from fastapi import APIRouter

from app.domain.api.domain_routes import router as domain_router
from app.document.api.document_routes import router as document_router
from app.evidence.api.evidence_routes import router as evidence_router
from app.graph.api.graph_routes import router as graph_router
from app.rules.api.rules_routes import router as rules_router
from app.decision.api.decision_routes import router as decision_router
from app.audit.api.audit_routes import router as audit_router
from app.knowledge.api.knowledge_routes import router as knowledge_router

api_router = APIRouter(prefix="/api/v1")

api_router.include_router(domain_router)
api_router.include_router(document_router)
api_router.include_router(evidence_router)
api_router.include_router(graph_router)
api_router.include_router(rules_router)
api_router.include_router(decision_router)
api_router.include_router(audit_router)
api_router.include_router(knowledge_router)
