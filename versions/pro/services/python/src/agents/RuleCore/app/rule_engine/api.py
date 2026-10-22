"""RuleCore API 路由（§17 + §24.5）.

注意：catch-all 的 GET /{rule_id} 必须放在所有单段具体路由之后，
否则会被优先匹配并因 int 转换失败返回 422。
"""
from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.rule_engine import comparison
from app.rule_engine.chunk_reader import get_document, iter_chunks, list_documents
from app.rule_engine.engine import evaluate
from app.rule_engine.fact_extractor import enrich_explicit_rule_facts, extract_facts
from app.rule_engine.lightweight_generation import retrieve_knowledge
from app.rule_engine.pipeline import extract_document_rules
from app.rule_engine.repositories import rule_repository as repo
from app.rule_engine.rule_verifier import validate_schema
from app.rule_engine.rule_checker import check_content
from app.rule_engine.schemas import ConstraintItem
from app.core.security import require_internal_request

logger = logging.getLogger("rulecore.api")
router = APIRouter(prefix="/api/rules", tags=["rules"])
internal_router = APIRouter(
    prefix="/internal/v1/rules", tags=["internal-rules"],
    dependencies=[Depends(require_internal_request)],
)


class RuntimeResolveRequest(BaseModel):
    task: str
    resource_type: str
    topic: str
    extra_context: str = ""


@internal_router.post("/resolve")
async def runtime_resolve(body: RuntimeResolveRequest) -> dict:
    rules = repo.get_active_rules()
    facts = await extract_facts(
        body.task,
        f"resource_type={body.resource_type}; topic={body.topic}; {body.extra_context}",
    )
    facts.setdefault("resource_type", body.resource_type)
    facts.setdefault("topic", body.topic)
    facts = enrich_explicit_rule_facts(
        facts, " ".join((body.task, body.topic, body.extra_context)), rules
    )
    result = evaluate(facts, rules)
    rules_by_code = {rule.rule_code: rule for rule in rules}
    constraints = []
    for item in result.constraints:
        rule = rules_by_code.get(item.rule_code)
        constraints.append({
            **item.model_dump(),
            "name": rule.name if rule else item.rule_code,
            "confidence": rule.confidence if rule else None,
            "sourceText": rule.source_text if rule else "",
            "sourceSection": rule.source_section if rule else item.source,
            "sourceDocumentId": rule.source_document_id if rule else None,
            "sourceChunkId": rule.source_chunk_id if rule else None,
        })
    return {
        "mode": "observe", "ruleCount": len(rules), "facts": result.input_facts,
        "derivedFacts": result.derived_facts, "matchedRules": result.matched_rules,
        "constraints": constraints,
        "reasoningTrace": [item.model_dump() for item in result.reasoning_trace],
    }


class RuntimeCheckRequest(BaseModel):
    content: dict | str
    constraints: list[dict]


@internal_router.post("/check")
async def runtime_check(body: RuntimeCheckRequest) -> dict:
    constraints = [ConstraintItem.model_validate(item) for item in body.constraints]
    content_text = body.content if isinstance(body.content, str) else json.dumps(body.content, ensure_ascii=False)
    result = await check_content(content_text, constraints)
    return {"passed": result.passed, "results": [item.model_dump() for item in result.results]}


# ── 文档 ────────────────────────────────────────────────────────────

@router.get("/documents")
async def documents() -> list[dict]:
    return list_documents()


@router.get("/documents/{document_id}/chunks")
async def document_chunks(document_id: int) -> dict:
    if not get_document(document_id):
        raise HTTPException(404, "文档不存在")
    chunks = iter_chunks(document_id, only_rule_candidates=True)
    return {
        "document_id": document_id,
        "chunks": chunks,
        "dedup": dict(getattr(iter_chunks, "stats", {})),
    }


# ── 规则抽取（§17.1）─────────────────────────────────────────────────

class ExtractRequest(BaseModel):
    max_chunks: int | None = Field(default=None, description="限制处理的切片数（调试用）")


@router.post("/extract/{document_id}")
async def extract(document_id: int, body: ExtractRequest | None = None):
    try:
        result = await extract_document_rules(
            document_id, max_chunks=body.max_chunks if body else None
        )
    except ValueError as e:
        raise HTTPException(404, str(e))
    return result


