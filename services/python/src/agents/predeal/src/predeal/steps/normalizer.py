"""Step 4: Normalization — generate normalized.md and source_map.json."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from ..models import DocumentSource
from ..utils.markdown import ImageRef, extract_images


@dataclass
class SourceMapEntry:
    normalized_start: int
    normalized_end: int
    source_start: int
    source_end: int
    transform: str


@dataclass
class NormalizationResult:
    normalized_text: str
    source_map: list[SourceMapEntry] = field(default_factory=list)
    image_refs: list[ImageRef] = field(default_factory=list)
    output_path: Path | None = None


def normalize_markdown(source_text: str) -> NormalizationResult:
    """Normalize a Markdown document for downstream processing."""
    result = NormalizationResult(normalized_text="")
    text = source_text

    # Phase 1: Convert HTML inline tags to Markdown
    text, inline_mappings = _convert_inline_html(text)

    # Phase 2: Extract image refs for downstream use (no placeholder replacement)
    image_refs = extract_images(text)

    # Phase 3: Clean up excessive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)

    result.normalized_text = text
    result.source_map = inline_mappings
    result.image_refs = image_refs
    return result


def _convert_inline_html(text: str) -> tuple[str, list[SourceMapEntry]]:
    """Convert simple HTML inline tags to Markdown equivalents."""
    mappings: list[SourceMapEntry] = []
    original = text

    # <strong>text</strong> → **text**
    text = re.sub(r"<strong>(.*?)</strong>", r"**\1**", text, flags=re.IGNORECASE)

    # <b>text</b> → **text**
    text = re.sub(r"<b>(.*?)</b>", r"**\1**", text, flags=re.IGNORECASE)

    # <em>text</em> → *text*
    text = re.sub(r"<em>(.*?)</em>", r"*\1*", text, flags=re.IGNORECASE)

    # <i>text</i> → *text*
    text = re.sub(r"<i>(.*?)</i>", r"*\1*", text, flags=re.IGNORECASE)

    # <sup>[1]</sup> → ^[1]
    text = re.sub(r"<sup>(.*?)</sup>", r"^\1", text, flags=re.IGNORECASE)

    # Create source map entries for tracking (simplified)
    if text != original:
        mappings.append(SourceMapEntry(
            normalized_start=0,
            normalized_end=len(text),
            source_start=0,
            source_end=len(original),
            transform="html_inline_to_markdown",
        ))

    return text, mappings


def save_normalization(
    result: NormalizationResult,
    doc: DocumentSource,
    output_dir: Path,
) -> Path:
    """Save normalized.md and source_map.json to output directory."""
    norm_dir = (
        output_dir
        / doc.domain_id
        / doc.domain_version_id
        / doc.document_id
        / "normalized"
    )
    norm_dir.mkdir(parents=True, exist_ok=True)

    # Write normalized.md
    norm_path = norm_dir / "normalized.md"
    norm_path.write_text(result.normalized_text, encoding="utf-8")

    # Write source_map.json
    import json
    map_path = norm_dir / "source_map.json"
    map_data = [
        {
            "normalized_start": m.normalized_start,
            "normalized_end": m.normalized_end,
            "source_start": m.source_start,
            "source_end": m.source_end,
            "transform": m.transform,
        }
        for m in result.source_map
    ]
    map_path.write_text(json.dumps(map_data, ensure_ascii=False, indent=2), encoding="utf-8")

    result.output_path = norm_path
    return norm_path
