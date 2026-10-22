import asyncio
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.routers import public
from app.security import InternalPrincipal


class _BatchStore:
    """Stub store exercising batch_delete contract."""

    def __init__(self, *, available=True, raises=None, returns=None):
        self.available_value = available
        self.raises = raises
        self.returns = returns or []
        self.calls = []

    def available(self):
        return self.available_value

    def batch_delete(self, task_ids, user_id):
        self.calls.append((list(task_ids), user_id))
        if self.raises is not None:
            raise self.raises
        return self.returns


def _principal():
    return InternalPrincipal(uuid4())


def test_batch_delete_rejects_empty_list():
    store = _BatchStore()
    with pytest.raises(HTTPException) as error:
        asyncio.run(public.batch_delete_presentations({"taskIds": []}, _principal()))
    assert error.value.status_code == 422


def test_batch_delete_rejects_too_many():
    store = _BatchStore()
    ids = [str(uuid4()) for _ in range(101)]
    with pytest.raises(HTTPException) as error:
        asyncio.run(public.batch_delete_presentations({"taskIds": ids}, _principal()))
    assert error.value.status_code == 422


def test_batch_delete_rejects_invalid_uuid():
    store = _BatchStore()
    with pytest.raises(HTTPException) as error:
        asyncio.run(public.batch_delete_presentations({"taskIds": ["not-a-uuid"]}, _principal()))
    assert error.value.status_code == 422


def test_batch_delete_accepts_snake_case_alias(monkeypatch, tmp_path):
    store = _BatchStore(returns=["/tmp/a.pptx"])
    monkeypatch.setattr(public, "presentation_store", lambda: store)
    monkeypatch.setattr(
        public, "get_settings",
        lambda: SimpleNamespace(presentation_output_dir=tmp_path),
    )
    ids = [str(uuid4()), str(uuid4())]
    result = asyncio.run(public.batch_delete_presentations({"task_ids": ids}, _principal()))
    assert result["count"] == 2
    assert len(store.calls[0][0]) == 2


def test_batch_delete_propagates_active_task_conflict(monkeypatch):
    store = _BatchStore(raises=ValueError("任务仍在进行中，无法删除: x"))
    monkeypatch.setattr(public, "presentation_store", lambda: store)
    with pytest.raises(HTTPException) as error:
        asyncio.run(public.batch_delete_presentations({"taskIds": [str(uuid4())]}, _principal()))
    assert error.value.status_code == 409


def test_batch_delete_propagates_missing_task(monkeypatch):
    store = _BatchStore(raises=ValueError("任务不存在或不属于当前用户: x"))
    monkeypatch.setattr(public, "presentation_store", lambda: store)
    with pytest.raises(HTTPException) as error:
        asyncio.run(public.batch_delete_presentations({"taskIds": [str(uuid4())]}, _principal()))
    assert error.value.status_code == 404


def test_batch_delete_503_when_store_unavailable(monkeypatch):
    store = _BatchStore(available=False)
    monkeypatch.setattr(public, "presentation_store", lambda: store)
    with pytest.raises(HTTPException) as error:
        asyncio.run(public.batch_delete_presentations(
            {"taskIds": [str(uuid4())]}, _principal(),
        ))
    assert error.value.status_code == 503


def test_batch_delete_removes_files_in_output_root(monkeypatch, tmp_path):
    file_a = tmp_path / "a.pptx"
    file_b = tmp_path / "b.pptx"
    file_a.write_bytes(b"x")
    file_b.write_bytes(b"y")
    store = _BatchStore(returns=[str(file_a), str(file_b)])
    monkeypatch.setattr(public, "presentation_store", lambda: store)
    monkeypatch.setattr(
        public, "get_settings",
        lambda: SimpleNamespace(presentation_output_dir=tmp_path),
    )
    asyncio.run(public.batch_delete_presentations(
        {"taskIds": [str(uuid4()), str(uuid4())]}, _principal(),
    ))
    assert not file_a.exists()
    assert not file_b.exists()
