"""切片-知识点分类审计与纠错服务.

对应 solutions.md 8.7 残余缺口 2（精确层错挂无法自愈）：
  - list_audit：按置信度升序列出低置信度分类记录（人工抽查入口，最可疑的排最前）
  - correct：人工纠错（删除 / 改挂其他知识点 / 调整置信度），写回 source='manual'
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

AUDIT_SQL = """
SELECT kcc.id AS classification_id, kcc.chunk_id, kcc.category_id,
       kcc.relation_type, kcc.confidence, kcc.source,
       c.name AS category_name, c.node_code, c.level, c.node_type, c.full_path,
       COALESCE(kc.chunk_code, '') AS chunk_code,
       COALESCE(kc.section_title, '') AS section_title,
       COALESCE(kc.title_path, '') AS title_path,
       COALESCE(SUBSTR(kc.content, 1, 300), '') AS content_preview
FROM knowledge_chunk_category kcc
JOIN knowledge_category c ON c.id = kcc.category_id
LEFT JOIN knowledge_chunk kc ON kc.id = kcc.chunk_id
WHERE c.domain_id = :did AND kcc.confidence <= :max_confidence
"""


class ClassificationService:
    """分类记录审计与纠错."""

    def __init__(self, db: AsyncSession):
        self.db = db

    # ── 审计 ───────────────────────────────────────────────────────────

    async def list_audit(
        self,
        domain_id: int,
        max_confidence: float = 0.7,
        source: str | None = None,
        relation_type: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, Any]:
        """低置信度分类抽查列表（按置信度升序，最可疑排最前）."""
        sql = AUDIT_SQL
        params: dict[str, Any] = {"did": domain_id, "max_confidence": max_confidence}
        if source:
            sql += " AND kcc.source = :source"
            params["source"] = source
        if relation_type:
            sql += " AND kcc.relation_type = :relation_type"
            params["relation_type"] = relation_type

        # 总数（同条件不带分页）
        count_row = (
            await self.db.execute(
                text("SELECT COUNT(*) AS cnt FROM (" + sql + ") t"),
                params,
            )
        ).mappings().first()

        rows = (
            await self.db.execute(
                text(sql + " ORDER BY kcc.confidence ASC, kcc.id LIMIT :lim OFFSET :off"),
                {**params, "lim": limit, "off": offset},
            )
        ).mappings().all()
        return {
            "total": int(count_row["cnt"]) if count_row else 0,
            "items": [dict(r) for r in rows],
        }

    # ── 纠错 ───────────────────────────────────────────────────────────

    async def correct(
        self,
        action: str,
        classification_id: int | None = None,
        chunk_id: int | None = None,
        old_category_id: int | None = None,
        new_category_id: int | None = None,
        confidence: float | None = None,
    ) -> dict[str, Any]:
        """人工纠错，四种动作：

        - assign:           新增归属（无归属切片 → 指定知识点），单归属约束：先清旧再写入
        - delete:           删除分类记录（错挂移除）
        - move:             改挂到 new_category_id（删旧 + 写新，source='manual'）
        - set_confidence:   仅调整置信度
        """
        if action == "assign":
            if chunk_id is None or new_category_id is None:
                return {"ok": False, "error": "assign 需要 chunk_id 和 new_category_id 参数"}
            cat = (
                await self.db.execute(
                    text("SELECT id, name FROM knowledge_category WHERE id = :cid AND status = 1"),
                    {"cid": new_category_id},
                )
            ).mappings().first()
            if not cat:
                return {"ok": False, "error": f"目标知识点不存在: {new_category_id}"}
            # 单归属：先清掉该切片已有分类，再写入
            await self.db.execute(
                text("DELETE FROM knowledge_chunk_category WHERE chunk_id = :chunk"),
                {"chunk": chunk_id},
            )
            await self.db.execute(
                text(
                    "INSERT INTO knowledge_chunk_category "
                    "(chunk_id, category_id, relation_type, confidence, source) "
                    "VALUES (:chunk, :cat, 'manual', :conf, 'manual')"
                ),
                {
                    "chunk": chunk_id,
                    "cat": new_category_id,
                    "conf": confidence if confidence is not None else 0.8,
                },
            )
            await self.db.commit()
            logger.info("classification assigned chunk=%s → category=%s", chunk_id, new_category_id)
            return {"ok": True, "action": "assign", "classification_id": None,
                    "detail": f"已归属: chunk#{chunk_id} → {cat['name']} (id={new_category_id})"}

        target = await self._resolve_target(classification_id, chunk_id, old_category_id)
        if not target:
            return {"ok": False, "error": "分类记录不存在（请提供 classification_id 或 chunk_id+old_category_id）"}

        if action == "delete":
            await self.db.execute(
                text("DELETE FROM knowledge_chunk_category WHERE id = :cid"),
                {"cid": target["id"]},
            )
            await self.db.commit()
            logger.info("classification deleted id=%s", target["id"])
            return {"ok": True, "action": "delete", "classification_id": target["id"],
                    "detail": f"已删除 {target['chunk_code'] or 'chunk'} → {target['category_name']}"}

        if action == "set_confidence":
            if confidence is None:
                return {"ok": False, "error": "set_confidence 需要 confidence 参数"}
            await self.db.execute(
                text("UPDATE knowledge_chunk_category SET confidence = :conf WHERE id = :cid"),
                {"conf": confidence, "cid": target["id"]},
            )
            await self.db.commit()
            logger.info("classification confidence updated id=%s conf=%s", target["id"], confidence)
            return {"ok": True, "action": "set_confidence", "classification_id": target["id"],
                    "detail": f"置信度调整为 {confidence}"}

        if action == "move":
            if new_category_id is None:
                return {"ok": False, "error": "move 需要 new_category_id 参数"}
            if new_category_id == target["category_id"]:
                return {"ok": True, "action": "move", "classification_id": target["id"],
                        "detail": "目标知识点与当前一致，未改动"}
            # 校验目标节点存在
            cat = (
                await self.db.execute(
                    text("SELECT id, name FROM knowledge_category WHERE id = :cid AND status = 1"),
                    {"cid": new_category_id},
                )
            ).mappings().first()
            if not cat:
                return {"ok": False, "error": f"目标知识点不存在: {new_category_id}"}
            # 删旧
            await self.db.execute(
                text("DELETE FROM knowledge_chunk_category WHERE id = :cid"),
                {"cid": target["id"]},
            )
            # 写新（若 chunk_id+new_category_id 已存在则跳过，避免唯一键冲突）
            dup = (
                await self.db.execute(
                    text(
                        "SELECT 1 FROM knowledge_chunk_category "
                        "WHERE chunk_id = :chunk AND category_id = :cat LIMIT 1"
                    ),
                    {"chunk": target["chunk_id"], "cat": new_category_id},
                )
            ).first()
            if not dup:
                await self.db.execute(
                    text(
                        "INSERT INTO knowledge_chunk_category "
                        "(chunk_id, category_id, relation_type, confidence, source) "
                        "VALUES (:chunk, :cat, 'manual', :conf, 'manual')"
                    ),
                    {
                        "chunk": target["chunk_id"],
                        "cat": new_category_id,
                        "conf": confidence if confidence is not None else 0.9,
                    },
                )
            await self.db.commit()
            logger.info("classification moved id=%s → category=%s", target["id"], new_category_id)
            return {"ok": True, "action": "move", "classification_id": target["id"],
                    "detail": f"已改挂: {target['chunk_code'] or 'chunk'} → {cat['name']} (id={new_category_id})"}

        return {"ok": False, "error": f"未知动作: {action}"}

    # ── 内部 ───────────────────────────────────────────────────────────

    async def _resolve_target(
        self,
        classification_id: int | None,
        chunk_id: int | None,
        old_category_id: int | None,
    ) -> dict[str, Any] | None:
        """定位分类记录（classification_id 优先，其次 chunk_id+old_category_id）."""
        if classification_id is not None:
            row = (
                await self.db.execute(
                    text(
                        "SELECT kcc.id, kcc.chunk_id, kcc.category_id, "
                        "       c.name AS category_name, kc.chunk_code "
                        "FROM knowledge_chunk_category kcc "
                        "JOIN knowledge_category c ON c.id = kcc.category_id "
                        "LEFT JOIN knowledge_chunk kc ON kc.id = kcc.chunk_id "
                        "WHERE kcc.id = :cid"
                    ),
                    {"cid": classification_id},
                )
            ).mappings().first()
            return dict(row) if row else None
        if chunk_id is not None and old_category_id is not None:
            row = (
                await self.db.execute(
                    text(
                        "SELECT kcc.id, kcc.chunk_id, kcc.category_id, "
                        "       c.name AS category_name, kc.chunk_code "
                        "FROM knowledge_chunk_category kcc "
                        "JOIN knowledge_category c ON c.id = kcc.category_id "
                        "LEFT JOIN knowledge_chunk kc ON kc.id = kcc.chunk_id "
                        "WHERE kcc.chunk_id = :chunk AND kcc.category_id = :cat"
                    ),
                    {"chunk": chunk_id, "cat": old_category_id},
                )
            ).mappings().first()
            return dict(row) if row else None
        return None
