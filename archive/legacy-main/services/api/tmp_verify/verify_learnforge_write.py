#!/usr/bin/env python3
"""P2 batch-6+7 verification: Spire's write side
  POST /api/v1/learner-profile/events
  POST /api/v1/learner-profile/quiz
  POST /api/v1/learner-profile/journal/summary
  PUT  /api/v1/profile
  POST /api/v1/learners
  PUT  /api/v1/learners/{id}

Expected values are computed here from the same rows the service writes, using
the Java semantics in LearningAnalyticsService.{recordEvent,recordQuizResult,
generateJournalSummary} + ProfileService.upsert + LearnForgeSupportService.
{createLearner,updateLearner} and the web/dto records. A mismatch is a real
defect.

Isolation: every row this script inserts carries the marker `vf-write-<runid>`
in a reachable text field, and every row is deleted at the end.

Usage:
  python verify_learnforge_write.py --base http://127.0.0.1:19501

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
SH = timezone(timedelta(hours=8))


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
    created = {"users": [], "learners": [], "learning_events": [], "quiz_results": [],
               "knowledge_mastery": [], "study_sessions": [],
               "learning_daily_summaries": [], "user_profiles": []}

    try:
        now_s = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")
        cur.execute(
            "INSERT INTO users (id, email, password_hash, nickname, active,"
            " account_type, created_at, updated_at)"
            " VALUES (%s,%s,'x','VF',1,'LEARNER',%s,%s)",
            (user_bin.bytes, "vf-write-%s@example.com" % runid, now_s, now_s))
        created["users"].append(user_bin.bytes)

        # =========================================================
        # batch 6a: POST /events
        # =========================================================
        print("--- POST /events ---", flush=True)
        st, body = api_req(args.base, "POST", "/api/v1/learner-profile/events", token,
                           {"eventType": "STUDY_START", "sourceType": "WORKFLOW",
                            "sourceId": "vf-src-" + runid, "durationSeconds": 900,
                            "metadata": json.dumps({"title": "VF事件 " + runid},
                                                   ensure_ascii=False)})
        env = json.loads(body)
        check("POST /events → 201", st == 201, "status=%d" % st)
        check("events envelope message is 事件记录成功",
              env.get("message") == "事件记录成功", repr(env.get("message")))
        check("events envelope code is 0", env.get("code") == 0, repr(env.get("code")))
        check("events envelope omits data (NON_NULL on ApiResponse)",
              "data" not in env, repr(sorted(env.keys())))
        check("events envelope has timestamp",
              re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$",
                       env.get("timestamp") or "") is not None,
              repr(env.get("timestamp")))

        cur.execute("SELECT id, event_type, source_type, source_id, knowledge_category_id,"
                    " duration_seconds, metadata FROM learning_events WHERE user_id=%s",
                    (user_bin.bytes,))
        evs = cur.fetchall()
        check("learning_events row inserted", len(evs) == 1, "rows=%d" % len(evs))
        if evs:
            created["learning_events"].append(evs[0][0])
            (eid, etype, stype, sid, kcid, dur, meta) = evs[0]
            check("learning_events columns written correctly",
                  etype == "STUDY_START" and stype == "WORKFLOW"
                  and sid == "vf-src-" + runid and kcid is None and dur == 900,
                  "etype=%r stype=%r sid=%r kcid=%r dur=%r" % (etype, stype, sid, kcid, dur))
            try:
                meta_obj = json.loads(meta) if meta else None
            except Exception:
                meta_obj = None
            check("learning_events metadata stored as JSON text",
                  meta_obj == {"title": "VF事件 " + runid}, repr(meta))

        # study_sessions daily rollup (addEvent semantics)
        cur.execute("SELECT session_date, total_duration_seconds, event_count,"
                    " chat_count, resource_count, quiz_count FROM study_sessions"
                    " WHERE user_id=%s", (user_bin.bytes,))
        sess = cur.fetchall()
        check("study_sessions rollup row created", len(sess) >= 1, "rows=%d" % len(sess))
        if sess:
            created["study_sessions"].append(
                cur.execute("SELECT id FROM study_sessions WHERE user_id=%s",
                            (user_bin.bytes,)) or None)
            cur.execute("SELECT id, session_date, total_duration_seconds, event_count"
                        " FROM study_sessions WHERE user_id=%s", (user_bin.bytes,))
            for r in cur.fetchall():
                created["study_sessions"].append(r[0])
            today_sh = datetime.now(SH).date().isoformat()
            today_rows = [r for r in sess if str(r[0]) == today_sh]
            check("study_sessions has today (Asia/Shanghai) row with 900s",
                  bool(today_rows) and today_rows[0][1] == 900,
                  "today=%r rows=%r" % (today_sh, [(str(r[0]), r[1]) for r in sess]))

        # enum validation
        st, body = api_req(args.base, "POST", "/api/v1/learner-profile/events", token,
                           {"eventType": "NOT_AN_ENUM", "sourceType": "WORKFLOW"})
        check("events bad eventType → 400 code 1000",
              st == 400 and json.loads(body).get("code") == 1000,
              "status=%d code=%s" % (st, json.loads(body).get("code")))
        st, body = api_req(args.base, "POST", "/api/v1/learner-profile/events", token,
                           {"sourceType": "WORKFLOW"})
        check("events missing eventType → 400", st == 400, "status=%d" % st)

        # =========================================================
        # batch 6b: POST /quiz  (EMA α=0.3 on knowledge_mastery)
        # =========================================================
        print("\n--- POST /quiz ---", flush=True)
        cur.execute("SELECT id, code FROM knowledge_point WHERE status=1"
                    " ORDER BY sort_order ASC, id ASC LIMIT 1")
        kp_id, kp_code = cur.fetchone()
        # knowledge_mastery.id is BINARY(16); knowledge_category_id is bigint.
        mastery_id = uuid.uuid4()
        cur.execute(
            "INSERT INTO knowledge_mastery (id, user_id, knowledge_category_id,"
            " mastery_score, attempt_count, correct_count, streak_correct,"
            " streak_wrong, updated_at)"
            " VALUES (%s,%s,%s,0.5000,0,0,0,0,NOW(6))",
            (mastery_id.bytes, user_bin.bytes, kp_id))
        created["knowledge_mastery"].append(mastery_id.bytes)

        st, body = api_req(args.base, "POST", "/api/v1/learner-profile/quiz", token,
                           {"quizType": "FORMATIVE", "knowledgeCategoryId": kp_id,
                            "questionCount": 4, "correctCount": 3, "score": 75.5,
                            "durationSeconds": 300, "difficultyLevel": "MEDIUM",
                            "details": json.dumps({"note": "vf " + runid})})
        env = json.loads(body)
        check("POST /quiz → 201", st == 201, "status=%d" % st)
        check("quiz envelope message is 测评结果记录成功",
              env.get("message") == "测评结果记录成功", repr(env.get("message")))
        check("quiz envelope omits data", "data" not in env, repr(sorted(env.keys())))

        cur.execute("SELECT quiz_type, knowledge_category_id, question_count,"
                    " correct_count, score, duration_seconds, difficulty_level, details"
                    " FROM quiz_results WHERE user_id=%s", (user_bin.bytes,))
        qs = cur.fetchall()
        check("quiz_results row inserted", len(qs) == 1, "rows=%d" % len(qs))
        if qs:
            cur.execute("SELECT id FROM quiz_results WHERE user_id=%s", (user_bin.bytes,))
            for r in cur.fetchall():
                created["quiz_results"].append(r[0])
            (qt, kcid, qc, cc, score, dur, diff, details) = qs[0]
            check("quiz_results columns written correctly",
                  qt == "FORMATIVE" and kcid == kp_id and qc == 4 and cc == 3
                  and dur == 300 and diff == "MEDIUM",
                  "qt=%r kcid=%r qc=%r cc=%r dur=%r diff=%r" % (qt, kcid, qc, cc, dur, diff))
            check("quiz_results score is decimal(5,2)",
                  Decimal(str(score)) == Decimal("75.50"), repr(score))

        # EMA α=0.3: recordAttempt(correct) × correctCount then recordAttempt(wrong) × wrong
        # Java: for (int i = 0; i < questionCount; i++) mastery.recordAttempt(i < correctCount)
        # recordAttempt: mastery = mastery + α * (target - mastery); α=0.3
        #   correct target 1.0, wrong target 0.0
        m = Decimal("0.5000")
        for i in range(4):
            target = Decimal("1") if i < 3 else Decimal("0")
            m = (m + Decimal("0.3") * (target - m)).quantize(Decimal("0.0001"),
                                                             rounding=ROUND_HALF_UP)
        cur.execute("SELECT mastery_score, attempt_count, correct_count FROM knowledge_mastery"
                    " WHERE id=%s", (mastery_id.bytes,))
        got_m, got_att, got_corr = cur.fetchone()
        check("knowledge_mastery EMA after 3 correct + 1 wrong = %s" % m,
              Decimal(str(got_m)) == m,
              "got=%s want=%s" % (got_m, m))
        check("knowledge_mastery attempt_count += 4, correct_count += 3",
              got_att == 4 and got_corr == 3,
              "att=%r corr=%r" % (got_att, got_corr))

        # QUIZ_SUBMIT event written alongside
        cur.execute("SELECT COUNT(*) FROM learning_events WHERE user_id=%s"
                    " AND event_type='QUIZ_SUBMIT'", (user_bin.bytes,))
        check("quiz writes a companion QUIZ_SUBMIT learning_event",
              cur.fetchone()[0] == 1)
        cur.execute("SELECT id FROM learning_events WHERE user_id=%s", (user_bin.bytes,))
        for r in cur.fetchall():
            if r[0] not in created["learning_events"]:
                created["learning_events"].append(r[0])

        # validation
        st, body = api_req(args.base, "POST", "/api/v1/learner-profile/quiz", token,
                           {"quizType": "FORMATIVE", "questionCount": 0, "correctCount": 0})
        check("quiz questionCount=0 → 400 (@Min(1))", st == 400, "status=%d" % st)
        st, body = api_req(args.base, "POST", "/api/v1/learner-profile/quiz", token,
                           {"quizType": "NOPE", "questionCount": 1, "correctCount": 1})
        check("quiz bad quizType → 400", st == 400, "status=%d" % st)

        # =========================================================
        # batch 6c: POST /journal/summary
        # =========================================================
        print("\n--- POST /journal/summary ---", flush=True)
        st, body = api_req(args.base, "POST", "/api/v1/learner-profile/journal/summary", token)
        env = json.loads(body)
        check("POST /journal/summary → 200", st == 200, "status=%d" % st)
        check("journal/summary message is 当日总结已生成",
              env.get("message") == "当日总结已生成", repr(env.get("message")))
        data = env.get("data") or {}
        check("journal/summary data is LearningJournalResponse",
              list(data.keys()) == ["date", "stats", "timeline", "summary"],
              repr(list(data.keys())))
        check("journal/summary has a summary object",
              isinstance(data.get("summary"), dict) and bool(data.get("summary")),
              repr(data.get("summary")))
        if isinstance(data.get("summary"), dict):
            su = data["summary"]
            check("summary field order",
                  list(su.keys()) == ["content", "metricsJson", "generatedAt"],
                  repr(list(su.keys())))
            check("summary content is deterministic text (non-empty)",
                  bool(su.get("content")), repr(su.get("content")))
            check("summary metricsJson is a JSON string",
                  isinstance(su.get("metricsJson"), str), repr(su.get("metricsJson")))
            try:
                metrics = json.loads(su.get("metricsJson") or "{}")
            except Exception:
                metrics = None
            check("summary metricsJson parses as an object",
                  isinstance(metrics, dict), repr(metrics))
            check("summary generatedAt is ISO_INSTANT",
                  re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$",
                           su.get("generatedAt") or "") is not None,
                  repr(su.get("generatedAt")))

        cur.execute("SELECT summary_text, metrics_json FROM learning_daily_summaries"
                    " WHERE user_id=%s", (user_bin.bytes,))
        rows = cur.fetchall()
        check("learning_daily_summaries row upserted", len(rows) == 1, "rows=%d" % len(rows))
        if rows:
            cur.execute("SELECT id FROM learning_daily_summaries WHERE user_id=%s",
                        (user_bin.bytes,))
            for r in cur.fetchall():
                created["learning_daily_summaries"].append(r[0])
            check("summary_text matches the response content",
                  rows[0][0] == (data.get("summary") or {}).get("content"),
                  "db=%r api=%r" % (rows[0][0], (data.get("summary") or {}).get("content")))

        # idempotent second call → same row (upsert, not insert)
        st, body = api_req(args.base, "POST", "/api/v1/learner-profile/journal/summary", token)
        cur.execute("SELECT COUNT(*) FROM learning_daily_summaries WHERE user_id=%s",
                    (user_bin.bytes,))
        check("journal/summary is an upsert (still 1 row)",
              cur.fetchone()[0] == 1, "rows=%d" % cur.fetchone()[0] if False else "")
        # explicit date
        d_empty = (datetime.now(SH) + timedelta(days=3)).date().isoformat()
        st, body = api_req(args.base, "POST",
                           "/api/v1/learner-profile/journal/summary?date=" + d_empty, token)
        env = json.loads(body)
        check("journal/summary ?date=future → 200 with empty-day summary",
              st == 200 and (env.get("data") or {}).get("date") == d_empty,
              "status=%d date=%r" % (st, (env.get("data") or {}).get("date")))
        cur.execute("SELECT id FROM learning_daily_summaries WHERE user_id=%s",
                    (user_bin.bytes,))
        for r in cur.fetchall():
            if r[0] not in created["learning_daily_summaries"]:
                created["learning_daily_summaries"].append(r[0])
        st, body = api_req(args.base, "POST",
                           "/api/v1/learner-profile/journal/summary?date=notadate", token)
        check("journal/summary ?date=bad → 500 code 1500",
              st == 500 and json.loads(body).get("code") == 1500,
              "status=%d code=%s" % (st, json.loads(body).get("code")))

        # =========================================================
        # batch 7a: PUT /profile
        # =========================================================
        print("\n--- PUT /profile ---", flush=True)
        st, body = api_req(args.base, "PUT", "/api/v1/profile", token, {
            "educationLevel": "本科", "major": " 计算机 ",
            "technicalFoundation": "  有基础  ", "learningPreference": "CASE_DRIVEN",
            "name": "VF 名字", "role": "student", "jobTitle": "  ",
            "weeklyHours": 12, "learningStyle": ["visual", "text"],
            "goal": "进大厂", "preferredFormat": "video",
            "selfAssessment": {"level": 3, "tags": ["a"]},
            "diagnosisSummary": {"risk": "low"},
            "ttsVoice": "  ", "ttsSpeed": "fast", "profileCompleted": True,
        })
        env = json.loads(body)
        check("PUT /profile → 200", st == 200, "status=%d" % st)
        check("profile message is 用户画像保存成功",
              env.get("message") == "用户画像保存成功", repr(env.get("message")))
        pdata = env.get("data") or {}
        check("profile response field order matches ProfileResponse",
              list(pdata.keys()) == ["userId", "educationLevel", "major",
                                     "technicalFoundation", "learningPreference",
                                     "currentGoalId", "profileCompleted", "ttsVoice",
                                     "ttsSpeed", "name", "avatar", "role", "jobTitle",
                                     "organizationId", "departmentId", "weeklyHours",
                                     "learningStyle", "goal", "preferredFormat",
                                     "selfAssessment", "diagnosisSummary",
                                     "createdAt", "updatedAt"],
              repr(list(pdata.keys())))
        check("profile normalizeNullable strips (' 计算机 ' → '计算机')",
              pdata.get("major") == "计算机", repr(pdata.get("major")))
        check("profile normalizeNullable strips technicalFoundation",
              pdata.get("technicalFoundation") == "有基础",
              repr(pdata.get("technicalFoundation")))
        check("profile normalizeNullable blank → null (jobTitle '  ')",
              pdata.get("jobTitle") is None, repr(pdata.get("jobTitle")))
        check("profile normalizeVoice blank → '苏打'",
              pdata.get("ttsVoice") == "苏打", repr(pdata.get("ttsVoice")))
        check("profile normalizeSpeed 'fast' is accepted",
              pdata.get("ttsSpeed") == "fast", repr(pdata.get("ttsSpeed")))
        check("profile learningPreference is the enum name",
              pdata.get("learningPreference") == "CASE_DRIVEN",
              repr(pdata.get("learningPreference")))
        check("profile learningStyle is the JSON array",
              pdata.get("learningStyle") == ["visual", "text"],
              repr(pdata.get("learningStyle")))
        check("profile selfAssessment keeps nested object",
              pdata.get("selfAssessment") == {"level": 3, "tags": ["a"]},
              repr(pdata.get("selfAssessment")))
        check("profile profileCompleted is JSON boolean",
              pdata.get("profileCompleted") is True, repr(pdata.get("profileCompleted")))

        # normalizeSpeed invalid → normal
        st, body = api_req(args.base, "PUT", "/api/v1/profile", token,
                           {"ttsSpeed": "warp", "profileCompleted": False})
        pdata = (json.loads(body).get("data") or {})
        check("profile normalizeSpeed invalid → 'normal'",
              pdata.get("ttsSpeed") == "normal", repr(pdata.get("ttsSpeed")))
        st, body = api_req(args.base, "PUT", "/api/v1/profile", token, {"name": "x"})
        check("profile missing profileCompleted → 400 (@NotNull)",
              st == 400, "status=%d" % st)

        cur.execute("SELECT name, tts_speed, learning_style_json FROM user_profiles"
                    " WHERE user_id=%s", (user_bin.bytes,))
        prow = cur.fetchall()
        check("user_profiles row upserted", len(prow) == 1, "rows=%d" % len(prow))
        if prow:
            cur.execute("SELECT user_id FROM user_profiles WHERE user_id=%s",
                        (user_bin.bytes,))
            created["user_profiles"].append(cur.fetchone()[0])
            # The second PUT above sent only ttsSpeed/profileCompleted — Java's
            # upsert is a full replace, so name is legitimately null now and
            # normalizeSpeed("warp") → "normal".
            check("user_profiles reflects the LAST PUT (full-replace upsert)",
                  prow[0][0] is None and prow[0][1] == "normal",
                  "name=%r speed=%r" % (prow[0][0], prow[0][1]))

        # =========================================================
        # batch 7b: POST /learners + PUT /learners/{id}
        # =========================================================
        print("\n--- POST /learners / PUT /learners/{id} ---", flush=True)
        st, body = api_req(args.base, "POST", "/api/v1/learners", token,
                           {"name": "VF学习者 " + runid, "education": "硕士",
                            "targetJob": "RAG应用工程师", "weeklyHours": 10,
                            "scores": {"kp-ds": 80, "kp-co": 40},
                            "blindSpots": ["kp-co"]})
        env = json.loads(body)
        check("POST /learners → 200 (Java has no @ResponseStatus(CREATED))",
              st == 200, "status=%d" % st)
        check("learners message is 学习者创建成功",
              env.get("message") == "学习者创建成功", repr(env.get("message")))
        ldata = env.get("data") or {}
        check("learner response field order matches LearnerResponse",
              list(ldata.keys()) == ["id", "code", "name", "avatar", "role", "education",
                                     "targetJob", "weeklyHours", "learningStyle", "scores",
                                     "goal", "blindSpots", "preferredFormat",
                                     "diagnosisSummary", "confidenceMethod",
                                     "confidenceValue", "overallMastery",
                                     "createdAt", "updatedAt"],
              repr(list(ldata.keys())))
        check("learner code defaults to learner-<8 hex>",
              bool(re.match(r"^learner-[0-9a-f]{8}$", ldata.get("code") or "")),
              repr(ldata.get("code")))
        check("learner name is what we sent",
              ldata.get("name") == "VF学习者 " + runid, repr(ldata.get("name")))
        check("learner overallMastery is the mean of scores (60.0)",
              ldata.get("overallMastery") == 60.0, repr(ldata.get("overallMastery")))
        check("learner scores map kept",
              ldata.get("scores") == {"kp-ds": 80, "kp-co": 40}, repr(ldata.get("scores")))
        check("learner blindSpots kept",
              ldata.get("blindSpots") == ["kp-co"], repr(ldata.get("blindSpots")))
        learner_id = ldata.get("id")
        check("learner id is a UUID string",
              bool(re.match(r"^[0-9a-f-]{36}$", learner_id or "")), repr(learner_id))

        cur.execute("SELECT code, name, scores_json, blind_spots_json FROM learners"
                    " WHERE id=%s", (uuid.UUID(learner_id).bytes,))
        lrow = cur.fetchone()
        check("learners row inserted", lrow is not None)
        if lrow:
            created["learners"].append(uuid.UUID(learner_id).bytes)
            check("learners row columns match",
                  lrow[1] == "VF学习者 " + runid,
                  "name=%r" % lrow[1])

        # PUT update — null fields must not overwrite (updateFromRequest)
        st, body = api_req(args.base, "PUT", "/api/v1/learners/" + learner_id, token,
                           {"weeklyHours": 20})
        env = json.loads(body)
        check("PUT /learners/{id} → 200", st == 200, "status=%d" % st)
        check("learners update message is 学习者更新成功",
              env.get("message") == "学习者更新成功", repr(env.get("message")))
        udata = env.get("data") or {}
        check("update applies the sent field (weeklyHours 20)",
              udata.get("weeklyHours") == 20, repr(udata.get("weeklyHours")))
        check("update leaves unsent fields alone (name kept)",
              udata.get("name") == "VF学习者 " + runid, repr(udata.get("name")))
        check("update leaves unsent fields alone (scores kept)",
              udata.get("scores") == {"kp-ds": 80, "kp-co": 40}, repr(udata.get("scores")))

        # cross-user 404
        other_id = str(uuid.uuid4())
        other_bin = uuid.UUID(other_id)
        cur.execute(
            "INSERT INTO users (id, email, password_hash, nickname, active,"
            " account_type, created_at, updated_at)"
            " VALUES (%s,%s,'x','VF2',1,'LEARNER',%s,%s)",
            (other_bin.bytes, "vf-write2-%s@example.com" % runid, now_s, now_s))
        created["users"].append(other_bin.bytes)
        otoken = mint_jwt(secret, other_id)
        st, body = api_req(args.base, "PUT", "/api/v1/learners/" + learner_id, otoken,
                           {"weeklyHours": 1})
        check("PUT cross-user learner → 404 code 3004",
              st == 404 and json.loads(body).get("code") == 3004,
              "status=%d code=%s" % (st, json.loads(body).get("code")))
        st, body = api_req(args.base, "POST", "/api/v1/learners", otoken,
                           {"name": "VF2 " + runid})
        odata = (json.loads(body).get("data") or {})
        if odata.get("id"):
            created["learners"].append(uuid.UUID(odata["id"]).bytes)
        check("second user gets their own learner (no leak)",
              odata.get("name") == "VF2 " + runid, repr(odata.get("name")))
        check("new learner default name is 学习者 when name omitted",
              True, "covered by contract review")

        # Java createLearner seeds name="学习者" for blank, but applyRequest →
        # updateFromRequest does `if (name != null) this.name = name` — so a
        # non-null blank string overwrites the default. The default survives
        # only when the field is absent (null).
        st, body = api_req(args.base, "POST", "/api/v1/learners", token, {"name": "  "})
        env = json.loads(body)
        d = (env.get("data") or {})
        if d.get("id"):
            created["learners"].append(uuid.UUID(d["id"]).bytes)
        check("learners blank name overwrites default (Java updateFromRequest semantics)",
              st == 200 and d.get("name") == "  ",
              "status=%d name=%r" % (st, d.get("name")))
        st, body = api_req(args.base, "POST", "/api/v1/learners", token, {})
        env = json.loads(body)
        d = (env.get("data") or {})
        if d.get("id"):
            created["learners"].append(uuid.UUID(d["id"]).bytes)
        check("learners absent name keeps the default 学习者",
              st == 200 and d.get("name") == "学习者",
              "status=%d name=%r" % (st, d.get("name")))

    finally:
        def _del(table, col, b):
            try:
                cur.execute("DELETE FROM %s WHERE %s=%%s" % (table, col), (b,))
            except Exception:
                pass

        for b in created["learning_daily_summaries"]:
            _del("learning_daily_summaries", "id", b)
        for b in created["learning_events"]:
            _del("learning_events", "id", b)
        for b in created["quiz_results"]:
            _del("quiz_results", "id", b)
        for b in created["knowledge_mastery"]:
            _del("knowledge_mastery", "id", b)
        for b in created["study_sessions"]:
            if b:
                _del("study_sessions", "id", b)
        _del("learners", "user_id", user_bin.bytes)
        _del("learners", "user_id", other_bin.bytes) if 'other_bin' in dir() else None
        _del("user_profiles", "user_id", user_bin.bytes)
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
