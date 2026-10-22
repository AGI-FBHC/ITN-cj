"""RAGFlow document versioning — the dataset must never accumulate multiple
versions of the same document, even when RAGFlow auto-renames duplicate
uploads (doc_000020.md -> doc_000020(1).md) or when uploads fail.
"""

from .conftest import SAMPLE_MD, run_pipeline


def _doc_names(fake_env) -> list[str]:
    names = []
    for ds in fake_env.ragflow.datasets.values():
        names += [d["name"] for d in ds["docs"].values()]
    return names


def _change_doc(domain, anchor, replacement):
    text = domain["src"].read_text(encoding="utf-8")
    assert anchor in text
    domain["src"].write_text(text.replace(anchor, replacement), encoding="utf-8")


def test_legacy_dataset_reconfigured_and_republished(fake_env, domain, tmp_path):
    """A dataset created with the default '\n' delimiter must be reconfigured
    (PATCH) and the current document re-uploaded so it parses into our chunks."""
    # Pre-create the dataset with the WRONG (default) delimiter, as if created
    # by the legacy pipeline
    ds = fake_env.ragflow.create_dataset(
        name="itn_test_v1", chunk_method="naive",
        parser_config={"delimiter": "\n"},
    )
    dsid = ds["id"]

    r1, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r1.status in ("passed", "passed_with_warnings"), r1.errors
    assert r1.ragflow_result.get("dataset_reconfigured") is True, r1.ragflow_result
    assert fake_env.ragflow.datasets[dsid]["parser_config"]["delimiter"] == "`<<<ITN_CHUNK_BOUNDARY>>>`"
    docs = fake_env.ragflow.list_documents(dsid)
    assert len(docs) == 1
    assert docs[0]["parser_config"]["delimiter"] == "`<<<ITN_CHUNK_BOUNDARY>>>`"

    # Second run: everything stable, no re-upload
    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status == "reused"

    # Forced re-run: doc parsed with correct delimiter -> up_to_date, no upload
    uploads_before = fake_env.ragflow.upload_calls
    r3, _ = run_pipeline(domain, tmp_path, fake_env, force=True)
    assert r3.status in ("passed", "passed_with_warnings")
    assert r3.ragflow_result["status"] == "up_to_date"
    assert fake_env.ragflow.upload_calls == uploads_before


def test_no_version_accumulation_across_replacements(fake_env, domain, tmp_path):
    """Multiple content changes -> still exactly one RAGFlow document."""
    r1, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r1.status in ("passed", "passed_with_warnings"), r1.errors
    assert len(_doc_names(fake_env)) == 1

    # Change 1: delete a chapter -> forces a fresh upload + old-version cleanup
    lines = [l for l in SAMPLE_MD.splitlines() if not l.startswith("## 6.3")]
    domain["src"].write_text("\n".join(lines), encoding="utf-8")
    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status in ("passed", "passed_with_warnings"), r2.errors
    assert len(_doc_names(fake_env)) == 1, f"versions after change 1: {_doc_names(fake_env)}"
    assert _doc_names(fake_env)[0] == "doc_000001.md", "name must be clean (not a (N) variant)"

    # Change 2: modify a paragraph
    _change_doc(domain, "需要根据任务类型选择。", "需要根据任务类型与团队规模选择。")
    r3, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r3.status in ("passed", "passed_with_warnings"), r3.errors
    assert len(_doc_names(fake_env)) == 1, f"versions after change 2: {_doc_names(fake_env)}"

    # Change 3: delete + restore (chunk ids reactivated, document replaced)
    lines = [l for l in SAMPLE_MD.splitlines() if not l.startswith("## 6.4")]
    domain["src"].write_text("\n".join(lines), encoding="utf-8")
    r4, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r4.status in ("passed", "passed_with_warnings"), r4.errors
    domain["src"].write_text(SAMPLE_MD, encoding="utf-8")
    r5, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r5.status in ("passed", "passed_with_warnings"), r5.errors
    assert len(_doc_names(fake_env)) == 1, f"versions after change 3: {_doc_names(fake_env)}"


