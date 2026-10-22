"""对照实验：证明抽取器对'有规则的文本'能正确抽取.

hello_agents 是技术教程（'必须'=输出格式约束，非条件—结论业务规则）→ 0 条属正常。
用文档§4.2 的《电气安全操作规程》示例（明确的 IF-THEN）喂同一抽取器，
若能抽出 R-001~R-005 级别规则，则证明抽取器工作正常，0 条是'数据无信号'而非'工具坏'。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from app.rule_engine.rule_extractor import extract_rules  # noqa: E402

# 文档示例中的规范性文本（明确的 条件—结论 规则）
ELECTRIC_SOP = """
## 电气安全操作规程（摘录）

1. 凡作业高度在 2 米及以上的高处作业，必须佩戴安全带，并设置防坠落装置。
2. 进行电气设备检修前，必须切断相关电源，并悬挂"禁止合闸"警示牌。
3. 检修电气设备前，必须使用验电器验证设备确已无电后方可作业。
4. 禁止在未切断电源的情况下对电气设备进行带电检修作业。
5. 在易燃易爆场所进行电气作业，必须使用防爆型工具和仪表。
6. 电气作业人员必须持证上岗，定期接受安全培训。
"""


async def main() -> None:
    ctx = {
        "title": "电气安全操作规程（对照实验样例）",
        "section_title": "4.2 规则抽取示例",
        "document_id": 0,
        "chunk_id": 0,
        "raw_text": ELECTRIC_SOP,
    }
    rules = await extract_rules(ELECTRIC_SOP, ctx)
    print(f"电气安全规程文本 → 抽出 {len(rules)} 条规则")
    for r in rules:
        print(f"\n  [{r.rule_code}] {r.name}  (conf={r.confidence})")
        print(f"    IF  {[(c.field, c.operator, c.value, c.unit) for c in r.conditions]}")
        print(f"    THEN {[(c.type, (c.content or f'{c.field}={c.value}')) for c in r.conclusions]}")
        print(f"    src: {r.source_text[:50]}")


if __name__ == "__main__":
    asyncio.run(main())
