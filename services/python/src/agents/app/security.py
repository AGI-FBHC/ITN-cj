import hashlib
import hmac
import threading
import time

import jwt
from dataclasses import dataclass
from uuid import UUID

from fastapi import HTTPException, Request, status

from app.config import Settings, get_settings




@dataclass(frozen=True)
class InternalPrincipal:
    user_id: UUID


class NonceStore:
    def __init__(self):
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


async def require_internal_principal(request: Request) -> InternalPrincipal:
    settings: Settings = get_settings()
    timestamp = request.headers.get("X-ITN-Timestamp", "")
    nonce = request.headers.get("X-ITN-Nonce", "")
    user_id = request.headers.get("X-ITN-User-Id", "")
    signature = request.headers.get("X-ITN-Signature", "")
    if not all((timestamp, nonce, user_id, signature)) or len(nonce) > 128:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Internal authentication required")
    try:
        timestamp_value = int(timestamp)
        parsed_user_id = UUID(user_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid internal authentication")
    now = int(time.time())
    if abs(now - timestamp_value) > settings.internal_auth_max_skew_seconds:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Expired internal authentication")
    body = await request.body()
    expected = create_signature(settings.agent_internal_secret, request.method, request.url.path,
                                timestamp, nonce, user_id, body)
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid internal authentication")
    if not nonce_store.consume(nonce, now, settings.internal_auth_max_skew_seconds * 2):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Replayed internal request")
    return InternalPrincipal(parsed_user_id)


async def require_user_principal(request: Request) -> InternalPrincipal:
    settings: Settings = get_settings()
    if not settings.jwt_secret:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="User authentication is not configured")
    authorization = request.headers.get("Authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")
    try:
        claims = jwt.decode(token.strip(), settings.jwt_secret, algorithms=["HS256", "HS384", "HS512"])
        user_id = UUID(claims["sub"])
    except (jwt.PyJWTError, ValueError, KeyError, TypeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    return InternalPrincipal(user_id)
