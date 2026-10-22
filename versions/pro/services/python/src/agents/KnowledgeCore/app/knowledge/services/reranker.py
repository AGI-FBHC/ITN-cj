"""T3.3 重排层：外部 reranker 端点优先，未配置/失败时 no-op（保持原序）.

设计（817 行动方案 T3.3）：
- 环境开关 KNOWLEDGE_RERANK（core/config.py，默认 off）：retrieval_service 只在
  开关 on 时才调用本模块，off 时检索链路完全不涉及本文件，保证"开关 off 行为与
  现状 100% 一致"。
- 端点配置 RERANKER_API_URL 未设置：即使 KNOWLEDGE_RERANK=on，rerank() 也直接
  no-op 返回原序（截断 top_k），不阻塞检索——生产先开总开关观察也不会因为忘配
  端点而报错。
- 端点调用失败（超时/非 200/响应格式不符）：同样降级为原序，绝不抛出异常中断
  检索主链路。
"""

from __future__ import annotations

from typing import Any

import httpx

from app.core.config import get_settings

RERANK_TIMEOUT_SECONDS = 10.0


async def _call_external_reranker(
    url: str, query: str, texts: list[str], top_k: int
) -> list[dict[str, Any]] | None:
    """调用外部 reranker HTTP 端点.

    两种契约（按配置自动选择）：
    - RERANKER_MODEL 已配置（云 API，如硅基流动 /v1/rerank）：
      body = {"model", "query", "documents", "top_n"}，Bearer 鉴权（RERANKER_API_KEY），
      响应 results[].relevance_score。
    - 未配置 MODEL（简易自建端点）：body = {"query", "documents", "top_k"}，
      响应 results[].score。
    任何异常/超时/非 200/响应格式不符 → 返回 None（调用方降级为原序）。
    """
    settings = get_settings()
    headers = {}
    if settings.RERANKER_API_KEY:
        headers["Authorization"] = f"Bearer {settings.RERANKER_API_KEY}"
    if settings.RERANKER_MODEL:
        body: dict[str, Any] = {
            "model": settings.RERANKER_MODEL,
            "query": query,
            "documents": texts,
            "top_n": top_k,
        }
    else:
        body = {"query": query, "documents": texts, "top_k": top_k}
    try:
        async with httpx.AsyncClient(timeout=RERANK_TIMEOUT_SECONDS) as client:
            resp = await client.post(url, json=body, headers=headers)
        if resp.status_code != 200:
            return None
        data = resp.json()
        results = data.get("results")
        if not isinstance(results, list):
            return None
        return results
    except Exception:  # noqa: BLE001 — 重排失败不应阻塞检索主链路
        return None


async def rerank(
    query: str, chunks: list[dict[str, Any]], top_k: int
) -> list[dict[str, Any]]:
    """对候选切片重排并截断到 top_k.

    - 未配置 RERANKER_API_URL 或候选为空：原样返回（截断 top_k），不附加 rerank_score
      （no-op，与"无重排能力"语义一致）。
    - 调用外部端点成功：按返回分数降序排列，每条结果附 "rerank_score"；
      响应中未覆盖的候选（端点异常返回不完整结果）静默丢弃。
    - 调用失败/响应不合法：降级为原序（截断 top_k），不附加 rerank_score。
    """
    if not chunks:
        return chunks[:top_k]

    url = get_settings().RERANKER_API_URL
    if not url:
        return chunks[:top_k]

    texts = [str(c.get("content") or "") for c in chunks]
    results = await _call_external_reranker(url, query, texts, top_k)
    if not results:
        return chunks[:top_k]

    scored: list[tuple[float, dict[str, Any]]] = []
    for r in results:
        idx = r.get("index")
        # 简易端点返回 score，OpenAI 风格云 API（硅基流动等）返回 relevance_score
        score = r.get("score", r.get("relevance_score"))
        if not isinstance(idx, int) or idx < 0 or idx >= len(chunks) or score is None:
            continue
        item = dict(chunks[idx])
        item["rerank_score"] = float(score)
        scored.append((float(score), item))

    if not scored:
        return chunks[:top_k]

    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in scored[:top_k]]
