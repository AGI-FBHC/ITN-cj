"""
Web Search Tool - 基于 Tavily API 的互联网搜索。
"""
import asyncio

from app.config import get_settings
from app.tools.base import BaseTool, register_tool


@register_tool
class WebSearchTool(BaseTool):
    """互联网搜索：检索最新资讯、资料与时事新闻。"""

    @property
    def id(self) -> str:
        return "web_search"

    @property
    def name(self) -> str:
        return "互联网搜索"

    @property
    def description(self) -> str:
        return (
            "【互联网搜索】根据上下文中的当前日期，用当前年份搜索最新信息。\n"
            "适用场景：\n"
            "- 用户说「搜索」「查找」「帮我找」\n"
            "- 用户问「最新消息」「最近发生了什么」\n"
            "- 用户说「帮我查一下」「了解一下」\n"
            "- 用户要求查找论文、资料、新闻等\n\n"
            "注意：搜索关键词(query)中必须包含当前年份，不要使用过时的年份。\n"
            "参数：query 是搜索关键词；limit 是返回结果数量（默认 5 条，最大 10 条）"
        )

    @property
    def parameters_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索关键词或问题",
                },
                "limit": {
                    "type": "integer",
                    "description": "返回结果数量，默认 5 条，最大 10 条",
                    "default": 5,
                },
            },
            "required": ["query"],
        }

    @property
    def available(self) -> bool:
        return bool(get_settings().tavily_api_key)

    async def execute(self, params: dict) -> dict:
        settings = get_settings()
        if not settings.tavily_api_key:
            return {
                "success": False,
                "error": "tavily_api_key is not configured (set TAVILY_API_KEY in agents/.env)",
                "source": "tavily",
            }

        query = (params.get("query") or "").strip()
        if not query:
            return {"success": False, "error": "query parameter is required", "source": "tavily"}
        try:
            limit = min(max(int(params.get("limit") or 5), 1), 10)
        except (TypeError, ValueError):
            limit = 5

        try:
            from tavily import TavilyClient
        except ImportError:
            return {"success": False,
                    "error": "tavily-python library not installed. Run: pip install tavily-python",
                    "source": "tavily"}

        try:
            client = TavilyClient(settings.tavily_api_key)
            response = await asyncio.to_thread(
                client.search,
                query=query,
                search_depth="advanced",
                max_results=limit,
            )
        except Exception as exc:
            return {"success": False, "error": str(exc), "source": "tavily"}

        results = []
        for item in response.get("results", []):
            content = item.get("content") or ""
            results.append({
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "content": content[:500],
            })

        return {
            "success": True,
            "query": query,
            "count": len(results),
            "results": results,
            "source": "tavily",
        }