"""LLM 客户端（OpenAI 兼容 /chat/completions；mock 供测试）.

- 与 agents 侧同一套配置键（LLM_API_URL / LLM_API_KEY / LLM_MODEL）
- transport 可注入（测试 MockTransport）
- 容错：JSON 围栏 / 截断恢复 / 尾随逗号；MiMo 推理模型 content 为空时自动重试
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

import httpx

from questionbank.config import Settings
from questionbank.request_context import get_trace_id, log_access_json


class LLMError(Exception):
    pass


class LLMClient:
    MAX_RETRIES = 3

    def __init__(
        self,
        settings: Settings,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.settings = settings
        self._transport = transport
        self._client: httpx.AsyncClient | None = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=self.settings.llm_timeout_seconds,
                transport=self._transport,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    def _endpoint(self) -> str:
        url = self.settings.llm_api_url.rstrip("/")
        if url.endswith("/chat/completions"):
            return url
        return f"{url}/chat/completions"

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.settings.llm_api_key}",
            "Content-Type": "application/json",
        }

    async def complete_json(
        self,
        system: str,
        prompt: str,
        fallback: dict[str, Any],
        *,
        temperature: float = 0.7,
        feature: str = "question_gen",
    ) -> dict[str, Any]:
        """请求 LLM 返回 JSON 对象；重试后仍失败 → 抛 LLMError（调用方决定策略）.

        针对 MiMo 推理模型：content 可能为空（token 全用于 reasoning），
        空内容/解析失败自动重试（最多 MAX_RETRIES 次，指数退避）。
        """
        if self.settings.llm_provider.lower() == "mock":
            return fallback
        if not self.settings.llm_api_url:
            return fallback

        last_error: Exception | None = None
        for attempt in range(self.MAX_RETRIES):
            try:
                parsed = await self._request_once(system, prompt, temperature, feature)
                if parsed is not None:
                    return parsed
                last_error = LLMError("LLM 响应无法解析为 JSON")
            except LLMError as exc:
                last_error = exc
            if attempt < self.MAX_RETRIES - 1:
                await asyncio.sleep(1.5 * (attempt + 1))
        raise LLMError(f"LLM 调用失败（重试 {self.MAX_RETRIES} 次）: {last_error}")

    async def _request_once(
        self,
        system: str,
        prompt: str,
        temperature: float,
        feature: str = "question_gen",
    ) -> dict[str, Any] | None:
        payload = {
            "model": self.settings.llm_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "temperature": temperature,
            "max_tokens": self.settings.llm_max_tokens,
        }
        started = time.perf_counter()
        try:
            resp = await self.client.post(
                self._endpoint(),
                headers=self._headers(),
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            content = (data["choices"][0]["message"]["content"] or "").strip()
        except httpx.HTTPError as exc:
            raise LLMError(f"LLM 网络/HTTP 错误: {type(exc).__name__}: {exc}") from exc
        except (KeyError, IndexError, ValueError) as exc:
            raise LLMError(f"LLM 响应结构非法: {exc}") from exc

        self._schedule_usage(feature, data.get("usage") or {}, started)

        if not content:
            # MiMo 推理模型常见：token 全用于 reasoning，content 为空
            return None
        return self._parse_json_content(content)

    # ── T2.2 LLM 记账：fire-and-forget，失败静默，绝不影响主流程 ──────────

    def _schedule_usage(self, feature: str, usage: dict[str, Any], started: float) -> None:
        latency_ms = int((time.perf_counter() - started) * 1000)
        try:
            asyncio.create_task(self._record_usage(feature, usage, latency_ms))
        except RuntimeError:
            pass  # 没有运行中的事件循环（不应发生在异步调用路径中）

    def _write_usage_row(self, row: dict[str, Any]) -> None:
        """同步写 llm_usage_log（在线程池中执行，避免阻塞事件循环）。"""
        import pymysql

        from questionbank.store import _conn_params

        connection = pymysql.connect(**_conn_params(self.settings))
        try:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO llm_usage_log "
                    "(trace_id, service, feature, model, in_tokens, out_tokens, latency_ms) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                    (row["trace_id"], row["service"], row["feature"], row["model"],
                     row["in_tokens"], row["out_tokens"], row["latency_ms"]),
                )
            connection.commit()
        finally:
            connection.close()

    async def _record_usage(self, feature: str, usage: dict[str, Any], latency_ms: int) -> None:
        row = {
            "trace_id": get_trace_id(), "service": "questionbank", "feature": feature,
            "model": self.settings.llm_model, "in_tokens": usage.get("prompt_tokens"),
            "out_tokens": usage.get("completion_tokens"), "latency_ms": latency_ms,
        }
        if not self.settings.mysql_host or not self.settings.mysql_database:
            # 无 MySQL 连接（本地/测试常见）：降级为结构化日志输出
            log_access_json(event="llm_usage", **row)
            return
        try:
            await asyncio.to_thread(self._write_usage_row, row)
        except Exception:  # noqa: BLE001 — 记账失败绝不影响主流程
            pass

    @staticmethod
    def _parse_json_content(content: str) -> dict[str, Any] | None:
        """宽容 JSON 解析：围栏 / 截断恢复 / 尾随逗号."""
        fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", content, flags=re.DOTALL | re.IGNORECASE)
        if fenced:
            content = fenced.group(1)

        start = content.find("{")
        end = content.rfind("}")
        if start < 0 or end <= start:
            return None
        candidate = content[start : end + 1]

        parsed = LLMClient._try_loads(candidate)
        if parsed is not None:
            return parsed

        # 修复 1：尾随逗号（如 {"a": 1,}）
        fixed = re.sub(r",\s*}", "}", candidate)
        parsed = LLMClient._try_loads(fixed)
        if parsed is not None:
            return parsed

        # 修复 2：输出被截断（最后一个 } 处可能不是完整对象），
        # 从后往前尝试每个 } 位置，取第一个能完整解析的
        for m in reversed(list(re.finditer(r"}", candidate))):
            sub = candidate[: m.start() + 1]
            parsed = LLMClient._try_loads(sub)
            if parsed is not None:
                return parsed
        return None

    @staticmethod
    def _try_loads(text: str) -> dict[str, Any] | None:
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return None
        return parsed if isinstance(parsed, dict) else None
