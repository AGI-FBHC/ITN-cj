from types import SimpleNamespace

from app.rule_engine.fact_extractor import enrich_explicit_rule_facts


def test_explicit_rule_enum_is_added_when_llm_omits_it():
    rules = [SimpleNamespace(conditions=[SimpleNamespace(
        field="paradigm", value=["Plan-and-Solve", "ReAct"]
    )])]

    result = enrich_explicit_rule_facts({}, "生成 ReAct 实操指南", rules)

    assert result["paradigm"] == "ReAct"


def test_existing_fact_wins_and_boolean_is_not_inferred():
    rules = [SimpleNamespace(conditions=[
        SimpleNamespace(field="paradigm", value="ReAct"),
        SimpleNamespace(field="use_reflection", value=True),
    ])]

    result = enrich_explicit_rule_facts(
        {"paradigm": "Reflection"}, "比较 ReAct 与 Reflection", rules
    )

    assert result == {"paradigm": "Reflection"}
