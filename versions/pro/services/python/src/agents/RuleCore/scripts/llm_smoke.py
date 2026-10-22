"""LLM 冒烟测试：验证 base_url 修复 + 看单切片抽取的原始结果."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from app.rule_engine.chunk_reader import iter_chunks  # noqa: E402
from app.rule_engine.rule_extractor import extract_rules  # noqa: E402


async def main() -> None:
    chunks = iter_chunks(38, only_rule_candidates=True)
    # 挑 3 个不同位置的切片（开头/中间/结尾）
    samples = [chunks[0], chunks[len(chunks) // 2], chunks[-1]]
    for i, ch in enumerate(samples):
        ctx = {
            "title": "第四章 智能体经典范式构建",
            "section_title": ch["section_title"],
            "document_id": 38,
            "chunk_id": ch["chunk_id"],
            "raw_text": ch["content"],
        }
        print(f"\n===== sample {i + 1} chunk={ch['chunk_id']} section={ch['section_title']} =====")
        print(f"原文前80字: {ch['content'][:80]}")
        rules = await extract_rules(ch["content"], ctx)
        print(f"→ 抽出 {len(rules)} 条规则")
        for r in rules:
            print(f"   [{r.rule_code}] {r.name}")
            print(f"     conds: {[ (c.field, c.operator, c.value, c.unit) for c in r.conditions ]}")
            print(f"     cons:  {[(c.type, (c.content or c.field)) for c in r.conclusions]}")
            print(f"     src:   {r.source_text[:60]}")


if __name__ == "__main__":
    asyncio.run(main())
