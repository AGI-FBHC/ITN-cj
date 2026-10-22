"""Document upload service — the single entry point for adding a document
to the knowledge base.

Wraps the full predeal pipeline for the "upload a new document" scenario:

1. The file is placed under the domain's discovery root ``uploads/``
   directory, which gives it a stable ``document_key``
   (``{domain}:uploads/{filename}``).
2. Re-uploading the SAME content is idempotent (fast path "reused").
3. Re-uploading a file with the SAME name but different content is an
   incremental update (same document row, only affected chunks change,
   old chunks soft-deleted).
4. Metadata defaults come from the domain config and can be overridden
   per upload.

Used by:
- CLI: ``predeal upload --domain hello_agents --file x.md``
- HTTP: ``POST /api/v1/uploads`` (see web/app.py)
- Any Python code that wants to ingest a document.
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

from .config import (
    DomainConfig,
    FigurePolicy,
    load_domain_config,
    resolve_discovery_root,
)
from .doc_convert import SUPPORTED_OFFICE_SUFFIXES, convert_to_markdown
from .pipeline2 import PipelineOptions, PipelineResult, process_document
from .ragflow_client import RAGFlowConfig

logger = logging.getLogger(__name__)

# Files land in <discovery_root>/uploads/... and keep their document_key stable
UPLOADS_SUBDIR = "uploads"

SUPPORTED_EXTENSIONS = {".md", ".markdown"} | SUPPORTED_OFFICE_SUFFIXES


@dataclass
class UploadOptions:
    """Metadata and behavior knobs for one document upload.

    Only ``domain_id`` and the file itself are required; everything else has
    sensible defaults (mostly inherited from the domain config).
    """

    domain_id: str
    title: Optional[str] = None
    document_type: Optional[str] = None
    source_type: str = "upload"
    source_name: Optional[str] = None
    publisher: Optional[str] = None
    publish_year: Optional[int] = None
    version: Optional[str] = None
    reliability_score: Optional[float] = None
    language: str = "zh-CN"
    storage_prefix: Optional[str] = None
    enable_ragflow: bool = True
    dataset_name: Optional[str] = None
    enable_vlm: bool = True
    enable_image_pipeline: bool = True
    enable_classify: bool = True
    force: bool = False
    output_dir: Optional[Path] = None
    progress_callback: Any = None


@dataclass
class UploadResult:
    """Outcome of a document upload."""

    status: str = "pending"
    document_key: Optional[str] = None
    db_document_id: Optional[int] = None
    document_id: Optional[str] = None          # internal id (doc_000020)
    chunk_count: int = 0
    figure_count: int = 0
    sync_report: Optional[dict] = None
    ragflow_result: Optional[dict] = None
    errors: list = field(default_factory=list)
    artifacts_dir: Optional[Path] = None
    reused: bool = False

    @classmethod
    def from_pipeline(cls, r: PipelineResult, document_key: str,
                      db_document_id: int, artifacts_dir: Path) -> "UploadResult":
        return cls(
            status=r.status,
            document_key=document_key,
            db_document_id=db_document_id,
            document_id=r.document_id,
            chunk_count=r.chunk_count,
            figure_count=r.figure_count,
            sync_report=r.sync_report,
            ragflow_result=r.ragflow_result,
            errors=list(r.errors),
            artifacts_dir=artifacts_dir,
            reused=r.status == "reused",
        )

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "document_key": self.document_key,
            "db_document_id": self.db_document_id,
            "document_id": self.document_id,
            "chunk_count": self.chunk_count,
            "figure_count": self.figure_count,
            "sync_report": self.sync_report,
            "ragflow": self.ragflow_result,
            "errors": self.errors,
            "artifacts_dir": str(self.artifacts_dir) if self.artifacts_dir else None,
            "reused": self.reused,
        }


def _domain_config_with_overrides(
    domain_id: str,
    opts: UploadOptions,
    domains_dir: Optional[Path] = None,
) -> DomainConfig:
    """Load the domain config and apply per-upload metadata overrides."""
    config = load_domain_config(domain_id, domains_dir)
    defaults = dict(config.metadata_defaults or {})
    if opts.title:
        defaults["title"] = opts.title
    if opts.document_type:
        defaults["document_type"] = opts.document_type
    if opts.source_name:
        defaults["source_name"] = opts.source_name
    if opts.publisher is not None:
        defaults["publisher"] = opts.publisher
    if opts.publish_year is not None:
        defaults["publish_year"] = opts.publish_year
    if opts.version is not None:
        defaults["version"] = opts.version
    if opts.reliability_score is not None:
        defaults["reliability_score"] = opts.reliability_score
    defaults["source_type"] = opts.source_type

    figure = config.figure_policy.model_copy(deep=True)
    if not opts.enable_vlm:
        figure.enable_vlm_summary = False
    if not opts.enable_image_pipeline:
        figure.enable_image_pipeline = False

    return config.model_copy(update={
        "metadata_defaults": defaults,
        "figure_policy": figure,
    })


def _stage_file(source: Path, config: DomainConfig) -> Path:
    """Copy the uploaded file into <discovery_root>/uploads/.

    The file name is kept stable so re-uploads share the same document_key:
    same content  -> idempotent fast path,
    changed content -> incremental update of the same document.
    """
    root = resolve_discovery_root(config)
    uploads_dir = root / UPLOADS_SUBDIR
    uploads_dir.mkdir(parents=True, exist_ok=True)
    dest = uploads_dir / source.name
    shutil.copy2(source, dest)
    return dest


def upload_document_file(
    source_path: Path,
    options: UploadOptions,
    domains_dir: Optional[Path] = None,
) -> UploadResult:
    """Upload a document file into the knowledge base.

    Args:
        source_path: Local path of the file to upload
        options: UploadOptions (domain_id required)
        domains_dir: Override for the domains config directory (tests)

    Returns:
        UploadResult with status, document_key, counts, errors.
    """
    if not source_path.exists():
        return UploadResult(status="failed", errors=[f"File not found: {source_path}"])
    if source_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        return UploadResult(
            status="failed",
            errors=[f"Unsupported file type '{source_path.suffix}'. "
                    f"Supported: {sorted(SUPPORTED_EXTENSIONS)}"],
        )

    try:
        config = _domain_config_with_overrides(options.domain_id, options, domains_dir)
    except FileNotFoundError as e:
        return UploadResult(status="failed", errors=[str(e)])

    # Office 文档（.docx/.pptx）先转成 Markdown 再走后续流水线
    convert_dir: Optional[Path] = None
    try:
        if source_path.suffix.lower() in SUPPORTED_OFFICE_SUFFIXES:
            try:
                markdown_text = convert_to_markdown(source_path)
            except Exception as e:
                return UploadResult(status="failed", errors=[f"文档解析失败: {e}"])
            if not markdown_text.strip():
                return UploadResult(
                    status="failed",
                    errors=[f"{source_path.name} 未抽取到文本内容，请确认文档不是扫描件/图片"],
                )
            convert_dir = Path(tempfile.mkdtemp(prefix="predeal_convert_"))
            md_path = convert_dir / (source_path.stem + ".md")
            md_path.write_text(markdown_text, encoding="utf-8")
            source_path = md_path

        # Stage the file (stable name under <root>/uploads/)
        try:
            target = _stage_file(source_path, config)
        except Exception as e:
            return UploadResult(status="failed", errors=[f"Staging failed: {e}"])
    finally:
        if convert_dir is not None:
            shutil.rmtree(convert_dir, ignore_errors=True)

    document_key = f"{config.domain_id}:{UPLOADS_SUBDIR}/{target.name}"

    # Default image storage prefix: ITN/{domain}/{filename_stem}
    storage_prefix = options.storage_prefix or (
        f"ITN/{config.domain_id}/{target.stem}"
    )

    ragflow_config = None
    if options.enable_ragflow:
        ragflow_config = RAGFlowConfig(
            base_url=os.environ.get("RAGFLOW_URL", ""),
            api_key=os.environ.get("RAGFLOW_API_KEY", ""),
        )

    output_dir = options.output_dir or (
        Path(__file__).parent.parent.parent / "output" / config.domain_id
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    pipeline_opts = PipelineOptions(
        ragflow_config=ragflow_config,
        dataset_name=options.dataset_name,
        storage_prefix=storage_prefix,
        progress_callback=options.progress_callback,
        force=options.force,
        skip_enrichment=not options.enable_classify,
    )

    result = process_document(target, config, output_dir, pipeline_opts)

    db_document_id = result.db_document_id
    artifacts_dir = output_dir / config.domain_version_id / (
        f"doc_{db_document_id:06d}" if db_document_id else "unknown"
    )
    return UploadResult.from_pipeline(result, document_key, db_document_id, artifacts_dir)


def upload_document_bytes(
    filename: str,
    content: bytes,
    options: UploadOptions,
    domains_dir: Optional[Path] = None,
    progress_callback=None,
) -> UploadResult:
    """Upload a document from raw bytes (HTTP uploads)."""
    import tempfile
    if progress_callback is not None:
        options = options
        # progress flows through the options object
        options.progress_callback = progress_callback
    tmp = Path(tempfile.mkdtemp(prefix="predeal_upload_"))
    src = tmp / filename
    src.write_bytes(content)
    try:
        return upload_document_file(src, options, domains_dir)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
