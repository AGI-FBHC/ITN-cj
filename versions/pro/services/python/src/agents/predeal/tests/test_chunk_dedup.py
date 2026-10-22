"""T3.5 索引期去冗余 — predeal 侧写 canonical_chunk_id.

compute_canonical_map is a pure function (no DB, no LLM) — tested directly.
dedup_document_chunks is exercised through FakeDB (mirrors the same pure
helper against the fake knowledge_chunk / knowledge_chunk_enrichment tables),
verifying the write-side wiring predeal owns (retrieval-side filtering is a
separate KnowledgeCore task).
"""

from predeal.steps.chunk_enricher import compute_canonical_map

from .conftest import run_pipeline


def test_compute_canonical_map_marks_later_duplicate():
    chunks = [
        {"db_id": 1, "chunk_index": 1, "content": "示例重复文本内容一模一样。", "near_duplicate_hint": True},
        {"db_id": 2, "chunk_index": 2, "content": "完全不同的另一段内容，不应该被判定重复。", "near_duplicate_hint": True},
        {"db_id": 3, "chunk_index": 3, "content": "示例重复文本内容一模一样。", "near_duplicate_hint": True},
    ]
    assert compute_canonical_map(chunks) == {3: 1}


def test_compute_canonical_map_ignores_unflagged_chunks():
    """第一块未被 LLM 标记为近重复 -> 不参与相似度比较 -> 不产生映射。"""
    chunks = [
        {"db_id": 1, "chunk_index": 1, "content": "重复内容重复内容重复内容示例文本", "near_duplicate_hint": False},
        {"db_id": 2, "chunk_index": 2, "content": "重复内容重复内容重复内容示例文本", "near_duplicate_hint": True},
    ]
    assert compute_canonical_map(chunks) == {}


def test_compute_canonical_map_chains_multiple_duplicates():
    chunks = [
        {"db_id": 1, "chunk_index": 1, "content": "重复片段甲重复片段甲重复片段甲", "near_duplicate_hint": True},
        {"db_id": 2, "chunk_index": 2, "content": "重复片段甲重复片段甲重复片段甲", "near_duplicate_hint": True},
        {"db_id": 3, "chunk_index": 3, "content": "重复片段甲重复片段甲重复片段甲", "near_duplicate_hint": True},
    ]
    canonical = compute_canonical_map(chunks)
    assert canonical == {2: 1, 3: 1}


def test_compute_canonical_map_empty_input():
    assert compute_canonical_map([]) == {}


def test_fake_db_dedup_sets_canonical_chunk_id(fake_env, domain, tmp_path):
    r, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r.status in ("passed", "passed_with_warnings"), r.errors

    db = fake_env.db
    doc_id = list(db.documents.values())[0]["id"]
    rows = db.active_chunk_rows(doc_id)
    assert len(rows) >= 2
    a, b = rows[0], rows[1]

    # Simulate the LLM flagging both a and b as near-duplicates of the same text
    db.chunks[b["id"]]["content"] = db.chunks[a["id"]]["content"]
    db.save_enrichment(a["id"], db.chunks[a["id"]]["content_hash"], {
        "context_prefix": "", "questions": [], "asset_summary": "",
        "near_duplicate_hint": True,
    })
    db.save_enrichment(b["id"], db.chunks[b["id"]]["content_hash"], {
        "context_prefix": "", "questions": [], "asset_summary": "",
        "near_duplicate_hint": True,
    })

    marked = db.dedup_document_chunks(doc_id)
    assert marked == 1
    assert db.chunks[b["id"]]["canonical_chunk_id"] == a["id"]
    assert db.chunks[a["id"]]["canonical_chunk_id"] is None

    # Idempotent: re-running finds nothing left to mark (already resolved)
    assert db.dedup_document_chunks(doc_id) == 0
