import asyncio
import json
from uuid import uuid4

import jwt

from app.config import get_settings
from app.domain.models import TeachingGroupRunRequest
from app.services.teaching_group import TeachingGroupService, TeachingGroupState


class FakeDirectory:
    def available(self) -> bool:
        return True

    def load_learner(self, learner_id, user_id):
        return {
            "id": str(learner_id),
            "name": "测试学员",
            "targetJob": "软考-软件设计师",
            "goal": "通过软件设计师考试",
            "scores": {
                "kp-ds": 61,
                "kp-co": 55,
                "kp-os": 53,
                "kp-network": 54,
                "kp-db": 52,
                "kp-agent": 48,
            },
            "blindSpots": ["智能体与大模型"],
        }

    def load_knowledge_points(self):
        return [
            {"code": "kp-ds", "name": "数据结构与算法", "targetLevel": 80, "weight": 0.18},
            {"code": "kp-co", "name": "计算机组成原理", "targetLevel": 82, "weight": 0.2},
            {"code": "kp-os", "name": "操作系统", "targetLevel": 85, "weight": 0.17},
            {"code": "kp-network", "name": "计算机网络", "targetLevel": 78, "weight": 0.15},
            {"code": "kp-db", "name": "数据库", "targetLevel": 90, "weight": 0.16},
            {"code": "kp-agent", "name": "智能体与大模型", "targetLevel": 80, "weight": 0.14},
        ]


class FakeRetriever:
    def search(self, query: str, max_results: int = 3):
        return [
            {
                "id": "1",
                "title": "智能体与大模型基础",
                "source": "测试知识库",
                "excerpt": "Agent 的核心循环包括感知、规划、行动与观察。",
            }
        ]


class FakeEvidenceSearch:
    def __init__(self, sources=None):
        self.sources = sources or []

    async def retrieve(self, query, **kwargs):
        return self.sources, {
            "toolsUsed": ["rag_search", "web_search"] if self.sources else ["rag_search"],
            "webFallbackUsed": any(item.get("sourceType") == "web" for item in self.sources),
        }


class FakeLLM:
    async def complete_json(self, system, prompt, fallback, **kwargs):
        if "学情诊断" in system:
            return {
                "summary": "当前最弱的是「智能体与大模型」",
                "focus": "智能体与大模型",
                "reason": "距离目标缺口最大。",
                "priority": "high",
            }
        if "教学内容生成" in system:
            return {
                "title": "智能体与大模型学习方案",
                "summary": "先补智能体核心循环，再做分阶题验证。",
                "sections": [
                    {
                        "heading": "为什么先学",
                        "body": "从感知、规划、行动、观察循环入手。",
                        "citations": ["1"],
                    }
                ],
                "practice": "完成一个 Agent 循环分析练习。",
                "quiz": "做 3 道题。",
                "citations": [{"kbId": "1", "title": "智能体与大模型基础"}],
            }
        if "决策仲裁" in system:
            return {
                "decision": "accept",
                "nextAction": "从智能体核心循环开始学习",
                "reason": "审核通过，证据充分。",
                "sources": [],
            }
        return fallback


class PublishActionLLM(FakeLLM):
    async def complete_json(self, system, prompt, fallback, **kwargs):
        if "决策仲裁" in system:
            return {
                "decision": "PUBLISH",
                "nextAction": "PUBLISH",
                "reason": "方案符合发布标准。",
                "sources": [],
            }
        return await super().complete_json(system, prompt, fallback, **kwargs)


def test_teaching_group_service_streams_five_agents_in_order(monkeypatch):
    async def execute():
        service = TeachingGroupService(
            get_settings(),
            llm=FakeLLM(),
            directory=FakeDirectory(),
            retriever=FakeRetriever(),
            evidence_search=FakeEvidenceSearch(),
        )
        request = TeachingGroupRunRequest(
            learner_id=uuid4(),
            mode="prepare_next",
        )
        return [event async for event in service.stream(uuid4(), request)]

    events = asyncio.run(execute())
    assert events[0]["type"] == "run_started"
    agents = [
        event["agent"]
        for event in events
        if event["type"] == "agent_started"
    ]
    assert agents == ["DIA-01", "RET-02", "GEN-03", "VER-04", "ARB-05"]
    assert events[-1]["type"] == "run_completed"
    assert events[-1]["data"]["decision"]["decision"] == "accept"
    assert events[-1]["data"]["evidence"][0]["title"] == "智能体与大模型基础"


