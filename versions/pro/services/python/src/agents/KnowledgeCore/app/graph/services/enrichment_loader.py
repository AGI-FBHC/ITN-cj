"""共享的 knowledge_chunk_enrichment 装配（defines/uses → ChunkConceptRow）.

供 `graph_sync.GraphSyncService`（T3.2 证据通道/括注别名抽取）与
`contrast_service.ContrastSyncService`（T4.4 易混淆边候选 + 本次管理端点按
domain_id 装配，见 817 待办清单第 7 项）共用，避免同一段 JOIN + JSON 解析
逻辑重复维护两份。
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.services.candidate_generator import ChunkConceptRow


async def load_concept_rows(db: AsyncSession, domain_id: int) -> list[ChunkConceptRow]:
    """按领域读取 knowledge_chunk_enrichment 的 defines/uses，展开为 ChunkConceptRow.

    JOIN knowledge_chunk_category 限定该领域涉及的 chunk（enrichment 表本身不带
    domain_id）；enrichment 表不存在/查询失败 → 静默跳过返回空列表（与手册"enrichment
    表不存在/为空时静默跳过"约定一致，调用方据此优雅返回空报告，不 500）。
    """
    try:
        rows = (
            await db.execute(
                text(
                    "SELECT kcc.chunk_id AS chunk_id, kcc.category_id AS category_id, "
                    "       kce.defines_json AS defines_json, kce.uses_json AS uses_json "
                    "FROM knowledge_chunk_enrichment kce "
                    "JOIN knowledge_chunk_category kcc ON kcc.chunk_id = kce.chunk_id "
                    "JOIN knowledge_category c ON c.id = kcc.category_id "
                    "WHERE c.domain_id = :did"
                ),
                {"did": domain_id},
            )
        ).mappings().all()
    except Exception:  # noqa: BLE001 — enrichment 表未迁移/查询失败：静默跳过
        return []

    out: list[ChunkConceptRow] = []
    for r in rows:
        defines = parse_json_list(r.get("defines_json"))
        uses = parse_json_list(r.get("uses_json"))
        if not defines and not uses:
            continue
        out.append(
            ChunkConceptRow(
                chunk_id=int(r["chunk_id"]),
                category_id=int(r["category_id"]),
                defines=defines,
                uses=uses,
            )
        )
    return out


def parse_json_list(value: Any) -> list[str]:
    """defines_json/uses_json 宽容解析：MySQL JSON 列经 text() 原样查询可能回落为

    字符串（未走 ORM 类型转换），也可能已是 list（部分驱动/SQLite JSON1 场景）。
    解析失败/非列表 → 空列表（宁缺毋滥，不阻断整批处理）。
    """
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        if isinstance(parsed, list):
            return [str(v) for v in parsed]
    return []
