"""Step 7: Chunk Compilation — generate final chunks with metadata.

Includes optional figure binding: after chunks are compiled, LLM determines
which figures belong to which chunks and moves/copies <img> tags accordingly.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from ..config import ChunkPolicy, DomainConfig
from ..models import ChunkType, DocumentSource, FigureAsset, KnowledgeChunk, StructureNode
from ..utils.hash import content_hash
from ..utils.markdown import find_code_block_ranges, is_in_code_block

logger = logging.getLogger(__name__)


CHUNK_SEPARATOR = "<<<ITN_CHUNK_BOUNDARY>>>"

# Heading-only threshold: chunks below this are candidates for merging
_HEADING_ONLY_MAX_CHARS = 150

# Regex for stripping figure-related content from text before counting
_IMG_TAG_RE = re.compile(r'<img\s+[^>]*/?>', re.IGNORECASE | re.DOTALL)
_FIGURE_CAPTION_RE = re.compile(r'^图\s*\d+[^\n]*$', re.MULTILINE)


def _text_length_without_figures(text: str) -> int:
    """Calculate text length excluding img tags and figure captions."""
    cleaned = _IMG_TAG_RE.sub('', text)
    cleaned = _FIGURE_CAPTION_RE.sub('', cleaned)
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    return len(cleaned.strip())


@dataclass
class SubChunk:
    """A sub-chunk with its local offset within the parent section text."""
    text: str
    local_start: int
    local_end: int


def compile_chunks(
    normalized_text: str,
    nodes: list[StructureNode],
    doc: DocumentSource,
    config: DomainConfig,
    figure_records: Optional[list[dict]] = None,
) -> tuple[str, list[KnowledgeChunk]]:
    """Compile structure nodes into knowledge chunks.

    If figure_records are provided (from knowledge_figures table), runs
    LLM-based figure binding to move/copy img tags into the correct chunks.

    Returns:
        Tuple of (chunked_for_ragflow.md content, list of KnowledgeChunk).
    """
    chunks: list[KnowledgeChunk] = []
    chunk_order = 0
    ragflow_parts: list[str] = []

    for node in nodes:
        # Get the text for this node
        start = node.normalized_start_offset
        end = node.normalized_end_offset
        section_text = normalized_text[start:end].strip()

        if not section_text:
            continue

        # Split oversized sections into sub-chunks with offsets
        sub_chunks = _split_if_needed(section_text, config.chunk_policy, title_path=node.heading or "")

        # Check for cross-section headings and split if needed
        cross_section_chunks = _split_at_cross_section_headings(
            section_text, node.heading, config.chunk_policy
        )
        if cross_section_chunks:
            sub_chunks = cross_section_chunks

        for sub in sub_chunks:
            chunk_order += 1
            chunk_id = f"chunk_{chunk_order:06d}"

            # ── Figure IDs: extract from data-figure-id attributes ──
            content_figure_ids = sorted(set(
                re.findall(r'data-figure-id="(\d+)"', sub.text)
            ))

            # Determine chunk type
            chunk_type = _classify_chunk_type(sub.text)

            # Extract virtual heading from content
            virtual_heading = _extract_virtual_heading(sub.text)

            # Build section path (include heading if present)
            section_path = list(node.section_path)
            if node.heading and (not section_path or section_path[-1] != node.heading):
                section_path.append(node.heading)

            # Build the ragflow chunk text
            header_lines = []
            for sp in section_path:
                level = section_path.index(sp) + 1
                header_lines.append(f"{'#' * level} {sp}")

            chunk_text = "\n".join(header_lines) + "\n\n" + sub.text if header_lines else sub.text

            c_hash = content_hash(sub.text)

            # ── Chunk-level offsets ──
            chunk_norm_start = node.normalized_start_offset + sub.local_start
            chunk_norm_end = node.normalized_start_offset + sub.local_end
            chunk_src_start = node.source_start_offset + sub.local_start
            chunk_src_end = node.source_start_offset + sub.local_end

            chunk = KnowledgeChunk(
                chunk_id=chunk_id,
                document_id=doc.document_id,
                domain_id=config.domain_id,
                domain_version_id=config.domain_version_id,
                source_file_hash=doc.file_hash,
                section_path=section_path,
                heading=node.heading,
                virtual_heading=virtual_heading,
                content=sub.text,
                content_hash=c_hash,
                chunk_type=chunk_type,
                chunk_order=chunk_order,
                source_start_offset=chunk_src_start,
                source_end_offset=chunk_src_end,
                normalized_start_offset=chunk_norm_start,
                normalized_end_offset=chunk_norm_end,
                char_count=_text_length_without_figures(sub.text),
                approx_token_count=_text_length_without_figures(sub.text) // 2,
                contains_code=bool(re.search(r"```", sub.text)),
                contains_table=bool(re.search(r"^\|.*\|", sub.text, re.MULTILINE)),
                contains_figure=bool(content_figure_ids),
                figure_ids=content_figure_ids,
                metadata={
                    "authority_level": doc.authority_level,
                    "applicability_scope": doc.applicability_scope,
                },
            )
            chunks.append(chunk)
            ragflow_parts.append(chunk_text)

    # ── Post-merge: merge heading-only chunks into their successor ──
    chunks = _post_merge_heading_chunks(chunks)

    # Re-number chunk_order after merge
    for idx, chunk in enumerate(chunks):
        chunk.chunk_order = idx + 1
        chunk.chunk_id = f"chunk_{idx + 1:06d}"

    # ── Figure binding + semantic re-split (unified slice review) ──
    # 统一切片评审：含图切片顺带图归属，超长切片顺带语义切分（同一切片一次 LLM 调用）；
    # 无图且不超长 → 不调 LLM。figure_records 为空且未开 semantic_split → 完全跳过。
    if figure_records or config.chunk_policy.semantic_split:
        chunks = _bind_figures(chunks, figure_records or [], normalized_text, config.chunk_policy)
        # 评审后切片列表可能变化 → 重新编号
        for idx, chunk in enumerate(chunks):
            chunk.chunk_order = idx + 1
            chunk.chunk_id = f"chunk_{idx + 1:06d}"

    # Build ragflow content from final chunks
    ragflow_parts = []
    for chunk in chunks:
        header_lines = []
        for sp in chunk.section_path:
            level = chunk.section_path.index(sp) + 1
            header_lines.append(f"{'#' * level} {sp}")
        chunk_text = "\n".join(header_lines) + "\n\n" + chunk.content if header_lines else chunk.content
        ragflow_parts.append(chunk_text)

    ragflow_content = f"\n\n{CHUNK_SEPARATOR}\n\n".join(ragflow_parts)
    if ragflow_parts:
        ragflow_content = f"{CHUNK_SEPARATOR}\n\n{ragflow_content}"

    return ragflow_content, chunks


def build_ragflow_content(chunks: list[KnowledgeChunk]) -> str:
    """Build ragflow markdown content from a list of chunks.

    Reusable after chunk content has been modified (e.g., by figure binding).
    """
    ragflow_parts = []
    for chunk in chunks:
        header_lines = []
        for sp in chunk.section_path:
            level = chunk.section_path.index(sp) + 1
            header_lines.append(f"{'#' * level} {sp}")
        chunk_text = "\n".join(header_lines) + "\n\n" + chunk.content if header_lines else chunk.content
        ragflow_parts.append(chunk_text)

    content = f"\n\n{CHUNK_SEPARATOR}\n\n".join(ragflow_parts)
    if ragflow_parts:
        content = f"{CHUNK_SEPARATOR}\n\n{content}"
    return content


# ── Splitting ────────────────────────────────────────────────────────────────


# T3.8: 切分优先级序列 — 每个策略是 (text, policy, code_ranges) -> Optional[list[SubChunk]]。
# 默认顺序（ChunkPolicy.split_priority 默认值）与历史硬编码顺序完全一致：
# #### 标题 → ##/### 标题 → 中文编号 → 方式/步骤/组件 → ### 标题（超长时）→
# **加粗** 标题（超长时）→ 段落安全切分。"safe" 兜底不在此表中，
# _split_if_needed 找不到任何命中时总会调用。
_SPLIT_STRATEGIES: dict = {
    "h4": lambda text, policy, code_ranges: _split_outside_code_blocks(
        text, r"(?=^####\s)", policy, code_ranges),
    "h23": lambda text, policy, code_ranges: _split_outside_code_blocks(
        text, r"(?=^#{2,3}\s+)", policy, code_ranges),
    "cn_num": lambda text, policy, code_ranges: _split_outside_code_blocks(
        text, r"(?=^（\d+）)", policy, code_ranges),
    "step_word": lambda text, policy, code_ranges: _split_outside_code_blocks(
        text, r"(?=^方式\s*\d+|^步骤\s*\d+|^组件\s*\d+)", policy, code_ranges),
    "h3_long": lambda text, policy, code_ranges: (
        _split_outside_code_blocks(text, r"(?=^###\s+)", policy, code_ranges)
        if _text_length_without_figures(text) > policy.target_max_chars else None
    ),
    "bold_long": lambda text, policy, code_ranges: (
        _split_outside_code_blocks(text, r"(?=^\*\*[^*]+\*\*\s*$)", policy, code_ranges)
        if _text_length_without_figures(text) > policy.target_max_chars else None
    ),
    "paragraph": lambda text, policy, code_ranges: _split_by_paragraph_safe(
        text, policy, code_ranges),
}


def _split_if_needed(
    text: str,
    policy: ChunkPolicy,
    title_path: str = "",
) -> list[SubChunk]:
    """Split text into sub-chunks if it exceeds hard_max_chars.

    Returns list of SubChunk with local offsets within `text`.
    All strategies are code-block-aware: never split inside a fenced code block.
    Size checks exclude img tags and figure captions.

    Split chain (T3.8: configurable via policy.split_priority): 规则锚点 →
    段落兜底 → 安全点。LLM 语义辅助切分由 binder 阶段的统一切片评审执行
    （figure_chunk_binder.review_and_bind），避免与图片归属重复调用 LLM。
    """
    if _text_length_without_figures(text) <= policy.hard_max_chars:
        return [SubChunk(text=text, local_start=0, local_end=len(text))]

    code_ranges = find_code_block_ranges(text)

    for name in policy.split_priority:
        strategy = _SPLIT_STRATEGIES.get(name)
        if strategy is None:
            continue
        result = strategy(text, policy, code_ranges)
        if result:
            return result

    # Fallback: safe split at nearest legal point (never inside code blocks)
    return _split_at_safe_points(text, policy.hard_max_chars, code_ranges)


def _split_at_cross_section_headings(
    text: str,
    node_heading: str | None,
    policy: ChunkPolicy,
) -> list[SubChunk] | None:
    """Split text at headings that belong to different sections.

    If the content starts with text before a heading (preamble from previous section),
    split at that heading boundary. This prevents cross-section merging.

    Returns None if no cross-section headings found.
    """
    if not node_heading:
        return None

    code_ranges = find_code_block_ranges(text)

    # Find all ## and ### headings outside code blocks
    heading_positions: list[tuple[int, str]] = []
    for m in re.finditer(r"^(#{2,3})\s+(.+)$", text, re.MULTILINE):
        pos = m.start()
        if not is_in_code_block(pos, code_ranges):
            heading_positions.append((pos, m.group(2).strip()))

    if not heading_positions:
        return None

    # Check if the first heading matches the node heading
    first_heading_pos, first_heading_text = heading_positions[0]

    # If the text starts before the first heading, it's a preamble
    if first_heading_pos > 0:
        preamble = text[:first_heading_pos].strip()
        if preamble:
            # Split at the first heading
            parts = []
            parts.append(SubChunk(text=preamble, local_start=0, local_end=first_heading_pos))
            remaining = text[first_heading_pos:].strip()
            if remaining:
                parts.append(SubChunk(text=remaining, local_start=first_heading_pos, local_end=len(text)))
            return parts if len(parts) > 1 else None

    return None


def _split_outside_code_blocks(
    text: str,
    pattern: str,
    policy: ChunkPolicy,
    code_ranges: list[tuple[int, int]],
) -> list[SubChunk] | None:
    """Split text by regex pattern, but never inside code blocks.

    The first split point is always 0 (start of text), so the first part
    includes any preamble before the first match. This ensures introductory
    text is merged with the first structural unit, not standalone.
    """
    # Find split points outside code blocks
    split_points = [0]
    for m in re.finditer(pattern, text, re.MULTILINE):
        pos = m.start()
        if not is_in_code_block(pos, code_ranges):
            split_points.append(pos)
    split_points.append(len(text))

    if len(split_points) <= 2:
        return None

    parts: list[SubChunk] = []
    for i in range(len(split_points) - 1):
        start = split_points[i]
        end = split_points[i + 1]
        # Don't strip - preserve newlines between parts
        part_text = text[start:end]
        # Only strip leading/trailing whitespace, but preserve internal structure
        part_text = part_text.strip()
        if part_text:
            parts.append(SubChunk(text=part_text, local_start=start, local_end=end))

    if len(parts) < 2:
        return None

    merged = _merge_small_parts(parts, policy)
    # Skip _ensure_code_blocks_closed check — split points are already outside code blocks
    result = _ensure_code_blocks_closed(merged, code_ranges, skip_check=True)

    # Recursively split parts that are still oversized
    final: list[SubChunk] = []
    for part in result:
        if _text_length_without_figures(part.text) > policy.hard_max_chars:
            sub_parts = _split_if_needed(part.text, policy, title_path="")
            for sp in sub_parts:
                final.append(SubChunk(
                    text=sp.text,
                    local_start=part.local_start + sp.local_start,
                    local_end=part.local_start + sp.local_end,
                ))
        else:
            final.append(part)
    return final if len(final) > 1 else None


def _ensure_code_blocks_closed(
    parts: list[SubChunk],
    code_ranges: list[tuple[int, int]] | None = None,
    skip_check: bool = False,
) -> list[SubChunk]:
    """Ensure each part has properly closed code blocks.

    Uses find_code_block_ranges for accurate fence detection.
    If a part has an unclosed code block, merge it with the next part.

    When skip_check=True, returns parts as-is (used when split points
    are already validated to be outside code blocks).
    """
    if len(parts) <= 1 or skip_check:
        return parts

    result: list[SubChunk] = []
    current_text = ""
    current_start = parts[0].local_start

    for part in parts:
        current_text += part.text if not current_text else "\n\n" + part.text

        # Check if code blocks are balanced in accumulated text
        part_ranges = find_code_block_ranges(current_text)
        # If the last code block extends to the end of text, it's unclosed
        is_balanced = True
        if part_ranges:
            last_start, last_end = part_ranges[-1]
            # If the last block ends beyond text length, it's unclosed
            # Note: last_end == len(current_text) means the code block is properly closed
            if last_end > len(current_text):
                is_balanced = False

        if is_balanced:
            result.append(SubChunk(
                text=current_text.strip(),
                local_start=current_start,
                local_end=part.local_end,
            ))
            current_text = ""
            current_start = part.local_end

    if current_text.strip():
        # Last part has unclosed block — merge with previous
        if result:
            prev = result[-1]
            result[-1] = SubChunk(
                text=prev.text + "\n\n" + current_text.strip(),
                local_start=prev.local_start,
                local_end=prev.local_end + len(current_text),
            )
        else:
            result.append(SubChunk(
                text=current_text.strip(),
                local_start=current_start,
                local_end=current_start + len(current_text),
            ))

    return result


def _split_by_paragraph_safe(
    text: str,
    policy: ChunkPolicy,
    code_ranges: list[tuple[int, int]] | None = None,
) -> list[SubChunk] | None:
    """Split by paragraph boundaries, code-block-aware, with correct offsets.

    Directly operates on original text (no placeholder substitution).
    Never splits inside a fenced code block.
    """
    if code_ranges is None:
        code_ranges = find_code_block_ranges(text)

    # Find paragraph boundaries (\n\n) outside code blocks
    para_boundaries = [0]
    for m in re.finditer(r"\n\n+", text):
        pos = m.start()
        if not is_in_code_block(pos, code_ranges):
            para_boundaries.append(m.end())  # split after the newlines
    para_boundaries.append(len(text))

    # Deduplicate and sort
    para_boundaries = sorted(set(para_boundaries))

    if len(para_boundaries) <= 2:
        return None

    # Build parts from paragraph boundaries, merging small ones
    # Use target_max_chars as the threshold for splitting (not hard_max_chars)
    # This ensures we split earlier when content is close to the limit
    split_threshold = policy.target_max_chars
    parts: list[SubChunk] = []
    current_text = ""
    current_start = 0

    for i in range(len(para_boundaries) - 1):
        seg_start = para_boundaries[i]
        seg_end = para_boundaries[i + 1]
        seg_text = text[seg_start:seg_end]

        if _text_length_without_figures(current_text + seg_text) > split_threshold and current_text.strip():
            parts.append(SubChunk(
                text=current_text.strip(),
                local_start=current_start,
                local_end=seg_start,
            ))
            current_start = seg_start
            current_text = ""

        current_text += seg_text

    if current_text.strip():
        parts.append(SubChunk(
            text=current_text.strip(),
            local_start=current_start,
            local_end=len(text),
        ))

    if len(parts) < 2:
        return None

    return _ensure_code_blocks_closed(parts, code_ranges)


def _merge_small_parts(parts: list[SubChunk], policy: ChunkPolicy) -> list[SubChunk]:
    """Merge parts that are too small, but respect structural boundaries.

    Never merges across （N）, ####, 方式/步骤/组件 boundaries
    if the current accumulator already meets target_min_chars.
    """
    result: list[SubChunk] = []
    current_text = ""
    current_start = parts[0].local_start if parts else 0
    current_end = current_start

    for part in parts:
        part_stripped = part.text.strip()
        # Check if this part starts a new structural unit
        is_structural_boundary = bool(
            re.match(r"^（\d+）", part_stripped)
            or re.match(r"^#{1,4}\s+", part_stripped)
            or re.match(r"^方式\s*\d+|^步骤\s*\d+|^组件\s*\d+", part_stripped)
        )

        # Don't merge across structural boundaries if current already has content
        # A structural boundary always starts a new chunk if current has any （N） or heading
        has_structural_content = bool(
            re.search(r"（\d+）", current_text)
            or re.search(r"^#{1,4}\s+", current_text, re.MULTILINE)
        )
        if is_structural_boundary and current_text.strip() and has_structural_content:
            result.append(SubChunk(
                text=current_text.strip(),
                local_start=current_start,
                local_end=current_end,
            ))
            current_start = part.local_start
            current_text = ""

        if _text_length_without_figures(current_text + part.text) > policy.hard_max_chars and current_text.strip():
            result.append(SubChunk(
                text=current_text.strip(),
                local_start=current_start,
                local_end=current_end,
            ))
            current_start = part.local_start
            current_text = ""
        # Add separator between parts to preserve structure
        if current_text and not current_text.endswith('\n\n'):
            current_text += '\n\n'
        current_text += part.text
        current_end = part.local_end

    if current_text.strip():
        result.append(SubChunk(
            text=current_text.strip(),
            local_start=current_start,
            local_end=current_end,
        ))

    return result


def _split_at_safe_points(
    text: str,
    max_chars: int,
    code_ranges: list[tuple[int, int]] | None = None,
) -> list[SubChunk]:
    """Split text at safe semantic boundaries, never inside code blocks.

    When max_chars is exceeded, seeks the nearest safe split point.

    Safe split point priority (outside code blocks):
    1. Heading boundary (next # line)
    2. Paragraph boundary (double newline)
    3. List item boundary (line starting with - or * or 1.)
    4. Code block end (after closing ```)
    5. Single newline (last resort)
    """
    if code_ranges is None:
        code_ranges = find_code_block_ranges(text)

    lines = text.split("\n")
    parts: list[SubChunk] = []
    current_lines: list[str] = []
    current_start = 0
    current_len = 0

    for line in lines:
        line_with_newline = line + "\n"
        line_len = len(line_with_newline)

        current_lines.append(line)
        current_len += line_len

        # Only consider splitting if we've exceeded max_chars AND we're outside code blocks
        if current_len >= max_chars:
            # Calculate position of current line end in the original text
            current_pos = current_start + current_len
            # Use is_in_code_block for proper nested fence tracking
            if not is_in_code_block(current_pos - 1, code_ranges):
                # Try to find a safe split point by looking backward from current position
                safe_idx = _find_safe_split_backward(current_lines)

                if safe_idx is not None and safe_idx > 0:
                    # Split here
                    above = "\n".join(current_lines[:safe_idx])
                    below = "\n".join(current_lines[safe_idx:])

                    if above.strip():
                        parts.append(SubChunk(
                            text=above.strip(),
                            local_start=current_start,
                            local_end=current_start + len(above) + 1,
                        ))

                    current_start = current_start + len(above) + 1
                    current_lines = current_lines[safe_idx:]
                    current_len = sum(len(l) + 1 for l in current_lines)

    # Remaining lines
    if current_lines:
        remaining = "\n".join(current_lines)
        if remaining.strip():
            parts.append(SubChunk(
                text=remaining.strip(),
                local_start=current_start,
                local_end=current_start + len(remaining),
            ))

    # Final safety: ensure code blocks are closed
    return _ensure_code_blocks_closed(parts, code_ranges)


def _find_safe_split_backward(lines: list[str]) -> int | None:
    """Find the best safe split point by looking backward from the end.

    Returns the line index to split at (the split goes BEFORE this line).
    Priority: heading > paragraph > list item > code block end > newline
    """
    # Search backward from the end (but not the very last line)
    for i in range(len(lines) - 1, 0, -1):
        stripped = lines[i].strip()
        prev_stripped = lines[i - 1].strip() if i > 0 else ""

        # Priority 1: Heading
        if re.match(r"^#{1,6}\s+", stripped):
            return i

        # Priority 2: Paragraph boundary (empty line before content)
        if not prev_stripped and stripped:
            return i

        # Priority 3: List item boundary
        if re.match(r"^[-*+]\s+", stripped) or re.match(r"^\d+\.\s+", stripped):
            return i

        # Priority 4: After code block end
        if prev_stripped.startswith("```") or prev_stripped.startswith("~~~"):
            return i

    # No safe split found - return None (will keep accumulating)
    return None


# ── Post-merge heading-only chunks ───────────────────────────────────────────


def _post_merge_heading_chunks(chunks: list[KnowledgeChunk]) -> list[KnowledgeChunk]:
    """Merge heading-only chunks (char_count < threshold) into their successor.

    A chunk is considered "heading-only" if:
    - char_count < _HEADING_ONLY_MAX_CHARS
    - does not contain code blocks
    - does not contain tables
    - does not contain figures

    The heading-only chunk's content is prepended to the next chunk's content.
    If it's the last chunk, it's kept as-is.
    """
    if not chunks:
        return chunks

    result: list[KnowledgeChunk] = []
    pending_heading: KnowledgeChunk | None = None

    for chunk in chunks:
        is_heading_only = (
            chunk.char_count < _HEADING_ONLY_MAX_CHARS
            and not chunk.contains_code
            and not chunk.contains_table
            and not chunk.contains_figure
        )

        if is_heading_only:
            # If there's already a pending heading, flush it (keep as-is)
            if pending_heading is not None:
                result.append(pending_heading)
            pending_heading = chunk
            continue

        # This is a real content chunk
        if pending_heading is not None:
            # Merge pending heading into this chunk
            merged_content = pending_heading.content + "\n\n" + chunk.content
            # Keep the deeper section_path, but ensure heading is included
            merged_section_path = list(pending_heading.section_path)
            if chunk.heading and (not merged_section_path or merged_section_path[-1] != chunk.heading):
                merged_section_path.append(chunk.heading)

            # Merge figure_ids
            merged_figure_ids = list(dict.fromkeys(pending_heading.figure_ids + chunk.figure_ids))

            chunk.content = merged_content
            chunk.section_path = merged_section_path
            chunk.figure_ids = merged_figure_ids
            chunk.char_count = len(merged_content)
            chunk.approx_token_count = len(merged_content) // 2
            chunk.contains_code = chunk.contains_code or pending_heading.contains_code
            chunk.contains_table = chunk.contains_table or pending_heading.contains_table
            chunk.contains_figure = chunk.contains_figure or pending_heading.contains_figure

            # Keep the earlier offset
            chunk.normalized_start_offset = min(chunk.normalized_start_offset, pending_heading.normalized_start_offset)
            chunk.source_start_offset = min(chunk.source_start_offset, pending_heading.source_start_offset)

            # Store merged heading info in metadata
            if "merged_headings" not in chunk.metadata:
                chunk.metadata["merged_headings"] = []
            chunk.metadata["merged_headings"].append({
                "heading": pending_heading.heading,
                "section_path": pending_heading.section_path,
            })

            pending_heading = None

        result.append(chunk)

    # If trailing heading-only chunk, keep it
    if pending_heading is not None:
        result.append(pending_heading)

    return result


# ── Figure binding (merged from figure_chunk_binder) ──────────────────────────

_IMG_TAG_FIGURE_RE = re.compile(r'<img\s+[^>]*data-figure-id="(\d+)"[^>]*/?>', re.IGNORECASE)


def _bind_figures(
    chunks: list[KnowledgeChunk],
    figure_records: list[dict],
    enhanced_text: str,
    policy: ChunkPolicy,
) -> list[KnowledgeChunk]:
    """统一切片评审：图归属 + 语义再切分（同一切片一次 LLM 调用）.

    - 含图切片：LLM 同时输出图归属与（若超长）语义切分建议
    - 无图但超长切片：LLM 仅输出语义切分建议
    - 图归属决策缓存到 knowledge_figures（bound_chunk_ids + bound_context_hash），
      上下文不变时复用，不重复调用 LLM
    - 语义切分失败/未提供：保持规则切分结果，不阻断

    Called from compile_chunks（figure_records 为空时仍执行语义切分）。
    Modifies chunk content in-place；可能增加切片数量（语义再切）。
    """
    from ..figure_chunk_binder import (
        build_figure_contexts,
        review_and_bind,
        save_figure_binding,
    )
    from ..utils.hash import content_hash
    import json as _json

    # Build chunk dicts for the binder (it expects dicts with 'content' key)
    chunk_dicts = [
        {"chunk_id": c.chunk_id, "title_path": " > ".join(c.section_path), "content": c.content}
        for c in chunks
    ]

    # 切分前图上下文（用于缓存键，与 review_and_bind 内部一致）
    pre_contexts = build_figure_contexts(figure_records, chunk_dicts, enhanced_text)
    ctx_hash_by_fig: dict[int, str] = {}
    for ctx in pre_contexts:
        parts = []
        for idx in (ctx.prev_chunk_idx, ctx.current_chunk_idx, ctx.next_chunk_idx):
            if idx is not None and 0 <= idx < len(chunk_dicts):
                parts.append(chunk_dicts[idx]["content"])
        ctx_hash_by_fig[ctx.figure_db_id] = content_hash("\n||\n".join(parts))

    # 统一切片评审（图归属 + 语义再切）
    reviewed = review_and_bind(chunk_dicts, figure_records, enhanced_text, policy)

    # 保存图归属缓存（从最终内容反推每图位置，可复现性）
    for ctx in pre_contexts:
        if not ctx.img_tag:
            continue
        fid = ctx.figure_db_id
        positions = [
            i for i, cd in enumerate(reviewed)
            if f'data-figure-id="{fid}"' in cd.get("content", "")
        ]
        if positions:
            try:
                save_figure_binding(fid, positions, ctx_hash_by_fig[fid])
            except Exception as e:
                logger.warning(f"Failed to persist figure binding: {e}")

    # Sync modified/added chunk dicts back to KnowledgeChunk objects
    # （语义再切的新片 chunk_id 带 #n 后缀；原片按 chunk_id 一一对应）
    template = None
    used_objs: set[int] = set()
    final: list[KnowledgeChunk] = []
    for cdict in reviewed:
        cid = cdict.get("chunk_id", "")
        base_id = str(cid).split("#")[0]
        chunk = None
        if "#" not in str(cid):
            chunk = next(
                (c for c in chunks if c.chunk_id == base_id and id(c) not in used_objs), None
            )
            if chunk is not None:
                used_objs.add(id(chunk))
        if chunk is None:
            if template is None:
                template = {
                    k: v for k, v in chunks[0].model_dump().items() if k != "id"
                }
            chunk = KnowledgeChunk(**template)
            chunk.chunk_id = base_id
            chunk.content_hash = content_hash(cdict["content"])
            chunk.ai_assisted = True  # 语义再切产物
        chunk.content = cdict["content"]
        chunk.char_count = _text_length_without_figures(cdict["content"])
        chunk.approx_token_count = chunk.char_count // 2
        chunk.contains_figure = bool(_IMG_TAG_FIGURE_RE.search(cdict["content"]))
        chunk.figure_ids = sorted(set(_IMG_TAG_FIGURE_RE.findall(cdict["content"])))
        final.append(chunk)

    return final


# ── Classification ───────────────────────────────────────────────────────────


def _extract_virtual_heading(text: str) -> str | None:
    """Extract virtual heading from chunk content.

    Priority:
    1. First （N）Chinese numbered item label
    2. First **bold** line (full-line bold)
    3. First #### heading
    """
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        # （N）Chinese numbering — extract the label after （N）
        m = re.match(r"^（\d+）(.+)", stripped)
        if m:
            return m.group(1).strip()
        # Full-line bold
        m = re.match(r"^\*\*(.+?)\*\*$", stripped)
        if m:
            return m.group(1).strip()
        # #### heading
        m = re.match(r"^####\s+(.+)", stripped)
        if m:
            return m.group(1).strip()
    return None


def _classify_chunk_type(text: str) -> ChunkType:
    """Classify chunk type based on content heuristics."""
    has_code = bool(re.search(r"```", text))
    has_operation = bool(re.search(r"操作\d+|步骤\d+", text))
    has_architecture = bool(re.search(r"架构|设计|组件|模块|层次", text))
    has_figure = bool(re.search(r'data-figure-id="', text))

    if has_code and has_operation:
        return ChunkType.OPERATION_INSTRUCTION
    if has_code:
        return ChunkType.CODE_EXAMPLE
    if has_architecture:
        return ChunkType.ARCHITECTURE_DESCRIPTION
    if has_figure:
        return ChunkType.FIGURE_EXPLANATION
    if has_operation:
        return ChunkType.OPERATION_INSTRUCTION
    return ChunkType.CONCEPT_EXPLANATION


# ── Save ─────────────────────────────────────────────────────────────────────


def save_chunks(
    ragflow_content: str,
    chunks: list[KnowledgeChunk],
    doc: DocumentSource,
    output_dir: Path,
) -> tuple[Path, Path]:
    """Save chunked_for_ragflow.md and chunk_manifest.json."""
    chunks_dir = (
        output_dir
        / doc.domain_id
        / doc.domain_version_id
        / doc.document_id
        / "chunks"
    )
    chunks_dir.mkdir(parents=True, exist_ok=True)

    # Save ragflow document
    ragflow_path = chunks_dir / "chunked_for_ragflow.md"
    ragflow_path.write_text(ragflow_content, encoding="utf-8")

    # Save manifest
    manifest_path = chunks_dir / "chunk_manifest.json"
    data = [c.model_dump(mode="json") for c in chunks]
    manifest_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    return ragflow_path, manifest_path
