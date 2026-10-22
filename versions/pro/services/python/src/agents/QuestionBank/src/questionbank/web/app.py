"""QuestionBank Web 服务入口（uvicorn questionbank.web.app:app --port 8001）.

- /v1/** API 路由（题库管理 / 学习端 / 重校验）
- / 静态前端（static/index.html：刷题 / 新增题 / 审核）
"""
import time
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from questionbank import __version__
from questionbank.request_context import HEADER_NAME, log_access_json, set_organization_id, set_trace_id
from questionbank.security import require_internal_principal
from questionbank.web.api import practice_router, revalidation_router, router

STATIC_DIR = Path(__file__).resolve().parent.parent.parent.parent / "static"


def create_app() -> FastAPI:
    app = FastAPI(
        title="ITN QuestionBank",
        version=__version__,
        description="题库独立模块：题目管理 / AI 出题 / 刷题（Knowledge Core 是唯一知识入口）",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        """T2.2：贯穿 trace id（读取/生成 X-Request-Id），响应头回带 + 结构化访问日志。"""
        trace_id = request.headers.get(HEADER_NAME) or str(uuid.uuid4())
        request.state.trace_id = trace_id
        set_trace_id(trace_id)
        set_organization_id(request.headers.get("X-ITN-Organization-Id"))
        started = time.perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            response.headers[HEADER_NAME] = trace_id
            return response
        finally:
            latency_ms = int((time.perf_counter() - started) * 1000)
            log_access_json(
                ts=time.time(), service="questionbank", trace_id=trace_id,
                path=request.url.path, status=status_code, latency_ms=latency_ms,
            )
            set_trace_id(None)
            set_organization_id(None)

    # T5.1：全部业务路由挂内部服务鉴权依赖；health/静态前端豁免。
    # QB_INTERNAL_SECRET 未配置时该依赖直接放行并打 WARNING（过渡期，见 security.py）。
    _internal_auth = [Depends(require_internal_principal)]
    app.include_router(router, dependencies=_internal_auth)
    app.include_router(practice_router, dependencies=_internal_auth)
    app.include_router(revalidation_router, dependencies=_internal_auth)

    @app.get("/health")
    async def health():
        return {"status": "healthy", "service": "questionbank", "version": __version__}

    # 静态前端兜底（放在最后，避免抢 API 路由）
    if STATIC_DIR.exists():
        app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

    return app


app = create_app()
