"""ITN Knowledge Core - FastAPI Application."""

import time
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.core.config import get_settings
from app.core.request_context import HEADER_NAME, log_access_json, set_trace_id
from app.core.security import require_internal_principal
from app.api.v1.router import api_router

settings = get_settings()

app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_PREFIX}/openapi.json",
    description="ITN Knowledge Core - 领域包驱动的规则-证据双轨知识决策内核",
    version="0.1.0",
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    """T2.2：贯穿 trace id（读取/生成 X-Request-Id），响应头回带 + 结构化访问日志。"""
    trace_id = request.headers.get(HEADER_NAME) or str(uuid.uuid4())
    request.state.trace_id = trace_id
    set_trace_id(trace_id)
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
            ts=time.time(), service="knowledgecore", trace_id=trace_id,
            path=request.url.path, status=status_code, latency_ms=latency_ms,
        )
        set_trace_id(None)


# API routes
# T5.1：全部业务路由（/api/v1/**）挂内部服务鉴权依赖；health/docs/static 等公共端点豁免。
# KC_INTERNAL_SECRET 未配置时该依赖直接放行并打 WARNING（过渡期，见 core/security.py）。
app.include_router(api_router, dependencies=[Depends(require_internal_principal)])

# Static files
static_dir = Path(__file__).parent.parent / "static"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/health")
async def health_check() -> dict[str, str]:
    """Health check endpoint."""
    return {"status": "ok"}


@app.get("/")
async def root():
    """Serve the test frontend."""
    index_path = static_dir / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return {
        "message": "ITN Knowledge Core API",
        "docs": f"{settings.API_V1_PREFIX}/docs",
        "health": "/health",
    }


@app.get("/graph.html")
async def graph_page():
    """Serve the knowledge graph console (review + edge overview + DAG)."""
    graph_path = static_dir / "graph.html"
    if graph_path.exists():
        return FileResponse(str(graph_path))
    return {"message": "graph.html not found"}


@app.get("/evidence/datasets", dependencies=[Depends(require_internal_principal)])
async def list_datasets():
    """List available RAGFlow datasets."""
    from app.evidence.services.ragflow_retriever import RAGFlowRetriever

    retriever = RAGFlowRetriever()
    try:
        datasets = retriever.list_datasets()
        return {"datasets": datasets}
    except Exception as e:
        return {"error": str(e), "datasets": []}
