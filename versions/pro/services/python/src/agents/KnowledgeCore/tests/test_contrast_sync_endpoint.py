"""817 待办清单第 7 项：`POST /knowledge/graph/contrast-sync/run` 管理触发入口

（ContrastSyncService 的 HTTP 接线，对齐 T4.6 `review-pending/process` 的既有模式：
KNOWLEDGE_ALLOW_WRITE 守门 + audit_records 审计 + 优雅降级）.
"""

from __future__ import annotations

import types

import pytest
import pytest_asyncio
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.services.audit_service import AuditService
from app.graph.api import graph_routes
from app.graph.services import contrast_service as contrast_service_module
from app.graph.services.prerequisite_service import PrerequisiteService

DDL = [
    """
    CREATE TABLE IF NOT EXISTS knowledge_category (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain_id INTEGER, parent_id INTEGER,
        node_code VARCHAR(64), name VARCHAR(255), description TEXT,
        full_path VARCHAR(1000), level INTEGER, node_type VARCHAR(32),
        sort_order INTEGER, status INTEGER DEFAULT 1
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS knowledge_category_prerequisite (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain_id INTEGER NOT NULL,
        category_id INTEGER NOT NULL,
        prereq_category_id INTEGER NOT NULL,
        edge_type VARCHAR(32) NOT NULL DEFAULT 'prerequisite',
        source_domain_id INTEGER,
        confidence DECIMAL(5,4) NOT NULL DEFAULT 1.0,
        rationale TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'proposed',
        source VARCHAR(32) NOT NULL DEFAULT 'agent',
        evidence_json TEXT,
        created_by VARCHAR(64),
        created_at TEXT,
        updated_at TEXT,
        UNIQUE (category_id, prereq_category_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS knowledge_chunk_category (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id INTEGER, category_id INTEGER,
        relation_type VARCHAR(32), confidence DECIMAL(5,4), source VARCHAR(32)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS knowledge_chunk_enrichment (
        chunk_id INTEGER PRIMARY KEY,
        defines_json TEXT, uses_json TEXT
    )
    """,
]

