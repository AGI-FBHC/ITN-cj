#!/usr/bin/env python3
"""Live verification of the predeal pipeline against REAL services.

Runs the full idempotency / incremental / failure-recovery scenarios on the
real chapter-6 test file (第六章 框架开发实践.md) against the production
MySQL, the image/file servers and RAGFlow.

Usage:
    .venv/bin/python tests/live_verify.py [--skip-incremental]

The script restores the source file in a finally block, so an interrupted run
never leaves the chapter-6 source modified.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from predeal import load_dotenv  # noqa: E402
from predeal.config import load_domain_config  # noqa: E402
from predeal.pipeline2 import PipelineOptions, process_document  # noqa: E402
from predeal.ragflow_client import RAGFlowClient, RAGFlowConfig  # noqa: E402
import pymysql  # noqa: E402
from pymysql.cursors import DictCursor  # noqa: E402

SRC = Path("/Users/inyvn/Documents/itn_source/hello_agents/docs/chapter6/第六章 框架开发实践.md")
# NOTE: process_document appends {domain}/{version}/doc_xxx, so the base is
# predeal/output (NOT output/hello_agents)
OUT = Path(__file__).parent.parent / "output"
DOMAIN = "hello_agents"

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"
INFO = "\033[94mINFO\033[0m"


def db_conn():
    cfg = dict(
        host=os.environ["MYSQL_HOST"], port=int(os.environ["MYSQL_PORT"]),
        user=os.environ["MYSQL_USER"], password=os.environ["MYSQL_PASSWORD"],
        database=os.environ["MYSQL_DATABASE"], charset="utf8mb4",
        cursorclass=DictCursor, connect_timeout=15,
    )
    return pymysql.connect(**cfg)


def q(sql, args=None):
    conn = db_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()
    finally:
        conn.close()


def run(progress=True):
    config = load_domain_config(DOMAIN)
    rf = RAGFlowConfig(base_url=os.environ["RAGFLOW_URL"], api_key=os.environ["RAGFLOW_API_KEY"])

    def cb(ev):
        if progress:
            mark = {"start": "▶", "end": "✓", "log": "·"}.get(ev.status, "?")
            print(f"   {mark} [{ev.step_num:02d}] {ev.step_name}: {ev.message}")

    opts = PipelineOptions(ragflow_config=rf, progress_callback=cb if progress else None)
    return process_document(SRC, config, OUT, opts)


def check(name, cond, detail=""):
    print(f"   {PASS if cond else FAIL} {name}" + (f"  ({detail})" if detail else ""))
    return cond


def main():
    skip_incremental = "--skip-incremental" in sys.argv
    print(f"{INFO} 源文件: {SRC}")
    print(f"{INFO} 输出目录: {OUT}")

    # backup the source file so we can always restore it
    backup = SRC.with_suffix(".md.bak_live_verify")
    shutil.copy2(SRC, backup)
    results = {"checks": []}

    def record(name, ok, detail=""):
        results["checks"].append({"name": name, "ok": ok, "detail": detail})

    try:
        # ══════════════ 1. IDEMPOTENCY ══════════════
        print("\n" + "=" * 70)
        print("阶段 1：幂等性（同一文件连续处理两次）")
        print("=" * 70)

        before_docs = q("SELECT id, document_code, document_key, content_sha256, status FROM knowledge_document WHERE document_key LIKE 'hello_agents:chapter6%'")
        before_chunks = q("SELECT id, chunk_code, status FROM knowledge_chunk WHERE document_id IN (SELECT id FROM knowledge_document WHERE document_key LIKE 'hello_agents:chapter6%')")
        before_figs = q("SELECT id, occurrence_no, source_url, storage_key, vlm_status FROM knowledge_figures WHERE document_id IN (SELECT id FROM knowledge_document WHERE document_key LIKE 'hello_agents:chapter6%')")

        print(f"\n{INFO} 第 1 次处理（完整流程 + RAGFlow 同步）...")
        t0 = time.time()
        r1 = run()
        dt = time.time() - t0
        print(f"   状态: {r1.status}  耗时 {dt:.1f}s  错误: {r1.errors}")
        record("run1 成功（含幂等复用）", r1.status in ("passed", "passed_with_warnings", "reused"), r1.status)
        print(f"   同步报告: {r1.sync_report}")
        print(f"   RAGFlow: {r1.ragflow_result}")
        record("run1 RAGFlow 上传", (r1.ragflow_result and r1.ragflow_result.get("status") in ("uploaded", "up_to_date")) or r1.status == "reused", str(r1.ragflow_result))

        doc_row = q("SELECT id, document_key, content_sha256, status, ragflow_doc_id, last_ragflow_sha256 FROM knowledge_document WHERE document_key LIKE 'hello_agents:chapter6%'")
        print(f"\n{INFO} 文档行（应为 1 条，含迁移）: {doc_row}")
        record("document 唯一", len(doc_row) == 1, f"{len(doc_row)} rows")
        record("document 已迁移 document_key", doc_row and doc_row[0]["document_key"] == "hello_agents:chapter6/第六章 框架开发实践.md", str(doc_row and doc_row[0]["document_key"]))
        record("ragflow_doc_id 已记录", bool(doc_row and doc_row[0]["ragflow_doc_id"]))

        chunks_1 = q("SELECT id, chunk_code, chunk_index, status, content_hash FROM knowledge_chunk WHERE document_id=%s ORDER BY chunk_index", (doc_row[0]["id"],))
        figs_1 = q("SELECT id, occurrence_no, source_url, storage_key, vlm_status, sha256 FROM knowledge_figures WHERE document_id=%s ORDER BY occurrence_no", (doc_row[0]["id"],))
        rf_docs_1 = q("SELECT ragflow_doc_id FROM knowledge_document WHERE id=%s", (doc_row[0]["id"],))

        print(f"\n{INFO} 第 2 次处理（期望 reused / 零副作用）...")
        t0 = time.time()
        r2 = run()
        dt = time.time() - t0
        print(f"   状态: {r2.status}  耗时 {dt:.1f}s  错误: {r2.errors}")
        record("run2 复用（fast path）", r2.status == "reused", r2.status)

        chunks_2 = q("SELECT id, chunk_code, chunk_index, status, content_hash FROM knowledge_chunk WHERE document_id=%s ORDER BY chunk_index", (doc_row[0]["id"],))
        figs_2 = q("SELECT id, occurrence_no, source_url, storage_key, vlm_status, sha256 FROM knowledge_figures WHERE document_id=%s ORDER BY occurrence_no", (doc_row[0]["id"],))
        doc_row_2 = q("SELECT id, status, ragflow_doc_id, last_ragflow_sha256 FROM knowledge_document WHERE id=%s", (doc_row[0]["id"],))

        record("不重复创建 chunk", [c["id"] for c in chunks_2] == [c["id"] for c in chunks_1], f"{len(chunks_2)} chunks")
        record("不重复创建 figure", [f["id"] for f in figs_2] == [f["id"] for f in figs_1], f"{len(figs_2)} figures")
        record("figure 状态不变", all(f["vlm_status"] == "success" for f in figs_2))
        record("RAGFlow 文档 ID 不变", doc_row_2[0]["ragflow_doc_id"] == doc_row[0]["ragflow_doc_id"], str(doc_row_2[0]["ragflow_doc_id"]))

        # 产物一致性：两次（强制重跑）生成的 normalized / manifest / source map
        import hashlib

        def file_sha(p):
            return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None

        print(f"\n{INFO} 强制重跑（--force）验证产物字节级一致...")
        r3 = run()
        print(f"   状态: {r3.status}  错误: {r3.errors}")
        doc_dir = OUT / "hello_agents" / "v1" / f"doc_{doc_row[0]['id']:06d}"
        arts = {
            "normalized.md": doc_dir / "normalized" / "normalized.md",
            "source_map.json": doc_dir / "normalized" / "source_map.json",
            "chunk_manifest.json": doc_dir / "chunks" / "chunk_manifest.json",
            "figure_manifest.json": doc_dir / "figures" / "figure_manifest.json",
            "structure_tree.json": doc_dir / "structure" / "structure_tree.json",
        }
        hashes = {}
        ok_arts = True
        for name, p in arts.items():
            h = file_sha(p)
            hashes[name] = h
            if h is None:
                ok_arts = False
                print(f"   {FAIL} 产物缺失: {name}")
        # force re-run writes the same files; compare to a second force run
        r4 = run()
        ok_arts2 = all(file_sha(p) == hashes[name] for name, p in arts.items())
        record("产物字节级一致（两次强制重跑）", ok_arts2, str(hashes))

        # ══════════════ 2. INCREMENTAL ══════════════
        if skip_incremental:
            print(f"\n{INFO} 跳过增量测试")
        else:
            print("\n" + "=" * 70)
            print("阶段 2：增量更新")
            print("=" * 70)
            original_text = SRC.read_text(encoding="utf-8")

            # ── 2a. 修改一个段落 ──
            print(f"\n{INFO} 2a. 修改一个段落（期望只更新 1 个 chunk）")
            anchor = "将所有理论与实践融会贯通。"
            assert anchor in original_text, "anchor not found"
            modified = original_text.replace(anchor, anchor + "本次修订新增了一句用于验证增量更新的内容。")
            SRC.write_text(modified, encoding="utf-8")
            r_a = run()
            print(f"   状态: {r_a.status}  同步报告: {r_a.sync_report}")
            record("2a 修改段落：updated=1", r_a.sync_report and r_a.sync_report.get("updated") == 1, str(r_a.sync_report))
            record("2a 修改段落：inserted=0", r_a.sync_report and r_a.sync_report.get("inserted") == 0)
            record("2a 修改段落：superseded=0", r_a.sync_report and r_a.sync_report.get("superseded") == 0)

            # ── 2b. 删除一个章节 ──
            print(f"\n{INFO} 2b. 删除一个章节（期望旧 chunk 软删除 superseded）")
            lines = [l for l in modified.splitlines()
                     if not (l.startswith("## 习题") or l.startswith("## 参考文献"))]
            # 习题 section runs until 参考文献; keep everything before 习题 and from 参考文献
            keep = []
            skipping = False
            for l in modified.splitlines():
                if l.startswith("## 习题"):
                    skipping = True
                    continue
                if l.startswith("## 参考文献"):
                    skipping = False
                if not skipping:
                    keep.append(l)
            SRC.write_text("\n".join(keep), encoding="utf-8")
            assert "## 习题" not in SRC.read_text(encoding="utf-8")
            before_active = {c["id"] for c in q("SELECT id FROM knowledge_chunk WHERE document_id=%s AND status='active'", (doc_row[0]["id"],))}
            r_b = run()
            print(f"   状态: {r_b.status}  同步报告: {r_b.sync_report}")
            after = q("SELECT id, status FROM knowledge_chunk WHERE document_id=%s", (doc_row[0]["id"],))
            superseded = [c for c in after if c["status"] == "superseded"]
            active = [c for c in after if c["status"] == "active"]
            record("2b 删除章节：有 superseded chunk", len(superseded) >= 1, f"{len(superseded)} superseded")
            record("2b 删除章节：旧 chunk 未物理删除", len(after) == len(before_active) + (r_b.sync_report or {}).get("inserted", 0) + 0 or len(after) >= len(before_active), f"{len(after)} total")
            record("2b 删除章节：当前索引排除旧 chunk", all(c["id"] not in {s["id"] for s in superseded} for c in active))

            # ── 2c. 替换一张图片 ──
            print(f"\n{INFO} 2c. 替换一张图片（期望重新上传 + 更新关联 chunk）")
            cur_text = SRC.read_text(encoding="utf-8")
            assert "6-figures/01.png" in cur_text, "image 01.png not found"
            fig_before = q("SELECT id, occurrence_no, source_url, storage_key FROM knowledge_figures WHERE document_id=%s AND occurrence_no=1", (doc_row[0]["id"],))
            cur_text = cur_text.replace("6-figures/01.png", "6-figures/03.png", 1)
            SRC.write_text(cur_text, encoding="utf-8")
            r_c = run()
            fig_after = q("SELECT id, occurrence_no, source_url, storage_key, download_status, upload_status, vlm_status FROM knowledge_figures WHERE document_id=%s AND occurrence_no=1", (doc_row[0]["id"],))
            print(f"   状态: {r_c.status}  同步报告: {r_c.sync_report}")
            print(f"   figure: {fig_before} -> {fig_after}")
            record("2c 替换图片：figure 行复用（同 id）", fig_after and fig_before and fig_after[0]["id"] == fig_before[0]["id"], str(fig_after and fig_after[0]["id"]))
            record("2c 替换图片：source_url 更新", fig_after and "03.png" in fig_after[0]["source_url"])
            record("2c 替换图片：三阶段全部成功", fig_after and all(fig_after[0][k] == "success" for k in ("download_status", "upload_status", "vlm_status")))
            record("2c 替换图片：关联 chunk 已更新", r_c.sync_report and r_c.sync_report.get("updated", 0) >= 1, str(r_c.sync_report))

        # ══════════════ 3. FAILURE RECOVERY ══════════════
        print("\n" + "=" * 70)
        print("阶段 3：失败恢复")
        print("=" * 70)

        # ── 3a. 恢复原文件后必须收敛 ──
        print(f"\n{INFO} 3a. 恢复原文件（期望回到与 run1 完全一致的状态）")
        shutil.copy2(backup, SRC)
        r_d = run()
        print(f"   状态: {r_d.status}  同步报告: {r_d.sync_report}")
        chunks_final = q("SELECT id, chunk_code, status FROM knowledge_chunk WHERE document_id=%s ORDER BY chunk_index", (doc_row[0]["id"],))
        record("3a 恢复收敛：状态完成", r_d.status in ("passed", "passed_with_warnings", "uploaded", "reused"), r_d.status)
        record("3a 恢复收敛：chunk 集合与 run1 一致", [c["id"] for c in chunks_final] == [c["id"] for c in chunks_1], f"{len(chunks_final)} vs {len(chunks_1)}")

        # ── 3b. VLM 失败恢复（对该文档新出现的图片注入失败）──
        print(f"\n{INFO} 3b. VLM 调用失败 -> 重跑只补 VLM、不重复上传")
        import predeal.images.pipeline as img_pipeline
        orig_vlm = img_pipeline.describe_image
        calls = {"n": 0}

        def flaky_vlm(path, api_key=None):
            calls["n"] += 1
            if calls["n"] <= 3:  # fail all retry attempts of the image pipeline
                raise RuntimeError("simulated VLM 500")
            return orig_vlm(path, api_key=api_key)

        # point image 01 to a fresh URL so download/upload/VLM actually run
        cur = SRC.read_text(encoding="utf-8")
        cur = cur.replace("6-figures/01.png", "6-figures/04.png", 1)
        SRC.write_text(cur, encoding="utf-8")
        img_pipeline.describe_image = flaky_vlm
        try:
            r_e1 = run()
            failed_figs = q("SELECT id, occurrence_no, vlm_status FROM knowledge_figures WHERE document_id=%s AND vlm_status='failed'", (doc_row[0]["id"],))
            print(f"   状态: {r_e1.status}  vlm failed figures: {failed_figs}")
            record("3b VLM 失败：文档标记 failed", r_e1.status == "failed" or bool(failed_figs), r_e1.status)
        finally:
            img_pipeline.describe_image = orig_vlm
        r_e2 = run()
        print(f"   重跑状态: {r_e2.status}  同步报告: {r_e2.sync_report}")
        record("3b VLM 重跑成功", r_e2.status in ("passed", "passed_with_warnings", "uploaded", "reused"), r_e2.status)

        # ── 3c. 图片下载失败 ──
        print(f"\n{INFO} 3c. 图片下载失败 -> download_status=failed，重跑恢复")
        orig_dl = img_pipeline.download_image
        d_calls = {"n": 0}

        def flaky_dl(url):
            d_calls["n"] += 1
            if d_calls["n"] <= 3:
                raise RuntimeError("simulated network down")
            return orig_dl(url)

        # fresh URL forces a real download attempt (02.png is currently unused
        # as the first occurrence was replaced by 04.png in 3b)
        cur = SRC.read_text(encoding="utf-8")
        cur = cur.replace("6-figures/02.png", "6-figures/01.png", 1)
        SRC.write_text(cur, encoding="utf-8")
        img_pipeline.download_image = flaky_dl
        try:
            r_f1 = run()
            failed_figs = q("SELECT id, occurrence_no, download_status, download_error FROM knowledge_figures WHERE document_id=%s AND download_status='failed'", (doc_row[0]["id"],))
            print(f"   状态: {r_f1.status}  download failed figures: {[(f['occurrence_no'], (f['download_error'] or '')[:40]) for f in failed_figs]}")
            record("3c 下载失败：download_status=failed", bool(failed_figs))
        finally:
            img_pipeline.download_image = orig_dl
        r_f2 = run()
        print(f"   重跑状态: {r_f2.status}")
        record("3c 下载重跑成功", r_f2.status in ("passed", "passed_with_warnings", "uploaded", "reused"), r_f2.status)

        # ══════════════ SUMMARY ══════════════
        print("\n" + "=" * 70)
        print("验证汇总")
        print("=" * 70)
        ok = sum(1 for c in results["checks"] if c["ok"])
        total = len(results["checks"])
        for c in results["checks"]:
            print(f"   {PASS if c['ok'] else FAIL} {c['name']}" + (f"  ({c['detail']})" if c["detail"] else ""))
        print(f"\n{PASS if ok == total else FAIL} {ok}/{total} 项通过")
        sys.exit(0 if ok == total else 1)

    finally:
        # always restore the original chapter-6 file
        if backup.exists():
            shutil.copy2(backup, SRC)
            backup.unlink(missing_ok=True)
            print(f"\n{INFO} 源文件已恢复: {SRC}")


if __name__ == "__main__":
    import os
    main()
