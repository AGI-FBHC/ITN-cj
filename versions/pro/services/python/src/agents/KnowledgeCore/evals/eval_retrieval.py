"""检索/决策评估脚本（817 行动方案 T2.1）.

用法示例（Windows，venv 在 src/agents/.venv）：

    cd src/agents/KnowledgeCore
    ..\\.venv\\Scripts\\python evals\\eval_retrieval.py
    ..\\.venv\\Scripts\\python evals\\eval_retrieval.py --base-url http://localhost:8010/api/v1
    ..\\.venv\\Scripts\\python evals\\eval_retrieval.py --dry-run          # 不发请求，只验证 golden 格式与报告 schema
    ..\\.venv\\Scripts\\python evals\\eval_retrieval.py --calibrate        # HF 阈值校准（对 qa_golden 网格搜索）

两条链路：
1. 检索评估（默认模式）：逐条读 retrieval_golden.jsonl → 调
   ``GET {base}/knowledge/chunks``（拿 decision/命中切片）与
   ``POST {base}/knowledge/resolve``（拿 high_fidelity_score）→ 聚合成稳定 JSON
   报告，同时打印 Markdown 表格。
2. HF 阈值校准（``--calibrate``）：逐条读 qa_golden.jsonl → 调 resolve 拿
   high_fidelity_score，与人工标注的 label（answerable/restricted/unanswerable）
   做 (t_high, t_mid) 网格搜索，只打印建议阈值，**不修改任何代码**。

空 golden（0 行）或 ``--dry-run`` 均不需要真实服务即可跑通并产出稳定 schema；
服务不可达 / 非 2xx 响应会抛出 ``EvalServiceError``，脚本以非零退出码结束并打印
清晰错误信息。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import httpx

EVALS_DIR = Path(__file__).resolve().parent
DEFAULT_BASE_URL = "http://localhost:8010/api/v1"
DEFAULT_RETRIEVAL_GOLDEN = EVALS_DIR / "retrieval_golden.jsonl"
DEFAULT_QA_GOLDEN = EVALS_DIR / "qa_golden.jsonl"
DEFAULT_DOMAIN = "agent"
DEFAULT_TOP_K = 8
# 2026-08-20：10 → 120。KNOWLEDGE_LLM_JUDGE 开启后单条 /resolve 需 10~60s，
# 10s 超时会被下方 HTTPError 分支统一报成"无法连接"造成误导。
DEFAULT_TIMEOUT = 120.0

# 报告里始终出现的 hit@k 档位与 stage 分布键（无数据时值为 0/null，schema 保持稳定）
HIT_K_VALUES = (3, 8)
STAGE_KEYS = ("mysql", "parent", "rag", "empty")

# --calibrate 网格：候选阈值集合，覆盖 decision_service.HF_THRESHOLDS 附近区间
# （待 T2.1 --calibrate 校准后，人工把结论同步进 decision_service.py，本脚本不自动改代码）
CALIBRATE_GRID: list[float] = [round(0.30 + 0.05 * i, 2) for i in range(14)]  # 0.30 .. 0.95
QA_LABELS = ("answerable", "restricted", "unanswerable")


class EvalServiceError(RuntimeError):
    """服务不可达 / 响应异常时抛出；调用方据此以非零退出码结束并给出清晰提示."""


# ── golden 文件加载 ──────────────────────────────────────────────────────────


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    """读取 jsonl golden 文件；文件不存在或内容为空返回空列表（不报错）."""
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    text = path.read_text(encoding="utf-8")
    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise EvalServiceError(f"{path}:{lineno} 不是合法 JSON：{exc}") from exc
    return records


# ── 检索评估：数据结构与纯函数 ────────────────────────────────────────────────


@dataclass
class RetrievalQueryResult:
    """单条 retrieval golden 的评测结果（一行 = 一次 chunks + 一次 resolve 调用）."""

    query: str
    category_id: int | None
    expected_chunk_ids: list[int]
    retrieved_chunk_ids: list[int] = field(default_factory=list)
    stage: str = "empty"  # GET /knowledge/chunks 的 decision 字段：mysql/parent/rag/empty
    resolve_decision: str | None = None  # POST /knowledge/resolve 的 decision 字段
    hf_score: float | None = None
    latency_ms: float | None = None


def hit_at_k(expected_ids: Iterable[int], retrieved_ids: list[int], k: int) -> bool | None:
    """expected 为空（未标注）→ 无法评估，返回 None；否则判断前 k 条是否命中任一 expected."""
    expected = set(expected_ids)
    if not expected:
        return None
    return bool(expected & set(retrieved_ids[:k]))


def build_report(results: list[RetrievalQueryResult]) -> dict[str, Any]:
    """把逐条结果聚合为稳定 JSON schema（键始终存在；无可评估数据时值为 0/null）."""
    stage_distribution = {key: 0 for key in STAGE_KEYS}
    for r in results:
        stage_distribution[r.stage if r.stage in stage_distribution else "empty"] += 1

    report: dict[str, Any] = {
        "total_queries": len(results),
        "evaluated_queries": sum(1 for r in results if r.expected_chunk_ids),
    }
    for k in HIT_K_VALUES:
        flags = [hit_at_k(r.expected_chunk_ids, r.retrieved_chunk_ids, k) for r in results]
        evaluable = [f for f in flags if f is not None]
        report[f"hit@{k}"] = (sum(1 for f in evaluable if f) / len(evaluable)) if evaluable else None
    report["stage_distribution"] = stage_distribution

    hf_scores = [r.hf_score for r in results if r.hf_score is not None]
    report["avg_hf"] = (sum(hf_scores) / len(hf_scores)) if hf_scores else None

    latencies = [r.latency_ms for r in results if r.latency_ms is not None]
    report["avg_latency_ms"] = (sum(latencies) / len(latencies)) if latencies else None

    return report


def _fmt(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.4f}"
    return str(value)


def render_markdown_table(report: dict[str, Any]) -> str:
    """把报告渲染成 Markdown 表格（打印到 stdout，便于人工/CI 浏览）."""
    lines = ["| 指标 | 值 |", "| --- | --- |"]
    for key in ("total_queries", "evaluated_queries", "hit@3", "hit@8", "avg_hf", "avg_latency_ms"):
        lines.append(f"| {key} | {_fmt(report.get(key))} |")
    lines.append("")
    lines.append("| stage | count |")
    lines.append("| --- | --- |")
    for stage, count in report["stage_distribution"].items():
        lines.append(f"| {stage} | {count} |")
    return "\n".join(lines)


# ── 检索评估：网络调用 ───────────────────────────────────────────────────────


async def fetch_chunks(
    client: httpx.AsyncClient,
    base_url: str,
    domain: str,
    knowledge_point: str,
    category_id: int | None,
    top_k: int,
) -> tuple[dict[str, Any], float]:
    """GET {base}/knowledge/chunks；异常/非 2xx 抛 EvalServiceError（清晰信息）."""
    params: dict[str, Any] = {"knowledge_point": knowledge_point, "domain": domain, "limit": top_k}
    if category_id is not None:
        params["category_id"] = category_id
    started = time.perf_counter()
    try:
        resp = await client.get(f"{base_url}/knowledge/chunks", params=params)
    except httpx.HTTPError as exc:
        raise EvalServiceError(
            f"请求 KnowledgeCore 失败 GET /knowledge/chunks（{base_url}）[{type(exc).__name__}]：{exc}"
        ) from exc
    elapsed_ms = (time.perf_counter() - started) * 1000
    if resp.status_code >= 400:
        raise EvalServiceError(f"GET /knowledge/chunks 返回 {resp.status_code}：{resp.text[:300]}")
    return resp.json(), elapsed_ms


async def fetch_resolve(
    client: httpx.AsyncClient,
    base_url: str,
    domain: str,
    query: str,
    task_type: str = "question",
) -> tuple[dict[str, Any], float]:
    """POST {base}/knowledge/resolve；异常/非 2xx 抛 EvalServiceError（清晰信息）."""
    body = {"domain_id": domain, "query": query, "task_type": task_type}
    started = time.perf_counter()
    try:
        resp = await client.post(f"{base_url}/knowledge/resolve", json=body)
    except httpx.HTTPError as exc:
        raise EvalServiceError(
            f"请求 KnowledgeCore 失败 POST /knowledge/resolve（{base_url}）[{type(exc).__name__}]：{exc}"
        ) from exc
    elapsed_ms = (time.perf_counter() - started) * 1000
    if resp.status_code >= 400:
        raise EvalServiceError(f"POST /knowledge/resolve 返回 {resp.status_code}：{resp.text[:300]}")
    return resp.json(), elapsed_ms


async def run_retrieval_eval(
    golden: list[dict[str, Any]],
    base_url: str,
    domain: str,
    top_k: int,
    dry_run: bool,
    timeout: float,
) -> list[RetrievalQueryResult]:
    """跑一遍 retrieval golden；空集或 dry_run 都不发起任何网络请求."""
    results: list[RetrievalQueryResult] = []
    if not golden:
        return results

    if dry_run:
        for row in golden:
            results.append(
                RetrievalQueryResult(
                    query=str(row.get("query", "")),
                    category_id=row.get("category_id"),
                    expected_chunk_ids=list(row.get("expected_chunk_ids") or []),
                )
            )
        return results

    async with httpx.AsyncClient(timeout=timeout) as client:
        for row in golden:
            query = str(row.get("query", ""))
            category_id = row.get("category_id")
            expected = list(row.get("expected_chunk_ids") or [])
            chunks_resp, chunks_ms = await fetch_chunks(client, base_url, domain, query, category_id, top_k)
            resolve_resp, resolve_ms = await fetch_resolve(client, base_url, domain, query)
            retrieved_ids = [
                c.get("chunk_id") for c in chunks_resp.get("chunks", []) if c.get("chunk_id") is not None
            ]
            results.append(
                RetrievalQueryResult(
                    query=query,
                    category_id=category_id,
                    expected_chunk_ids=expected,
                    retrieved_chunk_ids=retrieved_ids,
                    stage=chunks_resp.get("decision", "empty"),
                    resolve_decision=resolve_resp.get("decision"),
                    hf_score=resolve_resp.get("high_fidelity_score"),
                    latency_ms=chunks_ms + resolve_ms,
                )
            )
    return results


# ── HF 阈值校准（--calibrate） ───────────────────────────────────────────────


def classify_by_thresholds(hf_score: float, t_high: float, t_mid: float) -> str:
    """按 (t_high, t_mid) 把 hf_score 映射到 answerable/restricted/unanswerable 三档."""
    if hf_score >= t_high:
        return "answerable"
    if hf_score >= t_mid:
        return "restricted"
    return "unanswerable"


def grid_search_thresholds(
    scored: list[tuple[float, str]],
    grid: list[float] | None = None,
) -> list[dict[str, Any]]:
    """对 (hf_score, 人工 label) 样本做 (t_high, t_mid) 网格搜索.

    返回按一致率降序排列的全部组合（t_mid 必须严格小于 t_high）；scored 为空返回 []。
    """
    if not scored:
        return []
    candidates = grid if grid is not None else CALIBRATE_GRID
    outcomes: list[dict[str, Any]] = []
    for t_high in candidates:
        for t_mid in candidates:
            if t_mid >= t_high:
                continue
            correct = sum(1 for hf, label in scored if classify_by_thresholds(hf, t_high, t_mid) == label)
            outcomes.append(
                {
                    "t_high": t_high,
                    "t_mid": t_mid,
                    "accuracy": correct / len(scored),
                    "n": len(scored),
                }
            )
    outcomes.sort(key=lambda o: (-o["accuracy"], -(o["t_high"] - o["t_mid"])))
    return outcomes


async def run_calibration(
    qa_golden: list[dict[str, Any]],
    base_url: str,
    domain: str,
    dry_run: bool,
    timeout: float,
) -> list[dict[str, Any]]:
    """逐条调 resolve 拿 hf_score，交给 grid_search_thresholds 打分排序."""
    labeled = [row for row in qa_golden if row.get("label") in QA_LABELS]
    if dry_run or not labeled:
        return []
    scored: list[tuple[float, str]] = []
    skipped: list[str] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        for row in labeled:
            # 2026-08-20：单条容错。judge 开启后单条 resolve 延迟波动大
            # （10s~4min），此前一条超时就让整场校准（半小时级）全部作废。
            # 单条失败记 skipped 继续；失败过半才视为整场失败。
            try:
                resolve_resp, _ = await fetch_resolve(client, base_url, domain, str(row["query"]))
            except EvalServiceError as exc:
                skipped.append(f"{str(row['query'])[:30]} → {exc}")
                print(f"[eval_retrieval] 跳过 1 条（{len(skipped)} 累计）：{exc}")
                continue
            hf = resolve_resp.get("high_fidelity_score")
            if hf is not None:
                scored.append((float(hf), row["label"]))
    if skipped and len(skipped) * 2 > len(labeled):
        raise EvalServiceError(
            f"校准失败：{len(skipped)}/{len(labeled)} 条请求失败（过半），样本不足以校准。"
        )
    if skipped:
        print(f"[eval_retrieval] 警告：{len(skipped)}/{len(labeled)} 条被跳过，校准基于其余样本。")
    return grid_search_thresholds(scored)


def render_calibration_report(outcomes: list[dict[str, Any]], qa_golden: list[dict[str, Any]], dry_run: bool) -> str:
    """把校准结果渲染成人读文本（建议值 + Top10 表格），不修改任何代码."""
    if not qa_golden:
        return "[eval_retrieval] qa_golden 为空，无法校准（跳过网络请求）。"
    if dry_run:
        return "[eval_retrieval] --dry-run：跳过网络请求，未产出校准建议（仅用于验证参数解析）。"
    if not outcomes:
        return "[eval_retrieval] 没有可用于校准的已标注样本（label 需为 answerable/restricted/unanswerable 之一）。"

    best = outcomes[0]
    lines = [
        f"[eval_retrieval] 建议阈值：t_high={best['t_high']}, t_mid={best['t_mid']}"
        f"（一致率 {best['accuracy']:.2%}，样本数 {best['n']}）",
        "（仅打印建议值，未修改任何代码；请人工同步进 decision_service.HF_THRESHOLDS）",
        "",
        "| t_high | t_mid | accuracy | n |",
        "| --- | --- | --- | --- |",
    ]
    for o in outcomes[:10]:
        lines.append(f"| {o['t_high']} | {o['t_mid']} | {o['accuracy']:.2%} | {o['n']} |")
    return "\n".join(lines)


# ── CLI ──────────────────────────────────────────────────────────────────────


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="eval_retrieval.py",
        description="KnowledgeCore 检索/决策评估脚本（817 行动方案 T2.1）。",
    )
    parser.add_argument("--golden", type=Path, default=DEFAULT_RETRIEVAL_GOLDEN, help="retrieval_golden.jsonl 路径")
    parser.add_argument(
        "--qa-golden", type=Path, default=DEFAULT_QA_GOLDEN, help="qa_golden.jsonl 路径（--calibrate 模式使用）"
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("KNOWLEDGE_BASE_URL", DEFAULT_BASE_URL),
        help="KnowledgeCore 服务地址（默认读环境变量 KNOWLEDGE_BASE_URL，否则 http://localhost:8010/api/v1）",
    )
    parser.add_argument(
        "--domain",
        default=os.environ.get("KNOWLEDGE_EVAL_DOMAIN", DEFAULT_DOMAIN),
        help="查询使用的领域编码（knowledge_domain.code，默认 agent）",
    )
    parser.add_argument("--top-k", type=int, default=DEFAULT_TOP_K, help="GET /knowledge/chunks 的 limit 参数")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="单次 HTTP 请求超时秒数")
    parser.add_argument(
        "--calibrate", action="store_true", help="切到 HF 阈值校准模式：对 qa_golden 网格搜索 (t_high, t_mid)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="不发起任何网络请求，仅验证 golden 文件格式与报告 schema（无需服务在线）",
    )
    parser.add_argument("--output", type=Path, default=None, help="额外把 JSON 报告写入该文件")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    base_url = str(args.base_url).rstrip("/")

    try:
        if args.calibrate:
            qa_golden = load_jsonl(args.qa_golden)
            outcomes = asyncio.run(
                run_calibration(qa_golden, base_url, args.domain, args.dry_run, args.timeout)
            )
            print(render_calibration_report(outcomes, qa_golden, args.dry_run))
            return 0

        golden = load_jsonl(args.golden)
        results = asyncio.run(
            run_retrieval_eval(golden, base_url, args.domain, args.top_k, args.dry_run, args.timeout)
        )
        report = build_report(results)
    except EvalServiceError as exc:
        print(f"[eval_retrieval] 评估失败：{exc}", file=sys.stderr)
        return 1

    report_json = json.dumps(report, ensure_ascii=False, indent=2)
    print(report_json)
    print()
    print(render_markdown_table(report))
    if args.output:
        args.output.write_text(report_json, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
