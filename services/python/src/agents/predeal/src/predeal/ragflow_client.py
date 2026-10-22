"""RAGFlow API client for dataset and document management."""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import urllib.request
import urllib.parse
import urllib.error


@dataclass
class RAGFlowConfig:
    """RAGFlow connection configuration."""
    base_url: str = field(default_factory=lambda: os.environ.get("RAGFLOW_URL", ""))
    api_key: str = field(default_factory=lambda: os.environ.get("RAGFLOW_API_KEY", ""))
    timeout: int = 60


class RAGFlowError(Exception):
    """RAGFlow API error."""
    def __init__(self, code: int, message: str):
        self.code = code
        self.message = message
        super().__init__(f"RAGFlow error {code}: {message}")


class RAGFlowClient:
    """Client for RAGFlow HTTP API."""

    def __init__(self, config: RAGFlowConfig):
        self.config = config
        self._base = config.base_url.rstrip("/")

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        files: Optional[Dict[str, Any]] = None,
        content_type: str = "application/json",
    ) -> Dict[str, Any]:
        """Make an HTTP request to RAGFlow API."""
        url = f"{self._base}{path}"
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
        }

        if files:
            # Multipart form data - build as bytes to preserve UTF-8 encoding
            boundary = f"----WebKitFormBoundary{int(time.time() * 1000)}"
            headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"

            parts = []
            for key, (filename, file_content, mime_type) in files.items():
                parts.append(f"--{boundary}\r\n".encode("utf-8"))
                parts.append(f'Content-Disposition: form-data; name="{key}"; filename="{filename}"\r\n'.encode("utf-8"))
                parts.append(f"Content-Type: {mime_type}\r\n\r\n".encode("utf-8"))
                if isinstance(file_content, str):
                    parts.append(file_content.encode("utf-8"))
                else:
                    parts.append(file_content)
                parts.append(b"\r\n")

            if body:
                for key, value in body.items():
                    parts.append(f"--{boundary}\r\n".encode("utf-8"))
                    parts.append(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
                    parts.append(str(value).encode("utf-8"))
                    parts.append(b"\r\n")

            parts.append(f"--{boundary}--\r\n".encode("utf-8"))
            data = b"".join(parts)
        elif body:
            headers["Content-Type"] = content_type
            data = json.dumps(body).encode("utf-8")
        else:
            data = None

        req = urllib.request.Request(url, data=data, headers=headers, method=method)

        # Disable proxy to avoid system proxy settings
        proxy_handler = urllib.request.ProxyHandler({})
        opener = urllib.request.build_opener(proxy_handler)

        try:
            with opener.open(req, timeout=self.config.timeout) as resp:
                resp_data = resp.read().decode("utf-8")
                return json.loads(resp_data) if resp_data else {}
        except urllib.error.HTTPError as e:
            resp_body = e.read().decode("utf-8", errors="replace")
            try:
                err = json.loads(resp_body)
                raise RAGFlowError(err.get("code", e.code), err.get("message", resp_body))
            except json.JSONDecodeError:
                raise RAGFlowError(e.code, resp_body)

    # ── Dataset operations ──────────────────────────────────────────────

    def create_dataset(
        self,
        name: str,
        embedding_model: Optional[str] = None,
        chunk_method: str = "naive",
        parser_config: Optional[Dict[str, Any]] = None,
        description: str = "",
    ) -> Dict[str, Any]:
        """Create a new dataset."""
        body: Dict[str, Any] = {
            "name": name,
            "chunk_method": chunk_method,
        }
        if embedding_model:
            body["embedding_model"] = embedding_model
        if parser_config:
            body["parser_config"] = parser_config
        if description:
            body["description"] = description
        resp = self._request("POST", "/api/v1/datasets", body=body)
        if resp.get("code") != 0:
            raise RAGFlowError(resp.get("code", -1), resp.get("message", "Unknown error"))
        return resp["data"]

    def list_datasets(self, page: int = 1, page_size: int = 30) -> List[Dict[str, Any]]:
        """List all datasets."""
        resp = self._request("GET", f"/api/v1/datasets?page={page}&page_size={page_size}")
        if resp.get("code") != 0:
            raise RAGFlowError(resp.get("code", -1), resp.get("message", "Unknown error"))
        return resp.get("data", [])

    def get_dataset(self, dataset_id: str) -> Dict[str, Any]:
        """Get dataset by ID."""
        resp = self._request("GET", f"/api/v1/datasets/{dataset_id}")
        if resp.get("code") != 0:
            raise RAGFlowError(resp.get("code", -1), resp.get("message", "Unknown error"))
        return resp["data"]

    def update_dataset(
        self,
        dataset_id: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
        parser_config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Update dataset fields (e.g. parser_config for delimiter chunking)."""
        body: Dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if description is not None:
            body["description"] = description
        if parser_config is not None:
            body["parser_config"] = parser_config
        resp = self._request("PUT", f"/api/v1/datasets/{dataset_id}", body=body)
        if resp.get("code") != 0:
            raise RAGFlowError(resp.get("code", -1), resp.get("message", "Unknown error"))
        return resp.get("data", {})

    def delete_datasets(self, dataset_ids: List[str]) -> None:
        """Delete datasets by IDs."""
        resp = self._request("DELETE", "/api/v1/datasets", body={"ids": dataset_ids})
        if resp.get("code") != 0:
            raise RAGFlowError(resp.get("code", -1), resp.get("message", "Unknown error"))

    def find_dataset_by_name(self, name: str) -> Optional[Dict[str, Any]]:
        """Find a dataset by name."""
        datasets = self.list_datasets()
        for ds in datasets:
            if ds.get("name") == name:
                return ds
        return None

    # ── Document operations ─────────────────────────────────────────────

    def upload_document(self, dataset_id: str, file_path: Path, name: Optional[str] = None,
                        parser_config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Upload a document to a dataset.

        Args:
            dataset_id: RAGFlow dataset id
            file_path: Local file to upload
            name: Desired document name in RAGFlow (defaults to file basename)
            parser_config: Per-document parser config overrides, e.g.
                ``{"delimiter": "<<<ITN_CHUNK_BOUNDARY>>>"}`` — some RAGFlow
                versions ignore the dataset-level parser_config, so we pass it
                per document to make delimiter-based chunking actually work.
        """
        with open(file_path, "rb") as f:
            file_content = f.read()
        files = {
            "file": (name or file_path.name, file_content, "application/octet-stream"),
        }
        body = None
        if parser_config:
            body = {"parser_config": json.dumps(parser_config)}
        resp = self._request(
            "POST",
            f"/api/v1/datasets/{dataset_id}/documents",
            files=files,
            body=body,
        )
        if resp.get("code") != 0:
            raise RAGFlowError(resp.get("code", -1), resp.get("message", "Unknown error"))
        return resp["data"][0] if resp.get("data") else {}

    def list_documents(self, dataset_id: str, page: int = 1, page_size: int = 30) -> List[Dict[str, Any]]:
        """List documents in a dataset (paginated until exhausted)."""
        docs: List[Dict[str, Any]] = []
        current = page
        while True:
            resp = self._request(
                "GET",
                f"/api/v1/datasets/{dataset_id}/documents?page={current}&page_size={page_size}",
            )
            if resp.get("code") != 0:
                raise RAGFlowError(resp.get("code", -1), resp.get("message", "Unknown error"))
            data = resp.get("data", {})
            batch = data.get("docs", []) if isinstance(data, dict) else data
            docs.extend(batch)
            total = data.get("total") if isinstance(data, dict) else None
            if total is not None and len(docs) >= total:
                break
            if len(batch) < page_size:
                break
            current += 1
        return docs

    def parse_documents(self, dataset_id: str, document_ids: List[str]) -> None:
        """Trigger parsing of documents."""
        resp = self._request(
            "POST",
            f"/api/v1/datasets/{dataset_id}/chunks",
            body={"document_ids": document_ids},
        )
        if resp.get("code") != 0:
            raise RAGFlowError(resp.get("code", -1), resp.get("message", "Unknown error"))

    def delete_documents(self, dataset_id: str, document_ids: List[str]) -> None:
        """Delete documents from a dataset."""
        resp = self._request(
            "DELETE",
            f"/api/v1/datasets/{dataset_id}/documents",
            body={"ids": document_ids},
        )
        if resp.get("code") != 0:
            raise RAGFlowError(resp.get("code", -1), resp.get("message", "Unknown error"))

    # ── Chunk operations ────────────────────────────────────────────────

    def add_chunk(
        self,
        dataset_id: str,
        document_id: str,
        content: str,
        important_keywords: Optional[List[str]] = None,
        tag_kwd: Optional[List[str]] = None,
        questions: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Add a chunk to a document."""
        body: Dict[str, Any] = {"content": content}
        if important_keywords:
            body["important_keywords"] = important_keywords
        if tag_kwd:
            body["tag_kwd"] = tag_kwd
        if questions:
            body["questions"] = questions
        resp = self._request(
            "POST",
            f"/api/v1/datasets/{dataset_id}/documents/{document_id}/chunks",
            body=body,
        )
        if resp.get("code") != 0:
            raise RAGFlowError(resp.get("code", -1), resp.get("message", "Unknown error"))
        return resp.get("data", {}).get("chunk", {})

    def update_chunk(
        self,
        dataset_id: str,
        document_id: str,
        chunk_id: str,
        content: Optional[str] = None,
        important_keywords: Optional[List[str]] = None,
        available: Optional[bool] = None,
    ) -> None:
        """Update a chunk."""
        body: Dict[str, Any] = {}
        if content is not None:
            body["content"] = content
        if important_keywords is not None:
            body["important_keywords"] = important_keywords
        if available is not None:
            body["available"] = available
        resp = self._request(
            "PATCH",
            f"/api/v1/datasets/{dataset_id}/documents/{document_id}/chunks/{chunk_id}",
            body=body,
        )
        if resp.get("code") != 0:
            raise RAGFlowError(resp.get("code", -1), resp.get("message", "Unknown error"))

    def list_chunks(
        self,
        dataset_id: str,
        document_id: str,
        page: int = 1,
        page_size: int = 100,
    ) -> List[Dict[str, Any]]:
        """List chunks in a document."""
        resp = self._request(
            "GET",
            f"/api/v1/datasets/{dataset_id}/documents/{document_id}/chunks?page={page}&page_size={page_size}",
        )
        if resp.get("code") != 0:
            raise RAGFlowError(resp.get("code", -1), resp.get("message", "Unknown error"))
        return resp.get("data", {}).get("chunks", [])
