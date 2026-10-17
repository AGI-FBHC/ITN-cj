#!/usr/bin/env python3
"""P2 read-side verification: Spire's GET /api/v1/learners against the DB.

The expected value is computed here from the same row the service reads, using
the Java semantics spelled out in LearnForgeSupportService.toLearnerResponse
and web/dto/{ApiResponse,LearnerResponse}.java. A mismatch is a real defect.

Isolation: every learner this script touches carries the marker
`vf-learnforge-<runid>` in its `code`, and every row is deleted at the end.
Nothing outside that marker is written.

Usage:
  python verify_learnforge_read.py --base http://127.0.0.1:18811

Env:
  PLATFORM_DB_URL  mysql://user:pw@host:port/db   (or VERIFY_MYSQL_* vars)
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

PASS: list = []
FAIL: list = []


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


# ---- db ----

def db_connect():
    import pymysql

    url = os.environ.get("PLATFORM_DB_URL", "")
    if not url:
        raise SystemExit("PLATFORM_DB_URL is required")
    m = re.match(r"mysql://([^:]+):([^@]*)@([^:/]+):(\d+)/(\S+)", url)
    if not m:
        raise SystemExit("PLATFORM_DB_URL is not mysql://user:pw@host:port/db")
    user, pw, host, port, db = m.group(1), m.group(2), m.group(3), int(m.group(4)), m.group(5)
    conn = pymysql.connect(host=host, port=port, user=user, password=pw, database=db,
                           charset="utf8mb4", autocommit=True)
    return conn


# ---- expected-value model (mirrors the Java) ----

JAVA_NULL_ALWAYS = ("avatar", "role", "education", "targetJob", "weeklyHours",
                    "goal", "preferredFormat", "diagnosisSummary",
                    "confidenceMethod", "confidenceValue")
LEARNER_FIELDS = ["id", "code", "name", "avatar", "role", "education", "targetJob",
                  "weeklyHours", "learningStyle", "scores", "goal", "blindSpots",
                  "preferredFormat", "diagnosisSummary", "confidenceMethod",
                  "confidenceValue", "overallMastery", "createdAt", "updatedAt"]


def parse_scores(raw):
    """Jackson Map<String, Integer>, ACCEPT_FLOAT_AS_INT. Empty on any failure."""
    if raw is None or not str(raw).strip():
        return []
    try:
        obj = json.loads(raw)
    except Exception:
        return []
    if not isinstance(obj, dict):
        return []
    out = []
    for k, v in obj.items():
        if isinstance(v, bool):
            return []          # Jackson would coerce, but this is not a real shape
        if isinstance(v, int):
            out.append((k, v))
        elif isinstance(v, float):
            out.append((k, int(v)))            # truncate toward zero
        elif isinstance(v, str):
            try:
                out.append((k, int(v.strip())))
            except Exception:
                return []
        else:
            return []
    return out


def resolve_scores(raw, kp_codes):
    parsed = parse_scores(raw)
    if parsed:
        return parsed
    seen = set()
    out = []
    for c in kp_codes:
        if c not in seen:
            seen.add(c)
            out.append((c, 50))
    return out


def overall_mastery(scores):
    if not scores:
        return "0"
    mean = sum(v for _, v in scores) / len(scores)
    # BigDecimal.setScale(1, HALF_UP) then toString()
    scaled = mean * 10
    n = int(scaled + 0.5) if scaled >= 0 else int(scaled - 0.5)
    return "%d.%d" % (n // 10, abs(n % 10))


def iso_from_db(text):
    """Java Instant via Hibernate timestamp(6) -> ISO-8601 with Z."""
    t = str(text).replace("T", " ").rstrip("Z")
    if "." in t:
        main, frac = t.split(".", 1)
        frac = (frac + "000000")[:6].rstrip("0")
        return (main + ("." + frac if frac else "")).replace(" ", "T") + "Z"
    return t.replace(" ", "T") + "Z"


# ---- the run ----

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:18811")
    args = ap.parse_args()

    secret = os.environ.get("JWT_SECRET", "")
    if not secret:
        raise SystemExit("JWT_SECRET is required")

    conn = db_connect()
    cur = conn.cursor()

    kp_codes = []
    cur.execute("SELECT code FROM knowledge_point WHERE status=1 ORDER BY sort_order ASC, id ASC")
    kp_codes = [r[0] for r in cur.fetchall()]
    check("knowledge_point codes loaded", len(kp_codes) > 0, "codes=%s" % ",".join(kp_codes))

    runid = uuid.uuid4().hex[:12]
    marker = "vf-learnforge-" + runid
    learner_ids = []

    # learners.user_id has an FK to users.id, so the fixture owns a users row
    # too. Marker email, deleted at the end with the learners it parents.
    fixture_user = uuid.uuid4()
    user_bin = fixture_user.bytes
    user_id = str(fixture_user)
    token = mint_jwt(secret, user_id)
    cur.execute(
        "INSERT INTO users (id, email, password_hash, nickname, active, account_type,"
        " organization_id, admin_scope, created_at, updated_at)"
        " VALUES (%s,%s,%s,%s,1,'LEARNER',NULL,NULL,NOW(6),NOW(6))",
        (fixture_user.bytes, marker + "@vf.invalid", "!" + runid, "VF " + runid)
    )

    def make_learner(code, scores_json, learning_style=None, blind=None):
        lid = uuid.uuid4()
        cur.execute(
            "INSERT INTO learners (id, user_id, code, name, avatar, role, education,"
            " target_job, weekly_hours, learning_style_json, scores_json, goal,"
            " blind_spots_json, preferred_format, diagnosis_summary, status,"
            " created_at, updated_at, confidence_method, confidence_value)"
            " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1,NOW(6),NOW(6),%s,%s)",
            (lid.bytes, user_bin, code, "VF Test " + runid, None, None, None, None,
             None, learning_style, scores_json, None, blind, None, None, "auto", 7)
        )
        learner_ids.append(lid)
        return lid

    try:
        # ---- 1. no learners: list is an empty array inside the envelope ----
        st, body = api_get(args.base, "/api/v1/learners", token)
        try:
            env = json.loads(body)
        except Exception as e:
            check("list envelope parses", False, repr(e))
            return
        check("list HTTP 200", st == 200, "status=%d" % st)
        check("list envelope code==0", env.get("code") == 0, str(env.get("code")))
        check("list envelope message==success", env.get("message") == "success", str(env.get("message")))
        check("list envelope has timestamp",
              bool(re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$", env.get("timestamp") or "")),
              str(env.get("timestamp")))
        check("list envelope has data", "data" in env, "keys=%s" % list(env.keys()))
        check("list with no learners is data:[] not data:null",
              env.get("data") == [], repr(env.get("data")))
        check("list field order matches ApiResponse record",
              list(env.keys())[:2] == ["code", "message"], str(list(env.keys())))

        # ---- 2. scores_json non-empty: used as-is, no kp fill ----
        scores_in = {"kp-ds": 80, "kp-co": 40, "custom-x": 12}
        scores_json = json.dumps(scores_in, ensure_ascii=False)
        lid = make_learner(marker + "-a", scores_json,
                           learning_style='["visual","driven"]',
                           blind='["math","design"]')
        st, body = api_get(args.base, "/api/v1/learners/" + str(lid), token)
        env = json.loads(body)
        check("get HTTP 200", st == 200, "status=%d" % st)
        data = env.get("data") or {}
        check("get field order matches LearnerResponse record",
              list(data.keys()) == LEARNER_FIELDS, str(list(data.keys())))
        check("null scalars emitted as JSON null (not omitted)",
              all(k in data for k in JAVA_NULL_ALWAYS),
              "missing=%s" % [k for k in JAVA_NULL_ALWAYS if k not in data])
        check("scores keep document order and values",
              list(data.get("scores", {}).items()) == list(scores_in.items()),
              str(data.get("scores")))
        check("scores NOT filled with kp defaults when non-empty",
              set(data.get("scores", {})) == set(scores_in),
              str(data.get("scores")))
        expected_om = overall_mastery(list(scores_in.items()))
        check("overallMastery is mean rounded HALF_UP scale 1",
              str(data.get("overallMastery")) == expected_om,
              "got=%s want=%s" % (data.get("overallMastery"), expected_om))
        # Wire token matters: BigDecimal scale 1 serialises as "44.0", never
        # "44" or "44.00". json.loads would hide that, so read the raw body.
        raw_token = re.search(rb'"overallMastery"\s*:\s*(-?[0-9.]+)', body)
        check("overallMastery raw token is scale 1",
              raw_token is not None and raw_token.group(1).decode() == expected_om,
              "raw=%s want=%s" % (raw_token.group(1).decode() if raw_token else None, expected_om))
        check("learningStyle parsed from json",
              data.get("learningStyle") == ["visual", "driven"], str(data.get("learningStyle")))
        check("blindSpots parsed from json",
              data.get("blindSpots") == ["math", "design"], str(data.get("blindSpots")))

        # ---- 3. scores_json blank -> kp fill with 50 ----
        lid2 = make_learner(marker + "-b", None)
        st, body = api_get(args.base, "/api/v1/learners/" + str(lid2), token)
        data = json.loads(body).get("data") or {}
        check("blank scores_json fills enabled kp codes with 50",
              list(data.get("scores", {}).items()) == [(c, 50) for c in kp_codes],
              "got=%s" % data.get("scores"))
        check("fill preserves knowledge_point sort_order",
              list(data.get("scores", {})) == kp_codes, str(list(data.get("scores", {}))))
        expected_om = overall_mastery([(c, 50) for c in kp_codes])
        check("overallMastery of the default fill",
              str(data.get("overallMastery")) == expected_om,
              "got=%s want=%s" % (data.get("overallMastery"), expected_om))
        raw_token = re.search(rb'"overallMastery"\s*:\s*(-?[0-9.]+)', body)
        check("default-fill overallMastery raw token is scale 1",
              raw_token is not None and raw_token.group(1).decode() == expected_om,
              "raw=%s want=%s" % (raw_token.group(1).decode() if raw_token else None, expected_om))

        # ---- 4. scores_json unparseable -> empty map -> same fill ----
        lid3 = make_learner(marker + "-c", "not json at all")
        st, body = api_get(args.base, "/api/v1/learners/" + str(lid3), token)
        data = json.loads(body).get("data") or {}
        check("unparseable scores_json behaves like empty (kp fill)",
              list(data.get("scores", {}).items()) == [(c, 50) for c in kp_codes],
              "got=%s" % data.get("scores"))

        # ---- 5. a scores_json that is not a flat object -> empty -> fill ----
        lid4 = make_learner(marker + "-d", '["kp-ds", 80]')
        st, body = api_get(args.base, "/api/v1/learners/" + str(lid4), token)
        data = json.loads(body).get("data") or {}
        check("non-object scores_json behaves like empty (kp fill)",
              list(data.get("scores", {}).items()) == [(c, 50) for c in kp_codes],
              "got=%s" % data.get("scores"))

        # ---- 6. list returns every learner for the user, in created_at order ----
        st, body = api_get(args.base, "/api/v1/learners", token)
        rows = json.loads(body).get("data") or []
        check("list returns all four isolated learners",
              len(rows) == 4, "count=%d" % len(rows))
        codes = [r.get("code") for r in rows]
        check("list codes are the isolated ones",
              all(str(c).startswith(marker) for c in codes), str(codes))
        check("list order is created_at ASC",
              [r.get("code") for r in rows] == [marker + s for s in ("-a", "-b", "-c", "-d")],
              str(codes))

        # ---- 7. unknown learner id -> 404 ApiResponse.error ----
        st, body = api_get(args.base, "/api/v1/learners/" + str(uuid.uuid4()), token)
        env = json.loads(body)
        check("unknown learner HTTP 404", st == 404, "status=%d" % st)
        check("404 envelope code==3004 LEARNER_NOT_FOUND", env.get("code") == 3004, str(env.get("code")))
        check("404 envelope message is the Java string",
              env.get("message") == "学习者不存在", repr(env.get("message")))
        check("404 envelope omits data (@JsonInclude NON_NULL)",
              "data" not in env, str(list(env.keys())))
        check("404 envelope still carries timestamp", "timestamp" in env, str(list(env.keys())))

        # ---- 8. another user's learner is not visible ----
        st, body = api_get(args.base, "/api/v1/learners/" + str(lid), mint_jwt(secret, str(uuid.uuid4())))
        env = json.loads(body)
        check("cross-user learner is 404, not 200", st == 404 and env.get("code") == 3004,
              "status=%d code=%s" % (st, env.get("code")))

    finally:
        for lid in learner_ids:
            cur.execute("DELETE FROM learners WHERE id=%s", (lid.bytes,))
        cur.execute("DELETE FROM users WHERE id=%s", (fixture_user.bytes,))
        cur.close()
        conn.close()
        print("  cleaned up %d learner rows + 1 fixture user" % len(learner_ids), flush=True)

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
