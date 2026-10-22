"""MCP 规范规则入库（抽取 → 稳定编码 → 校验 → upsert）.

按用户指令（2026-08-25）：
- 只写 domain_rule，不建 knowledge_document、不写 knowledge_chunk
  （用户无 predeal 最新源码，切片走管线才能保一致性，先不切片）
- source_document_id = NULL；规则靠 'MCP-<page>' 前缀 + 内容 hash 标识
- rule_code 用 stable_rule_code（内容决定）→ 重跑本脚本自动去重，
  且将来切片管线若再抽到同文规则（用同一 prefix 约定）也能 upsert 去重
- 删除：scripts/purge_mcp_rules.py（按 MCP- 前缀整批删）

用法：
  .venv/bin/python scripts/ingest_mcp_rules.py                 # 全部 10 页
  .venv/bin/python scripts/ingest_mcp_rules.py --pages 01,03   # 指定页
  .venv/bin/python scripts/ingest_mcp_rules.py --no-verify     # 跳过 LLM 校验（快，全 ACTIVE）
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from app.core.config import settings  # noqa: E402
from app.rule_engine.repositories import rule_repository as repo  # noqa: E402
from app.rule_engine.rule_extractor import extract_rules  # noqa: E402
from app.rule_engine.rule_verifier import determine_status, verify_rule  # noqa: E402
from app.rule_engine.stable_code import stable_rule_code  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ingest_mcp")

SPEC_DIR = HERE / "data" / "mcp_spec"

# 页码 → (文件名, 页标题, 章节标签)
PAGES: dict[str, tuple[str, str, str]] = {
    "01": ("01_page.mdx", "MCP Lifecycle", "lifecycle"),
    "02": ("02_page.mdx", "MCP Protocol Overview", "index"),
    "03": ("03_page.mdx", "MCP Transports (stdio / HTTP+SSE)", "transports"),
    "07": ("07_page.mdx", "MCP Progress Reporting", "utilities/progress"),
    "08": ("08_page.mdx", "MCP Cancellation", "utilities/cancellation"),
    "10": ("10_page.mdx", "MCP Tools", "server/tools"),
    "11": ("11_page.mdx", "MCP Prompts", "server/prompts"),
    "12": ("12_page.mdx", "MCP Resources", "server/resources"),
    "13": ("13_page.mdx", "MCP Authorization (OAuth 2.1)", "authorization"),
    "14": ("14_page.mdx", "MCP Sampling", "client/sampling"),
}

MAX_TEXT_CHARS = 12000  # 防单次 LLM 输入过长（mimo 推理预算有限）


async def ingest_page(num: str, title: str, section: str, do_verify: bool) -> dict:
    fname = PAGES[num][0]
    path = SPEC_DIR / fname
    if not path.exists():
        return {"page": num, "error": f"文件不存在: {fname}"}
    text = path.read_text(encoding="utf-8").strip()[:MAX_TEXT_CHARS]
    doc_ctx = {
        "title": f"MCP Specification 2025-06-18: {title}",
        "source_name": "Model Context Protocol (modelcontextprotocol)",
        "section_title": section,
        "document_id": None,   # 不建文档行
        "chunk_id": None,      # 不切片
        "raw_text": text,
    }
    prefix = f"MCP-{section}"
    stats = {"page": num, "title": title, "candidate": 0, "active": 0, "invalid": 0}
    try:
        rules = await extract_rules(text, doc_ctx)
    except Exception as e:  # noqa: BLE001
        stats["error"] = f"抽取失败: {e}"
        return stats

    for rule in rules:
        rule.rule_code = stable_rule_code(prefix, rule)
        rule.source_document_id = None
        rule.source_chunk_id = None
        rule.source_section = f"spec/2025-06-18/{section}"
        stats["candidate"] += 1

        if do_verify:
            try:
                verify = await verify_rule(rule, text)
                status = determine_status(verify)
                reject = "; ".join(verify.issues[:5]) if verify.issues else None
                rule.confidence = verify.confidence
            except Exception as e:  # noqa: BLE001
                logger.warning("校验失败 %s: %s", rule.rule_code, e)
                status, reject, rule.confidence = "INVALID", "校验器异常", 0.0
        else:
            status, reject = "ACTIVE", None

        try:
            repo.upsert_rule(rule, status, reject)
        except Exception as e:  # noqa: BLE001
            logger.warning("入库失败 %s: %s", rule.rule_code, e)
            continue
        stats["active" if status == "ACTIVE" else "invalid"] += 1
        logger.info(
            "  [%s] %s %s conf=%.2f | %s",
            rule.rule_code, status, rule.name[:40], rule.confidence, reject or "-",
        )
    return stats


async def main() -> dict:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", default=",".join(PAGES.keys()),
                    help="逗号分隔页码，如 01,03")
    ap.add_argument("--no-verify", action="store_true", help="跳过 LLM 校验")
    args = ap.parse_args()
    page_nums = [p.strip() for p in args.pages.split(",") if p.strip()]
    do_verify = not args.no_verify
    logger.info("MCP 规则入库: pages=%s verify=%s threshold=%.2f",
                page_nums, do_verify, settings.RULE_EXTRACT_CONFIDENCE_THRESHOLD)

    results = []
    for num in page_nums:
        if num not in PAGES:
            logger.warning("未知页码 %s，跳过", num)
            continue
        _, title, section = PAGES[num]
        results.append(await ingest_page(num, title, section, do_verify))

    total = {
        "pages": len(results),
        "candidate": sum(r.get("candidate", 0) for r in results),
        "active": sum(r.get("active", 0) for r in results),
        "invalid": sum(r.get("invalid", 0) for r in results),
        "errors": [r.get("error") for r in results if r.get("error")],
        "details": results,
    }
    logger.info("完成: %s", {k: total[k] for k in ("pages", "candidate", "active", "invalid")})
    return total


if __name__ == "__main__":
    import json
    total = asyncio.run(main())
    print(json.dumps(total, ensure_ascii=False, indent=2, default=str))
