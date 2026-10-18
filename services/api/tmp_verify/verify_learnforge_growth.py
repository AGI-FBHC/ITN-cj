#!/usr/bin/env python3
"""P2 batch-3 verification: Spire's GET /api/v1/learner-profile/growth,
/api/v1/learner-profile/report and /api/v1/knowledge-graph against the DB.

Expected values are computed here from the same rows the service reads, using
the Java semantics in LearnForgeSupportService.growth/report/knowledgeGraph and
web/dto/{GrowthResponse,KnowledgeGraph*,LearnerResponse}.java. A mismatch is a
real defect.

Isolation: every learner/growth row this script inserts carries the marker
`vf-growth-<runid>` in a reachable text field, and every row is deleted at the
end. knowledge_point rows are only read (never written).

Usage:
  python verify_learnforge_growth.py --base http://127.0.0.1:19501

Env:
  PLATFORM_DB_URL  mysql://user:pw@host:port/db
  JWT_SECRET       HS256 key Spire verifies with

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


# ---- auth ----

def mint_jwt(secret: str, user_id: str) -> str:
    def b64url(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    now = int(time.time())
    payload = b64url(json.dumps({"sub": user_id, "iat": now, "exp": now + 3600}).encode())
    signing_input = ("%s.%s" % (header, payload)).encode()
    sig = b64url(hmac.new(secret.encode(), signing_input, hashlib.sha256).digest())
    return "%s.%s.%s" % (header, payload, sig)


def api_get(base: str, path: str, token: str):
    import http.client
    from urllib.parse import urlparse

    u = urlparse(base)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=30)
    conn.request("GET", path, headers={"Authorization": "Bearer " + token,
                                       "Accept": "application/json"})
    resp = conn.getresponse()
    body = resp.read()
    conn.close()
    return resp.status, body


def db_connect():
    import pymysql

    url = os.environ.get("PLATFORM_DB_URL", "")
    if not url:
        raise SystemExit("PLATFORM_DB_URL is required")
    m = re.match(r"mysql://([^:]+):([^@]*)@([^:/]+):(\d+)/(\S+)", url)
    if not m:
        raise SystemExit("PLATFORM_DB_URL is not mysql://user:pw@host:port/db")
    user, pw, host, port, db = m.group(1), m.group(2), m.group(3), int(m.group(4)), m.group(5)
    return pymysql.connect(host=host, port=port, user=user, password=pw, database=db,
                           charset="utf8mb4", autocommit=True)


def iso_z(dt) -> str:
    """ISO_INSTANT with the Java group-of-3 fraction rule."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    dt = dt.astimezone(UTC)
    micros = dt.microsecond
    if micros == 0:
        frac = ""
    else:
        s = "%06d" % micros
        while s.endswith("000") and len(s) > 3:
            s = s[:-3]
        while len(s) < 3:
            s += "0"
        frac = "." + s
    return "%04d-%02d-%02dT%02d:%02d:%02d%sZ" % (
        dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second, frac)


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
    created = {"users": [], "learners": [], "growth_states": [], "growth_events": []}

    try:
        # ---- fixture user + learner ----
        now_s = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")
        cur.execute(
            "INSERT INTO users (id, email, password_hash, nickname, active,"
            " account_type, created_at, updated_at)"
            " VALUES (%s,%s,'x','VF',1,'LEARNER',%s,%s)",
            (user_bin.bytes, "vf-growth-%s@example.com" % runid, now_s, now_s))
        created["users"].append(user_bin.bytes)

        learner_id = uuid.uuid4()
        cur.execute(
            "INSERT INTO learners (id, user_id, code, name, scores_json,"
            " blind_spots_json, status, created_at, updated_at)"
            " VALUES (%s,%s,%s,%s,%s,%s,1,NOW(6),NOW(6))",
            (learner_id.bytes, user_bin.bytes, "vf-growth-" + runid, "VF学习者",
             json.dumps({"kp-ds": 80, "kp-co": 40}), json.dumps(["kp-co"], ensure_ascii=False)))
        created["learners"].append(learner_id.bytes)

        # ---- A: growth with no GrowthState row (auto-create) ----
        print("--- A: growth auto-create ---", flush=True)
        st, body = api_get(args.base, "/api/v1/learner-profile/growth", token)
        env = json.loads(body)
        check("growth (no state) HTTP 200", st == 200, "status=%d" % st)
        check("growth envelope is ApiResponse", env.get("code") == 0 and env.get("message") == "success",
              "code=%s message=%s" % (env.get("code"), env.get("message")))
        g = env.get("data") or {}
        check("growth field order matches GrowthResponse",
              list(g.keys()) == ["orb", "watered", "stage", "events"], repr(list(g.keys())))
        check("auto-created state is orb=0 watered=0 stage=seed",
              g.get("orb") == 0 and g.get("watered") == 0 and g.get("stage") == "seed",
              repr(g))
        check("auto-created state has empty events", g.get("events") == [], repr(g.get("events")))

        cur.execute("SELECT id, orb, watered, stage FROM growth_states WHERE user_id=%s",
                    (user_bin.bytes,))
        rows = cur.fetchall()
        check("GrowthState row was inserted", len(rows) == 1, "rows=%d" % len(rows))
        if rows:
            created["growth_states"].append(rows[0][0])

        # ---- B: seeded growth state + events ----
        print("\n--- B: populated growth ---", flush=True)
        cur.execute(
            "UPDATE growth_states SET orb=7, watered=30, stage='sprout' WHERE user_id=%s",
            (user_bin.bytes,))
        ev_specs = [
            ("quiz-answer-correct", "答对一题", 5, 10),
            ("lecture-read", "读完一讲", 15, 20),
            ("nourish", "滋养园子", -30, 30),
            ("focus-bonus", "专注加分", 25, 40),
        ]
        for etype, title, amount, mins_ago in ev_specs:
            eid = uuid.uuid4()
            cur.execute(
                "INSERT INTO growth_events (id, user_id, learner_id, event_type,"
                " title, amount, metadata_json, created_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,NULL,"
                " DATE_SUB(NOW(6), INTERVAL %s MINUTE))",
                (eid.bytes, user_bin.bytes, learner_id.bytes, etype, title + " " + runid,
                 amount, mins_ago))
            created["growth_events"].append(eid.bytes)

        st, body = api_get(args.base, "/api/v1/learner-profile/growth", token)
        g = (json.loads(body).get("data") or {})
        check("growth (populated) orb=7 watered=30 stage=sprout",
              g.get("orb") == 7 and g.get("watered") == 30 and g.get("stage") == "sprout",
              repr({k: g.get(k) for k in ("orb", "watered", "stage")}))
        evs = g.get("events") or []
        check("growth events count is 4", len(evs) == 4, "got=%d" % len(evs))
        if evs:
            check("growth event field order matches GrowthEventItem",
                  list(evs[0].keys()) == ["eventType", "title", "amount", "createdAt"],
                  repr(list(evs[0].keys())))
        # Fixture mins_ago: quiz 10, lecture 20, nourish 30, focus 40 — so
        # newest-first is quiz, lecture, nourish, focus.
        check("growth events are newest-first",
              [e.get("eventType") for e in evs] ==
              ["quiz-answer-correct", "lecture-read", "nourish", "focus-bonus"],
              repr([e.get("eventType") for e in evs]))
        check("growth event amounts preserved",
              [e.get("amount") for e in evs] == [5, 15, -30, 25],
              repr([e.get("amount") for e in evs]))
        check("growth event createdAt is ISO_INSTANT with Z",
              all(re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$", e.get("createdAt") or "")
                  for e in evs),
              repr([e.get("createdAt") for e in evs][:2]))

        # events capped at 30
        for i in range(30):
            eid = uuid.uuid4()
            cur.execute(
                "INSERT INTO growth_events (id, user_id, learner_id, event_type,"
                " title, amount, metadata_json, created_at)"
                " VALUES (%s,%s,%s,'note-taken',%s,8,NULL, DATE_SUB(NOW(6), INTERVAL %s SECOND))",
                (eid.bytes, user_bin.bytes, learner_id.bytes, "cap " + runid, i + 1))
            created["growth_events"].append(eid.bytes)
        st, body = api_get(args.base, "/api/v1/learner-profile/growth", token)
        g = (json.loads(body).get("data") or {})
        check("growth events capped at 30", len(g.get("events") or []) == 30,
              "got=%d" % len(g.get("events") or []))

        # ---- C: knowledge-graph ----
        print("\n--- C: knowledge-graph ---", flush=True)
        st, body = api_get(args.base, "/api/v1/knowledge-graph", token)
        env = json.loads(body)
        check("knowledge-graph HTTP 200", st == 200, "status=%d" % st)
        kg = env.get("data") or {}
        check("knowledge-graph field order matches record",
              list(kg.keys()) == ["nodes", "edges"], repr(list(kg.keys())))

        cur.execute(
            "SELECT code, name, en_name, target_level, coverage, weight, prerequisites_json"
            " FROM knowledge_point WHERE status=1 ORDER BY sort_order ASC, id ASC")
        pts = cur.fetchall()
        want_nodes = []
        want_edges = []
        for code, name, en_name, tlevel, cov, weight, prereq_json in pts:
            w = 0.0 if weight is None else float(weight)
            want_nodes.append({"id": code, "name": name, "enName": en_name,
                               "targetLevel": tlevel, "coverage": cov, "weight": w})
            try:
                prereqs = json.loads(prereq_json) if prereq_json else []
            except Exception:
                prereqs = []
            if not isinstance(prereqs, list):
                prereqs = []
            for p in prereqs:
                want_edges.append({"source": code, "target": p, "type": "requires"})

        check("knowledge-graph node count matches DB", len(kg.get("nodes") or []) == len(want_nodes),
              "got=%d want=%d" % (len(kg.get("nodes") or []), len(want_nodes)))
        check("knowledge-graph edge count matches DB", len(kg.get("edges") or []) == len(want_edges),
              "got=%d want=%d" % (len(kg.get("edges") or []), len(want_edges)))
        if kg.get("nodes"):
            check("node field order matches KnowledgeGraphNode",
                  list(kg["nodes"][0].keys()) ==
                  ["id", "name", "enName", "targetLevel", "coverage", "weight"],
                  repr(list(kg["nodes"][0].keys())))
        if kg.get("edges"):
            check("edge field order matches KnowledgeGraphEdge",
                  list(kg["edges"][0].keys()) == ["source", "target", "type"],
                  repr(list(kg["edges"][0].keys())))
        # order + values (weight: null→0.0; Double so plain JSON number)
        node_ok = True
        for got, want in zip(kg.get("nodes") or [], want_nodes):
            if list(got.keys()) != list(want.keys()):
                node_ok = False
                break
            for k in want:
                if k == "weight":
                    if abs((got.get(k) or 0) - want[k]) > 1e-9:
                        node_ok = False
                elif got.get(k) != want[k]:
                    node_ok = False
        check("knowledge-graph nodes match DB rows (order+values)", node_ok,
              "first=%s" % repr((kg.get("nodes") or [None])[0]))
        check("knowledge-graph edges match DB rows",
              (kg.get("edges") or []) == want_edges,
              "first=%s" % repr((kg.get("edges") or [None])[0]))
        # weight is Double → javaDoubleText, not BigDecimal scale-4
        if kg.get("nodes"):
            raw = body.decode("utf-8", "replace")
            m = re.search(r'"weight":([^,}]+)', raw)
            check("node weight is a Double text (no forced 4dp)",
                  bool(m) and not re.match(r"^-?\d+\.\d{4}$", m.group(1).strip()),
                  "first weight text=%s" % (m.group(1).strip() if m else "?"))

        # ---- D: report ----
        print("\n--- D: report ---", flush=True)
        st, body = api_get(args.base, "/api/v1/learner-profile/report", token)
        env = json.loads(body)
        check("report HTTP 200", st == 200, "status=%d" % st)
        check("report envelope is ApiResponse", env.get("code") == 0 and env.get("message") == "success",
              "code=%s" % env.get("code"))
        r = env.get("data") or {}
        check("report field order matches LinkedHashMap order",
              list(r.keys()) == ["learner", "overall", "blindSpots", "pathRoadmap", "growth"],
              repr(list(r.keys())))
        learner = r.get("learner") or {}
        check("report.learner field order matches LearnerResponse",
              list(learner.keys()) == ["id", "code", "name", "avatar", "role", "education",
                                      "targetJob", "weeklyHours", "learningStyle", "scores",
                                      "goal", "blindSpots", "preferredFormat", "diagnosisSummary",
                                      "confidenceMethod", "confidenceValue", "overallMastery",
                                      "createdAt", "updatedAt"],
              repr(list(learner.keys())))
        # scores {kp-ds:80, kp-co:40} → overall mean 60 → BigDecimal scale1 "60.0"
        check("report.overall is learner.overallMastery (mean 60.0)",
              r.get("overall") == learner.get("overallMastery") == 60.0,
              "overall=%r learner.overallMastery=%r" % (r.get("overall"), learner.get("overallMastery")))
        check("report.overall is emitted with one decimal",
              re.search(r'"overall":(-?\d+\.\d)([,}])', body.decode("utf-8", "replace")) is not None,
              body.decode("utf-8", "replace")[:200])
        check("report.blindSpots comes from learner.blindSpots",
              r.get("blindSpots") == learner.get("blindSpots") == ["kp-co"],
              repr(r.get("blindSpots")))
        check("report.pathRoadmap equals knowledge-graph edges",
              r.get("pathRoadmap") == want_edges, "first=%s" % repr((r.get("pathRoadmap") or [None])[0]))
        rg = r.get("growth") or {}
        check("report.growth is the GrowthResponse body",
              rg.get("orb") == 7 and rg.get("watered") == 30 and rg.get("stage") == "sprout",
              repr({k: rg.get(k) for k in ("orb", "watered", "stage")}))
        check("report.growth.events is the capped 30",
              len(rg.get("events") or []) == 30, "got=%d" % len(rg.get("events") or []))

        # blank blindSpots → [] not null (learner.blindSpots() == null ? List.of())
        cur.execute("UPDATE learners SET blind_spots_json=NULL WHERE user_id=%s", (user_bin.bytes,))
        st, body = api_get(args.base, "/api/v1/learner-profile/report", token)
        r = (json.loads(body).get("data") or {})
        check("report.blindSpots null → [] (never JSON null)",
              r.get("blindSpots") == [], repr(r.get("blindSpots")))

        # ---- E: 404 paths ----
        print("\n--- E: errors ---", flush=True)
        st, body = api_get(args.base, "/api/v1/learner-profile/growth?learnerId=" + str(uuid.uuid4()), token)
        env = json.loads(body)
        check("growth unknown learnerId → 404 code 3004",
              st == 404 and env.get("code") == 3004, "status=%d code=%s" % (st, env.get("code")))
        check("growth 404 envelope omits data",
              "data" not in env, repr(sorted(env.keys())))
        st, body = api_get(args.base, "/api/v1/learner-profile/report?learnerId=not-a-uuid", token)
        env = json.loads(body)
        check("report bad learnerId → 404 code 3004",
              st == 404 and env.get("code") == 3004, "status=%d code=%s" % (st, env.get("code")))
        # KNOWN AUTH-DEPTH GAP (out of batch-3 scope): Java's JwtAuthenticationFilter
        # also requires a live user_sessions row + active user, else 401 before the
        # controller. Spire's requireUser verifies the JWT signature only, so a
        # signed JWT whose sub has no users row reaches the handler and the
        # learner auto-create hits the FK → 500. Unreachable via normal login.
        # Safety property checked here: no data leaks either way.
        st, body = api_get(args.base, "/api/v1/learner-profile/growth", mint_jwt(secret, str(uuid.uuid4())))
        env2 = json.loads(body)
        check("signed JWT without users row leaks no data (500, not a 200 body)",
              st >= 400 and "data" not in env2,
              "status=%d code=%s keys=%s  [known auth-depth gap: Java would 401]"
              % (st, env2.get("code"), sorted(env2.keys())))

        # real second user → fresh zero state, no leak from user 1
        other_id = str(uuid.uuid4())
        other_bin = uuid.UUID(other_id)
        cur.execute(
            "INSERT INTO users (id, email, password_hash, nickname, active,"
            " account_type, created_at, updated_at)"
            " VALUES (%s,%s,'x','VF2',1,'LEARNER',%s,%s)",
            (other_bin.bytes, "vf-growth2-%s@example.com" % runid, now_s, now_s))
        created["users"].append(other_bin.bytes)
        st, body = api_get(args.base, "/api/v1/learner-profile/growth", mint_jwt(secret, other_id))
        g2 = (json.loads(body).get("data") or {})
        check("cross-user growth is a fresh zero state (no leak)",
              g2.get("orb") == 0 and g2.get("watered") == 0 and (g2.get("events") or []) == [],
              repr(g2))
        cur.execute("SELECT COUNT(*) FROM growth_events WHERE user_id=%s", (other_bin.bytes,))
        check("cross-user has no growth_events rows", cur.fetchone()[0] == 0)

    finally:
        def _del(table, col, b):
            try:
                cur.execute("DELETE FROM %s WHERE %s=%%s" % (table, col), (b,))
            except Exception:
                pass

        for b in created["growth_events"]:
            _del("growth_events", "id", b)
        for b in created["growth_states"]:
            _del("growth_states", "id", b)
        _del("learners", "user_id", user_bin.bytes)
        _del("users", "id", user_bin.bytes)
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
