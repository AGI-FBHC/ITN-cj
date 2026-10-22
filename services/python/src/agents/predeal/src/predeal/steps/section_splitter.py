"""Step 7: Deterministic Section Splitting — split oversized sections."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..config import ChunkPolicy
from ..utils.markdown import find_code_block_ranges, is_in_code_block


@dataclass
class SubUnit:
    unit_id: str
    start_offset: int
    end_offset: int
    reason: str


@dataclass
class SplitResult:
    section_id: str
    sub_units: list[SubUnit] = field(default_factory=list)


def split_section(
    text: str,
    section_id: str,
    policy: ChunkPolicy,
    base_offset: int = 0,
) -> SplitResult:
    """Split an oversized section into sub-units using deterministic rules."""
    result = SplitResult(section_id=section_id)

    if len(text) <= policy.hard_max_chars:
        result.sub_units.append(SubUnit(
            unit_id=f"unit_{section_id}_0",
            start_offset=base_offset,
            end_offset=base_offset + len(text),
            reason="within_limit",
        ))
        return result

    code_ranges = find_code_block_ranges(text)

    # Try splitting strategies in priority order (all code-block-aware)
    splits = (
        _split_by_level4_headings(text, code_ranges)
        or _split_by_chinese_numbering(text, code_ranges)
        or _split_by_operation_heading(text, code_ranges)
        or _split_by_step_heading(text, code_ranges)
        or _split_by_figure_boundary(text, code_ranges)
        or _split_by_paragraph_boundary(text, policy.hard_max_chars, code_ranges)
    )

    if splits:
        for idx, (start, end, reason) in enumerate(splits):
            result.sub_units.append(SubUnit(
                unit_id=f"unit_{section_id}_{idx}",
                start_offset=base_offset + start,
                end_offset=base_offset + end,
                reason=reason,
            ))
    else:
        # Fallback: force split at safe points (never inside code blocks)
        safe_splits = _force_split_at_safe_points(text, policy.hard_max_chars, code_ranges)
        for idx, (start, end, reason) in enumerate(safe_splits):
            result.sub_units.append(SubUnit(
                unit_id=f"unit_{section_id}_{idx}",
                start_offset=base_offset + start,
                end_offset=base_offset + end,
                reason=reason,
            ))

    return result


def _split_by_level4_headings(
    text: str,
    code_ranges: list[tuple[int, int]],
) -> list[tuple[int, int, str]] | None:
    """Split by #### headings (outside code blocks)."""
    pattern = re.compile(r"^####\s+", re.MULTILINE)
    positions = [m.start() for m in pattern.finditer(text)
                 if not is_in_code_block(m.start(), code_ranges)]
    if len(positions) < 2:
        return None
    return _make_splits(text, positions, "level4_heading")


def _split_by_chinese_numbering(
    text: str,
    code_ranges: list[tuple[int, int]],
) -> list[tuple[int, int, str]] | None:
    """Split by （1）（2）（3） numbering (outside code blocks)."""
    pattern = re.compile(r"^（\d+）", re.MULTILINE)
    positions = [m.start() for m in pattern.finditer(text)
                 if not is_in_code_block(m.start(), code_ranges)]
    if len(positions) < 2:
        return None
    return _make_splits(text, positions, "chinese_numbering")


def _split_by_operation_heading(
    text: str,
    code_ranges: list[tuple[int, int]],
) -> list[tuple[int, int, str]] | None:
    """Split by 操作1/操作2 headings (outside code blocks)."""
    pattern = re.compile(r"^操作\d+", re.MULTILINE)
    positions = [m.start() for m in pattern.finditer(text)
                 if not is_in_code_block(m.start(), code_ranges)]
    if len(positions) < 2:
        return None
    return _make_splits(text, positions, "operation_heading")


def _split_by_step_heading(
    text: str,
    code_ranges: list[tuple[int, int]],
) -> list[tuple[int, int, str]] | None:
    """Split by 步骤1/步骤2 headings (outside code blocks)."""
    pattern = re.compile(r"^步骤\d+", re.MULTILINE)
    positions = [m.start() for m in pattern.finditer(text)
                 if not is_in_code_block(m.start(), code_ranges)]
    if len(positions) < 2:
        return None
    return _make_splits(text, positions, "step_heading")


def _split_by_figure_boundary(
    text: str,
    code_ranges: list[tuple[int, int]],
) -> list[tuple[int, int, str]] | None:
    """Split by <img data-figure-id=...> boundaries (outside code blocks)."""
    pattern = re.compile(r"<img\s+[^>]*data-figure-id=", re.MULTILINE)
    positions = [m.start() for m in pattern.finditer(text)
                 if not is_in_code_block(m.start(), code_ranges)]
    if len(positions) < 2:
        return None
    return _make_splits(text, positions, "figure_boundary")


def _split_by_paragraph_boundary(
    text: str,
    max_chars: int,
    code_ranges: list[tuple[int, int]],
) -> list[tuple[int, int, str]] | None:
    """Split by paragraph boundaries (double newline) respecting code blocks."""
    # Find paragraph boundaries outside code blocks
    boundaries = [0]
    for m in re.finditer(r"\n\n+", text):
        if not is_in_code_block(m.start(), code_ranges):
            boundaries.append(m.end())
    boundaries.append(len(text))

    # Build splits respecting max_chars
    splits: list[tuple[int, int, str]] = []
    current_start = 0
    current_len = 0

    for i in range(1, len(boundaries)):
        seg_len = boundaries[i] - boundaries[i - 1]
        if current_len + seg_len > max_chars and current_len > 0:
            splits.append((current_start, boundaries[i - 1], "paragraph_boundary"))
            current_start = boundaries[i - 1]
            current_len = 0
        current_len += seg_len

    if current_len > 0:
        splits.append((current_start, len(text), "paragraph_boundary"))

    if len(splits) < 2:
        return None
    return splits


def _force_split_at_safe_points(
    text: str,
    max_chars: int,
    code_ranges: list[tuple[int, int]],
) -> list[tuple[int, int, str]]:
    """Force split at safe semantic boundaries, never inside code blocks.

    Priority: heading > paragraph > list item > code block end > newline
    """
    lines = text.split("\n")
    splits: list[tuple[int, int, str]] = []
    current_start = 0
    current_len = 0
    in_fence = False

    for i, line in enumerate(lines):
        line_len = len(line) + 1  # +1 for newline
        stripped = line.strip()

        # Track fence state
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence

        current_len += line_len

        if current_len >= max_chars and not in_fence:
            # Look backward for safe split point
            safe_idx = _find_safe_split_backward(lines, i)

            if safe_idx is not None and safe_idx > 0:
                # Calculate offset of the split point
                split_offset = sum(len(lines[j]) + 1 for j in range(safe_idx))
                splits.append((current_start, split_offset, "safe_point"))
                current_start = split_offset
                current_len = sum(len(lines[j]) + 1 for j in range(safe_idx, i + 1))

    # Remaining
    if current_start < len(text):
        splits.append((current_start, len(text), "safe_point"))

    return splits


def _find_safe_split_backward(lines: list[str], current_idx: int) -> int | None:
    """Find the best safe split point by looking backward."""
    for i in range(current_idx, 0, -1):
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

    return None


def _make_splits(text: str, positions: list[int], reason: str) -> list[tuple[int, int, str]]:
    """Create split ranges from cut positions."""
    splits = []
    for idx, pos in enumerate(positions):
        end = positions[idx + 1] if idx + 1 < len(positions) else len(text)
        splits.append((pos, end, reason))
    return splits
