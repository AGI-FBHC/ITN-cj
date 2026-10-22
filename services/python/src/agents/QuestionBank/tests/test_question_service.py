"""QuestionService 集成测试（直连生产 MySQL，事务回滚零污染）."""
import pytest

from questionbank.services.question import (
    DuplicateQuestionError,
    QuestionCreate,
    QuestionNotFoundError,
    QuestionService,
    QuestionUpdate,
    ValidationError,
)
from questionbank.store import QuestionStore

from conftest import make_single_choice, unique_stem


@pytest.fixture
def service(rollback):
    from questionbank.config import get_settings

    return QuestionService(QuestionStore(get_settings())), rollback


# ── create ─────────────────────────────────────────────────────────────────


def test_create_with_knowledge_points(service):
    svc, conn = service
    record = svc.create(
        make_single_choice(
            knowledge_points=[{"category_id": 71, "role": "primary", "weight": 1.0}],
        ),
        conn=conn,
    )
    assert record["id"] > 0
    assert record["status"] == "proposed"
    assert record["content_hash"] and len(record["content_hash"]) == 64
    assert record["knowledge_points"][0]["category_id"] == 71
    assert record["knowledge_points"][0]["role"] == "primary"


def test_create_duplicate_raises(service):
    svc, conn = service
    data = make_single_choice()
    svc.create(data, conn=conn)
    with pytest.raises(DuplicateQuestionError):
        svc.create(data, conn=conn)


def test_create_llm_must_be_proposed(service):
    svc, conn = service
    with pytest.raises(ValidationError):
        svc.create(
            make_single_choice(source_type="llm", status="active"),
            conn=conn,
        )


def test_create_evidence_refs_and_generation_metadata(service):
    svc, conn = service
    record = svc.create(
        make_single_choice(
            evidence_refs=[
                {"chunk_id": 1024, "document_id": 18, "score": 0.93, "source": "mysql"}
            ],
            generation_metadata={
                "model": "MiMo", "prompt_version": "question-v1",
                "knowledge_context_hash": "abc", "knowledge_core_version": "v1",
            },
        ),
        conn=conn,
    )
    assert record["evidence_refs"][0]["chunk_id"] == 1024
    assert record["generation_metadata"]["model"] == "MiMo"


# ── get / search ───────────────────────────────────────────────────────────


def test_get_not_found(service):
    svc, conn = service
    with pytest.raises(QuestionNotFoundError):
        svc.get(99999999, conn=conn)


def test_search_by_category_and_filters(service):
    svc, conn = service
    q1 = svc.create(make_single_choice(difficulty=1, knowledge_points=[{"category_id": 71}] ), conn=conn)
    svc.create(
        make_single_choice(difficulty=5, question_type="true_false", options=None, reference_answer=True),
        conn=conn,
    )
    result = svc.search(category_id=71, difficulty=1, conn=conn)
    assert result["total"] >= 1
    ids = [r["id"] for r in result["items"]]
    assert q1["id"] in ids


def test_search_keyword(service):
    svc, conn = service
    stem = unique_stem("关键词检索专用")
    q = svc.create(make_single_choice(stem=stem), conn=conn)
    result = svc.search(keyword="关键词检索专用", conn=conn)
    assert any(r["id"] == q["id"] for r in result["items"])


# ── update ─────────────────────────────────────────────────────────────────


def test_update_recomputes_hash_and_blocks_duplicate(service):
    svc, conn = service
    q1 = svc.create(make_single_choice(), conn=conn)
    q2 = svc.create(make_single_choice(), conn=conn)

    # 正常更新：改题干 → hash 变化
    updated = svc.update(q1["id"], QuestionUpdate(stem=unique_stem("改后")), conn=conn)
    assert updated["stem"].startswith("改后")
    assert updated["content_hash"] != q1["content_hash"]

    # 把 q1 改成与 q2 完全相同 → 撞 hash
    dup = make_single_choice(stem=q2["stem"], options=q2["options"], reference_answer=q2["reference_answer"])
    with pytest.raises(DuplicateQuestionError):
        svc.update(q1["id"], QuestionUpdate(stem=dup.stem, options=dup.options, reference_answer=dup.reference_answer), conn=conn)


def test_update_replaces_knowledge_points(service):
    svc, conn = service
    q = svc.create(
        make_single_choice(knowledge_points=[{"category_id": 71, "role": "primary"}]),
        conn=conn,
    )
    svc.update(
        q["id"],
        QuestionUpdate(knowledge_points=[{"category_id": 72, "role": "secondary", "weight": 0.5}]),
        conn=conn,
    )
    points = svc.get(q["id"], conn=conn)["knowledge_points"]
    assert len(points) == 1
    assert points[0]["category_id"] == 72
    assert points[0]["role"] == "secondary"


# ── status flow ────────────────────────────────────────────────────────────


def test_status_flow(service):
    svc, conn = service
    q = svc.create(make_single_choice(), conn=conn)

    # proposed → active
    assert svc.set_status(q["id"], "active", conn=conn)["status"] == "active"
    # active → deprecated
    assert svc.set_status(q["id"], "deprecated", conn=conn)["status"] == "deprecated"
    # deprecated 是终态
    with pytest.raises(ValidationError):
        svc.set_status(q["id"], "active", conn=conn)


def test_status_flow_rejected_cycle(service):
    svc, conn = service
    q = svc.create(make_single_choice(), conn=conn)
    assert svc.set_status(q["id"], "rejected", conn=conn)["status"] == "rejected"
    # 修订后重新 proposed → active
    assert svc.set_status(q["id"], "proposed", conn=conn)["status"] == "proposed"
    assert svc.set_status(q["id"], "active", conn=conn)["status"] == "active"


def test_status_illegal_transition(service):
    svc, conn = service
    q = svc.create(make_single_choice(), conn=conn)
    # proposed 不能直接 deprecated
    with pytest.raises(ValidationError):
        svc.set_status(q["id"], "deprecated", conn=conn)


# ── soft delete / import ───────────────────────────────────────────────────


def test_delete_is_soft(service):
    svc, conn = service
    q = svc.create(make_single_choice(), conn=conn)
    svc.set_status(q["id"], "active", conn=conn)
    svc.delete(q["id"], conn=conn)
    record = svc.get(q["id"], conn=conn)
    assert record["status"] == "deprecated"  # 记录保留（attempt 历史不悬空）


def test_import_batch_idempotent(service):
    svc, conn = service
    data = make_single_choice()
    first = svc.import_batch([data], conn=conn)
    assert len(first["created"]) == 1
    second = svc.import_batch([data], conn=conn)
    assert len(second["created"]) == 0
    assert len(second["skipped"]) == 1
    assert second["skipped"][0]["question_id"] == first["created"][0]["question_id"]


def test_import_batch_invalid_item_reported(service):
    svc, conn = service
    bad = make_single_choice(options=[{"key": "A", "text": "只有一项"}])
    result = svc.import_batch([bad], conn=conn)
    assert len(result["created"]) == 0
    assert len(result["failed"]) == 1
    assert "≥2" in result["failed"][0]["error"]