def test_variant_detection_resumes_after_manual_rename(fake_env, domain, tmp_path):
    """If old versions somehow exist (e.g. previous bug), the next run must
    clean them all up and keep a single clean-named document."""
    r1, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r1.status in ("passed", "passed_with_warnings")

    # Simulate leftover variants as produced by the old buggy version
    ds = next(iter(fake_env.ragflow.datasets.values()))
    for n in (1, 2, 3):
        fake_env.ragflow._doc_seq += 1
        ds["docs"][f"leftover{n}"] = {
            "id": f"leftover{n}", "name": f"doc_000001({n}).md",
            "content": "stale", "parsed": True, "chunks": [],
        }
    assert len(ds["docs"]) == 4

    # A chapter deletion forces a replacement -> all leftovers removed
    lines = [l for l in SAMPLE_MD.splitlines() if not l.startswith("## 6.3")]
    domain["src"].write_text("\n".join(lines), encoding="utf-8")
    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status in ("passed", "passed_with_warnings"), r2.errors
    names = _doc_names(fake_env)
    assert len(names) == 1, f"leftovers not cleaned: {names}"
    assert names[0] == "doc_000001.md"


def test_upload_failure_leaves_no_versions_behind(fake_env, domain, tmp_path, monkeypatch):
    """If the fresh upload fails, old versions were removed first, so the next
    run simply re-uploads — no accumulation, no duplicates."""
    r1, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r1.status in ("passed", "passed_with_warnings")

    orig_upload = fake_env.ragflow.upload_document

    def failing_upload(dataset_id, file_path, name=None, parser_config=None):
        from predeal.ragflow_client import RAGFlowError
        raise RAGFlowError(500, "RAGFlow down (simulated)")

    monkeypatch.setattr(fake_env.ragflow, "upload_document", failing_upload)
    # chapter deletion -> replacement path -> old version removed, upload fails
    lines = [l for l in SAMPLE_MD.splitlines() if not l.startswith("## 6.3")]
    domain["src"].write_text("\n".join(lines), encoding="utf-8")
    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status == "failed"
    assert any("RAGFlow" in e for e in r2.errors)

    # old version was removed before the failed upload -> dataset empty for our doc
    names = [n for n in _doc_names(fake_env) if n.startswith("doc_")]
    assert names == [], f"stale versions left after failed upload: {names}"

    # recovery run re-uploads exactly once
    monkeypatch.setattr(fake_env.ragflow, "upload_document", orig_upload)
    r3, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r3.status in ("passed", "passed_with_warnings"), r3.errors
    assert len(_doc_names(fake_env)) == 1


def test_ragflow_chunk_id_self_heal_on_reused(fake_env, domain, tmp_path):
    """上传后映射丢失（ragflow_chunk_id 全 NULL）→ 内容不变重跑走 reused 快路径，
    由 self-heal 按 chunk_index 对齐回写，映射不再永久缺失."""
    r1, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r1.status in ("passed", "passed_with_warnings"), r1.errors

    # 模拟"上次上传后解析未完成即退出"：DB 映射全空（fake RAGFlow 解析已完成）
    db = fake_env.db
    doc_ids = {c["document_id"] for c in db.chunks.values()}
    assert doc_ids, "pipeline 应已写入 chunks"
    did = next(iter(doc_ids))
    for chunk in db.chunks.values():
        chunk["ragflow_chunk_id"] = None
    assert db.missing_ragflow_ids(did), "应存在缺失映射"

    # 内容不变重跑 → reused 快路径 → self-heal 补齐映射
    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status == "reused"
    missing = db.missing_ragflow_ids(did)
    assert missing == [], f"self-heal 未补齐: {missing}"
    mapped = db.get_ragflow_chunk_ids(did)
    assert len(mapped) > 0
    assert all(v for v in mapped.values()), "全部 active chunk 应有 ragflow_chunk_id"

    # 幂等：再跑一次不再产生额外调用（映射已完整，self-heal 直接跳过）
    r3, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r3.status == "reused"
    assert db.missing_ragflow_ids(did) == []


def test_chunk_id_sync_skips_on_count_mismatch(fake_env, domain, tmp_path, monkeypatch):
    """RAGFlow 解析数量与 DB 不一致（解析不完整）→ 跳过对齐，防止按位置错位映射."""
    r1, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r1.status in ("passed", "passed_with_warnings"), r1.errors

    db = fake_env.db
    did = next(iter(db.chunks.values()))["document_id"]
    # 清空映射并让 RAGFlow 侧少一个 chunk（模拟解析只完成一半）
    for chunk in db.chunks.values():
        chunk["ragflow_chunk_id"] = None
    for ds in fake_env.ragflow.datasets.values():
        for doc in ds["docs"].values():
            if doc["chunks"]:
                doc["chunks"] = doc["chunks"][:-1]

    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status == "reused"
    # 数量不一致 → 跳过，映射保持 NULL（不产生错位映射）
    assert db.missing_ragflow_ids(did), "解析不完整时应保持未映射状态"
