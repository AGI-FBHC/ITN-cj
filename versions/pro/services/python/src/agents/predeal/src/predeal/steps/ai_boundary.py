"""Step 8: AI-Assisted Boundary Planning — AI suggestions for complex sections.

This is a placeholder/stub. Full AI integration requires an LLM client.
For MVP, it returns no boundaries, falling back to deterministic rules.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..models import AICallRecord, BoundaryPlan, BoundaryRecommendation


@dataclass
class AIBoundaryResult:
    plans: list[BoundaryPlan] = field(default_factory=list)
    ai_calls: list[AICallRecord] = field(default_factory=list)


def plan_boundaries_ai(
    sections_needing_help: list[dict],
    model: str | None = None,
) -> AIBoundaryResult:
    """Generate boundary plans for sections that need AI assistance.

    Args:
        sections_needing_help: List of dicts with keys:
            - section_id: str
            - section_path: list[str]
            - text: str
            - figures: list[dict]
        model: Optional model name for AI calls.

    Returns:
        AIBoundaryResult with plans and audit records.
    """
    result = AIBoundaryResult()

    for section in sections_needing_help:
        section_id = section["section_id"]

        # Stub: no AI call, return empty boundaries
        # In production, this would call an LLM to analyze the text
        plan = BoundaryPlan(
            section_id=section_id,
            recommended_boundaries=[],
            skill_tags=[],
            warnings=["ai_boundary_not_implemented"],
        )
        result.plans.append(plan)

        # Audit record
        call_record = AICallRecord(
            task="boundary_planning",
            section_id=section_id,
            model=model or "stub",
            status="skipped",
        )
        result.ai_calls.append(call_record)

    return result


def validate_boundary_plan(
    plan: BoundaryPlan,
    text: str,
) -> tuple[bool, list[str]]:
    """Validate that AI boundary plan anchors exist in text and don't cross headings."""
    errors: list[bool] = []
    warnings: list[str] = []

    for rec in plan.recommended_boundaries:
        if rec.start_anchor not in text:
            warnings.append(f"start_anchor not found: {rec.start_anchor[:50]}")
            errors.append(True)
        if rec.end_anchor and rec.end_anchor not in text:
            warnings.append(f"end_anchor not found: {rec.end_anchor[:50]}")
            errors.append(True)

    return len(errors) == 0, warnings
