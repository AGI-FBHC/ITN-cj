"""混合检索服务：MySQL 精确 → 父级上卷 → RAG 兜底.

查询链路（对应 AGENT/solutions.md 第 4 节）：
  ① MySQL 精确层：knowledge_category 模糊匹配 → knowledge_chunk_category 取切片
  ② 父级上卷层：精确层不足阈值 → 沿 parent_id 向章节层上卷
  ③ RAG 兜底层：仍不足 → 用知识点名+描述打 RAGFlow retrieval
"""

from __future__ import annotations

import asyncio
import re
from collections import defaultdict
from typing import Any

from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.knowledge.services.rag_client import RagflowAsyncClient
from app.knowledge.services.reranker import rerank

# 阈值参数（solutions.md 4.3，按真实数据修正）
MIN_CHUNKS = 2                     # 知识点切片数固定下限
DEFAULT_FIXED_THRESHOLD = 3        # 默认固定阈值：低于该数视为数据不足，触发上卷/RAG
MAX_AUTO_THRESHOLD = 8             # auto 模式封顶（避免大树章节把阈值推得过高）
RAG_PAGE_SIZE = 8
RAG_SIMILARITY_THRESHOLD = 0.2
# predeal 上传时用 delimiter 分片，RAGFlow retrieve 返回的 content 可能残留分隔符
RAG_DELIMITER = "<<<ITN_CHUNK_BOUNDARY>>>"

# T1.4：RAG 兜底命中回写精确层的相似度门槛（低于此值不视为可信分类信号）
RAG_BACKFILL_SIMILARITY_THRESHOLD = 0.5

# T1.3：task_type → chunk 元数据过滤偏好，对应 knowledge_chunk 的布尔标记列。
# "definition" 暂无专用标记列，留空不特殊排序（T3.x 概念抽取后可补 contains_definition）。
PREFER_COLUMNS: dict[str, str] = {
    "code": "kc.contains_code",
    "figure": "kc.contains_figure",
}


def compute_threshold(
    chapter_stats: dict | None = None,
    mode: str = "fixed",
    is_chapter: bool = False,
) -> int:
    """计算切片数量阈值（纯函数，便于测试）.

    - fixed（默认）：知识点 3 条、章节 3 条 —— 简单可解释
    - auto：基于章节内"有切片知识点"的均值：max(2, min(int(avg*0.5), 8))
      （仅当 chapter_stats 可用时生效）
    """
    if mode == "auto" and chapter_stats and not is_chapter:
        avg = chapter_stats.get("kp_chunks", 0) / max(1, chapter_stats.get("kp_with_chunks", 1))
        return max(MIN_CHUNKS, min(int(avg * 0.5), MAX_AUTO_THRESHOLD))
    return DEFAULT_FIXED_THRESHOLD


