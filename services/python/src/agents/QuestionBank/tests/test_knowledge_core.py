"""Knowledge Core Contract 单元测试（mock HTTP，不依赖真实服务）."""
import asyncio

import httpx
import pytest

from questionbank.services.knowledge_core import (
    KnowledgeCore,
    KnowledgeCoreError,
    KnowledgeCoreClient,
)
from questionbank.services.knowledge_core.coverage import evaluate_coverage
from questionbank.services.knowledge_core.schemas import EvidenceItem

CHUNKS_RESPONSE = {
    "knowledge_point": "MCP传输方式",
    "domain_code": "agent",
    "category_id": 123,
    "category_name": "MCP传输方式",
    "category_level": 3,
    "node_type": "category_point",
    "decision": "mysql",
    "threshold": 3,
    "chunks": [
        {
            "chunk_id": 1024,
            "document_id": 18,
            "section_title": "MCP Transport",
            "content": "MCP 传输层支持 stdio 与 SSE 两种传输方式…",
            "source": "mysql",
            "confidence": 0.93,
        },
        {
            "chunk_id": 1051,
            "document_id": 18,
            "section_title": "MCP Transport",
            "content": "stdio 传输适用于本地进程间通信…",
            "source": "mysql",
            "confidence": 0.87,
        },
        {
            "chunk_id": 0,
            "document_id": "20",
            "section_title": "MCP 架构",
            "content": "（RAG 补充）MCP 遵循 JSON-RPC 2.0…",
            "source": "rag",
            "similarity": 0.81,
            "ragflow_chunk_id": "rag_882",
        },
    ],
    "stats": {"exact": 2, "rag": 1},
    "prerequisites": {
        "category_id": 123,
        "nodes": [
            {"category_id": 120, "name": "MCP协议", "level": 3},
            {"category_id": 119, "name": "JSON-RPC", "level": 3},
        ],
        "edges": [],
        "decision": "ok",
    },
    "contrasts": [
        {"category_id": 130, "name": "SSE长连接"},
        {"category_id": 131, "name": "WebSocket传输"},
    ],
}


def make_transport(handler):
    return httpx.MockTransport(handler)


def mock_client(handler) -> KnowledgeCoreClient:
    return KnowledgeCoreClient("http://kc.test", transport=make_transport(handler))


# ── resolve_knowledge_point ────────────────────────────────────────────────


def test_resolve_knowledge_point_maps_name_to_category():
    async def handler(request: httpx.Request) -> httpx.Response:
        assert "/api/v1/knowledge/chunks" in request.url.path
        assert request.url.params["knowledge_point"] == "MCP传输"
        assert request.url.params["include_rag"] == "false"
        return httpx.Response(200, json=CHUNKS_RESPONSE)

    async def run():
        kc = KnowledgeCore(mock_client(handler))
        kp = await kc.resolve_knowledge_point("MCP传输")
        assert kp is not None
        assert kp.id == 123
        assert kp.name == "MCP传输方式"

    asyncio.run(run())


def test_resolve_knowledge_point_miss_returns_none():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"knowledge_point": "不存在", "decision": "empty", "chunks": [], "threshold": 3},
        )

    async def run():
        kc = KnowledgeCore(mock_client(handler))
        assert await kc.resolve_knowledge_point("不存在") is None

    asyncio.run(run())


# ── get_context ────────────────────────────────────────────────────────────


def test_get_context_builds_full_context():
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["category_id"] == "123"
        assert request.url.params["include_prerequisites"] == "true"
        assert request.url.params["include_contrasts"] == "true"
        assert request.url.params["limit"] == "8"  # question_generation 深度
        return httpx.Response(200, json=CHUNKS_RESPONSE)

    async def run():
        kc = KnowledgeCore(mock_client(handler))
        ctx = await kc.get_context(category_id=123, purpose="question_generation")
        assert ctx.knowledge_point.id == 123
        assert ctx.knowledge_point.name == "MCP传输方式"
        # 证据：3 条（含 1 条 RAG），content 非空过滤
        assert len(ctx.evidence) == 3
        assert ctx.evidence[0].source == "mysql"
        assert ctx.evidence[0].score == 0.93
        assert ctx.evidence[2].source == "rag"
        assert ctx.evidence[2].score == 0.81
        assert ctx.evidence[2].ragflow_chunk_id == "rag_882"
        # 前置知识
        assert [p.id for p in ctx.prerequisites] == [120, 119]
        # T4.4：易混淆知识点
        assert [c.id for c in ctx.contrasts] == [130, 131]
        assert ctx.contrasts[0].name == "SSE长连接"
        # 覆盖度：direct=2 ≥ threshold 2 → sufficient
        assert ctx.coverage.coverage_level == "sufficient"
        assert ctx.coverage.direct_chunk_count == 2
        assert ctx.coverage.rag_supplement_count == 1
        # 溯源
        assert ctx.trace.strategy == "mysql"
        assert ctx.trace.request_id

    asyncio.run(run())


def test_get_context_include_contrasts_false_skips_field():
    """include_contrasts=False → contrasts 保持空列表（向后兼容旧调用方）."""

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["include_contrasts"] == "false"
        return httpx.Response(200, json=CHUNKS_RESPONSE)

    async def run():
        kc = KnowledgeCore(mock_client(handler))
        ctx = await kc.get_context(category_id=123, include_contrasts=False)
        assert ctx.contrasts == []

    asyncio.run(run())


