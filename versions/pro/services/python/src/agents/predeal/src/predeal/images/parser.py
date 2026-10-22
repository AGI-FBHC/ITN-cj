"""Image parser for identifying images in Markdown documents.

Supports:
- HTML <img> tags (with or without wrapping <div>)
- Markdown image syntax ![alt](url)
- Figure captions and labels
"""

from __future__ import annotations

import os
import re
from typing import List

from .models import ImageRef

# ── Regex Patterns ────────────────────────────────────────────────────────────
# ── Regex Patterns ────────────────────────────────────────────────────────────
# HTML div with img + caption pattern (order-agnostic: p before or after img)
_HTML_DIV_FIGURE = re.compile(
    r'<div[^>]*>\s*'
    r'(?:<p[^>]*>(.*?)</p>\s*)?'           # optional caption before img
    r'<img\s+[^>]*src=["\']([^"\']+)["\'][^>]*/?>\s*'
    r'(?:<p[^>]*>(.*?)</p>)?'              # optional caption after img
    r'</div>',
    re.IGNORECASE | re.DOTALL,
)

# HTML img tag pattern
_HTML_IMG = re.compile(
    r'<img\s+[^>]*src=["\']([^"\']+)["\'][^>]*/?>',
    re.IGNORECASE,
)

# Markdown image pattern
_MD_IMG = re.compile(r'!\[([^\]]*)\]\(([^)]+)\)')

# Attribute extraction patterns
_HTML_WIDTH = re.compile(r'width=["\']?(\d+%?)["\']?', re.IGNORECASE)
_HTML_ALT = re.compile(r'alt=["\']([^"\']*)["\']', re.IGNORECASE)

# Figure label pattern (e.g., "图 4.1", "表 4.1", "Figure 4.1")
_FIGURE_LABEL = re.compile(r'(?:图|表|Figure|Fig\.?)\s*[\d.]+', re.IGNORECASE)


def parse_images(text: str) -> List[ImageRef]:
    """Parse all image references from a Markdown document.

    Processes HTML images first (more specific), then Markdown images.
    Returns images sorted by their position in the document.

    Args:
        text: Markdown document content

    Returns:
        List of ImageRef objects sorted by occurrence order
    """
    images: List[ImageRef] = []
    seen_spans: set[tuple[int, int]] = set()

    # 1. HTML div figures (most specific pattern)
    for match in _HTML_DIV_FIGURE.finditer(text):
        # group(1) = caption before img, group(2) = src, group(3) = caption after img
        src = match.group(2)
        caption_before = match.group(1)
        caption_after = match.group(3)

        # Prefer caption that contains a figure label, otherwise use whichever exists
        caption = None
        if caption_before and _FIGURE_LABEL.search(caption_before):
            caption = caption_before.strip()
        elif caption_after and _FIGURE_LABEL.search(caption_after):
            caption = caption_after.strip()
        elif caption_before:
            caption = caption_before.strip()
        elif caption_after:
            caption = caption_after.strip()

        full_tag = match.group(0)

        # Skip already processed images (ITN server)
        if _is_processed_image(src):
            continue

        # Extract attributes
        alt_m = _HTML_ALT.search(full_tag)
        width_m = _HTML_WIDTH.search(full_tag)

        # Extract figure label from caption
        figure_label = _extract_figure_label(caption) if caption else None

        images.append(ImageRef(
            source_url=src,
            alt_text=alt_m.group(1) if alt_m else "",
            caption=caption,
            figure_label=figure_label,
            is_html=True,
            start_offset=match.start(),
            end_offset=match.end(),
            width=width_m.group(1) if width_m else None,
            original_tag=full_tag,
        ))
        seen_spans.add((match.start(), match.end()))

    # 2. HTML img tags (not already captured by div pattern)
    for match in _HTML_IMG.finditer(text):
        # Skip if already captured by div pattern
        if any(match.start() >= s and match.end() <= e for s, e in seen_spans):
            continue

        src = match.group(1)
        full_tag = match.group(0)

        # Skip already processed images
        if _is_processed_image(src):
            continue

        # Extract attributes
        alt_m = _HTML_ALT.search(full_tag)
        width_m = _HTML_WIDTH.search(full_tag)

        # Look for caption after the img tag
        caption = _find_caption_after(text, match.end())
        figure_label = _extract_figure_label(caption) if caption else None

        images.append(ImageRef(
            source_url=src,
            alt_text=alt_m.group(1) if alt_m else "",
            caption=caption,
            figure_label=figure_label,
            is_html=True,
            start_offset=match.start(),
            end_offset=match.end(),
            width=width_m.group(1) if width_m else None,
            original_tag=full_tag,
        ))
        seen_spans.add((match.start(), match.end()))

    # 3. Markdown images
    for match in _MD_IMG.finditer(text):
        # Skip if already captured
        if any(match.start() >= s and match.end() <= e for s, e in seen_spans):
            continue

        src = match.group(2)
        alt_text = match.group(1)

        # Skip already processed images
        if _is_processed_image(src):
            continue

        # Look for caption after the markdown image
        caption = _find_caption_after(text, match.end())
        figure_label = _extract_figure_label(caption) if caption else None

        images.append(ImageRef(
            source_url=src,
            alt_text=alt_text,
            caption=caption,
            figure_label=figure_label,
            is_html=False,
            start_offset=match.start(),
            end_offset=match.end(),
            original_tag=match.group(0),
        ))

    # Sort by position in document
    images.sort(key=lambda x: x.start_offset)

    # Assign occurrence numbers
    for idx, img in enumerate(images, start=1):
        img.occurrence_no = idx

    return images


def _is_processed_image(url: str) -> bool:
    """Check if an image URL points to the ITN image server."""
    image_server = os.environ.get("IMAGE_BASE_URL", "")
    return image_server and image_server.rstrip("/").split("//")[-1] in url


def _find_caption_after(text: str, offset: int) -> str | None:
    """Look for a figure caption after an image tag.

    Searches for text like "图 4.1 Description" or "<p>图 4.1 Description</p>"
    within a reasonable distance after the image.
    """
    # Look ahead up to 500 characters
    search_text = text[offset:offset + 500]

    # Try HTML <p> tag first
    p_match = re.search(r'<p[^>]*>(.*?)</p>', search_text, re.DOTALL)
    if p_match:
        caption = p_match.group(1).strip()
        if _FIGURE_LABEL.search(caption):
            return caption

    # Try plain text line
    line_match = re.search(r'\n\s*(图\s*[\d.]+\s*.+?)(?:\n|$)', search_text)
    if line_match:
        return line_match.group(1).strip()

    return None


def _extract_figure_label(text: str | None) -> str | None:
    """Extract figure label from caption text.

    Returns:
        Figure label (e.g., "图 4.1") or None
    """
    if not text:
        return None
    match = _FIGURE_LABEL.search(text)
    return match.group(0) if match else None
