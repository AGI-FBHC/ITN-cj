"""T4.6：图谱增量重审 —— 消费 predeal 写入的 graph_review_pending 表.

predeal 侧 `chunk_repository.py`（并行代理负责，不在本任务范围）在
`sync_chunks` 产出 superseded/updated 的 chunk_id 后写入
`graph_review_pending(chunk_id BIGINT, created_at DATETIME)`（该表由 predeal
自己的迁移建表；本模块只读+清理消费，表不存在时优雅降级，不假设迁移顺序）。

编排：
    graph_review_pending 取一批 chunk_id
      → 按 knowledge_chunk_category 反查这些 chunk 归属的知识点(category_id)
      → 这些知识点上 source='llm' 生成、且当前 active/proposed 的先修边
        置为 needs_review（底层证据切片已变化，之前的判定不再可信，需要人工
        复核；`prerequisite_service.STATUSES` 已含 needs_review——见交接遗留
        项 a——GET edges?status=needs_review / review-queue 均可查看）
      → 处理完的 pending 行删除（避免重复处理，保持表小体量）

可被两种方式驱动：① 管理端点 `POST /knowledge/graph/review-pending/process`
（受 KNOWLEDGE_ALLOW_WRITE 守门）；② 直接实例化本类在 cron/离线脚本里调用
`process_pending()`（不经过 HTTP，供定期任务复用）。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

DEFAULT_BATCH_SIZE = 500


@dataclass
class GraphReviewReport:
    """一次图谱增量重审的报告（可观测）."""

    pending_chunks: int = 0
    affected_categories: int = 0
    edges_marked: int = 0
    warnings: list[str] = field(default_factory=list)


class GraphReviewPendingService:
    """消费 graph_review_pending，联动先修边 needs_review 状态."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def process_pending(self, batch_size: int = DEFAULT_BATCH_SIZE) -> GraphReviewReport:
        """处理一批待重审 chunk：反查知识点 → 标记该知识点 llm 生成的边 needs_review

        → 删除已处理的 pending 行。任一阶段表未迁移/查询失败 → 优雅降级，返回
        （目前为止已完成部分的）报告，不抛异常、不中断调用方。
        """
        report = GraphReviewReport()

        try:
            rows = (
                await self.db.execute(
                    text(
                        "SELECT chunk_id FROM graph_review_pending "
                        "ORDER BY created_at LIMIT :n"
                    ),
                    {"n": batch_size},
                )
            ).mappings().all()
        except Exception as e:  # noqa: BLE001 — 表未迁移（predeal 侧迁移未跑）：优雅降级
            report.warnings.append(f"graph_review_pending 读取失败（可能未迁移）: {e}")
            return report

        chunk_ids = sorted({int(r["chunk_id"]) for r in rows})
        report.pending_chunks = len(chunk_ids)
        if not chunk_ids:
            return report

        try:
            cat_rows = (
                await self.db.execute(
                    text(
                        "SELECT DISTINCT category_id FROM knowledge_chunk_category "
                        "WHERE chunk_id IN :ids"
                    ).bindparams(bindparam("ids", expanding=True)),
                    {"ids": tuple(chunk_ids)},
                )
            ).mappings().all()
        except Exception as e:  # noqa: BLE001
            report.warnings.append(f"knowledge_chunk_category 反查失败: {e}")
            return report

        category_ids = sorted({int(r["category_id"]) for r in cat_rows})
        report.affected_categories = len(category_ids)

        if category_ids:
            try:
                result = await self.db.execute(
                    text(
                        "UPDATE knowledge_category_prerequisite SET status = 'needs_review', "
                        "updated_at = CURRENT_TIMESTAMP "
                        "WHERE source = 'llm' AND status IN ('active', 'proposed') "
                        "AND (category_id IN :ids OR prereq_category_id IN :ids)"
                    ).bindparams(bindparam("ids", expanding=True)),
                    {"ids": tuple(category_ids)},
                )
                report.edges_marked = result.rowcount or 0
                await self.db.commit()
            except Exception as e:  # noqa: BLE001
                report.warnings.append(f"标记 needs_review 失败: {e}")
                try:
                    await self.db.rollback()
                except Exception:  # noqa: BLE001
                    pass
                return report

        # 处理完删除 pending 行（幂等：即使 edges_marked=0——比如知识点当时没有
        # llm 生成的边——也算处理过，避免同一批 chunk 被反复扫描）。
        try:
            await self.db.execute(
                text("DELETE FROM graph_review_pending WHERE chunk_id IN :ids").bindparams(
                    bindparam("ids", expanding=True)
                ),
                {"ids": tuple(chunk_ids)},
            )
            await self.db.commit()
        except Exception as e:  # noqa: BLE001
            report.warnings.append(f"清理 graph_review_pending 失败: {e}")
            try:
                await self.db.rollback()
            except Exception:  # noqa: BLE001
                pass

        return report
