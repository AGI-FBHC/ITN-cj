"""用大模型把标题骨架归并成课程章 / 知识点。

规则解析（catalog.build_outline）只按标题层级切分，遇到「学习目标」「本章小结」
这类结构章节、或没有子标题的长段落时，会切出大量句子级“知识点”。这里把标题骨架
与每节摘要交给大模型，只做「合并分组 + 概念化命名」，不重写原文；任何失败都回退
到规则结果，因此解析链路不会因为模型不可用而中断。
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

import httpx

logger = logging.getLogger(__name__)

LLM_API_URL = (os.environ.get("LLM_API_URL") or os.environ.get("LLM_API_BASE") or "").strip()
LLM_API_KEY = (os.environ.get("LLM_API_KEY") or "").strip()
LLM_MODEL = (os.environ.get("LLM_MODEL") or "deepseek-chat").strip()
LLM_ENABLED = os.environ.get("CATALOG_LLM_ENABLED", "true").strip().lower() not in {"0", "false", "no"}
LLM_TIMEOUT = float(os.environ.get("CATALOG_LLM_TIMEOUT", "90"))

MAX_CHAPTERS = 30
MAX_POINTS_PER_CHAPTER = 8
MAX_NAME = 60
MAX_DESCRIPTION = 240
SKELETON_LIMIT = 16000

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_FENCE_RE = re.compile(r"```.*?```", re.DOTALL)
_WS_RE = re.compile(r"\s+")
# 结构章节：不单独成章，由模型并入「实践与复习」或省略
_STRUCTURAL_RE = re.compile(r"学习目标|本章小结|小结|复习题|练习题|常见问题|动手实践|实践目标|实践步骤")


def _clip(text: str, limit: int) -> str:
    text = _WS_RE.sub(" ", text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def build_skeleton(markdown: str) -> str:
    """把 Markdown 标题与每节正文摘要压成紧凑骨架（不含代码块）。"""
    lines = _FENCE_RE.sub("", markdown or "").splitlines()
    entries: list[tuple[int, str, list[str]]] = []
    for line in lines:
        match = _HEADING_RE.match(line)
        if match:
            entries.append((len(match.group(1)), match.group(2).strip(), []))
        elif entries:
            entries[-1][2].append(line)

    parts: list[str] = []
    for level, title, body in entries:
        if not title:
            continue
        body_text = _clip(" ".join(body), 260)
        indent = "  " * max(0, level - 1)
        parts.append(f"{indent}[H{level}] {title}" + (f" — {body_text}" if body_text else ""))
        if sum(len(item) for item in parts) > SKELETON_LIMIT:
            break
    return "\n".join(parts)


SYSTEM_PROMPT = "你是课程结构设计专家，只输出 JSON，不要输出解释或 Markdown。"

USER_PROMPT = """下面是《{title}》的标题骨架与每节内容摘要。请把它整理成适合课程学习的章 / 知识点结构。

整理规则：
1. 按文档的知识结构整理章：结构清晰时保留原有章；章节较多时可按主题适度合并，但不要为了凑数量强行合并。章数不设固定上限（建议不超过 30）。
2. 「学习目标」「本章小结」「复习题」「常见问题」「动手实践」等结构章节不要单独成章，最多合并成最后一章「实践与复习」；如果内容价值低可以省略。
3. 每章 3-8 个知识点，最多 8 个（严格限制）。知识点必须是概念、方法或对比项的名称（不超过 40 字），不能是完整句子或段落。
4. 描述用一句话概括（不超过 80 字），不得编造文档中没有的内容。
5. 只输出 JSON，格式为：
{{"chapters":[{{"name":"章名","description":"一句话说明","points":[{{"name":"知识点","description":"一句话说明"}}]}}]}}

标题骨架：
{skeleton}
"""

POINTS_PROMPT = """下面是《{title}》的标题骨架与每节内容摘要。它会被挂到一个已有的「章」下，请只整理出该章内部的知识点清单。

整理规则：
1. 输出 5-8 个知识点，最多 8 个；同主题的小节要合并，不要逐条罗列。
2. 每个知识点必须是概念、方法或对比项的名称（不超过 40 字），不能是完整句子或段落。
3. 「学习目标」「本章小结」「复习题」「常见问题」「动手实践」等结构内容不要作为知识点。
4. 描述用一句话概括（不超过 80 字），不得编造文档中没有的内容。
5. 只输出 JSON，格式为：
{{"points":[{{"name":"知识点","description":"一句话说明"}}]}}

