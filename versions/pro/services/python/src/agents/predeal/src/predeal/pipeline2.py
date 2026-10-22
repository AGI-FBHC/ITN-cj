"""Main pipeline orchestrator — idempotent, incremental, failure-resilient.

Step order (13 logical steps):

  1  intake            read file + hash
  2  create_document   idempotent upsert (stable document_key) + fast-path check
  3  archive           raw archive
  4  normalizer        markdown normalization (+ source_map.json)
  5  image_pipeline    download -> upload -> VLM (per-step resume, no repeat work)
  6  structure_parser  heading tree (+ offsets)
  7  chunk_compiler    slice + figure binding (+ chunk_manifest.json)
                        + T3.9 chunk_qc vector self-check (report-only)
  8  chunk_db_sync     diff-based insert/update/soft-delete
  9  category_classify T3.1 chunk enrichment: one LLM call per new/changed chunk
                        (classification + defines/uses/context_prefix/questions/
                        near_duplicate_hint/asset_summary) + T3.5 dedup
  10 ragflow_packager  import config (+ enrichment injected into packaged text)
  11 preflight         quality checks
  12 audit             audit record + document status
  13 ragflow_upload    idempotent/incremental RAGFlow sync

Idempotency: processing the same file twice never creates duplicate
documents/chunks, never re-uploads unchanged images, never re-calls a
successful VLM, never re-uploads an unchanged RAGFlow document, and produces
byte-identical artifacts (normalized.md / manifests / source_map.json).

Incremental: content changes are diffed at chunk level (content hash), old
chunks are soft-deleted (status='superseded') instead of physically removed,
and images/VLM results are reused when unchanged.

Failure recovery: every step can be re-run; stale 'processing' image states
are reset, unclassified chunks are retried, and RAGFlow sync resumes from the
last known document id.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from . import category_classifier as classifier
from . import chunk_repository as chunk_repo
from . import document_repository as doc_repo
from . import figure_chunk_binder as binder
from .config import DomainConfig, load_domain_config, resolve_discovery_root
from .file_uploader import upload_file
from .images.pipeline import process_markdown_images
from .models import DocumentSource
from .ragflow_client import RAGFlowConfig
from .steps import chunk_enricher as enricher
from .steps.audit import create_audit, finalize_audit, save_audit
from .steps.chunk_compiler import compile_chunks, save_chunks
from .steps.intake import discover_documents
from .steps.preflight import (
    low_confidence_warnings,
    run_chunk_qc,
    run_preflight,
    save_preflight_report,
)
from .steps.ragflow_packager2 import (
    package_for_ragflow,
    self_heal_chunk_ragflow_ids,
    sync_to_ragflow,
)
from .steps.raw_archive import archive_raw
from .steps.structure_parser import parse_structure, save_structure_tree
from .steps.normalizer import normalize_markdown, save_normalization
from .utils.hash import file_hash

logger = logging.getLogger(__name__)

_IMAGE_PIPELINE_MAX_RETRIES = 3
_FILE_UPLOAD_MAX_RETRIES = 3

# Statuses under which an unchanged document may take the fast path
_DONE_STATUSES = {"passed", "passed_with_warnings", "completed", "uploaded", "reused"}


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
    sync_report: Optional[Dict[str, Any]] = None
    db_document_id: Optional[int] = None  # knowledge_document.id in MySQL


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
    until: Optional[str] = None  # Stop after this step (for debugging)
    enable_ai: bool = False
    ragflow_config: Optional[RAGFlowConfig] = None  # If set, sync to RAGFlow
    dataset_name: Optional[str] = None  # Override dataset name
    storage_prefix: Optional[str] = None  # Image server storage prefix
    progress_callback: Optional[ProgressCallback] = None
    force: bool = False  # Ignore the fast path and re-run all steps
    skip_enrichment: bool = False  # 只切片、不做 LLM 分类（目录导入用，分类由调用方按标题绑定）


# Step order for --until
_STEP_ORDER = [
    "intake",              # 1
    "create_document",     # 2
    "archive",             # 3
    "normalizer",          # 4
    "image_pipeline",      # 5
    "structure_parser",    # 6
    "chunk_compiler",      # 7
    "chunk_db_sync",       # 8
    "category_classify",   # 9
    "ragflow_packager",    # 10
    "preflight",           # 11
    "audit",               # 12
    "ragflow_upload",      # 13
]


def _step_num(step_name: str) -> int:
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


def _doc_dir(output_dir: Path, config: DomainConfig, doc: DocumentSource) -> Path:
    return output_dir / config.domain_id / config.domain_version_id / doc.document_id


def _artifacts_complete(doc_dir: Path, source_file_name: str) -> bool:
    """Check that all local artifacts of a previous run exist."""
    required = [
        doc_dir / "raw" / source_file_name,
        doc_dir / "normalized" / "normalized.md",
        doc_dir / "structure" / "structure_tree.json",
        doc_dir / "chunks" / "chunk_manifest.json",
        doc_dir / "ragflow_package" / "ragflow_import_config.json",
        doc_dir / "audit" / "processing_audit.json",
    ]
    return all(p.exists() for p in required)


def _figure_manifest_from_db(rows: list[dict], output_dir: Path, doc: DocumentSource) -> Path:
    """Write figures/figure_manifest.json from knowledge_figures rows."""
    import json
    fig_dir = output_dir / doc.domain_id / doc.domain_version_id / doc.document_id / "figures"
    fig_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for r in rows:
        manifest.append({
            "id": r.get("id"),
            "occurrence_no": r.get("occurrence_no"),
            "figure_label": r.get("figure_label"),
            "caption": r.get("caption"),
            "alt_text": r.get("alt_text"),
            "source_url": r.get("source_url"),
            "storage_key": r.get("storage_key"),
            "sha256": r.get("sha256"),
            "vlm_description": r.get("vlm_description"),
            "vlm_model": r.get("vlm_model"),
            "download_status": r.get("download_status"),
            "upload_status": r.get("upload_status"),
            "vlm_status": r.get("vlm_status"),
        })
    path = fig_dir / "figure_manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


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
        content = source_path.read_text(encoding="utf-8")
        fhash = file_hash(str(source_path))

        # Stable logical key: relative path under the discovery root
        try:
            root = resolve_discovery_root(config)
            # as_posix()：Windows 下 str() 会产生反斜杠，导致同一文件在不同
            # 平台得到不同 document_key、幂等 upsert 失效
            rel_path = source_path.relative_to(root).as_posix()
        except ValueError:
            rel_path = source_path.name
        document_key = f"{config.domain_id}:{rel_path}"
        # document_code keeps the full relative path (dirs -> "_") so files
        # with the same name in different chapters stay distinct
        code_path = Path(rel_path).with_suffix("")
        document_code = f"{config.domain_id}_{code_path}".replace("/", "_").replace("\\", "_").replace(" ", "_")
        # knowledge_document.document_code 是 varchar(64)：长文件名截断并补哈希，避免入库 1406
        if len(document_code) > 64:
            document_code = f"{document_code[:55].rstrip('_')}_{fhash[:8]}"
        _emit(opts, "intake", "end", f"Hash: {fhash}")

        # ── Step 2: Create document record (idempotent) ──
        _emit(opts, "create_document", "start", f"Key: {document_key}")
        meta = config.metadata_defaults
        state = doc_repo.get_or_create_document(
            domain_id=config.domain_id,
            document_key=document_key,
            file_hash=fhash,
            title=meta.get("title", source_path.stem),
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
        db_id = state["db_id"]
        # Deterministic per-run document id (stable across re-runs)
        doc = DocumentSource(
            document_id=f"doc_{db_id:06d}",
            domain_id=config.domain_id,
            domain_version_id=config.domain_version_id,
            source_file_name=source_path.name,
            source_uri=str(source_path),
            file_hash=fhash,
            file_size=source_path.stat().st_size,
            pipeline_profile=config.pipeline_profile,
            authority_level=meta.get("authority_level"),
            applicability_scope=meta.get("applicability_scope", {}),
            db_document_id=db_id,
        )
        result.document_id = doc.document_id
        result.db_document_id = db_id
        _emit(opts, "create_document", "end",
              f"DB id={db_id} created={state['created_new']} unchanged={state['content_unchanged']}")

        # ── Fast path: unchanged content, previous run finished, artifacts intact ──
        if (state["content_unchanged"] and not opts.force
                and state["status"] in _DONE_STATUSES):
            d_dir = _doc_dir(output_dir, config, doc)
            if _artifacts_complete(d_dir, doc.source_file_name):
                ragflow_ok = True
                if opts.ragflow_config:
                    row = doc_repo.get_document_fields(db_id)
                    ragflow_ok = bool(row and row.get("ragflow_doc_id"))
                if ragflow_ok:
                    fig_rows = binder.load_figures_for_document(db_id) if db_id else []
                    chunk_rows = _load_active_chunk_counts(db_id)
                    result.status = "reused"
                    result.chunk_count = chunk_rows
                    result.figure_count = len(fig_rows)
                    result.sync_report = {
                        "inserted": 0, "updated": 0,
                        "unchanged": chunk_rows, "superseded": 0, "active": chunk_rows,
                        "reused": True,
                    }
                    _emit(opts, "audit", "log",
                          f"Content unchanged — reused previous results "
                          f"({result.chunk_count} chunks, {result.figure_count} figures)")
                    # Self-heal (T3.1): backfill any chunks that are still missing
                    # enrichment or a category classification (e.g. an LLM return
                    # without a category, or a partial run, on a previous pass).
                    # Cheap: only runs when the count is non-zero, so fully
                    # enriched docs stay zero-call.
                    try:
                        if enricher.count_chunks_needing_enrichment(db_id) > 0:
                            domain_db_id = classifier.get_domain_db_id(
                                config.domain_code or config.domain_id)
                            if domain_db_id:
                                _emit(opts, "category_classify", "start",
                                      "Backfilling missing enrichment/classification")
                                enricher.enrich_missing_for_document(db_id, domain_db_id)
                                enricher.dedup_document_chunks(db_id)
                                _emit(opts, "category_classify", "end",
                                      "Enrichment backfill complete")
                    except Exception as e:
                        logger.warning(f"Enrichment backfill failed: {e}")
                    # Self-heal: ragflow_chunk_id 映射缺失（上次上传后解析未完成
                    # 即退出）时补一次 RAGFlow chunk id 对齐。仅在存在缺失时才有
                    # API 调用（本地 SQL 判断），已映射文档零调用。
                    if opts.ragflow_config and db_id:
                        try:
                            self_heal_chunk_ragflow_ids(
                                db_id,
                                opts.ragflow_config,
                                dataset_name=opts.dataset_name
                                or f"{config.domain_code or config.domain_id}_{config.domain_version_id}",
                            )
                        except Exception as e:
                            logger.warning(f"RAGFlow chunk id self-heal failed: {e}")
                    if should_stop("create_document"):
                        result.status = "stopped"
                    return result

        # ── Step 3: Raw Archive ──
        _emit(opts, "archive", "start", "Archiving raw file")
        archive_raw(doc, config, source_path, output_dir)
        if should_stop("archive"):
            result.status = "stopped"
            return result

        # Upload raw file to file server (server dedupes by 409)
        file_dir = f"ITN/{config.domain_id}/{doc.document_id}"
        raw_path = _doc_dir(output_dir, config, doc) / "raw" / doc.source_file_name
        raw_storage_key = _upload_with_retry(raw_path, file_dir, doc.source_file_name)
        doc_repo.update_document_fields(db_id, storage_key=raw_storage_key)
        _emit(opts, "archive", "end", f"Raw archived, DB ID: {db_id}")

        # ── Step 4: Normalization ──
        _emit(opts, "normalizer", "start", "Normalizing markdown")
        norm_result = normalize_markdown(content)
        save_normalization(norm_result, doc, output_dir)
        _emit(opts, "normalizer", "end",
              f"Normalized: {len(norm_result.normalized_text)} chars, "
              f"{len(norm_result.image_refs)} images")
        if should_stop("normalizer"):
            result.status = "stopped"
            return result

        # ── Step 5: Image Pipeline (per-step idempotent) ──
        _emit(opts, "image_pipeline", "start", "Processing images")
        storage_prefix = opts.storage_prefix or config.figure_policy.storage_prefix
        if not storage_prefix:
            # 自动推导：ITN（项目名，每次必带）/ {domain_id 教程名} / {章节名或子教程目录}
            # 例：ITN/hello_agents/chapter4；根目录文档退化为 ITN/{domain_id}
            storage_prefix = f"ITN/{config.domain_id}"
            chapter_dir = Path(rel_path).parent
            if str(chapter_dir) not in ("", "."):
                storage_prefix = f"{storage_prefix}/{chapter_dir}"
        logger.info(f"Image storage prefix: {storage_prefix}")
        if config.figure_policy.enable_image_pipeline and norm_result.image_refs:
            norm_source = _doc_dir(output_dir, config, doc) / "normalized" / "normalized.md"
            last_error = None
            for attempt in range(_IMAGE_PIPELINE_MAX_RETRIES):
                try:
                    enhanced_path = process_markdown_images(
                        document_id=db_id,
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

        # Figure manifest from DB records (deterministic)
        fig_rows = binder.load_figures_for_document(db_id) if db_id else []
        result.figure_count = len(fig_rows)
        _figure_manifest_from_db(fig_rows, output_dir, doc)

        # Upload normalized file
        norm_file_path = _doc_dir(output_dir, config, doc) / "normalized" / "normalized.md"
        norm_storage_key = _upload_with_retry(norm_file_path, file_dir, "normalized.md")
        doc_repo.update_document_fields(db_id, normalized_storage_key=norm_storage_key)

        # ── Step 6: Structure Parsing ──
        _emit(opts, "structure_parser", "start", "Parsing document structure")
        tree = parse_structure(norm_result.normalized_text, doc)
        save_structure_tree(tree, output_dir, doc)
        _emit(opts, "structure_parser", "end", f"Found {len(tree.nodes)} top-level sections")
        if should_stop("structure_parser"):
            result.status = "stopped"
            return result

        # ── Step 7: Chunk Compilation (includes figure binding) ──
        _emit(opts, "chunk_compiler", "start", "Compiling chunks with figure binding")
        ragflow_content, chunks = compile_chunks(
            norm_result.normalized_text, tree.nodes, doc, config,
            figure_records=fig_rows or None,
        )
        save_chunks(ragflow_content, chunks, doc, output_dir)
        result.chunk_count = len(chunks)

        # Upload chunked_for_ragflow.md (compat field ragflow_document_id)
        ragflow_md_path = _doc_dir(output_dir, config, doc) / "chunks" / "chunked_for_ragflow.md"
        ragflow_storage_key = _upload_with_retry(ragflow_md_path, file_dir, "chunked_for_ragflow.md")
        doc_repo.update_document_fields(db_id, ragflow_document_id=ragflow_storage_key)
        _emit(opts, "chunk_compiler", "end", f"Generated {len(chunks)} chunks")
        if should_stop("chunk_compiler"):
            result.status = "stopped"
            return result

        # ── T3.9: chunk QC (vector self-check, report-only, before DB sync) ──
        qc_warnings = []
        try:
            qc_warnings = run_chunk_qc(chunks)
        except Exception as e:
            logger.warning(f"chunk_qc failed (non-fatal): {e}")

        # ── Step 8: Chunk DB sync (diff-based, soft delete) ──
        _emit(opts, "chunk_db_sync", "start", f"Syncing {len(chunks)} chunks into DB")
        report = chunk_repo.sync_chunks(db_id, chunks)
        result.sync_report = report.to_dict()
        _emit(opts, "chunk_db_sync", "end", str(report.to_dict()))
        if should_stop("chunk_db_sync"):
            result.status = "stopped"
            return result

        # ── Step 9: Chunk enrichment (T3.1 一次 LLM 通道 — classify + defines/
        # uses/context_prefix/questions/near_duplicate_hint/asset_summary in a
        # single call; only inserted/updated chunks are processed, see
        # chunk_enricher.get_chunks_needing_enrichment) ──
        _emit(opts, "category_classify", "start", "Enriching new/changed chunks")
        domain_db_id = classifier.get_domain_db_id(config.domain_code or config.domain_id)
        enriched = 0
        if opts.skip_enrichment:
            logger.info("skip_enrichment=True — 跳过 LLM 分类，切片分类由调用方按标题绑定")
        elif domain_db_id:
            try:
                enriched = len(enricher.enrich_missing_for_document(db_id, domain_db_id))
                enricher.dedup_document_chunks(db_id)  # T3.5 index-time dedup
            except Exception as e:
                logger.warning(f"Chunk enrichment failed (will retry next run): {e}")
                result.errors.append(f"category_classify: {e}")
        else:
            logger.warning(
                f"Domain '{config.domain_code or config.domain_id}' not found in "
                f"knowledge_domain, skipping chunk enrichment"
            )
        _emit(opts, "category_classify", "end", f"Enriched {enriched} chunks")
        if should_stop("category_classify"):
            result.status = "stopped"
            return result

        # ── Step 10: RAGFlow Packaging (also injects enrichment into the
        # packaged text, see ragflow_packager2.rewrite_ragflow_md_with_enrichment) ──
        _emit(opts, "ragflow_packager", "start", "Packaging for RAGFlow")
        package_for_ragflow(doc, output_dir, chunks=chunks, chunk_report=report)
        _emit(opts, "ragflow_packager", "end", "Package ready")
        if should_stop("ragflow_packager"):
            result.status = "stopped"
            return result

        # ── Step 11: Preflight Validation (merges T3.9 QC warnings) ──
        _emit(opts, "preflight", "start", "Running quality checks")
        low_conf_warnings = []
        try:
            confidence_map = enricher.get_confidence_by_chunk_code(db_id)
            low_conf_warnings = low_confidence_warnings(confidence_map)
        except Exception as e:
            logger.warning(f"low_confidence QC failed (non-fatal): {e}")
        preflight = run_preflight(
            doc, chunks, fig_rows, output_dir,
            extra_warnings=qc_warnings + low_conf_warnings,
        )
        save_preflight_report(preflight, output_dir, doc)
        _emit(opts, "preflight", "end",
              f"Status: {preflight.status} ({len(preflight.errors)} errors, "
              f"{len(preflight.warnings)} warnings)")
        if should_stop("preflight"):
            result.status = "stopped"
            return result

        # ── Step 12: Processing Audit + status ──
        _emit(opts, "audit", "start", "Saving audit record")
        audit = create_audit(doc, job_id)
        finalize_audit(audit, preflight.status)
        save_audit(audit, output_dir)
        result.status = preflight.status
        doc_repo.update_document_fields(db_id, status=preflight.status, last_error=None)
        _emit(opts, "audit", "end", f"Audit saved, status: {preflight.status}")

        # ── Step 13: RAGFlow Upload (idempotent/incremental) ──
        if opts.ragflow_config and not should_stop("ragflow_upload"):
            _emit(opts, "ragflow_upload", "start", "Syncing to RAGFlow")
            rf_result = sync_to_ragflow(
                doc, chunks, report, output_dir,
                opts.ragflow_config,
                # 数据集统一按知识领域编码命名：{knowledge_domain.code}_v1
                dataset_name=opts.dataset_name
                or f"{config.domain_code or config.domain_id}_{config.domain_version_id}",
            )
            result.ragflow_result = rf_result
            if rf_result.get("status") == "failed":
                result.errors.append(f"RAGFlow upload: {rf_result.get('error', 'unknown')}")
                result.status = "failed"
                doc_repo.update_document_fields(db_id, status="failed")
            else:
                doc_repo.update_document_fields(db_id, status="uploaded")
            _emit(opts, "ragflow_upload", "end", f"RAGFlow: {rf_result.get('status', 'skipped')}")

        return result

    except Exception as e:
        result.status = "failed"
        result.errors.append(str(e))
        try:
            if doc.db_document_id:
                doc_repo.mark_document_failed(doc.db_document_id, str(e))
        except Exception:
            logger.exception("Failed to mark document failed")
        _emit(opts, "error", "log", str(e))
        return result


def _load_active_chunk_counts(db_id: int) -> int:
    """Count active chunks (imported lazily to keep fast path light)."""
    return chunk_repo.count_active_chunks(db_id)


def process_domain(
    domain_id: str,
    output_dir: Path,
    options: Optional[PipelineOptions] = None,
    domains_dir: Optional[Path] = None,
    file_filter: Optional[str] = None,
) -> list:
    """Process all documents in a domain.

    Each document is isolated: a failure in one document is reported in its
    PipelineResult and processing continues with the remaining documents.
    """
    config = load_domain_config(domain_id, domains_dir)
    config_dir = domains_dir or (Path(__file__).parent.parent.parent / "domains")
    resolve_discovery_root(config, config_dir)

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
        try:
            r = process_document(source_path, config, output_dir, options)
        except Exception as e:  # belt and suspenders — never stop the domain loop
            r = PipelineResult(domain_id=domain_id, document_id=doc.source_file_name)
            r.status = "failed"
            r.errors.append(str(e))
        results.append(r)

    return results
