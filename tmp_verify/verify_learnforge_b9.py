#!/usr/bin/env python3
"""P2 batch-9 verification: Spire's onboarding pure-compute POSTs.
  POST /api/v1/onboarding/generate-profile
  POST /api/v1/onboarding/diagnose
  POST /api/v1/onboarding/answer

Expected values are computed here with the same algorithms as
OnboardingAssessmentService.{generateProfile,diagnose,answer,estimates,confidence,
answerDelta,priorOf,clampScore,commentOf,maybeEnqueue}. A mismatch is a real
defect.

Isolation: pure computation — no rows written. quiz-bank.json is read-only.

Usage:
  python verify_learnforge_b9.py --base http://127.0.0.1:19501

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
TAG_PRIOR = {
    "在校学生": {"kp-ds": 4, "kp-co": 2, "kp-os": 1, "kp-network": 1, "kp-db": 0, "kp-agent": -1},
    "应届毕业生": {"kp-ds": 8, "kp-co": 5, "kp-network": 4, "kp-os": 3, "kp-db": 2, "kp-agent": -2},
    "职场新人（1-3年）": {"kp-network": 5, "kp-db": 4, "kp-os": 3, "kp-ds": 1},
    "中级工程师（3-5年）": {"kp-network": 8, "kp-db": 6, "kp-os": 5, "kp-ds": -1, "kp-agent": 1},
    "高级工程师（5年+）": {"kp-network": 10, "kp-db": 9, "kp-os": 8, "kp-agent": 2},
    "转岗/跨领域": {"kp-network": 6, "kp-db": 4, "kp-os": 3, "kp-agent": -2, "kp-ds": -3},
    "自由学习者": {},
}
EDU_PRIOR = {
    "初中及以下": {"kp-ds": -6, "kp-co": -4},
    "高中": {"kp-ds": -3, "kp-co": -2},
    "大专": {"kp-network": 3, "kp-db": 1},
    "本科": {"kp-ds": 3, "kp-co": 1, "kp-os": 1},
    "硕士": {"kp-ds": 6, "kp-agent": 4, "kp-co": 2},
    "博士": {"kp-ds": 8, "kp-agent": 6, "kp-co": 4},
}


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


def api_post(base: str, path: str, body):
    import http.client
    from urllib.parse import urlparse

    u = urlparse(base)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=30)
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    conn.request("POST", path, body=payload,
                 headers={"Content-Type": "application/json", "Accept": "application/json"})
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp.status, data


# ---- reference implementation (Java semantics) ----

def clamp(v):
    return max(20, min(92, v))


def prior_of(tag, edu, kp):
    p = 0
    p += TAG_PRIOR.get(tag, {}).get(kp, 0)
    p += EDU_PRIOR.get(edu, {}).get(kp, 0)
    return p


def self_score(level):
    return 20 + (level if level is not None else 2) * 15


def answer_delta(level, result, attribution):
    if result == "correct":
        d = {"basic": 10, "advanced": 14}.get(level, 18)
    elif result == "wrong":
        d = -10 if level == "basic" else -6
    else:
        d = -6
    if attribution == "concept":
        d -= 3
    if attribution == "careless":
        d += 5
    return d


def java_round(x):
    import math
    return int(math.floor(x + 0.5))


def estimates(kp_ids, tag, edu, self_levels, answers, questions):
    out = {}
    for kp in kp_ids:
        level = self_levels.get(kp, 2)
        s = self_score(level) - 50
        e = 50 + prior_of(tag, edu, kp) + java_round(s * 0.4)
        out[kp] = clamp(e)
    for a in answers:
        q = questions.get(a.get("questionId"))
        if not q:
            continue
        cur = out.get(q["kpId"], 50)
        out[q["kpId"]] = clamp(cur + answer_delta(q["level"], a.get("result"),
                                                  a.get("attribution")))
    return out


def confidence(kp_ids, self_levels, answers, questions):
    out = {kp: 33 for kp in kp_ids}
    for a in answers:
        q = questions.get(a.get("questionId"))
        if not q:
            continue
        base = 8 if a.get("result") == "uncertain" else (18 if q["level"] == "basic" else 22)
        if a.get("attribution") and str(a.get("attribution")).strip():
            base += 4
        cur = out.get(q["kpId"], 33)
        out[q["kpId"]] = min(92, cur + base)
    return out


def average(vals):
    if not vals:
        return 0
    return java_round(sum(vals) / len(vals))


def goal_text(target_cat, weakest, job):
    job = job or ""
    if target_cat == "EXAM":
        return "3 个月内补齐「%s」等短板，对齐「%s」考试科目要求。" % (weakest, job)
    if target_cat == "CERT":
        return "3 个月内补齐「%s」等短板，对齐「%s」证书考核要求。" % (weakest, job)
    return "3 个月内补齐「%s」等短板，向「%s」岗位能力对齐。" % (weakest, job)


def diag_summary(strongest_name, strongest_score, weakest_name, weakest_score):
    return ("DIA-01 诊断：最强「%s」%d 分，最弱「%s」%d 分。"
            "建议从「%s」切入，用分阶题巩固优势维度。"
            % (strongest_name, strongest_score, weakest_name, weakest_score, weakest_name))


def comment_of(level, kp, result, estimate):
    name = ABILITY_NAMES.get(kp, "综合能力")
    label = {"basic": "基础", "advanced": "进阶"}.get(level, "挑战")
    if result == "uncertain":
        return "诚实比蒙对更有用——「%s」我先按偏弱记，之后再核。" % name
    return "%s题已完成，「%s」当前估计 %d 分。" % (label, name, estimate)


def priority_abilities(job):
    if job is None:
        return ["kp-os", "kp-agent"]
    if "RAG" in job:
        return ["kp-ds", "kp-db", "kp-network"]
    if "多智能体" in job:
        return ["kp-co", "kp-db", "kp-network"]
    if "平台" in job:
        return ["kp-db", "kp-network", "kp-os"]
    return ["kp-os", "kp-agent", "kp-co"]


def maybe_enqueue(target_job, self_levels, answers, queue_ids, questions):
    """Returns (question_dict, reason) or None."""
    if not answers:
        return None
    if queue_ids is not None and len(queue_ids) >= 14:
        return None
    last = answers[-1]
    q = questions.get(last.get("questionId"))
    if not q:
        return None
    kp = q["kpId"]
    extra = bool(last.get("extra"))
    extra_count = sum(1 for a in answers
                      if bool(a.get("extra"))
                      and questions.get(a.get("questionId"), {}).get("kpId") == kp)
    if extra_count >= 2:
        return None
    used = set(queue_ids or [])
    pool = [it for it in questions.values()
            if it["kpId"] == kp and it["id"] not in used]
    level = None
    reason = ""
    if last.get("result") == "wrong" and not extra:
        level = "basic"
        reason = "「%s」答错了，我再确认一道" % ABILITY_NAMES.get(kp, "综合能力")
    elif last.get("result") == "uncertain":
        level = "basic"
        reason = "不确定没关系，「%s」换道题再试" % ABILITY_NAMES.get(kp, "综合能力")
    elif (last.get("result") == "correct"
          and self_levels.get(kp, 2) >= 3 and not extra):
        level = "advanced"
        reason = "你自评较高，上道进阶题验证"
    elif (last.get("result") == "correct" and not extra
          and kp in priority_abilities(target_job)):
        level = "advanced"
        reason = ("「%s」是「%s」的重点能力，多测一道进阶题"
                  % (ABILITY_NAMES.get(kp, "综合能力"), target_job))
    if level is None:
        return None
    nxt = next((it for it in pool if it["level"] == level), None)
    if nxt is None:
        nxt = pool[0] if pool else None
    if nxt is None:
        return None
    return (nxt, reason)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    args = ap.parse_args()

    secret = os.environ.get("JWT_SECRET", "KNOWNSECRET20CHARSXX")
    token = mint_jwt(secret, str(uuid.uuid4()))

    bank_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                             "resources", "onboarding", "quiz-bank.json")
    with open(bank_path, "r", encoding="utf-8") as f:
        bank = json.load(f)
    questions = {q["id"]: q for q in bank}
    kp_ids = sorted({q["kpId"] for q in bank})

    # =========================================================
    # generate-profile
    # =========================================================
    print("--- generate-profile ---", flush=True)
    scores = {"kp-ds": 80, "kp-co": 40, "kp-os": 60, "kp-network": 55, "kp-db": 70, "kp-agent": 30}
    body = {"method": "full", "name": "VF画像", "avatar": None, "tag": "应届毕业生",
            "education": "本科", "targetJob": "RAG应用工程师",
            "targetCategoryCode": "EXAM", "scores": scores, "confidence": 55,
            "selfLevels": {}, "answers": [{"questionId": "q-01", "result": "correct"}]}
    st, raw = api_post(args.base, "/api/v1/onboarding/generate-profile", body)
    env = json.loads(raw)
    check("generate-profile → 200", st == 200, "status=%d" % st)
    d = env.get("data") or {}
    check("ForgeResponse field order",
          list(d.keys()) == ["name", "avatar", "scores", "confidence", "method",
                             "steps", "evidence", "blindSpots", "goal", "diagnosisSummary"],
          repr(list(d.keys())))
    check("generate-profile echoes name/method",
          d.get("name") == "VF画像" and d.get("method") == "full",
          repr({k: d.get(k) for k in ("name", "method")}))
    check("generate-profile echoes scores map",
          d.get("scores") == scores, repr(d.get("scores")))
    check("generate-profile confidence echoed",
          d.get("confidence") == 55, repr(d.get("confidence")))
    # sorted by value asc: kp-agent 30, kp-co 40, kp-network 55, kp-os 60,
    # kp-db 70, kp-ds 80 → weakest=学习迁移, strongest=知识理解
    check("generate-blindSpots are the lowest 2 ability names",
          d.get("blindSpots") == ["学习迁移", "逻辑推理"],
          repr(d.get("blindSpots")))
    check("generate goal text uses EXAM branch",
          d.get("goal") == goal_text("EXAM", "学习迁移", "RAG应用工程师"),
          repr(d.get("goal")))
    check("generate diagnosisSummary matches template",
          d.get("diagnosisSummary") == diag_summary("知识理解", 80, "学习迁移", 30),
          repr(d.get("diagnosisSummary")))
    check("generate steps is 4 ForgeStep items",
          len(d.get("steps") or []) == 4
          and list((d.get("steps") or [{}])[0].keys()) == ["text", "detail"],
          repr((d.get("steps") or [None])[0]))
    check("generate evidence is 4 strings",
          len(d.get("evidence") or []) == 4
          and all(isinstance(x, str) for x in (d.get("evidence") or [])),
          repr(d.get("evidence")))
    check("generate evidence[3] counts answers for method!=quick",
          "1 题" in (d.get("evidence") or ["", "", "", ""])[3],
          repr((d.get("evidence") or [None])[3]))

    # quick method branch
    body2 = dict(body)
    body2["method"] = "quick"
    body2["targetCategoryCode"] = "CERT"
    body2["targetJob"] = "Agent工程师"
    st, raw = api_post(args.base, "/api/v1/onboarding/generate-profile", body2)
    d2 = (json.loads(raw).get("data") or {})
    check("generate method=quick label is 背景先验起档",
          "背景先验起档" in json.dumps(d2.get("steps"), ensure_ascii=False),
          repr((d2.get("steps") or [None])[-1]))
    check("generate quick evidence is 背景先验 → 六维起点",
          (d2.get("evidence") or ["", "", "", ""])[3] == "背景先验 → 六维起点",
          repr((d2.get("evidence") or [None])[3]))
    check("generate goal text uses CERT branch",
          d2.get("goal") == goal_text("CERT", "学习迁移", "Agent工程师"),
          repr(d2.get("goal")))

    body3 = dict(body)
    body3["targetCategoryCode"] = None
    body3["targetJob"] = "多智能体开发工程师"
    st, raw = api_post(args.base, "/api/v1/onboarding/generate-profile", body3)
    d3 = (json.loads(raw).get("data") or {})
    check("generate goal text uses the default branch",
          d3.get("goal") == goal_text(None, "学习迁移", "多智能体开发工程师"),
          repr(d3.get("goal")))

    # empty scores → Java's sorted.stream().limit(2) on an empty list yields [],
    # while strongest/weakest default to abilityName("kp-ds")/50.
    st, raw = api_post(args.base, "/api/v1/onboarding/generate-profile",
                       {"method": "quick", "scores": {}})
    d4 = (json.loads(raw).get("data") or {})
    check("generate empty scores → blindSpots [] and strongest/weakest default kp-ds/50",
          (d4.get("blindSpots") or []) == []
          and "知识理解」50 分" in d4.get("diagnosisSummary", ""),
          "blindSpots=%r diag=%r" % (d4.get("blindSpots"), d4.get("diagnosisSummary")))

    # =========================================================
    # diagnose
    # =========================================================
    print("\n--- diagnose ---", flush=True)
    self_levels = {"kp-ds": 4, "kp-co": 1, "kp-os": 3, "kp-network": 2, "kp-db": 3, "kp-agent": 1}
    answers = [
        {"questionId": "q-01", "result": "correct", "attribution": None},
        {"questionId": "q-02", "result": "wrong", "attribution": "concept"},
        {"questionId": "q-03", "result": "uncertain", "attribution": None},
    ]
    want_est = estimates(kp_ids, "本科", "本科", self_levels, answers, questions)
    want_conf = confidence(kp_ids, self_levels, answers, questions)
    want_avg = average(list(want_conf.values()))
    body = {"tag": "本科", "education": "本科", "targetJob": "RAG应用工程师",
            "targetCategoryCode": "EXAM", "selfLevels": self_levels, "answers": answers}
    # fix tag to a real one
    body["tag"] = "应届毕业生"
    want_est = estimates(kp_ids, "应届毕业生", "本科", self_levels, answers, questions)
    st, raw = api_post(args.base, "/api/v1/onboarding/diagnose", body)
    env = json.loads(raw)
    check("diagnose → 200", st == 200, "status=%d" % st)
    d = env.get("data") or {}
    check("DiagnoseResponse field order",
          list(d.keys()) == ["scores", "confidence", "averageConfidence",
                             "blindSpots", "goal", "diagnosisSummary"],
          repr(list(d.keys())))
    check("diagnose estimates match the reference algorithm",
          d.get("scores") == want_est,
          "got=%r want=%r" % (d.get("scores"), want_est))
    check("diagnose confidence match the reference algorithm",
          d.get("confidence") == want_conf,
          "got=%r want=%r" % (d.get("confidence"), want_conf))
    check("diagnose averageConfidence matches", d.get("averageConfidence") == want_avg,
          "got=%r want=%r" % (d.get("averageConfidence"), want_avg))
    ordered = sorted(want_est.items(), key=lambda kv: kv[1])
    want_blind = [ABILITY_NAMES.get(kv[0], "综合能力") for kv in ordered[:2]]
    check("diagnose blindSpots are the lowest 2 of the estimates",
          d.get("blindSpots") == want_blind,
          "got=%r want=%r" % (d.get("blindSpots"), want_blind))
    check("diagnose goal text matches",
          d.get("goal") == goal_text("EXAM", want_blind[0], "RAG应用工程师"),
          repr(d.get("goal")))
    check("diagnose diagnosisSummary matches",
          d.get("diagnosisSummary") == diag_summary(
              ABILITY_NAMES.get(ordered[-1][0], "综合能力"), ordered[-1][1],
              ABILITY_NAMES.get(ordered[0][0], "综合能力"), ordered[0][1]),
          repr(d.get("diagnosisSummary")))

    # =========================================================
    # answer
    # =========================================================
    print("\n--- answer ---", flush=True)
    body = {"tag": "应届毕业生", "education": "本科", "targetJob": "RAG应用工程师",
            "selfLevels": self_levels, "answers": answers, "queueIds": ["q-01", "q-02", "q-03"]}
    want_est = estimates(kp_ids, "应届毕业生", "本科", self_levels, answers, questions)
    want_conf = confidence(kp_ids, self_levels, answers, questions)
    want_avg = average(list(want_conf.values()))
    st, raw = api_post(args.base, "/api/v1/onboarding/answer", body)
    env = json.loads(raw)
    check("answer → 200", st == 200, "status=%d" % st)
    d = env.get("data") or {}
    check("AnswerResponse field order",
          list(d.keys()) == ["estimates", "confidence", "averageConfidence",
                             "comment", "nextQuestion", "nextReason", "quizDone"],
          repr(list(d.keys())))
    check("answer estimates match the reference", d.get("estimates") == want_est,
          "got=%r want=%r" % (d.get("estimates"), want_est))
    check("answer confidence match the reference", d.get("confidence") == want_conf,
          "got=%r want=%r" % (d.get("confidence"), want_conf))
    check("answer averageConfidence matches", d.get("averageConfidence") == want_avg,
          "got=%r want=%r" % (d.get("averageConfidence"), want_avg))
    last_q = questions.get("q-03")
    want_comment = comment_of(last_q["level"], last_q["kpId"], "uncertain",
                              want_est[last_q["kpId"]])
    check("answer comment is the uncertain branch",
          d.get("comment") == want_comment,
          "got=%r want=%r" % (d.get("comment"), want_comment))

    want_next = maybe_enqueue("RAG应用工程师", self_levels, answers,
                              ["q-01", "q-02", "q-03"], questions)
    if want_next:
        nq, nreason = want_next
        check("answer nextQuestion is the reference pick",
              (d.get("nextQuestion") or {}).get("id") == nq.get("id"),
              "got=%r want=%r" % ((d.get("nextQuestion") or {}).get("id"), nq.get("id")))
        check("answer nextReason matches", d.get("nextReason") == nreason,
              "got=%r want=%r" % (d.get("nextReason"), nreason))
        check("answer quizDone is false when a next question exists",
              d.get("quizDone") is False, repr(d.get("quizDone")))
    else:
        check("answer nextQuestion is null when maybeEnqueue returns null",
              d.get("nextQuestion") is None, repr(d.get("nextQuestion")))
        check("answer quizDone is true when no next question",
              d.get("quizDone") is True, repr(d.get("quizDone")))

    # quizDone / empty answers
    st, raw = api_post(args.base, "/api/v1/onboarding/answer",
                       {"tag": "在校学生", "education": "高中", "selfLevels": {},
                        "answers": [], "queueIds": []})
    d = (json.loads(raw).get("data") or {})
    check("answer with empty answers → quizDone true, nextQuestion null",
          d.get("quizDone") is True and d.get("nextQuestion") is None
          and d.get("comment") == "",
          "quizDone=%r next=%r comment=%r" % (d.get("quizDone"), d.get("nextQuestion"),
                                              d.get("comment")))

    # queue full → no next question
    st, raw = api_post(args.base, "/api/v1/onboarding/answer",
                       {"tag": "应届毕业生", "education": "本科", "targetJob": "RAG应用工程师",
                        "selfLevels": self_levels, "answers": answers,
                        "queueIds": ["q%02d" % i for i in range(1, 15)]})
    d = (json.loads(raw).get("data") or {})
    check("answer with queueIds >= MAX_TOTAL=14 → quizDone true",
          d.get("quizDone") is True and d.get("nextQuestion") is None,
          "quizDone=%r next=%r" % (d.get("quizDone"), d.get("nextQuestion")))

    # answerDelta boundary: correct+challenge(18), concept-3, careless+5
    ans = [{"questionId": "q-01", "result": "correct", "attribution": "careless"}]
    q01 = questions.get("q-01")
    want = estimates(kp_ids, None, None, {}, ans, questions)
    st, raw = api_post(args.base, "/api/v1/onboarding/answer",
                       {"answers": ans, "selfLevels": {}})
    d = (json.loads(raw).get("data") or {})
    check("answerDelta applies careless +5",
          d.get("estimates") == want,
          "got=%r want=%r" % (d.get("estimates"), want))

    ans = [{"questionId": "q-01", "result": "wrong", "attribution": "concept"}]
    want = estimates(kp_ids, None, None, {}, ans, questions)
    st, raw = api_post(args.base, "/api/v1/onboarding/answer",
                       {"answers": ans, "selfLevels": {}})
    d = (json.loads(raw).get("data") or {})
    check("answerDelta applies wrong/basic -10 and concept -3",
          d.get("estimates") == want,
          "got=%r want=%r" % (d.get("estimates"), want))

    # priorOf coverage: tag+edu combined
    st, raw = api_post(args.base, "/api/v1/onboarding/diagnose",
                       {"tag": "博士", "education": "博士", "selfLevels": {}, "answers": []})
    d = (json.loads(raw).get("data") or {})
    want = estimates(kp_ids, "博士", "博士", {}, [], questions)
    check("priorOf(博士, 博士) combines TAG_PRIOR + EDU_PRIOR",
          d.get("scores") == want, "got=%r want=%r" % (d.get("scores"), want))

    print()
    print("== summary ==")
    print("PASS %d   FAIL %d" % (len(PASS), len(FAIL)))
    if FAIL:
        for n, dd in FAIL:
            print("  FAIL " + _safe(n) + "  -- " + _safe(dd))
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
