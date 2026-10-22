from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator
from pydantic_core import PydanticCustomError


class RunStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class AgentRunRequest(BaseModel):
    learning_goal_id: UUID = Field(validation_alias=AliasChoices("learning_goal_id", "learningGoalId"))
    content: str = Field(min_length=1, max_length=20000)
    profile: dict[str, Any] = Field(default_factory=dict)
    input: dict[str, Any] = Field(default_factory=dict)


class WorkflowState(BaseModel):
    run_id: UUID = Field(default_factory=uuid4)
    user_id: UUID
    learning_goal_id: UUID
    content: str
    profile: dict[str, Any] = Field(default_factory=dict)
    input: dict[str, Any] = Field(default_factory=dict)
    diagnosis: dict[str, Any] = Field(default_factory=dict)
    skill_sequence: list[dict[str, Any]] = Field(default_factory=list)
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    candidates: list[dict[str, Any]] = Field(default_factory=list)
    defects: list[dict[str, Any]] = Field(default_factory=list)
    final_content: dict[str, Any] | None = None
    risk_assessment: dict[str, Any] = Field(default_factory=dict)
    executed_agents: list[str] = Field(default_factory=list)
    errors: list[dict[str, str]] = Field(default_factory=list)
    status: RunStatus = RunStatus.PENDING
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AgentEvent(BaseModel):
    type: str
    run_id: UUID
    sequence: int
    agent: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)


class AgentRunResponse(BaseModel):
    run_id: UUID
    status: RunStatus
    result: dict[str, Any] | None = None
    errors: list[dict[str, str]] = Field(default_factory=list)


class ChatAttachmentRef(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: UUID
    name: str | None = Field(default=None, max_length=255)
    mime_type: str | None = Field(default=None, max_length=128,
                                  validation_alias=AliasChoices("mime_type", "mimeType"))


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="ignore")

    role: Literal["system", "user", "assistant"]
    content: str = Field(default="", max_length=20000)
    attachments: list[ChatAttachmentRef] | None = Field(default=None, max_length=8)


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    messages: list[ChatMessage] = Field(min_length=1, max_length=100)
    # 随堂问答系统提示词常驻完整演讲稿，按 MiMo v2.6 512K 上下文设计
    system_prompt: str | None = Field(default=None, max_length=200000,
                                      validation_alias=AliasChoices("system_prompt", "systemPrompt"))
    include_reasoning: bool = Field(default=False,
                                    validation_alias=AliasChoices("include_reasoning", "includeReasoning"))
    session_id: UUID | None = Field(default=None,
                                    validation_alias=AliasChoices("session_id", "sessionId"))
    model_provider: str = Field(default="kimi",
                                validation_alias=AliasChoices("model_provider", "modelProvider"))


class ChatResponse(BaseModel):
    reply: str


class PresentationChatRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    messages: list[ChatMessage] = Field(min_length=1, max_length=40)
    slide_index: int = Field(ge=0, validation_alias=AliasChoices("slide_index", "slideIndex"))
    session_id: UUID | None = Field(default=None,
                                    validation_alias=AliasChoices("session_id", "sessionId"))
    include_reasoning: bool = Field(default=False,
                                    validation_alias=AliasChoices("include_reasoning", "includeReasoning"))
    model_provider: str = Field(default="mimo",
                                validation_alias=AliasChoices("model_provider", "modelProvider"))


class AgentInferRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    learner_id: UUID = Field(validation_alias=AliasChoices("learner_id", "learnerId"))
    signal: dict = Field(default_factory=dict)
    session_id: UUID | None = Field(default=None, validation_alias=AliasChoices("session_id", "sessionId"))


class AgentAskRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    learner_id: UUID = Field(validation_alias=AliasChoices("learner_id", "learnerId"))
    ask_type: str = Field(default="free", max_length=24, validation_alias=AliasChoices("ask_type", "askType"))
    text: str = Field(default="", max_length=2000)
    kp_id: str | None = Field(default=None, max_length=64, validation_alias=AliasChoices("kp_id", "kpId"))
    session_id: UUID | None = Field(default=None, validation_alias=AliasChoices("session_id", "sessionId"))
    page_context: str | None = Field(default=None, max_length=500,
                                     validation_alias=AliasChoices("page_context", "pageContext"))
    page_state: dict = Field(default_factory=dict,
                             validation_alias=AliasChoices("page_state", "pageState"))


class AgentSimilarQuizRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    learner_id: UUID = Field(validation_alias=AliasChoices("learner_id", "learnerId"))
    kp_id: str | None = Field(default=None, max_length=64, validation_alias=AliasChoices("kp_id", "kpId"))
    session_id: UUID | None = Field(default=None, validation_alias=AliasChoices("session_id", "sessionId"))
    page_context: str | None = Field(default=None, max_length=500,
                                     validation_alias=AliasChoices("page_context", "pageContext"))
    page_state: dict = Field(default_factory=dict,
                             validation_alias=AliasChoices("page_state", "pageState"))
    quiz_follow_up: dict | None = Field(default=None,
                                        validation_alias=AliasChoices("quiz_follow_up", "quizFollowUp"))


class PresentationProgressRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    page_index: int | None = Field(default=None, ge=0, validation_alias=AliasChoices("page_index", "pageIndex"))
    page_count: int | None = Field(default=None, ge=1, validation_alias=AliasChoices("page_count", "pageCount"))
    learned: bool | None = None
    mastery: float | None = Field(default=None, ge=0, le=1)


class PresentationTtsRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str = Field(min_length=1, max_length=3000)
    voice: str | None = Field(default=None, max_length=40)
    speed: str | None = Field(default=None, max_length=16)
    model_provider: str = Field(default="mimo",
                                validation_alias=AliasChoices("model_provider", "modelProvider"))


class NoteCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=20000)
    status: Literal["pending_review", "approved"] = "approved"
    source_type: str = Field(default="manual",
                             validation_alias=AliasChoices("source_type", "sourceType"),
                             max_length=32)
    learner_id: UUID | None = Field(default=None,
                                    validation_alias=AliasChoices("learner_id", "learnerId"))
    kp_id: str | None = Field(default=None, max_length=64,
                               validation_alias=AliasChoices("kp_id", "kpId"))
    source_kind: str | None = Field(default=None, max_length=32,
                                     validation_alias=AliasChoices("source_kind", "sourceKind"))
    kb_refs: list[str] = Field(default_factory=list, max_length=20,
                                 validation_alias=AliasChoices("kb_refs", "kbRefs"))
    source_ref: str | None = Field(default=None,
                                   validation_alias=AliasChoices("source_ref", "sourceRef"),
                                   max_length=128)
    source_context: str | None = Field(default=None,
                                       validation_alias=AliasChoices("source_context", "sourceContext"),
                                       max_length=500)
    category_id: UUID | None = Field(default=None,
                                     validation_alias=AliasChoices("category_id", "categoryId"))
    knowledge_category_id: int | None = Field(default=None, ge=1,
        validation_alias=AliasChoices("knowledge_category_id", "knowledgeCategoryId"))
    knowledge_category_name: str | None = Field(default=None, max_length=160,
        validation_alias=AliasChoices("knowledge_category_name", "knowledgeCategoryName"))


class NoteUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    content: str | None = Field(default=None, min_length=1, max_length=20000)
    status: Literal["pending_review", "approved"] | None = None
    learner_id: UUID | None = Field(default=None,
                                    validation_alias=AliasChoices("learner_id", "learnerId"))
    kp_id: str | None = Field(default=None, max_length=64,
                               validation_alias=AliasChoices("kp_id", "kpId"))
    source_kind: str | None = Field(default=None, max_length=32,
                                     validation_alias=AliasChoices("source_kind", "sourceKind"))
    kb_refs: list[str] | None = Field(default=None, max_length=20,
                                       validation_alias=AliasChoices("kb_refs", "kbRefs"))
    category_id: UUID | None = Field(default=None,
                                     validation_alias=AliasChoices("category_id", "categoryId"))
    knowledge_category_id: int | None = Field(default=None, ge=1,
        validation_alias=AliasChoices("knowledge_category_id", "knowledgeCategoryId"))
    knowledge_category_name: str | None = Field(default=None, max_length=160,
        validation_alias=AliasChoices("knowledge_category_name", "knowledgeCategoryName"))


class NoteCategoryCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    color: str = Field(default="#5b7f68", pattern=r"^#[0-9a-fA-F]{6}$")


class NoteCategoryUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class LearningResourceCreateRequest(BaseModel):
    topic: str | None = Field(default=None, min_length=2, max_length=500)
    title: str | None = Field(default=None, max_length=160)
    learning_goal_id: UUID | None = Field(
        default=None, validation_alias=AliasChoices("learning_goal_id", "learningGoalId"),
    )
    learner_id: UUID | None = Field(default=None,
                                    validation_alias=AliasChoices("learner_id", "learnerId"))
    kp_id: str | None = Field(default=None, max_length=64,
                               validation_alias=AliasChoices("kp_id", "kpId"))
    form: Literal["lecture", "guide", "quiz", "practice"] | None = None
    level: Literal["basic", "advanced", "challenge"] | None = None
    version: str | None = Field(default=None, max_length=16,
                                 validation_alias=AliasChoices("version", "version"))
    quiz_ids: list[str] = Field(default_factory=list, max_length=100,
                                 validation_alias=AliasChoices("quiz_ids", "quizIds"))
    kb_refs: list[str] = Field(default_factory=list, max_length=50,
                                 validation_alias=AliasChoices("kb_refs", "kbRefs"))
    detail_level: Literal["concise", "balanced", "detailed"] = Field(
        default="balanced", validation_alias=AliasChoices("detail_level", "detailLevel"),
    )
    question_count: int = Field(
        default=15, ge=6, le=30, validation_alias=AliasChoices("question_count", "questionCount"),
    )
    goal_driven: bool = Field(
        default=False, validation_alias=AliasChoices("goal_driven", "goalDriven"),
    )
    generation_context: dict | None = Field(
        default=None, validation_alias=AliasChoices("generation_context", "generationContext"),
    )


class CourseCreateRequest(BaseModel):
    prompt: str = Field(default="", max_length=3000)
    learning_goal_id: UUID | None = Field(
        default=None, validation_alias=AliasChoices("learning_goal_id", "learningGoalId"),
    )
    learner_id: UUID | None = Field(
        default=None, validation_alias=AliasChoices("learner_id", "learnerId"),
    )
    learning_goal_ids: list[UUID] = Field(
        default_factory=list,
        validation_alias=AliasChoices("learning_goal_ids", "learningGoalIds"),
        max_length=8,
    )
    resource_types: list[Literal["ppt", "lecture", "practice", "quiz"]] = Field(
        default_factory=lambda: ["ppt", "lecture", "practice", "quiz"],
        validation_alias=AliasChoices("resource_types", "resourceTypes"),
        min_length=0, max_length=4,
    )
    depth: Literal["introductory", "systematic", "advanced"] = "systematic"
    scale: Literal["compact", "standard", "complete"] = "standard"
    course_style: Literal[
        "none", "colorful-ink", "sunset-mountains", "abstract-gradient",
        "clean-minimal", "cartoon-doodle", "blue-white-minimal",
        "blue-conference", "morandi-blue-gray", "business-gray", "watercolor",
    ] = Field(
        default="none", validation_alias=AliasChoices("course_style", "courseStyle"),
    )


class CourseRegenerateRequest(BaseModel):
    learner_id: UUID | None = Field(
        default=None, validation_alias=AliasChoices("learner_id", "learnerId"),
    )
    resource_types: list[Literal["ppt", "lecture", "practice", "quiz"]] = Field(
        default_factory=lambda: ["lecture", "practice", "quiz"],
        validation_alias=AliasChoices("resource_types", "resourceTypes"),
        min_length=1, max_length=4,
    )


class LearningResourceChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[ChatMessage] = Field(default_factory=list, max_length=20)
    current_question_id: str | None = Field(
        default=None, max_length=80,
        validation_alias=AliasChoices("current_question_id", "currentQuestionId"),
    )


class LearningResourceProgressRequest(BaseModel):
    """Persist resumable progress without replacing quiz or completion state."""

    current_block_id: str | None = Field(
        default=None, max_length=160,
        validation_alias=AliasChoices("current_block_id", "currentBlockId"),
    )
    visited_block_ids: list[str] = Field(
        default_factory=list, max_length=500,
        validation_alias=AliasChoices("visited_block_ids", "visitedBlockIds"),
    )
    completed_step_ids: list[str] = Field(
        default_factory=list, max_length=200,
        validation_alias=AliasChoices("completed_step_ids", "completedStepIds"),
    )
    elapsed_seconds: int = Field(
        default=0, ge=0, le=31_536_000,
        validation_alias=AliasChoices("elapsed_seconds", "elapsedSeconds"),
    )
    self_assessments: dict[str, float] = Field(
        default_factory=dict,
        validation_alias=AliasChoices("self_assessments", "selfAssessments"),
    )


class LearningResourceSourceFeedbackRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    source_id: str = Field(
        min_length=1, max_length=160,
        validation_alias=AliasChoices("source_id", "sourceId"),
    )
    issue_type: Literal["needs_review", "mismatch", "outdated", "broken_link", "other"] = Field(
        default="needs_review",
        validation_alias=AliasChoices("issue_type", "issueType"),
    )
    note: str | None = Field(default=None, max_length=1000)


class CourseUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise PydanticCustomError("blank_title", "title must not be blank")
        return value


class CourseChapterUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str | None = Field(default=None, min_length=1, max_length=200)
    summary: str | None = Field(default=None, max_length=1000)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise PydanticCustomError("blank_title", "title must not be blank")
        return value


class QuizAnswerRequest(BaseModel):
    question_id: str = Field(min_length=1, max_length=80,
                             validation_alias=AliasChoices("question_id", "questionId"))
    answer: str = Field(min_length=1, max_length=4000)
    duration_seconds: int = Field(default=0, ge=0, le=7200,
                                  validation_alias=AliasChoices("duration_seconds", "durationSeconds"))


class WrongAnswerUpdateRequest(BaseModel):
    review_status: Literal["unreviewed", "reviewing", "mastered"] | None = Field(
        default=None, validation_alias=AliasChoices("review_status", "reviewStatus"))
    mastered: bool | None = None
    streak: int | None = Field(default=None, ge=0)
    last_pick: int | None = Field(default=None, ge=-1)
    knowledge_category_id: int | None = Field(default=None, ge=1,
        validation_alias=AliasChoices("knowledge_category_id", "knowledgeCategoryId"))
    knowledge_category_name: str | None = Field(default=None, max_length=160,
        validation_alias=AliasChoices("knowledge_category_name", "knowledgeCategoryName"))


class WrongAnswerReviewRequest(BaseModel):
    answer: int = Field(ge=0, le=25)


class AgentSessionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    learner_id: UUID | None = Field(default=None,
                                    validation_alias=AliasChoices("learner_id", "learnerId"))
    session_type: str = Field(default="agent", max_length=32)
    title: str | None = Field(default=None, max_length=255)

class AgentSessionUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = Field(min_length=1, max_length=255)

class AgentMessageCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    agent_id: str | None = Field(default=None, max_length=64)
    kind: str = Field(default="agent", max_length=32)
    content: str = Field(min_length=1, max_length=10000)

class AgentDecisionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    stage: str = Field(min_length=1, max_length=32)
    text: str = Field(min_length=1, max_length=1000)

class TutoringSessionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    learner_code: str | None = Field(default=None, min_length=1, max_length=64,
                             validation_alias=AliasChoices("learner_code", "learnerCode"))
    resource_id: UUID | None = Field(
        default=None, validation_alias=AliasChoices("resource_id", "resourceId"),
    )
    title: str | None = Field(default=None, max_length=255)

class TutoringAnswerRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    option_index: int | None = Field(
        default=None, ge=0, validation_alias=AliasChoices("option_index", "optionIndex"),
    )
    option_label: str | None = Field(
        default=None, max_length=500,
        validation_alias=AliasChoices("option_label", "optionLabel"),
    )
    free_text: str | None = Field(
        default=None, max_length=4000,
        validation_alias=AliasChoices("free_text", "freeText"),
    )


class PresentationNoteDraftRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    instruction: str = Field(min_length=1, max_length=1000)
    slide_index: int = Field(ge=0, validation_alias=AliasChoices("slide_index", "slideIndex"))
    current_draft: str | None = Field(
        default=None,
        validation_alias=AliasChoices("current_draft", "currentDraft"),
        max_length=12000,
    )


class AssistantPlanRequest(BaseModel):
    command: str = Field(min_length=1, max_length=1000)
    context: dict[str, Any] = Field(default_factory=dict)


class TeachingGroupRunRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    learner_id: UUID = Field(
        validation_alias=AliasChoices("learner_id", "learnerId"),
    )
    knowledge_point_id: str | None = Field(
        default=None, max_length=64,
        validation_alias=AliasChoices("knowledge_point_id", "knowledgePointId"),
    )
    mode: Literal["prepare_next", "diagnose", "explain"] = "prepare_next"
    prompt: str | None = Field(default=None, max_length=1000)
