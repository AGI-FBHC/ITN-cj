import asyncio
from datetime import datetime
from uuid import uuid4

from app.domain.models import LearningResourceCreateRequest
from app.presentations.store import PresentationStore
from app.storage.resource_generation_tasks import ResourceGenerationTaskStore
from app.routers import public
from app.routers.public import _normalize_generation_event
from app.security import InternalPrincipal


def test_learning_resource_request_keeps_admin_generation_context():
    request = LearningResourceCreateRequest.model_validate({
        "topic": "智能体定义",
        "kpId": "agent-definition",
        "generationContext": {
            "adminGeneration": True,
            "domainCode": "agent",
            "nodeCode": "agent-definition",
        },
    })

    assert request.generation_context == {
        "adminGeneration": True,
        "domainCode": "agent",
        "nodeCode": "agent-definition",
    }


def test_resource_task_response_contains_original_request():
    task_id = uuid4()
    now = datetime.now()
    store = ResourceGenerationTaskStore.__new__(ResourceGenerationTaskStore)
    serialized = store._serialize({
        "id": task_id.bytes,
        "resource_type": "lecture",
        "title": "智能体定义 · 讲义",
        "status": "queued",
        "progress": 2,
        "stage_message": "等待教研组执行",
        "request_json": '{"generation_context":{"adminGeneration":true}}',
        "events_json": "[]",
        "resource_id": None,
        "error_message": None,
        "created_at": now,
        "updated_at": now,
    })

    assert serialized["request"]["generation_context"]["adminGeneration"] is True


def test_presentation_summary_keeps_generation_request_for_admin_management():
    task_id = uuid4()
    now = datetime.now()
    serialized = PresentationStore._serialize({
        "id": task_id.bytes,
        "title": "智能体定义",
        "status": "generating",
        "progress": 35,
        "stage_message": "正在生成",
        "error_message": None,
        "output_path": None,
        "learned_json": None,
        "request_json": '{"generationContext":{"adminGeneration":true,"nodeCode":"agent-definition"}}',
        "created_at": now,
        "updated_at": now,
    }, summary=True)

    assert serialized["request"]["generationContext"]["nodeCode"] == "agent-definition"


def test_historical_task_created_event_is_normalized_as_system_lifecycle():
    event = {
        "seq": 1, "agent": "ARB-05", "agentName": "发布仲裁 Agent",
        "status": "queued", "phase": "queued", "title": "任务已创建",
        "detail": "等待 AI 教研组开始执行", "snapshot": {},
    }

    normalized = _normalize_generation_event(event, 1, task_type="resource")

    assert normalized["agent"] == "SYSTEM"
    assert normalized["agentName"] == "系统流程"
    assert normalized["actorType"] == "system"
    assert normalized["eventType"] == "task_lifecycle"


def test_reused_resource_creates_persistent_completed_task(monkeypatch):
    store = ResourceGenerationTaskStore.__new__(ResourceGenerationTaskStore)
    user_id, task_id, resource_id = uuid4(), uuid4(), uuid4()
    calls = []

    monkeypatch.setattr(store, "create", lambda *_args: {"id": str(task_id)})
    monkeypatch.setattr(store, "update", lambda *args, **kwargs: calls.append((args, kwargs)))
    monkeypatch.setattr(store, "get", lambda *_args: {"id": str(task_id), "status": "completed"})

    task = store.create_reused(
        user_id, "lecture", "智能体定义 · 讲义",
        {"generation_context": {"adminGeneration": False}}, resource_id,
    )

    assert task == {"id": str(task_id), "status": "completed"}
    assert calls[0][0][2:5] == ("completed", 100, "已复用现有资源")
    assert calls[0][1]["resource_id"] == resource_id
    assert calls[0][1]["snapshot"]["reused"] is True


