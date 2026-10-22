"""Question Generator 单元测试：mock LLM + mock KnowledgeCore（不落库）."""
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
from questionbank.services.question.generator import GenerationRejected, QuestionGenerator
from questionbank.services.question.question_service import DuplicateQuestionError, QuestionService

SETTINGS = SimpleNamespace(
    llm_provider="openai-compatible",  # 测试用 MockTransport 模拟 HTTP，不走真 mock 分支
    llm_model="mimo-v2.6-pro",
    llm_api_url="http://llm.test/v1/chat/completions",
    llm_api_key="x",
    llm_timeout_seconds=10,
    llm_max_tokens=4096,
)


def make_context(level: str = "sufficient", evidence_count: int = 3) -> KnowledgeContext:
    evidence = [
        EvidenceItem(
            chunk_id=1024 + i,
            document_id=18,
            content=f"MCP 传输方式第 {i} 段内容…",
            score=0.9,
            source="mysql" if i < evidence_count - 1 else "rag",
            ragflow_chunk_id=None if i < evidence_count - 1 else "rag_882",
        )
        for i in range(evidence_count)
    ]
    return KnowledgeContext(
        knowledge_point=KnowledgePointInfo(id=72, name="MCP传输方式"),
        prerequisites=[PrerequisiteInfo(id=71, name="MCP协议")],
        evidence=evidence,
        coverage=CoverageInfo(
            direct_chunk_count=len([e for e in evidence if e.source == "mysql"]),
            rag_supplement_count=len([e for e in evidence if e.source == "rag"]),
            coverage_level=level,
        ),
        trace=TraceInfo(strategy="mysql", request_id="test-1"),
    )


class FakeKnowledgeCore:
    def __init__(self, context: KnowledgeContext | None = None, error: Exception | None = None):
        self.context = context
        self.error = error

    async def get_context(self, **kwargs):
        if self.error:
            raise self.error
        return self.context or make_context()

    async def aclose(self):
        pass


class RecordingService:
    """记录 create 调用的假 service（不落库）."""

    def __init__(self):
        self.created: list[dict] = []
        self.duplicate_hashes: set[str] = set()
        self.next_id = 100

    def create(self, data, conn=None):
        # 复现 content_hash 去重：第二次相同内容抛 DuplicateQuestionError
        from questionbank.services.question.duplicate_detector import content_hash

        digest = content_hash(
            question_type=data.question_type,
            stem=data.stem,
            options=[o.model_dump() for o in data.options] if data.options else None,
            reference_answer=data.reference_answer,
        )
        if digest in self.duplicate_hashes:
            raise DuplicateQuestionError(f"重复题目: {digest}")
        self.duplicate_hashes.add(digest)
        self.next_id += 1
        record = {"id": self.next_id, "status": data.status, **data.model_dump()}
        self.created.append(record)
        return record


def make_generator(llm: LLMClient, service: QuestionService | RecordingService | None = None):
    return QuestionGenerator(llm, service or RecordingService(), SETTINGS)


def mock_llm(questions: list[dict]) -> LLMClient:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"questions": questions}, ensure_ascii=False)}}]})

    return LLMClient(SETTINGS, transport=httpx.MockTransport(handler))


def valid_question(**overrides) -> dict:
    q = {
        "question_type": "single_choice",
        "difficulty": 3,
        "cognitive_level": "understand",
        "stem": "MCP 支持哪两种基础传输方式？",
        "options": [
            {"key": "A", "content": "stdio 与 SSE"},
            {"key": "B", "content": "HTTP 与 WebSocket"},
            {"key": "C", "content": "gRPC 与 Thrift"},
        ],
        "reference_answer": ["A"],
        "explanation": "MCP 规范定义 stdio 与 SSE。",
        "primary_category_id": 72,
        "secondary_category_ids": [71],
        "evidence_chunk_ids": [1024, 1025],
    }
    q.update(overrides)
    return q


async def run(coro):
    return await coro


# ── 覆盖度失败策略 ────────────────────────────────────────────────────────


def test_generate_rejects_empty_coverage():
    async def main():
        kc = FakeKnowledgeCore(make_context(level="empty", evidence_count=0))
        gen = make_generator(mock_llm([]))
        with pytest.raises(GenerationRejected) as ei:
            await gen.generate(kc, knowledge_point="无切片知识点")
        assert ei.value.code == "QUESTION_GENERATION_INSUFFICIENT_EVIDENCE"

    asyncio.run(main())


def test_generate_rejects_weak_coverage():
    async def main():
        kc = FakeKnowledgeCore(make_context(level="weak", evidence_count=1))
        gen = make_generator(mock_llm([]))
        with pytest.raises(GenerationRejected):
            await gen.generate(kc, category_id=72)

    asyncio.run(main())


def test_generate_invalid_params():
    async def main():
        gen = make_generator(mock_llm([]))
        with pytest.raises(GenerationRejected):
            await gen.generate(FakeKnowledgeCore(), count=0)
        with pytest.raises(GenerationRejected):
            await gen.generate(FakeKnowledgeCore(), difficulty=9)
        with pytest.raises(GenerationRejected):
            await gen.generate(FakeKnowledgeCore(), question_type="essay")
        with pytest.raises(GenerationRejected):
            await gen.generate(FakeKnowledgeCore())

    asyncio.run(main())


# ── 生成与入库 ────────────────────────────────────────────────────────────


