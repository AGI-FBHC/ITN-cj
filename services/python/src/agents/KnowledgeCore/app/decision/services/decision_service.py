"""双轨推断主流程与裁决服务."""
from __future__ import annotations
from typing import Optional

import uuid
from datetime import datetime

from sqlalchemy import bindparam, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.decision.models.orm import DecisionRecordORM, FactSnapshotORM
from app.domain.services.domain_service import DomainService
from app.evidence.services.evidence_service import EvidenceService
from app.evidence.services.evidence_judge import EvidenceJudge
from app.graph.services.graph_service import GraphService
from app.knowledge.services.retrieval_service import KnowledgeRetrievalService
from app.rules.services.rule_service import RuleService


# ── HF（High-Fidelity）判定阈值：high/medium/low 三档 ─────────────────────
# 用于契约补救建议与人工评估参考。
# 2026-08-20 按 40 条 qa_golden 校准更新（0.8/0.5/0.3 → 0.5/0.3/0.1）：
# 开启重排 + LLM judge + 门控修复后，answerable 实测全部落在 0.54~0.72、
# unanswerable 全部 0.0；high=0.5 保证可回答问题零误拒（answerable 最低 0.542
# 留有余量），网格搜索三档一致率 70%（restricted 档在 judge 留/剔二值判定下
# 无中间态，为当前信号体系的已知天花板，详见修改记录 2026-08-20）。
HF_THRESHOLDS: dict[str, float] = {
    "high": 0.5,
    "medium": 0.3,
    "low": 0.1,
}


