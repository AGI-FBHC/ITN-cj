import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from app.domain.models import PresentationChatRequest
from app.routers import public
from app.routers.public import (
    _presentation_chat_context,
    _resolve_presentation_output,
    _slide_image_for_index,
    _slideshow_asset_dir,
)
from app.security import InternalPrincipal


def test_slideshow_assets_are_isolated_by_task_id():
    output_root = Path("data/presentations")
    first_id = uuid4()
    second_id = uuid4()
    first_pptx = output_root / f"{first_id}.pptx"
    second_pptx = output_root / f"{second_id}.pptx"

    first_dir = _slideshow_asset_dir(first_pptx, first_id)
    second_dir = _slideshow_asset_dir(second_pptx, second_id)

    assert first_dir == output_root / str(first_id)
    assert second_dir == output_root / str(second_id)
    assert first_dir != second_dir


def test_presentation_output_resolves_host_path_to_container_mount(monkeypatch, tmp_path: Path):
    task_id = uuid4()
    mounted = tmp_path / f"{task_id}.pptx"
    mounted.touch()
    monkeypatch.setattr(public, "get_settings", lambda: SimpleNamespace(presentation_output_dir=tmp_path))
    resolved = _resolve_presentation_output(task_id, rf"D:\Desktop\ITN\data\presentations\{task_id}.pptx")
    assert resolved == mounted.resolve()


def test_presentation_output_resolves_old_app_path_when_file_lives_under_configured_root(
    monkeypatch, tmp_path: Path,
):
    task_id = uuid4()
    ppt_file = uuid4()
    mounted = tmp_path / f"{ppt_file}.pptx"
    mounted.touch()
    monkeypatch.setattr(public, "get_settings", lambda: SimpleNamespace(presentation_output_dir=tmp_path))
    resolved = _resolve_presentation_output(task_id, f"/app/data/presentations/{ppt_file}.pptx")
    assert resolved == mounted.resolve()


def test_presentation_chat_context_contains_current_and_adjacent_slides():
    task = {
        "title": "测试演示",
        "outline": {
            "title": "数据结构",
            "slides": [
                {"title": "封面", "kind": "title"},
                {
                    "title": "栈",
                    "kind": "concept",
                    "points": [{"heading": "后进先出", "detail": "最后进入的元素最先离开。"}],
                    "speakerNotes": "栈遵循后进先出原则。",
                },
                {"title": "队列", "kind": "concept"},
            ],
        },
    }

    context = _presentation_chat_context(task, 1)

    assert "当前页：2/3" in context
    assert "栈遵循后进先出原则" in context
    assert '"title":"封面"' in context
    assert '"title":"队列"' in context
    assert "[[SLIDE:页码]]" in context


def test_presentation_chat_context_rejects_invalid_slide_index():
    task = {"outline": {"slides": [{"title": "封面"}]}}

    try:
        _presentation_chat_context(task, 2)
    except ValueError as exc:
        assert "out of range" in str(exc)
    else:
        raise AssertionError("Expected an invalid slide index to be rejected")


def test_slide_image_lookup_supports_partially_rendered_decks(tmp_path: Path):
    (tmp_path / "slide-01.png").touch()
    (tmp_path / "slide-02.png").touch()
    (tmp_path / "slide-07.png").touch()

    assert _slide_image_for_index(tmp_path, 0).name == "slide-01.png"
    assert _slide_image_for_index(tmp_path, 1).name == "slide-02.png"
    assert _slide_image_for_index(tmp_path, 2) is None
    assert _slide_image_for_index(tmp_path, 6).name == "slide-07.png"


def test_presentation_chat_stream_uses_direct_llm_without_agent(monkeypatch):
    task_id = uuid4()
    user_id = uuid4()
    task = {
        "status": "completed",
        "title": "测试演示",
        "outline": {
            "title": "测试演示",
            "slides": [
                {"title": "第一页", "speakerNotes": "第一页备注"},
                {"title": "第二页", "speakerNotes": "第二页备注"},
            ],
        },
    }

    class FakeStore:
        def get(self, requested_task_id, requested_user_id):
            assert requested_task_id == task_id
            assert requested_user_id == user_id
            return task

    class FakeLlm:
        calls = 0

        async def stream_chat(self, messages, include_reasoning=False, provider="", thinking=None):
            self.calls += 1
            assert messages[0]["role"] == "system"
            assert "当前页：1/2" in messages[0]["content"]
            assert provider == "mimo"
            assert thinking is False
            yield {"type": "content", "text": "请看第二页。[[SLIDE:2]]"}

    fake_llm = FakeLlm()
    monkeypatch.setattr(public, "presentation_store", lambda: FakeStore())
    monkeypatch.setattr(public, "llm_client", lambda: fake_llm)

    async def collect():
        response = await public.stream_presentation_chat(
            task_id,
            PresentationChatRequest(
                messages=[{"role": "user", "content": "下一部分在哪里？"}],
                slideIndex=0,
                modelProvider="mimo",
            ),
            InternalPrincipal(user_id),
        )
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
        return "".join(chunks)

    body = asyncio.run(collect())
    payloads = [
        json.loads(line.removeprefix("data: "))
        for line in body.splitlines()
        if line.startswith("data: ")
    ]

    assert fake_llm.calls == 1
    # [[SLIDE:2]] 改为 LLM 决策动作：剥离为 control(goto:2)，正文不出现标记
    assert any(item.get("type") == "control" and item.get("action") == "goto" and item.get("page") == 2 for item in payloads)
    assert all("[[SLIDE" not in item.get("content", "") for item in payloads if item.get("type") == "chat_delta")
    assert payloads[-1]["type"] == "chat_completed"
