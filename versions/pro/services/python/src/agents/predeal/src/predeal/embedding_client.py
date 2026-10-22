"""817 待办第 8 项：真实 embedding 客户端（硅基流动 ``BAAI/bge-m3``），
替换 ``semantic_splitter.tf_embed`` 占位实现的可注入实现。

设计要点：
- OpenAI 兼容的 ``POST {EMBEDDING_API_URL}``（硅基流动默认
  ``https://api.siliconflow.cn/v1/embeddings``）：请求体
  ``{"model", "input"(单条或批量列表), "encoding_format": "float"}``，
  ``Authorization: Bearer <EMBEDDING_API_KEY>``；响应
  ``{"data": [{"embedding": [...], "index": N}, ...]}``。
- 未配置（``EMBEDDING_API_URL``/``EMBEDDING_API_KEY`` 任一缺失）/ 超时（10s）/
  请求或解析失败：一律返回 ``None``，由调用方决定降级路径，绝不抛异常
  中断流水线。
- 按文本 ``sha256`` 做进程内缓存（``EmbeddingClient`` 实例级；模块级
  ``get_default_client()`` 单例保证同一进程内的调用方共享缓存）。
- :meth:`EmbeddingClient.as_embed_fn` /模块级 :func:`as_embed_fn` 返回符合
  ``semantic_splitter.EmbeddingFn``（``str -> dict[str, float]``）接口的函数：
  真实 embedding 不可用时自动回落到 ``semantic_splitter.tf_embed``，调用方
  （``figure_chunk_binder._embedding_presplit`` 等）拿到的始终是可用的
  ``EmbeddingFn``，无需自行处理 ``None``。

三处接线（均保留降级路径，未配置/失败时行为与接线前完全一致）：
- ``figure_chunk_binder._embedding_presplit``（T3.7 切分断点）：用
  :func:`as_embed_fn` 替换默认的 ``tf_embed``。
- ``steps.chunk_enricher.compute_canonical_map``（T3.5 去重）：embedding 可用
  时用余弦相似度 ``>= EMBEDDING_DUPLICATE_THRESHOLD`` 判重，否则保持原有
  ``SequenceMatcher`` 文本相似度路径不变。
- ``steps.preflight.run_chunk_qc``（T3.9 QC）：embedding 可用时用真实向量算
  相邻/首尾相似度，否则保持原有 ``tf_embed`` 路径不变。
"""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Callable, Optional

import httpx

logger = logging.getLogger(__name__)

# 与其余 predeal 模块一致的“模块级读环境变量”惯例（figure_chunk_binder.py /
# category_classifier.py 等），构造函数参数用于测试注入覆盖。
EMBEDDING_API_URL = os.environ.get("EMBEDDING_API_URL")
EMBEDDING_API_KEY = os.environ.get("EMBEDDING_API_KEY")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "BAAI/bge-m3")
EMBEDDING_TIMEOUT = 10.0

EmbeddingVector = dict  # dict[int, float]：{维度序号: 值}
EmbeddingFn = Callable[[str], dict]  # 与 semantic_splitter.EmbeddingFn 保持一致


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class EmbeddingClient:
    """硅基流动（OpenAI 兼容）embedding 客户端，带进程内 sha256 缓存。"""

    def __init__(
        self,
        api_url: Optional[str] = None,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> None:
        self.api_url = api_url if api_url is not None else EMBEDDING_API_URL
        self.api_key = api_key if api_key is not None else EMBEDDING_API_KEY
        self.model = model if model is not None else EMBEDDING_MODEL
        self.timeout = timeout if timeout is not None else EMBEDDING_TIMEOUT
        self._cache: dict[str, EmbeddingVector] = {}

    @property
    def is_configured(self) -> bool:
        return bool(self.api_url and self.api_key)

    # ── 批量调用 + 缓存 ──────────────────────────────────────────────────

    def embed_batch(self, texts: list[str]) -> Optional[list[Optional[EmbeddingVector]]]:
        """批量取 embedding；未配置返回 ``None``，请求整体失败也返回 ``None``。

        已缓存的文本不产生网络调用；未缓存的文本合并成一次 HTTP 请求。
        """
        if not self.is_configured:
            return None
        if not texts:
            return []

        keys = [_sha256(t) for t in texts]
        results: list[Optional[EmbeddingVector]] = [None] * len(texts)
        miss_idx: list[int] = []
        miss_text: list[str] = []
        for i, k in enumerate(keys):
            cached = self._cache.get(k)
            if cached is not None:
                results[i] = cached
            else:
                miss_idx.append(i)
                miss_text.append(texts[i])

        if miss_text:
            fetched = self._call_api(miss_text)
            if fetched is None:
                return None
            for i, key, vec in zip(miss_idx, (keys[i] for i in miss_idx), fetched):
                self._cache[key] = vec
                results[i] = vec

        return results

    def embed_one(self, text: str) -> Optional[EmbeddingVector]:
        """单条取 embedding（内部走 :meth:`embed_batch`，复用同一份缓存）。"""
        result = self.embed_batch([text])
        if not result:
            return None
        return result[0]

    def _call_api(self, texts: list[str]) -> Optional[list[EmbeddingVector]]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        body = {"model": self.model, "input": texts, "encoding_format": "float"}
        try:
            with httpx.Client(timeout=self.timeout, proxy=None) as client:
                resp = client.post(self.api_url, headers=headers, json=body)
                resp.raise_for_status()
            data = resp.json()
        except Exception as e:  # noqa: BLE001 — 网络/超时/HTTP 错误一律降级
            logger.warning("embedding API call failed: %s", e)
            return None

        items = data.get("data") or []
        try:
            if items and all(isinstance(it, dict) and "index" in it for it in items):
                items = sorted(items, key=lambda it: it["index"])
            vectors = [
                {i: float(v) for i, v in enumerate(it.get("embedding") or [])}
                for it in items
            ]
        except (TypeError, ValueError, AttributeError) as e:
            logger.warning("embedding API response malformed: %s", e)
            return None

        if len(vectors) != len(texts):
            logger.warning(
                "embedding API returned %d vectors for %d inputs, discarding",
                len(vectors), len(texts),
            )
            return None
        return vectors

    # ── EmbeddingFn 适配（供 semantic_splitter 等消费） ─────────────────────

    def as_embed_fn(self) -> EmbeddingFn:
        """返回 ``str -> dict`` 的函数：embedding 不可用/失败时回落 ``tf_embed``。"""
        from .semantic_splitter import tf_embed

        def _fn(text: str) -> dict:
            vec = self.embed_one(text)
            return vec if vec is not None else tf_embed(text)

        return _fn


# ── 模块级单例（进程内共享缓存，供无需自定义配置的接线点直接使用） ──────────

_default_client: Optional[EmbeddingClient] = None


def get_default_client() -> EmbeddingClient:
    global _default_client
    if _default_client is None:
        _default_client = EmbeddingClient()
    return _default_client


def reset_default_client() -> None:
    """测试用：清空单例，便于在变更环境变量后重新读取配置。"""
    global _default_client
    _default_client = None


def as_embed_fn(client: Optional[EmbeddingClient] = None) -> EmbeddingFn:
    """便捷入口：默认使用进程内单例（未配置时其 ``as_embed_fn`` 回落 tf_embed）。"""
    return (client or get_default_client()).as_embed_fn()
