"""Question Reviewer Prompt（DESIGN v2 §14 / §26）.

Reviewer 只审不改：检查题目能否由证据支持、答案是否正确、是否无歧义、
难度是否匹配。返回结构化判定 + 问题列表。与 Answer Judge（判用户答得对不对）
完全独立。
"""
from __future__ import annotations

from questionbank.services.knowledge_core.schemas import KnowledgeContext

REVIEW_SYSTEM_PROMPT = """你是一名严谨的题目审核专家。你的任务是对一道题进行四项独立检查，
只输出结论，绝不修改原题。

四项检查：
1. grounded（证据支持）：题干与正确答案是否完全由给定 Evidence 支撑，不允许超出证据的内容
2. answer_correct（答案正确）：参考答案是否确实是唯一正确（或最佳）答案
3. unambiguous（无歧义）：题干表述是否清晰、选项是否互斥、不存在多个可成立答案；
   解析是否是一段完整可读的话（能独立读懂知识点与对错依据，不是模板化的「证据xx显示」堆砌，
   不因引用造成内容缺失）
4. difficulty_match（难度匹配）：按难度 rubric 判断题目难度是否与标注难度一致

难度 rubric：
1 —— 直接识别 / 定义 / 事实回忆，几乎不需要推理
2 —— 单知识点理解，简单判断
3 —— 单知识点应用，轻度场景推理
4 —— 多条件 / 多知识组合，较强分析
5 —— 复杂迁移，综合推理，深层分析

输出要求：只输出一个 JSON 对象，不要输出任何其他文字：
{
  "grounded": true,
  "answer_correct": true,
  "unambiguous": true,
  "difficulty_match": true,
  "confidence": 0.9,
  "issues": [],
  "suggested_difficulty": 3
}
- grounded / answer_correct / unambiguous / difficulty_match：布尔
- confidence：你对本次判定整体的置信度 0~1
- issues：问题列表（全部通过时为空数组；任一检查不通过时写清具体问题）
- suggested_difficulty：如难度不匹配，给出建议难度（匹配时与标注一致）
"""


def _question_block(question: dict) -> str:
    lines = [
        f"题型：{question.get('question_type')}",
        f"标注难度：{question.get('difficulty')}",
        f"认知层级：{question.get('cognitive_level')}",
        f"题干：{question.get('stem', '')}",
    ]
    options = question.get("options")
    if options:
        lines.append("选项：" + " | ".join(f"{o['key']}. {o['text']}" for o in options))
    lines.append(f"参考答案：{question.get('reference_answer')}")
    if question.get("explanation"):
        lines.append(f"解析：{question.get('explanation')}")
    return "\n".join(lines)


def build_review_prompt(question: dict, context: KnowledgeContext) -> str:
    """组装审题提示：题目 + 证据（目标知识点 + 前置）."""
    lines: list[str] = []
    lines.append("# 待审题目\n" + _question_block(question))
    lines.append(
        f"\n# 目标知识点\n{context.knowledge_point.name} (ID={context.knowledge_point.id})"
    )
    if context.prerequisites:
        prereq = "、".join(p.name for p in context.prerequisites[:8])
        lines.append(f"前置知识：{prereq}")
    lines.append("\n# Evidence（依据这些切片判断 grounded）")
    for idx, ev in enumerate(context.evidence[:8], start=1):
        ref = ev.chunk_id if ev.chunk_id > 0 else (ev.ragflow_chunk_id or "rag")
        content = ev.content.strip()[:700]
        lines.append(f"[{idx}] id={ref} (source={ev.source})\n{content}")
    lines.append("\n请输出 JSON 判定。")
    return "\n".join(lines)
