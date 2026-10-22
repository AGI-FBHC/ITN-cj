"""从文档抽取知识目录建议（章 / 知识点两级）。

目录格式对齐平台既有知识目录：
    L1 领域（已有，不在这里生成）
    L2 章   node_type='category'
    L3 知识点 node_type='knowledge_point'

只做结构抽取，不做语义理解：Markdown / Word(.docx) / PPT(.pptx) 先统一转成
Markdown，再按标题层级切章、切知识点；没有子标题时退化为按段落/要点切分。
不处理 PDF（用户明确要求不做 PDF）。
"""

from __future__ import annotations

import re
from pathlib import Path

from .doc_convert import SUPPORTED_OFFICE_SUFFIXES, convert_to_markdown

SUPPORTED_CATALOG_SUFFIXES = {".md", ".markdown"} | SUPPORTED_OFFICE_SUFFIXES

MAX_CHAPTERS = 30
MAX_POINTS_PER_CHAPTER = 20
MAX_NAME = 60
MAX_DESCRIPTION = 240

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
_BULLET_RE = re.compile(r"^\s*(?:[-*+]\s+|\d+[.、)]\s*)")
_CHAPTER_TEXT_RE = re.compile(
    r"^(第\s*[0-9一二三四五六七八九十百千]+\s*[章节讲篇部]|chapter\s*\d+|\d+[.、\s])",
    re.IGNORECASE,
)
_WS_RE = re.compile(r"\s+")


def _clip(text: str, limit: int) -> str:
    text = _WS_RE.sub(" ", text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _plain(lines: list[str]) -> str:
    parts = []
    for line in lines:
        stripped = _BULLET_RE.sub("", line.strip()).lstrip("#>").strip()
        if stripped:
            parts.append(stripped)
    return _clip(" ".join(parts), MAX_DESCRIPTION)


def load_markdown(path: Path) -> str:
    """把受支持的文档读成 Markdown 文本。"""
    suffix = path.suffix.lower()
    if suffix in SUPPORTED_OFFICE_SUFFIXES:
        return convert_to_markdown(path)
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="ignore")


def build_outline(markdown: str, fallback_title: str = "未命名文档") -> dict:
    """把 Markdown 文本解析成 {title, chapters:[{name, description, points}]}。"""
    lines = (markdown or "").splitlines()

    headings: list[tuple[int, int, str]] = []
    for index, line in enumerate(lines):
        match = _HEADING_RE.match(line)
        if match:
            headings.append((index, len(match.group(1)), match.group(2).strip()))
    headings = [item for item in headings if item[2]]

    title = fallback_title
    title_index = -1
    if headings:
        first_index, first_level, first_text = headings[0]
        lowest = min(item[1] for item in headings)
        lowest_count = len([item for item in headings if item[1] == lowest])
        # 只有一个最高层标题，或首个标题不像章节名而其后的同级标题像章节名时，
        # 把首个标题当作文档标题（Word 里常见的「标题 + 第1章」写法）。
        next_is_chapter = (
            len(headings) > 1
            and headings[1][1] == lowest
            and not _CHAPTER_TEXT_RE.match(first_text)
            and bool(_CHAPTER_TEXT_RE.match(headings[1][2]))
        )
        if first_level == lowest and (lowest_count == 1 or next_is_chapter):
            title = first_text
            title_index = first_index
            headings = headings[1:]

    if not headings:
        return {
            "title": title,
            "chapters": _fallback_chapters(lines, title),
        }

    chapter_level = min(item[1] for item in headings)
    chapter_starts = [item for item in headings if item[1] <= chapter_level]
    chapter_indexes = {item[0]: item[2] for item in chapter_starts}

    chapters: list[dict] = []
    current = None
    for index, line in enumerate(lines):
        if index == title_index:
            continue
        if index in chapter_indexes:
            if current is not None:
                chapters.append(current)
            if len(chapters) >= MAX_CHAPTERS:
                break
            current = {
                "name": _clip(chapter_indexes[index], MAX_NAME),
                "description": "",
                "points": [],
                "_lines": [],
                "_level": chapter_level,
            }
            continue
        if current is not None:
            current["_lines"].append(line)
    if current is not None and len(chapters) < MAX_CHAPTERS:
        chapters.append(current)

    result = []
    for chapter in chapters:
        body_lines = chapter.pop("_lines")
        chapter.pop("_level", None)
        points, intro_lines = _chapter_contents(body_lines, chapter_level)
        if points:
            chapter["points"] = points
            chapter["description"] = chapter["description"] or _plain(intro_lines)
        else:
            chapter["description"] = chapter["description"] or _plain(body_lines)
        result.append(chapter)

    if not result:
        return {"title": title, "chapters": _fallback_chapters(lines, title)}
    return {"title": title, "chapters": result}


def _chapter_contents(lines: list[str], chapter_level: int) -> tuple[list[dict], list[str]]:
    """章内按更深层标题切知识点；没有子标题时按段落切。

    返回 (知识点列表, 第一个子标题之前的正文行)，后者用于生成章的简介。
    """
    points: list[dict] = []
    intro_lines: list[str] = []
    sub_title: str | None = None
    sub_lines: list[str] = []

    def flush() -> None:
        nonlocal sub_title, sub_lines
        if sub_title is None:
            return
        if len(points) < MAX_POINTS_PER_CHAPTER:
            points.append({
                "name": _clip(sub_title, MAX_NAME),
                "description": _plain(sub_lines),
            })
        sub_title = None
        sub_lines = []

    for line in lines:
        match = _HEADING_RE.match(line)
        if match and len(match.group(1)) > chapter_level:
            flush()
            sub_title = match.group(2).strip()
            continue
        if sub_title is not None:
            sub_lines.append(line)
        elif line.strip():
            intro_lines.append(line)

    flush()
    if points:
        return points, intro_lines

    paragraphs = [line for line in lines if _BULLET_RE.match(line)]
    if len(paragraphs) < 2:
        paragraphs = [line for line in lines if len(line.strip()) >= 8]
    for line in paragraphs[:MAX_POINTS_PER_CHAPTER]:
        text = _BULLET_RE.sub("", line.strip()).lstrip("#>").strip()
        if not text:
            continue
        points.append({
            "name": _clip(text, MAX_NAME),
            "description": _clip(text, MAX_DESCRIPTION),
        })
    return points, intro_lines


def _fallback_chapters(lines: list[str], title: str) -> list[dict]:
    """整篇没有标题时：单章 + 按段落生成知识点。"""
    paragraphs = [line.strip() for line in lines if len(line.strip()) >= 8]
    if not paragraphs:
        return []
    points = []
    for line in paragraphs[:MAX_POINTS_PER_CHAPTER]:
        points.append({
            "name": _clip(line, MAX_NAME),
            "description": _clip(line, MAX_DESCRIPTION),
        })
    return [{
        "name": _clip(title, MAX_NAME),
        "description": "",
        "points": points,
    }]