def test_generate_creates_questions_with_evidence_and_metadata():
    async def main():
        service = RecordingService()
        gen = make_generator(mock_llm([valid_question(), valid_question(stem="第二题？", reference_answer=["B"])]), service)
        result = await gen.generate(FakeKnowledgeCore(), category_id=72, difficulty=3, count=2)
        assert len(result["created"]) == 2
        assert result["failed"] == []
        rec = service.created[0]
        assert rec["status"] == "proposed"
        assert rec["source_type"] == "llm"
        # 证据快照：只有 context 内存在的 id
        assert [e["chunk_id"] for e in rec["evidence_refs"]] == [1024, 1025]
        assert rec["generation_metadata"]["prompt_version"] == "question-v1"
        assert rec["generation_metadata"]["knowledge_context_hash"]
        # 知识点关联：primary=72，secondary=71（前置）
        kps = rec["knowledge_points"]
        assert kps[0]["category_id"] == 72 and kps[0]["role"] == "primary"
        assert kps[1]["category_id"] == 71 and kps[1]["role"] == "secondary"

    asyncio.run(main())


def test_generate_fabricated_evidence_rejected():
    """LLM 引用不存在的 chunk_99999 → 该题被拒（防线2）."""
    async def main():
        service = RecordingService()
        gen = make_generator(
            mock_llm([valid_question(evidence_chunk_ids=[99999])]),
            service,
        )
        result = await gen.generate(FakeKnowledgeCore(), category_id=72)
        assert result["created"] == []
        # 首轮 + 重试轮均失败（mock 每次都返回同样伪造证据）
        assert result["failed"]
        assert all("未引用任何有效证据" in f["error"] for f in result["failed"])

    asyncio.run(main())


def test_generate_partial_valid_evidence_keeps_only_matched():
    """混入非法 id → 剔除，保留合法引用."""
    async def main():
        service = RecordingService()
        gen = make_generator(
            mock_llm([valid_question(evidence_chunk_ids=[1024, 99999, "rag_882"])]),
            service,
        )
        result = await gen.generate(FakeKnowledgeCore(), category_id=72)
        assert len(result["created"]) == 1
        refs = service.created[0]["evidence_refs"]
        # 1024 按 chunk_id 匹配；99999 非法剔除；rag_882 按 ragflow_chunk_id 匹配到 1026
        assert [(r["chunk_id"], r["source"]) for r in refs] == [(1024, "mysql"), (1026, "rag")]
        assert refs[0]["document_id"] == 18

    asyncio.run(main())


def test_generate_duplicate_skipped():
    async def main():
        service = RecordingService()
        llm = mock_llm([valid_question()] * 2)  # 两道一模一样的题
        gen = make_generator(llm, service)
        result = await gen.generate(FakeKnowledgeCore(), category_id=72, count=2)
        assert len(result["created"]) == 1
        assert len(result["skipped"]) == 1
        assert "重复" in result["skipped"][0]["reason"]

    asyncio.run(main())


def test_generate_answer_normalization():
    """LLM 数组答案按题型归一化：单选取单值，判断转布尔，多选保留列表."""
    async def main():
        service = RecordingService()
        gen = make_generator(
            mock_llm(
                [
                    valid_question(question_type="true_false", options=None, reference_answer=["true"]),
                    valid_question(
                        question_type="multiple_choice",
                        options=[
                            {"key": "A", "content": "a"}, {"key": "B", "content": "b"},
                            {"key": "C", "content": "c"},
                        ],
                        reference_answer=["A", "C"],
                    ),
                ]
            ),
            service,
        )
        result = await gen.generate(FakeKnowledgeCore(), category_id=72, count=2)
        assert len(result["created"]) == 2
        tf, mc = service.created
        assert tf["reference_answer"] == "true"       # 数组→单值（布尔转换由防线1 validator 完成）
        assert tf["options"] is None
        assert mc["reference_answer"] == ["A", "C"]    # 多选保留列表
        assert [o["key"] for o in mc["options"]] == ["A", "B", "C"]

    asyncio.run(main())


def test_generate_reports_llm_structural_failure():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "not json at all"}}]})

    async def main():
        gen = make_generator(LLMClient(SETTINGS, transport=httpx.MockTransport(handler)))
        result = await gen.generate(FakeKnowledgeCore(), category_id=72)
        assert result["created"] == []
        assert "LLM" in result["failed"][0]["error"]

    asyncio.run(main())


def test_generate_retries_failed_type_in_second_round():
    """首轮某题证据伪造被拒 → 重试轮按题型专项重生成并成功."""
    calls = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        prompt = body["messages"][-1]["content"]
        calls.append(prompt)
        if len(calls) == 1:
            # 首轮：伪造证据 id（防线2 拦截）
            q = valid_question(evidence_chunk_ids=[99999])
        else:
            # 重试轮：引用真实证据
            q = valid_question(evidence_chunk_ids=[1024])
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"questions": [q]}, ensure_ascii=False)}}]})

    async def main():
        service = RecordingService()
        gen = make_generator(LLMClient(SETTINGS, transport=httpx.MockTransport(handler)), service)
        result = await gen.generate(FakeKnowledgeCore(), category_id=72, question_type="single_choice", count=1)
        assert len(result["created"]) == 1
        assert len(result["failed"]) == 1  # 首轮失败记录保留，重试轮成功
        assert "未引用任何有效证据" in result["failed"][0]["error"]
        assert service.created[0]["stem"] == valid_question()["stem"]  # 第二轮成功入库
        assert len(calls) == 2  # 触发重试轮

    asyncio.run(main())
