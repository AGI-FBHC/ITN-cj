"""LLM 客户端（OpenAI 兼容，对齐 src/agents/app/llm.py 的关键经验）:

- trust_env=False 防代理干扰
- MiMo 推理模型 max_tokens = 推理 + 正文总预算（配置 LLM_MAX_TOKENS，默认 16384；
  过小会导致长正文被截断 → JSON 不闭合 → 解析失败）
- 多重重试 + 退避
- JSON 响应解析容错（剥 code fence / 提取最外层 {} / 截断数组修复）
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

import httpx
from openai import AsyncOpenAI

from app.core.config import settings

logger = logging.getLogger("rulecore.llm")


def _extract_json(raw: str) -> str:
    """剥 code fence、提取最外层 JSON 对象/数组."""
    s = (raw or "").strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", s, flags=re.DOTALL | re.IGNORECASE)
    if fenced:
        s = fenced.group(1).strip()
    return s


def _repair_truncated_array(s: str) -> Any | None:
    """修复被截断的 JSON 数组：保留最后一个完整的 `{...}` 元素并闭合数组.

    场景：LLM 正文超 max_tokens 被截断，JSON 数组未闭合。
    正向扫描记录最后一个"闭合到顶层"的 `{...}` 对象结尾，截断到它之后、补齐 `]`。
    保住已完整的规则，丢弃截断到一半的最后一条。
    """
    depth = 0          # 大括号嵌套深度
    in_str = False
    esc = False
    last_complete = -1  # 最后一个顶层对象闭合 `}` 的下标
    for i, ch in enumerate(s):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                last_complete = i
    if last_complete < 0:
        return None
    head = s[: last_complete + 1].rstrip()
    if head.endswith(","):
        head = head[:-1]
    candidate = head + "\n]"
    try:
        return json.loads(candidate)
    except (json.JSONDecodeError, TypeError):
        return None


def parse_json_lenient(raw: str) -> Any | None:
    s = _extract_json(raw)
    if not s:
        return None
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        pass
    lst = s.lstrip()
    if lst.startswith("["):
        # 期望数组：先试最外层 [...]，再试截断修复（保住已完整元素）
        start, end = s.find("["), s.rfind("]")
        if start >= 0 and end > start:
            try:
                return json.loads(s[start : end + 1])
            except (json.JSONDecodeError, TypeError):
                pass
        return _repair_truncated_array(s)
    # 期望对象：提取最外层 {...}
    start, end = s.find("{"), s.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(s[start : end + 1])
        except (json.JSONDecodeError, TypeError):
            pass
    return None


class LLMClient:
    def __init__(self):
        self._http = httpx.AsyncClient(verify=False, trust_env=False)
        self._client: AsyncOpenAI | None = None
        if settings.LLM_API_URL and settings.LLM_API_KEY:
            # OpenAI SDK 会在 base_url 后自动拼 /chat/completions；
            # .env 里可能配了完整 URL，需剥掉尾部的 /chat/completions，否则路径重复导致 400。
            base = settings.LLM_API_URL.rstrip("/")
            suffix = "/chat/completions"
            if base.endswith(suffix):
                base = base[: -len(suffix)]
            self._client = AsyncOpenAI(
                api_key=settings.LLM_API_KEY,
                base_url=base,
                timeout=settings.LLM_TIMEOUT,
                http_client=self._http,
            )

    @property
    def available(self) -> bool:
        return self._client is not None

    async def complete(
        self,
        system: str,
        prompt: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """单轮补全，返回文本；失败返回空字符串."""
        if self._client is None:
            return ""
        temp = settings.LLM_TEMPERATURE if temperature is None else temperature
        # max_tokens 由配置控制（mimo 推理模型需覆盖 推理+正文 总预算）
        mt = max_tokens or settings.LLM_MAX_TOKENS
        last_err = ""
        for attempt in range(settings.LLM_RETRIES):
            try:
                resp = await self._client.chat.completions.create(
                    model=settings.LLM_MODEL,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": prompt},
                    ],
                    temperature=temp,
                    max_tokens=mt,
                )
                content = (resp.choices[0].message.content or "").strip()
                if content:
                    return content
                last_err = "empty content"
            except Exception as e:  # noqa: BLE001
                last_err = f"{type(e).__name__}: {e}"
            if attempt < settings.LLM_RETRIES - 1:
                await asyncio.sleep(2 * (attempt + 1))
        logger.warning("LLM 调用失败（已重试 %d 次）: %s", settings.LLM_RETRIES, last_err)
        return ""

    async def complete_json(
        self,
        system: str,
        prompt: str,
        fallback: Any | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> Any | None:
        """单轮补全并解析 JSON；解析失败返回 fallback."""
        if self._client is None:
            return fallback
        temp = 0 if temperature is None else temperature  # 结构化输出用低温
        raw = await self.complete(system, prompt, temperature=temp, max_tokens=max_tokens)
        if not raw:
            return fallback
        parsed = parse_json_lenient(raw)
        return parsed if parsed is not None else fallback

    async def close(self):
        await self._http.aclose()


# 全局单例
llm = LLMClient()
