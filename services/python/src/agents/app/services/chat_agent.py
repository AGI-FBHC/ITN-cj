"""
Chat Agent - 支持工具调用的对话智能体。

工作流程：先以流式方式调用 LLM（携带工具定义），若 LLM 返回 tool_calls，
则执行对应工具并把结果追加到上下文，然后再次调用 LLM 生成最终回答，
循环直至没有工具调用或达到最大迭代次数。
"""
import json
from collections.abc import AsyncIterator
from typing import Any

import app.tools  # noqa: F401  导入即注册全部内置工具
from app.llm import LLMClient
from app.tools.base import BaseTool, tool_registry

_TOOL_RESULT_MAX_CHARS = 20000


class ChatAgent:
    """具备工具调用能力的对话智能体。"""

    def __init__(self, llm: LLMClient, max_iterations: int = 4, provider: str = "kimi"):
        self.llm = llm
        self.max_iterations = max(1, max_iterations)
        self.provider = provider

    @staticmethod
    def _available_tools() -> list[BaseTool]:
        return tool_registry.list_available()

    async def stream(self, messages: list[dict[str, Any]],
                     include_reasoning: bool = False) -> AsyncIterator[dict[str, Any]]:
        working = list(messages)
        tools = self._available_tools()
        tool_definitions = [tool.get_tool_definition() for tool in tools]
        iteration = 0
        while True:
            allow_tools = bool(tool_definitions) and iteration < self.max_iterations
            calls: list[dict[str, Any]] = []
            try:
                async for chunk in self.llm.stream_chat_with_tools(
                        working, tool_definitions if allow_tools else None, include_reasoning, self.provider):
                    if chunk["type"] == "tool_calls":
                        calls = chunk["calls"]
                    else:
                        yield chunk
            except Exception:
                return
            if not calls:
                return
            iteration += 1
            working.append({
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": call["id"] or f"call_{index}",
                        "type": "function",
                        "function": {"name": call["name"], "arguments": call["arguments"] or "{}"},
                    }
                    for index, call in enumerate(calls)
                ],
            })
            for index, call in enumerate(calls):
                tool = tool_registry.get(call["name"])
                call_id = call["id"] or f"call_{index}"
                arguments = _parse_arguments(call["arguments"])
                yield {
                    "type": "tool_call_started",
                    "tool": call["name"],
                    "name": tool.name if tool else call["name"],
                    "arguments": arguments,
                }
                if tool is None:
                    result: Any = {"success": False, "error": f"Unknown tool: {call['name']}"}
                else:
                    try:
                        result = await tool.execute(arguments)
                    except Exception as exc:
                        result = {"success": False, "error": str(exc)}
                yield {
                    "type": "tool_call_completed",
                    "tool": call["name"],
                    "name": tool.name if tool else call["name"],
                    "success": _is_success(result),
                    "preview": _preview(result),
                }
                working.append({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": _serialize(result),
                })

    async def run(self, messages: list[dict[str, Any]],
                  include_reasoning: bool = False) -> tuple[str, str | None]:
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        async for event in self.stream(messages, include_reasoning):
            if event["type"] == "content":
                content_parts.append(event["text"])
            elif event["type"] == "reasoning":
                reasoning_parts.append(event["text"])
        return "".join(content_parts), ("".join(reasoning_parts) or None)


def _parse_arguments(raw: str) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _is_success(result: Any) -> bool:
    if isinstance(result, dict):
        if result.get("success") is False:
            return False
        if result.get("error"):
            return False
    return True


def _serialize(result: Any) -> str:
    text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
    return text[:_TOOL_RESULT_MAX_CHARS]


def _preview(result: Any) -> str:
    if isinstance(result, str):
        return result[:120]
    if not isinstance(result, dict):
        return str(result)[:120]
    if result.get("error"):
        return str(result["error"])[:120]
    if result.get("datetime"):
        parts = [result["datetime"]]
        if result.get("weekday"):
            parts.append(result["weekday"])
        return " ".join(parts)[:120]
    if "count" in result and "query" in result:
        return f"找到 {result['count']} 条与「{result['query']}」相关的结果"
    if result.get("title"):
        return str(result["title"])[:120]
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))[:120]