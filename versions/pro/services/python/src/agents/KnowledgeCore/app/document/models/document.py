from __future__ import annotations
from typing import Optional
from datetime import datetime
from enum import Enum

from pydantic import BaseModel


class DocType(str, Enum):
    TEXTBOOK = "textbook"
    SOP = "sop"
    STANDARD = "standard"
    CASE = "case"
    QUIZ = "quiz"
    GUIDE = "guide"
    INTERNAL = "internal"
    OTHER = "other"


class AuthorityLevel(str, Enum):
    A = "A"
    B = "B"
    C = "C"
    D = "D"


class SafetyCriticality(str, Enum):
    NONE = "none"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class ScopeType(str, Enum):
    PUBLIC = "public"
    ENTERPRISE = "enterprise"
    DEVICE = "device"
    PROJECT = "project"
    EXAMPLE = "example"


class DocumentStatus(str, Enum):
    DRAFT = "draft"
    PENDING_REVIEW = "pending_review"
    APPROVED = "approved"
    ACTIVE = "active"
    DEPRECATED = "deprecated"
    ARCHIVED = "archived"
    DISABLED = "disabled"


class Document(BaseModel):
    id: Optional[int] = None
    doc_id: str
    domain_id: str
    domain_version_id: Optional[str] = None
    title: str
    doc_type: DocType = DocType.OTHER
    source_uri: Optional[str] = None
    storage_uri: Optional[str] = None
    checksum: Optional[str] = None
    authority_level: AuthorityLevel = AuthorityLevel.C
    applicability_json: Optional[dict] = None
    standard_version: Optional[str] = None
    safety_criticality: SafetyCriticality = SafetyCriticality.NONE
    scope_type: ScopeType = ScopeType.PUBLIC
    status: DocumentStatus = DocumentStatus.DRAFT
    review_evidence: Optional[dict] = None
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class DocumentVersion(BaseModel):
    id: Optional[int] = None
    version_id: str
    doc_id: str
    version: str
    domain_id: str
    domain_version_id: Optional[str] = None
    applicability_json: Optional[dict] = None
    standard_version: Optional[str] = None
    safety_criticality: SafetyCriticality = SafetyCriticality.NONE
    storage_uri: Optional[str] = None
    checksum: Optional[str] = None
    status: str = "draft"
    created_at: Optional[datetime] = None


class DocumentSkillMapping(BaseModel):
    id: Optional[int] = None
    doc_id: str
    domain_id: str
    skill_id: str
    mapping_version: Optional[str] = None
    scope_confidence: float = 1.0
    created_at: Optional[datetime] = None
