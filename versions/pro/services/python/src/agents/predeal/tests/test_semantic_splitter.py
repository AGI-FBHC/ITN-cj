"""semantic_splitter 工具库测试（单元化 / 切分校验 / JSON 解析）.

LLM 调用已合并进 figure_chunk_binder 的统一切片评审（见 test_figure_binder.py）。
"""

from __future__ import annotations

import pytest

from predeal.config import ChunkPolicy
from predeal.semantic_splitter import (
    SPLIT_PATH_COUNTS,
    _embedding_breakpoints,
    apply_split_offsets,
    cosine_similarity,
    parse_json_response,
    resolve_split,
    split_into_units,
    split_sentences,
    tf_embed,
    try_embedding_split,
    unit_preview,
)
from predeal.utils.markdown import find_code_block_ranges, is_in_code_block

POLICY = ChunkPolicy(
    target_min_chars=300,
    target_max_chars=1200,
    hard_max_chars=1800,
)


# ── 单元化 ────────────────────────────────────────────────────────────────


def test_split_into_units_paragraphs_and_code():
    text = (
        "第一段内容。\n\n第二段内容。\n\n"
        "```python\ncode_line1\ncode_line2\n```\n\n第三段内容。"
    )
    code_ranges = find_code_block_ranges(text)
    units = split_into_units(text, code_ranges)
    # 3 个普通段 + 1 个代码块
    assert len(units) == 4
    assert units[2]["is_code"] is True
    assert "code_line1" in units[2]["text"]
    # 偏移连续且不重叠
    assert units[0]["start"] == 0
    for prev, cur in zip(units, units[1:]):
        assert prev["end"] <= cur["start"]
    assert units[-1]["end"] == len(text)


def test_split_into_units_long_paragraph_by_sentence():
    text = "句子一。句子二！句子三？" * 40  # 480 字，超 UNIT_MAX_CHARS
    units = split_into_units(text, [])
    assert len(units) > 1
    assert all(u["text"] for u in units)


def test_unit_preview_flags_code():
    unit = {"start": 0, "end": 5, "text": "abcde", "is_code": True}
    assert "[code]" in unit_preview(unit, 0)


# ── 切分校验 ──────────────────────────────────────────────────────────────


def test_apply_split_offsets_merges_too_small():
    """过近切点（< MIN_VALID_CHUNK）被丢弃，避免碎片."""
    text = "A" * 1500
    code_ranges = find_code_block_ranges(text)
    # 在第 100 字处切 → 前片 100 字 < MIN_VALID_CHUNK(200) → 切点被丢弃 → None
    splits = apply_split_offsets(text, [100], code_ranges, POLICY)
    assert splits is None
    # 250 字处切 → 前片 250 >= 200，合法
    splits = apply_split_offsets(text, [250], code_ranges, POLICY)
    assert splits is not None
    assert splits == [(0, 250, "semantic_split"), (250, 1500, "semantic_split")]


def test_apply_split_offsets_ignores_code_block_splits():
    """切点在代码块内 → 被忽略."""
    text = "前言。\n\n```python\ncode\n```\n\n后记。" * 3
    code_ranges = find_code_block_ranges(text)
    assert code_ranges, "text 应含代码块"
    inside = code_ranges[0][0] + 5
    splits = apply_split_offsets(text, [inside, len(text) - 10], code_ranges, POLICY)
    assert splits is None or all(
        not is_in_code_block(s, code_ranges) and not is_in_code_block(e, code_ranges)
        for s, e, _ in splits
    )


def test_apply_split_offsets_oversize_resplit():
    """LLM 建议导致的超长片 → 安全点再切（每片 ≤ hard_max）."""
    text = ("段落一。" * 400) + "\n\n" + ("段落二。" * 400)
    code_ranges = find_code_block_ranges(text)
    mid = len(text) // 2
    splits = apply_split_offsets(text, [mid], code_ranges, POLICY)
    assert splits is not None
    for s, e, _ in splits:
        assert e - s <= POLICY.hard_max_chars + 50


