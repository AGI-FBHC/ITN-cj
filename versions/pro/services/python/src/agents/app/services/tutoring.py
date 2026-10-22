from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from datetime import datetime
from pathlib import Path
from uuid import UUID, uuid4

from app.config import Settings
from app.domain.models import TutoringAnswerRequest
from app.storage.learning_resources import LearningResourceStore
from app.storage.platform_db import platform_connect

_SCRIPTS_PATH = Path(__file__).resolve().parent.parent / "resources" / "tutoring_scripts.json"


class TutoringStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._schema_ready = False

    def ensure_schema(self) -> None:
        if self._schema_ready:
            return
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS tutoring_sessions (
                      id BINARY(16) PRIMARY KEY,
                      user_id BINARY(16) NOT NULL,
                      learner_code VARCHAR(64) NOT NULL,
                      kp_id VARCHAR(64) NULL,
                      script_title VARCHAR(255) NULL,
                      status VARCHAR(32) NOT NULL DEFAULT 'running',
                      current_node_id VARCHAR(64) NULL,
                      level INT NOT NULL DEFAULT 2,
                      messages_json TEXT NULL,
                      answers_json TEXT NULL,
                      decisions_json TEXT NULL,
                      score_before INT NOT NULL DEFAULT 50,
                      score_after INT NULL,
                      created_at TIMESTAMP(6) NOT NULL,
                      updated_at TIMESTAMP(6) NOT NULL,
                      INDEX idx_tutoring_session_user (user_id, updated_at)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
            connection.commit()
        self._schema_ready = True

    def create(self, user_id: UUID, learner_code: str, kp_id: str, title: str,
               current_node_id: str, messages: list[dict], score_before: int) -> dict:
        self.ensure_schema()
        session_id, now = uuid4(), datetime.utcnow()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO tutoring_sessions "
                    "(id,user_id,learner_code,kp_id,script_title,status,current_node_id,level,messages_json,answers_json,decisions_json,score_before,created_at,updated_at) "
                    "VALUES(%s,%s,%s,%s,%s,'running',%s,2,%s,'[]','[]',%s,%s,%s)",
                    (session_id.bytes, user_id.bytes, learner_code, kp_id, title,
                     current_node_id, json.dumps(messages, ensure_ascii=False),
                     score_before, now, now),
                )
            connection.commit()
        return self.get(session_id, user_id)

    def get(self, session_id: UUID, user_id: UUID) -> dict | None:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT * FROM tutoring_sessions WHERE id=%s AND user_id=%s",
                    (session_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
        if not row:
            return None
        return {
            "id": str(UUID(bytes=row["id"])),
            "learnerCode": row["learner_code"],
            "kpId": row["kp_id"],
            "scriptTitle": row["script_title"],
            "status": row["status"],
            "currentNodeId": row["current_node_id"],
            "level": row["level"],
            "messages": json.loads(row["messages_json"] or "[]"),
            "answers": json.loads(row["answers_json"] or "[]"),
            "decisions": json.loads(row["decisions_json"] or "[]"),
            "scoreBefore": row["score_before"],
            "scoreAfter": row["score_after"],
            "createdAt": row["created_at"].isoformat(),
            "updatedAt": row["updated_at"].isoformat(),
        }

    def save(self, session_id: UUID, user_id: UUID, current_node_id: str | None,
             status: str, level: int, messages: list[dict], answers: list[bool],
             decisions: list[dict], score_after: int | None = None) -> dict:
        self.ensure_schema()
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE tutoring_sessions SET current_node_id=%s,status=%s,level=%s,"
                    "messages_json=%s,answers_json=%s,decisions_json=%s,score_after=%s,updated_at=%s "
                    "WHERE id=%s AND user_id=%s",
                    (current_node_id, status, level,
                     json.dumps(messages, ensure_ascii=False),
                     json.dumps(answers, ensure_ascii=False),
                     json.dumps(decisions, ensure_ascii=False),
                     score_after, datetime.utcnow(), session_id.bytes, user_id.bytes),
                )
            connection.commit()
        return self.get(session_id, user_id)


