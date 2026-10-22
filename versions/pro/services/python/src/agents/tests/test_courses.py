from datetime import UTC, datetime
from uuid import uuid4
import asyncio

from pydantic import ValidationError

from app.domain.models import CourseChapterUpdateRequest, CourseCreateRequest, CourseRegenerateRequest, CourseUpdateRequest
from app.storage import courses as courses_module
from app.storage.courses import CourseStore
from app.presentations import PresentationRequest
from app.routers import public
from app.security import InternalPrincipal


def test_course_create_request_accepts_frontend_aliases():
    goal_id, learner_id = uuid4(), uuid4()
    request = CourseCreateRequest.model_validate({
        "prompt": "希望生成一门从基础到实践的完整智能体课程",
        "learningGoalId": str(goal_id),
        "learnerId": str(learner_id),
        "learningGoalIds": [str(goal_id)],
        "resourceTypes": ["ppt", "lecture", "practice", "quiz"],
        "depth": "systematic", "scale": "standard", "courseStyle": "blue-white-minimal",
    })
    assert request.learning_goal_id == goal_id
    assert request.learner_id == learner_id
    assert request.learning_goal_ids == [goal_id]
    assert request.resource_types == ["ppt", "lecture", "practice", "quiz"]
    assert request.course_style == "blue-white-minimal"


def test_course_create_request_allows_empty_optional_prompt():
    request = CourseCreateRequest.model_validate({"prompt": "", "courseStyle": "watercolor"})
    assert request.prompt == ""
    assert request.course_style == "watercolor"


def test_course_regenerate_request_defaults_to_text_resources():
    learner_id = uuid4()
    request = CourseRegenerateRequest.model_validate({"learnerId": str(learner_id)})
    assert request.learner_id == learner_id
    assert request.resource_types == ["lecture", "practice", "quiz"]


def test_course_update_requests_trim_titles_and_reject_blank_values():
    assert CourseUpdateRequest(title="  新课程标题  ").title == "新课程标题"
    assert CourseChapterUpdateRequest(title="  新章节标题  ").title == "新章节标题"
    for request_type in (CourseUpdateRequest, CourseChapterUpdateRequest):
        try:
            request_type(title="   ")
        except ValidationError:
            pass
        else:
            raise AssertionError("blank title should be rejected")


def test_course_store_updates_chapter_only_for_owned_course(monkeypatch):
    course_id, chapter_id, user_id = uuid4(), uuid4(), uuid4()
    executed = []

    class FakeCursor:
        rowcount = 1

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, sql, args):
            executed.append((sql, args))

    class FakeConnection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def cursor(self):
            return FakeCursor()

        def commit(self):
            pass

    store = CourseStore.__new__(CourseStore)
    store.settings = None
    store._schema_ready = True
    store.get = lambda *_args: {"id": str(course_id), "chapters": []}
    monkeypatch.setattr(courses_module, "platform_connect", lambda _settings: FakeConnection())

    result = store.update_chapter_meta(course_id, chapter_id, user_id, title="新章节")

    assert result["id"] == str(course_id)
    sql, args = executed[0]
    assert "user_id=%s" in sql
    assert args[-4:] == (chapter_id.bytes, course_id.bytes, course_id.bytes, user_id.bytes)


def test_course_store_serializes_chapter_resource_relationships():
    now, chapter_id = datetime.now(UTC).replace(tzinfo=None), uuid4()
    store = CourseStore.__new__(CourseStore)
    chapter = store._chapter({
        "id": chapter_id.bytes, "chapter_index": 2, "title": "工具调用",
        "summary": "学习工具协议", "objectives_json": '["掌握工具调用"]',
        "sections_json": '[{"title":"工具定义","summary":"定义","keyTopics":["schema"]}]',
        "status": "completed", "progress": 100,
        "resources_json": '{"lecture":{"id":"resource-1","status":"completed"}}',
        "created_at": now, "updated_at": now,
    })
    assert chapter["index"] == 2
    assert chapter["resources"]["lecture"]["id"] == "resource-1"
    assert chapter["sections"][0]["title"] == "工具定义"


def test_course_store_serializes_learner_relationship():
    now, course_id, learner_id = datetime.now(UTC).replace(tzinfo=None), uuid4(), uuid4()
    store = CourseStore.__new__(CourseStore)
    course = store._course({
        "id": course_id.bytes, "learner_id": learner_id.bytes,
        "title": "算法评测工程师", "description": "真实课程", "prompt": "按画像生成",
        "learning_goal_id": None, "learning_goal_ids_json": "[]", "domain_name": "算法评测工程师",
        "depth": "systematic", "scale": "standard", "course_style": "none",
        "resource_types_json": '["lecture"]', "status": "completed", "progress": 100,
        "stage_message": "课程已生成完成", "error_message": None, "current_chapter_id": None,
        "events_json": "[]", "created_at": now, "updated_at": now,
    }, [])
    assert course["learnerId"] == str(learner_id)


