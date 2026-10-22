"""先修图 API 路由（prefix=/knowledge/graph，dag-design.md §9）.

写操作（建边/审核/删除）受 KNOWLEDGE_ALLOW_WRITE 总开关保护（生产库只读优先）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.services.audit_service import AuditService
from app.core.config import get_settings
from app.core.database import get_db
from app.graph.schemas import (
    AddPrerequisiteResult,
    ConsistencyResponse,
    PrerequisiteAddRequest,
    PrerequisiteChainResponse,
    PrerequisiteEdgeResponse,
    ReviewRequest,
)
from app.graph.services.contrast_service import ContrastSyncReport, ContrastSyncService
from app.graph.services.graph_service import GraphService
from app.graph.services.graph_sync import GraphSyncService, SyncReport
from app.graph.services.prerequisite_service import (
    CycleDetectedError,
    DirectionViolationError,
    InvalidEdgeError,
    OutdegreeExceededError,
    PrerequisiteService,
    RedundantEdgeError,
)
from app.graph.services.review_pending_service import GraphReviewPendingService, GraphReviewReport

router = APIRouter(prefix="/knowledge/graph", tags=["knowledge-graph"])


def _require_write() -> None:
    """写操作保护：未开启 KNOWLEDGE_ALLOW_WRITE 时拒绝（生产库只读优先）."""
    if not get_settings().KNOWLEDGE_ALLOW_WRITE:
        raise HTTPException(
            status_code=403,
            detail="写操作未开启（设置 KNOWLEDGE_ALLOW_WRITE=true 后重启服务）",
        )


async def _write_audit(
    db: AsyncSession,
    domain_id: int | str,
    action: str,
    edge_id: int,
    audit_type: str,
    result_status: str,
    result_summary: str,
    details: dict,
) -> None:
    """审批操作审计（T4.8）：fire-and-forget，失败不影响主流程（参照 T2.3 miss 日志约定）.

    audit_records.audit_type 枚举固定为 decision/validation/activation/rollback
    （审计模块非本任务改动范围），三个审批动作按语义就近映射：
    approve→activation，reject→decision（result_status=blocked），reverse→rollback。
    """
    try:
        await AuditService(db).create_audit(
            domain_id=str(domain_id),
            audit_type=audit_type,
            details_json={"action": action, "edge_id": edge_id, **details},
            result_status=result_status,
            result_summary=result_summary,
        )
    except Exception:
        pass


@router.post("/prerequisites", response_model=AddPrerequisiteResult)
async def add_prerequisite(
    request: PrerequisiteAddRequest,
    db: AsyncSession = Depends(get_db),
):
    """新增先修边（四道防线：方向白名单 → 祖先检查 → 出度上限 → proposed 审核）."""
    _require_write()
    service = PrerequisiteService(db)
    try:
        edge, warnings = await service.add_prerequisite(
            category_id=request.category_id,
            prereq_category_id=request.prereq_category_id,
            domain_id=request.domain_id,
            edge_type=request.edge_type,
            source_domain_id=request.source_domain_id,
            confidence=request.confidence,
            rationale=request.rationale,
            source=request.source,
            created_by=request.created_by,
            direct_active=request.direct_active,
        )
    except (DirectionViolationError, CycleDetectedError, OutdegreeExceededError, InvalidEdgeError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    return AddPrerequisiteResult(edge=PrerequisiteEdgeResponse.model_validate(edge, from_attributes=True), warnings=warnings)


@router.get("/prerequisites", response_model=PrerequisiteChainResponse)
async def query_prerequisites(
    category_id: int = Query(..., description="知识点/章节 category_id"),
    db: AsyncSession = Depends(get_db),
):
    """查询先修链（BFS，含跨域边，节点带 domain 标注）."""
    service = PrerequisiteService(db)
    result = await service.query_prerequisites(category_id)
    return result


@router.get("/edges", response_model=list[PrerequisiteEdgeResponse])
async def list_edges(
    domain_id: int | None = Query(None, description="领域 id"),
    status: str | None = Query(None, description="proposed|active|rejected|deprecated|redundant|needs_review"),
    edge_type: str | None = Query(None, description="prerequisite|cross_domain_prerequisite|related|contrasts_with"),
    db: AsyncSession = Depends(get_db),
):
    """边列表（按领域/状态/类型过滤）."""
    service = PrerequisiteService(db)
    try:
        return await service.list_edges(domain_id, status, edge_type)
    except InvalidEdgeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/review-queue", response_model=list[PrerequisiteEdgeResponse])
async def review_queue(
    domain_id: int | None = Query(None, description="领域 id"),
    db: AsyncSession = Depends(get_db),
):
    """审核队列：proposed + needs_review 边（低置信度优先，T4.1-T4.3 交接遗留项 a）."""
    service = PrerequisiteService(db)
    return await service.review_queue(domain_id)


@router.post("/review", response_model=dict)
async def review(
    request: ReviewRequest,
    db: AsyncSession = Depends(get_db),
):
    """审核 proposed 边 → active/rejected（激活时全图 Kahn 防环，批量同批校验）."""
    _require_write()
    service = PrerequisiteService(db)
    try:
        if len(request.edge_ids) == 1:
            edge = await service.review_edge(request.edge_ids[0], request.approve)
            return {"edge_id": edge.id, "status": edge.status}
        return await service.review_batch(request.edge_ids, request.approve)
    except (CycleDetectedError, InvalidEdgeError) as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/validate", response_model=ConsistencyResponse)
async def validate_consistency(
    domain_id: int | None = Query(None, description="领域 id（缺省全领域）"),
    db: AsyncSession = Depends(get_db),
):
    """一致性校验：引用完整性 + Kahn 环检测（存量漂移兜底，可 cron 每日调用）."""
    service = PrerequisiteService(db)
    return await service.validate_consistency(domain_id)


@router.get("/path", response_model=dict)
async def plan_path(
    from_id: int = Query(..., description="起点（已掌握的知识点/章节 category_id）"),
    to_id: int = Query(..., description="目标知识点/章节 category_id"),
    db: AsyncSession = Depends(get_db),
):
    """学习路径规划：from 到 to 的拓扑序学习路径（含先修链）."""
    service = PrerequisiteService(db)
    return await service.plan_path(from_id, to_id)


@router.get("/{domain_id}/frontier", response_model=list[dict])
async def learning_frontier(
    domain_id: int,
    user_id: str = Query(..., description="用户标识（对应 QuestionBank user_knowledge_state.user_id）"),
    db: AsyncSession = Depends(get_db),
):
    """T4.2 学习前沿：先修全掌握（mastery>=0.7）而自身未掌握的节点列表.

    实际路径为 `/api/v1/knowledge/graph/{domain_id}/frontier`（沿用本文件既有
    `/knowledge/graph` 前缀，与手册草案里的 `/api/v1/graph/{domain_id}/frontier`
    路径写法有出入——为保持与本模块其余接口路由风格一致，未额外挂第二套前缀）。
    掌握度数据来自 QuestionBank 落库的 `user_knowledge_state`（同一 itn-platform
    库，本接口只读消费）；供 QuestionBank `question_selector.py` 的
    `frontier_first` 参数配合使用。
    """
    service = GraphService(db)
    return await service.learning_frontier(domain_id, user_id)


@router.post("/sync", response_model=SyncReport)
async def graph_sync(
    domain_id: int = Query(..., description="领域 id（LLM 批量建边，需 KNOWLEDGE_ALLOW_WRITE）"),
    db: AsyncSession = Depends(get_db),
):
    """diff 对账式增量建边：候选对 → LLM 判定（缓存命中零调用）→ proposed 审核队列.

    幂等可重跑：已存在边跳过、LLM 结果 content-hash 缓存、孤儿边自动 deprecated。
    """
    _require_write()
    service = GraphSyncService(db)
    return await service.run_sync(domain_id)


@router.delete("/edges/{edge_id}", response_model=PrerequisiteEdgeResponse)
async def delete_edge(
    edge_id: int,
    db: AsyncSession = Depends(get_db),
):
    """删除边（软删 → deprecated，可审计）."""
    _require_write()
    service = PrerequisiteService(db)
    try:
        return await service.delete_edge(edge_id)
    except InvalidEdgeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/edges/reduce-redundant", response_model=dict)
async def reduce_redundant_edges(
    domain_id: int | None = Query(None, description="领域 id（缺省对全部领域的 active 图统一归约）"),
    db: AsyncSession = Depends(get_db),
):
    """T4.7 管理接口：离线传递归约 —— 对存量 active 边跑一次归约，冗余边软删为 status='redundant'.

    建议定期任务调用（cron）；存量图若已存在环则拒绝并提示先修复（`validate` 接口可查环）。
    """
    _require_write()
    service = PrerequisiteService(db)
    try:
        return await service.reduce_redundant_edges(domain_id)
    except CycleDetectedError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/review-pending/process", response_model=GraphReviewReport)
async def process_review_pending(
    batch_size: int = Query(500, ge=1, le=5000, description="单次处理的 chunk 数上限"),
    db: AsyncSession = Depends(get_db),
):
    """T4.6 管理接口：消费 graph_review_pending（predeal 增量重审事件）.

    按 knowledge_chunk_category 反查待重审 chunk 归属的知识点，把这些知识点上
    source='llm' 生成的先修边置为 needs_review（供人工在 review-queue 中复核），
    处理完删除对应 pending 行。建议定期任务（cron）调用；也可在离线脚本中直接
    实例化 `GraphReviewPendingService(db).process_pending()` 而不经过 HTTP。
    """
    _require_write()
    service = GraphReviewPendingService(db)
    return await service.process_pending(batch_size=batch_size)


@router.post("/contrast-sync/run", response_model=ContrastSyncReport)
async def run_contrast_sync(
    domain_id: int = Query(..., description="领域 id"),
    dry_run: bool = Query(
        False, description="仅出候选与 LLM 判定结果，不写库（不受 KNOWLEDGE_ALLOW_WRITE 限制）"
    ),
    db: AsyncSession = Depends(get_db),
):
    """817 待办清单第 7 项：contrasts_with 易混淆边同步的管理触发入口（T4.4 遗留项）.

    编排：`knowledge_chunk_enrichment` 的 defines/uses 概念共现 → 候选生成 →
    LLM 把关（`ContrastJudge`）→ 判定为"是"的对写为 proposed 边（`contrasts_with`，
    需人工经 `POST /edges/{id}/approve` 转正）。装配方式与 `graph_sync` 消费
    enrichment 的做法一致（复用 `enrichment_loader.load_concept_rows`）；
    enrichment 表不存在/该领域暂无 enrichment 数据 → 优雅返回空报告，不 500。

    `dry_run=true` 时只预览候选数/LLM 判定结果，不写库、也不受
    `KNOWLEDGE_ALLOW_WRITE` 限制（跑候选生成 + LLM 调用，但跳过 add_prerequisite）。
    本接口未接入任何自动定期任务，建议随 predeal 入库脚本低频跑（见交接文档）。
    """
    if not dry_run:
        _require_write()
    service = ContrastSyncService(db)
    report = await service.sync_from_domain(domain_id, dry_run=dry_run)
    try:
        await AuditService(db).create_audit(
            domain_id=str(domain_id),
            audit_type="activation",
            details_json={
                "action": "contrast_sync_run",
                "dry_run": dry_run,
                "candidates": report.candidates,
                "judged_yes": report.judged_yes,
                "added": report.added,
                "skipped": report.skipped,
            },
            result_status="success",
            result_summary=(
                f"contrast-sync{'(dry_run)' if dry_run else ''}: "
                f"candidates={report.candidates} judged_yes={report.judged_yes} added={report.added}"
            ),
        )
    except Exception:  # noqa: BLE001 — 审计失败不影响主流程（参照本文件其余审计调用约定）
        pass
    return report


# ── T4.8：审批接口（approve/reject/reverse，经 activate_edges 闸门 + 审计） ──────


@router.post("/edges/{edge_id}/approve", response_model=dict)
async def approve_edge(
    edge_id: int,
    db: AsyncSession = Depends(get_db),
):
    """审批通过：proposed → active，经 activate_edges 闸门（Kahn 环检测 + T4.7 传递归约）."""
    _require_write()
    service = PrerequisiteService(db)
    existing = await service.get_edge(edge_id)
    domain_id: int | str = existing.domain_id if existing is not None else "unknown"
    try:
        edge = await service.review_edge(edge_id, approve=True)
    except (CycleDetectedError, RedundantEdgeError, InvalidEdgeError) as e:
        await _write_audit(
            db, domain_id, "approve", edge_id, "activation", "failed", str(e), {"error": str(e)}
        )
        raise HTTPException(status_code=400, detail=str(e))
    await _write_audit(
        db,
        edge.domain_id,
        "approve",
        edge.id,
        "activation",
        "success",
        f"边 {edge.id} 审批通过并激活",
        {"category_id": edge.category_id, "prereq_category_id": edge.prereq_category_id},
    )
    return {"edge_id": edge.id, "status": edge.status}


@router.post("/edges/{edge_id}/reject", response_model=dict)
async def reject_edge(
    edge_id: int,
    db: AsyncSession = Depends(get_db),
):
    """审批拒绝：proposed → rejected."""
    _require_write()
    service = PrerequisiteService(db)
    existing = await service.get_edge(edge_id)
    domain_id: int | str = existing.domain_id if existing is not None else "unknown"
    try:
        edge = await service.review_edge(edge_id, approve=False)
    except InvalidEdgeError as e:
        await _write_audit(
            db, domain_id, "reject", edge_id, "decision", "failed", str(e), {"error": str(e)}
        )
        raise HTTPException(status_code=400, detail=str(e))
    await _write_audit(
        db,
        edge.domain_id,
        "reject",
        edge.id,
        "decision",
        "blocked",
        f"边 {edge.id} 审批拒绝",
        {"category_id": edge.category_id, "prereq_category_id": edge.prereq_category_id},
    )
    return {"edge_id": edge.id, "status": edge.status}


@router.post("/edges/{edge_id}/reverse", response_model=dict)
async def reverse_edge(
    edge_id: int,
    db: AsyncSession = Depends(get_db),
):
    """反转方向：原边 rejected，按反方向重新过方向白名单/祖先检查生成新 proposed 边.

    反转本身不自动激活——新边仍需再调用 approve 才会过 activate_edges 闸门。
    """
    _require_write()
    service = PrerequisiteService(db)
    existing = await service.get_edge(edge_id)
    domain_id: int | str = existing.domain_id if existing is not None else "unknown"
    try:
        result = await service.reverse_edge(edge_id)
    except (DirectionViolationError, CycleDetectedError, OutdegreeExceededError, InvalidEdgeError) as e:
        await _write_audit(
            db, domain_id, "reverse", edge_id, "rollback", "failed", str(e), {"error": str(e)}
        )
        raise HTTPException(status_code=400, detail=str(e))
    old_edge, new_edge = result["old_edge"], result["new_edge"]
    await _write_audit(
        db,
        old_edge.domain_id,
        "reverse",
        old_edge.id,
        "rollback",
        "success",
        f"边 {old_edge.id} 反转为新边 {new_edge.id}",
        {
            "old_edge_id": old_edge.id,
            "new_edge_id": new_edge.id,
            "new_category_id": new_edge.category_id,
            "new_prereq_category_id": new_edge.prereq_category_id,
        },
    )
    return {
        "old_edge_id": old_edge.id,
        "old_status": old_edge.status,
        "new_edge_id": new_edge.id,
        "new_status": new_edge.status,
    }
