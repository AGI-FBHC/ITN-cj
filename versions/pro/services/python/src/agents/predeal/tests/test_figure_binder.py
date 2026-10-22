"""figure_chunk_binder 窗口级切片质量评审测试.

验证：
1. review_window：窗口内多切片一次调用，输出 merge/split actions
2. _apply_window_actions：规则校验（相邻合并 / 超限拒绝 / 非相邻拒绝 / split 校验）
3. review_and_bind 端到端：窗口评审（合并/再切）→ 图归属
4. 无 semantic_split → 零调用；LLM 失败兜底；图缓存命中复用
"""

from __future__ import annotations

import json

import pytest

from predeal.config import ChunkPolicy
from predeal.figure_chunk_binder import (
    _apply_window_actions,
    _embedding_presplit,
    review_and_bind,
    review_window,
)
from predeal.semantic_splitter import SPLIT_PATH_COUNTS

POLICY = ChunkPolicy(
    target_min_chars=300, target_max_chars=1200, hard_max_chars=1800,
    semantic_split=True,
)


class FakeLLM:
    """可编程 LLM mock：记录调用，按 prompt 子串返回窗口 actions."""

    def __init__(self):
        self.calls: list[str] = []
        self.window_responses: list[dict] = []  # 按调用顺序返回

    def _respond(self, prompt: str) -> dict:
        self.calls.append(prompt)
        if self.window_responses:
            return self.window_responses.pop(0)
        return {"actions": [], "reasoning": "test"}

    def __call__(self, url, headers, body, timeout=None, proxy=None):
        prompt = body["messages"][0]["content"]
        resp = self._respond(prompt)

        class FakeResponse:
            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "choices": [{"message": {"content": json.dumps(resp, ensure_ascii=False)}}]
                }

        return FakeResponse()


def _patch_client(monkeypatch, fake: FakeLLM):
    import httpx

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, headers=None, json=None, **kw):
            return fake(url, headers, json, **kw)

    monkeypatch.setattr(httpx, "Client", FakeClient)


def _mk(content: str, cid: str = "") -> dict:
    return {"chunk_id": cid or f"chunk_{abs(hash(content)) % 10000:05d}", "title_path": "T", "content": content}


# ── review_window：窗口级调用 ─────────────────────────────────────────────


def test_review_window_returns_actions(monkeypatch):
    fake = FakeLLM()
    fake.window_responses = [{
        "actions": [{"type": "merge", "indices": [0, 1]}],
        "reasoning": "前两片过短应合并",
    }]
    _patch_client(monkeypatch, fake)
    win = [_mk("短切片内容A" * 10), _mk("短切片内容B" * 10), _mk("正常切片内容" * 40)]
    result = review_window(win)
    assert result["actions"][0]["type"] == "merge"
    assert len(fake.calls) == 1
    # prompt 包含全部切片 + 单元列表
    assert "[0]" in fake.calls[0] and "[2]" in fake.calls[0]
    assert "单元:" in fake.calls[0]
    assert "merge 只允许相邻" in fake.calls[0]


# ── _apply_window_actions：规则校验 ───────────────────────────────────────


def test_apply_merge_adjacent():
    win = [_mk("短片甲" * 20), _mk("短片乙" * 20), _mk("正常片" * 50)]
    new = _apply_window_actions(win, [{"type": "merge", "indices": [0, 1]}], POLICY)
    assert len(new) == 2
    assert "短片甲" in new[0]["content"] and "短片乙" in new[0]["content"]
    assert new[0].get("merge_reason") == "window_merge"


def test_apply_merge_non_adjacent_rejected():
    win = [_mk("短片甲" * 20), _mk("中片" * 50), _mk("短片乙" * 20)]
    new = _apply_window_actions(win, [{"type": "merge", "indices": [0, 2]}], POLICY)
    assert new == win  # 非相邻 → 拒绝


def test_apply_merge_oversize_rejected():
    win = [_mk("很长内容" * 100), _mk("很长内容" * 100)]  # 各 400 字，合计 800 < 1800
    win = [_mk("很长内容" * 300), _mk("很长内容" * 300)]  # 各 1200，合计 2400 > 1800
    new = _apply_window_actions(win, [{"type": "merge", "indices": [0, 1]}], POLICY)
    assert new == win  # 超限 → 拒绝


