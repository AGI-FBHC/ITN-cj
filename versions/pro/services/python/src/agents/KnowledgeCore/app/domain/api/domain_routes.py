"""Domain API routes."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.domain.schemas import (
    ActivateVersionRequest,
    CreateClaimSchemaRequest,
    CreateDomainRequest,
    CreateEntityTypeRequest,
    CreateEvidenceRoleRequest,
    CreateProfileRequest,
    CreateRelationTypeRequest,
    CreateRuleBundleRequest,
    CreateVersionRequest,
    DomainClaimSchemaResponse,
    DomainEntityTypeResponse,
    DomainEvidenceRoleResponse,
    DomainProfileResponse,
    DomainRelationTypeResponse,
    DomainResponse,
    DomainRuleBundleResponse,
    DomainRuntimeSnapshotResponse,
    DomainVersionResponse,
    RollbackRequest,
    ValidateResponse,
)
from app.domain.services.domain_service import DomainService

router = APIRouter(prefix="/domains", tags=["domain"])


@router.post("", response_model=DomainResponse)
async def create_domain(
    request: CreateDomainRequest,
    db: AsyncSession = Depends(get_db),
):
    """创建领域."""
    service = DomainService(db)
    try:
        domain = await service.create_domain(
            domain_id=request.domain_id,
            name=request.name,
            description=request.description,
            owner=request.owner,
        )
        return domain
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("", response_model=list[DomainResponse])
async def list_domains(
    db: AsyncSession = Depends(get_db),
):
    """列出所有领域."""
    service = DomainService(db)
    return await service.list_domains()


@router.get("/{domain_id}", response_model=DomainResponse)
async def get_domain(
    domain_id: str,
    db: AsyncSession = Depends(get_db),
):
    """获取领域."""
    service = DomainService(db)
    domain = await service.get_domain(domain_id)
    if not domain:
        raise HTTPException(status_code=404, detail=f"Domain '{domain_id}' not found")
    return domain


@router.post("/{domain_id}/versions", response_model=DomainVersionResponse)
async def create_version(
    domain_id: str,
    request: CreateVersionRequest,
    db: AsyncSession = Depends(get_db),
):
    """创建领域版本."""
    service = DomainService(db)
    try:
        version = await service.create_version(
            domain_id=domain_id,
            version=request.version,
            created_by=request.created_by,
        )
        return version
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{domain_id}/versions", response_model=list[DomainVersionResponse])
async def list_versions(
    domain_id: str,
    db: AsyncSession = Depends(get_db),
):
    """列出领域版本."""
    service = DomainService(db)
    return await service.list_versions(domain_id)


@router.post("/{domain_id}/validate", response_model=ValidateResponse)
async def validate_domain(
    domain_id: str,
    version: str,
    db: AsyncSession = Depends(get_db),
):
    """校验领域版本."""
    service = DomainService(db)
    try:
        result = await service.validate_version(domain_id, version)
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/{domain_id}/activate", response_model=DomainRuntimeSnapshotResponse)
async def activate_domain(
    domain_id: str,
    request: ActivateVersionRequest,
    db: AsyncSession = Depends(get_db),
):
    """激活领域版本."""
    service = DomainService(db)
    try:
        snapshot = await service.activate_version(
            domain_id=domain_id,
            version=request.version,
            activated_by=request.activated_by,
        )
        return snapshot
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{domain_id}/rollback", response_model=DomainVersionResponse)
async def rollback_domain(
    domain_id: str,
    request: RollbackRequest,
    db: AsyncSession = Depends(get_db),
):
    """回滚领域版本."""
    service = DomainService(db)
    try:
        version = await service.rollback(
            domain_id=domain_id,
            target_version=request.target_version,
        )
        return version
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{domain_id}/runtime-snapshots", response_model=list[DomainRuntimeSnapshotResponse])
async def get_runtime_snapshots(
    domain_id: str,
    db: AsyncSession = Depends(get_db),
):
    """查询运行快照."""
    service = DomainService(db)
    return await service.get_runtime_snapshots(domain_id)


# ── Profile routes ──────────────────────────────────────────────────────────


@router.post("/{domain_id}/profiles", response_model=DomainProfileResponse)
async def create_profile(
    domain_id: str,
    request: CreateProfileRequest,
    db: AsyncSession = Depends(get_db),
):
    """创建领域配置."""
    service = DomainService(db)
    profile = await service.create_profile(
        domain_id=domain_id,
        domain_version_id=request.domain_version_id,
        profile_type=request.profile_type,
        schema_json=request.schema_json,
        version=request.version,
    )
    return profile


@router.get("/{domain_id}/profiles", response_model=list[DomainProfileResponse])
async def list_profiles(
    domain_id: str,
    domain_version_id: str,
    db: AsyncSession = Depends(get_db),
):
    """列出领域配置."""
    service = DomainService(db)
    return await service.list_profiles(domain_id, domain_version_id)


# ── Entity Type routes ──────────────────────────────────────────────────────


@router.post("/{domain_id}/entity-types", response_model=DomainEntityTypeResponse)
async def create_entity_type(
    domain_id: str,
    request: CreateEntityTypeRequest,
    db: AsyncSession = Depends(get_db),
):
    """创建实体类型."""
    service = DomainService(db)
    entity_type = await service.create_entity_type(
        domain_id=domain_id,
        domain_version_id=request.domain_version_id,
        name=request.name,
        description=request.description,
        constraints_json=request.constraints_json,
    )
    return entity_type


@router.get("/{domain_id}/entity-types", response_model=list[DomainEntityTypeResponse])
async def list_entity_types(
    domain_id: str,
    domain_version_id: str,
    db: AsyncSession = Depends(get_db),
):
    """列出实体类型."""
    service = DomainService(db)
    return await service.list_entity_types(domain_id, domain_version_id)


# ── Relation Type routes ────────────────────────────────────────────────────


@router.post("/{domain_id}/relation-types", response_model=DomainRelationTypeResponse)
async def create_relation_type(
    domain_id: str,
    request: CreateRelationTypeRequest,
    db: AsyncSession = Depends(get_db),
):
    """创建关系类型."""
    service = DomainService(db)
    relation_type = await service.create_relation_type(
        domain_id=domain_id,
        domain_version_id=request.domain_version_id,
        name=request.name,
        description=request.description,
        source_types=request.source_types,
        target_types=request.target_types,
        constraints_json=request.constraints_json,
    )
    return relation_type


@router.get("/{domain_id}/relation-types", response_model=list[DomainRelationTypeResponse])
async def list_relation_types(
    domain_id: str,
    domain_version_id: str,
    db: AsyncSession = Depends(get_db),
):
    """列出关系类型."""
    service = DomainService(db)
    return await service.list_relation_types(domain_id, domain_version_id)


# ── Evidence Role routes ────────────────────────────────────────────────────


@router.post("/{domain_id}/evidence-roles", response_model=DomainEvidenceRoleResponse)
async def create_evidence_role(
    domain_id: str,
    request: CreateEvidenceRoleRequest,
    db: AsyncSession = Depends(get_db),
):
    """创建证据角色."""
    service = DomainService(db)
    evidence_role = await service.create_evidence_role(
        domain_id=domain_id,
        domain_version_id=request.domain_version_id,
        role_name=request.role_name,
        required_fields=request.required_fields,
        risk_policy=request.risk_policy,
    )
    return evidence_role


@router.get("/{domain_id}/evidence-roles", response_model=list[DomainEvidenceRoleResponse])
async def list_evidence_roles(
    domain_id: str,
    domain_version_id: str,
    db: AsyncSession = Depends(get_db),
):
    """列出证据角色."""
    service = DomainService(db)
    return await service.list_evidence_roles(domain_id, domain_version_id)


# ── Rule Bundle routes ──────────────────────────────────────────────────────


@router.post("/{domain_id}/rule-bundles", response_model=DomainRuleBundleResponse)
async def create_rule_bundle(
    domain_id: str,
    request: CreateRuleBundleRequest,
    db: AsyncSession = Depends(get_db),
):
    """创建规则包."""
    service = DomainService(db)
    rule_bundle = await service.create_rule_bundle(
        domain_id=domain_id,
        domain_version_id=request.domain_version_id,
        bundle_version=request.bundle_version,
        rules_json=request.rules_json,
        predicate_dependencies=request.predicate_dependencies,
        test_suite_ref=request.test_suite_ref,
    )
    return rule_bundle


@router.get("/{domain_id}/rule-bundles", response_model=list[DomainRuleBundleResponse])
async def list_rule_bundles(
    domain_id: str,
    domain_version_id: str,
    db: AsyncSession = Depends(get_db),
):
    """列出规则包."""
    service = DomainService(db)
    return await service.list_rule_bundles(domain_id, domain_version_id)


# ── Claim Schema routes ─────────────────────────────────────────────────────


@router.post("/{domain_id}/claim-schemas", response_model=DomainClaimSchemaResponse)
async def create_claim_schema(
    domain_id: str,
    request: CreateClaimSchemaRequest,
    db: AsyncSession = Depends(get_db),
):
    """创建关键主张."""
    service = DomainService(db)
    claim_schema = await service.create_claim_schema(
        domain_id=domain_id,
        domain_version_id=request.domain_version_id,
        task_type=request.task_type,
        claim_id=request.claim_id,
        criticality=request.criticality,
        required_roles=request.required_roles,
        description=request.description,
    )
    return claim_schema


@router.get("/{domain_id}/claim-schemas", response_model=list[DomainClaimSchemaResponse])
async def list_claim_schemas(
    domain_id: str,
    domain_version_id: str,
    db: AsyncSession = Depends(get_db),
):
    """列出关键主张."""
    service = DomainService(db)
    return await service.list_claim_schemas(domain_id, domain_version_id)
