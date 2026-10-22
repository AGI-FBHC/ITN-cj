"""T5.1 内部服务鉴权（QuestionBank 侧）验收测试。

覆盖点：
1. QB_INTERNAL_SECRET 未配置 → 过渡期豁免放行（并打 WARNING）。
2. 配置密钥后：无签名请求 401；带正确签名请求 200；重放同一 nonce 401。
3. web/app.py 的 wiring：真实业务路由（/v1/questions，service 用 fake 隔离 DB）确实挂了该依赖。
4. 生产环境（ENV=prod）检测到已知占位密钥 → 拒启（RuntimeError）。
"""
from __future__ import annotations

import time
from uuid import uuid4

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import questionbank.web.api as api_module
from questionbank.config import Settings, get_settings
from questionbank.security import create_signature, nonce_store, require_internal_principal
from questionbank.web.app import create_app


def _signed_headers(method: str, path: str, body: bytes, secret: str,
                    user_id: str = "caller-service", nonce: str | None = None,
                    timestamp: str | None = None) -> dict[str, str]:
    nonce = nonce or uuid4().hex
    timestamp = timestamp or str(int(time.time()))
    signature = create_signature(secret, method, path, timestamp, nonce, user_id, body)
    return {
        "X-ITN-Timestamp": timestamp,
        "X-ITN-Nonce": nonce,
        "X-ITN-User-Id": user_id,
        "X-ITN-Signature": signature,
    }


@pytest.fixture
def isolated_test_app() -> FastAPI:
    """一个只挂内部鉴权依赖的最小 app，隔离业务路由的 DB/service 依赖。"""
    app = FastAPI()

    @app.get("/protected", dependencies=[Depends(require_internal_principal)])
    async def protected():
        return {"ok": True}

    return app


@pytest.fixture(autouse=True)
def _clear_settings_cache_and_nonces():
    get_settings.cache_clear()
    nonce_store._values.clear()
    yield
    get_settings.cache_clear()
    nonce_store._values.clear()


def test_unset_secret_allows_unsigned_request_and_warns(isolated_test_app, monkeypatch, caplog):
    monkeypatch.delenv("QB_INTERNAL_SECRET", raising=False)
    get_settings.cache_clear()
    with caplog.at_level("WARNING", logger="questionbank.security"):
        with TestClient(isolated_test_app) as client:
            response = client.get("/protected")
    assert response.status_code == 200
    assert any("QB_INTERNAL_SECRET" in record.message for record in caplog.records)


def test_configured_secret_rejects_unsigned_request(isolated_test_app, monkeypatch):
    monkeypatch.setenv("QB_INTERNAL_SECRET", "a-real-shared-secret-for-tests-0001")
    get_settings.cache_clear()
    with TestClient(isolated_test_app) as client:
        response = client.get("/protected")
    assert response.status_code == 401


def test_configured_secret_accepts_valid_signature(isolated_test_app, monkeypatch):
    secret = "a-real-shared-secret-for-tests-0002"
    monkeypatch.setenv("QB_INTERNAL_SECRET", secret)
    get_settings.cache_clear()
    headers = _signed_headers("GET", "/protected", b"", secret)
    with TestClient(isolated_test_app) as client:
        response = client.get("/protected", headers=headers)
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_replayed_nonce_is_rejected(isolated_test_app, monkeypatch):
    secret = "a-real-shared-secret-for-tests-0003"
    monkeypatch.setenv("QB_INTERNAL_SECRET", secret)
    get_settings.cache_clear()
    nonce = uuid4().hex
    headers = _signed_headers("GET", "/protected", b"", secret, nonce=nonce)
    with TestClient(isolated_test_app) as client:
        first = client.get("/protected", headers=headers)
        second = client.get("/protected", headers=headers)
    assert first.status_code == 200
    assert second.status_code == 401


def test_expired_timestamp_is_rejected(isolated_test_app, monkeypatch):
    secret = "a-real-shared-secret-for-tests-0004"
    monkeypatch.setenv("QB_INTERNAL_SECRET", secret)
    get_settings.cache_clear()
    headers = _signed_headers("GET", "/protected", b"", secret, timestamp=str(int(time.time()) - 600))
    with TestClient(isolated_test_app) as client:
        response = client.get("/protected", headers=headers)
    assert response.status_code == 401


def test_wrong_secret_is_rejected(isolated_test_app, monkeypatch):
    monkeypatch.setenv("QB_INTERNAL_SECRET", "correct-secret-for-wiring-test-01")
    get_settings.cache_clear()
    headers = _signed_headers("GET", "/protected", b"", "totally-different-secret-value")
    with TestClient(isolated_test_app) as client:
        response = client.get("/protected", headers=headers)
    assert response.status_code == 401


# ── web/app.py wiring：真实业务路由确实挂了该依赖（service 用 fake 隔离 DB）─────


class _FakeService:
    def search(self, **kwargs):
        return {"total": 0, "items": [], "page": 0, "size": 20}


def test_real_app_business_route_enforces_signature_when_secret_configured(monkeypatch):
    monkeypatch.setattr(api_module, "_service", lambda: _FakeService())
    secret = "a-real-shared-secret-for-tests-0005"
    monkeypatch.setenv("QB_INTERNAL_SECRET", secret)
    get_settings.cache_clear()
    app = create_app()
    with TestClient(app) as client:
        unsigned = client.get("/v1/questions")
        assert unsigned.status_code == 401

        headers = _signed_headers("GET", "/v1/questions", b"", secret)
        signed = client.get("/v1/questions", headers=headers)
        assert signed.status_code == 200

        # health 仍豁免（公共端点）
        assert client.get("/health").status_code == 200


def test_real_app_business_route_allows_unsigned_when_secret_unset(monkeypatch):
    monkeypatch.setattr(api_module, "_service", lambda: _FakeService())
    monkeypatch.delenv("QB_INTERNAL_SECRET", raising=False)
    get_settings.cache_clear()
    app = create_app()
    with TestClient(app) as client:
        response = client.get("/v1/questions")
    assert response.status_code == 200


# ── 启动检查：ENV=prod + 已知占位密钥 → 拒启 ─────────────────────────────────


def test_prod_env_rejects_known_default_secret(monkeypatch):
    monkeypatch.setenv("ENV", "prod")
    monkeypatch.setenv("QB_INTERNAL_SECRET", "changeme")
    with pytest.raises(RuntimeError):
        Settings()


def test_prod_env_rejects_known_default_kc_secret(monkeypatch):
    monkeypatch.setenv("ENV", "prod")
    monkeypatch.delenv("QB_INTERNAL_SECRET", raising=False)
    monkeypatch.setenv("KC_INTERNAL_SECRET", "secret")
    with pytest.raises(RuntimeError):
        Settings()


def test_prod_env_accepts_real_secret(monkeypatch):
    monkeypatch.setenv("ENV", "prod")
    monkeypatch.setenv("QB_INTERNAL_SECRET", "a-real-random-secret-not-in-the-known-list")
    Settings()  # 不应抛出


def test_dev_env_allows_known_default_secret(monkeypatch):
    monkeypatch.setenv("ENV", "dev")
    monkeypatch.setenv("QB_INTERNAL_SECRET", "changeme")
    Settings()  # dev 环境不拒启（过渡期仍可联调）
