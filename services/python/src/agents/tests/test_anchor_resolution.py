"""Tests for stream-time anchor resolution (cited-text 1:1 from source)."""
from app.services.enhanced_chat_agent import (
    _drain_anchor_stream,
    _resolve_anchors_in_text,
    _slice_by_offset,
    _find_first_incomplete_anchor,
)


SRC1 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"  # 36 chars
SRC2 = "你好世界，这是一个测试。包含若干字符用于切片验证。"


def test_slice_by_offset_basic():
    assert _slice_by_offset(SRC1, 0, 5) == "ABCDE"
    assert _slice_by_offset(SRC1, 10, 20) == "KLMNOPQRST"
    # 越界 clamp
    assert _slice_by_offset(SRC1, 0, 999) == SRC1
    assert _slice_by_offset(SRC1, -5, 5) == "ABCDE"


def test_slice_by_offset_auto_closes_unmatched_code_block():
    """切片以 ``` 开头但缺闭合围栏 → 自动补齐（避免 marked 渲染错误）。"""
    src = "前言\n```python\ndef foo():\n    pass"
    # 切到原文 "```python\ndef foo():\n    pass"（缺闭合）
    snippet = _slice_by_offset(src, src.index("```python"), len(src))
    assert snippet.startswith("```python")
    assert snippet.endswith("```")  # 自动补齐闭合
    # 但不该重复追加原本就在的闭合
    src2 = "前言\n```python\ndef foo():\n    pass\n```\n后文"
    s = _slice_by_offset(src2, src2.index("```python"), len(src2))
    # 应该恰好有一对闭合
    assert s.count("```") == 2


def test_slice_by_offset_passes_through_inline_code():
    """行内 `code` 不应触发代码块补齐逻辑（不是以 ``` 开头）。"""
    src = "使用 `tavily.search()` 调用"
    s = _slice_by_offset(src, 0, len(src))
    assert s == src
    assert not s.endswith("```")


def test_find_first_incomplete_anchor_returns_minus_one_when_all_closed():
    buf = "前文 [[ANCHOR:1,0,5]] 后文"
    assert _find_first_incomplete_anchor(buf) == -1


def test_find_first_incomplete_anchor_truncated_at_prefix():
    # 截断到 "[[ANCH"（< len('[[ANCHOR:')）
    buf = "前文 [[ANCH"
    assert _find_first_incomplete_anchor(buf) == 3  # "[[ANCH" 的起始位置


def test_find_first_incomplete_anchor_truncated_in_middle():
    buf = "前文 [[ANCHOR:1,0,"
    assert _find_first_incomplete_anchor(buf) == 3


def test_find_first_incomplete_anchor_with_prior_closed_anchors():
    """已闭合锚点之后又有未闭合锚点 → 返回未闭合那一个的起始位置。"""
    buf = "前 [[ANCHOR:1,0,5]] 中 [[ANCHOR:2,0,"
    idx = _find_first_incomplete_anchor(buf)
    assert idx > 0 and buf[idx:].startswith("[[ANCHOR:2")


def test_drain_anchor_stream_cross_chunk_at_prefix():
    """修复前 bug：rfind('[[ANCHOR:') 在 [[ANCH 时找不到 → 当成普通文本输出。
    修复后正确地把 [[ANCH 之后留作 pending。"""
    sources = {1: {"content": SRC1}}
    out, pending = _drain_anchor_stream("前文 [[ANCH", sources)
    assert out == "前文 "  # "[[ANCH" 之前全输出
    assert pending == "[[ANCH"
    # 下一 chunk 拼接后
    out2, pending2 = _drain_anchor_stream("前文 [[ANCHOR:1,0,5]] 后文", sources)
    assert out2 == "前文 ABCDE [^1^] 后文"
    assert pending2 == ""


def test_drain_anchor_stream_keeps_prior_closed_anchors_intact():
    """修复前 bug：rfind 选未闭合锚点位置时，已闭合锚点被丢到 pending 一起留滞。
    修复后已闭合锚点全部解析、未闭合那一个之后留 pending。"""
    sources = {1: {"content": SRC1}, 2: {"content": SRC1}}
    out, pending = _drain_anchor_stream(
        "前 [[ANCHOR:1,0,3]] 中 [[ANCHOR:2,0,",  # 第二个未闭合
        sources,
    )
    # 第一个已闭合 → 应替换；第二个未闭合 → 留 pending
    assert "ABC [^1^]" in out
    assert "中 " in out
    assert pending == "[[ANCHOR:2,0,"


