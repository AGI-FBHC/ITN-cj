"""题库管理端 REST API（DESIGN v2 §10）.

前缀 /v1，与 agents 服务风格一致；T5.1 起挂内部服务签名鉴权（见 `web/app.py`
`dependencies=[Depends(require_internal_principal)]`）——`QB_INTERNAL_SECRET`
未配置时仍豁免放行（过渡期），配置后强制校验。
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException

from questionbank.config import get_settings
from questionbank.llm import LLMClient
from questionbank.services.knowledge_core import KnowledgeCore, KnowledgeCoreClient
from questionbank.services.question import (
    AttemptService,
    DuplicateQuestionError,
    QuestionCreate,
    QuestionNotFoundError,
    QuestionNotActiveError,
    QuestionSelector,
    QuestionService,
    QuestionUpdate,
    RevalidationService,
    ValidationError,
)
from questionbank.services.question.generator import GenerationRejected, QuestionGenerator
from questionbank.services.question.reviewer import QuestionReviewer, REVIEW_PROMPT_VERSION
from questionbank.store import QuestionStore

router = APIRouter(prefix="/v1/questions", tags=["questions"])
practice_router = APIRouter(prefix="/v1/practice", tags=["practice"])
revalidation_router = APIRouter(prefix="/v1/revalidation", tags=["revalidation"])


def _service() -> QuestionService:
    return QuestionService(QuestionStore(get_settings()))


def _generator() -> QuestionGenerator:
    settings = get_settings()
    return QuestionGenerator(
        LLMClient(settings),
        _service(),
        settings,
    )


def _knowledge_core() -> KnowledgeCore:
    settings = get_settings()
    if not settings.knowledge_core_url:
        raise HTTPException(status_code=503, detail="KNOWLEDGE_CORE_URL 未配置，无法出题")
    return KnowledgeCore.from_url(
        settings.knowledge_core_url,
        timeout=settings.knowledge_core_timeout,
        secret=settings.kc_internal_secret,
    )


def _reviewer() -> QuestionReviewer:
    return QuestionReviewer(LLMClient(get_settings()))


def _error(exc: Exception, status: int = 400) -> HTTPException:
    return HTTPException(status_code=status, detail=str(exc))


async def _resolve_frontier_category_ids(user_id: str) -> list[int] | None:
    """follow-up d：取 KC 学习前沿（T4.2）的 category_id 列表，供 frontier_first 选题用.

    先按 KNOWLEDGE_CORE_DOMAIN 拿 domain_id（复用 coverage 接口的响应字段，避免
    新增领域解析逻辑），再查 frontier 接口。KC 未配置/不可达/响应异常 —— 任一
    环节失败都返回 None（调用方据此降级为普通选题，不影响取题主链路）。
    """
    settings = get_settings()
    if not settings.knowledge_core_url:
        return None
    client = KnowledgeCoreClient(
        settings.knowledge_core_url,
        timeout=settings.knowledge_core_timeout,
        secret=settings.kc_internal_secret,
    )
    try:
        coverage = await client.fetch_coverage(domain=settings.knowledge_core_domain)
        domain_id = coverage.get("domain_id")
        if not domain_id:
            return None
        nodes = await client.fetch_frontier(int(domain_id), user_id)
        return [int(n["category_id"]) for n in nodes if n.get("category_id") is not None]
    except Exception:  # noqa: BLE001 — KC 不可达/响应异常：降级为普通选题
        return None
    finally:
        await client.aclose()


# ── 查询 ──────────────────────────────────────────────────────────────────


@router.get("")
def list_questions(
    category_id: int | None = None,
    difficulty: int | None = None,
    question_type: str | None = None,
    cognitive_level: str | None = None,
    status: str | None = None,
    keyword: str | None = None,
    page: int = 0,
    size: int = 20,
):
    return _service().search(
        category_id=category_id,
        difficulty=difficulty,
        question_type=question_type,
        cognitive_level=cognitive_level,
        status=status,
        keyword=keyword,
        page=page,
        size=size,
    )


# ── 知识点目录（供前端下拉） ───────────────────────────────────────────────


@router.get("/categories")
async def list_categories(domain: str = "agent"):
    """知识点/章节列表（转发 KC 覆盖报告）：{category_id, name, level, node_type, chunk_count, gap}."""
    settings = get_settings()
    if not settings.knowledge_core_url:
        raise HTTPException(status_code=503, detail="KNOWLEDGE_CORE_URL 未配置")
    client = KnowledgeCoreClient(
        settings.knowledge_core_url,
        timeout=settings.knowledge_core_timeout,
        secret=settings.kc_internal_secret,
    )
    try:
        data = await client.fetch_coverage(domain=domain)
    finally:
        await client.aclose()
    items = [
        {
            "category_id": int(i["category_id"]),
            "name": i.get("name", ""),
            "level": int(i.get("level", 0)),
            "node_type": i.get("node_type", ""),
            "chunk_count": int(i.get("chunk_count", 0)),
            "gap": i.get("gap", ""),
        }
        for i in data.get("items", [])
    ]
    return {"total": len(items), "items": items}


@router.get("/stats/overview")
def stats_overview():
    """题库总览：总数 / 按状态 / 按题型 / 按难度（题库看板）."""
    return _service().store.stats_overview()


@router.get("/stats/by-category")
def stats_by_category():
    """按知识点聚合题目数（primary 归属）：{category_id, name, total, active, by_difficulty, by_status}."""
    return {"items": _service().store.stats_by_category()}





@router.get("/review-queue")
def review_queue(page: int = 0, size: int = 50):
    """待审队列（proposed，AI 题先审后用）."""
    return _service().search(status="proposed", page=page, size=size)


@router.get("/{question_id}")
def get_question(question_id: int):
    try:
        return _service().get(question_id)
    except QuestionNotFoundError as exc:
        raise _error(exc, 404) from exc


# ── 创建 / 更新 / 删除 ────────────────────────────────────────────────────


@router.post("", status_code=201)
def create_question(data: QuestionCreate):
    try:
        return _service().create(data)
    except DuplicateQuestionError as exc:
        raise _error(exc, 409) from exc
    except ValidationError as exc:
        raise _error(exc, 422) from exc


@router.post("/import")
def import_questions(items: list[QuestionCreate]):
    """批量导入（幂等：content_hash 命中 → skipped）."""
    return _service().import_batch(items)


@router.put("/{question_id}")
def update_question(question_id: int, data: QuestionUpdate):
    try:
        return _service().update(question_id, data)
    except QuestionNotFoundError as exc:
        raise _error(exc, 404) from exc
    except (DuplicateQuestionError, ValidationError) as exc:
        raise _error(exc, 409 if isinstance(exc, DuplicateQuestionError) else 422) from exc


@router.delete("/{question_id}")
def delete_question(question_id: int):
    """软删除（deprecated）."""
    try:
        _service().delete(question_id)
        return {"deleted": True}
    except QuestionNotFoundError as exc:
        raise _error(exc, 404) from exc
    except ValidationError as exc:
        raise _error(exc, 422) from exc


# ── 审核 ──────────────────────────────────────────────────────────────────


@router.post("/{question_id}/review")
def review_question(question_id: int, status: str):
    """审核：proposed → active / rejected."""
    try:
        return _service().set_status(question_id, status)
    except QuestionNotFoundError as exc:
        raise _error(exc, 404) from exc
    except ValidationError as exc:
        raise _error(exc, 422) from exc


@router.post("/review/batch")
def review_batch(payload: dict[str, Any]):
    """批量审核：{"items": [{"question_id": 1, "status": "active"}, …]}."""
    service = _service()
    results = []
    for item in payload.get("items", []):
        qid = int(item.get("question_id"))
        status = str(item.get("status"))
        try:
            record = service.set_status(qid, status)
            results.append({"question_id": qid, "ok": True, "status": record["status"]})
        except Exception as exc:  # noqa: BLE001
            results.append({"question_id": qid, "ok": False, "error": str(exc)})
    return {"results": results}


@router.post("/{question_id}/deprecate")
def deprecate_question(question_id: int):
    """下架：active → deprecated."""
    try:
        return _service().set_status(question_id, "deprecated")
    except QuestionNotFoundError as exc:
        raise _error(exc, 404) from exc
    except ValidationError as exc:
        raise _error(exc, 422) from exc


# ── AI 出题 ───────────────────────────────────────────────────────────────


@router.post("/generate")
async def generate_questions(payload: dict[str, Any]):
    """出题：{knowledge_point|category_id, difficulty, question_type?, cognitive_level?, count}.

    覆盖度不足（empty/weak）→ 422 QUESTION_GENERATION_INSUFFICIENT_EVIDENCE。
    """
    try:
        generator = _generator()
        kc = _knowledge_core()
        try:
            result = await generator.generate(
                kc,
                category_id=payload.get("category_id"),
                knowledge_point=payload.get("knowledge_point"),
                question_type=payload.get("question_type"),
                difficulty=int(payload.get("difficulty", 3)),
                cognitive_level=payload.get("cognitive_level"),
                count=int(payload.get("count", 5)),
                created_by=payload.get("created_by", "llm"),
            )
        finally:
            await kc.aclose()
        return result
    except GenerationRejected as exc:
        raise HTTPException(status_code=422, detail={"code": exc.code, "message": str(exc)}) from exc
    except HTTPException:
        raise
    except ValidationError as exc:
        raise _error(exc, 422) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"出题失败: {exc}") from exc


# ── AI 审题（防线3 + 审核闭环） ────────────────────────────────────────────


@router.post("/{question_id}/ai-review")
async def ai_review(question_id: int, auto_apply: bool = True):
    """AI 审题：四项检查（证据支持/答案正确/无歧义/难度匹配）.

    - auto_apply=true：通过 → active；不通过（仅 proposed 态）→ rejected
    - 审题结论落库 metadata.ai_review（含 prompt_version / 时间 / 模型）
    """
    from datetime import datetime, timezone

    svc = _service()
    try:
        q = svc.get(question_id)
    except QuestionNotFoundError as exc:
        raise _error(exc, 404) from exc

    primary = next((p for p in q.get("knowledge_points", []) if p["role"] == "primary"), None)
    if primary is None:
        raise HTTPException(status_code=422, detail="题目未关联知识点（primary），无法审题")

    kc = _knowledge_core()
    try:
        context = await kc.get_context(category_id=primary["category_id"], purpose="review")
        # 证据快照合并：grounded 检查基于生成时证据（溯源不断），当前 context 检测知识变化
        snapshot = await kc.get_evidence(q.get("evidence_refs") or [])
    finally:
        await kc.aclose()

    context = QuestionReviewer.merge_snapshot_evidence(context, snapshot)
    verdict = await _reviewer().review(q, context)

    # 落库 metadata.ai_review
    meta = dict(q.get("metadata") or {})
    ai_review = {
        "verdict": verdict.model_dump(),
        "summary": verdict.summary(),
        "prompt_version": REVIEW_PROMPT_VERSION,
        "model": get_settings().llm_model,
        "reviewed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    meta["ai_review"] = ai_review
    try:
        svc.update(question_id, QuestionUpdate(metadata=meta))
        if auto_apply:
            if verdict.passed:
                svc.set_status(question_id, "active")
            elif q["status"] == "proposed":
                svc.set_status(question_id, "rejected")
    except (QuestionNotFoundError, ValidationError) as exc:
        raise _error(exc, 422) from exc

    return {
        "question_id": question_id,
        "verdict": verdict.model_dump(),
        "summary": verdict.summary(),
        "passed": verdict.passed,
        "status": svc.get(question_id)["status"],
    }


# ── 学习端：取题 / 作答（DESIGN v2 §10 / §20） ────────────────────────────


@practice_router.get("/questions")
async def practice_questions(
    user_id: str,
    category_id: int | None = None,
    count: int = 5,
    question_type: str | None = None,
    difficulty: int | None = None,
    exclude_recent_days: int = 7,
    frontier_first: bool = False,
):
    """取题（Question Selector）：只返回 id/type/stem/options/difficulty，
    绝不返回 answer/explanation/evidence。

    frontier_first=true（follow-up d）：先调 KnowledgeCore 学习前沿接口（T4.2）拿
    frontier_category_ids，命中这些知识点的新题优先排列；KC 不可达/未配置时静默
    降级为普通选题（不报错、不阻塞取题）。
    """
    frontier_category_ids: list[int] | None = None
    if frontier_first:
        frontier_category_ids = await _resolve_frontier_category_ids(user_id)

    try:
        result = QuestionSelector(_service()).select(
            user_id,
            category_id=category_id,
            count=count,
            question_type=question_type,
            difficulty=difficulty,
            exclude_recent_days=exclude_recent_days,
            frontier_first=frontier_first,
            frontier_category_ids=frontier_category_ids,
        )
    except ValueError as exc:
        raise _error(exc, 422) from exc
    return result


@practice_router.post("/submit")
async def practice_submit(payload: dict[str, Any]):
    """提交作答：{user_id, question_id, submitted_answer, judge_mode?, duration_ms?}.

    - 客观题：规则即时判分
    - 主观题：judge_mode=auto（默认）LLM+KC 判分；none 仅记录
    """
    settings = get_settings()
    store = QuestionStore(settings)
    service = _service()
    llm = LLMClient(settings)
    kc = KnowledgeCore.from_url(
        settings.knowledge_core_url,
        timeout=settings.knowledge_core_timeout,
        secret=settings.kc_internal_secret,
    ) if settings.knowledge_core_url else None
    attempt_service = AttemptService(store, service, llm, kc)
    try:
        result = await attempt_service.submit(
            str(payload.get("user_id", "")).strip(),
            int(payload.get("question_id")),
            payload.get("submitted_answer"),
            judge_mode=str(payload.get("judge_mode", "auto")),
            duration_ms=payload.get("duration_ms"),
        )
    except QuestionNotFoundError as exc:
        raise _error(exc, 404) from exc
    except QuestionNotActiveError as exc:
        raise _error(exc, 422) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"作答提交失败: {exc}") from exc
    finally:
        if kc is not None:
            await kc.aclose()
    return result


@practice_router.get("/mastery")
def practice_mastery(user_id: str):
    """用户各知识点掌握度快照（T4.1）：{category_id, mastery, evidence_count, mastered, updated_at}.

    mastery>=0.7 视为已掌握（mastered 字段），与 KnowledgeCore frontier 接口（T4.2）判定口径一致。
    """
    from questionbank.services.mastery import MasteryService

    store = QuestionStore(get_settings())
    items = MasteryService(store).get_states(user_id)
    return {"user_id": user_id, "items": items}


@practice_router.get("/attempts")
def practice_attempts(
    user_id: str,
    question_id: int | None = None,
    page: int = 0,
    size: int = 20,
):
    """作答历史（分页，可筛选单题）."""
    result = _service().store.list_attempts(user_id, question_id=question_id, page=page, size=size)
    for item in result["items"]:
        for col in ("submitted_answer", "judge_details"):
            value = item.get(col)
            if isinstance(value, (str, bytes, bytearray)):
                try:
                    item[col] = json.loads(value)
                except (json.JSONDecodeError, TypeError):
                    item[col] = None
    return result


@router.get("/{question_id}/stats")
def question_stats(question_id: int):
    """单题作答统计（次数/正确率/近 20 次正确率）."""
    try:
        _service().get(question_id)
    except QuestionNotFoundError as exc:
        raise _error(exc, 404) from exc
    return _service().store.question_stats(question_id)


# ── 知识变更重校验（阶段 8） ───────────────────────────────────────────────


@revalidation_router.post("/mark")
def revalidation_mark(payload: dict[str, Any]):
    """标记引用指定知识切片的题目 needs_revalidation=true：{chunk_ids, reason?}."""
    chunk_ids = [int(c) for c in payload.get("chunk_ids", [])]
    if not chunk_ids:
        raise _error(ValueError("chunk_ids 不能为空"), 422)
    return RevalidationService(QuestionStore(get_settings()), _service()).mark_by_chunk_ids(
        chunk_ids, reason=str(payload.get("reason", "knowledge_changed"))
    )


@revalidation_router.get("/queue")
def revalidation_queue(only_active: bool = True, page: int = 0, size: int = 50):
    """待重审队列."""
    return RevalidationService(QuestionStore(get_settings()), _service()).list_queue(
        only_active=only_active, page=page, size=size
    )


@revalidation_router.post("/{question_id}")
async def revalidate_question(question_id: int):
    """重审单题：Reviewer（快照+当前证据）→ 通过 active+清标记 / 不通过 deprecated."""
    from datetime import datetime, timezone

    settings = get_settings()
    store = QuestionStore(settings)
    service = _service()
    revalidation = RevalidationService(store, service)
    record = service.get(question_id)
    if record is None:
        raise _error(QuestionNotFoundError(f"题目不存在: {question_id}"), 404)
    primary = next((p for p in record.get("knowledge_points", []) if p["role"] == "primary"), None)
    if primary is None:
        raise HTTPException(status_code=422, detail="题目未关联知识点（primary），无法重审")

    kc = _knowledge_core()
    try:
        context = await kc.get_context(category_id=primary["category_id"], purpose="review")
        snapshot = await kc.get_evidence(record.get("evidence_refs") or [])
    finally:
        await kc.aclose()
    context = QuestionReviewer.merge_snapshot_evidence(context, snapshot)

    result = await revalidation.revalidate(question_id, _reviewer(), context)
    meta = service.get(question_id)["metadata"] or {}
    result["revalidation_meta"] = meta.get("needs_revalidation")
    result["reviewed_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return result
