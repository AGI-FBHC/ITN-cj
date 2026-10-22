"""证据检索与验证服务."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import bindparam, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.evidence.models.orm import EvidenceItemORM, EvidencePackORM
from app.evidence.services.evidence_judge import EvidenceJudge
from app.evidence.services.ragflow_retriever import RAGFlowRetriever
from app.knowledge.services.retrieval_service import KnowledgeRetrievalService


class EvidenceService:
    """证据检索、过滤、Evidence Pack 生成.

    检索层复用 knowledge 模块的三级降级检索（MySQL 精确 → 父级上卷 → RAG 兜底），
    取代旧的直连 RAGFlow 检索（RAGFlowRetriever 仅保留数据集查询等辅助能力）。
    """

    def __init__(
        self,
        db: AsyncSession,
        ragflow_retriever: Optional[RAGFlowRetriever] = None,
        knowledge_retriever: Optional[KnowledgeRetrievalService] = None,
        judge: Optional[EvidenceJudge] = None,
    ):
        self.db = db
        self.ragflow_retriever = ragflow_retriever or RAGFlowRetriever()
        self.knowledge_retriever = knowledge_retriever or KnowledgeRetrievalService(db)
        # LLM 证据相关性复核：显式注入优先；否则按配置开关（默认关，开启需 KNOWLEDGE_LLM_JUDGE=true）
        if judge is not None:
            self.judge = judge
        elif get_settings().KNOWLEDGE_LLM_JUDGE:
            self.judge = EvidenceJudge()
        else:
            self.judge = None

    async def search_evidence(
        self,
        domain_id: str,
        query: str,
        snapshot_id: Optional[str] = None,
        top_k: int = 10,
        similarity_threshold: float = 0.2,
        document_ids: Optional[list[str]] = None,
        dataset_ids: Optional[list[str]] = None,
    ) -> EvidencePackORM:
        """检索证据.

        使用 RAGFlow 进行实际检索，并将结果持久化到数据库。
        """
        # Create a new evidence pack
        pack_id = f"epack_{uuid.uuid4().hex[:8]}"
        pack = EvidencePackORM(
            pack_id=pack_id,
            query=query,
            domain_id=domain_id,
            domain_version_id="v1",  # Default version
            snapshot_id=snapshot_id,
        )
        self.db.add(pack)
        await self.db.commit()
        await self.db.refresh(pack)

        # If dataset_ids provided, retrieve via knowledge module's hybrid retrieval
        # (MySQL exact -> parent rollup -> RAG fallback), same logic as GET /knowledge/chunks
        if dataset_ids:
            try:
                domain_code = await self._resolve_domain_code(domain_id)
                result = await self.knowledge_retriever.retrieve_chunks(
                    knowledge_point=query,
                    domain=domain_code,
                    limit=top_k,
                    dataset_ids=dataset_ids,
                )

                # Convert chunk hits to evidence items
                evidence_items_data = self._chunks_to_evidence_items(
                    result.get("chunks", []),
                    domain_id=domain_id,
                )
                # 补文档元数据（authority/freshness 评分输入）
                await self._attach_document_meta(evidence_items_data)

                # LLM 证据相关性复核（剔除不相关证据；失败自动降级）
                judge_info = await self._judge_evidence(
                    query, evidence_items_data
                )
                evidence_items_data = judge_info["kept"]

                # Persist evidence items
                if evidence_items_data:
                    await self.add_evidence_items(pack_id, evidence_items_data)

                    # Calculate and update pack scores
                    conflicts = await self.detect_conflicts(evidence_items_data)
                    scores = self._calculate_pack_scores(
                        evidence_items_data,
                        conflict_risk_score=min(1.0, len(conflicts) * 0.2),
                    )
                    await self.update_pack_scores(pack_id, scores)

            except Exception as e:
                # Log error but don't fail - pack is still created
                print(f"Knowledge retrieval failed: {e}")

        return pack

    async def search_evidence_inline(
        self,
        query: str,
        domain_code: str | None = None,
        top_k: int = 10,
        dataset_ids: list[str] | None = None,
        similarity_threshold: float | None = None,
    ) -> dict:
        """纯内存证据检索（不建包、不落库）.

        供 decision 模块在无 evidence_packs/evidence_items 表的环境下使用：
        直接走 knowledge 三级降级检索，返回内存证据包。
        """
        # dataset_ids 可选：RAG 兜底层会按领域 code 自发现 RAGFlow 数据集
        # （_rag_fallback → resolve_dataset_ids(explicit=dataset_ids)），RAGFlow
        # 不可用时自身降级返回空+warning。历史行为是不传 dataset_ids 就整体跳过
        # 返回空包——导致现网调用方（agents 的 resolve()、eval 脚本）从不传该参数
        # 时决策链路永远 insufficient_evidence → retrieve_again，T1.1 的决策契约
        # 形同虚设；2026-08-18 基线评估时发现并修复。
        result = await self.knowledge_retriever.retrieve_chunks(
            knowledge_point=query,
            domain=domain_code or await self._resolve_domain_code(""),
            limit=top_k,
            dataset_ids=dataset_ids,
            rag_similarity_threshold=similarity_threshold,
        )
        items = self._chunks_to_evidence_items(
            result.get("chunks", []),
            domain_id=domain_code or "",
        )
        # 补文档元数据（authority/freshness 评分输入），查询失败时静默降级
        await self._attach_document_meta(items)
        # LLM 证据相关性复核（剔除不相关证据；失败自动降级不过滤）
        judge_info = await self._judge_evidence(query, items)
        items = judge_info["kept"]
        conflicts = await self.detect_conflicts(items)
        scores = self._calculate_pack_scores(
            items,
            conflict_risk_score=min(1.0, len(conflicts) * 0.2),
        )
        return {
            "pack_id": f"epack_mem_{uuid.uuid4().hex[:8]}",
            "query": query,
            "chunks": result.get("chunks", []),
            "items": items,
            "scores": scores,
            "judge": judge_info,
            "decision": result.get("decision", "empty"),
            "stats": result.get("stats", {}),
            "warning": result.get("warning"),
        }

    async def _resolve_domain_code(self, domain_id: str) -> str:
        """把 decision 领域的 domain_id 映射为 knowledge 领域的 code.

        decision 模块的 domain_id 与 knowledge_domain 表不是同一套 ID；
        先按 code/name/id 匹配，匹配不到则回退到第一个领域（表内通常只有一个）。
        """
        row = await self.knowledge_retriever.resolve_domain(domain_id)
        if row:
            return row["code"]
        result = await self.db.execute(
            text("SELECT code FROM knowledge_domain ORDER BY id LIMIT 1")
        )
        first = result.first()
        return first[0] if first else domain_id

    def _chunks_to_evidence_items(
        self,
        chunks: list[dict[str, Any]],
        domain_id: str,
    ) -> list[dict[str, Any]]:
        """把 retrieve_chunks 的 ChunkHit 形状转换为 evidence item 数据.

        mysql/parent 层命中无相似度（分类置信度可用作近似评分）；
        rag 层命中带 similarity。
        """
        items = []
        for hit in chunks:
            similarity = hit.get("similarity")
            confidence = hit.get("confidence")
            score = float(similarity if similarity is not None else confidence or 0.0)
            items.append(
                {
                    "evidence_id": f"evi_{uuid.uuid4().hex[:8]}",
                    "chunk_id": str(hit.get("chunk_id") or hit.get("ragflow_chunk_id") or ""),
                    "document_id": str(hit.get("document_id") or ""),
                    "domain_id": domain_id,
                    "domain_version_id": "v1",
                    "content": hit.get("content", ""),
                    "section_path": hit.get("title_path") or None,
                    "heading": hit.get("section_title"),
                    "chunk_type": "mixed",
                    "similarity_score": score,
                    "vector_similarity": 0.0,
                    "term_similarity": 0.0,
                    "evidence_role": "base",
                    "authority_level": "official",
                    "figure_ids": None,
                    "contains_code": False,
                    "contains_table": False,
                    "metadata": {
                        "source": hit.get("source"),
                        "confidence": confidence,
                        "category_id": None,
                    },
                }
            )
        return items

    # ── LLM 证据相关性复核（Context Precision） ───────────────────────────

    async def _judge_evidence(self, query: str, items: list[dict]) -> dict:
        """LLM 证据相关性复核：剔除不能支撑查询的证据.

        返回 {"kept": [...], "rejected": [...], "used_llm": bool, "warning": str|None}。
        judge 未启用/不可用 → 全部保留（降级，不中断检索主链路）。
        """
        if self.judge is None:
            return {"kept": items, "rejected": [], "used_llm": False, "warning": None}
        if not items:
            return {"kept": items, "rejected": [], "used_llm": False, "warning": None}
        try:
            return await self.judge.judge(query, items)
        except Exception as e:  # noqa: BLE001 — 复核层不因任何异常中断检索主链路
            return {
                "kept": items, "rejected": [],
                "used_llm": False,
                "warning": f"LLM judge 异常，跳过相关性复核: {e}",
            }

    # ── 文档元数据（authority/freshness 评分输入） ───────────────────────────

    async def _attach_document_meta(self, items: list[dict]) -> None:
        """按 chunk 归属批量补文档元数据（reliability_score / publish_year 等）.

        - mysql/parent 层：chunk_id 为 knowledge_chunk.id（数字）→ 直查 document_id
        - rag 层：chunk_id 为 RAGFlow chunk id（非数字）→ knowledge_chunk.ragflow_chunk_id 反查

        文档元数据写入 item["metadata"]["doc"]；表缺失/查询失败时静默降级
        （评分回退缺省值，不影响检索主链路）。
        """
        if not items:
            return
        chunk_to_doc: dict[str, int] = {}
        mysql_ids: list[int] = []
        ragf_ids: list[str] = []
        for it in items:
            cid = str(it.get("chunk_id") or "")
            if not cid:
                continue
            if cid.isdigit():
                mysql_ids.append(int(cid))
            else:
                ragf_ids.append(cid)
        try:
            if ragf_ids:
                rows = (
                    await self.db.execute(
                        text(
                            "SELECT ragflow_chunk_id, document_id FROM knowledge_chunk "
                            "WHERE ragflow_chunk_id IN :ids"
                        ).bindparams(bindparam("ids", expanding=True)),
                        {"ids": tuple(ragf_ids)},
                    )
                ).mappings().all()
                for r in rows:
                    if r["document_id"] is not None:
                        chunk_to_doc[r["ragflow_chunk_id"]] = int(r["document_id"])
            if mysql_ids:
                rows = (
                    await self.db.execute(
                        text(
                            "SELECT id, document_id FROM knowledge_chunk "
                            "WHERE id IN :ids"
                        ).bindparams(bindparam("ids", expanding=True)),
                        {"ids": tuple(mysql_ids)},
                    )
                ).mappings().all()
                for r in rows:
                    if r["document_id"] is not None:
                        chunk_to_doc[str(r["id"])] = int(r["document_id"])
            doc_ids = set(chunk_to_doc.values())
            if not doc_ids:
                return
            rows = (
                await self.db.execute(
                    text(
                        "SELECT id, reliability_score, publish_year, source_type, "
                        "       document_type, source_name, publisher "
                        "FROM knowledge_document WHERE id IN :ids"
                    ).bindparams(bindparam("ids", expanding=True)),
                    {"ids": tuple(doc_ids)},
                )
            ).mappings().all()
        except Exception:
            return  # 无表/查询失败：评分回退缺省值
        doc_map = {r["id"]: dict(r) for r in rows}
        for it in items:
            cid = str(it.get("chunk_id") or "")
            did = chunk_to_doc.get(cid)
            if did is None or did not in doc_map:
                continue
            it.setdefault("metadata", {})["doc"] = doc_map[did]

    async def add_evidence_items(
        self,
        pack_id: str,
        items: list[dict],
    ) -> list[EvidenceItemORM]:
        """添加证据项到证据包."""
        evidence_items = []
        for item_data in items:
            item = EvidenceItemORM(
                evidence_id=f"evi_{uuid.uuid4().hex[:8]}",
                pack_id=pack_id,
                chunk_id=item_data.get("chunk_id", ""),
                document_id=item_data.get("document_id", ""),
                domain_id=item_data.get("domain_id", ""),
                domain_version_id=item_data.get("domain_version_id", ""),
                content=item_data.get("content", ""),
                section_path=item_data.get("section_path"),
                heading=item_data.get("heading"),
                chunk_type=item_data.get("chunk_type", "mixed"),
                similarity_score=item_data.get("similarity_score", 0.0),
                vector_similarity=item_data.get("vector_similarity", 0.0),
                term_similarity=item_data.get("term_similarity", 0.0),
                evidence_role=item_data.get("evidence_role", "base"),
                authority_level=item_data.get("authority_level", "official"),
                coverage_aspects=item_data.get("coverage_aspects"),
                figure_ids=item_data.get("figure_ids"),
                contains_code=item_data.get("contains_code", False),
                contains_table=item_data.get("contains_table", False),
                metadata_json=item_data.get("metadata"),
            )
            self.db.add(item)
            evidence_items.append(item)

        await self.db.commit()
        for item in evidence_items:
            await self.db.refresh(item)
        return evidence_items

    async def update_pack_scores(
        self,
        pack_id: str,
        scores: dict,
    ) -> Optional[EvidencePackORM]:
        """更新证据包评分."""
        result = await self.db.execute(
            select(EvidencePackORM).where(EvidencePackORM.pack_id == pack_id)
        )
        pack = result.scalar_one_or_none()
        if not pack:
            return None

        for key, value in scores.items():
            if hasattr(pack, key):
                setattr(pack, key, value)

        await self.db.commit()
        await self.db.refresh(pack)
        return pack

    async def get_evidence_pack(self, pack_id: str) -> Optional[EvidencePackORM]:
        """获取证据包."""
        result = await self.db.execute(
            select(EvidencePackORM).where(EvidencePackORM.pack_id == pack_id)
        )
        return result.scalar_one_or_none()

    async def get_evidence_items(self, pack_id: str) -> list[EvidenceItemORM]:
        """获取证据包中的所有证据项."""
        result = await self.db.execute(
            select(EvidenceItemORM).where(EvidenceItemORM.pack_id == pack_id)
        )
        return list(result.scalars().all())

    async def validate_applicability(self, evidence_item: dict, context: dict) -> dict:
        """验证证据适用性."""
        # Simplified applicability validation
        item_scope = evidence_item.get("applicability_scope", {})
        task_context = context.get("task_context", {})

        # Check if evidence scope matches task context
        is_applicable = True
        reasons = []

        # Check version compatibility
        if item_scope.get("min_version") and task_context.get("version"):
            if task_context["version"] < item_scope["min_version"]:
                is_applicable = False
                reasons.append("Evidence version is too old for this task")

        return {
            "is_applicable": is_applicable,
            "reasons": reasons,
        }

    async def detect_conflicts(self, evidence_items: list[dict]) -> list[dict]:
        """检测证据冲突.

        两个维度（按 section=title_path 分组）：
        1. 组内证据相似度/置信度极差 > 0.3 → 疑似矛盾或混杂
        2. 组内正文高度重复（去重率 < 50%）→ 冗余切片（同一知识点挂大量雷同内容）
        """
        conflicts = []

        # Group by section
        section_evidence: dict[str, list[dict]] = {}
        for item in evidence_items:
            sp = item.get("section_path")
            if isinstance(sp, list):
                section = " > ".join(str(x) for x in sp) or "unknown"
            else:
                section = str(sp) if sp else (str(item.get("heading") or "") or "unknown")
            section_evidence.setdefault(section, []).append(item)

        # Check for conflicts within sections
        for section, items in section_evidence.items():
            if len(items) <= 1:
                continue
            similarities = [float(e.get("similarity_score") or 0.0) for e in items]
            if max(similarities) - min(similarities) > 0.3:
                conflicts.append({
                    "section": section,
                    "evidence_ids": [e.get("evidence_id") for e in items],
                    "type": "similarity_variance",
                })
            # 内容重复检测：截断后去重率 ≤50%（半数及以上雷同）→ 冗余
            contents = [str(e.get("content") or "")[:200] for e in items]
            unique_ratio = len(set(contents)) / len(contents)
            if unique_ratio <= 0.5:
                conflicts.append({
                    "section": section,
                    "evidence_ids": [e.get("evidence_id") for e in items],
                    "type": "duplicate_content",
                    "detail": f"去重率 {unique_ratio:.0%}",
                })

        return conflicts

    async def check_claim_coverage(
        self,
        evidence_pack_id: str,
        claim_schema: list[dict],
    ) -> dict:
        """检查关键主张覆盖."""
        # Get evidence items
        items = await self.get_evidence_items(evidence_pack_id)
        covered_aspects = set()
        for item in items:
            if item.coverage_aspects:
                covered_aspects.update(item.coverage_aspects)

        # Check coverage against claims
        covered_claims = []
        missing_claims = []

        for claim in claim_schema:
            claim_id = claim.get("claim_id", "")
            required_aspects = set(claim.get("required_aspects", []))

            if required_aspects.issubset(covered_aspects):
                covered_claims.append(claim_id)
            else:
                missing_claims.append({
                    "claim_id": claim_id,
                    "missing_aspects": list(required_aspects - covered_aspects),
                })

        total = len(claim_schema)
        covered_count = len(covered_claims)

        return {
            "total_claims": total,
            "covered_claims": covered_count,
            "coverage_rate": covered_count / total if total > 0 else 0.0,
            "covered_claim_ids": covered_claims,
            "missing_claims": missing_claims,
        }

    def _calculate_pack_scores(
        self,
        evidence_items: list[dict],
        conflict_risk_score: float = 0.0,
    ) -> dict:
        """计算证据包评分（六维，确定性计算）.

        - coverage: min(1.0, 证据数/3)
        - authority: 来源文档 reliability_score 加权平均（缺省回退 0.8）
        - freshness: 基于文档 publish_year（1 - 距今/10，clamp 0.1~1.0；缺省 0.8）
        - applicability: 平均相似度/分类置信度
        - source_independence: min(1.0, 唯一文档数/2)
        - conflict_risk: 由 detect_conflicts 检测结果折算（调用方传入）
        """
        if not evidence_items:
            return {
                "coverage_score": 0.0,
                "authority_score": 0.0,
                "freshness_score": 0.0,
                "applicability_score": 0.0,
                "source_independence_score": 0.0,
                "conflict_risk_score": 0.0,
            }

        # Coverage: based on number of items
        min_expected = 3
        coverage_score = min(1.0, len(evidence_items) / min_expected)

        # Authority: 来源文档可靠性评分加权平均（reliability_score，predeal 写入）
        reliabilities = [
            float(it["metadata"]["doc"]["reliability_score"])
            for it in evidence_items
            if it.get("metadata", {}).get("doc", {}).get("reliability_score") is not None
        ]
        if reliabilities:
            authority_score = min(1.0, sum(reliabilities) / len(reliabilities))
        else:
            authority_score = 0.8

        # Freshness: 基于文档出版年份（publish_year，越新越新鲜）
        years = [
            int(d["publish_year"])
            for it in evidence_items
            if (d := it.get("metadata", {}).get("doc")) and d.get("publish_year")
        ]
        if years:
            age = datetime.now().year - max(years)
            freshness_score = max(0.1, min(1.0, 1.0 - age / 10))
        else:
            freshness_score = 0.8

        # Applicability: average similarity
        applicability_score = min(
            1.0,
            sum(item.get("similarity_score", 0) for item in evidence_items) / len(evidence_items)
        )

        # Source independence: unique document count
        docs = [str(item.get("document_id", "")) for item in evidence_items]
        unique_docs = len({d for d in docs if d})
        min_expected_sources = 2
        source_independence_score = min(1.0, unique_docs / min_expected_sources)

        # Conflict risk: 由 detect_conflicts 传入（每条冲突 +0.2，封顶 1.0）
        conflict_risk_score = max(0.0, min(1.0, conflict_risk_score))

        return {
            "coverage_score": coverage_score,
            "authority_score": authority_score,
            "freshness_score": freshness_score,
            "applicability_score": applicability_score,
            "source_independence_score": source_independence_score,
            "conflict_risk_score": conflict_risk_score,
        }

    async def list_datasets(self) -> list[dict]:
        """列出 RAGFlow 可用数据集."""
        return self.ragflow_retriever.list_datasets()

    async def find_dataset_by_name(self, name: str) -> Optional[dict]:
        """根据名称查找数据集."""
        return self.ragflow_retriever.find_dataset_by_name(name)
