"""KnowledgeCore decision retrieval with a deterministic chunks fallback."""
from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from urllib.parse import urlencode
from uuid import UUID

import httpx
import pymysql

from app.security import create_signature
from app.storage.platform_db import platform_connect

logger = logging.getLogger(__name__)


class KnowledgeDecisionClient:
    def __init__(self, settings):
        self.settings = settings

    def _headers(self, method: str, path: str, body: bytes, user_id: UUID, request_id: str) -> dict[str, str]:
        timestamp, nonce, user = str(int(time.time())), uuid.uuid4().hex, str(user_id)
        return {
            "Content-Type": "application/json", "X-ITN-Timestamp": timestamp,
            "X-ITN-Nonce": nonce, "X-ITN-User-Id": user,
            "X-ITN-Signature": create_signature(
                self.settings.kc_internal_secret or self.settings.agent_internal_secret,
                method, path, timestamp, nonce, user, body),
            "X-Request-Id": request_id,
        }

    async def _request(self, method: str, path: str, user_id: UUID, request_id: str,
                       *, payload: dict | None = None, params: dict | None = None) -> dict:
        query = f"?{urlencode(params)}" if params else ""
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode() if payload else b""
        async with httpx.AsyncClient(base_url=self.settings.knowledge_core_url.rstrip("/"),
                                     timeout=self.settings.knowledge_resolve_timeout_seconds,
                                     trust_env=False) as client:
            response = await client.request(method, f"{path}{query}", content=body or None,
                                            headers=self._headers(method, path, body, user_id, request_id))
            response.raise_for_status()
            result = response.json()
            return result if isinstance(result, dict) else {}

    @staticmethod
    def _resolve_chunks(result: dict) -> list[dict]:
        chunks = []
        for item in result.get("evidence_items") or []:
            if not isinstance(item, dict):
                continue
            content = item.get("content") or item.get("text") or item.get("quote") or item.get("snippet")
            if content:
                chunks.append({"content": str(content),
                               "document": item.get("document") or item.get("title") or item.get("source_name") or "知识库证据",
                               "similarity": float(item.get("similarity") or item.get("score") or result.get("high_fidelity_score") or 0),
                               "chunk_id": str(item.get("chunk_id") or item.get("id") or ""),
                               "document_id": item.get("document_id"),
                               "category_id": item.get("category_id"),
                               "section_title": item.get("section_title") or item.get("title_path"),
                               "source": item.get("source") or "knowledge_core"})
        return chunks

    @staticmethod
    def _fallback_chunks(result: dict) -> list[dict]:
        return [{"content": str(item.get("content") or ""),
                 "document": item.get("section_title") or item.get("title_path") or "知识库资料",
                 "similarity": float(item.get("similarity") or item.get("confidence") or 0),
                 "chunk_id": str(item.get("ragflow_chunk_id") or item.get("chunk_id") or ""),
                 "section_title": item.get("section_title") or item.get("title_path") or ""}
                for item in result.get("chunks") or [] if item.get("content")]

    async def retrieve(self, query: str, user_id: UUID, *, top_k: int = 5,
                       task_type: str = "explanation") -> dict:
        request_id, started = str(uuid.uuid4()), time.perf_counter()
        decision, stage, error_code = "error", "resolve", None
        resolve_result, chunks, fallback_used, contrasts = {}, [], False, []
        try:
            resolve_result = await self._request(
                "POST", "/api/v1/knowledge/resolve", user_id, request_id,
                payload={"query": query, "task_type": task_type, "top_k": top_k, "similarity_threshold": 0.2})
            eligible = bool((resolve_result.get("eligibility") or {}).get("is_eligible"))
            chunks = self._resolve_chunks(resolve_result) if eligible else []
            decision = str(resolve_result.get("decision") or ("eligible" if eligible else "ineligible"))
            if not chunks:
                fallback_used, stage = True, "chunks"
                fallback = await self._request(
                    "GET", "/api/v1/knowledge/chunks", user_id, request_id,
                    params={"knowledge_point": query, "domain": "agent", "include_rag": "true",
                            "include_contrasts": "true", "limit": top_k})
                chunks, decision = self._fallback_chunks(fallback), str(fallback.get("decision") or decision)
                contrasts = fallback.get("contrasts") or []
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            error_code = type(exc).__name__
            logger.warning("KnowledgeCore retrieval failed request_id=%s stage=%s error=%s", request_id, stage, exc)
        latency_ms = int((time.perf_counter() - started) * 1000)
        self._record(user_id, request_id, query, task_type, decision, stage, resolve_result,
                     fallback_used, chunks, latency_ms, error_code)
        eligibility = resolve_result.get("eligibility") if isinstance(resolve_result.get("eligibility"), dict) else {}
        return {"success": bool(chunks), "source": "knowledgecore", "chunks": chunks,
                "decision": decision, "retrieval_stage": stage, "fallback_used": fallback_used,
                "request_id": request_id, "error": error_code,
                "domain_id": resolve_result.get("domain_id"),
                "category_id": resolve_result.get("category_id") or resolve_result.get("target_category_id"),
                "high_fidelity_score": resolve_result.get("high_fidelity_score"),
                "contrasts": contrasts or resolve_result.get("contrasts") or [],
                "eligibility": eligibility,
                "audit_trail": resolve_result.get("audit_trail") or []}

    def _record(self, user_id: UUID, request_id: str, query: str, task_type: str,
                decision: str, stage: str, resolve_result: dict, fallback_used: bool,
                chunks: list[dict], latency_ms: int, error_code: str | None) -> None:
        if not self.settings.platform_db_url:
            return
        try:
            with platform_connect(self.settings) as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT organization_id FROM users WHERE id=%s LIMIT 1", (user_id.bytes,))
                    row = cursor.fetchone()
                    if not row or not row.get("organization_id"):
                        return
                    refs = [item.get("chunk_id") for item in chunks if item.get("chunk_id")]
                    cursor.execute(
                        "INSERT INTO knowledge_resolve_decisions "
                        "(organization_id,user_id,request_id,domain_id,query_hash,task_type,decision,retrieval_stage,"
                        "high_fidelity_score,fallback_used,evidence_refs,latency_ms,error_code) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                        (row["organization_id"], user_id.bytes, request_id, resolve_result.get("domain_id"),
                         hashlib.sha256(query.encode()).hexdigest(), task_type, decision[:32], stage,
                         resolve_result.get("high_fidelity_score"), fallback_used,
                         json.dumps(refs, ensure_ascii=False), latency_ms, error_code))
                connection.commit()
        except pymysql.err.OperationalError as exc:
            # Older local platform dumps do not yet have organization_id on
            # users (or the decision table). Retrieval remains valid; audit
            # persistence is simply unavailable until the schema migration.
            if exc.args and int(exc.args[0]) in {1054, 1146}:
                logger.debug("KnowledgeCore decision audit skipped for legacy schema: %s", exc)
                return
            logger.warning("Unable to record KnowledgeCore decision request_id=%s error=%s", request_id, exc)
        except Exception as exc:
            logger.warning("Unable to record KnowledgeCore decision request_id=%s error=%s", request_id, exc)
