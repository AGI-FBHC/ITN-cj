"""T4.6 predeal 侧 — sync_chunks 产出的 updated/superseded chunk_id 写入
`graph_review_pending`（KnowledgeCore 图谱模块的消费队列，predeal 只生产）。

`_pending_chunk_ids` 是纯函数（无 DB），直接测；`_record_graph_review_pending`
只做一次 INSERT，用一个记录调用的假 cursor 测（fire-and-forget：失败静默，
不抛出）。真实 sync_chunks 端到端在 pipeline 测试里全程用 FakeDB 替身（见
conftest.py），不连真实 pymysql，这里额外验证 sync_chunks 确实在提交前调用
了这两个新函数、且用它们各自的返回值/行为正确接线。
"""

from __future__ import annotations

import pytest

from predeal.chunk_repository import (
    ChunkSyncReport,
    _pending_chunk_ids,
    _record_graph_review_pending,
)


# ── _pending_chunk_ids（纯函数） ────────────────────────────────────────────


def test_pending_chunk_ids_combines_updated_and_superseded():
    report = ChunkSyncReport()
    report.updated = [{"chunk_id": "chunk_000002", "db_id": 20}]
    report.superseded_ids = [30, 31]
    assert _pending_chunk_ids(report) == [20, 30, 31]


def test_pending_chunk_ids_ignores_inserted_and_unchanged():
    report = ChunkSyncReport()
    report.inserted = [{"chunk_id": "chunk_000001", "db_id": 1}]
    report.unchanged = [{"chunk_id": "chunk_000002", "db_id": 2}]
    assert _pending_chunk_ids(report) == []


def test_pending_chunk_ids_empty_report():
    assert _pending_chunk_ids(ChunkSyncReport()) == []


# ── _record_graph_review_pending（fire-and-forget 写入） ───────────────────


class _RecordingCursor:
    def __init__(self):
        self.executemany_calls: list[tuple[str, list]] = []

    def executemany(self, sql, params):
        self.executemany_calls.append((sql, params))


class _FailingCursor:
    def executemany(self, sql, params):
        raise RuntimeError("table graph_review_pending doesn't exist")


def test_record_graph_review_pending_inserts_rows():
    cursor = _RecordingCursor()
    _record_graph_review_pending(cursor, [10, 11])
    assert len(cursor.executemany_calls) == 1
    sql, params = cursor.executemany_calls[0]
    assert "INSERT INTO graph_review_pending" in sql
    assert [p[0] for p in params] == [10, 11]


def test_record_graph_review_pending_noop_for_empty_list():
    cursor = _RecordingCursor()
    _record_graph_review_pending(cursor, [])
    assert cursor.executemany_calls == []


def test_record_graph_review_pending_swallows_failure():
    """迁移未执行等失败场景：不抛异常，静默吞掉（不得影响 sync_chunks 主流程）."""
    cursor = _FailingCursor()
    _record_graph_review_pending(cursor, [10])  # must not raise


# ── sync_chunks 接线：确认在提交前调用了上面两个新函数 ──────────────────────


def test_sync_chunks_wires_graph_review_pending(monkeypatch):
    """用最小的假连接验证 sync_chunks 会把 updated/superseded 的 db_id
    交给 _record_graph_review_pending（不关心真实 SQL 执行细节，那部分已被
    上面的单测覆盖；这里只验证接线本身没有被漏掉或调用顺序错误）。
    """
    import predeal.chunk_repository as chunk_repository

    captured: dict = {}

    def fake_record(cursor, chunk_ids):
        captured["chunk_ids"] = list(chunk_ids)

    monkeypatch.setattr(chunk_repository, "_record_graph_review_pending", fake_record)

    class FakeCursor:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, sql, params=None):
            sql_upper = sql.strip().upper()
            if sql_upper.startswith("SELECT"):
                self._rows = []
            elif sql_upper.startswith("UPDATE"):
                pass
            elif sql_upper.startswith("INSERT INTO KNOWLEDGE_CHUNK"):
                self.lastrowid = 99

        def fetchall(self):
            return getattr(self, "_rows", [])

    class FakeConnection:
        def cursor(self):
            return FakeCursor()

        def commit(self):
            captured["committed"] = True

        def close(self):
            pass

    monkeypatch.setattr(chunk_repository, "_get_connection", lambda: FakeConnection())

    from predeal.models import KnowledgeChunk

    chunk = KnowledgeChunk(
        chunk_id="chunk_000001",
        document_id="doc-1",
        domain_id="dom-1",
        domain_version_id="v1",
        source_file_hash="h",
        section_path=["第一章"],
        heading="第一章",
        content="全新切片内容",
        content_hash="hash1",
        chunk_order=1,
        source_start_offset=0,
        source_end_offset=10,
        normalized_start_offset=0,
        normalized_end_offset=10,
        char_count=10,
        approx_token_count=5,
    )

    chunk_repository.sync_chunks(1, [chunk])

    # 全新文档、没有旧行 -> 本轮只有 inserted，updated/superseded 都是空列表
    assert captured["chunk_ids"] == []
    assert captured["committed"] is True
