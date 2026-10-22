import asyncio
import json
from datetime import datetime
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.domain.models import TeachingGroupRunRequest
from app.routers import public
from app.security import InternalPrincipal
from app.storage.teaching_group_runs import TeachingGroupRunStore


def _principal():
    return InternalPrincipal(uuid4())


def test_teaching_group_run_serialization_keeps_replay_summary():
    run_id, learner_id = uuid4(), uuid4()
    now = datetime.utcnow()
    row = {
        "id": run_id.bytes,
        "learner_id": learner_id.bytes,
        "knowledge_point_id": "kp-ds",
        "mode": "prepare_next",
        "prompt": None,
        "status": "completed",
        "events_json": json.dumps([{"type": "run_started"}, {"type": "run_completed"}]),
        "result_json": json.dumps({
            "diagnosis": {"focus": "数据结构与算法"},
            "decision": {"nextAction": "先完成复杂度分析讲义"},
        }),
        "error_code": None,
        "created_at": now,
        "updated_at": now,
    }
    store = TeachingGroupRunStore.__new__(TeachingGroupRunStore)
    result = store._serialize(row, include_events=True)
    assert result["id"] == str(run_id)
    assert result["eventCount"] == 2
    assert result["focus"] == "数据结构与算法"
    assert result["nextAction"] == "先完成复杂度分析讲义"
    assert len(result["events"]) == 2
    summary = store._serialize(row, include_events=False)
    assert "events" not in summary
    assert "result" not in summary


def test_teaching_group_history_endpoints_scope_current_user(monkeypatch):
    principal = _principal()
    run_id, learner_id = uuid4(), uuid4()

    class Store:
        def list(self, user_id, limit, requested_learner_id):
            assert user_id == principal.user_id
            assert limit == 12
            assert requested_learner_id == learner_id
            return [{"id": str(run_id)}]

        def get(self, requested_id, user_id):
            assert user_id == principal.user_id
            return {"id": str(requested_id), "events": []} if requested_id == run_id else None

    monkeypatch.setattr(public, "teaching_group_run_store", lambda: Store())
    listed = asyncio.run(public.list_teaching_group_runs(12, learner_id, principal))
    assert listed == {"runs": [{"id": str(run_id)}]}
    loaded = asyncio.run(public.get_teaching_group_run(run_id, principal))
    assert loaded["id"] == str(run_id)
    with pytest.raises(HTTPException) as error:
        asyncio.run(public.get_teaching_group_run(uuid4(), principal))
    assert error.value.status_code == 404


def test_teaching_group_stream_persists_every_event(monkeypatch):
    principal = _principal()
    learner_id = uuid4()
    calls = []

    class Store:
        def create(self, run_id, user_id, request):
            calls.append(("create", run_id, user_id, request.learner_id))

        def record_event(self, run_id, user_id, event):
            calls.append(("event", run_id, user_id, event["type"]))

        def mark_interrupted(self, run_id, user_id):
            calls.append(("interrupted", run_id, user_id))

    class Service:
        async def stream(self, user_id, request):
            yield {"type": "run_started", "data": {}}
            yield {"type": "agent_output", "agent": "DIA-01", "data": {"focus": "数据库"}}
            yield {"type": "run_completed", "data": {"decision": {"decision": "accept"}}}

    monkeypatch.setattr(public, "teaching_group_run_store", lambda: Store())
    monkeypatch.setattr(public, "teaching_group_service", lambda: Service())
    request = TeachingGroupRunRequest(learnerId=learner_id, mode="prepare_next")

    async def consume():
        response = await public.stream_teaching_group(request, principal)
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
        return "".join(chunks)

    body = asyncio.run(consume())
    assert "run_started" in body and "run_completed" in body
    assert [call[3] for call in calls if call[0] == "event"] == [
        "run_started", "agent_output", "run_completed",
    ]
    assert not any(call[0] == "interrupted" for call in calls)
    run_ids = {call[1] for call in calls}
    assert len(run_ids) == 1
