"""Rule Checker（§15，使用 LLM 语义判断）.

只检查 MUST / MUST_NOT（SHOULD 可检查但不导致 FAIL）。
硬性纪律（§15）：
- 逐条规则检查
- 禁止整体给一个"基本合规"
- 必须返回 rule_code
- 必须引用生成文本证据
- 没有明确证据时不能 PASS
"""
from __future__ import annotations

import json
from typing import Any

from app.core.config import settings
from app.rule_engine.constants import HARD_CHECK_TYPES, SOFT_CHECK_TYPES
from app.rule_engine.llm import llm
from app.rule_engine.schemas import CheckItem, CheckResult, ConstraintItem

CHECKER_SYSTEM = """你是一个严格的规则一致性审核员。给你一段生成内容和一组领域规则约束，
你的任务是**逐条**判断生成内容是否满足每条约束。

你必须严格遵守：
1. 逐条规则检查，每条单独给出 PASS / FAIL / SKIPPED。
2. **禁止**给出"基本合规""整体没问题"这类笼统结论——每条必须独立判断。
3. 每条结果必须带 rule_code。
4. 判定 PASS 时，**必须**从生成内容中引用一段原文作为 evidence（原句，不得改写）。
5. 判定 FAIL 时，必须给出 reason（生成内容缺失或违反了什么）。
6. **没有明确证据时不能 PASS**——找不到对应内容一律 FAIL。
7. MUST 约束：生成内容必须明确体现该要求（动作/步骤/规定），才算 PASS。
8. MUST_NOT 约束：生成内容中**不得出现**被禁止的行为；若出现则 FAIL，
   若明确避免或未涉及则 PASS（evidence 说明如何避免或为何不涉及）。
9. SHOULD 约束：同样逐条检查，但由调用方决定是否计入失败。

输出 JSON 对象（不要代码块、不要解释）：
{
  "results": [
    {"rule_code": "R-xxx", "status": "PASS", "evidence": "生成内容中的原文引用"},
    {"rule_code": "R-yyy", "status": "FAIL", "evidence": null, "reason": "缺失了什么"}
  ]
}
"""


def _build_prompt(content: str, constraints: list[ConstraintItem]) -> str:
    lines = []
    for c in constraints:
        lines.append(f"- [{c.rule_code}] {c.type}：{c.content}")
    return (
        "【生成内容】\n"
        f"\"\"\"\n{content}\n\"\"\"\n\n"
        "【规则约束（逐条检查）】\n"
        + "\n".join(lines)
        + "\n\n请逐条判断，只输出 JSON 对象。"
    )


def _coerce_result(raw: Any, constraints: list[ConstraintItem]) -> list[CheckItem]:
    """把 LLM 输出规整为 CheckItem 列表；缺失的约束补 SKIPPED."""
    by_code: dict[str, CheckItem] = {}
    if isinstance(raw, dict):
        for item in raw.get("results", []) or []:
            if not isinstance(item, dict):
                continue
            code = str(item.get("rule_code", "")).strip()
            if not code:
                continue
            status = str(item.get("status", "")).strip().upper()
            if status not in ("PASS", "FAIL", "SKIPPED"):
                status = "FAIL"
            by_code[code] = CheckItem(
                rule_code=code,
                status=status,
                evidence=item.get("evidence"),
                reason=item.get("reason"),
            )
    # 补齐 LLM 漏判的约束（没判 = 没证据 = FAIL，不得默认 PASS）
    for c in constraints:
        if c.rule_code not in by_code:
            by_code[c.rule_code] = CheckItem(
                rule_code=c.rule_code,
                status="FAIL",
                reason="校验器未对该规则给出判定（视为无证据）",
            )
    # 按约束顺序输出
    ordered = []
    for c in constraints:
        item = by_code.get(c.rule_code)
        if item:
            ordered.append(item)
    return ordered


def _decide_passed(items: list[CheckItem], constraints: list[ConstraintItem]) -> bool:
    """整体判定：只有 HARD（MUST/MUST_NOT）的 FAIL 才导致整体 FAIL（§15）."""
    hard_types = {c.rule_code: c.type for c in constraints}
    for item in items:
        ctype = hard_types.get(item.rule_code, "")
        if item.status == "FAIL" and ctype in HARD_CHECK_TYPES:
            return False
    return True


async def check_content(content: str, constraints: list[ConstraintItem]) -> CheckResult:
    """主接口：逐条校验生成内容."""
    if not content or not content.strip():
        items = [
            CheckItem(rule_code=c.rule_code, status="FAIL",
                      reason="生成内容为空")
            for c in constraints
        ]
        return CheckResult(passed=False, results=items)
    if not constraints:
        return CheckResult(passed=True, results=[])

    raw = await llm.complete_json(
        system=CHECKER_SYSTEM,
        prompt=_build_prompt(content, constraints),
        fallback=None,
        temperature=0.0,
        max_tokens=settings.LLM_MAX_TOKENS,  # 推理模型需预留 reasoning token 预算（配置统一）
    )
    items = _coerce_result(raw, constraints)
    passed = _decide_passed(items, constraints)
    return CheckResult(passed=passed, results=items)
