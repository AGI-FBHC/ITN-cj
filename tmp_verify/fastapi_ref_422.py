"""422 envelope ground truth for the agents service.

Mounts the real request models (transcribed from
src/agents/app/domain/models.py + public.py:3050) behind the REAL custom
RequestValidationError handler (src/agents/app/main.py:44-46) and captures the
exact JSON FastAPI returns for every validation case the Spire call sites cover.

Python 3.9 transcription rule (same as fastapi_ref_presentations.py):
  X | None  ->  Optional[X]
Everything else is verbatim. Run with the base Anaconda env (pydantic 2.10.4).
"""
from typing import Any, Dict, List, Literal, Optional
from uuid import UUID

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator
from pydantic_core import PydanticCustomError
from fastapi.testclient import TestClient

# ---------- models (transcribed; Optional[] for py3.9) ----------

class NoteCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=20000)
    status: Literal["pending_review", "approved"] = "approved"
    source_type: str = Field(default="manual", max_length=32,
                             validation_alias=AliasChoices("source_type", "sourceType"))
    learner_id: Optional[UUID] = Field(default=None,
                                       validation_alias=AliasChoices("learner_id", "learnerId"))
    kp_id: Optional[str] = Field(default=None, max_length=64,
                                 validation_alias=AliasChoices("kp_id", "kpId"))
    source_kind: Optional[str] = Field(default=None, max_length=32,
                                       validation_alias=AliasChoices("source_kind", "sourceKind"))
    kb_refs: List[str] = Field(default_factory=list, max_length=20,
                               validation_alias=AliasChoices("kb_refs", "kbRefs"))
    source_ref: Optional[str] = Field(default=None, max_length=128,
                                      validation_alias=AliasChoices("source_ref", "sourceRef"))
    source_context: Optional[str] = Field(default=None, max_length=500,
                                          validation_alias=AliasChoices("source_context", "sourceContext"))
    category_id: Optional[UUID] = Field(default=None,
                                        validation_alias=AliasChoices("category_id", "categoryId"))
    knowledge_category_id: Optional[int] = Field(default=None, ge=1,
        validation_alias=AliasChoices("knowledge_category_id", "knowledgeCategoryId"))
    knowledge_category_name: Optional[str] = Field(default=None, max_length=160,
        validation_alias=AliasChoices("knowledge_category_name", "knowledgeCategoryName"))


class NoteUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=160)
    content: Optional[str] = Field(default=None, min_length=1, max_length=20000)
    status: Optional[Literal["pending_review", "approved"]] = None
    learner_id: Optional[UUID] = Field(default=None,
                                       validation_alias=AliasChoices("learner_id", "learnerId"))
    kp_id: Optional[str] = Field(default=None, max_length=64,
                                 validation_alias=AliasChoices("kp_id", "kpId"))
    source_kind: Optional[str] = Field(default=None, max_length=32,
                                       validation_alias=AliasChoices("source_kind", "sourceKind"))
    kb_refs: Optional[List[str]] = Field(default=None, max_length=20,
                                         validation_alias=AliasChoices("kb_refs", "kbRefs"))
    category_id: Optional[UUID] = Field(default=None,
                                        validation_alias=AliasChoices("category_id", "categoryId"))
    knowledge_category_id: Optional[int] = Field(default=None, ge=1,
        validation_alias=AliasChoices("knowledge_category_id", "knowledgeCategoryId"))
    knowledge_category_name: Optional[str] = Field(default=None, max_length=160,
        validation_alias=AliasChoices("knowledge_category_name", "knowledgeCategoryName"))


class NoteCategoryCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    color: str = Field(default="#5b7f68", pattern=r"^#[0-9a-fA-F]{6}$")


class NoteCategoryUpdateRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class LearningResourceCreateRequest(BaseModel):
    topic: Optional[str] = Field(default=None, min_length=2, max_length=500)
    title: Optional[str] = Field(default=None, max_length=160)
    learning_goal_id: Optional[UUID] = Field(
        default=None, validation_alias=AliasChoices("learning_goal_id", "learningGoalId"),
    )
    learner_id: Optional[UUID] = Field(default=None,
                                       validation_alias=AliasChoices("learner_id", "learnerId"))
    kp_id: Optional[str] = Field(default=None, max_length=64,
                                 validation_alias=AliasChoices("kp_id", "kpId"))
    form: Optional[Literal["lecture", "guide", "quiz", "practice"]] = None
    level: Optional[Literal["basic", "advanced", "challenge"]] = None
    version: Optional[str] = Field(default=None, max_length=16,
                                   validation_alias=AliasChoices("version", "version"))
    quiz_ids: List[str] = Field(default_factory=list, max_length=100,
                                validation_alias=AliasChoices("quiz_ids", "quizIds"))
    kb_refs: List[str] = Field(default_factory=list, max_length=50,
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
    generation_context: Optional[dict] = Field(
        default=None, validation_alias=AliasChoices("generation_context", "generationContext"),
    )


class CourseUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: Optional[str] = Field(default=None, min_length=1, max_length=160)
    description: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value):
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise PydanticCustomError("blank_title", "title must not be blank")
        return value


class CourseChapterUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    summary: Optional[str] = Field(default=None, max_length=1000)

    @field_validator("title")
    @classmethod
    def normalize_title(cls, value):
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise PydanticCustomError("blank_title", "title must not be blank")
        return value


class AddToWrongBookRequest(BaseModel):
    resourceId: Optional[UUID] = None
    questionId: str
    stem: str
    options: List[str] = []
    userAnswer: int
    correctAnswer: int
    explanation: str = ""
    difficulty: str = "medium"
    kpId: Optional[str] = None
    knowledgeCategoryName: Optional[str] = None


class WrongAnswerUpdateRequest(BaseModel):
    review_status: Optional[Literal["unreviewed", "reviewing", "mastered"]] = Field(
        default=None, validation_alias=AliasChoices("review_status", "reviewStatus"))
    mastered: Optional[bool] = None
    streak: Optional[int] = Field(default=None, ge=0)
    last_pick: Optional[int] = Field(default=None, ge=-1)
    knowledge_category_id: Optional[int] = Field(default=None, ge=1,
        validation_alias=AliasChoices("knowledge_category_id", "knowledgeCategoryId"))
    knowledge_category_name: Optional[str] = Field(default=None, max_length=160,
        validation_alias=AliasChoices("knowledge_category_name", "knowledgeCategoryName"))


class WrongAnswerReviewRequest(BaseModel):
    answer: int = Field(ge=0, le=25)


class AgentSessionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    learner_id: Optional[UUID] = Field(default=None,
                                       validation_alias=AliasChoices("learner_id", "learnerId"))
    session_type: str = Field(default="agent", max_length=32)
    title: Optional[str] = Field(default=None, max_length=255)


class AgentSessionUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str = Field(min_length=1, max_length=255)


class AgentMessageCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    agent_id: Optional[str] = Field(default=None, max_length=64)
    kind: str = Field(default="agent", max_length=32)
    content: str = Field(min_length=1, max_length=10000)


class AgentDecisionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    stage: str = Field(min_length=1, max_length=32)
    text: str = Field(min_length=1, max_length=1000)


class QuizAnswerRequest(BaseModel):
    question_id: str = Field(min_length=1, max_length=80,
                             validation_alias=AliasChoices("question_id", "questionId"))
    answer: str = Field(min_length=1, max_length=4000)
    duration_seconds: int = Field(default=0, ge=0, le=7200,
                                  validation_alias=AliasChoices("duration_seconds", "durationSeconds"))


class LearningResourceProgressRequest(BaseModel):
    """Persist resumable progress without replacing quiz or completion state."""

    current_block_id: Optional[str] = Field(
        default=None, max_length=160,
        validation_alias=AliasChoices("current_block_id", "currentBlockId"),
    )
    visited_block_ids: List[str] = Field(
        default_factory=list, max_length=500,
        validation_alias=AliasChoices("visited_block_ids", "visitedBlockIds"),
    )
    completed_step_ids: List[str] = Field(
        default_factory=list, max_length=200,
        validation_alias=AliasChoices("completed_step_ids", "completedStepIds"),
    )
    elapsed_seconds: int = Field(
        default=0, ge=0, le=31_536_000,
        validation_alias=AliasChoices("elapsed_seconds", "elapsedSeconds"),
    )
    self_assessments: Dict[str, float] = Field(
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
    note: Optional[str] = Field(default=None, max_length=1000)


# ---------- app with the REAL handler (main.py:44-46) ----------

app = FastAPI()


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422,
                        content={"code": "VALIDATION_FAILED", "details": exc.errors()})


