from datetime import UTC, datetime
from uuid import uuid4

from app.domain.models import AgentAskRequest, NoteCreateRequest, PresentationNoteDraftRequest
from app.storage.notes import NoteStore
from app.routers.public import _assistant_note_is_grounded


def test_note_create_request_accepts_frontend_aliases():
    request = NoteCreateRequest(
        title="极限定义",
        content="极限描述函数的趋近行为。",
        status="pending_review",
        sourceType="presentation",
        sourceRef="task-1",
        sourceContext="第 3 页",
    )

    payload = request.model_dump()
    assert payload["source_type"] == "presentation"
    assert payload["source_ref"] == "task-1"
    assert payload["source_context"] == "第 3 页"


def test_presentation_note_draft_accepts_revision():
    request = PresentationNoteDraftRequest(
        instruction="改得更简洁",
        slideIndex=2,
        currentDraft="原始草稿",
    )

    assert request.slide_index == 2
    assert request.current_draft == "原始草稿"


def test_note_store_serializes_public_shape():
    note_id = uuid4()
    now = datetime.now(UTC)
    result = NoteStore._serialize({
        "id": note_id.bytes,
        "title": "标题",
        "content": "正文",
        "status": "approved",
        "source_type": "manual",
        "source_ref": None,
        "source_context": "工作台",
        "created_at": now,
        "updated_at": now,
    })

    assert result["id"] == str(note_id)
    assert result["sourceType"] == "manual"
    assert result["sourceContext"] == "工作台"


def test_agent_ask_accepts_structured_page_state():
    learner_id = uuid4()
    request = AgentAskRequest(
        learnerId=str(learner_id), text="解释这个", pageContext="/learn/resource/example",
        pageState={"pageType": "完整阅读", "focus": {"title": "RNN", "text": "隐藏状态传递历史信息"}},
    )
    assert request.page_state["focus"]["title"] == "RNN"


def test_assistant_note_rejects_prompt_echo_and_unrelated_content():
    source = "RNN通过隐藏状态在时间步之间传递历史信息。"
    assert not _assistant_note_is_grounded(
        "核心要求", "标题不超过24字，正文使用Markdown语法，去除对话痕迹。", source,
    )
    assert not _assistant_note_is_grounded("牛顿定律", "物体的加速度与受力有关。", source)


def test_assistant_note_accepts_grounded_learning_content():
    source = "RNN通过隐藏状态在时间步之间传递历史信息。"
    assert _assistant_note_is_grounded(
        "RNN的隐藏状态", "RNN利用隐藏状态连接相邻时间步，从而保留并传递历史信息。", source,
    )
