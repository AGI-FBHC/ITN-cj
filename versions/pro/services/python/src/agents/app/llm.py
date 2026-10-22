import base64
import json
import mimetypes
import re
import logging
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
from openai import AsyncOpenAI

from app.config import Settings

logger = logging.getLogger(__name__)

_T = chr(60) + "think" + chr(62)
_TC = chr(60) + "/think" + chr(62)
_C = chr(60) + "tool_call" + chr(62)
_CC = chr(60) + "/tool_call" + chr(62)

_TOOL_CALL_RE = re.compile(
    '<' + r"tool_call>\s*" + '<' + r"function=(\w+)>(.*?)" + '<' + r"/function>\s*" + '<' + r"/tool_call>",
    re.DOTALL,
)
_PARAM_RE = re.compile('<' + r"parameter=(\w+)>(.*?)" + '<' + r"/parameter>", re.DOTALL)
_STREAM_TAGS = (_T, _C)


def _incomplete_stream_tag_start(text: str) -> int | None:
    """Locate a trailing partial ``<think>`` or ``<tool_call>`` tag."""
    for index, char in enumerate(text):
        if char != "<":
            continue
        suffix = text[index:]
        if any(tag.startswith(suffix) for tag in _STREAM_TAGS):
            return index
    return None


def _normalize_cumulative_delta(accumulated: str, incoming: str) -> tuple[str, str]:
    """Convert cumulative OpenAI-compatible stream frames into real deltas.

    Some providers emit ``reasoning_content`` as the whole reasoning generated
    so far, while others emit ordinary token deltas. Supporting both prevents
    repeated paragraphs from being persisted and rendered.
    """
    if not incoming:
        return accumulated, ""
    if accumulated and incoming.startswith(accumulated):
        return incoming, incoming[len(accumulated):]
    if accumulated.endswith(incoming):
        return accumulated, ""
    return accumulated + incoming, incoming


def _parse_tags(text, include_reasoning=False):
    events = []
    remaining = text
    while remaining:
        tp = remaining.find(_T)
        cp = remaining.find(_C)
        if tp == -1 and cp == -1:
            partial_at = _incomplete_stream_tag_start(remaining)
            if partial_at is None:
                if remaining:
                    events.append({"type": "content", "text": remaining})
            else:
                if partial_at > 0:
                    events.append({"type": "content", "text": remaining[:partial_at]})
                events.append({"type": "_buf", "text": remaining[partial_at:]})
            break
        if tp != -1 and (cp == -1 or tp < cp): pos, tag = tp, "think"
        else: pos, tag = cp, "tool"
        if pos > 0 and remaining[:pos].strip():
            events.append({"type": "content", "text": remaining[:pos]})
        if tag == "think":
            end = remaining.find(_TC, pos)
            if end == -1: events.append({"type": "_buf", "text": remaining[pos:]}); break
            t = remaining[pos+len(_T):end].strip()
            if include_reasoning and t: events.append({"type": "reasoning", "text": t})
            remaining = remaining[end+len(_TC):]
        else:
            end = remaining.find(_CC, pos)
            if end == -1: events.append({"type": "_buf", "text": remaining[pos:]}); break
            block = remaining[pos:end+len(_CC)]
            import re as _re
            m = _TOOL_CALL_RE.search(block)
            if m: events.append({"type": "text_tool_call", "name": m.group(1), "params": dict(_PARAM_RE.findall(m.group(2)))})
            remaining = remaining[end+len(_CC):]
    return events




class LLMClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        # trust_env=False avoids Windows system proxy interfering with connections
        # 浏览器 UA：opencode 等网关经 Cloudflare 按 UA/指纹拦截默认客户端（403 1010）
        self._http_client = httpx.AsyncClient(
            verify=False, trust_env=False,
            limits=httpx.Limits(keepalive_expiry=300),
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            },
        )
        self._default_client = None if settings.llm_provider == "mock" else AsyncOpenAI(
            api_key=settings.llm_api_key,
            base_url=settings.llm_api_base,
            timeout=settings.llm_timeout_seconds,
            # Retries are controlled by complete_json/stream_chat. Disabling the
            # SDK's hidden retry layer keeps one provider outage from multiplying
            # into several minutes per learner resource.
            max_retries=0,
            http_client=self._http_client,
        )
        self._mimo_client: AsyncOpenAI | None = None
        self._mimo_legacy_client: AsyncOpenAI | None = None
        self._qwen_client: AsyncOpenAI | None = None

    def _client_for(self, provider: str = "") -> AsyncOpenAI | None:
        if provider in ("", "kimi", "qwen"):
            return self._client_for("mimo-legacy")
        if provider == "mimo":
            if self._mimo_client is None:
                mimo_key = self.settings.mimo_api_key
                if not mimo_key:
                    return self._default_client
                self._mimo_client = AsyncOpenAI(
                    api_key=mimo_key,
                    base_url=self.settings.mimo_text_api_base or self.settings.mimo_api_base,
                    timeout=self.settings.llm_timeout_seconds,
                    max_retries=0,
                    http_client=self._http_client,
                )
            return self._mimo_client
        if provider == "mimo-legacy":
            # token-plan 通道（MIMO_API_BASE/KEY）：text 通道失效时的回落通道
            if self._mimo_legacy_client is None:
                if not self.settings.mimo_api_key:
                    return self._default_client
                self._mimo_legacy_client = AsyncOpenAI(
                    api_key=self.settings.mimo_api_key,
                    base_url=self.settings.mimo_api_base or self.settings.mimo_api_base,
                    timeout=self.settings.llm_timeout_seconds,
                    max_retries=0,
                    http_client=self._http_client,
                )
            return self._mimo_legacy_client
        if provider == "qwen":
            if self._qwen_client is None:
                qwen_key = self.settings.qwen_chat_api_key or self.settings.qwen_audio_api_key
                qwen_base = self.settings.qwen_chat_api_base or self.settings.qwen_audio_api_base
                if not qwen_key:
                    return self._default_client
                self._qwen_client = AsyncOpenAI(
                    api_key=qwen_key,
                    base_url=qwen_base,
                    timeout=self.settings.llm_timeout_seconds,
                    max_retries=0,
                    http_client=self._http_client,
                )
            return self._qwen_client
        return self._default_client

    def _model_for(self, provider: str = "") -> str:
        if provider in ("", "kimi", "qwen"):
            return self.settings.mimo_model
        if provider == "mimo":
            # `mimo` is the locally deployed text channel.  Its model name must
            # never leak into the official MiMo endpoint.
            return self.settings.mimo_text_model or self.settings.mimo_model
        if provider == "mimo-legacy":
            # Official MiMo channel, used by multimodal review only.
            return self.settings.mimo_model
        if provider == "qwen":
            return self.settings.qwen_chat_model
        return self.settings.llm_model

    def _re_kwargs(self, provider: str = "") -> dict[str, Any]:
        if provider in ("mimo", "mimo-legacy", "", "kimi", "qwen"):
            return {}
        if provider == "qwen":
            # Qwen 用 enable_thinking 控制思考；reasoning_effort 与 enable_thinking=false 冲突
            return {}
        if self.settings.llm_reasoning_effort != "none":
            return {"reasoning_effort": self.settings.llm_reasoning_effort}
        return {}

    def _supports_reasoning_effort(self, provider: str = "") -> bool:
        """DeepSeek 等上游不认 reasoning_effort，且会把输出预算耗在思考上，直接不发该参数。"""
        if provider == "mimo":
            base = self.settings.mimo_text_api_base or self.settings.mimo_api_base
        elif provider in ("", "mimo-legacy", "kimi"):
            base = self.settings.mimo_api_base
        elif provider == "qwen":
            base = self.settings.qwen_chat_api_base or self.settings.qwen_audio_api_base
        else:
            base = self.settings.llm_api_base
        return "deepseek" not in (base or "").lower()

    @staticmethod
    def _get_reasoning(delta) -> str | None:
        return getattr(delta, "reasoning_content", None)

    async def complete_json(self, system: str, prompt: str, fallback: dict[str, Any],
                            reasoning_effort: str | None = None, provider: str = "",
                            max_retries: int | None = None,
                            max_tokens: int | None = None,
                            thinking: bool | None = None,
                            model: str | None = None,
                            timeout_seconds: float | None = None) -> dict[str, Any]:
        client = self._client_for(provider)
        if client is None:
            return fallback
        import asyncio as _asyncio
        retry_count = max_retries if max_retries is not None else (5 if provider == "mimo" else 1)
        retry_count = max(1, int(retry_count))
        for attempt in range(retry_count):
            try:
                kwargs = self._re_kwargs(provider)
                messages = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
                if provider == "mimo":
                    # MiMo 当前网关流式通道不稳；统一走非流式 JSON 生成，禁用思考。
                    try:
                        async with _asyncio.timeout(
                            max(1.0, float(timeout_seconds)) if timeout_seconds is not None
                            else min(self.settings.llm_timeout_seconds, 90)
                        ):
                            response = await client.chat.completions.create(
                                model=model or self._model_for(provider),
                                messages=messages,
                                temperature=self.settings.llm_temperature,
                                max_tokens=max_tokens or 4096,
                                extra_body={"thinking": {"type": "disabled"}},
                            )
                            content = (response.choices[0].message.content or "{}").strip()
                    except Exception:
                        # Text generation is pinned to the local deployment.
                        # Do not route a local model name or user content to the
                        # official multimodal/voice provider on failure.
                        logger.warning("local text channel failed", exc_info=True)
                        raise
                else:
                    effort = reasoning_effort or self.settings.llm_reasoning_effort
                    if effort and effort.strip().lower() != "none" and self._supports_reasoning_effort(provider):
                        kwargs["reasoning_effort"] = effort
                    # DeepSeek 要求 json_object 时 messages 里必须出现 "json"，否则直接 400
                    if "json" in (system + prompt).lower():
                        kwargs["response_format"] = {"type": "json_object"}
                    kwargs["temperature"] = self.settings.llm_temperature
                    response = await client.chat.completions.create(
                        **kwargs,
                        model=model or self._model_for(provider),
                        messages=messages,
                    )
                    content = (response.choices[0].message.content or "{}").strip()
            except Exception:
                if attempt < retry_count - 1:
                    await _asyncio.sleep(2 * (attempt + 1))
                    continue
                logger.warning("complete_json provider=%s attempt=%s failed", provider, attempt, exc_info=True)
                return fallback
            fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", content, flags=re.DOTALL | re.IGNORECASE)
            if fenced:
                content = fenced.group(1)
            if not content.lstrip().startswith("{"):
                start, end = content.find("{"), content.rfind("}")
                if start >= 0 and end > start:
                    content = content[start:end + 1]
            try:
                parsed = json.loads(content)
            except (json.JSONDecodeError, TypeError):
                if attempt < retry_count - 1:
                    await _asyncio.sleep(2 * (attempt + 1))
                    continue
                return fallback
            if isinstance(parsed, dict):
                return parsed
            if attempt < retry_count - 1:
                await _asyncio.sleep(2 * (attempt + 1))
                continue
        return fallback

    async def complete_vision_json(
        self, system: str, prompt: str, image_paths: list[str], fallback: dict[str, Any],
        *, model: str, provider: str = "mimo",
    ) -> dict[str, Any]:
        client = self._client_for(provider)
        if client is None or not image_paths:
            return fallback
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        try:
            for path in image_paths:
                mime = mimetypes.guess_type(path)[0] or "image/png"
                encoded = base64.b64encode(Path(path).read_bytes()).decode("ascii")
                content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{encoded}", "detail": "low"},
                })
            response = await client.chat.completions.create(
                model=model or self._model_for(provider),
                max_tokens=1600,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": content},
                ],
            )
        except Exception:
            return fallback
        raw = (response.choices[0].message.content or "{}").strip()
        fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", raw, flags=re.DOTALL | re.IGNORECASE)
        if fenced:
            raw = fenced.group(1)
        start, end = raw.find("{"), raw.rfind("}")
        if start >= 0 and end > start:
            raw = raw[start:end + 1]
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return fallback
        return parsed if isinstance(parsed, dict) else fallback

    async def complete_vision_text(
        self, system: str, prompt: str, image_data_url: str, *,
        provider: str = "mimo", model: str | None = None,
    ) -> str:
        """Single-turn vision model call returning plain text (image_url + prompt).

        Used by the two-stage image Q&A: describe the photo once, then feed the
        description into the main text conversation.
        """
        client = self._client_for(provider)
        if client is None:
            return ""
        content: list[dict[str, Any]] = [
            {"type": "image_url", "image_url": {"url": image_data_url, "detail": "low"}},
            {"type": "text", "text": prompt},
        ]
        try:
            kwargs: dict[str, Any] = {
                "model": model or self._model_for(provider),
                "max_tokens": 300,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": content},
                ],
            }
            if provider in ("qwen", "mimo-legacy", "", "kimi"):
                kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
            response = await client.chat.completions.create(**kwargs)
        except Exception:
            return ""
        return str((response.choices[0].message.content or "")).strip()[:2000]

    async def complete_chat(self, messages: list[dict[str, Any]], provider: str = "", model: str | None = None) -> str:

        client = self._client_for(provider)
        if client is None:
            last = next((item["content"] for item in reversed(messages) if item["role"] == "user"), "")
            return f"[mock] {last}"
        try:
            kwargs = self._re_kwargs(provider)
            if provider == "mimo":
                kwargs["max_tokens"] = 4096
                kwargs["temperature"] = self.settings.llm_temperature
                kwargs["extra_body"] = {"thinking": {"type": "disabled"}}
            response = await client.chat.completions.create(
                model=model or self._model_for(provider),
                **kwargs,
                messages=messages,
            )
        except Exception as exc:
            logger.warning("LLM complete_chat failed provider=%s error=%s", provider, exc)
            last = next((item["content"] for item in reversed(messages) if item["role"] == "user"), "")
            return f"[error] {last}"
        content = (response.choices[0].message.content or "").strip()
        if provider == "mimo":
            events = _parse_tags(content, include_reasoning=False)
            return "".join(ev.get("text", "") for ev in events if ev["type"] == "content") or content
        return content

    async def stream_chat(self, messages, include_reasoning=False, provider="kimi",
                          max_tokens_override: int | None = None,
                          thinking: bool | None = None):
        client = self._client_for(provider)
        if client is None:
            if include_reasoning:
                yield {"type": "reasoning", "text": "[mock reasoning]"}
            reply = await self.complete_chat(messages, provider)
            for i in range(0, len(reply), 8):
                yield {"type": "content", "text": reply[i:i + 8]}
            return
        # MiMo reasoning model: high max_tokens causes infinite reasoning with
        # no content output.  Cap at 4096 to force the model to produce content.
        max_tokens = max_tokens_override or self.settings.llm_max_tokens
        if provider in ("mimo", "mimo-legacy", "", "kimi", "qwen") and max_tokens > 8192:
            max_tokens = 8192
        import asyncio as _asyncio
        max_retries = 5 if provider in ("mimo", "mimo-legacy", "", "kimi", "qwen") else 1
        stream = None
        for attempt in range(max_retries):
            try:
                if provider == "mimo" and thinking is None:
                    # MiMo 默认进入思考会让生成迟迟不吐正文；除非显式开启思考，默认关闭。
                    thinking = False
                request_options = self._re_kwargs(provider)
                if provider in ("mimo", "mimo-legacy", "", "kimi", "qwen") and thinking is not None:
                    request_options["extra_body"] = {
                        "thinking": {"type": "enabled" if thinking else "disabled"},
                    }
                stream = await client.chat.completions.create(
                    model=self._model_for(provider),
                    messages=messages,
                    temperature=self.settings.llm_temperature,
                    max_tokens=max_tokens,
                    stream=True,
                    **request_options,
                )
                break
            except Exception:
                if attempt < max_retries - 1:
                    await _asyncio.sleep(2 * (attempt + 1))
                    continue
                return
        tag_buf = ""
        reasoning_stream = ""
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            reasoning = self._get_reasoning(delta)
            if include_reasoning and reasoning:
                reasoning_stream, reasoning_delta = _normalize_cumulative_delta(reasoning_stream, reasoning)
                if reasoning_delta:
                    yield {"type": "reasoning", "text": reasoning_delta}
            if delta.content:
                text = tag_buf + delta.content
                tag_buf = ""
                for ev in _parse_tags(text, include_reasoning):
                    if ev["type"] == "_buf":
                        tag_buf = ev["text"]
                    elif ev["type"] in ("content", "reasoning"):
                        yield ev
        if tag_buf:
            yield {"type": "content", "text": tag_buf}

    async def stream_chat_with_tools(self, messages, tools=None, include_reasoning=False, provider="kimi"):
        client = self._client_for(provider)
        if client is None or not tools:
            async for chunk in self.stream_chat(messages, include_reasoning, provider):
                yield chunk
            return

        from app.tools.base import tool_registry
        tool_map = {}
        for t in tools:
            name = t.get("function", {}).get("name", "")
            obj = tool_registry.get(name)
            if obj:
                tool_map[name] = obj

        working = list(messages)
        iteration = 0
        max_iter = self.settings.chat_tool_max_iterations

        # MiMo reasoning model: cap max_tokens to avoid infinite reasoning
        max_tokens = self.settings.llm_max_tokens
        if provider in ("mimo", "mimo-legacy", "", "kimi", "qwen") and max_tokens > 4096:
            max_tokens = 4096

        while iteration < max_iter:
            iteration += 1
            try:
                stream = await client.chat.completions.create(
                    model=self._model_for(provider),
                    messages=working, tools=tools,
                    temperature=self.settings.llm_temperature,
                    max_tokens=max_tokens,
                    stream=True, **self._re_kwargs(provider),
                )
            except Exception as e:
                # Always yield accumulated content before stopping
                if content_buf.strip():
                    yield {"type": "content", "text": content_buf}
                elif iteration > 1:
                    # If we had tool calls but no content, yield a fallback
                    yield {"type": "content", "text": f"\n\n[工具调用已完成，但生成最终回答时出错: {type(e).__name__}]"}
                return

            oai_calls = {}
            tag_buf = ""
            content_buf = ""
            text_calls = []
            reasoning_stream = ""

            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                reasoning = self._get_reasoning(delta)
                if include_reasoning and reasoning:
                    reasoning_stream, reasoning_delta = _normalize_cumulative_delta(reasoning_stream, reasoning)
                    if reasoning_delta:
                        yield {"type": "reasoning", "text": reasoning_delta}
                if delta.content:
                    text = tag_buf + delta.content
                    tag_buf = ""
                    for ev in _parse_tags(text, include_reasoning):
                        if ev["type"] == "_buf":
                            tag_buf = ev["text"]
                        elif ev["type"] == "text_tool_call":
                            text_calls.append(ev)
                        elif ev["type"] in ("content", "reasoning"):
                            content_buf += ev.get("text", "")
                            yield ev
                for tc in delta.tool_calls or []:
                    slot = oai_calls.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                    if tc.id:
                        slot["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            slot["name"] += tc.function.name
                        if tc.function.arguments:
                            slot["arguments"] += tc.function.arguments

            if tag_buf:
                for ev in _parse_tags(tag_buf, include_reasoning):
                    if ev["type"] == "text_tool_call":
                        text_calls.append(ev)
                    elif ev["type"] in ("content", "reasoning"):
                        yield ev

            if oai_calls:
                yield {"type": "tool_calls", "calls": [oai_calls[i] for i in sorted(oai_calls)]}
                return

            if not text_calls:
                return

            working.append({"role": "assistant", "content": content_buf})
            for tc in text_calls:
                tool_obj = tool_map.get(tc["name"])
                call_id = f"text_{iteration}_{tc['name']}"
                yield {"type": "tool_call_started", "tool": tc["name"], "name": tc["name"], "arguments": tc["params"]}
                if tool_obj is None:
                    result = {"success": False, "error": f"Unknown tool: {tc['name']}"}
                else:
                    try:
                        result = await tool_obj.execute(tc["params"])
                    except Exception as e:
                        result = {"success": False, "error": str(e)}
                is_err = isinstance(result, dict) and (result.get("success") is False or result.get("error"))
                ps = result if isinstance(result, dict) else {}
                preview = str(ps.get("title", "") or ps.get("datetime", "") or
                              ps.get("query", "") or
                              json.dumps(result, ensure_ascii=False, separators=(",", ":")))[:120]
                tool_content = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
                yield {"type": "tool_call_completed", "tool": tc["name"], "name": tc["name"],
                       "success": not is_err, "preview": preview,
                       "result": tool_content[:12000]}
                working.append({"role": "tool", "tool_call_id": call_id, "content": tool_content[:20000]})
