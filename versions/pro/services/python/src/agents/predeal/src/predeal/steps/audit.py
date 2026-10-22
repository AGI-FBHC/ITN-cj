"""Step 12: Processing Audit — record the full processing trace."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from ..models import AICallRecord, DocumentSource, PipelineStatus, ProcessingAudit


def create_audit(
    doc: DocumentSource,
    job_id: str,
    ai_calls: list[AICallRecord] | None = None,
) -> ProcessingAudit:
    """Create a processing audit record."""
    return ProcessingAudit(
        ingestion_job_id=job_id,
        domain_id=doc.domain_id,
        domain_version_id=doc.domain_version_id,
        document_id=doc.document_id,
        source_file_hash=doc.file_hash,
        pipeline_profile=doc.pipeline_profile,
        ai_assistant_enabled=bool(ai_calls),
        ai_calls=ai_calls or [],
        status=PipelineStatus.RUNNING,
    )


def finalize_audit(audit: ProcessingAudit, status: str = "completed") -> None:
    """Mark audit as finished."""
    audit.finished_at = datetime.now()
    # Map preflight status to pipeline status
    status_map = {
        "passed": "completed",
        "passed_with_warnings": "completed",
        "completed": "completed",
        "failed": "failed",
    }
    audit.status = PipelineStatus(status_map.get(status, "completed"))


def save_audit(audit: ProcessingAudit, output_dir: Path) -> Path:
    """Save processing_audit.json."""
    audit_dir = (
        output_dir
        / audit.domain_id
        / audit.domain_version_id
        / audit.document_id
        / "audit"
    )
    audit_dir.mkdir(parents=True, exist_ok=True)
    path = audit_dir / "processing_audit.json"
    path.write_text(
        json.dumps(audit.model_dump(mode="json"), ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )
    return path
