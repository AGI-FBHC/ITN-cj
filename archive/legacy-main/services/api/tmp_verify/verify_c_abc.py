#!/usr/bin/env python3
"""Verification for the C-a/b/c endpoints ported by the B-team handover
(memories CRUD, chat / presentation-chat session CRUD, admin read-only queries).

These are /v1 routes — bare JSON (the Python envelope), NOT /api/v1 ApiResponse.
Error bodies follow FastAPI HTTPException {"detail": "..."} and the pydantic
422 array shape from agents-service.

Routes under test:
  GET    /v1/memories
  POST   /v1/memory/context
  PUT    /v1/memories
  DELETE /v1/memories/{memory_id}
  POST   /v1/chat/sessions
  GET    /v1/chat/sessions
  GET    /v1/chat/sessions/{id}/messages
  PUT    /v1/chat/sessions/{id}/rename
  PUT    /v1/chat/sessions/{id}/archive
  DELETE /v1/chat/sessions/{id}
  POST   /v1/presentations/{task_id}/chat/sessions
  GET    /v1/presentations/{task_id}/chat/sessions
  GET    /v1/presentations/{task_id}/chat/sessions/{id}/messages
  DELETE /v1/presentations/{task_id}/chat/sessions/{id}
  GET    /v1/admin-generation-groups
  GET    /v1/admin-generation-resources/{resource_id}

Isolation: every row this script inserts carries the marker `vf-cabc-<runid>`
in a reachable text field, and every row is deleted at the end.

Usage:
  python verify_c_abc.py --base http://127.0.0.1:19501

Exit 0 iff every check passed.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone

PASS: list = []
FAIL: list = []
UTC = timezone.utc


def _safe(s: str) -> str:
    return (s or "").encode("ascii", "replace").decode("ascii")


def check(name: str, ok: bool, detail: str = ""):
    (PASS if ok else FAIL).append((name, detail))
    print(("  PASS  " if ok else "  FAIL  ") + _safe(name) +
          (("  -- " + _safe(detail)) if detail else ""), flush=True)


def mint_jwt(secret: str, user_id: str) -> str:
    def b64url(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    now = int(time.time())
    payload = b64url(json.dumps({"sub": user_id, "iat": now, "exp": now + 3600}).encode())
    sig = b64url(hmac.new(secret.encode(), ("%s.%s" % (header, payload)).encode(),
                          hashlib.sha256).digest())
    return "%s.%s.%s" % (header, payload, sig)


def api_req(base: str, method: str, path: str, token, body=None):
    import http.client
    from urllib.parse import urlparse

    u = urlparse(base)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=30)
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    payload = None
    if body is not None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=payload, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp.status, data


def db_connect():
    import pymysql

    url = os.environ.get("PLATFORM_DB_URL", "")
    m = re.match(r"mysql://([^:]+):([^@]*)@([^:/]+):(\d+)/(\S+)", url or "")
    if not m:
        raise SystemExit("PLATFORM_DB_URL is not mysql://user:pw@host:port/db")
    return pymysql.connect(host=m.group(3), port=int(m.group(4)), user=m.group(1),
                           password=m.group(2), database=m.group(5),
                           charset="utf8mb4", autocommit=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    args = ap.parse_args()

    secret = os.environ.get("JWT_SECRET", "KNOWNSECRET20CHARSXX")
    runid = uuid.uuid4().hex[:8]
    user_id = str(uuid.uuid4())
    user_bin = uuid.UUID(user_id)
    token = mint_jwt(secret, user_id)

    conn = db_connect()
    cur = conn.cursor()
    created = {"users": [], "learners": [], "user_memories": [], "chat_sessions": [],
               "presentation_chat_sessions": [], "presentation_tasks": []}

    def _del(table, col, b):
        try:
            cur.execute("DELETE FROM %s WHERE %s=%%s" % (table, col), (b,))
        except Exception:
            pass

    try:
        now_s = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")
        cur.execute(
            "INSERT INTO users (id, email, password_hash, nickname, active,"
            " account_type, created_at, updated_at)"
            " VALUES (%s,%s,'x','VF',1,'LEARNER',%s,%s)",
            (user_bin.bytes, "vf-cabc-%s@example.com" % runid, now_s, now_s))
        created["users"].append(user_bin.bytes)

        # =========================================================
        # C-a memories
        # =========================================================
        print("--- C-a memories ---", flush=True)

        # GET /v1/memories — empty, bare {"items": [...]}
        st, body = api_req(args.base, "GET", "/v1/memories", token)
        env = json.loads(body)
        check("GET /v1/memories → 200 bare JSON", st == 200, "status=%d" % st)
        check("GET /v1/memories body is {items: [...]}",
              list(env.keys()) == ["items"] and isinstance(env.get("items"), list),
              repr(sorted(env.keys())))
        check("GET /v1/memories is NOT an ApiResponse envelope",
              "code" not in env and "message" not in env,
              repr(sorted(env.keys())))

        # PUT /v1/memories — profile namespace is editable
        st, body = api_req(args.base, "PUT", "/v1/memories", token, {
            "namespace": "profile", "key": "vf-cabc-" + runid,
            "scope": {"scene": "chat"},
            "value": {"level": 3, "tags": ["a"]},
            "summary": "VF记忆 " + runid})
        env = json.loads(body)
        check("PUT /v1/memories → 200", st == 200, "status=%d" % st)
        check("memToJson field order",
              list(env.keys()) == ["id", "learnerId", "namespace", "key", "scope",
                                   "value", "summary", "sourceType", "confidence",
                                   "importance", "status", "version", "lastUsedAt",
                                   "createdAt", "updatedAt"],
              repr(list(env.keys())))
        check("memory namespace/key echoed",
              env.get("namespace") == "profile" and env.get("key") == "vf-cabc-" + runid,
              repr({k: env.get(k) for k in ("namespace", "key")}))
        check("memory value keeps nested object",
              env.get("value") == {"level": 3, "tags": ["a"]}, repr(env.get("value")))
        check("memory sourceType is user_declared / confidence 1.0 / importance 0.9",
              env.get("sourceType") == "user_declared"
              and abs((env.get("confidence") or 0) - 1.0) < 1e-9
              and abs((env.get("importance") or 0) - 0.9) < 1e-9,
              "st=%r conf=%r imp=%r" % (env.get("sourceType"), env.get("confidence"),
                                        env.get("importance")))
        memory_id = env.get("id")
        created["user_memories"].append(uuid.UUID(memory_id).bytes)

        # GET with namespace filter
        st, body = api_req(args.base, "GET", "/v1/memories?namespace=profile", token)
        items = (json.loads(body).get("items") or [])
        check("GET /v1/memories?namespace=profile filters",
              any(i.get("key") == "vf-cabc-" + runid for i in items),
              "n=%d" % len(items))
        st, body = api_req(args.base, "GET", "/v1/memories?namespace=goal", token)
        items2 = (json.loads(body).get("items") or [])
        check("GET /v1/memories?namespace=goal excludes profile rows",
              not any(i.get("key") == "vf-cabc-" + runid for i in items2),
              "n=%d" % len(items2))

        # PUT non-editable namespace → 422 {"detail": "..."}
        st, body = api_req(args.base, "PUT", "/v1/memories", token, {
            "namespace": "episodic", "key": "x", "scope": {}, "value": {},
            "summary": "y"})
        env = json.loads(body)
        check("PUT non-editable namespace → 422 detail",
              st == 422 and env.get("detail") ==
              "Only profile, goal and preference memories can be edited",
              "status=%d detail=%r" % (st, env.get("detail")))
        check("memory 422 body is HTTPException shape (detail string)",
              isinstance(env.get("detail"), str) and "code" not in env,
              repr(sorted(env.keys())))

        # PUT missing fields → agents-service 422 envelope
        # {"code":"VALIDATION_FAILED","details":[pydantic items]} (NOT FastAPI
        # {"detail":[...]}) — the shape the handover doc requires.
        st, body = api_req(args.base, "PUT", "/v1/memories", token, {"namespace": "profile"})
        env = json.loads(body)
        check("PUT missing fields → 422 VALIDATION_FAILED envelope",
              st == 422 and env.get("code") == "VALIDATION_FAILED"
              and isinstance(env.get("details"), list),
              "status=%d code=%r details=%r" % (st, env.get("code"),
                                                str(env.get("details"))[:60]))
        if isinstance(env.get("details"), list) and env["details"]:
            check("pydantic item shape has loc/msg/type",
                  set(env["details"][0].keys()) >= {"loc", "msg", "type"},
                  repr(sorted(env["details"][0].keys())))

        # POST /v1/memory/context
        st, body = api_req(args.base, "POST", "/v1/memory/context", token,
                           {"scene": "chat", "scope": {"scene": "chat"}})
        env = json.loads(body)
        check("POST /v1/memory/context → 200", st == 200, "status=%d" % st)
        check("memory/context top-level keys",
              set(env.keys()) >= {"scene", "scope", "profile", "goals", "knowledge",
                                  "misconceptions", "preferences", "strategies",
                                  "recentEpisodes", "memoryRefs"},
              repr(sorted(env.keys())))
        check("memory/context scene echoed", env.get("scene") == "chat",
              repr(env.get("scene")))
        check("memory/context memoryRefs is a list",
              isinstance(env.get("memoryRefs"), list),
              repr(type(env.get("memoryRefs")).__name__))

        # DELETE → 204.  The store's delete is a TOMBSTONE (status='deleted'),
        # matching Python's user_memory store — the row survives as a tombstone.
        st, body = api_req(args.base, "DELETE", "/v1/memories/" + memory_id, token)
        check("DELETE /v1/memories/{id} → 204", st == 204, "status=%d" % st)
        check("DELETE 204 has empty body", body in (b"", b"null"), repr(body[:20]))
        cur.execute("SELECT status FROM user_memories WHERE id=%s",
                    (uuid.UUID(memory_id).bytes,))
        row = cur.fetchone()
        check("memory is tombstoned (status='deleted'), not physically removed",
              row is not None and row[0] == "deleted",
              "row=%r" % (row,))

        # DELETE unknown → 404 detail
        st, body = api_req(args.base, "DELETE", "/v1/memories/" + str(uuid.uuid4()), token)
        env = json.loads(body)
        check("DELETE unknown memory → 404 Memory not found",
              st == 404 and env.get("detail") == "Memory not found",
              "status=%d detail=%r" % (st, env.get("detail")))

        # =========================================================
        # C-b chat sessions
        # =========================================================
        print("\n--- C-b chat sessions ---", flush=True)
        st, body = api_req(args.base, "POST", "/v1/chat/sessions", token)
        env = json.loads(body)
        check("POST /v1/chat/sessions → 200", st == 200, "status=%d" % st)
        check("chat session field order (snake_case)",
              list(env.keys()) == ["id", "title", "archived", "created_at", "updated_at"],
              repr(list(env.keys())))
        check("chat session default title is 新对话",
              env.get("title") == "新对话", repr(env.get("title")))
        check("chat session archived defaults false",
              env.get("archived") is False, repr(env.get("archived")))
        session_id = env.get("id")
        created["chat_sessions"].append(uuid.UUID(session_id).bytes)

        # GET list
        st, body = api_req(args.base, "GET", "/v1/chat/sessions", token)
        env = json.loads(body)
        check("GET /v1/chat/sessions → {sessions: [...]}",
              st == 200 and list(env.keys()) == ["sessions"],
              repr(sorted(env.keys())))
        check("list contains the new session",
              any(s.get("id") == session_id for s in (env.get("sessions") or [])),
              "n=%d" % len(env.get("sessions") or []))

        # GET ?archived= validation — agents-service 422 envelope
        st, body = api_req(args.base, "GET", "/v1/chat/sessions?archived=notabool", token)
        env = json.loads(body)
        check("GET ?archived=notabool → 422 bool_parsing",
              st == 422 and env.get("code") == "VALIDATION_FAILED"
              and isinstance(env.get("details"), list)
              and env["details"][0].get("type") == "bool_parsing",
              "status=%d code=%r details=%r" % (st, env.get("code"),
                                                str(env.get("details"))[:70]))

        # GET messages for a fresh session
        st, body = api_req(args.base, "GET",
                           "/v1/chat/sessions/%s/messages" % session_id, token)
        env = json.loads(body)
        check("GET .../messages → {messages: [...]}",
              st == 200 and list(env.keys()) == ["messages"],
              repr(sorted(env.keys())))
        check("fresh session has no messages", env.get("messages") == [],
              repr(env.get("messages")))

        # rename
        st, body = api_req(args.base, "PUT",
                           "/v1/chat/sessions/%s/rename" % session_id, token,
                           {"title": "  " + "VF改名 " + runid + "  "})
        env = json.loads(body)
        check("PUT .../rename → 200 strips the title",
              st == 200 and env.get("title") == "VF改名 " + runid,
              "status=%d title=%r" % (st, env.get("title")))
        st, body = api_req(args.base, "PUT",
                           "/v1/chat/sessions/%s/rename" % session_id, token,
                           {"title": "   "})
        env = json.loads(body)
        check("PUT .../rename blank title → 422 Title is required",
              st == 422 and env.get("detail") == "Title is required",
              "status=%d detail=%r" % (st, env.get("detail")))
        st, body = api_req(args.base, "PUT",
                           "/v1/chat/sessions/%s/rename" % str(uuid.uuid4()), token,
                           {"title": "x"})
        env = json.loads(body)
        check("PUT .../rename unknown session → 404 Chat session not found",
              st == 404 and env.get("detail") == "Chat session not found",
              "status=%d detail=%r" % (st, env.get("detail")))

        # archive
        st, body = api_req(args.base, "PUT",
                           "/v1/chat/sessions/%s/archive" % session_id, token,
                           {"archived": True})
        env = json.loads(body)
        check("PUT .../archive true → 200 archived=true",
              st == 200 and env.get("archived") is True,
              "status=%d archived=%r" % (st, env.get("archived")))
        st, body = api_req(args.base, "GET", "/v1/chat/sessions?archived=true", token)
        env = json.loads(body)
        check("archived session appears under ?archived=true",
              any(s.get("id") == session_id for s in (env.get("sessions") or [])),
              "n=%d" % len(env.get("sessions") or []))
        st, body = api_req(args.base, "GET", "/v1/chat/sessions", token)
        env = json.loads(body)
        check("archived session hidden from default list",
              not any(s.get("id") == session_id for s in (env.get("sessions") or [])),
              "n=%d" % len(env.get("sessions") or []))
        st, body = api_req(args.base, "PUT",
                           "/v1/chat/sessions/%s/archive" % session_id, token,
                           {"archived": "yes"})
        env = json.loads(body)
        check("PUT .../archive non-bool → 422 Archived must be a boolean",
              st == 422 and env.get("detail") == "Archived must be a boolean",
              "status=%d detail=%r" % (st, env.get("detail")))

        # DELETE → 204
        st, body = api_req(args.base, "DELETE",
                           "/v1/chat/sessions/" + session_id, token)
        check("DELETE /v1/chat/sessions/{id} → 204", st == 204, "status=%d" % st)
        cur.execute("SELECT COUNT(*) FROM chat_sessions WHERE id=%s",
                    (uuid.UUID(session_id).bytes,))
        check("chat session row deleted", cur.fetchone()[0] == 0)
        st, body = api_req(args.base, "DELETE",
                           "/v1/chat/sessions/" + str(uuid.uuid4()), token)
        env = json.loads(body)
        check("DELETE unknown chat session → 404",
              st == 404 and env.get("detail") == "Chat session not found",
              "status=%d detail=%r" % (st, env.get("detail")))

        # =========================================================
        # C-b presentation-chat sessions
        # =========================================================
        print("\n--- C-b presentation-chat ---", flush=True)
        task_id = uuid.uuid4()
        # presentation task row so ownership checks have a parent.
        # presentation_tasks has several NOT NULL columns with no default
        # (stage_message, request_json, ...) — fill them explicitly.
        try:
            cur.execute(
                "INSERT INTO presentation_tasks (id, user_id, title, status,"
                " stage_message, request_json, created_at, updated_at)"
                " VALUES (%s,%s,%s,'succeeded',%s,%s,NOW(6),NOW(6))",
                (task_id.bytes, user_bin.bytes, "vf-cabc-pt " + runid, "done", "{}"))
            created["presentation_tasks"].append(task_id.bytes)
        except Exception as e:
            print("  (note) presentation_tasks fixture skipped: %s" % _safe(str(e))[:60],
                  flush=True)

        st, body = api_req(args.base, "POST",
                           "/v1/presentations/%s/chat/sessions" % task_id, token)
        env = json.loads(body)
        if st == 200:
            check("POST presentations/chat/sessions → 200", True)
            check("presentation chat session field order (camelCase)",
                  list(env.keys()) == ["id", "taskId", "title", "modelProvider",
                                       "createdAt", "updatedAt"],
                  repr(list(env.keys())))
            check("presentation chat taskId echoed",
                  env.get("taskId") == str(task_id), repr(env.get("taskId")))
            pcs_id = env.get("id")
            created["presentation_chat_sessions"].append(uuid.UUID(pcs_id).bytes)

            st, body = api_req(args.base, "GET",
                               "/v1/presentations/%s/chat/sessions" % task_id, token)
            env = json.loads(body)
            # Python returns store.list() directly — a bare array, unlike the
            # chat sessions endpoint which wraps in {"sessions": [...]}.
            check("GET presentations/chat/sessions → 200 bare array",
                  st == 200 and isinstance(env, list),
                  "status=%d type=%s" % (st, type(env).__name__))

            st, body = api_req(args.base, "GET",
                               "/v1/presentations/%s/chat/sessions/%s/messages"
                               % (task_id, pcs_id), token)
            env = json.loads(body)
            # Python returns store.messages() directly — also a bare array.
            check("GET presentations/chat/messages → 200 bare array",
                  st == 200 and isinstance(env, list),
                  "status=%d type=%s" % (st, type(env).__name__))

            st, body = api_req(args.base, "DELETE",
                               "/v1/presentations/%s/chat/sessions/%s"
                               % (task_id, pcs_id), token)
            check("DELETE presentations/chat session → 204",
                  st == 204, "status=%d" % st)
        else:
            check("POST presentations/chat/sessions (fixture parent missing?)",
                  False, "status=%d body=%s" % (st, _safe(body.decode("utf-8", "replace")[:80])))

        # =========================================================
        # C-c admin read-only queries
        # =========================================================
        print("\n--- C-c admin queries ---", flush=True)
        st, body = api_req(args.base, "GET",
                           "/v1/admin-generation-groups?domainCode=DOM&nodeCode=NODE",
                           token)
        env = json.loads(body)
        check("GET /v1/admin-generation-groups → 200 {groups: [...]}",
              st == 200 and isinstance(env.get("groups"), list),
              "status=%d keys=%r" % (st, sorted(env.keys())))
        st, body = api_req(args.base, "GET", "/v1/admin-generation-groups", token)
        env = json.loads(body)
        check("GET admin-generation-groups missing params → 422 VALIDATION_FAILED",
              st == 422 and env.get("code") == "VALIDATION_FAILED"
              and isinstance(env.get("details"), list)
              and {d.get("loc", [None, None])[1] for d in env["details"]} ==
              {"domainCode", "nodeCode"},
              "status=%d code=%r details=%r" % (st, env.get("code"),
                                                str(env.get("details"))[:70]))
        st, body = api_req(args.base,
                           "GET", "/v1/admin-generation-groups?domainCode=&nodeCode=NODE",
                           token)
        env = json.loads(body)
        check("GET admin-generation-groups empty domainCode → 422 string_too_short",
              st == 422 and env.get("code") == "VALIDATION_FAILED"
              and isinstance(env.get("details"), list)
              and any(i.get("type") == "string_too_short" for i in env["details"]),
              "status=%d code=%r details=%r" % (st, env.get("code"),
                                                str(env.get("details"))[:70]))

        st, body = api_req(args.base,
                           "GET", "/v1/admin-generation-resources/" + str(uuid.uuid4()),
                           token)
        env = json.loads(body)
        check("GET admin-generation-resources unknown → 404",
              st == 404 and env.get("detail") == "资源不存在或不属于当前机构",
              "status=%d detail=%r" % (st, env.get("detail")))

        # =========================================================
        # cross-user isolation
        # =========================================================
        print("\n--- isolation ---", flush=True)
        other_id = str(uuid.uuid4())
        other_bin = uuid.UUID(other_id)
        cur.execute(
            "INSERT INTO users (id, email, password_hash, nickname, active,"
            " account_type, created_at, updated_at)"
            " VALUES (%s,%s,'x','VF2',1,'LEARNER',%s,%s)",
            (other_bin.bytes, "vf-cabc2-%s@example.com" % runid, now_s, now_s))
        created["users"].append(other_bin.bytes)
        otoken = mint_jwt(secret, other_id)

        st, body = api_req(args.base, "POST", "/v1/chat/sessions", otoken)
        other_session = (json.loads(body).get("id"))
        if other_session:
            created["chat_sessions"].append(uuid.UUID(other_session).bytes)
        st, body = api_req(args.base, "GET", "/v1/chat/sessions", otoken)
        ids = [s.get("id") for s in (json.loads(body).get("sessions") or [])]
        check("cross-user chat list is isolated",
              other_session in ids and session_id not in ids,
              repr(ids[:3]))
        st, body = api_req(args.base, "DELETE",
                           "/v1/chat/sessions/" + str(other_session or uuid.uuid4()), token)
        check("user A cannot delete user B's chat session → 404",
              st == 404, "status=%d" % st)
        st, body = api_req(args.base, "GET", "/v1/memories", otoken)
        check("cross-user memories list is empty",
              (json.loads(body).get("items") or []) == [],
              repr(json.loads(body).get("items")))

    finally:
        for b in created["presentation_chat_sessions"]:
            _del("presentation_chat_messages", "session_id", b)
            _del("presentation_chat_sessions", "id", b)
        for b in created["presentation_tasks"]:
            _del("presentation_tasks", "id", b)
        for b in created["chat_sessions"]:
            try:
                cur.execute("DELETE FROM chat_messages WHERE session_id=%s", (b,))
            except Exception:
                pass
            _del("chat_sessions", "id", b)
        for b in created["user_memories"]:
            try:
                cur.execute("DELETE FROM user_memory_usage WHERE memory_id=%s", (b,))
            except Exception:
                pass
            _del("user_memories", "id", b)
        _del("user_memories", "user_id", user_bin.bytes)
        _del("learners", "user_id", user_bin.bytes)
        _del("learners", "user_id", other_bin.bytes) if 'other_bin' in dir() else None
        _del("users", "id", user_bin.bytes)
        _del("users", "id", other_bin.bytes) if 'other_bin' in dir() else None
        cur.close()
        conn.close()
        print("  cleaned up fixture user %s" % user_id, flush=True)

    print()
    print("== summary ==")
    print("PASS %d   FAIL %d" % (len(PASS), len(FAIL)))
    if FAIL:
        for n, d in FAIL:
            print("  FAIL " + _safe(n) + "  -- " + _safe(d))
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
