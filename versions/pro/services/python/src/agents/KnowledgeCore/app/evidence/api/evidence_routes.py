"""Evidence API routes."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.evidence.schemas import (
    EvidenceItemResponse,
    EvidencePackResponse,
    SearchEvidenceRequest,
    SearchEvidenceResponse,
)
from app.evidence.services.evidence_service import EvidenceService
from app.evidence.models.orm import EvidenceItemORM

router = APIRouter(prefix="/evidence", tags=["evidence"])


def _item_to_response(it: EvidenceItemORM) -> EvidenceItemResponse:
    """ORM 证据项 → 响应模型（section_path 兼容字符串/list 两种存储形态）."""
    sp = it.section_path
    if isinstance(sp, str):
        sp = [p for p in sp.split(" > ") if p] if sp else []
    return EvidenceItemResponse(
        evidence_id=it.evidence_id,
        chunk_id=it.chunk_id,
        document_id=it.document_id,
        domain_id=it.domain_id,
        domain_version_id=it.domain_version_id,
        content=it.content,
        section_path=sp or [],
        heading=it.heading,
        chunk_type=it.chunk_type,
        similarity_score=it.similarity_score,
        vector_similarity=it.vector_similarity,
        term_similarity=it.term_similarity,
        evidence_role=it.evidence_role,
        authority_level=it.authority_level,
    )


@router.post("/search", response_model=SearchEvidenceResponse)
async def search_evidence(
    request: SearchEvidenceRequest,
    db: AsyncSession = Depends(get_db),
):
    """证据检索.

    检索层复用 knowledge 模块三级降级（MySQL 精确 → 父级上卷 → RAG 兜底），
    与 GET /knowledge/chunks 同一套逻辑；需传 dataset_ids 才会触发检索。
    """
    service = EvidenceService(db)

    # Create evidence pack
    pack = await service.search_evidence(
        domain_id=request.domain_id,
        query=request.query,
        snapshot_id=request.snapshot_id,
        top_k=request.top_k,
        similarity_threshold=request.similarity_threshold,
        document_ids=request.document_ids,
        dataset_ids=request.dataset_ids,
    )

    # Get items
    items = await service.get_evidence_items(pack.pack_id)

    return SearchEvidenceResponse(
        pack_id=pack.pack_id,
        query=pack.query,
        domain_id=pack.domain_id,
        evidence_count=len(items),
        evidence_items=[_item_to_response(it) for it in items],
        coverage_score=pack.coverage_score,
        authority_score=pack.authority_score,
        applicability_score=pack.applicability_score,
    )


@router.get("/packs/{pack_id}", response_model=EvidencePackResponse)
async def get_evidence_pack(
    pack_id: str,
    db: AsyncSession = Depends(get_db),
):
    """获取证据包."""
    service = EvidenceService(db)
    pack = await service.get_evidence_pack(pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail=f"Evidence pack '{pack_id}' not found")

    items = await service.get_evidence_items(pack_id)

    return EvidencePackResponse(
        pack_id=pack.pack_id,
        query=pack.query,
        domain_id=pack.domain_id,
        domain_version_id=pack.domain_version_id,
        evidence_items=[_item_to_response(it) for it in items],
        coverage_score=pack.coverage_score,
        covered_aspects=pack.covered_aspects or [],
        missing_aspects=pack.missing_aspects or [],
        authority_score=pack.authority_score,
        authority_distribution=pack.authority_distribution or {},
        freshness_score=pack.freshness_score,
        applicability_score=pack.applicability_score,
        source_independence_score=pack.source_independence_score,
        conflict_risk_score=pack.conflict_risk_score,
        conflicts=pack.conflicts or [],
        created_at=pack.created_at,
    )
