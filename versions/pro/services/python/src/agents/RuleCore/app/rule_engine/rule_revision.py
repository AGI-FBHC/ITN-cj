"""Revision Agent（§16，使用 LLM）.

FAIL 时触发，仅修正违反规则的内容。
MVP：MAX_REVISION_RETRY = 1，二次仍 FAIL 则带标记输出，不无限生成。
"""
from __future__ import annotations

from typing import Any

from app.core.config import settings
from app.rule_engine.llm import llm
from app.rule_engine.schemas import CheckItem, ConstraintItem

REVISION_SYSTEM = """你是一个内容修订专家。你的任务是：根据规则校验的失败结果，
对生成内容进行**最小化修正**。

你必须严格遵守：
1. **仅修正违反规则的内容**，补全缺失的 MUST 要求、移除 MUST_NOT 禁止的行为。
2. 尽量保持其他内容不变（不要重写整篇、不要改变结构与语气）。
3. **不得删除已经通过的规则内容**。
4. 修正后的内容必须仍然是一篇完整、连贯的文档。
5. 直接输出修正后的完整内容，不要输出解释、diff 或代码块标记。
"""


def _build_prompt(content: str, failed: list[CheckItem],
                  constraints: list[ConstraintItem]) -> str:
    c_by_code = {c.rule_code: c for c in constraints}
    lines = []
    for f in failed:
        c = c_by_code.get(f.rule_code)
        ctype = c.type if c else "MUST"
        ctext = c.content if c else ""
        lines.append(f"- [{f.rule_code}] {ctype}：{ctext}\n  失败原因：{f.reason}")
    return (
        "【当前内容】\n"
        f"\"\"\"\n{content}\n\"\"\"\n\n"
        "【未通过的规则（逐条修正）】\n"
        + "\n".join(lines)
        + "\n\n请输出修正后的完整内容。"
    )


async def revise(
    content: str,
    failed_items: list[CheckItem],
    constraints: list[ConstraintItem],
) -> str:
    """对 FAIL 内容做一次最小化修正；返回修正后文本（失败返回原文）."""
    hard_failed = [f for f in failed_items if f.status == "FAIL"]
    if not hard_failed or not content:
        return content
    raw = await llm.complete(
        system=REVISION_SYSTEM,
        prompt=_build_prompt(content, hard_failed, constraints),
        temperature=0.2,
        max_tokens=settings.GENERATE_MAX_TOKENS,
    )
    if not raw or not raw.strip():
        return content
    # 去掉可能的代码块包裹
    text = raw.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text or content
