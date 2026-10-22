"""文档管理服务."""
from __future__ import annotations
from typing import Optional

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.document.models.orm import DocumentChunkORM, DocumentORM


class DocumentService:
    """文档 CRUD 操作."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_document(
        self,
        domain_id: str,
        domain_version_id: str,
        title: str,
        source_uri: Optional[str] = None,
        file_hash: Optional[str] = None,
        file_size: Optional[int] = None,
        mime_type: Optional[str] = None,
        authority_level: str = "official",
        applicability_scope: Optional[dict] = None,
        metadata_json: Optional[dict] = None,
    ) -> DocumentORM:
        """创建文档."""
        doc = DocumentORM(
            document_id=f"doc_{uuid.uuid4().hex[:8]}",
            domain_id=domain_id,
            domain_version_id=domain_version_id,
            title=title,
            source_uri=source_uri,
            file_hash=file_hash,
            file_size=file_size,
            mime_type=mime_type,
            authority_level=authority_level,
            applicability_scope=applicability_scope,
            metadata_json=metadata_json,
            status="active",
        )
        self.db.add(doc)
        await self.db.commit()
        await self.db.refresh(doc)
        return doc

    async def get_document(self, document_id: str) -> Optional[DocumentORM]:
        """获取文档."""
        result = await self.db.execute(
            select(DocumentORM).where(DocumentORM.document_id == document_id)
        )
        return result.scalar_one_or_none()

    async def list_documents(
        self,
        domain_id: str,
        domain_version_id: Optional[str] = None,
    ) -> list[DocumentORM]:
        """列出文档."""
        query = select(DocumentORM).where(DocumentORM.domain_id == domain_id)
        if domain_version_id:
            query = query.where(DocumentORM.domain_version_id == domain_version_id)

        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def update_document(
        self,
        document_id: str,
        **kwargs,
    ) -> Optional[DocumentORM]:
        """更新文档."""
        doc = await self.get_document(document_id)
        if not doc:
            return None

        for key, value in kwargs.items():
            if hasattr(doc, key):
                setattr(doc, key, value)

        await self.db.commit()
        await self.db.refresh(doc)
        return doc

    async def delete_document(self, document_id: str) -> bool:
        """删除文档 (软删除)."""
        doc = await self.get_document(document_id)
        if not doc:
            return False

        doc.status = "archived"
        await self.db.commit()
        return True

    # ── Chunk management ────────────────────────────────────────────────────

    async def create_chunk(
        self,
        document_id: str,
        domain_id: str,
        domain_version_id: str,
        content: str,
        chunk_type: str = "mixed",
        section_path: Optional[list[str]] = None,
        heading: Optional[str] = None,
        contains_code: bool = False,
        contains_table: bool = False,
        figure_ids: Optional[list[str]] = None,
        metadata_json: Optional[dict] = None,
    ) -> DocumentChunkORM:
        """创建文档分块."""
        import hashlib

        chunk = DocumentChunkORM(
            chunk_id=f"chunk_{uuid.uuid4().hex[:8]}",
            document_id=document_id,
            domain_id=domain_id,
            domain_version_id=domain_version_id,
            content=content,
            content_hash=hashlib.sha256(content.encode()).hexdigest(),
            chunk_type=chunk_type,
            section_path=section_path,
            heading=heading,
            char_count=len(content),
            contains_code=contains_code,
            contains_table=contains_table,
            figure_ids=figure_ids,
            metadata_json=metadata_json,
        )
        self.db.add(chunk)
        await self.db.commit()
        await self.db.refresh(chunk)
        return chunk

    async def get_chunk(self, chunk_id: str) -> Optional[DocumentChunkORM]:
        """获取文档分块."""
        result = await self.db.execute(
            select(DocumentChunkORM).where(DocumentChunkORM.chunk_id == chunk_id)
        )
        return result.scalar_one_or_none()

    async def list_chunks(
        self,
        document_id: Optional[str] = None,
        domain_id: Optional[str] = None,
    ) -> list[DocumentChunkORM]:
        """列出文档分块."""
        query = select(DocumentChunkORM)
        if document_id:
            query = query.where(DocumentChunkORM.document_id == document_id)
        if domain_id:
            query = query.where(DocumentChunkORM.domain_id == domain_id)

        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def batch_create_chunks(
        self,
        document_id: str,
        domain_id: str,
        domain_version_id: str,
        chunks: list[dict],
    ) -> list[DocumentChunkORM]:
        """批量创建文档分块."""
        import hashlib

        created = []
        for chunk_data in chunks:
            content = chunk_data.get("content", "")
            chunk = DocumentChunkORM(
                chunk_id=f"chunk_{uuid.uuid4().hex[:8]}",
                document_id=document_id,
                domain_id=domain_id,
                domain_version_id=domain_version_id,
                content=content,
                content_hash=hashlib.sha256(content.encode()).hexdigest(),
                chunk_type=chunk_data.get("chunk_type", "mixed"),
                section_path=chunk_data.get("section_path"),
                heading=chunk_data.get("heading"),
                char_count=len(content),
                contains_code=chunk_data.get("contains_code", False),
                contains_table=chunk_data.get("contains_table", False),
                figure_ids=chunk_data.get("figure_ids"),
                metadata_json=chunk_data.get("metadata"),
            )
            self.db.add(chunk)
            created.append(chunk)

        await self.db.commit()
        for chunk in created:
            await self.db.refresh(chunk)
        return created
