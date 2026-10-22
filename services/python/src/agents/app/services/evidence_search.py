"""Shared RAG-first evidence retrieval with Web Search fallback."""
from __future__ import annotations

import asyncio
import re

from app.tools.rag_search_tool import RagSearchTool
from app.tools.web_search_tool import WebSearchTool
from app.tools.url_fetch_tool import UrlFetchTool


RAG_MIN_SIMILARITY = 0.4
RAG_MIN_RESULTS = 2
WEB_SEARCH_TIMEOUT_SECONDS = 25


def filter_rag_sources_by_chapter(sources: list[dict], knowledge_path: str) -> list[dict]:
    """Drop vector hits from a different textbook chapter while retaining Web fallback."""
    match = re.search(r"第[一二三四五六七八九十百0-9]+章[^/]*", knowledge_path or "")
    if not match:
        return sources
    chapter = match.group(0).strip()
    return [source for source in sources if source.get("sourceType") != "knowledge_base" or chapter in (
        f"{source.get('document') or ''}\n{source.get('content') or ''}"
    )]


_UUID_NAME_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f-]{27,}[_-]?", re.IGNORECASE)
_HEX_NAME_RE = re.compile(r"^[0-9a-f]{24,}[_-]?", re.IGNORECASE)


def clean_document_name(name: str, section: str = "") -> str:
    """上传附件的 UUID 文件名不适合直接展示给学习者，回退到章节名或通用名。"""
    title = (name or "").strip()
    if not title or _UUID_NAME_RE.match(title) or _HEX_NAME_RE.match(title):
        return (section or "知识库资料").strip()[:120]
    cleaned = re.sub(r"[_-]?attachment$", "", title, flags=re.IGNORECASE).strip()
    return cleaned or (section or "知识库资料").strip()[:120]


def compact_rag_sources(result: dict, limit: int = 10) -> list[dict]:
    sources = []
    for index, chunk in enumerate((result.get("chunks") or [])[:limit], 1):
        similarity = round(float(chunk.get("similarity") or 0), 4)
        section_title = chunk.get("section_title") or chunk.get("title_path") or ""
        src = {
            "id": index,
            "sourceType": "knowledge_base",
            "document": clean_document_name(str(chunk.get("document") or ""), str(section_title)),
            "url": "",
            "content": str(chunk.get("content") or "")[:6000],
            "similarity": similarity,
            "confidence": similarity,
            "chunkId": chunk.get("chunk_id") or "",
            "sectionTitle": chunk.get("section_title") or chunk.get("title_path") or "",
        }
        if chunk.get("knowledgeChunkId"):
            src["knowledgeChunkId"] = chunk["knowledgeChunkId"]
        sources.append(src)
    return sources


def compact_web_sources(result: dict, limit: int = 8) -> list[dict]:
    """Normalize Tavily snippets with a lightweight rank-based confidence."""
    sources = []
    for index, item in enumerate((result.get("results") or [])[:limit], 1):
        confidence = round(max(0.55, 0.76 - (index - 1) * 0.04), 2)
        sources.append({
            "id": index,
            "sourceType": "web",
            "document": item.get("title") or "互联网资料",
            "url": item.get("url") or "",
            "content": str(item.get("content") or "")[:1600],
            "similarity": confidence,
            "confidence": confidence,
            "chunkId": "",
        })
    return sources


def rag_sources_sufficient(sources: list[dict]) -> bool:
    confident = sum(
        float(source.get("similarity") or 0) >= RAG_MIN_SIMILARITY
        for source in sources
    )
    return confident >= RAG_MIN_RESULTS


class EvidenceSearch:
    """Retrieve RAG evidence first and add Web Search when coverage is weak."""

    def __init__(self, rag_tool=None, web_tool=None, url_fetch_tool=None, mysql_tool=None):
        self.rag_tool = rag_tool or RagSearchTool()
        self.web_tool = web_tool or WebSearchTool()
        self.url_fetch_tool = url_fetch_tool or UrlFetchTool()
        if mysql_tool is None:
            try:
                from app.tools.mysql_search_tool import MysqlSearchTool
                self.mysql_tool = MysqlSearchTool()
            except Exception:
                self.mysql_tool = None
        else:
            self.mysql_tool = mysql_tool

    async def _hydrate_web_source(self, source: dict, query: str) -> dict:
        """Replace the search snippet with a stable page-text snapshot when fetchable."""
        url = str(source.get("url") or "").strip()
        if not url:
            return source
        try:
            result = await self.url_fetch_tool.execute({"url": url, "focus": query})
        except Exception:
            return source
        page_text = str(result.get("content") or "").strip() if result.get("success") else ""
        if not page_text:
            return source
        return {
            **source,
            "document": result.get("title") or source.get("document"),
            "content": page_text[:12000],
            "snapshotType": "page_text",
        }

    async def retrieve(
        self,
        query: str,
        *,
        rag_top_k: int = 10,
        web_limit: int = 8,
        allow_web_fallback: bool = True,
        supplement_web: bool = False,
        kp_id: str = "",
    ) -> tuple[list[dict], dict]:
        tools_used: list[str] = []

        # Prefer MySQL search when kp_id is provided (direct category lookup).
        # MySQL slices are primary evidence. Web is only a last-resort fallback
        # below; it must never replace exact slices that are already present.
        mysql_sources: list[dict] = []
        if kp_id and self.mysql_tool:
            try:
                mysql_result = await self.mysql_tool.execute({"query": query, "top_k": 50, "kp_id": kp_id})
                if mysql_result.get("success") and mysql_result.get("chunks"):
                    mysql_sources = compact_rag_sources(mysql_result, rag_top_k)
                    tools_used.append("mysql_search")
            except Exception:
                pass  # Fall through to RAGFlow when the direct lookup is unavailable.

        if mysql_sources:
            rag_sources = mysql_sources
        else:
            try:
                rag_result = await self.rag_tool.execute({"query": query, "top_k": rag_top_k})
            except Exception:
                rag_result = {"success": False, "chunks": []}
            rag_sources = compact_rag_sources(rag_result, rag_top_k) if rag_result.get("success") else []
            if rag_result.get("success"):
                tools_used.append("rag_search")

        sufficient = rag_sources_sufficient(rag_sources)
        web_sources: list[dict] = []
        # Web is not an optional candidate. It is only used when knowledge
        # slices are absent or too weak, and it must never displace usable RAG.
        if allow_web_fallback and not sufficient and bool(getattr(self.web_tool, "available", False)):
            try:
                web_result = await asyncio.wait_for(
                    self.web_tool.execute({
                        "query": f"{query} 教程 原理 示例",
                        "limit": web_limit,
                    }),
                    timeout=WEB_SEARCH_TIMEOUT_SECONDS,
                )
            except Exception:
                web_result = {"success": False, "results": []}
            if web_result.get("success"):
                tools_used.append("web_search")
                web_sources = compact_web_sources(web_result, web_limit)
                web_sources = list(await asyncio.gather(*(
                    self._hydrate_web_source(source, query) for source in web_sources
                )))

        if web_sources:
            sources = [
                source for source in rag_sources
                if float(source.get("similarity") or 0) >= RAG_MIN_SIMILARITY
            ] + web_sources
        else:
            sources = rag_sources

        for index, source in enumerate(sources, 1):
            source["id"] = index

        return sources, {
            "toolsUsed": tools_used,
            "ragCount": len(rag_sources),
            "confidentRagCount": sum(
                float(source.get("similarity") or 0) >= RAG_MIN_SIMILARITY
                for source in rag_sources
            ),
            "webCount": len(web_sources),
            "webFallbackUsed": bool(web_sources),
        }
