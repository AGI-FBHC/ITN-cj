"""T3.1 一次 LLM 通道 — chunk_enricher pipeline integration tests.

Uses the same fake_env/run_pipeline harness as test_idempotency.py /
test_incremental.py. The LLM is mocked via FakeServices.enrich_missing_for_document
(see conftest.py), which is deterministic per chunk_id.
"""

from .conftest import run_pipeline

TWO_CHUNK_MD = """# 章节示例

## 1.1 概念A说明

这里是概念A的详细说明文字，用于验证一次 LLM 通道生成的检索增强信息是否正确写入
knowledge_chunk_enrichment 表。补充一些描述文字，确保内容长度足够形成独立切片，
同时不超过测试域配置的切片上限，保证切片数量可预期，便于断言测试结果的稳定性。
继续补充更多描述性文字，进一步拉长本段落的字符数，确保超过合并阈值一百五十字，
从而不会被判定为"仅有标题"的空壳切片，能够独立形成一个完整且有意义的知识切片。

## 1.2 概念B说明

这里是概念B的详细说明文字，同样用于验证增量传播与缓存复用逻辑是否符合预期，包括
零调用重跑与单块变更只重跑一个切片的场景验证，补充描述文字保证长度合适。继续补充
更多说明文字，进一步拉长本段落的字符数，确保超过合并阈值一百五十字，从而不会被
判定为"仅有标题"的空壳切片，能够独立形成一个完整且有意义的知识切片用于测试验证。
"""


def _write_two_chunk_doc(domain):
    domain["src"].write_text(TWO_CHUNK_MD, encoding="utf-8")


def test_double_chunk_document_creates_two_enrichment_rows(fake_env, domain, tmp_path):
    _write_two_chunk_doc(domain)
    r, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r.status in ("passed", "passed_with_warnings"), r.errors
    assert r.chunk_count == 2, f"expected exactly 2 chunks, got {r.chunk_count}"

    db = fake_env.db
    doc_id = list(db.documents.values())[0]["id"]
    active_ids = {c["id"] for c in db.active_chunk_rows(doc_id)}
    assert len(active_ids) == 2
    assert set(db.chunk_enrichment.keys()) == active_ids
    for row in db.chunk_enrichment.values():
        assert row["context_prefix"]
        assert row["questions"]

    # classification still written to knowledge_chunk_category (compat)
    classified_ids = {c["chunk_id"] for c in db.chunk_categories}
    assert active_ids <= classified_ids


def test_rerun_makes_zero_enrichment_calls(fake_env, domain, tmp_path):
    _write_two_chunk_doc(domain)
    r1, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r1.status in ("passed", "passed_with_warnings"), r1.errors
    n_enrich = len(fake_env.services.enrich_calls)
    assert n_enrich == 2

    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status == "reused"
    assert len(fake_env.services.enrich_calls) == n_enrich, "enrichment re-called on unchanged doc"


def test_changed_chunk_only_reenriches_one(fake_env, domain, tmp_path):
    _write_two_chunk_doc(domain)
    r1, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r1.status in ("passed", "passed_with_warnings"), r1.errors
    n_before = len(fake_env.services.enrich_calls)

    new_md = TWO_CHUNK_MD.replace("概念A的详细说明文字", "概念A的全新详细说明文字")
    assert new_md != TWO_CHUNK_MD
    domain["src"].write_text(new_md, encoding="utf-8")

    r2, _ = run_pipeline(domain, tmp_path, fake_env)
    assert r2.status in ("passed", "passed_with_warnings"), r2.errors
    assert len(fake_env.services.enrich_calls) == n_before + 1
    assert r2.sync_report["updated"] == 1 and r2.sync_report["inserted"] == 0


def test_ragflow_text_carries_context_prefix_and_questions(fake_env, domain, tmp_path):
    _write_two_chunk_doc(domain)
    r, out = run_pipeline(domain, tmp_path, fake_env)
    assert r.status in ("passed", "passed_with_warnings"), r.errors

    md_path = next(out.rglob("chunked_for_ragflow.md"))
    text = md_path.read_text(encoding="utf-8")

    db = fake_env.db
    for row in db.chunk_enrichment.values():
        assert row["context_prefix"] in text
        for q in row["questions"]:
            assert q in text

    # T3.1 硬约束 0.3.6: delimiter/chunk boundary contract untouched —
    # still exactly one separator per chunk.
    assert text.count("<<<ITN_CHUNK_BOUNDARY>>>") == r.chunk_count