def test_teaching_group_normalizes_publish_action_without_inverting_verdict():
    async def execute():
        service = TeachingGroupService(
            get_settings(),
            llm=PublishActionLLM(),
            directory=FakeDirectory(),
            retriever=FakeRetriever(),
            evidence_search=FakeEvidenceSearch(),
        )
        request = TeachingGroupRunRequest(learner_id=uuid4(), mode="prepare_next")
        return [event async for event in service.stream(uuid4(), request)]

    events = asyncio.run(execute())
    decision = events[-1]["data"]["decision"]
    assert decision["decision"] == "accept"
    assert decision["nextAction"].startswith("从「数据库」基础讲义开始")
    assert decision["nextAction"] != "PUBLISH"


def test_teaching_group_review_accepts_object_shaped_citations():
    service = TeachingGroupService(
        get_settings(), llm=FakeLLM(), directory=FakeDirectory(), retriever=FakeRetriever(),
    )
    state = TeachingGroupState(
        plan={"sections": [{"heading": "核心概念", "citations": [{"kbId": "WEB-003"}]}]},
        evidence=[{"kbId": "WEB-003", "title": "真实来源"}],
    )
    review = asyncio.run(service._review(state))
    assert review["passed"] is True
    assert review["defects"] == []
    assert review["confidence"] == 95


def test_teaching_group_retriever_exposes_web_search_evidence():
    async def execute():
        service = TeachingGroupService(
            get_settings(),
            llm=FakeLLM(),
            directory=FakeDirectory(),
            retriever=FakeRetriever(),
            evidence_search=FakeEvidenceSearch([{
                "id": 1,
                "sourceType": "web",
                "document": "操作系统公开教程",
                "url": "https://example.test/os",
                "content": "进程调度、内存管理与文件系统",
                "confidence": .76,
                "similarity": .76,
                "chunkId": "",
            }]),
        )
        request = TeachingGroupRunRequest(learner_id=uuid4(), mode="diagnose", knowledge_point_id="kp-os")
        return [event async for event in service.stream(uuid4(), request)]

    events = asyncio.run(execute())
    output = next(event["data"] for event in events if event.get("agent") == "RET-02" and event["type"] == "agent_output")
    assert output["source"] == "web_search"
    assert output["retrieval"]["webFallbackUsed"] is True
    assert output["evidence"][0]["source"] == "Web Search"
    assert output["evidence"][0]["url"] == "https://example.test/os"


def bearer_headers(user_id=None):
    token = jwt.encode(
        {"sub": str(user_id or uuid4()), "email": "tester@example.com"},
        get_settings().jwt_secret,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


class FakeRouteService:
    def agents(self):
        return [{"id": "DIA-01", "name": "学情诊断 Agent", "status": "idle", "duty": "测试"}]

    async def stream(self, user_id, request):
        yield {"type": "run_started", "runId": "test-run", "learnerId": str(request.learner_id)}
        yield {"type": "agent_started", "agent": "DIA-01", "data": {}}
        yield {"type": "agent_output", "agent": "DIA-01", "data": {"focus": "智能体与大模型"}}
        yield {"type": "run_completed", "data": {"decision": {"decision": "accept"}}}


def test_teaching_group_route_streams_real_events(client, monkeypatch):
    import app.routers.public as public

    fake = FakeRouteService()
    monkeypatch.setattr(public, "teaching_group_service", lambda: fake)
    monkeypatch.setattr(public, "teaching_group_run_store", lambda: type("RunStore", (), {
        "create": lambda self, *_args: None,
        "record_event": lambda self, *_args: None,
        "mark_interrupted": lambda self, *_args: None,
    })())

    agents_response = client.get("/v1/teaching-group/agents", headers=bearer_headers())
    assert agents_response.status_code == 200
    assert agents_response.json()["agents"][0]["id"] == "DIA-01"

    stream_response = client.post(
        "/v1/teaching-group/runs/stream",
        json={"learnerId": str(uuid4()), "mode": "prepare_next"},
        headers=bearer_headers(),
    )
    assert stream_response.status_code == 200
    events = [
        json.loads(line.removeprefix("data: "))
        for line in stream_response.text.strip().split("\n\n")
        if line.startswith("data: ")
    ]
    assert events[0]["type"] == "run_started"
    assert events[-1]["type"] == "run_completed"
