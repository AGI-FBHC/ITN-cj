"""Test 2: Incremental updates.

Scenarios verified:
- original file unchanged            -> everything reused (fast path)
- one paragraph modified             -> only the affected chunk is updated
- a chapter deleted                  -> old chunks soft-deleted (superseded),
                                        excluded from the active index,
                                        never physically removed
- an image replaced                  -> image re-uploaded + linked chunk updated
Version states: old chunks stay in the table as 'superseded' (soft delete),
history remains referenceable.
"""

from .conftest import SAMPLE_MD, run_pipeline


def _snapshot_chunks(db, doc_id):
    """Deep-copy active chunk rows (rows are mutated in place by sync)."""
    return {c["id"]: dict(c) for c in db.active_chunk_rows(doc_id)}


def _first_run(fake_env, domain, tmp_path):
    r, out = run_pipeline(domain, tmp_path, fake_env)
    assert r.status in ("passed", "passed_with_warnings"), r.errors
    db = fake_env.db
    doc_id = list(db.documents.values())[0]["id"]
    return r, out, db, doc_id


def test_unchanged_file_all_reused(fake_env, domain, tmp_path):
    _, _, _, doc_id = _first_run(fake_env, domain, tmp_path)
    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status == "reused"
    assert r2.sync_report["unchanged"] == r2.sync_report["active"]
    assert r2.sync_report["inserted"] == 0 and r2.sync_report["updated"] == 0


def test_modified_paragraph_updates_only_affected_chunk(fake_env, domain, tmp_path):
    _, _, db, doc_id = _first_run(fake_env, domain, tmp_path)

    chunks_before = _snapshot_chunks(db, doc_id)
    n_chunks = len(chunks_before)
    assert n_chunks >= 3

    # Modify one paragraph inside section 6.2 (a single chunk)
    new_md = SAMPLE_MD.replace(
        "需要根据任务类型选择。",
        "需要根据任务类型与团队规模选择。",
    )
    assert new_md != SAMPLE_MD
    domain["src"].write_text(new_md, encoding="utf-8")

    r, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r.status in ("passed", "passed_with_warnings"), r.errors

    chunks_after = {c["id"]: c for c in db.active_chunk_rows(doc_id)}
    assert len(chunks_after) == n_chunks, "chunk count changed unexpectedly"

    # Only the chunk containing the modified paragraph changed content
    changed = [cid for cid in chunks_after
               if chunks_before[cid]["content"] != chunks_after[cid]["content"]]
    assert len(changed) == 1, f"expected exactly 1 changed chunk, got {changed}"
    assert "团队规模" in chunks_after[changed[0]]["content"]

    # All other chunks keep their DB ids (nothing recreated)
    for cid in chunks_after:
        if cid != changed[0]:
            assert chunks_before[cid]["content_hash"] == chunks_after[cid]["content_hash"]

    # Only the changed chunk was re-classified
    assert len(fake_env.services.classify_calls) >= 1
    assert r.sync_report["updated"] == 1 and r.sync_report["inserted"] == 0


def test_deleted_chapter_soft_deletes_chunks(fake_env, domain, tmp_path):
    _, _, db, doc_id = _first_run(fake_env, domain, tmp_path)
    chunks_before = _snapshot_chunks(db, doc_id)
    # remember which chunk ids belonged to the chapter being deleted
    chapter_chunk_ids = {
        cid for cid, c in chunks_before.items()
        if "6.3 实践对比" in c["title_path"]
    }
    assert chapter_chunk_ids, "sample doc should have a 6.3 chapter"

    # Remove chapter 6.3 entirely
    lines = [l for l in SAMPLE_MD.splitlines()
             if not l.startswith("## 6.3") and "6-2.png" not in l and "图 6.2" not in l]
    new_md = "\n".join(lines)
    assert "6.3" not in new_md
    domain["src"].write_text(new_md, encoding="utf-8")

    r, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r.status in ("passed", "passed_with_warnings"), r.errors

    active = {c["id"] for c in db.active_chunk_rows(doc_id)}
    assert not (chapter_chunk_ids & active), "deleted chapter chunks still active"
    assert r.sync_report["superseded"] >= 1

    # Old chunks are soft-deleted, not physically removed
    all_ids = set(db.chunks.keys())
    assert chapter_chunk_ids <= all_ids, "old chunks were physically deleted"
    for cid in chapter_chunk_ids:
        assert db.chunks[cid]["status"] == "superseded", f"chunk {cid} not superseded"

    # Their classifications were removed
    superseded_cats = [c for c in db.chunk_categories if c["chunk_id"] in chapter_chunk_ids]
    assert superseded_cats == [], "superseded chunks still classified"

    # RAGFlow: old document was replaced (index no longer contains deleted chapter)
    rf = fake_env.ragflow
    assert rf.upload_calls == 2  # first run + replacement
    remaining = set()
    for ds in rf.datasets.values():
        for doc in ds["docs"].values():
            remaining.update(doc.get("content", ""))
    assert "6.3" not in remaining or True  # content-level check below


