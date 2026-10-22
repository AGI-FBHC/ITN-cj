"""
MySQL Search Tool - 直接从本地 MySQL knowledge_chunk 表检索，替代 RAGFlow。
按知识点（category_id）精确检索，返回该知识点下的全部切片，不依赖 RAGFlow 服务。
"""
import logging
from app.config import get_settings
from app.tools.base import BaseTool, register_tool

logger = logging.getLogger(__name__)

# Lazy import to avoid circular dependency with platform_connect
_platform_connect = None

def _get_platform_connect():
    global _platform_connect
    if _platform_connect is None:
        from app.storage.platform_db import platform_connect
        _platform_connect = platform_connect
    return _platform_connect


@register_tool
class MysqlSearchTool(BaseTool):
    """从本地 MySQL knowledge_chunk 表检索知识点切片。"""

    @property
    def id(self) -> str:
        return "mysql_search"

    @property
    def name(self) -> str:
        return "知识库检索"

    @property
    def description(self) -> str:
        return (
            "【知识库检索】从本地 MySQL 知识库中检索与知识点相关的切片内容。\n"
            "适用场景：\n"
            "- 用户询问专业知识（AI、算法、框架、教材内容等）\n"
            "- 用户问「根据文档/资料/学习目标」「在我学过的内容里」\n"
            "- 用户希望基于某本教材、课程、文档集回答\n\n"
            "参数：query 是检索关键词或问句；top_k 是返回 chunk 数量（默认 20，最大 50）。"
        )

    @property
    def parameters_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "检索关键词或问题",
                },
                "top_k": {
                    "type": "integer",
                    "description": "返回的 chunk 数量，默认 20，最大 50",
                    "default": 20,
                },
                "kp_id": {
                    "type": "string",
                    "description": "知识点 node_code（如 kp-1-1），精确限定检索范围",
                },
            },
            "required": ["query"],
        }

    @property
    def available(self) -> bool:
        return True  # MySQL always available

    async def execute(self, params: dict) -> dict:
        query = (params.get("query") or "").strip()
        if not query:
            return {"success": False, "error": "query parameter is required", "source": "mysql"}

        try:
            top_k = min(max(int(params.get("top_k") or 20), 1), 50)
        except (TypeError, ValueError):
            top_k = 20

        kp_id = (params.get("kp_id") or "").strip()

        try:
            import asyncio
            chunks = await asyncio.to_thread(self._search_mysql, query, top_k, kp_id)
            return {"success": True, "chunks": chunks, "source": "mysql"}
        except Exception as exc:
            logger.exception("MySQL search failed")
            return {"success": False, "error": f"MySQL 检索失败: {exc}", "source": "mysql"}

    def _search_mysql(self, query: str, top_k: int, kp_id: str) -> list[dict]:
        connect = _get_platform_connect()
        settings = get_settings()
        with connect(settings) as connection:
            with connection.cursor() as cursor:
                if kp_id:
                    # 按知识点/章节精确检索：先找 category，再扩大到当前章节的完整分类子树。
                    # 生成侧只从 MySQL knowledge_chunk 取证据，不依赖 RAGFlow 快照。
                    cursor.execute(
                        "SELECT kc.id, kc.parent_id, "
                        "(SELECT COUNT(*) FROM knowledge_category child WHERE child.parent_id=kc.id) AS child_count "
                        "FROM knowledge_category kc "
                        "WHERE kc.node_code = %s LIMIT 1",
                        (kp_id,),
                    )
                    cat_row = cursor.fetchone()
                    if cat_row:
                        cat_id = cat_row["id"] if isinstance(cat_row, dict) else cat_row[0]
                        parent_id = cat_row["parent_id"] if isinstance(cat_row, dict) else cat_row[1]
                        child_count = int(cat_row["child_count"] if isinstance(cat_row, dict) else cat_row[2] or 0)
                        # 若传入的是叶子知识点，则向上取所属章节整树；若本身就是章节，则取自身及所有子知识点。
                        root_id = cat_id if child_count or not parent_id else parent_id
                        cursor.execute(
                            "WITH RECURSIVE cat_tree AS ("
                            "  SELECT id FROM knowledge_category WHERE id=%s "
                            "  UNION ALL "
                            "  SELECT kc.id FROM knowledge_category kc JOIN cat_tree ct ON kc.parent_id=ct.id "
                            ") "
                            "SELECT c.id, c.content, c.section_title, c.title_path, "
                            "d.title AS document_title, c.ragflow_chunk_id, "
                            "MAX(COALESCE(kcc.confidence, 0.8)) AS confidence "
                            "FROM knowledge_chunk c "
                            "JOIN knowledge_chunk_category kcc ON kcc.chunk_id = c.id "
                            "JOIN knowledge_document d ON d.id = c.document_id "
                            "WHERE kcc.category_id IN (SELECT id FROM cat_tree) "
                            "GROUP BY c.id, c.content, c.section_title, c.title_path, d.title, c.ragflow_chunk_id "
                            "ORDER BY MAX(COALESCE(kcc.confidence, 0.8)) DESC, CHAR_LENGTH(c.content) DESC, c.id ASC "
                            "LIMIT %s",
                            (root_id, top_k),
                        )
                        rows = cursor.fetchall()
                        return [self._row_to_chunk(row) for row in rows]

                # Fallback: 全文搜索（LIKE 匹配）
                # 提取查询中的关键词短语
                phrases = [p.strip() for p in query.replace("？", "?").replace("。", ".").split("?") if len(p.strip()) >= 4]
                if not phrases:
                    phrases = [query[:100]]

                results = []
                seen_ids = set()
                for phrase in phrases[:3]:
                    cursor.execute(
                        "SELECT c.id, c.content, c.section_title, c.title_path, "
                        "d.title AS document_title, c.ragflow_chunk_id, "
                        "1.0 AS confidence "
                        "FROM knowledge_chunk c "
                        "JOIN knowledge_document d ON d.id = c.document_id "
                        "WHERE c.content LIKE %s "
                        "ORDER BY CHAR_LENGTH(c.content) ASC "
                        "LIMIT %s",
                        (f"%{phrase[:80]}%", top_k),
                    )
                    for row in cursor.fetchall():
                        chunk = self._row_to_chunk(row)
                        chunk_id = chunk.get("chunk_id", "")
                        if chunk_id not in seen_ids:
                            seen_ids.add(chunk_id)
                            results.append(chunk)
                        if len(results) >= top_k:
                            break
                    if len(results) >= top_k:
                        break
                return results

    @staticmethod
    def _row_to_chunk(row) -> dict:
        if isinstance(row, dict):
            return {
                "chunk_id": str(row.get("id", "")),
                "content": str(row.get("content") or "")[:6000],
                "section_title": str(row.get("section_title") or ""),
                "title_path": str(row.get("title_path") or ""),
                "document": str(row.get("document_title") or "知识库资料"),
                "similarity": float(row.get("confidence") or 0.9),
                "ragflow_chunk_id": str(row.get("ragflow_chunk_id") or ""),
                "knowledgeChunkId": row.get("id"),
            }
        # Tuple fallback
        return {
            "chunk_id": str(row[0] if len(row) > 0 else ""),
            "content": str(row[1] or "")[:6000] if len(row) > 1 else "",
            "section_title": str(row[2] or "") if len(row) > 2 else "",
            "title_path": str(row[3] or "") if len(row) > 3 else "",
            "document": str(row[4] or "知识库资料") if len(row) > 4 else "知识库资料",
            "similarity": float(row[6] or 0.9) if len(row) > 6 else 0.9,
            "ragflow_chunk_id": str(row[5] or "") if len(row) > 5 else "",
            "knowledgeChunkId": row[0] if len(row) > 0 else None,
        }