标题骨架：
{skeleton}
"""


def _endpoint() -> str:
    url = LLM_API_URL.rstrip("/")
    if url.endswith("/chat/completions"):
        return url
    return f"{url}/chat/completions"


def _normalize(payload: Any, fallback_title: str) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    raw_chapters = payload.get("chapters")
    if not isinstance(raw_chapters, list):
        return None
    chapters: list[dict[str, Any]] = []
    seen_chapters: set[str] = set()
    for item in raw_chapters[:MAX_CHAPTERS]:
        if not isinstance(item, dict):
            continue
        name = _clip(str(item.get("name") or ""), MAX_NAME)
        if not name or name in seen_chapters:
            continue
        seen_chapters.add(name)
        points: list[dict[str, str]] = []
        seen_points: set[str] = set()
        raw_points = item.get("points") if isinstance(item.get("points"), list) else []
        for point in raw_points[:MAX_POINTS_PER_CHAPTER]:
            if not isinstance(point, dict):
                continue
            point_name = _clip(str(point.get("name") or ""), MAX_NAME)
            if not point_name or point_name in seen_points:
                continue
            seen_points.add(point_name)
            points.append({
                "name": point_name,
                "description": _clip(str(point.get("description") or ""), MAX_DESCRIPTION),
            })
        if not points:
            continue
        chapters.append({
            "name": name,
            "description": _clip(str(item.get("description") or ""), MAX_DESCRIPTION),
            "points": points,
        })
    if len(chapters) < 2:
        return None
    return {"title": fallback_title, "chapters": chapters}


def refine_points(markdown: str, fallback_title: str, timeout: float | None = None) -> dict[str, Any] | None:
    """按「章内知识点」范围解析：只输出一组知识点，不生成章。"""
    if not LLM_ENABLED or not LLM_API_URL or not LLM_API_KEY:
        return None
    skeleton = build_skeleton(markdown)
    if not skeleton.strip():
        return None
    body = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": POINTS_PROMPT.format(title=fallback_title, skeleton=skeleton)},
        ],
        "temperature": 0.2,
        "max_tokens": 4096,
        "response_format": {"type": "json_object"},
    }
    try:
        response = httpx.post(
            _endpoint(),
            headers={"Authorization": f"Bearer {LLM_API_KEY}", "Content-Type": "application/json"},
            json=body,
            timeout=timeout or LLM_TIMEOUT,
            trust_env=False,
        )
        response.raise_for_status()
        content = str((response.json().get("choices") or [{}])[0].get("message", {}).get("content") or "").strip()
        fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", content, flags=re.DOTALL | re.IGNORECASE)
        if fenced:
            content = fenced.group(1)
        start, end = content.find("{"), content.rfind("}")
        if start >= 0 and end > start:
            content = content[start:end + 1]
        payload = json.loads(content)
        raw_points = payload.get("points") if isinstance(payload, dict) else None
        if not isinstance(raw_points, list):
            return None
        points: list[dict[str, str]] = []
        seen: set[str] = set()
        for item in raw_points:
            if not isinstance(item, dict):
                continue
            name = _clip(str(item.get("name") or ""), MAX_NAME)
            if not name or name in seen:
                continue
            seen.add(name)
            points.append({"name": name, "description": _clip(str(item.get("description") or ""), MAX_DESCRIPTION)})
            if len(points) >= 8:
                break
        if len(points) < 3:
            return None
        return {"title": fallback_title, "chapters": [{"name": fallback_title, "description": "", "points": points}]}
    except Exception:
        logger.warning("catalog LLM points refine failed", exc_info=True)
        return None


def refine_outline(markdown: str, fallback_title: str) -> dict[str, Any] | None:
    """调用大模型归并章 / 知识点；不可用或结果不合法时返回 None。"""
    if not LLM_ENABLED or not LLM_API_URL or not LLM_API_KEY:
        return None
    skeleton = build_skeleton(markdown)
    if not skeleton.strip():
        return None
    body = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": USER_PROMPT.format(title=fallback_title, skeleton=skeleton)},
        ],
        "temperature": 0.2,
        "max_tokens": 4096,
        "response_format": {"type": "json_object"},
    }
    try:
        response = httpx.post(
            _endpoint(),
            headers={"Authorization": f"Bearer {LLM_API_KEY}", "Content-Type": "application/json"},
            json=body,
            timeout=LLM_TIMEOUT,
            trust_env=False,
        )
        response.raise_for_status()
        data = response.json()
        content = str((data.get("choices") or [{}])[0].get("message", {}).get("content") or "").strip()
        fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", content, flags=re.DOTALL | re.IGNORECASE)
        if fenced:
            content = fenced.group(1)
        start, end = content.find("{"), content.rfind("}")
        if start >= 0 and end > start:
            content = content[start:end + 1]
        return _normalize(json.loads(content), fallback_title)
    except Exception:
        logger.warning("catalog LLM refine failed", exc_info=True)
        return None
