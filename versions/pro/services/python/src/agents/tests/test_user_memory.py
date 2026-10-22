from uuid import uuid4

from app.services.user_memory import UserMemoryService


class FakeStore:
    def __init__(self, memories=None):
        self.memories = memories or []
        self.upserts = []
        self.usages = []

    def primary_learner_id(self, _user_id):
        return uuid4()

    def append_event(self, *_args):
        return True

    def upsert(self, *args):
        self.upserts.append(args)
        return {}

    def list(self, _user_id):
        return self.memories

    def record_usage(self, _user_id, ids, scene, task_id=None):
        self.usages.append((ids, scene, task_id))


def test_wrong_quiz_answer_creates_knowledge_and_misconception(monkeypatch):
    service = UserMemoryService.__new__(UserMemoryService)
    service.store = FakeStore()
    monkeypatch.setattr(service, "bootstrap_profile", lambda _user_id: uuid4())

    accepted = service.record_event(
        uuid4(), "quiz_answered", "learning_resource", "resource:q1",
        {"kpId": "kp-1-1"},
        {"questionId": "q1", "question": "Agent 是否具备自主决策能力？",
         "correct": False, "mastery": .42, "progress": .2},
    )

    assert accepted is True
    assert [call[2] for call in service.store.upserts] == ["knowledge", "misconception"]
    assert service.store.upserts[0][5]["mastery"] == .42


def test_context_is_scene_and_knowledge_point_scoped(monkeypatch):
    service = UserMemoryService.__new__(UserMemoryService)
    service.store = FakeStore([
        {"id": "1", "namespace": "goal", "scope": {}, "value": {"goal": "学会 Agent"},
         "summary": "目标", "confidence": 1},
        {"id": "2", "namespace": "misconception", "scope": {"kpId": "kp-1-1"},
         "value": {"concept": "自主性"}, "summary": "混淆自主性", "confidence": .9},
        {"id": "3", "namespace": "misconception", "scope": {"kpId": "kp-2-1"},
         "value": {"concept": "符号系统"}, "summary": "其他知识点", "confidence": .8},
        {"id": "4", "namespace": "episodic", "scope": {"kpId": "kp-1-1"},
         "value": {"title": "近期经历"}, "summary": "经历", "confidence": 1},
    ])
    monkeypatch.setattr(service, "bootstrap_profile", lambda _user_id: uuid4())

    context = service.get_context(uuid4(), "quiz_customize", {"kpId": "kp-1-1"}, "task-1")

    assert context["goals"] == [{"goal": "学会 Agent"}]
    assert [item["concept"] for item in context["misconceptions"]] == ["自主性"]
    assert context["recentEpisodes"] == []
    assert service.store.usages[0][0] == ["1", "2"]


def test_prompt_block_omits_empty_memory_context():
    assert UserMemoryService.prompt_block({"memoryRefs": []}) == ""
