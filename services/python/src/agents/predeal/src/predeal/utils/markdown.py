"""Markdown parsing utilities."""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class HeadingInfo:
    level: int
    text: str
    offset: int


@dataclass
class CodeBlock:
    language: str | None
    content: str
    start_offset: int
    end_offset: int


@dataclass
class ImageRef:
    src: str
    alt: str
    is_html: bool
    start_offset: int
    end_offset: int
    caption: str | None = None
    width: str | None = None


def extract_headings(text: str) -> list[HeadingInfo]:
    """Extract all Markdown headings with their offsets, excluding headings inside code blocks."""
    # Use find_code_block_ranges for proper nested fence handling
    code_ranges = find_code_block_ranges(text)

    headings = []
    for m in re.finditer(r"^(#{1,6})\s+(.+)$", text, re.MULTILINE):
        # Skip if inside a code block
        if is_in_code_block(m.start(), code_ranges):
            continue
        headings.append(HeadingInfo(
            level=len(m.group(1)),
            text=m.group(2).strip(),
            offset=m.start(),
        ))
    return headings


def extract_code_blocks(text: str) -> list[CodeBlock]:
    """Extract fenced code blocks with their offsets.

    Uses find_code_block_ranges for proper nested fence handling.
    """
    ranges = find_code_block_ranges(text)
    blocks = []
    for start, end in ranges:
        block_text = text[start:end]
        # Extract language from opening fence
        first_line = block_text.split("\n", 1)[0]
        lang_match = re.match(r"^([`~]+)\s*(\w*)", first_line)
        language = lang_match.group(2) if lang_match and lang_match.group(2) else None
        # Content is between opening and closing fences
        lines = block_text.split("\n")
        content = "\n".join(lines[1:-1]) if len(lines) > 2 else ""
        blocks.append(CodeBlock(
            language=language,
            content=content,
            start_offset=start,
            end_offset=end,
        ))
    return blocks


# Markdown image: ![alt](src)
_MD_IMG = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")

# HTML img tag
_HTML_IMG = re.compile(
    r'<img\s+[^>]*src=["\']([^"\']+)["\'][^>]*/?>',
    re.IGNORECASE,
)

# HTML div with img + caption
_HTML_DIV_FIGURE = re.compile(
    r'<div[^>]*>\s*'
    r'<img\s+[^>]*src=["\']([^"\']+)["\'][^>]*/?>\s*'
    r'(?:<p[^>]*>(.*?)</p>)?\s*'
    r'</div>',
    re.IGNORECASE | re.DOTALL,
)

_HTML_WIDTH = re.compile(r'width=["\']?(\d+%?)["\']?', re.IGNORECASE)
_HTML_ALT = re.compile(r'alt=["\']([^"\']*)["\']', re.IGNORECASE)


def extract_images(text: str) -> list[ImageRef]:
    """Extract all image references (Markdown and HTML)."""
    images: list[ImageRef] = []
    seen_spans: set[tuple[int, int]] = set()

    # HTML div figures first (more specific)
    for m in _HTML_DIV_FIGURE.finditer(text):
        src = m.group(1)
        caption = m.group(2).strip() if m.group(2) else None
        width_m = _HTML_WIDTH.search(m.group(0))
        alt_m = _HTML_ALT.search(m.group(0))
        images.append(ImageRef(
            src=src,
            alt=alt_m.group(1) if alt_m else "",
            is_html=True,
            start_offset=m.start(),
            end_offset=m.end(),
            caption=caption,
            width=width_m.group(1) if width_m else None,
        ))
        seen_spans.add((m.start(), m.end()))

    # HTML img tags
    for m in _HTML_IMG.finditer(text):
        if any(m.start() >= s and m.end() <= e for s, e in seen_spans):
            continue
        src = m.group(1)
        alt_m = _HTML_ALT.search(m.group(0))
        width_m = _HTML_WIDTH.search(m.group(0))
        images.append(ImageRef(
            src=src,
            alt=alt_m.group(1) if alt_m else "",
            is_html=True,
            start_offset=m.start(),
            end_offset=m.end(),
            width=width_m.group(1) if width_m else None,
        ))
        seen_spans.add((m.start(), m.end()))

    # Markdown images
    for m in _MD_IMG.finditer(text):
        if any(m.start() >= s and m.end() <= e for s, e in seen_spans):
            continue
        images.append(ImageRef(
            src=m.group(2),
            alt=m.group(1),
            is_html=False,
            start_offset=m.start(),
            end_offset=m.end(),
        ))

    images.sort(key=lambda x: x.start_offset)
    return images


def find_code_block_ranges(text: str) -> list[tuple[int, int]]:
    """Find all fenced code block ranges in text.

    Recognizes ``` and ~~~ fences with any length (3+ characters).
    Properly handles nested fences: ```` can contain ``` inside.

    Returns list of (start, end) character-offset pairs.
    """
    ranges: list[tuple[int, int]] = []
    lines = text.split("\n")
    in_block = False
    block_start = 0
    fence_char = ""  # ` or ~
    fence_len = 0    # number of fence characters

    offset = 0
    for line in lines:
        stripped = line.strip()
        if not in_block:
            # Look for opening fence: ``` or ~~~ (possibly with language tag)
            if stripped.startswith("```") or stripped.startswith("~~~"):
                fence_char = stripped[0]  # ` or ~
                # Count fence characters
                fence_len = 0
                for c in stripped:
                    if c == fence_char:
                        fence_len += 1
                    else:
                        break
                block_start = offset
                in_block = True
        else:
            # Look for closing fence: same char, same or greater length
            # A closing fence must be ONLY fence characters (no language tag)
            if stripped.startswith(fence_char):
                # Check if it's only fence characters
                only_fence = all(c == fence_char for c in stripped)
                if only_fence and len(stripped) >= fence_len:
                    ranges.append((block_start, offset + len(line)))
                    in_block = False
                    fence_char = ""
                    fence_len = 0
        offset += len(line) + 1  # +1 for newline

    # Handle unclosed block at end
    if in_block:
        ranges.append((block_start, len(text)))

    return ranges


def is_in_code_block(pos: int, code_ranges: list[tuple[int, int]]) -> bool:
    """Check if a position falls inside any code block range."""
    return any(start <= pos < end for start, end in code_ranges)
