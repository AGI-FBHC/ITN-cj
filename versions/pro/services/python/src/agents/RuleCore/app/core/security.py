from __future__ import annotations

import hashlib
import hmac
import threading
import time

from fastapi import HTTPException, Request, status

from app.core.config import settings


class _NonceStore:
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


_nonces = _NonceStore()


def _signature(secret: str, method: str, path: str, timestamp: str,
               nonce: str, caller: str, body: bytes) -> str:
    body_hash = hashlib.sha256(body).hexdigest()
    canonical = "\n".join((method.upper(), path, timestamp, nonce, caller, body_hash)).encode()
    return hmac.new(secret.encode(), canonical, hashlib.sha256).hexdigest()


async def require_internal_request(request: Request) -> None:
    secret = settings.AGENT_INTERNAL_SECRET
    if not secret:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="RuleCore internal authentication is not configured")
    timestamp = request.headers.get("X-ITN-Timestamp", "")
    nonce = request.headers.get("X-ITN-Nonce", "")
    caller = request.headers.get("X-ITN-User-Id", "")
    supplied = request.headers.get("X-ITN-Signature", "")
    if not all((timestamp, nonce, caller, supplied)) or len(nonce) > 128:
        raise HTTPException(status_code=401, detail="Internal authentication required")
    try:
        timestamp_value = int(timestamp)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid internal authentication")
    now = int(time.time())
    skew = settings.INTERNAL_AUTH_MAX_SKEW_SECONDS
    if abs(now - timestamp_value) > skew:
        raise HTTPException(status_code=401, detail="Expired internal authentication")
    expected = _signature(secret, request.method, request.url.path, timestamp, nonce, caller, await request.body())
    if not hmac.compare_digest(expected, supplied):
        raise HTTPException(status_code=401, detail="Invalid internal authentication")
    if not _nonces.consume(nonce, now, skew * 2):
        raise HTTPException(status_code=401, detail="Replayed internal request")
