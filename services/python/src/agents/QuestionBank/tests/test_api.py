"""题库管理端 API 测试（TestClient + fake service，不落库）."""
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import questionbank.web.api as api_module
from questionbank.services.question.generator import GenerationRejected
from questionbank.web.app import create_app


class FakeService:
    """行为可编程的假 service."""

    def __init__(self):
        self.created = []
        self.searched = {"total": 0, "items": [], "page": 0, "size": 20}
        self.status_updates = []
        self.raise_create = None
        self.raise_search = None
        self.raise_status = None

    def create(self, data, conn=None):
        if self.raise_create:
            raise self.raise_create
        record = {"id": 1001, "status": data.status, "stem": data.stem}
        self.created.append(record)
        return record

    def search(self, **kwargs):
        if self.raise_search:
            raise self.raise_search
        return self.searched

    def get(self, question_id, conn=None):
        return {"id": question_id, "stem": "详情题"}

    def update(self, question_id, data, conn=None):
        return {"id": question_id, "updated": True}

    def delete(self, question_id, conn=None):
        return None

    def set_status(self, question_id, status, conn=None):
        if self.raise_status:
            raise self.raise_status
        if status not in ("active", "rejected", "deprecated", "proposed"):
            from questionbank.services.question import ValidationError

            raise ValidationError(f"非法状态: {status}")
        self.status_updates.append((question_id, status))
        return {"id": question_id, "status": status}

    def import_batch(self, items, conn=None):
        return {"created": [{"index": 0, "question_id": 2001}], "skipped": [], "failed": []}


@pytest.fixture
def client(monkeypatch):
    fake = FakeService()
    monkeypatch.setattr(api_module, "_service", lambda: fake)
    monkeypatch.setattr(api_module, "_generator", lambda: SimpleNamespace())
    app = create_app()
    with TestClient(app) as c:
        c.fake = fake  # type: ignore[attr-defined]
        yield c


def payload():
    return {
        "question_type": "single_choice",
        "difficulty": 3,
        "cognitive_level": "understand",
        "stem": "MCP 传输方式？",
        "options": [{"key": "A", "text": "stdio"}, {"key": "B", "text": "SSE"}, {"key": "C", "text": "HTTP"}],
        "reference_answer": "A",
        "explanation": "解析",
    }


class TestHealth:
    def test_health(self):
        from fastapi.testclient import TestClient

        with TestClient(create_app()) as c:
            resp = c.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "healthy"


class TestQuestions:
    def test_create_201(self, client):
        resp = client.post("/v1/questions", json=payload())
        assert resp.status_code == 201
        assert resp.json()["id"] == 1001

    def test_create_validation_422(self, client):
        bad = payload()
        bad["question_type"] = "essay"
        resp = client.post("/v1/questions", json=bad)
        assert resp.status_code == 422

    def test_create_duplicate_409(self, client, monkeypatch):
        from questionbank.services.question import DuplicateQuestionError

        monkeypatch.setattr(api_module, "_service", lambda: FakeService() if False else _dup_service())
        resp = client.post("/v1/questions", json=payload())
        assert resp.status_code == 409

    def test_list_with_filters(self, client):
        client.fake.searched = {"total": 1, "items": [{"id": 7}], "page": 0, "size": 20}
        resp = client.get("/v1/questions", params={"category_id": 72, "status": "active"})
        assert resp.status_code == 200
        assert resp.json()["total"] == 1

    def test_review_flow(self, client):
        resp = client.post("/v1/questions/1001/review", params={"status": "active"})
        assert resp.status_code == 200
        assert client.fake.status_updates == [(1001, "active")]

    def test_review_illegal_status(self, client):
        resp = client.post("/v1/questions/1001/review", params={"status": "deleted"})
        assert resp.status_code == 422  # 服务层 ValidationError → 422

    def test_deprecate(self, client):
        resp = client.post("/v1/questions/1001/deprecate")
        assert resp.status_code == 200
        assert resp.json()["status"] == "deprecated"

    def test_delete(self, client):
        resp = client.delete("/v1/questions/1001")
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True

    def test_import(self, client):
        resp = client.post("/v1/questions/import", json=[payload()])
        assert resp.status_code == 200
        assert resp.json()["created"][0]["question_id"] == 2001


class TestGenerate:
    def test_generate_rejected_when_insufficient(self, client, monkeypatch):
        async def fake_generate(kc, **kwargs):
            raise GenerationRejected("QUESTION_GENERATION_INSUFFICIENT_EVIDENCE", "覆盖度不足")

        monkeypatch.setattr(
            api_module,
            "_generator",
            lambda: SimpleNamespace(generate=fake_generate),
        )

        class FakeKC:
            async def aclose(self):
                pass

        monkeypatch.setattr(api_module, "_knowledge_core", lambda: FakeKC())
        resp = client.post(
            "/v1/questions/generate",
            json={"knowledge_point": "MCP传输方式", "difficulty": 3, "count": 3},
        )
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "QUESTION_GENERATION_INSUFFICIENT_EVIDENCE"

    def test_generate_ok(self, client, monkeypatch):
        async def fake_generate(kc, **kwargs):
            return {"created": [{"index": 0, "question_id": 9}], "skipped": [], "failed": []}

        class FakeKC:
            async def aclose(self):
                pass

        monkeypatch.setattr(api_module, "_generator", lambda: SimpleNamespace(generate=fake_generate))
        monkeypatch.setattr(api_module, "_knowledge_core", lambda: FakeKC())
        resp = client.post(
            "/v1/questions/generate",
            json={"category_id": 72, "difficulty": 3, "count": 1},
        )
        assert resp.status_code == 200
        assert resp.json()["created"][0]["question_id"] == 9


def _dup_service():
    from questionbank.services.question import DuplicateQuestionError

    class Dup(FakeService):
        def create(self, data, conn=None):
            raise DuplicateQuestionError("重复")

    return Dup()


def test_duplicate_service():
    from questionbank.services.question import DuplicateQuestionError

    with pytest.raises(DuplicateQuestionError):
        _dup_service().create(payload())
