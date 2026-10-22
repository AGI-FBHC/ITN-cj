"""零写库验证：电气规则 + facts → evaluate → constraints（确定性链）."""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from app.rule_engine.engine import evaluate  # noqa: E402
from app.rule_engine.schemas import DomainRuleSchema  # noqa: E402

# 电气安全规程 6 条规则（来自 extractor_control.py 的抽取结果，手工固化）
RULES = [
    DomainRuleSchema.model_validate({
        "rule_code": "R-001", "name": "高处作业安全带",
        "conditions": [{"field": "height", "operator": "GTE", "value": 2, "unit": "米"}],
        "conclusions": [{"type": "SET", "field": "work_type", "value": "高处作业"},
                        {"type": "MUST", "content": "必须佩戴安全带，并设置防坠落装置"}],
        "source_text": "凡作业高度在 2 米及以上的高处作业，必须佩戴安全带。",
        "confidence": 0.95,
    }),
    DomainRuleSchema.model_validate({
        "rule_code": "R-002", "name": "电气检修断电",
        "conditions": [{"field": "task_type", "operator": "EQ", "value": "电气设备检修"}],
        "conclusions": [{"type": "MUST", "content": "必须切断相关电源，并悬挂'禁止合闸'警示牌"}],
        "source_text": "进行电气设备检修前，必须切断相关电源，并悬挂'禁止合闸'警示牌。",
        "confidence": 0.95,
    }),
    DomainRuleSchema.model_validate({
        "rule_code": "R-003", "name": "电气检修验电",
        "conditions": [{"field": "task_type", "operator": "EQ", "value": "电气设备检修"}],
        "conclusions": [{"type": "MUST", "content": "必须使用验电器验证设备确已无电后方可作业"}],
        "source_text": "检修电气设备前，必须使用验电器验证设备确已无电后方可作业。",
        "confidence": 0.95,
    }),
    DomainRuleSchema.model_validate({
        "rule_code": "R-004", "name": "禁止带电检修",
        "conditions": [{"field": "task_type", "operator": "EQ", "value": "电气设备带电检修"},
                        {"field": "power_cut", "operator": "EQ", "value": False}],
        "conclusions": [{"type": "MUST_NOT", "content": "禁止对电气设备进行带电检修作业"}],
        "source_text": "禁止在未切断电源的情况下对电气设备进行带电检修作业。",
        "confidence": 0.95,
    }),
    DomainRuleSchema.model_validate({
        "rule_code": "R-005", "name": "易燃易爆场所防爆",
        "conditions": [{"field": "scene", "operator": "EQ", "value": "易燃易爆场所"},
                        {"field": "task_type", "operator": "EQ", "value": "电气作业"}],
        "conclusions": [{"type": "MUST", "content": "必须使用防爆型工具和仪表"}],
        "source_text": "在易燃易爆场所进行电气作业，必须使用防爆型工具和仪表。",
        "confidence": 0.95,
    }),
]

FACTS = {"height": 3, "task_type": "电气设备检修"}  # 演示任务：高度3米的电气设备检修


def main() -> None:
    result = evaluate(FACTS, RULES)
    print("=" * 60)
    print(f"输入 facts: {FACTS}")
    print(f"规则数: {len(RULES)}")
    print("=" * 60)
    print("\n【推理链】")
    for s in result.reasoning_trace:
        print(f"  第{s.round}轮 [{s.rule}] 命中: {s.reason} → {s.result}")
    print(f"\n【派生事实】{result.derived_facts}")
    print(f"\n【命中规则】{result.matched_rules}")
    print(f"\n【生成约束（共 {len(result.constraints)} 条）】")
    for c in result.constraints:
        print(f"  [{c.rule_code}] {c.type}: {c.content}")
    print("\n" + "=" * 60)
    # 断言
    assert "work_type" in result.derived_facts, "应派生 work_type"
    assert result.derived_facts["work_type"] == "高处作业"
    codes = [c.rule_code for c in result.constraints]
    for expected in ("R-001", "R-002", "R-003"):
        assert expected in codes, f"应命中 {expected}"
    # R-004 (带电检修) 不应命中（task_type 是'电气设备检修'非'带电检修'）
    assert "R-004" not in codes, "R-004 不应命中（非带电检修）"
    print("✅ 断言通过：SET 派生 + 条件匹配 + 约束生成 均正确")


if __name__ == "__main__":
    main()
