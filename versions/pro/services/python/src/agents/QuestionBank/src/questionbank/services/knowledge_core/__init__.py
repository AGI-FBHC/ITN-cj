"""knowledge_core 服务包：Knowledge Core Contract（DESIGN v2 阶段 1）."""

from .core import KnowledgeCore, Purpose
from .retriever import KnowledgeCoreClient, KnowledgeCoreError
from .schemas import (
    ContrastInfo,
    CoverageInfo,
    EvidenceItem,
    KnowledgeContext,
    KnowledgePointInfo,
    PrerequisiteInfo,
    TraceInfo,
)

__all__ = [
    "KnowledgeCore",
    "KnowledgeCoreClient",
    "KnowledgeCoreError",
    "Purpose",
    "KnowledgeContext",
    "KnowledgePointInfo",
    "PrerequisiteInfo",
    "ContrastInfo",
    "EvidenceItem",
    "CoverageInfo",
    "TraceInfo",
]
