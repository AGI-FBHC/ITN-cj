"""graph-sync CLI：diff 对账式增量建边入口（dag-design.md §8.5）.

用法（生产 MySQL 连接来自 agents/.env）：
    python -m app.graph.sync_cli --domain 1
    python -m app.graph.sync_cli --domain 1 --cache /tmp/graph_prereq_cache.json

可挂 cron 每日执行；LLM 批量写入需 KNOWLEDGE_ALLOW_WRITE=true。
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from app.core.config import get_settings
from app.core.database import get_session_factory
from app.graph.services.graph_sync import GraphSyncService


async def run(domain_id: int, cache_path: Path | None) -> dict:
    settings = get_settings()
    if not settings.KNOWLEDGE_ALLOW_WRITE:
        print("[graph-sync] ⚠️ KNOWLEDGE_ALLOW_WRITE=false，写操作会被拒绝（生产库只读优先）")
    from app.core.database import get_engine

    factory = get_session_factory()
    async with factory() as db:
        report = await GraphSyncService(db, cache_path=cache_path).run_sync(domain_id)
    await get_engine().dispose()
    return report.__dict__


def main() -> None:
    parser = argparse.ArgumentParser(description="知识先修图 diff 对账式增量建边")
    parser.add_argument("--domain", type=int, required=True, help="领域 id")
    parser.add_argument(
        "--cache", type=Path, default=None,
        help="LLM 判定缓存路径（默认 data/graph_prereq_cache.json）",
    )
    args = parser.parse_args()

    report = asyncio.run(run(args.domain, args.cache))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
