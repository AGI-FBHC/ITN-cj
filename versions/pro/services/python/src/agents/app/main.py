import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.routers.internal import repository, router
from app.routers.public import recover_interrupted_courses, recover_interrupted_resource_tasks, router as public_router


@asynccontextmanager
async def lifespan(_: FastAPI):
    repository()
    skip_recovery = os.environ.get("SKIP_QUEUE_RECOVERY")
    if skip_recovery and skip_recovery.lower() not in {"0", "false", "no"}:
        # Worker container handles queue processing — skip recovery here
        # so the API container can be restarted freely during development.
        yield
        return
    # 启动阶段的队列恢复是“尽力而为”：它只是把中间态任务重新排队。
    # 若数据库候选锁等待超时（1205）等临时故障，不应该把整个 API 服务拖死（BUG-024）；
    # 记录警告后继续启动，恢复逻辑会在下一次重启时重试。
    for recovery in (recover_interrupted_courses, recover_interrupted_resource_tasks):
        try:
            await recovery()
        except Exception:  # noqa: BLE001 - 启动恢复失败不应阻断服务
            logging.getLogger(__name__).warning(
                "startup queue recovery failed: %s", recovery.__name__, exc_info=True)
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version=settings.app_version,
                  docs_url="/docs" if settings.debug else None,
                  redoc_url="/redoc" if settings.debug else None, lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins,
                       allow_credentials=False, allow_methods=["*"],
                       allow_headers=["Content-Type", "Authorization", "X-ITN-Timestamp", "X-ITN-Nonce",
                                      "X-ITN-User-Id", "X-ITN-Signature"])
    app.include_router(router)
    app.include_router(public_router)

    @app.get("/health")
    async def health():
        return {"status": "healthy", "service": settings.app_name, "version": settings.app_version}

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        return JSONResponse(status_code=422, content={"code": "VALIDATION_FAILED", "details": exc.errors()})

    @app.exception_handler(Exception)
    async def unexpected_error(_: Request, __: Exception):
        return JSONResponse(status_code=500, content={"code": "INTERNAL_ERROR", "message": "Internal server error"})
    return app


app = create_app()
