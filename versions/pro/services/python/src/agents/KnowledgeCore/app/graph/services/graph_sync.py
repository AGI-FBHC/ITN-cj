"""diff 对账式增量 sync（dag-design.md §8.5）.

流程：目录树 + 有效边 → diff（新增/移动/孤儿）→ 候选对 → content-hash 缓存
过滤 → LLM 并发判定（防线 0 在候选生成时已保证方向）→ 判定为"是"的对
走 add_prerequisite（防线 1/2/3）写为 proposed → 审核队列。

关键设计：
- 幂等：已存在边（active/proposed/rejected）不生成候选；LLM 结果按
  content-hash 缓存（内容不变零调用），重跑不重复烧 token
- rejected 边不重试（人工否决），deprecated 可重试（删除可恢复）
- 失败降级：LLM 不可用跳过该批 + warning，下次 sync 补；孤儿边自动 deprecated
- 并发：按章节分组调用 LLM（每调用带章节上下文），Semaphore 限流
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.services.candidate_generator import (
    CandidatePair,
    CategoryRow,
    ChunkConceptRow,
    build_candidates,
    build_evidence_candidates,
    extract_bracket_aliases,
    pair_cache_key,
)
from app.graph.services.enrichment_loader import load_concept_rows
from app.graph.services.prerequisite_llm import PrerequisiteJudge
from app.graph.services.prerequisite_service import (
    CycleDetectedError,
    DirectionViolationError,
    InvalidEdgeError,
    OutdegreeExceededError,
    PrerequisiteService,
)

# 默认缓存路径：{KnowledgeCore 根}/data/graph_prereq_cache.json
DEFAULT_CACHE_PATH = Path(__file__).resolve().parent.parent.parent.parent / "data" / "graph_prereq_cache.json"
SYNC_CONCURRENCY = 8


@dataclass
class SyncReport:
    """一次 sync 的完整报告（可观测）."""

    domain_id: int
    new_categories: int = 0
    orphan_edges_deprecated: int = 0
    candidates: int = 0
    cache_hits: int = 0
    llm_calls: int = 0
    judged_yes: int = 0
    added: int = 0
    # T3.2 自动接线（交接遗留项 c）：证据通道（defines/uses 概念共现）建的候选边数 +
    # 括注别名写入数（enrichment 表不存在/该领域无 enrichment 数据 → 均为 0，静默跳过）。
    evidence_edges_added: int = 0
    aliases_added: int = 0
    skipped: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class GraphSyncService:
    """diff 对账式增量建边编排."""

    def __init__(
        self,
        db: AsyncSession,
        judge: PrerequisiteJudge | None = None,
        cache_path: Path | None = None,
        concurrency: int = SYNC_CONCURRENCY,
    ):
        self.db = db
        self.judge = judge or PrerequisiteJudge()
        self.cache_path = cache_path or DEFAULT_CACHE_PATH
        self.concurrency = concurrency
        self._cache: dict[str, dict[str, Any]] = self._load_cache()

    async def run_sync(self, domain_id: int) -> SyncReport:
        """执行一轮 sync，返回报告."""
        report = SyncReport(domain_id=domain_id)

        # 1. 目录树（领域下全部节点）
        categories = await self._load_categories(domain_id)

        # 2. 有效边（active/proposed/rejected —— rejected 不重试）
        edges = await self._load_edges(domain_id)

        # 3. diff：候选对 + 变更发现
        diff = build_candidates(
            categories,
            [(e["prereq_category_id"], e["category_id"], e["edge_type"]) for e in edges],
        )
        report.new_categories = len(diff.new_categories)
        report.candidates = len(diff.candidates)

        # 4. 孤儿边 → deprecated（引用已删除的 category）
        report.orphan_edges_deprecated = await self._deprecate_orphan_edges(domain_id)

        # 5. 候选对补描述 + 缓存过滤
        pending: list[CandidatePair] = []
        cat_by_id = {c.id: c for c in categories}
        for pair in diff.candidates:
            key = pair_cache_key(pair.prereq_id, pair.target_id)
            cached = self._cache.get(key)
            if cached and self._hash(pair, cat_by_id) == cached.get("hash"):
                report.cache_hits += 1
                if cached.get("is_prerequisite"):
                    await self._try_add(pair, cached, cat_by_id, report)
                continue
            pending.append(pair)

        # 6. LLM 并发判定（按章节分组，每调用带章节上下文）
        if pending:
            await self._judge_and_add(pending, cat_by_id, report)

        # 6-2 T3.2 自动接线（交接遗留项 c）：enrichment 的 defines/uses → 证据驱动候选边
        # + 括注别名写入。已有边集合复用步骤 3 的 edges（避免重复查库）。
        await self._sync_evidence_and_aliases(domain_id, cat_by_id, edges, report)

        # 7. 写回缓存
        self._save_cache()
        return report

    # ── LLM 判定与写回 ────────────────────────────────────────────────

    async def _judge_and_add(
        self,
        pairs: list[CandidatePair],
        cat_by_id: dict[int, CategoryRow],
        report: SyncReport,
    ) -> None:
        """按章节分组并发判定；判定为"是"的对走防线写为 proposed."""
        groups: dict[str, list[CandidatePair]] = {}
        for p in pairs:
            groups.setdefault(p.chapter_name or "未知章节", []).append(p)

        sem = asyncio.Semaphore(self.concurrency)

        async def judge_group(chapter: str, group: list[CandidatePair]) -> list[dict[str, Any]] | None:
            async with sem:
                report.llm_calls += 1
                payload = [
                    {
                        "prereq_id": p.prereq_id,
                        "prereq_name": p.prereq_name,
                        "prereq_desc": cat_by_id[p.prereq_id].description if p.prereq_id in cat_by_id else "",
                        "target_id": p.target_id,
                        "target_name": p.target_name,
                        "target_desc": cat_by_id[p.target_id].description if p.target_id in cat_by_id else "",
                    }
                    for p in group
                ]
                try:
                    return await self.judge.judge_pairs(chapter, payload)
                except Exception:  # noqa: BLE001 — judge 内部已降级，这里双保险
                    report.warnings.append(f"章节 {chapter} 判定失败（{len(group)} 对跳过，下次 sync 重试）")
                    return None

        results = await asyncio.gather(
            *[judge_group(ch, g) for ch, g in groups.items()]
        )

        # 展平并按 pair 还原
        for group_result in results:
            if not group_result:
                continue
            for item in group_result:
                pair = CandidatePair(
                    prereq_id=item["prereq_id"],
                    prereq_name=item["prereq_name"],
                    target_id=item["target_id"],
                    target_name=item["target_name"],
                )
                key = pair_cache_key(pair.prereq_id, pair.target_id)
                is_prereq = bool(item.get("is_prerequisite"))
                if not is_prereq:
                    # false 判定同样缓存（内容 hash 变化自动失效），避免重复调用
                    self._cache[key] = {
                        "hash": self._hash(pair, cat_by_id),
                        "is_prerequisite": False,
                        "confidence": float(item.get("confidence", 0.0)),
                        "rationale": item.get("rationale", ""),
                    }
                    continue
                report.judged_yes += 1
                ok = await self._try_add(
                    pair,
                    {
                        "is_prerequisite": True,
                        "confidence": item.get("confidence", 0.5),
                        "rationale": item.get("rationale", ""),
                    },
                    cat_by_id,
                    report,
                )
                # 只缓存成功建边的 true 判定（防线拒绝的边不缓存，
                # 拒绝通常意味着候选生成规则与白名单不一致，值得下次再暴露）
                if ok:
                    self._cache[key] = {
                        "hash": self._hash(pair, cat_by_id),
                        "is_prerequisite": True,
                        "confidence": item.get("confidence", 0.5),
                        "rationale": item.get("rationale", ""),
                    }

    async def _try_add(
        self,
        pair: CandidatePair,
        verdict: dict[str, Any],
        cat_by_id: dict[int, CategoryRow],
        report: SyncReport,
    ) -> bool:
        """走 add_prerequisite 四道防线写入（source=llm，proposed）. 返回是否成功.

        pair.evidence（T3.2 证据通道候选携带 {"concept","def_chunk","use_chunk"}）
        原样透传为 evidence_json；结构候选（同章/章节→知识点）本就是 None，行为不变。
        """
        svc = PrerequisiteService(self.db)
        try:
            edge, warnings = await svc.add_prerequisite(
                category_id=pair.target_id,
                prereq_category_id=pair.prereq_id,
                domain_id=report.domain_id,
                edge_type="prerequisite",
                confidence=float(verdict.get("confidence", 0.5)),
                rationale=verdict.get("rationale", ""),
                source="llm",
                created_by="graph-sync",
                evidence_json=pair.evidence,
            )
            report.added += 1
            report.skipped.extend(warnings)
            return True
        except (DirectionViolationError, CycleDetectedError, OutdegreeExceededError, InvalidEdgeError) as e:
            report.skipped.append(f"{pair.prereq_name}→{pair.target_name}: {e}")
            return False

    # ── T3.2 自动接线（交接遗留项 c）：enrichment → 证据候选 + 括注别名 ──────

    async def _sync_evidence_and_aliases(
        self,
        domain_id: int,
        cat_by_id: dict[int, CategoryRow],
        edges: list[dict[str, Any]],
        report: SyncReport,
    ) -> None:
        """把 knowledge_chunk_enrichment 的 defines/uses 喂给
        candidate_generator.build_evidence_candidates() / extract_bracket_aliases()

        （T3.2 交接文档记录的"能力就绪但未接自动化编排"，本次接上）：
        - 证据候选：仍走 `_try_add`（四道防线 + proposed 状态机），带 evidence_json，
          与结构候选（同章/章节→知识点）走同一条写入路径。
        - 括注别名：写入 knowledge_category_alias（source='definition_extract'），
          UNIQUE(category_id, alias) 天然幂等。

        enrichment 表不存在（predeal T3.1 未迁移/未跑过）或该领域暂无 enrichment
        数据 → 静默跳过，不影响 run_sync 主流程（与手册"enrichment 表不存在/为空
        时静默跳过"约定一致）。
        """
        rows = await self._load_concept_rows(domain_id)
        if not rows:
            return

        existing_pairs = {(e["prereq_category_id"], e["category_id"]) for e in edges}
        candidates = build_evidence_candidates(rows, existing_edges=existing_pairs, category_lookup=cat_by_id)
        for pair in candidates:
            ok = await self._try_add(
                pair,
                {"confidence": 0.6, "rationale": "T3.2 证据通道：概念定义/使用共现"},
                cat_by_id,
                report,
            )
            if ok:
                report.evidence_edges_added += 1

        aliases = extract_bracket_aliases(rows)
        if aliases:
            report.aliases_added = await self._write_aliases(aliases)

    async def _load_concept_rows(self, domain_id: int) -> list[ChunkConceptRow]:
        """按领域读取 knowledge_chunk_enrichment 的 defines/uses，展开为 ChunkConceptRow.

        装配逻辑抽到 `enrichment_loader.load_concept_rows`（与 T4.4
        `contrast_service.ContrastSyncService` 共用，避免重复维护同一段
        JOIN + JSON 解析）；enrichment 表不存在/查询失败 → 静默跳过返回空列表。
        """
        return await load_concept_rows(self.db, domain_id)

    async def _write_aliases(self, aliases: list[dict]) -> int:
        """写入 knowledge_category_alias（T1.5，source='definition_extract'）.

        UNIQUE(category_id, alias) 天然幂等（INSERT IGNORE / INSERT OR IGNORE）；
        别名表未迁移/写入失败 → 静默跳过，返回 0，不影响 run_sync 主流程。
        """
        if not aliases:
            return 0
        dialect = self.db.bind.dialect.name if self.db.bind is not None else "mysql"
        insert_sql = (
            "INSERT OR IGNORE INTO knowledge_category_alias (category_id, alias, source) "
            "VALUES (:cid, :alias, :source)"
            if dialect == "sqlite"
            else "INSERT IGNORE INTO knowledge_category_alias (category_id, alias, source) "
            "VALUES (:cid, :alias, :source)"
        )
        written = 0
        try:
            for a in aliases:
                result = await self.db.execute(
                    text(insert_sql),
                    {"cid": a["category_id"], "alias": a["alias"], "source": a["source"]},
                )
                written += result.rowcount or 0
            await self.db.commit()
        except Exception:  # noqa: BLE001 — 别名表未迁移/写入失败：静默跳过
            try:
                await self.db.rollback()
            except Exception:  # noqa: BLE001
                pass
            return 0
        return written

    # ── 数据加载与维护 ────────────────────────────────────────────────

    async def _load_categories(self, domain_id: int) -> list[CategoryRow]:
        result = await self.db.execute(
            text(
                "SELECT id, domain_id, parent_id, name, COALESCE(description,'') AS description, "
                "level, COALESCE(sort_order,0) AS sort_order, node_type "
                "FROM knowledge_category WHERE domain_id = :did AND status = 1"
            ),
            {"did": domain_id},
        )
        rows = result.mappings().all()
        return [
            CategoryRow(
                id=r["id"], domain_id=r["domain_id"], parent_id=r["parent_id"],
                name=r["name"], description=r["description"], level=r["level"],
                sort_order=r["sort_order"], node_type=r["node_type"],
            )
            for r in rows
        ]

    async def _load_edges(self, domain_id: int) -> list[dict[str, Any]]:
        result = await self.db.execute(
            text(
                "SELECT id, category_id, prereq_category_id, edge_type, status "
                "FROM knowledge_category_prerequisite "
                "WHERE domain_id = :did AND status IN ('active','proposed','rejected') "
                "AND edge_type IN ('prerequisite','cross_domain_prerequisite')"
            ),
            {"did": domain_id},
        )
        rows = result.mappings().all()
        return [
            {
                "id": r["id"], "category_id": r["category_id"],
                "prereq_category_id": r["prereq_category_id"],
                "edge_type": r["edge_type"], "status": r["status"],
            }
            for r in rows
        ]

    async def _deprecate_orphan_edges(self, domain_id: int) -> int:
        """边引用已删除的 category → deprecated（不物理删除）."""
        result = await self.db.execute(
            text(
                "UPDATE knowledge_category_prerequisite SET status = 'deprecated', "
                "updated_at = CURRENT_TIMESTAMP "
                "WHERE domain_id = :did AND status IN ('active','proposed') "
                "AND (category_id NOT IN (SELECT id FROM knowledge_category) "
                "     OR prereq_category_id NOT IN (SELECT id FROM knowledge_category))"
            ),
            {"did": domain_id},
        )
        await self.db.commit()
        return result.rowcount or 0

    # ── content-hash 缓存 ──────────────────────────────────────────────

    @staticmethod
    def _hash(pair: CandidatePair, cat_by_id: dict[int, CategoryRow]) -> str:
        """内容 hash：概念名+描述变化即失效（复用 figure_chunk_binder 缓存思路）."""
        def desc(cid: int) -> str:
            c = cat_by_id.get(cid)
            return f"{c.name}|{c.description}" if c else ""
        raw = f"{pair.prereq_id}|{desc(pair.prereq_id)}|{pair.target_id}|{desc(pair.target_id)}"
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def _load_cache(self) -> dict[str, dict[str, Any]]:
        try:
            if self.cache_path.exists():
                data = json.loads(self.cache_path.read_text(encoding="utf-8"))
                return data.get("pairs", {})
        except (OSError, json.JSONDecodeError):
            pass
        return {}

    def _save_cache(self) -> None:
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(
                json.dumps({"pairs": self._cache}, ensure_ascii=False, indent=1),
                encoding="utf-8",
            )
        except OSError as e:
            # 缓存写失败不影响主流程（下次重跑重新判定）
            print(f"[graph-sync] 缓存写失败: {e}")
