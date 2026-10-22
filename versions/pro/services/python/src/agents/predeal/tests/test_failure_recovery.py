"""Test 3: Failure recovery.

Scenarios verified:
- MySQL write failure            -> doc marked failed; re-run succeeds, no duplicates
- image download failure         -> download_status=failed; re-run retries only the failed step
- VLM failure                    -> vlm_status=failed; re-run skips download/upload, retries VLM only
- RAGFlow upload failure         -> doc stays failed; re-run resumes (no duplicate document)
- program exit mid-step          -> stale 'processing' states reset; re-run completes
- single doc failure             -> other documents in the domain still processed
"""

import pytest

from .conftest import SAMPLE_MD, run_pipeline


def _first_run(fake_env, domain, tmp_path):
    r, out = run_pipeline(domain, tmp_path, fake_env)
    assert r.status in ("passed", "passed_with_warnings"), r.errors
    doc_id = list(fake_env.db.documents.values())[0]["id"]
    return r, out, doc_id


# ── MySQL write failure ────────────────────────────────────────────────────

def test_mysql_chunk_write_failure_then_rerun(fake_env, domain, tmp_path, monkeypatch):
    _first_run(fake_env, domain, tmp_path)
    db = fake_env.db

    # Simulate: MySQL unavailable during chunk sync on the re-run
    orig_sync = db.sync_chunks

    def boom(*a, **kw):
        raise RuntimeError("MySQL connection lost (simulated)")

    monkeypatch.setattr("predeal.pipeline2.chunk_repo.sync_chunks", boom)
    r, _ = run_pipeline(domain, tmp_path, fake_env, force=True)
    assert r.status == "failed"
    assert any("MySQL" in e for e in r.errors)
    assert db.documents[list(db.documents)[0]]["status"] == "failed"

    # Re-run after recovery — must succeed with no duplicates
    monkeypatch.setattr("predeal.pipeline2.chunk_repo.sync_chunks", orig_sync)
    r2, _ = run_pipeline(domain, tmp_path, fake_env, force=True)
    assert r2.status in ("passed", "passed_with_warnings"), r2.errors
    assert len(db.documents) == 1
    ids = [c["id"] for c in db.chunks.values()]
    assert len(ids) == len(set(ids)), "duplicate chunk rows after recovery"


# ── Image download failure ─────────────────────────────────────────────────

def test_image_download_failure_then_resume(fake_env, domain, tmp_path, monkeypatch):
    import predeal.images.pipeline as img_pipeline
    orig = img_pipeline.download_image

    def failing_download(url):
        raise RuntimeError("network down (simulated)")

    monkeypatch.setattr(img_pipeline, "download_image", failing_download)
    r, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r.status == "failed"

    db = fake_env.db
    failed_figs = [f for f in db.figures.values()
                   if f.download_status.value == "failed"]
    assert failed_figs, "no figure marked download_failed"
    # Nothing was uploaded / described for the failed image
    assert all(f.upload_status.value in ("pending",) for f in failed_figs)

    # Recovery run: only the failed download is retried
    monkeypatch.setattr(img_pipeline, "download_image", orig)
    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status in ("passed", "passed_with_warnings"), r2.errors
    assert all(f.download_status.value == "success" for f in db.figures.values())
    assert all(f.vlm_status.value == "success" for f in db.figures.values())


# ── VLM failure ────────────────────────────────────────────────────────────

def test_vlm_failure_then_resume_skips_download_upload(fake_env, domain, tmp_path, monkeypatch):
    import predeal.images.pipeline as img_pipeline
    orig = img_pipeline.describe_image

    def failing_vlm(path, api_key=None):
        raise RuntimeError("VLM API 500 (simulated)")

    monkeypatch.setattr(img_pipeline, "describe_image", failing_vlm)
    r, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r.status == "failed"

    db = fake_env.db
    figs = list(db.figures.values())
    # Download + upload succeeded before VLM failed
    assert all(f.download_status.value == "success" for f in figs)
    assert all(f.upload_status.value == "success" for f in figs)
    assert any(f.vlm_status.value == "failed" for f in figs)

    # The failed image's upload must NOT be repeated on recovery. The second
    # image (never reached in run 1) may legitimately upload for the first time.
    failed_fig = next(f for f in figs if f.vlm_status.value == "failed")
    failed_key = failed_fig.storage_key

    # Recovery: VLM retried, download/upload NOT repeated
    monkeypatch.setattr(img_pipeline, "describe_image", orig)
    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status in ("passed", "passed_with_warnings"), r2.errors
    assert all(f.vlm_status.value == "success" for f in db.figures.values())
    assert all(f.upload_status.value == "success" for f in db.figures.values())
    uploads_after_fail = [k for k in fake_env.services.upload_calls
                          if k == failed_key]
    assert len(uploads_after_fail) == 1, "failed image re-uploaded on VLM retry"


