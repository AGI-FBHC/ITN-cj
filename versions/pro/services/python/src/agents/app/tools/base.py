from abc import ABC, abstractmethod
from typing import Any, Callable, Optional


class BaseTool(ABC):
    """工具抽象基类，遵循 OpenAI function calling 协议。"""

    @property
    @abstractmethod
    def id(self) -> str:
        """工具唯一标识，与 LLM tool_calls 中的 name 对应。"""
        raise NotImplementedError

    @property
    @abstractmethod
    def name(self) -> str:
        """工具显示名称。"""
        raise NotImplementedError

    @property
    @abstractmethod
    def description(self) -> str:
        """工具描述，用于让 LLM 理解何时使用该工具。"""
        raise NotImplementedError

    @property
    def parameters_schema(self) -> Optional[dict]:
        """OpenAI tool 参数 schema；返回 None 表示该工具不需要参数。"""
        return None

    @property
    def available(self) -> bool:
        """工具当前是否可用（例如依赖的 API Key 是否已配置）。"""
        return True

    @abstractmethod
    async def execute(self, params: dict) -> Any:
        """执行工具，返回值会被 JSON 序列化后回传给 LLM。"""
        raise NotImplementedError

    def get_tool_definition(self) -> dict:
        schema = self.parameters_schema
        return {
            "type": "function",
            "function": {
                "name": self.id,
                "description": self.description,
                "parameters": schema if schema else {"type": "object", "properties": {}},
            },
        }


class ToolRegistry:
    """工具注册表。"""

    def __init__(self):
        self._tools: dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        if tool.id in self._tools:
            raise ValueError(f"Tool with id '{tool.id}' already registered")
        self._tools[tool.id] = tool

    def get(self, tool_id: str) -> Optional[BaseTool]:
        return self._tools.get(tool_id)

    def list_all(self) -> list[BaseTool]:
        return list(self._tools.values())

    def list_available(self) -> list[BaseTool]:
        return [tool for tool in self._tools.values() if tool.available]

    def get_tool_definitions(self) -> list[dict]:
        return [tool.get_tool_definition() for tool in self.list_available()]


tool_registry = ToolRegistry()


def register_tool(tool_class: Callable[..., BaseTool]):
    """工具注册装饰器：@register_tool class MyTool(BaseTool): ..."""
    tool_registry.register(tool_class())
    return tool_class