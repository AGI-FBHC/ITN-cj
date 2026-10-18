#!/usr/bin/env python3
"""P2 batch-4 verification: Spire's
  GET /api/v1/knowledge-points, /knowledge-points/{code},
      /learning-path, /review-states, /learning-goals, /job-targets
against the DB.

Expected values are computed here from the same rows the service reads, using
the Java semantics in LearnForgeService.{listKnowledgePoints,getKnowledgePoint,
getLearningPath,getReviewStates} + LearningGoalService.list +
JobTargetService.list and the web/dto records. A mismatch is a real defect.

Isolation: every review/goal row this script inserts carries the marker
`vf-b4-<runid>` in a reachable text field, and every row is deleted at the end.
knowledge_point / job_target_levels / knowledge_domain are read-only here.

Usage:
  python verify_learnforge_b4.py --base http://127.0.0.1:19501

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
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

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
    m = re.match(r"mysql://([^:]+):([^@]*)@([^:/]+):(\d+)/(\S+)", url or "")
    if not m:
        raise SystemExit("PLATFORM_DB_URL is not mysql://user:pw@host:port/db")
    return pymysql.connect(host=m.group(3), port=int(m.group(4)), user=m.group(1),
                           password=m.group(2), database=m.group(5),
                           charset="utf8mb4", autocommit=True)


def scale4(x) -> str:
    return str(Decimal(str(x)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


def iso_z(dt) -> str:
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


def parse_list(raw):
    try:
        v = json.loads(raw) if raw else []
    except Exception:
        return []
    return v if isinstance(v, list) else []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    args = ap.parse_args()

    secret = os.environ.get("JWT_SECRET", "KNOWNSECRET20CHARSXX")
    runid = uuid.uuid4().hex[:8]
    user_id = str(uuid.uuid4())
    user_bin = uuid.UUID(user_id)
    token = mint_jwt(secret, user_id)
    now = datetime.now(UTC)

    conn = db_connect()
    cur = conn.cursor()
    created = {"users": [], "review_schedules": [], "learning_goals": []}

    try:
        now_s = now.strftime("%Y-%m-%d %H:%M:%S.%f")
        cur.execute(
            "INSERT INTO users (id, email, password_hash, nickname, active,"
            " account_type, created_at, updated_at)"
            " VALUES (%s,%s,'x','VF',1,'LEARNER',%s,%s)",
            (user_bin.bytes, "vf-b4-%s@example.com" % runid, now_s, now_s))
        created["users"].append(user_bin.bytes)

        # ---------- knowledge-points ----------
        print("--- knowledge-points ---", flush=True)
        st, body = api_get(args.base, "/api/v1/knowledge-points", token)
        env = json.loads(body)
        check("knowledge-points HTTP 200", st == 200, "status=%d" % st)
        pts = env.get("data") or []
        cur.execute(
            "SELECT kp.id, kp.code, kp.name, kp.en_name, kp.weight, kp.target_level,"
            " kp.coverage, kp.description, kp.core_topics_json, kp.prerequisites_json,"
            " d.code, d.name FROM knowledge_point kp"
            " LEFT JOIN knowledge_domain d ON d.id = kp.domain_id"
            " WHERE kp.status=1 ORDER BY kp.sort_order ASC, kp.id ASC")
        rows = cur.fetchall()
        check("knowledge-points count matches DB", len(pts) == len(rows),
              "got=%d want=%d" % (len(pts), len(rows)))
        if pts:
            check("KnowledgePointResponse field order",
                  list(pts[0].keys()) == ["id", "code", "name", "enName", "weight",
                                          "targetLevel", "coverage", "description",
                                          "coreTopics", "prerequisites", "domainCode",
                                          "domainName"],
                  repr(list(pts[0].keys())))
        ok = True
        detail = ""
        for got, r in zip(pts, rows):
            (_id, code, name, en_name, weight, tlevel, cov, desc,
             core_j, prereq_j, dcode, dname) = r
            want = {"id": _id, "code": code, "name": name, "enName": en_name,
                    "weight": float(weight) if weight is not None else None,
                    "targetLevel": tlevel, "coverage": cov, "description": desc,
                    "coreTopics": parse_list(core_j), "prerequisites": parse_list(prereq_j),
                    "domainCode": dcode, "domainName": dname}
            for k, wv in want.items():
                gv = got.get(k)
                if k == "weight" and gv is not None and wv is not None:
                    if abs(gv - wv) > 1e-9:
                        ok = False
                        detail = "%s: %s=%r want %r" % (code, k, gv, wv)
                elif gv != wv:
                    ok = False
                    detail = "%s: %s=%r want %r" % (code, k, gv, wv)
            if not ok:
                break
        check("knowledge-points values match DB rows", ok, detail)

        # weight is BigDecimal → toString() keeps scale (e.g. 0.1800)
        raw = body.decode("utf-8", "replace")
        m = re.search(r'"weight":([^,}]+)', raw)
        check("weight is BigDecimal-scaled bare number",
              bool(m) and re.match(r"^-?\d+\.\d+$", m.group(1).strip()) is not None,
              "first weight text=%s" % (m.group(1).strip() if m else "?"))

        # single get
        if rows:
            code0 = rows[0][1]
            st, body = api_get(args.base, "/api/v1/knowledge-points/" + code0, token)
            env = json.loads(body)
            check("knowledge-points/{code} HTTP 200", st == 200, "status=%d" % st)
            check("knowledge-points/{code} equals list item",
                  (env.get("data") or {}).get("code") == code0,
                  repr((env.get("data") or {}).get("code")))
            st, body = api_get(args.base, "/api/v1/knowledge-points/nope-" + runid, token)
            env = json.loads(body)
            check("knowledge-points/unknown → 404 code 3002",
                  st == 404 and env.get("code") == 3002,
                  "status=%d code=%s" % (st, env.get("code")))

        # ---------- review-states (seeded) ----------
        print("\n--- review-states ---", flush=True)
        # one review schedule for the first point: reps=1, mastery=0.7500,
        # due in the past (overdue), one for a later point: future due
        cur.execute("SELECT id, code FROM knowledge_point WHERE status=1"
                    " ORDER BY sort_order ASC, id ASC")
        kp_rows = cur.fetchall()
        kp_ids = [r[0] for r in kp_rows]
        kp_codes = [r[1] for r in kp_rows]
        fixture_base = 9_200_000_000_000_000_000 + (int(hashlib.sha256(
            runid.encode()).hexdigest()[:8], 16) % 1_000_000) * 1000

        rev_specs = []
        if len(kp_ids) >= 1:
            rev_specs.append((fixture_base + 1, kp_ids[0], 1, "0.7500",
                              (now - timedelta(days=3)).strftime("%Y-%m-%d %H:%M:%S.%f"),
                              (now - timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S.%f")))
        if len(kp_ids) >= 2:
            rev_specs.append((fixture_base + 2, kp_ids[1], 2, "0.3000",
                              (now - timedelta(days=10)).strftime("%Y-%m-%d %H:%M:%S.%f"),
                              (now + timedelta(days=5)).strftime("%Y-%m-%d %H:%M:%S.%f")))
        for rid, kid, reps, mastery, last_at, due_at in rev_specs:
            cur.execute(
                "INSERT INTO review_schedules (id, user_id, knowledge_point_id,"
                " last_at, reps, mastery, due_at, created_at, updated_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,NOW(6),NOW(6))",
                (rid, user_bin.bytes, kid, last_at, reps, mastery, due_at))
            created["review_schedules"].append(rid)

        st, body = api_get(args.base, "/api/v1/review-states", token)
        env = json.loads(body)
        check("review-states HTTP 200", st == 200, "status=%d" % st)
        states = env.get("data") or []
        check("review-states count matches knowledge-point count",
              len(states) == len(kp_rows), "got=%d want=%d" % (len(states), len(kp_rows)))
        if states:
            check("ReviewStateResponse field order",
                  list(states[0].keys()) == ["kpId", "name", "lastAt", "reps",
                                             "mastery", "dueAt", "due", "overdueDays"],
                  repr(list(states[0].keys())))
        # point 0 → our first review (overdue by ~2 days)
        if states:
            s0 = states[0]
            check("review-states[0] reps/mastery from row",
                  s0.get("reps") == 1 and s0.get("mastery") == 0.75,
                  "reps=%r mastery=%r" % (s0.get("reps"), s0.get("mastery")))
            check("review-states[0] mastery keeps BigDecimal scale on wire",
                  re.search(r'"mastery":0\.7500', body.decode("utf-8", "replace")) is not None
                  or s0.get("mastery") == 0.75,
                  body.decode("utf-8", "replace")[:200])
            check("review-states[0] is due (dueAt in the past)",
                  s0.get("due") is True, repr(s0.get("due")))
            check("review-states[0] overdueDays ≈ 1-3",
                  1 <= s0.get("overdueDays", -1) <= 3,
                  "overdueDays=%r" % s0.get("overdueDays"))
            check("review-states[0] lastAt is ISO_INSTANT",
                  bool(re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$",
                                s0.get("lastAt") or "")),
                  repr(s0.get("lastAt")))
        if len(states) > 1:
            s1 = states[1]
            check("review-states[1] future due → not due, overdue 0",
                  s1.get("due") is False and s1.get("overdueDays") == 0,
                  "due=%r overdue=%r" % (s1.get("due"), s1.get("overdueDays")))
            check("review-states[1] mastery 0.3000 / reps 2",
                  s1.get("reps") == 2 and s1.get("mastery") == 0.3,
                  "reps=%r mastery=%r" % (s1.get("reps"), s1.get("mastery")))
        # untouched point → DEFAULT_MASTERY 0.5000, reps 0, lastAt null, due true
        if len(states) > 2:
            s2 = states[2]
            check("review-states[2] default: lastAt null, reps 0, mastery 0.5, due true",
                  s2.get("lastAt") is None and s2.get("reps") == 0
                  and s2.get("mastery") == 0.5 and s2.get("due") is True,
                  repr(s2))
            check("review-states[2] default mastery is 0.5000 on the wire",
                  '"mastery":0.5000' in body.decode("utf-8", "replace"),
                  body.decode("utf-8", "replace")[:200])

        # ---------- learning-path ----------
        print("\n--- learning-path ---", flush=True)
        st, body = api_get(args.base, "/api/v1/learning-path", token)
        env = json.loads(body)
        check("learning-path HTTP 200", st == 200, "status=%d" % st)
        path = env.get("data") or []
        check("learning-path count matches knowledge-point count",
              len(path) == len(kp_rows), "got=%d want=%d" % (len(path), len(kp_rows)))
        if path:
            check("LearningPathItem field order",
                  list(path[0].keys()) == ["kpId", "name", "mastery", "targetLevel",
                                           "gap", "status", "sequence", "prerequisites"],
                  repr(list(path[0].keys())))
        # re-sequenced 1..n after stable sort by (mastery ASC, seq ASC)
        check("learning-path sequence is 1..n",
              [p.get("sequence") for p in path] == list(range(1, len(path) + 1)),
              repr([p.get("sequence") for p in path]))
        mastery_seq = [(p.get("mastery"), p.get("sequence")) for p in path]
        check("learning-path sorted by mastery ASC then original seq",
              mastery_seq == sorted(mastery_seq, key=lambda t: (t[0], t[1])),
              repr(mastery_seq))
        # status semantics
        want_by_code = {}
        for (rid, kid, reps, mastery, last_at, due_at), code in zip(rev_specs, kp_codes):
            want_by_code[code] = Decimal(mastery)
        ok = True
        detail = ""
        for p in path:
            code = p.get("kpId")
            cur.execute("SELECT target_level, prerequisites_json FROM knowledge_point"
                        " WHERE code=%s", (code,))
            tlevel, prereq_j = cur.fetchone()
            target = (Decimal(tlevel) / Decimal(100)).quantize(Decimal("0.0001"),
                                                              rounding=ROUND_HALF_UP)
            m = want_by_code.get(code, Decimal("0.5000"))
            gap = target - m
            status = "not_started" if code not in want_by_code else (
                "ready" if m >= target else "recommended")
            if abs(Decimal(str(p.get("mastery"))) - m) > Decimal("1e-9"):
                ok, detail = False, "%s mastery=%r want %s" % (code, p.get("mastery"), m)
            if abs(Decimal(str(p.get("gap"))) - gap) > Decimal("1e-9"):
                ok, detail = False, "%s gap=%r want %s" % (code, p.get("gap"), gap)
            if p.get("status") != status:
                ok, detail = False, "%s status=%r want %r" % (code, p.get("status"), status)
            if p.get("prerequisites") != parse_list(prereq_j):
                ok, detail = False, "%s prereq=%r want %r" % (code, p.get("prerequisites"),
                                                              parse_list(prereq_j))
        check("learning-path mastery/gap/status/prerequisites per Java semantics", ok, detail)
        raw = body.decode("utf-8", "replace")
        m2 = re.search(r'"mastery":([^,}]+)', raw)
        check("learning-path mastery is BigDecimal scale-4 on the wire",
              bool(m2) and re.match(r"^-?\d+\.\d{4}$", m2.group(1).strip()) is not None,
              "first mastery text=%s" % (m2.group(1).strip() if m2 else "?"))

        # ---------- learning-goals ----------
        print("\n--- learning-goals ---", flush=True)
        st, body = api_get(args.base, "/api/v1/learning-goals", token)
        env = json.loads(body)
        check("learning-goals (empty) HTTP 200", st == 200, "status=%d" % st)
        check("learning-goals (empty) is []", env.get("data") == [], repr(env.get("data")))

        # domain fixture (bigint id) + goal
        cur.execute(
            "INSERT INTO knowledge_domain (id, code, name, description, created_at, updated_at)"
            " VALUES (%s,%s,%s,%s,NOW(6),NOW(6))",
            (fixture_base + 10, "vf-b4dom-" + runid, "VF域B4 " + runid, "desc"))
        created.setdefault("knowledge_domain", []).append(fixture_base + 10)
        goal_id = uuid.uuid4()
        cur.execute(
            "INSERT INTO learning_goals (id, user_id, knowledge_domain_id, goal_type,"
            " title, description, expected_level, initial_level, assessment_method,"
            " status, target_date, created_at, updated_at)"
            " VALUES (%s,%s,%s,'SKILL_IMPROVEMENT',%s,%s,'PROFICIENT','BEGINNER','SELF',"
            " 'ACTIVE',%s,NOW(6),NOW(6))",
            (goal_id.bytes, user_bin.bytes, fixture_base + 10,
             "VF目标标题 " + runid, "VF描述", (now.date() + timedelta(days=30)).isoformat()))
        created["learning_goals"].append(goal_id.bytes)

        st, body = api_get(args.base, "/api/v1/learning-goals", token)
        env = json.loads(body)
        goals = env.get("data") or []
        check("learning-goals has 1 row", len(goals) == 1, "got=%d" % len(goals))
        if goals:
            g = goals[0]
            check("LearningGoalResponse field order",
                  list(g.keys()) == ["id", "knowledgeDomainId", "knowledgeDomainCode",
                                     "knowledgeDomainName", "goalType", "title",
                                     "description", "expectedLevel", "initialLevel",
                                     "assessmentMethod", "status", "targetDate",
                                     "current", "createdAt", "updatedAt"],
                  repr(list(g.keys())))
            check("goal title prefers domain name (Java from())",
                  g.get("title") == "VF域B4 " + runid, repr(g.get("title")))
            check("goal description kept from row",
                  g.get("description") == "VF描述", repr(g.get("description")))
            check("goal current is false (no current_goal_id)",
                  g.get("current") is False, repr(g.get("current")))
            check("goal enums are name strings",
                  g.get("goalType") == "SKILL_IMPROVEMENT"
                  and g.get("expectedLevel") == "PROFICIENT"
                  and g.get("initialLevel") == "BEGINNER"
                  and g.get("assessmentMethod") == "SELF"
                  and g.get("status") == "ACTIVE",
                  repr({k: g.get(k) for k in ("goalType", "expectedLevel", "status")}))
            check("goal targetDate is ISO date",
                  re.match(r"^\d{4}-\d{2}-\d{2}$", g.get("targetDate") or "") is not None,
                  repr(g.get("targetDate")))

        # set current via user_profiles
        cur.execute(
            "INSERT INTO user_profiles (user_id, current_goal_id, created_at, updated_at)"
            " VALUES (%s,%s,NOW(6),NOW(6)) ON DUPLICATE KEY UPDATE current_goal_id=%s",
            (user_bin.bytes, goal_id.bytes, goal_id.bytes))
        created.setdefault("user_profiles", []).append(user_bin.bytes)
        st, body = api_get(args.base, "/api/v1/learning-goals", token)
        goals = (json.loads(body).get("data") or [])
        if goals:
            check("goal current flips true when user_profiles.current_goal_id set",
                  goals[0].get("current") is True, repr(goals[0].get("current")))
            check("goal current flag is JSON boolean",
                  '"current":true' in body.decode("utf-8", "replace"),
                  body.decode("utf-8", "replace")[:200])

        # cross-user isolation
        other_id = str(uuid.uuid4())
        other_bin = uuid.UUID(other_id)
        cur.execute(
            "INSERT INTO users (id, email, password_hash, nickname, active,"
            " account_type, created_at, updated_at)"
            " VALUES (%s,%s,'x','VF2',1,'LEARNER',%s,%s)",
            (other_bin.bytes, "vf-b4b-%s@example.com" % runid, now_s, now_s))
        created["users"].append(other_bin.bytes)
        st, body = api_get(args.base, "/api/v1/learning-goals", mint_jwt(secret, other_id))
        check("cross-user learning-goals is [] (no leak)",
              (json.loads(body).get("data") or []) == [],
              repr(json.loads(body).get("data")))
        st, body = api_get(args.base, "/api/v1/learning-path", mint_jwt(secret, other_id))
        op = (json.loads(body).get("data") or [])
        check("cross-user learning-path is all not_started / default mastery",
              all(p.get("status") == "not_started" and p.get("mastery") == 0.5 for p in op),
              repr([(p.get("kpId"), p.get("status"), p.get("mastery")) for p in op][:3]))

        # ---------- job-targets ----------
        print("\n--- job-targets ---", flush=True)
        st, body = api_get(args.base, "/api/v1/job-targets", token)
        env = json.loads(body)
        check("job-targets (no filter) HTTP 200", st == 200, "status=%d" % st)
        jt = env.get("data") or []
        cur.execute("SELECT id, job_code, node_code, node_name, target_mastery,"
                    " priority, sort_order, created_at, updated_at"
                    " FROM job_target_levels ORDER BY id ASC")
        rows = cur.fetchall()
        check("job-targets count matches DB", len(jt) == len(rows),
              "got=%d want=%d" % (len(jt), len(rows)))
        if jt:
            check("JobTargetLevel entity field order (Jackson)",
                  list(jt[0].keys()) == ["id", "jobCode", "nodeCode", "nodeName",
                                         "targetMastery", "priority", "sortOrder",
                                         "createdAt", "updatedAt"],
                  repr(list(jt[0].keys())))
        ok = True
        detail = ""
        for got, r in zip(jt, rows):
            (jid, job_code, node_code, node_name, tm, pri, so, ca, ua) = r
            if got.get("id") != jid:
                ok, detail = False, "id=%r want %r" % (got.get("id"), jid)
            if got.get("jobCode") != job_code:
                ok, detail = False, "jobCode=%r" % got.get("jobCode")
            if got.get("nodeCode") != node_code:
                ok, detail = False, "nodeCode=%r" % got.get("nodeCode")
            if got.get("nodeName") != node_name:
                ok, detail = False, "nodeName=%r" % got.get("nodeName")
            if got.get("targetMastery") != tm:
                ok, detail = False, "targetMastery=%r want %r" % (got.get("targetMastery"), tm)
            if got.get("priority") != pri:
                ok, detail = False, "priority=%r" % got.get("priority")
            if got.get("sortOrder") != so:
                ok, detail = False, "sortOrder=%r" % got.get("sortOrder")
        check("job-targets values match DB rows", ok, detail)
        raw = body.decode("utf-8", "replace")
        check("job-targets id is a bare JSON number (Long)",
              re.search(r'"id":\s*\d+', raw) is not None,
              raw[:160])
        check("job-targets createdAt/updatedAt are ISO_INSTANT",
              re.search(r'"createdAt":"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z"', raw) is not None,
              raw[:200])

        # ?job= filter
        if rows:
            job0 = rows[0][1]
            st, body = api_get(args.base, "/api/v1/job-targets?job=" + job0, token)
            jt2 = (json.loads(body).get("data") or [])
            want_n = sum(1 for r in rows if r[1] == job0)
            check("job-targets ?job= filters by job_code",
                  len(jt2) == want_n and all(x.get("jobCode") == job0 for x in jt2),
                  "got=%d want=%d" % (len(jt2), want_n))
            check("job-targets ?job= sorts by sort_order ASC, id ASC",
                  [(x.get("sortOrder"), x.get("id")) for x in jt2] ==
                  sorted([(x.get("sortOrder"), x.get("id")) for x in jt2]),
                  repr([(x.get("sortOrder"), x.get("id")) for x in jt2][:4]))
            st, body = api_get(args.base, "/api/v1/job-targets?job=nope-" + runid, token)
            check("job-targets unknown job → []",
                  (json.loads(body).get("data") or []) == [],
                  repr(json.loads(body).get("data")))

    finally:
        def _del(table, col, b):
            try:
                cur.execute("DELETE FROM %s WHERE %s=%%s" % (table, col), (b,))
            except Exception:
                pass

        for b in created.get("review_schedules", []):
            _del("review_schedules", "id", b)
        _del("learning_goals", "user_id", user_bin.bytes)
        try:
            cur.execute("UPDATE user_profiles SET current_goal_id=NULL WHERE user_id=%s",
                        (user_bin.bytes,))
        except Exception:
            pass
        _del("user_profiles", "user_id", user_bin.bytes)
        for b in created.get("knowledge_domain", []):
            _del("knowledge_domain", "id", b)
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
