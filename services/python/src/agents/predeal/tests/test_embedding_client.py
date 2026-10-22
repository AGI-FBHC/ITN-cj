"""817 待办第 8 项：embedding_client（硅基流动 BAAI/bge-m3）.

覆盖：
1. 未配置 -> embed_batch/embed_one 返回 None -> as_embed_fn() 回落 tf_embed
2. 批量调用 + 按 sha256 缓存（重复文本第二次零网络调用；混合命中只取未命中的）
3. 请求失败/超时 -> None -> 回落 tf_embed（不抛异常）
4. 接线点 a：figure_chunk_binder._embedding_presplit 注入的 embed_fn 生效
5. 接线点 b：chunk_enricher.compute_canonical_map 去重路径（有/无 embedding）

全程 mock httpx.Client，禁止真实网络调用。
"""

from __future__ import annotations

import httpx
import pytest

from predeal.config import ChunkPolicy
from predeal.embedding_client import EmbeddingClient
from predeal.semantic_splitter import tf_embed
from predeal.steps.chunk_enricher import compute_canonical_map


# ── Fake HTTP client (records calls, returns deterministic vectors) ────────


class FakeEmbeddingHTTPClient:
    """Records every POST body; returns one embedding per input string."""

    calls: list[dict] = []

    def __init__(self, *a, **kw):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, url, headers=None, json=None, **kw):
        FakeEmbeddingHTTPClient.calls.append(json)
        inputs = json["input"]
        data = [
            {"index": i, "embedding": [float(len(t)), float(i)]}
            for i, t in enumerate(inputs)
        ]
        return _FakeResponse({"data": data})


class _FakeResponse:
    def __init__(self, data):
        self._data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self._data


class RaisingHTTPClient:
    def __init__(self, *a, **kw):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, *a, **kw):
        raise httpx.TimeoutException("simulated timeout")


# ── 1. 未配置 -> None -> 回落 tf_embed ──────────────────────────────────────


def test_unconfigured_client_is_not_configured():
    client = EmbeddingClient(api_url=None, api_key=None)
    assert client.is_configured is False


def test_unconfigured_embed_batch_returns_none():
    client = EmbeddingClient(api_url=None, api_key=None)
    assert client.embed_batch(["x"]) is None


def test_unconfigured_embed_one_returns_none():
    client = EmbeddingClient(api_url="", api_key="")
    assert client.embed_one("x") is None


def test_unconfigured_as_embed_fn_falls_back_to_tf_embed():
    client = EmbeddingClient(api_url=None, api_key=None)
    fn = client.as_embed_fn()
    assert fn("你好世界") == tf_embed("你好世界")


# ── 2. 批量调用 + sha256 缓存 ────────────────────────────────────────────────


def test_embed_batch_single_request_for_multiple_texts(monkeypatch):
    FakeEmbeddingHTTPClient.calls = []
    monkeypatch.setattr(httpx, "Client", FakeEmbeddingHTTPClient)
    client = EmbeddingClient(api_url="http://fake/embeddings", api_key="k", model="m")

    vectors = client.embed_batch(["hello", "world"])

    assert vectors is not None and len(vectors) == 2
    assert len(FakeEmbeddingHTTPClient.calls) == 1
    body = FakeEmbeddingHTTPClient.calls[0]
    assert body["input"] == ["hello", "world"]
    assert body["model"] == "m"
    assert body["encoding_format"] == "float"


def test_embed_batch_cache_hit_zero_network_calls(monkeypatch):
    FakeEmbeddingHTTPClient.calls = []
    monkeypatch.setattr(httpx, "Client", FakeEmbeddingHTTPClient)
    client = EmbeddingClient(api_url="http://fake/embeddings", api_key="k")

    first = client.embed_batch(["hello", "world"])
    assert len(FakeEmbeddingHTTPClient.calls) == 1

    second = client.embed_batch(["hello", "world"])
    assert second == first
    assert len(FakeEmbeddingHTTPClient.calls) == 1  # no new HTTP call


def test_embed_batch_partial_cache_only_fetches_misses(monkeypatch):
    FakeEmbeddingHTTPClient.calls = []
    monkeypatch.setattr(httpx, "Client", FakeEmbeddingHTTPClient)
    client = EmbeddingClient(api_url="http://fake/embeddings", api_key="k")

    client.embed_batch(["hello", "world"])
    assert len(FakeEmbeddingHTTPClient.calls) == 1

    client.embed_batch(["hello", "new-text"])
    assert len(FakeEmbeddingHTTPClient.calls) == 2
    assert FakeEmbeddingHTTPClient.calls[1]["input"] == ["new-text"]


def test_embed_one_uses_same_cache_as_embed_batch(monkeypatch):
    FakeEmbeddingHTTPClient.calls = []
    monkeypatch.setattr(httpx, "Client", FakeEmbeddingHTTPClient)
    client = EmbeddingClient(api_url="http://fake/embeddings", api_key="k")

    v1 = client.embed_one("hello")
    v2 = client.embed_one("hello")
    assert v1 == v2
    assert len(FakeEmbeddingHTTPClient.calls) == 1


# ── 3. 请求失败/超时 -> None -> 回落 tf_embed ────────────────────────────────


def test_embed_batch_returns_none_on_request_failure(monkeypatch):
    monkeypatch.setattr(httpx, "Client", RaisingHTTPClient)
    client = EmbeddingClient(api_url="http://fake/embeddings", api_key="k")
    assert client.embed_batch(["x"]) is None


def test_as_embed_fn_falls_back_on_request_failure(monkeypatch):
    monkeypatch.setattr(httpx, "Client", RaisingHTTPClient)
    client = EmbeddingClient(api_url="http://fake/embeddings", api_key="k")
    fn = client.as_embed_fn()
    assert fn("你好") == tf_embed("你好")


