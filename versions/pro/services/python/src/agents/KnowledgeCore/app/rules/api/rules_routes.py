"""Rules API routes."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.rules.schemas import (
    ExecuteRulesRequest,
    RuleBundleResponse,
    RuleExecutionResponse,
)
from app.rules.services.rule_service import RuleService

router = APIRouter(prefix="/rules", tags=["rules"])


@router.get("/predicates")
async def list_predicates():
    """列出可用谓词."""
    # Built-in predicates
    return {
        "predicates": [
            {
                "name": "always",
                "description": "总是返回 True",
                "params": {},
            },
            {
                "name": "never",
                "description": "总是返回 False",
                "params": {},
            },
            {
                "name": "high_risk_task",
                "description": "检查是否为高风险任务",
                "params": {},
            },
            {
                "name": "has_constraints",
                "description": "检查是否有运行约束",
                "params": {},
            },
            {
                "name": "query_contains",
                "description": "检查查询是否包含关键词",
                "params": {"keywords": "list[str]"},
            },
            {
                "name": "evidence_count_below",
                "description": "检查证据数量是否低于阈值",
                "params": {"threshold": "int"},
            },
            {
                "name": "similarity_below",
                "description": "检查平均相似度是否低于阈值",
                "params": {"threshold": "float"},
            },
        ]
    }


@router.post("/execute", response_model=RuleExecutionResponse)
async def execute_rules(
    request: ExecuteRulesRequest,
    db: AsyncSession = Depends(get_db),
):
    """执行规则."""
    service = RuleService(db)

    # Get rule bundle
    if request.rule_bundle_id:
        bundle = await service.get_bundle_by_id(request.rule_bundle_id)
    else:
        bundle = await service.get_active_bundle(request.domain_id)

    if not bundle:
        raise HTTPException(status_code=404, detail="No active rule bundle found")

    # Build fact snapshot (simplified)
    fact_snapshot = {
        "fact_id": request.fact_snapshot_id,
        "query": "",
        "task_type": "question",
    }

    # Execute rules
    result = await service.execute_rules(
        fact_snapshot=fact_snapshot,
        rules=bundle.rules_json,
        domain_id=request.domain_id,
    )

    return RuleExecutionResponse(
        execution_id=result["execution_id"],
        domain_id=result["domain_id"],
        bundle_id=bundle.bundle_id,
        fact_snapshot_id=result["fact_snapshot_id"],
        passed=result["passed"],
        hit_rules=result["hit_rules"],
        blocked_by=result["blocked_by"],
        restricted_by=result["restricted_by"],
        messages=result["messages"],
        created_at=result.get("created_at"),
    )


@router.get("/bundles/{domain_id}", response_model=list[RuleBundleResponse])
async def list_bundles(
    domain_id: str,
    db: AsyncSession = Depends(get_db),
):
    """列出规则包."""
    service = RuleService(db)
    return await service.list_bundles(domain_id)
