"""KnowledgeContext 契约 —— 题库与 Knowledge Core 之间唯一的数据结构.

对应方案 DESIGN v2 §3。任何消费方（Question Generator / Reviewer / Answer Judge /
Content Generator / Teaching Agent）一律通过 KnowledgeCoreClient.get_context()
获取，禁止自行拼装知识。
"""
from typing import Literal

from pydantic import BaseModel, Field


class KnowledgePointInfo(BaseModel):
    """目标知识点."""

    id: int = Field(..., description="knowledge_category.id")
    name: str = Field(..., description="知识点名称")
    description: str | None = None


class PrerequisiteInfo(BaseModel):
    """前置知识点（DAG 先修链）."""

    id: int = Field(..., description="knowledge_category.id")
    name: str = Field(..., description="知识点名称")
    relation_type: str = Field(default="prerequisite")


class ContrastInfo(BaseModel):
    """易混淆知识点（T4.4：KC 的 contrasts_with 边，active 状态才会出现）."""

    id: int = Field(..., description="knowledge_category.id")
    name: str = Field(..., description="知识点名称")


class EvidenceItem(BaseModel):
    """单条证据切片."""

    chunk_id: int = Field(..., description="knowledge_chunk.id（RAG 兜底项为 0）")
    ragflow_chunk_id: str | None = Field(
        default=None, description="RAG 层切片的 RAGFlow chunk id（溯源键，chunk_id=0 时使用）"
    )
    document_id: int | str | None = Field(
        default=None, description="来源文档 id（MySQL 层为 int；RAG 层为 RAGFlow 文档 id 字符串）"
    )
    content: str = Field(..., description="切片正文")
    score: float | None = Field(default=None, description="confidence（mysql 层）或 similarity（rag 层）")
    source: Literal["mysql", "parent", "rag"] = Field(..., description="证据来源层级")
    category_id: int | None = Field(default=None, description="命中的知识点节点")


class CoverageInfo(BaseModel):
    """覆盖度评估（Question Bank 不关心 KC 内部算法，只消费分级结果）."""

    direct_chunk_count: int = Field(0, description="目标知识点直接绑定的切片数")
    rag_supplement_count: int = Field(0, description="RAG 补充切片数")
    coverage_level: Literal["empty", "weak", "sufficient"] = Field("empty")


class TraceInfo(BaseModel):
    """调用溯源."""

    strategy: str = Field(..., description="检索策略：mysql / mysql_parent / mysql_plus_rag / rag / empty")
    request_id: str = Field(..., description="本次 get_context 请求 ID")


class KnowledgeContext(BaseModel):
    """统一知识上下文契约（DESIGN v2 §3）."""

    knowledge_point: KnowledgePointInfo
    prerequisites: list[PrerequisiteInfo] = Field(default_factory=list)
    contrasts: list[ContrastInfo] = Field(
        default_factory=list, description="T4.4：易混淆知识点（出题干扰项优先改编来源）"
    )
    evidence: list[EvidenceItem] = Field(default_factory=list)
    coverage: CoverageInfo = Field(default_factory=CoverageInfo)
    trace: TraceInfo

    def is_usable(self) -> bool:
        """出题前置判断：evidence 为空即不可用（DESIGN v2 §9 失败策略）."""
        return len(self.evidence) > 0
