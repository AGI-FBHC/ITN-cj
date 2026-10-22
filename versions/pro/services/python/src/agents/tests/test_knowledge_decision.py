from types import SimpleNamespace
from uuid import uuid4

import asyncio

from app.services.knowledge_decision import KnowledgeDecisionClient


def settings():
    return SimpleNamespace(
        agent_internal_secret="a" * 32,
        kc_internal_secret=None,
        knowledge_core_url="http://knowledgecore:8010",
        knowledge_resolve_timeout_seconds=5,
        platform_db_url=None,
    )


def test_resolve_evidence_is_used_without_fallback(monkeypatch):
    client = KnowledgeDecisionClient(settings())
    calls = []

    async def request(method, path, user_id, request_id, **kwargs):
        calls.append(path)
        return {"decision": "allow", "high_fidelity_score": 0.9,
                "eligibility": {"is_eligible": True},
                "evidence_items": [{"id": 7, "title": "定义", "content": "可信证据", "score": 0.8}]}

    monkeypatch.setattr(client, "_request", request)
    result = asyncio.run(client.retrieve("测试知识点", uuid4()))
    assert calls == ["/api/v1/knowledge/resolve"]
    assert result["success"] is True
    assert result["fallback_used"] is False
    assert result["chunks"][0]["content"] == "可信证据"
    assert result["high_fidelity_score"] == 0.9
    assert result["eligibility"]["is_eligible"] is True


def test_ineligible_resolve_falls_back_to_chunks(monkeypatch):
    client = KnowledgeDecisionClient(settings())
    calls = []

    async def request(method, path, user_id, request_id, **kwargs):
        calls.append(path)
        if path.endswith("/resolve"):
            return {"decision": "deny", "eligibility": {"is_eligible": False}}
        return {"decision": "parent", "chunks": [
            {"chunk_id": 3, "section_title": "章节", "content": "上卷证据", "confidence": 0.7}]}

    monkeypatch.setattr(client, "_request", request)
    result = asyncio.run(client.retrieve("测试知识点", uuid4()))
    assert calls == ["/api/v1/knowledge/resolve", "/api/v1/knowledge/chunks"]
    assert result["retrieval_stage"] == "chunks"
    assert result["fallback_used"] is True
    assert result["chunks"][0]["document"] == "章节"
