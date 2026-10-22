"""qb CLI —— 题库管理命令行（运维/批量操作入口）.

用法示例：
    qb list --category 72 --status active
    qb get 1001
    qb create --type single_choice --difficulty 3 --stem "…" --options "A:…|B:…|C:…|D:…" --answer B
    qb review 1001 --status active
    qb deprecate 1001
    qb import questions.json
    qb stats --category 72
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import sys
from datetime import datetime, timezone
from typing import Any

import click

from questionbank.config import get_settings
from questionbank.llm import LLMClient
from questionbank.services.question import (
    DuplicateQuestionError,
    KnowledgePointRef,
    QuestionCreate,
    QuestionNotFoundError,
    QuestionService,
    QuestionUpdate,
    ValidationError,
)
from questionbank.store import QuestionStore


def _service() -> QuestionService:
    return QuestionService(QuestionStore(get_settings()))


def _parse_options(spec: str | None) -> list[dict[str, str]] | None:
    """'A:选项一|B:选项二' → [{"key":"A","text":"选项一"}, …]."""
    if not spec:
        return None
    options = []
    for part in spec.split("|"):
        part = part.strip()
        if ":" in part:
            key, _, text = part.partition(":")
        elif " " in part:
            key, _, text = part.partition(" ")
        else:
            raise click.BadParameter(f"选项格式应为 key:text，收到: {part!r}")
        options.append({"key": key.strip().upper(), "text": text.strip()})
    return options


def _parse_answer(question_type: str, answer: str | None) -> Any:
    if answer is None:
        return None
    if question_type == "true_false":
        return answer.strip().lower() == "true"
    if question_type == "multiple_choice":
        return [a.strip().upper() for a in answer.split(",") if a.strip()]
    return answer.strip()


def _parse_kps(spec: str | None) -> list[dict[str, Any]] | None:
    """'71:primary|120:secondary' → [{"category_id":71,"role":"primary"}, …]."""
    if not spec:
        return None
    points = []
    for part in spec.split("|"):
        part = part.strip()
        if not part:
            continue
        bits = part.split(":")
        cid = int(bits[0])
        role = bits[1] if len(bits) > 1 else "primary"
        weight = float(bits[2]) if len(bits) > 2 else 1.0
        points.append({"category_id": cid, "role": role, "weight": weight})
    return points


def _print_json(payload: Any) -> None:
    click.echo(json.dumps(payload, ensure_ascii=False, indent=2, default=str))


@click.group()
def cli() -> None:
    """ITN QuestionBank 题库管理 CLI."""


@cli.command("list")
@click.option("--category", type=int, default=None, help="知识点 category_id")
@click.option("--type", "question_type", default=None, help="题型过滤")
@click.option("--difficulty", type=int, default=None, help="难度 1~5")
@click.option("--status", default=None, help="状态过滤")
@click.option("--keyword", default=None, help="题干关键词")
@click.option("--page", type=int, default=0)
@click.option("--size", type=int, default=20)
def list_questions(category, question_type, difficulty, status, keyword, page, size):
    """查询题目（分页）."""
    try:
        result = _service().search(
            category_id=category, question_type=question_type, difficulty=difficulty,
            status=status, keyword=keyword, page=page, size=size,
        )
    except Exception as exc:  # noqa: BLE001
        raise click.ClickException(f"查询失败: {exc}") from exc
    _print_json({"total": result["total"], "items": result["items"]})


@cli.command("get")
@click.argument("question_id", type=int)
def get_question(question_id: int):
    """题目详情（含知识点关联）."""
    try:
        record = _service().get(question_id)
    except QuestionNotFoundError as exc:
        raise click.ClickException(str(exc)) from exc
    _print_json(record)


@cli.command("create")
@click.option("--type", "question_type", required=True, help="single_choice/multiple_choice/true_false/short_answer")
@click.option("--difficulty", type=int, default=3, help="难度 1~5")
@click.option("--cognitive-level", default="remember")
@click.option("--stem", required=True, help="题干")
@click.option("--options", "options_spec", default=None, help="'A:…|B:…|C:…|D:…'")
@click.option("--answer", required=True, help="参考答案（多选用逗号分隔，判断用 true/false）")
@click.option("--explanation", default=None)
@click.option("--status", default="proposed")
@click.option("--source", "source_type", default="human", help="human/llm/imported")
@click.option("--kp", "kp_spec", default=None, help="'71:primary|120:secondary'")
@click.option("--created-by", default="cli")
def create_question(question_type, difficulty, cognitive_level, stem, options_spec,
                    answer, explanation, status, source_type, kp_spec, created_by):
    """创建题目（防线1 校验 + content_hash 去重）."""
    try:
        record = _service().create(
            QuestionCreate(
                question_type=question_type,
                difficulty=difficulty,
                cognitive_level=cognitive_level,
                stem=stem,
                options=_parse_options(options_spec),
                reference_answer=_parse_answer(question_type, answer),
                explanation=explanation,
                status=status,
                source_type=source_type,
                knowledge_points=[KnowledgePointRef(**p) for p in (_parse_kps(kp_spec) or [])] or None,
                created_by=created_by,
            )
        )
    except DuplicateQuestionError as exc:
        raise click.ClickException(f"重复题目（幂等跳过）: {exc}") from exc
    except ValidationError as exc:
        raise click.ClickException(f"校验失败: {exc}") from exc
    _print_json(record)


@cli.command("review")
@click.argument("question_id", type=int)
@click.option("--status", default=None, type=click.Choice(["active", "rejected"]), help="人工审核：proposed → active/rejected")
@click.option("--ai", is_flag=True, help="AI 审题（防线3）：四检查项 + 自动闭环，不需要 --status")
def review_question(question_id: int, status: str | None, ai: bool):
    """审核题目：人工（--status）或 AI（--ai，自动闭环）."""
    if ai:
        asyncio.run(_ai_review_cli(question_id))
        return
    if status is None:
        raise click.ClickException("请提供 --status active|rejected 或 --ai")
    try:
        record = _service().set_status(question_id, status)
    except (QuestionNotFoundError, ValidationError) as exc:
        raise click.ClickException(str(exc)) from exc
    _print_json({"id": record["id"], "status": record["status"]})


async def _ai_review_cli(question_id: int) -> None:
    from questionbank.services.question.reviewer import QuestionReviewer
    from questionbank.services.knowledge_core import KnowledgeCore

    settings = get_settings()
    svc = _service()
    try:
        q = svc.get(question_id)
    except QuestionNotFoundError as exc:
        raise click.ClickException(str(exc)) from exc
    primary = next((p for p in q.get("knowledge_points", []) if p["role"] == "primary"), None)
    if primary is None:
        raise click.ClickException("题目未关联知识点（primary），无法审题")
    if not settings.knowledge_core_url:
        raise click.ClickException("KNOWLEDGE_CORE_URL 未配置，无法审题")
    kc = KnowledgeCore.from_url(
        settings.knowledge_core_url,
        timeout=settings.knowledge_core_timeout,
        secret=settings.kc_internal_secret,
    )
    try:
        context = await kc.get_context(category_id=primary["category_id"], purpose="review")
    finally:
        await kc.aclose()
    verdict = await QuestionReviewer(LLMClient(settings)).review(q, context)
    # 落库 metadata.ai_review
    meta = dict(q.get("metadata") or {})
    meta["ai_review"] = {
        "verdict": verdict.model_dump(),
        "summary": verdict.summary(),
        "reviewed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    svc.update(question_id, QuestionUpdate(metadata=meta))
    if verdict.passed:
        svc.set_status(question_id, "active")
    elif q["status"] == "proposed":
        svc.set_status(question_id, "rejected")
    _print_json({"id": question_id, "passed": verdict.passed, "summary": verdict.summary(), "status": svc.get(question_id)["status"], "issues": verdict.issues})


@cli.command("deprecate")
@click.argument("question_id", type=int)
def deprecate_question(question_id: int):
    """下架：active → deprecated（软删除）."""
    try:
        record = _service().set_status(question_id, "deprecated")
    except (QuestionNotFoundError, ValidationError) as exc:
        raise click.ClickException(str(exc)) from exc
    _print_json({"id": record["id"], "status": record["status"]})


@cli.command("import")
@click.argument("file", type=click.Path(exists=True, dir_okay=False))
def import_questions(file: str):
    """批量导入 JSON 文件（数组，幂等：content_hash 命中跳过）."""
    try:
        with open(file, encoding="utf-8") as f:
            raw = json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        raise click.ClickException(f"读取文件失败: {exc}") from exc
    if not isinstance(raw, list):
        raise click.ClickException("JSON 文件必须是题目对象数组")
    items = []
    errors: list[dict[str, Any]] = []
    for idx, obj in enumerate(raw):
        try:
            items.append(QuestionCreate.model_validate(obj))
        except Exception as exc:  # noqa: BLE001
            errors.append({"index": idx, "error": str(exc)})
    if errors:
        click.echo(json.dumps({"parse_errors": errors}, ensure_ascii=False, indent=2), err=True)
    if not items:
        return
    try:
        result = _service().import_batch(items)
    except Exception as exc:  # noqa: BLE001
        raise click.ClickException(f"导入失败: {exc}") from exc
    _print_json(result)


@cli.command("stats")
@click.option("--category", type=int, default=None, help="仅统计某知识点的题目")
def stats(category: int | None):
    """题目统计（总数/状态/题型分布）."""
    svc = _service()
    result = svc.search(category_id=category, size=1)
    total = result["total"]
    by_status: dict[str, int] = {}
    by_type: dict[str, int] = {}
    page, size = 0, 100
    while True:
        page_result = svc.search(category_id=category, page=page, size=size)
        items = page_result["items"]
        if not items:
            break
        for q in items:
            by_status[q["status"]] = by_status.get(q["status"], 0) + 1
            by_type[q["question_type"]] = by_type.get(q["question_type"], 0) + 1
        if len(items) < size:
            break
        page += 1
    _print_json({"category_id": category, "total": total, "by_status": by_status, "by_type": by_type})


@cli.command("select")
@click.option("--user", "user_id", required=True, help="用户标识")
@click.option("--category", type=int, default=None, help="知识点 category_id")
@click.option("--count", type=int, default=5)
@click.option("--type", "question_type", default=None)
@click.option("--difficulty", type=int, default=None)
@click.option("--exclude-days", type=int, default=7, help="排除近 N 天做过的题")
def select_questions(user_id, category, count, question_type, difficulty, exclude_days):
    """为用户取题（active，错题优先，剥离答案字段）."""
    from questionbank.services.question import QuestionSelector

    try:
        result = QuestionSelector(_service()).select(
            user_id, category_id=category, count=count, question_type=question_type,
            difficulty=difficulty, exclude_recent_days=exclude_days,
        )
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    _print_json(result)


@cli.command("submit")
@click.option("--user", "user_id", required=True)
@click.option("--question", "question_id", type=int, required=True)
@click.option("--answer", "submitted_answer", required=True, help="提交的答案")
@click.option("--judge-mode", default="auto", type=click.Choice(["auto", "none"]))
@click.option("--duration-ms", type=int, default=None)
def submit_answer(user_id, question_id, submitted_answer, judge_mode, duration_ms):
    """提交作答（客观题规则判分；主观题 AI 判分或仅记录）."""
    from questionbank.llm import LLMClient
    from questionbank.services.knowledge_core import KnowledgeCore
    from questionbank.services.question import AttemptService

    settings = get_settings()
    kc = (
        KnowledgeCore.from_url(
            settings.knowledge_core_url,
            timeout=settings.knowledge_core_timeout,
            secret=settings.kc_internal_secret,
        )
        if settings.knowledge_core_url else None
    )
    attempt = AttemptService(_service().store, _service(), LLMClient(settings), kc)
    try:
        result = asyncio.run(
            attempt.submit(
                user_id, question_id, submitted_answer,
                judge_mode=judge_mode, duration_ms=duration_ms,
            )
        )
    except Exception as exc:  # noqa: BLE001
        raise click.ClickException(f"提交失败: {exc}") from exc
    _print_json(result)


@cli.command("attempts")
@click.option("--user", "user_id", required=True)
@click.option("--question", type=int, default=None)
@click.option("--page", type=int, default=0)
@click.option("--size", type=int, default=20)
def list_attempts(user_id, question, page, size):
    """用户作答历史."""
    result = _service().store.list_attempts(user_id, question_id=question, page=page, size=size)
    _print_json(result)


@cli.command("revalidate-mark")
@click.option("--chunks", required=True, help="变更的知识切片 id（逗号分隔）")
@click.option("--reason", default="knowledge_changed")
def revalidate_mark(chunks: str, reason: str):
    """知识变更后标记引用切片的题目待重审."""
    from questionbank.services.question import RevalidationService

    chunk_ids = [int(c.strip()) for c in chunks.split(",") if c.strip()]
    result = RevalidationService(_service().store, _service()).mark_by_chunk_ids(chunk_ids, reason=reason)
    _print_json(result)


@cli.command("revalidate")
@click.argument("question_id", type=int)
def revalidate_question(question_id: int):
    """重审单题（快照+当前证据）：通过 active / 不通过 deprecated."""
    from questionbank.llm import LLMClient
    from questionbank.services.knowledge_core import KnowledgeCore
    from questionbank.services.question import QuestionNotFoundError, RevalidationService
    from questionbank.services.question.reviewer import QuestionReviewer

    settings = get_settings()
    service = _service()
    try:
        record = service.get(question_id)
    except QuestionNotFoundError as exc:
        raise click.ClickException(str(exc)) from exc
    primary = next((p for p in record.get("knowledge_points", []) if p["role"] == "primary"), None)
    if primary is None:
        raise click.ClickException("题目未关联知识点（primary），无法重审")
    if not settings.knowledge_core_url:
        raise click.ClickException("KNOWLEDGE_CORE_URL 未配置，无法重审")

    async def run():
        kc = KnowledgeCore.from_url(
            settings.knowledge_core_url,
            timeout=settings.knowledge_core_timeout,
            secret=settings.kc_internal_secret,
        )
        try:
            context = await kc.get_context(category_id=primary["category_id"], purpose="review")
            snapshot = await kc.get_evidence(record.get("evidence_refs") or [])
        finally:
            await kc.aclose()
        context = QuestionReviewer.merge_snapshot_evidence(context, snapshot)
        return await RevalidationService(service.store, service).revalidate(
            question_id, QuestionReviewer(LLMClient(settings)), context
        )

    _print_json(asyncio.run(run()))


# ── T4.3 作答数据投票（graph-vote：先修边有效性双样本比例检验） ────────────────
#
# 对每条 proposed/active 先修边 A→B：取 B 知识点相关题的作答，按作答者对 A 的
# 掌握度分组（>=0.7 高组 / <0.4 低组，中间地带丢弃），双样本比例检验两组正确率
# 有无显著差异。n_each>=30 才出结论；显著为负（掌握 A 组反而更差，说明 A→B 这条
# 先修关系可能不成立/方向搞反）→ 边标 needs_review。
#
# 写库双重守门（手册"KNOWLEDGE_ALLOW_WRITE 类开关或 --apply 参数守门，默认只读
# 输出"）：默认只打印检验结果，不碰数据库；--apply 且环境变量
# KNOWLEDGE_ALLOW_WRITE 为真值时才真正 PATCH confidence / evidence_json.vote。


def _norm_cdf(x: float) -> float:
    """标准正态分布累积分布函数（stdlib math.erf 实现，不引入 scipy 依赖）."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _two_proportion_ztest(x1: int, n1: int, x2: int, n2: int) -> dict[str, float]:
    """双样本比例检验（正态近似，合并方差）.

    返回 {p_high, p_low, diff, z, p_value}；diff = p_high - p_low。
    """
    p1 = x1 / n1
    p2 = x2 / n2
    p_pool = (x1 + x2) / (n1 + n2)
    if p_pool <= 0.0 or p_pool >= 1.0:
        # 两组要么全对要么全错，方差为 0：差异视为无法用正态近似检验，标记不显著
        return {"p_high": p1, "p_low": p2, "diff": p1 - p2, "z": 0.0, "p_value": 1.0}
    se = math.sqrt(p_pool * (1 - p_pool) * (1 / n1 + 1 / n2))
    z = (p1 - p2) / se
    p_value = 2 * (1 - _norm_cdf(abs(z)))
    return {"p_high": p1, "p_low": p2, "diff": p1 - p2, "z": z, "p_value": p_value}


