"""Question Reviewer 单元测试（mock LLM）."""
import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from questionbank.llm import LLMClient
from questionbank.services.knowledge_core import (
    CoverageInfo,
    EvidenceItem,
    KnowledgeContext,
    KnowledgePointInfo,
    PrerequisiteInfo,
    TraceInfo,
)
from questionbank.services.question.reviewer import QuestionReviewer

SETTINGS = SimpleNamespace(
    llm_provider="openai-compatible",
    llm_model="mimo-v2.6-pro",
    llm_api_url="http://llm.test/v1/chat/completions",
    llm_api_key="x",
    llm_timeout_seconds=10,
    llm_max_tokens=4096,
)


def make_context() -> KnowledgeContext:
    return KnowledgeContext(
        knowledge_point=KnowledgePointInfo(id=72, name="MCP传输方式"),
        prerequisites=[PrerequisiteInfo(id=71, name="MCP协议")],
        evidence=[
            EvidenceItem(chunk_id=1024, document_id=18, content="MCP 支持 stdio 与 SSE 两种传输。", score=0.9, source="mysql"),
            EvidenceItem(chunk_id=1025, document_id=18, content="stdio 适合本地进程间通信。", score=0.85, source="mysql"),
        ],
        coverage=CoverageInfo(direct_chunk_count=2, coverage_level="sufficient"),
        trace=TraceInfo(strategy="mysql", request_id="r1"),
    )


def make_question(**overrides) -> dict:
    q = {
        "id": 1001,
        "question_type": "single_choice",
        "difficulty": 3,
        "cognitive_level": "understand",
        "stem": "MCP 支持哪两种基础传输方式？",
        "options": [{"key": "A", "text": "stdio 与 SSE"}, {"key": "B", "text": "HTTP 与 WebSocket"}],
        "reference_answer": "A",
        "explanation": "MCP 规范定义 stdio 与 SSE。",
    }
    q.update(overrides)
    return q


def reviewer_returning(payload: dict) -> QuestionReviewer:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}]})

    return QuestionReviewer(LLMClient(SETTINGS, transport=httpx.MockTransport(handler)))


async def run(coro):
    return await coro


def test_review_passed():
    r = reviewer_returning(
        {
            "grounded": True, "answer_correct": True, "unambiguous": True,
            "difficulty_match": True, "confidence": 0.95, "issues": [],
            "suggested_difficulty": 3,
        }
    )
    verdict = asyncio.run(r.review(make_question(), make_context()))
    assert verdict.passed
    assert verdict.confidence == 0.95
    assert verdict.issues == []


def test_review_rejected_with_issues():
    r = reviewer_returning(
        {
            "grounded": True, "answer_correct": False, "unambiguous": True,
            "difficulty_match": False, "confidence": 0.7,
            "issues": ["参考答案与证据不符", "实际难度应为 2"],
            "suggested_difficulty": 2,
        }
    )
    verdict = asyncio.run(r.review(make_question(), make_context()))
    assert not verdict.passed
    assert len(verdict.issues) == 2
    assert verdict.suggested_difficulty == 2
    assert "答案不正确" in verdict.summary()
    assert "难度不匹配" in verdict.summary()


def test_review_llm_failure_conservative_reject():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    r = QuestionReviewer(LLMClient(SETTINGS, transport=httpx.MockTransport(handler)))
    verdict = asyncio.run(r.review(make_question(), make_context()))
    assert not verdict.passed
    assert verdict.confidence == 0.0
    assert "审题调用失败" in verdict.issues[0]


def test_review_structural_failure_conservative_reject():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "not json"}}]})

    r = QuestionReviewer(LLMClient(SETTINGS, transport=httpx.MockTransport(handler)))
    verdict = asyncio.run(r.review(make_question(), make_context()))
    assert not verdict.passed
    assert "审题调用失败" in verdict.issues[0]


def test_review_out_of_range_confidence_conservative_reject():
    """LLM 输出越界 confidence（>1.0）→ 模型校验失败 → 保守拒绝（可信度存疑）."""
    r = reviewer_returning(
        {
            "grounded": True, "answer_correct": True, "unambiguous": True,
            "difficulty_match": True, "confidence": 1.5, "issues": [],
        }
    )
    verdict = asyncio.run(r.review(make_question(), make_context()))
    assert not verdict.passed
    assert verdict.confidence == 0.0


def test_review_does_not_modify_question():
    """只审不改：输入题目对象不被修改."""
    question = make_question()
    before = json.dumps(question, ensure_ascii=False, sort_keys=True)
    r = reviewer_returning(
        {
            "grounded": True, "answer_correct": True, "unambiguous": True,
            "difficulty_match": True, "confidence": 0.9, "issues": [],
        }
    )
    asyncio.run(r.review(question, make_context()))
    assert json.dumps(question, ensure_ascii=False, sort_keys=True) == before


def test_merge_snapshot_evidence():
    """快照证据并入审题上下文（去重，不重复当前已存在的切片）."""
    context = make_context()
    snapshot = [
        EvidenceItem(chunk_id=1024, document_id=18, content="MCP 支持 stdio 与 SSE。", source="mysql"),  # 已存在
        EvidenceItem(chunk_id=1303, document_id=38, content="工具调用异常处理最佳实践。", source="mysql"),  # 缺失
        EvidenceItem(chunk_id=0, document_id="rag", content="RAG 项跳过", source="rag"),  # RAG 不并入
    ]
    merged = QuestionReviewer.merge_snapshot_evidence(context, snapshot)
    ids = [e.chunk_id for e in merged.evidence]
    assert ids == [1303, 1024, 1025]  # 快照证据前置（prompt 截断时优先）
    # 原 context 不被修改（不可变复制）
    assert [e.chunk_id for e in context.evidence] == [1024, 1025]
