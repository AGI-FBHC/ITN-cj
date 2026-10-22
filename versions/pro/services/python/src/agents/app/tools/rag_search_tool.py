"""
RAG Search Tool - 调用 RAGFlow /api/v1/retrieval 检索知识库。
适用于已构建好的 RAGFlow 数据集（如 hello_agents_v1）。
"""
import json
import logging

import httpx

from app.config import get_settings
from app.tools.base import BaseTool, register_tool

logger = logging.getLogger(__name__)


@register_tool
class RagSearchTool(BaseTool):
    """在 RAGFlow 知识库中检索与问题相关的段落。"""

    @property
    def id(self) -> str:
        return "rag_search"

    @property
    def name(self) -> str:
        return "RAG 知识库检索"

    @property
    def description(self) -> str:
        return (
            "【RAG 知识库检索】在已构建好的 RAGFlow 知识库中检索与问题相关的段落。\n"
            "适用场景：\n"
            "- 用户询问专业知识（AI、算法、框架、教材内容等）\n"
            "- 用户问「根据文档/资料/学习目标」「在我学过的内容里」\n"
            "- 用户希望基于某本教材、课程、文档集回答\n\n"
            "与 web_search 的区别：本工具查询的是本地/私有知识库（已构建好的 RAGFlow 数据集），"
            "而 web_search 是全网检索。请优先用本工具回答学习相关的精确问题。\n\n"
            "参数：query 是检索关键词或问句（建议用完整中文问句）；top_k 是返回 chunk 数量（默认 5，最大 10）。"
        )

    @property
    def parameters_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "检索关键词或问题",
                },
                "top_k": {
                    "type": "integer",
                    "description": "返回的 chunk 数量，默认 5，最大 10",
                    "default": 5,
                },
            },
            "required": ["query"],
        }

    @property
    def available(self) -> bool:
        return bool(get_settings().ragflow_api_key)

    async def execute(self, params: dict) -> dict:
        settings = get_settings()
        if not settings.ragflow_api_key:
            return {
                "success": False,
                "error": "ragflow_api_key is not configured (set RAGFLOW_API_KEY in .env)",
                "source": "ragflow",
            }

        query = (params.get("query") or "").strip()
        if not query:
            return {"success": False, "error": "query parameter is required", "source": "ragflow"}

        try:
            top_k = min(max(int(params.get("top_k") or settings.ragflow_top_k), 1), 10)
        except (TypeError, ValueError):
            top_k = settings.ragflow_top_k

        url = f"{settings.ragflow_base_url.rstrip('/')}/api/v1/retrieval"
        headers = {
            "Authorization": f"Bearer {settings.ragflow_api_key}",
            "Content-Type": "application/json",
        }
        body = {
            "question": query,
            "dataset_ids": [settings.ragflow_dataset_id],
            "top_k": top_k,
        }

        try:
            async with httpx.AsyncClient(trust_env=False, verify=False, timeout=30) as client:
                resp = await client.post(url, headers=headers, json=body)
        except Exception as exc:
            return {"success": False, "error": f"RAGFlow 请求失败: {exc}", "source": "ragflow"}

        if resp.status_code != 200:
            return {
                "success": False,
                "error": f"RAGFlow 返回 HTTP {resp.status_code}: {resp.text[:200]}",
                "source": "ragflow",
            }

        try:
            payload = resp.json()
        except json.JSONDecodeError as exc:
            return {"success": False, "error": f"RAGFlow 返回非 JSON: {exc}", "source": "ragflow"}

        if payload.get("code") != 0:
            return {
                "success": False,
                "error": f"RAGFlow 错误: {payload.get('message', '未知')}",
                "source": "ragflow",
            }

        data = payload.get("data") or {}
        raw_chunks = data.get("chunks") or []
        chunks = []
        for c in raw_chunks:
            content = c.get("content") or ""
            chunks.append({
                "content": content,
                "similarity": round(float(c.get("similarity") or 0), 4),
                "vector_similarity": round(float(c.get("vector_similarity") or 0), 4),
                "term_similarity": round(float(c.get("term_similarity") or 0), 4),
                "document": c.get("document_keyword") or "",
                "dataset_id": c.get("dataset_id") or "",
                "chunk_id": c.get("id") or "",
            })

        return {
            "success": True,
            "query": query,
            "count": len(chunks),
            "total_in_dataset": data.get("total", len(chunks)),
            "chunks": chunks,
            "source": "ragflow",
            "dataset_id": settings.ragflow_dataset_id,
        }
