"""Rule Verifier（§8.4，使用 LLM）+ Schema Validator（§8.5，程序级）.

Verifier 职责（只做验证，禁止创建新规则）：
- 条件是否来自原文
- 结论是否来自原文
- 有没有扩大规则适用范围
- 有没有遗漏关键条件
- 数值是否正确
- 单位是否正确
- MUST/MUST_NOT/SHOULD 强度是否正确

阈值（§8.4，配置控制）：
  confidence >= RULE_EXTRACT_CONFIDENCE_THRESHOLD → ACTIVE
  confidence <  阈值 → INVALID
"""
from __future__ import annotations

import json
from typing import Any

from app.core.config import settings
from app.rule_engine.constants import CONCLUSION_TYPES, OPERATORS
from app.rule_engine.llm import llm
from app.rule_engine.schemas import DomainRuleSchema, VerifyResult

VERIFIER_SYSTEM = """你是一个严格的规则校验器。给你一段领域规范原文和一条候选规则，
你的任务是**验证这条候选规则是否忠实于原文**，并给出置信度。

你只负责验证，**禁止创建、修改或补充任何规则**。

逐项检查：
1. 条件是否来自原文（每个 field/operator/value 是否能在原文找到依据）
2. 结论是否来自原文
3. 有没有扩大规则的适用范围（原文说 A，规则写成 A 或 B）
4. 有没有遗漏关键条件
5. 数值是否正确
6. 单位是否正确
7. MUST / MUST_NOT / SHOULD 强度是否正确（强制性 vs 禁止 vs 推荐）

输出 JSON 对象（不要代码块、不要解释）：
{
  "valid": true 或 false,
  "confidence": 0.0 到 1.0 之间的数字,
  "issues": ["问题1", "问题2"]
}

判定标准：
- 完全忠实于原文 → valid=true, confidence>=0.9
- 基本忠实但有轻微不精确 → valid=true, confidence 0.7~0.9
- 有明显偏离原文（扩大范围/遗漏条件/数值错误/强度错误）→ valid=false 或 confidence<0.8
"""


def _rule_to_text(rule: DomainRuleSchema) -> str:
    conds = " AND ".join(
        f"{c.field} {c.operator} {c.value if c.value is not None else ''}"
        + (f" {c.unit}" if c.unit else "")
        for c in rule.conditions
    )
    cons = "; ".join(
        (f"{cl.type} {cl.field}={cl.value}" if cl.type == "SET"
         else f"{cl.type} {cl.content or ''}")
        for cl in rule.conclusions
    )
    return f"IF {conds}\nTHEN {cons}"


def validate_schema(rule: DomainRuleSchema) -> list[str]:
    """程序级 Schema 校验（§8.5）. 返回问题列表；空列表 = 合法."""
    issues: list[str] = []

    # rule_code
    if not rule.rule_code or not str(rule.rule_code).strip():
        issues.append("rule_code 为空")

    # conditions
    if not rule.conditions:
        issues.append("缺少 conditions")
    for i, c in enumerate(rule.conditions):
        if c.operator not in OPERATORS:
            issues.append(f"条件{i} operator 非法: {c.operator}")
        if c.operator in ("GT", "GTE", "LT", "LTE") and c.value is None:
            issues.append(f"条件{i} {c.operator} 缺少数值")
        if c.operator == "EXISTS" and c.value is not None:
            issues.append(f"条件{i} EXISTS 不应有 value")
        if not c.field or not str(c.field).strip():
            issues.append(f"条件{i} field 为空")

    # conclusions
    if not rule.conclusions:
        issues.append("缺少 conclusions")
    for i, cl in enumerate(rule.conclusions):
        if cl.type not in CONCLUSION_TYPES:
            issues.append(f"结论{i} type 非法: {cl.type}")
            continue
        if cl.type == "SET":
            if not cl.field or cl.value is None:
                issues.append(f"结论{i} SET 缺少 field/value")
        else:  # MUST / MUST_NOT / SHOULD
            if not cl.content or not str(cl.content).strip():
                issues.append(f"结论{i} {cl.type} 缺少 content")

    # confidence
    if not (0.0 <= rule.confidence <= 1.0):
        issues.append(f"confidence 超出 0~1: {rule.confidence}")

    # source_text
    if not rule.source_text or not str(rule.source_text).strip():
        issues.append("缺少 source_text（必须保留原文）")

    return issues


def schema_is_valid(rule: DomainRuleSchema) -> bool:
    return not validate_schema(rule)


async def verify_rule(rule: DomainRuleSchema, source_text: str) -> VerifyResult:
    """LLM 自动校验（§8.4）."""
    prompt = (
        "【领域规范原文】\n"
        f"\"\"\"\n{source_text}\n\"\"\"\n\n"
        "【候选规则】\n"
        f"{_rule_to_text(rule)}\n\n"
        "请验证该候选规则是否忠实于原文，只输出 JSON 对象。"
    )
    raw = await llm.complete_json(
        system=VERIFIER_SYSTEM,
        prompt=prompt,
        fallback=None,
        temperature=0.0,
        max_tokens=settings.LLM_MAX_TOKENS,  # 推理模型需预留 reasoning token 预算（配置统一）
    )
    if not isinstance(raw, dict):
        return VerifyResult(valid=False, confidence=0.0, issues=["校验器返回格式错误"])

    try:
        confidence = float(raw.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))
    valid = bool(raw.get("valid", False)) and confidence >= settings.RULE_EXTRACT_CONFIDENCE_THRESHOLD
    issues = raw.get("issues") or []
    if not isinstance(issues, list):
        issues = [str(issues)]
    issues = [str(x) for x in issues]

    # 程序级 Schema 校验叠加：不合法直接 INVALID
    schema_issues = validate_schema(rule)
    if schema_issues:
        issues = issues + [f"[schema] {x}" for x in schema_issues]
        valid = False
        confidence = min(confidence, 0.5)

    return VerifyResult(valid=valid, confidence=confidence, issues=issues)


def determine_status(verify: VerifyResult) -> str:
    """根据校验结果决定规则状态（§8.4 阈值，配置控制）."""
    if verify.valid and verify.confidence >= settings.RULE_EXTRACT_CONFIDENCE_THRESHOLD:
        return "ACTIVE"
    return "INVALID"