def test_apply_split_offsets_middle_fragment_merged():
    """中间碎片（< MIN_VALID_CHUNK）并入前一片."""
    text = "A" * 900 + "B" * 150 + "C" * 900  # 中间片 150 字 < 200
    code_ranges = find_code_block_ranges(text)
    splits = apply_split_offsets(text, [900, 1050], code_ranges, POLICY)
    assert splits is not None
    # 150 字碎片被并入前片 → 2 片
    assert len(splits) == 2
    assert splits[0] == (0, 1050, "semantic_split")
    assert splits[1] == (1050, 1950, "semantic_split")


def test_apply_split_offsets_empty_returns_none():
    assert apply_split_offsets("A" * 1000, [], [], POLICY) is None


# ── JSON 宽松解析 ─────────────────────────────────────────────────────────


def test_parse_json_response_variants():
    assert parse_json_response('{"split_after": [1]}') == {"split_after": [1]}
    assert parse_json_response('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json_response('以下是结果：{"a": 1} 完') == {"a": 1}
    assert parse_json_response("不是JSON") is None
    assert parse_json_response("") is None


# ── T3.7: embedding 断点检测 ──────────────────────────────────────────────

TOPIC_A_SENTENCE = "苹果的种植需要良好的光照与排水条件。"
TOPIC_B_SENTENCE = "分布式系统的一致性协议需要处理网络分区问题。"


def test_tf_embed_identical_text_has_similarity_one():
    v = tf_embed("测试文本内容用于验证词频向量")
    assert cosine_similarity(v, v) == pytest.approx(1.0)


def test_cosine_similarity_empty_vector_is_zero():
    assert cosine_similarity({}, {"a": 1.0}) == 0.0
    assert cosine_similarity({}, {}) == 0.0


def test_split_sentences_basic():
    assert split_sentences("第一句。第二句！第三句？") == ["第一句。", "第二句！", "第三句？"]


def test_embedding_breakpoints_needs_at_least_three_sentences():
    assert _embedding_breakpoints("只有一句话。") == []
    assert _embedding_breakpoints("第一句。第二句。") == []


def test_resolve_split_uses_embedding_path_for_clear_topic_breakpoint():
    """有明显主题断点的长文：embedding 路径直接命中，LLM 兜底完全不被调用。"""
    text = (TOPIC_A_SENTENCE * 15) + (TOPIC_B_SENTENCE * 15)
    llm_calls: list[str] = []

    def llm_fallback(t: str):
        llm_calls.append(t)
        return None

    before_embedding = SPLIT_PATH_COUNTS.get("embedding", 0)
    result = resolve_split(text, POLICY, llm_fallback=llm_fallback)

    assert llm_calls == [], "embedding path should skip the LLM fallback entirely"
    assert result is not None
    assert len(result) == 2
    total_len = sum(e - s for s, e, _ in result)
    assert total_len == len(text)
    assert SPLIT_PATH_COUNTS["embedding"] == before_embedding + 1


def test_resolve_split_falls_back_to_llm_without_clear_breakpoint():
    """无法形成合法 embedding 断点（句子太少）时回落 LLM 路径。"""
    text = "内容较短，不足以形成明显的语义断点候选。"
    llm_calls: list[str] = []

    def llm_fallback(t: str):
        llm_calls.append(t)
        return [(0, len(t), "llm_split")]

    result = resolve_split(text, POLICY, llm_fallback=llm_fallback)
    assert llm_calls == [text]
    assert result == [(0, len(text), "llm_split")]


def test_resolve_split_without_fallback_returns_none():
    text = "内容较短，不足以形成明显的语义断点候选。"
    assert resolve_split(text, POLICY) is None


def test_try_embedding_split_rejects_oversized_pieces():
    """断点存在但切出的片超过 hard_max_chars 时不采用（回落 LLM）。"""
    tiny_policy = ChunkPolicy(target_min_chars=10, target_max_chars=20, hard_max_chars=30)
    text = (TOPIC_A_SENTENCE * 15) + (TOPIC_B_SENTENCE * 15)
    assert try_embedding_split(text, tiny_policy) is None
