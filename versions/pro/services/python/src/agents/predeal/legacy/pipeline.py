"""Main pipeline orchestrator."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from .config import DomainConfig, load_domain_config, resolve_discovery_root
from .document_repository import create_document, update_document_fields
from .file_uploader import upload_file
from .images.pipeline import process_markdown_images
from .models import DocumentSource
from .ragflow_client import RAGFlowConfig
from .steps.audit import create_audit, finalize_audit, save_audit
from .steps.chunk_compiler import compile_chunks, save_chunks
from .steps.intake import discover_documents
from .steps.preflight import run_preflight, save_preflight_report
from .steps.ragflow_packager import package_for_ragflow, upload_to_ragflow
from .steps.raw_archive import archive_raw
from .steps.structure_parser import parse_structure, save_structure_tree
from .steps.normalizer import normalize_markdown, save_normalization
from .chunk_repository import insert_chunks
from .figure_chunk_binder import load_figures_for_document
from .category_classifier import classify_chunks, get_domain_db_id

logger = logging.getLogger(__name__)

_IMAGE_PIPELINE_MAX_RETRIES = 3
_FILE_UPLOAD_MAX_RETRIES = 3


@dataclass
class PipelineResult:
    domain_id: str
    document_id: str
    status: str = "pending"
    chunk_count: int = 0
    figure_count: int = 0
    errors: list = field(default_factory=list)
    output_dir: Optional[Path] = None
    ragflow_result: Optional[Dict[str, Any]] = None


@dataclass
class PipelineProgress:
    """Progress event emitted during pipeline execution."""
    step_name: str
    step_num: int
    status: str  # "start" | "end" | "log"
    message: str = ""


ProgressCallback = Callable[[PipelineProgress], None]


@dataclass
class PipelineOptions:
    until: Optional[str] = None
    enable_ai: bool = False
    ragflow_config: Optional[RAGFlowConfig] = None
    dataset_name: Optional[str] = None
    storage_prefix: Optional[str] = None
    progress_callback: Optional[ProgressCallback] = None


# Step order for --until debugging
_STEP_ORDER = [
    "intake",           # 1
    "archive",          # 2
    "normalizer",       # 3
    "image_pipeline",   # 4
    "structure_parser", # 5
    "chunk_compiler",   # 6 (includes figure binding)
    "chunk_db_insert",  # 7
    "category_classify",# 8
    "ragflow_packager", # 9
    "preflight",        # 10
    "audit",            # 11
    "ragflow_upload",   # 12
]


def _step_num(step_name: str) -> int:
    """Return 1-based step number, or 0 if unknown."""
    try:
        return _STEP_ORDER.index(step_name) + 1
    except ValueError:
        return 0


def _emit(opts: PipelineOptions, step_name: str, status: str, message: str = ""):
    """Emit a progress event if callback is set."""
    if opts.progress_callback:
        opts.progress_callback(PipelineProgress(
            step_name=step_name,
            step_num=_step_num(step_name),
            status=status,
            message=message,
        ))


def _upload_with_retry(local_path: Path, directory: str, filename: str) -> str:
    """Upload a file with retry. Returns storage_key. Raises on failure."""
    last_err = None
    for attempt in range(_FILE_UPLOAD_MAX_RETRIES):
        try:
            result = upload_file(local_path, directory, filename=filename)
            return result.storage_key
        except Exception as e:
            last_err = e
            logger.warning(f"Upload attempt {attempt + 1} failed for {filename}: {e}")
    raise RuntimeError(f"File upload failed after {_FILE_UPLOAD_MAX_RETRIES} attempts: {last_err}")


def process_document(
    source_path: Path,
    config: DomainConfig,
    output_dir: Path,
    options: Optional[PipelineOptions] = None,
) -> PipelineResult:
    """Run the full preprocessing pipeline on a single document."""
    opts = options or PipelineOptions()
    job_id = f"job_{uuid.uuid4().hex[:8]}"
    result = PipelineResult(domain_id=config.domain_id, document_id="")
    result.output_dir = output_dir

    def should_stop(step: str) -> bool:
        if opts.until is None:
            return False
        return _STEP_ORDER.index(step) > _STEP_ORDER.index(opts.until)

    try:
        # ── Step 1: Intake ──
        _emit(opts, "intake", "start", f"Reading {source_path.name}")
        from .utils.hash import file_hash
        content = source_path.read_text(encoding="utf-8")
        doc = DocumentSource(
            document_id=f"doc_{uuid.uuid4().hex[:6]}",
            domain_id=config.domain_id,
            domain_version_id=config.domain_version_id,
            source_file_name=source_path.name,
            source_uri=str(source_path),
            file_hash=file_hash(str(source_path)),
            file_size=source_path.stat().st_size,
            pipeline_profile=config.pipeline_profile,
            authority_level=config.metadata_defaults.get("authority_level"),
            applicability_scope=config.metadata_defaults.get("applicability_scope", {}),
        )
        result.document_id = doc.document_id
        _emit(opts, "intake", "end", f"Document ID: {doc.document_id}")

        # ── Step 2: Raw Archive ──
        _emit(opts, "archive", "start", "Archiving raw file")
        archive_raw(doc, config, source_path, output_dir)
        if should_stop("archive"):
            result.status = "stopped"
            return result

        # ── Step 2.5: Create knowledge_document record ──
        meta = config.metadata_defaults
        doc.db_document_id = create_document(
            document_code=f"{config.domain_id}_{doc.file_hash[:8]}",
            title=source_path.stem,
            document_type=meta.get("document_type", config.pipeline_profile),
            source_type=meta.get("source_type", "local_file"),
            source_name=meta.get("source_name", source_path.name),
            original_file_name=source_path.name,
            language=config.language,
            publisher=meta.get("publisher", ""),
            publish_year=int(meta.get("publish_year", 0)),
            version=meta.get("version", ""),
            reliability_score=float(meta.get("reliability_score", 0)),
        )

        # Upload raw file
        file_dir = f"ITN/{config.domain_id}/{doc.document_id}"
        raw_path = (
            output_dir / config.domain_id / config.domain_version_id
            / doc.document_id / "raw" / doc.source_file_name
        )
        raw_storage_key = _upload_with_retry(raw_path, file_dir, doc.source_file_name)
        update_document_fields(doc.db_document_id, storage_key=raw_storage_key)
        _emit(opts, "archive", "end", f"Raw file archived, DB ID: {doc.db_document_id}")

        # ── Step 3: Normalization ──
        _emit(opts, "normalizer", "start", "Normalizing markdown")
        norm_result = normalize_markdown(content)
        save_normalization(norm_result, doc, output_dir)
        _emit(opts, "normalizer", "end", f"Normalized: {len(norm_result.normalized_text)} chars, {len(norm_result.image_refs)} images")
        if should_stop("normalizer"):
            result.status = "stopped"
            return result

        # ── Step 4: Image Pipeline ──
        _emit(opts, "image_pipeline", "start", "Processing images")
        storage_prefix = opts.storage_prefix or config.figure_policy.storage_prefix
        logger.info(f"Image pipeline: enable_vlm={config.figure_policy.enable_vlm_summary}, enable_image_pipeline={config.figure_policy.enable_image_pipeline}, image_refs={len(norm_result.image_refs)}")
        if config.figure_policy.enable_image_pipeline and norm_result.image_refs:
            norm_source = (
                output_dir / config.domain_id / config.domain_version_id
                / doc.document_id / "normalized" / "normalized.md"
            )
            last_error = None
            for attempt in range(_IMAGE_PIPELINE_MAX_RETRIES):
                try:
                    enhanced_path = process_markdown_images(
                        document_id=doc.db_document_id,
                        source_path=norm_source,
                        storage_prefix=storage_prefix,
                        enable_vlm=config.figure_policy.enable_vlm_summary,
                        vlm_api_key=config.figure_policy.vlm_api_key,
                    )
                    norm_result.normalized_text = enhanced_path.read_text(encoding="utf-8")
                    last_error = None
                    break
                except Exception as e:
                    last_error = e
                    logger.warning(f"Image pipeline attempt {attempt + 1} failed: {e}")

            if last_error is not None:
                raise RuntimeError(
                    f"Image pipeline failed after {_IMAGE_PIPELINE_MAX_RETRIES} attempts: {last_error}"
                )

        _emit(opts, "image_pipeline", "end", "Image processing complete")
        if should_stop("image_pipeline"):
            result.status = "stopped"
            return result

        # Upload normalized file
        norm_file_path = (
            output_dir / config.domain_id / config.domain_version_id
            / doc.document_id / "normalized" / "normalized.md"
        )
        norm_storage_key = _upload_with_retry(norm_file_path, file_dir, "normalized.md")
        update_document_fields(doc.db_document_id, normalized_storage_key=norm_storage_key)

        # ── Step 5: Structure Parsing ──
        _emit(opts, "structure_parser", "start", "Parsing document structure")
        tree = parse_structure(norm_result.normalized_text, doc)
        save_structure_tree(tree, output_dir, doc)
        _emit(opts, "structure_parser", "end", f"Found {len(tree.nodes)} top-level sections")
        if should_stop("structure_parser"):
            result.status = "stopped"
            return result

        # ── Step 6: Chunk Compilation (includes figure binding) ──
        _emit(opts, "chunk_compiler", "start", "Compiling chunks with figure binding")
        fig_records = load_figures_for_document(doc.db_document_id) if doc.db_document_id else []
        result.figure_count = len(fig_records)
        ragflow_content, chunks = compile_chunks(
            norm_result.normalized_text, tree.nodes, doc, config,
            figure_records=fig_records or None,
        )
        save_chunks(ragflow_content, chunks, doc, output_dir)
        result.chunk_count = len(chunks)

        # Upload RAGFlow document
        ragflow_md_path = (
            output_dir / config.domain_id / config.domain_version_id
            / doc.document_id / "chunks" / "chunked_for_ragflow.md"
        )
        ragflow_storage_key = _upload_with_retry(ragflow_md_path, file_dir, "chunked_for_ragflow.md")
        update_document_fields(doc.db_document_id, ragflow_document_id=ragflow_storage_key)
        _emit(opts, "chunk_compiler", "end", f"Generated {len(chunks)} chunks, {len(fig_records)} figures")

        if should_stop("chunk_compiler"):
            result.status = "stopped"
            return result

        # ── Step 7: Insert chunks into knowledge_chunk ──
        _emit(opts, "chunk_db_insert", "start", f"Inserting {len(chunks)} chunks into DB")
        chunk_db_records = insert_chunks(doc.db_document_id, chunks)
        _emit(opts, "chunk_db_insert", "end", f"Inserted {len(chunk_db_records)} chunks")

        if should_stop("chunk_db_insert"):
            result.status = "stopped"
            return result

        # ── Step 8: Classify chunks into knowledge categories ──
        _emit(opts, "category_classify", "start", "Classifying chunks with LLM")
        domain_db_id = get_domain_db_id(config.domain_code or config.domain_id)
        if domain_db_id:
            chunk_dicts = [
                {
                    "chunk_id": c["chunk_id"],
                    "db_id": c["db_id"],
                    "content": chunks[i].content,
                    "title_path": " > ".join(chunks[i].section_path),
                }
                for i, c in enumerate(chunk_db_records)
            ]
            classify_chunks(chunk_dicts, domain_db_id)
        else:
            logger.warning(
                f"Domain '{config.domain_code or config.domain_id}' not found in knowledge_domain, "
                f"skipping category classification"
            )
        _emit(opts, "category_classify", "end", "Classification complete")

        if should_stop("category_classify"):
            result.status = "stopped"
            return result

        # ── Step 9: RAGFlow Packaging ──
        _emit(opts, "ragflow_packager", "start", "Packaging for RAGFlow")
        package_for_ragflow(doc, output_dir)
        _emit(opts, "ragflow_packager", "end", "Package ready")
        if should_stop("ragflow_packager"):
            result.status = "stopped"
            return result

        # ── Step 10: Preflight Validation ──
        _emit(opts, "preflight", "start", "Running quality checks")
        preflight = run_preflight(doc, chunks, fig_records, output_dir)
        save_preflight_report(preflight, output_dir, doc)
        _emit(opts, "preflight", "end", f"Status: {preflight.status} ({len(preflight.errors)} errors, {len(preflight.warnings)} warnings)")
        if should_stop("preflight"):
            result.status = "stopped"
            return result

        # ── Step 11: Processing Audit ──
        _emit(opts, "audit", "start", "Saving audit record")
        audit = create_audit(doc, job_id)
        finalize_audit(audit, preflight.status)
        save_audit(audit, output_dir)
        result.status = preflight.status
        _emit(opts, "audit", "end", f"Audit saved, status: {preflight.status}")

        update_document_fields(doc.db_document_id, status=preflight.status)

        # ── Step 12: RAGFlow Upload (optional) ──
        if opts.ragflow_config and not should_stop("ragflow_upload"):
            _emit(opts, "ragflow_upload", "start", "Uploading to RAGFlow")
            rf_result = upload_to_ragflow(
                doc, chunks, output_dir,
                opts.ragflow_config,
                dataset_name=opts.dataset_name,
            )
            result.ragflow_result = rf_result
            if rf_result.get("status") == "uploaded":
                update_document_fields(doc.db_document_id, status="uploaded")
            elif rf_result.get("status") == "failed":
                result.errors.append(f"RAGFlow upload: {rf_result.get('error', 'unknown')}")
            _emit(opts, "ragflow_upload", "end", f"RAGFlow: {rf_result.get('status', 'skipped')}")

        return result

    except Exception as e:
        result.status = "failed"
        result.errors.append(str(e))
        _emit(opts, "error", "log", str(e))
        return result


def process_domain(
    domain_id: str,
    output_dir: Path,
    options: Optional[PipelineOptions] = None,
    domains_dir: Optional[Path] = None,
    file_filter: Optional[str] = None,
) -> list:
    """Process all documents in a domain."""
    config = load_domain_config(domain_id, domains_dir)
    config_dir = domains_dir or (Path(__file__).parent.parent.parent / "domains")
    root = resolve_discovery_root(config, config_dir)

    results = []
    intake_result = discover_documents(config, config_dir)
    if intake_result.errors:
        for err in intake_result.errors:
            r = PipelineResult(domain_id=domain_id, document_id="")
            r.status = "failed"
            r.errors.append(err)
            results.append(r)
        return results

    for doc in intake_result.documents:
        if file_filter and file_filter not in doc.source_file_name:
            continue
        source_path = Path(doc.source_uri)
        r = process_document(source_path, config, output_dir, options)
        results.append(r)

    return results
