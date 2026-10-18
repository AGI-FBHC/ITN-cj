#!/usr/bin/env python3
"""P2 batch-2 verification: Spire's GET /api/v1/learner-profile and
/learner-profile/journal against the DB.

Expected values are computed here from the same rows the service reads, using
the Java semantics spelled out in service/LearningAnalyticsService.java and
web/dto/{LearnerProfileResponse,LearningJournalResponse}.java. A mismatch is a
real defect.

Isolation: every row this script inserts carries the marker
`vf-profile-<runid>` in a reachable text field, and every row is deleted at the
end. Nothing outside that marker is written.

Usage:
  python verify_learnforge_profile.py --base http://127.0.0.1:19413

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
from datetime import date, datetime, timedelta, timezone
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


# ---- wire-format helpers (match Java) ----

PROFILE_FIELDS = ["profile", "currentGoal", "stats", "mastery", "recentQuizzes"]
PROFILE_INFO_FIELDS = ["educationLevel", "major", "learningPreference", "technicalFoundation"]
CURRENT_GOAL_FIELDS = ["title", "goalType", "expectedLevel", "progress"]
STUDY_STATS_FIELDS = ["totalStudyMinutes", "totalDays", "streakDays",
                      "weeklyMinutes", "studyDates", "eventDistribution"]
MASTERY_FIELDS = ["overall", "categories", "strongPoints", "weakPoints"]
CATEGORY_FIELDS = ["id", "name", "score", "attempts"]
QUIZ_SUMMARY_FIELDS = ["quizType", "score", "categoryName", "createdAt"]

JOURNAL_FIELDS = ["date", "stats", "timeline", "summary"]
JOURNAL_STATS_FIELDS = ["focusSeconds", "totalDurationSeconds", "resourceCount",
                        "knowledgeCount", "questionCount", "correctCount", "wrongCount"]
TIMELINE_FIELDS = ["id", "occurredAt", "kind", "title", "description",
                   "durationSeconds", "knowledgeName", "correctCount", "wrongCount"]
DAILY_SUMMARY_FIELDS = ["content", "metricsJson", "generatedAt"]


def iso_instant_utc(dt: datetime) -> str:
    """ISO_INSTANT: group-of-3 fraction, trailing Z."""
    dt = dt.astimezone(UTC)
    if dt.microsecond == 0:
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    frac = "%06d" % dt.microsecond
    # strip trailing zeros, then group into 3s from the left
    frac = frac.rstrip("0")
    groups = [frac[i:i + 3] for i in range(0, len(frac), 3)]
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + "." + "".join(groups) + "Z"


def iso_local_datetime_utc(dt: datetime) -> str:
    """ISO_LOCAL_DATE_TIME on the UTC wall clock: seconds always, fraction
    all-trailing-zeros-stripped when non-zero, no Z."""
    dt = dt.astimezone(UTC)
    base = dt.strftime("%Y-%m-%dT%H:%M:%S")
    if dt.microsecond == 0:
        return base
    frac = ("%06d" % dt.microsecond).rstrip("0")
    return base + "." + frac


def java_double_text(x: float) -> str:
    """java.lang.Double.toString — shortest round-trip."""
    return repr(x) if x != float("inf") else "Infinity"


def java_math_round(a: float) -> int:
    """Math.round(double) = floor(a + 0.5) for non-NaN."""
    import math
    return int(math.floor(a + 0.5))


# ---- expected-value model (mirrors the Java) ----

class Expected:
    """Builds the expected JSON body from DB rows, reproducing
    LearningAnalyticsService semantics exactly."""

    def __init__(self, cur, user_bin: UUID, runid: str):
        self.cur = cur
        self.user_bin = user_bin
        self.runid = runid
        self.now_utc = datetime.now(UTC)
        self.today_utc = self.now_utc.date()
        self.today_sh = datetime.now(SH).date()

    # -- profile --
    def profile_info(self):
        self.cur.execute(
            "SELECT education_level, major, learning_preference, technical_foundation"
            " FROM user_profiles WHERE user_id=%s", (self.user_bin.bytes,))
        row = self.cur.fetchone()
        if row is None:
            return {"educationLevel": None, "major": None,
                    "learningPreference": None, "technicalFoundation": None}
        return {"educationLevel": row[0], "major": row[1],
                "learningPreference": row[2], "technicalFoundation": row[3]}

    # -- current goal --
    def current_goal(self):
        self.cur.execute(
            "SELECT g.title, g.goal_type, g.expected_level, g.status, g.target_date,"
            " g.created_at, g.knowledge_domain_id, d.name"
            " FROM user_profiles p"
            " JOIN learning_goals g ON g.id = p.current_goal_id"
            " LEFT JOIN knowledge_domain d ON d.id = g.knowledge_domain_id"
            " WHERE p.user_id=%s", (self.user_bin.bytes,))
        row = self.cur.fetchone()
        if row is None:
            return None
        title_raw, goal_type, expected_level, status, target_date, created_at, domain_id, domain_name = row
        # title = knowledgeDomain == null ? goal.title : knowledgeDomain.getName()
        title = title_raw if domain_id is None else domain_name
        progress = self._goal_progress(status, target_date, created_at)
        return {"title": title, "goalType": goal_type,
                "expectedLevel": expected_level, "progress": progress}

    def _goal_progress(self, status, target_date, created_at):
        if status == "COMPLETED":
            return 1.0
        if target_date is None:
            return 0.0
        # created_at is timestamp(6) in session TZ; Instant is absolute.
        # We store NOW(6) which is session-local (+08). Convert to UTC date.
        if isinstance(created_at, str):
            created_dt = datetime.fromisoformat(created_at.replace(" ", "T"))
        elif isinstance(created_at, datetime):
            created_dt = created_at
        else:
            return 0.0
        if created_dt.tzinfo is None:
            created_dt = created_dt.replace(tzinfo=SH)  # session is +08
        created_date = created_dt.astimezone(UTC).date()
        total_days = (target_date - created_date).days
        elapsed = (self.today_utc - created_date).days
        if total_days <= 0:
            return 0.0
        ratio = max(0.0, min(1.0, elapsed / total_days))
        return ratio

    # -- study stats --
    def study_stats(self):
        self.cur.execute("SELECT COUNT(*) FROM study_sessions WHERE user_id=%s",
                         (self.user_bin.bytes,))
        total_days = self.cur.fetchone()[0]
        self.cur.execute(
            "SELECT COALESCE(SUM(total_duration_seconds),0) FROM study_sessions"
            " WHERE user_id=%s", (self.user_bin.bytes,))
        total_seconds = self.cur.fetchone()[0] or 0
        total_minutes = total_seconds // 60

        streak = self._streak()

        # weeklyMinutes: today-6 .. today
        week_start = self.today_utc - timedelta(days=6)
        self.cur.execute(
            "SELECT session_date, total_duration_seconds FROM study_sessions"
            " WHERE user_id=%s AND session_date BETWEEN %s AND %s"
            " ORDER BY session_date ASC",
            (self.user_bin.bytes, week_start.isoformat(), self.today_utc.isoformat()))
        week_map = {}
        for sd, secs in self.cur.fetchall():
            week_map[sd.isoformat() if hasattr(sd, "isoformat") else str(sd)] = secs // 60
        weekly = []
        for i in range(6, -1, -1):
            d = (self.today_utc - timedelta(days=i)).isoformat()
            weekly.append(week_map.get(d, 0))

        # studyDates: [today-59, today] ASC
        cal_start = self.today_utc - timedelta(days=59)
        self.cur.execute(
            "SELECT session_date FROM study_sessions"
            " WHERE user_id=%s AND session_date BETWEEN %s AND %s"
            " ORDER BY session_date ASC",
            (self.user_bin.bytes, cal_start.isoformat(), self.today_utc.isoformat()))
        study_dates = []
        for (sd,) in self.cur.fetchall():
            study_dates.append(sd.isoformat() if hasattr(sd, "isoformat") else str(sd))

        # eventDistribution: (UTC today - 30).atStartOfDay through now
        month_ago = datetime.combine(self.today_utc - timedelta(days=30),
                                     datetime.min.time(), tzinfo=UTC)
        self.cur.execute(
            "SELECT source_type, COUNT(*) FROM learning_events"
            " WHERE user_id=%s AND created_at BETWEEN %s AND %s"
            " GROUP BY source_type",
            (self.user_bin.bytes,
             month_ago.strftime("%Y-%m-%d %H:%M:%S.%f"),
             self.now_utc.astimezone(SH).strftime("%Y-%m-%d %H:%M:%S.%f")))
        dist = {}
        for st, cnt in self.cur.fetchall():
            dist[st] = cnt

        return {"totalStudyMinutes": total_minutes, "totalDays": total_days,
                "streakDays": streak, "weeklyMinutes": weekly,
                "studyDates": study_dates, "eventDistribution": dist}

    def _streak(self):
        self.cur.execute(
            "SELECT session_date FROM study_sessions WHERE user_id=%s"
            " ORDER BY session_date DESC", (self.user_bin.bytes,))
        rows = [r[0] for r in self.cur.fetchall()]
        if not rows:
            return 0
        expected = self.today_utc
        newest = rows[0]
        if hasattr(newest, "date"):
            newest = newest.date()
        if newest != expected:
            expected = expected - timedelta(days=1)
        streak = 0
        for sd in rows:
            if hasattr(sd, "date"):
                sd = sd.date()
            if sd == expected:
                streak += 1
                expected = expected - timedelta(days=1)
            elif sd < expected:
                break
        return streak

    # -- mastery --
    def mastery(self):
        self.cur.execute(
            "SELECT km.knowledge_category_id, c.name, km.mastery_score, km.attempt_count"
            " FROM knowledge_mastery km"
            " JOIN knowledge_category c ON c.id = km.knowledge_category_id"
            " WHERE km.user_id=%s ORDER BY km.mastery_score DESC",
            (self.user_bin.bytes,))
        rows = self.cur.fetchall()
        if not rows:
            return {"overall": 0.0, "categories": [],
                    "strongPoints": [], "weakPoints": []}
        scores = [float(r[2]) for r in rows]
        avg = sum(scores) / len(scores)
        overall = java_math_round(avg * 100.0) / 100.0
        cats = []
        strong = []
        weak = []
        for cid, name, score_text, attempts in rows:
            score = float(score_text)
            cats.append({"id": cid, "name": name, "score": score, "attempts": attempts})
            if score >= 0.7 and len(strong) < 5:
                strong.append(name)
            if score < 0.4 and len(weak) < 5:
                weak.append(name)
        return {"overall": overall, "categories": cats,
                "strongPoints": strong, "weakPoints": weak}

    # -- recent quizzes --
    def recent_quizzes(self):
        self.cur.execute(
            "SELECT q.quiz_type, q.score, c.name, q.created_at"
            " FROM quiz_results q"
            " LEFT JOIN knowledge_category c ON c.id = q.knowledge_category_id"
            " WHERE q.user_id=%s ORDER BY q.created_at DESC LIMIT 10",
            (self.user_bin.bytes,))
        out = []
        for qt, score, cname, created in self.cur.fetchall():
            out.append({
                "quizType": qt,
                "score": float(score) if score is not None else None,
                "categoryName": cname,
                "createdAt": iso_local_datetime_utc(created),
            })
        return out

    # -- journal --
    def journal(self, target: date):
        # window: [target 00:00 SH, target+1 00:00 SH)
        frm = datetime.combine(target, datetime.min.time(), tzinfo=SH)
        to = datetime.combine(target + timedelta(days=1), datetime.min.time(), tzinfo=SH)
        frm_s = frm.strftime("%Y-%m-%d %H:%M:%S.%f")
        to_s = to.strftime("%Y-%m-%d %H:%M:%S.%f")

        self.cur.execute(
            "SELECT e.id, e.event_type, e.source_type, c.name, e.duration_seconds,"
            " e.metadata, e.created_at"
            " FROM learning_events e"
            " LEFT JOIN knowledge_category c ON c.id = e.knowledge_category_id"
            " WHERE e.user_id=%s AND e.created_at BETWEEN %s AND %s"
            " ORDER BY e.created_at DESC",
            (self.user_bin.bytes, frm_s, to_s))
        events = self.cur.fetchall()

        self.cur.execute(
            "SELECT q.id, q.question_count, q.correct_count, q.duration_seconds,"
            " q.difficulty_level, c.name, q.created_at"
            " FROM quiz_results q"
            " LEFT JOIN knowledge_category c ON c.id = q.knowledge_category_id"
            " WHERE q.user_id=%s AND q.created_at BETWEEN %s AND %s"
            " ORDER BY q.created_at ASC",
            (self.user_bin.bytes, frm_s, to_s))
        quizzes = self.cur.fetchall()

        timeline = []
        for eid, etype, stype, cname, dur, meta, created in events:
            if etype == "QUIZ_SUBMIT":
                continue
            md = {}
            if meta:
                try:
                    md = json.loads(meta)
                    if not isinstance(md, dict):
                        md = {}
                except Exception:
                    md = {}
            kn = cname if cname is not None else self._meta_text(md, "knowledgePoint")
            timeline.append({
                "id": str(uuid.UUID(bytes=eid)),
                "occurredAt": iso_instant_utc(created),
                "kind": self._journal_kind(etype),
                "title": self._event_title(etype, md, kn),
                "description": self._event_desc(etype, stype, dur, md),
                "durationSeconds": dur,
                "knowledgeName": kn,
                "correctCount": None,
                "wrongCount": None,
                "_sort": created,
            })
        for qid, qcnt, ccnt, dur, diff, cname, created in quizzes:
            wrong = max(0, qcnt - ccnt)
            desc = ("难度 · " + diff) if diff is not None else "根据作答结果更新掌握情况"
            timeline.append({
                "id": str(uuid.UUID(bytes=qid)),
                "occurredAt": iso_instant_utc(created),
                "kind": "quiz",
                "title": "完成一组分阶测试",
                "description": desc,
                "durationSeconds": dur,
                "knowledgeName": cname,
                "correctCount": ccnt,
                "wrongCount": wrong,
                "_sort": created,
            })
        # stable sort by occurredAt ascending
        timeline.sort(key=lambda x: x["_sort"])
        for t in timeline:
            del t["_sort"]

        # JournalStats over RAW rows (not the filtered timeline)
        focus = 0
        total_dur = 0
        resources = 0
        for eid, etype, stype, cname, dur, meta, created in events:
            if dur is not None:
                total_dur += dur
                if etype == "STUDY_END":
                    focus += dur
            if etype == "RESOURCE_VIEW":
                resources += 1
        questions = sum(q[1] for q in quizzes)
        correct = sum(q[2] for q in quizzes)
        knowledge = len({t["knowledgeName"] for t in timeline if t["knowledgeName"] is not None})
        stats = {"focusSeconds": focus, "totalDurationSeconds": total_dur,
                 "resourceCount": resources, "knowledgeCount": knowledge,
                 "questionCount": questions, "correctCount": correct,
                 "wrongCount": max(0, questions - correct)}

        # DailySummary
        self.cur.execute(
            "SELECT summary_text, metrics_json, generated_at"
            " FROM learning_daily_summaries"
            " WHERE user_id=%s AND summary_date=%s",
            (self.user_bin.bytes, target.isoformat()))
        row = self.cur.fetchone()
        if row is None:
            summary = None
        else:
            summary = {"content": row[0], "metricsJson": row[1],
                       "generatedAt": iso_instant_utc(row[2])}

        return {"date": target.isoformat(), "stats": stats,
                "timeline": timeline, "summary": summary}

    @staticmethod
    def _meta_text(md: dict, field: str):
        if field not in md:
            return None
        v = md[field]
        if v is None:
            return None
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return str(v)
        if isinstance(v, str):
            return v
        return ""

    @staticmethod
    def _journal_kind(etype: str) -> str:
        return {
            "STUDY_START": "focus", "STUDY_END": "focus",
            "RESOURCE_VIEW": "resource", "KP_MASTERY_CHECK": "knowledge",
            "CHAT_INTERACTION": "chat", "QUIZ_SUBMIT": "quiz",
        }.get(etype, "quiz")

    @classmethod
    def _event_title(cls, etype, md, kn):
        supplied = cls._meta_text(md, "title")
        if supplied is None:
            supplied = cls._meta_text(md, "resourceTitle")
        if supplied is not None and supplied.strip():
            return supplied
        return {
            "STUDY_START": "开始专注",
            "STUDY_END": "完成专注",
            "RESOURCE_VIEW": "学习了一项资源",
            "CHAT_INTERACTION": "进行交互导学",
            "KP_MASTERY_CHECK": ("学习「" + kn + "」") if kn is not None else "复习知识点",
            "QUIZ_SUBMIT": "完成测试",
        }.get(etype, "完成测试")

    @classmethod
    def _event_desc(cls, etype, stype, dur, md):
        detail = cls._meta_text(md, "description")
        if detail is None:
            detail = cls._meta_text(md, "action")
        if detail is not None and detail.strip():
            return detail
        if dur is not None and dur > 0:
            return "持续 %d 分钟" % max(1, dur // 60)
        return {
            "CHAT": "围绕当前领域提问与交流",
            "RESOURCE": "打开并学习个性化资源",
            "KNOWLEDGE_BASE": "浏览知识库内容",
            "QUIZ": "完成题目并更新掌握情况",
            "WORKFLOW": "完成一段学习流程",
        }.get(stype, "完成一段学习流程")


# ---- deep compare ----

def deep_eq(got, want, path=""):
    """Compare got vs want, allowing float tolerance of 1e-9 on numbers."""
    if isinstance(want, float) and isinstance(got, (int, float)):
        return abs(float(got) - want) < 1e-9, "%s: got=%r want=%r" % (path, got, want)
    if isinstance(want, dict):
        if not isinstance(got, dict):
            return False, "%s: got type %s want dict" % (path, type(got).__name__)
        if list(got.keys()) != list(want.keys()):
            return False, "%s: keys got=%s want=%s" % (path, list(got.keys()), list(want.keys()))
        for k in want:
            ok, d = deep_eq(got[k], want[k], path + "." + k)
            if not ok:
                return False, d
        return True, ""
    if isinstance(want, list):
        if not isinstance(got, list):
            return False, "%s: got type %s want list" % (path, type(got).__name__)
        if len(got) != len(want):
            return False, "%s: len got=%d want=%d" % (path, len(got), len(want))
        for i, (g, w) in enumerate(zip(got, want)):
            ok, d = deep_eq(g, w, "%s[%d]" % (path, i))
            if not ok:
                return False, d
        return True, ""
    if want != got:
        return False, "%s: got=%r want=%r" % (path, got, want)
    return True, ""


# ---- the run ----

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:19413")
    args = ap.parse_args()

    secret = os.environ.get("JWT_SECRET", "")
    if not secret:
        raise SystemExit("JWT_SECRET is required")

    conn = db_connect()
    cur = conn.cursor()

    runid = uuid.uuid4().hex[:12]
    marker = "vf-profile-" + runid
    fixture_user = uuid.uuid4()
    user_bin = fixture_user
    user_id = str(fixture_user)
    token = mint_jwt(secret, user_id)
    created_ids = {"users": [], "user_profiles": [], "learning_goals": [],
                   "study_sessions": [], "learning_events": [],
                   "quiz_results": [], "knowledge_mastery": [],
                   "learning_daily_summaries": [], "knowledge_category": [],
                   "knowledge_domain": []}

    try:
        # ---- fixture user ----
        cur.execute(
            "INSERT INTO users (id, email, password_hash, nickname, active, account_type,"
            " organization_id, admin_scope, created_at, updated_at)"
            " VALUES (%s,%s,%s,%s,1,'LEARNER',NULL,NULL,NOW(6),NOW(6))",
            (fixture_user.bytes, marker + "@vf.invalid", "!" + runid, "VF " + runid))
        created_ids["users"].append(fixture_user.bytes)

        exp = Expected(cur, user_bin, runid)

        # =========================================================
        # PART A — empty user: no profile, no goal, no sessions, etc.
        # =========================================================
        print("\n--- A: empty user ---", flush=True)

        st, body = api_get(args.base, "/api/v1/learner-profile", token)
        try:
            env = json.loads(body)
        except Exception as e:
            check("profile (empty) envelope parses", False, repr(e))
            return
        check("profile (empty) HTTP 200", st == 200, "status=%d" % st)
        check("profile (empty) envelope code==0", env.get("code") == 0, str(env.get("code")))
        check("profile (empty) envelope message==success",
              env.get("message") == "success", str(env.get("message")))
        data = env.get("data") or {}
        check("profile (empty) field order matches record",
              list(data.keys()) == PROFILE_FIELDS, str(list(data.keys())))
        check("profile (empty) profile field order matches ProfileInfo",
              list((data.get("profile") or {}).keys()) == PROFILE_INFO_FIELDS,
              str(list((data.get("profile") or {}).keys())))
        check("profile (empty) currentGoal is null (no row)",
              data.get("currentGoal") is None, repr(data.get("currentGoal")))
        check("profile (empty) stats field order matches StudyStatsInfo",
              list((data.get("stats") or {}).keys()) == STUDY_STATS_FIELDS,
              str(list((data.get("stats") or {}).keys())))
        check("profile (empty) stats are all zeros",
              (data.get("stats") or {}).get("totalStudyMinutes") == 0
              and (data.get("stats") or {}).get("totalDays") == 0
              and (data.get("stats") or {}).get("streakDays") == 0
              and (data.get("stats") or {}).get("weeklyMinutes") == [0] * 7
              and (data.get("stats") or {}).get("studyDates") == []
              and (data.get("stats") or {}).get("eventDistribution") == {},
              str(data.get("stats")))
        check("profile (empty) mastery is all zeros",
              (data.get("mastery") or {}).get("overall") == 0.0
              and (data.get("mastery") or {}).get("categories") == []
              and (data.get("mastery") or {}).get("strongPoints") == []
              and (data.get("mastery") or {}).get("weakPoints") == [],
              str(data.get("mastery")))
        check("profile (empty) recentQuizzes is []",
              data.get("recentQuizzes") == [], repr(data.get("recentQuizzes")))

        # journal (empty)
        st, body = api_get(args.base, "/api/v1/learner-profile/journal", token)
        env = json.loads(body)
        check("journal (empty) HTTP 200", st == 200, "status=%d" % st)
        jdata = env.get("data") or {}
        check("journal (empty) field order matches record",
              list(jdata.keys()) == JOURNAL_FIELDS, str(list(jdata.keys())))
        check("journal (empty) date is today in Asia/Shanghai",
              jdata.get("date") == exp.today_sh.isoformat(),
              "got=%s want=%s" % (jdata.get("date"), exp.today_sh.isoformat()))
        check("journal (empty) stats are all zeros",
              all(v == 0 for v in (jdata.get("stats") or {}).values()),
              str(jdata.get("stats")))
        check("journal (empty) timeline is []", jdata.get("timeline") == [],
              repr(jdata.get("timeline")))
        check("journal (empty) summary is null", jdata.get("summary") is None,
              repr(jdata.get("summary")))

        # invalid ?date= → 500
        for bad in ("notadate", "2026-13-01", "2026-02-30", "2026-1-1",
                    "2026-10-18T00:00:00", ""):
            st, body = api_get(args.base, "/api/v1/learner-profile/journal?date=" + bad, token)
            env2 = json.loads(body)
            check("journal ?date=%r → 500" % bad,
                  st == 500 and env2.get("code") == 1500,
                  "status=%d code=%s" % (st, env2.get("code")))

        # =========================================================
        # PART B — populate and verify the full profile
        # =========================================================
        print("\n--- B: populated profile ---", flush=True)

        # knowledge domain + categories (isolated).  NOTE: knowledge_category.id
        # and knowledge_domain.id are `bigint unsigned`, not BINARY(16) — these
        # fixtures use a run-scoped high integer range and delete it after.
        fixture_base = 9_100_000_000_000_000_000 + (int(hashlib.sha256(
            runid.encode()).hexdigest()[:8], 16) % 1_000_000) * 1000
        domain_id = fixture_base + 10
        cur.execute(
            "INSERT INTO knowledge_domain (id, code, name, description, created_at, updated_at)"
            " VALUES (%s,%s,%s,%s,NOW(6),NOW(6))",
            (domain_id, "vf-domain-" + runid, "VF域 " + runid, "VF"))
        created_ids["knowledge_domain"].append(domain_id)

        cat_ids = []
        for idx, (name, score) in enumerate(
                [("VF强项A", "0.8500"), ("VF中等B", "0.5500"),
                 ("VF弱项C", "0.2000")], start=1):
            cid = fixture_base + idx
            cur.execute(
                "INSERT INTO knowledge_category (id, domain_id, node_code, name,"
                " description, sort_order, status, created_at, updated_at)"
                " VALUES (%s,%s,%s,%s,%s,1,1,NOW(6),NOW(6))",
                (cid, domain_id, "vf-cat-%d-%s" % (idx, runid),
                 name + " " + runid, "VF", ))
            created_ids["knowledge_category"].append(cid)
            cat_ids.append(cid)

        goal_id = uuid.uuid4()
        # created_at = 10 days ago UTC, target = +20 days from created → total=20
        created_10ago = (exp.now_utc - timedelta(days=10)).strftime("%Y-%m-%d %H:%M:%S.%f")
        target_d = (exp.today_utc + timedelta(days=10)).isoformat()
        cur.execute(
            "INSERT INTO learning_goals (id, user_id, knowledge_domain_id, goal_type,"
            " title, expected_level, status, target_date, created_at, updated_at)"
            " VALUES (%s,%s,%s,'COURSE_STUDY',%s,'PROFICIENT','ACTIVE',%s,%s,NOW(6))",
            (goal_id.bytes, user_bin.bytes, domain_id, "VF目标 " + runid,
             target_d, created_10ago))
        created_ids["learning_goals"].append(goal_id.bytes)

        # user profile
        cur.execute(
            "INSERT INTO user_profiles (user_id, education_level, major,"
            " technical_foundation, name, avatar, role, job_title, organization_id,"
            " department_id, weekly_hours, learning_style_json, goal, preferred_format,"
            " self_assessment_json, diagnosis_summary_json, learning_preference,"
            " current_goal_id, profile_completed, tts_voice, tts_speed, created_at, updated_at)"
            " VALUES (%s,'本科','软件工程','有 Python 基础','VF 名字',NULL,'student','实习生',"
            " NULL,NULL,12,'[\"visual\"]','进大厂','video','{}','{}','CASE_DRIVEN',"
            " %s,1,'苏打','normal',NOW(6),NOW(6))",
            (user_bin.bytes, goal_id.bytes))
        created_ids["user_profiles"].append(user_bin.bytes)

        # study sessions: today, yesterday, 2 days ago, and 10 days ago (streak=3)
        today_s = exp.today_utc.isoformat()
        yesterday_s = (exp.today_utc - timedelta(days=1)).isoformat()
        d2_s = (exp.today_utc - timedelta(days=2)).isoformat()
        d10_s = (exp.today_utc - timedelta(days=10)).isoformat()
        for sd, secs, ev, chat, res, quiz in [
            (today_s, 3600, 5, 2, 2, 1),
            (yesterday_s, 1800, 3, 1, 1, 1),
            (d2_s, 900, 2, 1, 1, 0),
            (d10_s, 600, 1, 0, 1, 0),
        ]:
            sid = uuid.uuid4()
            cur.execute(
                "INSERT INTO study_sessions (id, user_id, session_date,"
                " total_duration_seconds, event_count, chat_count, resource_count,"
                " quiz_count, created_at, updated_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,NOW(6),NOW(6))",
                (sid.bytes, user_bin.bytes, sd, secs, ev, chat, res, quiz))
            created_ids["study_sessions"].append(sid.bytes)

        # mastery: three categories, exactly representable scores
        for cid, score, att, corr in [
            (cat_ids[0], "0.8500", 10, 9),
            (cat_ids[1], "0.5500", 8, 4),
            (cat_ids[2], "0.2000", 5, 1),
        ]:
            mid = uuid.uuid4()
            cur.execute(
                "INSERT INTO knowledge_mastery (id, user_id, knowledge_category_id,"
                " mastery_score, attempt_count, correct_count, last_attempt_at,"
                " streak_correct, streak_wrong, updated_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,NOW(6),0,0,NOW(6))",
                (mid.bytes, user_bin.bytes, cid, score, att, corr))
            created_ids["knowledge_mastery"].append(mid.bytes)

        # quizzes: 3 in the last hour (recentQuizzes + journal today)
        quiz_ids = []
        for i, (qt, score, cid, q, c, dur, diff) in enumerate([
            ("FORMATIVE", "85.50", cat_ids[0], 10, 9, 300, "MEDIUM"),
            ("SUMMATIVE", None, cat_ids[1], 5, 3, 180, None),
            ("DIAGNOSTIC", "60.00", None, 8, 5, 240, "EASY"),
        ]):
            qid = uuid.uuid4()
            created = (exp.now_utc - timedelta(hours=1, minutes=i * 10)).astimezone(SH)
            cur.execute(
                "INSERT INTO quiz_results (id, user_id, quiz_type, knowledge_category_id,"
                " question_count, correct_count, score, duration_seconds, difficulty_level,"
                " details, created_at)"
                " VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,NULL,%s)",
                (qid.bytes, user_bin.bytes, qt, cid,
                 q, c, score, dur, diff,
                 created.strftime("%Y-%m-%d %H:%M:%S.%f")))
            created_ids["quiz_results"].append(qid.bytes)
            quiz_ids.append(qid)

        # learning events for today's journal
        # timestamps: 2h ago, 90min ago, 60min ago, 30min ago (all +08 session)
        def sh_ago(minutes):
            return (exp.now_utc.astimezone(SH) - timedelta(minutes=minutes)).strftime(
                "%Y-%m-%d %H:%M:%S.%f")

        event_specs = [
            # (etype, stype, cid, dur, metadata, minutes_ago)
            ("STUDY_START", "WORKFLOW", None, None, None, 120),
            ("RESOURCE_VIEW", "RESOURCE", cat_ids[0], 600,
             json.dumps({"title": "VF资源标题", "resourceTitle": "ignored"}, ensure_ascii=False), 110),
            ("CHAT_INTERACTION", "CHAT", None, None,
             json.dumps({"description": "围绕某个问题提问"}, ensure_ascii=False), 90),
            ("KP_MASTERY_CHECK", "KNOWLEDGE_BASE", cat_ids[1], None,
             json.dumps({"knowledgePoint": "知识点X"}, ensure_ascii=False), 70),
            ("QUIZ_SUBMIT", "QUIZ", cat_ids[0], 300, None, 60),  # skipped in timeline
            ("STUDY_END", "WORKFLOW", None, 1800, None, 30),
            ("RESOURCE_VIEW", "KNOWLEDGE_BASE", None, None, None, 15),  # no title/desc
        ]
        for etype, stype, cid, dur, meta, mins in event_specs:
            eid = uuid.uuid4()
            cur.execute(
                "INSERT INTO learning_events (id, user_id, event_type, source_type,"
                " source_id, knowledge_category_id, duration_seconds, metadata, created_at)"
                " VALUES (%s,%s,%s,%s,NULL,%s,%s,%s,%s)",
                (eid.bytes, user_bin.bytes, etype, stype,
                 cid, dur, meta, sh_ago(mins)))
            created_ids["learning_events"].append(eid.bytes)

        # daily summary for today SH
        sid = uuid.uuid4()
        metrics = json.dumps({"focusSeconds": 1800, "resourceCount": 2})
        cur.execute(
            "INSERT INTO learning_daily_summaries (id, user_id, summary_date,"
            " summary_text, metrics_json, generated_at, updated_at)"
            " VALUES (%s,%s,%s,%s,%s,NOW(6),NOW(6))",
            (sid.bytes, user_bin.bytes, exp.today_sh.isoformat(),
             "VF 当日小结 " + runid, metrics))
        created_ids["learning_daily_summaries"].append(sid.bytes)

        # ---- verify profile ----
        st, body = api_get(args.base, "/api/v1/learner-profile", token)
        env = json.loads(body)
        check("profile (populated) HTTP 200", st == 200, "status=%d" % st)
        data = env.get("data") or {}
        want_profile = exp.profile_info()
        want_goal = exp.current_goal()
        want_stats = exp.study_stats()
        want_mastery = exp.mastery()
        want_quizzes = exp.recent_quizzes()

        ok, d = deep_eq(data.get("profile"), want_profile, "profile")
        check("profile.profile matches ProfileInfo", ok, d)
        ok, d = deep_eq(data.get("currentGoal"), want_goal, "currentGoal")
        check("profile.currentGoal matches CurrentGoalInfo", ok, d)
        ok, d = deep_eq(data.get("stats"), want_stats, "stats")
        check("profile.stats matches StudyStatsInfo", ok, d)
        ok, d = deep_eq(data.get("mastery"), want_mastery, "mastery")
        check("profile.mastery matches MasteryInfo", ok, d)
        ok, d = deep_eq(data.get("recentQuizzes"), want_quizzes, "recentQuizzes")
        check("profile.recentQuizzes matches QuizSummary list", ok, d)

        # spot-checks that the deep compare could miss if both sides share a bug
        cg = data.get("currentGoal") or {}
        check("currentGoal.title prefers domain name (not goal title)",
              cg.get("title") == ("VF域 " + runid),
              "got=%s" % cg.get("title"))
        check("currentGoal.progress is ~0.5 (10 of 20 days elapsed)",
              abs((cg.get("progress") or 0) - 0.5) < 0.01,
              "got=%s" % cg.get("progress"))
        stt = data.get("stats") or {}
        check("streakDays is 3 (today, yesterday, day-2; day-10 is a gap)",
              stt.get("streakDays") == 3, "got=%s" % stt.get("streakDays"))
        check("totalStudyMinutes is 115 (3600+1800+900+600)/60",
              stt.get("totalStudyMinutes") == 115, "got=%s" % stt.get("totalStudyMinutes"))
        check("weeklyMinutes has 7 entries", len(stt.get("weeklyMinutes") or []) == 7,
              "got=%s" % stt.get("weeklyMinutes"))
        mas = data.get("mastery") or {}
        check("mastery.overall is 0.53 ((0.85+0.55+0.20)/3 → round)",
              abs((mas.get("overall") or 0) - 0.53) < 0.001,
              "got=%s" % mas.get("overall"))
        check("strongPoints has 1 entry (score>=0.7)",
              (mas.get("strongPoints") or []) == ["VF强项A " + runid],
              "got=%s" % mas.get("strongPoints"))
        check("weakPoints has 1 entry (score<0.4)",
              (mas.get("weakPoints") or []) == ["VF弱项C " + runid],
              "got=%s" % mas.get("weakPoints"))
        rqs = data.get("recentQuizzes") or {}
        check("recentQuizzes has 3 entries",
              len(data.get("recentQuizzes") or []) == 3,
              "got=%d" % len(data.get("recentQuizzes") or []))
        # score null is emitted
        raw = body.decode("utf-8", "replace")
        check("null quiz score is emitted as JSON null",
              re.search(r'"score"\s*:\s*null', raw) is not None,
              "raw snippet: ..." + raw[raw.find('"score"'):raw.find('"score"') + 30] if '"score"' in raw else "no score")

        # ---- verify journal ----
        st, body = api_get(args.base, "/api/v1/learner-profile/journal", token)
        env = json.loads(body)
        check("journal (populated) HTTP 200", st == 200, "status=%d" % st)
        jdata = env.get("data") or {}
        want_j = exp.journal(exp.today_sh)
        ok, d = deep_eq(jdata, want_j, "journal")
        check("journal body matches LearningJournalResponse", ok, d)

        tl = jdata.get("timeline") or {}
        # QUIZ_SUBMIT skipped; 6 events + 3 quizzes = 9
        check("timeline has 9 items (7 events + 3 quizzes, QUIZ_SUBMIT skipped)",
              len(tl) == 9, "got=%d" % len(tl))
        kinds = [t.get("kind") for t in tl]
        check("timeline kinds include focus/resource/knowledge/chat/quiz",
              "focus" in kinds and "resource" in kinds and "knowledge" in kinds
              and "chat" in kinds and "quiz" in kinds,
              "kinds=%s" % kinds)
        # stable sort: occurredAt ascending
        occurred = [t.get("occurredAt") for t in tl]
        check("timeline occurredAt is ascending",
              occurred == sorted(occurred), "got=%s" % occurred[:3])
        # titles
        titles = {t.get("kind"): t.get("title") for t in tl}
        check("RESOURCE_VIEW with metadata title uses it",
              any(t.get("title") == "VF资源标题" for t in tl),
              "titles=%s" % [t.get("title") for t in tl])
        check("CHAT_INTERACTION description from metadata",
              any(t.get("description") == "围绕某个问题提问" for t in tl),
              "descs=%s" % [t.get("description") for t in tl])
        check("KP_MASTERY_CHECK title uses category name",
              any(t.get("title", "").startswith("学习「VF中等B") for t in tl),
              "titles=%s" % [t.get("title") for t in tl])
        check("STUDY_END description is 持续 N 分钟",
              any(t.get("description") == "持续 30 分钟" for t in tl),
              "descs=%s" % [t.get("description") for t in tl])
        # quiz timeline items have correct/wrong
        quiz_items = [t for t in tl if t.get("kind") == "quiz"]
        check("quiz timeline items have correctCount and wrongCount",
              all(t.get("correctCount") is not None and t.get("wrongCount") is not None
                  for t in quiz_items),
              "got=%s" % [(t.get("correctCount"), t.get("wrongCount")) for t in quiz_items])
        # stats
        jstats = jdata.get("stats") or {}
        check("journal stats.focusSeconds is 1800 (STUDY_END only)",
              jstats.get("focusSeconds") == 1800, "got=%s" % jstats.get("focusSeconds"))
        check("journal stats.totalDurationSeconds sums all non-null durations",
              jstats.get("totalDurationSeconds") == 1800 + 600 + 300,
              "got=%s" % jstats.get("totalDurationSeconds"))
        check("journal stats.resourceCount counts RESOURCE_VIEW",
              jstats.get("resourceCount") == 2, "got=%s" % jstats.get("resourceCount"))
        check("journal stats.questionCount is 23 (10+5+8)",
              jstats.get("questionCount") == 23, "got=%s" % jstats.get("questionCount"))
        check("journal stats.correctCount is 17 (9+3+5)",
              jstats.get("correctCount") == 17, "got=%s" % jstats.get("correctCount"))
        check("journal stats.wrongCount is 6 (max(0, 23-17))",
              jstats.get("wrongCount") == 6, "got=%s" % jstats.get("wrongCount"))
        # summary
        summ = jdata.get("summary")
        check("journal summary is present with metricsJson as a string",
              summ is not None and isinstance(summ.get("metricsJson"), str),
              "got=%s" % summ)
        check("journal summary content matches the inserted text",
              summ is not None and summ.get("content") == ("VF 当日小结 " + runid),
              "got=%s" % (summ or {}).get("content"))
        # explicit ?date= for today
        st, body = api_get(args.base,
                           "/api/v1/learner-profile/journal?date=" + exp.today_sh.isoformat(),
                           token)
        jdata2 = json.loads(body).get("data") or {}
        check("explicit ?date=today matches default",
              jdata2.get("date") == exp.today_sh.isoformat()
              and len(jdata2.get("timeline") or []) == len(tl),
              "date=%s tl=%d" % (jdata2.get("date"), len(jdata2.get("timeline") or [])))
        # empty day
        empty_d = (exp.today_sh + timedelta(days=30)).isoformat()
        st, body = api_get(args.base,
                           "/api/v1/learner-profile/journal?date=" + empty_d, token)
        jdata3 = json.loads(body).get("data") or {}
        check("explicit ?date=empty day returns zeros",
              jdata3.get("date") == empty_d
              and all(v == 0 for v in (jdata3.get("stats") or {}).values())
              and jdata3.get("timeline") == []
              and jdata3.get("summary") is None,
              "date=%s stats=%s tl=%s" % (
                  jdata3.get("date"), jdata3.get("stats"), jdata3.get("timeline")))

        # cross-user isolation
        other = mint_jwt(secret, str(uuid.uuid4()))
        st, body = api_get(args.base, "/api/v1/learner-profile", other)
        odata = (json.loads(body).get("data") or {})
        check("cross-user profile sees no data",
              (odata.get("stats") or {}).get("totalDays") == 0
              and odata.get("currentGoal") is None
              and odata.get("recentQuizzes") == [],
              "stats=%s goal=%s quizzes=%s" % (
                  odata.get("stats"), odata.get("currentGoal"),
                  odata.get("recentQuizzes")))

    finally:
        def _del(table, col, b):
            try:
                cur.execute("DELETE FROM %s WHERE %s=%%s" % (table, col), (b,))
            except Exception:
                pass

        for b in created_ids["learning_daily_summaries"]:
            _del("learning_daily_summaries", "id", b)
        for b in created_ids["learning_events"]:
            _del("learning_events", "id", b)
        for b in created_ids["quiz_results"]:
            _del("quiz_results", "id", b)
        for b in created_ids["knowledge_mastery"]:
            _del("knowledge_mastery", "id", b)
        for b in created_ids["study_sessions"]:
            _del("study_sessions", "id", b)
        try:
            cur.execute("UPDATE user_profiles SET current_goal_id=NULL WHERE user_id=%s",
                        (user_bin.bytes,))
        except Exception:
            pass
        _del("user_profiles", "user_id", user_bin.bytes)
        _del("learning_goals", "user_id", user_bin.bytes)
        for b in created_ids["knowledge_category"]:
            _del("knowledge_category", "id", b)
        for b in created_ids["knowledge_domain"]:
            _del("knowledge_domain", "id", b)
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
