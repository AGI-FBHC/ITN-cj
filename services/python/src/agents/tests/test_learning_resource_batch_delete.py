import asyncio
from datetime import datetime
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.routers import public
from app.security import InternalPrincipal
from app.storage.learning_resources import LearningResourceStore
import app.storage.learning_resources as learning_resources_module


class _ResourceStore:
    def __init__(self, deleted=None):
        self.deleted = deleted or []
        self.calls = []

    def batch_delete(self, resource_ids, user_id):
        self.calls.append((list(resource_ids), user_id))
        return self.deleted


def _principal():
    return InternalPrincipal(uuid4())


@pytest.mark.parametrize("payload", [
    {"resourceIds": []},
    {"resourceIds": ["not-a-uuid"]},
    {"resourceIds": [str(uuid4()) for _ in range(101)]},
])
def test_batch_delete_learning_resources_rejects_invalid_payload(payload):
    with pytest.raises(HTTPException) as error:
        asyncio.run(public.batch_delete_learning_resources(payload, _principal()))
    assert error.value.status_code == 422


def test_complete_learning_resource_marks_learned(monkeypatch):
    resource_id = uuid4()
    store = _ResourceStore()
    store.mark_learned = lambda _resource_id, _user_id: {"type": "lecture", "content": {}, "state": {"learned": True}, "title": "讲义"}
    monkeypatch.setattr(public, "learning_resource_store", lambda: store)
    result = asyncio.run(public.complete_learning_resource(resource_id, _principal()))
    assert result["learned"] is True
    assert result["resource"]["state"]["learned"] is True


def test_resource_summary_marks_saved_progress_as_started_but_not_learned():
    store = LearningResourceStore.__new__(LearningResourceStore)
    row = {
        "id": uuid4().bytes, "resource_type": "lecture", "title": "讲义", "topic": "Agent",
        "learning_goal_id": None, "learner_id": None, "kp_id": "kp-1", "form": "lecture",
        "level": None, "version": None, "quiz_ids_json": "[]", "kb_refs_json": "[]",
        "course_id": None, "chapter_id": None, "sources_json": "[]",
        "state_json": '{"progress":{"currentBlockId":"section-2","visitedBlockIds":["section-1"],"elapsedSeconds":18}}',
        "context_json": "{}", "decision_json": "{}", "created_at": datetime.now(), "updated_at": datetime.now(),
    }
    result = store._serialize(row, summary=True)
    assert result["started"] is True
    assert result["learned"] is False


def test_resource_create_rejects_nonexistent_owner_before_insert(monkeypatch):
    executed = []

    class Cursor:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def execute(self, sql, args): executed.append((sql, args))
        def fetchone(self): return None

    class Connection:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def cursor(self): return Cursor()
        def commit(self): raise AssertionError("invalid owner must not commit")

    store = LearningResourceStore.__new__(LearningResourceStore)
    store.settings = object()
    store._schema_ready = True
    monkeypatch.setattr(learning_resources_module, "platform_connect", lambda _settings: Connection())

    with pytest.raises(ValueError, match="Resource owner does not exist"):
        store.create(
            uuid4(), "lecture", {"title": "测试", "topic": "Agent"},
            {"chapters": []}, [],
        )

    assert len(executed) == 1
    assert "FROM users WHERE id=%s" in executed[0][0]


def test_update_learning_resource_progress_returns_merged_resource(monkeypatch):
    resource_id = uuid4()
    store = _ResourceStore()
    store.update_progress = lambda _resource_id, _user_id, progress: {
        "type": "lecture", "content": {}, "title": "讲义",
        "state": {"progress": {"currentBlockId": progress["current_block_id"]}},
    }
    monkeypatch.setattr(public, "learning_resource_store", lambda: store)
    request = public.LearningResourceProgressRequest(
        currentBlockId="section-2", visitedBlockIds=["section-1", "section-2"], elapsedSeconds=96,
    )
    result = asyncio.run(public.update_learning_resource_progress(resource_id, request, _principal()))
    assert result["resource"]["state"]["progress"]["currentBlockId"] == "section-2"


def test_learning_resource_source_feedback_is_scoped_and_persisted(monkeypatch):
    resource_id = uuid4()
    principal = _principal()
    store = _ResourceStore()
    captured = {}

    def create_feedback(requested_id, user_id, payload):
        captured.update(resource_id=requested_id, user_id=user_id, payload=payload)
        return {"id": str(uuid4()), "resourceId": str(requested_id), "status": "submitted"}

    store.create_source_feedback = create_feedback
    monkeypatch.setattr(public, "learning_resource_store", lambda: store)
    request = public.LearningResourceSourceFeedbackRequest(
        sourceId="WEB-003", issueType="mismatch", note="当前论断与来源摘要不一致",
    )
    result = asyncio.run(public.create_learning_resource_source_feedback(resource_id, request, principal))
    assert result["feedback"]["status"] == "submitted"
    assert captured["resource_id"] == resource_id
    assert captured["user_id"] == principal.user_id
    assert captured["payload"]["source_id"] == "WEB-003"


def test_learning_resource_summary_exposes_persisted_learning_state():
    now = datetime.utcnow()
    resource_id = uuid4()
    store = LearningResourceStore.__new__(LearningResourceStore)
    row = {
        "id": resource_id.bytes, "resource_type": "lecture", "title": "真实讲义", "topic": "算法评测",
        "learning_goal_id": None, "learner_id": None, "kp_id": None, "form": None, "level": None,
        "version": None, "quiz_ids_json": "[]", "kb_refs_json": "[]", "course_id": None,
        "chapter_id": None, "sources_json": "[]", "state_json": '{"learned":true,"learnedAt":"2026-08-09T10:00:00"}',
        "context_json": "{}", "decision_json": "{}", "created_at": now, "updated_at": now,
    }
    result = store._serialize(row, summary=True)
    assert result["learned"] is True
    assert result["learnedAt"] == "2026-08-09T10:00:00"
    assert "content" not in result

def test_batch_delete_learning_resources_deduplicates_and_scopes_user(monkeypatch):
    resource_id = uuid4()
    store = _ResourceStore([str(resource_id)])
    monkeypatch.setattr(public, "learning_resource_store", lambda: store)
    principal = _principal()
    result = asyncio.run(public.batch_delete_learning_resources(
        {"resourceIds": [str(resource_id), str(resource_id)]}, principal,
    ))
    assert result == {"deleted": [str(resource_id)], "count": 1}
    assert store.calls == [([resource_id], principal.user_id)]


def test_learning_resource_routes_bind_batch_delete_and_complete_separately():
    routes = {
        (route.path, method)
        for route in public.router.routes
        for method in getattr(route, "methods", set())
    }
    assert ("/v1/learning-resources/batch-delete", "POST") in routes
    assert ("/v1/learning-resources/{resource_id}/complete", "POST") in routes


def test_traceability_keeps_source_identity_and_url():
    result = public._build_traceability({
        "sources": [{
            "id": 7,
            "document": "算法复杂度参考",
            "type": "websearch",
            "url": "https://example.test/complexity",
            "similarity": 0.72,
            "content": "复杂度分析内容",
        }],
        "content": {"sections": [{"title": "大 O 表示法", "citations": [7]}]},
    })
    assert result[0]["id"] == "7"
    assert result[0]["url"] == "https://example.test/complexity"