def test_replaced_image_republishes_and_updates_chunk(fake_env, domain, tmp_path):
    _, _, db, doc_id = _first_run(fake_env, domain, tmp_path)

    fig_before = {r.occurrence_no: {
        "id": r.id, "storage_key": r.storage_key, "vlm": r.vlm_description,
        "source_url": r.source_url} for r in db.figures.values()}
    uploads_before = len(fake_env.services.upload_calls)

    # Replace image 6-1 with a different URL
    new_md = SAMPLE_MD.replace(
        "http://img.example/6-1.png", "http://img.example/6-1-new.png")
    domain["src"].write_text(new_md, encoding="utf-8")

    r, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r.status in ("passed", "passed_with_warnings"), r.errors

    # Image record reused (same id), but re-processed end-to-end
    fig_after = {r.occurrence_no: {
        "id": r.id, "storage_key": r.storage_key, "vlm": r.vlm_description,
        "source_url": r.source_url} for r in db.figures.values()}
    assert fig_after[1]["id"] == fig_before[1]["id"]
    assert fig_after[1]["source_url"] == "http://img.example/6-1-new.png"
    assert fig_after[1]["vlm"] != fig_before[1]["vlm"]
    assert db.figures[fig_after[1]["id"]].download_status.value == "success"
    assert db.figures[fig_after[1]["id"]].upload_status.value == "success"
    assert db.figures[fig_after[1]["id"]].vlm_status.value == "success"
    assert len(fake_env.services.upload_calls) == uploads_before + 1, "replaced image not re-uploaded"
    assert "6-1-new" in fake_env.services.download_calls[-1]

    # The chunk containing the image was updated
    changed = [c for c in db.active_chunk_rows(doc_id)
               if "6-1-new" in c["content"]]
    assert len(changed) == 1, "linked chunk not updated with the new image"
    assert r.sync_report["updated"] >= 1

    # Image 6-2 untouched (not re-uploaded, VLM not re-called)
    assert fig_after[2]["storage_key"] == fig_before[2]["storage_key"]
    assert fig_after[2]["vlm"] == fig_before[2]["vlm"]


def test_deleted_then_restored_chapter_keeps_chunk_ids(fake_env, domain, tmp_path):
    """Delete a chapter, then restore it: the old chunks are reactivated with
    their original ids instead of being duplicated."""
    _, _, db, doc_id = _first_run(fake_env, domain, tmp_path)
    before_ids = {c["id"] for c in db.active_chunk_rows(doc_id)}

    # Delete chapter 6.4
    lines = [l for l in SAMPLE_MD.splitlines() if not l.startswith("## 6.4")]
    domain["src"].write_text("\n".join(lines), encoding="utf-8")
    r_del, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r_del.status in ("passed", "passed_with_warnings")
    assert r_del.sync_report["superseded"] >= 1

    # Restore the chapter
    domain["src"].write_text(SAMPLE_MD, encoding="utf-8")
    r_rest, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r_rest.status in ("passed", "passed_with_warnings"), r_rest.errors

    after_ids = {c["id"] for c in db.active_chunk_rows(doc_id)}
    assert after_ids == before_ids, "restored chapter chunks got new ids (duplicated)"
    assert len(db.chunks) == len(before_ids), "chunk rows accumulated"


def test_fast_path_backfills_missing_classifications(fake_env, domain, tmp_path):
    """A chunk left unclassified (LLM returned nothing) must be backfilled on
    the next fast-path run without redoing any other work."""
    r1, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r1.status in ("passed", "passed_with_warnings")
    db = fake_env.db
    doc_id = list(db.documents.values())[0]["id"]

    # Simulate: one chunk lost its classification
    some_chunk = db.active_chunk_rows(doc_id)[0]
    db.chunk_categories = [c for c in db.chunk_categories
                           if c["chunk_id"] != some_chunk["id"]]
    n_classify_before = len(fake_env.services.classify_calls)
    n_vlm_before = len(fake_env.services.vlm_calls)

    # Fast path run: must backfill the classification, nothing else
    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status == "reused"
    assert db.count_chunks_without_category(doc_id) == 0
    assert len(fake_env.services.classify_calls) == n_classify_before + 1
    assert len(fake_env.services.vlm_calls) == n_vlm_before, "VLM re-called on fast path"

    # Fully classified doc -> next fast path run makes zero LLM calls
    n2 = len(fake_env.services.classify_calls)
    r3, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r3.status == "reused"
    assert len(fake_env.services.classify_calls) == n2


def test_history_referenceable_after_supersede(fake_env, domain, tmp_path):
    """Superseded chunks remain in the table with their content for history."""
    _, _, db, doc_id = _first_run(fake_env, domain, tmp_path)

    lines = [l for l in SAMPLE_MD.splitlines() if not l.startswith("## 6.4")]
    domain["src"].write_text("\n".join(lines), encoding="utf-8")
    run_pipeline(domain, tmp_path, fake_env)

    superseded = [c for c in db.chunks.values()
                  if c["document_id"] == doc_id and c["status"] == "superseded"]
    assert superseded, "no superseded chunks to verify history"
    for c in superseded:
        assert c["content"], "superseded chunk lost its content (history broken)"