# domain 1：ReAct(10) / Plan-and-Solve(11) / Reflection(12) 三个 level3 知识点同章
SEED = [
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (1, 1, NULL, 'construction', '智能体构建', 1, 'category', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (2, 1, 1, 'ch4', '第四章 经典范式', 2, 'category', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (10, 1, 2, 'kp-react', 'ReAct范式', 3, 'knowledge_point', 1)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (11, 1, 2, 'kp-plan', 'Plan-and-Solve', 3, 'knowledge_point', 2)",
    "INSERT INTO knowledge_category (id, domain_id, parent_id, node_code, name, level, node_type, sort_order) "
    "VALUES (12, 1, 2, 'kp-reflect', 'Reflection', 3, 'knowledge_point', 3)",
]

TABLES = (
    "knowledge_chunk_enrichment",
    "knowledge_chunk_category",
    "knowledge_category_prerequisite",
    "knowledge_category",
)


def _insert_enrichment(rows: list[tuple[int, int, str, str]]) -> list[str]:
    """rows: (chunk_id, category_id, defines_json, uses_json) → SQL 语句列表."""
    stmts = []
    for chunk_id, category_id, defines_json, uses_json in rows:
        stmts.append(
            f"INSERT INTO knowledge_chunk_category (chunk_id, category_id, confidence, source) "
            f"VALUES ({chunk_id}, {category_id}, 0.9, 'llm')"
        )
        stmts.append(
            "INSERT INTO knowledge_chunk_enrichment (chunk_id, defines_json, uses_json) "
            f"VALUES ({chunk_id}, '{defines_json}', '{uses_json}')"
        )
    return stmts


class FakeContrastJudge:
    """mock LLM 判定器（端点测试不打真实网络）."""

    def __init__(self, is_contrast: bool = True, confidence: float = 0.8):
        self.is_contrast = is_contrast
        self.confidence = confidence
        self.calls: list[list[dict]] = []

    async def judge_pairs(self, pairs: list[dict]):
        self.calls.append(pairs)
        return [
            {**p, "is_contrast": self.is_contrast, "confidence": self.confidence, "rationale": "mock"}
            for p in pairs
        ]


@pytest_asyncio.fixture
async def contrast_db(db_session: AsyncSession):
    for t in TABLES:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    for ddl in DDL:
        await db_session.execute(text(ddl))
    for sql in SEED:
        await db_session.execute(text(sql))
    # chunk 101 定义"思考-行动循环"归属 ReAct(10)，chunk 102 定义"规划-执行分离"
    # 归属 Plan-and-Solve(11)，chunk 103（归属 Reflection(12)）同时 uses 两者
    # → build_contrast_candidates 产出 (10, 11) 一对候选。
    for sql in _insert_enrichment(
        [
            (101, 10, '["思考-行动循环"]', "[]"),
            (102, 11, '["规划-执行分离"]', "[]"),
            (103, 12, "[]", '["思考-行动循环", "规划-执行分离"]'),
        ]
    ):
        await db_session.execute(text(sql))
    await db_session.commit()
    yield db_session
    for t in TABLES:
        await db_session.execute(text(f"DROP TABLE IF EXISTS {t}"))
    await db_session.commit()


def _fake_settings(monkeypatch, **overrides) -> None:
    base = {"KNOWLEDGE_ALLOW_WRITE": False}
    base.update(overrides)
    monkeypatch.setattr(graph_routes, "get_settings", lambda: types.SimpleNamespace(**base))


def _patch_judge(monkeypatch, judge: FakeContrastJudge) -> None:
    """ContrastSyncService() 未显式传 judge 时用 ContrastJudge() 兜底，

    monkeypatch 该类的构造，使路由内部装配的 service 用到 mock 判定器。
    """
    monkeypatch.setattr(contrast_service_module, "ContrastJudge", lambda: judge)


async def _contrasts_with_edges(db: AsyncSession) -> list[dict]:
    edges = await PrerequisiteService(db).list_edges(domain_id=1, edge_type="contrasts_with")
    return [{"category_id": e.category_id, "prereq_category_id": e.prereq_category_id, "status": e.status} for e in edges]


# ── KNOWLEDGE_ALLOW_WRITE 守门 ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_contrast_sync_endpoint_requires_write_flag(contrast_db: AsyncSession, monkeypatch):
    """dry_run=False（默认）+ ALLOW_WRITE off → 403，明确拒绝."""
    _fake_settings(monkeypatch, KNOWLEDGE_ALLOW_WRITE=False)
    _patch_judge(monkeypatch, FakeContrastJudge())
    with pytest.raises(HTTPException) as exc_info:
        await graph_routes.run_contrast_sync(domain_id=1, dry_run=False, db=contrast_db)
    assert exc_info.value.status_code == 403


# ── dry_run：出报告但不写库，且不受 ALLOW_WRITE 限制 ─────────────────────────


@pytest.mark.asyncio
async def test_contrast_sync_dry_run_reports_without_writing(contrast_db: AsyncSession, monkeypatch):
    _fake_settings(monkeypatch, KNOWLEDGE_ALLOW_WRITE=False)  # 关着也能 dry_run
    judge = FakeContrastJudge(is_contrast=True)
    _patch_judge(monkeypatch, judge)

    report = await graph_routes.run_contrast_sync(domain_id=1, dry_run=True, db=contrast_db)

    assert report.candidates == 1
    assert report.judged_yes == 1
    assert report.added == 0  # dry_run 不写库
    assert judge.calls  # LLM 确实被调用（预览判定结果）
    assert await _contrasts_with_edges(contrast_db) == []


# ── 正常路径：ALLOW_WRITE on → 建 proposed 边 ────────────────────────────────


@pytest.mark.asyncio
async def test_contrast_sync_endpoint_writes_proposed_edges_when_enabled(
    contrast_db: AsyncSession, monkeypatch
):
    _fake_settings(monkeypatch, KNOWLEDGE_ALLOW_WRITE=True)
    judge = FakeContrastJudge(is_contrast=True, confidence=0.75)
    _patch_judge(monkeypatch, judge)

    report = await graph_routes.run_contrast_sync(domain_id=1, dry_run=False, db=contrast_db)

    assert report.candidates == 1
    assert report.judged_yes == 1
    assert report.added == 1

    edges = await _contrasts_with_edges(contrast_db)
    assert len(edges) == 1
    assert edges[0]["status"] == "proposed"  # 默认 proposed，需人工审核转正
    assert {edges[0]["category_id"], edges[0]["prereq_category_id"]} == {10, 11}

    # 写了 audit_records（审计记录，区别于 review-pending/process 未写审计）
    audits, total = await AuditService(contrast_db).list_audits(domain_id="1")
    assert total >= 1
    assert any(a.details_json.get("action") == "contrast_sync_run" for a in audits)


@pytest.mark.asyncio
async def test_contrast_sync_endpoint_no_verdict_adds_nothing(contrast_db: AsyncSession, monkeypatch):
    """LLM 判定 is_contrast=False → 报告记录候选/判定数，但不建边."""
    _fake_settings(monkeypatch, KNOWLEDGE_ALLOW_WRITE=True)
    judge = FakeContrastJudge(is_contrast=False)
    _patch_judge(monkeypatch, judge)

    report = await graph_routes.run_contrast_sync(domain_id=1, dry_run=False, db=contrast_db)
    assert report.candidates == 1
    assert report.judged_yes == 0
    assert report.added == 0
    assert await _contrasts_with_edges(contrast_db) == []


# ── enrichment 缺表：优雅降级 ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_contrast_sync_endpoint_missing_enrichment_table_degrades(
    db_session: AsyncSession, monkeypatch
):
    """knowledge_chunk_enrichment 表不存在（predeal 未迁移）→ 优雅返回空报告，不 500."""
    await db_session.execute(text("DROP TABLE IF EXISTS knowledge_chunk_enrichment"))
    await db_session.commit()
    _fake_settings(monkeypatch, KNOWLEDGE_ALLOW_WRITE=True)
    _patch_judge(monkeypatch, FakeContrastJudge())

    report = await graph_routes.run_contrast_sync(domain_id=1, dry_run=False, db=db_session)
    assert report.candidates == 0
    assert report.judged_yes == 0
    assert report.added == 0
