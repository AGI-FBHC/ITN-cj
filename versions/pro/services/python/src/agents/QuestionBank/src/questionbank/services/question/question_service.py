"""QuestionService —— 题目查询 / 状态 / 保存的统一出口（DESIGN v2 §11）.

业务侧禁止直接拼 SQL；所有题目操作走本服务。覆盖：
- 创建（含 content_hash 去重、知识点关联、证据快照落库）
- 更新 / 软删除 / 状态流转
- 统一查询 search_questions()
- 批量导入（幂等）
"""
from __future__ import annotations

import json
from typing import Any

import pymysql

from questionbank.store import QuestionStore

from .duplicate_detector import content_hash
from .models import QuestionCreate, QuestionUpdate
from .validators import (
    SOURCE_TYPES,
    STATUSES,
    ValidationError,
    validate_question,
    validate_question_type,
)

_JSON_COLUMNS = (
    "options", "reference_answer", "evidence_refs", "generation_metadata", "metadata",
)


class QuestionNotFoundError(Exception):
    pass


class DuplicateQuestionError(Exception):
    """content_hash 与现有题目冲突（幂等导入时由调用方处理）."""


def _json_loads(value: Any) -> Any:
    if value is None or isinstance(value, (dict, list, bool, int, float)):
        return value
    if isinstance(value, (str, bytes, bytearray)):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return None
    return value


def row_to_record(row: dict[str, Any]) -> dict[str, Any]:
    """数据库行 → API 记录（JSON 列反序列化）."""
    record = dict(row)
    for col in _JSON_COLUMNS:
        record[col] = _json_loads(record.get(col))
    return record


