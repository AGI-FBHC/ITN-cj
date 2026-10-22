"""T3.9 chunk_qc 向量自检 — 只产报告不动刀."""

from __future__ import annotations

from predeal.models import DocumentSource, KnowledgeChunk
from predeal.steps.preflight import (
    low_confidence_warnings,
    run_chunk_qc,
    run_preflight,
)


def _chunk(chunk_id: str, content: str, order: int = 1) -> KnowledgeChunk:
    return KnowledgeChunk(
        chunk_id=chunk_id,
        document_id="doc_000001",
        domain_id="d",
        domain_version_id="v1",
        source_file_hash="h",
        section_path=["Sec"],
        heading="Sec",
        content=content,
        content_hash=f"hash:{chunk_id}",
        chunk_order=order,
        source_start_offset=0,
        source_end_offset=len(content),
        normalized_start_offset=0,
        normalized_end_offset=len(content),
        char_count=len(content),
        approx_token_count=len(content) // 2,
    )


def test_merge_candidate_flagged_for_near_identical_adjacent_chunks():
    text = "这是一段关于智能体框架设计原则与工程实践的说明文字。" * 5
    chunks = [_chunk("chunk_000001", text, 1), _chunk("chunk_000002", text, 2)]
    warnings = run_chunk_qc(chunks)
    assert any(w.type == "merge_candidate" for w in warnings)


def test_no_merge_candidate_for_dissimilar_adjacent_chunks():
    a = _chunk("chunk_000001", "今天天气晴朗适合户外运动和郊游活动安排出行计划。", 1)
    b = _chunk("chunk_000002", "量子计算利用叠加态实现并行计算能力显著提升效率。", 2)
    warnings = run_chunk_qc([a, b])
    assert all(w.type != "merge_candidate" for w in warnings)


def test_split_candidate_flagged_for_mixed_topic_chunk():
    a = "苹果种植需要良好的光照与排水条件保证产量。" * 6
    b = "分布式系统一致性协议需要处理网络分区问题挑战。" * 6
    chunk = _chunk("chunk_000001", a + b, 1)
    warnings = run_chunk_qc([chunk])
    assert any(w.type == "split_candidate" for w in warnings)


def test_split_candidate_not_flagged_for_single_topic_chunk():
    text = "这是一段主题连贯的说明文字。" * 8
    chunk = _chunk("chunk_000001", text, 1)
    warnings = run_chunk_qc([chunk])
    assert all(w.type != "split_candidate" for w in warnings)


def test_run_chunk_qc_empty_and_single_chunk_no_crash():
    assert run_chunk_qc([]) == []
    assert run_chunk_qc([_chunk("chunk_000001", "短内容", 1)]) == []


def test_low_confidence_warnings_threshold():
    warnings = low_confidence_warnings({"chunk_000001": 0.3, "chunk_000002": 0.9})
    assert len(warnings) == 1
    assert warnings[0].type == "low_confidence"
    assert warnings[0].chunk_id == "chunk_000001"


def test_low_confidence_warnings_ignores_none_and_empty():
    assert low_confidence_warnings({}) == []
    assert low_confidence_warnings({"chunk_000001": None}) == []


def test_preflight_status_not_failed_by_qc_warnings(tmp_path):
    doc = DocumentSource(
        document_id="doc_000001", domain_id="d", domain_version_id="v1",
        source_file_name="f.md", file_hash="h", file_size=1,
        pipeline_profile="markdown_tutorial",
    )
    base = tmp_path / "d" / "v1" / "doc_000001"
    for sub, name in [
        ("raw", "f.md"),
        ("normalized", "normalized.md"),
        ("chunks", "chunked_for_ragflow.md"),
        ("chunks", "chunk_manifest.json"),
    ]:
        p = base / sub
        p.mkdir(parents=True, exist_ok=True)
        (p / name).write_text("x", encoding="utf-8")

    chunk = _chunk("chunk_000001", "内容", 1)
    qc_warnings = low_confidence_warnings({"chunk_000001": 0.1})
    report = run_preflight(doc, [chunk], [], tmp_path, extra_warnings=qc_warnings)

    assert report.status == "passed_with_warnings"
    assert any(w.type == "low_confidence" for w in report.warnings)


def test_preflight_without_extra_warnings_unaffected(tmp_path):
    """extra_warnings=None (默认) 时行为与改造前完全一致."""
    doc = DocumentSource(
        document_id="doc_000001", domain_id="d", domain_version_id="v1",
        source_file_name="f.md", file_hash="h", file_size=1,
        pipeline_profile="markdown_tutorial",
    )
    base = tmp_path / "d" / "v1" / "doc_000001"
    for sub, name in [
        ("raw", "f.md"),
        ("normalized", "normalized.md"),
        ("chunks", "chunked_for_ragflow.md"),
        ("chunks", "chunk_manifest.json"),
    ]:
        p = base / sub
        p.mkdir(parents=True, exist_ok=True)
        (p / name).write_text("x", encoding="utf-8")

    chunk = _chunk("chunk_000001", "内容", 1)
    report = run_preflight(doc, [chunk], [], tmp_path)
    assert report.status == "passed"
    assert report.warnings == []