def test_apply_split():
    win = [_mk("主题A的连续叙述内容" * 80 + "\n\n" + "主题B的连续叙述内容" * 80), _mk("后续" * 30)]
    new = _apply_window_actions(
        win, [{"type": "split", "index": 0, "split_after": [0]}], POLICY
    )
    assert len(new) == 3
    assert "主题A" in new[0]["content"] and "主题B" in new[1]["content"]


def test_apply_split_and_merge_conflict_split_dropped():
    win = [_mk("短片甲" * 20), _mk("长内容A" * 80 + "\n\n" + "长内容B" * 80)]
    # merge 0+1 与 split 1 冲突 → split 丢弃，merge 生效
    new = _apply_window_actions(
        win,
        [{"type": "merge", "indices": [0, 1]}, {"type": "split", "index": 1, "split_after": [0]}],
        POLICY,
    )
    assert len(new) == 1  # 仅 merge


# ── review_and_bind：端到端 ──────────────────────────────────────────────


def test_review_and_bind_window_merge(monkeypatch):
    fake = FakeLLM()
    fake.window_responses = [{
        "actions": [{"type": "merge", "indices": [0, 1]}],
        "reasoning": "合并",
    }]
    _patch_client(monkeypatch, fake)
    chunks = [_mk("短片甲" * 20), _mk("短片乙" * 20), _mk("正常片" * 50)]
    reviewed = review_and_bind(chunks, [], "x", POLICY)
    assert len(reviewed) == 2
    assert len(fake.calls) == 1


def test_review_and_bind_no_semantic_zero_calls(monkeypatch):
    fake = FakeLLM()
    _patch_client(monkeypatch, fake)
    policy_off = ChunkPolicy(semantic_split=False)
    chunks = [_mk("内容" * 50) for _ in range(3)]
    reviewed = review_and_bind(chunks, [], "x", policy_off)
    assert len(reviewed) == 3
    assert fake.calls == []


def test_review_and_bind_llm_failure_fallback(monkeypatch):
    import httpx

    class BrokenClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, url, headers=None, json=None, **kw):
            raise RuntimeError("llm down")

    monkeypatch.setattr(httpx, "Client", BrokenClient)
    chunks = [_mk("短片甲" * 20), _mk("短片乙" * 20), _mk("正常片" * 50)]
    reviewed = review_and_bind(chunks, [], "x", POLICY)
    assert len(reviewed) == 3  # 兜底：原样返回


def test_review_and_bind_figure_binding_after_review(monkeypatch):
    """窗口评审后图归属仍执行（含图切片单切片上下文 + 缓存）. """
    fake = FakeLLM()
    # 窗口评审：无调整
    fake.window_responses = [{"actions": [], "reasoning": "ok"}]
    _patch_client(monkeypatch, fake)
    chunks = [
        _mk("前切片内容" * 30),
        _mk("当前切片内容" * 30 + '\n\n<img src="http://x/1.png" data-figure-id="42">'),
        _mk("后切片内容" * 30),
    ]
    figures = [{
        "id": 42, "occurrence_no": 1, "caption": "图 1", "alt_text": "",
        "vlm_description": "测试图", "source_url": "http://x/1.png",
        "bound_chunk_ids": "", "bound_context_hash": "",
    }]
    reviewed = review_and_bind(chunks, figures, chunks[1]["content"], POLICY)
    # 窗口评审 1 次 + 图归属 1 次（review_slice）
    assert len(fake.calls) == 2
    # 图仍保留在切片中
    assert any("data-figure-id" in c["content"] for c in reviewed)


def test_review_and_bind_figure_cache_hit(monkeypatch):
    """图缓存命中 → 图归属不调 LLM（窗口评审照常）. """
    fake = FakeLLM()
    fake.window_responses = [{"actions": [], "reasoning": "ok"}]
    _patch_client(monkeypatch, fake)
    chunks = [
        _mk("前切片内容" * 30),
        _mk("当前切片内容" * 30 + '\n\n<img src="http://x/1.png" data-figure-id="42">'),
        _mk("后切片内容" * 30),
    ]
    # 缓存预填：bound_chunk_ids=[1] + 正确的上下文 hash
    from predeal.utils.hash import content_hash

    parts = [chunks[0]["content"], chunks[1]["content"], chunks[2]["content"]]
    ctx_hash = content_hash("\n||\n".join(parts))
    figures = [{
        "id": 42, "occurrence_no": 1, "caption": "图 1", "alt_text": "",
        "vlm_description": "测试图", "source_url": "http://x/1.png",
        "bound_chunk_ids": "[1]", "bound_context_hash": ctx_hash,
    }]
    reviewed = review_and_bind(chunks, figures, chunks[1]["content"], POLICY)
    assert len(fake.calls) == 1  # 仅窗口评审，图归属命中缓存
    assert any("data-figure-id" in c["content"] for c in reviewed)


