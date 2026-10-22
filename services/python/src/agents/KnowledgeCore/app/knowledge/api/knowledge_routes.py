"""按知识点查切片：混合检索 / 覆盖报告 / 分类审计纠错 API.

对用户只需提供"知识点名称"，系统自动完成
MySQL 精确 → 父级上卷 → RAG 兜底 三级降级（solutions.md 第 4 节）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.knowledge.schemas import (
    CategoryTreeResponse,
    ChunksByIdsResponse,
    ChunksResponse,
    ClassificationAuditItem,
    ClassificationAuditResponse,
    ClassificationCorrectRequest,
    ClassificationCorrectResponse,
    CoverageItem,
    CoverageResponse,
    CoverageSummary,
)
from app.knowledge.services.classification_service import ClassificationService
from app.knowledge.services.retrieval_service import KnowledgeRetrievalService, compute_threshold

router = APIRouter(prefix="/knowledge", tags=["knowledge"])

COVERAGE_SQL = """
SELECT c.id AS category_id, c.parent_id, c.node_code, c.name, c.level, c.node_type,
       COUNT(CASE WHEN kc.id IS NOT NULL THEN kcc.chunk_id END) AS chunk_count
FROM knowledge_category c
LEFT JOIN knowledge_chunk_category kcc ON kcc.category_id = c.id
LEFT JOIN knowledge_chunk kc ON kc.id = kcc.chunk_id
WHERE c.domain_id = :did AND c.status = 1
GROUP BY c.id, c.parent_id, c.node_code, c.name, c.level, c.node_type, c.sort_order
ORDER BY c.level, c.sort_order, c.id
"""


@router.get(
    "/categories", response_model=CategoryTreeResponse,
    summary="完整目录树（嵌套 children，含切片数/缺口状态）",
)
async def get_category_tree(
    domain: str = Query("agent", description="领域编码"),
    threshold_mode: str = Query("fixed", pattern="^(fixed|auto)$", description="阈值模式"),
    db: AsyncSession = Depends(get_db),
):
    """返回领域完整目录树（level 1 → 2 → 3 嵌套），每个节点带切片数、阈值与缺口状态.

    用于前端目录树直观展示。
    """
    domain_row = (
        await db.execute(
            text("SELECT id, code, name FROM knowledge_domain WHERE code = :code OR name = :name LIMIT 1"),
            {"code": domain, "name": domain},
        )
    ).mappings().first()
    if not domain_row:
        raise HTTPException(status_code=404, detail=f"领域不存在: {domain}")

    service = KnowledgeRetrievalService(db)
    data = await service.category_tree(domain_row["id"], threshold_mode=threshold_mode)
    return CategoryTreeResponse(
        domain_code=domain_row["code"],
        domain_id=domain_row["id"],
        total=data["total"],
        tree=data["tree"],
    )


@router.get("/chunks", response_model=ChunksResponse, summary="按知识点名混合检索切片")
async def get_chunks(
    knowledge_point: str = Query(..., min_length=1, description="知识点名称（支持模糊匹配）"),
    domain: str = Query("agent", description="领域编码（knowledge_domain.code）"),
    threshold: int | None = Query(None, ge=1, description="切片数量阈值，缺省自动计算"),
    include_rag: bool = Query(True, description="精确/上卷不足时是否走 RAG 兜底"),
    threshold_mode: str = Query(
        "fixed", pattern="^(fixed|auto)$",
        description="阈值模式：fixed=固定 3 条；auto=按章节均值（封顶 8）",
    ),
    category_id: int | None = Query(None, ge=1, description="直接按知识点节点 ID 查（跳过名称匹配）"),
    min_confidence: float | None = Query(None, ge=0.0, le=1.0, description="精确层只返回分类置信度≥该值的切片"),
    include_prerequisites: bool = Query(False, description="响应附带命中节点的先修链（G6 联动）"),
    include_contrasts: bool = Query(
        False, description="响应附带命中节点的易混淆知识点列表（T4.4，active contrasts_with 边）"
    ),
    expand_context: bool = Query(
        False, description="T3.4：强制为命中块补充同文档相邻块（短块无需此参数也会自动补邻）"
    ),
    limit: int = Query(20, ge=1, le=50, description="返回切片数上限"),
    dataset_ids: list[str] | None = Query(None, description="指定 RAGFlow 数据集 ID"),
    db: AsyncSession = Depends(get_db),
):
    """混合检索：给知识点名称 → 返回对应切片.

    命中层级（decision）：
    - mysql  精确命中该知识点的分类切片（>= 阈值）
    - parent 该知识点切片不足，上卷到父章节切片（>= 阈值）
    - rag    仍不足，RAGFlow 相似度检索兜底（父级切片会一并返回）
    - empty  无任何结果

    知识点定位优先级：category_id 直查 > 名称精确全匹配 > 多词 AND > LIKE 模糊。
    """
    service = KnowledgeRetrievalService(db)
    result = await service.retrieve_chunks(
        knowledge_point=knowledge_point,
        domain=domain,
        threshold=threshold,
        threshold_mode=threshold_mode,
        include_rag=include_rag,
        limit=limit,
        dataset_ids=dataset_ids,
        category_id=category_id,
        min_confidence=min_confidence,
        expand_context=expand_context,
    )

    # G6 联动：命中节点附带先修链（学习路径推荐的地基）
    if include_prerequisites and result.get("category_id"):
        try:
            from app.graph.services.prerequisite_service import PrerequisiteService

            result["prerequisites"] = await PrerequisiteService(db).query_prerequisites(
                result["category_id"]
            )
        except Exception:  # noqa: BLE001 — 先修链为增值信息，失败不影响检索主链路
            result["prerequisites"] = {"error": "先修链查询失败（图数据未就绪）"}

    # T4.4：命中节点附带易混淆知识点列表（出题干扰项数据源）
    if include_contrasts and result.get("category_id"):
        try:
            from app.graph.services.prerequisite_service import PrerequisiteService

            result["contrasts"] = await PrerequisiteService(db).list_contrasts(
                result["category_id"]
            )
        except Exception:  # noqa: BLE001 — 易混淆列表为增值信息，失败不影响检索主链路
            result["contrasts"] = []

    return result


@router.get(
    "/chunks/by-ids", response_model=ChunksByIdsResponse,
    summary="按切片ID批量回取（题库 get_evidence / 审核 / 判题 / 溯源）",
)
async def get_chunks_by_ids(
    chunk_ids: list[int] = Query(..., min_length=1, max_length=50, description="knowledge_chunk.id 列表（多值参数）"),
    db: AsyncSession = Depends(get_db),
):
    """按切片 ID 批量回取正文.

    题库侧证据快照（evidence_refs）落库后，知识库内容仍可能变化，
    本接口用于按快照 ID 回取当时依据的切片内容（DESIGN v2 §28 get_evidence）。
    仅回取 MySQL 切片；RAG 兜底项（chunk_id=0）不在本接口范围。
    """
    service = KnowledgeRetrievalService(db)
    chunks = await service.chunks_by_ids(chunk_ids)
    return ChunksByIdsResponse(chunks=chunks)


@router.get("/coverage", response_model=CoverageResponse, summary="知识点覆盖度报告")
async def get_coverage(
    domain: str = Query("agent", description="领域编码"),
    threshold_mode: str = Query("fixed", pattern="^(fixed|auto)$", description="阈值模式"),
    db: AsyncSession = Depends(get_db),
):
    """覆盖矩阵：每个知识节点的切片数 / 阈值 / 缺口类型.

    gap 字段：no_chunks（0 切片）/ below_threshold（低于阈值）/ ok
    可直接驱动"该知识点要不要 RAG 兜底或补文档"。
    切片数只统计 JOIN knowledge_chunk 的有效切片（自动剔除失效引用）。
    """
    domain_row = (
        await db.execute(
            text("SELECT id, code, name FROM knowledge_domain WHERE code = :code OR name = :name LIMIT 1"),
            {"code": domain, "name": domain},
        )
    ).mappings().first()
    if not domain_row:
        raise HTTPException(status_code=404, detail=f"领域不存在: {domain}")

    rows = (await db.execute(text(COVERAGE_SQL), {"did": domain_row["id"]})).mappings().all()

    # 预取每个 level2 章节的切片统计（供 auto 阈值与子节点阈值使用）
    chapter_stats_map: dict[int, dict] = {}
    if threshold_mode == "auto":
        chapter_rows = (
            await db.execute(
                text(
                    "SELECT c.id AS anchor_id, "
                    "  COUNT(DISTINCT kcc.chunk_id) AS chapter_chunks, "
                    "  COUNT(DISTINCT CASE WHEN c2.level = 3 THEN kcc.chunk_id END) AS kp_chunks, "
                    "  COUNT(DISTINCT CASE WHEN c2.level = 3 AND kcc.chunk_id IS NOT NULL THEN c2.id END) "
                    "    AS kp_with_chunks "
                    "FROM knowledge_category c "
                    "LEFT JOIN knowledge_category c2 ON c2.parent_id = c.id "
                    "LEFT JOIN knowledge_chunk_category kcc ON kcc.category_id = c2.id "
                    "JOIN knowledge_chunk kc ON kc.id = kcc.chunk_id "
                    "WHERE c.domain_id = :did AND c.level = 2 "
                    "GROUP BY c.id"
                ),
                {"did": domain_row["id"]},
            )
        ).mappings().all()
        for r in chapter_rows:
            chapter_stats_map[int(r["anchor_id"])] = {
                "chapter_chunks": int(r["chapter_chunks"] or 0),
                "kp_chunks": int(r["kp_chunks"] or 0),
                "kp_with_chunks": int(r["kp_with_chunks"] or 0),
            }

    items: list[CoverageItem] = []
    for r in rows:
        is_chapter = r["node_type"] == "category"
        stats = None
        if not is_chapter:
            # level3 知识点的阈值基于其父章节统计
            stats = chapter_stats_map.get(r["parent_id"]) or {}
        thr = compute_threshold(stats if stats else None, mode=threshold_mode, is_chapter=is_chapter)
        if r["chunk_count"] == 0:
            gap = "no_chunks"
        elif r["chunk_count"] < thr:
            gap = "below_threshold"
        else:
            gap = "ok"
        items.append(
            CoverageItem(
                category_id=r["category_id"],
                parent_id=r["parent_id"],
                node_code=r["node_code"],
                name=r["name"],
                level=r["level"],
                node_type=r["node_type"],
                chunk_count=r["chunk_count"],
                threshold=thr,
                gap=gap,
            )
        )

    summary = CoverageSummary(
        total_nodes=len(items),
        total_chunks=sum(i.chunk_count for i in items),
        no_chunks=sum(1 for i in items if i.gap == "no_chunks"),
        below_threshold=sum(1 for i in items if i.gap == "below_threshold"),
        ok=sum(1 for i in items if i.gap == "ok"),
    )
    return CoverageResponse(
        domain_id=domain_row["id"],
        domain_code=domain_row["code"],
        domain_name=domain_row["name"],
        summary=summary,
        items=items,
    )


def _require_write() -> None:
    """写操作保护：未开启 KNOWLEDGE_ALLOW_WRITE 时拒绝（生产库只读优先）."""
    if not get_settings().KNOWLEDGE_ALLOW_WRITE:
        raise HTTPException(
            status_code=403,
            detail="写操作未开启（设置 KNOWLEDGE_ALLOW_WRITE=true 后重启服务）",
        )


# ── 分类审计与纠错（精确层错挂人工自愈入口） ────────────────────────────


@router.get(
    "/classifications/audit", response_model=ClassificationAuditResponse,
    summary="低置信度分类抽查（按置信度升序）",
)
async def audit_classifications(
    domain: str = Query("agent", description="领域编码"),
    max_confidence: float = Query(0.7, ge=0.0, le=1.0, description="只看置信度≤该值的分类"),
    source: str | None = Query(None, description="过滤分类来源（llm/manual/agent/rag_backfill）"),
    relation_type: str | None = Query(None, description="过滤关系类型（classified/related/manual）"),
    limit: int = Query(100, ge=1, le=500, description="每页条数"),
    offset: int = Query(0, ge=0, description="偏移量"),
    db: AsyncSession = Depends(get_db),
):
    """列出低置信度分类记录，供人工抽查 LLM 错挂。最可疑的排最前."""
    domain_row = (
        await db.execute(
            text("SELECT id, code, name FROM knowledge_domain WHERE code = :code OR name = :name LIMIT 1"),
            {"code": domain, "name": domain},
        )
    ).mappings().first()
    if not domain_row:
        raise HTTPException(status_code=404, detail=f"领域不存在: {domain}")

    svc = ClassificationService(db)
    data = await svc.list_audit(
        domain_id=domain_row["id"],
        max_confidence=max_confidence,
        source=source,
        relation_type=relation_type,
        limit=limit,
        offset=offset,
    )
    return ClassificationAuditResponse(
        domain_code=domain_row["code"],
        domain_id=domain_row["id"],
        total=data["total"],
        limit=limit,
        offset=offset,
        items=[ClassificationAuditItem(**i) for i in data["items"]],
    )


@router.post(
    "/classifications/correct", response_model=ClassificationCorrectResponse,
    summary="人工纠错分类（删除/改挂/调置信度）",
)
async def correct_classification(
    request: ClassificationCorrectRequest,
    db: AsyncSession = Depends(get_db),
):
    """对 LLM 错挂的分类记录执行人工纠错（写生产库，需 KNOWLEDGE_ALLOW_WRITE=true）."""
    _require_write()
    svc = ClassificationService(db)
    result = await svc.correct(
        action=request.action,
        classification_id=request.classification_id,
        chunk_id=request.chunk_id,
        old_category_id=request.old_category_id,
        new_category_id=request.new_category_id,
        confidence=request.confidence,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error", "纠错失败"))
    return ClassificationCorrectResponse(**result)


