import asyncio
import hashlib
import io
import json
import logging
import math
import re
import struct
import time
import wave
from collections import OrderedDict
from copy import deepcopy

from datetime import datetime
from pathlib import Path
from functools import lru_cache
from typing import Any
from uuid import UUID, uuid4

# Track sessions with active background generation tasks
# Maps session_id (str) -> asyncio.Queue for live event streaming
_active_sessions: dict[str, asyncio.Queue] = {}
_presentation_tasks: dict[UUID, asyncio.Task] = {}
_course_tasks: dict[UUID, asyncio.Task] = {}
_course_resource_retry_tasks: dict[tuple[UUID, UUID, str], asyncio.Task] = {}
_learning_resource_generation_tasks: dict[UUID, asyncio.Task] = {}
_event_summary_backfill_running: set[tuple[str, UUID]] = set()
_event_summary_generation_tasks: set[asyncio.Task] = set()
_personalized_unit_tasks: set[asyncio.Task] = set()
_course_text_generation_semaphore: asyncio.Semaphore | None = None
_course_text_generation_loop: asyncio.AbstractEventLoop | None = None
_slide_render_locks: dict[UUID, asyncio.Lock] = {}
_slide_render_tasks: dict[UUID, asyncio.Task] = {}
_slide_audio_locks: dict[tuple[UUID, str, int], asyncio.Lock] = {}
_slide_audio_tasks: dict[tuple[UUID, str], asyncio.Task] = {}

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import AliasChoices, BaseModel

from app.config import get_settings
from app.domain.models import (AgentRunRequest, AgentRunResponse, AssistantPlanRequest, ChatRequest,
                               ChatResponse, CourseCreateRequest, CourseRegenerateRequest, LearningResourceChatRequest, LearningResourceCreateRequest,
                               LearningResourceProgressRequest, LearningResourceSourceFeedbackRequest,
                               NoteCategoryCreateRequest, NoteCategoryUpdateRequest,
                               CourseUpdateRequest, CourseChapterUpdateRequest,
                               NoteCreateRequest, NoteUpdateRequest, QuizAnswerRequest,
                               WrongAnswerReviewRequest, WrongAnswerUpdateRequest,
                               AgentSessionCreateRequest, AgentSessionUpdateRequest, AgentMessageCreateRequest, AgentDecisionCreateRequest,
                               TutoringSessionCreateRequest, TutoringAnswerRequest,
                               PresentationChatRequest, PresentationNoteDraftRequest,
                               PresentationTtsRequest, WorkflowState,
                               AgentInferRequest, AgentAskRequest, AgentSimilarQuizRequest,
                               PresentationProgressRequest)
from app.services.teaching_group import TeachingGroupService
from app.domain.models import TeachingGroupRunRequest
from app.presentations import PptAgent, PresentationRequest, PresentationStore
from app.routers.internal import chat_messages, llm_client, repository, workflow
from app.security import InternalPrincipal, require_user_principal
from app.services.enhanced_chat_agent import EnhancedChatAgent
from app.services.refusal import detect_refusal, refusal_banner_message
from app.storage.attachments import AttachmentError, AttachmentStore
from app.storage.chat_store import ChatSessionStore
from app.storage.platform_db import PlatformDirectory
from app.storage.platform_db import platform_connect
from app.storage.notes import NoteStore
from app.storage.learning_resources import LearningResourceStore
from app.storage.resource_generation_tasks import ResourceGenerationTaskStore
from app.storage.event_summaries import EventSummaryStore
from app.storage.courses import CourseStore
from app.storage.wrong_answers import WrongAnswerStore
from app.storage.agent_activity import AgentActivityStore
from app.storage.teaching_group_runs import TeachingGroupRunStore
from app.services.learning_content import LearningContentService
from app.services.resource_generation_team import ResourceGenerationTeam
from app.services.resource_group import resolve_resource_group
from app.services.personalized_units import PersonalizedUnitService
from app.services.goal_context import GoalContextService
from app.services.tutoring import TutoringService
from app.services.user_memory import UserMemoryService
from app.services.course_outline_planner import CourseOutlinePlanner, clean_title
from app.services.presentation_actions import (ACTION_PROTOCOL, ControlMarkerStripper, parse_actions, slide_window_messages)
from app.storage.presentation_chat_store import PresentationChatStore

router = APIRouter(prefix="/v1")
logger = logging.getLogger(__name__)


def _assistant_note_is_grounded(title: str, content: str, source_text: str) -> bool:
    """Reject prompt echoes and notes that are not grounded in the user's material."""
    combined = f"{title}\n{content}"
    lowered = combined.lower()
    prompt_markers = (
        "合法json", "json对象", "字数限制", "内容规范", "核心要求",
        "标题（title）", "正文（content）", "只输出", "笔记编辑",
        "删除所有对话痕迹", "去除对话痕迹", "保留事实含义",
        "示例格式", "markdown语法", "可独立阅读", "不依赖对话上下文",
        "结构清晰", "语言精炼", "输出：{\"title\"", "不超过24字",
    )
    if not title.strip() or len(content.strip()) < 8 or any(marker in lowered for marker in prompt_markers):
        return False

    def evidence_tokens(value: str) -> set[str]:
        tokens = {
            word.lower() for word in re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", value)
            if word.lower() not in {"markdown", "json", "title", "content"}
        }
        for run in re.findall(r"[\u4e00-\u9fff]{2,}", value):
            tokens.update(run[index:index + 2] for index in range(len(run) - 1))
        return tokens - {
            "内容", "用户", "笔记", "记录", "整理", "需要", "这个", "部分",
            "问题", "回答", "学习", "知识", "可以", "具体", "说明", "要求",
        }

    source_tokens = evidence_tokens(source_text)
    result_tokens = evidence_tokens(combined)
    if not source_tokens:
        return False
    required_overlap = 1 if len(source_tokens) <= 3 else 2
    return len(source_tokens & result_tokens) >= required_overlap


def _focused_note_source(page_state: dict | None) -> str:
    state = page_state if isinstance(page_state, dict) else {}
    selection = str(state.get("selection") or "").strip()
    if selection:
        return selection[:10000]
    focus = state.get("focus") if isinstance(state.get("focus"), dict) else {}
    focus_text = str(focus.get("text") or "").strip()
    if focus_text:
        return focus_text[:10000]
    dialog = state.get("dialog") if isinstance(state.get("dialog"), dict) else {}
    return str(dialog.get("text") or "").strip()[:10000]


def _course_generation_semaphore() -> asyncio.Semaphore:
    """Return a semaphore owned by the active loop (safe across Uvicorn reloads)."""
    global _course_text_generation_semaphore, _course_text_generation_loop
    loop = asyncio.get_running_loop()
    if _course_text_generation_semaphore is None or _course_text_generation_loop is not loop:
        # MiMo becomes markedly slower when several long JSON generations share
        # one account. Two slots retain useful parallelism without request pile-up.
        _course_text_generation_semaphore = asyncio.Semaphore(2)
        _course_text_generation_loop = loop
    return _course_text_generation_semaphore


def _wav_contains_speech(content: bytes, mime_type: str) -> bool | None:
    """Return False for silent PCM WAV, or None when this format cannot be inspected."""
    if mime_type.lower().split(";", 1)[0].strip() not in {"audio/wav", "audio/x-wav"}:
        return None
    try:
        with wave.open(io.BytesIO(content), "rb") as wav:
            if wav.getsampwidth() != 2 or wav.getcomptype() != "NONE":
                return None
            channels = wav.getnchannels()
            sample_rate = wav.getframerate()
            frames = wav.readframes(wav.getnframes())
    except (EOFError, wave.Error):
        return None
    if channels < 1 or sample_rate < 1 or len(frames) < 2:
        return False
    sample_count = len(frames) // 2
    samples = [
        value[0] / 32768.0
        for value in struct.iter_unpack("<h", frames[:sample_count * 2])
    ]
    frame_size = max(channels, (sample_rate // 50) * channels)
    peak_rms = 0.0
    voiced_samples = 0
    for offset in range(0, len(samples), frame_size):
        frame = samples[offset:offset + frame_size]
        if len(frame) < frame_size // 2:
            continue
        rms = math.sqrt(sum(sample * sample for sample in frame) / len(frame))
        peak_rms = max(peak_rms, rms)
        # Browser microphones often emit a short click/AGC burst even when the
        # user says nothing. Count only sustained, clearly audible frames.
        if rms >= 0.012:
            voiced_samples += len(frame)
    voiced_seconds = voiced_samples / (sample_rate * channels)
    return peak_rms >= 0.018 and voiced_seconds >= 0.24


def _reject_silent_wav(content: bytes, mime_type: str) -> None:
    if _wav_contains_speech(content, mime_type) is False:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="没有检测到有效语音，请靠近麦克风后再试",
        )


@lru_cache
def note_store() -> NoteStore:
    return NoteStore(get_settings())


@lru_cache
def learning_resource_store() -> LearningResourceStore:
    return LearningResourceStore(get_settings())


@lru_cache
def resource_generation_task_store() -> ResourceGenerationTaskStore:
    return ResourceGenerationTaskStore(get_settings())

@lru_cache
def event_summary_store() -> EventSummaryStore:
    return EventSummaryStore(get_settings())


@lru_cache
def course_store() -> CourseStore:
    return CourseStore(get_settings())


@lru_cache
def wrong_answer_store() -> WrongAnswerStore:
    return WrongAnswerStore(get_settings())


@lru_cache
def ability_reward_store() -> "AbilityRewardStore":
    from app.storage.ability_rewards import AbilityRewardStore
    return AbilityRewardStore(get_settings())

@lru_cache
def agent_activity_store() -> AgentActivityStore:
    return AgentActivityStore(get_settings())

@lru_cache
def teaching_group_service() -> TeachingGroupService:
    return TeachingGroupService(get_settings())

@lru_cache
def teaching_group_run_store() -> TeachingGroupRunStore:
    return TeachingGroupRunStore(get_settings())

@lru_cache
def tutoring_service() -> TutoringService:
    return TutoringService(get_settings())

@lru_cache
def personalized_unit_service() -> PersonalizedUnitService:
    return PersonalizedUnitService(get_settings())


@lru_cache
def user_memory_service() -> UserMemoryService:
    return UserMemoryService(get_settings())


async def _record_memory_event(user_id: UUID, event_type: str, source_module: str,
                               source_id: str, scope: dict, payload: dict) -> None:
    """Memory is additive: it must never block the primary learning action."""
    try:
        await asyncio.to_thread(
            user_memory_service().record_event,
            user_id, event_type, source_module, source_id, scope, payload,
        )
    except Exception:
        logger.exception("Failed to record user memory event %s/%s", event_type, source_id)


async def _extract_chat_memory(user_id: UUID, messages: list[dict], reply: str,
                                scope: dict) -> None:
    """Fire-and-forget: extract memory signals from a chat conversation."""
    try:
        await user_memory_service().extract_from_chat(user_id, messages, reply, scope)
    except Exception:
        logger.debug("Chat memory extraction failed (non-critical)", exc_info=True)


def _build_traceability(resource: dict) -> list[dict]:
    sources = resource.get("sources") or []
    source_by_id = {}
    for source in sources:
        try: source_by_id[int(source.get("id"))] = source
        except (TypeError, ValueError): continue
    content = resource.get("content") or {}
    positions: dict[int, list[str]] = {}
    def collect_citations(items: list, label: str) -> None:
        for item in items or []:
            if not isinstance(item, dict): continue
            for citation in item.get("citations") or []:
                try: citation_id = int(citation)
                except (TypeError, ValueError): continue
                positions.setdefault(citation_id, []).append(str(item.get("title") or item.get("stem") or label))
    for chapter in content.get("chapters") or []:
        if isinstance(chapter, dict):
            collect_citations(chapter.get("sections"), str(chapter.get("title") or "章节"))
    collect_citations(content.get("sections"), "讲义")
    collect_citations(content.get("steps"), "实操指南")
    collect_citations(content.get("questions"), "分阶题")
    items = []
    for citation_id, position_titles in positions.items():
        source = source_by_id.get(citation_id)
        if not source: continue
        similarity = source.get("similarity") or 0.8
        items.append({
            "id": str(source.get("id") or citation_id),
            "kbId": f"KB-{citation_id:03d}",
            "title": source.get("document") or "知识库来源",
            "type": source.get("type") or source.get("document_type") or "知识库",
            "url": source.get("url"),
            "credibility": round(max(0.0, min(1.0, float(similarity))) * 100),
            "excerpt": str(source.get("content") or "")[:240],
            "positions": list(dict.fromkeys(position_titles))[:20],
        })
    return items

def _public_quiz(resource: dict) -> dict:
    return resource


@lru_cache
def assistant_tts_service():
    """Reuse the MiMo client so short assistant replies keep one warm connection."""
    from app.services.tts import get_tts_service
    return get_tts_service(get_settings())


@lru_cache
def assistant_audio_service():
    from app.services.assistant_audio import get_assistant_audio_service
    return get_assistant_audio_service(get_settings())


_assistant_tts_cache: OrderedDict[tuple[str, str, str], bytes] = OrderedDict()
_ASSISTANT_TTS_CACHE_LIMIT = 24


_ASSISTANT_ACTIONS = {
    "navigation.open": {"page": {"dashboard", "profile", "resources", "tutor", "knowledge"}},
    "resource.switch_tab": {"tab": {"ppt", "lecture", "practice", "quiz"}},
    "notes.open": {},
    "notes.create": {},
    "presentation.tasks.open": {},
    "presentation.create": {},
    "knowledge.search": {},
    "console.toggle": {},
    "assistant.voice.set": {"voice": {"冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"}},
    "assistant.speed.set": {"speed": {"very_slow", "slow", "normal", "fast", "very_fast"}},
    "assistant.speed.adjust": {"direction": {"slower", "faster"}},
    "assistant.help": {},
    "none": {},
}


def _local_assistant_plan(command: str) -> dict | None:
    """Resolve common safe commands without spending an LLM round trip."""
    clean = re.sub(r"[，。！？\s]", "", command.lower())
    rate_match = re.search(r"(\d+(?:\.\d+)?)\s*(?:倍速|x|×)", command.lower())
    if rate_match:
        requested_rate = float(rate_match.group(1))
        if requested_rate > 1.2:
            return {
                "action": "assistant.speed.set", "arguments": {"speed": "very_fast"},
                "reply": "最高支持 1.2× 极速，不能继续加快；已为你切换到极速。",
                "requiresConfirmation": False,
            }
        if requested_rate < 0.8:
            return {
                "action": "assistant.speed.set", "arguments": {"speed": "very_slow"},
                "reply": "最低支持 0.8× 超慢速，不能继续放慢；已为你切换到超慢速。",
                "requiresConfirmation": False,
            }
    speed_labels = {
        "超慢": ("very_slow", "超慢速"), "最慢": ("very_slow", "超慢速"),
        "慢速": ("slow", "慢速"), "正常速度": ("normal", "正常语速"),
        "正常语速": ("normal", "正常语速"), "恢复正常": ("normal", "正常语速"),
        "快速": ("fast", "快速"), "极速": ("very_fast", "极速"),
        "最快": ("very_fast", "极速"),
    }
    for label, (speed, spoken) in speed_labels.items():
        if label in clean and any(word in clean for word in ("语速", "速度", "说", "讲", "读", "切换", "调成", "改成")):
            return {
                "action": "assistant.speed.set", "arguments": {"speed": speed},
                "reply": f"好的，已切换为{spoken}。", "requiresConfirmation": False,
            }
    if any(word in clean for word in ("再快点", "再快一点", "讲快点", "说快点", "读快点")):
        return {
            "action": "assistant.speed.adjust", "arguments": {"direction": "faster"},
            "reply": "好的，我会加快一档。", "requiresConfirmation": False,
        }
    if any(word in clean for word in ("再慢点", "再慢一点", "讲慢点", "说慢点", "读慢点")):
        return {
            "action": "assistant.speed.adjust", "arguments": {"direction": "slower"},
            "reply": "好的，我会放慢一档。", "requiresConfirmation": False,
        }
    voice_aliases = {
        "冰糖": "冰糖", "茉莉": "茉莉", "苏打": "苏打", "白桦": "白桦",
        "mia": "Mia", "chloe": "Chloe", "milo": "Milo", "dean": "Dean",
    }
    for label, voice in voice_aliases.items():
        if label in clean and any(word in clean for word in ("音色", "声音", "语音", "换成", "改成")):
            return {"action": "assistant.voice.set", "arguments": {"voice": voice},
                    "reply": f"好的，之后我会使用{voice}音色。", "requiresConfirmation": False}
    if ("ppt" in clean or "演示文稿" in clean or "课件" in clean) and any(
        word in clean for word in ("创建", "生成", "制作", "做一份", "做一个", "做个")
    ):
        if len(command.strip()) < 10:
            return {
                "action": "none", "arguments": {},
                "reply": "可以直接帮你创建 PPT。请再告诉我具体主题或希望讲清楚的内容。",
                "requiresConfirmation": False,
            }
        title_match = re.search(r"(?:关于|主题(?:是|为)?)([^，。！？]{2,50}?)(?:的)?(?:ppt|演示文稿|课件)", command, re.I)
        title = title_match.group(1).strip("《》“”\" ") if title_match else ""
        return {
            "action": "presentation.create",
            "arguments": {
                "requirement": command.strip(),
                "title": title,
                "audience": "students",
                "purpose": "courseware",
                "backgroundStyle": "none",
                "style": "academic",
                "slideCount": "0",
                "detailLevel": "balanced",
                "includeSpeakerNotes": "true",
            },
            "reply": f"已开始创建{f'《{title}》' if title else '这份'} PPT，并为你打开任务进度。",
            "requiresConfirmation": False,
        }
    note_match = re.search(r"(?:帮我)?(?:记下|记录|记个笔记|写个笔记|记笔记)[：:，,\s]*(.+)", command, re.I)
    if note_match and note_match.group(1).strip():
        content = note_match.group(1).strip()
        return {
            "action": "notes.create",
            "arguments": {"title": content[:24], "content": content},
            "reply": "已经整理成待审核笔记，请你看一下内容是否合适。",
            "requiresConfirmation": False,
        }
    knowledge_match = re.search(
        r"(?:在)?知识库(?:里|中)?(?:搜索|查找|查询|搜)[：:，,\s]*(.+)", command, re.I,
    )
    if knowledge_match and knowledge_match.group(1).strip():
        query = knowledge_match.group(1).strip()
        return {
            "action": "knowledge.search",
            "arguments": {"query": query},
            "reply": f"已在知识库中搜索“{query}”。",
            "requiresConfirmation": False,
        }
    page_aliases = {
        "工作台": "dashboard", "首页": "dashboard",
        "学情画像": "profile", "用户画像": "profile",
        "资源中心": "resources", "资源页": "resources",
        "交互导学": "tutor", "导学": "tutor",
        "知识库": "knowledge",
    }
    for label, page in page_aliases.items():
        if label in clean and any(word in clean for word in ("打开", "进入", "切换", "前往", "去")):
            return {"action": "navigation.open", "arguments": {"page": page},
                    "reply": f"已为你打开{label}。", "requiresConfirmation": False}
    if ("ppt" in clean or "演示文稿" in clean) and any(
        word in clean for word in ("任务", "记录", "历史", "生成列表")
    ):
        return {"action": "presentation.tasks.open", "arguments": {},
                "reply": "已打开 PPT 生成任务。", "requiresConfirmation": False}
    tab_aliases = {
        "ppt导学": "ppt", "ppt": "ppt", "定制讲义": "lecture",
        "实操指南": "practice", "测试题": "quiz", "分阶测试": "quiz",
    }
    for label, tab in tab_aliases.items():
        if label in clean and any(word in clean for word in ("打开", "进入", "切换", "前往", "去")):
            return {"action": "resource.switch_tab", "arguments": {"tab": tab},
                    "reply": f"已切换到{label}。", "requiresConfirmation": False}
    if "笔记" in clean and any(word in clean for word in ("打开", "查看", "看看")):
        return {"action": "notes.open", "arguments": {},
                "reply": "已打开我的笔记。", "requiresConfirmation": False}
    if "控制台" in clean:
        return {"action": "console.toggle", "arguments": {},
                "reply": "已切换控制台。", "requiresConfirmation": False}
    if clean in {"你能做什么", "帮助", "怎么用", "功能"}:
        return {"action": "assistant.help", "arguments": {},
                "reply": "我可以直接创建 PPT、记录待审核笔记、搜索知识库，也能切换页面、打开笔记和查看 PPT 任务。",
                "requiresConfirmation": False}
    greetings = {
        "你好": "你好呀！我是伴学助手，很高兴见到你。今天想学点什么，还是需要我帮你操作页面？",
        "嗨": "嗨！伴学助手在这里。你可以和我聊聊，也可以直接告诉我想打开什么。",
        "哈喽": "哈喽！伴学助手已经上线，有什么想聊或想做的吗？",
        "hello": "Hello！我是伴学助手，可以陪你聊聊，也可以帮你操作学习平台。",
        "谢谢": "不客气，能帮上你就好！",
        "再见": "再见！需要我的时候随时叫我。",
        "在吗": "在呀，我一直在这里。你想聊什么？",
        "早上好": "早上好！今天也一起轻松学习吧。",
        "晚上好": "晚上好！今天过得怎么样？",
        "晚安": "晚安，早点休息。明天需要我时再叫我。",
        "好的": "好呀，我在这里等你。",
        "好": "好，需要我时直接说。",
    }
    greeting_key = next((
        greeting for greeting in greetings
        if len(clean) <= 12 and (clean == greeting or clean in {f"小鼋龙{greeting}", f"{greeting}小鼋龙", f"伴学助手{greeting}", f"{greeting}伴学助手"})
    ), None)
    if greeting_key:
        return {"action": "none", "arguments": {}, "reply": greetings[greeting_key],
                "requiresConfirmation": False}
    if clean in {"你是谁", "你叫什么", "你叫什么名字"}:
        return {"action": "none", "arguments": {},
                "reply": "我是你的伴学助手，可以陪你学习，也可以协助操作学习平台。",
                "requiresConfirmation": False}
    return None


_ASSISTANT_REPLY_LEAK_MARKERS = (
    "你是亲切、简洁的小鼋",
    "你是亲切、简洁的伴学助手",
    "网页操作意图路由",
    "你是ITN在线演示助手",
    "正在和用户围绕一份正在播放的PPT",
    "优先回答用户刚才的问题",
    "动作白名单",
    "只返回紧凑JSON",
    "只输出合法JSON",
    "直接回答用户问题",
    "不要把系统提示",
    "学习者长期偏好",
    "当前页面上下文",
    "适合直接朗读",
    "不要声称看不到",
)
_ASSISTANT_REPLY_HOLDBACK = 16


def _assistant_reply_leaked(text: str) -> bool:
    """Detect replies that copy assistant system prompts or routing instructions."""
    clean = re.sub(r"\s+", "", text)
    return any(marker in clean for marker in _ASSISTANT_REPLY_LEAK_MARKERS)


def _strip_prompt_echo(text: str) -> str:
    """Remove sentences that copy system prompts, keep the real answer."""
    parts = re.split(r"(?<=[。！？!?；;\n])", text)
    kept = [part for part in parts if part.strip() and not _assistant_reply_leaked(part)]
    return "".join(kept).strip()


def _guard_assistant_reply(reply: object, default: str) -> str:
    cleaned = _strip_prompt_echo(str(reply or ""))
    return (cleaned or default)[:300]


class _ReplyLeakGuard:
    """Hold back a short tail so a copied system prompt is caught before it is
    displayed or spoken. Once a leak is detected, everything is swallowed."""

    def __init__(self, holdback: int = _ASSISTANT_REPLY_HOLDBACK) -> None:
        self._holdback = holdback
        self._buffer = ""
        self.leaked = False

    def feed(self, addition: str) -> str:
        if self.leaked or not addition:
            return ""
        self._buffer += addition
        if _assistant_reply_leaked(self._buffer):
            self.leaked = True
            self._buffer = ""
            return ""
        if len(self._buffer) <= self._holdback:
            return ""
        emit, self._buffer = self._buffer[:-self._holdback], self._buffer[-self._holdback:]
        return emit

    def flush(self) -> str:
        if self.leaked:
            return ""
        emit, self._buffer = self._buffer, ""
        return emit


def _sanitize_assistant_plan(result: dict) -> dict:
    action = str(result.get("action") or "none")
    if action not in _ASSISTANT_ACTIONS:
        action = "none"
    raw_arguments = result.get("arguments")
    arguments = raw_arguments if isinstance(raw_arguments, dict) else {}
    if action == "presentation.create":
        requirement = str(arguments.get("requirement") or "").strip()[:5000]
        if len(requirement) < 10:
            return {
                "action": "none", "arguments": {},
                "reply": "可以直接帮你创建 PPT。请再告诉我主题、受众或希望讲清楚的内容。",
                "requiresConfirmation": False,
            }
        allowed = {
            "audience": {"students", "teachers", "professionals", "general"},
            "purpose": {"courseware", "report", "sharing", "defense", "training"},
            "backgroundStyle": {
                "none", "colorful-ink", "sunset-mountains", "abstract-gradient",
                "clean-minimal", "cartoon-doodle", "blue-white-minimal",
                "blue-conference", "morandi-blue-gray", "business-gray", "watercolor",
            },
            "style": {"minimal", "vibrant", "terracotta", "luxury", "education", "academic", "business", "editorial", "ocean"},
            "detailLevel": {"concise", "balanced", "detailed"},
        }
        clean = {"requirement": requirement, "title": str(arguments.get("title") or "").strip()[:120]}
        defaults = {
            "audience": "students", "purpose": "courseware", "backgroundStyle": "none",
            "style": "academic", "detailLevel": "balanced",
        }
        for key, choices in allowed.items():
            value = str(arguments.get(key) or defaults[key])
            clean[key] = value if value in choices else defaults[key]
        slide_count = str(arguments.get("slideCount") or "0")
        clean["slideCount"] = slide_count if slide_count in {"0", "12", "20", "30", "40", "55", "70"} else "0"
        clean["includeSpeakerNotes"] = (
            "false" if str(arguments.get("includeSpeakerNotes", "true")).lower() == "false" else "true"
        )
        return {
            "action": action, "arguments": clean,
            "reply": _guard_assistant_reply(result.get("reply"), "已开始创建 PPT，并为你打开任务进度。"),
            "requiresConfirmation": False,
        }
    if action == "notes.create":
        content = str(arguments.get("content") or "").strip()[:20000]
        if not content:
            action = "none"
            arguments = {}
        else:
            return {
                "action": action,
                "arguments": {
                    "title": str(arguments.get("title") or "伴学助手记录").strip()[:160],
                    "content": content,
                },
                "reply": _guard_assistant_reply(result.get("reply"), "已整理成待审核笔记，请你确认。"),
                "requiresConfirmation": False,
            }
    if action == "knowledge.search":
        query = str(arguments.get("query") or "").strip()[:200]
        if query:
            return {
                "action": action, "arguments": {"query": query},
                "reply": _guard_assistant_reply(result.get("reply"), f"已在知识库中搜索“{query}”。"),
                "requiresConfirmation": False,
            }
        action = "none"
        arguments = {}
    constraints = _ASSISTANT_ACTIONS[action]
    clean_arguments = {}
    for key, allowed in constraints.items():
        value = str(arguments.get(key) or "")
        if value in allowed:
            clean_arguments[key] = value
    if constraints and len(clean_arguments) != len(constraints):
        action = "none"
        clean_arguments = {}
    return {
        "action": action,
        "arguments": clean_arguments,
        "reply": _guard_assistant_reply(result.get("reply"), "我在呢。你可以继续和我聊，也可以告诉我想打开哪个页面。"),
        "requiresConfirmation": bool(result.get("requiresConfirmation", False)),
    }


def _json_string_progress(raw: str, key: str) -> tuple[str, bool]:
    """Decode an incrementally generated JSON string field."""
    match = re.search(rf'"{re.escape(key)}"\s*:\s*"', raw)
    if not match:
        return "", False
    index = match.end()
    output: list[str] = []
    escapes = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}
    while index < len(raw):
        char = raw[index]
        if char == '"':
            return "".join(output), True
        if char != "\\":
            output.append(char)
            index += 1
            continue
        if index + 1 >= len(raw):
            break
        escaped = raw[index + 1]
        if escaped == "u":
            digits = raw[index + 2:index + 6]
            if len(digits) < 4 or not re.fullmatch(r"[0-9a-fA-F]{4}", digits):
                break
            output.append(chr(int(digits, 16)))
            index += 6
            continue
        output.append(escapes.get(escaped, escaped))
        index += 2
    return "".join(output), False


def _slide_number(path: Path) -> int:
    match = re.search(r"(\d+)$", path.stem)
    return int(match.group(1)) if match else 0


def _slide_images(slide_dir: Path) -> list[Path]:
    paths = list(slide_dir.glob("slide-*.png")) or list(slide_dir.glob("slide_*.png"))
    return sorted(paths, key=_slide_number)


def _slideshow_asset_dir(pptx_path: Path, task_id: UUID) -> Path:
    """Keep rendered images and audio isolated per presentation task."""
    return pptx_path.parent / str(task_id)


def _slide_image_for_index(slide_dir: Path, slide_index: int) -> Path | None:
    page_number = slide_index + 1
    return next((path for path in _slide_images(slide_dir) if _slide_number(path) == page_number), None)


def _presentation_chat_context(task: dict, slide_index: int) -> str:
    """Build a bounded, server-trusted context for an in-slideshow conversation."""
    outline = task.get("outline") or {}
    slides = outline.get("slides") or []
    if slide_index < 0 or slide_index >= len(slides):
        raise ValueError("Slide index is out of range")

    def compact(slide: object) -> dict:
        if not isinstance(slide, dict):
            return {}
        result = {
            "title": str(slide.get("title") or ""),
            "kind": str(slide.get("kind") or ""),
            "takeaway": str(slide.get("takeaway") or ""),
            "points": slide.get("points") or [],
        }
        for key in ("process", "table", "code"):
            if slide.get(key):
                result[key] = slide[key]
        return result

    current = slides[slide_index]
    current_note = str(current.get("speakerNotes") or "") if isinstance(current, dict) else ""
    titles = [
        f"{index + 1}. {str(slide.get('title') or '')}"
        for index, slide in enumerate(slides)
        if isinstance(slide, dict)
    ]

    script_parts: list[str] = []
    for index, slide in enumerate(slides):
        if not isinstance(slide, dict):
            continue
        note = str(slide.get("speakerNotes") or "").strip()
        if not note:
            continue
        script_parts.append(f"第{index + 1}页《{str(slide.get('title') or '')}》：\n{note}")
    deck_script = "\n\n".join(script_parts) or "（本课件未提供演讲稿正文）"
    previous = compact(slides[slide_index - 1]) if slide_index > 0 else {}
    following = compact(slides[slide_index + 1]) if slide_index + 1 < len(slides) else {}
    current_json = json.dumps(compact(current), ensure_ascii=False, separators=(",", ":"))[:1800]
    adjacent_json = json.dumps(
        {"previous": previous, "next": following},
        ensure_ascii=False,
        separators=(",", ":"),
    )[:900]
    deck_map = "\n".join(titles)[:1000]
    deck_summaries = "\n".join(
        f"第{index + 1}页：{json.dumps(compact(slide), ensure_ascii=False, separators=(',', ':'))}"
        for index, slide in enumerate(slides)
        if isinstance(slide, dict)
    )[:3200]
    return (
        "你是ITN在线演示助手，正在和用户围绕一份正在播放的PPT实时交流。"
        "优先回答用户刚才的问题，不要重复整页内容；回答自然、简洁、适合口头交流。"
        "默认回答2到4句、尽量不超过120个汉字，只有用户明确要求详细时才展开。"
        "回复使用纯文本，不要输出Markdown标题、星号加粗、列表符号或代码围栏。"
        "若问题超出当前页，可结合整份PPT回答。需要建议跳页时，必须把"
        "[[SLIDE:页码]]放在回答最开头，页码使用下面目录中的1起始页码；"
        "让页面先跳转再展示回答。不需要跳页时不要输出该标记。"
        "不要声称看不到PPT。\n"
        "不要主动说“可以翻页/让我翻页”这类生硬话术；需要跳页讲解时，"
        "用“我可以跳转到第X页为你详细讲解”这类表达。\n"
        "如果用户问你是谁，直接说明你是陪伴用户学习这份课件的ITN伴学助手。"
        "如果用户询问指定页，必须依据下面对应页的结构摘要回答，禁止用“基于用户需求生成、"
        "围绕关键问题展开、结合具体场景”等模板套话代替具体内容。\n"
        f"PPT标题：{str(outline.get('title') or task.get('title') or '')}\n"
        f"当前页：{slide_index + 1}/{len(slides)}\n"
        f"当前页结构：{current_json}\n"
        f"当前页讲解备注：{current_note[:1100]}\n"
        f"相邻页：{adjacent_json}\n"
        f"整份PPT页码目录：\n{deck_map}\n"
        f"各页结构摘要：\n{deck_summaries}"
        f"\n完整演讲稿（按页码，始终在上下文中）：\n{deck_script}"
        + ACTION_PROTOCOL
    )


def _presentation_chat_context_compact(task: dict, slide_index: int) -> str:
    """Qwen Realtime 语音链路专用精简上下文。

    Realtime 模型按“音频轮次 + 累计时长”管理上下文（默认 20 轮 / 上限 300 秒），
    instructions 的文本预算远小于 100 万 token 的文本模型。因此这里不放完整演讲稿，
    只保留当前页结构/讲稿节选/相邻页/页码目录，总长度控制在 6.5K 字符以内。
    """
    outline = task.get("outline") or {}
    slides = outline.get("slides") or []
    if slide_index < 0 or slide_index >= len(slides):
        raise ValueError("Slide index is out of range")

    def compact_slide(slide: object) -> dict:
        if not isinstance(slide, dict):
            return {}
        result = {
            "title": str(slide.get("title") or ""),
            "kind": str(slide.get("kind") or ""),
            "takeaway": str(slide.get("takeaway") or ""),
            "points": slide.get("points") or [],
        }
        for key in ("process", "table", "code"):
            if slide.get(key):
                result[key] = slide[key]
        return result

    current = slides[slide_index]
    current_note = str(current.get("speakerNotes") or "").strip() if isinstance(current, dict) else ""
    titles = [
        f"{index + 1}. {str(slide.get('title') or '')}"
        for index, slide in enumerate(slides)
        if isinstance(slide, dict)
    ]
    previous = compact_slide(slides[slide_index - 1]) if slide_index > 0 else {}
    following = compact_slide(slides[slide_index + 1]) if slide_index + 1 < len(slides) else {}
    current_json = json.dumps(compact_slide(current), ensure_ascii=False, separators=(",", ":"))[:1200]
    adjacent_json = json.dumps(
        {"previous": previous, "next": following},
        ensure_ascii=False,
        separators=(",", ":"),
    )[:600]
    deck_map = "\n".join(titles)[:800]
    return (
        "你是ITN在线演示助手，正在和用户围绕一份正在播放的PPT实时交流。"
        "优先回答用户刚才的问题，不要重复整页内容；回答自然、简洁、适合口头交流。"
        "默认回答2到4句、尽量不超过120个汉字，只有用户明确要求详细时才展开。"
        "回复使用纯文本，不要输出Markdown标题、星号加粗、列表符号或代码围栏。"
        "不要主动说“可以翻页/让我翻页”这类生硬话术；需要跳页讲解时，"
        "用“我可以跳转到第X页为你详细讲解”这类表达。"
        "不要声称看不到PPT。如果用户问你是谁，直接说明你是陪伴用户学习这份课件的ITN伴学助手。\n"
        f"PPT标题：{str(outline.get('title') or task.get('title') or '')}\n"
        f"当前页：{slide_index + 1}/{len(slides)}\n"
        f"当前页结构：{current_json}\n"
        f"当前页讲解备注：{current_note[:600]}\n"
        f"相邻页：{adjacent_json}\n"
        f"整份PPT页码目录：\n{deck_map}"
    )[:6500]




def _presentation_voice_control(transcript: str, slide_total: int) -> tuple[str, int | None, bool] | None:
    """Resolve unambiguous slideshow commands after ASR, without asking the LLM."""
    clean = re.sub(r"[\s，。！？!?；;：:]", "", transcript).lower()
    if any(word in clean for word in ("继续播放", "继续讲", "接着播放", "接着讲", "开始播放", "别停", "说下去")):
        return "play", None, True
    if any(word in clean for word in ("暂停播放", "暂停一下", "先暂停", "停一下", "别讲了")):
        return "pause", None, False
    if any(word in clean for word in ("下一页", "下页", "往后翻")):
        return "next", None, False
    if any(word in clean for word in ("上一页", "上页", "往前翻")):
        return "previous", None, False
    match = re.search(r"(?:跳到|打开|播放|去)(?:第)?(\d+)(?:页)?", clean)
    if match:
        page = int(match.group(1))
        if 1 <= page <= slide_total:
            return "goto", page, False
    return None


