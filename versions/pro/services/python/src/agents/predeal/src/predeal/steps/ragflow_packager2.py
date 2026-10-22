"""Step 10: RAGFlow Document Packaging — assemble the import package and sync to RAGFlow.

sync_to_ragflow is idempotent and incremental:

- Same chunked content as the last successful upload  -> no API calls (up_to_date)
- Content changed, chunk layout unchanged             -> in-place PATCH of changed chunks
  (superseded chunks are disabled via available=false when ids are known)
- Content changed, chunk layout changed               -> replace the document: every old
  version (exact name, RAGFlow's auto-renamed ``name(1).md`` variants, legacy name) is
  removed BEFORE the upload so the dataset never accumulates multiple versions.
- Failure recovery                                    -> a re-run detects the existing
  document by name (including variants) and resumes instead of duplicating
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import chunk_enricher
from .. import chunk_repository as chunk_repo
from .. import document_repository as doc_repo
from ..models import DocumentSource, KnowledgeChunk, RAGFlowImportConfig
from ..ragflow_client import RAGFlowClient, RAGFlowConfig, RAGFlowError
from ..utils.hash import content_hash

logger = logging.getLogger(__name__)

CHUNK_SEPARATOR = "<<<ITN_CHUNK_BOUNDARY>>>"

# RAGFlow parser_config.delimiter 字段值：必须用反引号包裹，
# RAGFlow（markdown/txt 解析器）才把它当作"整体分隔符 + 每段一 chunk"
# （见 ragflow/rag/nlp/__init__.py naive_merge 的 has_custom 分支，
#   以及 deepdoc/parser/markdown_parser.py get_delimiters）。
# 裸字符串（无反引号）会被解析成单字符集合或直接忽略：
#   - md 解析路径：get_delimiters 只提取反引号 token → 空 → delimiter 不生效
#   - txt 解析路径：被当成单字符 delimiter → 在任意 I/T/N/< 等字符处乱切
# 后果：RAGFlow chunk 边界与 MySQL knowledge_chunk 不一致（实测 52 切片 → 18 chunk），
# 且分隔符文本残留在 chunk 内容里。
RAGFLOW_DELIMITER_FIELD = f"`{CHUNK_SEPARATOR}`"

# RAGFlow v0.26.4 的 md 解析分支（rag/app/naive.py is_markdown 段）对 delimiter
# 切出的 section 仍按 chunk_token_num 合并（chunk_limit 循环），没有"每段一
# chunk"开关。实测设 chunk_token_num=1 使合并条件恒真 → 每个 delimiter 段独立成
# chunk，RAGFlow chunk 边界与 MySQL knowledge_chunk 完全一致（52 切片 → 52 chunk，
# 无 delimiter 残留）。tokenize_chunks 后处理不按 chunk_token_num 切分，安全。
RAGFLOW_CHUNK_TOKEN_NUM = 1

# Legacy document name used by the pre-migration pipeline
_LEGACY_RAGFLOW_DOC_NAME = "chunked_for_ragflow.md"


def _as_dict(value) -> dict:
    """RAGFlow sometimes returns parser_config as a JSON string."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def _doc_name_variants(stem: str, name: str) -> bool:
    """True if a RAGFlow document name belongs to our target document.

    RAGFlow auto-renames duplicate uploads: ``doc_000020.md`` becomes
    ``doc_000020(1).md``, ``doc_000020(2).md`` … — all of them are versions
    of the same logical document and must be treated as one.
    """
    if name == f"{stem}.md":
        return True
    if re.fullmatch(rf"{re.escape(stem)}\(\d+\)\.md", name):
        return True
    return False


