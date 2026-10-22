"""T4.4：contrasts_with 候选生成 + LLM 把关 + 写入 proposed 边编排.

沿用 T3.2 概念共现数据（knowledge_chunk_enrichment 的 defines/uses，
调用方展开为 ChunkConceptRow，做法与 graph_sync 消费 candidate_generator 的
证据通道一致）：

    候选生成（candidate_generator.build_contrast_candidates）
      → LLM 把关（contrast_llm.ContrastJudge；不可用/未配置/解析覆盖不足时
        整体跳过，宁缺毋滥，不臆断写边）
      → 判定为"是"的对走 PrerequisiteService.add_prerequisite(
        edge_type="contrasts_with") 写为 proposed（不直接激活，需人工审核）。

本文件不在 sync 主流程（graph_sync.GraphSyncService）中自动调用——与 T3.2 交接
文档记录的"能力就绪但未接自动化编排"状态一致，留给调用方（定期任务/管理接口）
显式驱动，避免未经评估就默认跑批。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.services.candidate_generator import (
    CategoryRow,
    ChunkConceptRow,
    build_contrast_candidates,
)
from app.graph.services.contrast_llm import ContrastJudge
from app.graph.services.enrichment_loader import load_concept_rows
from app.graph.services.prerequisite_service import InvalidEdgeError, PrerequisiteService


@dataclass
class ContrastSyncReport:
    """一次 contrasts_with 同步的报告（可观测）."""

    candidates: int = 0
    judged_yes: int = 0
    added: int = 0
    skipped: list[str] = field(default_factory=list)


class ContrastSyncService:
    """易混淆知识点（contrasts_with）候选生成 + LLM 把关 + proposed 建边编排."""

    def __init__(self, db: AsyncSession, judge: ContrastJudge | None = None):
        self.db = db
        # judge 显式注入优先（测试用 mock 判定器）；否则用真实 ContrastJudge
        # （未配置 LLM_API_URL/KEY 时其 judge_pairs 会自然返回 None，本服务据此整体跳过）。
        self.judge = judge or ContrastJudge()

    async def sync_contrasts(
        self,
        rows: list[ChunkConceptRow],
        domain_id: int,
        existing_pairs: set[tuple[int, int]] | None = None,
        category_lookup: dict[int, CategoryRow] | None = None,
        dry_run: bool = False,
    ) -> ContrastSyncReport:
        """执行一轮候选生成 + LLM 把关 + 写入（proposed）.

        dry_run=True 时仍跑候选生成 + LLM 判定（`judged_yes` 照常统计，方便预览
        效果），但跳过 `add_prerequisite` 写库这一步——`added` 恒为 0，`skipped`
        里追加一条 dry-run 提示，不产生任何数据库副作用。
        """
        report = ContrastSyncReport()
        candidates = build_contrast_candidates(
            rows, existing_pairs=existing_pairs, category_lookup=category_lookup
        )
        report.candidates = len(candidates)
        if not candidates:
            return report

        payload = [
            {"a_id": c.a_id, "a_name": c.a_name, "b_id": c.b_id, "b_name": c.b_name}
            for c in candidates
        ]
        try:
            verdicts = await self.judge.judge_pairs(payload)
        except Exception as e:  # noqa: BLE001 — LLM 把关失败不应中断（宁缺毋滥）
            report.skipped.append(f"LLM 判定异常，跳过全部候选: {e}")
            return report
        if not verdicts:
            report.skipped.append("LLM 判定不可用/结果为空，跳过全部候选")
            return report

        judged_yes_candidates = [
            (cand, verdict) for cand, verdict in zip(candidates, verdicts) if verdict.get("is_contrast")
        ]
        report.judged_yes = len(judged_yes_candidates)

        if dry_run:
            report.skipped.append(
                f"dry_run=true：仅预览，未写库（{report.judged_yes} 对判定为易混淆）"
            )
            return report

        svc = PrerequisiteService(self.db)
        for cand, verdict in judged_yes_candidates:
            try:
                await svc.add_prerequisite(
                    category_id=cand.b_id,
                    prereq_category_id=cand.a_id,
                    domain_id=domain_id,
                    edge_type="contrasts_with",
                    confidence=float(verdict.get("confidence", 0.5)),
                    rationale=verdict.get("rationale", ""),
                    source="llm",
                    created_by="contrast-sync",
                    evidence_json=cand.evidence,
                )
                report.added += 1
            except InvalidEdgeError as e:  # noqa: BLE001 — 重复边等幂等冲突跳过
                report.skipped.append(f"{cand.a_name}↔{cand.b_name}: {e}")
        return report

    # ── 按 domain_id 从数据库装配（管理端点 `POST .../contrast-sync/run` 用） ──

    async def sync_from_domain(self, domain_id: int, dry_run: bool = False) -> ContrastSyncReport:
        """从数据库按 domain_id 装配 rows/category_lookup/existing_pairs 后跑一轮同步.

        装配方式与 `graph_sync.GraphSyncService` 一致（enrichment 读取复用
        `enrichment_loader.load_concept_rows`；category_lookup 同款目录树查询）；
        enrichment 表不存在/该领域暂无 enrichment 数据 → 优雅返回空报告
        （`candidates=0`），不抛异常。
        """
        rows = await load_concept_rows(self.db, domain_id)
        if not rows:
            return ContrastSyncReport()
        category_lookup = await self._load_category_lookup(domain_id)
        existing_pairs = await self._load_existing_contrast_pairs(domain_id)
        return await self.sync_contrasts(
            rows,
            domain_id=domain_id,
            existing_pairs=existing_pairs,
            category_lookup=category_lookup,
            dry_run=dry_run,
        )

    async def _load_category_lookup(self, domain_id: int) -> dict[int, CategoryRow]:
        """领域目录树 → {category_id: CategoryRow}（与 GraphSyncService._load_categories

        同款查询，仅用于补全候选对的展示名称；目录表异常时降级为空 lookup
        （候选仍能生成，只是 a_name/b_name 为空字符串）。
        """
        try:
            rows = (
                await self.db.execute(
                    text(
                        "SELECT id, domain_id, parent_id, name, COALESCE(description,'') AS description, "
                        "level, COALESCE(sort_order,0) AS sort_order, node_type "
                        "FROM knowledge_category WHERE domain_id = :did AND status = 1"
                    ),
                    {"did": domain_id},
                )
            ).mappings().all()
        except Exception:  # noqa: BLE001 — 目录表异常：降级为空 lookup
            return {}
        return {
            r["id"]: CategoryRow(
                id=r["id"], domain_id=r["domain_id"], parent_id=r["parent_id"],
                name=r["name"], description=r["description"], level=r["level"],
                sort_order=r["sort_order"], node_type=r["node_type"],
            )
            for r in rows
        }

    async def _load_existing_contrast_pairs(self, domain_id: int) -> set[tuple[int, int]]:
        """该领域已有的 contrasts_with 边（active/proposed，幂等跳过用）.

        contrasts_with 对称无方向，`build_contrast_candidates` 会两个方向都比对，
        这里按存表原样的 (prereq_category_id, category_id) 提供即可；查询失败
        （如列不存在的极端场景）→ 降级为空集合，最坏情况是重复生成候选，
        写入时仍会被 UNIQUE 约束 + InvalidEdgeError 挡住，不会产生脏数据。
        """
        try:
            rows = (
                await self.db.execute(
                    text(
                        "SELECT prereq_category_id, category_id FROM knowledge_category_prerequisite "
                        "WHERE domain_id = :did AND edge_type = 'contrasts_with' "
                        "AND status IN ('active','proposed')"
                    ),
                    {"did": domain_id},
                )
            ).mappings().all()
        except Exception:  # noqa: BLE001
            return set()
        return {(int(r["prereq_category_id"]), int(r["category_id"])) for r in rows}