class QuestionService:
    def __init__(self, store: QuestionStore):
        self.store = store

    # ── 创建 ──────────────────────────────────────────────────────────────

    def create(
        self,
        data: QuestionCreate,
        conn: pymysql.Connection | None = None,
    ) -> dict[str, Any]:
        """创建题目：防线1 校验 → 去重 → 入库（题目 + 知识点关联）.

        - 已存在相同 content_hash 的题目 → 抛 DuplicateQuestionError（幂等场景调用方捕获）
        - LLM 来源禁止直接 active（生产建议一律走审核）
        """
        qtype, diff, level, opts, answer = validate_question(
            question_type=data.question_type,
            difficulty=data.difficulty,
            cognitive_level=data.cognitive_level,
            stem=data.stem,
            options=[o.model_dump() for o in data.options] if data.options else None,
            reference_answer=data.reference_answer,
        )
        if data.source_type == "llm" and data.status == "active":
            raise ValidationError("LLM 出题必须为 proposed，审核通过后才能 active")

        digest = content_hash(
            question_type=qtype, stem=data.stem, options=opts, reference_answer=answer
        )
        own_conn = conn is None
        c = self.store.connect() if own_conn else conn
        try:
            existing = self.store.get_question_by_hash(digest, conn=c)
            if existing is not None:
                raise DuplicateQuestionError(
                    f"重复题目: content_hash={digest} 已存在 (id={existing['id']})"
                )

            question_id = self.store.insert_question(
                {
                    "question_type": qtype,
                    "difficulty": diff,
                    "cognitive_level": level,
                    "stem": data.stem.strip(),
                    "options": json.dumps(opts, ensure_ascii=False) if opts is not None else None,
                    "reference_answer": json.dumps(answer, ensure_ascii=False),
                    "explanation": data.explanation.strip() if data.explanation else None,
                    "status": data.status,
                    "source_type": data.source_type,
                    "evidence_refs": json.dumps(
                        [r.model_dump() for r in data.evidence_refs], ensure_ascii=False
                    ) if data.evidence_refs else None,
                    "generation_metadata": json.dumps(
                        data.generation_metadata, ensure_ascii=False
                    ) if data.generation_metadata else None,
                    "content_hash": digest,
                    "metadata": json.dumps(data.metadata, ensure_ascii=False) if data.metadata else None,
                    "created_by": data.created_by,
                },
                conn=c,
            )
            if data.knowledge_points:
                self.store.replace_knowledge_points(
                    question_id,
                    [p.model_dump() for p in data.knowledge_points],
                    conn=c,
                )
            if own_conn:
                c.commit()
            return self.get(question_id, conn=c)  # type: ignore[arg-type]
        finally:
            if own_conn:
                c.close()

    # ── 查询 ──────────────────────────────────────────────────────────────

    def get(self, question_id: int, conn: pymysql.Connection | None = None) -> dict[str, Any]:
        row = self.store.get_question(question_id, conn=conn)
        if row is None:
            raise QuestionNotFoundError(f"题目不存在: {question_id}")
        record = row_to_record(row)
        record["knowledge_points"] = self.store.list_knowledge_points(question_id, conn=conn)
        return record

    def search(
        self,
        *,
        category_id: int | None = None,
        difficulty: int | None = None,
        question_type: str | None = None,
        cognitive_level: str | None = None,
        status: str | None = None,
        keyword: str | None = None,
        page: int = 0,
        size: int = 20,
        conn: pymysql.Connection | None = None,
    ) -> dict[str, Any]:
        """统一查询出口（DESIGN v2 §18）."""
        result = self.store.search_questions(
            category_id=category_id,
            difficulty=difficulty,
            question_type=question_type,
            cognitive_level=cognitive_level,
            status=status,
            keyword=keyword,
            page=page,
            size=size,
            conn=conn,
        )
        result["items"] = [row_to_record(r) for r in result["items"]]
        return result

    # ── 更新 / 删除 / 状态 ────────────────────────────────────────────────

    def update(
        self,
        question_id: int,
        data: QuestionUpdate,
        conn: pymysql.Connection | None = None,
    ) -> dict[str, Any]:
        """部分更新；content_hash 随内容自动重算（并查重）."""
        own_conn = conn is None
        c = self.store.connect() if own_conn else conn
        try:
            row = self.store.get_question(question_id, conn=c)
            if row is None:
                raise QuestionNotFoundError(f"题目不存在: {question_id}")
            current_row = row_to_record(row)

            updates: dict[str, Any] = {}
            qtype = current_row["question_type"]
            diff = current_row["difficulty"]
            level = current_row["cognitive_level"]
            stem = current_row["stem"]
            opts = current_row["options"]
            answer = current_row["reference_answer"]

            if data.question_type is not None:
                qtype = validate_question_type(data.question_type)
            if data.difficulty is not None:
                diff = data.difficulty
            if data.cognitive_level is not None:
                level = data.cognitive_level
            if data.stem is not None:
                stem = data.stem
            if data.options is not None:
                opts = [o.model_dump() for o in data.options]
            if data.reference_answer is not None:
                answer = data.reference_answer

            qtype, diff, level, opts, answer = validate_question(
                question_type=qtype,
                difficulty=diff,
                cognitive_level=level,
                stem=stem,
                options=opts,
                reference_answer=answer,
            )
            updates.update(
                question_type=qtype,
                difficulty=diff,
                cognitive_level=level,
                stem=stem.strip(),
                options=json.dumps(opts, ensure_ascii=False) if opts is not None else None,
                reference_answer=json.dumps(answer, ensure_ascii=False),
            )
            if data.explanation is not None:
                updates["explanation"] = data.explanation.strip() or None
            if data.source_type is not None:
                if data.source_type not in SOURCE_TYPES:
                    raise ValidationError(f"非法来源: {data.source_type}")
                updates["source_type"] = data.source_type
            if data.evidence_refs is not None:
                updates["evidence_refs"] = json.dumps(
                    [r.model_dump() for r in data.evidence_refs], ensure_ascii=False
                )
            if data.generation_metadata is not None:
                updates["generation_metadata"] = json.dumps(data.generation_metadata, ensure_ascii=False)
            if data.metadata is not None:
                updates["metadata"] = json.dumps(data.metadata, ensure_ascii=False)

            # content_hash 重算 + 查重（排除自身）
            digest = content_hash(question_type=qtype, stem=stem, options=opts, reference_answer=answer)
            dup = self.store.get_question_by_hash(digest, conn=c)
            if dup is not None and int(dup["id"]) != question_id:
                raise DuplicateQuestionError(
                    f"更新后与现有题目重复 (id={dup['id']}, hash={digest})"
                )
            updates["content_hash"] = digest

            self.store.update_question(question_id, updates, conn=c)
            if data.knowledge_points is not None:
                self.store.replace_knowledge_points(
                    question_id, [p.model_dump() for p in data.knowledge_points], conn=c
                )
            if own_conn:
                c.commit()
            return self.get(question_id, conn=c)  # type: ignore[arg-type]
        finally:
            if own_conn:
                c.close()

    def delete(self, question_id: int, conn: pymysql.Connection | None = None) -> None:
        """软删除：status → deprecated（保留 attempt 历史与溯源）."""
        self.set_status(question_id, "deprecated", conn=conn)

    def set_status(
        self,
        question_id: int,
        status: str,
        conn: pymysql.Connection | None = None,
    ) -> dict[str, Any]:
        """状态流转（DESIGN v2 §7）：

        proposed → active / rejected
        active   → deprecated
        rejected → proposed（修订后重新审核）
        deprecated 终态（不反向）
        """
        if status not in STATUSES:
            raise ValidationError(f"非法状态: {status}，允许 {STATUSES}")
        own_conn = conn is None
        c = self.store.connect() if own_conn else conn
        try:
            row = self.store.get_question(question_id, conn=c)
            if row is None:
                raise QuestionNotFoundError(f"题目不存在: {question_id}")
            current = row["status"]
            allowed: dict[str, set[str]] = {
                "proposed": {"active", "rejected"},
                "active": {"deprecated"},
                "rejected": {"proposed"},
                "deprecated": set(),
            }
            if status not in allowed.get(current, set()):
                raise ValidationError(f"非法状态流转: {current} → {status}")
            self.store.update_question(question_id, {"status": status}, conn=c)
            if own_conn:
                c.commit()
            return self.get(question_id, conn=c)  # type: ignore[arg-type]
        finally:
            if own_conn:
                c.close()

    # ── 批量导入（幂等） ──────────────────────────────────────────────────

    def import_batch(
        self,
        items: list[QuestionCreate],
        conn: pymysql.Connection | None = None,
    ) -> dict[str, Any]:
        """批量导入：逐条走 create，content_hash 命中视为 skipped（幂等）.

        返回 {created: [...], skipped: [...], failed: [{index, error}]}。
        同一批次内重复内容：第一条 created，后续 skipped。
        """
        created: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        failed: list[dict[str, Any]] = []
        own_conn = conn is None
        c = self.store.connect() if own_conn else conn
        try:
            for idx, item in enumerate(items):
                try:
                    rec = self.create(item, conn=c)
                    created.append({"index": idx, "question_id": rec["id"]})
                except DuplicateQuestionError as exc:
                    digest = content_hash(
                        question_type=item.question_type,
                        stem=item.stem,
                        options=[o.model_dump() for o in item.options] if item.options else None,
                        reference_answer=item.reference_answer,
                    )
                    existing = self.store.get_question_by_hash(digest, conn=c)
                    skipped.append(
                        {"index": idx, "question_id": existing["id"] if existing else None, "reason": str(exc)}
                    )
                except ValidationError as exc:
                    failed.append({"index": idx, "error": str(exc)})
                except Exception as exc:  # noqa: BLE001 — 单条失败不影响批次
                    failed.append({"index": idx, "error": f"{type(exc).__name__}: {exc}"})
            if own_conn:
                c.commit()
        finally:
            if own_conn:
                c.close()
        return {"created": created, "skipped": skipped, "failed": failed}
