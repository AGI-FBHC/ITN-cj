"""T2.2 trace id 贯穿：跨中间件/LLM 客户端共享当前请求的 trace id。

`web/app.py` 的中间件在请求进入时把 `X-Request-Id`（无则生成）写进这里；
`llm.py` 等下游代码通过 `get_trace_id()` 读取，写入 `llm_usage_log`，
从而让同一条请求链路在 agents / KnowledgeCore / QuestionBank 的日志与记账表中
可以用同一个 trace_id 关联起来。

用 contextvars 而不是显式参数传递，避免大范围改动调用链。FastAPI/Starlette
每个请求在独立 task 中处理，在中间件里同步设置的 ContextVar 会正确传播到
该请求后续的所有 await 调用。
"""
from __future__ import annotations

import json
import logging
import sys
from contextvars import ContextVar

_trace_id_var: ContextVar[str | None] = ContextVar("trace_id", default=None)
_organization_id_var: ContextVar[str | None] = ContextVar("organization_id", default=None)

HEADER_NAME = "X-Request-Id"


def set_trace_id(trace_id: str | None) -> None:
    _trace_id_var.set(trace_id)


def get_trace_id() -> str | None:
    return _trace_id_var.get()


def set_organization_id(organization_id: str | None) -> None:
    _organization_id_var.set(organization_id)


def get_organization_id() -> str | None:
    return _organization_id_var.get()


def get_access_logger(name: str = "questionbank.access") -> logging.Logger:
    """返回只输出裸 JSON 行的 logger（不受根 logger 格式影响）。"""
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    return logger


def log_access_json(**fields) -> None:
    """输出一行结构化 JSON 访问日志（ts/service/trace_id/path/status/latency_ms 等）。"""
    try:
        get_access_logger().info(json.dumps(fields, ensure_ascii=False, default=str))
    except Exception:  # noqa: BLE001 — 日志失败绝不影响主流程
        pass
