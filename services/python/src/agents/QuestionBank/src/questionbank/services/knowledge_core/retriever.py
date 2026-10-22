"""KnowledgeCore HTTP 客户端（只读封装）.

Question Bank 与 Knowledge Core 的硬边界：
- 只允许调用 KC 暴露的 HTTP 接口（/api/v1/knowledge/*、/api/v1/evidence/*）
- 禁止直连 RAGFlow、禁止自行查询知识切片

底层使用 httpx.AsyncClient，transport 可注入（测试时用 MockTransport）。
"""
from __future__ import annotations

import time
import uuid
from typing import Any

import httpx

from questionbank.security import create_signature


class KnowledgeCoreError(Exception):
    """Knowledge Core 调用失败（不可达 / 非 2xx / 响应非法）."""


class KnowledgeCoreClient:
    """只读 HTTP 客户端."""

    def __init__(
        self,
        base_url: str,
        timeout: float = 15.0,
        transport: httpx.AsyncBaseTransport | None = None,
        secret: str | None = None,
    ):
        self._base = base_url.rstrip("/")
        self._secret = secret
        self._client = httpx.AsyncClient(
            timeout=timeout,
            transport=transport,
            headers={"Accept": "application/json"},
        )

    def _signed_headers(self, method: str, path: str, body: bytes) -> dict[str, str]:
        """T5.1：按 KC 侧 `require_internal_principal` 的约定补四个签名头。

        `secret` 未配置时不加头，保持现状兼容（KC 侧对应过渡期豁免放行）。
        """
        if not self._secret:
            return {}
        timestamp = str(int(time.time()))
        nonce = uuid.uuid4().hex
        user_id = "questionbank-service"
        signature = create_signature(self._secret, method, path, timestamp, nonce, user_id, body)
        return {
            "X-ITN-Timestamp": timestamp,
            "X-ITN-Nonce": nonce,
            "X-ITN-User-Id": user_id,
            "X-ITN-Signature": signature,
        }

    async def aclose(self) -> None:
        await self._client.aclose()

    # ── 底层端点 ──────────────────────────────────────────────────────────

    async def fetch_chunks(
        self,
        *,
        knowledge_point: str | None = None,
        category_id: int | None = None,
        domain: str = "agent",
        limit: int = 8,
        include_rag: bool = True,
        include_prerequisites: bool = False,
        include_contrasts: bool = False,
        threshold_mode: str = "auto",
    ) -> dict[str, Any]:
        """GET /api/v1/knowledge/chunks —— 混合检索（mysql→parent→rag→empty）."""
        if knowledge_point is None and category_id is None:
            raise ValueError("fetch_chunks 必须提供 knowledge_point 或 category_id 之一")
        params: dict[str, Any] = {
            "domain": domain,
            "limit": max(1, min(limit, 50)),
            "include_rag": str(include_rag).lower(),
            "include_prerequisites": str(include_prerequisites).lower(),
            "include_contrasts": str(include_contrasts).lower(),
            "threshold_mode": threshold_mode,
        }
        if knowledge_point is not None:
            params["knowledge_point"] = knowledge_point
        elif category_id is not None:
            # KC 接口要求 knowledge_point 必填；category_id 给定时内部以 ID 为准
            params["knowledge_point"] = f"kp:{category_id}"
        if category_id is not None:
            params["category_id"] = category_id
        return await self._get("/api/v1/knowledge/chunks", params=params)

    async def fetch_coverage(
        self,
        domain: str = "agent",
        threshold_mode: str = "auto",
    ) -> dict[str, Any]:
        """GET /api/v1/knowledge/coverage —— 知识覆盖矩阵（前端知识点下拉数据源）."""
        return await self._get(
            "/api/v1/knowledge/coverage",
            params={"domain": domain, "threshold_mode": threshold_mode},
        )

    async def fetch_frontier(self, domain_id: int, user_id: str) -> list[dict[str, Any]]:
        """GET /api/v1/knowledge/graph/{domain_id}/frontier —— 学习前沿（T4.2）.

        返回"先修全掌握而自身未掌握"的知识点列表（可能为空，响应体本身是 JSON
        数组而非对象，与本客户端其余 `_get()` 方法不同，走 `_get_list()`）；
        供选题器 `frontier_first` 取 category_id 优先排列对应题目（follow-up d）。
        """
        return await self._get_list(
            f"/api/v1/knowledge/graph/{domain_id}/frontier",
            params={"user_id": user_id},
        )

    async def fetch_chunks_by_ids(self, chunk_ids: list[int]) -> list[dict[str, Any]]:
        """GET /api/v1/knowledge/chunks/by-ids —— 按切片 ID 批量回取（get_evidence 数据源）."""
        if not chunk_ids:
            return []
        data = await self._get(
            "/api/v1/knowledge/chunks/by-ids",
            params={"chunk_ids": [str(c) for c in chunk_ids]},
        )
        return data.get("chunks", [])

    # ── 内部工具 ──────────────────────────────────────────────────────────

    async def _request_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        """底层 GET + JSON 解析（不做响应结构类型校验，调用方自行校验）."""
        headers = self._signed_headers("GET", path, b"")
        try:
            resp = await self._client.get(f"{self._base}{path}", params=params, headers=headers or None)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPError as exc:
            raise KnowledgeCoreError(f"Knowledge Core 不可达: {self._base}{path}: {exc}") from exc
        except ValueError as exc:
            raise KnowledgeCoreError(f"Knowledge Core 响应非 JSON: {self._base}{path}") from exc

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        data = await self._request_json(path, params)
        if not isinstance(data, dict):
            raise KnowledgeCoreError(f"Knowledge Core 响应结构非法: {type(data)}")
        return data

    async def _get_list(self, path: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        data = await self._request_json(path, params)
        if not isinstance(data, list):
            raise KnowledgeCoreError(f"Knowledge Core 响应结构非法（应为数组）: {type(data)}")
        return data