def _valid_presentation_transcript(transcript: str, presentation_context: str) -> bool:
    """Reject silence hallucinations and copied system/context instructions."""
    clean = re.sub(r"[\s*_#>`~]+", "", transcript)
    if not clean or len(clean) > 500:
        return False
    leak_markers = (
        "你是ITN在线演示助手",
        "正在和用户围绕一份正在播放的PPT",
        "优先回答用户刚才的问题",
        "不要声称看不到幻灯片",
        "当前页结构",
        "整份PPT页码目录",
    )
    if any(marker.lower() in clean.lower() for marker in leak_markers):
        return False
    context_clean = re.sub(r"\s+", "", presentation_context).lower()
    if len(clean) >= 80:
        probes = (clean[:28], clean[len(clean) // 2:len(clean) // 2 + 28], clean[-28:])
        if sum(probe.lower() in context_clean for probe in probes if probe) >= 2:
            return False
    return True


async def _render_remaining_slides(
    task_id: UUID,
    pptx_path: Path,
    slide_dir: Path,
    slide_count: int,
) -> None:
    """Render non-critical pages in small batches so on-demand requests can interleave."""
    agent = PptAgent(None, None, pptx_path.parent)
    lock = _slide_render_locks.setdefault(task_id, asyncio.Lock())
    try:
        for first_page in range(3, slide_count + 1, 4):
            last_page = min(slide_count, first_page + 3)
            if all(_slide_image_for_index(slide_dir, page - 1) for page in range(first_page, last_page + 1)):
                continue
            async with lock:
                pdf_path = await asyncio.to_thread(agent.prepare_slideshow_pdf, pptx_path, slide_dir)
                if pdf_path is None:
                    return
                await asyncio.to_thread(
                    agent.render_slide_png_range, pdf_path, slide_dir, first_page, last_page,
                )
            await asyncio.sleep(0)
    finally:
        _slide_render_tasks.pop(task_id, None)


async def _warm_slideshow_audio(
    task_id: UUID, voice: str, notes: list[str], audio_dir: Path,
) -> None:
    """Fill the selected voice cache in the background, prioritizing early pages."""
    from app.services.tts import get_tts_service
    tts = get_tts_service(get_settings())
    semaphore = asyncio.Semaphore(3)

    async def synthesize(index: int, note: str) -> None:
        if not note.strip():
            return
        wav_path = audio_dir / f"slide_{index:03d}.wav"
        if wav_path.is_file():
            return
        lock = _slide_audio_locks.setdefault((task_id, voice, index), asyncio.Lock())
        async with semaphore, lock:
            if not wav_path.is_file():
                await tts.synthesize_to_file(note, wav_path, voice)

    try:
        if not tts.available:
            return
        # The first pages are requested by the player immediately; warm the rest
        # in deck order so normal playback nearly always finds the next page ready.
        await asyncio.gather(
            *(synthesize(index, note) for index, note in enumerate(notes)),
            return_exceptions=True,
        )
    finally:
        await tts.close()
        _slide_audio_tasks.pop((task_id, voice), None)


@lru_cache
def directory() -> PlatformDirectory:
    return PlatformDirectory(get_settings())


async def _assistant_profile(user_id: UUID) -> dict:
    """Load the shared, user-owned assistant preferences and learner context."""
    try:
        return await asyncio.to_thread(directory().load_profile, user_id)
    except Exception:
        logger.exception("Unable to load assistant profile for user %s", user_id)
        return {}


def _assistant_profile_context(profile: dict) -> str:
    """Turn the assistant profile into a bounded, LLM-usable context suffix."""
    if not profile:
        return ""
    safe = {
        key: profile.get(key)
        for key in (
            "educationLevel", "education", "major", "technicalFoundation", "learningPreference",
            "targetJob", "role", "weeklyHours", "learningStyle", "scores",
            "blindSpots", "goal", "preferredFormat", "diagnosisSummary",
        )
        if profile.get(key) is not None
    }
    if not safe:
        return ""
    return (
        "\n学习者画像与偏好（仅在有助于回答时自然使用，不要逐项复述）："
        + json.dumps(safe, ensure_ascii=False, default=str)
    )


async def _assistant_voice(user_id: UUID) -> str:
    from app.services.tts import MIMO_PRESET_VOICES
    voice = str((await _assistant_profile(user_id)).get("ttsVoice") or "").strip()
    return voice if voice in MIMO_PRESET_VOICES else "苏打"


async def _assistant_speed(user_id: UUID) -> str:
    from app.services.tts import TTS_SPEEDS
    speed = str((await _assistant_profile(user_id)).get("ttsSpeed") or "").strip()
    return speed if speed in TTS_SPEEDS else "normal"


@lru_cache
def chat_store() -> ChatSessionStore:
    return ChatSessionStore(get_settings())


@lru_cache
def attachment_store() -> AttachmentStore:
    return AttachmentStore(get_settings())


@lru_cache
def presentation_store() -> PresentationStore:
    return PresentationStore(get_settings())


@lru_cache
def presentation_chat_store() -> PresentationChatStore:
    return PresentationChatStore(get_settings())


def ppt_agent() -> PptAgent:
    settings = get_settings()
    return PptAgent(llm_client(), presentation_store(), settings.presentation_output_dir)


def _presentation_roots() -> list[Path]:
    """Return presentation output roots that may exist in local and container mounts."""
    roots: list[Path] = []
    seen: set[str] = set()
    raw_roots = [
        get_settings().presentation_output_dir,
        Path("/app/data/presentations"),
        Path("/data/presentations"),
    ]
    for root in raw_roots:
        try:
            root = root.resolve()
        except OSError:
            continue
        key = str(root)
        if key in seen:
            continue
        seen.add(key)
        roots.append(root)
    return roots


def _resolve_presentation_output(task_id: UUID, raw_path: str | None) -> Path | None:
    """Resolve persisted PPT paths across Windows-host and Linux-container mounts."""
    roots = _presentation_roots()

    def _is_file(candidate: Path) -> bool:
        try:
            return candidate.is_file()
        except OSError:
            return False

    if raw_path:
        persisted = Path(raw_path).resolve()
        if any(persisted.is_relative_to(root) for root in roots) and _is_file(persisted):
            return persisted
        # DB may store an old container mount prefix while the actual file lives
        # under another presentation data mount (/data vs /app/data).
        name = persisted.name
        for root in roots:
            candidate = root / name
            if _is_file(candidate):
                return candidate
    for root in roots:
        candidate = root / f"{task_id}.pptx"
        if _is_file(candidate):
            return candidate
    return None


def chat_agent(provider: str = "kimi") -> EnhancedChatAgent:
    return EnhancedChatAgent(llm_client(), get_settings(), provider=provider, max_iterations=get_settings().chat_tool_max_iterations)


def require_chat_store() -> ChatSessionStore:
    if not chat_store().available():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Chat session storage is not configured")
    return chat_store()


def owned_session(session_id: UUID, user_id: UUID) -> dict:
    session = require_chat_store().get_session(session_id, user_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat session not found")
    return session


async def enriched_state(principal: InternalPrincipal, request: AgentRunRequest) -> WorkflowState:
    if not directory().available():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="User context is not configured")
    goal = await asyncio.to_thread(directory().load_goal, principal.user_id, request.learning_goal_id)
    if goal is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Learning goal not found")
    profile = await asyncio.to_thread(directory().load_profile, principal.user_id)
    profile.update(goal)
    return WorkflowState(user_id=principal.user_id, learning_goal_id=request.learning_goal_id,
                         content=request.content.strip(), profile=profile, input=request.input)


@router.get("/agents")
async def list_agents(_: InternalPrincipal = Depends(require_user_principal)):
    return {"agents": [{"id": item.agent_id, "name": item.name} for item in workflow().agents]}


@router.get("/teaching-group/agents")
async def teaching_group_agents(_: InternalPrincipal = Depends(require_user_principal)):
    return {"agents": teaching_group_service().agents()}


@router.get("/teaching-group/runs")
async def list_teaching_group_runs(
    limit: int = Query(default=30, ge=1, le=100),
    learner_id: UUID | None = Query(default=None, alias="learnerId"),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    runs = await asyncio.to_thread(
        teaching_group_run_store().list, principal.user_id, limit, learner_id,
    )
    return {"runs": runs}


@router.get("/teaching-group/runs/{run_id}")
async def get_teaching_group_run(
    run_id: UUID,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    run = await asyncio.to_thread(teaching_group_run_store().get, run_id, principal.user_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Teaching group run not found")
    return run


@router.post("/teaching-group/runs/stream")
async def stream_teaching_group(
    request: TeachingGroupRunRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    service = teaching_group_service()
    store = teaching_group_run_store()

    async def events():
        terminal = False
        run_id: UUID | None = None
        try:
            async for event in service.stream(principal.user_id, request):
                if run_id is None:
                    try:
                        run_id = UUID(str(event.get("runId"))) if event.get("runId") else uuid4()
                    except (TypeError, ValueError, AttributeError):
                        run_id = uuid4()
                    await asyncio.to_thread(store.create, run_id, principal.user_id, request)
                event["runId"] = str(run_id)
                await asyncio.to_thread(store.record_event, run_id, principal.user_id, event)
                terminal = event.get("type") in {"run_completed", "run_failed"}
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            if run_id is not None and not terminal:
                await asyncio.to_thread(store.mark_interrupted, run_id, principal.user_id)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _with_admin_resume(request):
    """Mark admin generation requests as eligible for checkpoint recovery."""
    context = request.generation_context
    if isinstance(context, dict) and context.get("adminGeneration") is True:
        if not context.get("resumeEnabled"):
            context = {**context, "resumeEnabled": True}
            request = request.model_copy(update={"generation_context": context})
    return request

async def _run_presentation_full(task_id: UUID, request: PresentationRequest) -> None:
    """Phase 1 outline + Phase 2 slides without manual outline approval."""
    agent = ppt_agent()
    current = await asyncio.to_thread(agent.store.get_internal, task_id)
    checkpoint = await asyncio.to_thread(agent.store.load_checkpoint, task_id) if agent.store else None
    outline_ready = False
    if current:
        raw_outline = current.get("outline_json") or (checkpoint or {}).get("outline")
        outline_ready = isinstance(raw_outline, dict) and bool(raw_outline.get("slides"))
    user_id = None
    raw_user_id = current.get("user_id") if current else None
    if isinstance(raw_user_id, (bytes, bytearray)):
        user_id = UUID(bytes=bytes(raw_user_id))
    elif isinstance(raw_user_id, str):
        user_id = UUID(raw_user_id)

    async def summarize_presentation_event(event_task_id: UUID, seq: int) -> None:
        if user_id is None:
            return
        _spawn_event_summary("ppt", event_task_id, seq, InternalPrincipal(user_id))
    agent.event_summary_callback = summarize_presentation_event
    if not outline_ready:
        await agent.run(task_id, request)
    current = await asyncio.to_thread(agent.store.get_internal, task_id)
    if outline_ready or (current and current.get("status") == "outline_review"):
        await agent.run_generate(task_id, request)
    current = await asyncio.to_thread(agent.store.get_internal, task_id)
    generation_context = request.generation_context or {}
    if current and current.get("status") == "completed" and generation_context.get("regenerate"):
        await asyncio.to_thread(
            agent.store.archive_previous_for_group,
            str(generation_context.get("domainCode") or ""),
            str(generation_context.get("nodeCode") or ""),
            str(generation_context.get("groupName") or "默认分组"), task_id,
        )

async def _run_presentation_after_dependencies(task_id: UUID, request: PresentationRequest) -> None:
    store = presentation_store()
    context = dict(request.generation_context or {})
    domain = str(context.get("domainCode") or "")
    node = str(context.get("nodeCode") or "")
    group = str(context.get("groupName") or "默认分组")
    dependencies = ("lecture", "practice", "quiz")
    initial = await asyncio.to_thread(store.get_internal, task_id)
    raw_user_id = initial.get("user_id") if initial else None
    if isinstance(raw_user_id, (bytes, bytearray)):
        # The waiting event becomes part of the readable execution record when
        # this PPT actually reaches the queue head, not while hundreds of
        # future PPT tasks are merely being registered.
        _spawn_event_summary("ppt", task_id, 1, InternalPrincipal(UUID(bytes=bytes(raw_user_id))))
    while True:
        current = await asyncio.to_thread(store.get_internal, task_id)
        if current is None or str(current.get("status")) in {"completed", "failed", "cancelled"}:
            return
        groups = await asyncio.to_thread(learning_resource_store().list_admin_generation_groups, domain, node)
        selected = next((item for item in groups if item["groupName"] == group), {})
        details = selected.get("details") or {}
        blocked = [dep for dep in dependencies if (details.get(dep) or []) and not {"generated"} & set(details[dep]) and {"failed", "cancelled"} & set(details[dep])]
        if blocked:
            await asyncio.to_thread(
                store.update, task_id, status="failed", progress=100,
                stage_message="依赖资源未完成，交互课件已停止", error_message="缺少依赖：" + ",".join(blocked),
            )
            return
        if all("generated" in (details.get(dep) or []) for dep in dependencies):
            # The PPT task is normally created before its three dependencies
            # finish. Refresh the lecture here so agenda planning receives the
            # actual approved teaching structure instead of the original empty
            # creation-time context.
            lecture = await asyncio.to_thread(
                learning_resource_store().get_admin_group_resource,
                domain, node, group, "lecture",
            )
            if lecture and isinstance(lecture.get("content"), dict):
                decision = lecture.get("decision") or {}
                context["lectureResource"] = {
                    "title": lecture.get("title"),
                    "content": lecture["content"],
                    "sources": (lecture.get("sources") or [])[:20],
                    "evidenceSnapshot": decision.get("evidenceSnapshot") or [],
                    "knowledgeContext": decision.get("knowledgeContext") or {},
                    "qualityReview": decision.get("multiAgent") or {},
                    "webEvidenceDebate": decision.get("webEvidenceDebate") or {},
                }
                request = request.model_copy(update={"generation_context": context})
            # This dependency waiter itself is already running inside the
            # global generation queue. Run the presentation directly here to
            # avoid a nested enqueue deadlock.
            await _run_presentation_full(task_id, request)
            return
        await asyncio.sleep(5)

@router.post("/presentations", status_code=status.HTTP_202_ACCEPTED)
async def create_presentation(request: PresentationRequest,
                              principal: InternalPrincipal = Depends(require_user_principal)):
    store = presentation_store()
    if not store.available():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Presentation storage is not configured")
    request = _with_admin_resume(request)
    context = dict(request.generation_context or {})
    if context.get("adminGeneration") is True:
        domain = str(context.get("domainCode") or "")
        node = str(context.get("nodeCode") or "")
        group = str(context.get("groupName") or "默认分组")
        if domain and node:
            existing_groups = await asyncio.to_thread(learning_resource_store().list_admin_generation_groups, domain, node)
            existing_types = set(next((item for item in existing_groups if item["groupName"] == group), {}).get("types") or [])
            if "ppt" in existing_types and not context.get("regenerate"):
                raise HTTPException(status_code=409, detail="该分组已存在交互课件，同一分组内各资源唯一")
            group_detail = next((item for item in existing_groups if item["groupName"] == group), {})
            detail_map = group_detail.get("details") or {}
            generated_types = {rtype for rtype, statuses in detail_map.items() if "generated" in statuses}
            # 交互课件允许先排队：前三项尚未完成时进入依赖等待队列，完成后自动开始生成。
            if not {"lecture", "practice", "quiz"}.issubset(generated_types):
                context["waitForDependencies"] = True
                request = request.model_copy(update={"generation_context": context})
                context = dict(request.generation_context or {})
    kp_id = str(context.get("kpId") or "").strip()
    if kp_id:
        lectures = await asyncio.to_thread(
            learning_resource_store().list,
            principal.user_id, "lecture", False, None, kp_id,
        )
        topic_name = str(context.get("topicName") or request.title or "").strip()
        matched_lecture = next((
            item for item in lectures
            if topic_name and str(item.get("topic") or "").strip() == topic_name
        ), lectures[0] if lectures else None)
        if matched_lecture:
            lecture = await asyncio.to_thread(
                learning_resource_store().get, UUID(matched_lecture["id"]), principal.user_id,
            )
            if lecture and isinstance(lecture.get("content"), dict):
                context["lectureResource"] = {
                    "title": lecture.get("title"),
                    "content": lecture["content"],
                    "sources": (lecture.get("sources") or [])[:12],
                    "evidenceSnapshot": (lecture.get("decision") or {}).get("evidenceSnapshot") or [],
                    "knowledgeContext": (lecture.get("decision") or {}).get("knowledgeContext") or {},
                    "qualityReview": (lecture.get("decision") or {}).get("multiAgent") or {},
                    "webEvidenceDebate": (lecture.get("decision") or {}).get("webEvidenceDebate") or {},
                }
                request = request.model_copy(update={"generation_context": context})
    presentation_title = request.title or request.requirement.strip().splitlines()[0][:80]
    previous_tasks = await asyncio.to_thread(store.list_same_name, principal.user_id, presentation_title)
    task = await asyncio.to_thread(store.create, principal.user_id, request)
    task_id = UUID(task["id"])
    for previous in previous_tasks:
        previous_id = UUID(previous["id"])
        background = _presentation_tasks.pop(previous_id, None)
        if background and not background.done():
            background.cancel()
    if previous_tasks:
        await asyncio.to_thread(
            store.delete_same_name_except, principal.user_id, presentation_title, task_id,
        )
    if context.get("waitForDependencies") is True:
        recorded = await asyncio.to_thread(
            store.append_event, task_id, "queued", "等待前三项完成",
            "讲义、实操、题库完成后自动启动交互课件",
        )
        if recorded:
            _spawn_event_summary("ppt", task_id, int(recorded["seq"]), InternalPrincipal(principal.user_id))
        await asyncio.to_thread(
            store.update, task_id, status="queued", progress=2, stage_message="等待前三项完成",
        )
    lecture_context = context.get("lectureResource") if isinstance(context.get("lectureResource"), dict) else {}
    if lecture_context:
        recorded = await asyncio.to_thread(
            store.append_event, task_id, "analysis", "知识依据已准备",
            "交互课件将继承讲义中已核验的知识依据、引用来源和教学结构",
            {"sourceCount": len(lecture_context.get("sources") or []),
             "evidenceCount": len(lecture_context.get("evidenceSnapshot") or []),
             "citationVerified": bool((lecture_context.get("qualityReview") or {}).get("citationVerified"))},
        )
        if recorded:
            _spawn_event_summary("ppt", task_id, int(recorded["seq"]), InternalPrincipal(principal.user_id))
    node_code = str(context.get("nodeCode") or context.get("kpId") or "")
    waiting_on_dependencies = context.get("waitForDependencies") is True
    background = _enqueue_generation(
        _run_presentation_after_dependencies(task_id, request)
        if waiting_on_dependencies
        else _run_presentation_full(task_id, request),
        node_code=node_code, resource_type="ppt",
        is_ppt=waiting_on_dependencies,
        ppt_dep_check=(lambda: _ppt_dep_check_from_context(context))
        if waiting_on_dependencies else None,
        queue_sequence=context.get("queueSequence"),
    )
    _presentation_tasks[task_id] = background
    background.add_done_callback(lambda _task, key=task_id: _presentation_tasks.pop(key, None))
    return task


@router.post("/presentations/{task_id}/restart")
async def restart_presentation(
    task_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    store = presentation_store()
    task = await asyncio.to_thread(store.restart, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=409, detail="任务不存在或当前状态不允许重启")
    request = PresentationRequest.model_validate(task["request"])
    if task.get("events"):
        _spawn_event_summary("ppt", task_id, len(task["events"]), principal)
    ppt_node = (request.generation_context or {}).get("nodeCode") or (request.generation_context or {}).get("kpId") or ""
    restart_context = request.generation_context or {}
    background = _enqueue_generation(
        _run_presentation_full(task_id, request), node_code=ppt_node,
        resource_type="ppt", queue_sequence=restart_context.get("queueSequence"),
    )
    _presentation_tasks[task_id] = background
    background.add_done_callback(lambda _task, key=task_id: _presentation_tasks.pop(key, None))
    return task

@router.post("/presentations/{task_id}/cancel")
async def cancel_presentation(task_id: UUID,
                              principal: InternalPrincipal = Depends(require_user_principal)):
    store = presentation_store()
    task = await asyncio.to_thread(store.get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    if task["status"] in {"completed", "failed", "cancelled"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Presentation task is no longer running")
    if not await asyncio.to_thread(store.cancel, task_id, principal.user_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Presentation task could not be cancelled")
    cancelled_task = await asyncio.to_thread(store.get, task_id, principal.user_id)
    if cancelled_task and cancelled_task.get("events"):
        _spawn_event_summary("ppt", task_id, len(cancelled_task["events"]), InternalPrincipal(principal.user_id))
    background = _presentation_tasks.get(task_id)
    if background and not background.done():
        background.cancel()
    return await asyncio.to_thread(store.get, task_id, principal.user_id)


@router.post("/presentations/{task_id}/generate", status_code=status.HTTP_202_ACCEPTED)
async def start_presentation_generation(task_id: UUID,
                                        principal: InternalPrincipal = Depends(require_user_principal)):
    store = presentation_store()
    task = await asyncio.to_thread(store.get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    if task["status"] != "outline_review":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail=f"Task is in status '{task['status']}', expected 'outline_review'")
    request = PresentationRequest.model_validate(task["request"])
    store.update(task_id, status="generating", progress=40,
                 stage_message="提纲已确认，正在设计幻灯片")
    ppt_node2 = (request.generation_context or {}).get("nodeCode") or (request.generation_context or {}).get("kpId") or ""
    generate_context = request.generation_context or {}
    background = _enqueue_generation(
        ppt_agent().run_generate(task_id, request), node_code=ppt_node2,
        resource_type="ppt", queue_sequence=generate_context.get("queueSequence"),
    )
    _presentation_tasks[task_id] = background
    background.add_done_callback(lambda _task, key=task_id: _presentation_tasks.pop(key, None))
    return task


def _etag_json(payload: dict, request: Request, prefix: str) -> Response:
    """轮询接口的条件响应：内容没变时返回 304，前端复用上次响应，省网络与解析。"""
    import hashlib
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    etag = f'"{prefix}-{hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]}"'
    if request.headers.get("If-None-Match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    return JSONResponse(payload, headers={"ETag": etag})


@router.get("/presentations")
async def list_presentations(request: Request,
                            summary: bool = True,
                            limit: int = 20,
                            exclude_course: bool = False,
                            principal: InternalPrincipal = Depends(require_user_principal)):
    store = presentation_store()
    if not store.available():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Presentation storage is not configured")
    # The administrator workbench can legitimately contain hundreds of
    # queued resources from one domain-wide batch. Keep the ordinary default
    # small, but allow that management view to request the complete set.
    limit = max(1, min(limit, 1000))
    return _etag_json({"tasks": await asyncio.to_thread(
        store.list, principal.user_id, limit, summary=summary, exclude_course=exclude_course,
    )}, request, "ppt")


@router.get("/presentations/{task_id}")
async def get_presentation(task_id: UUID,
                           principal: InternalPrincipal = Depends(require_user_principal)):
    task = await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    await _attach_stored_summaries_to_task(task, "ppt", principal.user_id)
    return task


@router.post("/presentations/{task_id}/complete")
async def complete_presentation(task_id: UUID,
                                principal: InternalPrincipal = Depends(require_user_principal)):
    learned = await asyncio.to_thread(presentation_store().mark_learned, task_id, principal.user_id)
    if not learned:
        raise HTTPException(status_code=404, detail="Completed presentation task not found")
    return {"learned": True}

# 下载路由原来和 complete 叠在一起：GET /download 会打到 complete，而 download_presentation 没有装饰器，
# 等于"课件下载"这条路根本不存在。拆开。
@router.get("/presentations/{task_id}/download")
async def download_presentation(task_id: UUID,
                                principal: InternalPrincipal = Depends(require_user_principal)):
    output = await asyncio.to_thread(presentation_store().output_for, task_id, principal.user_id)
    if not output:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation file is not ready")
    path = _resolve_presentation_output(task_id, output)
    if path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation file is missing")
    return FileResponse(path, media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                        filename=f"ITN-Presentation-{task_id}.pptx")


@router.delete("/presentations/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_presentation(task_id: UUID,
                              principal: InternalPrincipal = Depends(require_user_principal)):
    store = presentation_store()
    task = await asyncio.to_thread(store.get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    if task["status"] not in {"completed", "failed", "cancelled"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Presentation generation is still in progress")
    output = await asyncio.to_thread(store.delete, task_id, principal.user_id)
    if output is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    if output:
        path = Path(output).resolve()
        output_root = get_settings().presentation_output_dir.resolve()
        if path.is_relative_to(output_root) and path.is_file():
            await asyncio.to_thread(path.unlink)


@router.post("/presentations/batch-delete")
async def batch_delete_presentations(payload: dict,
                                    principal: InternalPrincipal = Depends(require_user_principal)):
    raw_ids = payload.get("taskIds") or payload.get("task_ids") or []
    if not isinstance(raw_ids, list) or not raw_ids:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="taskIds must be a non-empty array")
    if len(raw_ids) > 100:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="taskIds cannot contain more than 100 items")
    try:
        task_ids = [UUID(str(item)) for item in raw_ids]
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="taskIds contains invalid UUIDs")

    store = presentation_store()
    if not store.available():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Presentation storage is not configured")
    try:
        outputs = await asyncio.to_thread(store.batch_delete, task_ids, principal.user_id)
    except ValueError as error:
        message = str(error)
        if "仍在进行中" in message:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=message)

    settings = get_settings()
    output_root = settings.presentation_output_dir.resolve()
    for raw in outputs:
        if not raw:
            continue
        path = Path(raw).resolve()
        if path.is_relative_to(output_root) and path.is_file():
            await asyncio.to_thread(path.unlink, missing_ok=True)
    return {"deleted": [str(task_id) for task_id in task_ids], "count": len(task_ids)}


@router.get("/presentations/{task_id}/slides")
async def get_slideshow_slides(task_id: UUID,
                               principal: InternalPrincipal = Depends(require_user_principal)):
    """Return slide metadata for the slideshow viewer. Images are fetched per-slide."""
    task = await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    if task["status"] != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Presentation is not completed yet")
    settings = get_settings()
    pptx_path = _resolve_presentation_output(task_id, task.get("outputPath") or task.get("output_path"))
    if pptx_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PPTX file is missing")
    asset_dir = _slideshow_asset_dir(pptx_path, task_id)
    slide_dir = asset_dir / "slides"
    outline = task.get("outline") or {}
    outline_slides = outline.get("slides", [])
    # Old completed tasks predate teachingMoments. Enrich the in-memory copy at
    # read time so they gain the same classroom behavior without rewriting DB/PPTX.
    PptAgent._ensure_teaching_moments(outline_slides)
    speaker_notes = [str(s.get("speakerNotes", "")) for s in outline_slides]
    teaching_moments = [
        s.get("teachingMoments", []) if isinstance(s, dict) and isinstance(s.get("teachingMoments"), list) else []
        for s in outline_slides
    ]
    n = len(speaker_notes)
    if n <= 0:
        n = len(_slide_images(slide_dir))
    first_pages_ready = all(_slide_image_for_index(slide_dir, index) for index in range(min(2, n)))
    if not first_pages_ready:
        lock = _slide_render_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            first_pages_ready = all(_slide_image_for_index(slide_dir, index) for index in range(min(2, n)))
            if not first_pages_ready:
                agent = PptAgent(None, None, pptx_path.parent)
                pdf_path = await asyncio.to_thread(agent.prepare_slideshow_pdf, pptx_path, slide_dir)
                if pdf_path is None:
                    raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                        detail="Failed to prepare slideshow")
                await asyncio.to_thread(
                    agent.render_slide_png_range, pdf_path, slide_dir, 1, min(2, n),
                )
    if n > 2 and task_id not in _slide_render_tasks:
        background = asyncio.create_task(_render_remaining_slides(task_id, pptx_path, slide_dir, n))
        _slide_render_tasks[task_id] = background
    speaker_notes = (speaker_notes + [""] * n)[:n]
    teaching_moments = (teaching_moments + [[] for _ in range(n)])[:n]
    voice = await _assistant_voice(principal.user_id)
    audio_dir = asset_dir / "audio" / "pcm_stretch_v3" / voice
    # A note can always be synthesized on demand. Existing files remain the
    # fast path, while changing the profile voice does not require rebuilding
    # the PPT or all of its narration upfront.
    audio_available = [
        bool(speaker_notes[index].strip())
        or (audio_dir / f"slide_{index:03d}.wav").is_file()
        for index in range(n)
    ]
    audio_task_key = (task_id, voice)
    if audio_task_key not in _slide_audio_tasks and any(
        note.strip() and not (audio_dir / f"slide_{index:03d}.wav").is_file()
        for index, note in enumerate(speaker_notes)
    ):
        _slide_audio_tasks[audio_task_key] = asyncio.create_task(
            _warm_slideshow_audio(task_id, voice, speaker_notes, audio_dir),
        )
    return {
        "slideCount": n,
        "imageUrl": f"/v1/presentations/{task_id}/slides/{{index}}",
        "audioUrl": f"/v1/presentations/{task_id}/audio/{{index}}",
        "speakerNotes": speaker_notes,
        "teachingMoments": teaching_moments,
        "audioAvailable": audio_available,
    }


@router.get("/presentations/{task_id}/slides/{slide_index}")
async def get_slide_image(task_id: UUID, slide_index: int,
                          principal: InternalPrincipal = Depends(require_user_principal)):
    """Return PNG image for a single slide."""
    task = await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    if task["status"] != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Presentation is not completed yet")
    settings = get_settings()
    pptx_path = _resolve_presentation_output(task_id, task.get("outputPath") or task.get("output_path"))
    if pptx_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PPTX file is missing")
    slide_dir = _slideshow_asset_dir(pptx_path, task_id) / "slides"
    outline = task.get("outline") or {}
    slide_count = len(outline.get("slides", []))
    if slide_index < 0 or slide_index >= slide_count:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Slide image not found")
    image = _slide_image_for_index(slide_dir, slide_index)
    if image is None:
        lock = _slide_render_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            image = _slide_image_for_index(slide_dir, slide_index)
            if image is None:
                agent = PptAgent(None, None, pptx_path.parent)
                pdf_path = await asyncio.to_thread(agent.prepare_slideshow_pdf, pptx_path, slide_dir)
                if pdf_path is not None:
                    await asyncio.to_thread(
                        agent.render_slide_png_range,
                        pdf_path,
                        slide_dir,
                        slide_index + 1,
                        slide_index + 1,
                    )
                image = _slide_image_for_index(slide_dir, slide_index)
    if image is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Slide image not found")
    return FileResponse(image, media_type="image/png",
                        filename=f"slide_{slide_index}.png")


@router.get("/presentations/{task_id}/audio/{slide_index}")
async def get_slideshow_audio(task_id: UUID, slide_index: int,
                              model_provider: str = "mimo",
                              qwen_voice: str = "longanxiaoxin",
                              principal: InternalPrincipal = Depends(require_user_principal)):
    """Return WAV audio for a specific slide's speaker notes."""
    task = await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    if task["status"] != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Presentation is not completed yet")
    settings = get_settings()
    pptx_path = _resolve_presentation_output(task_id, task.get("outputPath") or task.get("output_path"))
    if pptx_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PPTX file is missing")
    audio_dir = _slideshow_asset_dir(pptx_path, task_id) / "audio"
    outline = task.get("outline") or {}
    slides = outline.get("slides") or []
    if slide_index < 0 or slide_index >= len(slides):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audio not found for this slide")
    note = str(slides[slide_index].get("speakerNotes") or "").strip()
    if not note:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audio not found for this slide")
    selected_model = "qwen" if model_provider.lower() == "qwen" else "mimo"
    if selected_model == "qwen":
        from app.services.qwen_tts import QWEN_TTS_VOICES
        voice = qwen_voice if qwen_voice in QWEN_TTS_VOICES else "longanxiaoxin"
        audio_dir = audio_dir / "qwen_audio_3_tts_flash" / voice
    else:
        voice = await _assistant_voice(principal.user_id)
        audio_dir = audio_dir / "pcm_stretch_v3" / voice
    wav_path = audio_dir / f"slide_{slide_index:03d}.wav"
    if not wav_path.is_file():
        lock = _slide_audio_locks.setdefault((task_id, voice, slide_index), asyncio.Lock())
        async with lock:
            if not wav_path.is_file():
                if selected_model == "qwen":
                    from app.services.qwen_tts import get_qwen_tts_service
                    tts = get_qwen_tts_service(settings)
                else:
                    from app.services.tts import get_tts_service
                    tts = get_tts_service(settings)
                try:
                    if not tts.available:
                        raise HTTPException(
                            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="TTS service is unavailable",
                        )
                    await tts.synthesize_to_file(note, wav_path, voice)
                finally:
                    await tts.close()
    if not wav_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audio not found for this slide")
    return FileResponse(wav_path, media_type="audio/wav",
                        filename=f"slide_{slide_index:03d}.wav")


async def _owned_presentation(task_id: UUID, user_id: UUID) -> dict:
    task = await asyncio.to_thread(presentation_store().get, task_id, user_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    return task


@router.post("/presentations/{task_id}/chat/sessions")
async def create_presentation_chat_session(
    task_id: UUID, model_provider: str = "mimo",
    principal: InternalPrincipal = Depends(require_user_principal),
):
    await _owned_presentation(task_id, principal.user_id)
    return await asyncio.to_thread(
        presentation_chat_store().create, task_id, principal.user_id,
        "qwen" if model_provider.lower() == "qwen" else "mimo",
    )


@router.get("/presentations/{task_id}/chat/sessions")
async def list_presentation_chat_sessions(
    task_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    await _owned_presentation(task_id, principal.user_id)
    return await asyncio.to_thread(
        presentation_chat_store().list, task_id, principal.user_id,
    )


@router.get("/presentations/{task_id}/chat/sessions/{session_id}/messages")
async def get_presentation_chat_messages(
    task_id: UUID, session_id: UUID,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    await _owned_presentation(task_id, principal.user_id)
    store = presentation_chat_store()
    if not await asyncio.to_thread(store.owned, session_id, task_id, principal.user_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation chat session not found")
    return await asyncio.to_thread(store.messages, session_id)


@router.delete(
    "/presentations/{task_id}/chat/sessions/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_presentation_chat_session(
    task_id: UUID, session_id: UUID,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    deleted = await asyncio.to_thread(
        presentation_chat_store().delete, session_id, task_id, principal.user_id,
    )
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation chat session not found")


@router.post("/presentations/{task_id}/chat/stream")
async def stream_presentation_chat(
    task_id: UUID,
    request: PresentationChatRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """Stream a chat answer grounded in the currently displayed slide."""
    task = await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    if task["status"] != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Presentation is not completed yet")
    try:
        system_prompt = _presentation_chat_context(task, request.slide_index)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    system_prompt += _assistant_profile_context(await _assistant_profile(principal.user_id))
    chat_request = ChatRequest(
        messages=request.messages,
        systemPrompt=system_prompt,
        includeReasoning=request.include_reasoning,
        sessionId=request.session_id,
        modelProvider=request.model_provider,
    )
    ppt_chat_store = presentation_chat_store()
    selected_model = "qwen" if request.model_provider.lower() == "qwen" else "mimo"
    llm_provider = selected_model
    if request.session_id is not None and not await asyncio.to_thread(
        ppt_chat_store.owned, request.session_id, task_id, principal.user_id, selected_model,
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Presentation chat session not found",
        )

    async def events():
        """Fast slideshow path: one direct LLM call, without planner/retrieval/tools."""
        reply_parts: list[str] = []
        reasoning_parts: list[str] = []
        refused = False
        try:
            # Establish the SSE stream before database work and model startup.
            yield f"data: {json.dumps({'type': 'phase', 'phase': 'generate', 'message': '正在结合当前幻灯片回答…'}, ensure_ascii=False)}\n\n"
            last = request.messages[-1]
            if last.role != "user":
                raise ValueError("The last presentation message must come from the user")
            history: list[dict] = []
            if request.session_id is not None:
                history = await asyncio.to_thread(ppt_chat_store.messages, request.session_id)
            window = slide_window_messages(history)
            if request.session_id is not None:
                await asyncio.to_thread(
                    ppt_chat_store.append,
                    request.session_id,
                    "user",
                    last.content,
                    "text",
                )
            messages: list[dict[str, str]] = [{"role": "system", "content": chat_request.system_prompt or ""}]
            messages.extend(
                {"role": str(item["role"]), "content": str(item.get("content") or "")}
                for item in window
            )
            messages.append({"role": "user", "content": last.content})

            emitted_text = ""
            guard = _ReplyLeakGuard()
            for attempt in range(2):
                reply_parts = []
                guard = _ReplyLeakGuard()
                pending_controls: list[dict] = []
                stripper = ControlMarkerStripper(pending_controls.append)
                async for event in llm_client().stream_chat(
                    messages,
                    include_reasoning=chat_request.include_reasoning,
                    provider=llm_provider,
                    thinking=False if llm_provider == "mimo-legacy" else None,
                ):
                    if event["type"] == "reasoning":
                        reasoning_parts.append(event["text"])
                        payload = {"type": "chat_reasoning_delta", "content": event["text"]}
                    elif event["type"] == "content":
                        reply_parts.append(event["text"])
                        hit = detect_refusal("".join(reasoning_parts), "".join(reply_parts))
                        if hit is not None:
                            refused = True
                            banner = refusal_banner_message("".join(reasoning_parts))
                            reply_parts = [banner]
                            payload = {"type": "refused", "signal": hit["signal"], "banner": banner}
                            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                            break
                        stripped = stripper.feed(event["text"])
                        while pending_controls:
                            control = pending_controls.pop(0)
                            yield f"data: {json.dumps({'type': 'control', **control}, ensure_ascii=False)}\n\n"
                        if not stripped:
                            continue
                        safe = guard.feed(stripped)
                        if guard.leaked:
                            break
                        if not safe:
                            continue
                        emitted_text += safe
                        payload = {"type": "chat_delta", "content": safe}
                    else:
                        continue
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                # Retry only when nothing has been shown or spoken yet.
                if refused or not guard.leaked or emitted_text:
                    break

            if guard.leaked and not refused:
                cleaned = _strip_prompt_echo("".join(reply_parts))
                reply_parts = [cleaned] if cleaned else []
                if cleaned and not emitted_text:
                    yield f"data: {json.dumps({'type': 'chat_delta', 'content': cleaned}, ensure_ascii=False)}\n\n"
                elif (
                    cleaned
                    and cleaned.startswith(emitted_text)
                    and len(cleaned) > len(emitted_text)
                ):
                    yield f"data: {json.dumps({'type': 'chat_delta', 'content': cleaned[len(emitted_text):]}, ensure_ascii=False)}\n\n"
            elif not refused:
                tail = guard.flush()
                if tail:
                    yield f"data: {json.dumps({'type': 'chat_delta', 'content': tail}, ensure_ascii=False)}\n\n"

            if refused:
                yield f"data: {json.dumps({'type': 'chat_failed', 'code': 'CHAT_REFUSED_BY_MODEL'}, ensure_ascii=False)}\n\n"
            else:
                yield f"data: {json.dumps({'type': 'chat_completed'}, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            raise
        except Exception:
            yield f"data: {json.dumps({'type': 'chat_failed', 'code': 'CHAT_EXECUTION_FAILED'}, ensure_ascii=False)}\n\n"
        finally:
            if request.session_id is not None and reply_parts:
                try:
                    await asyncio.to_thread(
                        ppt_chat_store.append,
                        request.session_id,
                        "assistant",
                        parse_actions("".join(reply_parts))[1] or "".join(reply_parts),
                        "text",
                    )
                except BaseException:
                    pass

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/presentations/{task_id}/progress")
async def update_presentation_progress(
    task_id: UUID,
    request: PresentationProgressRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """更新 PPT 学习进度：翻页进度 / 完成标记 / 掌握程度（供交互课件进度与 3D 图状态使用）。"""
    task = await asyncio.to_thread(
        presentation_store().update_learning, task_id, principal.user_id,
        page_index=request.page_index, page_count=request.page_count,
        learned=request.learned, mastery=request.mastery,
    )
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found or not completed")
    return task


@router.post("/presentations/{task_id}/chat/tts")
async def stream_presentation_chat_tts(
    task_id: UUID,
    request: PresentationTtsRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """Stream MiMo PCM16 audio for a slideshow assistant answer."""
    task = await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    if task["status"] != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Presentation is not completed yet")
    # Reuse the same warm MiMo/OpenAI client as the global assistant. Creating
    # and closing a client for every short clause adds a TLS round trip before
    # each audible segment.
    tts = assistant_tts_service()
    if not tts.available:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="TTS service is unavailable")

    async def pcm_stream():
        if request.model_provider.lower() == "qwen":
            import audioop
            import io as _io
            import wave as _wave
            from app.services.qwen_tts import QWEN_TTS_VOICES, get_qwen_tts_service
            qwen_tts = get_qwen_tts_service(get_settings())
            if not qwen_tts.available:
                raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                                    detail="Qwen TTS service is unavailable")
            voice = request.voice if request.voice in QWEN_TTS_VOICES else "longanxiaoxin"
            wav = await qwen_tts.synthesize(request.text.strip(), voice)
            with _wave.open(_io.BytesIO(wav), "rb") as wf:
                channels, width, rate = wf.getnchannels(), wf.getsampwidth(), wf.getframerate()
                pcm = wf.readframes(wf.getnframes())
            if width != 2:
                pcm = audioop.lin2lin(pcm, width, 2)
            if channels > 1:
                pcm = audioop.tomono(pcm, 2, 0.5, 0.5)
            if rate != 24000:
                pcm, _ = audioop.ratecv(pcm, 2, 1, rate, 24000, None)
            for offset in range(0, len(pcm), 4096):
                yield pcm[offset:offset + 4096]
            return
        from app.services.tts import MIMO_PRESET_VOICES, TTS_SPEEDS
        voice = request.voice if request.voice in MIMO_PRESET_VOICES else await _assistant_voice(principal.user_id)
        speed = request.speed if request.speed in TTS_SPEEDS else await _assistant_speed(principal.user_id)
        async for chunk in tts.stream_pcm(request.text.strip(), voice, speed):
            yield chunk

    return StreamingResponse(
        pcm_stream(),
        media_type="audio/L16;rate=24000;channels=1",
        headers={
            "Cache-Control": "no-store",
            "X-Audio-Sample-Rate": "24000",
            "X-Audio-Encoding": "pcm16le",
        },
    )


@router.post("/assistant/tts")
async def stream_assistant_tts(
    request: PresentationTtsRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """Stream a short global-assistant response using the selected MiMo voice."""
    tts = assistant_tts_service()
    if not tts.available:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="TTS service is unavailable")
    text = request.text.strip()
    from app.services.tts import MIMO_PRESET_VOICES, TTS_SPEEDS
    voice = request.voice if request.voice in MIMO_PRESET_VOICES else await _assistant_voice(principal.user_id)
    speed = request.speed if request.speed in TTS_SPEEDS else await _assistant_speed(principal.user_id)
    cache_key = (text, voice, speed)

    async def pcm_stream():
        cached = _assistant_tts_cache.get(cache_key)
        if cached is not None:
            _assistant_tts_cache.move_to_end(cache_key)
            for offset in range(0, len(cached), 32 * 1024):
                yield cached[offset:offset + 32 * 1024]
            return
        collected = bytearray()
        async for chunk in tts.stream_pcm(text, voice, speed):
            collected.extend(chunk)
            yield chunk
        if collected and len(text) <= 300:
            _assistant_tts_cache[cache_key] = bytes(collected)
            _assistant_tts_cache.move_to_end(cache_key)
            while len(_assistant_tts_cache) > _ASSISTANT_TTS_CACHE_LIMIT:
                _assistant_tts_cache.popitem(last=False)

    return StreamingResponse(
        pcm_stream(),
        media_type="audio/L16;rate=24000;channels=1",
        headers={
            "Cache-Control": "no-store",
            "X-Audio-Sample-Rate": "24000",
            "X-Audio-Encoding": "pcm16le",
        },
    )


@router.post("/presentations/{task_id}/chat/audio-stream")
async def stream_presentation_chat_audio(
    task_id: UUID,
    audio: UploadFile = File(...),
    slide_index: int = Form(...),
    session_id: str = Form(default=""),
    audio_model: str = Form(default="mimo"),
    qwen_voice: str = Form(default="longanxiaoxin"),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """Understand slideshow speech and stream a grounded reply in one MiMo call."""
    task = await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    if task["status"] != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Presentation is not completed yet")
    try:
        presentation_context = _presentation_chat_context(task, slide_index)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    profile = await _assistant_profile(principal.user_id)
    presentation_context += _assistant_profile_context(profile)
    selected_audio_model = "qwen" if audio_model.strip().lower() == "qwen" else "mimo"
    ppt_session_id: UUID | None = None
    ppt_chat_store = presentation_chat_store()
    if session_id.strip():
        try:
            ppt_session_id = UUID(session_id)
        except ValueError:
            ppt_session_id = None
        if ppt_session_id is not None and not await asyncio.to_thread(
            ppt_chat_store.owned, ppt_session_id, task_id, principal.user_id, selected_audio_model,
        ):
            ppt_session_id = None
    if ppt_session_id is None:
        created_session = await asyncio.to_thread(
            ppt_chat_store.create, task_id, principal.user_id, selected_audio_model,
        )
        ppt_session_id = UUID(created_session["id"])
    history = await asyncio.to_thread(ppt_chat_store.messages, ppt_session_id)
    if history:
        # 对话历史走滑动窗口（系统提示词与完整演讲稿常驻，不参与滑动）。
        presentation_context += "\n最近对话：\n" + "\n".join(
            f"{'用户' if item['role'] == 'user' else '助手'}：{item['content']}"
            for item in slide_window_messages(history)
        )
    content = await audio.read(10 * 1024 * 1024 + 1)
    if not content:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Audio is empty")
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail="Audio exceeds the 10 MB limit")
    mime_type = audio.content_type or "audio/wav"
    _reject_silent_wav(content, mime_type)
    if selected_audio_model == "qwen":
        from app.services.qwen_realtime_audio import get_qwen_realtime_audio_service
        qwen_service = get_qwen_realtime_audio_service(get_settings())
        service = assistant_audio_service()
        if not qwen_service.available:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                                detail="Qwen Audio Realtime is unavailable")
    else:
        selected_audio_model = "mimo"
        service = assistant_audio_service()
    if not service.available:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="MiMo audio understanding is unavailable")

    async def events():
        from app.services.asr import get_asr_service
        asr = get_asr_service(get_settings())
        transcript = ""
        reply = ""
        transcript_emitted = False
        control: tuple[str, int | None, bool] | None = None
        if selected_audio_model == "qwen":
            transcript = ""
            reply = ""
            clean_reply = ""
            llm_control: tuple[str, int | None, bool] | None = None
            pending_controls: list[dict] = []
            stripper = ControlMarkerStripper(pending_controls.append)
            try:
                yield f"data: {json.dumps({'type': 'phase', 'phase': 'answering', 'message': 'Qwen 正在实时回答…', 'model': 'qwen'}, ensure_ascii=False)}\n\n"
                qwen_context = _presentation_chat_context_compact(task, slide_index)
                qwen_context += _assistant_profile_context(profile)
                if history:
                    qwen_context += "\n最近对话：\n" + "\n".join(
                        f"{'用户' if item['role'] == 'user' else '助手'}：{item['content']}"
                        for item in slide_window_messages(history, max_items=8, max_chars=2000)
                    )
                instructions = (
                    qwen_context
                    + "\n直接回答用户语音中的问题，简短自然，不要复述问题或输出Markdown。"
                    + "你的回答文本和语音中禁止出现任何方括号符号或[[]]标记；"
                    + "需要切换页面或控制播放时，用自然语言提示（如“我可以跳转到第5页为你详细讲解”），由用户语音指令执行。"
                    + "你是ITN伴学助手。"
                )
                qwen_voice_map = {
                    "longanlingxi": "longanlingxi",
                    "longanxiaoxin": "longanxiaoxin",
                }
                requested_voice = qwen_voice_map.get(qwen_voice, "longanxiaoxin")
                async for event in qwen_service.stream(content, instructions, requested_voice):
                    if event["type"] == "text" and event.get("delta"):
                        stripped = stripper.feed(str(event["delta"]))
                        clean_reply += stripped
                        while pending_controls:
                            control_item = pending_controls.pop(0)
                            llm_control = (control_item.get("action"), control_item.get("page"), False)
                            yield f"data: {json.dumps({'type': 'control', **control_item}, ensure_ascii=False)}\n\n"
                        if stripped:
                            reply += stripped
                            yield f"data: {json.dumps({'type': 'reply_delta', 'content': stripped}, ensure_ascii=False)}\n\n"
                    elif event["type"] == "audio" and event.get("delta"):
                        yield f"data: {json.dumps({'type': 'audio_delta', 'audio': event['delta'], 'sampleRate': 24000}, ensure_ascii=False)}\n\n"
                    elif event["type"] == "transcript" and event.get("text") and not transcript_emitted:
                        transcript = str(event["text"]).strip()[:1000]
                        if _valid_presentation_transcript(transcript, presentation_context):
                            yield f"data: {json.dumps({'type': 'transcript', 'transcript': transcript}, ensure_ascii=False)}\n\n"
                            transcript_emitted = True
                            control = _presentation_voice_control(
                                transcript,
                                len((task.get("outline") or {}).get("slides") or []),
                            )
                            if control is not None:
                                action, page, resume = control
                                yield f"data: {json.dumps({'type': 'control', 'action': action, 'page': page, 'resume': resume}, ensure_ascii=False)}\n\n"
                                break
                if not transcript:
                    transcript = "语音提问"
                tail_text = stripper.flush()
                if tail_text:
                    clean_reply += tail_text
                    reply += tail_text
                final_reply = parse_actions(clean_reply)[1] or clean_reply
                if ppt_session_id is not None:
                    await asyncio.to_thread(ppt_chat_store.append, ppt_session_id, "user", transcript, "voice")
                    if final_reply:
                        await asyncio.to_thread(ppt_chat_store.append, ppt_session_id, "assistant", final_reply, "text")
                action, page, resume = llm_control or control or ("none", None, False)
                yield f"data: {json.dumps({'type': 'result', 'transcript': transcript, 'content': final_reply, 'action': action, 'page': page, 'resume': resume, 'sessionId': str(ppt_session_id)}, ensure_ascii=False)}\n\n"
            except Exception as exc:
                yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"
            return
        transcript_task = asyncio.create_task(asr.transcribe(content, mime_type, "zh"))
        queue: asyncio.Queue[tuple[str, str | Exception | None]] = asyncio.Queue()

        async def collect_reply() -> None:
            try:
                async for delta in service.stream_presentation_reply(
                    content, mime_type, presentation_context,
                ):
                    await queue.put(("reply", delta))
                await queue.put(("reply_done", None))
            except Exception as exc:
                await queue.put(("error", exc))

        async def collect_transcript() -> None:
            try:
                await queue.put(("transcript", await transcript_task))
            except Exception as exc:
                await queue.put(("error", exc))

        reply_task = asyncio.create_task(collect_reply())
        transcript_collector = asyncio.create_task(collect_transcript())
        try:
            yield f"data: {json.dumps({'type': 'phase', 'phase': 'answering', 'message': '正在理解并回答…', 'model': selected_audio_model}, ensure_ascii=False)}\n\n"
            reply_done = False
            clean_reply = ""
            llm_control: tuple[str, int | None, bool] | None = None
            rule_control: tuple[str, int | None, bool] | None = None
            pending_controls: list[dict] = []
            stripper = ControlMarkerStripper(pending_controls.append)
            while not reply_done or not transcript_emitted:
                event_type, value = await queue.get()
                if event_type == "error":
                    raise value if isinstance(value, Exception) else RuntimeError("语音处理失败")
                if event_type == "transcript":
                    transcript = str(value or "").strip()[:1000]
                    if _valid_presentation_transcript(transcript, presentation_context):
                        yield f"data: {json.dumps({'type': 'transcript', 'transcript': transcript}, ensure_ascii=False)}\n\n"
                        transcript_emitted = True
                        if llm_control is None:
                            rule_control = _presentation_voice_control(
                                transcript,
                                len((task.get("outline") or {}).get("slides") or []),
                            )
                            if rule_control is not None:
                                action, page, resume = rule_control
                                if not reply_task.done():
                                    reply_task.cancel()
                                yield f"data: {json.dumps({'type': 'control', 'action': action, 'page': page, 'resume': resume}, ensure_ascii=False)}\n\n"
                                reply_done = True
                                break
                        if clean_reply:
                            yield f"data: {json.dumps({'type': 'reply_delta', 'content': clean_reply}, ensure_ascii=False)}\n\n"
                    else:
                        raise ValueError("没有识别到有效语音")
                elif event_type == "reply":
                    delta = str(value or "")
                    reply += delta
                    stripped = stripper.feed(delta)
                    clean_reply += stripped
                    while pending_controls:
                        control_item = pending_controls.pop(0)
                        llm_control = (control_item.get("action"), control_item.get("page"), False)
                        yield f"data: {json.dumps({'type': 'control', **control_item}, ensure_ascii=False)}\n\n"
                    if stripped and transcript_emitted:
                        yield f"data: {json.dumps({'type': 'reply_delta', 'content': stripped}, ensure_ascii=False)}\n\n"
                elif event_type == "reply_done":
                    reply_done = True
            if not _valid_presentation_transcript(transcript, presentation_context):
                raise ValueError("没有识别到有效语音")
            final_reply = "" if rule_control is not None else _strip_prompt_echo(clean_reply.strip())[:1000]
            if ppt_session_id is not None:
                await asyncio.to_thread(
                    ppt_chat_store.append, ppt_session_id, "user", transcript, "voice",
                )
                if final_reply:
                    await asyncio.to_thread(
                        ppt_chat_store.append, ppt_session_id, "assistant", final_reply, "text",
                    )
            action, page, resume = rule_control or llm_control or ("none", None, False)
            yield f"data: {json.dumps({'type': 'result', 'transcript': transcript, 'content': final_reply, 'action': action, 'page': page, 'resume': resume, 'sessionId': str(ppt_session_id)}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            for pending in (transcript_task, reply_task, transcript_collector):
                if not pending.done():
                    pending.cancel()
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.post("/presentations/{task_id}/chat/image-stream")
async def stream_presentation_chat_image(
    task_id: UUID,
    image: UploadFile = File(...),
    slide_index: int = Form(...),
    question: str = Form(default=""),
    session_id: str = Form(default=""),
    model_provider: str = Form(default="mimo"),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """Understand a photo alongside the current slide and stream a grounded reply (mimo-v2.6-pro)."""
    task = await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    if task["status"] != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Presentation is not completed yet")
    try:
        presentation_context = _presentation_chat_context(task, slide_index)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    presentation_context += _assistant_profile_context(await _assistant_profile(principal.user_id))
    ppt_chat_store = presentation_chat_store()
    ppt_session_id: UUID | None = None
    if session_id.strip():
        try:
            ppt_session_id = UUID(session_id)
        except ValueError:
            ppt_session_id = None
        if ppt_session_id is not None and not await asyncio.to_thread(
            ppt_chat_store.owned, ppt_session_id, task_id, principal.user_id, "mimo",
        ):
            ppt_session_id = None
    if ppt_session_id is None:
        created_session = await asyncio.to_thread(
            ppt_chat_store.create, task_id, principal.user_id, "mimo",
        )
        ppt_session_id = UUID(created_session["id"])
    history = await asyncio.to_thread(ppt_chat_store.messages, ppt_session_id)
    if history:
        presentation_context += "\n最近对话：\n" + "\n".join(
            f"{'用户' if item['role'] == 'user' else '助手'}：{item['content']}"
            for item in slide_window_messages(history)
        )
    content = await image.read(5 * 1024 * 1024 + 1)
    if not content:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Image is empty")
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail="Image exceeds the 5 MB limit")
    mime_type = image.content_type or "image/png"
    early_model = "qwen" if model_provider.strip().lower() == "qwen" else "mimo"
    service = assistant_audio_service() if early_model == "mimo" else None
    if early_model == "mimo" and (service is None or not service.available):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="MiMo image understanding is unavailable")

    async def events():
        """两阶段：图片先单独转成结构化描述，再以文本注入主问答（复用文字链路全部能力）。"""
        selected_model = early_model
        chat_provider = selected_model
        reply = ""
        llm_control: tuple[str, int | None, bool] | None = None
        pending_controls: list[dict] = []
        stripper = ControlMarkerStripper(pending_controls.append)
        try:
            # 阶段一：图片模态单独走一次 mimo-v2.6-pro 多模态，输出图片描述
            yield f"data: {json.dumps({'type': 'phase', 'phase': 'understanding', 'message': 'Agent 正在分析图片…', 'model': selected_model}, ensure_ascii=False)}\n\n"
            current_slide = None
            for slide_item in (task.get("outline") or {}).get("slides") or []:
                if isinstance(slide_item, dict) and len((task.get("outline") or {}).get("slides") or []) > slide_index:
                    current_slide = ((task.get("outline") or {}).get("slides") or [])[slide_index]
                    break
            current_slide_title = str(current_slide.get("title") or "") if isinstance(current_slide, dict) else ""
            topic_hint = f"{str(task.get('title') or '')}；当前页：{current_slide_title}".strip()
            if selected_model == "qwen":
                import base64 as _b64
                image_data_url = f"data:{mime_type};base64,{_b64.b64encode(content).decode('ascii')}"
                description = await llm_client().complete_vision_text(
                    "你是ITN演示助手的图像识别模块，负责把图片准确转写为文字描述。",
                    (
                        "请判断这张图片是否与下面的课件内容相关，再决定描述的详细程度。"
                        f"\n课件内容：{topic_hint or '（未提供，视为通用课堂场景）'}\n"
                        "如果图片与课件相关（课件截图、板书、题目、公式、设备界面、报错等）："
                        "细致描述，必须包含①主题/场景②主体与关键对象③整体结构与布局④图中所有文本（逐条摘录）⑤关键细节。"
                        "如果图片与课件无关（日常照片、表情包、无关截图等）：用一两句话简短说明图片内容即可，不要展开。"
                        "总字数控制在160个汉字以内，只输出描述正文，不要评价、不要推测、不要输出Markdown标题或列表符号。"
                    ),
                    image_data_url,
                    provider="qwen",
                )
            else:
                description = await service.describe_image(content, mime_type, topic_hint)
            if not description:
                raise ValueError("图片内容识别失败，请换一张更清晰的图片重试")
            # 阶段二：把描述作为文本注入主会话，走与文字提问一致的动作协议/滑动窗口/净正文
            yield f"data: {json.dumps({'type': 'phase', 'phase': 'answering', 'message': '已理解图片，正在生成回复…', 'model': selected_model}, ensure_ascii=False)}\n\n"
            user_text = (
                f"[图片] {question.strip()}" if question.strip() else "[图片]"
            )
            user_message = (
                f"用户上传了一张图片（历史中仅保留[图片]占位）。图片内容描述：{description}\n"
                f"用户问题：{question.strip() or '请结合这张图片和当前页内容说明。'}"
            )
            messages: list[dict[str, str]] = [
                {"role": "system", "content": presentation_context},
                {"role": "user", "content": user_message},
            ]
            async for event in llm_client().stream_chat(
                messages,
                include_reasoning=False,
                provider=chat_provider,
                thinking=False,
            ):
                if event["type"] != "content":
                    continue
                stripped = stripper.feed(event["text"])
                while pending_controls:
                    control_item = pending_controls.pop(0)
                    llm_control = (control_item.get("action"), control_item.get("page"), False)
                    yield f"data: {json.dumps({'type': 'control', **control_item}, ensure_ascii=False)}\n\n"
                if stripped:
                    reply += stripped
                    yield f"data: {json.dumps({'type': 'reply_delta', 'content': stripped}, ensure_ascii=False)}\n\n"
            tail = stripper.flush()
            if tail:
                reply += tail
                yield f"data: {json.dumps({'type': 'reply_delta', 'content': tail}, ensure_ascii=False)}\n\n"
            if ppt_session_id is not None:
                attachment_id: UUID | None = None
                try:
                    saved = await asyncio.to_thread(
                        attachment_store().save, principal.user_id,
                        "presentation-question.png", mime_type, content,
                    )
                    attachment_id = UUID(saved["id"])
                except Exception:
                    attachment_id = None
                await asyncio.to_thread(
                    ppt_chat_store.append, ppt_session_id, "user", user_text, "image", attachment_id,
                )
                if reply:
                    await asyncio.to_thread(
                        ppt_chat_store.append, ppt_session_id, "assistant", reply.strip(), "text",
                    )
            action, page, resume = llm_control or ("none", None, False)
            yield f"data: {json.dumps({'type': 'result', 'transcript': user_text, 'content': reply.strip(), 'action': action, 'page': page, 'resume': resume, 'sessionId': str(ppt_session_id)}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.post("/assistant/asr")
async def transcribe_assistant_audio(
    audio: UploadFile = File(...),
    language: str = Form(default="zh"),
    _: InternalPrincipal = Depends(require_user_principal),
):
    """Transcribe cross-browser microphone audio with MiMo-V2.5-ASR (最新可用 ASR 仍为 v2.5)。"""
    from app.services.asr import get_asr_service
    service = get_asr_service(get_settings())
    if not service.available:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="ASR service is unavailable")
    content = await audio.read(10 * 1024 * 1024 + 1)
    if not content:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Audio is empty")
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail="Audio exceeds the 10 MB limit")
    _reject_silent_wav(content, audio.content_type or "audio/wav")
    try:
        transcript = await service.transcribe(content, audio.content_type or "audio/wav", language)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail=str(exc)) from exc
    return {"transcript": transcript}


@router.post("/assistant/audio-plan")
async def plan_assistant_audio(
    audio: UploadFile = File(...),
    context: str = Form(default="{}"),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """Understand speech and produce a reply/action in one MiMo-V2.5 request."""
    service = assistant_audio_service()
    if not service.available:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="MiMo audio understanding is unavailable")
    content = await audio.read(10 * 1024 * 1024 + 1)
    if not content:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Audio is empty")
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail="Audio exceeds the 10 MB limit")
    _reject_silent_wav(content, audio.content_type or "audio/wav")
    try:
        parsed_context = json.loads(context)
    except json.JSONDecodeError:
        parsed_context = {}
    if isinstance(parsed_context, dict):
        parsed_context["learnerProfile"] = await _assistant_profile(principal.user_id)
    action_guide = {
        "navigation.open": {"page": ["dashboard", "profile", "resources", "tutor", "knowledge"]},
        "resource.switch_tab": {"tab": ["ppt", "lecture", "practice", "quiz"]},
        "notes.open": {},
        "notes.create": {"title": "笔记标题", "content": "笔记正文"},
        "presentation.tasks.open": {},
        "presentation.create": {
            "requirement": "完整生成需求，至少10字", "title": "标题",
            "audience": ["students", "teachers", "professionals", "general"],
            "purpose": ["courseware", "report", "sharing", "defense", "training"],
            "backgroundStyle": "主题风格，默认none", "style": "视觉风格，默认academic",
            "slideCount": [0, 12, 20, 30, 40, 55, 70],
            "detailLevel": ["concise", "balanced", "detailed"],
            "includeSpeakerNotes": True,
        },
        "knowledge.search": {"query": "搜索关键词"},
        "console.toggle": {},
        "assistant.voice.set": {"voice": ["冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]},
        "assistant.speed.set": {"speed": ["very_slow", "slow", "normal", "fast", "very_fast"]},
        "assistant.speed.adjust": {"direction": ["slower", "faster"]},
        "assistant.help": {},
        "none": {},
    }
    try:
        result = await service.understand(
            content,
            audio.content_type or "audio/wav",
            parsed_context if isinstance(parsed_context, dict) else {},
            action_guide,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail=str(exc)) from exc
    transcript = str(result.get("transcript") or "语音指令").strip()[:1000]
    # Canonicalize common replies/actions after the single multimodal request.
    # This keeps execution deterministic and lets repeated greetings hit TTS cache.
    plan = _local_assistant_plan(transcript) or _sanitize_assistant_plan(result)
    plan["transcript"] = transcript
    return plan


@router.post("/assistant/audio-stream")
async def stream_assistant_audio(
    audio: UploadFile = File(...),
    context: str = Form(default="{}"),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """Stream reply text early, then emit the validated final action plan."""
    service = assistant_audio_service()
    if not service.available:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="MiMo audio understanding is unavailable")
    content = await audio.read(10 * 1024 * 1024 + 1)
    if not content:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Audio is empty")
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail="Audio exceeds the 10 MB limit")
    _reject_silent_wav(content, audio.content_type or "audio/wav")
    try:
        parsed_context = json.loads(context)
    except json.JSONDecodeError:
        parsed_context = {}
    if isinstance(parsed_context, dict):
        parsed_context["learnerProfile"] = await _assistant_profile(principal.user_id)
    action_guide = {
        "navigation.open": {"page": ["dashboard", "profile", "resources", "tutor", "knowledge"]},
        "resource.switch_tab": {"tab": ["ppt", "lecture", "practice", "quiz"]},
        "notes.open": {},
        "notes.create": {"title": "笔记标题", "content": "笔记正文"},
        "presentation.tasks.open": {},
        "presentation.create": {
            "requirement": "完整生成需求，至少10字", "title": "标题",
            "audience": ["students", "teachers", "professionals", "general"],
            "purpose": ["courseware", "report", "sharing", "defense", "training"],
            "backgroundStyle": "主题风格，默认none", "style": "视觉风格，默认academic",
            "slideCount": [0, 12, 20, 30, 40, 55, 70],
            "detailLevel": ["concise", "balanced", "detailed"],
            "includeSpeakerNotes": True,
        },
        "knowledge.search": {"query": "搜索关键词"},
        "console.toggle": {},
        "assistant.voice.set": {"voice": ["冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]},
        "assistant.speed.set": {"speed": ["very_slow", "slow", "normal", "fast", "very_fast"]},
        "assistant.speed.adjust": {"direction": ["slower", "faster"]},
        "assistant.help": {},
        "none": {},
    }

    async def events():
        raw = ""
        fed_reply = ""
        emitted = ""
        guard = _ReplyLeakGuard()
        try:
            for attempt in range(2):
                raw = ""
                fed_reply = ""
                guard = _ReplyLeakGuard()
                async for delta in service.stream_understand(
                    content,
                    audio.content_type or "audio/wav",
                    parsed_context if isinstance(parsed_context, dict) else {},
                    action_guide,
                ):
                    raw += delta
                    if guard.leaked:
                        if not emitted:
                            break
                        continue
                    reply, _ = _json_string_progress(raw, "reply")
                    if len(reply) > len(fed_reply):
                        addition = reply[len(fed_reply):]
                        fed_reply = reply
                        safe = guard.feed(addition)
                        if safe:
                            emitted += safe
                            yield f"data: {json.dumps({'type': 'reply_delta', 'content': safe}, ensure_ascii=False)}\n\n"
                if not guard.leaked or emitted:
                    break
            start, end = raw.find("{"), raw.rfind("}")
            result = json.loads(raw[start:end + 1] if start >= 0 and end > start else raw)
            transcript = str(result.get("transcript") or "语音指令").strip()[:1000]
            local_plan = _local_assistant_plan(transcript)
            plan = local_plan or _sanitize_assistant_plan(result)
            if (
                local_plan
                and local_plan.get("action") not in {"assistant.speed.set", "assistant.speed.adjust"}
                and str(result.get("reply") or "").strip()
            ):
                plan["reply"] = _guard_assistant_reply(result.get("reply"), str(local_plan.get("reply") or ""))
            plan["transcript"] = transcript
            final_reply = str(plan.get("reply") or "")
            if guard.leaked:
                if not emitted:
                    yield f"data: {json.dumps({'type': 'reply_delta', 'content': final_reply}, ensure_ascii=False)}\n\n"
                elif final_reply.startswith(emitted) and len(final_reply) > len(emitted):
                    yield f"data: {json.dumps({'type': 'reply_delta', 'content': final_reply[len(emitted):]}, ensure_ascii=False)}\n\n"
            else:
                tail = guard.flush()
                if final_reply.startswith(fed_reply) and len(final_reply) > len(fed_reply):
                    tail += final_reply[len(fed_reply):]
                if tail:
                    yield f"data: {json.dumps({'type': 'reply_delta', 'content': tail}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'plan', 'plan': plan}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.get("/notes")
async def list_notes(principal: InternalPrincipal = Depends(require_user_principal)):
    store = note_store()
    if not store.available():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Note storage is unavailable")
    return {"notes": await asyncio.to_thread(store.list, principal.user_id)}


@router.get("/note-categories")
async def list_note_categories(principal: InternalPrincipal = Depends(require_user_principal)):
    return {"categories": await asyncio.to_thread(note_store().list_categories, principal.user_id)}


@router.post("/note-categories", status_code=status.HTTP_201_CREATED)
async def create_note_category(request: NoteCategoryCreateRequest,
                               principal: InternalPrincipal = Depends(require_user_principal)):
    try:
        return await asyncio.to_thread(
            note_store().create_category, principal.user_id, request.name.strip(), request.color,
        )
    except Exception as exc:
        if "Duplicate" in str(exc):
            raise HTTPException(status_code=409, detail="Category name already exists") from exc
        raise


@router.patch("/note-categories/{category_id}")
async def update_note_category(category_id: UUID, request: NoteCategoryUpdateRequest,
                               principal: InternalPrincipal = Depends(require_user_principal)):
    result = await asyncio.to_thread(
        note_store().update_category, category_id, principal.user_id,
        request.model_dump(exclude_unset=True),
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Note category not found")
    return result


@router.delete("/note-categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note_category(category_id: UUID,
                               principal: InternalPrincipal = Depends(require_user_principal)):
    if not await asyncio.to_thread(note_store().delete_category, category_id, principal.user_id):
        raise HTTPException(status_code=404, detail="Note category not found")


@router.post("/assistant/plan")
async def plan_assistant_action(
    request: AssistantPlanRequest,
    _: InternalPrincipal = Depends(require_user_principal),
):
    local = _local_assistant_plan(request.command)
    if local is not None:
        return local
    action_guide = {
        "navigation.open": {"page": ["dashboard", "profile", "resources", "tutor", "knowledge"]},
        "resource.switch_tab": {"tab": ["ppt", "lecture", "practice", "quiz"]},
        "notes.open": {},
        "notes.create": {"title": "笔记标题", "content": "笔记正文"},
        "presentation.tasks.open": {},
        "presentation.create": {
            "requirement": "完整生成需求，至少10字", "title": "标题",
            "audience": ["students", "teachers", "professionals", "general"],
            "purpose": ["courseware", "report", "sharing", "defense", "training"],
            "backgroundStyle": "主题风格，默认none", "style": "视觉风格，默认academic",
            "slideCount": [0, 12, 20, 30, 40, 55, 70],
            "detailLevel": ["concise", "balanced", "detailed"],
            "includeSpeakerNotes": True,
        },
        "knowledge.search": {"query": "搜索关键词"},
        "console.toggle": {},
        "assistant.voice.set": {"voice": ["冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]},
        "assistant.speed.set": {"speed": ["very_slow", "slow", "normal", "fast", "very_fast"]},
        "assistant.speed.adjust": {"direction": ["slower", "faster"]},
        "assistant.help": {},
        "none": {},
    }
    result = await llm_client().complete_json(
        system=(
            "你是亲切、简洁的小鼋助手，同时负责网页操作意图路由。"
            "先判断用户是在闲聊、问普通问题，还是明确要求操作网页。"
            "只有明确操作请求才选择对应白名单动作；闲聊和普通问答使用none，"
            "并在reply中直接自然回答，绝对不要说功能不支持。"
            "对于确实要求执行但白名单没有覆盖的操作，才简短说明当前能做到的替代方案。"
            "不能编造动作，不能输出代码，只输出合法JSON。"
        ),
        prompt=(
            f"用户命令：{request.command}\n"
            f"当前页面上下文：{json.dumps(request.context, ensure_ascii=False)[:1500]}\n"
            f"允许动作：{json.dumps(action_guide, ensure_ascii=False)}\n"
            "返回JSON：{\"action\":\"动作名\",\"arguments\":{},"
            "\"reply\":\"执行后的简短中文反馈\",\"requiresConfirmation\":false}。"
            "闲聊或普通问题使用none并直接回答；无法执行的操作也使用none。"
        ),
        fallback={
            "action": "none",
            "arguments": {},
            "reply": "我在呢。你可以继续和我聊，也可以告诉我想打开哪个页面。",
            "requiresConfirmation": False,
        },
        provider="mimo",
        reasoning_effort="low",
        max_retries=2,
        max_tokens=500,
    )
    return _sanitize_assistant_plan(result)


@router.post("/assistant/plan-stream")
async def stream_assistant_action(
    request: AssistantPlanRequest,
    _: InternalPrincipal = Depends(require_user_principal),
):
    """Stream assistant reply text while the final action plan is still being generated."""
    local = _local_assistant_plan(request.command)

    async def events():
        if local is not None:
            reply = str(local.get("reply") or "")
            if reply:
                yield f"data: {json.dumps({'type': 'reply_delta', 'content': reply}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'plan', 'plan': local}, ensure_ascii=False)}\n\n"
            return
        operation_words = (
            "打开", "切换", "跳转", "进入", "创建", "生成", "记录", "记笔记",
            "修改", "设置", "调快", "调慢", "搜索", "查找", "播放", "暂停",
        )
        question_words = (
            "什么", "为什么", "怎么", "如何", "是否", "能不能", "介绍",
            "说明", "解释", "告诉我", "怎么样", "哪一个", "哪些",
        )
        direct_answer = (
            not any(word in request.command for word in operation_words)
            and (
                any(word in request.command for word in question_words)
                or request.command.rstrip().endswith(("?", "？"))
            )
        )
        if direct_answer:
            reply = ""
            emitted = ""
            try:
                messages = [
                    {
                        "role": "system",
                        "content": (
                            "你是亲切、简洁的伴学助手。直接回答用户问题，"
                            "自然口语化，通常一到三句，不要输出Markdown标记。"
                        ),
                    },
                    {"role": "user", "content": request.command},
                ]
                guard = _ReplyLeakGuard()
                for attempt in range(2):
                    reply = ""
                    guard = _ReplyLeakGuard()
                    async for event in llm_client().stream_chat(
                        messages, provider="mimo", max_tokens_override=300, thinking=False,
                    ):
                        if event.get("type") != "content":
                            continue
                        addition = str(event.get("text") or "")
                        if not addition:
                            continue
                        reply += addition
                        safe = guard.feed(addition)
                        if safe:
                            emitted += safe
                            yield f"data: {json.dumps({'type': 'reply_delta', 'content': safe}, ensure_ascii=False)}\n\n"
                        if guard.leaked:
                            break
                    # Only safe to retry when nothing has been shown or spoken yet.
                    if not guard.leaked or emitted:
                        break
                if guard.leaked:
                    reply = _strip_prompt_echo(reply)
                    if reply.startswith(emitted) and len(reply) > len(emitted):
                        addition = reply[len(emitted):]
                        emitted = reply
                        yield f"data: {json.dumps({'type': 'reply_delta', 'content': addition}, ensure_ascii=False)}\n\n"
                else:
                    tail = guard.flush()
                    if tail:
                        yield f"data: {json.dumps({'type': 'reply_delta', 'content': tail}, ensure_ascii=False)}\n\n"
                plan = {
                    "action": "none",
                    "arguments": {},
                    "reply": reply.strip()[:300] or "我在呢，请再说一遍你的问题。",
                    "requiresConfirmation": False,
                }
                yield f"data: {json.dumps({'type': 'plan', 'plan': plan}, ensure_ascii=False)}\n\n"
            except Exception as exc:
                yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"
            return
        action_guide = {
            "navigation.open": {"page": ["dashboard", "profile", "resources", "tutor", "knowledge"]},
            "resource.switch_tab": {"tab": ["ppt", "lecture", "practice", "quiz"]},
            "notes.open": {},
            "notes.create": {"title": "笔记标题", "content": "笔记正文"},
            "presentation.tasks.open": {},
            "presentation.create": {
                "requirement": "完整生成需求，至少10字", "title": "标题",
                "audience": ["students", "teachers", "professionals", "general"],
                "purpose": ["courseware", "report", "sharing", "defense", "training"],
                "backgroundStyle": "主题风格，默认none", "style": "视觉风格，默认academic",
                "slideCount": [0, 12, 20, 30, 40, 55, 70],
                "detailLevel": ["concise", "balanced", "detailed"],
                "includeSpeakerNotes": True,
            },
            "knowledge.search": {"query": "搜索关键词"},
            "console.toggle": {},
            "assistant.voice.set": {"voice": ["冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"]},
            "assistant.speed.set": {"speed": ["very_slow", "slow", "normal", "fast", "very_fast"]},
            "assistant.speed.adjust": {"direction": ["slower", "faster"]},
            "assistant.help": {},
            "none": {},
        }
        try:
            messages = [
                {
                    "role": "system",
                    "content": (
                        "你是亲切、简洁的小鼋助手，同时负责网页操作意图路由。"
                        "普通问答自然简短回答；只有明确要求操作网页时才选择白名单动作。"
                        "只输出合法JSON，必须把reply字段放在第一个，以便立即流式显示。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"用户命令：{request.command}\n"
                        f"当前页面上下文：{json.dumps(request.context, ensure_ascii=False)[:1500]}\n"
                        f"允许动作：{json.dumps(action_guide, ensure_ascii=False)}\n"
                        "严格按此字段顺序返回：{\"reply\":\"简短中文回复\",\"action\":\"动作名\","
                        "\"arguments\":{},\"requiresConfirmation\":false}。"
                        "闲聊和普通问题action使用none；不要输出Markdown代码块。"
                    ),
                },
            ]
            raw = ""
            fed_reply = ""
            emitted = ""
            guard = _ReplyLeakGuard()
            for attempt in range(2):
                raw = ""
                fed_reply = ""
                guard = _ReplyLeakGuard()
                async for event in llm_client().stream_chat(
                    messages, provider="mimo", max_tokens_override=500, thinking=False,
                ):
                    if event.get("type") != "content":
                        continue
                    raw += str(event.get("text") or "")
                    if guard.leaked:
                        if not emitted:
                            break
                        continue
                    reply, _ = _json_string_progress(raw, "reply")
                    if len(reply) > len(fed_reply):
                        addition = reply[len(fed_reply):]
                        fed_reply = reply
                        safe = guard.feed(addition)
                        if safe:
                            emitted += safe
                            yield f"data: {json.dumps({'type': 'reply_delta', 'content': safe}, ensure_ascii=False)}\n\n"
                # Keep consuming the broken stream is unnecessary; retry only
                # when nothing has been shown or spoken yet.
                if not guard.leaked or emitted:
                    break
            start, end = raw.find("{"), raw.rfind("}")
            result = json.loads(raw[start:end + 1] if start >= 0 and end > start else raw)
            plan = _sanitize_assistant_plan(result)
            final_reply = str(plan.get("reply") or "")
            if guard.leaked:
                if not emitted:
                    yield f"data: {json.dumps({'type': 'reply_delta', 'content': final_reply}, ensure_ascii=False)}\n\n"
                elif final_reply.startswith(emitted) and len(final_reply) > len(emitted):
                    yield f"data: {json.dumps({'type': 'reply_delta', 'content': final_reply[len(emitted):]}, ensure_ascii=False)}\n\n"
            else:
                tail = guard.flush()
                if final_reply.startswith(fed_reply) and len(final_reply) > len(fed_reply):
                    tail += final_reply[len(fed_reply):]
                if tail:
                    yield f"data: {json.dumps({'type': 'reply_delta', 'content': tail}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'plan', 'plan': plan}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.post("/notes", status_code=status.HTTP_201_CREATED)
async def create_note(
    request: NoteCreateRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    store = note_store()
    if not store.available():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Note storage is unavailable")
    return await asyncio.to_thread(
        store.create,
        principal.user_id,
        request.model_dump(),
    )


@router.patch("/notes/{note_id}")
async def update_note(
    note_id: UUID,
    request: NoteUpdateRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    result = await asyncio.to_thread(
        note_store().update,
        note_id,
        principal.user_id,
        request.model_dump(exclude_unset=True),
    )
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    return result


@router.delete("/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note(
    note_id: UUID,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    deleted = await asyncio.to_thread(note_store().delete, note_id, principal.user_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")


@router.get("/knowledge-categories/match")
async def match_knowledge_categories(query: str = Query(min_length=1, max_length=1000),
                                     _: InternalPrincipal = Depends(require_user_principal)):
    candidates = await asyncio.to_thread(
        learning_resource_store().knowledge_point_candidates, query, 30,
    )
    match = await asyncio.to_thread(learning_resource_store().match_knowledge_category, query)
    return {"match": match, "candidates": candidates}


@router.get("/wrong-answers")
async def list_wrong_answers(keyword: str | None = None,
                             principal: InternalPrincipal = Depends(require_user_principal)):
    return {"items": await asyncio.to_thread(wrong_answer_store().list, principal.user_id, keyword)}


@router.patch("/wrong-answers/{wrong_id}")
async def update_wrong_answer(wrong_id: UUID, request: WrongAnswerUpdateRequest,
                              principal: InternalPrincipal = Depends(require_user_principal)):
    result = await asyncio.to_thread(
        wrong_answer_store().update, wrong_id, principal.user_id,
        request.model_dump(exclude_unset=True),
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Wrong answer not found")
    return result


@router.post("/wrong-answers/{wrong_id}/review")
async def review_wrong_answer(wrong_id: UUID, request: WrongAnswerReviewRequest,
                              principal: InternalPrincipal = Depends(require_user_principal)):
    try:
        result = await asyncio.to_thread(
            wrong_answer_store().review, wrong_id, principal.user_id, request.answer,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Wrong answer not found")
    return result


@router.delete("/wrong-answers/{wrong_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_wrong_answer(wrong_id: UUID,
                              principal: InternalPrincipal = Depends(require_user_principal)):
    if not await asyncio.to_thread(wrong_answer_store().delete, wrong_id, principal.user_id):
        raise HTTPException(status_code=404, detail="Wrong answer not found")


class AddToWrongBookRequest(BaseModel):
    resourceId: UUID | None = None
    questionId: str
    stem: str
    options: list[str] = []
    userAnswer: int
    correctAnswer: int
    explanation: str = ""
    difficulty: str = "medium"
    kpId: str | None = None
    knowledgeCategoryName: str | None = None


@router.post("/wrong-answers/add", status_code=status.HTTP_201_CREATED)
async def add_to_wrong_book(request: AddToWrongBookRequest,
                             principal: InternalPrincipal = Depends(require_user_principal)):
    """手动收入错题本（用于答对但用户想标记的题目）"""
    question = {
        "id": request.questionId, "stem": request.stem,
        "options": request.options, "correctIndex": request.correctAnswer,
        "explanation": request.explanation, "difficulty": request.difficulty,
    }
    point = {"kpId": request.kpId, "name": request.knowledgeCategoryName or ""}
    result = await asyncio.to_thread(
        wrong_answer_store().record, principal.user_id, request.resourceId,
        question, request.userAnswer, point,
    )
    return result


@router.get("/agent-sessions")
async def list_agent_sessions(principal: InternalPrincipal = Depends(require_user_principal)):
    sessions = await asyncio.to_thread(agent_activity_store().list_sessions, principal.user_id)
    return {"sessions": sessions}

@router.post("/agent-sessions", status_code=status.HTTP_201_CREATED)
async def create_agent_session(
    request: AgentSessionCreateRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    session = await asyncio.to_thread(
        agent_activity_store().create_session, principal.user_id, request.learner_id,
        request.session_type, request.title,
    )
    return session

@router.patch("/agent-sessions/{session_id}")
async def update_agent_session(
    session_id: UUID, request: AgentSessionUpdateRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    session = await asyncio.to_thread(
        agent_activity_store().update_title, session_id, principal.user_id, request.title,
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return session

@router.get("/agent-sessions/{session_id}")
async def get_agent_session(
    session_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    session = await asyncio.to_thread(agent_activity_store().get_session, session_id, principal.user_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return session

@router.post("/agent-sessions/{session_id}/complete")
async def complete_agent_session(
    session_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    session = await asyncio.to_thread(agent_activity_store().complete_session, session_id, principal.user_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return session

@router.get("/agent-sessions/{session_id}/messages")
async def list_agent_messages(
    session_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    session = await asyncio.to_thread(agent_activity_store().get_session, session_id, principal.user_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return {"messages": session.get("messages", [])}

@router.post("/agent-sessions/{session_id}/messages", status_code=status.HTTP_201_CREATED)
async def append_agent_message(
    session_id: UUID, request: AgentMessageCreateRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    session = await asyncio.to_thread(
        agent_activity_store().append_message, session_id, principal.user_id,
        request.agent_id, request.kind, request.content,
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return session

@router.get("/agent-sessions/{session_id}/decisions")
async def list_agent_decisions(
    session_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    session = await asyncio.to_thread(agent_activity_store().get_session, session_id, principal.user_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return {"decisions": session.get("decisions", [])}

@router.post("/agent-sessions/{session_id}/decisions", status_code=status.HTTP_201_CREATED)
async def append_agent_decision(
    session_id: UUID, request: AgentDecisionCreateRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    session = await asyncio.to_thread(
        agent_activity_store().append_decision, session_id, principal.user_id, None,
        request.stage, request.text,
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return session


@router.post("/agent/ask/stream")
async def stream_agent_ask(
    request: AgentAskRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """阿诊流式问答：真实学情 + MiMo 流式输出回复（SSE）。"""
    from app.services.agent_diagnosis import AgentDiagnosisService
    service = AgentDiagnosisService(get_settings())

    async def events():
        reply = ""
        session_id_out: str | None = None
        try:
            clean_text = service.clean_user_text(request.text)
            note_after = re.search(
                r"(?:帮我)?(?:整理到笔记本|整理到笔记|整理成笔记|保存到笔记本|存到笔记本|记下来|记一下|记下|记录一下|记录|记个笔记|写个笔记|记笔记)(?:[：:，,\s]*(.*))?$",
                clean_text,
                re.I,
            )
            note_before = re.search(
                r"把[：:，,\s]*(.+?)[，,\s]*(?:整理到笔记本|整理到笔记|整理成笔记|保存到笔记本|存到笔记本|记下来|记录下来|记到笔记(?:本|里)?)$",
                clean_text,
                re.I,
            )
            previous_agent_text = ""
            recent_dialogue = ""
            if request.session_id is not None:
                try:
                    session = await asyncio.to_thread(
                        agent_activity_store().get_session, request.session_id, principal.user_id,
                    )
                    recent_messages = (session or {}).get("messages") or []
                    recent_dialogue = "\n".join(
                        f"{'用户' if item.get('kind') == 'user' else '助手'}：{str(item.get('content') or '').strip()}"
                        for item in recent_messages[-8:]
                        if item.get("content")
                    )
                    for message in reversed(recent_messages):
                        if message.get("kind") == "agent" and message.get("content"):
                            previous_agent_text = str(message["content"]).strip()
                            break
                except BaseException:
                    previous_agent_text = ""
            confirmation = (
                clean_text.lower() in {"要", "需要", "好", "好的", "可以", "行", "记吧", "帮我记一下"}
                and "整理到笔记本吗" in previous_agent_text
            )
            clarification_followup = (
                "请具体告诉我想记录哪些内容" in previous_agent_text
                and len(clean_text) >= 2
            )
            if note_after or note_before or confirmation or clarification_followup:
                requested = (
                    (note_before.group(1) if note_before else note_after.group(1)) or ""
                ).strip() if (note_after or note_before) else (clean_text if clarification_followup else "")
                vague_request = requested.strip("。！？!?，, ").lower() in {
                    "", "这个", "这个内容", "这个知识点", "刚才的", "刚才内容",
                    "上面的", "这里", "这一块", "这部分", "这些", "一下",
                }
                focused_source = _focused_note_source(request.page_state)
                requested_has_fact = len(requested) >= 12 or bool(re.search(
                    r"(?:是|指|通过|因为|包括|包含|用于|会|能够|等于|意味着|区别|原因|结论)", requested,
                ))
                needs_detail = (
                    (vague_request and not focused_source and not previous_agent_text)
                    or bool(requested and not requested_has_fact and not focused_source and not previous_agent_text)
                )
                if needs_detail and not confirmation and not clarification_followup:
                    reply = "可以。请具体告诉我想记录哪些内容，例如某个定义、结论、疑问或容易混淆的地方。"
                    yield f"data: {json.dumps({'type': 'reply_delta', 'content': reply}, ensure_ascii=False)}\n\n"
                else:
                    source_text = previous_agent_text if confirmation else (
                        focused_source if (vague_request or not requested_has_fact) else requested
                    )
                    draft = await llm_client().complete_json(
                        system=(
                            "你是学习笔记编辑。保留事实含义，把输入整理成可独立阅读的中文学习笔记。"
                            "不要写‘用户说’‘助手回答’等对话痕迹，只输出合法JSON。"
                        ),
                        prompt=(
                            f"用户要求：{requested or '把刚才没有理解透的内容整理成笔记'}\n"
                            f"可用内容：{source_text[:10000]}\n"
                            '输出：{"title":"不超过24字的标题","content":"简洁Markdown正文"}'
                        ),
                        fallback={"title": "", "content": ""},
                        provider="mimo", max_tokens=900, thinking=False,
                    )
                    title = str(draft.get("title") or "").strip()[:160]
                    content = str(draft.get("content") or "").strip()[:20000]
                    if not _assistant_note_is_grounded(title, content, source_text):
                        reply = "这次没有整理出可靠的笔记内容，所以没有保存。请具体告诉我需要记录的结论、定义或疑问。"
                        yield f"data: {json.dumps({'type': 'reply_delta', 'content': reply}, ensure_ascii=False)}\n\n"
                    else:
                        note = await asyncio.to_thread(
                            note_store().create,
                            principal.user_id,
                            {
                                "title": title,
                                "content": content,
                                "status": "approved",
                                "source_type": "assistant",
                                "learner_id": request.learner_id,
                                "kp_id": request.kp_id,
                                "source_kind": "qa",
                                "source_ref": request.page_context,
                                "source_context": "伴学助手整理",
                                "kb_refs": [],
                            },
                        )
                        reply = f"已整理好《{title}》，并存入你的笔记本。"
                        yield f"data: {json.dumps({'type': 'reply_delta', 'content': reply}, ensure_ascii=False)}\n\n"
                        yield f"data: {json.dumps({'type': 'note_saved', 'note': note}, ensure_ascii=False)}\n\n"
                try:
                    store = agent_activity_store()
                    session = await asyncio.to_thread(
                        store.get_session, request.session_id, principal.user_id,
                    ) if request.session_id is not None else None
                    if session is None:
                        session = await asyncio.to_thread(
                            store.create_session, principal.user_id, request.learner_id,
                            "agent-dock", "伴学助手 · 学习笔记",
                        )
                    session_uuid = UUID(session["id"])
                    await asyncio.to_thread(
                        store.append_message, session_uuid, principal.user_id, None, "user", clean_text,
                    )
                    await asyncio.to_thread(
                        store.append_message, session_uuid, principal.user_id, "DIA-01", "agent", reply,
                    )
                    session_id_out = session["id"]
                except BaseException:
                    session_id_out = str(request.session_id) if request.session_id else None
                yield f"data: {json.dumps({'type': 'result', 'reply': reply, 'sessionId': session_id_out}, ensure_ascii=False)}\n\n"
                return
            yield f"data: {json.dumps({'type': 'phase', 'message': '正在结合你的学情回答…'}, ensure_ascii=False)}\n\n"
            async for delta in service.stream_ask(
                principal.user_id, request.learner_id, request.ask_type,
                request.text, request.kp_id, request.page_context, recent_dialogue, request.page_state,
            ):
                if not delta:
                    continue
                reply += delta
                yield f"data: {json.dumps({'type': 'reply_delta', 'content': delta}, ensure_ascii=False)}\n\n"
            if not reply.strip():
                reply = "我正在结合你的学情数据整理回答，请稍后再试。"
                yield f"data: {json.dumps({'type': 'reply_delta', 'content': reply}, ensure_ascii=False)}\n\n"
            # 落库到当前 agent-dock 会话
            try:
                store = agent_activity_store()
                sessions = await asyncio.to_thread(store.list_sessions, principal.user_id)
                session = next(
                    (item for item in sessions if item.get("id") == str(request.session_id)),
                    None,
                ) if request.session_id is not None else next(
                    (
                        item for item in sessions
                        if item.get("sessionType") == "agent-dock"
                        and item.get("learnerId") == str(request.learner_id)
                    ),
                    None,
                )
                if session is None:
                    session = await asyncio.to_thread(
                        store.create_session, principal.user_id, request.learner_id,
                        "agent-dock", "阿诊 · 学习诊断",
                    )
                session_id = UUID(session["id"])
                session_id_out = session["id"]
                user_text = service.clean_user_text(request.text) or {
                    "why-blind": "为什么这些是我的盲区？",
                    "what-next": "我下一步该学什么？",
                    "challenge-score": "我的分数依据是什么？",
                    "free": "帮我看看我的学情",
                }.get(request.ask_type, "帮我看看我的学情")
                await asyncio.to_thread(
                    store.append_message, session_id, principal.user_id, None, "user", user_text,
                )
                await asyncio.to_thread(
                    store.append_message, session_id, principal.user_id, "DIA-01", "agent", reply.strip(),
                )
                await asyncio.to_thread(
                    store.append_decision, session_id, principal.user_id, request.learner_id,
                    "inference", f"阿诊问答（{request.ask_type}）→ 已回复",
                )
            except BaseException:
                pass
            yield f"data: {json.dumps({'type': 'result', 'reply': reply.strip(), 'sessionId': session_id_out}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.post("/agent/ask/image-stream")
async def stream_agent_ask_image(
    image: UploadFile = File(...),
    learner_id: UUID = Form(...),
    ask_type: str = Form(default="free"),
    text: str = Form(default=""),
    session_id: str = Form(default=""),
    page_context: str = Form(default=""),
    page_state: str = Form(default=""),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """伴学助手图片提问：MiMo 先理解图片，再注入伴学助手文本回答链路（SSE）。"""
    from app.services.agent_diagnosis import AgentDiagnosisService

    content = await image.read(5 * 1024 * 1024 + 1)
    if not content:
        raise HTTPException(status_code=422, detail="Image is empty")
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image exceeds the 5 MB limit")
    mime_type = image.content_type or "image/png"
    if mime_type.lower() not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
        raise HTTPException(status_code=422, detail="Image must be PNG, JPEG, WEBP or GIF")
    service = assistant_audio_service()
    if service is None or not service.available:
        raise HTTPException(status_code=503, detail="MiMo image understanding is unavailable")
    state: dict = {}
    if page_state.strip():
        try:
            parsed = json.loads(page_state)
            if isinstance(parsed, dict):
                state = parsed
        except Exception:
            state = {}
    focus = state.get("focus") if isinstance(state.get("focus"), dict) else {}
    topic_hint = "；".join(
        str(v).strip() for v in (state.get("pageType"), focus.get("title") or state.get("pageTitle"))
        if str(v).strip()
    )

    async def events():
        reply = ""
        session_id_out: str | None = None
        try:
            yield f"data: {json.dumps({'type': 'phase', 'phase': 'understanding', 'message': '正在分析图片…'}, ensure_ascii=False)}\n\n"
            description = await service.describe_image(content, mime_type, topic_hint)
            if not description:
                raise ValueError("图片内容识别失败，请换一张更清晰的图片重试")
            yield f"data: {json.dumps({'type': 'phase', 'phase': 'answering', 'message': '已理解图片，正在生成回复…'}, ensure_ascii=False)}\n\n"
            clean_text = AgentDiagnosisService.clean_user_text(text)
            attachment_id: UUID | None = None
            try:
                saved = await asyncio.to_thread(
                    attachment_store().save, principal.user_id,
                    "companion-question.png", mime_type, content,
                )
                attachment_id = UUID(saved["id"])
            except Exception:
                attachment_id = None
            image_marker = f"[图片:{attachment_id}]" if attachment_id else "[图片]"
            user_text = f"{image_marker} {clean_text}" if clean_text else image_marker
            user_message = (
                f"用户上传了一张图片（历史中仅保留[图片]占位）。图片内容描述：{description}\n"
                f"用户问题：{clean_text or '请结合这张图片说明。'}"
            )
            diagnosis = AgentDiagnosisService(get_settings())
            async for piece in diagnosis.stream_ask(
                principal.user_id, learner_id, ask_type,
                user_message, None, page_context or None, "", state,
            ):
                reply += piece
                yield f"data: {json.dumps({'type': 'reply_delta', 'content': piece}, ensure_ascii=False)}\n\n"
            store = agent_activity_store()
            session = None
            if session_id.strip():
                try:
                    session = await asyncio.to_thread(store.get_session, UUID(session_id), principal.user_id)
                except ValueError:
                    session = None
            if session is None:
                sessions = await asyncio.to_thread(store.list_sessions, principal.user_id)
                session = next(
                    (item for item in sessions
                     if item.get("sessionType") == "agent-dock"
                     and item.get("learnerId") == str(learner_id)),
                    None,
                )
            if session is None:
                session = await asyncio.to_thread(
                    store.create_session, principal.user_id, learner_id, "agent-dock", "新对话",
                )
            session_id_out = session["id"]
            await asyncio.to_thread(
                store.append_message, UUID(session_id_out), principal.user_id, None, "user", user_text,
            )
            if reply.strip():
                await asyncio.to_thread(
                    store.append_message, UUID(session_id_out), principal.user_id, "DIA-01", "agent", reply.strip(),
                )
            yield f"data: {json.dumps({'type': 'result', 'reply': reply.strip(), 'sessionId': session_id_out}, ensure_ascii=False)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@router.post("/agent/ask/suggestions")
async def ask_agent_suggestions(
    request: AgentAskRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """阿诊快捷问题建议：基于真实学情动态生成（面板 chips 定时刷新）。"""
    from app.services.agent_diagnosis import AgentDiagnosisService
    service = AgentDiagnosisService(get_settings())
    questions = await service.suggest_questions(
        principal.user_id, request.learner_id, request.kp_id,
        request.page_context, request.page_state, request.text,
    )
    return {"questions": questions}


@router.post("/agent/ask/weekly-plan")
async def ask_agent_weekly_plan(
    request: AgentAskRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """成长报告周建议：ARB-05 根据真实学情快照生成本周行动建议。"""
    from app.services.agent_diagnosis import AgentDiagnosisService
    service = AgentDiagnosisService(get_settings())
    return await service.weekly_plan(
        principal.user_id, request.learner_id, request.kp_id,
    )


@router.post("/agent/ask/similar-quiz")
async def ask_agent_similar_quiz(
    request: AgentSimilarQuizRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """伴学助手生成一道类似练习题，供前端渲染为可交互做题卡片。"""
    from app.services.agent_diagnosis import AgentDiagnosisService
    service = AgentDiagnosisService(get_settings())
    result = await service.ask_similar_quiz(
        principal.user_id, request.learner_id,
        request.kp_id, request.page_context, request.page_state,
        request.quiz_follow_up,
    )
    if not result:
        raise HTTPException(status_code=502, detail="类似题生成失败，请稍后重试")
    return result


@router.post("/agent/ask")
async def ask_agent_diagnosis(
    request: AgentAskRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """阿诊对话回复：真实学情 + MiMo 回答学情类问题（知识点讲解引导回课件）。"""
    from app.services.agent_diagnosis import AgentDiagnosisService
    service = AgentDiagnosisService(get_settings())
    result = await service.ask(
        principal.user_id, request.learner_id, request.ask_type,
        request.text, request.kp_id, request.page_context,
    )
    try:
        store = agent_activity_store()
        sessions = await asyncio.to_thread(store.list_sessions, principal.user_id)
        session = next(
            (
                item for item in sessions
                if item.get("id") == str(request.session_id)
            ),
            None,
        ) if request.session_id is not None else next(
            (
                item for item in sessions
                if item.get("sessionType") == "agent-dock"
                and item.get("learnerId") == str(request.learner_id)
            ),
            None,
        )
        if session is None:
            session = await asyncio.to_thread(
                store.create_session, principal.user_id, request.learner_id,
                "agent-dock", "阿诊 · 学习诊断",
            )
        session_id = UUID(session["id"])
        user_text = service.clean_user_text(request.text) or {
            "why-blind": "为什么这些是我的盲区？",
            "what-next": "我下一步该学什么？",
            "challenge-score": "我的分数依据是什么？",
            "free": "帮我看看我的学情",
        }.get(request.ask_type, "帮我看看我的学情")
        await asyncio.to_thread(
            store.append_message, session_id, principal.user_id, None, "user", user_text,
        )
        await asyncio.to_thread(
            store.append_message, session_id, principal.user_id, "DIA-01", "agent", result["reply"],
        )
        await asyncio.to_thread(
            store.append_decision, session_id, principal.user_id, request.learner_id,
            "inference", f"阿诊问答（{request.ask_type}）→ 已回复",
        )
    except BaseException:
        pass
    return result


@router.delete("/agent-sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent_session(
    session_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    deleted = await asyncio.to_thread(agent_activity_store().delete, session_id, principal.user_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent session not found")


@router.post("/agent/infer")
async def infer_agent_diagnosis(
    request: AgentInferRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """阿诊（DIA-01）学情推理：真实学情数据 + MiMo → 诊断反馈（画像写回由前端复用 learners 接口）。"""
    from app.services.agent_diagnosis import AgentDiagnosisService
    service = AgentDiagnosisService(get_settings())
    result = await service.infer(principal.user_id, request.learner_id, request.signal)
    try:
        store = agent_activity_store()
        sessions = await asyncio.to_thread(store.list_sessions, principal.user_id)
        session = next(
            (
                item for item in sessions
                if item.get("id") == str(request.session_id)
            ),
            None,
        ) if request.session_id is not None else next(
            (
                item for item in sessions
                if item.get("sessionType") == "agent-dock"
                and item.get("learnerId") == str(request.learner_id)
            ),
            None,
        )
        if session is None:
            session = await asyncio.to_thread(
                store.create_session, principal.user_id, request.learner_id,
                "agent-dock", "阿诊 · 学习诊断",
            )
        session_id = UUID(session["id"])
        signal_desc = service.describe_signal(request.signal)
        await asyncio.to_thread(
            store.append_decision, session_id, principal.user_id, request.learner_id,
            "inference",
            f"信号：{signal_desc} → delta={result['delta']} conf={result['confDelta']}",
        )
        await asyncio.to_thread(
            store.append_message, session_id, principal.user_id, "DIA-01", "agent", result["say"],
        )
        result["sessionId"] = session["id"]
    except BaseException:
        pass
    return result


_TEMPLATED_SUMMARY = re.compile(r"^围绕.{0,60}建立第.{1,8}阶段")
@router.get("/tutoring/scripts/{learner_code}")
async def get_tutoring_script(
    learner_code: str,
    _: InternalPrincipal = Depends(require_user_principal),
):
    script = await asyncio.to_thread(tutoring_service().get_script, learner_code)
    if script is None:
        raise HTTPException(status_code=404, detail="Tutoring script not found")
    return script


@router.get("/learning-units/{kp_id}/topics/{topic_id}")
async def get_personalized_learning_unit(
    kp_id: str,
    topic_id: str,
    learner_id: UUID = Query(alias="learnerId"),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """Return a profile-bound unit for one smallest knowledge-map topic."""
    try:
        return await personalized_unit_service().get_or_generate(
            principal.user_id, learner_id, kp_id, topic_id,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/learning-units/prewarm", status_code=status.HTTP_202_ACCEPTED)
async def prewarm_personalized_learning_units(
    payload: dict,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    learner_id = UUID(str(payload.get("learnerId")))
    service = personalized_unit_service()
    km = await asyncio.to_thread(service.directory.load_knowledge_map)
    pairs: list[tuple[str, str]] = []
    for chapter in km.get("chapters") or []:
        pairs.extend((chapter["code"], topic["id"]) for topic in chapter.get("topics") or [])

    async def generate_all() -> None:
        semaphore = asyncio.Semaphore(2)
        async def one(kp_id: str, topic_id: str) -> None:
            async with semaphore:
                try:
                    await service.get_or_generate(principal.user_id, learner_id, kp_id, topic_id)
                except Exception:
                    logger.exception("Unable to prewarm personalized unit %s/%s", kp_id, topic_id)
        await asyncio.gather(*(one(kp_id, topic_id) for kp_id, topic_id in pairs))

    task = _enqueue_generation(generate_all())
    _personalized_unit_tasks.add(task)
    task.add_done_callback(_personalized_unit_tasks.discard)
    return {"queued": len(pairs), "granularity": "knowledge_topic"}

@router.post("/tutoring/sessions", status_code=status.HTTP_201_CREATED)
async def create_tutoring_session(
    request: TutoringSessionCreateRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    try:
        return await asyncio.to_thread(
            tutoring_service().create_session,
            principal.user_id,
            request.learner_code,
            request.resource_id,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

@router.get("/tutoring/sessions/{session_id}")
async def get_tutoring_session(
    session_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    session = await asyncio.to_thread(tutoring_service().get_session, principal.user_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Tutoring session not found")
    return session

@router.post("/tutoring/sessions/{session_id}/answer")
async def answer_tutoring_session(
    session_id: UUID, request: TutoringAnswerRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    try:
        return await asyncio.to_thread(tutoring_service().answer, principal.user_id, session_id, request)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

@router.post("/tutoring/sessions/{session_id}/complete")
async def complete_tutoring_session(
    session_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    try:
        return await asyncio.to_thread(tutoring_service().complete, principal.user_id, session_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

_RESOURCE_TITLE_SUFFIXES = {
    "lecture": ("讲义",),
    "practice": ("实操指南", "实践指南", "实战指南"),
    "quiz": ("选择题", "分阶测试", "诊断测评", "综合测评", "能力测评", "测评", "测验", "测试"),
}
_GENERIC_TITLE_WORDS = {"方法", "核心概念", "核心知识", "核心原理", "概述", "总结", "复习", "引言", "结论", "综合", "实践", "实战"}


def _is_templated_summary(summary: str) -> bool:
    return bool(_TEMPLATED_SUMMARY.match(summary))


def _prior_chapters_text(chapters: list[dict], current_index: int) -> str:
    """Build a compact summary of chapters before the current one."""
    parts = []
    for item in chapters or []:
        try:
            index = int(item.get("index", 0))
        except (TypeError, ValueError):
            continue
        if index >= int(current_index):
            continue
        title = clean_title(item.get("title"))
        if not title:
            continue
        summary = str(item.get("summary") or "").strip()
        if _is_templated_summary(summary):
            summary = ""
        parts.append(f"第{index}章《{title}》" + (f"：{summary}" if summary else ""))
    return "；".join(parts)[:600]


def _clean_resource_title(title: object, chapter_title: str, kind: str) -> str | None:
    cleaned = clean_title(title)
    chapter = clean_title(chapter_title)
    if chapter and cleaned.startswith(chapter):
        cleaned = cleaned[len(chapter):].strip(" ：:、-—|｜") or chapter
    suffixes = _RESOURCE_TITLE_SUFFIXES.get(kind, ())
    if not cleaned or cleaned in suffixes or cleaned in _GENERIC_TITLE_WORDS or len(cleaned) < 4:
        return None
    stem = cleaned
    for suffix in suffixes:
        if stem.endswith(suffix) and len(stem) > len(suffix):
            stem = stem[:-len(suffix)].strip(" ：:、-—|｜")
            break
    if not stem or stem == chapter:
        return None
    return cleaned



async def _generate_course(course_id: UUID, user_id: UUID, request: CourseCreateRequest,
                           context: dict, chapter_ids: set[UUID] | None = None) -> None:

        return await _generate_course_inner(course_id, user_id, request, context, chapter_ids)


async def _generate_course_inner(course_id: UUID, user_id: UUID, request: CourseCreateRequest,
                                 context: dict, chapter_ids: set[UUID] | None = None) -> None:
    store = course_store()
    style_labels = {
        "none": "素雅纯色", "colorful-ink": "彩色水墨", "sunset-mountains": "橙红山脉",
        "abstract-gradient": "梦幻渐变", "clean-minimal": "自然简约",
        "cartoon-doodle": "趣味涂鸦", "blue-white-minimal": "蓝白学术",
        "blue-conference": "蓝调会议", "morandi-blue-gray": "莫兰迪蓝灰",
        "business-gray": "商务灰阶", "watercolor": "清透水彩",
    }
    ppt_styles = {
        "none": "minimal", "colorful-ink": "vibrant", "sunset-mountains": "terracotta",
        "abstract-gradient": "luxury", "clean-minimal": "minimal", "cartoon-doodle": "education",
        "blue-white-minimal": "academic", "blue-conference": "business",
        "morandi-blue-gray": "editorial", "business-gray": "business", "watercolor": "ocean",
    }
    style_instruction = f"整套课程采用“{style_labels[request.course_style]}”主题视觉风格"
    extra_requirement = request.prompt.strip() or "无额外要求，由课程Agent根据学习目标自主规划"
    try:
        pending_presentations: list[tuple[UUID, dict, UUID]] = []
        course = await asyncio.to_thread(store.get, course_id, user_id)
        await asyncio.to_thread(store.append_event, course_id, 
            "DIA-01 学情诊断完成", "已读取用户目标、画像与优先薄弱方向", "DIA-01",
        )
        chapter_count = {"compact": 4, "standard": 6, "complete": 8}[request.scale]
        chapter_range = {"compact": (3, 5), "standard": (5, 8), "complete": (8, 12)}[request.scale]
        fallback = {
            "title": context.get("goal", {}).get("title") or "个性化系统课程",
            "description": "围绕当前学习目标，由浅入深组织的系统课程。",
            "chapters": [
                {"title": title, "summary": summary, "objectives": [summary]}
                for title, summary in [
                    ("学习地图与基础概念", "建立领域全局认知"), ("核心原理", "掌握关键机制"),
                    ("方法与工具", "学会典型方法"), ("实践与综合应用", "完成综合实践"),
                ]
            ],
        }
        if not course or not course.get("chapters"):
            plan, _outline_sources, _tools_used = await CourseOutlinePlanner(llm_client()).plan(
                context, chapter_count, request.depth, extra_requirement, chapter_range,
            )
            chapters = plan["chapters"]
            await asyncio.to_thread(store.set_outline, course_id, str(plan.get("title") or fallback["title"]),
                                    str(plan.get("description") or fallback["description"]), chapters)
            await asyncio.to_thread(
                store.append_event, course_id, "ARB-05 课程大纲已确认",
                f"生成 {len(chapters)} 个动态章节，等待章节资源按需生成", "ARB-05",
            )
            course = await asyncio.to_thread(store.get, course_id, user_id)
        if not course:
            return
        for chapter in course["chapters"]:
            if chapter_ids is not None and UUID(chapter["id"]) not in chapter_ids:
                continue
            if chapter["status"] == "completed":
                continue
            chapter_id = UUID(chapter["id"])
            resources: dict[str, dict] = dict(chapter.get("resources") or {})
            await asyncio.to_thread(store.update_chapter, course_id, chapter_id, "generating", 10, resources)
            chapter_title = clean_title(chapter.get("title"))
            section_titles = "、".join(
                cleaned for item in chapter.get("sections") or []
                if (cleaned := clean_title(item.get("title")))
            )
            chapter_summary = str(chapter.get("summary") or "").strip()
            if _is_templated_summary(chapter_summary):
                chapter_summary = ""
            topic = f"{course['title']}｜第{chapter['index']}章 {chapter_title}"
            if chapter_summary:
                topic += f"：{chapter_summary}"
            if section_titles:
                topic += f"。本章小节：{section_titles}"
            prior_context_text = _prior_chapters_text(course["chapters"], chapter["index"])
            chapter_context = {**context, "course": {"id": str(course_id), "title": course["title"],
                                                       "style": style_instruction,
                                                       "extraRequirement": extra_requirement},
                               "chapter": chapter, "priorChapters": prior_context_text}
            ppt_task_id: UUID | None = None
            for kind in [item for item in request.resource_types if item == "ppt"]:
                if (resources.get(kind) or {}).get("status") == "completed":
                    continue
                try:
                    if kind == "ppt":
                        ppt_request = PresentationRequest(
                            requirement=(
                                f"为企业培训课程《{course['title']}》的第{chapter['index']}章《{chapter['title']}》制作学员版配套教学PPT。"
                                f"{chapter['summary']}。教学风格：{style_instruction}。额外要求：{extra_requirement}。"
                                "受众是正在学习本章的企业学员，不是课程设计人员。按‘本章问题—通俗概念—工作场景—逐步示例—练习检查—要点回顾’组织；"
                                "首次术语必须解释，示例必须给出具体输入、过程与输出，不使用空泛口号，不把讲稿正文堆满页面。"
                                f"前文已学章节（仅用于衔接与避免重复，不要重复展开，需要时一句话带过）：{prior_context_text or '无'}"
                            ),
                            title=f"{chapter['title']}｜{course['title']}", audience="students", purpose="courseware",
                            style=ppt_styles[request.course_style], backgroundStyle=request.course_style,
                            slideCount=12, detailLevel="balanced",
                            learningGoalId=request.learning_goal_id,
                            generationContext={"courseId": str(course_id), "chapterId": chapter["id"]},
                        )
                        existing = resources.get(kind) or {}
                        if existing.get("id"):
                            task_id = UUID(existing["id"])
                            task = await asyncio.to_thread(presentation_store().get_internal, task_id)
                        else:
                            created = await asyncio.to_thread(presentation_store().create, user_id, ppt_request)
                            task_id, task = UUID(created["id"]), created
                            resources[kind] = {"id": created["id"], "status": created["status"], "title": created["title"]}
                        ppt_task_id = task_id
                        if task and task.get("status") == "completed":
                            resources[kind]["status"] = "completed"
                        elif task_id not in _presentation_tasks:
                            background = asyncio.create_task(_run_course_presentation(task_id, ppt_request))
                            _presentation_tasks[task_id] = background
                            background.add_done_callback(lambda _task, key=task_id: _presentation_tasks.pop(key, None))
                        await asyncio.to_thread(store.update_chapter, course_id, chapter_id, "generating", 25, resources)
                        continue
                except Exception as exc:
                    logger.exception("Course chapter resource generation failed")
                    resources[kind] = {"status": "failed", "error": str(exc)[:300]}
                await asyncio.to_thread(store.update_chapter, course_id, chapter_id, "generating", 25, resources)

            text_kinds = [kind for kind in request.resource_types if kind != "ppt" and (resources.get(kind) or {}).get("status") != "completed"]
            if text_kinds:
                await asyncio.to_thread(
                    store.append_event, course_id, "RET-02 知识检索开始",
                    f"检索第{chapter['index']}章「{chapter_title}」相关证据", "RET-02",
                )
                service = LearningContentService(get_settings())
                logger.warning("Course %s chapter %s retrieving shared sources", course_id, chapter["index"])
                await service.retrieve(topic)
                logger.warning("Course %s chapter %s sources ready; queued resources=%s", course_id, chapter["index"], text_kinds)

                async def generate_text_resource(kind: str) -> tuple[str, dict]:
                    logger.warning("Course %s chapter %s resource %s waiting for generation slot", course_id, chapter["index"], kind)
                    async with _course_generation_semaphore():
                        logger.warning("Course %s chapter %s resource %s generation started", course_id, chapter["index"], kind)
                        return await generate_text_resource_unlimited(kind)

                async def persist_text_resource(kind: str, result: dict) -> tuple[str, dict]:
                    resources[kind] = result
                    completed_count = sum(1 for item in request.resource_types if (resources.get(item) or {}).get("status") == "completed")
                    progress = min(90, 25 + round(65 * completed_count / max(1, len(request.resource_types))))
                    await asyncio.to_thread(store.update_chapter, course_id, chapter_id, "generating", progress, resources)
                    return kind, result

                async def generate_text_resource_unlimited(kind: str) -> tuple[str, dict]:
                    payload = {"topic": topic, "title": chapter_title if kind == "lecture" else f"{chapter_title}实操指南" if kind == "practice" else f"{chapter_title}分阶测试",
                               "learning_goal_id": request.learning_goal_id, "detail_level": "detailed" if request.depth == "advanced" else "balanced", "question_count": 15}
                    try:
                        if kind == "lecture":
                            content, sources, decision = await service.generate_lecture(payload, chapter_context); state = None
                        elif kind == "practice":
                            content, sources, decision = await service.generate_practice(payload, chapter_context); state = None
                        else:
                            candidates = await asyncio.to_thread(learning_resource_store().knowledge_point_candidates, topic)
                            content, sources, state, decision = await service.generate_quiz(payload, candidates, chapter_context)
                            content = await asyncio.to_thread(learning_resource_store().bind_knowledge_categories, content, candidates)
                        payload["title"] = (_clean_resource_title(content.get("title"), chapter_title, kind) or payload["title"])[:160]
                        resource = await asyncio.to_thread(learning_resource_store().create, user_id, kind, payload, content, sources, state, chapter_context, decision, course_id, chapter_id)
                        logger.warning("Course %s chapter %s resource %s generation completed", course_id, chapter["index"], kind)
                        return await persist_text_resource(kind, {"id": resource["id"], "status": "completed", "title": resource["title"]})
                    except Exception as exc:
                        logger.exception("Course chapter text resource generation failed")
                        return await persist_text_resource(kind, {"status": "failed", "error": str(exc)[:300]})

                try:
                    generated = await asyncio.gather(*(generate_text_resource(kind) for kind in text_kinds))
                    await asyncio.to_thread(
                        store.append_event, course_id, "GEN-03 章节资源生成完成",
                        f"第{chapter['index']}章「{chapter_title}」正文资源已生成", "GEN-03",
                    )
                finally:
                    await service.close()
            if ppt_task_id and (resources.get("ppt") or {}).get("status") != "completed":
                pending_presentations.append((chapter_id, resources, ppt_task_id))
                await asyncio.to_thread(store.update_chapter, course_id, chapter_id, "generating", 90, resources)
            else:
                await asyncio.to_thread(store.update_chapter, course_id, chapter_id, "completed", 100, resources)

        active_ppt_tasks = [
            _presentation_tasks[task_id]
            for _, _, task_id in pending_presentations
            if task_id in _presentation_tasks
        ]
        if active_ppt_tasks:
            await asyncio.gather(*active_ppt_tasks, return_exceptions=True)
        for chapter_id, resources, task_id in pending_presentations:
            task = await asyncio.to_thread(presentation_store().get_internal, task_id)
            if task:
                resources["ppt"] = {
                    "id": str(task_id), "status": task.get("status") or "failed",
                    "progress": int(task.get("progress") or 0),
                    "title": task.get("title") or (resources.get("ppt") or {}).get("title"),
                    "error": task.get("error_message"),
                }
            else:
                resources["ppt"] = {"id": str(task_id), "status": "failed", "error": "PPT task was not found"}
            await asyncio.to_thread(store.update_chapter, course_id, chapter_id, "completed", 100, resources)
    except Exception as exc:
        logger.exception("Course generation failed")
        if chapter_ids:
            failed_course = await asyncio.to_thread(store.get, course_id, user_id)
            for chapter in (failed_course or {}).get("chapters", []):
                chapter_id = UUID(chapter["id"])
                if chapter_id not in chapter_ids:
                    continue
                resources = dict(chapter.get("resources") or {})
                for kind in request.resource_types:
                    if (resources.get(kind) or {}).get("status") != "completed":
                        resources[kind] = {
                            **(resources.get(kind) or {}), "status": "failed", "error": str(exc)[:300],
                        }
                await asyncio.to_thread(store.update_chapter, course_id, chapter_id, "completed", 100, resources)
        else:
            await asyncio.to_thread(store.fail, course_id, str(exc))


async def recover_interrupted_courses() -> int:
    """Resume active courses whose in-memory asyncio tasks vanished on reload/restart."""
    recoverable = await asyncio.to_thread(course_store().list_recoverable)
    resumed = 0
    for item in recoverable:
        course_id, user_id = UUID(item["id"]), UUID(item["userId"])
        if course_id in _course_tasks:
            continue
        course = await asyncio.to_thread(course_store().get, course_id, user_id)
        for chapter in (course or {}).get("chapters", []):
            ppt = (chapter.get("resources") or {}).get("ppt") or {}
            if not ppt.get("id"):
                continue
            task_id = UUID(ppt["id"])
            task_row = await asyncio.to_thread(presentation_store().get_internal, task_id)
            if not task_row or task_row.get("status") in {"completed", "failed", "cancelled"}:
                continue
            request_data = task_row.get("request_json") or {}
            if isinstance(request_data, str):
                request_data = json.loads(request_data)
            ppt_request = PresentationRequest.model_validate(request_data)
            background = asyncio.create_task(_run_course_presentation(task_id, ppt_request))
            _presentation_tasks[task_id] = background
            background.add_done_callback(lambda _task, key=task_id: _presentation_tasks.pop(key, None))
        request = CourseCreateRequest(
            prompt=item["prompt"], learning_goal_id=item.get("learningGoalId"),
            learning_goal_ids=item.get("learningGoalIds") or [],
            resource_types=item["resourceTypes"], depth=item["depth"], scale=item["scale"],
            course_style=item.get("courseStyle") or "none",
        )
        context = await asyncio.to_thread(
            GoalContextService(get_settings()).build, user_id, request.learning_goal_id,
        )
        task = _enqueue_generation(_generate_course(course_id, user_id, request, context))
        _course_tasks[course_id] = task
        task.add_done_callback(lambda _task, key=course_id: _course_tasks.pop(key, None))
        resumed += 1
        logger.info("Resumed interrupted course %s", course_id)
    return resumed

async def recover_interrupted_resource_tasks() -> int:
    """进程重启后恢复统一 FIFO 中的文本资源和交互课件任务。

    Only tasks created with the admin resume marker are recovered.  Events and
    checkpoint payloads are preserved so resumed tasks do not silently lose
    their execution record.
    """
    affected = await asyncio.to_thread(resource_generation_task_store().fail_orphaned)
    ppt_affected = await asyncio.to_thread(presentation_store().mark_orphaned_recoverable)
    affected += ppt_affected
    # Both task types share one worker during normal submission.  Recover them
    # in their original creation order as well; otherwise every queued PPT is
    # silently lost on reload or gets appended after all text resources.
    from app.storage.platform_db import platform_connect
    from app.config import get_settings as _gs
    def _load_queued():
        with platform_connect(_gs()) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 'resource' task_kind,id,user_id,resource_type,request_json,created_at"
                    " FROM learning_resource_generation_tasks WHERE status='queued' AND resume_enabled=1"
                    " UNION ALL "
                    "SELECT 'presentation' task_kind,id,user_id,NULL resource_type,request_json,created_at"
                    " FROM presentation_tasks WHERE status='queued' AND resume_enabled=1"
                    " ORDER BY created_at"
                )
                return cur.fetchall()
    queued = list(await asyncio.to_thread(_load_queued))
    def _recovery_order(row):
        raw = row.get("request_json")
        payload = json.loads(raw) if isinstance(raw, str) else (raw or {})
        context = payload.get("generation_context") or payload.get("generationContext") or {}
        sequence = context.get("queueSequence")
        if isinstance(sequence, int) or (isinstance(sequence, str) and sequence.isdigit()):
            return (0, int(sequence), row.get("created_at"))
        node = str(context.get("nodeCode") or payload.get("kp_id") or payload.get("kpId") or "")
        kind = str(row.get("resource_type") or ("ppt" if row.get("task_kind") == "presentation" else ""))
        return (1, _calc_priority(node, kind), row.get("created_at"))
    queued.sort(key=_recovery_order)
    for row in queued:
        tid = UUID(bytes=row['id'])
        uid = UUID(bytes=row['user_id'])
        req_data = json.loads(row['request_json']) if isinstance(row['request_json'], str) else (row['request_json'] or {})
        if row['task_kind'] == 'resource':
            from app.domain.models import LearningResourceCreateRequest
            rt = str(row['resource_type'])
            req = LearningResourceCreateRequest.model_validate(req_data)
            nc = req_data.get("generation_context", {}).get("nodeCode") or req_data.get("kp_id") or ""
            context = req_data.get("generation_context") or req_data.get("generationContext") or {}
            _enqueue_generation(
                _run_learning_resource_generation(tid, uid, rt, req),
                node_code=nc, resource_type=rt, queue_sequence=context.get("queueSequence"),
            )
            continue
        req = PresentationRequest.model_validate(req_data)
        context = dict(req.generation_context or {})
        nc_ppt = context.get("nodeCode") or context.get("kpId") or ""
        waiting_on_dependencies = context.get("waitForDependencies") is True
        background = _enqueue_generation(
            _run_presentation_after_dependencies(tid, req)
            if waiting_on_dependencies
            else _run_presentation_full(tid, req),
            node_code=nc_ppt, resource_type="ppt",
            is_ppt=waiting_on_dependencies,
            ppt_dep_check=(lambda: _ppt_dep_check_from_context(context))
            if waiting_on_dependencies else None,
            queue_sequence=context.get("queueSequence"),
        )
        _presentation_tasks[tid] = background
        background.add_done_callback(lambda _task, key=tid: _presentation_tasks.pop(key, None))
    return affected


async def _run_course_presentation(task_id: UUID, request: PresentationRequest) -> None:
    """Run both PPT phases because course resources have no manual outline-review step."""
    agent = ppt_agent()
    task = await asyncio.to_thread(presentation_store().get_internal, task_id)
    if task and task.get("status") == "completed":
        return
    if not task or task.get("status") != "outline_review":
        await agent.run(task_id, request)
        task = await asyncio.to_thread(presentation_store().get_internal, task_id)
    if task and task.get("status") == "outline_review":
        presentation_store().update(
            task_id, status="generating", progress=40,
            stage_message="课程提纲已自动确认，正在设计幻灯片",
        )
        await agent.run_generate(task_id, request)


async def _enrich_course_presentation_status(course: dict, user_id: UUID) -> dict:
    for chapter in course.get("chapters", []):
        ppt = (chapter.get("resources") or {}).get("ppt")
        if not ppt or not ppt.get("id"):
            continue
        try:
            task = await asyncio.to_thread(presentation_store().get, UUID(ppt["id"]), user_id)
        except (TypeError, ValueError):
            task = None
        if task:
            ppt.update({"status": task["status"], "progress": task["progress"],
                        "title": task["title"], "error": task.get("errorMessage")})
    return course


async def _learner_course_context(user_id: UUID, learner_id: UUID) -> dict | None:
    learner = await asyncio.to_thread(directory().load_learner, learner_id, user_id)
    if learner is None:
        return None
    km = await asyncio.to_thread(directory().load_knowledge_map)
    points = km.get("chapters") or []
    scores = learner.get("scores") or {}
    focus = min(
        points, key=lambda point: (
            -(int(point.get("targetLevel") or 80) - int(scores.get(point.get("code"), 50))),
            int(scores.get(point.get("code"), 50)),
        ),
    ) if points else None
    goal_title = str(learner.get("targetJob") or learner.get("goal") or "个性化学习课程")[:160]
    goal_description = str(learner.get("goal") or f"围绕{goal_title}构建系统课程")[:1000]
    return {
        "mode": "learner_driven",
        "goal": {"id": None, "title": goal_title, "description": goal_description,
                   "goalType": "SKILL_IMPROVEMENT", "expectedLevel": "PROFICIENT",
                   "initialLevel": None, "inferred": True},
        "learner": learner,
        "knowledgePoints": points,
        "recommendation": {
            "topic": focus.get("name") if focus else goal_title,
            "reason": "根据学习者画像优先安排缺口最大的知识点。", "ability": .35,
            "difficulty": "foundation", "detailLevel": "balanced",
        },
    }
@router.post("/courses", status_code=status.HTTP_202_ACCEPTED)
async def create_course(request: CourseCreateRequest,
                        principal: InternalPrincipal = Depends(require_user_principal)):
    payload = request.model_dump()
    goal_ids = list(dict.fromkeys(request.learning_goal_ids or (
        [request.learning_goal_id] if request.learning_goal_id else []
    )))
    if not goal_ids:
        context = await asyncio.to_thread(
            GoalContextService(get_settings()).build, principal.user_id, None,
        )
        current_id = (context.get("goal") or {}).get("id")
        if current_id:
            goal_ids = [UUID(current_id)]

        if request.learner_id:
            learner_context = await _learner_course_context(principal.user_id, request.learner_id)
            if learner_context:
                context = learner_context
    else:
        contexts = await asyncio.gather(*[
            asyncio.to_thread(GoalContextService(get_settings()).build, principal.user_id, goal_id)
            for goal_id in goal_ids
        ])
        context = contexts[0]
        selected_domains = [item.get("goal") or {} for item in contexts]
        context["selectedDomains"] = selected_domains
        domain_names = [
            str(item.get("knowledgeDomainName") or item.get("title") or "").strip()
            for item in selected_domains
        ]
        domain_names = [name for name in domain_names if name]
        if len(domain_names) > 1:
            context["goal"] = {
                **(context.get("goal") or {}),
                "title": " + ".join(domain_names),
                "knowledgeDomainName": "、".join(domain_names),
            }
    request.learning_goal_ids = goal_ids
    request.learning_goal_id = goal_ids[0] if goal_ids else request.learning_goal_id
    payload = request.model_dump()
    course = await asyncio.to_thread(course_store().create, principal.user_id, payload, context)
    course_id = UUID(course["id"])
    task = _enqueue_generation(_generate_course(course_id, principal.user_id, request, context))
    _course_tasks[course_id] = task
    task.add_done_callback(lambda _task, key=course_id: _course_tasks.pop(key, None))
    return course


@router.post("/courses/{course_id}/regenerate", status_code=status.HTTP_202_ACCEPTED)
async def regenerate_course(
    course_id: UUID, request: CourseRegenerateRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """Create a fresh course version while preserving the previous version and its learning records."""
    source = await asyncio.to_thread(course_store().get, course_id, principal.user_id)
    if source is None:
        raise HTTPException(status_code=404, detail="Course not found")
    active = _course_tasks.get(course_id)
    if active and not active.done():
        raise HTTPException(status_code=409, detail="Course generation is already running")

    create_request = CourseCreateRequest(
        prompt=(
            f"{source.get('prompt') or ''}\n"
            "这是一次课程内容重新生成。请重新规划与学习目标直接相关的具体章节，"
            "不要退回固定六知识点模板，并为每章生成可直接学习的正文资源。"
        ).strip(),
        learner_id=request.learner_id or source.get("learnerId"),
        learning_goal_id=source.get("learningGoalId"),
        learning_goal_ids=source.get("learningGoalIds") or [],
        resource_types=request.resource_types,
        depth=source["depth"], scale=source["scale"],
        course_style=source.get("courseStyle") or "none",
    )
    if create_request.learner_id:
        context = await _learner_course_context(principal.user_id, create_request.learner_id)
        if context is None:
            raise HTTPException(status_code=404, detail="Learner not found")
    elif create_request.learning_goal_id:
        context = await asyncio.to_thread(
            GoalContextService(get_settings()).build, principal.user_id, create_request.learning_goal_id,
        )
    else:
        learner = await asyncio.to_thread(directory().load_primary_learner, principal.user_id)
        if learner:
            create_request.learner_id = UUID(learner["id"])
            context = await _learner_course_context(principal.user_id, create_request.learner_id) or {}
        else:
            context = await asyncio.to_thread(
                GoalContextService(get_settings()).build, principal.user_id, None,
            )

    payload = create_request.model_dump()
    replacement = await asyncio.to_thread(course_store().create, principal.user_id, payload, context)
    replacement_id = UUID(replacement["id"])
    await asyncio.to_thread(
        course_store().append_event, replacement_id, "课程重新生成",
        f"已保留旧版本 {course_id}，开始生成新的课程大纲与正文资源", "ARB-05",
    )
    task = asyncio.create_task(
        _generate_course(replacement_id, principal.user_id, create_request, context),
    )
    _course_tasks[replacement_id] = task
    task.add_done_callback(lambda _task, key=replacement_id: _course_tasks.pop(key, None))
    return replacement


@router.post("/courses/{course_id}/retry", status_code=status.HTTP_202_ACCEPTED)
async def retry_failed_course(course_id: UUID,
                              principal: InternalPrincipal = Depends(require_user_principal)):
    active = _course_tasks.get(course_id)
    if active and not active.done():
        raise HTTPException(status_code=409, detail="Course generation is already running")
    store = course_store()
    course = await asyncio.to_thread(store.get, course_id, principal.user_id)
    if course is None:
        raise HTTPException(status_code=404, detail="Course not found")
    if course.get("status") != "failed":
        raise HTTPException(status_code=409, detail="Only failed courses can be retried")
    request = CourseCreateRequest(
        prompt=course.get("prompt") or "", learning_goal_id=course.get("learningGoalId"),
        learner_id=course.get("learnerId"),
        learning_goal_ids=course.get("learningGoalIds") or [], resource_types=course.get("resourceTypes") or [],
        depth=course["depth"], scale=course["scale"], course_style=course.get("courseStyle") or "none",
    )
    if request.learning_goal_id:
        context = await asyncio.to_thread(
            GoalContextService(get_settings()).build, principal.user_id, request.learning_goal_id,
        )
    else:
        learner = await asyncio.to_thread(directory().load_primary_learner, principal.user_id)
        if learner:
            request.learner_id = UUID(learner["id"])
            context = await _learner_course_context(principal.user_id, request.learner_id) or {}
        else:
            context = await asyncio.to_thread(
                GoalContextService(get_settings()).build, principal.user_id, None,
            )
    if not await asyncio.to_thread(store.restart, course_id, principal.user_id):
        raise HTTPException(status_code=409, detail="Course is no longer retryable")
    task = _enqueue_generation(_generate_course(course_id, principal.user_id, request, context))
    _course_tasks[course_id] = task
    task.add_done_callback(lambda _task, key=course_id: _course_tasks.pop(key, None))
    updated = await asyncio.to_thread(store.get, course_id, principal.user_id)
    return updated


@router.get("/course-progress")
async def get_course_progress(
    learner_id: UUID | None = Query(default=None, alias="learnerId"),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    await asyncio.to_thread(learning_resource_store().ensure_schema)
    await asyncio.to_thread(presentation_store().ensure_schema)
    progress = await asyncio.to_thread(course_store().progress, principal.user_id, learner_id)
    if progress is None:
        return {"total": 0, "completed": 0, "percent": 0}
    return progress

@router.get("/courses")
async def list_courses(
    learner_id: UUID | None = Query(default=None, alias="learnerId"),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    courses = await asyncio.to_thread(course_store().list, principal.user_id, learner_id)
    return {"courses": [await _enrich_course_presentation_status(course, principal.user_id)
                        for course in courses]}


@router.get("/courses/{course_id}")
async def get_course(course_id: UUID,
                     principal: InternalPrincipal = Depends(require_user_principal)):
    course = await asyncio.to_thread(course_store().get, course_id, principal.user_id)
    if course is None:
        raise HTTPException(status_code=404, detail="Course not found")
    return await _enrich_course_presentation_status(course, principal.user_id)


@router.put("/courses/{course_id}")
async def update_course_meta(
    course_id: UUID, request: CourseUpdateRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    updated = await asyncio.to_thread(
        course_store().update_course_meta, course_id, principal.user_id, request.title, request.description,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Course not found")
    return await _enrich_course_presentation_status(updated, principal.user_id)


@router.put("/courses/{course_id}/chapters/{chapter_id}")
async def update_course_chapter_meta(
    course_id: UUID, chapter_id: UUID, request: CourseChapterUpdateRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    updated = await asyncio.to_thread(
        course_store().update_chapter_meta, course_id, chapter_id, principal.user_id,
        request.title, request.summary,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Course chapter not found")
    return await _enrich_course_presentation_status(updated, principal.user_id)


@router.post("/courses/{course_id}/chapters/{chapter_id}/resources/{resource_type}/retry",
             status_code=status.HTTP_202_ACCEPTED)
async def retry_course_chapter_resource(
    course_id: UUID, chapter_id: UUID, resource_type: str,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    if resource_type not in {"ppt", "lecture", "practice", "quiz"}:
        raise HTTPException(status_code=422, detail="Invalid resource type")
    store = course_store()
    course = await asyncio.to_thread(store.get, course_id, principal.user_id)
    if course is None:
        raise HTTPException(status_code=404, detail="Course not found")
    course = await _enrich_course_presentation_status(course, principal.user_id)
    chapter = next((item for item in course.get("chapters", []) if item["id"] == str(chapter_id)), None)
    if chapter is None:
        raise HTTPException(status_code=404, detail="Course chapter not found")
    if course.get("resourceTypes") and resource_type not in course.get("resourceTypes", []):
        raise HTTPException(status_code=422, detail="Resource type is not enabled for this course")
    current = (chapter.get("resources") or {}).get(resource_type) or {}
    if current.get("status") not in {None, "failed", "cancelled", "queued", "generating"}:
        raise HTTPException(status_code=409, detail="Only failed resources can be regenerated")
    active_course = _course_tasks.get(course_id)
    if active_course and not active_course.done():
        raise HTTPException(status_code=409, detail="Wait for course generation to finish before retrying a resource")
    retry_key = (course_id, chapter_id, resource_type)
    active_retry = _course_resource_retry_tasks.get(retry_key)
    if active_retry and not active_retry.done():
        raise HTTPException(status_code=409, detail="Resource regeneration is already running")

    request = CourseCreateRequest(
        prompt=course.get("prompt") or "", learning_goal_id=course.get("learningGoalId"),
        learning_goal_ids=course.get("learningGoalIds") or [], resource_types=[resource_type],
        depth=course["depth"], scale=course["scale"], course_style=course.get("courseStyle") or "none",
    )
    context = await asyncio.to_thread(
        GoalContextService(get_settings()).build, principal.user_id, request.learning_goal_id,
    )
    resources = dict(chapter.get("resources") or {})
    resources[resource_type] = {"status": "queued", "progress": 0, "title": current.get("title")}
    await asyncio.to_thread(store.update_chapter, course_id, chapter_id, "generating", 5, resources)
    task = _enqueue_generation(_generate_course(course_id, principal.user_id, request, context, {chapter_id}))
    _course_resource_retry_tasks[retry_key] = task
    task.add_done_callback(lambda _task, key=retry_key: _course_resource_retry_tasks.pop(key, None))
    updated = await asyncio.to_thread(store.get, course_id, principal.user_id)
    return await _enrich_course_presentation_status(updated, principal.user_id)


@router.delete("/courses/{course_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_course(course_id: UUID,
                        principal: InternalPrincipal = Depends(require_user_principal)):
    task = _course_tasks.get(course_id)
    if task and not task.done():
        task.cancel()
    for key, retry_task in list(_course_resource_retry_tasks.items()):
        if key[0] == course_id and not retry_task.done():
            retry_task.cancel()
            _course_resource_retry_tasks.pop(key, None)
    if not await asyncio.to_thread(course_store().delete, course_id, principal.user_id):
        raise HTTPException(status_code=404, detail="Course not found")


@router.get("/learning-resources")
async def list_learning_resources(
    request: Request,
    resource_type: str | None = None,
    include_course: bool = False,
    learner_id: UUID | None = Query(default=None, validation_alias=AliasChoices("learner_id", "learnerId")),
    kp_id: str | None = Query(default=None, max_length=64, validation_alias=AliasChoices("kp_id", "kpId")),
    form: str | None = Query(default=None, validation_alias=AliasChoices("form", "form")),
    level: str | None = Query(default=None, validation_alias=AliasChoices("level", "level")),
    course_id: UUID | None = Query(default=None, alias="courseId"),
    chapter_id: UUID | None = Query(default=None, alias="chapterId"),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    if resource_type not in {None, "lecture", "practice", "quiz"}:
        raise HTTPException(status_code=422, detail="Invalid resource type")
    resources = await asyncio.to_thread(
        learning_resource_store().list, principal.user_id, resource_type, include_course or course_id is not None or chapter_id is not None,
        learner_id, kp_id, form, level, course_id, chapter_id,
    )
    return _etag_json({"resources": resources}, request, "res")


@router.post("/learning-resources/{resource_id}/regenerate", status_code=status.HTTP_202_ACCEPTED)
async def regenerate_learning_resource(
    resource_id: UUID,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    store = learning_resource_store()
    resource = await asyncio.to_thread(store.get, resource_id, principal.user_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="Learning resource not found")
    kind = resource.get("type")
    content = resource.get("content") or {}
    payload = {
        "topic": resource.get("topic") or "", "title": resource.get("title") or "",
        "detail_level": "balanced",
        "question_count": max(6, len(content.get("questions") or []) or 15),
    }
    context = await asyncio.to_thread(
        GoalContextService(get_settings()).build, principal.user_id, resource.get("learningGoalId"),
    )
    service = LearningContentService(get_settings())
    try:
        if kind == "quiz":
            candidates = await asyncio.to_thread(store.knowledge_point_candidates, payload["topic"])
            content, sources, state, decision = await service.generate_quiz(payload, candidates, context)
        elif kind == "practice":
            content, sources, decision = await service.generate_practice(payload, context)
            state = None
        else:
            content, sources, decision = await service.generate_lecture(payload, context)
            state = None
    finally:
        await service.close()
    payload["title"] = str(content.get("title") or payload["title"])[:160]
    version = str(resource.get("version") or "v1")
    version = f"v{max(2, int(version[1:]) + 1)}" if version.startswith("v") and version[1:].isdigit() else "v2"
    created = await asyncio.to_thread(
        store.create, principal.user_id, kind, payload, content, sources, state, context, decision,
        None, None, resource.get("learnerId"), resource.get("kpId"), resource.get("form"),
        resource.get("level"), version, resource.get("quizIds") or [], resource.get("kbRefs") or [],
    )
    return _public_quiz(created)


@router.get("/learning-context")
async def get_goal_driven_context(
    learning_goal_id: UUID | None = None,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    return await asyncio.to_thread(
        GoalContextService(get_settings()).build, principal.user_id, learning_goal_id,
    )


class MemoryContextRequest(BaseModel):
    scene: str
    scope: dict = {}
    taskId: str | None = None


class MemoryUpsertRequest(BaseModel):
    namespace: str
    key: str
    scope: dict = {}
    value: dict
    summary: str


@router.get("/memories")
async def list_user_memories(
    namespace: str | None = None,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    service = user_memory_service()
    await asyncio.to_thread(service.bootstrap_profile, principal.user_id)
    items = await asyncio.to_thread(service.store.list, principal.user_id, namespace)
    return {"items": items}


@router.post("/memory/context")
async def get_user_memory_context(
    request: MemoryContextRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    return await asyncio.to_thread(
        user_memory_service().get_context,
        principal.user_id, request.scene, request.scope, request.taskId,
    )


@router.put("/memories")
async def upsert_user_memory(
    request: MemoryUpsertRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    if request.namespace not in {"profile", "goal", "preference"}:
        raise HTTPException(status_code=422, detail="Only profile, goal and preference memories can be edited")
    learner_id = await asyncio.to_thread(user_memory_service().store.primary_learner_id, principal.user_id)
    return await asyncio.to_thread(
        user_memory_service().store.upsert,
        principal.user_id, learner_id, request.namespace, request.key,
        request.scope, request.value, request.summary, "user_declared", 1.0, .9,
    )


_SIX_ABILITY_DIMS = ("kp-ds", "kp-co", "kp-os", "kp-network", "kp-db", "kp-agent")


def _parse_profile_scores(text: str, current: dict) -> dict:
    """从画像分析文本里提取六维分数；解析不到时原样返回当前分数。

    模型被要求在结尾单独输出一行 JSON（见提示词），优先按 JSON 解析；
    解析失败时退化为「维度字段 + 新分数」的正则，避免把「应用更新」写成空操作。
    """
    import json as _json
    import re as _re

    merged: dict = {
        str(key): int(value)
        for key, value in (current or {}).items()
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    }

    def _apply(data: dict) -> bool:
        changed = False
        for dim in _SIX_ABILITY_DIMS:
            if dim not in data:
                continue
            try:
                value = int(round(float(data[dim])))
            except (TypeError, ValueError):
                continue
            merged[dim] = max(0, min(100, value))
            changed = True
        return changed

    for block in reversed(_re.findall(r"\{[^{}]*\}", text or "")):
        try:
            parsed = _json.loads(block)
        except (TypeError, ValueError):
            continue
        if isinstance(parsed, dict) and _apply(parsed):
            return merged

    for dim in _SIX_ABILITY_DIMS:
        match = _re.search(
            rf"{_re.escape(dim)}[^0-9]{{0,24}}\d{{1,3}}[^0-9]{{0,10}}"
            rf"(?:→|->|调整为|建议为|建议|改为)[^0-9]{{0,10}}(\d{{1,3}})",
            text or "",
        ) or _re.search(rf"{_re.escape(dim)}[^0-9]{{0,24}}(\d{{1,3}})", text or "")
        if not match:
            continue
        merged[dim] = max(0, min(100, int(match.group(1))))
    return merged


@router.get("/memory/profile-analysis")
async def stream_profile_analysis(
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """SSE stream: analyze user profile based on recent memories, propose six-dimension adjustments."""
    import json as _json

    async def stream():
        # 1. Check for recent memories (last 24h)
        def recent_memories():
            service = user_memory_service()
            service.bootstrap_profile(principal.user_id)
            all_memories = service.store.list(principal.user_id)
            from datetime import datetime, timedelta
            cutoff = datetime.utcnow() - timedelta(hours=24)
            recent = []
            for m in all_memories:
                updated = m.get("updatedAt") or m.get("createdAt") or ""
                if updated and updated >= cutoff.isoformat():
                    recent.append(m)
            return recent, all_memories

        recent, all_memories = await asyncio.to_thread(recent_memories)
        if not recent:
            payload = _json.dumps({"type": "no_data", "message": "最近24小时内没有新的学习数据"}, ensure_ascii=False)
            yield f"data: {payload}\n\n"
            return

        # 2. Load current scores
        def load_scores():
            with platform_connect(get_settings()) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT scores_json, goal, blind_spots_json FROM learners WHERE user_id=%s AND status=1 LIMIT 1",
                                   (principal.user_id.bytes,))
                    row = cursor.fetchone()
                    if not row:
                        return {}, "", []
                    import json as _j
                    scores = _j.loads(row["scores_json"]) if row["scores_json"] else {}
                    blind = _j.loads(row["blind_spots_json"]) if row["blind_spots_json"] else []
                    return scores, str(row.get("goal") or ""), blind

        current_scores, goal, blind_spots = await asyncio.to_thread(load_scores)

        # 3. Build analysis prompt
        nl = "\n"
        memory_lines = []
        for m in recent[:15]:
            conf = round(m.get("confidence", 0) * 100)
            memory_lines.append(f"- [{m['namespace']}] {m['summary']} (可信度{conf}%)")
        memory_text = nl.join(memory_lines)

        scores_str = _json.dumps(current_scores, ensure_ascii=False)
        blind_str = _json.dumps(blind_spots, ensure_ascii=False)
        prompt = (
            "你是学习画像分析助手。根据用户最近的学习记忆，分析其六维能力变化。" + nl + nl
            + f"当前六维分数：{scores_str}" + nl
            + f"学习目标：{goal}" + nl
            + f"当前盲区：{blind_str}" + nl + nl
            + f"最近24小时的学习记忆：{nl}{memory_text}" + nl + nl
            + "六个维度及字段名：知识理解(kp-ds)、逻辑推理(kp-co)、工程实践(kp-os)、"
            + "问题诊断(kp-network)、系统设计(kp-db)、学习迁移(kp-agent)。" + nl
            + "请逐项说明是否有变化依据，如果有，给出更新后的分数（0-100 的整数）和理由；"
            + "没有依据的维度保持当前分数。" + nl
            + "最后必须单独输出一行 JSON（不要代码围栏、不要其他文字），包含全部六个字段，例如："
            + '{"kp-ds":54,"kp-co":48,"kp-os":51,"kp-network":51,"kp-db":50,"kp-agent":49}。'
            + "用中文回答。"
        )

        # 4. Stream LLM analysis
        from app.llm import LLMClient
        llm = LLMClient(get_settings())
        full_reply = []
        try:
            async for event in llm.stream_chat(
                [{"role": "system", "content": "你是学习画像分析师。只基于提供的记忆数据分析，不编造。"},
                 {"role": "user", "content": prompt}],
                provider="mimo",
            ):
                if event.get("type") == "content":
                    text = event.get("text", "")
                    full_reply.append(text)
                    evt = _json.dumps({"type": "delta", "content": text}, ensure_ascii=False)
                    yield f"data: {evt}\n\n" 
        except Exception as exc:
            evt = _json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False)
            yield f"data: {evt}\n\n"
            return

        # 5. Parse the six scores from the analysis (best-effort)
        analysis_text = "".join(full_reply)
        proposed_scores = _parse_profile_scores(analysis_text, current_scores)
        evt = _json.dumps({"type": "done", "analysis": analysis_text, "currentScores": proposed_scores}, ensure_ascii=False)
        yield f"data: {evt}\n\n" 

    from starlette.responses import StreamingResponse
    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class ProfileScoreRequest(BaseModel):
    name: str = ""
    tag: str = ""
    education: str = ""
    targetJob: str = ""
    targetCategoryCode: str | None = None
    method: str = "quick"
    background: str = ""
    selfLevels: dict[str, int] | None = None
    answers: list[dict[str, Any]] | None = None


_PROFILE_DIMENSIONS = {
    "kp-ds": "知识理解：解释智能体/LLM/RAG等概念、术语和原理的能力",
    "kp-co": "逻辑推理：梳理条件、流程、工具调用和多智能体协作中的逻辑与异常分支",
    "kp-os": "工程实践：编程、调试、测试、交付，使用平台或框架实现真实任务",
    "kp-network": "问题诊断：定位报错、检索失败、上下文问题、性能下降和结果归因",
    "kp-db": "系统设计：面对记忆、数据、接口、并发和可靠性需求做系统拆分与技术选型",
    "kp-agent": "学习迁移：面对新场景/新工具/新框架，能迁移已有经验并较快形成方案",
}


@router.post("/profile/llm-score")
async def llm_profile_score(
    request: ProfileScoreRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """LLM-generated six-dimension starting profile from user background.

    This endpoint intentionally does not use prior-table scoring rules.  It hands
    the user's real background/job/answers to the model and asks for a structured,
    evidence-backed profile.  The frontend keeps deterministic fallback only when
    the model is unavailable.
    """
    from app.llm import LLMClient

    if not request.tag and not request.education and not request.background:
        raise HTTPException(status_code=422, detail="缺少建档信息")

    dimension_lines = "\n".join(
        f"- {code} {label}" for code, label in _PROFILE_DIMENSIONS.items()
    )
    background = str(request.background or "").strip()
    if not background:
        background = (
            f"身份：{request.tag or '未说明'}；学历：{request.education or '未说明'}；"
            f"目标岗位：{request.targetJob or '未说明'}。"
        )

    evidence = [f"身份：{request.tag or ''}", f"学历：{request.education or ''}", f"目标：{request.targetJob or ''}"]
    if background:
        evidence.append(f"自述：{background}")
    if request.selfLevels:
        evidence.append(f"自评：{json.dumps(request.selfLevels, ensure_ascii=False)}")
    answer_count = len(request.answers or [])
    if answer_count:
        evidence.append(f"已作答数：{answer_count}")

    prompt = (
        "你是学习画像分析师。请只依据用户给出的背景、自评或作答信息推断六维能力起点，不要编造未出现的经验。\n"
        "六维含义如下：\n"
        f"{dimension_lines}\n\n"
        f"用户建档方法：{request.method or 'quick'}\n"
        f"用户信息：\n{chr(10).join(evidence)}\n\n"
        "请返回严格 JSON：\n"
        "{\n"
        '  "scores": {"kp-ds": 0-100, "kp-co": 0-100, "kp-os": 0-100, "kp-network": 0-100, "kp-db": 0-100, "kp-agent": 0-100},\n'
        '  "confidence": 0-100,\n'
        '  "reasoning": {"kp-ds": "简要依据", ...},\n'
        '  "blindSpots": ["最弱维度名1", "最弱维度名2"],\n'
        '  "goal": "一句话学习目标",\n'
        '  "diagnosisSummary": "面向学习者的画像摘要，不得暴露后台字段",\n'
        '  "recommendation": {"entry": "ch1-intro 或更合适的章节code", "difficulty": "basic|advanced|challenge"}\n'
        "}\n"
        "盲区必须从六维名称中选。分数需要有据可依：如果信息不足，倾向中低分数并降低 confidence。"
    )

    fallback = {
        "scores": {},
        "confidence": 33,
        "reasoning": {},
        "blindSpots": [],
        "goal": "",
        "diagnosisSummary": "",
        "recommendation": {"entry": "ch1-intro", "difficulty": "basic"},
    }
    llm = LLMClient(get_settings())
    try:
        result = await llm.complete_json(
            "你是学习画像分析师，只输出合法 JSON。",
            prompt,
            fallback,
            provider="mimo",
            max_tokens=4096,
            thinking=False,
            timeout_seconds=90,
        )
    except Exception:
        result = fallback

    raw_scores = result.get("scores") if isinstance(result.get("scores"), dict) else {}
    scores: dict[str, int] = {}
    for code in ("kp-ds", "kp-co", "kp-os", "kp-network", "kp-db", "kp-agent"):
        try:
            scores[code] = max(12, min(96, round(float(raw_scores.get(code) or 50))))
        except (TypeError, ValueError):
            scores[code] = 50
    confidence = result.get("confidence")
    try:
        confidence = max(25, min(90, int(float(confidence or 33))))
    except (TypeError, ValueError):
        confidence = 33

    reasoning = result.get("reasoning") if isinstance(result.get("reasoning"), dict) else {}
    blind = result.get("blindSpots") if isinstance(result.get("blindSpots"), list) else []
    blind_spots = [str(item) for item in blind if str(item).strip()][:3]
    recommendation = result.get("recommendation") if isinstance(result.get("recommendation"), dict) else {}
    return {
        "scores": scores,
        "confidence": confidence,
        "reasoning": reasoning,
        "blindSpots": blind_spots,
        "goal": str(result.get("goal") or "").strip(),
        "diagnosisSummary": str(result.get("diagnosisSummary") or "").strip(),
        "recommendation": recommendation,
    }


class ScoreUpdateRequest(BaseModel):
    scores: dict[str, int]


@router.put("/learners/scores")
async def update_learner_scores(
    request: ScoreUpdateRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """Update the six-dimension scores for the current user's primary learner."""
    def _update():
        service = user_memory_service()
        learner_id = service.store.primary_learner_id(principal.user_id)
        if learner_id is None:
            return False
        import json as _json
        # Validate scores: must be int 0-100
        clean = {}
        for k, v in request.scores.items():
            try:
                clean[str(k)] = max(0, min(100, int(v)))
            except (TypeError, ValueError):
                continue
        if not clean:
            return False
        with platform_connect(get_settings()) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE learners SET scores_json=%s, updated_at=NOW(6) WHERE id=%s AND user_id=%s",
                    (_json.dumps(clean, ensure_ascii=False), learner_id.bytes, principal.user_id.bytes),
                )
            connection.commit()
        return True

    ok = await asyncio.to_thread(_update)
    if not ok:
        raise HTTPException(status_code=404, detail="Learner not found or no valid scores")
    return {"ok": True}


@router.delete("/memories/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user_memory(
    memory_id: UUID,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    deleted = await asyncio.to_thread(user_memory_service().store.delete, memory_id, principal.user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Memory not found")


@router.get("/course-recommendations")
async def list_course_recommendations(
    limit: int = Query(20, ge=1, le=50),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """Lightweight recent course-resource candidates for the home dock."""
    candidates: list[dict] = []
    with platform_connect(get_settings()) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT id, resource_type, title, course_id, chapter_id, updated_at "
                "FROM generated_learning_resources "
                "WHERE archived_at IS NULL AND resource_scope='USER' AND (user_id=%s OR is_public=1) AND course_id IS NOT NULL "
                "ORDER BY updated_at DESC LIMIT %s",
                (principal.user_id.bytes, limit),
            )
            for row in cursor.fetchall():
                candidates.append({
                    "type": row["resource_type"], "id": str(UUID(bytes=row["id"])), "title": row["title"],
                    "courseId": str(UUID(bytes=row["course_id"])) if row.get("course_id") else None,
                    "chapterId": str(UUID(bytes=row["chapter_id"])) if row.get("chapter_id") else None,
                    "updatedAt": row["updated_at"].isoformat(),
                })
            cursor.execute(
                "SELECT id, title, updated_at FROM presentation_tasks "
                "WHERE archived_at IS NULL AND resource_scope='USER' AND (user_id=%s OR is_public=1) AND status='completed' "
                "ORDER BY updated_at DESC LIMIT %s",
                (principal.user_id.bytes, limit),
            )
            for row in cursor.fetchall():
                candidates.append({
                    "type": "ppt", "id": str(UUID(bytes=row["id"])), "title": row["title"] or "最近的 PPT",
                    "courseId": None, "chapterId": None, "updatedAt": row["updated_at"].isoformat(),
                })
    candidates.sort(key=lambda item: item["updatedAt"], reverse=True)
    return {"candidates": candidates[:limit]}


@router.get("/learning-resources/{resource_id}")
async def get_learning_resource(resource_id: UUID,
                                principal: InternalPrincipal = Depends(require_user_principal)):
    resource = await asyncio.to_thread(learning_resource_store().get, resource_id, principal.user_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="Learning resource not found")
    return _public_quiz(resource)


@router.get("/learning-resources/{resource_id}/traceability")
async def get_learning_resource_traceability(
    resource_id: UUID,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    resource = await asyncio.to_thread(learning_resource_store().get, resource_id, principal.user_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="Learning resource not found")
    return {"items": _build_traceability(resource)}


@router.post("/learning-resources/{resource_id}/complete")
async def complete_learning_resource(resource_id: UUID,
                                     principal: InternalPrincipal = Depends(require_user_principal)):
    updated = await asyncio.to_thread(
        learning_resource_store().mark_learned, resource_id, principal.user_id,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Learning resource not found")
    await _record_memory_event(
        principal.user_id, "resource_completed", "learning_resource", str(resource_id),
        {"kpId": updated.get("kpId"), "resourceType": updated.get("type")},
        {"kpId": updated.get("kpId"), "resourceType": updated.get("type"),
         "title": updated.get("title"), "progress": 1.0},
    )
    return {"learned": True, "resource": _public_quiz(updated)}


@router.patch("/learning-resources/{resource_id}/progress")
async def update_learning_resource_progress(
    resource_id: UUID,
    request: LearningResourceProgressRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    updated = await asyncio.to_thread(
        learning_resource_store().update_progress,
        resource_id,
        principal.user_id,
        request.model_dump(by_alias=False),
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Learning resource not found")
    await _record_memory_event(
        principal.user_id, "resource_progress", "learning_resource", str(resource_id),
        {"kpId": updated.get("kpId"), "resourceType": updated.get("type")},
        {"kpId": updated.get("kpId"), "resourceType": updated.get("type"),
         "progress": updated.get("progressRatio", 0)},
    )
    return {"resource": _public_quiz(updated)}


@router.post("/learning-resources/{resource_id}/source-feedback", status_code=status.HTTP_201_CREATED)
async def create_learning_resource_source_feedback(
    resource_id: UUID,
    request: LearningResourceSourceFeedbackRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    feedback = await asyncio.to_thread(
        learning_resource_store().create_source_feedback,
        resource_id,
        principal.user_id,
        request.model_dump(by_alias=False),
    )
    if feedback is None:
        raise HTTPException(status_code=404, detail="Learning resource not found")
    return {"feedback": feedback}

@router.post("/learning-resources/batch-delete")
async def batch_delete_learning_resources(payload: dict,
                                          principal: InternalPrincipal = Depends(require_user_principal)):
    raw_ids = payload.get("resourceIds") if isinstance(payload, dict) else None
    if not isinstance(raw_ids, list) or not raw_ids or len(raw_ids) > 100:
        raise HTTPException(status_code=422, detail="resourceIds must contain 1 to 100 items")
    try:
        resource_ids = list(dict.fromkeys(UUID(str(value)) for value in raw_ids))
    except (TypeError, ValueError, AttributeError) as exc:
        raise HTTPException(status_code=422, detail="Invalid resource id") from exc
    deleted = await asyncio.to_thread(
        learning_resource_store().batch_delete, resource_ids, principal.user_id,
    )
    return {"deleted": deleted, "count": len(deleted)}


async def _run_learning_resource_generation(task_id: UUID, user_id: UUID, kind: str,
                                            request: LearningResourceCreateRequest) -> None:
    task_store = resource_generation_task_store()

    async def emit(status: str, progress: int, agent: str, title: str, detail: str,
                   snapshot: dict | None = None) -> None:
        new_event = await asyncio.to_thread(task_store.update, task_id, user_id, status, progress, title,
                                    agent=agent, title=title, detail=detail, snapshot=snapshot)
        if new_event:
            _spawn_event_summary("resource", task_id, int(new_event["seq"]), InternalPrincipal(user_id))

    async def emit_terminal(status: str, progress: int, stage: str, agent: str, title: str,
                            detail: str = "", resource_id: UUID | None = None, error: str | None = None,
                            snapshot: dict | None = None) -> None:
        new_event = await asyncio.to_thread(
            task_store.update, task_id, user_id, status, progress, stage,
            agent=agent, title=title, detail=detail, resource_id=resource_id, error=error,
            snapshot=snapshot,
        )
        if new_event:
            _spawn_event_summary("resource", task_id, int(new_event["seq"]), InternalPrincipal(user_id))

    # 生成链路中的瞬时异常（模型超时、返回 JSON 截断、返回结构异常）不应直接
    # 变成给用户的失败结论：整条链路会自动重跑，最多 3 次尝试，不会无限重试。
    max_attempts = 3
    non_retryable_markers = (
        "质量核验多轮修订后仍未通过", "分阶题质量门未通过", "没有可溯源知识库切片",
        "未找到可溯源资料", "知识服务连接", "无法生成分阶测试题",
    )

    def is_retryable(exc: Exception) -> bool:
        message = str(exc)
        if any(marker in message for marker in non_retryable_markers):
            return False
        return not (message.startswith("第 ") and "题多轮修订仍未通过" in message)

    def retry_reason(exc: Exception) -> str:
        message = str(exc)
        if "无可用内容" in message:
            return "模型多轮未返回可用内容"
        if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
            return "模型响应超时"
        if isinstance(exc, json.JSONDecodeError):
            return "模型返回内容格式异常"
        if isinstance(exc, (AttributeError, TypeError, KeyError, IndexError, ValueError)):
            return "生成结果结构异常"
        if isinstance(exc, OSError):
            return "依赖服务连接异常"
        return "生成链路出现瞬时异常"

    async def generate_with_retry() -> tuple[dict, list[dict], dict, dict]:
        last_error: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            try:
                return await team.generate(kind, payload, context, emit, candidates, user_id=user_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                last_error = exc
                logger.warning("Learning resource generation attempt %d/%d failed: %s",
                               attempt, max_attempts, exc, exc_info=True)
                if attempt >= max_attempts or not is_retryable(exc):
                    raise
                reason = retry_reason(exc)
                await emit(
                    "generating", 46, "orchestrator",
                    f"{reason}，正在自动重试（第 {attempt + 1}/{max_attempts} 次）",
                    "本次异常已自动忽略，正在重新执行检索、生成与核验，无需人工干预",
                    {"activity": "自动重试生成链路", "attempt": attempt + 1,
                     "retryReason": reason, "decision": "retry"},
                )
                await asyncio.sleep(min(2 * attempt, 6))
        assert last_error is not None  # pragma: no cover - the loop always raises
        raise last_error

    team = ResourceGenerationTeam(get_settings())
    initial_state = await asyncio.to_thread(task_store.stream_state, task_id, user_id)
    if initial_state and initial_state.get("events"):
        _spawn_event_summary("resource", task_id, 1, InternalPrincipal(user_id))
    try:
        payload = request.model_dump()
        generation_context = request.generation_context or {}
        admin_generation = generation_context.get("adminGeneration") is True
        persisted_resource_id: UUID | None = None

        async def archive_replaced_resource(resource_id: UUID) -> None:
            """Best-effort housekeeping must never turn an approved resource into a failed task."""
            if not (admin_generation and generation_context.get("regenerate")):
                return
            last_error: Exception | None = None
            for delay in (0, 1, 3):
                if delay:
                    await asyncio.sleep(delay)
                try:
                    await asyncio.to_thread(
                        learning_resource_store().archive_previous_for_group,
                        str(generation_context.get("domainCode") or ""),
                        str(generation_context.get("nodeCode") or ""),
                        str(generation_context.get("groupName") or "默认分组"),
                        kind, resource_id,
                    )
                    return
                except Exception as exc:
                    last_error = exc
                    logger.warning("Archiving replaced resource failed; retrying", exc_info=True)
            await emit(
                "judging", 99, "judge", "旧版本整理将在后台重试",
                "新资源已经通过审核并成功保存；旧版本归档暂时未完成，不影响本次交付",
                {"activity": "已保存新资源，等待后台整理旧版本", "decision": "pass"},
            )
            logger.error("Approved resource persisted but old-version archive did not finish: %s", last_error)
        if admin_generation:
            generic_topic = request.topic or "通用课程资源"
            context = {
                "mode": "institution_master", "profile": {}, "mastery": {},
                "goal": {"title": generic_topic, "description": "形成可审核、可复用的机构通用资源母版"},
                "recommendation": {"topic": generic_topic, "questionCount": 15},
                "resourceGroup": "默认分组",
            }
            payload["generation_mode"] = "admin_master"
            resolved_group = await asyncio.to_thread(
                resolve_resource_group, get_settings(),
                str(generation_context.get("domainCode") or ""), str(generation_context.get("nodeCode") or ""),
                str(generation_context.get("groupName") or ""),
            )
            generation_context = dict(generation_context)
            generation_context["groupName"] = resolved_group
            payload["generation_context"] = generation_context
            context["resourceGroup"] = resolved_group
        else:
            context = await asyncio.to_thread(
                GoalContextService(get_settings()).build, user_id, request.learning_goal_id,
            )
            payload["generation_mode"] = "learner_adaptive"
        topic = request.topic or context["recommendation"]["topic"]
        payload["topic"] = topic
        payload["detail_level"] = "detailed"
        if kind == "quiz":
            # 机构通用题库固定按基础/进阶/挑战三批、每批 5 题生成。
            payload["question_count"] = 15
        payload["title"] = request.title or (
            topic[:80] if kind == "lecture" else f"{topic[:70]}实操指南" if kind == "practice" else f"{topic[:70]}分阶测试"
        )
        # All resource types need the MySQL knowledge-map path. Lectures use it
        # to pre-read the owning RAGFlow chapter before topic-level retrieval.
        candidates = await asyncio.to_thread(learning_resource_store().knowledge_point_candidates, topic)
        checkpoint_state = await asyncio.to_thread(task_store.load_checkpoint, task_id, user_id)
        resume_payload = (checkpoint_state or {}).get("payload") or {}
        resume_stage = (checkpoint_state or {}).get("stage") or "created"
        current_task = await asyncio.to_thread(task_store.stream_state, task_id, user_id)
        if current_task and current_task.get("resourceId"):
            persisted_resource_id = UUID(current_task["resourceId"])
        if persisted_resource_id is None and resume_payload.get("resourceId"):
            persisted_resource_id = UUID(str(resume_payload["resourceId"]))
        if resume_stage in {"release_ready", "resource_created", "promoted"} and resume_payload.get("content"):
            content, sources, state, decision = (
                resume_payload["content"], resume_payload["sources"],
                resume_payload.get("state") or {}, resume_payload.get("decision") or {},
            )
        else:
            content, sources, state, decision = await generate_with_retry()
            await asyncio.to_thread(task_store.save_checkpoint, task_id, user_id, "release_ready", {
                "content": content, "sources": sources, "state": state, "decision": decision,
                "payload": payload,
            })
        payload["title"] = str(content.get("title") or payload["title"])[:160]
        if persisted_resource_id is None:
            resource = await asyncio.to_thread(
                learning_resource_store().create, user_id, kind, payload, content, sources, state,
                context, decision, None, None, request.learner_id, request.kp_id, request.form,
                request.level, request.version, request.quiz_ids, request.kb_refs, task_id=task_id,
            )
            persisted_resource_id = UUID(resource["id"])
            await asyncio.to_thread(task_store.save_checkpoint, task_id, user_id, "resource_created", {
                "content": content, "sources": sources, "state": state, "decision": decision,
                "payload": payload, "resourceId": str(persisted_resource_id),
            })
        if admin_generation and resume_stage != "promoted":
            await asyncio.to_thread(
                learning_resource_store().promote_admin_generation,
                persisted_resource_id, user_id,
                str(generation_context.get("domainCode") or ""),
                str(generation_context.get("nodeCode") or ""),
            )
            await archive_replaced_resource(persisted_resource_id)
            await asyncio.to_thread(task_store.save_checkpoint, task_id, user_id, "promoted", {
                "content": content, "sources": sources, "state": state, "decision": decision,
                "payload": payload, "resourceId": str(persisted_resource_id),
            })
        await emit_terminal(
            "completed", 100, "资源已通过审查", "orchestrator", "生成完成",
            detail="内容、引用与目标要求对齐均已通过质量门槛", resource_id=persisted_resource_id,
        )
    except asyncio.CancelledError:
        await emit_terminal("cancelled", 100, "任务已取消", "orchestrator", "任务取消")
        raise
    except Exception as exc:
        logger.exception("Learning resource team generation failed")
        # A resource written during a failed generation must not remain in the
        # database as an orphan file. Remove the just-created USER-scope row.
        if persisted_resource_id is not None and admin_generation:
            try:
                await asyncio.to_thread(
                    learning_resource_store().batch_delete,
                    [persisted_resource_id], user_id,
                )
                logger.info("Removed failed admin generation resource %s", persisted_resource_id)
            except Exception as cleanup_exc:
                logger.warning("Failed to clean up resource %s after generation error: %s",
                               persisted_resource_id, cleanup_exc)
        if kind in {"quiz", "lecture", "practice"}:
            # 面向用户只给可操作的结论，技术原因留在日志与事件快照里供排查。
            technical_cause = f"{type(exc).__name__}: {str(exc)[:200]}"
            quality_blocked = str(exc).startswith((
                "质量核验多轮修订后仍未通过", "分阶题质量门未通过",
            )) or (str(exc).startswith("第 ") and "题多轮修订仍未通过" in str(exc))
            retrieval_blocked = any(token in str(exc) for token in (
                "没有可溯源知识库切片", "未找到可溯源资料", "知识服务连接", "无法生成分阶测试题",
            ))
            if quality_blocked or retrieval_blocked:
                message = ("内容与知识依据仍未完全对齐，本次生成已停止；请补充或更换该知识点的资料后重新生成"
                           if quality_blocked else
                           "未能取得可用的知识依据，本次生成已停止；请确认该知识点资料已入库后重新生成")
                await emit_terminal(
                    "failed", 100,
                    "多轮自主修复后仍需补充依据" if quality_blocked else "知识检索未完成",
                    "citation_verifier" if quality_blocked else "retrieval",
                    "质量门受控终止" if quality_blocked else "知识检索未完成",
                    detail=message, error=message,
                    snapshot={"technicalCause": technical_cause, "failureKind": "quality" if quality_blocked else "retrieval"},
                )
                return
            if kind == "quiz":
                message = "模型多轮生成仍未形成可用题目，请稍后重新生成"
                await emit_terminal(
                    "failed", 100, "分阶题生成失败", "judge", "模型生成未完成",
                    detail=message, error=message,
                    snapshot={"technicalCause": technical_cause, "failureKind": "quiz"},
                )
                return
        logger.warning("Delivering emergency fallback for non-quiz resource")
        try:
            content, state, decision = team.service.emergency_fallback(kind, payload, candidates)
            payload["title"] = str(content.get("title") or payload["title"])[:160]
            resource = await asyncio.to_thread(
                learning_resource_store().create, user_id, kind, payload, content, [], state,
                context, decision, None, None, request.learner_id, request.kp_id, request.form,
                request.level, request.version, request.quiz_ids, request.kb_refs,
            )
            if generation_context.get("adminGeneration") is True:
                await asyncio.to_thread(
                    learning_resource_store().promote_admin_generation,
                    UUID(resource["id"]), user_id,
                    str(generation_context.get("domainCode") or ""),
                    str(generation_context.get("nodeCode") or ""),
                )
                await archive_replaced_resource(UUID(resource["id"]))
            await emit_terminal(
                "completed", 100, "资源已生成", "orchestrator", "生成完成",
                detail="生成链路异常后已自动兜底交付完整资源", resource_id=UUID(resource["id"]),
            )
        except Exception as fallback_exc:
            logger.exception("Emergency fallback also failed")
            message = (f"本次生成已自动重试 {max_attempts} 次仍未完成"
                       f"（原因：{retry_reason(fallback_exc)}），请重新发起生成；若反复出现请联系管理员")
            await emit_terminal(
                "failed", 100, "生成失败", "judge", "任务未通过",
                detail=message, error=message,
                snapshot={"technicalCause": f"{type(fallback_exc).__name__}: {str(fallback_exc)[:200]}",
                          "failureKind": "fallback"},
            )
    finally:
        await team.close()


@router.post("/learning-resource-tasks/{resource_type}", status_code=status.HTTP_202_ACCEPTED)
async def create_learning_resource_task(
    resource_type: str, request: LearningResourceCreateRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    request = _with_admin_resume(request)
    if resource_type not in {"lecture", "practice", "quiz"}:
        raise HTTPException(status_code=422, detail="Invalid resource type")
    topic = request.topic or "个性化学习资源"
    title = request.title or f"{topic} · " + {"lecture": "定制讲义", "practice": "实操指南", "quiz": "分阶测试"}[resource_type]
    generation_context = request.generation_context or {}
    admin_generation = generation_context.get("adminGeneration") is True
    if admin_generation:
        domain = str(generation_context.get("domainCode") or "")
        node = str(generation_context.get("nodeCode") or "")
        group = str(generation_context.get("groupName") or "默认分组")
        if domain and node:
            existing_groups = await asyncio.to_thread(learning_resource_store().list_admin_generation_groups, domain, node)
            existing_types = set(next((item for item in existing_groups if item["groupName"] == group), {}).get("types") or [])
            if resource_type in existing_types and not generation_context.get("regenerate"):
                raise HTTPException(status_code=409, detail="该分组已存在对应资源，同一分组内各资源唯一")
    task_store = resource_generation_task_store()
    previous_tasks = await asyncio.to_thread(
        task_store.list_same_name, principal.user_id, resource_type, title,
    )
    async def replace_previous_tasks(new_task: dict) -> dict:
        new_task_id = UUID(new_task["id"])
        for previous in previous_tasks:
            previous_id = UUID(previous["id"])
            running = _learning_resource_generation_tasks.pop(previous_id, None)
            if running and not running.done():
                running.cancel()
        if previous_tasks:
            await asyncio.to_thread(
                task_store.delete_same_name_except,
                principal.user_id, resource_type, title, new_task_id,
            )
        return new_task
    # 管理员工作台允许同一知识点存在多个同类型资源；每次显式新建都应生成
    # 一份新候选资源。普通学习端仍保持复用，但复用动作也必须写入真实任务记录。
    if not admin_generation:
        existing = await asyncio.to_thread(
            learning_resource_store().list, principal.user_id,
            kind=resource_type, learner_id=request.learner_id, kp_id=request.kp_id, include_course=False,
        )
        for item in existing:
            if (item.get("topic") or "").strip() == topic.strip() or (item.get("title") or "") == title:
                reused = await asyncio.to_thread(
                    task_store.create_reused,
                    principal.user_id, resource_type, item.get("title") or title,
                    request.model_dump(), UUID(item["id"]),
                )
                return await replace_previous_tasks(reused)
    task = await asyncio.to_thread(
        task_store.create, principal.user_id, resource_type, title, request.model_dump(),
    )
    task = await replace_previous_tasks(task)
    task_id = UUID(task["id"])
    node_code = (request.generation_context or {}).get("nodeCode") or request.kp_id or ""
    running = _enqueue_generation(
        _run_learning_resource_generation(task_id, principal.user_id, resource_type, request),
        node_code=node_code, resource_type=resource_type,
        queue_sequence=(request.generation_context or {}).get("queueSequence"),
    )
    _learning_resource_generation_tasks[task_id] = running
    running.add_done_callback(lambda _task, key=task_id: _learning_resource_generation_tasks.pop(key, None))
    return task


@router.get("/learning-resource-tasks")
async def list_learning_resource_tasks(
    limit: int = Query(30, ge=1, le=1000),
    summary: bool = Query(False),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    return {"tasks": await asyncio.to_thread(resource_generation_task_store().list, principal.user_id, limit, summary=summary)}


@router.post("/admin-generation-batches", status_code=status.HTTP_202_ACCEPTED)
async def create_admin_generation_batch(
    payload: dict, principal: InternalPrincipal = Depends(require_user_principal),
):
    """Create one durable, restart-safe, strictly ordered administrator batch."""
    domain_code = str(payload.get("domainCode") or "").strip()
    group_name = str(payload.get("groupName") or "").strip()
    if domain_code != "agent" or not group_name:
        raise HTTPException(status_code=422, detail="domainCode=agent and groupName are required")

    from app.storage.platform_db import platform_connect
    settings = get_settings()

    def load_inventory():
        with platform_connect(settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT organization_id,account_type FROM users WHERE HEX(id)=%s",
                    (principal.user_id.hex.upper(),),
                )
                user = cursor.fetchone()
                if not user or str(user.get("account_type") or "").upper() != "ADMIN" or not user.get("organization_id"):
                    raise PermissionError("Only organization administrators can create shared resources")
                organization_id = user["organization_id"]
                cursor.execute(
                    "SELECT kp.node_code,kp.name topic_name,ch.node_code chapter_code,ch.name chapter_name "
                    "FROM knowledge_domain d JOIN knowledge_category kp ON kp.domain_id=d.id "
                    "JOIN knowledge_category ch ON ch.id=kp.parent_id "
                    "LEFT JOIN knowledge_category root ON root.id=ch.parent_id "
                    "WHERE d.code=%s AND kp.node_type='knowledge_point' AND kp.status=1 "
                    "ORDER BY COALESCE(root.sort_order,0),COALESCE(root.id,0),"
                    "COALESCE(ch.sort_order,0),ch.id,COALESCE(kp.sort_order,0),kp.id",
                    (domain_code,),
                )
                knowledge_points = list(cursor.fetchall())
                cursor.execute(
                    "SELECT category_node_code node_code,resource_type,id FROM generated_learning_resources "
                    "WHERE organization_id=%s AND domain_code=%s AND BINARY resource_group=BINARY %s "
                    "AND resource_scope='ORGANIZATION' AND archived_at IS NULL "
                    "AND resource_type IN ('lecture','practice','quiz')",
                    (organization_id, domain_code, group_name),
                )
                completed = {(str(row["node_code"]), str(row["resource_type"])): row["id"] for row in cursor.fetchall()}
                cursor.execute(
                    "SELECT category_node_code node_code,id FROM presentation_tasks "
                    "WHERE organization_id=%s AND domain_code=%s AND BINARY resource_group=BINARY %s "
                    "AND status='completed' AND archived_at IS NULL",
                    (organization_id, domain_code, group_name),
                )
                completed.update({(str(row["node_code"]), "ppt"): row["id"] for row in cursor.fetchall()})
                cursor.execute(
                    "SELECT id,resource_type,JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.nodeCode')) node_code,status "
                    "FROM learning_resource_generation_tasks WHERE HEX(user_id)=%s "
                    "AND JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.domainCode'))=%s "
                    "AND BINARY JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.groupName'))=BINARY %s "
                    "AND status NOT IN ('completed','failed','cancelled')",
                    (principal.user_id.hex.upper(), domain_code, group_name),
                )
                active = {(str(row["node_code"]), str(row["resource_type"])): row for row in cursor.fetchall()}
                cursor.execute(
                    "SELECT id,JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.nodeCode')) node_code,status "
                    "FROM presentation_tasks WHERE HEX(user_id)=%s AND domain_code=%s AND BINARY resource_group=BINARY %s "
                    "AND status NOT IN ('completed','failed','cancelled')",
                    (principal.user_id.hex.upper(), domain_code, group_name),
                )
                active.update({(str(row["node_code"]), "ppt"): row for row in cursor.fetchall()})
                # Failed/cancelled attempts are replaced by the new canonical
                # task and should not remain as duplicate workbench rows.
                cursor.execute(
                    "DELETE FROM learning_resource_generation_tasks WHERE HEX(user_id)=%s "
                    "AND JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.domainCode'))=%s "
                    "AND BINARY JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.groupName'))=BINARY %s "
                    "AND status IN ('failed','cancelled')",
                    (principal.user_id.hex.upper(), domain_code, group_name),
                )
                cursor.execute(
                    "DELETE FROM presentation_tasks WHERE HEX(user_id)=%s AND domain_code=%s "
                    "AND BINARY resource_group=BINARY %s AND status IN ('failed','cancelled')",
                    (principal.user_id.hex.upper(), domain_code, group_name),
                )
            connection.commit()
        return knowledge_points, completed, active

    try:
        knowledge_points, completed, active = await asyncio.to_thread(load_inventory)
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    if len(knowledge_points) != 119:
        raise HTTPException(status_code=409, detail=f"Agent 领域知识点数量异常：{len(knowledge_points)}，预期 119")

    batch_id = str(uuid4())
    type_labels = {"lecture": "讲义", "practice": "实操指南", "quiz": "题库", "ppt": "交互课件"}
    task_store = resource_generation_task_store()
    ppt_store = presentation_store()
    entries = []
    summary = {"skippedExisting": 0, "keptQueued": 0, "created": 0}
    sequence = 0
    for kp in knowledge_points:
        node_code = str(kp["node_code"])
        topic_name = str(kp["topic_name"])
        for resource_type in ("lecture", "practice", "quiz", "ppt"):
            sequence += 1
            key = (node_code, resource_type)
            entry = {
                "sequence": sequence, "chapterCode": str(kp["chapter_code"]),
                "chapterName": str(kp["chapter_name"]), "nodeCode": node_code,
                "topicName": topic_name, "resourceType": resource_type,
            }
            if key in completed:
                summary["skippedExisting"] += 1
                entries.append({**entry, "action": "skipped_existing", "taskId": None})
                continue
            if key in active:
                summary["keptQueued"] += 1
                entries.append({
                    **entry, "action": "kept_existing_task",
                    "taskId": str(UUID(bytes=active[key]["id"])), "status": str(active[key]["status"]),
                })
                continue
            context = {
                "adminGeneration": True, "domainCode": domain_code, "nodeCode": node_code,
                "kpId": node_code, "topicName": topic_name, "groupName": group_name,
                "regenerate": False, "resumeEnabled": True, "queueSequence": sequence, "batchId": batch_id,
            }
            if resource_type == "ppt":
                request = PresentationRequest(
                    requirement=f"围绕“{topic_name}”生成一份面向学习者的完整交互课件，内容准确、结构清晰，并适合课堂讲解与自主学习。",
                    title=topic_name, audience="students", purpose="courseware", style="education",
                    backgroundStyle="blue-white-minimal", language="zh-CN", slideCount=0,
                    aspectRatio="16:9", detailLevel="detailed", includeSpeakerNotes=True,
                    modelProvider="mimo", generationMode="template",
                    generationContext={**context, "waitForDependencies": True},
                )
                created = await asyncio.to_thread(ppt_store.create, principal.user_id, request)
                task_id = UUID(created["id"])
                await asyncio.to_thread(
                    ppt_store.append_event, task_id, "queued", "等待前三项完成",
                    "讲义、实操、题库完成后自动启动交互课件",
                )
                running = _enqueue_generation(
                    _run_presentation_after_dependencies(task_id, request),
                    node_code=node_code, resource_type="ppt", is_ppt=True,
                    ppt_dep_check=lambda: _ppt_dep_check_from_context(context),
                    queue_sequence=sequence,
                )
                _presentation_tasks[task_id] = running
                running.add_done_callback(lambda _task, key=task_id: _presentation_tasks.pop(key, None))
            else:
                request = LearningResourceCreateRequest(
                    topic=topic_name, title=f"{topic_name} · {type_labels[resource_type]}",
                    kpId=node_code, detailLevel="detailed",
                    questionCount=15 if resource_type == "quiz" else 15,
                    generationContext=context,
                )
                created = await asyncio.to_thread(
                    task_store.create, principal.user_id, resource_type,
                    request.title, request.model_dump(),
                )
                task_id = UUID(created["id"])
                running = _enqueue_generation(
                    _run_learning_resource_generation(task_id, principal.user_id, resource_type, request),
                    node_code=node_code, resource_type=resource_type, queue_sequence=sequence,
                )
                _learning_resource_generation_tasks[task_id] = running
                running.add_done_callback(lambda _task, key=task_id: _learning_resource_generation_tasks.pop(key, None))
            summary["created"] += 1
            entries.append({**entry, "action": "created", "taskId": str(task_id), "status": "queued"})

    return {
        "batchId": batch_id, "domainCode": domain_code, "groupName": group_name,
        "createdAt": datetime.utcnow().isoformat(),
        "ordering": ["chapter", "knowledgePoint", "lecture", "practice", "quiz", "ppt"],
        "expectedKnowledgePoints": len(knowledge_points), "expectedResources": sequence,
        "summary": summary, "entries": entries,
    }


# ============ 用户端资源定制（基于管理员母版二次创作） ============

_customize_tasks: dict[UUID, asyncio.Task] = {}

# -- Global parallel generation queue ------------------------------------
# opencodego gateway supports concurrent calls. Run up to generation_concurrency
# generation tasks in parallel; queued entries retain the existing priority order.
import heapq as _heapq

_generation_queue: list = []
_generation_counter = 0
_generation_worker_started = False
_generation_worker_tasks: set[asyncio.Task] = set()

_RESOURCE_TYPE_ORDER = {"lecture": 0, "practice": 1, "quiz": 2, "ppt": 3}

def _generation_concurrency() -> int:
    try:
        return max(1, min(32, int(get_settings().generation_concurrency)))
    except Exception:
        return 8

def _calc_priority(node_code: str, resource_type: str, queue_sequence=None) -> int:
    if isinstance(queue_sequence, int) or (isinstance(queue_sequence, str) and queue_sequence.isdigit()):
        # Persisted batch order is authoritative and also supports node codes
        # such as kp-g10-1 that cannot be ordered by numeric parsing alone.
        return max(0, int(queue_sequence))
    parts = (node_code or "").replace("kp-", "").split("-")
    try:
        chapter = int(parts[0]) if len(parts) > 0 else 99
        kp_num = int(parts[1]) if len(parts) > 1 else 99
    except (ValueError, IndexError):
        chapter, kp_num = 99, 99
    return chapter * 10000 + kp_num * 10 + _RESOURCE_TYPE_ORDER.get(resource_type, 4)


def _ppt_deps_met(domain_code: str, node_code: str, group_name: str) -> bool:
    """Whether a waiting PPT may leave the queue and start (or stop) now.

    Returns True when the three dependencies are generated, or when one of
    them has already failed/cancelled so the waiter can mark the PPT failed.
    Returns False while the group still has work in progress; the worker then
    requeues the entry without occupying a generation slot.
    """
    if not domain_code or not node_code:
        return True
    try:
        groups = learning_resource_store().list_admin_generation_groups(domain_code, node_code)
        selected = next((item for item in groups if item["groupName"] == group_name), {})
        details = selected.get("details") or {}
        dependencies = ("lecture", "practice", "quiz")
        failed = any(
            (details.get(dep) or [])
            and not {"generated"} & set(details[dep])
            and {"failed", "cancelled"} & set(details[dep])
            for dep in dependencies
        )
        if failed:
            return True
        return all("generated" in (details.get(dep) or []) for dep in dependencies)
    except Exception:
        return True  # on error, let the waiter re-check instead of blocking forever


def _ppt_dep_check_from_context(context: dict) -> bool:
    return _ppt_deps_met(
        str(context.get("domainCode") or ""),
        str(context.get("nodeCode") or context.get("kpId") or ""),
        str(context.get("groupName") or "默认分组"),
    )

async def _generation_worker():
    global _generation_counter
    while True:
        if not _generation_queue:
            await asyncio.sleep(0.5)
            continue
        _heapq.heapify(_generation_queue)
        _, _, entry = _heapq.heappop(_generation_queue)
        try:
            if entry["cancelled"]:
                entry["coro"].close()
                entry["sentinel"].set()
                continue
            if entry.get("is_ppt") and entry.get("ppt_dep_check"):
                if not entry["ppt_dep_check"]():
                    _generation_counter += 1
                    _heapq.heappush(_generation_queue, (entry["priority"] + 5, _generation_counter, entry))
                    await asyncio.sleep(3)
                    continue
            running = asyncio.create_task(entry["coro"])
            entry["running"] = running
            try:
                entry["holder"]["result"] = await running
            except asyncio.CancelledError:
                if asyncio.current_task().cancelling():
                    raise
                entry["holder"]["cancelled"] = True
            except Exception as exc:
                entry["holder"]["error"] = exc
            finally:
                entry["sentinel"].set()
        finally:
            pass

def _worker_done(task: asyncio.Task) -> None:
    global _generation_worker_started
    _generation_worker_tasks.discard(task)
    if not _generation_worker_tasks:
        _generation_worker_started = False

def _start_generation_workers() -> None:
    global _generation_worker_started
    if _generation_worker_started:
        return
    _generation_worker_started = True
    for _ in range(_generation_concurrency()):
        worker = asyncio.create_task(_generation_worker())
        _generation_worker_tasks.add(worker)
        worker.add_done_callback(_worker_done)

def _enqueue_generation(coro, *, node_code="", resource_type="",
                        is_ppt=False, ppt_dep_check=None, queue_sequence=None):
    global _generation_counter
    _start_generation_workers()
    sentinel = asyncio.Event()
    holder = {}
    priority = _calc_priority(node_code, resource_type, queue_sequence)
    _generation_counter += 1
    entry = {
        "coro": coro, "sentinel": sentinel, "holder": holder,
        "running": None, "cancelled": False, "priority": priority,
        "is_ppt": is_ppt, "ppt_dep_check": ppt_dep_check,
    }
    _heapq.heappush(_generation_queue, (priority, _generation_counter, entry))

    async def _wait():
        await sentinel.wait()
        if holder.get("cancelled"):
            raise asyncio.CancelledError
        if "error" in holder:
            raise holder["error"]
        return holder.get("result")

    waiter = asyncio.create_task(_wait())

    def _cancel_real_work(done: asyncio.Task) -> None:
        if not done.cancelled():
            return
        entry["cancelled"] = True
        running = entry.get("running")
        if running is not None and not running.done():
            running.cancel()

    waiter.add_done_callback(_cancel_real_work)
    return waiter
# --------------------------------------------------------------------------



def _customize_service():
    from app.services.customize_service import CustomizeService
    return CustomizeService(get_settings())



_ADAPTIVE_RANK = {"easy": 0, "medium": 1, "hard": 2}
_ADAPTIVE_RANK_TO_LABEL = {0: "easy", 1: "medium", 2: "hard"}

def _adaptive_difficulty_label(item: dict) -> str:
    raw = str(item.get("difficulty") or item.get("level") or item.get("difficultyLevel") or "medium").lower().strip()
    mapping = {
        "easy": "easy", "基础": "easy", "basic": "easy", "1": "easy", "2": "easy",
        "medium": "medium", "进阶": "medium", "standard": "medium", "3": "medium",
        "hard": "hard", "挑战": "hard", "综合": "hard", "advanced": "hard", "5": "hard",
    }
    return mapping.get(raw, "medium")


def _adaptive_initial_difficulty(user_context: dict) -> str:
    mastery = user_context.get("mastery") or {}
    overall = mastery.get("overall")
    try:
        overall = float(overall if overall is not None else 0.5)
    except (TypeError, ValueError):
        overall = 0.5
    if overall < 0.45:
        return "easy"
    if overall > 0.72:
        return "hard"
    return "medium"


def _pick_adaptive_question(questions: list[dict], target: str, used_ids: set[str]) -> dict | None:
    candidates = [deepcopy(item) for item in questions if isinstance(item, dict) and str(item.get("id")) not in used_ids]
    if not candidates:
        return None

    def distance(item: dict) -> int:
        label = _adaptive_difficulty_label(item)
        return abs(_ADAPTIVE_RANK.get(label, 1) - _ADAPTIVE_RANK.get(target, 1))

    return min(candidates, key=distance)


def _adaptive_next_difficulty(state: dict, current: str) -> str:
    answered = state.get("answered") or []
    if not answered:
        return current or "medium"
    rank = _ADAPTIVE_RANK.get(current or "medium", 1)
    recent = answered[-2:]
    if len(recent) >= 2 and all(bool(item.get("correct")) for item in recent):
        rank += 1
    elif len(recent) >= 2 and not any(bool(item.get("correct")) for item in recent):
        rank -= 1
    elif len(recent) == 1 and not bool(recent[-1].get("correct")):
        rank -= 1
    return _ADAPTIVE_RANK_TO_LABEL.get(max(0, min(2, rank)), "medium")


def _adaptive_quiz_slides(content: dict) -> list[dict]:
    slides: list[dict] = []
    for index, question in enumerate(content.get("questions") or []):
        slides.append({
            "index": index, "unitIndex": index,
            "totalUnits": max(5, len(content.get("questions") or [])),
            "type": "question", "title": f"第 {index + 1} 题",
            "content": deepcopy(question), "sources": [], "evidenceQuotes": [],
        })
    return slides


def _start_adaptive_quiz_session(task_id: UUID, user_id: UUID, admin_resource_id: UUID,
                                 kp_id: str | None, title: str) -> dict:
    service = _customize_service()
    template = service._load_template(admin_resource_id, "quiz")
    if template is None:
        raise ValueError("管理员母版资源不存在或已归档")
    template_content = service._template_content(template)
    questions = [item for item in template_content.get("questions") or [] if isinstance(item, dict)]
    if not questions:
        raise ValueError("管理员分阶题库为空，暂时无法生成自适应分阶测试")
    user_context = service._load_user_context(user_id, kp_id, "quiz", task_id)
    difficulty = _adaptive_initial_difficulty(user_context)
    first = _pick_adaptive_question(questions, difficulty, set())
    if first is None:
        raise ValueError("分阶题库中没有可用题目，暂时无法开始")
    content = deepcopy(template_content)
    content["questions"] = [first]
    content["adaptiveQuiz"] = {
        "state": "draft", "totalQuestions": 5, "currentIndex": 1,
        "initialDifficulty": difficulty, "currentDifficulty": difficulty,
        "taskId": str(task_id), "adaptive": True,
    }
    task_store = resource_generation_task_store()
    task_store.save_checkpoint(task_id, user_id, "adaptive_quiz", {
        "templateId": str(admin_resource_id), "title": title,
        "questions": deepcopy(questions), "totalQuestions": 5,
        "initialDifficulty": difficulty, "currentDifficulty": difficulty,
    })
    new_id = service._create_user_copy(
        user_id, template, kp_id, "quiz", title, content,
        delivery_mode="adaptive", fallback_reason="",
    )
    task_store.update(
        task_id, user_id, "generating", 20, "第 1/5 题",
        agent="orchestrator", title="自适应分阶已开始",
        detail="已根据当前画像选定第 1 题，继续作答后将按答题表现调整后续难度",
        resource_id=new_id,
        snapshot={"activity": "第 1 题已就绪", "totalQuestions": 5,
                  "initialDifficulty": difficulty, "nextStep": "用户作答后继续动态出题"},
    )
    task_store.save_slides(task_id, user_id, _adaptive_quiz_slides(content))
    return task_store.get(task_id, user_id)


def _refresh_adaptive_task_after_answer(task_id: UUID, user_id: UUID, resource: dict, state: dict,
                                        content: dict, final: bool) -> None:
    task_store = resource_generation_task_store()
    answered_count = len(state.get("answered") or [])
    if final:
        task_store.update(
            task_id, user_id, "completed", 100, "自适应分阶已完成",
            agent="orchestrator", title="分阶测试定制完成",
            detail="5 道自适应题已全部作答，最终分阶测试资源已生成",
            resource_id=UUID(resource["id"]),
            snapshot={"activity": "分阶测试资源已生成", "answered": answered_count, "totalQuestions": 5},
        )
    else:
        progress = max(25, min(95, round(answered_count / 5 * 100)))
        task_store.update(
            task_id, user_id, "generating", progress, f"第 {answered_count + 1}/5 题",
            agent="orchestrator", title="自适应分阶题已更新",
            detail="已根据上一题作答表现调整下一题难度",
            resource_id=UUID(resource["id"]),
            snapshot={"activity": f"已生成第 {answered_count + 1} 题", "answered": answered_count,
                      "totalQuestions": 5, "nextStep": "用户继续作答"},
        )
    task_store.save_slides(task_id, user_id, _adaptive_quiz_slides(content))
class CustomizeResourceRequest(BaseModel):
    adminResourceId: str
    kpId: str | None = None
    resourceType: str
    title: str | None = None
    overwrite: bool = False


@router.post("/customize-resource", status_code=status.HTTP_202_ACCEPTED)
async def create_customize_task(
    request: CustomizeResourceRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """Create a customization task deriving a personal resource from an
    organization template. Each (user, template) pair can only be customized once."""
    if request.resourceType not in {"lecture", "practice", "quiz", "ppt"}:
        raise HTTPException(status_code=422, detail="Invalid resource type")
    template_id = UUID(request.adminResourceId)

    def _check_and_create():
        service = _customize_service()
        template = service._load_template(template_id, request.resourceType)
        if template is None:
            raise HTTPException(status_code=404, detail="管理员母版资源不存在或已归档")
        title = request.title or f"{template.get('topic') or template.get('title') or '资源'} · 我的定制"
        existing = service._find_user_copy(principal.user_id, template_id, request.resourceType)
        if existing is not None and not request.overwrite:
            existing_task = service._find_customize_task_for_copy(
                principal.user_id, UUID(existing),
            )
            if existing_task is not None:
                return existing_task, False
            # Repair a legacy USER copy whose task history was removed. The
            # returned completed task lets every frontend entry converge on the
            # same state without regenerating or duplicating the resource.
            reused = resource_generation_task_store().create_reused(
                principal.user_id, request.resourceType, title,
                {"customize": True, "adminResourceId": request.adminResourceId,
                 "kpId": request.kpId, "overwrite": False, "reused": True},
                UUID(existing),
            )
            return reused, False
        content = (
            service._loads(template.get("outline_json"), {})
            if request.resourceType == "ppt" else service._template_content(template)
        )
        expected_total = len(
            content.get("slides") or content.get("chapters")
            or content.get("steps") or content.get("questions") or []
        )
        task_store = resource_generation_task_store()
        task = task_store.create(
            principal.user_id, request.resourceType, title,
            {"customize": True, "adminResourceId": request.adminResourceId,
             "kpId": request.kpId, "overwrite": request.overwrite,
             "expectedTotal": expected_total},
        )
        return task, True

    task, should_run = await asyncio.to_thread(_check_and_create)
    if not should_run:
        return task
    task_id = UUID(task["id"])
    if request.resourceType == "quiz":
        # 分阶测试改为自适应答题：先释放第 1 题，用户每答完一题后端再追加下一题，
        # 第 5 题答完才生成最终资源。
        try:
            started = await asyncio.to_thread(
                _start_adaptive_quiz_session, task_id, principal.user_id,
                template_id, request.kpId, task["title"],
            )
        except Exception as exc:
            await asyncio.to_thread(
                resource_generation_task_store().update,
                task_id, principal.user_id, "failed", 100, "自适应分阶启动失败",
                agent="orchestrator", title="自适应分阶启动失败",
                detail=str(exc), error=str(exc),
            )
            raise HTTPException(status_code=409, detail=str(exc) or "自适应分阶启动失败")
        return started
    running = _enqueue_generation(_customize_service().run(
        task_id, principal.user_id, template_id,
        request.kpId, request.resourceType, task["title"],
    ))
    _customize_tasks[task_id] = running
    running.add_done_callback(lambda _t, key=task_id: _customize_tasks.pop(key, None))
    return task

@router.get("/customize-tasks")
async def list_customize_tasks(
    kpId: str | None = Query(None),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """List the current user's customization tasks, optionally filtered by kpId."""
    def _list():
        service = _customize_service()
        return service._list_user_customize_tasks(principal.user_id, kpId)
    tasks = await asyncio.to_thread(_list)
    return {"tasks": tasks}


@router.get("/customize-tasks/{task_id}")
async def get_customize_task(
    task_id: UUID,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    task = await asyncio.to_thread(resource_generation_task_store().get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Customization task not found")
    return task


@router.get("/customize-tasks/{task_id}/slides")
async def get_customize_task_slides(
    task_id: UUID,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """Return cards that are ready while a personal resource is still generating."""
    task_store = resource_generation_task_store()

    def _load():
        task = task_store.get(task_id, principal.user_id)
        if task is None:
            return None
        slides = task_store.get_slides(task_id, principal.user_id) or []
        from app.services.customize_service import CustomizeService
        slides = CustomizeService.coalesce_legacy_unit_slides(slides)
        expected_units = max(
            [int(item.get("totalUnits") or 0) for item in slides if isinstance(item, dict)] or [0]
        )
        if not expected_units:
            expected_units = int((task.get("request") or {}).get("expectedTotal") or 0)
        raw_status = str(task.get("status") or "generating")
        public_status = "completed" if raw_status == "completed" else (
            raw_status if raw_status in {"failed", "cancelled"} else "generating"
        )
        completed_units = len({
            int(item.get("unitIndex")) for item in slides
            if isinstance(item, dict) and item.get("unitIndex") is not None
        })
        total = len(slides) if public_status == "completed" else max(expected_units, len(slides))
        return {
            "slides": slides, "total": total, "completed": completed_units,
            "status": public_status, "resourceId": task.get("resourceId"),
            "resourceType": task.get("resourceType"), "title": task.get("title"),
            "stageMessage": task.get("stageMessage"),
            "kpId": (task.get("request") or {}).get("kpId"),
        }

    result = await asyncio.to_thread(_load)
    if result is None:
        raise HTTPException(status_code=404, detail="Customization task not found")
    return result


class CourseRecommendRequest(BaseModel):
    profile: dict[str, Any] = {}
    courses: list[dict[str, Any]] = []


_RECOMMEND_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_RECOMMEND_CACHE_TTL_SECONDS = 600


@router.post("/learner/course-recommendations")
async def learner_course_recommendations(
    body: CourseRecommendRequest,
    _: InternalPrincipal = Depends(require_user_principal),
):
    """让大模型按学习者画像与课程名称/描述的匹配度给候选课程打分排序。"""
    courses: list[dict[str, Any]] = []
    for item in body.courses:
        code = str(item.get("code") or "").strip()
        name = str(item.get("name") or "").strip()
        if not code or not name:
            continue
        courses.append({
            "code": code,
            "name": name,
            "description": str(item.get("description") or "")[:200],
            "type": str(item.get("type") or "课程"),
            "knowledgePoints": int(item.get("knowledgePoints") or 0),
        })
    courses = courses[:20]
    if not courses:
        return {"items": [], "source": "empty"}

    profile = {
        key: body.profile.get(key)
        for key in ("name", "tag", "role", "targetJob", "goal", "background",
                    "education", "learningStyle", "strengths", "blindSpots")
        if body.profile.get(key)
    }
    cache_src = json.dumps({"profile": profile, "courses": courses}, ensure_ascii=False, sort_keys=True)
    cache_key = hashlib.sha256(cache_src.encode("utf-8")).hexdigest()
    cached = _RECOMMEND_CACHE.get(cache_key)
    if cached and time.time() - cached[0] < _RECOMMEND_CACHE_TTL_SECONDS:
        return cached[1]

    system = "你是课程推荐助手。只能依据学习者画像与课程名称、描述的匹配程度打分，不要编造课程。只返回 JSON。"
    prompt = (
        "学习者画像：\n" + json.dumps(profile, ensure_ascii=False)
        + "\n\n候选课程：\n" + json.dumps(courses, ensure_ascii=False)
        + "\n\n请为每门课程给出 0-100 的匹配分，并写一句 20 字以内的推荐理由。"
        + '严格输出 {"items":[{"code":"课程编码","score":86,"reason":"理由"}]}，'
        + "必须覆盖全部候选课程，code 只能取自候选列表。"
    )
    fallback: dict[str, Any] = {"items": []}
    try:
        result = await llm_client().complete_json(
            system, prompt, fallback, thinking=False, timeout_seconds=25,
        )
    except Exception:
        logger.warning("course recommendation llm failed", exc_info=True)
        result = fallback

    scored: dict[str, dict[str, Any]] = {}
    for item in result.get("items") or []:
        if not isinstance(item, dict):
            continue
        code = str(item.get("code") or "").strip()
        if not code:
            continue
        try:
            score = int(float(item.get("score") or 0))
        except (TypeError, ValueError):
            score = 0
        scored[code] = {"score": max(0, min(100, score)), "reason": str(item.get("reason") or "")[:80]}

    items = [
        {"code": course["code"], **scored[course["code"]]}
        for course in courses
        if scored.get(course["code"], {}).get("score", 0) > 0
    ]
    items.sort(key=lambda row: row["score"], reverse=True)
    payload = {"items": items, "source": "llm" if items else "fallback"}
    _RECOMMEND_CACHE[cache_key] = (time.time(), payload)
    if len(_RECOMMEND_CACHE) > 200:
        for key in list(_RECOMMEND_CACHE)[:100]:
            _RECOMMEND_CACHE.pop(key, None)
    return payload


@router.get("/admin-generation-groups")
async def list_admin_generation_groups(
    domainCode: str = Query(..., min_length=1), nodeCode: str = Query(..., min_length=1),
    _: InternalPrincipal = Depends(require_user_principal),
):
    groups = await asyncio.to_thread(learning_resource_store().list_admin_generation_groups, domainCode, nodeCode)
    return {"groups": groups}

@router.get("/admin-generation-resources/{resource_id}")
async def get_admin_generation_resource(
    resource_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    resource = await asyncio.to_thread(learning_resource_store().get_admin, resource_id, principal.user_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="资源不存在或不属于当前机构")
    return resource

@router.get("/learning-resource-tasks/{task_id}")
async def get_learning_resource_task(
    task_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    task = await asyncio.to_thread(resource_generation_task_store().get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Learning resource generation task not found")
    await _attach_stored_summaries_to_task(task, "resource", principal.user_id)
    return task


@router.post("/learning-resource-tasks/{task_id}/restart")
async def restart_learning_resource_task(
    task_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    task = await asyncio.to_thread(resource_generation_task_store().restart, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=409, detail="任务不存在或当前状态不允许重启")
    request = LearningResourceCreateRequest.model_validate(task["request"])
    if task.get("events"):
        _spawn_event_summary("resource", task_id, len(task["events"]), principal)
    restart_context = request.generation_context or {}
    running = _enqueue_generation(
        _run_learning_resource_generation(task_id, principal.user_id, task["resourceType"], request),
        node_code=restart_context.get("nodeCode") or request.kp_id or "",
        resource_type=task["resourceType"], queue_sequence=restart_context.get("queueSequence"),
    )
    _learning_resource_generation_tasks[task_id] = running
    running.add_done_callback(lambda _task, key=task_id: _learning_resource_generation_tasks.pop(key, None))
    return task

@router.post("/learning-resource-tasks/{task_id}/cancel", status_code=status.HTTP_200_OK)
async def cancel_learning_resource_task(
    task_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    cancelled = await asyncio.to_thread(
        resource_generation_task_store().cancel, task_id, principal.user_id,
    )
    if cancelled is None:
        raise HTTPException(status_code=404, detail="任务不存在或已结束，无需取消")
    running = _learning_resource_generation_tasks.pop(task_id, None)
    if running and not running.done():
        running.cancel()
    return cancelled


@router.delete("/learning-resource-tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_learning_resource_task(
    task_id: UUID, principal: InternalPrincipal = Depends(require_user_principal),
):
    """永久删除任务记录（未完成任务删除时其对应数据一并清理）。"""
    running = _learning_resource_generation_tasks.pop(task_id, None)
    if running and not running.done():
        running.cancel()
    deleted = await asyncio.to_thread(
        resource_generation_task_store().delete, task_id, principal.user_id,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="任务不存在或无权删除")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _normalize_generation_event(event: dict, seq: int, *, task_type: str) -> dict:
    """Return one safe, role-aware event for the read-only generation cockpit."""
    lifecycle_titles = {"任务已创建", "任务取消", "生成完成", "任务已结束", "任务被取消"}
    if event.get("agent") == "SYSTEM" or event.get("title") in lifecycle_titles:
        return {
            **event, "seq": int(event.get("seq") or seq), "agent": "SYSTEM", "agentName": "系统流程",
            "actorType": "system", "eventType": "task_lifecycle", "snapshot": event.get("snapshot") or {},
        }
    if event.get("agentName"):
        return {**event, "seq": int(event.get("seq") or seq), "actorType": event.get("actorType") or "agent",
                "eventType": event.get("eventType") or "agent_work", "snapshot": event.get("snapshot") or {}}
    phase = str(event.get("phase") or event.get("status") or "running")
    if task_type == "ppt":
        agent_id, agent_name = PresentationStore.role_for_phase(phase)
    else:
        raw = str(event.get("agent") or "orchestrator")
        agent_id, agent_name = {
            "planner": ("DIA-01", "教学策划 Agent"), "retrieval": ("RET-02", "知识检索 Agent"),
            "writer": ("GEN-03", "内容生成 Agent"), "revision": ("GEN-03", "内容生成 Agent"),
            "citation_verifier": ("VER-04", "质量核验 Agent"), "reviewer": ("VER-04", "质量核验 Agent"),
            "judge": ("ARB-05", "发布仲裁 Agent"), "orchestrator": ("SYSTEM", "系统流程"),
        }.get(raw, (raw, raw))
    snapshot = event.get("snapshot") or event.get("data") or {}
    return {
        "seq": seq, "time": event.get("time"), "agent": agent_id, "agentName": agent_name,
        "status": event.get("status") or phase, "phase": phase, "title": event.get("title") or "生成进度",
        "detail": event.get("detail") or "", "snapshot": snapshot if isinstance(snapshot, dict) else {},
        "executionSummary": event.get("executionSummary"),
        "actorType": "system" if agent_id == "SYSTEM" else "agent",
        "eventType": "task_lifecycle" if agent_id == "SYSTEM" else "agent_work",
    }


async def _attach_stored_summaries_to_task(task: dict, task_type: str, principal_user_id: UUID):
    if not task:
        return task
    events = task.get("events") or []
    if not events:
        return task
    summary_map = await asyncio.to_thread(event_summary_store().latest_by_task, principal_user_id, task_type, UUID(task["id"]))
    for index, raw in enumerate(events):
        seq = int(raw.get("seq") or index + 1)
        if raw.get("executionSummary"):
            continue
        summary = (summary_map.get(seq) or {}).get("summary")
        if summary:
            raw["executionSummary"] = summary
    return task

async def _patch_persisted_event_summary(task_type: str, task_id: UUID, principal_user_id: UUID, seq: int, summary: str) -> None:
    if task_type == "resource":
        await asyncio.to_thread(resource_generation_task_store().attach_event_summary, task_id, principal_user_id, seq, summary)
    else:
        await asyncio.to_thread(presentation_store().attach_event_summary, task_id, seq, summary)

async def _guarded_event_summary(task_type: str, task_id: UUID, seq: int, principal: InternalPrincipal) -> None:
    try:
        await summarize_admin_generation_event(task_type, task_id, seq, principal=principal)
    except Exception:
        pass

def _event_value_text(value: object, limit: int = 180) -> str:
    if value is None or value == "" or value == [] or value == {}:
        return ""
    if isinstance(value, list):
        text = "；".join(str(item) for item in value[:4])
    elif isinstance(value, dict):
        text = "；".join(f"{key}：{item}" for key, item in list(value.items())[:4])
    else:
        text = str(value)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit] + ("…" if len(text) > limit else "")


def _build_event_execution_summary(event: dict) -> str:
    """Create the user-facing summary from the event snapshot without an extra LLM call."""
    snapshot = event.get("snapshot") if isinstance(event.get("snapshot"), dict) else {}
    title = _event_value_text(event.get("title"), 90) or "执行流程更新"
    detail = _event_value_text(event.get("detail"), 220)
    action = _event_value_text(snapshot.get("activity") or snapshot.get("operation") or detail, 220)
    conclusion = _event_value_text(
        snapshot.get("conclusion") or snapshot.get("result") or snapshot.get("decision")
        or snapshot.get("finding") or snapshot.get("coverage"), 220,
    )
    evidence = _event_value_text(
        snapshot.get("evidence") or snapshot.get("sources") or snapshot.get("sourceSummary")
        or snapshot.get("checks") or snapshot.get("questionAudit"), 220,
    )
    next_step = _event_value_text(snapshot.get("nextStep") or snapshot.get("next_step"), 180)
    lines = [f"- **执行动作**：{action or title}"]
    if conclusion and conclusion != action:
        lines.append(f"- **执行结果**：{conclusion}")
    elif detail and detail != action:
        lines.append(f"- **执行结果**：{detail}")
    if evidence:
        lines.append(f"- **依据与检查**：{evidence}")
    if next_step:
        lines.append(f"- **后续处理**：{next_step}")
    return "\n".join(lines[:4])


async def _persist_event_summary_at_creation(
    task_type: str, task_id: UUID, seq: int, principal: InternalPrincipal,
) -> None:
    try:
        if task_type == "resource":
            task = await asyncio.to_thread(resource_generation_task_store().stream_state, task_id, principal.user_id)
        else:
            task = await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)
        events = (task or {}).get("events") or []
        if not 1 <= seq <= len(events):
            return
        raw = events[seq - 1]
        if raw.get("executionSummary"):
            return
        event = _normalize_generation_event(raw, seq, task_type=task_type)
        summary = _build_event_execution_summary(event)
        await asyncio.to_thread(
            event_summary_store().save_revision, principal.user_id, task_type, task_id, seq,
            str(event.get("title") or "")[:200], str(event.get("agentName") or event.get("agent") or "")[:120],
            summary, "event-snapshot-v1", False,
        )
        await _patch_persisted_event_summary(task_type, task_id, principal.user_id, seq, summary)
    except Exception:
        logger.exception("Failed to persist generation event summary task=%s seq=%s", task_id, seq)


def _spawn_event_summary(task_type: str, task_id: UUID, seq: int, principal: InternalPrincipal) -> None:
    # Summaries are part of the generation snapshot and are persisted as soon
    # as the event is emitted.  They deliberately do not call the single-slot
    # content LLM, so audit readability cannot slow down resource production.
    task = asyncio.create_task(_persist_event_summary_at_creation(task_type, task_id, seq, principal))
    _event_summary_generation_tasks.add(task)
    task.add_done_callback(_event_summary_generation_tasks.discard)

@router.get("/admin-generation-tasks/{task_type}/{task_id}/stream")
async def stream_admin_generation_task(
    task_type: str, task_id: UUID, request: Request,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    if task_type not in {"resource", "ppt"}:
        raise HTTPException(status_code=422, detail="Invalid generation task type")

    async def read_task() -> dict | None:
        if task_type == "resource":
            return await asyncio.to_thread(resource_generation_task_store().stream_state, task_id, principal.user_id)
        return await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)

    initial = await read_task()
    if initial is None:
        raise HTTPException(status_code=404, detail="Generation task not found")

    summary_map = await asyncio.to_thread(event_summary_store().latest_by_task, principal.user_id, task_type, task_id)

    async def stream():
        sent = 0
        heartbeat = 0
        sleep_seconds = 0.5
        terminal = {"completed", "failed", "cancelled"}
        while True:
            if await request.is_disconnected():
                return
            task = await read_task()
            if task is None:
                return
            events = task.get("events") or []
            while sent < len(events):
                normalized = _normalize_generation_event(events[sent], sent + 1, task_type=task_type)
                normalized["executionSummary"] = normalized.get("executionSummary") or (summary_map.get(normalized["seq"]) or {}).get("summary")
                # Raw event detail is already user-facing. Never hold back the
                # timeline merely because an optional LLM summary is absent.
                yield f"id: {normalized['seq']}\nevent: generation_event\ndata: {json.dumps(normalized, ensure_ascii=False, default=str)}\n\n"
                sent += 1
                sleep_seconds = 0.5
            if str(task.get("status")) in terminal and sent >= len(events):
                yield f"event: generation_done\ndata: {json.dumps({'status': task.get('status'), 'progress': task.get('progress')}, ensure_ascii=False)}\n\n"
                return
            heartbeat += 1
            if heartbeat >= 20:
                yield f"event: heartbeat\ndata: {json.dumps({'progress': task.get('progress'), 'stageMessage': task.get('stageMessage')}, ensure_ascii=False)}\n\n"
                heartbeat = 0
            await asyncio.sleep(sleep_seconds)
            sleep_seconds = min(2.0, sleep_seconds + 0.25)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
    })

async def _run_event_summary_backfill(task_type: str, task_id: UUID, principal: InternalPrincipal) -> None:
    key = (task_type, task_id)
    try:
        if task_type == "resource":
            task = await asyncio.to_thread(resource_generation_task_store().stream_state, task_id, principal.user_id)
        else:
            task = await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)
        if not task:
            return
        events = task.get("events") or []
        existing = await asyncio.to_thread(event_summary_store().latest_by_task, principal.user_id, task_type, task_id)
        terminal = str(task.get("status")) in {"completed", "failed", "cancelled"}
        for index in range(len(events)):
            seq = index + 1
            if seq in existing:
                saved = existing[seq]
                raw = events[index]
                if not raw.get("executionSummary") and saved.get("summary"):
                    await _patch_persisted_event_summary(task_type, task_id, principal.user_id, seq, saved["summary"])
                continue
            if not terminal and seq == len(events):
                continue
            try:
                await summarize_admin_generation_event(task_type, task_id, seq, principal=principal)
            except Exception:
                continue
    finally:
        _event_summary_backfill_running.discard(key)

@router.post("/admin-generation-events/{task_type}/{task_id}/backfill-summaries", status_code=status.HTTP_202_ACCEPTED)
async def backfill_event_summaries(
    task_type: str, task_id: UUID,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    if task_type not in {"resource", "ppt"}:
        raise HTTPException(status_code=422, detail="Invalid generation task type")
    key = (task_type, task_id)
    if key in _event_summary_backfill_running:
        return {"started": False, "alreadyRunning": True, "pending": 0}
    existing = await asyncio.to_thread(event_summary_store().latest_by_task, principal.user_id, task_type, task_id)
    if task_type == "resource":
        task = await asyncio.to_thread(resource_generation_task_store().stream_state, task_id, principal.user_id)
    else:
        task = await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)
    if not task:
        raise HTTPException(status_code=404, detail="Generation task not found")
    events = task.get("events") or []
    pending = max(0, len(events) - len(existing))
    _event_summary_backfill_running.add(key)
    asyncio.create_task(_run_event_summary_backfill(task_type, task_id, principal))
    return {"started": True, "alreadyRunning": False, "pending": pending}

@router.get("/admin-generation-events/{task_type}/{task_id}/summarize")
async def summarize_admin_generation_event(
    task_type: str, task_id: UUID, seq: int = Query(1, ge=1),
    refresh: bool = Query(False),
    principal: InternalPrincipal = Depends(require_user_principal),
):
    if task_type not in {"resource", "ppt"}:
        raise HTTPException(status_code=422, detail="Invalid generation task type")
    if task_type == "resource":
        task = await asyncio.to_thread(resource_generation_task_store().stream_state, task_id, principal.user_id)
    else:
        task = await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Generation task not found")
    events = task.get("events") or []
    if not 1 <= seq <= len(events):
        raise HTTPException(status_code=404, detail="Generation event not found")
    event = _normalize_generation_event(events[seq - 1], seq, task_type=task_type)
    payload = json.dumps(event, ensure_ascii=False, default=str)
    if len(payload) > 12000:
        payload = payload[:12000] + "…(truncated)"
    timeline = []
    normalized_events = []
    for index, raw_event in enumerate(events, start=1):
        normalized = _normalize_generation_event(raw_event, index, task_type=task_type)
        normalized_events.append(normalized)
        timeline.append(f"{normalized.get('seq')}. {normalized.get('agentName')} · {normalized.get('title')} · {normalized.get('detail') or ''}")

    existing = await asyncio.to_thread(event_summary_store().latest, principal.user_id, task_type, task_id, seq)
    if existing and not refresh:
        history = await asyncio.to_thread(event_summary_store().list_revisions, principal.user_id, task_type, task_id, seq)
        await _patch_persisted_event_summary(task_type, task_id, principal.user_id, seq, existing["summary"])
        return {"summary": existing["summary"], "model": existing["model"], "llmFallback": existing["fallback"], "saved": True, "revision": existing["revision"], "history": history}

    previous_event = normalized_events[seq - 2] if seq > 1 else None
    next_event = normalized_events[seq] if seq < len(normalized_events) else None
    previous_text = f"{previous_event.get('seq')}. {previous_event.get('agentName')} / {previous_event.get('title')} / {previous_event.get('detail') or ''}" if previous_event else "无"
    next_text = f"{next_event.get('seq')}. {next_event.get('agentName')} / {next_event.get('title')} / {next_event.get('detail') or ''}" if next_event else "无"
    snapshot = event.get("snapshot") or {}
    quiz_audit = isinstance(snapshot.get("questionAudit"), dict)
    quiz_hint = ""
    quiz_checks_text = ""
    if snapshot.get("questionNumber"):
        question_number = snapshot["questionNumber"]
        audit = snapshot.get("questionAudit")
        if isinstance(audit, dict):
            score_text = "；".join(f"{key}={value}" for key, value in (audit.get("scores") or {}).items())
            issue_text = "；".join(str(item) for item in (audit.get("issues") or [])[:3])
            checks = [item for item in audit.get("checks") or [] if isinstance(item, dict)]
            quiz_checks_text = "\n".join(
                f"- {item.get('label') or '检查项'}：{'通过' if item.get('passed') else '未通过'}；{item.get('finding') or item.get('evidence') or '无补充说明'}"
                for item in checks[:8]
            )
            quiz_hint = (
                f"题号 {question_number}，审核结论 {'通过' if audit.get('passed') else '返工'}"
                + (f"，评分 {score_text}" if score_text else "")
                + (f"，问题 {issue_text}" if issue_text else "")
            )
    if quiz_audit:
        system = (
            "你是题库单题审核摘要生成器。只输出 Markdown 分点列表，禁止口语化，禁止引言和总结，"
            "禁止出现“上一节点”“下一节点”“当前节点”等流水线叙述。"
            "根据逐项审核记录说明该题是怎么审的：每点写一个检查项名称、审核结果和关键发现；"
            "最后单独写综合结论（通过或返工），如有问题则列出关键问题。总长度 100-160 字；"
            "不要提 JSON、数据结构或 API，不要输出代码围栏。"
        )
        prompt = (
            f"任务标题：{task.get('title') or task.get('topic') or '生成任务'}\n\n"
            f"当前节点：{seq}. {event.get('agentName')} / {event.get('title')} / {event.get('phase')} / {event.get('detail') or ''}\n\n"
            + (f"逐项审核记录：\n{quiz_checks_text}\n\n" if quiz_checks_text else "")
            + f"本题审核要点：{quiz_hint}\n\n"
            + f"当前节点原始消息：{payload}"
        )
    else:
        system = (
            "你是教学资源生产流程的正式审计摘要生成器。只输出 Markdown 分点列表，禁止口语化，禁止出现“本节点”“当前节点（Agent）对…”等叙述，禁止引言和总结。"
            "每点用简短动宾结构：第一点说明上一节点，第二点说明当前节点执行动作和结果，第三点说明下一节点；最多 3 点，总长度 100-150 字；"
            "不要提 JSON、数据结构或 API，不要输出代码围栏。"
        )
        prompt = (
            f"任务标题：{task.get('title') or task.get('topic') or '生成任务'}\n\n"
            f"上一节点：{previous_text}\n\n"
            f"当前节点：{seq}. {event.get('agentName')} / {event.get('title')} / {event.get('phase')} / {event.get('detail') or ''}\n\n"
            f"下一节点：{next_text}\n\n"
            f"当前节点原始消息：{payload}"
        )
    try:
        summary = await llm_client().complete_chat(
            [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            provider="mimo", model="mimo-v2.6-flash",
        )
        fallback = bool(not summary or summary.startswith("[error]") or summary.startswith("[mock]"))
        if fallback:
            summary = f"{event.get('title')}：{event.get('detail') or '该事件已执行完成，可结合原始 JSON 查看具体内容。'}"
    except Exception:
        summary = f"{event.get('title')}：{event.get('detail') or '该事件已执行完成，可结合原始 JSON 查看具体内容。'}"
        fallback = True
    saved = await asyncio.to_thread(
        event_summary_store().save_revision, principal.user_id, task_type, task_id, seq,
        str(event.get("title") or "")[:200], str(event.get("agentName") or event.get("agent") or "")[:120],
        summary, "mimo-v2.6-flash", fallback,
    )
    history = await asyncio.to_thread(event_summary_store().list_revisions, principal.user_id, task_type, task_id, seq)
    if saved:
        await _patch_persisted_event_summary(task_type, task_id, principal.user_id, seq, summary)
    return {
        "summary": summary, "model": "mimo-v2.6-flash", "llmFallback": fallback,
        "saved": bool(saved), "revision": saved["revision"] if saved else None, "history": history,
    }


@router.post("/learning-resources/lectures", status_code=status.HTTP_201_CREATED)
async def create_lecture(request: LearningResourceCreateRequest,
                         principal: InternalPrincipal = Depends(require_user_principal)):
    payload = request.model_dump()
    context = await asyncio.to_thread(
        GoalContextService(get_settings()).build, principal.user_id, request.learning_goal_id,
    )
    topic = request.topic or context["recommendation"]["topic"]
    payload["topic"] = topic
    if request.goal_driven:
        payload["detail_level"] = context["recommendation"]["detailLevel"]
    payload["title"] = request.title or topic[:80]
    service = LearningContentService(get_settings())
    try:
        content, sources, decision = await service.generate_lecture(payload, context)
    finally:
        await service.close()
    payload["title"] = str(content.get("title") or payload["title"])[:160]
    return await asyncio.to_thread(
        learning_resource_store().create, principal.user_id, "lecture", payload, content, sources,
        None, context, decision, None, None,
        request.learner_id, request.kp_id, request.form, request.level, request.version,
        request.quiz_ids, request.kb_refs,
    )


@router.post("/learning-resources/quizzes", status_code=status.HTTP_201_CREATED)
async def create_adaptive_quiz(request: LearningResourceCreateRequest,
                               principal: InternalPrincipal = Depends(require_user_principal)):
    payload = request.model_dump()
    context = await asyncio.to_thread(
        GoalContextService(get_settings()).build, principal.user_id, request.learning_goal_id,
    )
    topic = request.topic or context["recommendation"]["topic"]
    payload["topic"] = topic
    if request.goal_driven:
        payload["question_count"] = context["recommendation"]["questionCount"]
    payload["title"] = request.title or f"{topic[:70]}分阶测试"
    candidates = await asyncio.to_thread(learning_resource_store().knowledge_point_candidates, topic)
    service = LearningContentService(get_settings())
    try:
        content, sources, state, decision = await service.generate_quiz(payload, candidates, context)
    finally:
        await service.close()
    payload["title"] = str(content.get("title") or payload["title"])[:160]
    resource = await asyncio.to_thread(
        learning_resource_store().create, principal.user_id, "quiz", payload, content, sources, state,
        context, decision, None, None,
        request.learner_id, request.kp_id, request.form, request.level, request.version,
        request.quiz_ids, request.kb_refs,
    )
    return _public_quiz(resource)


@router.post("/learning-resources/practices", status_code=status.HTTP_201_CREATED)
async def create_practice_guide(request: LearningResourceCreateRequest,
                                principal: InternalPrincipal = Depends(require_user_principal)):
    payload = request.model_dump()
    context = await asyncio.to_thread(
        GoalContextService(get_settings()).build, principal.user_id, request.learning_goal_id,
    )
    topic = request.topic or context["recommendation"]["topic"]
    payload["topic"] = topic
    payload["title"] = request.title or f"{topic[:70]}实操指南"
    service = LearningContentService(get_settings())
    try:
        content, sources, decision = await service.generate_practice(payload, context)
    finally:
        await service.close()
    payload["title"] = str(content.get("title") or payload["title"])[:160]
    return await asyncio.to_thread(
        learning_resource_store().create, principal.user_id, "practice", payload, content, sources,
        None, context, decision, None, None,
        request.learner_id, request.kp_id, request.form, request.level, request.version,
        request.quiz_ids, request.kb_refs,
    )


@router.get("/learning-resources/{resource_id}/next-question")
async def get_next_adaptive_question(resource_id: UUID,
                                     principal: InternalPrincipal = Depends(require_user_principal)):
    resource = await asyncio.to_thread(learning_resource_store().get, resource_id, principal.user_id)
    if resource is None or resource.get("type") != "quiz":
        raise HTTPException(status_code=404, detail="Quiz not found")
    question = LearningContentService.choose_next(resource["content"], resource.get("state") or {})
    if question is None:
        return {"completed": True, "question": None, "state": resource.get("state") or {}}
    public_question = {k: v for k, v in question.items() if k not in {"correctIndex", "explanation"}}
    return {"completed": False, "question": public_question, "state": resource.get("state") or {}}


@router.post("/learning-resources/{resource_id}/answers")
async def answer_adaptive_question(resource_id: UUID, request: QuizAnswerRequest,
                                   principal: InternalPrincipal = Depends(require_user_principal)):
    store = learning_resource_store()
    resource = await asyncio.to_thread(store.get, resource_id, principal.user_id)
    if resource is None or resource.get("type") != "quiz":
        raise HTTPException(status_code=404, detail="Quiz not found")
    try:
        state, feedback = LearningContentService.answer(
            resource["content"], resource.get("state") or {}, request.question_id,
            request.answer, request.duration_seconds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    content = resource.get("content") or {}
    adaptive_meta = content.get("adaptiveQuiz") or (resource.get("context") or {}).get("adaptiveQuiz")
    adaptive = bool(isinstance(adaptive_meta, dict) and adaptive_meta.get("adaptive"))
    task_store = resource_generation_task_store()
    updated = None
    next_question = None
    adaptive_final = False

    if adaptive:
        answered_count = len(state.get("answered") or [])
        adaptive_final = answered_count >= int(adaptive_meta.get("totalQuestions") or 5)
        if not adaptive_final:
            state["completed"] = False
            state["learned"] = False
            state.pop("learnedAt", None)
        task_id = None
        raw_task_id = adaptive_meta.get("taskId") or ""
        if raw_task_id:
            try:
                task_id = UUID(str(raw_task_id))
            except (TypeError, ValueError):
                task_id = None
        checkpoint = None
        if task_id is not None:
            checkpoint = await asyncio.to_thread(task_store.load_checkpoint, task_id, principal.user_id)
        checkpoint_payload = (checkpoint or {}).get("payload") or {}
        pool = checkpoint_payload.get("questions") or content.get("questions") or []
        if adaptive_final:
            updated = await asyncio.to_thread(
                store.replace_content_and_state, resource_id, principal.user_id, content, state,
            )
            if task_id is not None:
                await asyncio.to_thread(
                    _refresh_adaptive_task_after_answer, task_id, principal.user_id,
                    resource, state, content, True,
                )
        else:
            current_diff = str(
                adaptive_meta.get("currentDifficulty")
                or checkpoint_payload.get("currentDifficulty")
                or checkpoint_payload.get("initialDifficulty")
                or "medium"
            )
            next_diff = _adaptive_next_difficulty(state, current_diff)
            used = {str(item.get("questionId")) for item in state.get("answered") or []}
            # 已生成到 content 里的题同样不能再追加：否则「重新练习」清空 answered 后，
            # 同一道题会被反复追加，content.questions 越滚越大（实测 5 → 9），
            # 而 completed 判定用的是 len(content.questions)，于是永远回不到已完成（BUG-037）。
            used |= {str(item.get("id")) for item in content.get("questions") or [] if isinstance(item, dict)}
            nxt = _pick_adaptive_question(pool, next_diff, used)
            # 题量上限：题组只应保留 totalQuestions 道题。重启（重新练习）后 content 里已有整套题，
            # 若继续按「下一题」追加，会给 5 题的分阶题塞进第 6~9 题（下一次 BUG-037 的同源问题）。
            try:
                adaptive_limit = int(adaptive_meta.get("totalQuestions") or 0)
            except (TypeError, ValueError):
                adaptive_limit = 0
            room_left = adaptive_limit <= 0 or len(content.get("questions") or []) < adaptive_limit
            if nxt is not None and room_left:
                content = deepcopy(content)
                content["adaptiveQuiz"] = deepcopy(adaptive_meta)
                content["questions"] = list(content.get("questions") or []) + [nxt]
                content["adaptiveQuiz"]["currentDifficulty"] = next_diff
                content["adaptiveQuiz"]["currentIndex"] = len(content["questions"])
                updated = await asyncio.to_thread(
                    store.replace_content_and_state, resource_id, principal.user_id, content, state,
                )
                if task_id is not None:
                    await asyncio.to_thread(
                        _refresh_adaptive_task_after_answer, task_id, principal.user_id,
                        resource, state, content, False,
                    )
                next_question = {k: v for k, v in nxt.items() if k not in {"correctIndex", "explanation"}}
            else:
                updated = await asyncio.to_thread(store.update_state, resource_id, principal.user_id, state)
    else:
        updated = await asyncio.to_thread(store.update_state, resource_id, principal.user_id, state)

    question = next(q for q in resource["content"]["questions"] if q["id"] == request.question_id)
    point = next((p for p in content.get("knowledgePoints", [])
                  if str(p.get("id")) == str(question.get("knowledgePointId"))), {})
    wrong_answer = None
    if not feedback["correct"]:
        learner_id = None
        if resource.get("learnerId"):
            try: learner_id = UUID(str(resource.get("learnerId")))
            except ValueError: learner_id = None
        wrong_answer = await asyncio.to_thread(
            wrong_answer_store().record, principal.user_id, resource_id, question,
            int(request.answer), point, learner_id, "quiz", resource.get("kbRefs") or [],
        )
    previous = float((resource.get("state") or {}).get("mastery", {}).get(str(question.get("knowledgePointId")), 0.35))
    current = float(state.get("mastery", {}).get(str(question.get("knowledgePointId")), previous))
    answered_count = len(state.get("answered", []))
    decision = {
        "type": "writeback",
        "title": "答题回写",
        "detail": "ARB-05 根据本轮作答更新知识点掌握度",
        "deltas": [{"kpId": str(question.get("knowledgePointId")), "from": round(previous * 100, 1), "to": round(current * 100, 1)}],
    }
    memory_kp_id = str(resource.get("kpId") or question.get("knowledgePointId") or "")
    await _record_memory_event(
        principal.user_id, "quiz_answered", "learning_resource", f"{resource_id}:{request.question_id}",
        {"kpId": memory_kp_id, "resourceType": "quiz"},
        {"kpId": memory_kp_id, "questionId": request.question_id,
         "question": question.get("stem"), "selectedAnswer": request.answer,
         "correct": feedback["correct"], "mastery": current,
         "progress": answered_count / 5 if adaptive else answered_count / max(1, len(resource["content"].get("questions") or []))},
    )
    return {**feedback, "knowledgePoint": point, "wrongAnswer": wrong_answer,
            "state": (updated or {}).get("state") if isinstance(updated, dict) else state,
            "masteryDelta": round((current - previous) * 100, 1),
            "confidence": min(95, 40 + answered_count * 4), "decision": decision,
            "adaptive": adaptive, "adaptiveFinal": adaptive_final,
            "nextQuestion": next_question}

@router.post("/learning-resources/{resource_id}/reset")
async def reset_learning_resource(
    resource_id: UUID,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    '重新练习：清空本人对该资源的进度/作答/自评/掌握度与错题，返回全新资源。'
    store = learning_resource_store()
    resource = await asyncio.to_thread(store.get, resource_id, principal.user_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="Resource not found")
    await asyncio.to_thread(store.update_state, resource_id, principal.user_id, {})
    try:
        await asyncio.to_thread(
            wrong_answer_store().delete_by_resource, principal.user_id, resource_id,
        )
    except Exception:
        pass
    fresh = await asyncio.to_thread(store.get, resource_id, principal.user_id)
    return {"resource": fresh or resource}


@router.post("/learning-resources/{resource_id}/ability-reward")
async def reward_learning_resource_ability(
    resource_id: UUID,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    """学习资源完成后异步更新六维画像：同一资源只奖励一次。"""
    store = learning_resource_store()
    resource = await asyncio.to_thread(store.get, resource_id, principal.user_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="Resource not found")
    learner_id = resource.get("learnerId")
    if not learner_id:
        return {"rewarded": False, "reason": "no-learner"}
    try:
        learner_uuid = UUID(str(learner_id))
    except (TypeError, ValueError):
        return {"rewarded": False, "reason": "invalid-learner"}

    resource_type = str(resource.get("type") or "lecture")
    state = resource.get("state") or {}
    answered = state.get("answered") or []
    correct_rate = 1.0
    if isinstance(answered, list) and answered:
        correct_rate = sum(1 for item in answered if isinstance(item, dict) and item.get("correct")) / len(answered)

    content = resource.get("content") or {}
    hint = " ".join(str(part) for part in (
        resource.get("title"),
        content.get("title"),
        *(kp.get("name") or kp.get("id") or "" for kp in (content.get("knowledgePoints") or []) if isinstance(kp, dict)),
    ))
    result = await asyncio.to_thread(
        ability_reward_store().apply,
        principal.user_id, learner_uuid, resource_id, resource_type,
        resource.get("kpId"), hint[:300], correct_rate,
    )
    return result


@router.post("/learning-resources/{resource_id}/answers/grade")
async def grade_adaptive_question(resource_id: UUID, request: QuizAnswerRequest,
                                  principal: InternalPrincipal = Depends(require_user_principal)):
    """Return immediate grading feedback without writing learner state or wrong-answer records."""
    resource = await asyncio.to_thread(learning_resource_store().get, resource_id, principal.user_id)
    if resource is None or resource.get("type") != "quiz":
        raise HTTPException(status_code=404, detail="Quiz not found")
    try:
        _state, feedback = LearningContentService.answer(
            resource["content"], resource.get("state") or {}, request.question_id,
            request.answer, request.duration_seconds,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return feedback


@router.get("/learning-resources/{resource_id}/messages")
async def list_learning_resource_messages(resource_id: UUID,
                                          principal: InternalPrincipal = Depends(require_user_principal)):
    return {"messages": await asyncio.to_thread(
        learning_resource_store().messages, resource_id, principal.user_id,
    )}


@router.post("/learning-resources/{resource_id}/chat")
async def chat_about_learning_resource(resource_id: UUID, request: LearningResourceChatRequest,
                                       principal: InternalPrincipal = Depends(require_user_principal)):
    store = learning_resource_store()
    resource = await asyncio.to_thread(store.get, resource_id, principal.user_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="Learning resource not found")
    history = [item.model_dump() for item in request.history]
    await asyncio.to_thread(store.add_message, resource_id, principal.user_id, "user", request.message)
    service = LearningContentService(get_settings())
    try:
        memory_context = await asyncio.to_thread(
            user_memory_service().get_context, principal.user_id, "ai_tutoring",
            {"kpId": resource.get("kpId"), "resourceType": resource.get("type")}, str(resource_id),
        )
        reply, follow_ups = await service.chat(
            resource, request.message, history, current_question_id=request.current_question_id,
            memory_context=memory_context,
        )
    finally:
        await service.close()
    await asyncio.to_thread(store.add_message, resource_id, principal.user_id, "assistant", reply)
    # Fire-and-forget: extract memory signals from this conversation
    asyncio.create_task(_extract_chat_memory(
        principal.user_id, history + [{"role": "user", "content": request.message}], reply,
        {"kpId": resource.get("kpId"), "resourceType": resource.get("type")},
    ))
    return {"reply": reply, "followUps": follow_ups}


@router.post("/presentations/{task_id}/notes/draft")
async def draft_presentation_note(
    task_id: UUID,
    request: PresentationNoteDraftRequest,
    principal: InternalPrincipal = Depends(require_user_principal),
):
    task = await asyncio.to_thread(presentation_store().get, task_id, principal.user_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Presentation task not found")
    if task["status"] != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Presentation is not completed yet")
    try:
        context = _presentation_chat_context(task, request.slide_index)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    revision = (
        f"\n当前草稿：\n{request.current_draft[:12000]}\n"
        if request.current_draft else ""
    )
    prompt = (
        f"{context}\n\n用户的记笔记要求：{request.instruction}\n{revision}"
        "请整理一则供用户审核的学习笔记。笔记必须准确、简洁、可以脱离对话单独阅读；"
        "若有当前草稿，请严格按用户要求修改，不要解释修改过程。"
        "仅返回JSON：{\"title\":\"笔记标题\",\"content\":\"Markdown正文\"}"
    )
    fallback_title = f"第 {request.slide_index + 1} 页笔记"
    result = await llm_client().complete_json(
        system="你是学习笔记编辑，只输出合法JSON。",
        prompt=prompt,
        fallback={"title": fallback_title, "content": request.current_draft or request.instruction},
        provider="mimo",
        reasoning_effort="low",
        max_retries=2,
        max_tokens=1600,
    )
    return {
        "title": str(result.get("title") or fallback_title)[:160],
        "content": str(result.get("content") or request.current_draft or request.instruction)[:20000],
        "sourceType": "presentation",
        "sourceRef": str(task_id),
        "sourceContext": f"第 {request.slide_index + 1} 页 · {task.get('title') or ''}"[:500],
    }


@router.post("/agent-runs", response_model=AgentRunResponse)
async def run_agents(request: AgentRunRequest,
                     principal: InternalPrincipal = Depends(require_user_principal)):
    state = await workflow().run(await enriched_state(principal, request))
    return AgentRunResponse(run_id=state.run_id, status=state.status,
                            result=state.final_content, errors=state.errors)


@router.post("/agent-runs/stream")
async def stream_agents(request: AgentRunRequest,
                        principal: InternalPrincipal = Depends(require_user_principal)):
    state = await enriched_state(principal, request)

    async def events():
        async for event in workflow().stream(state):
            yield f"data: {event.model_dump_json()}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/agent-runs/{run_id}")
async def get_run(run_id: UUID, principal: InternalPrincipal = Depends(require_user_principal)):
    result = repository().get(run_id, principal.user_id)
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent run not found")
    return result


@router.post("/chat/attachments", status_code=status.HTTP_201_CREATED)
async def upload_chat_attachment(file: UploadFile = File(...),
                                 principal: InternalPrincipal = Depends(require_user_principal)):
    data = await file.read()
    store = attachment_store()
    try:
        return await asyncio.to_thread(store.save, principal.user_id,
                                       file.filename or "attachment", file.content_type, data)
    except AttachmentError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))


@router.get("/chat/attachments/{attachment_id}")
async def download_chat_attachment(attachment_id: UUID,
                                   principal: InternalPrincipal = Depends(require_user_principal)):
    store = attachment_store()
    row = await asyncio.to_thread(store.get_owned, attachment_id, principal.user_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment not found")
    path = store.path_for(row)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment file is missing")
    return FileResponse(path, media_type=row["mime_type"], filename=row["filename"])


@router.post("/chat/sessions")
async def create_chat_session(principal: InternalPrincipal = Depends(require_user_principal)):
    return await asyncio.to_thread(require_chat_store().create_session, principal.user_id)


@router.get("/chat/sessions")
async def list_chat_sessions(archived: bool = False,
                             principal: InternalPrincipal = Depends(require_user_principal)):
    return {"sessions": await asyncio.to_thread(
        require_chat_store().list_sessions, principal.user_id, archived
    )}


@router.get("/chat/sessions/{session_id}/messages")
async def list_chat_messages(session_id: UUID, principal: InternalPrincipal = Depends(require_user_principal)):
    await asyncio.to_thread(owned_session, session_id, principal.user_id)
    return {"messages": await asyncio.to_thread(require_chat_store().list_messages, session_id)}


@router.put("/chat/sessions/{session_id}/rename")
async def rename_chat_session(session_id: UUID, body: dict,
                               principal: InternalPrincipal = Depends(require_user_principal)):
    title = (body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Title is required")
    store = require_chat_store()
    await asyncio.to_thread(owned_session, session_id, principal.user_id)
    result = await asyncio.to_thread(store.rename_session, session_id, principal.user_id, title)
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat session not found")
    return result


@router.put("/chat/sessions/{session_id}/archive")
async def archive_chat_session(session_id: UUID, body: dict,
                               principal: InternalPrincipal = Depends(require_user_principal)):
    archived = body.get("archived")
    if not isinstance(archived, bool):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Archived must be a boolean")
    result = await asyncio.to_thread(
        require_chat_store().set_archived, session_id, principal.user_id, archived
    )
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat session not found")
    return result


@router.delete("/chat/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_chat_session(session_id: UUID, principal: InternalPrincipal = Depends(require_user_principal)):
    deleted = await asyncio.to_thread(require_chat_store().delete_session, session_id, principal.user_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat session not found")


async def build_llm_messages(request: ChatRequest, user_id: UUID) -> list[dict]:
    messages = chat_messages(request)
    store = attachment_store()
    for index, item in enumerate(request.messages):
        if not item.attachments:
            continue
        rows = await asyncio.to_thread(store.get_many_owned,
                                       [ref.id for ref in item.attachments], user_id)
        if rows:
            messages[index + 1]["content"] = store.augment_content(item.content, rows)
    try:
        context = await asyncio.to_thread(
            user_memory_service().get_context, user_id, "ai_tutoring", {},
            str(request.session_id) if request.session_id else None,
        )
        prompt = UserMemoryService.prompt_block(context)
        if prompt:
            messages.insert(1 if messages and messages[0].get("role") == "system" else 0,
                            {"role": "system", "content": prompt})
    except Exception:
        logger.exception("Failed to load memory context for chat")
    return messages


async def persist_user_message(request: ChatRequest, user_id: UUID) -> None:
    if request.session_id is None:
        return
    await asyncio.to_thread(owned_session, request.session_id, user_id)
    last = request.messages[-1]
    if last.role != "user":
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="The last message must come from the user")
    attachment_ids = [ref.id for ref in last.attachments or []]
    if not last.content.strip() and not attachment_ids:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Message content or attachments are required")
    store = require_chat_store()
    await asyncio.to_thread(store.append_message, request.session_id, "user", last.content,
                            None, attachment_ids, user_id)
    title_source = last.content.strip()
    if not title_source and last.attachments:
        title_source = f"[附件] {last.attachments[0].name or '图片'}"
    await asyncio.to_thread(store.auto_title, request.session_id, title_source)



@router.post("/graph-suggest", status_code=status.HTTP_200_OK)
async def admin_graph_suggest(
    payload: dict,
    _: InternalPrincipal = Depends(require_user_principal),
):
    """轻量 AI 建议：不走 chat agent / memory，只让模型返回结构化边数组."""
    nodes = payload.get("nodes") or []
    edges = payload.get("edges") or []
    system = (
        "你是知识网络教研助手。只允许返回一个 JSON 对象，字段为 edges，值是标准 JSON 数组。"
        "不要 Markdown、不要代码块、不要解释。edges 中每条必须使用数字 id，字段固定为 prereqCategoryId、categoryId、edgeType、rationale；"
        "edgeType 只能是 prerequisite、related 或 contrasts_with。若没有合理建议就返回 {\"edges\": []}。"
    )
    prompt = (
        f"章节：{json.dumps(nodes, ensure_ascii=False)}\n"
        f"已有边：{json.dumps(edges, ensure_ascii=False)}\n"
        "最多给 5 条最合理的建议，理由控制在 20 字以内。"
    )
    result = await llm_client().complete_json(
        system, prompt,
        {"edges": []},
        provider="mimo-legacy",
        max_tokens=900,
        timeout_seconds=45,
    )
    return {"edges": result.get("edges") or []}


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest,
               principal: InternalPrincipal = Depends(require_user_principal)):
    await persist_user_message(request, principal.user_id)
    messages = await build_llm_messages(request, principal.user_id)
    reply, _ = await chat_agent(provider=request.model_provider).run(messages, user_id=principal.user_id)
    if request.session_id is not None:
        await asyncio.to_thread(require_chat_store().append_message,
                                request.session_id, "assistant", reply)
    # Fire-and-forget: extract memory signals from this conversation
    user_messages = [{"role": m.role, "content": m.content} for m in request.messages]
    asyncio.create_task(_extract_chat_memory(principal.user_id, user_messages, reply, {}))
    return ChatResponse(reply=reply)


@router.post("/chat/stream")
async def stream_chat(request: ChatRequest,
                      principal: InternalPrincipal = Depends(require_user_principal)):
    await persist_user_message(request, principal.user_id)
    messages = await build_llm_messages(request, principal.user_id)
    session_id = request.session_id
    provider = request.model_provider
    include_reasoning = request.include_reasoning

    # Pre-create assistant message in DB
    persisted_msg_id = None
    if session_id is not None:
        try:
            msg = await asyncio.to_thread(require_chat_store().append_message,
                                          session_id, "assistant", "")
            persisted_msg_id = UUID(msg["id"]) if msg else None
        except Exception:
            pass

    # Queue: background task pushes events, SSE generator reads
    # Use shared queue per session so reconnecting clients can resume
    queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=200)
    if session_id:
        _active_sessions[str(session_id)] = queue

    async def run_agent():
        """Run agent in background, persist to DB, push events to queue."""
        reply_parts: list[str] = []
        reasoning_parts: list[str] = []
        update_counter = 0
        refused = False
        source_items: list[dict] = []
        citation_items: list[dict] = []

        def tools_payload() -> list[dict] | None:
            """Persisted tool metadata (references) attached to the reply."""
            tools: list[dict] = []
            if source_items:
                tools.append({"tool": "__sources__", "name": "__sources__",
                              "status": "done", "sources": source_items})
            if citation_items:
                tools.append({"tool": "__citations__", "name": "__citations__",
                              "status": "done", "sources": citation_items})
            return tools or None

        try:
            async for event in chat_agent(provider=provider).stream(
                messages, include_reasoning=include_reasoning, user_id=principal.user_id):
                # Build SSE payload
                if event["type"] == "phase":
                    phase_text = f"[{event.get('phase', '')}] {event.get('message', '')}\n"
                    reasoning_parts.append(phase_text)
                    payload = {"type": "phase", "phase": event.get("phase"), "message": event.get("message")}
                elif event["type"] == "reasoning":
                    reasoning_parts.append(event["text"])
                    payload = {"type": "chat_reasoning_delta", "content": event["text"]}
                elif event["type"] == "content":
                    reply_parts.append(event["text"])
                    payload = {"type": "chat_delta", "content": event["text"]}
                elif event["type"] == "tool_call_started":
                    args = event.get("arguments") or {}
                    args_brief = ", ".join(f"{k}={v!r}" for k, v in args.items()) if isinstance(args, dict) else str(args)
                    if reasoning_parts and not reasoning_parts[-1].endswith("\n"):
                        reasoning_parts.append("\n")
                    reasoning_parts.append(f"🔧 {event.get('name', event.get('tool', ''))}({args_brief})\n")
                    payload = {"type": "tool_call_started", "tool": event["tool"],
                               "name": event["name"], "arguments": event["arguments"]}
                elif event["type"] == "tool_call_completed":
                    status_mark = "✓" if event.get("success") is not False else "✗"
                    preview = event.get("preview", "")
                    reasoning_parts.append(f"  {status_mark} {preview}\n")
                    if event.get("sources"):
                        source_items.extend(event["sources"])
                    full_result = event.get("result", "")
                    if full_result:
                        persisted_result = json.dumps(
                            {"tool": event.get("tool", ""), "result": full_result},
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        reasoning_parts.append(f"[[ITN_TOOL_RESULT]]{persisted_result}\n")
                    payload = {"type": "tool_call_completed", "tool": event["tool"],
                               "name": event["name"], "success": event["success"],
                               "preview": event["preview"],
                               "result": event.get("result", "")}
                elif event["type"] == "sources":
                    source_items = event.get("sources") or []
                    payload = {"type": "sources", "sources": source_items}
                elif event["type"] == "citation_validation":
                    citation_items = event.get("citations") or []
                    payload = {"type": "citation_validation", "citations": citation_items}
                elif event["type"] == "agent_started":
                    reasoning_parts.append(f"[agent] {event.get('name', event.get('agent', ''))} ｜ {event.get('detail', '')}\n")
                    payload = event
                elif event["type"] == "agent_completed":
                    mark = "✓" if event.get("success") is not False else "✗"
                    reasoning_parts.append(f"[agent] {mark} {event.get('name', '')} ｜ {event.get('output', '')}\n")
                    payload = event
                elif event["type"] == "refused":
                    refused = True
                    banner = event.get("banner", "")
                    signal = event.get("signal", "")
                    # Replace (not append) any partial reply with the
                    # refusal banner so the assistant message displays
                    # a clean one-liner instead of millions of tokens
                    # of internal refusal monologue.
                    reply_parts = [banner] if banner else reply_parts
                    reasoning_parts = [f"[模型拒绝] signal={signal}\n"]
                    payload = {"type": "refused", "signal": signal, "banner": banner}
                else:
                    continue
                try:
                    queue.put_nowait(payload)
                except asyncio.QueueFull:
                    pass  # Client not reading, continue generating
                # Persist every 20 events
                update_counter += 1
                if persisted_msg_id and update_counter % 20 == 0:
                    try:
                        await asyncio.to_thread(
                            require_chat_store().update_message,
                            persisted_msg_id, "".join(reply_parts),
                            "".join(reasoning_parts) or None,
                            tools_payload())
                    except Exception:
                        pass
            try:
                if refused:
                    queue.put_nowait({"type": "chat_failed", "code": "CHAT_REFUSED_BY_MODEL"})
                else:
                    queue.put_nowait({"type": "chat_completed"})
            except asyncio.QueueFull:
                pass
        except Exception:
            try:
                if reply_parts or reasoning_parts:
                    queue.put_nowait({"type": "chat_completed"})
                else:
                    queue.put_nowait({"type": "chat_failed", "code": "CHAT_EXECUTION_FAILED"})
            except asyncio.QueueFull:
                pass
        finally:
            # Always persist final state to DB
            if persisted_msg_id and (reply_parts or reasoning_parts):
                try:
                    await asyncio.to_thread(
                        require_chat_store().update_message,
                        persisted_msg_id, "".join(reply_parts),
                        "".join(reasoning_parts) or None,
                        tools_payload())
                except BaseException:
                    pass
            if session_id:
                _active_sessions.pop(str(session_id), None)
            try:
                queue.put_nowait(None)  # Sentinel: done
            except asyncio.QueueFull:
                pass

    # Start background task (runs independently of SSE connection)
    task = asyncio.create_task(run_agent())

    async def events():
        """SSE generator: reads from queue, yields to client."""
        try:
            while True:
                payload = await queue.get()
                if payload is None:
                    break
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            # Client disconnected - background task continues and persists to DB
            pass

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/chat/sessions/{session_id}/active")
async def check_session_active(session_id: UUID,
                                principal: InternalPrincipal = Depends(require_user_principal)):
    """Check if a session has an active background generation task."""
    store = require_chat_store()
    session = await asyncio.to_thread(store.get_session, session_id, principal.user_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return {"active": str(session_id) in _active_sessions}


@router.get("/chat/sessions/{session_id}/resume")
async def resume_chat_stream(session_id: UUID,
                              principal: InternalPrincipal = Depends(require_user_principal)):
    """Resume SSE stream for an active session. Returns events from the shared queue."""
    store = require_chat_store()
    session = await asyncio.to_thread(store.get_session, session_id, principal.user_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    queue = _active_sessions.get(str(session_id))
    if queue is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No active stream for this session")

    async def events():
        try:
            while True:
                payload = await queue.get()
                if payload is None:
                    break
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            pass

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/chat/sessions/{session_id}/active")
async def check_session_active(session_id: UUID,
                                principal: InternalPrincipal = Depends(require_user_principal)):
    """Check if a session has an active background generation task."""
    store = require_chat_store()
    session = await asyncio.to_thread(store.get_session, session_id, principal.user_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return {"active": str(session_id) in _active_sessions}


@router.get("/chat/sessions/{session_id}/resume")
async def resume_chat_stream(session_id: UUID,
                              principal: InternalPrincipal = Depends(require_user_principal)):
    """Resume SSE stream for an active session. Returns events from the shared queue."""
    store = require_chat_store()
    session = await asyncio.to_thread(store.get_session, session_id, principal.user_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    queue = _active_sessions.get(str(session_id))
    if queue is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No active stream for this session")

    async def events():
        try:
            while True:
                payload = await queue.get()
                if payload is None:
                    break
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            pass

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