# ── T3.7 接线：窗口 LLM 评审前的 embedding 断点前置 ────────────────────────

_TOPIC_A = "苹果的种植需要良好的光照与排水条件。"
_TOPIC_B = "分布式系统的一致性协议需要处理网络分区问题。"


def test_embedding_presplit_splits_long_chunk_with_clear_breakpoint():
    """超过 target_max_chars 且有明显主题断点的切片：直接切分，零 LLM 调用."""
    long_content = (_TOPIC_A * 40) + (_TOPIC_B * 40)  # ~1440 字，在 target_max~hard_max 区间
    win = [_mk(long_content, cid="chunk_000001"), _mk("短片" * 10, cid="chunk_000002")]

    before = SPLIT_PATH_COUNTS.get("embedding", 0)
    result = _embedding_presplit(win, POLICY)

    # 长切片被拆成两段（各自 chunk_id 带 #0/#1 后缀），短切片原样保留
    long_pieces = [c for c in result if c["chunk_id"].startswith("chunk_000001")]
    assert len(long_pieces) == 2
    assert long_pieces[0]["chunk_id"] == "chunk_000001#0"
    assert long_pieces[1]["chunk_id"] == "chunk_000001#1"
    assert "苹果" in long_pieces[0]["content"]
    assert "分布式" in long_pieces[1]["content"]
    short = [c for c in result if c["chunk_id"] == "chunk_000002"]
    assert len(short) == 1 and short[0]["content"] == win[1]["content"]
    assert SPLIT_PATH_COUNTS["embedding"] == before + 1


def test_embedding_presplit_leaves_short_chunks_untouched():
    """长度未超过 target_max_chars 的切片：不尝试 embedding 切分，原样返回."""
    win = [_mk("短切片内容" * 10, cid="chunk_a"), _mk("另一短切片" * 10, cid="chunk_b")]
    result = _embedding_presplit(win, POLICY)
    assert result == win


def test_embedding_presplit_falls_back_when_no_clear_breakpoint():
    """超长但无明显断点（同质内容重复）：embedding 路径不采用，原样保留（交给窗口 LLM）."""
    homogeneous = ("这是完全相同的一句内容。" * 150)  # 单一主题反复重复，无断点
    win = [_mk(homogeneous, cid="chunk_x")]
    result = _embedding_presplit(win, POLICY)
    assert len(result) == 1
    assert result[0]["chunk_id"] == "chunk_x"
    assert result[0]["content"] == homogeneous


def test_window_review_skips_llm_split_for_embedding_presplit_chunk(monkeypatch):
    """端到端：窗口内含一个有明显主题断点的超长切片 -> 该切片被 embedding 前置
    直接切开；窗口 LLM 仍会被调用一次（用于判断其余/已切分片是否需要合并），
    但不需要 LLM 给出 split 建议，最终切片数按 embedding 结果落地。"""
    fake = FakeLLM()
    fake.window_responses = [{"actions": [], "reasoning": "no adjustment needed"}]
    _patch_client(monkeypatch, fake)

    long_content = (_TOPIC_A * 40) + (_TOPIC_B * 40)
    # 至少两个切片才会触发窗口评审（review_and_bind 对单切片文档整体跳过窗口
    # 评审，见 review_and_bind 的 len(chunks) > 1 前置条件，与本次接线无关）。
    chunks = [_mk(long_content, cid="chunk_000001"), _mk("后续短片" * 10, cid="chunk_000002")]

    reviewed = review_and_bind(
        chunks, [], "x", POLICY, api_url="http://fake-llm", api_key="fake-key"
    )

    assert len(reviewed) == 3  # 长片切成 2 + 短片 1
    assert "苹果" in reviewed[0]["content"]
    assert "分布式" in reviewed[1]["content"]
    assert reviewed[2]["content"] == chunks[1]["content"]
    # 窗口 LLM 仍被调用（针对已切好的 2 片判断是否需要合并），但 prompt 里
    # 不会再出现要求判断"是否要切"这件事本身导致新的切分——已经切好了。
    assert len(fake.calls) == 1