def test_admin_generation_always_creates_new_candidate_task(monkeypatch):
    user_id, task_id, old_task_id = uuid4(), uuid4(), uuid4()
    deleted = []

    class TaskStore:
        def list_same_name(self, *_args):
            return [{"id": str(old_task_id), "status": "completed"}]

        def delete_same_name_except(self, *args):
            deleted.append(args)
            return 1

        def create(self, *_args):
            return {"id": str(task_id), "status": "queued"}

    class ResourceStore:
        def list(self, *_args, **_kwargs):
            raise AssertionError("管理员新建不应复用已有资源")

    async def no_op_generation(*_args):
        return None

    monkeypatch.setattr(public, "resource_generation_task_store", lambda: TaskStore())
    monkeypatch.setattr(public, "learning_resource_store", lambda: ResourceStore())
    monkeypatch.setattr(public, "_run_learning_resource_generation", no_op_generation)

    result = asyncio.run(
        public.create_learning_resource_task(
            "lecture",
            LearningResourceCreateRequest.model_validate({
                "topic": "智能体定义",
                "title": "智能体定义 · 讲义",
                "generationContext": {"adminGeneration": True, "nodeCode": "agent-definition"},
            }),
            InternalPrincipal(user_id=user_id),
        )
    )

    assert result == {"id": str(task_id), "status": "queued"}
    assert deleted == [(user_id, "lecture", "智能体定义 · 讲义", task_id)]


def test_generation_queue_runs_resources_in_parallel_up_to_concurrency():
    async def scenario():
        active = 0
        max_active = 0
        gate = asyncio.Event()
        order = []

        async def generate(name):
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            order.append(f"start:{name}")
            await gate.wait()
            order.append(f"end:{name}")
            active -= 1

        tasks = [public._enqueue_generation(generate(name)) for name in ("lecture", "practice", "quiz")]
        await asyncio.sleep(0.05)
        gate.set()
        await asyncio.gather(*tasks)
        return max_active, order

    max_active, order = asyncio.run(scenario())
    assert 1 < max_active <= min(3, public._generation_concurrency())
    assert all(order.count(f"start:{name}") == 1 for name in ("lecture", "practice", "quiz"))


def test_persisted_batch_sequence_orders_arbitrary_node_codes():
    assert public._calc_priority("kp-g10-1", "lecture", 401) == 401
    assert public._calc_priority("kp-g10-1", "practice", 402) == 402
    assert public._calc_priority("kp-g10-1", "quiz", 403) == 403
    assert public._calc_priority("kp-g10-1", "ppt", 404) == 404
    assert public._calc_priority("kp-g9-9", "ppt", 400) < public._calc_priority("kp-g10-1", "lecture", 401)


def test_execution_summary_is_created_from_event_snapshot_without_llm():
    summary = public._build_event_execution_summary({
        "title": "完成知识依据解析",
        "snapshot": {
            "activity": "解析知识库切片并核对引用",
            "conclusion": "已形成 6 条可追溯依据",
            "sources": ["切片 A", "切片 B"],
            "nextStep": "进入教学蓝图设计",
        },
    })

    assert "执行动作" in summary and "解析知识库切片" in summary
    assert "执行结果" in summary and "6 条可追溯依据" in summary
    assert "依据与检查" in summary and "切片 A" in summary
    assert "后续处理" in summary and "教学蓝图设计" in summary


def test_generation_worker_requeues_waiting_ppt_without_crashing():
    async def scenario():
        calls = 0
        started = 0

        async def generate():
            nonlocal started
            started += 1

        def dependency_ready():
            nonlocal calls
            calls += 1
            return calls >= 2

        task = public._enqueue_generation(
            generate(), node_code="kp-1-2", resource_type="ppt",
            is_ppt=True, ppt_dep_check=dependency_ready,
        )
        await task
        return calls, started

    assert asyncio.run(scenario()) == (2, 1)


def test_generation_queue_cancels_queued_resource_before_it_starts():
    async def scenario():
        gate = asyncio.Event()
        started = []
        concurrency = public._generation_concurrency()

        async def blocker(index):
            started.append(f"blocker{index}")
            await gate.wait()

        async def second():
            started.append("second")

        blockers = [
            public._enqueue_generation(blocker(index))
            for index in range(concurrency)
        ]
        await asyncio.sleep(0.02)
        second_task = public._enqueue_generation(second())
        await asyncio.sleep(0)
        second_task.cancel()
        await asyncio.sleep(0)
        gate.set()
        await asyncio.gather(*blockers, return_exceptions=True)
        await asyncio.gather(second_task, return_exceptions=True)
        for _ in range(100):
            if not public._generation_queue:
                break
            await asyncio.sleep(0.01)
        return started

    started = asyncio.run(scenario())
    assert "second" not in started
    assert len(started) >= public._generation_concurrency()
