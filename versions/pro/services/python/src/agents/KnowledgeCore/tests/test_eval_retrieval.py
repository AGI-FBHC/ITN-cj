"""T2.1 eval_retrieval.py 纯函数测试（不起服务、不发网络请求）.

只覆盖脚本内不依赖真实 HTTP 调用的部分：golden 加载、hit@k、报告聚合/渲染、
HF 阈值网格搜索，以及 main() 在 --dry-run / 空 golden 路径下的行为
（这两条路径按脚本设计完全不创建 httpx.AsyncClient）。
"""

from __future__ import annotations

import json

import pytest

from evals.eval_retrieval import (
    RetrievalQueryResult,
    build_arg_parser,
    build_report,
    classify_by_thresholds,
    grid_search_thresholds,
    hit_at_k,
    load_jsonl,
    main,
    render_calibration_report,
    render_markdown_table,
    run_calibration,
    run_retrieval_eval,
)


# ── load_jsonl ───────────────────────────────────────────────────────────────


def test_load_jsonl_missing_file_returns_empty(tmp_path):
    assert load_jsonl(tmp_path / "does_not_exist.jsonl") == []


def test_load_jsonl_empty_file_returns_empty(tmp_path):
    path = tmp_path / "empty.jsonl"
    path.write_text("", encoding="utf-8")
    assert load_jsonl(path) == []


def test_load_jsonl_reads_records_and_skips_blank_lines(tmp_path):
    path = tmp_path / "golden.jsonl"
    path.write_text(
        '{"query": "a", "expected_chunk_ids": [1], "category_id": 1}\n'
        "\n"
        '{"query": "b", "expected_chunk_ids": [], "category_id": null}\n',
        encoding="utf-8",
    )
    records = load_jsonl(path)
    assert len(records) == 2
    assert records[0]["query"] == "a"
    assert records[1]["category_id"] is None


def test_real_retrieval_golden_rows_are_well_formed():
    """golden 已按库内实际内容标注（2026-08-18 方案 A），只校验结构不锁条数."""
    from evals.eval_retrieval import DEFAULT_RETRIEVAL_GOLDEN

    rows = load_jsonl(DEFAULT_RETRIEVAL_GOLDEN)
    assert len(rows) >= 10
    for row in rows:
        assert "query" in row and row["query"]
        assert isinstance(row["expected_chunk_ids"], list)
        assert all(isinstance(cid, int) for cid in row["expected_chunk_ids"])
        assert "category_id" in row


def test_real_qa_golden_rows_are_well_formed():
    from evals.eval_retrieval import DEFAULT_QA_GOLDEN, QA_LABELS

    rows = load_jsonl(DEFAULT_QA_GOLDEN)
    assert len(rows) >= 10
    labels = {row["label"] for row in rows}
    assert labels == set(QA_LABELS)  # 三档都要有样本（HF 阈值校准的前提）
    for row in rows:
        assert row["label"] in QA_LABELS
        assert isinstance(row["key_points"], list)


# ── hit_at_k ─────────────────────────────────────────────────────────────────


def test_hit_at_k_none_when_expected_empty():
    assert hit_at_k([], [1, 2, 3], 3) is None


def test_hit_at_k_true_when_hit_within_k():
    assert hit_at_k([5], [1, 2, 5, 9], 3) is True


def test_hit_at_k_false_when_miss_within_k():
    assert hit_at_k([5], [1, 2, 3], 3) is False
    assert hit_at_k([5], [1, 2, 3, 5], 3) is False  # 命中在第4位，k=3 内未命中


# ── build_report / render_markdown_table ─────────────────────────────────────


def test_build_report_empty_results_schema_is_stable():
    report = build_report([])
    assert report["total_queries"] == 0
    assert report["evaluated_queries"] == 0
    assert report["hit@3"] is None
    assert report["hit@8"] is None
    assert report["stage_distribution"] == {"mysql": 0, "parent": 0, "rag": 0, "empty": 0}
    assert report["avg_hf"] is None
    assert report["avg_latency_ms"] is None
    # schema 键固定存在
    assert set(report.keys()) == {
        "total_queries",
        "evaluated_queries",
        "hit@3",
        "hit@8",
        "stage_distribution",
        "avg_hf",
        "avg_latency_ms",
    }


