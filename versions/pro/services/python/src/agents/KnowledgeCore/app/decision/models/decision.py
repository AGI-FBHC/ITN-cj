from __future__ import annotations
from typing import Optional
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class DecisionStatus(str, Enum):
    PERMIT = "PERMIT"
    PERMIT_WITH_CONSTRAINTS = "PERMIT_WITH_CONSTRAINTS"
    RESTRICT_SCOPE = "RESTRICT_SCOPE"
    RETRIEVE_AGAIN = "RETRIEVE_AGAIN"
    BLOCK = "BLOCK"
    REQUEST_HUMAN_REVIEW = "REQUEST_HUMAN_REVIEW"


class EligibilityResult(BaseModel):
    hard_rule_passed: bool = False
    required_evidence_role_passed: bool = False
    critical_claim_coverage_passed: bool = False
    evidence_applicability_passed: bool = False
    prerequisite_passed: bool = False
    no_unresolved_critical_conflict: bool = False

    @property
    def is_eligible(self) -> bool:
        return all([
            self.hard_rule_passed,
            self.required_evidence_role_passed,
            self.critical_claim_coverage_passed,
            self.evidence_applicability_passed,
            self.prerequisite_passed,
            self.no_unresolved_critical_conflict,
        ])


class HighFidelityScore(BaseModel):
    eligibility: float = Field(ge=0.0, le=1.0)
    coverage: float = Field(ge=0.0, le=1.0)
    authority: float = Field(ge=0.0, le=1.0)
    applicability: float = Field(ge=0.0, le=1.0)
    freshness: float = Field(ge=0.0, le=1.0)
    graph_consistency: float = Field(ge=0.0, le=1.0)
    source_independence: float = Field(ge=0.0, le=1.0)
    conflict_risk: float = Field(ge=0.0, le=1.0)

    def calculate(
        self,
        alpha: float = 0.25,
        beta: float = 0.15,
        gamma: float = 0.20,
        delta: float = 0.10,
        epsilon: float = 0.15,
        zeta: float = 0.10,
        lam: float = 0.05,
    ) -> float:
        return self.eligibility * (
            alpha * self.coverage
            + beta * self.authority
            + gamma * self.applicability
            + delta * self.freshness
            + epsilon * self.graph_consistency
            + zeta * self.source_independence
            - lam * self.conflict_risk
        )


class KnowledgeDecisionContract(BaseModel):
    id: Optional[int] = None
    decision_id: str
    domain_id: str
    domain_runtime_snapshot_id: str
    fact_snapshot_id: Optional[str] = None
    evidence_pack_id: Optional[str] = None
    decision_status: DecisionStatus
    high_fidelity_score: Optional[float] = None
    matched_rules: Optional[list[str]] = None
    prerequisite_satisfied: Optional[bool] = None
    allowed_scope: Optional[str] = None
    required_citations: bool = True
    prohibited_content: Optional[list[str]] = None
    remediation_items: Optional[list[dict]] = None
    created_at: Optional[datetime] = None