class TutoringService:
    def __init__(self, settings: Settings):
        self.store = TutoringStore(settings)
        self.settings = settings
        self.resource_store = LearningResourceStore(settings)

    def scripts(self) -> list[dict]:
        with open(_SCRIPTS_PATH, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def get_script(self, learner_code: str, user_id: UUID | None = None) -> dict | None:
        code = learner_code.strip().lower()
        if code.startswith("resource:") and user_id is not None:
            try:
                resource_id = UUID(code.split(":", 1)[1])
            except ValueError:
                return None
            resource = self.resource_store.get(resource_id, user_id)
            return self._script_from_quiz(resource) if resource else None
        return next((script for script in self.scripts() if script.get("learnerId") == code), None)

    def create_session(self, user_id: UUID, learner_code: str | None = None,
                       resource_id: UUID | None = None) -> dict:
        if resource_id is not None:
            learner_code = f"resource:{resource_id}"
        if not learner_code:
            raise ValueError("learnerCode or resourceId is required")
        script = self.get_script(learner_code, user_id)
        if script is None:
            raise KeyError("tutoring script not found")
        messages: list[dict] = []
        decisions: list[dict] = []
        messages, decisions, level, current_node = self._enter_node(
            messages, decisions, 2, script, script["startId"],
        )
        score_before = self._score_before(user_id, learner_code, script.get("kpId"))
        session = self.store.create(
            user_id, learner_code, script.get("kpId") or "", script.get("title") or "",
            current_node, messages, score_before,
        )
        return self._enrich_session(user_id, session, script)

    def get_session(self, user_id: UUID, session_id: UUID) -> dict | None:
        session = self.store.get(session_id, user_id)
        return self._enrich_session(user_id, session) if session else None

    def answer(self, user_id: UUID, session_id: UUID, request: TutoringAnswerRequest) -> dict:
        session = self.store.get(session_id, user_id)
        if session is None:
            raise KeyError("session not found")
        if session["status"] == "completed":
            raise ValueError("tutoring session already completed")
        script = self.get_script(session["learnerCode"], user_id)
        if script is None:
            raise KeyError("tutoring script not found")
        node = script["nodes"].get(session["currentNodeId"])
        if node is None:
            raise ValueError("invalid current node")
        options = node.get("options") or []
        selected = None
        text = request.free_text
        if request.option_index is not None:
            if request.option_index >= len(options):
                raise ValueError("invalid option index")
            selected = options[request.option_index]
            text = selected.get("label")
        elif request.option_label is not None:
            selected = next((o for o in options if o.get("label") == request.option_label), None)
            if selected is None:
                raise ValueError("invalid option label")
            text = selected.get("label")
        elif request.free_text is not None:
            text = request.free_text
            selected = self._match_free_text(request.free_text, options)
        if text is None or not str(text).strip():
            raise ValueError("answer is required")

        messages = list(session.get("messages") or [])
        answers = list(session.get("answers") or [])
        decisions = list(session.get("decisions") or [])
        level = int(session.get("level") or 2)
        messages.append({"kind": "learner", "text": str(text)})
        if request.free_text is not None and selected is None:
            messages.append({
                "kind": "feedback",
                "verdict": "wrong",
                "text": "我已经记下你的想法，但暂时无法稳定映射到本题选项。可以补充关键词，或点一个最接近的快答继续。",
            })
            return self._enrich_session(user_id, self.store.save(
                session_id, user_id, session["currentNodeId"], "running", level,
                messages, answers, decisions, None,
            ), script)
        if selected is not None and selected.get("correct") is not None:
            correct = bool(selected["correct"])
            answers.append(correct)
            messages.append({
                "kind": "feedback",
                "verdict": "correct" if correct else "wrong",
                "text": "答对了，这一步的因果链你已经抓住了。" if correct else "先别急，换个角度再想想。",
            })
        target = selected.get("next") if selected is not None else None
        if target is None and selected is None:
            target = next((o.get("next") for o in options if o.get("correct")), None) or (options[0].get("next") if options else None)
        current_node = session["currentNodeId"]
        if target:
            messages, decisions, level, current_node = self._enter_node(
                messages, decisions, level, script, target,
            )
        completed = current_node is None
        saved = self.store.save(
            session_id, user_id, current_node,
            "completed" if completed else "running", level,
            messages, answers, decisions,
            session.get("scoreBefore", 50) + 6 if completed else None,
        )
        return self._enrich_session(user_id, saved, script)

    @staticmethod
    def _match_free_text(text: str, options: list[dict]) -> dict | None:
        def normalize(value: str) -> str:
            return re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", value.lower())

        query = normalize(text)
        if not query:
            return None
        ranked: list[tuple[float, dict]] = []
        for option in options:
            label = normalize(str(option.get("label") or ""))
            if not label:
                continue
            contained = 1.0 if query in label or label in query else 0.0
            shared = len(set(query) & set(label)) / max(1, len(set(query) | set(label)))
            sequence = SequenceMatcher(None, query, label).ratio()
            ranked.append((max(contained, shared, sequence), option))
        if not ranked:
            return None
        score, option = max(ranked, key=lambda pair: pair[0])
        return option if score >= 0.36 else None

    def complete(self, user_id: UUID, session_id: UUID) -> dict:
        session = self.store.get(session_id, user_id)
        if session is None:
            raise KeyError("session not found")
        saved = self.store.save(
            session_id, user_id, None, "completed", session.get("level") or 2,
            session.get("messages") or [], session.get("answers") or [],
            session.get("decisions") or [], session.get("scoreBefore", 50) + 6,
        )
        return self._enrich_session(user_id, saved)

    def _enrich_session(self, user_id: UUID, session: dict,
                        script: dict | None = None) -> dict:
        script = script or self.get_script(session["learnerCode"], user_id)
        node = (script or {}).get("nodes", {}).get(session.get("currentNodeId"))
        result = dict(session)
        result["currentNode"] = None if node is None else {
            "id": node.get("id"),
            "stage": node.get("stage"),
            "options": [{"label": option.get("label", "")} for option in node.get("options") or []],
        }
        result["topics"] = (script or {}).get("topics") or []
        result["resourceId"] = (script or {}).get("resourceId")
        return result

    @staticmethod
    def _script_from_quiz(resource: dict | None) -> dict | None:
        if not resource or resource.get("type") != "quiz":
            return None
        content = resource.get("content") or {}
        questions = [item for item in content.get("questions") or [] if isinstance(item, dict)]
        if not questions:
            return None
        nodes: dict[str, dict] = {}
        selected = questions[:6]
        for index, question in enumerate(selected):
            node_id = f"q{index + 1}"
            next_id = f"q{index + 2}" if index + 1 < len(selected) else "summary"
            options = [str(option) for option in question.get("options") or []]
            try:
                correct_index = int(question.get("correctIndex", -1))
            except (TypeError, ValueError):
                correct_index = -1
            answer_options = []
            for option_index, label in enumerate(options):
                correct = option_index == correct_index
                answer_options.append({
                    "label": label,
                    "correct": correct,
                    "next": next_id if correct else f"{node_id}-explain",
                })
            refs = question.get("kbRefs") or resource.get("kbRefs") or []
            nodes[node_id] = {
                "id": node_id,
                "stage": "引导" if index == 0 else "追问" if index < len(selected) - 1 else "确认",
                "tutor": str(question.get("stem") or f"第 {index + 1} 个问题"),
                "options": answer_options,
                "kbRefs": refs,
                "backstage": [{
                    "agent": "DIA-01",
                    "content": f"依据真实课程题目评估「{question.get('difficulty') or '自适应'}」层级掌握情况",
                }],
            }
            explanation = str(question.get("explanation") or "先回到题干中的关键条件，再判断各选项之间的差异。")
            correct_text = options[correct_index] if 0 <= correct_index < len(options) else "参考正确选项"
            nodes[f"{node_id}-explain"] = {
                "id": f"{node_id}-explain",
                "stage": "追问",
                "tutor": f"我们把这一步拆开：{explanation} 因此更合适的判断是「{correct_text}」。",
                "options": [{"label": "我理解了，继续", "next": next_id}],
                "kbRefs": refs,
                "decision": "simplify",
                "decisionReason": "本题首次未命中，ARB-05 下发解释后再继续下一步",
                "backstage": [
                    {"agent": "VER-04", "content": "核对答案与生成题目的解析一致性"},
                    {"agent": "ARB-05", "content": "采用降维解释，保留学习节奏而不重复扣分"},
                ],
            }
        nodes["summary"] = {
            "id": "summary",
            "stage": "确认",
            "tutor": f"本轮《{resource.get('title') or '课程导学'}》已经完成。系统已保存会话、答题走势和动态决策，可以回到课程继续学习。",
            "decision": "challenge",
            "decisionReason": "完成本轮真实课程导学，建议进入下一项课程资源",
            "backstage": [
                {"agent": "DIA-01", "content": "汇总本轮答题表现"},
                {"agent": "ARB-05", "content": "生成下一步学习建议"},
            ],
            "end": True,
        }
        points = [item for item in content.get("knowledgePoints") or [] if isinstance(item, dict)]
        topics = [{
            "id": str(item.get("id") or item.get("categoryId") or index),
            "name": TutoringService._topic_name(item, resource, index),
            "description": str(item.get("description") or "来自当前课程分阶题"),
            "kbRef": (resource.get("kbRefs") or [None])[0],
        } for index, item in enumerate(points[:4])]
        if not topics:
            topics = [{
                "id": resource.get("kpId") or "course-topic",
                "name": resource.get("topic") or resource.get("title") or "课程知识点",
                "description": "来自当前课程的真实分阶题",
                "kbRef": (resource.get("kbRefs") or [None])[0],
            }]
        return {
            "learnerId": f"resource:{resource['id']}",
            "resourceId": resource["id"],
            "title": f"苏格拉底导学 · {resource.get('title') or resource.get('topic')}",
            "kpId": resource.get("kpId") or topics[0]["id"],
            "topics": topics,
            "startId": "q1",
            "nodes": nodes,
        }

    @staticmethod
    def _topic_name(item: dict, resource: dict, index: int) -> str:
        value = str(item.get("categoryName") or item.get("name") or "").strip()
        if value and not (re.fullmatch(r"[a-zA-Z0-9_.-]+", value) and "_" in value):
            return value
        topic = str(resource.get("topic") or resource.get("title") or "课程知识点").strip()
        return f"{topic} · 要点 {index + 1}" if index else topic

    def _enter_node(self, messages: list[dict], decisions: list[dict],
                    level: int, script: dict, node_id: str):
        node = script["nodes"].get(node_id)
        if node is None:
            return messages, decisions, level, None
        if node.get("backstage"):
            messages.append({"kind": "backstage", "notes": node["backstage"]})
        messages.append({
            "kind": "tutor",
            "stage": node.get("stage"),
            "text": node.get("tutor"),
            "kbRefs": node.get("kbRefs"),
        })
        if node.get("decision"):
            decision = {
                "id": f"d-{uuid4().hex[:8]}",
                "type": node["decision"],
                "label": "进阶挑战" if node["decision"] == "challenge" else "降维解释",
                "reason": node.get("decisionReason") or "",
                "confidence": 0.95 if node["decision"] == "challenge" else 0.92,
            }
            decisions.insert(0, decision)
            messages.append({
                "kind": "decision",
                "type": decision["type"],
                "reason": decision["reason"],
                "accuracy": self._accuracy(messages),
                "asked": len([m for m in messages if m.get("kind") == "feedback"]),
            })
            level = min(5, level + 1) if decision["type"] == "challenge" else max(1, level - 1)
        if node.get("end"):
            messages.append({"kind": "summary"})
            return messages, decisions, level, None
        return messages, decisions, level, node_id

    @staticmethod
    def _accuracy(messages: list[dict]) -> int:
        answers = [m for m in messages if m.get("kind") == "feedback"]
        if not answers:
            return 0
        correct = sum(1 for m in answers if m.get("verdict") == "correct")
        return round(correct * 100 / len(answers))

    def _score_before(self, user_id: UUID, learner_code: str, kp_id: str | None) -> int:
        if learner_code.startswith("resource:"):
            return 50
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT scores_json FROM learners WHERE code=%s LIMIT 1", (learner_code,))
                row = cursor.fetchone()
        if not row or not row.get("scores_json"):
            return 50
        try:
            scores = json.loads(row["scores_json"])
            return int(scores.get(kp_id) or 50)
        except (TypeError, ValueError):
            return 50