def test_course_presentation_automatically_continues_after_outline(monkeypatch):
    task_id = uuid4()
    calls = []

    class FakeStore:
        def get_internal(self, _task_id):
            return {"status": "outline_review"}

        def update(self, _task_id, **changes):
            calls.append(("update", changes["status"]))

    class FakeAgent:
        async def run(self, _task_id, _request):
            calls.append(("run", "outline"))

        async def run_generate(self, _task_id, _request):
            calls.append(("run", "generate"))

    monkeypatch.setattr(public, "presentation_store", lambda: FakeStore())
    monkeypatch.setattr(public, "ppt_agent", lambda: FakeAgent())
    request = PresentationRequest(requirement="为课程章节生成一份完整教学演示文稿")
    asyncio.run(public._run_course_presentation(task_id, request))
    assert calls == [("update", "generating"), ("run", "generate")]


def test_course_presentation_restarts_outline_phase_when_interrupted(monkeypatch):
    task_id = uuid4()
    calls = []

    class FakeStore:
        reads = 0

        def get_internal(self, _task_id):
            self.reads += 1
            return {"status": "generating" if self.reads == 1 else "outline_review"}

        def update(self, _task_id, **changes):
            calls.append(("update", changes["status"]))

    class FakeAgent:
        async def run(self, _task_id, _request):
            calls.append(("run", "outline"))

        async def run_generate(self, _task_id, _request):
            calls.append(("run", "generate"))

    store = FakeStore()
    monkeypatch.setattr(public, "presentation_store", lambda: store)
    monkeypatch.setattr(public, "ppt_agent", lambda: FakeAgent())
    request = PresentationRequest(requirement="恢复被服务重启中断的课程演示文稿")
    asyncio.run(public._run_course_presentation(task_id, request))
    assert calls == [("run", "outline"), ("update", "generating"), ("run", "generate")]


def test_failed_course_resource_retry_queues_only_requested_item(monkeypatch):
    user_id, course_id, chapter_id = uuid4(), uuid4(), uuid4()
    calls = []
    course = {
        "id": str(course_id), "title": "智能体课程", "prompt": "包含可运行案例",
        "learningGoalId": None, "learningGoalIds": [], "depth": "systematic",
        "scale": "compact", "courseStyle": "none", "resourceTypes": ["ppt", "lecture"],
        "chapters": [{
            "id": str(chapter_id), "index": 1, "title": "基础", "summary": "建立概念",
            "objectives": [], "sections": [], "status": "completed", "progress": 100,
            "resources": {
                "ppt": {"id": "failed-task", "status": "failed", "title": "基础 PPT"},
                "lecture": {"id": "lecture-ok", "status": "completed"},
            },
        }],
    }

    class FakeStore:
        def get(self, *_args):
            return course

        def update_chapter(self, _course_id, _chapter_id, status, progress, resources):
            calls.append(("update", status, progress, resources))
            course["chapters"][0]["status"] = status
            course["chapters"][0]["resources"] = resources

    class FakeContextService:
        def __init__(self, _settings):
            pass

        def build(self, *_args):
            return {"goal": {"title": "智能体"}}

    async def fake_enrich(value, _user_id):
        return value

    async def fake_generate(_course_id, _user_id, request, _context, chapter_ids):
        calls.append(("generate", request.resource_types, chapter_ids))

    monkeypatch.setattr(public, "course_store", lambda: FakeStore())
    monkeypatch.setattr(public, "GoalContextService", FakeContextService)
    monkeypatch.setattr(public, "_enrich_course_presentation_status", fake_enrich)
    monkeypatch.setattr(public, "_generate_course", fake_generate)

    async def run():
        result = await public.retry_course_chapter_resource(
            course_id, chapter_id, "ppt", InternalPrincipal(user_id),
        )
        await asyncio.sleep(0)
        return result

    result = asyncio.run(run())
    queued = result["chapters"][0]["resources"]["ppt"]
    assert queued["status"] == "queued"
    assert "id" not in queued
    assert calls[0][1:3] == ("generating", 5)
    assert calls[1] == ("generate", ["ppt"], {chapter_id})


