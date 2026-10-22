from uuid import uuid4
import asyncio

from app.services import personalized_units as module
from app.services.personalized_units import PersonalizedUnitService


class FakeDirectory:
    def load_learner(self, learner_id, user_id):
        return {"id": str(learner_id), "education": "本科", "targetJob": "工程师", "learningStyle": ["案例迁移"], "scores": {"kp-a": 42}}

    def load_knowledge_point(self, code):
        return {"code": code, "name": "父章节"}

    def load_knowledge_topics(self, code):
        return [{"id": "kp-a-t3", "name": "最小知识点", "index": 3}]


class FakeStore:
    def __init__(self): self.saved = None
    def get(self, *args): return None
    def put(self, *args):
        self.saved = args
        return {**args[-2], "sources": args[-1], "cached": False, "updatedAt": "now"}


class FakeGenerator:
    def __init__(self, settings): pass
    async def close(self): pass
    async def generate_lecture(self, payload, context):
        assert payload["title"] == "最小知识点"
        assert context["scope"]["topicId"] == "kp-a-t3"
        return ({"summary": "小结", "chapters": [{"sections": [{"title": "细讲", "content": "只讲这个小点", "citations": [1]}]}]}, [{"id": 1, "document": "来源"}], {})


def test_unit_generation_is_bound_to_smallest_topic(monkeypatch):
    monkeypatch.setattr(module, "LearningContentService", FakeGenerator)
    service = PersonalizedUnitService(object())
    service.directory = FakeDirectory()
    service.store = FakeStore()

    result = asyncio.run(service.get_or_generate(uuid4(), uuid4(), "kp-a", "kp-a-t3"))

    assert result["topicId"] == "kp-a-t3"
    assert result["topicName"] == "最小知识点"
    assert result["difficulty"] == "零基础"
    assert result["styleLabel"] == "案例对照"
    assert result["blocks"][0]["citations"] == [1]
    assert "父章节" not in result["blocks"][0]["text"]
