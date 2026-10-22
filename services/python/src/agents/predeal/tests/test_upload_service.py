"""Document upload service tests (mock infra, no external services)."""

from pathlib import Path

import pytest

from .conftest import SAMPLE_MD


def _make_upload(tmp_path, name="第七章 上传测试.md", content=SAMPLE_MD):
    src = tmp_path / name
    src.write_text(content, encoding="utf-8")
    return src


def _upload(fake_env, tmp_path, src: Path, **opts_kw):
    from predeal.upload_service import UploadOptions, upload_document_file
    opts = UploadOptions(domain_id="itn_test", **opts_kw)
    return upload_document_file(src, opts, domains_dir=fake_env.tmp / "domains")


def test_upload_new_document(fake_env, domain, tmp_path):
    src = _make_upload(tmp_path)
    r = _upload(fake_env, tmp_path, src)
    assert r.status in ("passed", "passed_with_warnings"), r.errors
    assert r.document_key == "itn_test:uploads/第七章 上传测试.md"
    assert r.db_document_id is not None
    assert r.chunk_count >= 1
    assert r.figure_count == 2
    assert r.ragflow_result and r.ragflow_result.get("status") in ("uploaded", "up_to_date")

    # staged file exists under <root>/uploads/
    staged = domain["docs_dir"] / "uploads" / "第七章 上传测试.md"
    assert staged.exists()

    # exactly one document row for this key
    docs = [d for d in fake_env.db.documents.values()
            if d.get("document_key") == r.document_key]
    assert len(docs) == 1


def test_reupload_same_content_is_idempotent(fake_env, domain, tmp_path):
    src = _make_upload(tmp_path)
    r1 = _upload(fake_env, tmp_path, src)
    assert r1.status in ("passed", "passed_with_warnings")

    chunks_before = len(fake_env.db.chunks)
    uploads_before = fake_env.ragflow.upload_calls
    n_vlm = len(fake_env.services.vlm_calls)

    r2 = _upload(fake_env, tmp_path, src)
    assert r2.status == "reused", r2.errors
    assert r2.db_document_id == r1.db_document_id
    assert len(fake_env.db.chunks) == chunks_before, "chunks duplicated"
    assert fake_env.ragflow.upload_calls == uploads_before, "RAGFlow re-uploaded"
    assert len(fake_env.services.vlm_calls) == n_vlm, "VLM re-called"


def test_same_name_changed_content_is_incremental(fake_env, domain, tmp_path):
    src = _make_upload(tmp_path)
    r1 = _upload(fake_env, tmp_path, src)
    assert r1.status in ("passed", "passed_with_warnings")

    # same file name, different content -> incremental update of same document
    modified = SAMPLE_MD.replace("需要根据任务类型选择。", "需要根据任务类型与团队规模选择。")
    src.write_text(modified, encoding="utf-8")
    r2 = _upload(fake_env, tmp_path, src)
    assert r2.status in ("passed", "passed_with_warnings"), r2.errors
    assert r2.db_document_id == r1.db_document_id, "must update, not duplicate"
    assert r2.document_key == r1.document_key
    assert r2.sync_report["updated"] >= 1
    assert len(fake_env.db.documents) == 1, "document duplicated"

    # one RAGFlow doc, replaced not accumulated
    names = []
    for ds in fake_env.ragflow.datasets.values():
        names += [d["name"] for d in ds["docs"].values()]
    assert len(names) == 1


def test_metadata_overrides_are_persisted(fake_env, domain, tmp_path):
    src = _make_upload(tmp_path)
    r = _upload(fake_env, tmp_path, src,
                title="自定义标题",
                document_type="教材",
                source_type="github",
                source_name="测试仓库",
                publisher="测试出版社",
                publish_year=2024,
                version="v2.0",
                reliability_score=0.85)
    assert r.status in ("passed", "passed_with_warnings"), r.errors
    row = fake_env.db.documents[r.db_document_id]
    assert row["title"] == "自定义标题"
    # metadata lives in the document row via pipeline's get_or_create_document


def test_no_ragflow_flag_skips_ragflow(fake_env, domain, tmp_path):
    src = _make_upload(tmp_path)
    r = _upload(fake_env, tmp_path, src, enable_ragflow=False)
    assert r.status in ("passed", "passed_with_warnings"), r.errors
    assert r.ragflow_result is None
    assert fake_env.ragflow.upload_calls == 0
    assert fake_env.ragflow.datasets == {}, "no dataset should be created"


def test_unsupported_extension_rejected(fake_env, domain, tmp_path):
    src = tmp_path / "bad.pdf"
    src.write_bytes(b"%PDF-1.4 fake")
    r = _upload(fake_env, tmp_path, src)
    assert r.status == "failed"
    assert any("Unsupported" in e for e in r.errors)


def test_upload_bytes_api(fake_env, domain, tmp_path):
    from predeal.upload_service import UploadOptions, upload_document_bytes
    r = upload_document_bytes("第八章 字节上传.md", SAMPLE_MD.encode("utf-8"),
                              UploadOptions(domain_id="itn_test"),
                              domains_dir=fake_env.tmp / "domains")
    assert r.status in ("passed", "passed_with_warnings"), r.errors
    assert r.document_key == "itn_test:uploads/第八章 字节上传.md"
    assert r.db_document_id is not None
