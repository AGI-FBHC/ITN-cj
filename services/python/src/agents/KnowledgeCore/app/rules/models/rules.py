from __future__ import annotations
from typing import Optional
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class RuleLayer(str, Enum):
    HARD = "hard"
    EVIDENCE_POLICY = "evidence_policy"
    OPERATIONAL = "operational"
    PEDAGOGICAL = "pedagogical"
    SOFT = "soft"


class Rule(BaseModel):
    rule_id: str
    rule_layer: RuleLayer
    priority: int = Field(ge=0, le=1000)
    scope: dict
    when: dict
    then: list[dict]


class FactNamespace(str, Enum):
    TASK = "task"
    LEARNER = "learner"
    GRAPH = "graph"
    EVIDENCE = "evidence"
    DOCUMENT = "document"
    DOMAIN = "domain"
    ASSET = "asset"
    PROCESS = "process"
    PARAMETER = "parameter"
    SAFETY = "safety"
    STANDARD = "standard"


class FactSnapshot(BaseModel):
    id: Optional[int] = None
    snapshot_id: str
    domain_id: str
    domain_runtime_snapshot_id: str
    task_type: Optional[str] = None
    task_risk_level: Optional[str] = None
    facts_json: dict
    claim_schema_version: Optional[str] = None
    created_at: Optional[datetime] = None


class PredicateDefinition(BaseModel):
    name: str
    description: str
    args: list[str]
    returns: str
    version: str = "1.0"


class RuleExecutionResult(BaseModel):
    rule_id: str
    hit_status: str
    input_facts: Optional[dict] = None
    predicate_results: Optional[list[dict]] = None
    actions: Optional[list[dict]] = None
    explanation: Optional[str] = None