def test_drain_anchor_stream_replaces_complete_anchors():
    sources = {1: {"content": SRC1}}
    # 整段可识别
    out, pending = _drain_anchor_stream("前文 [[ANCHOR:1,0,5]] 后文", sources)
    # 锚点替换为原文后，会自动追加 [^N^] 引用标记
    assert out == "前文 ABCDE [^1^] 后文"
    assert pending == ""


def test_drain_anchor_stream_holds_partial_at_end():
    sources = {1: {"content": SRC1}}
    # 末尾是未闭合的 [[ANCHOR:1,0,5 → 不输出，留在 pending
    out, pending = _drain_anchor_stream("前文 [[ANCHOR:1,0,", sources)
    assert out == "前文 "
    assert pending == "[[ANCHOR:1,0,"


def test_drain_anchor_stream_multiple_anchors_one_pass():
    sources = {1: {"content": SRC1}}
    out, pending = _drain_anchor_stream(
        "a [[ANCHOR:1,0,3]] b [[ANCHOR:1,5,8]] c", sources
    )
    # 每个锚点都带自己的 [^1^] 标记
    assert out == "a ABC [^1^] b FGH [^1^] c"
    assert pending == ""


def test_drain_anchor_stream_invalid_sid_drops_to_empty():
    sources = {1: {"content": SRC1}}
    out, pending = _drain_anchor_stream("前 [[ANCHOR:99,0,5]] 后", sources)
    # 锚点找不到 sid → 替换为空串，不追加引用
    assert out == "前  后"
    assert pending == ""


def test_drain_anchor_stream_invalid_offset_drops_to_empty():
    sources = {1: {"content": SRC1}}
    out, pending = _drain_anchor_stream("前 [[ANCHOR:1,100,200]] 后", sources)
    # 越界 → 空串，不追加引用
    assert out == "前  后"


def test_drain_anchor_stream_no_anchor_passes_through():
    sources = {1: {"content": SRC1}}
    out, pending = _drain_anchor_stream("纯文本，没有任何锚点", sources)
    assert out == "纯文本，没有任何锚点"
    assert pending == ""


def test_resolve_anchors_in_text_full_postprocess():
    sources = {
        1: {"content": SRC1},
        2: {"content": SRC2},
    }
    raw = (
        f"AgentScope 中 [[ANCHOR:1,0,10]]，"
        f"另外 [[ANCHOR:2,0,4]] 是中文切片。"
    )
    text, used = _resolve_anchors_in_text(raw, sources)
    assert "ABCDEFGHIJ" in text
    assert "你好世界" in text
    assert set(used.keys()) == {1, 2}
    # 引用标记自动追加
    assert "[^1^]" in text
    assert "[^2^]" in text


def test_resolve_anchors_collects_used_sources():
    sources = {1: {"content": "ABCDEFGH"}}
    raw = "开头 [[ANCHOR:1,2,5]] 结尾"
    text, used = _resolve_anchors_in_text(raw, sources)
    assert "CDE" in text
    assert 1 in used
    # 来源内容必须 1:1 出现在 text 里（不是模糊包含）
    assert "CDE" in text and "DEF" not in text  # 严格 2:5 = CDE
    assert "[^1^]" in text


def test_resolve_anchors_mixed_anchor_and_passage():
    """LLM 真实场景：原文片段 + 顺接词交替。"""
    src = "RAGFlow 提供向量检索与关键词检索双路召回。混合排序提升 top-5 准确率 12%。"
    sources = {1: {"content": src}}
    raw = (
        "首先，"
        "[[ANCHOR:1,0,20]]"
        "其次，"
        "[[ANCHOR:1,28,46]]"
        "以上两点是核心机制。"
    )
    text, used = _resolve_anchors_in_text(raw, sources)
    assert src[0:20] in text  # "RAGFlow 提供向量检索与关键词检索"
    assert src[28:46] in text  # "双路召回。混合排序提升 top-5 准确率 12%。"
    # 锚点间的衔接词保留
    assert "首先，" in text
    assert "其次，" in text
    assert "以上两点是核心机制。" in text
    assert 1 in used
    # 引用标记自动追加
    assert text.count("[^1^]") == 2