def test_build_report_with_unannotated_skeleton_rows_no_crash():
    results = [
        RetrievalQueryResult(query="q1", category_id=None, expected_chunk_ids=[], stage="mysql", hf_score=0.7, latency_ms=10.0),
        RetrievalQueryResult(query="q2", category_id=None, expected_chunk_ids=[], stage="empty", hf_score=None, latency_ms=5.0),
    ]
    report = build_report(results)
    assert report["total_queries"] == 2
    assert report["evaluated_queries"] == 0  # 无标注，无可评估样本
    assert report["hit@3"] is None
    assert report["hit@8"] is None
    assert report["stage_distribution"] == {"mysql": 1, "parent": 0, "rag": 0, "empty": 1}
    assert report["avg_hf"] == pytest.approx(0.7)
    assert report["avg_latency_ms"] == pytest.approx(7.5)


def test_build_report_computes_hit_rates_from_annotated_rows():
    results = [
        RetrievalQueryResult(query="q1", category_id=1, expected_chunk_ids=[10], retrieved_chunk_ids=[10, 2, 3], stage="mysql"),
        RetrievalQueryResult(query="q2", category_id=2, expected_chunk_ids=[20], retrieved_chunk_ids=[1, 2, 3, 4, 5, 6, 7, 8], stage="rag"),
    ]
    report = build_report(results)
    assert report["evaluated_queries"] == 2
    assert report["hit@3"] == pytest.approx(0.5)  # 只有 q1 在前3命中
    assert report["hit@8"] == pytest.approx(0.5)  # q2 的 20 从未出现


def test_render_markdown_table_contains_stage_rows():
    report = build_report([])
    table = render_markdown_table(report)
    assert "| stage | count |" in table
    assert "| mysql | 0 |" in table
    assert "| hit@3 | - |" in table


# ── HF 阈值校准（纯函数部分） ─────────────────────────────────────────────────


def test_classify_by_thresholds():
    assert classify_by_thresholds(0.9, t_high=0.8, t_mid=0.5) == "answerable"
    assert classify_by_thresholds(0.6, t_high=0.8, t_mid=0.5) == "restricted"
    assert classify_by_thresholds(0.2, t_high=0.8, t_mid=0.5) == "unanswerable"


def test_grid_search_thresholds_empty_input():
    assert grid_search_thresholds([]) == []


def test_grid_search_thresholds_finds_perfect_separator():
    scored = [
        (0.95, "answerable"),
        (0.90, "answerable"),
        (0.60, "restricted"),
        (0.55, "restricted"),
        (0.10, "unanswerable"),
        (0.05, "unanswerable"),
    ]
    outcomes = grid_search_thresholds(scored, grid=[0.2, 0.4, 0.5, 0.65, 0.8, 0.9])
    assert outcomes  # 非空
    best = outcomes[0]
    assert best["accuracy"] == pytest.approx(1.0)
    assert best["t_mid"] < best["t_high"]
    # 结果按一致率降序
    accuracies = [o["accuracy"] for o in outcomes]
    assert accuracies == sorted(accuracies, reverse=True)


@pytest.mark.asyncio
async def test_run_calibration_dry_run_returns_empty():
    qa_golden = [{"query": "x", "label": "answerable", "key_points": []}]
    outcomes = await run_calibration(qa_golden, base_url="http://unused", domain="agent", dry_run=True, timeout=1.0)
    assert outcomes == []


@pytest.mark.asyncio
async def test_run_calibration_empty_golden_returns_empty():
    outcomes = await run_calibration([], base_url="http://unused", domain="agent", dry_run=False, timeout=1.0)
    assert outcomes == []


def test_render_calibration_report_empty_golden():
    assert "为空" in render_calibration_report([], [], dry_run=False)


def test_render_calibration_report_dry_run():
    qa_golden = [{"query": "x", "label": "answerable"}]
    assert "dry-run" in render_calibration_report([], qa_golden, dry_run=True)


