"""Step 1: Document Intake — discover and register documents."""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field
from pathlib import Path

from ..config import DomainConfig, resolve_discovery_root
from ..models import DocumentSource
from ..utils.hash import file_hash


@dataclass
class IntakeResult:
    documents: list[DocumentSource] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def discover_documents(config: DomainConfig, config_dir: Path | None = None) -> IntakeResult:
    """Discover documents matching the domain's discovery rules."""
    root = resolve_discovery_root(config, config_dir)
    if not root.exists():
        return IntakeResult(errors=[f"Discovery root does not exist: {root}"])

    result = IntakeResult()
    doc_counter = 0

    for pattern in config.discovery.include:
        for path in sorted(root.glob(pattern)):
            if not path.is_file():
                continue
            # Check exclusions
            rel = str(path.relative_to(root))
            if any(fnmatch.fnmatch(rel, exc) for exc in config.discovery.exclude):
                continue

            doc_counter += 1
            document_id = f"doc_{doc_counter:06d}"
            fhash = file_hash(str(path))
            fsize = path.stat().st_size

            doc = DocumentSource(
                document_id=document_id,
                domain_id=config.domain_id,
                domain_version_id=config.domain_version_id,
                source_file_name=path.name,
                source_uri=str(path),
                mime_type="text/markdown",
                file_hash=fhash,
                file_size=fsize,
                pipeline_profile=config.pipeline_profile,
                authority_level=config.metadata_defaults.get("authority_level"),
                applicability_scope=config.metadata_defaults.get("applicability_scope", {}),
            )
            result.documents.append(doc)

    if not result.documents:
        result.errors.append(f"No documents found in {root}")

    return result