# ── 规则查询（§17.2）────────────────────────────────────────────────

@router.get("")
async def list_rules(
    document_id: int | None = None,
    status: str | None = None,
    rule_type: str | None = None,
    keyword: str | None = None,
    limit: int = Query(default=200, le=1000),
) -> list[dict]:
    rows = repo.get_rules(document_id=document_id, status=status, keyword=keyword, limit=limit)
    if rule_type:
        rows = [r for r in rows if r.get("rule_type") == rule_type]
    return rows


@router.get("/schema-check")
async def schema_check() -> dict:
    """对全部 ACTIVE 规则跑一遍程序级 Schema 校验（健康检查）."""
    rules = repo.get_active_rules()
    issues = []
    for r in rules:
        i = validate_schema(r)
        if i:
            issues.append({"rule_code": r.rule_code, "issues": i})
    return {"total": len(rules), "with_issues": len(issues), "issues": issues}


# ── 手动推理（§17.4）────────────────────────────────────────────────

class EvaluateRequest(BaseModel):
    facts: dict[str, Any]
    document_id: int | None = None


@router.post("/evaluate")
async def evaluate_rules(body: EvaluateRequest) -> dict:
    """手动测试推理（调试 + 比赛演示）. 确定性引擎，无 LLM."""
    rules = repo.get_active_rules(body.document_id)
    if not rules:
        raise HTTPException(404, "该文档暂无 ACTIVE 规则，请先执行 /extract")
    result = evaluate(body.facts, rules)
    return {
        "rule_count": len(rules),
        "input_facts": result.input_facts,
        "derived_facts": result.derived_facts,
        "matched_rules": result.matched_rules,
        "constraints": [c.model_dump() for c in result.constraints],
        "reasoning_trace": [t.model_dump() for t in result.reasoning_trace],
    }


# ── Fact 抽取（调试）────────────────────────────────────────────────

class FactsRequest(BaseModel):
    task: str
    extra_context: str = ""


@router.post("/facts")
async def extract_facts_api(body: FactsRequest) -> dict:
    facts = await extract_facts(body.task, body.extra_context)
    return {"task": body.task, "facts": facts}


# ── 知识检索（调试）──────────────────────────────────────────────────

class RetrieveRequest(BaseModel):
    task: str
    document_ids: list[int] | None = None
    top_k: int = 8


@router.post("/retrieve")
async def retrieve_api(body: RetrieveRequest) -> dict:
    return retrieve_knowledge(body.task, body.document_ids, top_k=body.top_k)


# ── A/B 对照（§24.5）────────────────────────────────────────────────

class CompareRequest(BaseModel):
    task: str = Field(..., description="演示任务描述")
    document_id: int | None = Field(default=None, description="限定规则/知识来源文档")
    document_ids: list[int] | None = Field(default=None, description="知识检索范围（可多文档）")


@router.post("/compare")
async def compare(body: CompareRequest) -> dict:
    if not body.task.strip():
        raise HTTPException(400, "task 不能为空")
    try:
        task_id = comparison.start_compare(
            body.task, document_ids=body.document_ids, document_id=body.document_id
        )
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    return {"task_id": task_id, "status": "PENDING"}


@router.get("/compare/{task_id}")
async def compare_status(task_id: str) -> dict:
    task = comparison.get_compare(task_id)
    if not task:
        raise HTTPException(404, "对照任务不存在")
    return task


@router.get("/compare")
async def compare_list(limit: int = Query(default=20, le=100)) -> list[dict]:
    return comparison.list_compares(limit=limit)


# ── rule_execution 溯源（§7.2 / §19）────────────────────────────────

@router.get("/executions/{request_id}")
async def executions(request_id: str) -> list[dict]:
    return repo.get_executions(request_id)


# ── 规则详情（§17.3）—— catch-all，必须放在最后 ───────────────────────

@router.get("/{rule_id}")
async def rule_detail(rule_id: int) -> dict:
    row = repo.get_rule(rule_id)
    if not row:
        raise HTTPException(404, "规则不存在")
    return row
