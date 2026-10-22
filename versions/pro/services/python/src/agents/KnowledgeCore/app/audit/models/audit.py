from __future__ import annotations
from typing import Optional
from datetime import datetime

from pydantic import BaseModel


class RuleExecutionLog(BaseModel):
    id: Optional[int] = None
    decision_id: str
    rule_id: str
    rule_bundle_version: Optional[str] = None
    snapshot_id: Optional[str] = None
    hit_status: str
    input_facts: Optional[dict] = None
    predicate_results: Optional[list[dict]] = None
    actions: Optional[list[dict]] = None
    explanation: Optional[str] = None
    created_at: Optional[datetime] = None


class EvidenceAuditLog(BaseModel):
    id: Optional[int] = None
    decision_id: str
    pack_id: Optional[str] = None
    retrieval_request: Optional[dict] = None
    retrieval_response_ref: Optional[str] = None
    document_refs: Optional[list[dict]] = None
    filtering_reasons: Optional[list[dict]] = None
    created_at: Optional[datetime] = None


class GraphValidationLog(BaseModel):
    id: Optional[int] = None
    decision_id: str
    graph_version: Optional[str] = None
    query_scope: Optional[dict] = None
    prerequisite_chain: Optional[list[dict]] = None
    missing_nodes: Optional[list[dict]] = None
    impact_analysis: Optional[dict] = None
    consistency_result: Optional[str] = None
    created_at: Optional[datetime] = None


class DecisionAuditLog(BaseModel):
    id: Optional[int] = None
    decision_id: str
    eligibility_result: Optional[dict] = None
    high_fidelity_score: Optional[float] = None
    decision_status: Optional[str] = None
    constraints: Optional[dict] = None
    human_review_flag: bool = False
    contract_json: Optional[dict] = None
    created_at: Optional[datetime] = None


class ReplayLog(BaseModel):
    id: Optional[int] = None
    decision_id: str
    historical_snapshot_id: str
    replay_input: dict
    replay_result: dict
    version_diff: Optional[dict] = None
    diff_explanation: Optional[str] = None
    created_at: Optional[datetime] = None
