from __future__ import annotations
from typing import Optional

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class DomainStatus(str, Enum):
    DRAFT = "draft"
    ACTIVE = "active"
    DEPRECATED = "deprecated"
    ARCHIVED = "archived"


class DomainVersionStatus(str, Enum):
    DRAFT = "draft"
    VALIDATING = "validating"
    SHADOW = "shadow"
    ACTIVE = "active"
    DEPRECATED = "deprecated"
    ROLLED_BACK = "rolled_back"


class ProfileType(str, Enum):
    ONTOLOGY = "ontology"
    TERMINOLOGY = "terminology"
    EVIDENCE_ROLE = "evidence_role"
    RISK_POLICY = "risk_policy"
    RETRIEVAL = "retrieval"
    GRAPH = "graph"
    CLAIM_SCHEMA = "claim_schema"
    EVALUATION = "evaluation"
    ACTIVATION = "activation"


class Domain(BaseModel):
    id: Optional[int] = None
    domain_id: str
    name: str
    description: Optional[str] = None
    owner: Optional[str] = None
    status: DomainStatus = DomainStatus.DRAFT
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class DomainVersion(BaseModel):
    id: Optional[int] = None
    domain_version_id: str
    domain_id: str
    version: str
    effective_from: Optional[datetime] = None
    effective_to: Optional[datetime] = None
    status: DomainVersionStatus = DomainVersionStatus.DRAFT
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None


class DomainRuntimeSnapshot(BaseModel):
    id: Optional[int] = None
    snapshot_id: str
    domain_id: str
    domain_version_id: str
    rule_bundle_version: Optional[str] = None
    graph_version: Optional[str] = None
    evidence_role_version: Optional[str] = None
    claim_schema_version: Optional[str] = None
    retrieval_profile_version: Optional[str] = None
    activated_at: Optional[datetime] = None
    created_by: Optional[str] = None


class DomainProfile(BaseModel):
    id: Optional[int] = None
    domain_id: str
    domain_version_id: str
    profile_type: ProfileType
    schema_json: dict
    version: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class DomainEntityType(BaseModel):
    id: Optional[int] = None
    domain_id: str
    domain_version_id: str
    name: str
    description: Optional[str] = None
    constraints_json: Optional[dict] = None
    created_at: Optional[datetime] = None


class DomainRelationType(BaseModel):
    id: Optional[int] = None
    domain_id: str
    domain_version_id: str
    name: str
    description: Optional[str] = None
    source_types: Optional[list[str]] = None
    target_types: Optional[list[str]] = None
    constraints_json: Optional[dict] = None
    created_at: Optional[datetime] = None


class RiskPolicy(str, Enum):
    OPTIONAL = "optional"
    RECOMMENDED = "recommended"
    REQUIRED = "required"


class DomainEvidenceRole(BaseModel):
    id: Optional[int] = None
    domain_id: str
    domain_version_id: str
    role_name: str
    required_fields: Optional[dict] = None
    risk_policy: RiskPolicy = RiskPolicy.OPTIONAL
    created_at: Optional[datetime] = None


class RuleBundleStatus(str, Enum):
    DRAFT = "draft"
    ACTIVE = "active"
    DEPRECATED = "deprecated"


class DomainRuleBundle(BaseModel):
    id: Optional[int] = None
    domain_id: str
    domain_version_id: str
    bundle_version: str
    rules_json: list[dict]
    predicate_dependencies: Optional[list[str]] = None
    test_suite_ref: Optional[str] = None
    status: RuleBundleStatus = RuleBundleStatus.DRAFT
    created_at: Optional[datetime] = None


class ClaimCriticality(str, Enum):
    CRITICAL = "critical"
    IMPORTANT = "important"
    OPTIONAL = "optional"


class DomainClaimSchema(BaseModel):
    id: Optional[int] = None
    domain_id: str
    domain_version_id: str
    task_type: str
    claim_id: str
    criticality: ClaimCriticality = ClaimCriticality.IMPORTANT
    required_roles: Optional[list[str]] = None
    description: Optional[str] = None
    created_at: Optional[datetime] = None
