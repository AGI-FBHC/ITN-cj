"""领域包生命周期管理服务."""
from __future__ import annotations
from typing import Optional

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models.orm import (
    DomainClaimSchemaORM,
    DomainEntityTypeORM,
    DomainEvidenceRoleORM,
    DomainORM,
    DomainProfileORM,
    DomainRelationTypeORM,
    DomainRuleBundleORM,
    DomainRuntimeSnapshotORM,
    DomainVersionORM,
)


class DomainService:
    """领域包的创建、校验、激活、回滚."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_domain(
        self,
        domain_id: str,
        name: str,
        description: Optional[str] = None,
        owner: Optional[str] = None,
    ) -> DomainORM:
        """创建领域."""
        # Check if domain_id already exists
        existing = await self.db.execute(
            select(DomainORM).where(DomainORM.domain_id == domain_id)
        )
        if existing.scalar_one_or_none():
            raise ValueError(f"Domain '{domain_id}' already exists")

        domain = DomainORM(
            domain_id=domain_id,
            name=name,
            description=description,
            owner=owner,
            status="draft",
        )
        self.db.add(domain)
        await self.db.commit()
        await self.db.refresh(domain)
        return domain

    async def get_domain(self, domain_id: str) -> DomainORM | None:
        """获取领域."""
        result = await self.db.execute(
            select(DomainORM).where(DomainORM.domain_id == domain_id)
        )
        return result.scalar_one_or_none()

    async def list_domains(self) -> list[DomainORM]:
        """列出所有领域."""
        result = await self.db.execute(select(DomainORM))
        return list(result.scalars().all())

    async def create_version(
        self,
        domain_id: str,
        version: str,
        created_by: Optional[str] = None,
    ) -> DomainVersionORM:
        """创建领域版本."""
        # Verify domain exists
        domain = await self.get_domain(domain_id)
        if not domain:
            raise ValueError(f"Domain '{domain_id}' not found")

        # Check if version already exists
        existing = await self.db.execute(
            select(DomainVersionORM).where(
                DomainVersionORM.domain_id == domain_id,
                DomainVersionORM.version == version,
            )
        )
        if existing.scalar_one_or_none():
            raise ValueError(f"Version '{version}' already exists for domain '{domain_id}'")

        domain_version = DomainVersionORM(
            domain_version_id=f"dv_{uuid.uuid4().hex[:8]}",
            domain_id=domain_id,
            version=version,
            created_by=created_by,
            status="draft",
        )
        self.db.add(domain_version)
        await self.db.commit()
        await self.db.refresh(domain_version)
        return domain_version

    async def get_version(self, domain_id: str, version: str) -> DomainVersionORM | None:
        """获取领域版本."""
        result = await self.db.execute(
            select(DomainVersionORM).where(
                DomainVersionORM.domain_id == domain_id,
                DomainVersionORM.version == version,
            )
        )
        return result.scalar_one_or_none()

    async def list_versions(self, domain_id: str) -> list[DomainVersionORM]:
        """列出领域所有版本."""
        result = await self.db.execute(
            select(DomainVersionORM).where(DomainVersionORM.domain_id == domain_id)
        )
        return list(result.scalars().all())

    async def validate_version(self, domain_id: str, version: str) -> dict:
        """校验领域版本结构完整性."""
        domain_version = await self.get_version(domain_id, version)
        if not domain_version:
            raise ValueError(f"Version '{version}' not found for domain '{domain_id}'")

        errors = []
        warnings = []
        checks = {}

        # Check profiles exist
        profiles_result = await self.db.execute(
            select(DomainProfileORM).where(
                DomainProfileORM.domain_id == domain_id,
                DomainProfileORM.domain_version_id == domain_version.domain_version_id,
            )
        )
        profiles = list(profiles_result.scalars().all())
        profile_types = {p.profile_type for p in profiles}

        required_profiles = {"ontology", "terminology", "retrieval"}
        for pt in required_profiles:
            checks[f"has_{pt}_profile"] = pt in profile_types
            if pt not in profile_types:
                warnings.append(f"Missing {pt} profile")

        # Check entity types
        entity_result = await self.db.execute(
            select(DomainEntityTypeORM).where(
                DomainEntityTypeORM.domain_id == domain_id,
                DomainEntityTypeORM.domain_version_id == domain_version.domain_version_id,
            )
        )
        entity_types = list(entity_result.scalars().all())
        checks["has_entity_types"] = len(entity_types) > 0
        if not entity_types:
            warnings.append("No entity types defined")

        # Check rule bundles
        rules_result = await self.db.execute(
            select(DomainRuleBundleORM).where(
                DomainRuleBundleORM.domain_id == domain_id,
                DomainRuleBundleORM.domain_version_id == domain_version.domain_version_id,
            )
        )
        rule_bundles = list(rules_result.scalars().all())
        checks["has_rule_bundle"] = len(rule_bundles) > 0
        if not rule_bundles:
            warnings.append("No rule bundles defined")

        # Check evidence roles
        evidence_result = await self.db.execute(
            select(DomainEvidenceRoleORM).where(
                DomainEvidenceRoleORM.domain_id == domain_id,
                DomainEvidenceRoleORM.domain_version_id == domain_version.domain_version_id,
            )
        )
        evidence_roles = list(evidence_result.scalars().all())
        checks["has_evidence_roles"] = len(evidence_roles) > 0
        if not evidence_roles:
            warnings.append("No evidence roles defined")

        is_valid = len(errors) == 0

        return {
            "domain_id": domain_id,
            "version": version,
            "is_valid": is_valid,
            "errors": errors,
            "warnings": warnings,
            "checks": checks,
        }

    async def activate_version(
        self,
        domain_id: str,
        version: str,
        activated_by: Optional[str] = None,
    ) -> DomainRuntimeSnapshotORM:
        """激活领域版本，生成运行快照."""
        domain_version = await self.get_version(domain_id, version)
        if not domain_version:
            raise ValueError(f"Version '{version}' not found for domain '{domain_id}'")

        # Validate first
        validation = await self.validate_version(domain_id, version)
        if not validation["is_valid"]:
            raise ValueError(f"Validation failed: {validation['errors']}")

        # Deactivate previous active version
        prev_active = await self.db.execute(
            select(DomainVersionORM).where(
                DomainVersionORM.domain_id == domain_id,
                DomainVersionORM.status == "active",
            )
        )
        for prev in prev_active.scalars().all():
            prev.status = "deprecated"

        # Activate new version
        domain_version.status = "active"
        domain_version.activated_at = datetime.now()

        # Create runtime snapshot
        snapshot_id = f"drs_{uuid.uuid4().hex[:8]}"

        # Gather rule bundle version
        rules_result = await self.db.execute(
            select(DomainRuleBundleORM).where(
                DomainRuleBundleORM.domain_id == domain_id,
                DomainRuleBundleORM.domain_version_id == domain_version.domain_version_id,
            )
        )
        rule_bundle = rules_result.scalars().first()

        # Gather profiles
        profiles_result = await self.db.execute(
            select(DomainProfileORM).where(
                DomainProfileORM.domain_id == domain_id,
                DomainProfileORM.domain_version_id == domain_version.domain_version_id,
            )
        )
        profiles = {p.profile_type: p for p in profiles_result.scalars().all()}

        snapshot = DomainRuntimeSnapshotORM(
            snapshot_id=snapshot_id,
            domain_id=domain_id,
            domain_version_id=domain_version.domain_version_id,
            rule_bundle_version=rule_bundle.bundle_version if rule_bundle else None,
            retrieval_profile_version=profiles.get("retrieval").version if profiles.get("retrieval") else None,
            claim_schema_version=profiles.get("claim_schema").version if profiles.get("claim_schema") else None,
            activated_at=datetime.now(),
            created_by=activated_by,
        )
        self.db.add(snapshot)
        await self.db.commit()
        await self.db.refresh(snapshot)
        return snapshot

    async def rollback(self, domain_id: str, target_version: str) -> DomainVersionORM:
        """回滚到指定版本."""
        target = await self.get_version(domain_id, target_version)
        if not target:
            raise ValueError(f"Version '{target_version}' not found for domain '{domain_id}'")

        # Deactivate current active
        current_active = await self.db.execute(
            select(DomainVersionORM).where(
                DomainVersionORM.domain_id == domain_id,
                DomainVersionORM.status == "active",
            )
        )
        for ver in current_active.scalars().all():
            ver.status = "rolled_back"

        # Activate target
        target.status = "active"

        # Update domain status
        domain = await self.get_domain(domain_id)
        if domain:
            domain.status = "active"

        await self.db.commit()
        await self.db.refresh(target)
        return target

    async def get_runtime_snapshots(self, domain_id: str) -> list[DomainRuntimeSnapshotORM]:
        """查询运行快照."""
        result = await self.db.execute(
            select(DomainRuntimeSnapshotORM).where(
                DomainRuntimeSnapshotORM.domain_id == domain_id
            )
        )
        return list(result.scalars().all())

    async def get_latest_snapshot(self, domain_id: str) -> DomainRuntimeSnapshotORM | None:
        """获取最新运行快照."""
        result = await self.db.execute(
            select(DomainRuntimeSnapshotORM)
            .where(DomainRuntimeSnapshotORM.domain_id == domain_id)
            .order_by(DomainRuntimeSnapshotORM.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def get_snapshot_by_id(self, snapshot_id: str) -> DomainRuntimeSnapshotORM | None:
        """根据 ID 获取运行快照."""
        result = await self.db.execute(
            select(DomainRuntimeSnapshotORM).where(
                DomainRuntimeSnapshotORM.snapshot_id == snapshot_id
            )
        )
        return result.scalar_one_or_none()

    # ── Profile management ──────────────────────────────────────────────────

    async def create_profile(
        self,
        domain_id: str,
        domain_version_id: str,
        profile_type: str,
        schema_json: dict,
        version: Optional[str] = None,
    ) -> DomainProfileORM:
        """创建领域配置."""
        profile = DomainProfileORM(
            domain_id=domain_id,
            domain_version_id=domain_version_id,
            profile_type=profile_type,
            schema_json=schema_json,
            version=version,
        )
        self.db.add(profile)
        await self.db.commit()
        await self.db.refresh(profile)
        return profile

    async def list_profiles(self, domain_id: str, domain_version_id: str) -> list[DomainProfileORM]:
        """列出领域配置."""
        result = await self.db.execute(
            select(DomainProfileORM).where(
                DomainProfileORM.domain_id == domain_id,
                DomainProfileORM.domain_version_id == domain_version_id,
            )
        )
        return list(result.scalars().all())

    # ── Entity Type management ──────────────────────────────────────────────

    async def create_entity_type(
        self,
        domain_id: str,
        domain_version_id: str,
        name: str,
        description: Optional[str] = None,
        constraints_json: Optional[dict] = None,
    ) -> DomainEntityTypeORM:
        """创建实体类型."""
        entity_type = DomainEntityTypeORM(
            domain_id=domain_id,
            domain_version_id=domain_version_id,
            name=name,
            description=description,
            constraints_json=constraints_json,
        )
        self.db.add(entity_type)
        await self.db.commit()
        await self.db.refresh(entity_type)
        return entity_type

    async def list_entity_types(self, domain_id: str, domain_version_id: str) -> list[DomainEntityTypeORM]:
        """列出实体类型."""
        result = await self.db.execute(
            select(DomainEntityTypeORM).where(
                DomainEntityTypeORM.domain_id == domain_id,
                DomainEntityTypeORM.domain_version_id == domain_version_id,
            )
        )
        return list(result.scalars().all())

    # ── Relation Type management ────────────────────────────────────────────

    async def create_relation_type(
        self,
        domain_id: str,
        domain_version_id: str,
        name: str,
        description: Optional[str] = None,
        source_types: Optional[list[str]] = None,
        target_types: Optional[list[str]] = None,
        constraints_json: Optional[dict] = None,
    ) -> DomainRelationTypeORM:
        """创建关系类型."""
        relation_type = DomainRelationTypeORM(
            domain_id=domain_id,
            domain_version_id=domain_version_id,
            name=name,
            description=description,
            source_types=source_types,
            target_types=target_types,
            constraints_json=constraints_json,
        )
        self.db.add(relation_type)
        await self.db.commit()
        await self.db.refresh(relation_type)
        return relation_type

    async def list_relation_types(self, domain_id: str, domain_version_id: str) -> list[DomainRelationTypeORM]:
        """列出关系类型."""
        result = await self.db.execute(
            select(DomainRelationTypeORM).where(
                DomainRelationTypeORM.domain_id == domain_id,
                DomainRelationTypeORM.domain_version_id == domain_version_id,
            )
        )
        return list(result.scalars().all())

    # ── Evidence Role management ────────────────────────────────────────────

    async def create_evidence_role(
        self,
        domain_id: str,
        domain_version_id: str,
        role_name: str,
        required_fields: Optional[dict] = None,
        risk_policy: str = "optional",
    ) -> DomainEvidenceRoleORM:
        """创建证据角色."""
        evidence_role = DomainEvidenceRoleORM(
            domain_id=domain_id,
            domain_version_id=domain_version_id,
            role_name=role_name,
            required_fields=required_fields,
            risk_policy=risk_policy,
        )
        self.db.add(evidence_role)
        await self.db.commit()
        await self.db.refresh(evidence_role)
        return evidence_role

    async def list_evidence_roles(self, domain_id: str, domain_version_id: str) -> list[DomainEvidenceRoleORM]:
        """列出证据角色."""
        result = await self.db.execute(
            select(DomainEvidenceRoleORM).where(
                DomainEvidenceRoleORM.domain_id == domain_id,
                DomainEvidenceRoleORM.domain_version_id == domain_version_id,
            )
        )
        return list(result.scalars().all())

    # ── Rule Bundle management ──────────────────────────────────────────────

    async def create_rule_bundle(
        self,
        domain_id: str,
        domain_version_id: str,
        bundle_version: str,
        rules_json: list[dict],
        predicate_dependencies: Optional[list[str]] = None,
        test_suite_ref: Optional[str] = None,
    ) -> DomainRuleBundleORM:
        """创建规则包."""
        rule_bundle = DomainRuleBundleORM(
            domain_id=domain_id,
            domain_version_id=domain_version_id,
            bundle_version=bundle_version,
            rules_json=rules_json,
            predicate_dependencies=predicate_dependencies,
            test_suite_ref=test_suite_ref,
            status="draft",
        )
        self.db.add(rule_bundle)
        await self.db.commit()
        await self.db.refresh(rule_bundle)
        return rule_bundle

    async def list_rule_bundles(self, domain_id: str, domain_version_id: str) -> list[DomainRuleBundleORM]:
        """列出规则包."""
        result = await self.db.execute(
            select(DomainRuleBundleORM).where(
                DomainRuleBundleORM.domain_id == domain_id,
                DomainRuleBundleORM.domain_version_id == domain_version_id,
            )
        )
        return list(result.scalars().all())

    # ── Claim Schema management ─────────────────────────────────────────────

    async def create_claim_schema(
        self,
        domain_id: str,
        domain_version_id: str,
        task_type: str,
        claim_id: str,
        criticality: str = "important",
        required_roles: Optional[list[str]] = None,
        description: Optional[str] = None,
    ) -> DomainClaimSchemaORM:
        """创建关键主张."""
        claim_schema = DomainClaimSchemaORM(
            domain_id=domain_id,
            domain_version_id=domain_version_id,
            task_type=task_type,
            claim_id=claim_id,
            criticality=criticality,
            required_roles=required_roles,
            description=description,
        )
        self.db.add(claim_schema)
        await self.db.commit()
        await self.db.refresh(claim_schema)
        return claim_schema

    async def list_claim_schemas(self, domain_id: str, domain_version_id: str) -> list[DomainClaimSchemaORM]:
        """列出关键主张."""
        result = await self.db.execute(
            select(DomainClaimSchemaORM).where(
                DomainClaimSchemaORM.domain_id == domain_id,
                DomainClaimSchemaORM.domain_version_id == domain_version_id,
            )
        )
        return list(result.scalars().all())