class KnowledgeRetrievalService:
    """按知识点名取切片：精确 → 上卷 → RAG 三级降级."""

    def __init__(self, db: AsyncSession, rag: RagflowAsyncClient | None = None):
        self.db = db
        self.rag = rag or RagflowAsyncClient()
        # T1.4：fire-and-forget 回写任务句柄——生产不等待；测试可显式 await 以保证确定性
        self._pending_backfill_tasks: list[asyncio.Task] = []

    # ── 定位：领域 / 知识点 ────────────────────────────────────────────

    async def resolve_domain(self, domain_code: str) -> dict[str, Any] | None:
        """按 code 或 name 查 knowledge_domain."""
        row = (
            await self.db.execute(
                text(
                    "SELECT id, code, name FROM knowledge_domain "
                    "WHERE code = :code OR name = :name LIMIT 1"
                ),
                {"code": domain_code, "name": domain_code},
            )
        ).mappings().first()
        return dict(row) if row else None

    async def resolve_category(
        self,
        domain_id: int,
        knowledge_point: str,
        category_id: int | None = None,
    ) -> dict[str, Any] | None:
        """定位知识点节点（优先数据库精确匹配）.

        匹配优先级（从强到弱）：
          1. category_id 直查（调用方已确定节点 ID，最强精确）
          2. 精确全匹配：name / node_code / full_path 与输入完全一致
          2.5 别名精确命中（T1.5）：knowledge_category_alias.alias 与输入完全一致
          3. 多词 AND：输入分词后所有词同时命中（名称/编码/父章节名，如 "ReAct 范式"）
          4. 单 LIKE 模糊：任一字段包含输入（原有逻辑兜底）

        同优先级内优先最具体层级（node_type='knowledge_point'），其次 sort_order。
        父章节名（p.name）参与匹配：生产库 full_path 为空串，依赖它不靠谱。
        """
        if category_id is not None:
            row = (
                await self.db.execute(
                    text(
                        "SELECT id, parent_id, node_code, name, description, level, node_type, sort_order "
                        "FROM knowledge_category "
                        "WHERE id = :cid AND domain_id = :did AND status = 1"
                    ),
                    {"cid": category_id, "did": domain_id},
                )
            ).mappings().first()
            return dict(row) if row else None

        base_sql = (
            "SELECT c.id, c.parent_id, c.node_code, c.name, c.description, c.level, c.node_type, c.sort_order "
            "FROM knowledge_category c "
            "LEFT JOIN knowledge_category p ON p.id = c.parent_id "
            "WHERE c.domain_id = :did AND c.status = 1"
        )
        params: dict[str, Any] = {"did": domain_id, "kp": knowledge_point}

        # ① 精确全匹配（名称 / 编码 / 完整路径）
        rows = (
            await self.db.execute(
                text(
                    base_sql
                    + " AND (c.name = :kp OR c.node_code = :kp OR c.full_path = :kp) "
                    + "ORDER BY CASE WHEN c.name = :kp THEN 0 ELSE 1 END, "
                    + "c.level DESC, c.sort_order LIMIT 10"
                ),
                params,
            )
        ).mappings().all()
        if rows:
            return self._pick_best(rows)

        # ①-2 别名精确命中（T1.5）：knowledge_category_alias.alias = 输入 → category_id 直查
        # 表可能尚未迁移（生产库演练前）/ 查询失败：静默跳过，落到后续匹配阶段兜底
        try:
            alias_row = (
                await self.db.execute(
                    text("SELECT category_id FROM knowledge_category_alias WHERE alias = :kp LIMIT 1"),
                    {"kp": knowledge_point},
                )
            ).mappings().first()
        except Exception:  # noqa: BLE001 — 别名表缺失/查询异常不应中断知识点定位主链路
            alias_row = None
        if alias_row:
            cat_row = (
                await self.db.execute(
                    text(
                        "SELECT id, parent_id, node_code, name, description, level, node_type, sort_order "
                        "FROM knowledge_category "
                        "WHERE id = :cid AND domain_id = :did AND status = 1"
                    ),
                    {"cid": alias_row["category_id"], "did": domain_id},
                )
            ).mappings().first()
            if cat_row:
                return dict(cat_row)

        # ② 多词 AND（输入分词后所有词同时命中：名称/编码/父章节名，如 "ReAct 范式"）
        tokens = [t for t in re.split(r"[\s,，、/（）()]+", knowledge_point) if t]
        if len(tokens) > 1:
            and_sql = base_sql
            for i, tok in enumerate(tokens):
                and_sql += (
                    f" AND (c.name LIKE :t{i} OR c.node_code LIKE :t{i} "
                    f"OR c.full_path LIKE :t{i} OR p.name LIKE :t{i})"
                )
                params[f"t{i}"] = f"%{tok}%"
            rows = (
                await self.db.execute(
                    text(and_sql + " ORDER BY c.level DESC, c.sort_order LIMIT 10"),
                    params,
                )
            ).mappings().all()
            if rows:
                return self._pick_best(rows)

        # ③ 单 LIKE 模糊兜底：先只看节点自身字段直接命中，再放宽到父章节名
        like = f"%{knowledge_point}%"
        rows = (
            await self.db.execute(
                text(
                    base_sql
                    + " AND (c.name LIKE :like OR c.node_code LIKE :like OR c.full_path LIKE :like) "
                    + "ORDER BY CASE WHEN c.name = :kp THEN 0 "
                    + "                  WHEN c.node_code = :kp THEN 1 ELSE 2 END, "
                    + "c.level DESC, c.sort_order LIMIT 10"
                ),
                {**params, "like": like},
            )
        ).mappings().all()
        if rows:
            return self._pick_best(rows)

        # ③-2 放宽：输入命中父章节名（如 "经典范式" → ch4 下所有知识点）
        rows = (
            await self.db.execute(
                text(base_sql + " AND p.name LIKE :like ORDER BY c.level DESC, c.sort_order LIMIT 10"),
                {**params, "like": like},
            )
        ).mappings().all()
        if not rows:
            return None
        return self._pick_best(rows)

    @staticmethod
    def _pick_best(rows: list[Any]) -> dict[str, Any]:
        """同优先级候选中优先最具体的知识点叶子节点."""
        for r in rows:
            if r["node_type"] == "knowledge_point":
                return dict(r)
        return dict(rows[0])

    async def ancestor_chain(self, category: dict[str, Any]) -> list[dict[str, Any]]:
        """从最近父级到最远的祖先节点链（level 2 → level 1）."""
        chain: list[dict[str, Any]] = []
        cur_id = category.get("parent_id")
        while cur_id:
            row = (
                await self.db.execute(
                    text(
                        "SELECT id, parent_id, node_code, name, description, level, node_type "
                        "FROM knowledge_category WHERE id = :cid AND status = 1"
                    ),
                    {"cid": cur_id},
                )
            ).mappings().first()
            if not row:
                break
            row = dict(row)
            chain.append(row)
            cur_id = row["parent_id"]
        return chain

    # ── 查询：切片 / 章节切片基数 ──────────────────────────────────────

    async def _descendant_ids(self, category_id: int) -> list[int]:
        """递归收集 category_id 的全部子孙节点 id（目录树小，一次全查再内存遍历）."""
        rows = (
            await self.db.execute(
                text("SELECT id, parent_id FROM knowledge_category WHERE status = 1")
            )
        ).mappings().all()
        children: dict[int, list[int]] = defaultdict(list)
        for r in rows:
            if r["parent_id"] is not None:
                children[r["parent_id"]].append(r["id"])
        out: list[int] = []
        stack = [category_id]
        while stack:
            cur = stack.pop()
            for cid in children.get(cur, []):
                out.append(cid)
                stack.append(cid)
        return out

    async def chunks_by_category(
        self,
        category_id: int,
        source: str,
        min_confidence: float | None = None,
        include_descendants: bool = False,
        prefer: str | None = None,
    ) -> list[dict[str, Any]]:
        """按分类关系取切片（按置信度降序），每条带 source 标签.

        min_confidence: 只返回分类置信度不低于该值的切片（用于过滤 LLM 低置信度错挂）.
        include_descendants: 章节/顶层节点查询时递归聚合其下所有子孙知识点的切片
        （切片只挂 level3 知识点，章节自身 0 切片；level1 顶层同样需要聚合）.
        prefer: T1.3 任务类型偏好（"code" / "figure"）——命中列在排序中前置，
        含码/含图切片优先返回；未知取值或 None 不影响原有排序。

        T3.5：SQL 加 kc.canonical_chunk_id IS NULL 过滤——非规范（重复）切片不返回，
        生产库该列在去重跑批前全为 NULL，等价 no-op（不改变现状行为）。
        """
        cat_filter = "kcc.category_id = :cid"
        params: dict[str, Any] = {"cid": category_id}
        if include_descendants:
            sub_ids = await self._descendant_ids(category_id)
            if sub_ids:
                cat_filter = "(kcc.category_id = :cid OR kcc.category_id IN :sub_ids)"
                params["sub_ids"] = tuple(sub_ids)
        sql = (
            "SELECT kc.id AS chunk_id, kc.chunk_code, kc.document_id, kc.chunk_index, kc.title_path, "
            "       kc.section_title, kc.content, kc.summary, kc.ragflow_chunk_id, "
            "       kcc.confidence, kcc.relation_type, kcc.source AS classify_source "
            "FROM knowledge_chunk_category kcc "
            "JOIN knowledge_chunk kc ON kc.id = kcc.chunk_id "
            f"WHERE {cat_filter} AND kc.canonical_chunk_id IS NULL"
        )
        if min_confidence is not None:
            sql += " AND kcc.confidence >= :min_conf"
            params["min_conf"] = min_confidence
        prefer_col = PREFER_COLUMNS.get(prefer or "")
        order_clause = "kcc.confidence DESC, kc.chunk_index"
        if prefer_col:
            order_clause = f"{prefer_col} DESC, {order_clause}"
        sql += f" ORDER BY {order_clause}"
        rows = (
            await self.db.execute(
                text(sql).bindparams(bindparam("sub_ids", expanding=True))
                if include_descendants and params.get("sub_ids") is not None
                else text(sql),
                params,
            )
        ).mappings().all()
        hits = []
        for r in rows:
            item = dict(r)
            item["source"] = source
            hits.append(item)
        return hits

    async def prerequisite_evidence_chunks(
        self, category_id: int, limit: int = 2
    ) -> list[dict[str, Any]]:
        """T4.5：先修节点的证据切片（knowledge_chunk_enrichment 有 defines 的块优先）.

        由 GraphRAG 一跳（decision_service）在开关开启时调用：给定一个先修知识点的
        category_id，取最多 limit 条切片作为 prerequisite 证据。enrichment 表未迁移/
        查询失败 → 静默降级为不带 enrichment 排序的普通置信度排序（T3.2 交接文档记录
        的"enrichment 表不存在/为空时静默跳过"约定）。
        """
        try:
            rows = (
                await self.db.execute(
                    text(
                        "SELECT kc.id AS chunk_id, kc.chunk_code, kc.document_id, kc.chunk_index, "
                        "       kc.title_path, kc.section_title, kc.content, kc.summary, "
                        "       kc.ragflow_chunk_id, kcc.confidence, kcc.relation_type, "
                        "       kcc.source AS classify_source, "
                        "       CASE WHEN kce.defines_json IS NOT NULL "
                        "                 AND kce.defines_json <> '' AND kce.defines_json <> '[]' "
                        "            THEN 0 ELSE 1 END AS defines_rank "
                        "FROM knowledge_chunk_category kcc "
                        "JOIN knowledge_chunk kc ON kc.id = kcc.chunk_id "
                        "LEFT JOIN knowledge_chunk_enrichment kce ON kce.chunk_id = kc.id "
                        "WHERE kcc.category_id = :cid AND kc.canonical_chunk_id IS NULL "
                        "ORDER BY defines_rank, kcc.confidence DESC, kc.chunk_index "
                        "LIMIT :limit"
                    ),
                    {"cid": category_id, "limit": limit},
                )
            ).mappings().all()
        except Exception:  # noqa: BLE001 — enrichment 表未迁移/查询失败：降级为无 enrichment 排序
            try:
                rows = (
                    await self.db.execute(
                        text(
                            "SELECT kc.id AS chunk_id, kc.chunk_code, kc.document_id, kc.chunk_index, "
                            "       kc.title_path, kc.section_title, kc.content, kc.summary, "
                            "       kc.ragflow_chunk_id, kcc.confidence, kcc.relation_type, "
                            "       kcc.source AS classify_source "
                            "FROM knowledge_chunk_category kcc "
                            "JOIN knowledge_chunk kc ON kc.id = kcc.chunk_id "
                            "WHERE kcc.category_id = :cid AND kc.canonical_chunk_id IS NULL "
                            "ORDER BY kcc.confidence DESC, kc.chunk_index "
                            "LIMIT :limit"
                        ),
                        {"cid": category_id, "limit": limit},
                    )
                ).mappings().all()
            except Exception:  # noqa: BLE001 — 分类关系表缺失等更基础的故障，防御性兜底
                return []
        hits = []
        for r in rows:
            item = dict(r)
            item["source"] = "prerequisite"
            hits.append(item)
        return hits

    async def chunks_by_ids(self, chunk_ids: list[int]) -> list[dict[str, Any]]:
        """按切片 ID 批量回取（get_evidence / 审核 / 判题 / 溯源用）.

        保持请求顺序返回；不存在或非法的 ID 静默跳过。
        返回 ChunkHit 兼容形状（source='mysql'）。
        """
        ids = [int(c) for c in chunk_ids if int(c) > 0]
        if not ids:
            return []
        rows = (
            await self.db.execute(
                text(
                    "SELECT kc.id AS chunk_id, kc.chunk_code, kc.document_id, kc.title_path, "
                    "       kc.section_title, kc.content, kc.summary, kc.ragflow_chunk_id "
                    "FROM knowledge_chunk kc WHERE kc.id IN :ids "
                ).bindparams(bindparam("ids", expanding=True)),
                {"ids": tuple(ids)},
            )
        ).mappings().all()
        by_id = {int(r["chunk_id"]): r for r in rows}
        hits = []
        for cid in ids:
            row = by_id.get(cid)
            if row is None:
                continue
            item = dict(row)
            item["source"] = "mysql"
            item["confidence"] = None
            item["relation_type"] = None
            item["similarity"] = None
            item["document_id"] = (
                str(row["document_id"]) if row.get("document_id") is not None else None
            )
            hits.append(item)
        return hits

    async def chapter_chunk_count(self, domain_id: int, category: dict[str, Any]) -> dict | None:
        """计算知识点所属章节的切片统计：

        - anchor_id: 章节节点（level2，缺省取 level1）
        - chapter_chunks: 章节子树去重有效切片数（JOIN knowledge_chunk）
        - kp_chunks / kp_with_chunks: 章节内 level3 知识点的有效切片总数 / 有切片的知识点数
        """
        chain = await self.ancestor_chain(category)
        anchor = next((a for a in chain if a["level"] == 2), chain[0] if chain else None)
        if not anchor:
            return None
        row = (
            await self.db.execute(
                text(
                    "SELECT "
                    "  COUNT(DISTINCT kcc.chunk_id) AS chapter_chunks, "
                    "  COUNT(DISTINCT CASE WHEN c2.level = 3 THEN kcc.chunk_id END) AS kp_chunks, "
                    "  COUNT(DISTINCT CASE WHEN c2.level = 3 AND kcc.chunk_id IS NOT NULL THEN c2.id END) "
                    "    AS kp_with_chunks "
                    "FROM knowledge_category c "
                    "LEFT JOIN knowledge_category c2 ON c2.parent_id = c.id "
                    "LEFT JOIN knowledge_chunk_category kcc ON kcc.category_id = c2.id "
                    "JOIN knowledge_chunk kc ON kc.id = kcc.chunk_id "
                    "WHERE c.domain_id = :did AND c.id = :anchor"
                ),
                {"did": domain_id, "anchor": anchor["id"]},
            )
        ).mappings().first()
        if not row or not row["chapter_chunks"]:
            # 该章节可能没有 level3 子节点（c2 全空），回退：直接数锚点节点自身挂的切片
            row2 = (
                await self.db.execute(
                    text(
                        "SELECT COUNT(DISTINCT kcc.chunk_id) AS cnt "
                        "FROM knowledge_chunk_category kcc "
                        "JOIN knowledge_chunk kc ON kc.id = kcc.chunk_id "
                        "WHERE kcc.category_id = :anchor"
                    ),
                    {"anchor": anchor["id"]},
                )
            ).mappings().first()
            return {
                "anchor_id": anchor["id"],
                "chapter_chunks": int(row2["cnt"] or 0) if row2 else 0,
                "kp_chunks": 0,
                "kp_with_chunks": 0,
            }
        return {
            "anchor_id": anchor["id"],
            "chapter_chunks": int(row["chapter_chunks"]),
            "kp_chunks": int(row["kp_chunks"] or 0),
            "kp_with_chunks": int(row["kp_with_chunks"] or 0),
        }

    # ── RAG 兜底 ───────────────────────────────────────────────────────

    async def _rag_fallback(
        self,
        domain_row: dict[str, Any],
        knowledge_point: str,
        category: dict[str, Any] | None,
        dataset_ids: list[str] | None = None,
        similarity_threshold: float | None = None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        """RAGFlow 检索，返回 (chunks, warning)."""
        question = knowledge_point
        if category and category.get("description"):
            question = f"{knowledge_point}：{category['description']}"
        try:
            ds_ids = await self.rag.resolve_dataset_ids(
                domain_row["code"], explicit=dataset_ids, domain_name=domain_row.get("name"),
            )
            if not ds_ids:
                return [], f"未找到领域「{domain_row['name']}」对应的 RAGFlow 数据集"
            chunks = await self.rag.retrieve(
                question=question,
                dataset_ids=ds_ids,
                page_size=RAG_PAGE_SIZE,
                similarity_threshold=(
                    similarity_threshold
                    if similarity_threshold is not None
                    else RAG_SIMILARITY_THRESHOLD
                ),
            )
            # T1.4：高相似度命中回写精确层（异步、不阻塞响应；总开关默认 off）
            if category is not None and get_settings().KNOWLEDGE_ALLOW_WRITE:
                for c in chunks:
                    similarity = c.get("similarity")
                    if similarity is not None and similarity >= RAG_BACKFILL_SIMILARITY_THRESHOLD:
                        task = asyncio.create_task(
                            self._backfill_chunk_category(c, category["id"], float(similarity))
                        )
                        self._pending_backfill_tasks.append(task)
            return chunks, None
        except Exception as e:  # noqa: BLE001 — 兜底链路不因 RAG 故障中断
            return [], f"RAGFlow 检索失败: {e}"

    async def _backfill_chunk_category(
        self, rag_chunk: dict[str, Any], category_id: int, similarity: float
    ) -> None:
        """T1.4：RAG 命中回写精确层.

        按 ragflow_chunk_id 反查 knowledge_chunk.id，写 knowledge_chunk_category
        （source='rag_backfill'）。查不到 chunk / 写库失败均静默跳过，不影响主检索链路
        （fire-and-forget：由调用方通过 asyncio.create_task 投递，本方法内部吞掉所有异常）。
        """
        ragflow_chunk_id = rag_chunk.get("id") or rag_chunk.get("chunk_id")
        if not ragflow_chunk_id:
            return
        try:
            row = (
                await self.db.execute(
                    text("SELECT id FROM knowledge_chunk WHERE ragflow_chunk_id = :rid"),
                    {"rid": ragflow_chunk_id},
                )
            ).mappings().first()
            if not row:
                return
            dialect = self.db.bind.dialect.name if self.db.bind is not None else "mysql"
            insert_sql = (
                "INSERT OR IGNORE INTO knowledge_chunk_category "
                "(chunk_id, category_id, confidence, source) VALUES (:cid, :cat, :sim, 'rag_backfill')"
                if dialect == "sqlite"
                else "INSERT IGNORE INTO knowledge_chunk_category "
                "(chunk_id, category_id, confidence, source) VALUES (:cid, :cat, :sim, 'rag_backfill')"
            )
            await self.db.execute(
                text(insert_sql),
                {"cid": row["id"], "cat": category_id, "sim": similarity},
            )
            await self.db.commit()
        except Exception:  # noqa: BLE001 — 写库失败静默，不影响主检索链路
            try:
                await self.db.rollback()
            except Exception:  # noqa: BLE001
                pass

    async def log_retrieval_miss(
        self,
        query: str,
        domain_id: int | None,
        stage: str,
        task_type: str | None = None,
    ) -> None:
        """T2.3：检索 miss 日志——fire-and-forget，写库失败静默不影响主流程.

        stage: resolve_category（知识点未在目录树命中）/ chunks（三级降级全空）/ gate（决策门控）。
        """
        try:
            await self.db.execute(
                text(
                    "INSERT INTO knowledge_retrieval_miss (query, domain_id, stage, task_type) "
                    "VALUES (:q, :did, :stage, :tt)"
                ),
                {"q": query, "did": domain_id, "stage": stage, "tt": task_type},
            )
            await self.db.commit()
        except Exception:  # noqa: BLE001 — miss 日志表未迁移/写库失败不应影响检索主链路
            try:
                await self.db.rollback()
            except Exception:  # noqa: BLE001
                pass

    async def category_tree(self, domain_id: int, threshold_mode: str = "fixed") -> dict[str, Any]:
        """返回完整目录树（嵌套 children），节点带切片数/缺口状态/阈值.

        结构：按 parent_id 分组递归组装，一次查询拿全部节点+有效切片数。
        """
        rows = (
            await self.db.execute(
                text(
                    "SELECT c.id, c.parent_id, c.node_code, c.name, c.description, "
                    "       c.level, c.node_type, c.sort_order, "
                    "       COUNT(CASE WHEN kc.id IS NOT NULL THEN kcc.chunk_id END) AS chunk_count "
                    "FROM knowledge_category c "
                    "LEFT JOIN knowledge_chunk_category kcc ON kcc.category_id = c.id "
                    "LEFT JOIN knowledge_chunk kc ON kc.id = kcc.chunk_id "
                    "WHERE c.domain_id = :did AND c.status = 1 "
                    "GROUP BY c.id, c.parent_id, c.node_code, c.name, c.description, "
                    "         c.level, c.node_type, c.sort_order "
                    "ORDER BY c.sort_order, c.id"
                ),
                {"did": domain_id},
            )
        ).mappings().all()

        # 章节统计（供 auto 阈值）
        chapter_stats: dict[int, dict] = {}
        if threshold_mode == "auto":
            for r in rows:
                if r["node_type"] == "category" and r["level"] == 2:
                    stats = await self.chapter_chunk_count(domain_id, dict(r))
                    if stats:
                        chapter_stats[r["id"]] = stats

        nodes: dict[int, dict[str, Any]] = {}
        roots: list[dict[str, Any]] = []
        for r in rows:
            item = dict(r)
            item["chunk_count"] = int(item["chunk_count"] or 0)
            is_chapter = item["node_type"] == "category" and item["level"] == 2
            stats = chapter_stats.get(r["parent_id"]) if not is_chapter else None
            thr = compute_threshold(stats, mode=threshold_mode, is_chapter=is_chapter)
            if item["chunk_count"] == 0:
                item["gap"] = "no_chunks"
            elif item["chunk_count"] < thr:
                item["gap"] = "below_threshold"
            else:
                item["gap"] = "ok"
            item["threshold"] = thr
            item["children"] = []
            nodes[item["id"]] = item

        for item in nodes.values():
            pid = item["parent_id"]
            if pid in nodes:
                nodes[pid]["children"].append(item)
            else:
                roots.append(item)

        # 章节/顶层节点的切片数 = 子树聚合（与检索侧章节聚合语义一致）
        def _aggregate(node: dict[str, Any]) -> int:
            if node["children"]:
                node["chunk_count"] = sum(_aggregate(c) for c in node["children"])
                is_chapter = node["node_type"] == "category" and node["level"] == 2
                thr = compute_threshold(None, mode=threshold_mode, is_chapter=is_chapter)
                node["threshold"] = thr
                if node["chunk_count"] == 0:
                    node["gap"] = "no_chunks"
                elif node["chunk_count"] < thr:
                    node["gap"] = "below_threshold"
                else:
                    node["gap"] = "ok"
            return node["chunk_count"]

        for root in roots:
            _aggregate(root)
        return {"total": len(nodes), "tree": roots}

    # ── 主流程 ─────────────────────────────────────────────────────────

    async def retrieve_chunks(
        self,
        knowledge_point: str,
        domain: str = "agent",
        threshold: int | None = None,
        threshold_mode: str = "fixed",
        include_rag: bool = True,
        limit: int = 20,
        dataset_ids: list[str] | None = None,
        category_id: int | None = None,
        min_confidence: float | None = None,
        rag_similarity_threshold: float | None = None,
        prefer: str | None = None,
        task_type: str | None = None,
        expand_context: bool = False,
    ) -> dict[str, Any]:
        """混合检索入口.

        category_id: 直接按知识点节点 ID 查（跳过名称匹配，最强精确）.
        min_confidence: 精确层只返回分类置信度不低于该值的切片.
        rag_similarity_threshold: RAG 兜底相似度阈值（缺省 0.2）.
        prefer: T1.3 任务类型偏好（"code" / "figure"），透传给精确层/父级上卷层排序。
        task_type: 仅用于 T2.3 miss 日志记录，不影响检索逻辑。
        expand_context: T3.4 父子多粒度（轻量版）——强制为命中块补充同文档相邻块
        （短块 <200 字符即使不传此参数也会自动补邻）；返回体新增 hit_chunks/
        context_chunks 字段，原 chunks 字段不变（向后兼容）。
        """
        domain_row = await self.resolve_domain(domain)
        if not domain_row:
            return self._empty_result(
                knowledge_point, domain,
                threshold=threshold,
                warning=f"领域不存在: {domain}",
            )

        category = await self.resolve_category(domain_row["id"], knowledge_point, category_id)
        if not category:
            # 知识点名都没匹配到 → 直接 RAG 兜底
            if include_rag:
                rag_chunks, warning = await self._rag_fallback(
                    domain_row, knowledge_point, None, dataset_ids,
                    similarity_threshold=rag_similarity_threshold,
                )
                decision = "rag" if rag_chunks else "empty"
                if decision == "empty":
                    await self.log_retrieval_miss(
                        knowledge_point, domain_row.get("id"), stage="resolve_category", task_type=task_type
                    )
                hit_list = self._to_hits(rag_chunks, source="rag")[:limit]
                return {
                    "knowledge_point": knowledge_point,
                    "domain_code": domain_row["code"],
                    "category_id": None,
                    "category_name": None,
                    "category_level": None,
                    "node_type": None,
                    "decision": decision,
                    "threshold": threshold or MIN_CHUNKS,
                    "chunks": hit_list,
                    "hit_chunks": hit_list,
                    "context_chunks": [],
                    "stats": {"exact": 0, "parent": 0, "rag": len(rag_chunks)},
                    "via_parent": False,
                    "warning": warning or "知识点未在目录树中命中，返回 RAG 结果",
                }
            await self.log_retrieval_miss(
                knowledge_point, domain_row.get("id"), stage="resolve_category", task_type=task_type
            )
            return self._empty_result(
                knowledge_point, domain, threshold=threshold,
                warning="知识点未在目录树中命中",
            )

        # ① MySQL 精确层（章节/顶层节点递归聚合子孙知识点切片）
        is_chapter_node = category.get("node_type") == "category"
        exact = await self.chunks_by_category(
            category["id"], source="mysql", min_confidence=min_confidence,
            include_descendants=is_chapter_node, prefer=prefer,
        )
        chapter_stats = await self.chapter_chunk_count(domain_row["id"], category)
        thr = threshold or compute_threshold(chapter_stats, mode=threshold_mode)

        if len(exact) >= thr:
            return await self._build_result(
                category=category, decision="mysql", hits=exact, threshold=thr,
                stats={"exact": len(exact), "parent": 0, "rag": 0},
                via_parent=False, limit=limit, domain_code=domain_row["code"],
                query=knowledge_point, expand_context=expand_context,
            )

        # ② 父级上卷层（只上卷到章节 level2；顶层=全领域内容相关性弱，跳过直接 RAG）
        parent_hits: list[dict[str, Any]] = []
        for anc in await self.ancestor_chain(category):
            if anc.get("level", 0) <= 1:
                continue
            is_chapter = anc.get("node_type") == "category"
            hits = await self.chunks_by_category(
                anc["id"], source="parent", min_confidence=min_confidence,
                include_descendants=is_chapter, prefer=prefer,
            )
            if hits:
                parent_hits = hits
            if len(hits) >= thr:
                return await self._build_result(
                    category=category, decision="parent", hits=parent_hits, threshold=thr,
                    stats={"exact": len(exact), "parent": len(parent_hits), "rag": 0},
                    via_parent=True, limit=limit, domain_code=domain_row["code"],
                    query=knowledge_point, expand_context=expand_context,
                )

        # ③ RAG 兜底层
        if include_rag:
            rag_chunks, warning = await self._rag_fallback(
                domain_row, knowledge_point, category, dataset_ids,
                similarity_threshold=rag_similarity_threshold,
            )
            combined = parent_hits + self._to_hits(rag_chunks, source="rag")
            stats = {"exact": len(exact), "parent": len(parent_hits), "rag": len(rag_chunks)}
            decision = "rag" if combined else "empty"
            if decision == "empty":
                await self.log_retrieval_miss(
                    knowledge_point, domain_row.get("id"), stage="chunks", task_type=task_type
                )
            return await self._build_result(
                category=category, decision=decision,
                hits=combined, threshold=thr, stats=stats,
                via_parent=bool(parent_hits), limit=limit,
                warning=warning, domain_code=domain_row["code"],
                query=knowledge_point, expand_context=expand_context,
            )

        await self.log_retrieval_miss(
            knowledge_point, domain_row.get("id"), stage="chunks", task_type=task_type
        )
        return await self._build_result(
            category=category, decision="empty", hits=parent_hits, threshold=thr,
            stats={"exact": len(exact), "parent": len(parent_hits), "rag": 0},
            via_parent=bool(parent_hits), limit=limit,
            warning="低于阈值且 include_rag=false", domain_code=domain_row["code"],
            query=knowledge_point, expand_context=expand_context,
        )

    # ── 结果组装 ───────────────────────────────────────────────────────

    def _empty_result(
        self,
        knowledge_point: str,
        domain: str,
        threshold: int | None,
        warning: str,
    ) -> dict[str, Any]:
        return {
            "knowledge_point": knowledge_point,
            "domain_code": domain,
            "category_id": None,
            "category_name": None,
            "category_level": None,
            "node_type": None,
            "decision": "empty",
            "threshold": threshold or MIN_CHUNKS,
            "chunks": [],
            "hit_chunks": [],
            "context_chunks": [],
            "stats": {},
            "via_parent": False,
            "warning": warning,
        }

    async def _build_result(
        self,
        category: dict[str, Any],
        decision: str,
        hits: list[dict[str, Any]],
        threshold: int,
        stats: dict[str, Any],
        via_parent: bool,
        limit: int,
        warning: str | None = None,
        domain_code: str = "",
        query: str = "",
        expand_context: bool = False,
    ) -> dict[str, Any]:
        hit_list = [self._to_hit(h) for h in hits]
        # T3.3：重排层（开关 off 时完全不涉及，行为与现状 100% 一致）。
        # getattr 兜底：部分测试用 SimpleNamespace 打桩 get_settings() 只带
        # 自己关心的字段，缺省视为 off，不影响既有用例。
        if getattr(get_settings(), "KNOWLEDGE_RERANK", False):
            hit_list = await rerank(query, hit_list, top_k=limit)
        else:
            hit_list = hit_list[:limit]
        # T3.4：父子多粒度（轻量版）——短块自动补邻，或调用方显式要求
        context_list = await self._expand_context(hit_list, expand_context) if hit_list else []
        return {
            "knowledge_point": category["name"],
            "domain_code": domain_code,
            "category_id": category["id"],
            "category_name": category["name"],
            "category_level": category.get("level"),
            "node_type": category.get("node_type"),
            "decision": decision,
            "threshold": threshold,
            "chunks": hit_list,
            "hit_chunks": hit_list,
            "context_chunks": context_list,
            "stats": stats,
            "via_parent": via_parent,
            "warning": warning,
        }

    def _to_hits(self, rag_chunks: list[dict[str, Any]], source: str) -> list[dict[str, Any]]:
        hits = []
        for c in rag_chunks:
            item = {
                "chunk_id": 0,
                "chunk_code": "",
                "document_id": c.get("document_id"),
                "chunk_index": None,
                "title_path": "",
                "section_title": "",
                "content": (c.get("content", "") or "").replace(RAG_DELIMITER, "").strip(),
                "summary": None,
                "source": source,
                "confidence": None,
                "relation_type": None,
                "similarity": c.get("similarity"),
                "ragflow_chunk_id": c.get("id") or c.get("chunk_id"),
            }
            hits.append(item)
        return hits

    def _to_hit(self, row: dict[str, Any]) -> dict[str, Any]:
        """统一转换为 ChunkHit 形状."""
        if row.get("source") == "rag":
            return row
        return {
            "chunk_id": row["chunk_id"],
            "chunk_code": row.get("chunk_code", ""),
            "document_id": str(row["document_id"]) if row.get("document_id") is not None else None,
            "chunk_index": row.get("chunk_index"),
            "title_path": row.get("title_path", ""),
            "section_title": row.get("section_title", ""),
            "content": row.get("content", ""),
            "summary": row.get("summary"),
            "source": row.get("source", "mysql"),
            "confidence": float(row["confidence"]) if row.get("confidence") is not None else None,
            "relation_type": row.get("relation_type"),
            "similarity": None,
            "ragflow_chunk_id": row.get("ragflow_chunk_id"),
        }

    # ── T3.4：父子多粒度返回（轻量版） ────────────────────────────────────

    async def _expand_context(
        self, hit_chunks: list[dict[str, Any]], expand_context: bool
    ) -> list[dict[str, Any]]:
        """短块（内容 <200 字符）或调用方传 expand_context=True 时，取相邻块补充上下文.

        邻块条件：同 document_id、chunk_index ±1、title_path 与命中块完全一致
        （章节/文档边界不越界）；已在命中集合中的块不重复出现在 context_chunks。
        RAG 结果没有可靠的 chunk_index/document_id，跳过不补邻。
        """
        context: list[dict[str, Any]] = []
        seen_ids = {h.get("chunk_id") for h in hit_chunks if h.get("chunk_id")}
        for h in hit_chunks:
            if h.get("source") == "rag":
                continue
            content = h.get("content") or ""
            if not (expand_context or len(content) < 200):
                continue
            doc_id = h.get("document_id")
            idx = h.get("chunk_index")
            title_path = h.get("title_path")
            if doc_id is None or idx is None:
                continue
            try:
                doc_id_int = int(doc_id)
            except (TypeError, ValueError):
                continue
            for neighbor_idx in (idx - 1, idx + 1):
                if neighbor_idx < 0:
                    continue
                row = (
                    await self.db.execute(
                        text(
                            "SELECT kc.id AS chunk_id, kc.chunk_code, kc.document_id, kc.chunk_index, "
                            "       kc.title_path, kc.section_title, kc.content, kc.summary, "
                            "       kc.ragflow_chunk_id "
                            "FROM knowledge_chunk kc "
                            "WHERE kc.document_id = :did AND kc.chunk_index = :idx"
                        ),
                        {"did": doc_id_int, "idx": neighbor_idx},
                    )
                ).mappings().first()
                if not row or row["title_path"] != title_path:
                    continue  # 章节/文档边界不越界：title_path 不同即跳过
                if row["chunk_id"] in seen_ids:
                    continue
                item = dict(row)
                item["source"] = "context"
                context.append(self._to_hit(item))
                seen_ids.add(row["chunk_id"])
        return context
