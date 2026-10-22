"""Knowledge Core 统一入口 —— Question Bank 唯一的知识访问点.

对外只暴露三个核心接口（DESIGN v2 §28）：

1. resolve_knowledge_point(query)     名称 → 知识点（category_id）
2. get_context(category_id, purpose)  组装 KnowledgeContext（知识点+前置+证据+覆盖度+溯源）
3. get_evidence(evidence_ids)         按 evidence_refs 快照回取证据内容

禁止绕过本入口直接操作 RAGFlow / 知识表。
"""
from __future__ import annotations

import uuid
from typing import Literal

import httpx

from .coverage import evaluate_coverage, strategy_label
from .resolver import resolve_knowledge_point
from .retriever import KnowledgeCoreClient
from .schemas import (
    ContrastInfo,
    CoverageInfo,
    EvidenceItem,
    KnowledgeContext,
    KnowledgePointInfo,
    PrerequisiteInfo,
    TraceInfo,
)

Purpose = Literal["question_generation", "review", "judge", "default"]

# 不同用途的切片拉取上限（purpose 决定上下文范围）
_PURPOSE_LIMITS: dict[str, int] = {
    "question_generation": 8,
    "review": 6,
    "judge": 5,
    "default": 5,
}


class KnowledgeCore:
    """题库侧 Knowledge Core 门面."""

    def __init__(
        self,
        client: KnowledgeCoreClient,
        domain: str = "agent",
    ):
        self._client = client
        self._domain = domain

    @classmethod
    def from_url(
        cls,
        base_url: str,
        *,
        timeout: float = 15.0,
        domain: str = "agent",
        transport: httpx.AsyncBaseTransport | None = None,
        secret: str | None = None,
    ) -> "KnowledgeCore":
        return cls(
            KnowledgeCoreClient(base_url, timeout=timeout, transport=transport, secret=secret),
            domain=domain,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    # ── 接口 1：resolve_knowledge_point ──────────────────────────────────

    async def resolve_knowledge_point(self, query: str) -> KnowledgePointInfo | None:
        """知识点名称 → KnowledgePointInfo（未命中返回 None）."""
        return await resolve_knowledge_point(self._client, query, domain=self._domain)

    # ── 接口 2：get_context（核心） ───────────────────────────────────────

    async def get_context(
        self,
        *,
        category_id: int | None = None,
        knowledge_point: str | None = None,
        purpose: Purpose = "default",
        include_prerequisites: bool = True,
        include_contrasts: bool = True,
    ) -> KnowledgeContext:
        """组装 KnowledgeContext.

        - category_id 与 knowledge_point 至少提供一个（都提供时 category_id 优先）
        - purpose 决定检索深度（question_generation 拉取最多证据）
        - include_prerequisites=True 时附带 DAG 先修链
        - include_contrasts=True 时附带 T4.4 易混淆知识点（出题干扰项数据源）；
          KC 侧无 active contrasts_with 边时为空列表，向后兼容（不影响现有出题行为）
        """
        kp: KnowledgePointInfo
        if category_id is not None:
            kp = KnowledgePointInfo(id=int(category_id), name=knowledge_point or f"kp:{category_id}")
        else:
            resolved = await self.resolve_knowledge_point(knowledge_point or "")
            if resolved is None:
                # 名称解析失败：返回空上下文（覆盖度 empty），由出题侧拒绝生成
                return KnowledgeContext(
                    knowledge_point=KnowledgePointInfo(id=0, name=knowledge_point or ""),
                    coverage=CoverageInfo(coverage_level="empty"),
                    trace=TraceInfo(strategy="empty", request_id=uuid.uuid4().hex[:16]),
                )
            kp = resolved

        limit = _PURPOSE_LIMITS.get(purpose, 5)
        data = await self._client.fetch_chunks(
            category_id=kp.id,
            domain=self._domain,
            limit=limit,
            include_rag=True,
            include_prerequisites=include_prerequisites,
            include_contrasts=include_contrasts,
        )

        evidence = [
            EvidenceItem(
                chunk_id=int(c["chunk_id"] or 0),
                ragflow_chunk_id=c.get("ragflow_chunk_id"),
                document_id=c.get("document_id"),
                content=c.get("content") or "",
                score=c.get("confidence") if c.get("confidence") is not None else c.get("similarity"),
                source=c.get("source", "mysql"),
                category_id=data.get("category_id"),
            )
            for c in data.get("chunks", [])
            if (c.get("content") or "").strip()
        ]

        prerequisites: list[PrerequisiteInfo] = []
        if include_prerequisites:
            nodes = (data.get("prerequisites") or {}).get("nodes") or []
            for n in nodes[:20]:
                prerequisites.append(
                    PrerequisiteInfo(
                        id=int(n.get("category_id", 0)),
                        name=n.get("name") or "",
                    )
                )

        contrasts: list[ContrastInfo] = []
        if include_contrasts:
            contrast_nodes = data.get("contrasts") or []
            for n in contrast_nodes[:20]:
                name = n.get("name")
                if not name:
                    continue
                contrasts.append(
                    ContrastInfo(id=int(n.get("category_id", 0)), name=name)
                )

        coverage = evaluate_coverage(evidence)
        return KnowledgeContext(
            knowledge_point=KnowledgePointInfo(
                id=kp.id,
                name=data.get("category_name") or kp.name,
            ),
            prerequisites=prerequisites,
            contrasts=contrasts,
            evidence=evidence,
            coverage=coverage,
            trace=TraceInfo(
                strategy=strategy_label(data.get("decision", "empty")),
                request_id=uuid.uuid4().hex[:16],
            ),
        )

    # ── 接口 3：get_evidence ─────────────────────────────────────────────

    async def get_evidence(self, evidence_refs: list[dict]) -> list[EvidenceItem]:
        """按 evidence_refs 快照回取证据内容（审核 / 判题 / 溯源用）.

        输入形如 [{"chunk_id": 1024, "document_id": 18}]；
        仅回取 MySQL 切片（chunk_id > 0），RAG 项跳过（无法按 id 回取，保留快照即可）。
        """
        chunk_ids = sorted(
            {int(r["chunk_id"]) for r in evidence_refs if int(r.get("chunk_id") or 0) > 0}
        )
        if not chunk_ids:
            return []
        rows = await self._client.fetch_chunks_by_ids(chunk_ids)
        return [
            EvidenceItem(
                chunk_id=int(r["chunk_id"]),
                document_id=r.get("document_id"),
                content=r.get("content") or "",
                score=None,
                source="mysql",
                category_id=r.get("category_id"),
            )
            for r in rows
        ]