def test_embed_batch_returns_none_on_malformed_response(monkeypatch):
    class BadClient(FakeEmbeddingHTTPClient):
        def post(self, url, headers=None, json=None, **kw):
            return _FakeResponse({"data": [{"embedding": [1.0]}]})  # only 1 for 2 inputs

    monkeypatch.setattr(httpx, "Client", BadClient)
    client = EmbeddingClient(api_url="http://fake/embeddings", api_key="k")
    assert client.embed_batch(["a", "b"]) is None


# ── 4. 接线点 a：figure_chunk_binder._embedding_presplit 注入 embed_fn ───────


def test_embedding_presplit_injects_embed_fn(monkeypatch):
    from predeal import figure_chunk_binder as fcb

    marker_calls: list[str] = []

    def fake_as_embed_fn():
        def fn(text: str) -> dict:
            marker_calls.append(text)
            return {}
        return fn

    monkeypatch.setattr(fcb, "as_embed_fn", fake_as_embed_fn)

    policy = ChunkPolicy(target_min_chars=10, target_max_chars=20, hard_max_chars=500)
    long_content = (
        "这是第一句话说明主题甲。第二句继续说明主题甲的细节。第三句仍在讲主题甲。"
        "第四句突然切换到主题乙的内容。第五句继续讲主题乙的细节说明。"
    )
    chunks = [{"chunk_id": "c1", "content": long_content}]

    fcb._embedding_presplit(chunks, policy)

    assert marker_calls, "injected embed_fn should have been invoked"


def test_embedding_presplit_short_chunk_skips_embed_fn(monkeypatch):
    """低于 target_max_chars 的切片不需要 embedding 断点检测，不应调用 embed_fn."""
    from predeal import figure_chunk_binder as fcb

    call_count = {"n": 0}

    def fake_as_embed_fn():
        def fn(text: str) -> dict:
            call_count["n"] += 1
            return {}
        return fn

    monkeypatch.setattr(fcb, "as_embed_fn", fake_as_embed_fn)

    policy = ChunkPolicy(target_min_chars=10, target_max_chars=5000, hard_max_chars=8000)
    chunks = [{"chunk_id": "c1", "content": "短内容不需要切分"}]
    result = fcb._embedding_presplit(chunks, policy)

    assert result == chunks
    assert call_count["n"] == 0


# ── 5. 接线点 b：chunk_enricher.compute_canonical_map 去重路径 ───────────────


class _FakeConfiguredClient:
    """is_configured=True 的假客户端，按内容里是否含“甲”返回两类固定向量."""

    is_configured = True

    def __init__(self, batch_result=None):
        self._batch_result = batch_result

    def embed_batch(self, texts):
        if self._batch_result is not None:
            return self._batch_result
        return [{0: 1.0, 1: 0.0} if "甲" in t else {0: 0.0, 1: 1.0} for t in texts]


class _FakeUnconfiguredClient:
    is_configured = False

    def embed_batch(self, texts):
        raise AssertionError("embed_batch should not be called when unconfigured")


def test_dedup_uses_embedding_cosine_when_configured():
    chunks = [
        {"db_id": 1, "chunk_index": 1, "content": "内容甲的第一种表述完全不同的字面文本A", "near_duplicate_hint": True},
        {"db_id": 2, "chunk_index": 2, "content": "内容甲的第二种表述完全不同的字面文本B", "near_duplicate_hint": True},
    ]
    canonical = compute_canonical_map(chunks, embed_client=_FakeConfiguredClient())
    # 两段文字字面完全不同（SequenceMatcher 判不出重复），但注入的向量余弦=1.0 >= 0.95
    assert canonical == {2: 1}


def test_dedup_falls_back_to_text_similarity_when_not_configured():
    chunks = [
        {"db_id": 1, "chunk_index": 1, "content": "内容甲的第一种表述完全不同的字面文本A", "near_duplicate_hint": True},
        {"db_id": 2, "chunk_index": 2, "content": "内容甲的第二种表述完全不同的字面文本B", "near_duplicate_hint": True},
    ]
    canonical = compute_canonical_map(chunks, embed_client=_FakeUnconfiguredClient())
    # 未配置 -> SequenceMatcher 文本相似度 -> 字面差异较大，不判重
    assert canonical == {}


class _FailingConfiguredClient:
    """is_configured=True 但请求整体失败（embed_batch 返回 None）."""

    is_configured = True

    def embed_batch(self, texts):
        return None


def test_dedup_falls_back_to_text_similarity_when_embed_batch_fails():
    chunks = [
        {"db_id": 1, "chunk_index": 1, "content": "示例重复文本内容一模一样。", "near_duplicate_hint": True},
        {"db_id": 2, "chunk_index": 2, "content": "示例重复文本内容一模一样。", "near_duplicate_hint": True},
    ]
    canonical = compute_canonical_map(chunks, embed_client=_FailingConfiguredClient())
    assert canonical == {2: 1}


def test_dedup_default_embed_client_matches_unconfigured_baseline():
    """未显式传 embed_client 时走进程内单例；测试环境下必为 unconfigured，
    与接入前行为完全一致（回归保护，防止默认参数误接了真实网络客户端）."""
    chunks = [
        {"db_id": 1, "chunk_index": 1, "content": "示例重复文本内容一模一样。", "near_duplicate_hint": True},
        {"db_id": 2, "chunk_index": 2, "content": "完全不同的另一段内容，不应该被判定重复。", "near_duplicate_hint": True},
        {"db_id": 3, "chunk_index": 3, "content": "示例重复文本内容一模一样。", "near_duplicate_hint": True},
    ]
    assert compute_canonical_map(chunks) == {3: 1}
