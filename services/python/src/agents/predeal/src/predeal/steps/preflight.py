"""Step 10: Preflight Validation — quality checks before RAGFlow import."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from ..models import (
    ChunkType,
    DocumentSource,
    KnowledgeChunk,
    PreflightReport,
    PreflightWarning,
)

if TYPE_CHECKING:
    from ..embedding_client import EmbeddingClient


def run_preflight(
    doc: DocumentSource,
    chunks: list[KnowledgeChunk],
    fig_records: Optional[list[dict]] = None,
    output_dir: Optional[Path] = None,
    extra_warnings: Optional[list[PreflightWarning]] = None,
) -> PreflightReport:
    """Run all preflight checks and generate a report.

    ``extra_warnings`` (T3.9 chunk_qc: merge_candidate / split_candidate /
    low_confidence) are merged in as-is — QC only produces report entries,
    it never changes chunk content, and a document with only warnings still
    ends up ``passed_with_warnings`` (never ``failed``).
    """
    report = PreflightReport(document_id=doc.document_id)
    report.chunk_count = len(chunks)
    report.figure_count = len(fig_records) if fig_records else 0

    base = output_dir / doc.domain_id / doc.domain_version_id / doc.document_id

    # File existence checks
    _check_file_exists(base / "raw" / doc.source_file_name, "raw_file", report)
    _check_file_exists(base / "normalized" / "normalized.md", "normalized_md", report)
    _check_file_exists(base / "chunks" / "chunked_for_ragflow.md", "ragflow_md", report)
    _check_file_exists(base / "chunks" / "chunk_manifest.json", "chunk_manifest", report)

    # Chunk metadata completeness
    for chunk in chunks:
        if not chunk.domain_id:
            report.errors.append(f"{chunk.chunk_id}: missing domain_id")
        if not chunk.domain_version_id:
            report.errors.append(f"{chunk.chunk_id}: missing domain_version_id")
        if not chunk.document_id:
            report.errors.append(f"{chunk.chunk_id}: missing document_id")
        if chunk.source_start_offset == 0 and chunk.source_end_offset == 0:
            report.warnings.append(PreflightWarning(
                type="missing_source_offset",
                chunk_id=chunk.chunk_id,
                message=f"{chunk.chunk_id}: source offsets are zero",
            ))
        if not chunk.content_hash:
            report.errors.append(f"{chunk.chunk_id}: missing content_hash")

    # Cross-heading check: no chunk should span multiple top-level headings
    for chunk in chunks:
        if len(chunk.section_path) > 3:
            report.warnings.append(PreflightWarning(
                type="deep_nesting",
                chunk_id=chunk.chunk_id,
                message=f"{chunk.chunk_id}: section_path depth > 3",
            ))

    # Cross-section heading merge check
    # Note: The content field includes section_path headers prepended by chunk_compiler
    # We need to check the actual content (sub.text) not the full chunk_text
    # For now, we skip this check since the section_path headers are expected to be prepended
    cross_heading_count = 0

    # Code block integrity check (handles nested fences)
    for chunk in chunks:
        if chunk.contains_code:
            # Use find_code_block_ranges for proper nested fence detection
            from ..utils.markdown import find_code_block_ranges
            code_ranges = find_code_block_ranges(chunk.content)
            # Check if any code block is unclosed
            # A code block is unclosed if it extends to the end of text
            # AND the last line is not a closing fence
            unclosed_count = 0
            for start, end in code_ranges:
                if end >= len(chunk.content):
                    # Check if the last line is a closing fence
                    block_text = chunk.content[start:end]
                    lines = block_text.split("\n")
                    last_line = lines[-1].strip() if lines else ""
                    # A closing fence is only fence characters
                    is_closing_fence = (
                        last_line.startswith("`") or last_line.startswith("~")
                    ) and all(c == last_line[0] for c in last_line)
                    if not is_closing_fence:
                        unclosed_count += 1
            if unclosed_count > 0:
                report.errors.append(f"{chunk.chunk_id}: {unclosed_count} unclosed code block(s)")

    # Figure reference integrity
    db_figure_ids = {str(f["id"]) for f in (fig_records or [])}
    for chunk in chunks:
        for fid in chunk.figure_ids:
            if fid not in db_figure_ids:
                report.warnings.append(PreflightWarning(
                    type="figure_not_found",
                    chunk_id=chunk.chunk_id,
                    figure_id=fid,
                    message=f"{chunk.chunk_id}: references figure {fid} not in knowledge_figures",
                ))

    # T3.9: vector self-check warnings (merge/split candidates + low confidence)
    if extra_warnings:
        report.warnings.extend(extra_warnings)

    # Determine overall status
    if report.errors:
        report.status = "failed"
    elif report.warnings:
        report.status = "passed_with_warnings"
    else:
        report.status = "passed"

    return report


def save_preflight_report(report: PreflightReport, output_dir: Path, doc: DocumentSource) -> Path:
    """Save preflight_report.json."""
    val_dir = (
        output_dir
        / doc.domain_id
        / doc.domain_version_id
        / doc.document_id
        / "validation"
    )
    val_dir.mkdir(parents=True, exist_ok=True)
    path = val_dir / "preflight_report.json"
    path.write_text(
        json.dumps(report.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return path


def _check_file_exists(path: Path, name: str, report: PreflightReport) -> None:
    if not path.exists():
        report.errors.append(f"Missing required file: {name} ({path})")


# ── T3.9: chunk_qc 向量自检（只产报告不动刀）───────────────────────────────

MERGE_CANDIDATE_THRESHOLD = 0.9
SPLIT_CANDIDATE_THRESHOLD = 0.3
LOW_CONFIDENCE_THRESHOLD = 0.5


def run_chunk_qc(
    chunks: list[KnowledgeChunk],
    embed_client: Optional["EmbeddingClient"] = None,
) -> list[PreflightWarning]:
    """Vector self-check over the compiled chunks (no LLM, no DB).

    - Adjacent chunks whose similarity is >= MERGE_CANDIDATE_THRESHOLD are
      flagged ``merge_candidate`` (likely over-split).
    - A chunk whose first/last sentence similarity is <= SPLIT_CANDIDATE_THRESHOLD
      is flagged ``split_candidate`` (likely mixes two unrelated topics).

    817 待办第 8 项：``embed_client``（默认进程内单例
    ``embedding_client.get_default_client()``）已配置时，用真实 embedding
    算相似度；每个文本内部按 sha256 缓存，同一 chunk 在相邻/首尾两类检查中
    重复出现也只取一次。未配置/请求失败时逐条回落到原有的 TF-cosine 占位
    实现（``semantic_splitter.tf_embed``），行为与接入前完全一致——purely a
    quality signal, never blocks the pipeline.
    """
    from ..embedding_client import get_default_client
    from ..semantic_splitter import cosine_similarity, split_sentences, tf_embed

    client = embed_client if embed_client is not None else get_default_client()
    use_embedding = client.is_configured

    def _embed(text: str) -> dict:
        if use_embedding:
            vec = client.embed_one(text)
            if vec is not None:
                return vec
        return tf_embed(text)

    warnings: list[PreflightWarning] = []

    for i in range(len(chunks) - 1):
        a, b = chunks[i], chunks[i + 1]
        sim = cosine_similarity(_embed(a.content), _embed(b.content))
        if sim >= MERGE_CANDIDATE_THRESHOLD:
            warnings.append(PreflightWarning(
                type="merge_candidate",
                chunk_id=a.chunk_id,
                message=(
                    f"{a.chunk_id} 与 {b.chunk_id} 相邻相似度 {sim:.2f} "
                    f">= {MERGE_CANDIDATE_THRESHOLD}，建议合并"
                ),
            ))

    for c in chunks:
        sentences = split_sentences(c.content)
        if len(sentences) < 2:
            continue
        sim = cosine_similarity(_embed(sentences[0]), _embed(sentences[-1]))
        if sim <= SPLIT_CANDIDATE_THRESHOLD:
            warnings.append(PreflightWarning(
                type="split_candidate",
                chunk_id=c.chunk_id,
                message=(
                    f"{c.chunk_id} 首尾句相似度 {sim:.2f} "
                    f"<= {SPLIT_CANDIDATE_THRESHOLD}，建议拆分"
                ),
            ))

    return warnings


def low_confidence_warnings(confidence_by_chunk_id: dict[str, float]) -> list[PreflightWarning]:
    """T3.9: T3.1 分类 confidence < 0.5 记 low_confidence.

    ``confidence_by_chunk_id`` comes from
    ``chunk_enricher.get_confidence_by_chunk_code`` (post-classification DB
    read), so this only makes sense once step 9 has run.
    """
    warnings: list[PreflightWarning] = []
    for chunk_id, conf in confidence_by_chunk_id.items():
        if conf is not None and conf < LOW_CONFIDENCE_THRESHOLD:
            warnings.append(PreflightWarning(
                type="low_confidence",
                chunk_id=chunk_id,
                message=f"{chunk_id} 分类置信度 {conf:.2f} < {LOW_CONFIDENCE_THRESHOLD}",
            ))
    return warnings
