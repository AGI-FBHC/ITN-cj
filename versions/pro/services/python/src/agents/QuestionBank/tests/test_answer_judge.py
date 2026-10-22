"""Answer Judge 判分规则测试（纯函数，无 DB / 无 LLM）."""
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
    TraceInfo,
)
from questionbank.services.question.answer_judge import (
    judge_objective,
    judge_subjective,
)

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
        evidence=[
            EvidenceItem(chunk_id=1024, document_id=18, content="MCP 支持 stdio 与 SSE 两种传输。", score=0.9, source="mysql"),
        ],
        coverage=CoverageInfo(direct_chunk_count=1, coverage_level="sufficient"),
        trace=TraceInfo(strategy="mysql", request_id="r1"),
    )


class TestObjectiveJudge:
    def test_single_choice_case_insensitive(self):
        j = judge_objective("single_choice", "B", "b")
        assert j.is_correct is True
        assert j.score == 1.0
        assert j.judge_mode == "rule"

    def test_single_choice_wrong(self):
        j = judge_objective("single_choice", "B", "C")
        assert j.is_correct is False
        assert j.score == 0.0

    def test_multiple_choice_set_equality(self):
        ref = ["A", "C"]
        assert judge_objective("multiple_choice", ref, ["C", "A"]).is_correct is True
        assert judge_objective("multiple_choice", ref, ["A"]).is_correct is False
        assert judge_objective("multiple_choice", ref, ["A", "B"]).is_correct is False
        # 字符串形式（逗号分隔）
        assert judge_objective("multiple_choice", ref, "c,a").is_correct is True

    def test_true_false_normalization(self):
        assert judge_objective("true_false", True, "true").is_correct is True
        assert judge_objective("true_false", True, 1).is_correct is True
        assert judge_objective("true_false", False, "false").is_correct is True
        assert judge_objective("true_false", False, "错").is_correct is True
        assert judge_objective("true_false", True, 0).is_correct is False
        assert judge_objective("true_false", False, "对").is_correct is False  # 答"对"=true，参考答案 false

    def test_unsupported_type_raises(self):
        with pytest.raises(ValueError):
            judge_objective("short_answer", "x", "y")


class TestSubjectiveJudge:
    def _llm_responding(self, payload: dict) -> LLMClient:
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}]})

        return LLMClient(SETTINGS, transport=httpx.MockTransport(handler))

    def test_full_judgment(self):
        llm = self._llm_responding(
            {
                "score": 0.8, "is_correct": True,
                "matched_points": ["说明标准化协议作用", "说明工具调用关系"],
                "missing_points": ["未说明资源访问"],
                "feedback": "总体正确，补充资源访问细节更佳",
            }
        )
        q = {"stem": "简述 MCP 的作用", "reference_answer": "标准化协议…", "explanation": "…"}
        j = asyncio.run(judge_subjective(llm, q, "MCP 是标准化协议，定义工具调用", make_context()))
        assert j.judge_mode == "llm"
        assert j.is_correct is True
        assert j.score == 0.8
        assert len(j.judge_details["matched_points"]) == 2
        assert "资源访问" in j.judge_details["missing_points"][0]

    def test_llm_failure_returns_unjudged(self):
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="boom")

        llm = LLMClient(SETTINGS, transport=httpx.MockTransport(handler))
        q = {"stem": "简述", "reference_answer": "x"}
        j = asyncio.run(judge_subjective(llm, q, "答案", make_context()))
        assert j.is_correct is None
        assert j.score is None
        assert "失败" in j.judge_details["error"]

    def test_out_of_range_score_unjudged(self):
        llm = self._llm_responding({"score": 5.0, "is_correct": True, "matched_points": [], "missing_points": [], "feedback": ""})
        q = {"stem": "简述", "reference_answer": "x"}
        j = asyncio.run(judge_subjective(llm, q, "答案", make_context()))
        assert j.score is None
        assert j.is_correct is True  # is_correct 独立解析
