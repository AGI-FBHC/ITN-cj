from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.storage import wrong_answers as module
from app.storage.wrong_answers import WrongAnswerStore, _coerce_category_id, _iso_utc


def test_generated_knowledge_point_code_is_not_used_as_numeric_category_id():
    assert _coerce_category_id("kp-ds") is None
    assert _coerce_category_id("42") == 42
    assert _coerce_category_id(0) is None


class _Cursor:
    def __init__(self, row):
        self.row = row
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, query, params):
        self.calls.append((query, params))
        return 1

    def fetchone(self):
        return self.row


class _Connection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.committed = False

    def cursor(self):
        return self._cursor

    def commit(self):
        self.committed = True


def _store(monkeypatch, row):
    cursor = _Cursor(row)
    connection = _Connection(cursor)

    @contextmanager
    def connect(_settings):
        yield connection

    monkeypatch.setattr(module, "platform_connect", connect)
    store = WrongAnswerStore(SimpleNamespace())
    store.ensure_schema = lambda: None
    wrong_id = uuid4()
    store.list = lambda _user_id: [{"id": str(wrong_id), "streak": 1, "reviewCount": 1}]
    return store, wrong_id, cursor, connection


@pytest.mark.parametrize(("answer", "expected"), [(2, True), (0, False)])
def test_review_computes_result_and_persists(monkeypatch, answer, expected):
    store, wrong_id, cursor, connection = _store(
        monkeypatch,
        {"options_json": '["A","B","C","D"]', "correct_answer": 2, "mastered": 0},
    )

    result = store.review(wrong_id, uuid4(), answer)

    assert result["correct"] is expected
    assert result["item"]["id"] == str(wrong_id)
    update_params = cursor.calls[1][1]
    assert update_params[0] == answer
    assert update_params[1:4] == (expected, expected, expected)
    assert connection.committed is True


def test_review_rejects_answer_outside_options(monkeypatch):
    store, wrong_id, _, _ = _store(
        monkeypatch,
        {"options_json": '["A","B"]', "correct_answer": 1, "mastered": 0},
    )

    with pytest.raises(ValueError, match="outside"):
        store.review(wrong_id, uuid4(), 2)


def test_iso_utc_marks_naive_mysql_datetime_as_utc():
    assert _iso_utc(datetime(2026, 8, 9, 12, 0, 0)) == "2026-08-09T12:00:00Z"
    assert _iso_utc(datetime(2026, 8, 9, 12, 0, 0, tzinfo=timezone.utc)).endswith("Z")
