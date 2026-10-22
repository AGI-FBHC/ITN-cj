"""T2.2 trace id 贯穿：X-Request-Id 中间件测试（生成/透传 + 响应头回带）。"""
from fastapi.testclient import TestClient

from questionbank.web.app import create_app


def _client() -> TestClient:
    return TestClient(create_app())


def test_health_response_has_generated_request_id():
    with _client() as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert "X-Request-Id" in response.headers
    assert response.headers["X-Request-Id"]


def test_incoming_request_id_is_passed_through():
    incoming = "qb-test-trace-id-12345"
    with _client() as client:
        response = client.get("/health", headers={"X-Request-Id": incoming})
    assert response.status_code == 200
    assert response.headers["X-Request-Id"] == incoming


def test_two_requests_get_different_generated_ids():
    with _client() as client:
        first = client.get("/health").headers["X-Request-Id"]
        second = client.get("/health").headers["X-Request-Id"]
    assert first != second
