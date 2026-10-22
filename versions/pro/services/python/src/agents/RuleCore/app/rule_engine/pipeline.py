"""Rule Pipeline 编排（§3.1 / §8：候选识别 → 抽取 → 校验 → 入库）.

独立流程：失败不影响 Knowledge Pipeline。
"""
from __future__ import annotations

import logging
from typing import Any

from app.rule_engine.chunk_reader import iter_chunks, list_documents, get_document
from app.rule_engine.repositories import rule_repository as repo
from app.rule_engine.rule_extractor import extract_rules
from app.rule_engine.rule_verifier import (
    determine_status,
    verify_rule,
)
from app.rule_engine.stable_code import stable_rule_code

logger = logging.getLogger("rulecore.pipeline")


async def extract_document_rules(document_id: int,
                                 max_chunks: int | None = None) -> dict:
    """对一个文档执行完整 Rule Pipeline.

    返回统计：{document_id, candidate_count, active_count, invalid_count, dedup, rules:[...]}
    """
    doc = get_document(document_id)
    if not doc:
        raise ValueError(f"文档不存在: {document_id}")

    # ① 读取 active 切片 + 去重 + 规则候选过滤
    chunks = iter_chunks(document_id, only_rule_candidates=True)
    dedup_stats = dict(getattr(iter_chunks, "stats", {}))
    if max_chunks:
        chunks = chunks[:max_chunks]
    if not chunks:
        return {
            "document_id": document_id,
            "candidate_count": 0,
            "active_count": 0,
            "invalid_count": 0,
            "dedup": dedup_stats,
            "rules": [],
            "note": "该文档没有含规则关键词的 active 切片",
        }

    stats = {"candidate": 0, "active": 0, "invalid": 0}
    rule_summaries: list[dict] = []

    # ② 逐切片：抽取 → 校验 → 入库（单切片失败不影响其他）
    for i, chunk in enumerate(chunks):
        doc_context = {
            "title": doc["title"],
            "source_name": doc.get("source_name", ""),
            "section_title": chunk["section_title"],
            "document_id": document_id,
            "chunk_id": chunk["chunk_id"],
            "raw_text": chunk["content"],
        }
        try:
            rules = await extract_rules(chunk["content"], doc_context)
        except Exception as e:  # noqa: BLE001
            logger.warning("抽取失败 doc=%s chunk=%s: %s", document_id, chunk["chunk_id"], e)
            continue

        for rule in rules:
            stats["candidate"] += 1
            # 分配正式 rule_code：内容决定的稳定编码（§：重跑同一文档 → 同一 code → upsert 去重，
            # 不再依赖切片下标，避免同批撞码覆盖 / 跨 run 漂移产生重复）
            rule.rule_code = stable_rule_code(f"R{document_id}", rule)
            # ③ 自动校验（LLM）+ Schema 程序校验
            try:
                verify = await verify_rule(rule, chunk["content"])
            except Exception as e:  # noqa: BLE001
                logger.warning("校验失败 doc=%s rule=%s: %s", document_id, rule.rule_code, e)
                verify = None

            if verify is None:
                status = "INVALID"
                reject = "校验器异常"
                confidence = 0.0
            else:
                status = determine_status(verify)
                reject = "; ".join(verify.issues[:5]) if verify.issues else None
                confidence = verify.confidence
                rule.confidence = verify.confidence

            try:
                rule_id = repo.upsert_rule(rule, status, reject)
            except Exception as e:  # noqa: BLE001
                logger.warning("入库失败 doc=%s rule=%s: %s", document_id, rule.rule_code, e)
                continue

            if status == "ACTIVE":
                stats["active"] += 1
            else:
                stats["invalid"] += 1
            rule_summaries.append({
                "rule_id": rule_id,
                "rule_code": rule.rule_code,
                "name": rule.name,
                "status": status,
                "confidence": round(confidence, 4),
                "reject_reason": reject,
                "chunk_id": chunk["chunk_id"],
                "section": chunk["section_title"],
                "conditions": len(rule.conditions),
                "conclusions": [c.type for c in rule.conclusions],
            })

    return {
        "document_id": document_id,
        "candidate_count": stats["candidate"],
        "active_count": stats["active"],
        "invalid_count": stats["invalid"],
        "dedup": dedup_stats,
        "rules": rule_summaries,
    }


async def extract_all_rules(document_ids: list[int],
                            max_chunks_per_doc: int | None = None) -> dict:
    """对多个文档批量抽取."""
    results: list[dict] = []
    for doc_id in document_ids:
        try:
            results.append(await extract_document_rules(doc_id, max_chunks_per_doc))
        except Exception as e:  # noqa: BLE001
            results.append({"document_id": doc_id, "error": str(e)})
    return {
        "documents": len(document_ids),
        "candidate_count": sum(r.get("candidate_count", 0) for r in results),
        "active_count": sum(r.get("active_count", 0) for r in results),
        "invalid_count": sum(r.get("invalid_count", 0) for r in results),
        "details": results,
    }
