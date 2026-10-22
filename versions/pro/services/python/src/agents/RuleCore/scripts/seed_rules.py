"""种子规则入库：智能体领域设计规则（source_text 全部来自第四章原文）.

背景：库内 16 个文档均为 Datawhale《Hello Agents》技术教程（描述性教材），
Rule Extractor 对第四章抽 0 条是正确行为（对照实验已证明抽取器对规范性文本可正常抽取）。
为让 A/B 对照演示跑在"智能体领域"上，这里把书中真实存在的规范性语句
（ReAct 输出协议 / Plan-and-Solve 设计原则 / Reflection 终止条件）
按 §5 规则模型形式化为种子规则入库。rule_code 前缀 R38 = document_id 38。

演示任务（冻结用例）：
  生成一份智能体系统培训案例，采用 ReAct 范式并加入 Reflection 机制，
  讲解 Thought-Action-Observation 循环、如何确定最终答案、以及反思的终止条件。
预期命中：R38-001, R38-002 (paradigm=ReAct) + R38-004, R38-005 (use_reflection=true)
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from app.rule_engine.repositories import rule_repository as repo  # noqa: E402
from app.rule_engine.schemas import DomainRuleSchema  # noqa: E402

DOC_ID = 38

SEED_RULES: list[dict] = [
    {
        "rule_code": "R38-001",
        "name": "ReAct 步骤必须遵循 Thought-Action-Observation 协议",
        "conditions": [{"field": "paradigm", "operator": "EQ", "value": "ReAct"}],
        "conclusions": [{
            "type": "MUST",
            "content": "每个推理步骤必须遵循 Thought -> Action -> Observation 循环，并把新的观察结果追加到历史记录中，推理与行动交替进行",
        }],
        "source_text": "智能体将不断重复这个 Thought -> Action -> Observation 的循环，将新的观察结果追加到历史记录中，形成一个不断增长的上下文，直到它在Thought中认为已经找到了最终答案，然后输出结果。",
        "source_section": "4.2 ReAct",
        "confidence": 0.90,
    },
    {
        "rule_code": "R38-002",
        "name": "ReAct 最终答案必须用 Finish 输出",
        "conditions": [{"field": "paradigm", "operator": "EQ", "value": "ReAct"}],
        "conclusions": [{
            "type": "MUST",
            "content": "当收集到足够信息能够回答用户最终问题时，必须在 Action: 字段后使用 Finish[最终答案] 来输出最终答案，而不是直接给出答案",
        }],
        "source_text": "当你收集到足够的信息，能够回答用户的最终问题时，你必须在Action:字段后使用 Finish[最终答案] 来输出最终答案。",
        "source_section": "4.2.3 ReAct 提示词",
        "confidence": 0.92,
    },
    {
        "rule_code": "R38-003",
        "name": "Plan-and-Solve 必须先规划后执行且计划可解析",
        "conditions": [{
            "field": "paradigm", "operator": "IN",
            "value": ["Plan-and-Solve", "Plan-and-Execute"],
        }],
        "conclusions": [{
            "type": "MUST",
            "content": "必须先生成完整的行动计划（Plan）再严格按计划执行（Solve），且计划必须是结构化的，以便代码可以解析并逐一执行",
        }],
        "source_text": "这种范式将任务处理明确地分为两个阶段：先规划 (Plan)，后执行 (Solve)。……这个计划必须是结构化的，以便我们的代码可以轻松解析并逐一执行。",
        "source_section": "4.3 Plan-and-Solve",
        "confidence": 0.90,
    },
    {
        "rule_code": "R38-004",
        "name": "Reflection 必须有终止条件",
        "conditions": [{"field": "use_reflection", "operator": "EQ", "value": True}],
        "conclusions": [{
            "type": "MUST",
            "content": "反思循环必须设置终止条件：反馈中包含“无需改进”或达到最大迭代次数时终止，避免无限迭代",
        }],
        "source_text": "Reflection 机制的终止条件是“反馈中包含无需改进”或“达到最大迭代次数”。",
        "source_section": "4.4 习题（Reflection 机制）",
        "confidence": 0.88,
    },
    {
        "rule_code": "R38-005",
        "name": "Reflection 串行执行对延迟的影响",
        "conditions": [{"field": "use_reflection", "operator": "EQ", "value": True}],
        "conclusions": [{
            "type": "SHOULD",
            "content": "应说明每一轮反思需等待上一轮完成（串行过程），并提示其对任务延迟/总耗时的影响",
        }],
        "source_text": "Reflection 是一个串行过程，每一轮的优化都必须等待上一轮的反思完成。这使得任务的总耗时显著延长，不适合对实时性要求高的场景。",
        "source_section": "4.4 Reflection 的局限",
        "confidence": 0.85,
    },
]


def main() -> None:
    for spec in SEED_RULES:
        rule = DomainRuleSchema.model_validate({
            **spec,
            "source_document_id": DOC_ID,
            "source_chunk_id": None,
        })
        rule_id = repo.upsert_rule(rule, "ACTIVE", None)
        print(f"  入库 {spec['rule_code']} (id={rule_id}) {spec['name']}")
    active = repo.get_active_rules(DOC_ID)
    print(f"\n文档 {DOC_ID} 现有 ACTIVE 规则 {len(active)} 条:")
    for r in active:
        print(f"  [{r.rule_code}] {r.name}")


if __name__ == "__main__":
    main()
