"""离线可测逻辑的单元测试（无需 LLM / DB）:
- Schema Validator（§8.5）
- Rule Checker 结果规整与整体判定（§15）
- 轻量检索切词
- Fact 归一化
"""
from __future__ import annotations

import pytest

from app.rule_engine.lightweight_generation import _tokens
from app.rule_engine.rule_checker import _coerce_result, _decide_passed
from app.rule_engine.rule_verifier import validate_schema
from app.rule_engine.schemas import (
    CheckItem,
    ConstraintItem,
    DomainRuleSchema,
    RuleCondition,
    RuleConclusion,
)


def mk_rule(**kw) -> DomainRuleSchema:
    base = {
        "rule_code": "R-001",
        "name": "测试规则",
        "conditions": [
            {"field": "height", "operator": "GTE", "value": 2, "unit": "m"}
        ],
        "conclusions": [
            {"type": "MUST", "content": "佩戴安全带"}
        ],
        "source_text": "凡2m及以上高处作业应佩戴安全带。",
        "confidence": 0.9,
    }
    base.update(kw)
    return DomainRuleSchema.model_validate(base)


class TestSchemaValidator:
    def test_valid_rule(self):
        assert validate_schema(mk_rule()) == []

    def test_bad_operator(self):
        r = mk_rule(
            conditions=[{"field": "h", "operator": "REGEX", "value": "x"}]
        )
        issues = validate_schema(r)
        assert any("operator 非法" in i for i in issues)

    def test_gt_without_value(self):
        r = mk_rule(conditions=[{"field": "h", "operator": "GT"}])
        issues = validate_schema(r)
        assert any("缺少数值" in i for i in issues)

    def test_exists_with_value(self):
        r = mk_rule(conditions=[{"field": "h", "operator": "EXISTS", "value": 1}])
        assert any("EXISTS 不应有 value" in i for i in validate_schema(r))

    def test_set_requires_field_value(self):
        r = mk_rule(
            conclusions=[{"type": "SET", "field": "work_type"}]
        )
        assert any("SET 缺少 field/value" in i for i in validate_schema(r))

    def test_must_requires_content(self):
        r = mk_rule(conclusions=[{"type": "MUST"}])
        assert any("缺少 content" in i for i in validate_schema(r))

    def test_missing_source_text(self):
        r = mk_rule(source_text="")
        assert any("source_text" in i for i in validate_schema(r))

    def test_bad_confidence_rejected_at_construction(self):
        """confidence 有 ge/le 约束，构造期即拒绝（无需到 validate_schema）."""
        with pytest.raises(Exception):
            mk_rule(confidence=1.5)

    def test_empty_conditions(self):
        r = mk_rule(conditions=[])
        assert any("conditions" in i for i in validate_schema(r))

    def test_invalid_conclusion_type_rejected_at_construction(self):
        """type 是 Literal[SET,MUST,MUST_NOT,SHOULD]，非法值构造期即拒绝."""
        with pytest.raises(Exception):
            mk_rule(conclusions=[{"type": "MAYBE", "content": "x"}])


class TestCheckerCoerce:
    CONSTS = [
        ConstraintItem(rule_code="R-002", type="MUST", content="佩戴安全带"),
        ConstraintItem(rule_code="R-003", type="MUST_NOT", content="带电作业"),
    ]

    def test_coerce_full(self):
        raw = {"results": [
            {"rule_code": "R-002", "status": "PASS", "evidence": "作业前系好安全带"},
            {"rule_code": "R-003", "status": "PASS", "evidence": "全程断电操作"},
        ]}
        items = _coerce_result(raw, self.CONSTS)
        assert {i.rule_code: i.status for i in items} == {"R-002": "PASS", "R-003": "PASS"}
        assert items[0].evidence == "作业前系好安全带"

    def test_missing_constraint_defaults_fail(self):
        """LLM 漏判的约束 = 无证据 = FAIL（不得默认 PASS，§15）."""
        raw = {"results": [
            {"rule_code": "R-002", "status": "PASS", "evidence": "x"},
        ]}
        items = _coerce_result(raw, self.CONSTS)
        r003 = [i for i in items if i.rule_code == "R-003"][0]
        assert r003.status == "FAIL"
        assert r003.reason

    def test_invalid_status_becomes_fail(self):
        raw = {"results": [
            {"rule_code": "R-002", "status": "BASICALLY OK"},
        ]}
        items = _coerce_result(raw, self.CONSTS)
        assert [i for i in items if i.rule_code == "R-002"][0].status == "FAIL"

    def test_none_raw_all_fail(self):
        items = _coerce_result(None, self.CONSTS)
        assert all(i.status == "FAIL" for i in items)

    def test_decide_passed_must_fail(self):
        items = [CheckItem(rule_code="R-002", status="FAIL")]
        assert _decide_passed(items, self.CONSTS) is False

    def test_should_fail_does_not_fail_overall(self):
        """SHOULD 失败不导致整体 FAIL（§15）."""
        consts = [ConstraintItem(rule_code="R-010", type="SHOULD", content="x")]
        items = [CheckItem(rule_code="R-010", status="FAIL")]
        assert _decide_passed(items, consts) is True

    def test_must_not_fail_fails_overall(self):
        items = [CheckItem(rule_code="R-003", status="FAIL")]
        assert _decide_passed(items, self.CONSTS) is False


class TestTokenizer:
    def test_english(self):
        toks = _tokens("ReAct agent loop")
        assert "react" in toks and "agent" in toks

    def test_chinese_bigram(self):
        toks = _tokens("智能体调试")
        assert "智能" in toks and "能体" in toks and "调试" in toks

    def test_stopwords_filtered(self):
        assert "的" not in _tokens("调试的技巧")
        assert "我们" not in _tokens("我们应该")

    def test_mixed(self):
        toks = _tokens("ReAct 智能体 调试技巧")
        assert "react" in toks
        assert "调试" in toks


class TestFactNormalization:
    def test_normalize(self):
        from app.rule_engine.field_registry import field_registry
        assert field_registry.normalize("作业高度") == "height"
        assert field_registry.normalize("WORK_HEIGHT") == "height"
        assert field_registry.normalize("new_field") == "new_field"

    def test_aliases_of(self):
        from app.rule_engine.field_registry import field_registry
        aliases = field_registry.aliases_of("height")
        assert "height" in aliases
        assert "作业高度" in aliases
