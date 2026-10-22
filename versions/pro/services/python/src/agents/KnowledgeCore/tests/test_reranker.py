"""T3.3 reranker.py 单测：未配置端点 no-op；mock 端点按分数重排；调用失败降级."""

from __future__ import annotations

import types

import pytest

import app.knowledge.services.reranker as reranker_module
from app.knowledge.services.reranker import rerank


def _fake_settings(monkeypatch, url: str, key: str = "", model: str = "") -> None:
    monkeypatch.setattr(
        reranker_module,
        "get_settings",
        lambda: types.SimpleNamespace(
            RERANKER_API_URL=url, RERANKER_API_KEY=key, RERANKER_MODEL=model
        ),
    )


@pytest.mark.asyncio
async def test_rerank_noop_when_url_not_configured(monkeypatch):
    """未配置 RERANKER_API_URL → 原序返回，截断 top_k，不附加 rerank_score."""
    _fake_settings(monkeypatch, "")
    chunks = [{"chunk_id": 1, "content": "a"}, {"chunk_id": 2, "content": "b"}, {"chunk_id": 3, "content": "c"}]
    out = await rerank("q", chunks, top_k=2)
    assert [c["chunk_id"] for c in out] == [1, 2]
    assert "rerank_score" not in out[0]


@pytest.mark.asyncio
async def test_rerank_empty_chunks_noop(monkeypatch):
    _fake_settings(monkeypatch, "http://reranker.local/rerank")
    assert await rerank("q", [], top_k=5) == []


@pytest.mark.asyncio
async def test_rerank_reorders_by_mock_endpoint_score(monkeypatch):
    """配置端点 + mock 分数 → 按分数降序重排，附 rerank_score."""
    _fake_settings(monkeypatch, "http://reranker.local/rerank")

    async def fake_call(url, query, texts, top_k):
        # chunk 索引 2（内容 "c"）分数最高
        return [
            {"index": 0, "score": 0.2},
            {"index": 1, "score": 0.5},
            {"index": 2, "score": 0.9},
        ]

    monkeypatch.setattr(reranker_module, "_call_external_reranker", fake_call)
    chunks = [{"chunk_id": 1, "content": "a"}, {"chunk_id": 2, "content": "b"}, {"chunk_id": 3, "content": "c"}]
    out = await rerank("q", chunks, top_k=3)
    assert [c["chunk_id"] for c in out] == [3, 2, 1]
    assert out[0]["rerank_score"] == 0.9


@pytest.mark.asyncio
async def test_rerank_truncates_to_top_k(monkeypatch):
    _fake_settings(monkeypatch, "http://reranker.local/rerank")

    async def fake_call(url, query, texts, top_k):
        return [{"index": i, "score": float(i)} for i in range(len(texts))]

    monkeypatch.setattr(reranker_module, "_call_external_reranker", fake_call)
    chunks = [{"chunk_id": i, "content": str(i)} for i in range(5)]
    out = await rerank("q", chunks, top_k=2)
    assert len(out) == 2
    assert [c["chunk_id"] for c in out] == [4, 3]


@pytest.mark.asyncio
async def test_rerank_degrades_on_call_failure(monkeypatch):
    """外部端点调用失败（返回 None）→ 降级为原序."""
    _fake_settings(monkeypatch, "http://reranker.local/rerank")

    async def fake_call(url, query, texts, top_k):
        return None

    monkeypatch.setattr(reranker_module, "_call_external_reranker", fake_call)
    chunks = [{"chunk_id": 1, "content": "a"}, {"chunk_id": 2, "content": "b"}]
    out = await rerank("q", chunks, top_k=2)
    assert [c["chunk_id"] for c in out] == [1, 2]


@pytest.mark.asyncio
async def test_call_external_reranker_network_error_returns_none(monkeypatch):
    """真实 HTTP 层异常（如连接失败）→ _call_external_reranker 吞掉异常返回 None."""
    result = await reranker_module._call_external_reranker(
        "http://127.0.0.1:1/definitely-not-listening", "q", ["a"], 1
    )
    assert result is None


@pytest.mark.asyncio
async def test_rerank_siliconflow_cloud_contract(monkeypatch):
    """配置 RERANKER_MODEL + KEY → 按云 API 契约发送（model/top_n/Bearer 头），
    解析 relevance_score（硅基流动 /v1/rerank 响应字段）."""
    _fake_settings(
        monkeypatch,
        "https://api.siliconflow.cn/v1/rerank",
        key="sk-test-key",
        model="BAAI/bge-reranker-v2-m3",
    )

    captured: dict = {}

    class FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            return {
                "id": "rerank-x",
                "results": [
                    {"index": 1, "relevance_score": 0.92},
                    {"index": 0, "relevance_score": 0.31},
                ],
            }

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None):
            captured["url"] = url
            captured["json"] = json
            captured["headers"] = headers
            return FakeResponse()

    monkeypatch.setattr(reranker_module.httpx, "AsyncClient", FakeClient)

    chunks = [{"chunk_id": 1, "content": "a"}, {"chunk_id": 2, "content": "b"}]
    out = await rerank("q", chunks, top_k=2)

    assert captured["json"]["model"] == "BAAI/bge-reranker-v2-m3"
    assert captured["json"]["top_n"] == 2
    assert "top_k" not in captured["json"]
    assert captured["headers"]["Authorization"] == "Bearer sk-test-key"
    # relevance_score 被正确解析：index 1 分高排前
    assert [c["chunk_id"] for c in out] == [2, 1]
    assert out[0]["rerank_score"] == 0.92
