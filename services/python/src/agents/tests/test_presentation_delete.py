import asyncio
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.routers import public
from app.security import InternalPrincipal


class DeleteStore:
    def __init__(self, owner, output: Path, status: str = "completed"):
        self.owner = owner
        self.output = output
        self.status = status
        self.deleted = False
        self.cancelled = False

    def get(self, task_id, user_id):
        if user_id != self.owner:
            return None
        return {"id": str(task_id), "status": self.status}

    def delete(self, task_id, user_id):
        if user_id != self.owner:
            return None
        self.deleted = True
        return str(self.output)

    def cancel(self, task_id, user_id):
        if user_id != self.owner or self.status not in {"queued", "analyzing", "generating", "reviewing"}:
            return False
        self.cancelled = True
        self.status = "cancelled"
        return True


def test_delete_presentation_removes_record_and_generated_file(tmp_path, monkeypatch):
    owner, task_id = uuid4(), uuid4()
    output = tmp_path / f"{task_id}.pptx"
    output.write_bytes(b"pptx")
    store = DeleteStore(owner, output)
    monkeypatch.setattr(public, "presentation_store", lambda: store)
    monkeypatch.setattr(
        public, "get_settings",
        lambda: SimpleNamespace(presentation_output_dir=tmp_path),
    )

    asyncio.run(public.delete_presentation(task_id, InternalPrincipal(owner)))

    assert store.deleted
    assert not output.exists()


def test_delete_presentation_rejects_active_generation(tmp_path, monkeypatch):
    owner, task_id = uuid4(), uuid4()
    store = DeleteStore(owner, tmp_path / "pending.pptx", status="generating")
    monkeypatch.setattr(public, "presentation_store", lambda: store)

    with pytest.raises(HTTPException) as error:
        asyncio.run(public.delete_presentation(task_id, InternalPrincipal(owner)))

    assert error.value.status_code == 409
    assert not store.deleted


def test_cancel_presentation_marks_task_and_cancels_background(tmp_path, monkeypatch):
    owner, task_id = uuid4(), uuid4()
    store = DeleteStore(owner, tmp_path / "pending.pptx", status="generating")
    monkeypatch.setattr(public, "presentation_store", lambda: store)

    class Background:
        def __init__(self):
            self.cancel_called = False

        def done(self):
            return False

        def cancel(self):
            self.cancel_called = True

    background = Background()
    public._presentation_tasks[task_id] = background
    result = asyncio.run(public.cancel_presentation(task_id, InternalPrincipal(owner)))

    assert store.cancelled
    assert background.cancel_called
    assert result["status"] == "cancelled"
    public._presentation_tasks.pop(task_id, None)


def test_complete_presentation_marks_learned(monkeypatch):
    owner, task_id = uuid4(), uuid4()
    store = SimpleNamespace(mark_learned=lambda _task_id, _user_id: True)
    monkeypatch.setattr(public, "presentation_store", lambda: store)
    result = asyncio.run(public.complete_presentation(task_id, InternalPrincipal(owner)))
    assert result == {"learned": True}
