"""Durable upload-task storage owned by the platform Flyway schema."""

from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Any

import pymysql
from pymysql.cursors import DictCursor


def _connect():
    return pymysql.connect(
        host=os.environ.get("MYSQL_HOST"), port=int(os.environ.get("MYSQL_PORT", "3306")),
        user=os.environ.get("MYSQL_USER"), password=os.environ.get("MYSQL_PASSWORD"),
        database=os.environ.get("MYSQL_DATABASE"), charset="utf8mb4", autocommit=True,
        cursorclass=DictCursor,
    )


def create_task(task: dict[str, Any], organization_id: str, user_id: str, content_sha256: str) -> tuple[str, bool]:
    """Create an idempotent task; return (task_id, reused)."""
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM predeal_upload_tasks WHERE organization_id=UUID_TO_BIN(%s) "
            "AND domain_code=%s AND content_sha256=%s LIMIT 1",
            (organization_id, task["domain"], content_sha256),
        )
        existing = cur.fetchone()
        if existing:
            return str(existing["id"]), True
        cur.execute(
            "INSERT INTO predeal_upload_tasks "
            "(id,organization_id,created_by,domain_code,original_file_name,content_sha256,options_json,status,current_stage,progress) "
            "VALUES(%s,UUID_TO_BIN(%s),UUID_TO_BIN(%s),%s,%s,%s,%s,'queued','queued',0)",
            (task["id"], organization_id, user_id, task["domain"], task["file_name"], content_sha256,
             json.dumps(task["params"], ensure_ascii=False)),
        )
        append_event(cur, task["id"], "queued", "info", "任务已进入处理队列")
        return task["id"], False


def append_event(cur, task_id: str, stage: str, level: str, message: str, details: Any = None) -> None:
    cur.execute("SELECT COALESCE(MAX(sequence_no),0)+1 AS seq FROM predeal_upload_events WHERE task_id=%s", (task_id,))
    seq = int(cur.fetchone()["seq"])
    cur.execute(
        "INSERT INTO predeal_upload_events(task_id,sequence_no,stage,level,message,details_json) VALUES(%s,%s,%s,%s,%s,%s)",
        (task_id, seq, stage, level, message[:1000], json.dumps(details, ensure_ascii=False, default=str) if details else None),
    )


def progress(task_id: str, stage: str, step_num: int, status: str, message: str) -> None:
    percent = max(1, min(95, round(step_num / 13 * 95)))
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE predeal_upload_tasks SET status='running',current_stage=%s,progress=%s,started_at=COALESCE(started_at,NOW(6)) WHERE id=%s",
            (stage, percent, task_id),
        )
        append_event(cur, task_id, stage, "error" if status == "failed" else "info", message,
                     {"step_num": step_num, "status": status})


def finish(task_id: str, result: dict[str, Any]) -> None:
    raw_status = str(result.get("status", "completed")).lower()
    ragflow = result.get("ragflow_result") or result.get("ragflow") or {}
    partial = raw_status not in {"failed", "error"} and isinstance(ragflow, dict) and ragflow.get("status") in {"failed", "error"}
    status = "partial" if partial else ("cancelled" if raw_status == "cancelled" else ("failed" if raw_status in {"failed", "error"} else "completed"))
    document_id = result.get("db_document_id")
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE predeal_upload_tasks SET status=%s,current_stage=%s,progress=%s,document_id=%s,result_json=%s,"
            "retry_from_stage=%s,finished_at=NOW(6) WHERE id=%s",
            (status, "uploading_ragflow" if partial else status, 100 if status == "completed" else (0 if status == "cancelled" else 95),
             document_id, json.dumps(result, ensure_ascii=False, default=str), "uploading_ragflow" if partial else None, task_id),
        )
        append_event(cur, task_id, status, "warning" if partial else "info", "任务部分完成" if partial else "任务处理完成")


def requeue(task_id: str) -> None:
    """Reset a failed/partial/cancelled task so the pipeline can run again."""
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE predeal_upload_tasks SET status='queued',current_stage='queued',progress=0,"
            "document_id=NULL,result_json=NULL,warning_json=NULL,error_code=NULL,error_message=NULL,"
            "retry_from_stage=NULL,cancel_requested=0,started_at=NULL,finished_at=NULL WHERE id=%s",
            (task_id,),
        )
        append_event(cur, task_id, "queued", "info", "任务重新进入处理队列")


def fail(task_id: str, error: Exception) -> None:
    message = str(error)[:1000]
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE predeal_upload_tasks SET status='failed',error_code='PIPELINE_FAILED',error_message=%s,finished_at=NOW(6) WHERE id=%s",
            (message, task_id),
        )
        append_event(cur, task_id, "failed", "error", message)


def is_cancel_requested(task_id: str) -> bool:
    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT cancel_requested FROM predeal_upload_tasks WHERE id=%s", (task_id,))
        row = cur.fetchone()
        return bool(row and row["cancel_requested"])


def cancel(task_id: str, organization_id: str) -> bool:
    with _connect() as conn, conn.cursor() as cur:
        changed = cur.execute(
            "UPDATE predeal_upload_tasks SET cancel_requested=1,finished_at=IF(status='queued',NOW(6),finished_at),"
            "status=IF(status='queued','cancelled',status) WHERE id=%s AND organization_id=UUID_TO_BIN(%s) "
            "AND status IN ('queued','running')", (task_id, organization_id))
        if changed:
            append_event(cur, task_id, "cancel_requested", "warning", "管理员请求取消任务")
        return bool(changed)


def get_task(task_id: str, organization_id: str) -> dict[str, Any] | None:
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id,original_file_name AS file_name,domain_code AS domain,status,current_stage,progress,"
            "options_json AS params,result_json AS result,error_code,error_message,cancel_requested,created_at,updated_at "
            "FROM predeal_upload_tasks WHERE id=%s AND organization_id=UUID_TO_BIN(%s)",
            (task_id, organization_id),
        )
        return _normalize(cur.fetchone())


def list_tasks(organization_id: str, page: int, size: int) -> dict[str, Any]:
    size = max(1, min(size, 100)); page = max(0, page)
    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM predeal_upload_tasks WHERE organization_id=UUID_TO_BIN(%s)", (organization_id,))
        total = int(cur.fetchone()["n"])
        cur.execute(
            "SELECT id,original_file_name AS file_name,domain_code AS domain,status,current_stage,progress,"
            "options_json AS params,result_json AS result,error_code,error_message,cancel_requested,created_at,updated_at "
            "FROM predeal_upload_tasks WHERE organization_id=UUID_TO_BIN(%s) ORDER BY created_at DESC LIMIT %s OFFSET %s",
            (organization_id, size, page * size),
        )
        return {"items": [_normalize(row) for row in cur.fetchall()], "total": total, "page": page, "size": size}


def list_events(task_id: str, organization_id: str) -> list[dict[str, Any]] | None:
    if get_task(task_id, organization_id) is None:
        return None
    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT sequence_no,stage,level,message,details_json AS details,created_at FROM predeal_upload_events WHERE task_id=%s ORDER BY sequence_no", (task_id,))
        return [_normalize(row) for row in cur.fetchall()]


def _normalize(row):
    if row is None: return None
    for key, value in list(row.items()):
        if key in {"params", "result", "details"} and isinstance(value, str):
            try: row[key] = json.loads(value)
            except json.JSONDecodeError: row[key] = None
        elif isinstance(value, datetime): row[key] = value.isoformat()
    return row
