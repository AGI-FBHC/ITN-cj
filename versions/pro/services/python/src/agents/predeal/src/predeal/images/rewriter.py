"""Document rewriter for image path replacement.

Handles:
- Replacing image URLs with ITN server URLs
- Adding data-figure-id and data-vlm-description attributes
- Converting Markdown images to HTML img tags
"""

from __future__ import annotations

import logging
from html import escape
from typing import List

from .models import ImageRef, ReplacementInfo

logger = logging.getLogger(__name__)


def build_replacement(
    image: ImageRef,
    public_url: str,
    figure_id: int,
    vlm_description: str,
) -> ReplacementInfo:
    """Build a replacement info object for an image.

    Args:
        image: Original image reference
        public_url: New public URL
        figure_id: Database record ID
        vlm_description: VLM generated description

    Returns:
        ReplacementInfo object
    """
    return ReplacementInfo(
        image=image,
        public_url=public_url,
        figure_id=figure_id,
        vlm_description=vlm_description,
    )


def apply_replacements(
    source_text: str,
    replacements: List[ReplacementInfo],
) -> str:
    """Apply all image replacements to the source text.

    Processes replacements in reverse order to maintain correct offsets.

    Args:
        source_text: Original document text
        replacements: List of replacement info objects

    Returns:
        Modified document text with all replacements applied
    """
    if not replacements:
        return source_text

    # Sort replacements by start offset in reverse order
    # This ensures we replace from end to start, maintaining correct offsets
    sorted_replacements = sorted(
        replacements,
        key=lambda r: r.image.start_offset,
        reverse=True,
    )

    result = source_text

    for replacement in sorted_replacements:
        # Build the new img tag
        new_tag = _build_img_tag(replacement)

        # Replace the original tag
        start = replacement.image.start_offset
        end = replacement.image.end_offset

        result = result[:start] + new_tag + result[end:]

        logger.debug(
            f"Replaced image at offset {start}-{end}: "
            f"{replacement.image.source_url} -> {replacement.public_url}"
        )

    return result


def _build_img_tag(replacement: ReplacementInfo) -> str:
    """Build a new HTML img tag with all required attributes.

    Args:
        replacement: Replacement info

    Returns:
        Complete HTML img tag
    """
    image = replacement.image

    # Escape the VLM description for HTML attribute
    vlm_desc_escaped = prepare_html_attribute(replacement.vlm_description)

    # Build the tag
    if image.is_html:
        # HTML img tag
        tag = _build_html_img_tag(
            src=replacement.public_url,
            alt=image.alt_text,
            width=image.width,
            figure_id=replacement.figure_id,
            vlm_description=vlm_desc_escaped,
        )
    else:
        # Convert Markdown image to HTML img tag
        tag = _build_html_img_tag(
            src=replacement.public_url,
            alt=image.alt_text,
            width=None,
            figure_id=replacement.figure_id,
            vlm_description=vlm_desc_escaped,
        )

    return tag


def _build_html_img_tag(
    src: str,
    alt: str,
    width: str | None,
    figure_id: int,
    vlm_description: str,
) -> str:
    """Build an HTML img tag.

    Args:
        src: Image URL
        alt: Alt text
        width: Width attribute (optional)
        figure_id: Database record ID
        vlm_description: Escaped VLM description

    Returns:
        Complete HTML img tag
    """
    # Build attributes
    parts = [f'src="{escape(src, quote=True)}"']

    if alt:
        parts.append(f'alt="{escape(alt, quote=True)}"')

    if width:
        parts.append(f'width="{escape(width, quote=True)}"')

    parts.append(f'data-figure-id="{figure_id}"')
    parts.append(f'data-vlm-description="{vlm_description}"')

    # Build the tag
    attrs = " ".join(parts)
    return f"<img {attrs} />"


def prepare_html_attribute(value: str) -> str:
    """Prepare a string for use as an HTML attribute value.

    - Collapses whitespace to single spaces
    - Removes newlines
    - Escapes HTML special characters

    Args:
        value: Raw string value

    Returns:
        Escaped string safe for HTML attributes
    """
    # Collapse whitespace and remove newlines
    one_line = " ".join(value.split())

    # Escape HTML special characters
    return escape(one_line, quote=True)
