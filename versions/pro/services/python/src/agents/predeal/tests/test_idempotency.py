"""Test 1: Idempotency — processing the same file twice.

Requirements verified:
- no duplicate knowledge_document rows
- no duplicate knowledge_chunk rows (ids are stable)
- unchanged images are not re-uploaded
- successful VLM calls are not repeated
- RAGFlow documents are not re-uploaded
- normalized / manifests / source map are byte-identical between runs
"""

from pathlib import Path

from .conftest import run_pipeline


def _artifact_files(out: Path) -> dict[str, Path]:
    doc_dir = next(out.rglob("raw")) .parent  # .../doc_xxxxxx
    files = {
        "normalized": doc_dir / "normalized" / "normalized.md",
        "chunk_manifest": doc_dir / "chunks" / "chunk_manifest.json",
        "figure_manifest": doc_dir / "figures" / "figure_manifest.json",
        "source_map": doc_dir / "normalized" / "source_map.json",
        "structure": doc_dir / "structure" / "structure_tree.json",
    }
    return {k: v for k, v in files.items() if v.exists()}


def test_same_file_twice_no_duplicates(fake_env, domain, tmp_path):
    r1, out1 = run_pipeline(domain, tmp_path, fake_env)
    assert r1.status in ("passed", "passed_with_warnings"), r1.errors
    db = fake_env.db

    doc_rows = list(db.documents.values())
    assert len(doc_rows) == 1
    doc_id = doc_rows[0]["id"]
    chunk_ids_1 = sorted(db.chunks.keys())
    fig_ids_1 = sorted(db.figures.keys())
    fig_records_1 = [db.figures[i] for i in fig_ids_1]

    # Second run — must take the fast path
    r2, out2 = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status == "reused", r2.errors

    assert len(db.documents.values()) == 1, "document duplicated"
    assert sorted(db.chunks.keys()) == chunk_ids_1, "chunks duplicated"
    assert sorted(db.figures.keys()) == fig_ids_1, "figures duplicated"
    assert r2.sync_report["unchanged"] == r1.sync_report["active"]


def test_same_file_twice_no_repeat_network_calls(fake_env, domain, tmp_path):
    run_pipeline(domain, tmp_path, fake_env)
    s = fake_env.services
    rf = fake_env.ragflow
    n_download = len(s.download_calls)
    n_upload = len(s.upload_calls)
    n_vlm = len(s.vlm_calls)
    n_classify = len(s.classify_calls)
    n_rf_upload = rf.upload_calls
    n_file_upload = len(s.file_upload_calls)
    assert n_download > 0 and n_vlm > 0 and n_classify > 0

    # Second run: fast path — zero calls of any kind
    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status == "reused"
    assert len(s.download_calls) == n_download, "image re-downloaded"
    assert len(s.upload_calls) == n_upload, "image re-uploaded"
    assert len(s.vlm_calls) == n_vlm, "VLM re-called"
    assert len(s.classify_calls) == n_classify, "classifier re-called"
    assert len(s.file_upload_calls) == n_file_upload, "files re-uploaded"
    assert rf.upload_calls == n_rf_upload, "RAGFlow doc re-uploaded"


def test_same_file_twice_artifacts_identical(fake_env, domain, tmp_path):
    r1, out1 = run_pipeline(domain, tmp_path, fake_env, output="run1")
    # Same output dir -> fast path reuses artifacts
    r2, out2 = run_pipeline(domain, tmp_path, fake_env, output="run1")
    assert r1.status in ("passed", "passed_with_warnings")
    assert r2.status == "reused"

    # Force a full re-run into a fresh dir and compare every artifact byte-for-byte
    r3, out3 = run_pipeline(domain, tmp_path, fake_env, output="run3", force=True)
    assert r3.status in ("passed", "passed_with_warnings")

    a1 = _artifact_files(out1)
    a3 = _artifact_files(out3)
    assert set(a1) == set(a3)
    for name, p1 in a1.items():
        p3 = a3[name]
        assert p1.read_bytes() == p3.read_bytes(), f"artifact differs: {name}"


def test_forced_rerun_keeps_ids_and_skips_unchanged(fake_env, domain, tmp_path):
    """A forced re-run must still be idempotent at the DB level."""
    r1, out = run_pipeline(domain, tmp_path, fake_env)
    db = fake_env.db
    chunk_ids_1 = {k: v["content_hash"] for k, v in db.chunks.items()}
    fig_ids_1 = {k: (v.source_url, v.storage_key, v.vlm_description)
                 for k, v in db.figures.items()}
    n_vlm = len(fake_env.services.vlm_calls)
    n_up = len(fake_env.services.upload_calls)

    r2, _ = run_pipeline(domain, tmp_path, fake_env, output="out2", force=True)
    assert r2.status in ("passed", "passed_with_warnings")

    assert {k: v["content_hash"] for k, v in db.chunks.items()} == chunk_ids_1
    assert {k: (v.source_url, v.storage_key, v.vlm_description)
            for k, v in db.figures.items()} == fig_ids_1
    assert len(fake_env.services.vlm_calls) == n_vlm, "VLM re-called on unchanged images"
    assert len(fake_env.services.upload_calls) == n_up, "images re-uploaded"
    assert r2.sync_report["inserted"] == 0 and r2.sync_report["updated"] == 0
