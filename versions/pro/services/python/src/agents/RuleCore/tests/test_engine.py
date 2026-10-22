"""Rule Engine 单元测试（确定性逻辑，无需 LLM / DB）."""
from __future__ import annotations

import pytest

from app.rule_engine.engine import evaluate
from app.rule_engine.field_registry import field_registry
from app.rule_engine.schemas import (
    DomainRuleSchema,
    RuleCondition,
    RuleConclusion,
)


def rule(code, name, conditions, conclusions, section="§4.2"):
    return DomainRuleSchema(
        rule_code=code,
        name=name,
        conditions=[RuleCondition(**c) for c in conditions],
        conclusions=[RuleConclusion(**c) for c in conclusions],
        source_text=f"测试原文 {code}",
        source_section=section,
        confidence=0.95,
    )


R001 = rule(
    "R-001", "高处作业判定",
    [{"field": "height", "operator": "GTE", "value": 2, "unit": "m"}],
    [{"type": "SET", "field": "work_type", "value": "高处作业"}],
)
R002 = rule(
    "R-002", "高处作业安全带要求",
    [{"field": "work_type", "operator": "EQ", "value": "高处作业"}],
    [{"type": "MUST", "content": "作业人员正确佩戴安全带"}],
)
R003 = rule(
    "R-003", "高处作业防坠落要求",
    [{"field": "work_type", "operator": "EQ", "value": "高处作业"}],
    [{"type": "MUST", "content": "设置可靠防坠落措施"}],
)
R004 = rule(
    "R-004", "电气检修断电",
    [{"field": "task_type", "operator": "EQ", "value": "电气设备检修"}],
    [{"type": "MUST", "content": "检修前切断电源"}],
)


class TestBasicMatching:
    def test_gte_chain_two_rounds(self):
        """§4 示例：height=3 → R-001 SET → R-002/R-003 MUST."""
        result = evaluate({"height": 3}, [R001, R002, R003])
        assert "R-001" in result.matched_rules
        assert "R-002" in result.matched_rules
        assert "R-003" in result.matched_rules
        assert result.derived_facts == {"work_type": "高处作业"}
        contents = {c.rule_code: c.content for c in result.constraints}
        assert contents["R-002"] == "作业人员正确佩戴安全带"
        assert contents["R-003"] == "设置可靠防坠落措施"
        # trace 两轮：第1轮 R-001，第2轮 R-002/R-003
        rounds = {t.round for t in result.reasoning_trace}
        assert rounds == {1, 2}

    def test_below_threshold_no_match(self):
        result = evaluate({"height": 1}, [R001, R002])
        assert result.matched_rules == []
        assert result.constraints == []
        assert result.derived_facts == {}

    def test_eq_mismatch(self):
        result = evaluate({"work_type": "地面作业"}, [R002])
        assert result.matched_rules == []

    def test_and_requires_all(self):
        """§11.1：AND 语义，缺一个条件即不命中."""
        r = rule(
            "R-AND", "双条件",
            [
                {"field": "task_type", "operator": "EQ", "value": "检修"},
                {"field": "equipment_type", "operator": "EQ", "value": "电气设备"},
            ],
            [{"type": "MUST", "content": "双人作业"}],
        )
        assert evaluate({"task_type": "检修"}, [r]).matched_rules == []
        hit = evaluate({"task_type": "检修", "equipment_type": "电气设备"}, [r])
        assert hit.matched_rules == ["R-AND"]

    def test_in_operator(self):
        r = rule(
            "R-IN", "设备类型",
            [{"field": "equipment_type", "operator": "IN", "value": ["电气设备", "起重设备"]}],
            [{"type": "SHOULD", "content": "配备专职监护人"}],
        )
        hit = evaluate({"equipment_type": "起重设备"}, [r])
        assert hit.matched_rules == ["R-IN"]
        assert hit.constraints[0].type == "SHOULD"
        miss = evaluate({"equipment_type": "管道"}, [r])
        assert miss.matched_rules == []

    def test_not_in_operator(self):
        r = rule(
            "R-NIN", "排除",
            [{"field": "equipment_type", "operator": "NOT_IN", "value": ["低压设备"]}],
            [{"type": "MUST", "content": "执行高压作业程序"}],
        )
        assert evaluate({"equipment_type": "高压设备"}, [r]).matched_rules == ["R-NIN"]
        assert evaluate({"equipment_type": "低压设备"}, [r]).matched_rules == []

    def test_exists_operator(self):
        r = rule(
            "R-EX", "有高度事实",
            [{"field": "height", "operator": "EXISTS"}],
            [{"type": "SHOULD", "content": "评估坠落风险"}],
        )
        assert evaluate({"height": 0.5}, [r]).matched_rules == ["R-EX"]
        assert evaluate({}, [r]).matched_rules == []

    def test_ne_operator(self):
        r = rule(
            "R-NE", "非地面",
            [{"field": "work_type", "operator": "NE", "value": "地面作业"}],
            [{"type": "SHOULD", "content": "评估防护"}],
        )
        assert evaluate({"work_type": "高处作业"}, [r]).matched_rules == ["R-NE"]
        assert evaluate({"work_type": "地面作业"}, [r]).matched_rules == []


