"""MCP 规范抽取验证（零写库）.

目的：证明 MCP（智能体领域协议规范）文本能被现有 Rule Extractor
抽出"条件—结论"结构化规则，与第四章教程（0 条）形成对照。
只调用 LLM + Schema 校验，不写任何 DB。
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from app.rule_engine.rule_extractor import extract_rules_sync  # noqa: E402

SPEC_DIR = HERE / "data" / "mcp_spec"

CASES = [
    ("03_transports", "03_page.mdx", "MCP 传输规范（stdio/HTTP+SSE）"),
    ("01_lifecycle", "01_page.mdx", "MCP 生命周期（initialize/initialized）"),
    ("13_authorization", "13_page.mdx", "MCP 授权（OAuth 2.1）"),
]


def main() -> None:
    grand = 0
    for label, fname, desc in CASES:
        text = (SPEC_DIR / fname).read_text(encoding="utf-8")
        doc_ctx = {
            "title": f"MCP Specification 2025-06-18: {desc}",
            "source_name": "Model Context Protocol (modelcontextprotocol)",
            "document_id": None,
            "chunk_id": None,
            "section_title": label,
            "raw_text": text,
        }
        rules = extract_rules_sync(text[:12000], doc_ctx)  # 截断防超长
        grand += len(rules)
        print(f"\n{'='*72}\n[{label}] {desc} — 抽出 {len(rules)} 条规则")
        for r in rules:
            conds = " & ".join(f"{c.field}{c.operator}{c.value}" for c in r.conditions)
            concl = r.conclusions[0]
            content = (concl.content or "").strip() or "-"
            print(f"  · {concl.type:9s} | {conds} → {content[:54]}")
            print(f"      src: {(r.source_text or '').strip()[:66]}")
    print(f"\n{'='*72}\n合计抽出 {grand} 条结构化规则（全部零写库验证）")


if __name__ == "__main__":
    main()
