"""Rule Engine 核心（确定性 Python 逻辑，禁止依赖 LLM —— §20 铁律）.

职责：
1. 条件匹配（EQ/NE/GT/GTE/LT/LTE/IN/NOT_IN/EXISTS，AND 语义）
2. SET 结论派生新事实
3. 有限前向推理（MAX_REASONING_ROUNDS 轮，每条规则单次 evaluate 只 fire 一次）
4. 产出 Generation Constraints + reasoning_trace
"""
from __future__ import annotations

from typing import Any, Callable, Sequence

from .constants import MAX_REASONING_ROUNDS
from .field_registry import field_registry
from .schemas import (
    ConstraintItem,
    DomainRuleSchema,
    ReasoningStep,
    RuleEvaluationResult,
)


# ── 数值解析 ─────────────────────────────────────────────────────────

def _to_number(value: Any) -> float | None:
    """尽力把值转成数值；失败返回 None（如 '3' / '3m' / '3.0'）."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip().lower()
        # 去掉常见中文单位
        for unit in ("米", "毫米", "厘米", "分钟", "小时", "个", "条", "次",
                     "m", "mm", "cm", "min", "h", "kg", "v", "kv", "%"):
            if s.endswith(unit):
                s = s[: -len(unit)].strip()
        try:
            return float(s)
        except ValueError:
            return None
    return None


def _coerce_for_compare(fact_value: Any, rule_value: Any) -> tuple[Any, Any]:
    """比较前做类型归一：两边都是数值则比数值，否则比字符串."""
    a, b = _to_number(fact_value), _to_number(rule_value)
    if a is not None and b is not None:
        return a, b
    return (
        str(fact_value).strip().lower() if fact_value is not None else "",
        str(rule_value).strip().lower() if rule_value is not None else "",
    )


def _lookup_fact(field: str, facts: dict[str, Any]) -> tuple[str, Any]:
    """按 canonical + 全部别名查找事实（§10 字段对齐，双向）.

    返回 (命中的字段名, 值)；未找到返回 (canonical, None).
    """
    canonical = field_registry.normalize(field)
    for candidate in field_registry.aliases_of(canonical):
        if candidate in facts and facts[candidate] is not None:
            return candidate, facts[candidate]
    return canonical, None


# ── 单条件匹配 ───────────────────────────────────────────────────────

def _match_condition(field: str, operator: str, value: Any,
                     facts: dict[str, Any]) -> tuple[bool, str]:
    """返回 (matched, reason)."""
    field_label, fact_value = _lookup_fact(field, facts)

    if operator == "EXISTS":
        return (fact_value is not None), f"{field_label} EXISTS"

    if fact_value is None:
        return False, f"{field_label} 缺失，无法匹配 {operator}"

    if operator in ("EQ", "NE"):
        a, b = _coerce_for_compare(fact_value, value)
        ok = (a == b) if operator == "EQ" else (a != b)
        return ok, f"{field_label}={fact_value} {operator} {value}"

    if operator in ("IN", "NOT_IN"):
        allowed = value if isinstance(value, (list, tuple)) else [value]
        fact_str = str(fact_value).strip().lower()
        hit = any(str(v).strip().lower() == fact_str for v in allowed)
        ok = hit if operator == "IN" else not hit
        return ok, f"{field_label}={fact_value} {operator} {allowed}"

    if operator in ("GT", "GTE", "LT", "LTE"):
        a, b = _coerce_for_compare(fact_value, value)
        if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
            return False, f"{field_label}={fact_value} 非数值，无法 {operator} {value}"
        ok = {
            "GT": a > b,
            "GTE": a >= b,
            "LT": a < b,
            "LTE": a <= b,
        }[operator]
        return ok, f"{field_label}={fact_value} {operator} {value}"

    return False, f"未知运算符 {operator}"


def match_conditions(conditions: Sequence, facts: dict[str, Any]) -> tuple[bool, str]:
    """AND 语义：全部成立才命中（§11.1）."""
    reasons: list[str] = []
    for cond in conditions:
        ok, reason = _match_condition(
            cond.field, cond.operator, cond.value, facts
        )
        reasons.append(reason)
        if not ok:
            return False, "AND 失败: " + reason
    return True, "AND 全部成立: " + " | ".join(reasons)


# ── 前向推理主流程 ───────────────────────────────────────────────────

def evaluate(
    facts: dict[str, Any],
    rules: Sequence[DomainRuleSchema],
    max_rounds: int = MAX_REASONING_ROUNDS,
    now_fn: Callable | None = None,
) -> RuleEvaluationResult:
    """有限前向推理（§11.2 / §11.3 / §12）.

    同步轮语义（与 §12 示例一致）：
    - 每轮开始时基于当前 facts 快照求值全部未 fire 规则
    - 本轮命中的 SET 结论在本轮结束后统一写入 facts（下一轮才可见）
    - 每条规则单次 evaluate 只 fire 一次（防重复/防环）
    - 最多 max_rounds 轮，本轮无新事实则提前收敛
    """
    work_facts: dict[str, Any] = dict(facts or {})
    fired: set[str] = set()
    derived: dict[str, Any] = {}
    derived_meta: dict[str, str] = {}
    constraints: list[ConstraintItem] = []
    trace: list[ReasoningStep] = []
    matched_codes: list[str] = []

    for rnd in range(1, max_rounds + 1):
        # 本轮求值快照（§12：第 1 轮只能看到初始事实）
        round_facts = dict(work_facts)
        new_facts: dict[str, Any] = {}
        changed = False

        for rule in rules:
            if rule.rule_code in fired:
                continue
            ok, reason = match_conditions(rule.conditions, round_facts)
            if not ok:
                continue
            # 命中：fire 一次
            fired.add(rule.rule_code)
            matched_codes.append(rule.rule_code)
            for conclusion in rule.conclusions:
                if conclusion.type == "SET":
                    new_field = field_registry.normalize(conclusion.field or "")
                    new_facts.setdefault(new_field, conclusion.value)
                    derived_meta.setdefault(new_field, rule.rule_code)
                    if new_field not in work_facts or work_facts.get(new_field) != conclusion.value:
                        changed = True
                    trace.append(ReasoningStep(
                        round=rnd,
                        rule=rule.rule_code,
                        reason=reason,
                        result=f"SET {new_field}={conclusion.value}",
                    ))
                elif conclusion.type in ("MUST", "MUST_NOT", "SHOULD"):
                    constraints.append(ConstraintItem(
                        rule_code=rule.rule_code,
                        type=conclusion.type,
                        content=conclusion.content,
                        source=rule.source_section,
                    ))
                    trace.append(ReasoningStep(
                        round=rnd,
                        rule=rule.rule_code,
                        reason=reason,
                        result=f"{conclusion.type} {conclusion.content}",
                    ))

        # 轮末统一应用本轮派生事实
        for new_field, new_value in new_facts.items():
            work_facts[new_field] = new_value
            if new_field not in facts:
                derived[new_field] = new_value

        if not changed:
            break

    return RuleEvaluationResult(
        input_facts=dict(facts or {}),
        derived_facts=derived,
        matched_rules=matched_codes,
        constraints=constraints,
        reasoning_trace=trace,
    )
