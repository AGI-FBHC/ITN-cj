"""Fact Extractor（§9，使用 LLM）.

把生成任务转成结构化事实。
要求（§9）：
- 不能推测用户没有提供的信息
- 没有明确值则不要填
- 单位标准化
- 字段名尽量复用已有规则字段（Field Registry）
"""
from __future__ import annotations

from typing import Any, Sequence

from app.core.config import settings
from app.rule_engine.field_registry import field_registry
from app.rule_engine.llm import llm

FACT_EXTRACTOR_SYSTEM = """你是一个任务事实抽取器。你的唯一任务是：从用户的生成任务描述中，
抽取**明确给出**的结构化事实（facts），用于领域规则匹配。

你必须严格遵守：
1. **只能抽取用户明确提供的信息**；用户没说的，一律不填。
2. 没有明确值则不要填该字段（宁可少填，不可推测）。
3. 数值字段尽量输出纯数字（把单位放到对应 _unit 字段，如 height=3, height_unit="m"）。
4. 字段名优先从【字段注册表】中选择；注册表没有的才新建字段。
5. 不要输出解释，只输出 JSON 对象 {"facts": {...}}。

【字段注册表】
{registry}
"""


def build_prompt(task: str, extra_context: str = "") -> str:
    ctx = f"\n【补充上下文】\n{extra_context}" if extra_context else ""
    return (
        f"【用户生成任务】\n{task}\n{ctx}\n\n"
        "请抽取结构化事实，只输出 JSON 对象 {\"facts\": {...}}。"
    )


async def extract_facts(task: str, extra_context: str = "") -> dict[str, Any]:
    """主接口：返回结构化事实 dict（字段已归一化）."""
    if not (task or "").strip():
        return {}
    system = FACT_EXTRACTOR_SYSTEM.replace("{registry}", field_registry.describe())
    raw = await llm.complete_json(
        system=system,
        prompt=build_prompt(task, extra_context),
        fallback=None,
        temperature=0.0,
        max_tokens=settings.LLM_MAX_TOKENS,  # 推理模型需预留 reasoning token 预算（配置统一）
    )
    facts: dict[str, Any] = {}
    if isinstance(raw, dict):
        inner = raw.get("facts", raw)
        if isinstance(inner, dict):
            facts = inner
    elif isinstance(raw, list):
        # 容错：模型直接返回 [{field,value}] 列表
        for item in raw:
            if isinstance(item, dict) and item.get("field"):
                facts[str(item["field"])] = item.get("value")

    # 字段归一化（§10）
    normalized: dict[str, Any] = {}
    for k, v in facts.items():
        if v is None or v == "":
            continue
        canon = field_registry.normalize(str(k))
        # _unit 后缀跟随主字段 canonical
        if canon.endswith("_unit") or str(k).endswith("_unit"):
            base = field_registry.normalize(str(k)[: -5])
            normalized[f"{base}_unit"] = v
        else:
            normalized[canon] = v
    return normalized


def enrich_explicit_rule_facts(
    facts: dict[str, Any], source_text: str, rules: Sequence[Any]
) -> dict[str, Any]:
    """用任务中明确出现的规则枚举值补齐事实，不做语义猜测。

    LLM 偶尔会漏掉诸如 ``ReAct`` 这类已明示的范式名。这里仅在规则条件值是
    字符串（或字符串枚举）且原文包含完整值时补齐字段；布尔值、数值和未明示
    信息一律不推断。
    """
    enriched = dict(facts or {})
    haystack = (source_text or "").casefold()
    if not haystack:
        return enriched
    for rule in rules:
        for condition in getattr(rule, "conditions", ()):
            field = field_registry.normalize(condition.field)
            if field in enriched:
                continue
            candidates = condition.value if isinstance(condition.value, (list, tuple)) else [condition.value]
            for candidate in candidates:
                if not isinstance(candidate, str) or not candidate.strip():
                    continue
                if candidate.strip().casefold() in haystack:
                    enriched[field] = candidate
                    break
    return enriched
