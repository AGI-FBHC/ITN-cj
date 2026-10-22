"""T4.4：出题 Prompt 注入易混淆知识点（干扰项数据源）测试."""
from __future__ import annotations

from questionbank.services.knowledge_core import (
    ContrastInfo,
    CoverageInfo,
    EvidenceItem,
    KnowledgeContext,
    KnowledgePointInfo,
    PrerequisiteInfo,
    TraceInfo,
)
from questionbank.services.question.generator.prompts import build_user_prompt


def _context(contrasts: list[ContrastInfo] | None = None) -> KnowledgeContext:
    return KnowledgeContext(
        knowledge_point=KnowledgePointInfo(id=72, name="MCP传输方式"),
        prerequisites=[PrerequisiteInfo(id=71, name="MCP协议")],
        contrasts=contrasts or [],
        evidence=[
            EvidenceItem(chunk_id=1024, content="MCP 传输层支持 stdio 与 SSE…", score=0.9, source="mysql"),
        ],
        coverage=CoverageInfo(direct_chunk_count=1, rag_supplement_count=0, coverage_level="sufficient"),
        trace=TraceInfo(strategy="mysql", request_id="test-1"),
    )


def test_prompt_injects_contrast_hint_when_present():
    ctx = _context(
        contrasts=[
            ContrastInfo(id=130, name="SSE长连接"),
            ContrastInfo(id=131, name="WebSocket传输"),
        ]
    )
    prompt = build_user_prompt(
        ctx, question_type=None, difficulty=3, cognitive_level=None, count=3
    )
    assert "干扰项优先改编自以下易混概念" in prompt
    assert "SSE长连接" in prompt
    assert "WebSocket传输" in prompt


def test_prompt_omits_contrast_section_when_empty():
    ctx = _context(contrasts=[])
    prompt = build_user_prompt(
        ctx, question_type=None, difficulty=3, cognitive_level=None, count=3
    )
    assert "干扰项优先改编自以下易混概念" not in prompt
    assert "易混淆知识点" not in prompt
