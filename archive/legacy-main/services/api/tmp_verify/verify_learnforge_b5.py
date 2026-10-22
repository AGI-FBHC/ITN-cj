#!/usr/bin/env python3
"""P2 batch-5 verification: Spire's GET /api/v1/onboarding/{meta,target-categories,
targets,jobs} against the DB + quiz-bank.json.

Expected values are computed here from the same rows the service reads, using
the Java semantics in OnboardingAssessmentService.{meta,targetCategories,
targetOptions,toMeta} and web/dto/OnboardingDtos.java. A mismatch is a real
defect.

Isolation: target_categories/target_options/knowledge_point are read-only here
(only SELECTs). quiz-bank.json is read-only.

Usage:
  python verify_learnforge_b5.py --base http://127.0.0.1:19501

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

ABILITY_NAMES = {
    "kp-ds": "知识理解", "kp-co": "逻辑推理", "kp-os": "工程实践",
    "kp-network": "问题诊断", "kp-db": "系统设计", "kp-agent": "学习迁移",
}
TAGS = ["在校学生", "应届毕业生", "职场新人（1-3年）", "中级工程师（3-5年）",
        "高级工程师（5年+）", "转岗/跨领域", "自由学习者"]
EDU = ["初中及以下", "高中", "大专", "本科", "硕士", "博士"]
STYLES = ["理论先行", "实操驱动", "图示学习", "案例迁移", "步骤清单",
          "碎片化学习", "视频演示", "项目实战", "同伴讨论"]
SELF_LEVELS = ["未接触", "需要指导", "可独立完成", "能处理复杂情况", "能指导他人"]


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


def api_get(base: str, path: str, token: str = None):
    import http.client
    from urllib.parse import urlparse

    u = urlparse(base)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=30)
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    conn.request("GET", path, headers=headers)
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
    token = mint_jwt(secret, str(uuid.uuid4()))

    conn = db_connect()
    cur = conn.cursor()

    try:
        # ---------- target-categories ----------
        print("--- target-categories ---", flush=True)
        st, body = api_get(args.base, "/api/v1/onboarding/target-categories", token)
        env = json.loads(body)
        check("target-categories HTTP 200", st == 200, "status=%d" % st)
        check("target-categories envelope is ApiResponse",
              env.get("code") == 0 and env.get("message") == "success",
              "code=%s message=%s" % (env.get("code"), env.get("message")))
        tc = env.get("data") or []
        cur.execute("SELECT id, code, name, description, sort_order, status"
                    " FROM target_categories WHERE status=1"
                    " ORDER BY sort_order ASC, id ASC")
        rows = cur.fetchall()
        check("target-categories count matches DB", len(tc) == len(rows),
              "got=%d want=%d" % (len(tc), len(rows)))
        if tc:
            check("TargetCategory field order",
                  list(tc[0].keys()) == ["id", "code", "name", "description",
                                         "sortOrder", "enabled"],
                  repr(list(tc[0].keys())))
        ok = True
        detail = ""
        for got, r in zip(tc, rows):
            (tid, code, name, desc, so, status) = r
            if got.get("id") != tid:
                ok, detail = False, "id=%r want %r" % (got.get("id"), tid)
            elif got.get("code") != code:
                ok, detail = False, "code=%r" % got.get("code")
            elif got.get("name") != name:
                ok, detail = False, "name=%r" % got.get("name")
            elif got.get("description") != desc:
                ok, detail = False, "description=%r want %r" % (got.get("description"), desc)
            elif got.get("sortOrder") != so:
                ok, detail = False, "sortOrder=%r" % got.get("sortOrder")
            elif got.get("enabled") is not True:
                ok, detail = False, "enabled=%r (status=1 → true)" % got.get("enabled")
        check("target-categories values match DB rows", ok, detail)
        raw = body.decode("utf-8", "replace")
        check("target-categories id is bare JSON number (Long)",
              re.search(r'"id":\s*\d+', raw) is not None, raw[:160])
        check("target-categories enabled is JSON boolean",
              '"enabled":true' in raw or '"enabled":false' in raw, raw[:200])

        # ---------- targets / jobs ----------
        print("\n--- targets / jobs ---", flush=True)
        st, body = api_get(args.base, "/api/v1/onboarding/targets", token)
        env = json.loads(body)
        check("targets HTTP 200", st == 200, "status=%d" % st)
        tg = env.get("data") or []
        cur.execute("SELECT id, code, category_code, name, description, sort_order, status"
                    " FROM target_options WHERE status=1"
                    " ORDER BY sort_order ASC, id ASC")
        rows = cur.fetchall()
        check("targets count matches DB", len(tg) == len(rows),
              "got=%d want=%d" % (len(tg), len(rows)))
        if tg:
            check("TargetOption field order",
                  list(tg[0].keys()) == ["id", "code", "categoryCode", "name",
                                         "description", "sortOrder", "enabled"],
                  repr(list(tg[0].keys())))
        ok = True
        detail = ""
        for got, r in zip(tg, rows):
            (tid, code, ccode, name, desc, so, status) = r
            if got.get("id") != tid:
                ok, detail = False, "id=%r want %r" % (got.get("id"), tid)
            elif got.get("code") != code:
                ok, detail = False, "code=%r" % got.get("code")
            elif got.get("categoryCode") != ccode:
                ok, detail = False, "categoryCode=%r want %r" % (got.get("categoryCode"), ccode)
            elif got.get("name") != name:
                ok, detail = False, "name=%r" % got.get("name")
            elif got.get("description") != desc:
                ok, detail = False, "description=%r want %r" % (got.get("description"), desc)
            elif got.get("sortOrder") != so:
                ok, detail = False, "sortOrder=%r" % got.get("sortOrder")
            elif got.get("enabled") is not True:
                ok, detail = False, "enabled=%r" % got.get("enabled")
        check("targets values match DB rows", ok, detail)

        st, body2 = api_get(args.base, "/api/v1/onboarding/jobs", token)
        check("jobs returns the same targetOptions body",
              json.loads(body2).get("data") == tg,
              "same=%s" % (json.loads(body2).get("data") == tg))

        # ---------- meta ----------
        print("\n--- meta ---", flush=True)
        st, body = api_get(args.base, "/api/v1/onboarding/meta", token)
        env = json.loads(body)
        check("meta HTTP 200", st == 200, "status=%d" % st)
        m = env.get("data") or {}
        check("Meta field order matches record",
              list(m.keys()) == ["knowledgePoints", "tags", "edu", "targetCategories",
                                 "targetOptions", "styles", "selfLevels", "questions"],
              repr(list(m.keys())))
        check("meta.tags is the static TAGS list", m.get("tags") == TAGS, repr(m.get("tags")))
        check("meta.edu is the static EDU list", m.get("edu") == EDU, repr(m.get("edu")))
        check("meta.styles is the static STYLES list", m.get("styles") == STYLES,
              repr(m.get("styles")))
        check("meta.selfLevels is the static SELF_LEVELS list",
              m.get("selfLevels") == SELF_LEVELS, repr(m.get("selfLevels")))
        check("meta.targetCategories equals /target-categories body",
              m.get("targetCategories") == tc, "same=%s" % (m.get("targetCategories") == tc))
        check("meta.targetOptions equals /targets body",
              m.get("targetOptions") == tg, "same=%s" % (m.get("targetOptions") == tg))

        # knowledgePoints
        kps = m.get("knowledgePoints") or []
        cur.execute("SELECT code, name, en_name, weight, target_level, coverage,"
                    " description, core_topics_json FROM knowledge_point"
                    " WHERE status=1 ORDER BY sort_order ASC, id ASC")
        kp_rows = cur.fetchall()
        check("meta.knowledgePoints count matches DB", len(kps) == len(kp_rows),
              "got=%d want=%d" % (len(kps), len(kp_rows)))
        if kps:
            check("KnowledgePointMeta field order",
                  list(kps[0].keys()) == ["id", "name", "en", "weight", "targetLevel",
                                          "coverage", "description", "coreTopics"],
                  repr(list(kps[0].keys())))
        ok = True
        detail = ""
        for got, r in zip(kps, kp_rows):
            (code, name, en_name, weight, tlevel, cov, desc, core_j) = r
            want_name = ABILITY_NAMES.get(code, "综合能力")
            if got.get("id") != code:
                ok, detail = False, "id=%r want %r" % (got.get("id"), code)
            elif got.get("name") != want_name:
                ok, detail = False, "%s name=%r want abilityName %r" % (code, got.get("name"), want_name)
            elif got.get("en") != en_name:
                ok, detail = False, "%s en=%r want %r" % (code, got.get("en"), en_name)
            elif abs((got.get("weight") or 0) - (float(weight) if weight is not None else 0.0)) > 1e-9:
                ok, detail = False, "%s weight=%r want %r" % (code, got.get("weight"), weight)
            elif got.get("targetLevel") != (80 if tlevel is None else tlevel):
                ok, detail = False, "%s targetLevel=%r" % (code, got.get("targetLevel"))
            elif got.get("coverage") != (90 if cov is None else cov):
                ok, detail = False, "%s coverage=%r" % (code, got.get("coverage"))
            elif got.get("description") != desc:
                ok, detail = False, "%s description=%r" % (code, got.get("description"))
            elif got.get("coreTopics") != parse_list(core_j):
                ok, detail = False, "%s coreTopics=%r want %r" % (
                    code, got.get("coreTopics"), parse_list(core_j))
        check("meta.knowledgePoints values match DB (name=abilityName)", ok, detail)
        raw = body.decode("utf-8", "replace")
        m2 = re.search(r'"weight":([^,}]+)', raw)
        check("meta weight is Double text (javaDoubleText, not BigDecimal)",
              bool(m2) and not re.match(r"^-?\d+\.\d{4}$", m2.group(1).strip()),
              "first weight text=%s" % (m2.group(1).strip() if m2 else "?"))

        # questions from quiz-bank.json
        qs = m.get("questions") or []
        bank_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                 "resources", "onboarding", "quiz-bank.json")
        with open(bank_path, "r", encoding="utf-8") as f:
            bank = json.load(f)
        check("meta.questions count matches quiz-bank.json", len(qs) == len(bank),
              "got=%d want=%d" % (len(qs), len(bank)))
        if qs:
            check("Question field order",
                  list(qs[0].keys()) == ["id", "kpId", "level", "stars", "stem",
                                         "options", "answerIndex", "analysis", "kbRefs"],
                  repr(list(qs[0].keys())))
        check("meta.questions equals quiz-bank.json rows",
              qs == bank, "first=%s" % repr((qs or [None])[0]))

        # ---------- error paths ----------
        print("\n--- errors ---", flush=True)
        st, body = api_get(args.base, "/api/v1/onboarding/meta")
        check("meta is public (no auth) → 200", st == 200, "status=%d" % st)
        st, body = api_get(args.base, "/api/v1/onboarding/nope-" + uuid.uuid4().hex[:6])
        check("unknown onboarding path is not 200", st != 200, "status=%d" % st)

    finally:
        cur.close()
        conn.close()

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
