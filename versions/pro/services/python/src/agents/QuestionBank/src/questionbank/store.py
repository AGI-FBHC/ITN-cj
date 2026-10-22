"""题库存储层：MySQL（itn-platform 库，knowledge_question* 三张核心表）.

- 连接复用 agents/.env 的 MYSQL_* 配置
- 服务方法可注入外部连接（conn 参数），测试用事务回滚实现零污染验证
"""
from __future__ import annotations

import json
from typing import Any

import pymysql

from questionbank.config import Settings
from questionbank.request_context import get_organization_id


def _conn_params(settings: Settings) -> dict[str, Any]:
    return {
        "host": settings.mysql_host,
        "port": settings.mysql_port,
        "user": settings.mysql_user,
        "password": settings.mysql_password,
        "database": settings.mysql_database,
        "charset": "utf8mb4",
        "connect_timeout": 8,
        "autocommit": False,
        "cursorclass": pymysql.cursors.DictCursor,
    }


class QuestionStore:
    """题目/知识点关联/作答记录的统一 SQL 出口（业务侧不拼 SQL，只走 Service）."""

    def __init__(self, settings: Settings):
        self.settings = settings

    def available(self) -> bool:
        return bool(self.settings.mysql_host and self.settings.mysql_database)

    def connect(self) -> pymysql.Connection:
        return pymysql.connect(**_conn_params(self.settings))

    def _conn(self, conn: pymysql.Connection | None) -> pymysql.Connection:
        return conn if conn is not None else self.connect()

    def close(self, conn: pymysql.Connection | None) -> None:
        if conn is not None:
            conn.close()

    # ── knowledge_question ────────────────────────────────────────────────

    def insert_question(self, row: dict[str, Any], conn: pymysql.Connection | None = None) -> int:
        """插入题目，返回自增 id（content_hash 冲突由调用方先查重）."""
        c = self._conn(conn)
        with c.cursor() as cur:
            cur.execute(
                "INSERT INTO knowledge_question "
                "(scope_type, organization_id, question_type, difficulty, cognitive_level, stem, options, reference_answer, "
                " explanation, status, source_type, evidence_refs, generation_metadata, "
                " content_hash, metadata, created_by) "
                "VALUES ('ORGANIZATION',UUID_TO_BIN(%s),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    self._required_organization_id(),
                    row["question_type"], row["difficulty"], row["cognitive_level"], row["stem"],
                    row.get("options"), row.get("reference_answer"),
                    row.get("explanation"), row["status"], row["source_type"],
                    row.get("evidence_refs"), row.get("generation_metadata"),
                    row["content_hash"], row.get("metadata"), row.get("created_by"),
                ),
            )
            return int(cur.lastrowid)

    def get_question(self, question_id: int, conn: pymysql.Connection | None = None) -> dict | None:
        c = self._conn(conn)
        with c.cursor() as cur:
            clause, params = self._scope_clause()
            cur.execute(f"SELECT * FROM knowledge_question WHERE id = %s AND {clause}", (question_id, *params))
            return self._sanitize_question_row(cur.fetchone())

    def get_question_by_hash(self, content_hash: str, conn: pymysql.Connection | None = None) -> dict | None:
        c = self._conn(conn)
        with c.cursor() as cur:
            clause, params = self._scope_clause()
            cur.execute(f"SELECT * FROM knowledge_question WHERE content_hash = %s AND {clause}", (content_hash, *params))
            return self._sanitize_question_row(cur.fetchone())

    def update_question(
        self, question_id: int, updates: dict[str, Any], conn: pymysql.Connection | None = None
    ) -> None:
        """按白名单字段更新（updates 的 key 必须是 knowledge_question 合法列）."""
        c = self._conn(conn)
        allowed = {
            "question_type", "difficulty", "cognitive_level", "stem", "options",
            "reference_answer", "explanation", "status", "source_type", "evidence_refs",
            "generation_metadata", "content_hash", "metadata",
        }
        cols = [k for k in updates if k in allowed and updates[k] is not None]
        if not cols:
            return
        assignments = ", ".join(f"{col} = %s" for col in cols)
        scope, scope_params = self._scope_clause()
        params = [updates[col] for col in cols] + [question_id, *scope_params]
        with c.cursor() as cur:
            cur.execute(f"UPDATE knowledge_question SET {assignments} WHERE id = %s AND {scope}", params)

    def search_questions(
        self,
        *,
        category_id: int | None = None,
        difficulty: int | None = None,
        question_type: str | None = None,
        cognitive_level: str | None = None,
        status: str | None = None,
        keyword: str | None = None,
        page: int = 0,
        size: int = 20,
        conn: pymysql.Connection | None = None,
    ) -> dict[str, Any]:
        """分页查询题目（支持按知识点关联过滤），返回 {total, items, page, size}."""
        c = self._conn(conn)
        scope, scope_params = self._scope_clause("q")
        where: list[str] = [scope]
        params: list[Any] = list(scope_params)
        if category_id is not None:
            where.append(
                "q.id IN (SELECT kp.question_id FROM knowledge_question_knowledge_point kp "
                "WHERE kp.category_id = %s)"
            )
            params.append(category_id)
        if difficulty is not None:
            where.append("q.difficulty = %s")
            params.append(difficulty)
        if question_type:
            where.append("q.question_type = %s")
            params.append(question_type)
        if cognitive_level:
            where.append("q.cognitive_level = %s")
            params.append(cognitive_level)
        if status:
            where.append("q.status = %s")
            params.append(status)
        if keyword:
            where.append("q.stem LIKE %s")
            params.append(f"%{keyword}%")
        where_sql = f"WHERE {' AND '.join(where)}" if where else ""

        with c.cursor() as cur:
            cur.execute(
                f"SELECT COUNT(*) AS total FROM knowledge_question q {where_sql}", tuple(params)
            )
            total = int(cur.fetchone()["total"])
            offset = max(0, page) * max(1, min(size, 100))
            cur.execute(
                f"SELECT q.* FROM knowledge_question q {where_sql} "
                "ORDER BY q.updated_at DESC, q.id DESC LIMIT %s OFFSET %s",
                (*params, size, offset),
            )
            rows = [self._sanitize_question_row(row) for row in cur.fetchall()]
        return {"total": total, "items": rows, "page": page, "size": size}

    def count_questions(self, conn: pymysql.Connection | None = None) -> int:
        c = self._conn(conn)
        with c.cursor() as cur:
            scope, params = self._scope_clause()
            cur.execute(f"SELECT COUNT(*) AS total FROM knowledge_question WHERE {scope}", params)
            return int(cur.fetchone()["total"])

    def _required_organization_id(self) -> str:
        value = get_organization_id()
        if not value:
            raise PermissionError("缺少机构上下文，禁止写入题库")
        return value

    def _scope_clause(self, alias: str | None = None) -> tuple[str, tuple[str, ...]]:
        prefix = f"{alias}." if alias else ""
        organization_id = get_organization_id()
        if not organization_id:
            return f"{prefix}scope_type = 'PLATFORM'", ()
        return f"({prefix}scope_type = 'PLATFORM' OR {prefix}organization_id = UUID_TO_BIN(%s))", (organization_id,)

    @staticmethod
    def _sanitize_question_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if row is None:
            return None
        row.pop("organization_id", None)
        row.pop("scope_type", None)
        return row

    # ── knowledge_question_knowledge_point ────────────────────────────────

    def replace_knowledge_points(
        self,
        question_id: int,
        points: list[dict[str, Any]],
        conn: pymysql.Connection | None = None,
    ) -> None:
        """整体替换题目-知识点关联（先删后插，保持 role/weight）."""
        c = self._conn(conn)
        with c.cursor() as cur:
            cur.execute("DELETE FROM knowledge_question_knowledge_point WHERE question_id = %s", (question_id,))
            for p in points:
                cur.execute(
                    "INSERT INTO knowledge_question_knowledge_point "
                    "(question_id, category_id, role, weight) VALUES (%s,%s,%s,%s)",
                    (question_id, p["category_id"], p.get("role", "primary"), p.get("weight", 1.0)),
                )

    def list_knowledge_points(
        self, question_id: int, conn: pymysql.Connection | None = None
    ) -> list[dict[str, Any]]:
        c = self._conn(conn)
        with c.cursor() as cur:
            cur.execute(
                "SELECT category_id, role, weight FROM knowledge_question_knowledge_point "
                "WHERE question_id = %s ORDER BY role = 'primary' DESC, weight DESC",
                (question_id,),
            )
            return cur.fetchall()

    # ── knowledge_question_attempt ─────────────────────────────────────────

    def insert_attempt(
        self,
        row: dict[str, Any],
        conn: pymysql.Connection | None = None,
    ) -> int:
        """插入作答记录，返回自增 id."""
        c = self._conn(conn)
        with c.cursor() as cur:
            cur.execute(
                "INSERT INTO knowledge_question_attempt "
                "(user_id, question_id, submitted_answer, is_correct, score, judge_details, "
                " started_at, submitted_at, duration_ms) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    row["user_id"], row["question_id"], row.get("submitted_answer"),
                    row.get("is_correct"), row.get("score"), row.get("judge_details"),
                    row.get("started_at"), row.get("submitted_at"), row.get("duration_ms"),
                ),
            )
            return int(cur.lastrowid)

    def list_attempts(
        self,
        user_id: str,
        *,
        question_id: int | None = None,
        page: int = 0,
        size: int = 20,
        conn: pymysql.Connection | None = None,
    ) -> dict[str, Any]:
        c = self._conn(conn)
        where = ["user_id = %s"]
        params: list[Any] = [user_id]
        if question_id is not None:
            where.append("question_id = %s")
            params.append(question_id)
        where_sql = " AND ".join(where)
        with c.cursor() as cur:
            cur.execute(
                f"SELECT COUNT(*) AS total FROM knowledge_question_attempt WHERE {where_sql}",
                tuple(params),
            )
            total = int(cur.fetchone()["total"])
            offset = max(0, page) * max(1, min(size, 100))
            cur.execute(
                f"SELECT * FROM knowledge_question_attempt WHERE {where_sql} "
                "ORDER BY submitted_at DESC, id DESC LIMIT %s OFFSET %s",
                (*params, size, offset),
            )
            rows = cur.fetchall()
        return {"total": total, "items": rows, "page": page, "size": size}

    def recent_attempt_question_ids(
        self,
        user_id: str,
        days: int,
        conn: pymysql.Connection | None = None,
    ) -> list[int]:
        """用户近 N 天做过的题目 id（Selector 排除重复刷题用）."""
        if days <= 0:
            return []
        c = self._conn(conn)
        with c.cursor() as cur:
            cur.execute(
                "SELECT DISTINCT question_id FROM knowledge_question_attempt "
                "WHERE user_id = %s AND submitted_at >= DATE_SUB(NOW(), INTERVAL %s DAY)",
                (user_id, days),
            )
            return [int(r["question_id"]) for r in cur.fetchall()]

    def wrong_question_ids(
        self,
        user_id: str,
        conn: pymysql.Connection | None = None,
    ) -> list[int]:
        """用户最近一次作答答错的题目 id（错题优先策略用）."""
        c = self._conn(conn)
        with c.cursor() as cur:
            cur.execute(
                "SELECT question_id FROM knowledge_question_attempt a "
                "WHERE user_id = %s AND is_correct = 0 "
                "AND submitted_at = (SELECT MAX(a2.submitted_at) FROM knowledge_question_attempt a2 "
                "    WHERE a2.user_id = a.user_id AND a2.question_id = a.question_id) "
                "ORDER BY submitted_at DESC",
                (user_id,),
            )
            return [int(r["question_id"]) for r in cur.fetchall()]

    def question_stats(
        self,
        question_id: int,
        conn: pymysql.Connection | None = None,
    ) -> dict[str, Any]:
        """单题作答统计：次数 / 答对数 / 正确率 / 最近正确率（近 20 次）."""
        c = self._conn(conn)
        with c.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) AS total, "
                "       COALESCE(SUM(is_correct = 1), 0) AS correct "
                "FROM knowledge_question_attempt WHERE question_id = %s",
                (question_id,),
            )
            row = cur.fetchone()
            cur.execute(
                "SELECT COUNT(*) AS total, COALESCE(SUM(is_correct = 1), 0) AS correct "
                "FROM (SELECT is_correct FROM knowledge_question_attempt WHERE question_id = %s "
                "      AND is_correct IS NOT NULL ORDER BY submitted_at DESC LIMIT 20) t",
                (question_id,),
            )
            recent = cur.fetchone()
        total = int(row["total"])
        correct = int(row["correct"])
        recent_total = int(recent["total"])
        recent_correct = int(recent["correct"])
        return {
            "total_attempts": total,
            "correct_count": correct,
            "accuracy": round(correct / total, 4) if total else None,
            "recent_accuracy": round(recent_correct / recent_total, 4) if recent_total else None,
        }

    # ── 统计（题库看板） ───────────────────────────────────────────────────

    def stats_overview(self, conn: pymysql.Connection | None = None) -> dict[str, Any]:
        """题库总览：总数 / 按状态 / 按题型 / 按难度."""
        c = self._conn(conn)
        scope, params = self._scope_clause()
        with c.cursor() as cur:
            cur.execute(f"SELECT status, COUNT(*) AS n FROM knowledge_question WHERE {scope} GROUP BY status", params)
            by_status = {r["status"]: int(r["n"]) for r in cur.fetchall()}
            cur.execute(f"SELECT question_type, COUNT(*) AS n FROM knowledge_question WHERE {scope} GROUP BY question_type", params)
            by_type = {r["question_type"]: int(r["n"]) for r in cur.fetchall()}
            cur.execute(f"SELECT difficulty, COUNT(*) AS n FROM knowledge_question WHERE {scope} GROUP BY difficulty", params)
            by_difficulty = {int(r["difficulty"]): int(r["n"]) for r in cur.fetchall()}
            cur.execute(f"SELECT COUNT(*) AS n FROM knowledge_question WHERE {scope}", params)
            total = int(cur.fetchone()["n"])
        return {
            "total": total,
            "by_status": by_status,
            "by_type": by_type,
            "by_difficulty": by_difficulty,
        }

    def stats_by_category(self, conn: pymysql.Connection | None = None) -> list[dict[str, Any]]:
        """按知识点（primary 关联，一道题只归属一次）聚合：总题数 / active 数 / 各难度题数."""
        c = self._conn(conn)
        scope, params = self._scope_clause("q")
        with c.cursor() as cur:
            cur.execute(
                "SELECT kp.category_id, c.name, q.status, q.difficulty, COUNT(*) AS n "
                "FROM knowledge_question_knowledge_point kp "
                "JOIN knowledge_question q ON q.id = kp.question_id "
                "JOIN knowledge_category c ON c.id = kp.category_id "
                f"WHERE kp.role = 'primary' AND {scope} "
                "GROUP BY kp.category_id, c.name, q.status, q.difficulty "
                "ORDER BY c.name",
                params,
            )
            rows = cur.fetchall()
        grouped: dict[int, dict[str, Any]] = {}
        for r in rows:
            cid = int(r["category_id"])
            item = grouped.setdefault(
                cid,
                {
                    "category_id": cid,
                    "name": r["name"],
                    "total": 0,
                    "active": 0,
                    "by_difficulty": {d: 0 for d in range(1, 6)},
                    "by_status": {},
                },
            )
            n = int(r["n"])
            item["total"] += n
            item["by_difficulty"][int(r["difficulty"])] += n
            item["by_status"][r["status"]] = item["by_status"].get(r["status"], 0) + n
            if r["status"] == "active":
                item["active"] += n
        return list(grouped.values())

    # ── user_knowledge_state（T4.1 掌握度） ─────────────────────────────────

    def list_attempts_for_mastery(
        self, user_id: str, category_id: int, conn: pymysql.Connection | None = None
    ) -> list[dict[str, Any]]:
        """用户在某知识点下的历史作答（is_correct/submitted_at），供 mastery 计算用.

        知识点关联走 knowledge_question_knowledge_point（任意 role，不限 primary）——
        一道题被标了该知识点即视为该知识点的一次作答证据。
        """
        c = self._conn(conn)
        with c.cursor() as cur:
            cur.execute(
                "SELECT a.is_correct, a.submitted_at FROM knowledge_question_attempt a "
                "JOIN knowledge_question_knowledge_point kp ON kp.question_id = a.question_id "
                "WHERE a.user_id = %s AND kp.category_id = %s",
                (user_id, category_id),
            )
            return cur.fetchall()

    def upsert_knowledge_state(
        self,
        user_id: str,
        category_id: int,
        mastery: float,
        evidence_count: int,
        conn: pymysql.Connection | None = None,
    ) -> None:
        c = self._conn(conn)
        with c.cursor() as cur:
            cur.execute(
                "INSERT INTO user_knowledge_state (user_id, category_id, mastery, evidence_count, updated_at) "
                "VALUES (%s, %s, %s, %s, NOW()) "
                "ON DUPLICATE KEY UPDATE mastery = VALUES(mastery), "
                "evidence_count = VALUES(evidence_count), updated_at = VALUES(updated_at)",
                (user_id, category_id, mastery, evidence_count),
            )

    def list_knowledge_state(
        self, user_id: str, conn: pymysql.Connection | None = None
    ) -> list[dict[str, Any]]:
        c = self._conn(conn)
        with c.cursor() as cur:
            cur.execute(
                "SELECT category_id, mastery, evidence_count, updated_at "
                "FROM user_knowledge_state WHERE user_id = %s ORDER BY category_id",
                (user_id,),
            )
            return cur.fetchall()

    def question_ids_by_category(
        self, category_ids: list[int], conn: pymysql.Connection | None = None
    ) -> set[int]:
        """给定知识点集合，返回关联到这些知识点（任意角色）的题目 id 集合（T4.2 frontier 选题用）."""
        ids = [int(c) for c in category_ids if c is not None]
        if not ids:
            return set()
        c = self._conn(conn)
        placeholders = ",".join(["%s"] * len(ids))
        with c.cursor() as cur:
            cur.execute(
                f"SELECT DISTINCT question_id FROM knowledge_question_knowledge_point "
                f"WHERE category_id IN ({placeholders})",
                tuple(ids),
            )
            return {int(r["question_id"]) for r in cur.fetchall()}

    # ── T4.3 作答数据投票（graph-vote：先修边有效性双样本比例检验） ──────────

    def list_prerequisite_edges(
        self,
        statuses: tuple[str, ...] = ("proposed", "active"),
        conn: pymysql.Connection | None = None,
    ) -> list[dict[str, Any]]:
        """读 knowledge_category_prerequisite 先修边（KnowledgeCore 拥有的表，同库直读）."""
        c = self._conn(conn)
        placeholders = ",".join(["%s"] * len(statuses))
        with c.cursor() as cur:
            cur.execute(
                f"SELECT id, domain_id, category_id, prereq_category_id, edge_type, "
                f"confidence, status, evidence_json FROM knowledge_category_prerequisite "
                f"WHERE status IN ({placeholders}) "
                f"AND edge_type IN ('prerequisite','cross_domain_prerequisite')",
                tuple(statuses),
            )
            return cur.fetchall()

    def attempt_correctness_grouped_by_prereq_mastery(
        self,
        category_id: int,
        prereq_category_id: int,
        *,
        high_threshold: float = 0.7,
        low_threshold: float = 0.4,
        conn: pymysql.Connection | None = None,
    ) -> dict[str, list[int]]:
        """B（category_id）知识点相关题的作答，按作答者对 A（prereq_category_id）
        的掌握度分组：高组 mastery>=high_threshold，低组 mastery<low_threshold
        （中间地带样本丢弃，与手册"≥0.7 vs <0.4"口径一致）.

        返回 {"high": [0/1,...], "low": [0/1,...]}（is_correct 转 int，NULL 已排除）。
        """
        c = self._conn(conn)
        with c.cursor() as cur:
            cur.execute(
                "SELECT a.is_correct AS is_correct, s.mastery AS mastery "
                "FROM knowledge_question_attempt a "
                "JOIN knowledge_question_knowledge_point kp ON kp.question_id = a.question_id "
                "JOIN user_knowledge_state s ON s.user_id = a.user_id AND s.category_id = %s "
                "WHERE kp.category_id = %s AND a.is_correct IS NOT NULL",
                (prereq_category_id, category_id),
            )
            rows = cur.fetchall()
        high = [int(r["is_correct"]) for r in rows if float(r["mastery"]) >= high_threshold]
        low = [int(r["is_correct"]) for r in rows if float(r["mastery"]) < low_threshold]
        return {"high": high, "low": low}

    def patch_prerequisite_edge_vote(
        self,
        edge_id: int,
        *,
        confidence: float | None = None,
        vote: dict[str, Any] | None = None,
        needs_review: bool = False,
        conn: pymysql.Connection | None = None,
    ) -> None:
        """PATCH knowledge_category_prerequisite.confidence 与 evidence_json.vote（T4.3）.

        JSON_SET 合并写 evidence_json，不覆盖 T3.2 已写入的 concept/def_chunk/use_chunk 等字段；
        显著为负时把 needs_review=True 一并置 status='needs_review'（调用方守门，见 cli.py）。
        """
        c = self._conn(conn)
        sets: list[str] = []
        params: list[Any] = []
        if confidence is not None:
            sets.append("confidence = %s")
            params.append(confidence)
        if vote is not None:
            sets.append(
                "evidence_json = JSON_SET(COALESCE(evidence_json, JSON_OBJECT()), "
                "'$.vote', CAST(%s AS JSON))"
            )
            params.append(json.dumps(vote, ensure_ascii=False, default=str))
        if needs_review:
            sets.append("status = 'needs_review'")
        if not sets:
            return
        params.append(edge_id)
        with c.cursor() as cur:
            cur.execute(
                f"UPDATE knowledge_category_prerequisite SET {', '.join(sets)} WHERE id = %s",
                params,
            )

    # ── 证据切片反查（阶段 8 知识变更重校验） ───────────────────────────────

    def question_ids_by_evidence_chunks(
        self,
        chunk_ids: list[int],
        conn: pymysql.Connection | None = None,
    ) -> list[int]:
        """引用指定知识切片的题目 id（evidence_refs JSON 反查）."""
        ids = [int(c) for c in chunk_ids if int(c) > 0]
        if not ids:
            return []
        c = self._conn(conn)
        result: list[int] = []
        with c.cursor() as cur:
            for cid in ids:
                cur.execute(
                    "SELECT id FROM knowledge_question WHERE status <> 'deprecated' "
                    "AND JSON_CONTAINS(JSON_EXTRACT(evidence_refs, '$[*].chunk_id'), CAST(%s AS JSON))",
                    (cid,),
                )
                result.extend(int(r["id"]) for r in cur.fetchall())
        return sorted(set(result))
