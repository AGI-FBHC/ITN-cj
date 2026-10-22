"""Pydantic data models for the preprocessing pipeline."""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ── Enums ──────────────────────────────────────────────────────────────────

class DocumentType(str, Enum):
    MARKDOWN_TUTORIAL = "markdown_tutorial"
    MARKDOWN_REFERENCE = "markdown_reference"
    UNKNOWN_TEXT = "unknown_text"


class ChunkType(str, Enum):
    CONCEPT_EXPLANATION = "concept_explanation"
    ARCHITECTURE_DESCRIPTION = "architecture_description"
    OPERATION_INSTRUCTION = "operation_instruction"
    CODE_EXAMPLE = "code_example"
    CONFIGURATION_EXAMPLE = "configuration_example"
    WORKFLOW_DESCRIPTION = "workflow_description"
    EXERCISE = "exercise"
    REFERENCE = "reference"
    FIGURE_EXPLANATION = "figure_explanation"
    MIXED = "mixed"


class FigureImportance(str, Enum):
    CONTENT = "content"
    TABLE_IMAGE = "table_image"
    FORMULA_IMAGE = "formula_image"
    DECORATIVE = "decorative"
    UNAVAILABLE = "unavailable"


class AssetStatus(str, Enum):
    AVAILABLE = "available"
    DOWNLOAD_FAILED = "download_failed"
    LOCAL_MISSING = "local_missing"


class PipelineStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


# ── Document Source ────────────────────────────────────────────────────────

class DocumentSource(BaseModel):
    document_id: str
    domain_id: str
    domain_version_id: str
    source_file_name: str
    source_uri: Optional[str] = None
    mime_type: str = "text/markdown"
    file_hash: str
    file_size: int
    pipeline_profile: str
    authority_level: Optional[str] = None
    applicability_scope: Dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=datetime.now)
    db_document_id: Optional[int] = None  # knowledge_document.id in MySQL


# ── Figure Asset ───────────────────────────────────────────────────────────

class FigureAsset(BaseModel):
    figure_id: str
    document_id: str
    domain_id: str
    domain_version_id: str
    caption: Optional[str] = None
    alt_text: Optional[str] = None
    original_src: Optional[str] = None
    asset_uri: Optional[str] = None
    asset_hash: Optional[str] = None
    source_start_offset: Optional[int] = None
    source_end_offset: Optional[int] = None
    section_path: List[str] = Field(default_factory=list)
    linked_chunk_ids: List[str] = Field(default_factory=list)
    ocr_text: Optional[str] = None
    vlm_summary: Optional[str] = None
    asset_status: AssetStatus = AssetStatus.AVAILABLE
    importance: FigureImportance = FigureImportance.CONTENT
    metadata: Dict[str, Any] = Field(default_factory=dict)


# ── Structure Node ─────────────────────────────────────────────────────────

class StructureNode(BaseModel):
    node_id: str
    document_id: str
    parent_id: Optional[str] = None
    node_type: str
    heading: Optional[str] = None
    level: Optional[int] = None
    section_path: List[str] = Field(default_factory=list)
    source_start_offset: int
    source_end_offset: int
    normalized_start_offset: int
    normalized_end_offset: int
    contains_code: bool = False
    contains_table: bool = False
    contains_figure: bool = False
    figure_ids: List[str] = Field(default_factory=list)
    text_hash: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict)


# ── Knowledge Chunk ────────────────────────────────────────────────────────

class KnowledgeChunk(BaseModel):
    chunk_id: str
    document_id: str
    domain_id: str
    domain_version_id: str
    source_file_hash: str
    section_path: List[str]
    heading: Optional[str] = None
    virtual_heading: Optional[str] = None
    content: str
    content_hash: str
    chunk_type: ChunkType = ChunkType.MIXED
    chunk_order: int
    source_start_offset: int
    source_end_offset: int
    normalized_start_offset: int
    normalized_end_offset: int
    char_count: int
    approx_token_count: int
    contains_code: bool = False
    contains_table: bool = False
    contains_figure: bool = False
    figure_ids: List[str] = Field(default_factory=list)
    section_figure_ids: List[str] = Field(default_factory=list)
    evidence_role: Optional[str] = None
    skill_tags: List[str] = Field(default_factory=list)
    ai_assisted: bool = False
    metadata: Dict[str, Any] = Field(default_factory=dict)


# ── Boundary Plan ──────────────────────────────────────────────────────────

class BoundaryRecommendation(BaseModel):
    virtual_heading: Optional[str] = None
    start_anchor: str
    end_anchor: Optional[str] = None
    reason: str = ""


class BoundaryPlan(BaseModel):
    section_id: str
    recommended_boundaries: List[BoundaryRecommendation] = Field(default_factory=list)
    skill_tags: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)


# ── Preflight Report ───────────────────────────────────────────────────────

class PreflightWarning(BaseModel):
    type: str
    figure_id: Optional[str] = None
    chunk_id: Optional[str] = None
    message: str


class PreflightReport(BaseModel):
    status: str = "pending"
    document_id: str
    chunk_count: int = 0
    figure_count: int = 0
    errors: List[str] = Field(default_factory=list)
    warnings: List[PreflightWarning] = Field(default_factory=list)


# ── Processing Audit ───────────────────────────────────────────────────────

class AICallRecord(BaseModel):
    task: str
    section_id: Optional[str] = None
    model: Optional[str] = None
    prompt_hash: Optional[str] = None
    input_hash: Optional[str] = None
    output_hash: Optional[str] = None
    status: str = "pending"


class ProcessingAudit(BaseModel):
    ingestion_job_id: str
    domain_id: str
    domain_version_id: str
    document_id: str
    source_file_hash: str
    pipeline_profile: str
    normalizer_version: str = "normalizer_0.1.0"
    figure_processor_version: str = "figure_processor_0.1.0"
    structure_parser_version: str = "structure_parser_0.1.0"
    chunk_compiler_version: str = "chunk_compiler_0.1.0"
    ai_assistant_enabled: bool = False
    ai_calls: List[AICallRecord] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.now)
    finished_at: Optional[datetime] = None
    status: PipelineStatus = PipelineStatus.PENDING


# ── RAGFlow Import Config ─────────────────────────────────────────────────

class RAGFlowImportConfig(BaseModel):
    dataset_name: str
    document_id: str
    file: str = "chunked_for_ragflow.md"
    splitter: Dict[str, Any] = Field(default_factory=lambda: {
        "type": "delimiter",
        "delimiter": "<<<ITN_CHUNK_BOUNDARY>>>",
    })
    metadata_mapping: Dict[str, Any] = Field(default_factory=lambda: {
        "external_manifest": "chunk_manifest.json",
        "chunk_id_strategy": "content_hash_and_order",
    })
