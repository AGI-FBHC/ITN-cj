import asyncio
from uuid import uuid4

from app.routers import public
from app.security import InternalPrincipal


class _SummaryTask:
    def __init__(self):
        self.id = uuid4()
        self.owner = uuid4()
        self._calls = []

    def available(self):
        return True

    def list(self, user_id, limit, *, summary, exclude_course=False):
        self._calls.append((user_id, limit, summary, exclude_course))
        return [
            {
                "id": str(self.id), "title": "Sample", "status": "completed",
                "progress": 100, "stageMessage": "完成", "errorMessage": None,
                "downloadUrl": f"/v1/presentations/{self.id}/download",
                "createdAt": "2026-07-27T00:00:00", "updatedAt": "2026-07-27T00:00:00",
            }
        ]


def test_list_presentations_defaults_to_summary(monkeypatch):
    store = _SummaryTask()
    monkeypatch.setattr(public, "presentation_store", lambda: store)
    result = asyncio.run(public.list_presentations(principal=InternalPrincipal(store.owner)))
    assert result["tasks"][0]["id"] == str(store.id)
    assert result["tasks"][0].get("events") is None
    assert result["tasks"][0].get("outline") is None
    assert store._calls and store._calls[0][2] is True


def test_list_presentations_full_mode(monkeypatch):
    store = _SummaryTask()
    monkeypatch.setattr(public, "presentation_store", lambda: store)
    asyncio.run(public.list_presentations(summary=False, limit=5, principal=InternalPrincipal(store.owner)))
    assert store._calls[0][2] is False
    assert store._calls[0][1] == 5


def test_list_presentations_clamps_limit(monkeypatch):
    store = _SummaryTask()
    monkeypatch.setattr(public, "presentation_store", lambda: store)
    asyncio.run(public.list_presentations(limit=9999, principal=InternalPrincipal(store.owner)))
    assert store._calls[0][1] == 100


def test_list_presentations_lower_limit_clamped(monkeypatch):
    store = _SummaryTask()
    monkeypatch.setattr(public, "presentation_store", lambda: store)
    asyncio.run(public.list_presentations(limit=0, principal=InternalPrincipal(store.owner)))
    assert store._calls[0][1] == 1
def test_list_presentations_excludes_course(monkeypatch):
    store = _SummaryTask()
    monkeypatch.setattr(public, "presentation_store", lambda: store)
    asyncio.run(public.list_presentations(exclude_course=True, principal=InternalPrincipal(store.owner)))
    assert store._calls[0][3] is True


def test_row_has_course_context():
    from app.presentations.store import PresentationStore
    assert PresentationStore._row_has_course_context({'request_json': '{"generationContext": {"courseId": "c1"}}'}) is True
    assert PresentationStore._row_has_course_context({'request_json': '{"generationContext": {}}'}) is False
    assert PresentationStore._row_has_course_context({"request_json": "not-json"}) is False
    assert PresentationStore._row_has_course_context({}) is False
