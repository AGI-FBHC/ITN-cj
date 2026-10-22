"""知识点解析：名称 → category_id（Knowledge Core 的 resolve 职责）.

实现基于 KC 混合检索接口：调用 /knowledge/chunks（名称模糊匹配），
从响应提取命中的 category_id / category_name。不命中返回 None。
"""
from __future__ import annotations

from .retriever import KnowledgeCoreClient
from .schemas import KnowledgePointInfo


async def resolve_knowledge_point(
    client: KnowledgeCoreClient,
    query: str,
    domain: str = "agent",
) -> KnowledgePointInfo | None:
    """"MCP传输" → KnowledgePointInfo(id=123, name="MCP传输方式")；未命中返回 None."""
    query = (query or "").strip()
    if not query:
        return None
    data = await client.fetch_chunks(
        knowledge_point=query,
        domain=domain,
        limit=1,
        include_rag=False,  # 解析阶段不需要 RAG 兜底
    )
    category_id = data.get("category_id")
    if not category_id:
        return None
    return KnowledgePointInfo(
        id=int(category_id),
        name=data.get("category_name") or query,
    )