def test_regenerate_course_creates_new_version_and_preserves_source(monkeypatch):
    user_id, course_id, replacement_id, learner_id = uuid4(), uuid4(), uuid4(), uuid4()
    calls = []
    source = {
        "id": str(course_id), "title": "旧课程", "prompt": "原始要求",
        "learningGoalId": None, "learningGoalIds": [], "depth": "systematic",
        "scale": "standard", "courseStyle": "none", "resourceTypes": [],
    }

    class FakeStore:
        def get(self, *_args):
            return source

        def create(self, _user_id, payload, context):
            calls.append(("create", payload, context))
            return {"id": str(replacement_id), "status": "planning"}

        def append_event(self, *_args):
            calls.append(("event", _args))

    class FakeDirectory:
        def load_primary_learner(self, _user_id):
            return None

    class FakeContextService:
        def __init__(self, _settings):
            pass

        def build(self, *_args):
            return {"goal": {"title": "算法评测工程师"}}

    async def fake_learner_context(_user_id, requested_learner_id):
        assert requested_learner_id == learner_id
        return {"goal": {"title": "算法评测工程师"}}

    async def fake_generate(new_id, _user_id, request, _context):
        calls.append(("generate", new_id, request.resource_types))

    monkeypatch.setattr(public, "course_store", lambda: FakeStore())
    monkeypatch.setattr(public, "directory", lambda: FakeDirectory())
    monkeypatch.setattr(public, "GoalContextService", FakeContextService)
    monkeypatch.setattr(public, "_learner_course_context", fake_learner_context)
    monkeypatch.setattr(public, "_generate_course", fake_generate)

    async def run():
        result = await public.regenerate_course(
            course_id, CourseRegenerateRequest(learnerId=learner_id), InternalPrincipal(user_id),
        )
        await asyncio.sleep(0)
        return result

    result = asyncio.run(run())
    assert result["id"] == str(replacement_id)
    assert calls[0][0] == "create"
    assert calls[0][1]["resource_types"] == ["lecture", "practice", "quiz"]
    assert "固定六知识点模板" in calls[0][1]["prompt"]
    assert calls[-1] == ("generate", replacement_id, ["lecture", "practice", "quiz"])


def test_course_generation_semaphore_is_recreated_for_new_event_loop(monkeypatch):
    monkeypatch.setattr(public, "_course_text_generation_semaphore", None)
    monkeypatch.setattr(public, "_course_text_generation_loop", None)

    async def get_semaphore():
        return public._course_generation_semaphore()

    first = asyncio.run(get_semaphore())
    second = asyncio.run(get_semaphore())
    assert first is not second
def test_clean_resource_title_strips_chapter_prefix_and_suffix():
    clean = public._clean_resource_title
    assert clean("第8章 复盘与综合评测：智能体系统能力综合实践指南", "复盘与综合评测", "practice") == "智能体系统能力综合实践指南"
    assert clean("第四章：记忆、规划与复杂工作流 - 诊断测评", "第四章：记忆、规划与复杂工作流", "quiz") is None
    assert clean("工具使用与API集成：选择题", "工具使用与API集成", "quiz") is None
    assert clean("ReAct智能体循环：状态推进与错误恢复", "ReAct智能体循环", "lecture") == "状态推进与错误恢复"
    assert clean("", "基础概念", "lecture") is None
    assert clean(None, "基础概念", "lecture") is None


def test_templated_summary_detection():
    assert public._is_templated_summary("围绕智能体学习目标建立第8阶段的系统能力。")
    assert public._is_templated_summary("围绕数据结构建立第1阶段的系统能力")
    assert not public._is_templated_summary("理解ReAct循环的状态推进机制。")
    assert not public._is_templated_summary("")
def test_get_course_progress_returns_backend_progress(monkeypatch):
    class FakeStore:
        def progress(self, _user_id, _learner_id=None):
            return {"courseId": "course-1", "courseTitle": "智能体课程", "total": 4, "completed": 1, "percent": 25}
    monkeypatch.setattr(public, "course_store", lambda: FakeStore())
    result = asyncio.run(public.get_course_progress(principal=InternalPrincipal(uuid4())))
    assert result["total"] == 4
    assert result["completed"] == 1
    assert result["percent"] == 25

def test_clean_resource_title_rejects_generic_or_tiny_titles():
    clean = public._clean_resource_title
    assert clean("方法", "复盘与综合评测", "lecture") is None
    assert clean("核心概念", "项目实战", "lecture") is None
    assert clean("A", "项目实战", "lecture") is None
    assert clean("ReAct循环机制", "ReAct循环机制", "lecture") is None
def test_prior_chapters_text_builds_compact_summary():
    chapters = [
        {"index": 1, "title": "基础概念与知识地图", "summary": "认识智能体的核心概念。"},
        {"index": 2, "title": "第2章 核心原理", "summary": "围绕智能体建立第2阶段的系统能力。"},
        {"index": 3, "title": "实践流程", "summary": "动手实现典型应用案例。"},
    ]
    prior = public._prior_chapters_text(chapters, 3)
    assert "第1章《基础概念与知识地图》：认识智能体的核心概念。" in prior
    assert "核心原理" in prior
    assert "围绕智能体建立第2阶段" not in prior
    assert "第3章" not in prior
    assert public._prior_chapters_text(chapters, 1) == ""
    assert public._prior_chapters_text([], 5) == ""
