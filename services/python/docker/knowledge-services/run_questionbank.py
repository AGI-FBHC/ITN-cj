from __future__ import annotations

import os

from runtime_env import configure_shared_env

configure_shared_env()

from fastapi import Request
from fastapi.responses import JSONResponse
import uvicorn

from questionbank.web.app import app


DISABLED_EXACT = {"/v1/questions/generate"}
DISABLED_PREFIXES = ("/v1/practice", "/v1/revalidation")


@app.middleware("http")
async def enforce_phase_one_features(request: Request, call_next):
    path = request.url.path.rstrip("/") or "/"
    ai_review = path.startswith("/v1/questions/") and path.endswith("/ai-review")
    disabled = path in DISABLED_EXACT or ai_review or any(path.startswith(prefix) for prefix in DISABLED_PREFIXES)
    if disabled and os.environ.get("QUESTIONBANK_ENABLE_DEFERRED_FEATURES", "false").lower() != "true":
        return JSONResponse(status_code=404, content={"detail": "该题库能力在当前阶段未开放"})
    return await call_next(request)


uvicorn.run(app, host="0.0.0.0", port=8030, workers=1)
