"""覆盖度评估（DESIGN v2 §3 / §9）.

Question Bank 不关心 KC 内部阈值算法，只对 KnowledgeContext 的 evidence
做二次分级，供出题流水线决定是否拒绝生成：

- empty     无任何证据 → 拒绝生成
- weak      仅有 RAG/父级上卷证据，或直接证据不足 → 拒绝生成（不放松约束）
- sufficient 目标知识点直接绑定切片 ≥ threshold → 允许生成
"""
from __future__ import annotations

from .schemas import CoverageInfo, EvidenceItem


def evaluate_coverage(
    evidence: list[EvidenceItem],
    threshold: int = 2,
) -> CoverageInfo:
    """对证据列表做覆盖度分级.

    threshold：目标知识点直接绑定切片（source=mysql）的最低数量。
    默认 2 条；生成侧可传 3 提高底线（与 KC 的 auto 阈值语义一致，不冲突）。
    """
    direct = [e for e in evidence if e.source == "mysql"]
    rag = [e for e in evidence if e.source != "mysql"]

    if not evidence:
        level = "empty"
    elif len(direct) >= max(1, threshold):
        level = "sufficient"
    else:
        level = "weak"

    return CoverageInfo(
        direct_chunk_count=len(direct),
        rag_supplement_count=len(rag),
        coverage_level=level,
    )


def strategy_label(decision: str) -> str:
    """KC decision（mysql/parent/rag/empty）→ TraceInfo.strategy."""
    return {
        "mysql": "mysql",
        "parent": "mysql_parent",
        "rag": "mysql_plus_rag",
        "empty": "empty",
    }.get(decision, decision or "unknown")
