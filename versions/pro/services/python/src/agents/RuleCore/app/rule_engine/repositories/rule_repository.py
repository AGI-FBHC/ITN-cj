"""Rule Repository（domain_rule / rule_execution / rule_compare 表访问）."""
from __future__ import annotations

import json
from typing import Any

from app.core.database import db_session
from app.rule_engine.schemas import DomainRuleSchema

RULE_COLUMNS = (
    "id, rule_code, name, rule_type, conditions_json, conclusions_json, "
    "source_document_id, source_chunk_id, source_section, source_text, "
    "confidence, status, reject_reason, created_at, updated_at"
)


def _row_to_schema(row: dict) -> DomainRuleSchema:
    return DomainRuleSchema.model_validate({
        "rule_code": row["rule_code"],
        "name": row["name"],
        "conditions": json.loads(row["conditions_json"]) if isinstance(row["conditions_json"], str) else row["conditions_json"],
        "conclusions": json.loads(row["conclusions_json"]) if isinstance(row["conclusions_json"], str) else row["conclusions_json"],
        "source_text": row["source_text"],
        "source_section": row.get("source_section"),
        "source_document_id": row.get("source_document_id"),
        "source_chunk_id": row.get("source_chunk_id"),
        "confidence": float(row.get("confidence") or 0.0),
    })


def upsert_rule(rule: DomainRuleSchema, status: str,
                reject_reason: str | None = None) -> int:
    """插入或按 rule_code 更新。返回规则 id."""
    with db_session() as cur:
        cur.execute(
            f"INSERT INTO domain_rule "
            f"(rule_code, name, rule_type, conditions_json, conclusions_json, "
            f" source_document_id, source_chunk_id, source_section, source_text, "
            f" confidence, status, reject_reason) "
            f"VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
            f"ON DUPLICATE KEY UPDATE "
            f" name=VALUES(name), conditions_json=VALUES(conditions_json), "
            f" conclusions_json=VALUES(conclusions_json), "
            f" source_section=VALUES(source_section), source_text=VALUES(source_text), "
            f" confidence=VALUES(confidence), status=VALUES(status), "
            f" reject_reason=VALUES(reject_reason)",
            (
                rule.rule_code,
                rule.name,
                "extracted",
                json.dumps([c.model_dump() for c in rule.conditions], ensure_ascii=False),
                json.dumps([c.model_dump() for c in rule.conclusions], ensure_ascii=False),
                rule.source_document_id,
                rule.source_chunk_id,
                rule.source_section,
                rule.source_text,
                rule.confidence,
                status,
                reject_reason,
            ),
        )
        cur.execute("SELECT LAST_INSERT_ID() AS id")
        row = cur.fetchone()
        return int(row["id"])


def get_active_rules(document_id: int | None = None) -> list[DomainRuleSchema]:
    with db_session() as cur:
        if document_id is not None:
            cur.execute(
                f"SELECT {RULE_COLUMNS} FROM domain_rule "
                "WHERE status='ACTIVE' AND source_document_id=%s ORDER BY id",
                (document_id,),
            )
        else:
            cur.execute(
                f"SELECT {RULE_COLUMNS} FROM domain_rule "
                "WHERE status='ACTIVE' ORDER BY id"
            )
        return [_row_to_schema(r) for r in cur.fetchall()]


def get_rules(document_id: int | None = None, status: str | None = None,
              keyword: str | None = None, limit: int = 200) -> list[dict]:
    sql = f"SELECT {RULE_COLUMNS} FROM domain_rule WHERE 1=1"
    args: list[Any] = []
    if document_id is not None:
        sql += " AND source_document_id=%s"
        args.append(document_id)
    if status:
        sql += " AND status=%s"
        args.append(status)
    if keyword:
        sql += " AND (name LIKE %s OR source_text LIKE %s OR rule_code LIKE %s)"
        args += [f"%{keyword}%"] * 3
    sql += " ORDER BY id LIMIT %s"
    args.append(limit)
    with db_session() as cur:
        cur.execute(sql, args)
        rows = cur.fetchall()
    out = []
    for r in rows:
        d = dict(r)
        for col in ("conditions_json", "conclusions_json"):
            if isinstance(d.get(col), str):
                d[col] = json.loads(d[col])
        d["confidence"] = float(d.get("confidence") or 0.0)
        out.append(d)
    return out


def get_rule(rule_id: int) -> dict | None:
    with db_session() as cur:
        cur.execute(f"SELECT {RULE_COLUMNS} FROM domain_rule WHERE id=%s", (rule_id,))
        r = cur.fetchone()
    if not r:
        return None
    d = dict(r)
    for col in ("conditions_json", "conclusions_json"):
        if isinstance(d.get(col), str):
            d[col] = json.loads(d[col])
    d["confidence"] = float(d.get("confidence") or 0.0)
    return d


def record_execution(
    request_id: str,
    rule: DomainRuleSchema | None,
    matched: bool,
    input_facts: dict,
    derived_facts: dict | None = None,
    conclusions: list | None = None,
    arm: str | None = None,
) -> None:
    with db_session() as cur:
        cur.execute(
            "INSERT INTO rule_execution "
            "(request_id, rule_id, rule_code, input_facts_json, matched, "
            " derived_facts_json, conclusions_json, check_status, arm) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                request_id,
                getattr(rule, "id", None),
                rule.rule_code if rule else None,
                json.dumps(input_facts, ensure_ascii=False),
                1 if matched else 0,
                json.dumps(derived_facts or {}, ensure_ascii=False),
                json.dumps(conclusions or [], ensure_ascii=False),
                "PENDING",
                arm,
            ),
        )


def set_check_result(request_id: str, rule_code: str, status: str,
                     evidence: str | None) -> None:
    with db_session() as cur:
        cur.execute(
            "UPDATE rule_execution SET check_status=%s, check_evidence=%s "
            "WHERE request_id=%s AND rule_code=%s",
            (status, evidence, request_id, rule_code),
        )


def get_executions(request_id: str) -> list[dict]:
    with db_session() as cur:
        cur.execute(
            "SELECT * FROM rule_execution WHERE request_id=%s ORDER BY id",
            (request_id,),
        )
        rows = cur.fetchall()
    out = []
    for r in rows:
        d = dict(r)
        for col in ("input_facts_json", "derived_facts_json", "conclusions_json"):
            if isinstance(d.get(col), str):
                d[col] = json.loads(d[col])
        d["matched"] = bool(d.get("matched"))
        out.append(d)
    return out
