"""Step 10: RAGFlow Document Packaging — assemble the import package and optionally upload to RAGFlow."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, Optional

from ..models import DocumentSource, KnowledgeChunk, RAGFlowImportConfig
from ..ragflow_client import RAGFlowClient, RAGFlowConfig, RAGFlowError

logger = logging.getLogger(__name__)


CHUNK_SEPARATOR = "<<<ITN_CHUNK_BOUNDARY>>>"


def package_for_ragflow(
    doc: DocumentSource,
    output_dir: Path,
) -> Path:
    """Create the ragflow_package directory with import config."""
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

    return pkg_dir


def upload_to_ragflow(
    doc: DocumentSource,
    chunks: list[KnowledgeChunk],
    output_dir: Path,
    ragflow_config: RAGFlowConfig,
    dataset_name: Optional[str] = None,
    embedding_model: Optional[str] = None,
) -> Dict[str, Any]:
    """Upload processed document to RAGFlow.

    Strategy:
    1. Find or create dataset
    2. Upload chunked_for_ragflow.md as a placeholder document
    3. Use RAGFlow's add_chunk API to create chunks directly
       (RAGFlow's naive chunk method ignores delimiter, so we bypass it)

    Returns:
        Dict with dataset_id, document_id, chunk_count.
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

    # Step 1: Find or create dataset
    try:
        existing = client.find_dataset_by_name(ds_name)
        if existing:
            dataset_id = existing["id"]
            result["dataset_id"] = dataset_id
        else:
            ds = client.create_dataset(
                name=ds_name,
                embedding_model=embedding_model,
                chunk_method="naive",
                parser_config={
                    "chunk_token_num": 2048,
                },
                description=f"Auto-created by predeal for {doc.domain_id}/{doc.domain_version_id}",
            )
            dataset_id = ds["id"]
            result["dataset_id"] = dataset_id
    except RAGFlowError as e:
        result["status"] = "failed"
        result["error"] = f"Dataset operation failed: {e.message}"
        return result

    # Step 2: Clean up existing document with same name, then upload
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

    try:
        # Delete existing document with the same filename to avoid accumulation
        existing_docs = client.list_documents(dataset_id)
        for existing_doc in existing_docs:
            if existing_doc.get("name", "").startswith("chunked_for_ragflow"):
                try:
                    client.delete_documents(dataset_id, [existing_doc["id"]])
                    logger.info(f"Deleted existing RAGFlow document: {existing_doc['name']}")
                except RAGFlowError:
                    pass

        doc_info = client.upload_document(dataset_id, ragflow_md)
        document_id = doc_info.get("id")
        result["document_id"] = document_id
    except RAGFlowError as e:
        result["status"] = "failed"
        result["error"] = f"Document upload failed: {e.message}"
        return result

    # Step 3: Add our pre-split chunks
    try:
        added_count = 0
        for chunk in chunks:
            # Build chunk text with section path headers
            header_lines = []
            for sp in chunk.section_path:
                level = chunk.section_path.index(sp) + 1
                header_lines.append(f"{'#' * level} {sp}")

            chunk_text = "\n".join(header_lines) + "\n\n" + chunk.content if header_lines else chunk.content

            # Remove any CHUNK_SEPARATOR from the content
            chunk_text = chunk_text.replace(CHUNK_SEPARATOR, "").strip()

            if not chunk_text:
                continue

            try:
                client.add_chunk(
                    dataset_id,
                    document_id,
                    chunk_text,
                    important_keywords=[],
                )
                added_count += 1
            except RAGFlowError as e:
                # Log but continue with other chunks
                pass

        result["chunk_count"] = added_count
    except RAGFlowError as e:
        result["status"] = "uploaded"
        result["warning"] = f"Chunk management failed: {e.message}"
        return result

    result["status"] = "uploaded"
    return result
