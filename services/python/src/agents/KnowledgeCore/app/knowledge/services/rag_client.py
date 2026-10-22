"""轻量 RAGFlow 异步检索客户端（httpx，不依赖 predeal 包）.

RAGFlow HTTP API: POST /api/v1/retrieval
历史上参考过 predeal 的 ragflow_client 里的 retrieve 实现改写为 async；
T5.3 收敛后 predeal/src/predeal/ragflow_client.py（原 ragflow_client2.py）已不再
提供 retrieve() 方法，本文件与其完全独立实现，不受影响。
"""

from __future__ import annotations

from typing import Any

import httpx

from app.core.config import get_settings


class RagflowError(Exception):
    """RAGFlow API 错误."""

    def __init__(self, code: int, message: str):
        self.code = code
        self.message = message
        super().__init__(f"RAGFlow error {code}: {message}")


class RagflowAsyncClient:
    """RAGFlow 检索客户端（异步）."""

    def __init__(self):
        settings = get_settings()
        self._base = settings.RAGFLOW_BASE_URL.rstrip("/")
        self._api_key = settings.RAGFLOW_API_KEY
        self._timeout = 60

    async def _request(self, method: str, path: str, body: dict | None = None) -> dict[str, Any]:
        url = f"{self._base}{path}"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.request(method, url, headers=headers, json=body)
        if resp.status_code >= 400:
            try:
                err = resp.json()
                raise RagflowError(err.get("code", resp.status_code), err.get("message", resp.text))
            except ValueError:
                raise RagflowError(resp.status_code, resp.text)
        data = resp.json()
        if data.get("code") != 0:
            raise RagflowError(data.get("code", -1), data.get("message", "Unknown error"))
        return data.get("data", {})

    async def retrieve(
        self,
        question: str,
        dataset_ids: list[str],
        page_size: int = 8,
        similarity_threshold: float = 0.2,
        vector_similarity_weight: float = 0.3,
        top_k: int = 1024,
    ) -> list[dict[str, Any]]:
        """检索相关切片."""
        body = {
            "dataset_ids": dataset_ids,
            "question": question,
            "page": 1,
            "page_size": page_size,
            "similarity_threshold": similarity_threshold,
            "vector_similarity_weight": vector_similarity_weight,
            "top_k": top_k,
            "keyword": False,
            "use_kg": False,
            "toc_enhance": False,
        }
        data = await self._request("POST", "/api/v1/retrieval", body=body)
        return data.get("chunks", [])

    async def list_datasets(self) -> list[dict[str, Any]]:
        """列出所有数据集."""
        data = await self._request("GET", "/api/v1/datasets?page=1&page_size=100")
        return data.get("docs", data) if isinstance(data, dict) else data

    async def resolve_dataset_ids(
        self,
        domain_code: str,
        explicit: list[str] | None = None,
        domain_name: str | None = None,
    ) -> list[str]:
        """解析领域对应的 RAGFlow 数据集 ID.

        优先使用显式传入的 dataset_ids；否则扫描数据集名，
        匹配 predeal 命名约定 {domain_id}_{domain_version_id}（如 hello_agents_v1），
        兜底匹配名称包含领域编码的数据集。
        """
        if explicit:
            return explicit
        try:
            datasets = await self.list_datasets()
        except Exception:
            return []
        hits = []
        code = domain_code.lower()
        label = (domain_name or "").strip().lower()
        for ds in datasets:
            name = str(ds.get("name") or "")
            name_lower = name.lower()
            # 命名约定优先：{code}_v1 / {领域名称}_v1（predeal 现在按领域名称建数据集）
            if (name_lower == f"{code}_v1" or name_lower.startswith(f"{code}_")
                    or (label and (name_lower == f"{label}_v1" or name_lower.startswith(f"{label}_")))):
                hits.insert(0, ds["id"])
            elif code in name_lower or (label and label in name_lower):
                hits.append(ds["id"])
        return hits
