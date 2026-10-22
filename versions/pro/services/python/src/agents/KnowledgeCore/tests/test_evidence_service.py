"""Tests for EvidenceService."""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.evidence.services.evidence_service import EvidenceService


@pytest.mark.asyncio
async def test_create_evidence_pack(db_session: AsyncSession):
    """Test creating an evidence pack."""
    service = EvidenceService(db_session)

    pack = await service.search_evidence(
        domain_id="test_domain",
        query="test query",
        snapshot_id="test_snapshot",
    )

    assert pack.pack_id.startswith("epack_")
    assert pack.query == "test query"
    assert pack.domain_id == "test_domain"


@pytest.mark.asyncio
async def test_add_evidence_items(db_session: AsyncSession):
    """Test adding evidence items to a pack."""
    service = EvidenceService(db_session)

    # Create pack
    pack = await service.search_evidence(
        domain_id="test_domain",
        query="test query",
    )

    # Add items
    items_data = [
        {
            "chunk_id": "chunk_001",
            "document_id": "doc_001",
            "domain_id": "test_domain",
            "domain_version_id": "v1",
            "content": "Test content 1",
            "similarity_score": 0.8,
            "evidence_role": "base",
            "authority_level": "official",
        },
        {
            "chunk_id": "chunk_002",
            "document_id": "doc_002",
            "domain_id": "test_domain",
            "domain_version_id": "v1",
            "content": "Test content 2",
            "similarity_score": 0.6,
            "evidence_role": "example",
            "authority_level": "reference",
        },
    ]

    items = await service.add_evidence_items(pack.pack_id, items_data)

    assert len(items) == 2
    assert items[0].chunk_id == "chunk_001"
    assert items[1].chunk_id == "chunk_002"


@pytest.mark.asyncio
async def test_get_evidence_pack(db_session: AsyncSession):
    """Test getting an evidence pack."""
    service = EvidenceService(db_session)

    # Create pack
    created = await service.search_evidence(
        domain_id="test_domain",
        query="test query",
    )

    # Get pack
    pack = await service.get_evidence_pack(created.pack_id)
    assert pack is not None
    assert pack.pack_id == created.pack_id


@pytest.mark.asyncio
async def test_get_evidence_items(db_session: AsyncSession):
    """Test getting evidence items."""
    service = EvidenceService(db_session)

    # Create pack and add items
    pack = await service.search_evidence(
        domain_id="test_domain",
        query="test query",
    )

    items_data = [
        {
            "chunk_id": "chunk_003",
            "document_id": "doc_003",
            "domain_id": "test_domain",
            "domain_version_id": "v1",
            "content": "Test content",
        },
    ]
    await service.add_evidence_items(pack.pack_id, items_data)

    # Get items
    items = await service.get_evidence_items(pack.pack_id)
    assert len(items) >= 1


@pytest.mark.asyncio
async def test_update_pack_scores(db_session: AsyncSession):
    """Test updating pack scores."""
    service = EvidenceService(db_session)

    # Create pack
    pack = await service.search_evidence(
        domain_id="test_domain",
        query="test query",
    )

    # Update scores
    scores = {
        "coverage_score": 0.8,
        "authority_score": 0.9,
        "freshness_score": 0.7,
    }

    updated = await service.update_pack_scores(pack.pack_id, scores)

    assert updated is not None
    assert updated.coverage_score == 0.8
    assert updated.authority_score == 0.9
    assert updated.freshness_score == 0.7


@pytest.mark.asyncio
async def test_detect_conflicts(db_session: AsyncSession):
    """Test detecting evidence conflicts."""
    service = EvidenceService(db_session)

    # Create items with conflicting similarities
    items = [
        {
            "section_path": ["Chapter 1", "Section 1"],
            "evidence_id": "evi_001",
            "similarity_score": 0.9,
        },
        {
            "section_path": ["Chapter 1", "Section 1"],
            "evidence_id": "evi_002",
            "similarity_score": 0.5,
        },
    ]

    conflicts = await service.detect_conflicts(items)
    assert len(conflicts) >= 1
    assert conflicts[0]["type"] == "similarity_variance"
