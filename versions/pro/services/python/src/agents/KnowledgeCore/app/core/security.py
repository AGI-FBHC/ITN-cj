"""T5.1 内部服务鉴权（KnowledgeCore 侧）。

与 `src/agents/app/security.py`（agents 服务的实现）保持零共享依赖，独立复制一份，
避免跨服务引入包依赖。HMAC 校验语义完全一致：

    canonical_request = METHOD \n PATH \n TIMESTAMP \n NONCE \n USER_ID \n sha256(BODY)
    signature = HMAC-SHA256(secret, canonical_request)

过渡期语义：`KC_INTERNAL_SECRET` 未配置时跳过校验并打 WARNING（保证不瞬间打断现有联调）；
一旦配置该变量，所有业务路由强制要求四个请求头
（`X-ITN-Timestamp` / `X-ITN-Nonce` / `X-ITN-User-Id` / `X-ITN-Signature`）。
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import threading
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request, status

from app.core.config import Settings, get_settings

logger = logging.getLogger("knowledgecore.security")


@dataclass(frozen=True)
class InternalPrincipal:
    """内部调用方身份（服务间调用，caller 为调用方自报的标识字符串，非最终用户）。"""

    caller: str


class NonceStore:
    """内存版一次性 nonce 存储（进程级防重放，足够覆盖单实例部署）。"""

    def __init__(self) -> None:
        self._values: dict[str, int] = {}
        self._lock = threading.Lock()

    def consume(self, nonce: str, now: int, ttl: int) -> bool:
        with self._lock:
            self._values = {key: expiry for key, expiry in self._values.items() if expiry >= now}
            if nonce in self._values:
                return False
            self._values[nonce] = now + ttl
            return True


nonce_store = NonceStore()


def body_hash(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def canonical_request(method: str, path: str, timestamp: str, nonce: str,
                      user_id: str, body: bytes) -> bytes:
    return "\n".join((method.upper(), path, timestamp, nonce, user_id, body_hash(body))).encode()


def create_signature(secret: str, method: str, path: str, timestamp: str,
                     nonce: str, user_id: str, body: bytes) -> str:
    return hmac.new(secret.encode(), canonical_request(method, path, timestamp, nonce, user_id, body),
                    hashlib.sha256).hexdigest()


async def require_internal_principal(request: Request) -> InternalPrincipal | None:
    """FastAPI 依赖：校验内部服务调用签名。

    过渡期：`settings.KC_INTERNAL_SECRET` 未配置 → 跳过校验，打 WARNING，返回 None。
    配置后：强制四个请求头齐全、时间戳不过期、签名匹配、nonce 未被重放，否则 401。
    """
    settings: Settings = get_settings()
    secret = settings.KC_INTERNAL_SECRET
    if not secret:
        logger.warning(
            "KC_INTERNAL_SECRET 未配置：内部服务鉴权处于豁免状态（过渡期），"
            "生产环境务必配置该变量以启用签名校验 path=%s",
            request.url.path,
        )
        return None

    timestamp = request.headers.get("X-ITN-Timestamp", "")
    nonce = request.headers.get("X-ITN-Nonce", "")
    user_id = request.headers.get("X-ITN-User-Id", "")
    signature = request.headers.get("X-ITN-Signature", "")
    if not all((timestamp, nonce, user_id, signature)) or len(nonce) > 128:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Internal authentication required")
    try:
        timestamp_value = int(timestamp)
    except (ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid internal authentication")

    now = int(time.time())
    max_skew = settings.INTERNAL_AUTH_MAX_SKEW_SECONDS
    if abs(now - timestamp_value) > max_skew:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Expired internal authentication")

    body = await request.body()
    expected = create_signature(secret, request.method, request.url.path, timestamp, nonce, user_id, body)
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid internal authentication")

    if not nonce_store.consume(nonce, now, max_skew * 2):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Replayed internal request")

    return InternalPrincipal(caller=user_id)
