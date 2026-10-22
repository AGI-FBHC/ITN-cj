"""Knowledge Retriever - search knowledge base for relevant context."""
from typing import Any
from urllib.parse import urlparse
import pymysql, pymysql.cursors
from app.config import Settings

def _connect(settings: Settings):
    p = urlparse(settings.platform_db_url)
    return pymysql.connect(host=p.hostname, port=p.port or 3306, user=p.username,
        password=p.password, database=p.path.lstrip("/"), charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor, connect_timeout=10, read_timeout=60, write_timeout=60)

class KnowledgeRetriever:
    def __init__(self, settings: Settings):
        self.settings = settings; self._available = bool(settings.platform_db_url)

    def available(self) -> bool: return self._available

    def search(self, query: str, max_results: int = 3) -> list[dict[str, Any]]:
        if not self._available: return []
        try:
            with _connect(self.settings) as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT id, title, slug, markdown, source_name, category "
                        "FROM knowledge_articles WHERE title LIKE %s OR markdown LIKE %s LIMIT %s",
                        (f"%{query}%", f"%{query}%", max_results))
                    rows = cur.fetchall()
        except Exception: return []
        results = []
        for row in rows:
            md = row.get("markdown") or ""
            results.append({"id": str(row["id"]), "title": row.get("title",""), "slug": row.get("slug",""),
                "source": row.get("source_name",""), "category": row.get("category",""),
                "excerpt": md[:2000] if len(md) > 2000 else md})
        return results