def package_for_ragflow(
    doc: DocumentSource,
    output_dir: Path,
    chunks: Optional[List[KnowledgeChunk]] = None,
    chunk_report: Optional[Any] = None,
) -> Path:
    """Create the ragflow_package directory with import config.

    When ``chunks`` + ``chunk_report`` are given (the normal pipeline call),
    also rewrites ``chunks/chunked_for_ragflow.md`` so the text actually
    uploaded to RAGFlow carries each chunk's enrichment (context_prefix +
    generated questions + asset_summary, T3.1 §4 / T3.6) — a no-op when no
    enrichment rows exist yet for this document.
    """
    pkg_dir = (
        output_dir
        / doc.domain_id
        / doc.domain_version_id
        / doc.document_id
        / "ragflow_package"
    )
    pkg_dir.mkdir(parents=True, exist_ok=True)

    config = RAGFlowImportConfig(
        dataset_name=f"{doc.domain_id}_{doc.domain_version_id}",
        document_id=doc.document_id,
    )

    config_path = pkg_dir / "ragflow_import_config.json"
    config_path.write_text(
        json.dumps(config.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    if chunks:
        rewrite_ragflow_md_with_enrichment(doc, chunks, chunk_report, output_dir)

    return pkg_dir


def _chunk_ragflow_text(chunk: KnowledgeChunk, enrichment: Optional[dict] = None) -> str:
    """Reconstruct the exact section text of a chunk inside chunked_for_ragflow.md.

    T3.1 §4: when enrichment is available, the block text becomes
    ``context_prefix + "\\n" + "\\n".join(questions) + "\\n\\n" + 原文``
    (each segment skipped when absent/None — the delimiter/chunk_token_num
    contract with RAGFlow, see module docstring, is untouched).
    """
    header_lines = []
    for i, sp in enumerate(chunk.section_path):
        header_lines.append(f"{'#' * (i + 1)} {sp}")
    header = "\n".join(header_lines)

    prefix_parts = []
    if enrichment:
        context_prefix = enrichment.get("context_prefix")
        if context_prefix:
            prefix_parts.append(context_prefix)
        questions = enrichment.get("questions") or []
        if questions:
            prefix_parts.append("\n".join(questions))
        asset_summary = enrichment.get("asset_summary")
        if asset_summary:
            prefix_parts.append(asset_summary)

    body = ("\n".join(prefix_parts) + "\n\n" + chunk.content) if prefix_parts else chunk.content
    return f"{header}\n\n{body}" if header_lines else body


def build_enriched_ragflow_md(
    chunks: List[KnowledgeChunk],
    enrichment_by_chunk_id: Optional[Dict[str, dict]] = None,
) -> str:
    """Rebuild the ragflow markdown, injecting per-chunk enrichment when present."""
    enrichment_by_chunk_id = enrichment_by_chunk_id or {}
    parts = [
        _chunk_ragflow_text(c, enrichment_by_chunk_id.get(c.chunk_id))
        for c in chunks
    ]
    content = f"\n\n{CHUNK_SEPARATOR}\n\n".join(parts)
    if parts:
        content = f"{CHUNK_SEPARATOR}\n\n{content}"
    return content


def rewrite_ragflow_md_with_enrichment(
    doc: DocumentSource,
    chunks: List[KnowledgeChunk],
    chunk_report: Optional[Any],
    output_dir: Path,
) -> Optional[Path]:
    """Overwrite chunked_for_ragflow.md with enrichment-augmented chunk text.

    No-op (returns None, file left untouched) when there is no known chunk
    db id mapping or no enrichment rows yet for this document — e.g. the
    classification/enrichment step failed or the domain isn't registered.
    """
    all_db_ids: Dict[str, int] = getattr(chunk_report, "all_db_ids", None) or {}
    db_ids = [all_db_ids[c.chunk_id] for c in chunks if all_db_ids.get(c.chunk_id)]
    if not db_ids:
        return None

    enrichment_rows = chunk_enricher.get_enrichment_for_chunks(db_ids)
    if not enrichment_rows:
        return None

    by_chunk_id = {
        c.chunk_id: enrichment_rows[all_db_ids[c.chunk_id]]
        for c in chunks
        if all_db_ids.get(c.chunk_id) in enrichment_rows
    }
    if not by_chunk_id:
        return None

    content = build_enriched_ragflow_md(chunks, by_chunk_id)
    path = (
        output_dir / doc.domain_id / doc.domain_version_id / doc.document_id
        / "chunks" / "chunked_for_ragflow.md"
    )
    path.write_text(content, encoding="utf-8")
    return path


def sync_to_ragflow(
    doc: DocumentSource,
    chunks: list[KnowledgeChunk],
    chunk_report: Any,
    output_dir: Path,
    ragflow_config: RAGFlowConfig,
    dataset_name: Optional[str] = None,
    embedding_model: Optional[str] = None,
) -> Dict[str, Any]:
    """Idempotently sync the chunked document to RAGFlow.

    Returns:
        Dict with dataset_id, document_id, chunk_count, status:
          - "up_to_date" : nothing changed since last upload (no API calls)
          - "uploaded"   : fresh document uploaded (or re-uploaded + old deleted)
          - "in_place"   : chunk contents patched in place
          - "failed"     : with error message
    """
    client = RAGFlowClient(ragflow_config)
    ds_name = dataset_name or f"{doc.domain_id}_{doc.domain_version_id}"

    result: Dict[str, Any] = {
        "dataset_name": ds_name,
        "dataset_id": None,
        "document_id": None,
        "chunk_count": 0,
        "status": "pending",
    }

    ragflow_md = (
        output_dir
        / doc.domain_id
        / doc.domain_version_id
        / doc.document_id
        / "chunks"
        / "chunked_for_ragflow.md"
    )
    if not ragflow_md.exists():
        result["status"] = "failed"
        result["error"] = f"chunked_for_ragflow.md not found at {ragflow_md}"
        return result

    local_hash = content_hash(ragflow_md.read_text(encoding="utf-8"))
    target_name = f"{doc.document_id}.md"
    doc_row = doc_repo.get_document_fields(doc.db_document_id) if doc.db_document_id else None

    # ── Step 1: find or create dataset ──
    try:
        existing = client.find_dataset_by_name(ds_name)
        if existing:
            dataset_id = existing["id"]
            result["dataset_id"] = dataset_id
            # The dataset-level delimiter is the only parser_config this RAGFlow
            # version honours (per-document overrides are ignored). If the
            # dataset was created before delimiter chunking existed (or by the
            # legacy pipeline), reconfigure it so new uploads parse correctly.
            try:
                ds_info = client.get_dataset(dataset_id)
                ds_pc = _as_dict(ds_info.get("parser_config"))
                if ds_pc.get("delimiter") != RAGFLOW_DELIMITER_FIELD:
                    client.update_dataset(
                        dataset_id,
                        parser_config={
                            "delimiter": RAGFLOW_DELIMITER_FIELD,
                            "chunk_token_num": RAGFLOW_CHUNK_TOKEN_NUM,
                        },
                    )
                    result["dataset_reconfigured"] = True
                    logger.info(f"RAGFlow dataset {ds_name} reconfigured for delimiter chunking")
            except RAGFlowError as e:
                result["warning"] = f"Dataset parser_config check failed: {e.message}"
        else:
            ds = client.create_dataset(
                name=ds_name,
                embedding_model=embedding_model,
                chunk_method="naive",
                parser_config={
                    "delimiter": RAGFLOW_DELIMITER_FIELD,
                    "chunk_token_num": RAGFLOW_CHUNK_TOKEN_NUM,
                },
                description=f"Auto-created by predeal for {doc.domain_id}/{doc.domain_version_id}",
            )
            dataset_id = ds["id"]
            result["dataset_id"] = dataset_id
    except RAGFlowError as e:
        result["status"] = "failed"
        result["error"] = f"Dataset operation failed: {e.message}"
        return result
    except RAGFlowError as e:
        result["status"] = "failed"
        result["error"] = f"Dataset operation failed: {e.message}"
        return result

    # ── Step 2: locate our document in the dataset (idempotent reuse) ──
    try:
        all_docs = client.list_documents(dataset_id, page_size=100)
    except RAGFlowError as e:
        result["status"] = "failed"
        result["error"] = f"List documents failed: {e.message}"
        return result

    stored_rf_id = (doc_row or {}).get("ragflow_doc_id")
    last_hash = (doc_row or {}).get("last_ragflow_sha256")
    target_stem = target_name.rsplit(".", 1)[0]
    existing_doc = None
    for d in all_docs:
        if (_doc_name_variants(target_stem, d.get("name"))
                or d.get("name") == _LEGACY_RAGFLOW_DOC_NAME):
            existing_doc = d
            break

    if existing_doc is None:
        return _upload_fresh(
            client, dataset_id, target_name, ragflow_md, chunks,
            result, doc, local_hash, old_doc=None, all_docs=all_docs,
        )

    result["document_id"] = existing_doc["id"]

    # ── Step 3: nothing changed since our last successful upload ──
    # 严格校验：只有文档明确声明用"反引号包裹的 delimiter"解析过才视为正确。
    # 存量文档（delimiter 为 None / 裸字符串）chunk 边界与切片不一致，强制重传。
    doc_pc = _as_dict(existing_doc.get("parser_config"))
    parsed_with_correct_delimiter = bool(
        doc_pc and doc_pc.get("delimiter") == RAGFLOW_DELIMITER_FIELD
    )
    if (last_hash == local_hash and stored_rf_id == existing_doc["id"]
            and parsed_with_correct_delimiter):
        # self-heal: if the doc somehow has no chunks yet (parse was never
        # completed), re-trigger parsing once.
        try:
            rf_chunks = client.list_chunks(dataset_id, existing_doc["id"])
            if not rf_chunks:
                client.parse_documents(dataset_id, [existing_doc["id"]])
        except RAGFlowError:
            pass
        # self-heal: 上次上传后解析未完成即退出 → ragflow_chunk_id 永久缺失；
        # 此路径补一次对齐回写（本地 SQL 判断缺失，已映射文档零 API 调用）。
        try:
            if doc.db_document_id and chunk_repo.missing_ragflow_ids(doc.db_document_id):
                _sync_chunk_ragflow_ids(client, dataset_id, existing_doc["id"], doc)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"chunk id self-heal failed: {e}")
        result["status"] = "up_to_date"
        result["chunk_count"] = len(chunks)
        return result

    # ── Step 4: try in-place incremental PATCH (same layout, contents differ) ──
    active_rows = chunk_repo.get_active_chunks(doc.db_document_id) if doc.db_document_id else []
    has_new = bool(chunk_report and getattr(chunk_report, "inserted", None))
    has_superseded = bool(chunk_report and getattr(chunk_report, "superseded_ids", None))

    if (not has_new and not has_superseded
            and stored_rf_id == existing_doc["id"]):
        try:
            rf_chunks = client.list_chunks(dataset_id, existing_doc["id"])
        except RAGFlowError as e:
            rf_chunks = []
            logger.warning(f"list_chunks failed: {e.message}")

        if len(rf_chunks) == len(active_rows) == len(chunks) and rf_chunks:
            patched = 0
            rf_sorted = sorted(
                rf_chunks, key=lambda c: c.get("create_time", 0))
            enrichment_by_db_id = (
                chunk_enricher.get_enrichment_for_chunks([r["id"] for r in active_rows])
                if active_rows else {}
            )
            for db_row, rf_chunk in zip(active_rows, rf_sorted):
                expected = _chunk_ragflow_text(
                    chunks[db_row["chunk_index"] - 1],
                    enrichment_by_db_id.get(db_row["id"]),
                ) if 1 <= db_row["chunk_index"] <= len(chunks) else None
                if expected is None:
                    continue
                if (rf_chunk.get("content") or "").strip() != expected.strip():
                    try:
                        client.update_chunk(
                            dataset_id, existing_doc["id"],
                            rf_chunk["id"], content=expected,
                        )
                        patched += 1
                    except RAGFlowError as e:
                        result["status"] = "failed"
                        result["error"] = f"Chunk update failed: {e.message}"
                        return result
                chunk_repo.update_chunk_ragflow_id(db_row["id"], rf_chunk["id"])
            doc_repo.update_document_fields(doc.db_document_id, last_ragflow_sha256=local_hash)
            result["status"] = "in_place"
            result["chunk_count"] = len(chunks)
            result["patched_chunks"] = patched
            logger.info(f"RAGFlow in-place sync: patched {patched} chunks")
            return result

    # ── Step 5: layout changed or unknown state -> replace the document ──
    return _upload_fresh(
        client, dataset_id, target_name, ragflow_md, chunks,
        result, doc, local_hash, old_doc=existing_doc, all_docs=all_docs,
    )


def _upload_fresh(
    client: RAGFlowClient,
    dataset_id: str,
    target_name: str,
    ragflow_md: Path,
    chunks: list,
    result: Dict[str, Any],
    doc: DocumentSource,
    local_hash: str,
    old_doc: Optional[Dict[str, Any]],
    all_docs: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Replace the document in RAGFlow with a fresh upload.

    Every previous version — the exact-name document, RAGFlow's auto-renamed
    ``name(1).md`` variants, and the pre-migration ``chunked_for_ragflow.md`` —
    is deleted BEFORE the upload so the new document always gets the clean
    name and the dataset never accumulates multiple versions. If the upload
    then fails, the next run re-uploads (the index is stale anyway).
    """
    stem = target_name.rsplit(".", 1)[0]

    # ── 1. remove every old version first ──
    stale_ids: list[str] = []
    if all_docs is None:
        try:
            all_docs = client.list_documents(dataset_id, page_size=100)
        except RAGFlowError:
            all_docs = []
    for d in all_docs:
        if (_doc_name_variants(stem, d.get("name"))
                or d.get("name") == _LEGACY_RAGFLOW_DOC_NAME):
            stale_ids.append(d["id"])
    if stale_ids:
        try:
            client.delete_documents(dataset_id, stale_ids)
            result["removed_old_versions"] = stale_ids
        except RAGFlowError as e:
            result["warning"] = f"Old version cleanup failed: {e.message}"

    # ── 2. upload the fresh document (delimiter-based chunking) ──
    try:
        doc_info = client.upload_document(
            dataset_id, ragflow_md, name=target_name,
            parser_config={
            "delimiter": RAGFLOW_DELIMITER_FIELD,
            "chunk_token_num": RAGFLOW_CHUNK_TOKEN_NUM,
        },
        )
        document_id = doc_info.get("id")
        result["document_id"] = document_id
        result["chunk_count"] = len(chunks)
    except RAGFlowError as e:
        result["status"] = "failed"
        result["error"] = f"Document upload failed: {e.message}"
        return result

    try:
        client.parse_documents(dataset_id, [document_id])
    except RAGFlowError as e:
        # Document is uploaded; parsing will be retried on the next run.
        result["status"] = "uploaded"
        result["warning"] = f"Parse trigger failed: {e.message}"
    else:
        result["status"] = "uploaded"

    if doc.db_document_id:
        doc_repo.update_document_fields(
            doc.db_document_id,
            ragflow_doc_id=document_id,
            last_ragflow_sha256=local_hash,
        )
        # 重传后 RAGFlow chunk id 全部变化：按 chunk_index 与解析结果对齐，
        # 回写 MySQL knowledge_chunk.ragflow_chunk_id，
        # 否则 chunk 级映射（如 backfill 写回）会引用失效 id。
        _sync_chunk_ragflow_ids(client, dataset_id, document_id, doc)
    return result


def _sync_chunk_ragflow_ids(
    client: RAGFlowClient,
    dataset_id: str,
    document_id: str,
    doc: DocumentSource,
    db_id: Optional[int] = None,
) -> None:
    """按 chunk_index 对齐，把 RAGFlow 解析产出的 chunk id 写回 MySQL.

    解析是异步的（parse_documents 立即返回），本函数在文档 DONE 后由
    后续 pipeline 运行补齐；若解析未完成则跳过，下次 sync 的 in-place
    路径（Step 4）与 reused 快路径（self_heal_chunk_ragflow_ids）会兜底对齐。
    """
    chunk_db_id = db_id or getattr(doc, "db_document_id", None)
    if not chunk_db_id:
        return
    try:
        # RAGFlow page_size 上限 100；单文档切片目前均 < 100，超出时后续可加分页
        rf_chunks = client.list_chunks(dataset_id, document_id, page_size=100)
    except RAGFlowError as e:
        logger.warning(f"list_chunks failed during chunk id sync: {e.message}")
        return
    if not rf_chunks:
        return  # 解析尚未完成，留待下次
    rows = chunk_repo.get_active_chunks(chunk_db_id)
    if len(rf_chunks) != len(rows):
        # 数量不一致：解析不完整或切片布局变化 → 跳过，避免按位置错位映射
        logger.info(
            "chunk id sync skipped: rf=%d db=%d (incomplete parse or layout change)",
            len(rf_chunks), len(rows),
        )
        return
    rf_sorted = sorted(rf_chunks, key=lambda c: c.get("create_time", 0))
    # get_active_chunks 已按 chunk_index 升序返回（见 chunk_repository）
    for db_row, rf_chunk in zip(rows, rf_sorted):
        chunk_repo.update_chunk_ragflow_id(db_row["id"], rf_chunk["id"])
    logger.info(
        "chunk id sync: %d chunks mapped for doc %s",
        len(rows), document_id,
    )


def self_heal_chunk_ragflow_ids(
    db_id: int,
    ragflow_config: RAGFlowConfig,
    dataset_name: Optional[str] = None,
) -> bool:
    """补写缺失的 ragflow_chunk_id 映射（pipeline reused 快路径调用）.

    场景：上传后 RAGFlow 解析未完成即退出 → 数据库 ragflow_chunk_id 全 NULL；
    此后内容不变走 reused 快路径不再进入 sync_to_ragflow，映射永久缺失。
    本函数仅在存在缺失映射时才产生 API 调用（本地 SQL 判断，已映射文档零调用）。
    """
    try:
        if not chunk_repo.missing_ragflow_ids(db_id):
            return False
        row = doc_repo.get_document_fields(db_id)
        rf_doc_id = (row or {}).get("ragflow_doc_id")
        if not rf_doc_id:
            return False
        client = RAGFlowClient(ragflow_config)
        ds = client.find_dataset_by_name(dataset_name) if dataset_name else None
        if not ds:
            return False
        _sync_chunk_ragflow_ids(client, ds["id"], rf_doc_id, doc=None, db_id=db_id)
        return True
    except Exception as e:  # noqa: BLE001 — 自愈失败不影响主流程
        logger.warning(f"chunk id self-heal failed for doc {db_id}: {e}")
        return False


def upload_to_ragflow(
    doc: DocumentSource,
    chunks: list[KnowledgeChunk],
    output_dir: Path,
    ragflow_config: RAGFlowConfig,
    dataset_name: Optional[str] = None,
    embedding_model: Optional[str] = None,
) -> Dict[str, Any]:
    """Backwards-compatible wrapper around sync_to_ragflow (no diff report)."""
    return sync_to_ragflow(
        doc, chunks, None, output_dir, ragflow_config,
        dataset_name=dataset_name, embedding_model=embedding_model,
    )
