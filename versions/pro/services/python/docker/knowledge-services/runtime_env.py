"""Deployment-only environment adapter for the delivered knowledge services.

The colleague-owned KnowledgeCore and predeal packages intentionally remain
unchanged.  This adapter only maps the platform's existing consolidated
environment variables to the names those packages already consume.
"""

from __future__ import annotations

import os
from urllib.parse import unquote, urlsplit


def configure_shared_env() -> None:
    database_url = os.environ.get("PLATFORM_DB_URL", "").strip()
    if database_url and not os.environ.get("MYSQL_HOST"):
        parsed = urlsplit(database_url.replace("mysql+aiomysql://", "mysql://", 1).replace("mysql+pymysql://", "mysql://", 1))
        if parsed.hostname:
            os.environ["MYSQL_HOST"] = parsed.hostname
        if parsed.port:
            os.environ["MYSQL_PORT"] = str(parsed.port)
        if parsed.username:
            os.environ["MYSQL_USER"] = unquote(parsed.username)
        if parsed.password:
            os.environ["MYSQL_PASSWORD"] = unquote(parsed.password)
        if parsed.path.strip("/"):
            os.environ["MYSQL_DATABASE"] = unquote(parsed.path.strip("/"))

    aliases = {
        "RAGFLOW_URL": ("RAGFLOW_BASE_URL",),
        "LLM_API_URL": ("MIMO_TEXT_API_BASE", "MIMO_API_BASE", "LLM_API_BASE"),
        "LLM_API_KEY": ("OPENCODE_GO_API_KEY", "MIMO_API_KEY"),
        "LLM_MODEL": ("MIMO_TEXT_MODEL", "MIMO_MODEL"),
    }
    for target, candidates in aliases.items():
        if os.environ.get(target):
            continue
        for candidate in candidates:
            value = os.environ.get(candidate)
            if value:
                os.environ[target] = value
                break
