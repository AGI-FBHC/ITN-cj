"""follow-up d：/v1/practice/questions 的 frontier_first 参数（调 KC frontier 接口）."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import questionbank.web.api as api_module
from questionbank.web.app import create_app


class FakeSettings:
    knowledge_core_url = "http://kc.test"
    knowledge_core_timeout = 5.0
    knowledge_core_domain = "agent"
    kc_internal_secret = None


class FakeKCClient:
    """monkeypatch 目标：替代真实 KnowledgeCoreClient，避免真实 HTTP 调用."""

    def __init__(self, coverage: dict | None = None, frontier: list[dict] | None = None, fail_at: str | None = None):
        self.coverage = coverage if coverage is not None else {"domain_id": 1}
        self.frontier = frontier if frontier is not None else []
        self.fail_at = fail_at
        self.closed = False
        self.frontier_calls: list[tuple[int, str]] = []

    async def fetch_coverage(self, domain: str):
        if self.fail_at == "coverage":
            raise RuntimeError("KC 覆盖接口不可达")
        return self.coverage

    async def fetch_frontier(self, domain_id: int, user_id: str):
        self.frontier_calls.append((domain_id, user_id))
        if self.fail_at == "frontier":
            raise RuntimeError("KC frontier 接口不可达")
        return self.frontier

    async def aclose(self):
        self.closed = True


# ── _resolve_frontier_category_ids（单元测试） ──────────────────────────────


def test_resolve_frontier_category_ids_success(monkeypatch):
    fake_client = FakeKCClient(
        coverage={"domain_id": 7},
        frontier=[{"category_id": 88, "name": "事务隔离级别"}, {"category_id": 90, "name": "MVCC"}],
    )
    monkeypatch.setattr(api_module, "get_settings", lambda: FakeSettings())
    monkeypatch.setattr(api_module, "KnowledgeCoreClient", lambda *a, **kw: fake_client)

    result = asyncio.run(api_module._resolve_frontier_category_ids("u1"))
    assert result == [88, 90]
    assert fake_client.frontier_calls == [(7, "u1")]
    assert fake_client.closed is True


def test_resolve_frontier_category_ids_kc_not_configured(monkeypatch):
    class NoKCSettings(FakeSettings):
        knowledge_core_url = None

    monkeypatch.setattr(api_module, "get_settings", lambda: NoKCSettings())
    result = asyncio.run(api_module._resolve_frontier_category_ids("u1"))
    assert result is None


def test_resolve_frontier_category_ids_coverage_missing_domain_id(monkeypatch):
    fake_client = FakeKCClient(coverage={})
    monkeypatch.setattr(api_module, "get_settings", lambda: FakeSettings())
    monkeypatch.setattr(api_module, "KnowledgeCoreClient", lambda *a, **kw: fake_client)
    result = asyncio.run(api_module._resolve_frontier_category_ids("u1"))
    assert result is None
    assert fake_client.closed is True


def test_resolve_frontier_category_ids_kc_unreachable_degrades(monkeypatch):
    fake_client = FakeKCClient(fail_at="frontier")
    monkeypatch.setattr(api_module, "get_settings", lambda: FakeSettings())
    monkeypatch.setattr(api_module, "KnowledgeCoreClient", lambda *a, **kw: fake_client)
    result = asyncio.run(api_module._resolve_frontier_category_ids("u1"))
    assert result is None
    assert fake_client.closed is True  # 即使失败也要关闭客户端


def test_resolve_frontier_category_ids_coverage_unreachable_degrades(monkeypatch):
    fake_client = FakeKCClient(fail_at="coverage")
    monkeypatch.setattr(api_module, "get_settings", lambda: FakeSettings())
    monkeypatch.setattr(api_module, "KnowledgeCoreClient", lambda *a, **kw: fake_client)
    result = asyncio.run(api_module._resolve_frontier_category_ids("u1"))
    assert result is None


# ── /v1/practice/questions 端到端（TestClient + fake service/store） ────────


class FakeStore:
    def __init__(self, frontier_question_ids: set[int] | None = None):
        self.frontier_question_ids = frontier_question_ids or set()

    def recent_attempt_question_ids(self, user_id, days, conn=None):
        return []

    def wrong_question_ids(self, user_id, conn=None):
        return []

    def question_ids_by_category(self, category_ids, conn=None):
        if not category_ids:
            return set()
        return self.frontier_question_ids


class FakeServiceWithStore:
    def __init__(self, pool: list[dict], store: FakeStore):
        self.pool = pool
        self.store = store

    def search(self, **kwargs):
        return {"items": self.pool, "total": len(self.pool), "page": 0, "size": 200}


@pytest.fixture
def client(monkeypatch):
    pool = [
        {"id": 1, "question_type": "single_choice", "difficulty": 2, "cognitive_level": "remember",
         "stem": "普通题1", "options": []},
        {"id": 2, "question_type": "single_choice", "difficulty": 2, "cognitive_level": "remember",
         "stem": "普通题2", "options": []},
        {"id": 3, "question_type": "single_choice", "difficulty": 3, "cognitive_level": "understand",
         "stem": "前沿题3", "options": []},
    ]
    store = FakeStore(frontier_question_ids={3})
    fake_service = FakeServiceWithStore(pool, store)
    monkeypatch.setattr(api_module, "_service", lambda: fake_service)
    app = create_app()
    with TestClient(app) as c:
        c.fake_service = fake_service  # type: ignore[attr-defined]
        yield c


def test_practice_questions_frontier_first_false_no_kc_call(client, monkeypatch):
    """默认 frontier_first=false：完全不调用 KC，行为与现状一致."""
    called = {"n": 0}

    async def fake_resolve(user_id):
        called["n"] += 1
        return None

    monkeypatch.setattr(api_module, "_resolve_frontier_category_ids", fake_resolve)
    resp = client.get("/v1/practice/questions", params={"user_id": "u1", "count": 3})
    assert resp.status_code == 200
    assert called["n"] == 0
    assert "frontier_first" not in resp.json()["strategy"]


def test_practice_questions_frontier_first_prioritizes_frontier_questions(client, monkeypatch):
    """frontier_first=true 且 KC 返回前沿知识点 → 命中题目排在其余新题之前."""

    async def fake_resolve(user_id):
        assert user_id == "u1"
        return [42]

    monkeypatch.setattr(api_module, "_resolve_frontier_category_ids", fake_resolve)
    resp = client.get(
        "/v1/practice/questions",
        params={"user_id": "u1", "count": 3, "frontier_first": "true"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["strategy"]["frontier_first"] == 1  # 命中 1 道前沿题（question 3）
    ids = [i["id"] for i in data["items"]]
    assert ids[0] == 3  # 前沿题排在最前


def test_practice_questions_frontier_first_kc_unreachable_falls_back(client, monkeypatch):
    """frontier_first=true 但 KC 不可达 → 降级为普通选题，不报错."""

    async def fake_resolve(user_id):
        return None

    monkeypatch.setattr(api_module, "_resolve_frontier_category_ids", fake_resolve)
    resp = client.get(
        "/v1/practice/questions",
        params={"user_id": "u1", "count": 3, "frontier_first": "true"},
    )
    assert resp.status_code == 200
    assert "frontier_first" not in resp.json()["strategy"]  # 未命中候选，selector 内部不加该字段
