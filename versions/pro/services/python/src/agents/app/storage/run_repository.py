import json
import threading
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from app.config import Settings
from app.domain.models import AgentEvent, WorkflowState
from app.storage.platform_db import platform_connect


class AgentRunRepository:
    """Agent 运行记录存储（统一使用平台 MySQL，与 Spring Boot 同一实例/库）。

    表结构与 sqlite 版本兼容：id/run_id 使用字符串 UUID，时间戳保留 ISO 文本，
    agent_events 以 (run_id, sequence) 为主键，不依赖自增 id。
    """

    def __init__(self, settings: Settings):
        self.settings = settings
        self._lock = threading.RLock()
        self._initialize()

    def _initialize(self) -> None:
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "CREATE TABLE IF NOT EXISTS agent_runs ("
                    "  id VARCHAR(36) PRIMARY KEY,"
                    "  user_id VARCHAR(36) NOT NULL,"
                    "  learning_goal_id VARCHAR(36) NOT NULL,"
                    "  content TEXT NOT NULL,"
                    "  status VARCHAR(24) NOT NULL,"
                    "  result_json TEXT NULL,"
                    "  errors_json TEXT NOT NULL,"
                    "  created_at VARCHAR(40) NOT NULL,"
                    "  updated_at VARCHAR(40) NOT NULL"
                    ")"
                )
                try:
                    # sqlite（测试假连接）支持 IF NOT EXISTS；MySQL 8 不支持，走下方兜底
                    cursor.execute(
                        "CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created"
                        "  ON agent_runs(user_id, created_at)"
                    )
                except Exception:
                    try:
                        cursor.execute(
                            "CREATE INDEX idx_agent_runs_user_created"
                            "  ON agent_runs(user_id, created_at)"
                        )
                    except Exception:
                        # MySQL 第二次启动时索引已存在（Duplicate key name）
                        pass
                cursor.execute(
                    "CREATE TABLE IF NOT EXISTS agent_events ("
                    "  run_id VARCHAR(36) NOT NULL,"
                    "  sequence INT NOT NULL,"
                    "  event_type VARCHAR(64) NOT NULL,"
                    "  agent VARCHAR(128) NULL,"
                    "  data_json TEXT NOT NULL,"
                    "  created_at VARCHAR(40) NOT NULL,"
                    "  PRIMARY KEY (run_id, sequence),"
                    "  CONSTRAINT fk_agent_events_run FOREIGN KEY (run_id)"
                    "    REFERENCES agent_runs(id) ON DELETE CASCADE"
                    ")"
                )
            connection.commit()

    def create(self, state: WorkflowState) -> None:
        now = state.created_at.isoformat()
        with self._lock, platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO agent_runs(id,user_id,learning_goal_id,content,status,errors_json,created_at,updated_at)"
                    " VALUES(%s,%s,%s,%s,%s,%s,%s,%s)",
                    (str(state.run_id), str(state.user_id), str(state.learning_goal_id), state.content,
                     state.status.value, "[]", now, now),
                )
            connection.commit()

    def save_event(self, event: AgentEvent) -> None:
        with self._lock, platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO agent_events(run_id,sequence,event_type,agent,data_json,created_at)"
                    " VALUES(%s,%s,%s,%s,%s,%s)",
                    (str(event.run_id), event.sequence, event.type, event.agent,
                     json.dumps(event.data, ensure_ascii=False), datetime.now(timezone.utc).isoformat()),
                )
            connection.commit()

    def finish(self, state: WorkflowState) -> None:
        with self._lock, platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE agent_runs SET status=%s,result_json=%s,errors_json=%s,updated_at=%s"
                    " WHERE id=%s AND user_id=%s",
                    (state.status.value, json.dumps(state.final_content, ensure_ascii=False),
                     json.dumps(state.errors, ensure_ascii=False), datetime.now(timezone.utc).isoformat(),
                     str(state.run_id), str(state.user_id)),
                )
            connection.commit()

    def get(self, run_id: UUID, user_id: UUID) -> dict[str, Any] | None:
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM agent_runs WHERE id=%s AND user_id=%s",
                    (str(run_id), str(user_id)),
                )
                row = cursor.fetchone()
                if not row:
                    return None
                cursor.execute(
                    "SELECT sequence,event_type,agent,data_json,created_at FROM agent_events"
                    " WHERE run_id=%s ORDER BY sequence",
                    (str(run_id),),
                )
                events = cursor.fetchall()
        result = dict(row)
        result_json = result.pop("result_json")
        result["result"] = json.loads(result_json) if result_json else None
        result["errors"] = json.loads(result.pop("errors_json"))
        result["events"] = [{**dict(event), "data": json.loads(event["data_json"])} for event in events]
        for event in result["events"]:
            event.pop("data_json", None)
        return result