def _vote_for_edge(
    edge: dict[str, Any],
    high: list[int],
    low: list[int],
    *,
    min_n: int = 30,
    alpha: float = 0.05,
) -> dict[str, Any]:
    """单条边的检验结论（纯函数，便于构造数据单测）.

    edge 需含 id/category_id/prereq_category_id/confidence；high/low 为对应分组的
    is_correct（0/1）列表。返回 dict 至少含 conclusive；conclusive=True 时含
    new_confidence（启发式：显著负→降 0.3 下限 0.1；显著正→升 0.1 上限 1.0；
    不显著→维持原值）与 needs_review。
    """
    n_high, n_low = len(high), len(low)
    base = {
        "edge_id": int(edge["id"]),
        "category_id": int(edge["category_id"]),
        "prereq_category_id": int(edge["prereq_category_id"]),
        "old_confidence": float(edge["confidence"]),
        "n_high": n_high,
        "n_low": n_low,
    }
    if n_high < min_n or n_low < min_n:
        return {
            **base,
            "conclusive": False,
            "reason": f"样本不足（要求 n_each>={min_n}，实际 high={n_high}, low={n_low}）",
        }

    stat = _two_proportion_ztest(sum(high), n_high, sum(low), n_low)
    significant = stat["p_value"] < alpha
    significant_negative = significant and stat["diff"] < 0
    significant_positive = significant and stat["diff"] > 0
    if significant_negative:
        new_confidence = round(max(0.1, base["old_confidence"] - 0.3), 4)
    elif significant_positive:
        new_confidence = round(min(1.0, base["old_confidence"] + 0.1), 4)
    else:
        new_confidence = base["old_confidence"]
    return {
        **base,
        "conclusive": True,
        **stat,
        "significant": significant,
        "significant_negative": significant_negative,
        "significant_positive": significant_positive,
        "new_confidence": new_confidence,
        "needs_review": significant_negative,
    }


