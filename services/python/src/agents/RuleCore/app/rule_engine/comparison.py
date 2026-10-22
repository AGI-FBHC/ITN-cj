"""A/B 对照编排（§24.5，演示命脉）.

同一输入、同一模型、同一知识上下文，只变一个变量（有无 Rule Constraints）。
对照纪律：
- 不做假对照（A 臂不削弱）
- 同一套 Rule Checker、同一约束清单
- 两臂原始输出与校验结果如实存档
- 异步执行，状态可轮询
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from app.core.config import settings
from app.core.database import db_session
from app.rule_engine.engine import evaluate
from app.rule_engine.fact_extractor import extract_facts
from app.rule_engine.lightweight_generation import (
    generate_content,
    retrieve_knowledge,
)
from app.rule_engine.repositories import rule_repository as repo
from app.rule_engine.rule_checker import check_content
from app.rule_engine.rule_revision import revise
from app.rule_engine.schemas import ConstraintItem, RuleEvaluationResult

# 后台任务表（内存）——MVP 用内存 + DB 双写，重启后 DB 仍可查
_TASKS: dict[str, dict[str, Any]] = {}


def _new_task_id() -> str:
    return f"cmp_{uuid.uuid4().hex[:12]}"


def _save_compare(task: dict) -> None:
    """把对照任务持久化到 rule_compare 表（演示证据存档）."""
    with db_session() as cur:
        cur.execute(
            "INSERT INTO rule_compare "
            "(task_id, task_text, status, request_id_a, request_id_b, facts_json, "
            " constraints_json, knowledge_json, output_a, output_b, output_b_revised, "
            " check_a_json, check_b_json, check_b_revised_json, reasoning_trace_json, error) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
            "ON DUPLICATE KEY UPDATE "
            " status=VALUES(status), request_id_a=VALUES(request_id_a), "
            " request_id_b=VALUES(request_id_b), facts_json=VALUES(facts_json), "
            " constraints_json=VALUES(constraints_json), knowledge_json=VALUES(knowledge_json), "
            " output_a=VALUES(output_a), output_b=VALUES(output_b), "
            " output_b_revised=VALUES(output_b_revised), check_a_json=VALUES(check_a_json), "
            " check_b_json=VALUES(check_b_json), check_b_revised_json=VALUES(check_b_revised_json), "
            " reasoning_trace_json=VALUES(reasoning_trace_json), error=VALUES(error)",
            (
                task["task_id"],
                task.get("task_text", ""),
                task.get("status", "PENDING"),
                task.get("request_id_a"),
                task.get("request_id_b"),
                json.dumps(task.get("facts", {}), ensure_ascii=False),
                json.dumps([c.model_dump() for c in task.get("constraints", [])], ensure_ascii=False)
                if task.get("constraints") else None,
                json.dumps(task.get("knowledge_meta", {}), ensure_ascii=False),
                task.get("output_a"),
                task.get("output_b"),
                task.get("output_b_revised"),
                json.dumps(task.get("check_a"), ensure_ascii=False),
                json.dumps(task.get("check_b"), ensure_ascii=False),
                json.dumps(task.get("check_b_revised"), ensure_ascii=False),
                json.dumps(task.get("reasoning_trace", []), ensure_ascii=False),
                task.get("error"),
            ),
        )


def _to_check_dict(result) -> dict:
    """CheckResult → 可 JSON 化的 dict."""
    return {
        "passed": result.passed,
        "results": [
            {
                "rule_code": r.rule_code,
                "status": r.status,
                "evidence": r.evidence,
                "reason": r.reason,
            }
            for r in result.results
        ],
    }


def _pass_count(check_dict: dict | None) -> int:
    if not check_dict:
        return 0
    return sum(1 for r in check_dict.get("results", []) if r.get("status") == "PASS")


def _build_summary(check_a: dict | None, check_b: dict | None,
                   check_b_revised: dict | None, constraints: list | None) -> dict:
    """对照摘要（内存路径与 DB 回退路径共用，单一事实来源）."""
    return {
        "arm_a_pass": _pass_count(check_a),
        "arm_b_pass": _pass_count(check_b_revised or check_b),
        "arm_b_revised_pass": _pass_count(check_b_revised) if check_b_revised else None,
        "constraint_total": len(constraints or []),
        "a_failed": [r["rule_code"] for r in (check_a or {}).get("results", []) if r.get("status") == "FAIL"],
        "b_final_failed": [r["rule_code"] for r in ((check_b_revised or check_b) or {}).get("results", []) if r.get("status") == "FAIL"],
    }


def _matched_from_trace(trace: list | None) -> list[str]:
    """从 reasoning_trace 重建命中规则清单.

    engine.evaluate() 的 trace 只追加 fire（命中）的规则，未命中规则不产生
    trace 条目；每条规则可有多个步骤（SET + MUST），按首次出现顺序去重。
    """
    seen: list[str] = []
    for step in trace or []:
        code = step.get("rule") if isinstance(step, dict) else None
        if code and code not in seen:
            seen.append(code)
    return seen


async def _run_arm_b(task: dict, constraints: list[ConstraintItem],
                     knowledge_text: str, request_id: str) -> None:
    """B 臂：受控生成 → 检查 → (FAIL 则修正一次 → 复查）."""
    task["request_id_b"] = request_id
    task["output_b"] = await generate_content(
        task["task_text"], knowledge_text, constraints=constraints
    )
    check_b = await check_content(task["output_b"], constraints)
    task["check_b"] = _to_check_dict(check_b)
    for item in check_b.results:
        repo.set_check_result(request_id, item.rule_code, item.status,
                              item.evidence or item.reason)

    # 自动修正一次（§16）
    if not check_b.passed and settings.MAX_REVISION_RETRY >= 1:
        task["status"] = "RUNNING"
        revised = await revise(task["output_b"], check_b.results, constraints)
        if revised and revised != task["output_b"]:
            task["output_b_revised"] = revised
            check_b2 = await check_content(revised, constraints)
            task["check_b_revised"] = _to_check_dict(check_b2)
            for item in check_b2.results:
                repo.set_check_result(request_id, item.rule_code, item.status,
                                      item.evidence or item.reason)


async def _run_compare(task_id: str) -> None:
    task = _TASKS[task_id]
    try:
        task["status"] = "RUNNING"
        _save_compare(task)

        # STEP 1: 知识检索（两臂共用同一份）
        knowledge = retrieve_knowledge(task["task_text"], task.get("document_ids"))
        task["knowledge_text"] = knowledge["text"]
        task["knowledge_meta"] = {
            "chunks": knowledge["chunks"],
            "total_chars": sum(c["chars"] for c in knowledge["chunks"]),
        }

        # STEP 2: Fact 抽取
        facts = await extract_facts(task["task_text"])
        task["facts"] = facts

        # STEP 3: Rule Evaluate（确定性引擎）
        rules = repo.get_active_rules(task.get("document_id"))
        eval_result: RuleEvaluationResult = evaluate(facts, rules)
        constraints = eval_result.constraints
        task["constraints"] = constraints
        task["reasoning_trace"] = [t.model_dump() for t in eval_result.reasoning_trace]
        task["matched_rules"] = eval_result.matched_rules
        task["derived_facts"] = eval_result.derived_facts

        # 落 rule_execution（B 臂溯源）
        request_id_b = f"req_b_{task_id}"
        for r in rules:
            matched = r.rule_code in eval_result.matched_rules
            repo.record_execution(
                request_id_b, r, matched, facts,
                derived_facts=eval_result.derived_facts,
                arm="B",
            )

        knowledge_text = knowledge["text"] or "（无相关资料）"

        # STEP 4/5/6: A 臂（无约束）+ B 臂（有约束），同一知识、同一模型
        request_id_a = f"req_a_{task_id}"
        task["request_id_a"] = request_id_a

        async def arm_a():
            task["output_a"] = await generate_content(
                task["task_text"], knowledge_text, constraints=None
            )
            check_a = await check_content(task["output_a"], constraints)
            task["check_a"] = _to_check_dict(check_a)
            for item in check_a.results:
                repo.set_check_result(request_id_a, item.rule_code, item.status,
                                      item.evidence or item.reason)

        # A/B 并行生成（同一模型同一上下文，公平）
        await asyncio.gather(arm_a(), _run_arm_b(task, constraints, knowledge_text, request_id_b))

        # 汇总（与 DB 回退路径同一函数，保证两条路径摘要一致）
        task["summary"] = _build_summary(
            task.get("check_a"), task.get("check_b"),
            task.get("check_b_revised"), task.get("constraints") or [],
        )
        task["status"] = "DONE"
    except Exception as e:  # noqa: BLE001 — 错误隔离，不拖垮服务
        task["status"] = "FAILED"
        task["error"] = f"{type(e).__name__}: {e}"
    finally:
        _save_compare(task)


def start_compare(task_text: str, document_ids: list[int] | None = None,
                  document_id: int | None = None) -> str:
    """发起对照（异步，立即返回 task_id）."""
    if not settings.RULE_ENGINE_ENABLED:
        raise RuntimeError("Rule Engine 已被配置禁用 (RULE_ENGINE_ENABLED=false)")
    task_id = _new_task_id()
    _TASKS[task_id] = {
        "task_id": task_id,
        "task_text": task_text,
        "status": "PENDING",
        "document_id": document_id,
        "document_ids": document_ids or ([document_id] if document_id else None),
        "facts": {},
        "constraints": [],
        "knowledge_meta": {},
        "reasoning_trace": [],
    }
    _save_compare(_TASKS[task_id])
    asyncio.get_event_loop().create_task(_run_compare(task_id))
    return task_id


def get_compare(task_id: str) -> dict | None:
    """查询对照任务（优先内存，回退 DB）. 两条路径键名统一为 *_json 形态."""
    if task_id in _TASKS:
        t = dict(_TASKS[task_id])
        # 去掉不宜直接序列化的内部字段
        t.pop("knowledge_text", None)
        # 内存里的 constraints 是 ConstraintItem 对象，序列化为 constraints_json
        t["constraints_json"] = [c.model_dump() for c in t.get("constraints") or []]
        t.pop("constraints", None)
        # 统一键名：facts / reasoning_trace → *_json（与 DB 路径一致）
        t.setdefault("facts_json", t.get("facts"))
        t.setdefault("reasoning_trace_json", t.get("reasoning_trace"))
        # 统一键名：check_a / check_b / check_b_revised → *_json（与 DB 路径一致）
        for src, dst in (("check_a", "check_a_json"),
                         ("check_b", "check_b_json"),
                         ("check_b_revised", "check_b_revised_json")):
            if t.get(src) is not None:
                t[dst] = t[src]
        return t
    with db_session() as cur:
        cur.execute("SELECT * FROM rule_compare WHERE task_id=%s", (task_id,))
        row = cur.fetchone()
    if not row:
        return None
    d = dict(row)
    for col in ("facts_json", "constraints_json", "knowledge_json",
                "check_a_json", "check_b_json", "check_b_revised_json",
                "reasoning_trace_json"):
        if isinstance(d.get(col), str):
            d[col] = json.loads(d[col])
    d["document_id"] = None
    # 重建内存路径天然存在、但 DB 未持久化的两个派生字段：
    # - matched_rules：reasoning_trace 只记录 fire（命中）的规则，按首次出现去重
    # - summary：由 check JSON 重建（与内存路径同一 _build_summary）
    d.setdefault("matched_rules", _matched_from_trace(d.get("reasoning_trace_json")))
    if d.get("status") == "DONE":
        d.setdefault("summary", _build_summary(
            d.get("check_a_json"), d.get("check_b_json"),
            d.get("check_b_revised_json"), d.get("constraints_json") or [],
        ))
    return d


def list_compares(limit: int = 20) -> list[dict]:
    with db_session() as cur:
        cur.execute(
            "SELECT task_id, task_text, status, created_at, updated_at, error "
            "FROM rule_compare ORDER BY id DESC LIMIT %s",
            (limit,),
        )
        return [dict(r) for r in cur.fetchall()]
