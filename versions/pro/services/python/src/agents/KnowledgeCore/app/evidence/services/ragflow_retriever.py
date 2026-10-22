"""RAGFlow retriever integration for evidence search."""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from app.core.config import get_settings


class RAGFlowRetriever:
    """RAGFlow retriever for evidence search."""

    def __init__(self):
        self.settings = get_settings()
        self._client = None

    @property
    def client(self):
        """Lazy initialization of RAGFlow client."""
        if self._client is None:
            from predeal.src.predeal.ragflow_client import RAGFlowClient, RAGFlowConfig

            config = RAGFlowConfig(
                base_url=self.settings.RAGFLOW_BASE_URL,
                api_key=self.settings.RAGFLOW_API_KEY,
            )
            self._client = RAGFlowClient(config)
        return self._client

    def retrieve(
        self,
        query: str,
        dataset_ids: List[str],
        top_k: int = 10,
        similarity_threshold: float = 0.2,
        vector_similarity_weight: float = 0.3,
        document_ids: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Retrieve relevant chunks from RAGFlow.

        NOTE (T5.3 唯一事实源收敛): as of the predeal ragflow_client rename
        (ragflow_client2.py -> ragflow_client.py), the underlying client no
        longer exposes ``.retrieve()`` — this method is currently unreachable
        dead code (evidence_service.py only uses ``list_datasets`` /
        ``find_dataset_by_name`` from this class; see its module docstring).
        Real evidence retrieval goes through
        ``app/knowledge/services/rag_client.py`` (independent async httpx
        client hitting the RAGFlow HTTP API directly). Calling this method
        will raise ``AttributeError``; kept only for reference pending
        removal or reimplementation.

        Args:
            query: Search query
            dataset_ids: List of RAGFlow dataset IDs
            top_k: Number of results to return
            similarity_threshold: Minimum similarity score
            vector_similarity_weight: Weight for vector vs keyword search
            document_ids: Optional filter to specific documents

        Returns:
            List of chunk dicts with similarity scores
        """
        try:
            chunks = self.client.retrieve(
                dataset_ids=dataset_ids,
                question=query,
                document_ids=document_ids,
                page_size=top_k,
                similarity_threshold=similarity_threshold,
                vector_similarity_weight=vector_similarity_weight,
            )
            return chunks
        except Exception as e:
            # Log error and return empty list
            print(f"RAGFlow retrieval error: {e}")
            return []

    def list_datasets(self) -> List[Dict[str, Any]]:
        """List all available datasets."""
        try:
            return self.client.list_datasets()
        except Exception as e:
            print(f"RAGFlow list datasets error: {e}")
            return []

    def find_dataset_by_name(self, name: str) -> Optional[Dict[str, Any]]:
        """Find dataset by name."""
        try:
            return self.client.find_dataset_by_name(name)
        except Exception as e:
            print(f"RAGFlow find dataset error: {e}")
            return None

    def build_evidence_items(
        self,
        chunks: List[Dict[str, Any]],
        domain_id: str,
        domain_version_id: str = "v1",
    ) -> List[Dict[str, Any]]:
        """Convert RAGFlow chunks to evidence items.

        Args:
            chunks: Raw chunks from RAGFlow
            domain_id: Domain ID
            domain_version_id: Domain version ID

        Returns:
            List of evidence item dicts
        """
        evidence_items = []

        for chunk in chunks:
            chunk_id = chunk.get("id", "")
            content = chunk.get("content", "")
            similarity = chunk.get("similarity", 0.0)
            vector_sim = chunk.get("vector_similarity", 0.0)
            term_sim = chunk.get("term_similarity", 0.0)

            # Build evidence item
            item = {
                "evidence_id": f"evi_{uuid.uuid4().hex[:8]}",
                "chunk_id": chunk_id,
                "document_id": chunk.get("document_id", ""),
                "domain_id": domain_id,
                "domain_version_id": domain_version_id,
                "content": content,
                "section_path": chunk.get("section_path", []),
                "heading": chunk.get("heading"),
                "chunk_type": chunk.get("chunk_type", "mixed"),
                "similarity_score": similarity,
                "vector_similarity": vector_sim,
                "term_similarity": term_sim,
                "evidence_role": self._determine_evidence_role(chunk),
                "authority_level": self._determine_authority_level(chunk),
                "figure_ids": chunk.get("figure_ids", []),
                "contains_code": chunk.get("contains_code", False),
                "contains_table": chunk.get("contains_table", False),
                "metadata": {
                    "document_name": chunk.get("document_keyword", ""),
                    "dataset_id": chunk.get("dataset_id", ""),
                    "available": chunk.get("available", True),
                },
            }
            evidence_items.append(item)

        return evidence_items

    def _determine_evidence_role(self, chunk: Dict[str, Any]) -> str:
        """Determine evidence role from chunk metadata."""
        # Check if role is already set
        existing_role = chunk.get("evidence_role")
        if existing_role:
            return existing_role

        # Infer from content
        chunk_type = chunk.get("chunk_type", "")
        contains_code = chunk.get("contains_code", False)

        if chunk_type == "code_example" or contains_code:
            return "example"
        elif chunk_type == "reference":
            return "reference"
        elif chunk_type == "concept_explanation":
            return "base"
        else:
            return "base"

    def _determine_authority_level(self, chunk: Dict[str, Any]) -> str:
        """Determine authority level from chunk metadata."""
        # Check if level is already set
        existing_level = chunk.get("authority_level")
        if existing_level:
            return existing_level

        # Default to official
        return "official"
