"""Document API routes."""
from __future__ import annotations
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.document.schemas import (
    CreateDocumentRequest,
    DocumentChunkResponse,
    DocumentResponse,
)
from app.document.services.document_service import DocumentService

router = APIRouter(prefix="/documents", tags=["document"])


@router.post("", response_model=DocumentResponse)
async def create_document(
    request: CreateDocumentRequest,
    db: AsyncSession = Depends(get_db),
):
    """创建文档."""
    service = DocumentService(db)
    doc = await service.create_document(
        domain_id=request.domain_id,
        domain_version_id=request.domain_version_id,
        title=request.title,
        source_uri=request.source_uri,
        file_hash=request.file_hash,
        file_size=request.file_size,
        mime_type=request.mime_type,
        authority_level=request.authority_level,
        applicability_scope=request.applicability_scope,
        metadata_json=request.metadata_json,
    )
    return doc


@router.get("/{doc_id}", response_model=DocumentResponse)
async def get_document(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
):
    """获取文档."""
    service = DocumentService(db)
    doc = await service.get_document(doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found")
    return doc


@router.get("", response_model=list[DocumentResponse])
async def list_documents(
    domain_id: str,
    domain_version_id: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """列出文档."""
    service = DocumentService(db)
    return await service.list_documents(domain_id, domain_version_id)


@router.put("/{doc_id}", response_model=DocumentResponse)
async def update_document(
    doc_id: str,
    request: dict,
    db: AsyncSession = Depends(get_db),
):
    """更新文档."""
    service = DocumentService(db)
    doc = await service.update_document(doc_id, **request)
    if not doc:
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found")
    return doc


@router.delete("/{doc_id}")
async def delete_document(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
):
    """删除文档 (软删除)."""
    service = DocumentService(db)
    success = await service.delete_document(doc_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found")
    return {"status": "deleted", "document_id": doc_id}


@router.get("/{doc_id}/chunks", response_model=list[DocumentChunkResponse])
async def list_chunks(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
):
    """列出文档分块."""
    service = DocumentService(db)
    return await service.list_chunks(document_id=doc_id)


@router.post("/{doc_id}/chunks", response_model=list[DocumentChunkResponse])
async def create_chunks(
    doc_id: str,
    chunks: list[dict],
    domain_id: str,
    domain_version_id: str,
    db: AsyncSession = Depends(get_db),
):
    """批量创建文档分块."""
    service = DocumentService(db)
    return await service.batch_create_chunks(
        document_id=doc_id,
        domain_id=domain_id,
        domain_version_id=domain_version_id,
        chunks=chunks,
    )
