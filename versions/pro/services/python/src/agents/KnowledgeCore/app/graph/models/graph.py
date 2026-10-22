from __future__ import annotations
from typing import Optional
from datetime import datetime
from enum import Enum

from pydantic import BaseModel


class NodeStatus(str, Enum):
    ACTIVE = "active"
    DEPRECATED = "deprecated"
    DISABLED = "disabled"


class EdgeStatus(str, Enum):
    ACTIVE = "active"
    DEPRECATED = "deprecated"
    DISABLED = "disabled"


class CoreOntologyType(str, Enum):
    SKILL = "Skill"
    KNOWLEDGE_POINT = "KnowledgePoint"
    TASK = "Task"
    ROLE = "Role"
    DOCUMENT = "Document"
    EVIDENCE = "Evidence"
    RULE = "Rule"
    STANDARD = "Standard"
    ASSESSMENT = "Assessment"
    RESOURCE_TEMPLATE = "ResourceTemplate"


class CoreRelationType(str, Enum):
    PREREQUISITE_OF = "PREREQUISITE_OF"
    SUPPORTED_BY = "SUPPORTED_BY"
    CONSTRAINED_BY = "CONSTRAINED_BY"
    ASSESSED_BY = "ASSESSED_BY"
    ALIGNED_TO_ROLE = "ALIGNED_TO_ROLE"
    RELATED_TO = "RELATED_TO"
    CONFLICTS_WITH = "CONFLICTS_WITH"


class KGNode(BaseModel):
    id: Optional[int] = None
    node_id: str
    domain_id: str
    ontology_profile_version: Optional[str] = None
    schema_type: str
    name: str
    properties_json: Optional[dict] = None
    status: NodeStatus = NodeStatus.ACTIVE
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class KGEdge(BaseModel):
    id: Optional[int] = None
    edge_id: str
    domain_id: str
    ontology_profile_version: Optional[str] = None
    relation_type: str
    source_node_id: str
    target_node_id: str
    properties_json: Optional[dict] = None
    status: EdgeStatus = EdgeStatus.ACTIVE
    created_at: Optional[datetime] = None