class DecisionService:
    """双轨推断主流程编排、资格门控、高保真评分、决策契约生成."""

    # ── HF（High-Fidelity）六维权重（T2.4 诚实化） ──────────────────────
    # freshness 曾是写死 0.8 的假维度（见 817 体检结论），本次并入 applicability，
    # 不再作为独立维度；graph_consistency 已在 T1.2 接入真实图谱 BFS 打分。
    # 正权重（不含 conflict_risk 负项）之和 = 1。
    HF_WEIGHTS = {
        "coverage": 0.25,             # REAL：证据条数 / 期望条数（evidence_service._calculate_pack_scores）
        "authority": 0.15,            # REAL：来源文档 reliability_score 加权平均（无元数据时退化为缺省 0.8）
        "applicability": 0.35,        # REAL：平均相似度/分类置信度；已吸收原 freshness(0.10) 权重
        "graph_consistency": 0.15,    # REAL（T1.2）：沿 knowledge_category_prerequisite BFS 打分
        "source_independence": 0.10,  # REAL：唯一文档数 / 期望来源数
        "conflict_risk": -0.05,       # REAL（负项）：detect_conflicts 检出冲突数折算，不计入正权重之和
    }

    # HF thresholds（模块常量 HF_THRESHOLDS 的类属性别名，兼容既有 self.HF_THRESHOLDS 用法）
    HF_THRESHOLDS = HF_THRESHOLDS

    # Eligibility thresholds
    ELIGIBILITY_THRESHOLDS = {
        # 2026-08-20：0.5 → 0.3。coverage = min(1, 证据数/3)，0.5 等价于要求 ≥2 条
        # 证据，与下方 min_evidence_count=1 自相矛盾——单一来源的事实性问题
        # （答案只存在于一个切片）会被一刀切拒答（judge 修复后 40 条 qa golden
        # 实测 8 条 answerable 因此 HF=0）。0.3 即 1 条合格证据可过门。
        "min_coverage": 0.3,
        "min_authority": 0.3,
        "min_applicability": 0.3,
        "min_freshness": 0.3,
        "max_conflict_risk": 0.5,
        "min_evidence_count": 1,
    }

    def __init__(
        self,
        db: AsyncSession,
        knowledge_retriever: Optional[KnowledgeRetrievalService] = None,
        judge: Optional[EvidenceJudge] = None,
    ):
        self.db = db
        self.domain_service = DomainService(db)
        self.evidence_service = EvidenceService(
            db, knowledge_retriever=knowledge_retriever, judge=judge
        )
        self.rule_service = RuleService(db)
        self.knowledge_retriever = knowledge_retriever or KnowledgeRetrievalService(db)

    # ── 内存模式默认规则（不依赖 rule_bundles 表） ────────────────────────

    @staticmethod
    def _default_rules() -> list[dict]:
        """内置默认规则：证据下限 + 高风险任务门控（soft，不阻断，仅记录）."""
        return [
            {
                "rule_id": "rule_evidence_min",
                "name": "证据数量下限",
                "level": "soft",
                "predicate": "evidence_count_below",
                "params": {"threshold": 1},
                "action": "restrict",
                "message": "证据不足，决策受限",
            },
            {
                "rule_id": "rule_high_risk_task",
                "name": "高风险任务门控",
                "level": "soft",
                "predicate": "high_risk_task",
                "params": {},
                "action": "restrict",
                "message": "高风险任务（练习/排障），输出受限",
            },
        ]

    async def _resolve_knowledge_domain(self, domain_id: Optional[str]) -> Optional[dict]:
        """从 knowledge_domain 表解析领域（替代 domains 表）."""
        if domain_id:
            row = await self.knowledge_retriever.resolve_domain(domain_id)
            if row:
                return row
        result = await self.db.execute(
            text("SELECT id, code, name FROM knowledge_domain ORDER BY id LIMIT 1")
        )
        row = result.mappings().first()
        return dict(row) if row else None

    async def resolve(
        self,
        domain_id: Optional[str] = None,
        query: str = "",
        task_type: Optional[str] = None,
        user_context: Optional[dict] = None,
        constraints: Optional[dict] = None,
        top_k: int = 10,
        similarity_threshold: float = 0.2,
        dataset_ids: Optional[list[str]] = None,
    ) -> dict:
        """完整双轨推断（纯内存版，仅依赖 knowledge_* 六表）. 

        与旧版差异：领域取自 knowledge_domain（非 domains 表）、
        规则用内置默认规则（非 rule_bundles 表）、证据检索走三级降级
        （非直连 RAGFlow）、事实快照/证据包/决策契约全部不落库。
        """
        # ① 领域：knowledge_domain（替代 domains 表）
        domain = await self._resolve_knowledge_domain(domain_id)
        if not domain:
            raise ValueError("No domains found. Please create a knowledge domain first.")
        domain_code = domain["code"]
        snapshot_id = f"kdom_{domain['id']}"

        # ② 事实快照（内存，不落 fact_snapshots 表）
        fact_snapshot = {
            "fact_id": f"fact_{uuid.uuid4().hex[:8]}",
            "domain_runtime_snapshot_id": snapshot_id,
            "query": query,
            "task_type": task_type or "question",
            "user_context": {
                "learner": (user_context or {}).get("learner") or {},
                **(user_context or {}),
            },
            "relevant_sections": [],
            "relevant_skills": [],
            "prerequisite_chain": [],
            "related_entities": [],
            "constraints": constraints or {},
        }

        # ③ 内置默认规则（替代 rule_bundles 表）
        rules = self._default_rules()

        # ④ 预检索规则
        retrieval_hints = await self.rule_service.pre_retrieval_rules(fact_snapshot, rules)

        # ⑤ 证据检索：knowledge 三级降级（不落 evidence_packs/items 表）
        evidence = await self.evidence_service.search_evidence_inline(
            query=query,
            domain_code=domain_code,
            top_k=top_k,
            dataset_ids=dataset_ids,
            similarity_threshold=similarity_threshold,
        )
        items = evidence["items"]

        # ⑤-2 T1.3：task_type → chunk 元数据过滤偏好（练习/排障优先含代码块切片）
        prefer = self._prefer_for_task_type(task_type)
        if prefer and items:
            items = await self._reorder_by_prefer(
                items,
                domain_code=domain_code,
                query=query,
                prefer=prefer,
                dataset_ids=dataset_ids,
                top_k=top_k,
            )

        # ⑥ 后检索规则（过滤/重排）
        post_results = await self.rule_service.post_retrieval_rules(
            fact_snapshot,
            {"evidence_items": items},
            rules,
        )
        filtered = post_results.get("filtered_items", [])
        if filtered is not None and filtered != items:
            items = filtered

        # ⑦ 规则执行（内存，不落 rule_execution_logs 表）
        # 注入 evidence_pack 上下文，使 evidence_count_below 等谓词拿到真实证据数
        rule_context = {**fact_snapshot, "evidence_pack": {"evidence_items": items}}
        rule_results = await self.rule_service.execute_rules(
            rule_context,
            rules,
            domain_id=str(domain["id"]),
            persist=False,
        )

        # ⑧ 资格门控（内存评分）
        eligibility = self._eligibility_memory(items, evidence["scores"], rule_results)

        # ⑧-2 T2.3：门控判定证据不足 → 检索 miss 日志（fire-and-forget，失败静默）
        if eligibility.get("gate_type") == "insufficient_evidence":
            await self.knowledge_retriever.log_retrieval_miss(
                query, domain.get("id"), stage="gate", task_type=task_type
            )

        # ⑨ 高保真评分（T1.2：graph_consistency 接真实图谱一致性打分）
        evidence_category_ids = await self._evidence_category_ids(items)
        target_category = await self.knowledge_retriever.resolve_category(domain["id"], query)
        target_category_id = target_category["id"] if target_category else None
        graph_service = GraphService(self.db)
        graph_consistency = await graph_service.consistency_score(evidence_category_ids, target_category_id)
        graph_consistency_detail = await graph_service.consistency_detail(
            evidence_category_ids, target_category_id
        )
        hf_score, hf_breakdown = self._hf_memory(eligibility, evidence["scores"], graph_consistency)

        # ⑨-2 T4.5：GraphRAG 一跳（开关默认 off）。coverage/eligibility/hf 均已基于
        # 基础证据算完，此处追加的先修证据不计入 coverage 分子（不影响上面已算出的分数）。
        if get_settings().KNOWLEDGE_GRAPH_RAG and target_category_id is not None:
            prerequisite_chain = await graph_service.direct_prerequisites(target_category_id)
            fact_snapshot["prerequisite_chain"] = prerequisite_chain
            prereq_items = await self._prerequisite_evidence_items(prerequisite_chain)
            if prereq_items:
                items = items + prereq_items

        # ⑩ 决策契约（内存，不落 decision_records 表）
        contract = self._contract_memory(
            domain_id=str(domain["id"]),
            snapshot_id=snapshot_id,
            fact_snapshot=fact_snapshot,
            eligibility=eligibility,
            hf_score=hf_score,
            items=items,
            rule_results=rule_results,
            evidence=evidence,
            hf_breakdown=hf_breakdown,
            graph_consistency_detail=graph_consistency_detail,
        )

        return contract

    # ── T1.3：task_type → chunk 偏好映射 ─────────────────────────────────

    # exercise/troubleshooting（练习/排障）优先含代码块切片；question/explanation 不特殊排序
    PREFER_BY_TASK_TYPE: dict[str, str] = {
        "exercise": "code",
        "troubleshooting": "code",
    }

    @classmethod
    def _prefer_for_task_type(cls, task_type: Optional[str]) -> Optional[str]:
        """fact.task_type → retrieval_service prefer 参数映射（T1.3）."""
        return cls.PREFER_BY_TASK_TYPE.get(task_type or "")

    async def _reorder_by_prefer(
        self,
        items: list[dict],
        domain_code: str,
        query: str,
        prefer: str,
        dataset_ids: Optional[list[str]],
        top_k: int,
    ) -> list[dict]:
        """按 prefer 对证据重排序：取底层 retrieve_chunks(prefer=...) 的参考顺序重排现有证据.

        只调整顺序、不改变证据集合本身；参考检索失败时静默降级，保持原序不受影响。
        """
        try:
            ref = await self.knowledge_retriever.retrieve_chunks(
                knowledge_point=query,
                domain=domain_code,
                prefer=prefer,
                dataset_ids=dataset_ids,
                limit=top_k,
                include_rag=False,
            )
        except Exception:  # noqa: BLE001 — 重排是锦上添花，不应影响主检索链路
            return items
        rank = {
            str(c.get("chunk_id")): i
            for i, c in enumerate(ref.get("chunks", []))
            if c.get("chunk_id")
        }
        if not rank:
            return items
        return sorted(items, key=lambda it: rank.get(str(it.get("chunk_id")), len(rank)))

    # ── T1.2：图一致性真值化辅助 ─────────────────────────────────────────

    async def _evidence_category_ids(self, items: list[dict]) -> list[int]:
        """从 knowledge_chunk_category 反查证据切片归属的 category_id 集合.

        仅 mysql/parent 层证据（chunk_id 为 knowledge_chunk.id 数字）可反查；
        RAG 层证据 chunk_id 为 RAGFlow id，跳过。查询失败静默降级为空列表。
        """
        chunk_ids = [
            int(it["chunk_id"]) for it in items if str(it.get("chunk_id") or "").isdigit()
        ]
        if not chunk_ids:
            return []
        try:
            rows = (
                await self.db.execute(
                    text(
                        "SELECT DISTINCT category_id FROM knowledge_chunk_category "
                        "WHERE chunk_id IN :ids"
                    ).bindparams(bindparam("ids", expanding=True)),
                    {"ids": tuple(chunk_ids)},
                )
            ).mappings().all()
        except Exception:  # noqa: BLE001 — 分类关系缺失/查询失败不应中断决策主链路
            return []
        return [int(r["category_id"]) for r in rows]

    # ── T4.5：GraphRAG 一跳辅助 ──────────────────────────────────────────

    async def _prerequisite_evidence_items(self, prerequisite_chain: list[dict]) -> list[dict]:
        """先修节点 → 证据 item 列表（evidence_role='prerequisite'，总数 ≤3）.

        每个先修节点取 1~2 条块（`retrieval_service.prerequisite_evidence_chunks`
        enrichment 有定义块优先），累计到 3 条即停止；单节点/整体查询异常静默跳过
        （GraphRAG 是增强项，不应影响主决策链路）。这批证据在调用方（resolve()）
        追加到 items 时已经晚于 coverage/eligibility/hf 的计算，天然不计入 coverage 分子。
        """
        items: list[dict] = []
        for node in prerequisite_chain:
            if len(items) >= 3:
                break
            take = min(2, 3 - len(items))
            try:
                chunks = await self.knowledge_retriever.prerequisite_evidence_chunks(
                    node["category_id"], limit=take
                )
            except Exception:  # noqa: BLE001 — 先修证据是增强项，不应影响主决策链路
                chunks = []
            for c in chunks:
                items.append(
                    {
                        "evidence_id": f"evi_{uuid.uuid4().hex[:8]}",
                        "chunk_id": str(c.get("chunk_id") or ""),
                        "document_id": str(c.get("document_id") or ""),
                        "content": c.get("content", ""),
                        "section_path": c.get("title_path") or None,
                        "heading": c.get("section_title"),
                        "similarity_score": float(c.get("confidence") or 0.0),
                        "evidence_role": "prerequisite",
                        "authority_level": "official",
                        "metadata": {
                            "source": "prerequisite",
                            "prerequisite_category_id": node.get("category_id"),
                        },
                    }
                )
                if len(items) >= 3:
                    break
        return items

    def _eligibility_memory(
        self,
        items: list[dict],
        scores: dict,
        rule_results: dict,
    ) -> dict:
        """资格门控（内存版）：与 check_eligibility 同一套阈值与判定逻辑."""
        evidence_count = len(items)
        coverage_score = scores.get("coverage_score", 0.0)
        authority_score = scores.get("authority_score", 0.0)
        applicability_score = scores.get("applicability_score", 0.0)
        freshness_score = scores.get("freshness_score", 0.0)
        conflict_risk_score = scores.get("conflict_risk_score", 0.0)

        thresholds = self.ELIGIBILITY_THRESHOLDS
        failure_reasons: list[str] = []
        remediation_suggestions: list[str] = []

        if evidence_count < thresholds["min_evidence_count"]:
            failure_reasons.append(f"证据数量不足: {evidence_count} < {thresholds['min_evidence_count']}")
            remediation_suggestions.append("尝试扩大检索范围或降低相似度阈值")

        coverage_passed = coverage_score >= thresholds["min_coverage"]
        if not coverage_passed:
            failure_reasons.append(f"覆盖度不足: {coverage_score:.2f} < {thresholds['min_coverage']}")
            remediation_suggestions.append("缺少关键知识点的证据")

        authority_passed = authority_score >= thresholds["min_authority"]
        if not authority_passed:
            failure_reasons.append(f"权威性不足: {authority_score:.2f} < {thresholds['min_authority']}")
            remediation_suggestions.append("尝试从官方文档中检索更权威的证据")

        applicability_passed = applicability_score >= thresholds["min_applicability"]
        if not applicability_passed:
            failure_reasons.append(f"适用性不足: {applicability_score:.2f} < {thresholds['min_applicability']}")
            remediation_suggestions.append("尝试使用更精确的查询词")

        freshness_passed = freshness_score >= thresholds["min_freshness"]
        if not freshness_passed:
            failure_reasons.append(f"时效性不足: {freshness_score:.2f} < {thresholds['min_freshness']}")
            remediation_suggestions.append("检查是否有更新版本的文档")

        conflict_check_passed = conflict_risk_score <= thresholds["max_conflict_risk"]
        if not conflict_check_passed:
            failure_reasons.append(f"冲突风险过高: {conflict_risk_score:.2f} > {thresholds['max_conflict_risk']}")
            remediation_suggestions.append("存在证据冲突，需要人工审核")

        if not rule_results.get("passed", True):
            for rule in rule_results.get("blocked_by", []):
                failure_reasons.append(f"被规则阻止: {rule.get('rule_id', '')} - {rule.get('message', '')}")

        is_eligible = (
            coverage_passed
            and authority_passed
            and applicability_passed
            and freshness_passed
            and conflict_check_passed
            and rule_results.get("passed", True)
            and evidence_count >= thresholds["min_evidence_count"]
        )

        if is_eligible:
            gate_type = "pass"
        elif not conflict_check_passed:
            gate_type = "blocked"
        elif evidence_count < thresholds["min_evidence_count"]:
            gate_type = "insufficient_evidence"
        elif not rule_results.get("passed", True):
            gate_type = "blocked"
        else:
            gate_type = "restricted"

        if is_eligible:
            decision = "permit"
        elif gate_type == "blocked":
            decision = "block"
        elif gate_type == "insufficient_evidence":
            decision = "retrieve_again"
        else:
            decision = "restrict_scope"

        return {
            "is_eligible": is_eligible,
            "gate_type": gate_type,
            "decision": decision,
            "coverage_passed": coverage_passed,
            "authority_passed": authority_passed,
            "applicability_passed": applicability_passed,
            "freshness_passed": freshness_passed,
            "conflict_check_passed": conflict_check_passed,
            "failure_reasons": failure_reasons,
            "remediation_suggestions": remediation_suggestions,
            "scores": {
                "coverage": coverage_score,
                "authority": authority_score,
                "applicability": applicability_score,
                "freshness": freshness_score,
                "conflict_risk": conflict_risk_score,
            },
        }

    def _hf_breakdown(self, eligibility: dict, scores: dict, graph_consistency: float) -> dict[str, float]:
        """按 HF_WEIGHTS 计算各维度加权贡献（T2.4：audit_trail 可见各维度贡献）."""
        w = self.HF_WEIGHTS
        if not eligibility.get("is_eligible", False):
            return {k: 0.0 for k in w}
        s = eligibility.get("scores", {})
        return {
            "coverage": w["coverage"] * s.get("coverage", 0.0),
            "authority": w["authority"] * s.get("authority", 0.0),
            "applicability": w["applicability"] * s.get("applicability", 0.0),
            "graph_consistency": w["graph_consistency"] * graph_consistency,
            "source_independence": w["source_independence"] * scores.get("source_independence_score", 0.0),
            "conflict_risk": w["conflict_risk"] * s.get("conflict_risk", 0.0),
        }

    def _hf_memory(
        self, eligibility: dict, scores: dict, graph_consistency: float = 1.0
    ) -> tuple[float, dict[str, float]]:
        """高保真评分（内存版）：与 calculate_high_fidelity_score 同权重.

        graph_consistency：T1.2 起由调用方传入真实图谱一致性打分（默认 1.0 兼容旧调用方）。
        返回 (hf_score, 各维度加权贡献明细)。
        """
        breakdown = self._hf_breakdown(eligibility, scores, graph_consistency)
        hf = max(0.0, min(1.0, sum(breakdown.values())))
        return hf, breakdown

    def _contract_memory(
        self,
        domain_id: str,
        snapshot_id: str,
        fact_snapshot: dict,
        eligibility: dict,
        hf_score: float,
        items: list[dict],
        rule_results: dict,
        evidence: dict,
        hf_breakdown: Optional[dict[str, float]] = None,
        graph_consistency_detail: Optional[list[dict]] = None,
    ) -> dict:
        """决策契约（内存版）：与 generate_decision_contract 同构，但不落库."""
        contract_id = f"kdc_{uuid.uuid4().hex[:8]}"
        decision_status = eligibility["decision"]

        permitted_actions = self._determine_permitted_actions(decision_status, hf_score)

        sorted_items = sorted(items, key=lambda x: x.get("similarity_score", 0.0), reverse=True)
        required_citations = [i["chunk_id"] for i in sorted_items[:3]]

        prohibited_content = self._determine_prohibited_content(decision_status, eligibility)

        remediation_items = list(eligibility.get("remediation_suggestions", []))
        if hf_score < self.HF_THRESHOLDS["medium"]:
            remediation_items.append("建议提供更多相关文档以提高置信度")

        audit_trail = [
            {
                "step": "eligibility_check",
                "timestamp": datetime.now().isoformat(),
                "result": {
                    "is_eligible": eligibility.get("is_eligible", False),
                    "gate_type": eligibility.get("gate_type", "unknown"),
                    "failure_reasons": eligibility.get("failure_reasons", []),
                },
            },
            {
                "step": "hf_scoring",
                "timestamp": datetime.now().isoformat(),
                "result": {"hf_score": hf_score, "hf_breakdown": hf_breakdown or {}},
            },
            {
                "step": "graph_consistency_detail",
                "timestamp": datetime.now().isoformat(),
                "result": {"details": graph_consistency_detail or []},
            },
            {
                "step": "prerequisite_chain",
                "timestamp": datetime.now().isoformat(),
                "result": {"chain": fact_snapshot.get("prerequisite_chain", [])},
            },
            {
                "step": "evidence_summary",
                "timestamp": datetime.now().isoformat(),
                "result": {
                    "evidence_pack_id": evidence["pack_id"],
                    "required_citations_count": len(required_citations),
                },
            },
        ]

        evidence_items_list = []
        for item in items:
            content = item.get("content", "")
            evidence_items_list.append(
                {
                    "evidence_id": item.get("evidence_id", ""),
                    "chunk_id": item.get("chunk_id", ""),
                    "document_id": item.get("document_id", ""),
                    "content": content[:200] + "..." if len(content) > 200 else content,
                    "similarity_score": item.get("similarity_score", 0.0),
                    "evidence_role": item.get("evidence_role", "base"),
                    "authority_level": item.get("authority_level", "official"),
                    "heading": item.get("heading"),
                }
            )

        rule_hits = []
        for rule in rule_results.get("hit_rules", []):
            rule_hits.append(
                {
                    "rule_id": rule.get("rule_id", ""),
                    "name": rule.get("name", ""),
                    "level": rule.get("level", ""),
                    "action": rule.get("action", ""),
                    "message": rule.get("message", ""),
                }
            )

        return {
            "contract_id": contract_id,
            "decision": decision_status,
            "high_fidelity_score": hf_score,
            "domain_runtime_snapshot_id": snapshot_id,
            "fact_snapshot_id": fact_snapshot["fact_id"],
            "evidence_pack_id": evidence["pack_id"],
            "eligibility": eligibility,
            "permitted_actions": permitted_actions,
            "required_citations": required_citations,
            "prohibited_content": prohibited_content,
            "remediation_items": remediation_items,
            "evidence_count": len(items),
            "evidence_items": evidence_items_list,
            "coverage_score": eligibility["scores"]["coverage"],
            "authority_score": eligibility["scores"]["authority"],
            "rule_hits": rule_hits,
            "audit_trail": audit_trail,
            "created_at": datetime.now().isoformat(),
        }

    async def check_eligibility(
        self,
        fact_snapshot: dict,
        evidence_pack_id: str,
        rule_results: dict,
        graph_validation: dict,
    ) -> dict:
        """资格门控检查."""
        # Get evidence pack
        pack = await self.evidence_service.get_evidence_pack(evidence_pack_id)
        items = await self.evidence_service.get_evidence_items(evidence_pack_id)

        # Default scores if pack not fully populated
        coverage_score = pack.coverage_score if pack else 0.0
        authority_score = pack.authority_score if pack else 0.0
        applicability_score = pack.applicability_score if pack else 0.0
        freshness_score = pack.freshness_score if pack else 0.0
        conflict_risk_score = pack.conflict_risk_score if pack else 0.0

        thresholds = self.ELIGIBILITY_THRESHOLDS
        failure_reasons = []
        remediation_suggestions = []

        # Check evidence count
        evidence_count = len(items)
        if evidence_count < thresholds["min_evidence_count"]:
            failure_reasons.append(f"证据数量不足: {evidence_count} < {thresholds['min_evidence_count']}")
            remediation_suggestions.append("尝试扩大检索范围或降低相似度阈值")

        # Check coverage
        coverage_passed = coverage_score >= thresholds["min_coverage"]
        if not coverage_passed:
            failure_reasons.append(f"覆盖度不足: {coverage_score:.2f} < {thresholds['min_coverage']}")
            remediation_suggestions.append("缺少关键知识点的证据")

        # Check authority
        authority_passed = authority_score >= thresholds["min_authority"]
        if not authority_passed:
            failure_reasons.append(f"权威性不足: {authority_score:.2f} < {thresholds['min_authority']}")
            remediation_suggestions.append("尝试从官方文档中检索更权威的证据")

        # Check applicability
        applicability_passed = applicability_score >= thresholds["min_applicability"]
        if not applicability_passed:
            failure_reasons.append(f"适用性不足: {applicability_score:.2f} < {thresholds['min_applicability']}")
            remediation_suggestions.append("尝试使用更精确的查询词")

        # Check freshness
        freshness_passed = freshness_score >= thresholds["min_freshness"]
        if not freshness_passed:
            failure_reasons.append(f"时效性不足: {freshness_score:.2f} < {thresholds['min_freshness']}")
            remediation_suggestions.append("检查是否有更新版本的文档")

        # Check conflict risk
        conflict_check_passed = conflict_risk_score <= thresholds["max_conflict_risk"]
        if not conflict_check_passed:
            failure_reasons.append(f"冲突风险过高: {conflict_risk_score:.2f} > {thresholds['max_conflict_risk']}")
            remediation_suggestions.append("存在证据冲突，需要人工审核")

        # Check rules
        if not rule_results.get("passed", True):
            blocked_by = rule_results.get("blocked_by", [])
            for rule in blocked_by:
                failure_reasons.append(f"被规则阻止: {rule.get('rule_id', '')} - {rule.get('message', '')}")

        # Check graph consistency
        graph_consistent = graph_validation.get("is_consistent", True)
        if not graph_consistent:
            failure_reasons.append("图谱一致性校验失败")
            remediation_suggestions.append("检查先修关系和依赖完整性")

        # Determine eligibility
        is_eligible = (
            coverage_passed
            and authority_passed
            and applicability_passed
            and freshness_passed
            and conflict_check_passed
            and rule_results.get("passed", True)
            and graph_consistent
            and evidence_count >= thresholds["min_evidence_count"]
        )

        # Determine gate type
        if is_eligible:
            gate_type = "pass"
        elif not conflict_check_passed:
            gate_type = "blocked"
        elif evidence_count < thresholds["min_evidence_count"]:
            gate_type = "insufficient_evidence"
        elif not rule_results.get("passed", True):
            gate_type = "blocked"
        else:
            gate_type = "restricted"

        # Determine decision
        if is_eligible:
            decision = "permit"
        elif gate_type == "blocked":
            decision = "block"
        elif gate_type == "insufficient_evidence":
            decision = "retrieve_again"
        else:
            decision = "restrict_scope"

        return {
            "is_eligible": is_eligible,
            "gate_type": gate_type,
            "decision": decision,
            "coverage_passed": coverage_passed,
            "authority_passed": authority_passed,
            "applicability_passed": applicability_passed,
            "freshness_passed": freshness_passed,
            "conflict_check_passed": conflict_check_passed,
            "failure_reasons": failure_reasons,
            "remediation_suggestions": remediation_suggestions,
            "scores": {
                "coverage": coverage_score,
                "authority": authority_score,
                "applicability": applicability_score,
                "freshness": freshness_score,
                "conflict_risk": conflict_risk_score,
            },
        }

    async def calculate_high_fidelity_score(
        self,
        eligibility: dict,
        evidence_pack_id: str,
        graph_validation: dict,
    ) -> float:
        """高保真评分计算（T2.4：freshness 已并入 applicability，不再单列）."""
        if not eligibility.get("is_eligible", False):
            return 0.0

        scores = eligibility.get("scores", {})
        w = self.HF_WEIGHTS
        graph_consistency = graph_validation.get("consistency_score", 1.0)

        # Get source independence from evidence pack
        pack = await self.evidence_service.get_evidence_pack(evidence_pack_id)
        source_independence = pack.source_independence_score if pack else 0.0

        hf = (
            w["coverage"] * scores.get("coverage", 0.0)
            + w["authority"] * scores.get("authority", 0.0)
            + w["applicability"] * scores.get("applicability", 0.0)
            + w["graph_consistency"] * graph_consistency
            + w["source_independence"] * source_independence
            + w["conflict_risk"] * scores.get("conflict_risk", 0.0)
        )

        return max(0.0, min(1.0, hf))

    async def generate_decision_contract(
        self,
        domain_id: str,
        snapshot_id: str,
        decision_status: str,
        hf_score: float,
        evidence_pack_id: str,
        matched_rules: list[str],
        fact_snapshot: Optional[dict] = None,
        eligibility: Optional[dict] = None,
        rule_results: Optional[dict] = None,
    ) -> dict:
        """生成决策契约."""
        contract_id = f"kdc_{uuid.uuid4().hex[:8]}"

        # Determine permitted actions
        permitted_actions = self._determine_permitted_actions(decision_status, hf_score)

        # Determine required citations
        required_citations = []
        if evidence_pack_id:
            items = await self.evidence_service.get_evidence_items(evidence_pack_id)
            sorted_items = sorted(items, key=lambda x: x.similarity_score, reverse=True)
            required_citations = [item.chunk_id for item in sorted_items[:3]]

        # Determine prohibited content
        prohibited_content = self._determine_prohibited_content(decision_status, eligibility or {})

        # Generate remediation
        remediation_items = (eligibility or {}).get("remediation_suggestions", [])
        if hf_score < self.HF_THRESHOLDS["medium"]:
            remediation_items.append("建议提供更多相关文档以提高置信度")

        # Build audit trail
        audit_trail = [
            {
                "step": "eligibility_check",
                "timestamp": datetime.now().isoformat(),
                "result": {
                    "is_eligible": (eligibility or {}).get("is_eligible", False),
                    "gate_type": (eligibility or {}).get("gate_type", "unknown"),
                    "failure_reasons": (eligibility or {}).get("failure_reasons", []),
                },
            },
            {
                "step": "hf_scoring",
                "timestamp": datetime.now().isoformat(),
                "result": {"hf_score": hf_score},
            },
            {
                "step": "evidence_summary",
                "timestamp": datetime.now().isoformat(),
                "result": {
                    "evidence_pack_id": evidence_pack_id,
                    "required_citations_count": len(required_citations),
                },
            },
        ]

        # Get evidence pack details
        evidence_pack = await self.evidence_service.get_evidence_pack(evidence_pack_id)
        evidence_items = await self.evidence_service.get_evidence_items(evidence_pack_id)
        evidence_count = len(evidence_items)

        # Persist decision record
        record = DecisionRecordORM(
            contract_id=contract_id,
            domain_id=domain_id,
            domain_version_id="",
            decision=decision_status,
            high_fidelity_score=hf_score,
            domain_runtime_snapshot_id=snapshot_id,
            fact_snapshot_id=fact_snapshot.get("fact_id", "") if fact_snapshot else "",
            evidence_pack_id=evidence_pack_id,
            eligibility_json=eligibility,
            permitted_actions=permitted_actions,
            required_citations=required_citations,
            prohibited_content=prohibited_content,
            remediation_items=remediation_items,
            audit_trail=audit_trail,
            query=fact_snapshot.get("query", "") if fact_snapshot else "",
            task_type=fact_snapshot.get("task_type") if fact_snapshot else None,
            user_context=fact_snapshot.get("user_context") if fact_snapshot else None,
        )
        self.db.add(record)
        await self.db.commit()
        await self.db.refresh(record)

        # Build evidence items list
        evidence_items_list = []
        for item in evidence_items:
            evidence_items_list.append({
                "evidence_id": item.evidence_id,
                "chunk_id": item.chunk_id,
                "document_id": item.document_id,
                "content": item.content[:200] + "..." if len(item.content) > 200 else item.content,
                "similarity_score": item.similarity_score,
                "evidence_role": item.evidence_role,
                "authority_level": item.authority_level,
                "heading": item.heading,
            })

        # Build rule hits list
        rule_hits = []
        if rule_results:
            for rule in rule_results.get("hit_rules", []):
                rule_hits.append({
                    "rule_id": rule.get("rule_id", ""),
                    "name": rule.get("name", ""),
                    "level": rule.get("level", ""),
                    "action": rule.get("action", ""),
                    "message": rule.get("message", ""),
                })

        return {
            "contract_id": contract_id,
            "decision": decision_status,
            "high_fidelity_score": hf_score,
            "domain_runtime_snapshot_id": snapshot_id,
            "fact_snapshot_id": fact_snapshot.get("fact_id", "") if fact_snapshot else "",
            "evidence_pack_id": evidence_pack_id,
            "eligibility": eligibility or {},
            "permitted_actions": permitted_actions,
            "required_citations": required_citations,
            "prohibited_content": prohibited_content,
            "remediation_items": remediation_items,
            "evidence_count": evidence_count,
            "evidence_items": evidence_items_list,
            "coverage_score": evidence_pack.coverage_score if evidence_pack else 0.0,
            "authority_score": evidence_pack.authority_score if evidence_pack else 0.0,
            "rule_hits": rule_hits,
            "audit_trail": audit_trail,
            "created_at": datetime.now().isoformat(),
        }

    def _determine_permitted_actions(self, decision: str, hf_score: float) -> list[str]:
        """确定允许的操作."""
        if decision == "block":
            return []
        elif decision == "permit":
            return [
                "answer_question",
                "provide_explanation",
                "show_code_examples",
                "reference_figures",
            ]
        elif decision == "restrict_scope":
            actions = ["answer_question"]
            if hf_score >= 0.5:
                actions.append("provide_explanation")
            return actions
        elif decision == "retrieve_again":
            return ["request_more_info"]
        else:  # request_human_review
            return ["escalate_to_human"]

    def _determine_prohibited_content(self, decision: str, eligibility: dict) -> list[str]:
        """确定禁止的内容."""
        prohibited = []

        if decision == "block":
            prohibited.append("any_response")
        elif decision == "restrict_scope":
            if not eligibility.get("coverage_passed", True):
                prohibited.append("content_beyond_coverage")
            if not eligibility.get("authority_passed", True):
                prohibited.append("unverified_claims")
        elif decision == "request_human_review":
            prohibited.append("definitive_answers")

        return prohibited

    async def get_decision(self, contract_id: str) -> Optional[DecisionRecordORM]:
        """获取决策记录."""
        result = await self.db.execute(
            select(DecisionRecordORM).where(DecisionRecordORM.contract_id == contract_id)
        )
        return result.scalar_one_or_none()

    async def list_decisions(
        self,
        domain_id: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
    ) -> list[DecisionRecordORM]:
        """列出决策记录."""
        query = select(DecisionRecordORM)
        if domain_id:
            query = query.where(DecisionRecordORM.domain_id == domain_id)
        query = query.order_by(DecisionRecordORM.created_at.desc()).limit(limit).offset(offset)

        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def replay_decision(
        self,
        domain_runtime_snapshot_id: str,
        query: str,
        task_type: Optional[str] = None,
    ) -> dict:
        """回放：内存模式下无历史快照表，直接用当前领域重跑决策."""
        return await self.resolve(
            domain_id=domain_runtime_snapshot_id,
            query=query,
            task_type=task_type,
        )

    async def _ensure_snapshot(self, domain_id: str):
        """确保领域有运行快照，如果没有则创建一个."""
        # First check if domain exists, create if not
        domain = await self.domain_service.get_domain(domain_id)
        if not domain:
            # Auto-create domain
            domain = await self.domain_service.create_domain(
                domain_id=domain_id,
                name=f"Auto-created domain: {domain_id}",
                description="Automatically created for knowledge resolution",
            )

        # Check for active version
        versions = await self.domain_service.list_versions(domain_id)
        if not versions:
            # Create a default version
            version = await self.domain_service.create_version(
                domain_id=domain_id,
                version="v1",
            )
        else:
            version = versions[0]

        # Activate version and create snapshot
        try:
            snapshot = await self.domain_service.activate_version(
                domain_id=domain_id,
                version=version.version,
                activated_by="system",
            )
        except Exception:
            # If activation fails, try to get existing snapshot
            snapshot = await self.domain_service.get_latest_snapshot(domain_id)
            if not snapshot:
                raise ValueError(f"Failed to create snapshot for domain '{domain_id}'")

        return snapshot