@cli.command("graph-vote")
@click.option("--domain", type=int, default=None, help="仅处理该领域的先修边（缺省全部）")
@click.option("--min-n", "min_n", type=int, default=30, help="双样本比例检验最小样本量（每组）")
@click.option("--alpha", type=float, default=0.05, help="显著性水平")
@click.option(
    "--apply", "apply_write", is_flag=True, default=False,
    help="写库（PATCH confidence / evidence_json.vote，显著为负置 needs_review）；"
    "缺省仅打印只读检验结果。还需环境变量 KNOWLEDGE_ALLOW_WRITE=true 才会真正写库。",
)
def graph_vote(domain: int | None, min_n: int, alpha: float, apply_write: bool):
    """T4.3 作答数据投票：按对先修知识点 A 的掌握度分组，双样本比例检验 A→B 边的有效性.

    默认只读（打印每条边的检验结果，不写库）；--apply 且环境变量
    KNOWLEDGE_ALLOW_WRITE=true 同时满足时，才 PATCH 回
    knowledge_category_prerequisite.confidence 与 evidence_json.vote，
    显著为负（掌握 A 组反而更差）的边额外置 status=needs_review。
    """
    settings = get_settings()
    store = QuestionStore(settings)
    if not store.available():
        raise click.ClickException("MYSQL 未配置，无法读取作答/先修边数据")

    write_enabled = apply_write and os.environ.get("KNOWLEDGE_ALLOW_WRITE", "").strip().lower() in (
        "1", "true", "yes",
    )

    conn = store.connect()
    try:
        edges = store.list_prerequisite_edges(conn=conn)
        if domain is not None:
            edges = [e for e in edges if int(e["domain_id"]) == domain]

        results: list[dict[str, Any]] = []
        for edge in edges:
            groups = store.attempt_correctness_grouped_by_prereq_mastery(
                int(edge["category_id"]), int(edge["prereq_category_id"]), conn=conn,
            )
            vote = _vote_for_edge(edge, groups["high"], groups["low"], min_n=min_n, alpha=alpha)
            results.append(vote)

        applied = 0
        for vote in results:
            if not vote["conclusive"]:
                continue
            if apply_write and not write_enabled:
                vote["apply_skipped"] = "KNOWLEDGE_ALLOW_WRITE 未开启，跳过写库（仅 --apply 不足以写库）"
                continue
            if write_enabled:
                store.patch_prerequisite_edge_vote(
                    vote["edge_id"],
                    confidence=vote["new_confidence"],
                    vote=vote,
                    needs_review=vote["needs_review"],
                    conn=conn,
                )
                vote["applied"] = True
                applied += 1
        if write_enabled:
            conn.commit()
    finally:
        conn.close()

    _print_json(
        {
            "total_edges": len(edges),
            "conclusive": sum(1 for v in results if v["conclusive"]),
            "needs_review": sum(1 for v in results if v.get("needs_review")),
            "applied": applied,
            "write_enabled": write_enabled,
            "items": results,
        }
    )


if __name__ == "__main__":
    sys.exit(cli())
