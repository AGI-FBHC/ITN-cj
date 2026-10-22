"""Knowledge Change Revalidation —— 知识更新后题目重审（DESIGN v2 §33 / §8 阶段 8）.

机制：
1. Knowledge Core 内容更新后，调用方告知变更的 chunk_ids
2. 反查引用这些切片的题目（evidence_refs），标记 metadata.needs_revalidation=true
3. 重审队列列出待审题目（优先 active 的）
4. 重审（Reviewer，快照+当前证据）：
   - 通过 → 保持 active，清除 needs_revalidation
   - 不通过 → deprecated（题目随知识库演化）
"""
from __future__ import annotations

import json
from typing import Any

import pymysql

from questionbank.services.question.question_service import (
    QuestionNotFoundError,
    QuestionService,
    QuestionUpdate,
)
from questionbank.services.question.reviewer import QuestionReviewer, ReviewVerdict
from questionbank.store import QuestionStore

REVALIDATION_KEY = "needs_revalidation"


class RevalidationService:
    def __init__(self, store: QuestionStore, service: QuestionService):
        self.store = store
        self.service = service

    def mark_by_chunk_ids(
        self,
        chunk_ids: list[int],
        reason: str = "knowledge_changed",
        conn: pymysql.Connection | None = None,
    ) -> dict[str, Any]:
        """标记引用指定切片的题目 needs_revalidation=true，返回 {question_ids, count}."""
        ids = self.store.question_ids_by_evidence_chunks(chunk_ids, conn=conn)
        marked: list[int] = []
        for qid in ids:
            record = self.service.get(qid, conn=conn)
            meta = dict(record.get("metadata") or {})
            meta[REVALIDATION_KEY] = {"reason": reason, "chunk_ids": [int(c) for c in chunk_ids]}
            self.service.update(qid, QuestionUpdate(metadata=meta), conn=conn)
            marked.append(qid)
        return {"question_ids": marked, "count": len(marked)}

    def list_queue(
        self,
        only_active: bool = True,
        page: int = 0,
        size: int = 50,
        conn: pymysql.Connection | None = None,
    ) -> dict[str, Any]:
        """待重审队列：metadata.needs_revalidation 存在的题目."""
        result = self.service.search(status="active" if only_active else None, size=200, conn=conn)
        items = []
        for q in result["items"]:
            meta = q.get("metadata") or {}
            if REVALIDATION_KEY in meta:
                items.append(q)
        total = len(items)
        offset = max(0, page) * max(1, min(size, 100))
        return {"total": total, "items": items[offset : offset + size], "page": page, "size": size}

    async def revalidate(
        self,
        question_id: int,
        reviewer: QuestionReviewer,
        context: Any,
        conn: pymysql.Connection | None = None,
    ) -> dict[str, Any]:
        """重审单题：通过 → active + 清标记；不通过 → deprecated.

        context 由调用方组装（当前 KC context + 证据快照），保持与 ai-review 一致。
        """
        record = self.service.get(question_id, conn=conn)
        if record is None:
            raise QuestionNotFoundError(f"题目不存在: {question_id}")
        verdict: ReviewVerdict = await reviewer.review(record, context)

        meta = dict(record.get("metadata") or {})
        if verdict.passed:
            meta.pop(REVALIDATION_KEY, None)
            if record["status"] != "active":
                self.service.set_status(question_id, "active", conn=conn)
            self.service.update(question_id, QuestionUpdate(metadata=meta), conn=conn)
            new_status = "active"
        else:
            if record["status"] == "active":
                self.service.set_status(question_id, "deprecated", conn=conn)
            meta[REVALIDATION_KEY] = {
                **meta.get(REVALIDATION_KEY, {}),
                "last_failed": verdict.model_dump(),
            }
            self.service.update(question_id, QuestionUpdate(metadata=meta), conn=conn)
            new_status = record["status"] if record["status"] != "active" else "deprecated"

        return {
            "question_id": question_id,
            "passed": verdict.passed,
            "summary": verdict.summary(),
            "status": new_status,
        }