def test_render_calibration_report_no_labeled_outcomes():
    qa_golden = [{"query": "x", "label": "answerable"}]
    text = render_calibration_report([], qa_golden, dry_run=False)
    assert "没有可用于校准" in text


def test_render_calibration_report_with_outcomes():
    qa_golden = [{"query": "x", "label": "answerable"}]
    outcomes = [{"t_high": 0.8, "t_mid": 0.5, "accuracy": 0.9, "n": 10}]
    text = render_calibration_report(outcomes, qa_golden, dry_run=False)
    assert "建议阈值：t_high=0.8, t_mid=0.5" in text
    assert "| 0.8 | 0.5 | 90.00% | 10 |" in text


# ── run_retrieval_eval 空集/dry-run 分支（不发网络请求） ─────────────────────


@pytest.mark.asyncio
async def test_run_retrieval_eval_empty_golden_no_network():
    results = await run_retrieval_eval(
        [], base_url="http://127.0.0.1:1", domain="agent", top_k=8, dry_run=False, timeout=0.1
    )
    assert results == []


@pytest.mark.asyncio
async def test_run_retrieval_eval_dry_run_no_network():
    golden = [
        {"query": "什么是ACID", "expected_chunk_ids": [], "category_id": None},
        {"query": "TCP握手", "expected_chunk_ids": [1, 2], "category_id": 3},
    ]
    results = await run_retrieval_eval(
        golden, base_url="http://127.0.0.1:1", domain="agent", top_k=8, dry_run=True, timeout=0.1
    )
    assert len(results) == 2
    assert results[0].query == "什么是ACID"
    assert results[0].retrieved_chunk_ids == []
    assert results[1].expected_chunk_ids == [1, 2]


# ── CLI（build_arg_parser / main 的 dry-run、空集、报错分支） ─────────────────


def test_build_arg_parser_defaults():
    parser = build_arg_parser()
    args = parser.parse_args([])
    assert args.calibrate is False
    assert args.dry_run is False
    assert args.top_k == 8


def test_main_help_exits_zero(capsys):
    with pytest.raises(SystemExit) as exc_info:
        main(["--help"])
    assert exc_info.value.code == 0
    out = capsys.readouterr().out
    assert "eval_retrieval.py" in out


def test_main_dry_run_on_real_skeleton_prints_stable_schema(capsys):
    code = main(["--dry-run"])
    assert code == 0
    out = capsys.readouterr().out
    report = json.loads(out.split("\n\n", 1)[0])
    total = report["total_queries"]
    assert total >= 10
    # dry-run 不发网络请求 → 全部落 empty；hit@3 在 dry-run 下无标注可评
    assert report["stage_distribution"] == {"mysql": 0, "parent": 0, "rag": 0, "empty": total}


def test_main_empty_golden_no_service_needed(tmp_path, capsys):
    empty_golden = tmp_path / "empty.jsonl"
    empty_golden.write_text("", encoding="utf-8")
    code = main(["--golden", str(empty_golden), "--base-url", "http://127.0.0.1:1"])
    assert code == 0
    out = capsys.readouterr().out
    report = json.loads(out.split("\n\n", 1)[0])
    assert report["total_queries"] == 0
    assert report["avg_latency_ms"] is None


def test_main_returns_nonzero_and_clear_message_on_service_error(monkeypatch, tmp_path, capsys):
    golden = tmp_path / "golden.jsonl"
    golden.write_text('{"query": "q", "expected_chunk_ids": [], "category_id": null}\n', encoding="utf-8")

    async def _boom(*args, **kwargs):
        from evals.eval_retrieval import EvalServiceError

        raise EvalServiceError("模拟：无法连接 KnowledgeCore 服务")

    monkeypatch.setattr("evals.eval_retrieval.run_retrieval_eval", _boom)
    code = main(["--golden", str(golden), "--base-url", "http://127.0.0.1:1"])
    assert code == 1
    err = capsys.readouterr().err
    assert "评估失败" in err
    assert "无法连接" in err


def test_main_calibrate_dry_run(capsys):
    code = main(["--calibrate", "--dry-run"])
    assert code == 0
    out = capsys.readouterr().out
    assert "dry-run" in out
