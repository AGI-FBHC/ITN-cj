"""Rule Extractor（§8.3，使用 LLM）.

从文档切片中抽取"条件—结论/约束"规则。
铁律（§8.3 要求）：
1. 只抽取原文明确支持的规则
2. 不允许自行补充领域常识
3. 一条规则只表达一个主要约束
4. OR 条件拆成多条规则
5. 数值、单位必须保持原文
6. 原文不能形式化时允许不抽
7. 必须返回对应 source_text
8. MUST / MUST_NOT / SHOULD 必须区分
9. SET 只用于能够由条件明确推导出的事实
"""
from __future__ import annotations

import json
from typing import Any

from app.core.config import settings
from app.rule_engine.field_registry import field_registry
from app.rule_engine.llm import llm
from app.rule_engine.schemas import DomainRuleSchema

EXTRACTOR_SYSTEM = """你是一个严谨的领域规则抽取器。你的唯一任务是：从给定的领域规范原文中，
抽取"条件—结论/约束"形式的结构化规则。

你必须严格遵守以下纪律：
1. 只抽取原文**明确支持**的规则；原文没有说的，一律不抽。
2. **禁止**自行补充任何领域常识或行业惯例。
3. 一条规则只表达一个主要约束（一个 THEN）。
4. 若原文出现"A OR B → C"，拆成两条规则（A→C 和 B→C），不要使用 OR 运算符。
5. 数值和单位必须**保持原文**（如 2m、3米 原样保留）。
6. 如果原文无法形式化为条件—结论，允许不抽（返回空数组）。
7. 每条规则必须带上对应的 source_text（原文原句）。
8. 结论强度必须区分：
   - MUST：强制性要求（"必须""应""须""不得...否则"等强约束）
   - MUST_NOT：明确禁止（"禁止""严禁""不得"）
   - SHOULD：推荐性（"宜""建议""应当...时"等较软的建议）
   - SET：由条件可以明确推导出的事实/分类（用于继续推理），例如"height>=2m → 属于高处作业"
9. 字段名优先从【字段注册表】中选择；注册表没有的才新建字段。
10. 运算符只能用：EQ, NE, GT, GTE, LT, LTE, IN, NOT_IN, EXISTS。
    条件之间一律 AND（用多个 condition 表示），不要用 OR。

只输出 JSON 数组，不要输出任何解释、markdown 代码块标记或多余文字。
每个元素格式：
{
  "name": "规则简短名称",
  "conditions": [
    {"field": "字段名", "operator": "EQ", "value": "值", "unit": "单位(可空)"}
  ],
  "conclusions": [
    {"type": "MUST", "content": "约束描述"}
  ]
}
"""


def _build_prompt(text: str, document_context: dict) -> str:
    registry_desc = field_registry.describe()
    doc_title = document_context.get("title", "")
    doc_source = document_context.get("source_name", "")
    return (
        f"【字段注册表（字段名优先从这里选）】\n{registry_desc}\n\n"
        f"【文档】{doc_title}（来源：{doc_source}）\n\n"
        f"【待抽取原文片段】\n\"\"\"\n{text}\n\"\"\"\n\n"
        "请从以上原文中抽取结构化规则，只输出 JSON 数组。"
    )


def _coerce_rules(raw: Any, document_context: dict) -> list[DomainRuleSchema]:
    """把 LLM 输出的原始 dict 列表规整为 DomainRuleSchema 列表（尽力容错）."""
    if not isinstance(raw, list):
        return []
    rules: list[DomainRuleSchema] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        try:
            conditions = []
            for c in item.get("conditions", []) or []:
                if not isinstance(c, dict) or not c.get("field"):
                    continue
                conditions.append({
                    "field": str(c["field"]).strip(),
                    "operator": str(c.get("operator", "EQ")).strip().upper(),
                    "value": c.get("value"),
                    "unit": c.get("unit") or None,
                })
            if not conditions:
                continue

            conclusions = []
            for cl in item.get("conclusions", []) or []:
                if not isinstance(cl, dict):
                    continue
                ctype = str(cl.get("type", "")).strip().upper()
                if ctype not in ("SET", "MUST", "MUST_NOT", "SHOULD"):
                    continue
                conclusions.append({
                    "type": ctype,
                    "field": cl.get("field"),
                    "value": cl.get("value"),
                    "content": cl.get("content"),
                })
            if not conclusions:
                continue

            source_text = (item.get("source_text") or "").strip()
            if not source_text:
                # 纪律 7：必须有 source_text，缺失则回退为整段原文
                source_text = document_context.get("raw_text", "")[:500]

            rules.append(DomainRuleSchema.model_validate({
                "rule_code": item.get("rule_code") or f"CAND-{i + 1:03d}",
                "name": (item.get("name") or f"规则{i + 1}").strip(),
                "conditions": [
                    {"field": c["field"], "operator": c["operator"],
                     "value": c["value"], "unit": c.get("unit")}
                    for c in conditions
                ],
                "conclusions": conclusions,
                "source_text": source_text,
                "source_section": item.get("source_section")
                or document_context.get("section_title")
                or None,
                "source_document_id": document_context.get("document_id"),
                "source_chunk_id": document_context.get("chunk_id"),
                "confidence": float(item.get("confidence", 0.0) or 0.0),
            }))
        except Exception:  # noqa: BLE001 — 单条坏规则不影响其他
            continue
    return rules


async def extract_rules(text: str, document_context: dict) -> list[DomainRuleSchema]:
    """主接口（§8.3）.

    document_context 建议包含：title, source_name, section_title,
    document_id, chunk_id, raw_text
    """
    if not (text or "").strip():
        return []
    prompt = _build_prompt(text, document_context)
    raw = await llm.complete_json(
        system=EXTRACTOR_SYSTEM,
        prompt=prompt,
        fallback=None,
        temperature=0.0,
        max_tokens=settings.LLM_MAX_TOKENS,
    )
    rules = _coerce_rules(raw, document_context)
    # 截断过长原文，避免入库超限（保留完整句）
    for r in rules:
        if len(r.source_text) > 1000:
            r.source_text = r.source_text[:1000] + "…"
    return rules


def extract_rules_sync(text: str, document_context: dict) -> list[DomainRuleSchema]:
    """同步包装（测试/脚本用）."""
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            raise RuntimeError("loop running")
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(extract_rules(text, document_context))