class TestNumericAndUnits:
    def test_numeric_string_with_unit(self):
        """'3m' 与 2 比较应按数值（§8.3 数值单位保持原文，但引擎比较需归一）."""
        assert evaluate({"height": "3m"}, [R001, R002]).matched_rules == ["R-001", "R-002"]

    def test_chinese_unit(self):
        assert evaluate({"height": "3米"}, [R001]).matched_rules == ["R-001"]

    def test_non_numeric_gt_no_crash(self):
        """非数值比较不得崩溃，返回不命中."""
        r = rule(
            "R-BAD", "坏数值",
            [{"field": "height", "operator": "GT", "value": 2}],
            [{"type": "MUST", "content": "x"}],
        )
        result = evaluate({"height": "未知"}, [r])
        assert result.matched_rules == []

    def test_boundary_equal(self):
        """GTE 边界：height=2 应命中."""
        assert evaluate({"height": 2}, [R001]).matched_rules == ["R-001"]


class TestFieldAlignment:
    def test_alias_normalization(self):
        """§10：规则用 作业高度，事实给 height，应命中."""
        r = rule(
            "R-ALIAS", "别名",
            [{"field": "作业高度", "operator": "GTE", "value": 2}],
            [{"type": "SET", "field": "作业类型", "value": "高处作业"}],
        )
        result = evaluate({"height": 3}, [r])
        assert result.matched_rules == ["R-ALIAS"]
        assert result.derived_facts == {"work_type": "高处作业"}

    def test_reverse_alias(self):
        """规则用 height，事实给 作业高度."""
        assert evaluate({"作业高度": 3}, [R001, R002]).matched_rules == ["R-001", "R-002"]

    def test_registry_reverse_lookup(self):
        assert field_registry.normalize("作业高度") == "height"
        assert field_registry.normalize("work_type") == "work_type"
        assert field_registry.normalize("unregistered_field") == "unregistered_field"


class TestInferenceSafety:
    def test_no_infinite_loop_on_cycle(self):
        """环形规则：A→B→A 不得死循环."""
        ra = rule(
            "R-A", "环A",
            [{"field": "x", "operator": "EXISTS"}],
            [{"type": "SET", "field": "y", "value": 1}],
        )
        rb = rule(
            "R-B", "环B",
            [{"field": "y", "operator": "EXISTS"}],
            [{"type": "SET", "field": "x", "value": 1}],
        )
        result = evaluate({"x": 1}, [ra, rb], max_rounds=2)
        # 每条规则只 fire 一次
        assert result.matched_rules.count("R-A") == 1
        assert result.matched_rules.count("R-B") == 1

    def test_rule_fires_once(self):
        """同一规则在单轮内不得重复 fire."""
        result = evaluate({"height": 3}, [R001, R001], max_rounds=2)
        assert result.matched_rules.count("R-001") == 1

    def test_rounds_bounded(self):
        """长链超过 max_rounds 时只跑有限轮."""
        r1 = rule("C-1", "链1", [{"field": "a", "operator": "EXISTS"}],
                  [{"type": "SET", "field": "b", "value": 1}])
        r2 = rule("C-2", "链2", [{"field": "b", "operator": "EXISTS"}],
                  [{"type": "SET", "field": "c", "value": 1}])
        r3 = rule("C-3", "链3", [{"field": "c", "operator": "EXISTS"}],
                  [{"type": "MUST", "content": "第三层"}])
        r4 = rule("C-4", "链4", [{"field": "d", "operator": "EXISTS"}],
                  [{"type": "SET", "field": "d2", "value": 1}])
        # 3 跳链在 2 轮内最多到第 2 跳
        result = evaluate({"a": 1}, [r1, r2, r3, r4], max_rounds=2)
        assert "C-1" in result.matched_rules
        assert "C-2" in result.matched_rules
        assert "C-3" not in result.matched_rules
        # 3 轮可以走完
        result3 = evaluate({"a": 1}, [r1, r2, r3, r4], max_rounds=3)
        assert "C-3" in result3.matched_rules

    def test_trace_records_reason(self):
        result = evaluate({"height": 3}, [R001, R002])
        t1 = result.reasoning_trace[0]
        assert t1.round == 1
        assert t1.rule == "R-001"
        assert "height" in t1.reason
        assert t1.result.startswith("SET work_type")


class TestConstraintCollection:
    def test_must_not_collected(self):
        r = rule(
            "R-MN", "禁止",
            [{"field": "equipment_status", "operator": "EQ", "value": "带电"}],
            [{"type": "MUST_NOT", "content": "直接检修"}],
        )
        result = evaluate({"equipment_status": "带电"}, [r])
        assert result.constraints[0].type == "MUST_NOT"
        assert result.constraints[0].content == "直接检修"

    def test_source_section_carried(self):
        result = evaluate({"height": 3}, [R001, R002])
        must = [c for c in result.constraints if c.type == "MUST"][0]
        assert must.source == "§4.2"

    def test_input_facts_not_mutated(self):
        facts = {"height": 3}
        evaluate(facts, [R001, R002])
        assert facts == {"height": 3}