@app.post("/note")
async def note(r: NoteCreateRequest):
    return {"ok": True}


@app.put("/note")
async def note_up(r: NoteUpdateRequest):
    return {"ok": True}


@app.post("/cat")
async def cat(r: NoteCategoryCreateRequest):
    return {"ok": True}


@app.put("/cat")
async def cat_up(r: NoteCategoryUpdateRequest):
    return {"ok": True}


@app.post("/resource")
async def resource(r: LearningResourceCreateRequest):
    return {"ok": True}


@app.put("/course")
async def course(r: CourseUpdateRequest):
    return {"ok": True}


@app.put("/chapter")
async def chapter(r: CourseChapterUpdateRequest):
    return {"ok": True}


@app.post("/wrong")
async def wrong(r: AddToWrongBookRequest):
    return {"ok": True}


@app.put("/wrong")
async def wrong_up(r: WrongAnswerUpdateRequest):
    return {"ok": True}


@app.post("/review")
async def review(r: WrongAnswerReviewRequest):
    return {"ok": True}


@app.post("/sess")
async def sess(r: AgentSessionCreateRequest):
    return {"ok": True}


@app.put("/sess")
async def sess_up(r: AgentSessionUpdateRequest):
    return {"ok": True}


@app.post("/msg")
async def msg(r: AgentMessageCreateRequest):
    return {"ok": True}


@app.post("/dec")
async def dec(r: AgentDecisionCreateRequest):
    return {"ok": True}


@app.get("/courses")
async def courses(learnerId: Optional[UUID] = Query(default=None, alias="learnerId")):
    return {"ok": True}


@app.post("/quiz")
async def quiz(r: QuizAnswerRequest):
    return {"ok": True}


@app.post("/prog")
async def prog(r: LearningResourceProgressRequest):
    return {"ok": True}


@app.post("/sf")
async def sf(r: LearningResourceSourceFeedbackRequest):
    return {"ok": True}


@app.get("/km")
async def km(query: str = Query(min_length=1, max_length=1000)):
    return {"ok": True}


@app.get("/res")
async def res_list(
    resource_type: Optional[str] = None,
    include_course: bool = False,
    learner_id: Optional[UUID] = Query(default=None, validation_alias=AliasChoices("learner_id", "learnerId")),
    kp_id: Optional[str] = Query(default=None, max_length=64, validation_alias=AliasChoices("kp_id", "kpId")),
    form: Optional[str] = Query(default=None, validation_alias=AliasChoices("form", "form")),
    level: Optional[str] = Query(default=None, validation_alias=AliasChoices("level", "level")),
    course_id: Optional[UUID] = Query(default=None, alias="courseId"),
    chapter_id: Optional[UUID] = Query(default=None, alias="chapterId"),
):
    return {"ok": True}


client = TestClient(app, raise_server_exceptions=False)

