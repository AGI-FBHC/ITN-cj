"""Tests for DomainService."""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.services.domain_service import DomainService


@pytest.mark.asyncio
async def test_create_domain(db_session: AsyncSession):
    """Test creating a domain."""
    service = DomainService(db_session)

    domain = await service.create_domain(
        domain_id="test_domain",
        name="Test Domain",
        description="A test domain",
        owner="test_user",
    )

    assert domain.domain_id == "test_domain"
    assert domain.name == "Test Domain"
    assert domain.description == "A test domain"
    assert domain.owner == "test_user"
    assert domain.status == "draft"


@pytest.mark.asyncio
async def test_create_duplicate_domain(db_session: AsyncSession):
    """Test creating a duplicate domain raises error."""
    service = DomainService(db_session)

    # Create first domain
    await service.create_domain(
        domain_id="dup_domain",
        name="Duplicate Domain",
    )

    # Try to create duplicate
    with pytest.raises(ValueError, match="already exists"):
        await service.create_domain(
            domain_id="dup_domain",
            name="Duplicate Domain 2",
        )


@pytest.mark.asyncio
async def test_get_domain(db_session: AsyncSession):
    """Test getting a domain."""
    service = DomainService(db_session)

    # Create domain
    created = await service.create_domain(
        domain_id="get_domain",
        name="Get Domain",
    )

    # Get domain
    domain = await service.get_domain("get_domain")
    assert domain is not None
    assert domain.domain_id == "get_domain"
    assert domain.name == "Get Domain"


@pytest.mark.asyncio
async def test_list_domains(db_session: AsyncSession):
    """Test listing domains."""
    service = DomainService(db_session)

    # Create multiple domains
    await service.create_domain(domain_id="list_1", name="List 1")
    await service.create_domain(domain_id="list_2", name="List 2")

    # List domains
    domains = await service.list_domains()
    assert len(domains) >= 2


@pytest.mark.asyncio
async def test_create_version(db_session: AsyncSession):
    """Test creating a domain version."""
    service = DomainService(db_session)

    # Create domain
    await service.create_domain(domain_id="version_domain", name="Version Domain")

    # Create version
    version = await service.create_version(
        domain_id="version_domain",
        version="v1.0",
        created_by="test_user",
    )

    assert version.domain_id == "version_domain"
    assert version.version == "v1.0"
    assert version.created_by == "test_user"
    assert version.status == "draft"


@pytest.mark.asyncio
async def test_create_version_nonexistent_domain(db_session: AsyncSession):
    """Test creating a version for non-existent domain raises error."""
    service = DomainService(db_session)

    with pytest.raises(ValueError, match="not found"):
        await service.create_version(
            domain_id="nonexistent",
            version="v1.0",
        )


@pytest.mark.asyncio
async def test_list_versions(db_session: AsyncSession):
    """Test listing domain versions."""
    service = DomainService(db_session)

    # Create domain
    await service.create_domain(domain_id="versions_domain", name="Versions Domain")

    # Create multiple versions
    await service.create_version(domain_id="versions_domain", version="v1.0")
    await service.create_version(domain_id="versions_domain", version="v2.0")

    # List versions
    versions = await service.list_versions("versions_domain")
    assert len(versions) >= 2


@pytest.mark.asyncio
async def test_validate_version(db_session: AsyncSession):
    """Test validating a domain version."""
    service = DomainService(db_session)

    # Create domain and version
    await service.create_domain(domain_id="validate_domain", name="Validate Domain")
    await service.create_version(domain_id="validate_domain", version="v1.0")

    # Validate
    result = await service.validate_version("validate_domain", "v1.0")

    assert result["domain_id"] == "validate_domain"
    assert result["version"] == "v1.0"
    assert "is_valid" in result
    assert "checks" in result
