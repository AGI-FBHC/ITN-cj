"""Decision API routes."""
from __future__ import annotations
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.decision.schemas import (
    DecisionDetailResponse,
    ReplayRequest,
    ResolveRequest,
    ResolveResponse,
)
from app.decision.services.decision_service import DecisionService

router = APIRouter(prefix="/knowledge", tags=["decision"])


@router.post("/resolve", response_model=ResolveResponse)
async def resolve_knowledge(
    request: ResolveRequest,
    db: AsyncSession = Depends(get_db),
):
    """完整双轨推断."""
    service = DecisionService(db)
    try:
        result = await service.resolve(
            domain_id=request.domain_id,
            query=request.query,
            task_type=request.task_type,
            user_context=request.user_context,
            constraints=request.constraints,
            top_k=request.top_k,
            similarity_threshold=request.similarity_threshold,
            dataset_ids=request.dataset_ids,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Decision resolution failed: {str(e)}")


@router.post("/decision/replay", response_model=ResolveResponse)
async def replay_decision(
    request: ReplayRequest,
    db: AsyncSession = Depends(get_db),
):
    """以指定运行快照回放历史决策."""
    service = DecisionService(db)
    try:
        result = await service.replay_decision(
            domain_runtime_snapshot_id=request.domain_runtime_snapshot_id,
            query=request.query,
            task_type=request.task_type,
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/decision/{contract_id}", response_model=DecisionDetailResponse)
async def get_decision(
    contract_id: str,
    db: AsyncSession = Depends(get_db),
):
    """查询决策详情."""
    service = DecisionService(db)
    decision = await service.get_decision(contract_id)
    if not decision:
        raise HTTPException(status_code=404, detail=f"Decision '{contract_id}' not found")
    return decision


@router.get("/decisions", response_model=list[DecisionDetailResponse])
async def list_decisions(
    domain_id: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
):
    """列出决策记录."""
    service = DecisionService(db)
    return await service.list_decisions(
        domain_id=domain_id,
        limit=limit,
        offset=offset,
    )