CASES = [
    # --- NoteCreateRequest ---
    ("note missing title", "POST", "/note", {"content": "c"}),
    ("note missing content", "POST", "/note", {"title": "t"}),
    ("note title too short", "POST", "/note", {"title": "", "content": "c"}),
    ("note title too long", "POST", "/note", {"title": "x" * 161, "content": "c"}),
    ("note content too short", "POST", "/note", {"title": "t", "content": ""}),
    ("note content too long", "POST", "/note", {"title": "t", "content": "x" * 20001}),
    ("note status literal", "POST", "/note", {"title": "t", "content": "c", "status": "bogus"}),
    ("note title int", "POST", "/note", {"title": 5, "content": "c"}),
    ("note title null", "POST", "/note", {"title": None, "content": "c"}),
    ("note kpId too long", "POST", "/note", {"title": "t", "content": "c", "kpId": "k" * 65}),
    ("note knowledgeCategoryId ge", "POST", "/note", {"title": "t", "content": "c", "knowledgeCategoryId": 0}),
    ("note knowledgeCategoryId not int", "POST", "/note", {"title": "t", "content": "c", "knowledgeCategoryId": "x"}),
    ("note category_id bad uuid", "POST", "/note", {"title": "t", "content": "c", "categoryId": "zz"}),
    ("note kbRefs too long", "POST", "/note", {"title": "t", "content": "c", "kbRefs": ["a"] * 21}),
    ("note kbRefs not list", "POST", "/note", {"title": "t", "content": "c", "kbRefs": "x"}),
    ("note multi", "POST", "/note", {"title": "", "content": ""}),
    ("note body array", "POST", "/note", ["x"]),
    ("note body string", "POST", "/note", "x"),
    ("note body null", "POST", "/note", None),
    # --- NoteUpdateRequest ---
    ("noteup title too long", "PUT", "/note", {"title": "x" * 161}),
    ("noteup status literal", "PUT", "/note", {"status": "bogus"}),
    ("noteup title null ok", "PUT", "/note", {"title": None}),
    # --- NoteCategoryCreateRequest ---
    ("cat missing name", "POST", "/cat", {}),
    ("cat name too short", "POST", "/cat", {"name": ""}),
    ("cat name too long", "POST", "/cat", {"name": "n" * 81}),
    ("cat color pattern", "POST", "/cat", {"name": "n", "color": "red"}),
    ("cat color default ok", "POST", "/cat", {"name": "n"}),
    ("catup color pattern", "PUT", "/cat", {"color": "#12"}),
    ("catup name missing ok", "PUT", "/cat", {}),
    # --- LearningResourceCreateRequest ---
    ("res topic too short", "POST", "/resource", {"topic": "a"}),
    ("res topic too long", "POST", "/resource", {"topic": "t" * 501}),
    ("res title too long", "POST", "/resource", {"title": "t" * 161}),
    ("res form literal", "POST", "/resource", {"form": "bogus"}),
    ("res level literal", "POST", "/resource", {"level": "bogus"}),
    ("res detailLevel literal", "POST", "/resource", {"detailLevel": "bogus"}),
    ("res questionCount ge", "POST", "/resource", {"questionCount": 5}),
    ("res questionCount le", "POST", "/resource", {"questionCount": 31}),
    ("res questionCount not int", "POST", "/resource", {"questionCount": "x"}),
    ("res goalDriven not bool", "POST", "/resource", {"goalDriven": "x"}),
    ("res learnerId bad uuid", "POST", "/resource", {"learnerId": "zz"}),
    ("res quizIds too long", "POST", "/resource", {"quizIds": ["a"] * 101}),
    ("res empty ok", "POST", "/resource", {}),
    ("res multi", "POST", "/resource", {"topic": "a", "form": "bogus", "questionCount": 5}),
    # --- CourseUpdateRequest ---
    ("course title blank", "PUT", "/course", {"title": "   "}),
    ("course title empty", "PUT", "/course", {"title": ""}),
    ("course title too long", "PUT", "/course", {"title": "t" * 161}),
    ("course title int", "PUT", "/course", {"title": 5}),
    ("course desc too long", "PUT", "/course", {"description": "d" * 2001}),
    ("course blank + desc", "PUT", "/course", {"title": "  ", "description": "d" * 2001}),
    ("course empty body ok", "PUT", "/course", {}),
    # --- CourseChapterUpdateRequest ---
    ("chapter title blank", "PUT", "/chapter", {"title": "  "}),
    ("chapter title too long", "PUT", "/chapter", {"title": "t" * 201}),
    ("chapter summary too long", "PUT", "/chapter", {"summary": "s" * 1001}),
    # --- AddToWrongBookRequest ---
    ("wrong missing questionId", "POST", "/wrong", {"stem": "s", "userAnswer": 0, "correctAnswer": 1}),
    ("wrong missing stem", "POST", "/wrong", {"questionId": "q", "userAnswer": 0, "correctAnswer": 1}),
    ("wrong missing userAnswer", "POST", "/wrong", {"questionId": "q", "stem": "s", "correctAnswer": 1}),
    ("wrong missing correctAnswer", "POST", "/wrong", {"questionId": "q", "stem": "s", "userAnswer": 0}),
    ("wrong resourceId bad uuid", "POST", "/wrong", {"resourceId": "zz", "questionId": "q", "stem": "s", "userAnswer": 0, "correctAnswer": 1}),
    ("wrong options not list", "POST", "/wrong", {"questionId": "q", "stem": "s", "options": "x", "userAnswer": 0, "correctAnswer": 1}),
    ("wrong userAnswer not int", "POST", "/wrong", {"questionId": "q", "stem": "s", "userAnswer": "x", "correctAnswer": 1}),
    ("wrong multi", "POST", "/wrong", {}),
    # --- WrongAnswerUpdateRequest ---
    ("wa reviewStatus literal", "PUT", "/wrong", {"reviewStatus": "bogus"}),
    ("wa mastered not bool", "PUT", "/wrong", {"mastered": "x"}),
    ("wa mastered int1", "PUT", "/wrong", {"mastered": 1}),
    ("wa streak ge", "PUT", "/wrong", {"streak": -1}),
    ("wa lastPick ge", "PUT", "/wrong", {"lastPick": -2}),
    ("wa knowledgeCategoryId ge", "PUT", "/wrong", {"knowledgeCategoryId": 0}),
    ("wa knowledgeCategoryName too long", "PUT", "/wrong", {"knowledgeCategoryName": "n" * 161}),
    ("wa empty ok", "PUT", "/wrong", {}),
    # --- WrongAnswerReviewRequest ---
    ("review missing answer", "POST", "/review", {}),
    ("review answer ge", "POST", "/review", {"answer": -1}),
    ("review answer le", "POST", "/review", {"answer": 26}),
    ("review answer not int", "POST", "/review", {"answer": "x"}),
    ("review answer ok", "POST", "/review", {"answer": 0}),
    # --- agent session / message / decision ---
    ("sess learnerId bad uuid", "POST", "/sess", {"learnerId": "zz"}),
    ("sess title too long", "POST", "/sess", {"title": "t" * 256}),
    ("sess sessionType too long", "POST", "/sess", {"sessionType": "s" * 33}),
    ("sess empty ok", "POST", "/sess", {}),
    ("sessup missing title", "PUT", "/sess", {}),
    ("sessup title too short", "PUT", "/sess", {"title": ""}),
    ("sessup title too long", "PUT", "/sess", {"title": "t" * 256}),
    ("msg missing content", "POST", "/msg", {}),
    ("msg content too short", "POST", "/msg", {"content": ""}),
    ("msg content too long", "POST", "/msg", {"content": "c" * 10001}),
    ("msg agentId too long", "POST", "/msg", {"content": "c", "agentId": "a" * 65}),
    ("dec missing stage", "POST", "/dec", {"text": "t"}),
    ("dec missing text", "POST", "/dec", {"stage": "s"}),
    ("dec stage too short", "POST", "/dec", {"stage": "", "text": "t"}),
    # --- query ---
    ("query learnerId bad uuid", "GET", "/courses?learnerId=zz", None),
    ("query learnerId empty", "GET", "/courses?learnerId=", None),
    ("query learnerId ok", "GET", "/courses?learnerId=11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", None),
    # --- gaps filled after the first capture ---
    ("note categoryId int", "POST", "/note", {"title": "t", "content": "c", "categoryId": 5}),
    ("note categoryId array", "POST", "/note", {"title": "t", "content": "c", "categoryId": ["a"]}),
    ("note categoryId object", "POST", "/note", {"title": "t", "content": "c", "categoryId": {"a": 1}}),
    ("note categoryId null ok", "POST", "/note", {"title": "t", "content": "c", "categoryId": None}),
    ("note learnerId empty str", "POST", "/note", {"title": "t", "content": "c", "learnerId": ""}),
    ("note knowledgeCategoryId null ok", "POST", "/note", {"title": "t", "content": "c", "knowledgeCategoryId": None}),
    ("note knowledgeCategoryId float", "POST", "/note", {"title": "t", "content": "c", "knowledgeCategoryId": 1.5}),
    ("note knowledgeCategoryId true", "POST", "/note", {"title": "t", "content": "c", "knowledgeCategoryId": True}),
    ("note knowledgeCategoryId str ok", "POST", "/note", {"title": "t", "content": "c", "knowledgeCategoryId": "3"}),
    ("note kbRefs item not str", "POST", "/note", {"title": "t", "content": "c", "kbRefs": [1]}),
    ("note kbRefs empty ok", "POST", "/note", {"title": "t", "content": "c", "kbRefs": []}),
    ("note title bool", "POST", "/note", {"title": True, "content": "c"}),
    ("note status missing ok", "POST", "/note", {"title": "t", "content": "c"}),
    ("note status null", "POST", "/note", {"title": "t", "content": "c", "status": None}),
    ("note sourceType too long", "POST", "/note", {"title": "t", "content": "c", "sourceType": "s" * 33}),
    ("note sourceType null ok", "POST", "/note", {"title": "t", "content": "c", "sourceType": None}),
    ("note both missing", "POST", "/note", {}),
    ("wrong options item not str", "POST", "/wrong", {"questionId": "q", "stem": "s", "options": [1], "userAnswer": 0, "correctAnswer": 1}),
    ("wrong userAnswer null", "POST", "/wrong", {"questionId": "q", "stem": "s", "userAnswer": None, "correctAnswer": 1}),
    ("wrong userAnswer float", "POST", "/wrong", {"questionId": "q", "stem": "s", "userAnswer": 1.5, "correctAnswer": 1}),
    ("wrong userAnswer bool", "POST", "/wrong", {"questionId": "q", "stem": "s", "userAnswer": True, "correctAnswer": 1}),
    ("wrong questionId null", "POST", "/wrong", {"questionId": None, "stem": "s", "userAnswer": 0, "correctAnswer": 1}),
    ("wa streak str ok", "PUT", "/wrong", {"streak": "3"}),
    ("wa streak null ok", "PUT", "/wrong", {"streak": None}),
    ("wa last_pick str ok", "PUT", "/wrong", {"last_pick": "2"}),
    ("wa last_pick ge", "PUT", "/wrong", {"last_pick": -2}),
    ("wa last_pick null ok", "PUT", "/wrong", {"last_pick": None}),
    ("wa mastered str true", "PUT", "/wrong", {"mastered": "true"}),
    ("wa reviewStatus null", "PUT", "/wrong", {"reviewStatus": None}),
    ("wa both bad", "PUT", "/wrong", {"streak": -1, "last_pick": -2}),
    ("res title blank ok", "POST", "/resource", {"title": ""}),
    ("res topic null ok", "POST", "/resource", {"topic": None}),
    ("res questionCount null ok", "POST", "/resource", {"questionCount": None}),
    ("res questionCount str ok", "POST", "/resource", {"questionCount": "20"}),
    ("res goalDriven str true", "POST", "/resource", {"goalDriven": "true"}),
    ("res detailLevel missing ok", "POST", "/resource", {}),
    ("res quizIds item not str", "POST", "/resource", {"quizIds": [1]}),
    ("res quizIds empty ok", "POST", "/resource", {"quizIds": []}),
    ("res title null ok", "POST", "/resource", {"title": None}),
    ("res genCtx not dict", "POST", "/resource", {"generationContext": 5}),
    ("res genCtx null ok", "POST", "/resource", {"generationContext": None}),
    ("res genCtx ok", "POST", "/resource", {"generationContext": {"adminGeneration": True}}),
    ("res kbRefs too long", "POST", "/resource", {"kbRefs": ["k"] * 51}),
    ("res kbRefs not list", "POST", "/resource", {"kbRefs": "x"}),
    ("res detailLevel null", "POST", "/resource", {"detailLevel": None}),
    ("res version too long", "POST", "/resource", {"version": "v" * 17}),
    ("res kpId too long", "POST", "/resource", {"kpId": "k" * 65}),
    ("res learningGoalId bad", "POST", "/resource", {"learningGoalId": "zz"}),
    ("res quizIds not list", "POST", "/resource", {"quizIds": 5}),
    ("res questionCount str bad", "POST", "/resource", {"questionCount": "x"}),
    ("res goalDriven null", "POST", "/resource", {"goalDriven": None}),
    ("res topic 2 ok", "POST", "/resource", {"topic": "ab"}),
    ("res topic int", "POST", "/resource", {"topic": 5}),
    ("res qc snake bad camel good", "POST", "/resource", {"question_count": "x", "questionCount": 15}),
    ("res qc both snake good camel bad", "POST", "/resource", {"question_count": 15, "questionCount": "x"}),
    ("res genCtx snake ok", "POST", "/resource", {"generation_context": {"a": 1}}),
    ("course title null ok", "PUT", "/course", {"title": None}),
    ("chapter title null ok", "PUT", "/chapter", {"title": None}),
    ("sess session_type null", "POST", "/sess", {"session_type": None}),
    ("sess session_type too long", "POST", "/sess", {"session_type": "s" * 33}),
    ("sess title null ok", "POST", "/sess", {"title": None}),
    ("sessup title null", "PUT", "/sess", {"title": None}),
    ("msg kind null", "POST", "/msg", {"content": "c", "kind": None}),
    ("msg agent_id null ok", "POST", "/msg", {"content": "c", "agent_id": None}),
    ("msg agent_id too long", "POST", "/msg", {"content": "c", "agent_id": "a" * 65}),
    ("dec stage null", "POST", "/dec", {"stage": None, "text": "t"}),
    ("dec multi", "POST", "/dec", {}),
    ("note cat name int", "POST", "/cat", {"name": 5}),
    ("note cat name null", "POST", "/cat", {"name": None}),
    ("catup name too long", "PUT", "/cat", {"name": "n" * 81}),
    ("catup both bad", "PUT", "/cat", {"name": "", "color": "red"}),

    # --- QuizAnswerRequest ---
    ("quiz missing question_id", "POST", "/quiz", {"answer": "a"}),
    ("quiz missing answer", "POST", "/quiz", {"questionId": "q"}),
    ("quiz multi", "POST", "/quiz", {}),
    ("quiz questionId too short", "POST", "/quiz", {"questionId": "", "answer": "a"}),
    ("quiz questionId too long", "POST", "/quiz", {"questionId": "q" * 81, "answer": "a"}),
    ("quiz questionId null", "POST", "/quiz", {"questionId": None, "answer": "a"}),
    ("quiz answer too short", "POST", "/quiz", {"questionId": "q", "answer": ""}),
    ("quiz answer too long", "POST", "/quiz", {"questionId": "q", "answer": "a" * 4001}),
    ("quiz duration ge", "POST", "/quiz", {"questionId": "q", "answer": "a", "durationSeconds": -1}),
    ("quiz duration le", "POST", "/quiz", {"questionId": "q", "answer": "a", "durationSeconds": 7201}),
    ("quiz duration not int", "POST", "/quiz", {"questionId": "q", "answer": "a", "durationSeconds": "x"}),
    ("quiz duration null", "POST", "/quiz", {"questionId": "q", "answer": "a", "durationSeconds": None}),
    ("quiz duration float", "POST", "/quiz", {"questionId": "q", "answer": "a", "durationSeconds": 1.5}),
    ("quiz duration str ok", "POST", "/quiz", {"questionId": "q", "answer": "a", "durationSeconds": "3"}),
    ("quiz snake ok", "POST", "/quiz", {"question_id": "q", "answer": "a"}),
    ("quiz camel ok", "POST", "/quiz", {"questionId": "q", "answer": "a"}),
    ("quiz both aliases snake wins", "POST", "/quiz", {"question_id": "q", "questionId": "", "answer": "a"}),

    # --- LearningResourceProgressRequest ---
    ("prog empty ok", "POST", "/prog", {}),
    ("prog currentBlockId too long", "POST", "/prog", {"currentBlockId": "c" * 161}),
    ("prog currentBlockId null ok", "POST", "/prog", {"currentBlockId": None}),
    ("prog currentBlockId int", "POST", "/prog", {"currentBlockId": 5}),
    ("prog visited too long", "POST", "/prog", {"visitedBlockIds": ["a"] * 501}),
    ("prog visited not list", "POST", "/prog", {"visitedBlockIds": "x"}),
    ("prog visited item not str", "POST", "/prog", {"visitedBlockIds": [1]}),
    ("prog completed too long", "POST", "/prog", {"completedStepIds": ["a"] * 201}),
    ("prog completed not list", "POST", "/prog", {"completedStepIds": 5}),
    ("prog elapsed ge", "POST", "/prog", {"elapsedSeconds": -1}),
    ("prog elapsed le", "POST", "/prog", {"elapsedSeconds": 31536001}),
    ("prog elapsed not int", "POST", "/prog", {"elapsedSeconds": "x"}),
    ("prog elapsed null", "POST", "/prog", {"elapsedSeconds": None}),
    ("prog elapsed str ok", "POST", "/prog", {"elapsedSeconds": "3"}),
    ("prog assessments not dict", "POST", "/prog", {"selfAssessments": "x"}),
    ("prog assessments null", "POST", "/prog", {"selfAssessments": None}),
    ("prog assessments bad value", "POST", "/prog", {"selfAssessments": {"k": "x"}}),
    ("prog assessments int value ok", "POST", "/prog", {"selfAssessments": {"k": 2}}),
    ("prog multi", "POST", "/prog", {"visitedBlockIds": ["a"] * 501, "elapsedSeconds": -1}),
    ("prog currentBlockId + elapsed", "POST", "/prog", {"currentBlockId": "c" * 161, "elapsedSeconds": -1}),

    # --- LearningResourceSourceFeedbackRequest ---
    ("sf missing sourceId", "POST", "/sf", {}),
    ("sf sourceId too short", "POST", "/sf", {"sourceId": ""}),
    ("sf sourceId too long", "POST", "/sf", {"sourceId": "s" * 161}),
    ("sf sourceId null", "POST", "/sf", {"sourceId": None}),
    ("sf issueType literal", "POST", "/sf", {"sourceId": "s", "issueType": "bogus"}),
    ("sf issueType null", "POST", "/sf", {"sourceId": "s", "issueType": None}),
    ("sf issueType missing ok", "POST", "/sf", {"sourceId": "s"}),
    ("sf note too long", "POST", "/sf", {"sourceId": "s", "note": "n" * 1001}),
    ("sf note null ok", "POST", "/sf", {"sourceId": "s", "note": None}),
    ("sf multi", "POST", "/sf", {"sourceId": "", "issueType": "bogus"}),
    ("sf snake ok", "POST", "/sf", {"source_id": "s"}),
    ("sf camel ok", "POST", "/sf", {"sourceId": "s"}),

    # --- knowledge-match query ---
    ("km missing", "GET", "/km", None),
    ("km empty", "GET", "/km?query=", None),
    ("km too long", "GET", "/km?query=" + "q" * 1001, None),
    ("km spaces ok", "GET", "/km?query=%20%20", None),
    ("km ok", "GET", "/km?query=abc", None),

    # --- list-learning-resources query ---
    ("resq learnerId bad", "GET", "/res?learnerId=zz", None),
    ("resq learner_id bad", "GET", "/res?learner_id=zz", None),
    ("resq learner both snake bad camel good", "GET",
     "/res?learner_id=zz&learnerId=11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", None),
    ("resq learner both snake good camel bad", "GET",
     "/res?learner_id=11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa&learnerId=zz", None),
    ("resq kpId too long", "GET", "/res?kpId=" + "k" * 65, None),
    ("resq kp_id too long", "GET", "/res?kp_id=" + "k" * 65, None),
    ("resq kpId both snake long camel short", "GET",
     "/res?kp_id=" + "k" * 65 + "&kpId=short", None),
    ("resq courseId bad", "GET", "/res?courseId=zz", None),
    ("resq courseId empty", "GET", "/res?courseId=", None),
    ("resq chapterId bad", "GET", "/res?chapterId=zz", None),
    ("resq course_id snake ignored", "GET", "/res?course_id=zz", None),
    ("resq includeCourse bad", "GET", "/res?include_course=abc", None),
    ("resq includeCourse empty", "GET", "/res?include_course=", None),
    ("resq includeCourse ok", "GET", "/res?include_course=true", None),

    # --- more dict / query edge cases ---
    ("prog assessments bool value", "POST", "/prog", {"selfAssessments": {"k": True}}),
    ("prog assessments null value", "POST", "/prog", {"selfAssessments": {"k": None}}),
    ("prog assessments list value", "POST", "/prog", {"selfAssessments": {"k": []}}),
    ("prog assessments str float ok", "POST", "/prog", {"selfAssessments": {"k": "1.5"}}),
    ("prog assessments two bad", "POST", "/prog", {"selfAssessments": {"a": "x", "b": "y"}}),
    ("resq includeCourse 1", "GET", "/res?include_course=1", None),
    ("resq includeCourse 0", "GET", "/res?include_course=0", None),
    ("resq includeCourse TRUE", "GET", "/res?include_course=TRUE", None),
    ("resq includeCourse on", "GET", "/res?include_course=on", None),
    ("resq includeCourse yes", "GET", "/res?include_course=yes", None),
]

out = []
for name, method, path, body in CASES:
    if method == "GET":
        r = client.get(path)
    elif method == "POST":
        r = client.post(path, json=body)
    else:
        r = client.put(path, json=body)
    out.append({"name": name, "method": method, "path": path, "body": body,
                "status": r.status_code, "json": r.json()})

import json
import os
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fastapi_ref_422.json"),
          "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

for item in out:
    print(item["name"], "->", item["status"], json.dumps(item["json"], ensure_ascii=False)[:300])
