"""混合检索（MySQL 精确 → 父级上卷 → RAG 兜底）响应模型."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# ── 目录树 ──────────────────────────────────────────────────────────────────


class CategoryTreeNode(BaseModel):
    """目录树节点（嵌套 children）.

    id / parent_id 用字符串输出：knowledge_category.id 已超过 JS 安全整数，
    按数字下发会在前端被四舍五入成同一个值，导致章节节点互相覆盖。
    """

    model_config = ConfigDict(coerce_numbers_to_str=True)

    id: str
    parent_id: str | None = None
    node_code: str = ""
    name: str = ""
    description: str | None = None
    level: int = 0
    node_type: str = ""
    sort_order: int = 0
    chunk_count: int = 0
    threshold: int = 0
    gap: Literal["no_chunks", "below_threshold", "ok"] = "no_chunks"
    children: list[CategoryTreeNode] = Field(default_factory=list)


class CategoryTreeResponse(BaseModel):
    """GET /api/v1/knowledge/categories 响应（完整目录树）."""

    domain_code: str = ""
    domain_id: int | None = None
    total: int = 0
    tree: list[CategoryTreeNode] = Field(default_factory=list)


# ── 检索结果 ────────────────────────────────────────────────────────────────


class ChunkHit(BaseModel):
    """单条切片命中."""

    chunk_id: int = Field(..., description="knowledge_chunk.id（RAG 兜底为 0）")
    chunk_code: str = ""
    document_id: str | None = Field(None, description="来源文档 ID（MySQL 为 int，RAGFlow 为字符串）")
    title_path: str = ""
    section_title: str = ""
    content: str = Field(..., description="切片正文")
    summary: str | None = None
    source: Literal["mysql", "parent", "rag", "context"] = Field(..., description="命中来源")
    confidence: float | None = Field(None, description="分类置信度（mysql/parent）")
    relation_type: str | None = Field(None, description="分类关系（classified/related/manual）")
    similarity: float | None = Field(None, description="相似度（rag）")
    ragflow_chunk_id: str | None = None
    chunk_index: int | None = Field(
        None, description="T3.4/follow-up：块在文档内的序号（父子多粒度补邻用）"
    )
    rerank_score: float | None = Field(
        None, description="T3.3：重排层分数（未重排的结果没有该字段）"
    )


class ChunksResponse(BaseModel):
    """GET /api/v1/knowledge/chunks 响应."""

    knowledge_point: str = Field(..., description="查询的知识点名称")
    domain_code: str = Field(..., description="领域编码")
    category_id: int | None = None
    category_name: str | None = None
    category_level: int | None = None
    node_type: str | None = None
    decision: Literal["mysql", "parent", "rag", "empty"] = Field(
        ..., description="本次检索命中的层级：mysql=精确 / parent=父级上卷 / rag=RAG 兜底 / empty=无结果"
    )
    threshold: int = Field(..., description="实际使用的切片数量阈值")
    chunks: list[ChunkHit] = Field(default_factory=list)
    hit_chunks: list[ChunkHit] = Field(
        default_factory=list,
        description="T3.4：精确命中的切片（与 chunks 内容相同，为区分 context_chunks 而起的新名字）",
    )
    context_chunks: list[ChunkHit] = Field(
        default_factory=list,
        description="T3.4：命中块的同文档相邻块（短块自动补邻，或 expand_context=true 强制补邻）",
    )
    stats: dict[str, Any] = Field(default_factory=dict, description="各层命中计数，如 {exact: 3, parent: 0, rag: 2}")
    via_parent: bool = Field(False, description="是否含父级章节切片")
    warning: str | None = Field(None, description="降级/异常说明（如 RAGFlow 不可达）")
    prerequisites: dict | None = Field(
        None, description="include_prerequisites=true 时的先修链（dag-design.md G6 联动）"
    )
    contrasts: list[dict] | None = Field(
        None, description="T4.4：include_contrasts=true 时命中节点的易混淆知识点列表（active contrasts_with 边）"
    )


# ── 覆盖报告 ────────────────────────────────────────────────────────────────


class ChunksByIdsResponse(BaseModel):
    """GET /api/v1/knowledge/chunks/by-ids 响应（get_evidence 数据源）."""

    chunks: list[ChunkHit] = Field(default_factory=list, description="按请求顺序回取的切片（不存在的 ID 跳过）")


class CoverageItem(BaseModel):
    """单个知识节点覆盖情况."""

    category_id: int
    parent_id: int | None = None
    node_code: str = ""
    name: str = ""
    level: int
    node_type: str = ""
    chunk_count: int = 0
    threshold: int = 0
    gap: Literal["no_chunks", "below_threshold", "ok"] = Field(..., description="缺口类型")


class CoverageSummary(BaseModel):
    """覆盖汇总."""

    total_nodes: int = 0
    total_chunks: int = 0
    no_chunks: int = 0
    below_threshold: int = 0
    ok: int = 0


class CoverageResponse(BaseModel):
    """GET /api/v1/knowledge/coverage 响应."""

    domain_id: int | None = None
    domain_code: str = ""
    domain_name: str = ""
    summary: CoverageSummary = Field(default_factory=CoverageSummary)
    items: list[CoverageItem] = Field(default_factory=list)


# ── 分类审计与纠错 ─────────────────────────────────────────────────────────


class ClassificationAuditItem(BaseModel):
    """单条低置信度分类记录（抽查用）."""

    classification_id: int
    chunk_id: int | None = None
    category_id: int
    category_name: str = ""
    node_code: str = ""
    level: int = 0
    node_type: str = ""
    full_path: str = ""
    relation_type: str = ""
    confidence: float | None = None
    source: str = ""
    chunk_code: str = ""
    section_title: str = ""
    title_path: str = ""
    content_preview: str = ""


class ClassificationAuditResponse(BaseModel):
    """GET /api/v1/knowledge/classifications/audit 响应."""

    domain_code: str = ""
    domain_id: int | None = None
    total: int = 0
    limit: int = 0
    offset: int = 0
    items: list[ClassificationAuditItem] = Field(default_factory=list)


class ClassificationCorrectRequest(BaseModel):
    """人工纠错请求（错挂自愈/补归属）.

    定位分类记录：classification_id 优先；否则用 chunk_id + old_category_id。
    动作：
      - assign: 新增归属（chunk_id + new_category_id，先清旧分类保证单归属）
      - delete: 删除该分类记录
      - move: 改挂到 new_category_id（删旧写新，source='manual'）
      - set_confidence: 仅调整 confidence
    """

    action: Literal["assign", "delete", "move", "set_confidence"]
    classification_id: int | None = Field(None, description="分类记录 ID（优先）")
    chunk_id: int | None = Field(None, description="切片 ID（与 old_category_id 组合定位）")
    old_category_id: int | None = Field(None, description="当前知识点 ID")
    new_category_id: int | None = Field(None, description="move 目标知识点 ID")
    confidence: float | None = Field(None, ge=0.0, le=1.0, description="set_confidence 新值")


class ClassificationCorrectResponse(BaseModel):
    """POST /api/v1/knowledge/classifications/correct 响应."""

    ok: bool
    action: str = ""
    classification_id: int | None = None
    detail: str = ""
    error: str | None = None
