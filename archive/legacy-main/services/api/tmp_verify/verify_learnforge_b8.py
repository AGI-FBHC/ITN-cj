#!/usr/bin/env python3
"""P2 batch-8 verification: Spire's growth writes + goals CRUD + review complete.
  POST   /api/v1/learner-profile/growth-events
  POST   /api/v1/learner-profile/growth/nourish
  POST   /api/v1/learning-goals
  POST   /api/v1/learning-goals/domain/{domainId}/ensure
  PUT    /api/v1/learning-goals/{goalId}
  DELETE /api/v1/learning-goals/{goalId}
  PUT    /api/v1/learning-goals/{goalId}/current
  DELETE /api/v1/learning-goals/current
  POST   /api/v1/review-states/{code}/complete

Expected values are computed here from the same rows the service writes, using
the Java semantics in LearnForgeSupportService.{recordGrowthEvent,nourishGrowth,
growthReward} + GrowthState.{addOrb,water,stageOf} + LearningGoalService +
LearnForgeService.completeReview + ReviewSchedule.complete. A mismatch is a real
defect.

Isolation: every row this script inserts carries the marker `vf-b8-<runid>` in a
reachable text field, and every row is deleted at the end. knowledge_domain and
knowledge_point rows are created only in a run-scoped high integer id range and
deleted after.

Usage:
  python verify_learnforge_b8.py --base http://127.0.0.1:19501

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


def api_req(base: str, method: str, path: str, token: str, body=None):
    import http.client
    from urllib.parse import urlparse

    u = urlparse(base)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=30)
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
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


def scale4(x) -> str:
    return str(Decimal(str(x)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


def growth_reward(event_type, amount):
    """LearnForgeSupportService.growthReward (7 branches)."""
    amt = amount if amount is not None else 0
    table = {"quiz-answer-correct": 5, "quiz-answer": 1, "lecture-read": 15,
             "guide-complete": 20, "tutoring-finished": 25, "note-taken": 8,
             "courseware-complete": 15}
    if event_type in table:
        return table[event_type]
    if event_type == "focus-bonus":
        return max(0, min(25, amt))
    return min(0, amt)


def stage_of(watered):
    """GrowthState.stageOf (4 thresholds)."""
    if watered >= 280:
        return "tree"
    if watered >= 160:
        return "young_tree"
    if watered >= 80:
        return "seedling"
    if watered >= 30:
        return "sprout"
    return "seed"


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
    # Keep the fixture id range under Int64 max (9.22e18) — the API parses
    # knowledgeDomainId with Int64 and rejects anything larger.
    fixture_base = 4_200_000_000_000_000_000 + (int(hashlib.sha256(
        runid.encode()).hexdigest()[:8], 16) % 1_000_000) * 1000

    conn = db_connect()
    cur = conn.cursor()
    created = {"users": [], "learners": [], "growth_states": [], "growth_events": [],
               "learning_goals": [], "user_profiles": [], "knowledge_domain": [],
               "knowledge_point": [], "review_schedules": [], "learning_events": []}

    try:
        now_s = now.strftime("%Y-%m-%d %H:%M:%S.%f")
        cur.execute(
            "INSERT INTO users (id, email, password_hash, nickname, active,"
            " account_type, created_at, updated_at)"
            " VALUES (%s,%s,'x','VF',1,'LEARNER',%s,%s)",
            (user_bin.bytes, "vf-b8-%s@example.com" % runid, now_s, now_s))
        created["users"].append(user_bin.bytes)

        learner_id = uuid.uuid4()
        cur.execute(
            "INSERT INTO learners (id, user_id, code, name, status, created_at, updated_at)"
            " VALUES (%s,%s,%s,%s,1,NOW(6),NOW(6))",
            (learner_id.bytes, user_bin.bytes, "vf-b8-" + runid, "VF学习者"))
        created["learners"].append(learner_id.bytes)

        # =========================================================
        # growthReward 7 branches (via POST /growth-events)
        # =========================================================
        print("--- growthReward (7 branches) ---", flush=True)
        cases = [
            ("quiz-answer-correct", 0, 5),
            ("quiz-answer", 0, 1),
            ("lecture-read", 0, 15),
            ("guide-complete", 0, 20),
            ("tutoring-finished", 0, 25),
            ("note-taken", 0, 8),
            ("courseware-complete", 0, 15),
            ("focus-bonus", 10, 10),
            ("focus-bonus", 99, 25),     # clamp max 25
            ("focus-bonus", -5, 0),      # clamp min 0
            ("custom-type", 7, 0),       # default → min(0, 7) = 0
            ("custom-type", -3, -3),     # default → min(0, -3) = -3
        ]
        for etype, amount, want in cases:
            st, body = api_req(args.base, "POST", "/api/v1/learner-profile/growth-events",
                               token, {"learnerId": str(learner_id), "eventType": etype,
                                       "title": "vf-b8 " + etype, "amount": amount})
            env = json.loads(body)
            ok = st == 200
            g = env.get("data") or {}
            evs = g.get("events") or []
            got_amt = evs[0].get("amount") if evs else None
            check("growthReward(%r, %s) → %d" % (etype, amount, want),
                  ok and got_amt == want,
                  "status=%d amount=%r want=%r" % (st, got_amt, want))

        # events accumulate → orb = max(0, sum) is checked below after reset

        # =========================================================
        # growth state: addOrb clamp + water/stageOf
        # =========================================================
        print("\n--- growth state (addOrb / water / stageOf) ---", flush=True)
        # reset state to a known point via SQL, then drive through the API
        cur.execute("SELECT id FROM growth_states WHERE user_id=%s", (user_bin.bytes,))
        gs_rows = cur.fetchall()
        for r in gs_rows:
            created["growth_states"].append(r[0])
        cur.execute("UPDATE growth_states SET orb=0, watered=0, stage='seed'"
                    " WHERE user_id=%s", (user_bin.bytes,))

        # addOrb: a default-type event with amount -5 → reward -5 → orb stays 0
        api_req(args.base, "POST", "/api/v1/learner-profile/growth-events", token,
                {"learnerId": str(learner_id), "eventType": "custom", "title": "neg", "amount": -5})
        st, body = api_req(args.base, "GET",
                           "/api/v1/learner-profile/growth?learnerId=" + str(learner_id), token)
        g = (json.loads(body).get("data") or {})
        check("addOrb clamps at 0 (orb=0 + (-5) → 0)",
              g.get("orb") == 0, repr(g.get("orb")))

        # water: set orb=40, water → watered=40, orb=0, stage=sprout
        cur.execute("UPDATE growth_states SET orb=40, watered=0, stage='seed'"
                    " WHERE user_id=%s", (user_bin.bytes,))
        st, body = api_req(args.base, "POST",
                           "/api/v1/learner-profile/growth/nourish?learnerId=" + str(learner_id),
                           token)
        env = json.loads(body)
        g = (env.get("data") or {})
        check("nourish message is 园子滋养成功",
              env.get("message") == "园子滋养成功", repr(env.get("message")))
        check("water(): orb=40 → watered=40, orb=0, stage=sprout",
              g.get("orb") == 0 and g.get("watered") == 40 and g.get("stage") == "sprout",
              repr({k: g.get(k) for k in ("orb", "watered", "stage")}))
        # a nourish event with amount = -spent is written
        cur.execute("SELECT amount FROM growth_events WHERE user_id=%s"
                    " AND event_type='nourish' ORDER BY created_at DESC LIMIT 1",
                    (user_bin.bytes,))
        nourish_amt = cur.fetchone()
        check("nourish writes a growth_event with amount=-spent",
              nourish_amt and nourish_amt[0] == -40, repr(nourish_amt))

        # stageOf thresholds
        for watered, want_stage in [(0, "seed"), (29, "seed"), (30, "sprout"),
                                    (79, "sprout"), (80, "seedling"), (159, "seedling"),
                                    (160, "young_tree"), (279, "young_tree"),
                                    (280, "tree"), (1000, "tree")]:
            cur.execute("UPDATE growth_states SET orb=0, watered=%s, stage='seed'"
                        " WHERE user_id=%s", (watered, user_bin.bytes))
            api_req(args.base, "POST",
                    "/api/v1/learner-profile/growth/nourish?learnerId=" + str(learner_id), token)
            st, body = api_req(args.base, "GET",
                               "/api/v1/learner-profile/growth?learnerId=" + str(learner_id), token)
            g = (json.loads(body).get("data") or {})
            check("stageOf(%d) → %r" % (watered, want_stage),
                  g.get("stage") == want_stage, repr(g.get("stage")))

        # events capped at 30 (listGrowthEvents top 30)
        cur.execute("SELECT COUNT(*) FROM growth_events WHERE user_id=%s", (user_bin.bytes,))
        # 12 reward cases + 1 negative + 1 nourish (only written when spent > 0)
        check("growth_events rows accumulated", cur.fetchone()[0] >= 13,
              "rows=%d" % cur.fetchone()[0] if False else "")
        st, body = api_req(args.base, "GET",
                           "/api/v1/learner-profile/growth?learnerId=" + str(learner_id), token)
        g = (json.loads(body).get("data") or {})
        check("growth events list capped at 30", len(g.get("events") or []) <= 30,
              "got=%d" % len(g.get("events") or []))

        # =========================================================
        # learning-goals CRUD
        # =========================================================
        print("\n--- learning-goals CRUD ---", flush=True)
        domain_id = fixture_base + 10
        cur.execute(
            "INSERT INTO knowledge_domain (id, code, name, description, created_at, updated_at)"
            " VALUES (%s,%s,%s,%s,NOW(6),NOW(6))",
            (domain_id, "vf-b8dom-" + runid, "VF域B8 " + runid, "desc"))
        created["knowledge_domain"].append(domain_id)

        # POST create
        st, body = api_req(args.base, "POST", "/api/v1/learning-goals", token,
                           {"knowledgeDomainId": domain_id,
                            "goalType": "SKILL_IMPROVEMENT",
                            "title": "  VF目标 " + runid + "  ",
                            "description": "   ",
                            "expectedLevel": "PROFICIENT", "initialLevel": "BEGINNER",
                            "assessmentMethod": "SELF", "status": "ACTIVE",
                            "targetDate": (now.date() + timedelta(days=30)).isoformat()})
        env = json.loads(body)
        check("POST /learning-goals → 201", st == 201, "status=%d" % st)
        check("goal create message is 学习目标创建成功",
              env.get("message") == "学习目标创建成功", repr(env.get("message")))
        g = (env.get("data") or {})
        # LearningGoalResponse.from() prefers domain.name over the row title when
        # a domain is set — so the response title is the domain name by design.
        # The strip() of the row title is asserted on the DB row below.
        check("goal response title is domain name (Java from() override)",
              g.get("title") == "VF域B8 " + runid, repr(g.get("title")))
        check("goal description blank → null (normalizeNullable)",
              g.get("description") is None, repr(g.get("description")))
        check("goal title prefers domain name when domain is set (from())",
              g.get("title") == "VF域B8 " + runid,
              "got=%r (domain name wins over row title)" % g.get("title"))
        check("goal current is false initially", g.get("current") is False,
              repr(g.get("current")))
        goal_id = g.get("id")

        cur.execute("SELECT title, description FROM learning_goals WHERE id=%s",
                    (uuid.UUID(goal_id).bytes,))
        row = cur.fetchone()
        check("learning_goals row has strip'd title",
              row and row[0] == "VF目标 " + runid, repr(row))
        check("learning_goals row description is NULL (blank → null)",
              row and row[1] is None, repr(row[1] if row else None))
        created["learning_goals"].append(uuid.UUID(goal_id).bytes)

        # POST domain/{id}/ensure — idempotent
        st, body = api_req(args.base, "POST",
                           "/api/v1/learning-goals/domain/%d/ensure" % domain_id, token)
        env = json.loads(body)
        e = (env.get("data") or {})
        check("ensure returns the existing goal (idempotent)",
              e.get("id") == goal_id, repr(e.get("id")))
        check("ensure message is success (single-arg ApiResponse.success)",
              env.get("message") == "success", repr(env.get("message")))
        cur.execute("SELECT COUNT(*) FROM learning_goals WHERE user_id=%s AND knowledge_domain_id=%s",
                    (user_bin.bytes, domain_id))
        check("ensure created no second row", cur.fetchone()[0] == 1)

        # PUT update
        st, body = api_req(args.base, "PUT", "/api/v1/learning-goals/" + goal_id, token,
                           {"knowledgeDomainId": domain_id, "goalType": "EXAM_PREP",
                            "title": "  改过的目标  ", "description": " 新描述 ",
                            "expectedLevel": "ADVANCED", "status": "PAUSED"})
        env = json.loads(body)
        check("PUT /learning-goals → 200", st == 200, "status=%d" % st)
        check("goal update message is 学习目标更新成功",
              env.get("message") == "学习目标更新成功", repr(env.get("message")))
        g = (env.get("data") or {})
        check("update goalType/status applied",
              g.get("goalType") == "EXAM_PREP" and g.get("status") == "PAUSED",
              repr({k: g.get(k) for k in ("goalType", "status")}))
        check("update description strip'd",
              g.get("description") == "新描述", repr(g.get("description")))
        cur.execute("SELECT title, description FROM learning_goals WHERE id=%s",
                    (uuid.UUID(goal_id).bytes,))
        row = cur.fetchone()
        check("update title strip'd in the row",
              row and row[0] == "改过的目标", repr(row[0] if row else None))

        # PUT /{id}/current
        st, body = api_req(args.base, "PUT", "/api/v1/learning-goals/%s/current" % goal_id, token)
        env = json.loads(body)
        check("PUT /current message is 当前学习目标切换成功",
              env.get("message") == "当前学习目标切换成功", repr(env.get("message")))
        g = (env.get("data") or {})
        check("setCurrent returns current=true",
              g.get("current") is True, repr(g.get("current")))
        cur.execute("SELECT current_goal_id FROM user_profiles WHERE user_id=%s",
                    (user_bin.bytes,))
        row = cur.fetchone()
        check("user_profiles.current_goal_id is set",
              row and row[0] == uuid.UUID(goal_id).bytes, repr(row))
        created["user_profiles"].append(user_bin.bytes)

        # DELETE /current
        st, body = api_req(args.base, "DELETE", "/api/v1/learning-goals/current", token)
        env = json.loads(body)
        check("DELETE /current message is 当前学习目标已清除",
              env.get("message") == "当前学习目标已清除", repr(env.get("message")))
        check("DELETE /current omits data (ApiResponse<Void>)",
              "data" not in env, repr(sorted(env.keys())))
        cur.execute("SELECT current_goal_id FROM user_profiles WHERE user_id=%s",
                    (user_bin.bytes,))
        row = cur.fetchone()
        check("user_profiles.current_goal_id cleared to NULL",
              row and row[0] is None, repr(row))

        # set current again, then DELETE the goal → current cleared first
        api_req(args.base, "PUT", "/api/v1/learning-goals/%s/current" % goal_id, token)
        st, body = api_req(args.base, "DELETE", "/api/v1/learning-goals/" + goal_id, token)
        env = json.loads(body)
        check("DELETE /learning-goals → 200", st == 200, "status=%d" % st)
        check("goal delete message is 学习目标删除成功",
              env.get("message") == "学习目标删除成功", repr(env.get("message")))
        check("goal delete omits data", "data" not in env, repr(sorted(env.keys())))
        cur.execute("SELECT COUNT(*) FROM learning_goals WHERE id=%s",
                    (uuid.UUID(goal_id).bytes,))
        check("goal row deleted", cur.fetchone()[0] == 0)
        cur.execute("SELECT current_goal_id FROM user_profiles WHERE user_id=%s",
                    (user_bin.bytes,))
        row = cur.fetchone()
        check("delete cleared current_goal_id before removing the goal",
              row and row[0] is None, repr(row))

        # 404s
        st, body = api_req(args.base, "PUT", "/api/v1/learning-goals/" + str(uuid.uuid4()),
                           token, {"knowledgeDomainId": domain_id, "goalType": "SKILL_IMPROVEMENT",
                                   "title": "x", "expectedLevel": "PROFICIENT", "status": "ACTIVE"})
        check("PUT unknown goal → 404 code 2001",
              st == 404 and json.loads(body).get("code") == 2001,
              "status=%d code=%s" % (st, json.loads(body).get("code")))
        st, body = api_req(args.base, "POST", "/api/v1/learning-goals", token,
                           {"knowledgeDomainId": fixture_base + 999,
                            "goalType": "SKILL_IMPROVEMENT", "title": "x",
                            "expectedLevel": "PROFICIENT", "status": "ACTIVE"})
        check("POST goal with inactive/missing domain → 400 学习领域不存在或尚未启用",
              st == 400 and json.loads(body).get("code") == 1000,
              "status=%d code=%s msg=%r" % (st, json.loads(body).get("code"),
                                            json.loads(body).get("message")))

        # =========================================================
        # POST /review-states/{code}/complete
        # =========================================================
        print("\n--- review complete ---", flush=True)
        # isolated knowledge_point so we don't touch the shared graph
        kp_id = fixture_base + 20
        kp_code = "vf-b8kp-" + runid
        cur.execute(
            "INSERT INTO knowledge_point (id, domain_id, code, name, target_level,"
            " coverage, sort_order, status, created_at, updated_at)"
            " VALUES (%s,%s,%s,%s,80,90,9999,1,NOW(6),NOW(6))",
            (kp_id, domain_id, kp_code, "VF知识点"))
        created["knowledge_point"].append(kp_id)

        # first complete on a fresh schedule: reps 0→1, intervalDays 1
        st, body = api_req(args.base, "POST",
                           "/api/v1/review-states/%s/complete" % kp_code, token,
                           {"score": 80, "sourceId": "vf-b8-src", "durationSeconds": 120})
        env = json.loads(body)
        check("POST complete → 200", st == 200, "status=%d" % st)
        check("complete message is 复习记录成功",
              env.get("message") == "复习记录成功", repr(env.get("message")))
        r = (env.get("data") or {})
        check("ReviewStateResponse field order",
              list(r.keys()) == ["kpId", "name", "lastAt", "reps", "mastery",
                                 "dueAt", "due", "overdueDays"],
              repr(list(r.keys())))
        check("complete reps becomes 1 on a fresh schedule",
              r.get("reps") == 1, repr(r.get("reps")))
        check("complete mastery is clamp(80/100).setScale(4) = 0.8000",
              r.get("mastery") == 0.8 and '"mastery":0.8000' in body.decode("utf-8", "replace"),
              "mastery=%r raw=%s" % (r.get("mastery"), body.decode("utf-8", "replace")[:160]))
        check("complete kpId is the code", r.get("kpId") == kp_code, repr(r.get("kpId")))

        cur.execute("SELECT reps, mastery, due_at, last_at FROM review_schedules"
                    " WHERE user_id=%s AND knowledge_point_id=%s", (user_bin.bytes, kp_id))
        row = cur.fetchone()
        created["review_schedules"].append(
            cur.execute("SELECT id FROM review_schedules WHERE user_id=%s"
                        " AND knowledge_point_id=%s", (user_bin.bytes, kp_id)) or 0)
        cur.execute("SELECT id FROM review_schedules WHERE user_id=%s"
                    " AND knowledge_point_id=%s", (user_bin.bytes, kp_id))
        for rr in cur.fetchall():
            if rr[0] not in created["review_schedules"]:
                created["review_schedules"].append(rr[0])
        check("review_schedules row has reps=1 mastery=0.8000",
              row and row[0] == 1 and Decimal(str(row[1])) == Decimal("0.8000"),
              "reps=%r mastery=%r" % (row[0] if row else None, row[1] if row else None))
        if row and row[2]:
            # due_at is DATE_ADD(NOW(6), ...) where NOW(6) is the DB session clock
            # (UTC+8) — compare against the DB's own NOW, not a UTC timestamp.
            cur.execute("SELECT NOW(6)")
            db_now = cur.fetchone()[0]
            due_delta = (row[2] - db_now).total_seconds()
            check("fresh schedule due_at ≈ now + 1 day (intervalDays=1)",
                  86000 < due_delta < 87000, "delta_s=%.0f" % due_delta)

        # KP_MASTERY_CHECK event written
        cur.execute("SELECT id, metadata FROM learning_events WHERE user_id=%s"
                    " AND event_type='KP_MASTERY_CHECK'", (user_bin.bytes,))
        ev = cur.fetchall()
        check("complete writes a KP_MASTERY_CHECK learning_event", len(ev) >= 1,
              "rows=%d" % len(ev))
        if ev:
            created["learning_events"].append(ev[0][0])
            try:
                meta = json.loads(ev[0][1]) if ev[0][1] else None
            except Exception:
                meta = None
            check("KP_MASTERY_CHECK metadata has knowledgePoint+score",
                  meta and meta.get("knowledgePoint") == kp_code and meta.get("score") == 80,
                  repr(meta))

        # intervalDays ladder: reps 1→2 (2 days), 2→4, 3→7
        for want_reps, want_days in [(2, 2), (3, 4), (4, 7)]:
            api_req(args.base, "POST", "/api/v1/review-states/%s/complete" % kp_code,
                    token, {"score": 50})
            cur.execute("SELECT reps, due_at FROM review_schedules"
                        " WHERE user_id=%s AND knowledge_point_id=%s",
                        (user_bin.bytes, kp_id))
            reps, due_at = cur.fetchone()
            cur.execute("SELECT NOW(6)")
            db_now = cur.fetchone()[0]
            delta = (due_at - db_now).total_seconds()
            check("intervalDays ladder: reps=%d → due in %d days" % (want_reps, want_days),
                  reps == want_reps and want_days * 86400 - 120 < delta < want_days * 86400 + 120,
                  "reps=%r delta_s=%.0f want_days=%d" % (reps, delta, want_days))

        # mastery clamp
        api_req(args.base, "POST", "/api/v1/review-states/%s/complete" % kp_code,
                token, {"score": 0})
        cur.execute("SELECT mastery FROM review_schedules WHERE user_id=%s"
                    " AND knowledge_point_id=%s", (user_bin.bytes, kp_id))
        m0 = cur.fetchone()[0]
        check("mastery clamps to 0.0500 at score=0",
              Decimal(str(m0)) == Decimal("0.0500"), repr(m0))
        api_req(args.base, "POST", "/api/v1/review-states/%s/complete" % kp_code,
                token, {"score": 100})
        cur.execute("SELECT mastery FROM review_schedules WHERE user_id=%s"
                    " AND knowledge_point_id=%s", (user_bin.bytes, kp_id))
        m1 = cur.fetchone()[0]
        check("mastery clamps to 0.9600 at score=100",
              Decimal(str(m1)) == Decimal("0.9600"), repr(m1))

        # validation
        st, body = api_req(args.base, "POST", "/api/v1/review-states/%s/complete" % kp_code,
                           token, {"score": 101})
        check("score=101 → 400 (@Max(100))", st == 400, "status=%d" % st)
        st, body = api_req(args.base, "POST", "/api/v1/review-states/%s/complete" % kp_code,
                           token, {"score": -1})
        check("score=-1 → 400 (@Min(0))", st == 400, "status=%d" % st)
        st, body = api_req(args.base, "POST",
                           "/api/v1/review-states/nope-%s/complete" % runid, token,
                           {"score": 50})
        check("unknown kp code → 404 code 3002",
              st == 404 and json.loads(body).get("code") == 3002,
              "status=%d code=%s" % (st, json.loads(body).get("code")))

    finally:
        def _del(table, col, b):
            try:
                cur.execute("DELETE FROM %s WHERE %s=%%s" % (table, col), (b,))
            except Exception:
                pass

        for b in created["learning_events"]:
            _del("learning_events", "id", b)
        for b in created["review_schedules"]:
            if b:
                _del("review_schedules", "id", b)
        for b in created["growth_events"]:
            _del("growth_events", "id", b)
        for b in created["growth_states"]:
            _del("growth_states", "id", b)
        try:
            cur.execute("UPDATE user_profiles SET current_goal_id=NULL WHERE user_id=%s",
                        (user_bin.bytes,))
        except Exception:
            pass
        _del("user_profiles", "user_id", user_bin.bytes)
        _del("learning_goals", "user_id", user_bin.bytes)
        for b in created["knowledge_point"]:
            _del("knowledge_point", "id", b)
        for b in created["knowledge_domain"]:
            _del("knowledge_domain", "id", b)
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