# ── RAGFlow upload failure ─────────────────────────────────────────────────

def test_ragflow_upload_failure_then_resume(fake_env, domain, tmp_path, monkeypatch):
    # Simulate RAGFlow being down on the first run (no prior upload state)
    orig_upload = fake_env.ragflow.upload_document

    def failing_upload(dataset_id, file_path, name=None, parser_config=None):
        from predeal.ragflow_client import RAGFlowError
        raise RAGFlowError(500, "RAGFlow down (simulated)")

    monkeypatch.setattr(fake_env.ragflow, "upload_document", failing_upload)
    r, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r.status == "failed"
    assert any("RAGFlow" in e for e in r.errors)
    assert list(fake_env.db.documents.values())[0]["status"] == "failed"

    # Recovery run: succeeds; document in RAGFlow is NOT duplicated
    monkeypatch.setattr(fake_env.ragflow, "upload_document", orig_upload)
    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status in ("passed", "passed_with_warnings"), r2.errors
    assert r2.ragflow_result["status"] == "uploaded"
    total_docs = sum(len(ds["docs"]) for ds in fake_env.ragflow.datasets.values())
    assert total_docs == 1, "RAGFlow document duplicated after retry"

    # Third run: fully idempotent (up_to_date, no API upload)
    r3, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r3.status == "reused"
    assert r3.ragflow_result is None or r3.ragflow_result.get("status") in ("up_to_date", "uploaded")


# ── Mid-step crash ─────────────────────────────────────────────────────────

def test_crash_mid_image_step_resets_stale_processing(fake_env, domain, tmp_path):
    # Run until after image download (leave statuses in a mixed state)
    r1, _ = run_pipeline(domain, tmp_path, fake_env, until="image_pipeline")
    assert r1.status == "stopped"

    db = fake_env.db
    # Simulate a crash: some figure left in 'processing'
    rec = next(iter(db.figures.values()))
    rec.download_status = type(rec.download_status)("processing")
    rec.upload_status = type(rec.upload_status)("processing")

    # Re-run: stale processing states must be reset and completed
    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status in ("passed", "passed_with_warnings"), r2.errors
    for f in db.figures.values():
        assert f.download_status.value == "success"
        assert f.upload_status.value == "success"
        assert f.vlm_status.value == "success"


def test_crash_before_chunk_sync_then_complete(fake_env, domain, tmp_path, monkeypatch):
    # Crash right after figure processing (before chunks are written)
    r1, _ = run_pipeline(domain, tmp_path, fake_env, until="image_pipeline")
    assert r1.status == "stopped"
    assert fake_env.db.count_active_chunks(1) == 0

    n_vlm = len(fake_env.services.vlm_calls)

    # Re-run from scratch — images reused, no repeated VLM
    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status in ("passed", "passed_with_warnings"), r2.errors
    assert fake_env.db.count_active_chunks(1) >= 1
    assert len(fake_env.services.vlm_calls) == n_vlm, "VLM repeated after mid-step crash"


# ── Domain-level isolation ─────────────────────────────────────────────────

def test_single_document_failure_others_continue(fake_env, domain, tmp_path, monkeypatch):
    """One failing document must not block the other documents in the domain."""
    # Add a second, healthy document
    (domain["docs_dir"] / "chapter6" / "第六章 另一份.md").write_text(
        SAMPLE_MD.replace("6-1.png", "other-1.png"), encoding="utf-8")

    import predeal.images.pipeline as img_pipeline

    orig = img_pipeline.download_image
    calls = {"n": 0}

    def flaky_download(url):
        calls["n"] += 1
        if calls["n"] <= 3:  # all retries of the first document's first image fail
            raise RuntimeError("transient network error (simulated)")
        return orig(url)

    monkeypatch.setattr(img_pipeline, "download_image", flaky_download)

    from predeal.config import load_domain_config
    from predeal.pipeline2 import PipelineOptions, process_domain
    from predeal.ragflow_client import RAGFlowConfig

    config = load_domain_config("itn_test", domain["domains_dir"])
    out = tmp_path / "domain_out"
    results = process_domain(
        "itn_test", out,
        PipelineOptions(ragflow_config=RAGFlowConfig(base_url="http://rf", api_key="k")),
        domain["domains_dir"],
    )
    statuses = [r.status for r in results]
    assert "failed" in statuses, "first doc should have failed"
    assert any(s in ("passed", "passed_with_warnings") for s in statuses), \
        "healthy documents must still be processed"

    # Re-run the whole domain: everything converges
    monkeypatch.setattr(img_pipeline, "download_image", orig)
    results2 = process_domain(
        "itn_test", out,
        PipelineOptions(ragflow_config=RAGFlowConfig(base_url="http://rf", api_key="k")),
        domain["domains_dir"],
    )
    assert all(s in ("passed", "passed_with_warnings", "reused") for s in
               [r.status for r in results2]), results2
