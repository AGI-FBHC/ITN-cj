"""Document module request/response schemas."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


# ── Request Schemas ─────────────────────────────────────────────────────────


class CreateDocumentRequest(BaseModel):
    """创建文档请求."""

    domain_id: str = Field(..., description="领域 ID")
    domain_version_id: str = Field(..., description="领域版本 ID")
    title: str = Field(..., min_length=1, max_length=512, description="文档标题")
    source_uri: Optional[str] = Field(None, max_length=1024, description="源文件 URI")
    file_hash: Optional[str] = Field(None, description="文件哈希")
    file_size: Optional[int] = Field(None, description="文件大小")
    mime_type: Optional[str] = Field(None, description="MIME 类型")
    authority_level: str = Field("official", description="权威性等级")
    applicability_scope: Optional[dict[str, Any]] = Field(None, description="适用范围")
    metadata_json: Optional[dict[str, Any]] = Field(None, description="元数据")


# ── Response Schemas ────────────────────────────────────────────────────────


class DocumentResponse(BaseModel):
    """文档响应."""

    id: int
    document_id: str
    domain_id: str
    domain_version_id: str
    title: str
    source_uri: Optional[str] = None
    file_hash: Optional[str] = None
    file_size: Optional[int] = None
    mime_type: Optional[str] = None
    authority_level: str
    applicability_scope: Optional[dict] = None
    metadata_json: Optional[dict] = None
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DocumentChunkResponse(BaseModel):
    """文档分块响应."""

    id: int
    chunk_id: str
    document_id: str
    domain_id: str
    domain_version_id: str
    content: str
    content_hash: Optional[str] = None
    chunk_type: str
    section_path: Optional[list[str]] = None
    heading: Optional[str] = None
    char_count: Optional[int] = None
    contains_code: bool
    contains_table: bool
    figure_ids: Optional[list[str]] = None
    metadata_json: Optional[dict] = None
    created_at: datetime

    model_config = {"from_attributes": True}
