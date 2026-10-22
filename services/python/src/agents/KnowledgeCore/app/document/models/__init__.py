"""Document models."""

from app.document.models.document import (
    Document,
    DocumentVersion,
    DocumentSkillMapping,
    DocumentStatus,
    AuthorityLevel,
    DocType,
    SafetyCriticality,
    ScopeType,
)
from app.document.models.orm import (
    DocumentORM,
    DocumentChunkORM,
)

__all__ = [
    # Pydantic models
    "Document",
    "DocumentVersion",
    "DocumentSkillMapping",
    "DocumentStatus",
    "AuthorityLevel",
    "DocType",
    "SafetyCriticality",
    "ScopeType",
    # ORM models
    "DocumentORM",
    "DocumentChunkORM",
]
