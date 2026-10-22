"""RuleCore FastAPI 应用入口.

独立服务（用户决定：放 src/agents/RuleCore/ 独立服务）。
挂载：
- /api/rules/*  规则引擎 API
- /static/*     独立对照演示页面
- /health       健康检查
"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.rule_engine.api import router as rules_router
from app.rule_engine.api import internal_router
from app.rule_engine.rule_verifier import validate_schema
from app.rule_engine.repositories import rule_repository as repo

logging.basicConfig(level=logging.DEBUG if settings.DEBUG else logging.INFO)
logger = logging.getLogger("rulecore")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(
    title="智训云枢 Rule Engine (RuleCore)",
    description="领域规则抽取 + 有限前向推理 + 生成约束 + A/B 对照演示",
    version="0.1.0",
)

app.add_middleware(CORSMiddleware, allow_origins=[], allow_methods=["GET", "POST"], allow_headers=[])

app.include_router(rules_router)
app.include_router(internal_router)


@app.on_event("startup")
async def _startup():
    logger.info(
        "RuleCore 启动: enabled=%s threshold=%.2f max_rounds=%d max_revision=%d",
        settings.RULE_ENGINE_ENABLED,
        settings.RULE_EXTRACT_CONFIDENCE_THRESHOLD,
        settings.MAX_REASONING_ROUNDS,
        settings.MAX_REVISION_RETRY,
    )


@app.get("/health")
async def health() -> dict:
    """健康检查：DB 连通 + 规则数量 + LLM 可用性."""
    db_ok = True
    rule_count = 0
    active_count = 0
    try:
        rules = repo.get_active_rules()
        active_count = len(rules)
    except Exception as e:  # noqa: BLE001
        db_ok = False
        active_count = -1
    return {
        "status": "ok" if db_ok else "degraded",
        "rule_engine_enabled": settings.RULE_ENGINE_ENABLED,
        "llm_available": llm_available(),
        "db": "ok" if db_ok else "error",
        "active_rules": active_count,
        "confidence_threshold": settings.RULE_EXTRACT_CONFIDENCE_THRESHOLD,
        "max_reasoning_rounds": settings.MAX_REASONING_ROUNDS,
    }


def llm_available() -> bool:
    from app.rule_engine.llm import llm
    return llm.available


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "comparison.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8201,
                reload=settings.DEBUG)
