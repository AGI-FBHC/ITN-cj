"""Step 2: Raw Archive — copy original files to output directory."""

from __future__ import annotations

import shutil
from pathlib import Path

from ..config import DomainConfig
from ..models import DocumentSource


def archive_raw(
    doc: DocumentSource,
    config: DomainConfig,
    source_path: Path,
    output_dir: Path,
) -> Path:
    """Copy raw file to the output directory. Returns the raw file path."""
    raw_dir = (
        output_dir
        / config.domain_id
        / config.domain_version_id
        / doc.document_id
        / "raw"
    )
    raw_dir.mkdir(parents=True, exist_ok=True)
    dest = raw_dir / doc.source_file_name
    shutil.copy2(source_path, dest)
    return dest
