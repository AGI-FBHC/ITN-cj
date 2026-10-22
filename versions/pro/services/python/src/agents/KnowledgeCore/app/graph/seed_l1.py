"""L1 章节先修边种子（dag-design.md §8 管道② 人工维护，G5）.

用法：python -m app.graph.seed_l1 --domain 1
20 条章节边（2026-08 人工定义，基于课程内容语义）：

同父（sort_order 递增，防线 1 校验通过）：
  concepts     ch1→ch2, ch1→ch3, ch2→ch3
  construction ch4→ch5, ch4→ch6, ch4→ch7, ch6→ch7
  capabilities ch8→ch9, ch8→ch10, ch9→ch10
  advanced     ch11→ch12
  practice     ch13→ch16, ch14→ch16, ch15→ch16
跨父（source=human 放行，防线 2 祖先检查兜底）：
  ch3→ch4    LLM 基础 → 范式构建（核心）
  ch4→ch8    范式 → 记忆检索（核心）
  ch9→ch11   上下文 → Agentic RL
  ch7→ch13/14/15  自建框架 → 三个实践章节

全部 direct_active（人工边直接生效），source=human，created_by=seed-l1。
"""

from __future__ import annotations

import argparse
import asyncio

from app.core.database import get_session_factory
from app.graph.services.prerequisite_service import PrerequisiteService

# (prereq_category_id, category_id) —— 先修 → 后修
L1_EDGES: list[tuple[int, int]] = [
    # concepts（父 1）
    (6, 7),    # ch1 → ch2
    (6, 8),    # ch1 → ch3
    (7, 8),    # ch2 → ch3
    # construction（父 2）
    (28, 29),  # ch4 → ch5
    (28, 30),  # ch4 → ch6
    (28, 31),  # ch4 → ch7
    (30, 31),  # ch6 → ch7
    # capabilities（父 3）
    (54, 55),  # ch8 → ch9
    (54, 56),  # ch8 → ch10
    (55, 56),  # ch9 → ch10
    # advanced（父 4）
    (77, 78),  # ch11 → ch12
    # practice（父 5）
    (96, 99),  # ch13 → ch16
    (97, 99),  # ch14 → ch16
    (98, 99),  # ch15 → ch16
    # 跨父（核心依赖）
    (8, 28),   # ch3 LLM 基础 → ch4 范式
    (28, 54),  # ch4 范式 → ch8 记忆检索
    (55, 77),  # ch9 上下文 → ch11 Agentic RL
    (31, 96),  # ch7 → ch13 实践
    (31, 97),  # ch7 → ch14 实践
    (31, 98),  # ch7 → ch15 实践
]

RATIONALE = "L1 章节先修边（人工维护，2026-08 G5 种子）"


async def seed(domain_id: int) -> None:
    factory = get_session_factory()
    async with factory() as db:
        svc = PrerequisiteService(db)
        ok = skipped = 0
        for prereq, target in L1_EDGES:
            try:
                edge, warnings = await svc.add_prerequisite(
                    category_id=target,
                    prereq_category_id=prereq,
                    domain_id=domain_id,
                    source="human",
                    created_by="seed-l1",
                    rationale=RATIONALE,
                    direct_active=True,
                )
                print(f"OK   {prereq}→{target} status={edge.status}{(' ' + str(warnings)) if warnings else ''}")
                ok += 1
            except Exception as e:  # noqa: BLE001 — 逐条报告，不中断
                print(f"SKIP {prereq}→{target}: {e}")
                skipped += 1
        print(f"\n完成：{ok} 条生效，{skipped} 条跳过")
    from app.core.database import get_engine

    await get_engine().dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description="写入 L1 章节先修边（人工种子）")
    parser.add_argument("--domain", type=int, default=1, help="领域 id（默认 1=agent）")
    args = parser.parse_args()
    asyncio.run(seed(args.domain))


if __name__ == "__main__":
    main()