def test_get_context_missing_contrasts_key_degrades_gracefully():
    """KC 响应无 contrasts 字段（旧版本 KC）→ 不报错，contrasts 为空列表."""

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=dict(CHUNKS_RESPONSE, contrasts=None))

    async def run():
        kc = KnowledgeCore(mock_client(handler))
        ctx = await kc.get_context(category_id=123)
        assert ctx.contrasts == []

    asyncio.run(run())


def test_get_context_by_name_resolves_then_fetches():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.params.get("category_id"):
            return httpx.Response(200, json=CHUNKS_RESPONSE)
        # 第一次：名称解析（复用 chunks 接口）
        return httpx.Response(200, json=dict(CHUNKS_RESPONSE, chunks=[]))

    async def run():
        kc = KnowledgeCore(mock_client(handler))
        ctx = await kc.get_context(knowledge_point="MCP传输方式", purpose="review")
        assert ctx.knowledge_point.id == 123
        assert len(seen) == 2

    asyncio.run(run())


def test_get_context_resolve_failure_yields_empty_context():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"knowledge_point": "找不到", "decision": "empty", "chunks": [], "threshold": 3},
        )

    async def run():
        kc = KnowledgeCore(mock_client(handler))
        ctx = await kc.get_context(knowledge_point="找不到")
        assert ctx.coverage.coverage_level == "empty"
        assert not ctx.is_usable()

    asyncio.run(run())


def test_get_context_kc_unavailable_raises():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    async def run():
        kc = KnowledgeCore(mock_client(handler))
        with pytest.raises(KnowledgeCoreError):
            await kc.get_context(category_id=123)

    asyncio.run(run())


# ── get_evidence ───────────────────────────────────────────────────────────


def test_get_evidence_returns_mysql_chunks_and_skips_rag():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/knowledge/chunks/by-ids"
        ids = [v for k, v in request.url.params.multi_items() if k == "chunk_ids"]
        assert sorted(ids) == ["1024", "1051"]  # RAG 项（chunk_id=0）被过滤
        return httpx.Response(
            200,
            json={
                "chunks": [
                    {"chunk_id": 1024, "document_id": 18, "content": "MCP 传输层支持…", "source": "mysql"},
                    {"chunk_id": 1051, "document_id": 18, "content": "stdio 传输适用…", "source": "mysql"},
                ]
            },
        )

    async def run():
        kc = KnowledgeCore(mock_client(handler))
        items = await kc.get_evidence(
            [
                {"chunk_id": 1024, "document_id": 18},
                {"chunk_id": 1051, "document_id": 18},
                {"chunk_id": 0, "document_id": "20"},  # RAG 引用，跳过
            ]
        )
        assert [i.chunk_id for i in items] == [1024, 1051]

    asyncio.run(run())


# ── evaluate_coverage ───────────────────────────────────────────────────────


def _ev(source: str) -> EvidenceItem:
    return EvidenceItem(chunk_id=1, content="x", source=source)  # type: ignore[arg-type]


def test_evaluate_coverage_levels():
    assert evaluate_coverage([]).coverage_level == "empty"
    assert evaluate_coverage([_ev("rag")]).coverage_level == "weak"
    assert evaluate_coverage([_ev("mysql"), _ev("rag")]).coverage_level == "weak"  # direct=1 < 2
    assert evaluate_coverage([_ev("mysql"), _ev("mysql")]).coverage_level == "sufficient"
    assert evaluate_coverage([_ev("mysql")], threshold=2).coverage_level == "weak"
    # 直接证据数量达标但低于自定义阈值 → weak
    assert evaluate_coverage([_ev("mysql"), _ev("mysql"), _ev("rag")], threshold=3).coverage_level == "weak"
    assert evaluate_coverage([_ev("mysql"), _ev("mysql"), _ev("rag")], threshold=3).direct_chunk_count == 2


# ── fetch_frontier（follow-up d：学习前沿，响应体是 JSON 数组） ─────────────


def test_fetch_frontier_returns_list():
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/knowledge/graph/7/frontier"
        assert request.url.params["user_id"] == "u1"
        return httpx.Response(
            200,
            json=[
                {"category_id": 88, "name": "事务隔离级别", "mastered_prerequisites": [71, 72]},
            ],
        )

    async def run():
        client = mock_client(handler)
        nodes = await client.fetch_frontier(7, "u1")
        assert nodes == [{"category_id": 88, "name": "事务隔离级别", "mastered_prerequisites": [71, 72]}]

    asyncio.run(run())


def test_fetch_frontier_empty_list():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[])

    async def run():
        client = mock_client(handler)
        assert await client.fetch_frontier(7, "u1") == []

    asyncio.run(run())


def test_fetch_frontier_rejects_non_list_response():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": "object"})

    async def run():
        client = mock_client(handler)
        with pytest.raises(KnowledgeCoreError):
            await client.fetch_frontier(7, "u1")

    asyncio.run(run())


# ── 参数校验 / 边界 ────────────────────────────────────────────────────────


def test_fetch_chunks_requires_identifier():
    async def run():
        client = mock_client(lambda req: httpx.Response(200, json={}))
        with pytest.raises(ValueError):
            await client.fetch_chunks()

    asyncio.run(run())


def test_knowledge_core_client_rejects_non_json():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not-json")

    async def run():
        kc = KnowledgeCore(mock_client(handler))
        with pytest.raises(KnowledgeCoreError):
            await kc.get_context(category_id=123)

    asyncio.run(run())
