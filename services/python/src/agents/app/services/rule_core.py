from __future__ import annotations

import json
import logging
import time
import uuid
from uuid import UUID

import httpx

from app.security import create_signature

logger = logging.getLogger(__name__)


class RuleCoreClient:
    def __init__(self, settings):
        self.settings = settings

    async def _post(self, path: str, payload: dict, user_id: UUID) -> dict:
        if not self.settings.rule_core_enabled:
            return {}
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        timestamp, nonce, caller = str(int(time.time())), uuid.uuid4().hex, str(user_id)
        headers = {
            "Content-Type": "application/json", "X-ITN-Timestamp": timestamp,
            "X-ITN-Nonce": nonce, "X-ITN-User-Id": caller,
            "X-ITN-Signature": create_signature(
                self.settings.agent_internal_secret, "POST", path,
                timestamp, nonce, caller, body,
            ),
        }
        try:
            async with httpx.AsyncClient(
                base_url=self.settings.rule_core_url.rstrip("/"),
                timeout=self.settings.rule_core_timeout_seconds, trust_env=False,
            ) as client:
                response = await client.post(path, content=body, headers=headers)
                response.raise_for_status()
                result = response.json()
                return result if isinstance(result, dict) else {}
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            logger.warning("RuleCore request failed path=%s error=%s", path, exc)
            return {"available": False, "error": type(exc).__name__}

    async def resolve(self, task: str, resource_type: str, topic: str,
                      user_id: UUID, extra_context: str = "") -> dict:
        return await self._post("/internal/v1/rules/resolve", {
            "task": task, "resource_type": resource_type, "topic": topic,
            "extra_context": extra_context,
        }, user_id)

    async def check(self, content: dict, constraints: list[dict], user_id: UUID) -> dict:
        return await self._post("/internal/v1/rules/check", {
            "content": content,
            "constraints": [{key: item.get(key) for key in ("rule_code", "type", "content", "source")}
                            for item in constraints],
        }, user_id)
