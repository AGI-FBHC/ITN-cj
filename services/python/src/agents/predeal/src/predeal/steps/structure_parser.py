"""Step 6: Structure Parsing — build a tree of document structure."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from ..models import DocumentSource, StructureNode
from ..utils.hash import content_hash
from ..utils.markdown import extract_code_blocks, extract_headings


@dataclass
class StructureTree:
    nodes: list[StructureNode] = field(default_factory=list)
    node_counter: int = 0

    def next_id(self) -> str:
        self.node_counter += 1
        return f"node_{self.node_counter:06d}"


def parse_structure(normalized_text: str, doc: DocumentSource) -> StructureTree:
    """Parse normalized.md into a structure tree."""
    tree = StructureTree()
    headings = extract_headings(normalized_text)
    code_blocks = extract_code_blocks(normalized_text)

    if not headings:
        # No headings — treat entire document as one node
        node = StructureNode(
            node_id=tree.next_id(),
            document_id=doc.document_id,
            node_type="document",
            source_start_offset=0,
            source_end_offset=len(normalized_text),
            normalized_start_offset=0,
            normalized_end_offset=len(normalized_text),
            text_hash=content_hash(normalized_text),
        )
        tree.nodes.append(node)
        return tree

    # Build heading nodes with parent tracking
    section_stack: list[tuple[int, str, StructureNode]] = []  # (level, node_id, node)

    for idx, h in enumerate(headings):
        node_id = tree.next_id()

        # Determine parent: find the last heading with a lower level
        parent_id = None
        while section_stack and section_stack[-1][0] >= h.level:
            section_stack.pop()
        if section_stack:
            parent_id = section_stack[-1][2].node_id

        # Compute section_path
        section_path = []
        for _, _, parent_node in section_stack:
            if parent_node.heading:
                section_path.append(parent_node.heading)
        section_path.append(h.text)

        # Determine content range (until next heading of same or higher level)
        end_offset = len(normalized_text)
        if idx + 1 < len(headings):
            end_offset = headings[idx + 1].offset

        # Don't extend end_offset past the next heading - this prevents
        # cross-section merging when code blocks span heading boundaries

        content_segment = normalized_text[h.offset:end_offset]

        # Check what this section contains
        contains_code = bool(re.search(r"^```", content_segment, re.MULTILINE))
        contains_table = bool(re.search(r"^\|.*\|", content_segment, re.MULTILINE))
        contains_figure = bool(re.search(r'data-figure-id="', content_segment))

        node = StructureNode(
            node_id=node_id,
            document_id=doc.document_id,
            parent_id=parent_id,
            node_type=_heading_type(h.level),
            heading=h.text,
            level=h.level,
            section_path=section_path,
            source_start_offset=h.offset,
            source_end_offset=end_offset,
            normalized_start_offset=h.offset,
            normalized_end_offset=end_offset,
            contains_code=contains_code,
            contains_table=contains_table,
            contains_figure=contains_figure,
            text_hash=content_hash(content_segment),
        )
        tree.nodes.append(node)
        section_stack.append((h.level, node_id, node))

    return tree


def _heading_type(level: int) -> str:
    """Map heading level to node type."""
    return {1: "chapter", 2: "section", 3: "subsection"}.get(level, "paragraph")


def save_structure_tree(tree: StructureTree, output_dir: Path, doc: DocumentSource) -> Path:
    """Save structure_tree.json."""
    struct_dir = (
        output_dir
        / doc.domain_id
        / doc.domain_version_id
        / doc.document_id
        / "structure"
    )
    struct_dir.mkdir(parents=True, exist_ok=True)
    path = struct_dir / "structure_tree.json"
    data = [n.model_dump(mode="json") for n in tree.nodes]
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
