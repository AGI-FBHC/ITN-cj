"""DB-backed matrix for Spire's /v1/customize-tasks read side (§14.5).

Covers GET /v1/customize-tasks?kpId=, GET /v1/customize-tasks/{id} and
GET /v1/customize-tasks/{id}/slides against seeded
learning_resource_generation_tasks rows (customize=TRUE + legacy
part-split slides). Also exercises the summary serializer VALUES
(resourceSummaryColumns vs serializeResourceTaskSummary alignment).

Seeds SPIREWCT* rows under two isolation users only; cleanup removes them.

Env required: JWT_SECRET, VERIFY_MYSQL_PW, VERIFY_BASE (optional).

Run:
  JWT_SECRET=... VERIFY_MYSQL_PW=... VERIFY_BASE=http://127.0.0.1:19413 \
    python verify_customize_tasks.py
"""
import os, sys, json, time, hmac, hashlib, base64, uuid
import urllib.request, urllib.error
from datetime import datetime
import pymysql

sys.stdout.reconfigure(encoding="utf-8")

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:19413")
JWT_SECRET = os.environ["JWT_SECRET"]
DB = dict(
    host=os.environ.get("VERIFY_MYSQL_HOST", "43.160.236.121"),
    port=int(os.environ.get("VERIFY_MYSQL_PORT", "3306")),
    user=os.environ.get("VERIFY_MYSQL_USER", "root"),
    password=os.environ["VERIFY_MYSQL_PW"],
    database=os.environ.get("VERIFY_MYSQL_DB", "itn_cangjie_dev"),
    charset="utf8mb4",
    connect_timeout=15,
)
TAG = "SPIREWCT" + time.strftime("%H%M%S")
USER_C = "33333333-cccc-4ccc-8ccc-cccccccccccc"
USER_D = "44444444-dddd-4ddd-8ddd-dddddddddddd"
GHOST = "ffffffff-ffff-4fff-8fff-ffffffffffff"

TASK_A = "aaaaaaaa-6001-4000-8000-00000000000a"   # C, generating, 7 legacy cards
TASK_B = "aaaaaaaa-6002-4000-8000-00000000000b"   # C, completed, simple slides
TASK_C = "aaaaaaaa-6003-4000-8000-00000000000c"   # C, failed, no kpId, empty slides
TASK_N = "aaaaaaaa-6004-4000-8000-00000000000d"   # C, customize=FALSE (excluded)
TASK_D = "aaaaaaaa-6005-4000-8000-00000000000e"   # D, customize=TRUE (other owner)
SEED_IDS = [t.replace("-", "") for t in (TASK_A, TASK_B, TASK_C, TASK_N, TASK_D)]
RES_B = "eeeeeeee-3001-4000-8000-0000000000e1"

TASK = "learning_resource_generation_tasks"

SUMMARY_KEYS = ["id", "resourceType", "title", "status", "progress", "stageMessage",
                "events", "resourceId", "errorMessage", "request", "createdAt", "updatedAt"]
FULL_KEYS = ["id", "resourceType", "title", "status", "progress", "stageMessage",
             "events", "resourceId", "checkpointStage", "errorMessage", "request",
             "createdAt", "updatedAt"]

# Legacy 7-card split structure for TASK_A (hand-traced coalesce expectations:
# caution-block strip, part merge, title suffix strip, final reindex 0..4).
SLIDES_A = [
    {"type": "directory", "unitIndex": 0, "partIndex": 0, "partCount": 2,
     "title": "第一章（1/2）",
     "content": "第一节内容\n\n**注意事项**\n\ncaution\n保持专注", "totalUnits": 4},
    {"type": "directory", "unitIndex": 0, "partIndex": 1, "partCount": 2,
     "title": "第一章（2/2）", "content": "第二节内容", "totalUnits": 4},
    {"type": "directory", "unitIndex": 1, "partIndex": 0, "partCount": 1,
     "title": "第二章", "content": "第二章正文", "totalUnits": 4},
    {"type": "question", "unitIndex": 2, "title": "随堂测",
     "content": {"stem": "题干", "options": ["A", "B"]}, "totalUnits": 4},
    {"type": "concept", "unitIndex": None, "title": "前言",
     "content": "前言内容", "totalUnits": 4},
    {"type": "concept", "unitIndex": 3, "partIndex": 0, "partCount": 2,
     "title": "要点（1/2）", "content": "要点开头\n**注意事项**\nDANGER\n", "totalUnits": 4},
    {"type": "concept", "unitIndex": 3, "partIndex": 1, "partCount": 2,
     "title": "要点（2/2）", "content": " 要点续", "totalUnits": 4},
]
SLIDES_A_EXPECTED = [
    {"type": "directory", "unitIndex": 0, "partIndex": 0, "partCount": 1,
     "title": "第一章", "content": "第一节内容\n保持专注\n\n第二节内容",
     "totalUnits": 4, "index": 0},
    {"type": "directory", "unitIndex": 1, "partIndex": 0, "partCount": 1,
     "title": "第二章", "content": "第二章正文", "totalUnits": 4, "index": 1},
    {"type": "question", "unitIndex": 2, "title": "随堂测",
     "content": {"stem": "题干", "options": ["A", "B"]}, "totalUnits": 4, "index": 2},
    {"type": "concept", "unitIndex": None, "title": "前言",
     "content": "前言内容", "totalUnits": 4, "index": 3},
    {"type": "concept", "unitIndex": 3, "partIndex": 0, "partCount": 1,
     "title": "要点", "content": "要点开头\n\n要点续", "totalUnits": 4, "index": 4},
]
SLIDES_B = [
    {"type": "directory", "unitIndex": 0, "partCount": 1, "title": "完成页",
     "content": "甲", "totalUnits": 2},
    {"type": "question", "unitIndex": 1, "title": "测",
     "content": {"stem": "s"}, "totalUnits": 2},
]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(sub: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps({"sub": sub, "exp": int(time.time()) + 3600}, separators=(",", ":")).encode())
    msg = f"{header}.{payload}".encode()
    sig = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(sig)}"


def req(method, path, token=None, body=None):
    url = BASE + path
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read()
            st = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        st = e.code
    except Exception as e:
        return None, f"ERR {type(e).__name__}: {e}"
    try:
        return st, json.loads(raw.decode("utf-8"))
    except Exception:
        return st, raw.decode("utf-8", "replace")[:300]


results = []


def check(name, cond, detail=""):
    results.append((name, "PASS" if cond else "FAIL", detail))
    print(f"{'PASS' if cond else 'FAIL':4} | {name} | {detail}")


def keys(o):
    return list(o.keys()) if isinstance(o, dict) else []


print("TAG", TAG, "BASE", BASE)
tok_c = make_jwt(USER_C)
tok_d = make_jwt(USER_D)

conn = pymysql.connect(**DB)
cur = conn.cursor()
conn.autocommit(True)


def ensure_schema():
    """Mirror Python resource_generation_tasks.ensure_schema (column adds)."""
    cur.execute(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s", (TASK,))
    have = {r[0] for r in cur.fetchall()}
    for col, ddl in [
        ("slides_json", f"ALTER TABLE {TASK} ADD COLUMN slides_json JSON NOT NULL DEFAULT (JSON_ARRAY()) AFTER events_json"),
        ("resume_enabled", f"ALTER TABLE {TASK} ADD COLUMN resume_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER resource_id"),
        ("checkpoint_stage", f"ALTER TABLE {TASK} ADD COLUMN checkpoint_stage VARCHAR(48) NULL AFTER resume_enabled"),
        ("checkpoint_json", f"ALTER TABLE {TASK} ADD COLUMN checkpoint_json JSON NULL AFTER checkpoint_stage"),
    ]:
        if col not in have:
            cur.execute(ddl)
            print(f"  ensure_schema: added {col}")


ensure_schema()


def seed_user(uid_hex, email):
    cur.execute(
        "INSERT INTO users (id,email,password_hash,nickname,active,account_type,created_at,updated_at) "
        "VALUES (UNHEX(%s),%s,'x',%s,1,'LEARNER',NOW(6),NOW(6)) "
        "ON DUPLICATE KEY UPDATE email=VALUES(email)",
        (uid_hex.replace("-", ""), email, TAG),
    )


seed_user(USER_C, f"{TAG.lower()}-c@example.com")
seed_user(USER_D, f"{TAG.lower()}-d@example.com")

# idempotent re-run: drop the five fixed rows first
cur.execute(
    f"DELETE FROM {TASK} WHERE id IN ({','.join(['UNHEX(%s)'] * len(SEED_IDS))})",
    SEED_IDS)


def seed_task(task_hex, user_hex, *, rtype, title, status, progress, stage,
              request, created_at, events=None, slides_json=None, resource_id=None,
              error=None):
    if events is None:
        events = [{"seq": 1, "time": created_at, "agent": "SYSTEM",
                   "agentName": "系统流程", "actorType": "system", "eventType": "task_lifecycle",
                   "status": status, "phase": status, "title": "点验播种", "detail": TAG,
                   "snapshot": {"resourceType": rtype}}]
    cur.execute(
        f"INSERT INTO {TASK} (id,user_id,resource_type,title,status,progress,stage_message,"
        "events_json,slides_json,resource_id,error_message,request_json,created_at,updated_at) "
        "VALUES (UNHEX(%s),UNHEX(%s),%s,%s,%s,%s,%s,CAST(%s AS JSON),%s,%s,%s,"
        "CAST(%s AS JSON),%s,%s)",
        (task_hex, user_hex, rtype, title, status, progress, stage,
         json.dumps(events, ensure_ascii=False),
         json.dumps(slides_json if slides_json is not None else [], ensure_ascii=False),
         bytes.fromhex(resource_id) if resource_id else None, error,
         json.dumps(request, ensure_ascii=False), created_at, created_at))


seed_task(SEED_IDS[0], USER_C.replace("-", ""), rtype="lecture", title=f"{TAG}-custA标题",
          status="generating", progress=40, stage="生成中",
          request={"customize": True, "kpId": f"{TAG}-kpA", "expectedTotal": 4,
                   "resourceType": "lecture"},
          created_at="2026-10-01 08:00:00",
          events=[{"seq": 1, "time": "2026-10-01T08:00:00", "agent": "SYSTEM",
                   "title": "任务已创建"},
                  {"seq": 2, "time": "2026-10-01T08:05:00", "agent": "教研智能体",
                   "title": "开始生成"}],
          slides_json=SLIDES_A)
seed_task(SEED_IDS[1], USER_C.replace("-", ""), rtype="quiz", title=f"{TAG}-custB标题",
          status="completed", progress=100, stage="已完成",
          request={"customize": True, "kpId": f"{TAG}-kpB", "expectedTotal": 2},
          created_at="2026-10-02 08:00:00", slides_json=SLIDES_B,
          resource_id=RES_B.replace("-", ""))
seed_task(SEED_IDS[2], USER_C.replace("-", ""), rtype="practice", title=f"{TAG}-custC标题",
          status="failed", progress=60, stage="生成失败",
          request={"customize": True, "expectedTotal": 5},
          created_at="2026-10-03 08:00:00", slides_json=[], error="点验失败详情")
seed_task(SEED_IDS[3], USER_C.replace("-", ""), rtype="lecture", title=f"{TAG}-非定制行",
          status="completed", progress=100, stage="已完成",
          request={"customize": False, "topic": f"{TAG}-notcust"},
          created_at="2026-10-04 08:00:00")
seed_task(SEED_IDS[4], USER_D.replace("-", ""), rtype="lecture", title=f"{TAG}-D行",
          status="generating", progress=30, stage="生成中",
          request={"customize": True, "kpId": f"{TAG}-kpD"},
          created_at="2026-10-05 08:00:00")

print("seeded", len(SEED_IDS), "rows")

# ------------------------------------------------------------------ list --

print("\n---- list ----")

st, b = req("GET", "/v1/customize-tasks", tok_c)
ok = st == 200 and isinstance(b, dict)
check("list 200", ok, str(st))
tasks = (b or {}).get("tasks") if ok else None
if ok:
    ids = [t.get("id") for t in (tasks or [])]
    check("list order DESC + excludes non-cust",
          ids == [TASK_C, TASK_B, TASK_A], str(ids))
    check("list hides other owner", TASK_D not in ids, str(ids))

    sm = next((t for t in tasks if t.get("id") == TASK_A), None) or {}
    check("summary key order", keys(sm) == SUMMARY_KEYS, str(keys(sm)))
    check("summary omits checkpointStage", "checkpointStage" not in sm, str(keys(sm)))
    check("summary forces events []", sm.get("events") == [], repr(sm.get("events")))
    # VALUES — guards the resourceSummaryColumns/serializer positional alignment
    check("summary values A",
          sm.get("resourceType") == "lecture" and sm.get("title") == f"{TAG}-custA标题"
          and sm.get("status") == "generating" and sm.get("progress") == 40
          and sm.get("stageMessage") == "生成中"
          and sm.get("createdAt") == "2026-10-01T08:00:00",
          json.dumps({k: sm.get(k) for k in ("resourceType", "title", "status",
                                             "progress", "stageMessage", "createdAt")},
                     ensure_ascii=False))
    check("summary request A",
          isinstance(sm.get("request"), dict) and sm["request"].get("customize") is True
          and sm["request"].get("kpId") == f"{TAG}-kpA",
          json.dumps(sm.get("request"), ensure_ascii=False)[:140])
    check("summary A nulls", sm.get("resourceId") is None and sm.get("errorMessage") is None,
          str({k: sm.get(k) for k in ("resourceId", "errorMessage")}))

    smc = next((t for t in tasks if t.get("id") == TASK_C), None) or {}
    check("summary values C (failed)",
          smc.get("resourceType") == "practice" and smc.get("status") == "failed"
          and smc.get("progress") == 60 and smc.get("errorMessage") == "点验失败详情"
          and smc.get("request", {}).get("kpId") is None
          and smc.get("createdAt") == "2026-10-03T08:00:00",
          json.dumps({k: smc.get(k) for k in ("resourceType", "status", "progress",
                                              "errorMessage", "createdAt")},
                     ensure_ascii=False))

    smb = next((t for t in tasks if t.get("id") == TASK_B), None) or {}
    check("summary values B resourceId uuid",
          smb.get("resourceId") == str(uuid.UUID(RES_B)),
          repr(smb.get("resourceId")))

st, b = req("GET", f"/v1/customize-tasks?kpId={TAG}-kpA", tok_c)
ids = [t.get("id") for t in ((b or {}).get("tasks") or [])] if st == 200 else None
check("list filter kpId=A", st == 200 and ids == [TASK_A], str(st) + " " + str(ids))

st, b = req("GET", f"/v1/customize-tasks?kpId={TAG}-kpNope", tok_c)
ids = [t.get("id") for t in ((b or {}).get("tasks") or [])] if st == 200 else None
check("list filter no match -> []", st == 200 and ids == [], str(st) + " " + str(ids))

st, b = req("GET", "/v1/customize-tasks?kpId=", tok_c)
ids = [t.get("id") for t in ((b or {}).get("tasks") or [])] if st == 200 else None
check("list filter empty -> no filter", st == 200 and ids == [TASK_C, TASK_B, TASK_A],
      str(st) + " " + str(ids))

st, b = req("GET", f"/v1/customize-tasks?kpId={TAG}-KPA", tok_c)
ids = [t.get("id") for t in ((b or {}).get("tasks") or [])] if st == 200 else None
check("list filter case-sensitive", st == 200 and ids == [], str(st) + " " + str(ids))

st, b = req("GET", "/v1/customize-tasks", tok_d)
ids = [t.get("id") for t in ((b or {}).get("tasks") or [])] if st == 200 else None
check("list owner D only own", st == 200 and ids == [TASK_D], str(st) + " " + str(ids))

st, b = req("GET", "/v1/customize-tasks", None)
check("list no token unauthorized", st in (401, 403), str(st))

# ------------------------------------------------------------------- get --

print("\n---- get ----")

st, b = req("GET", f"/v1/customize-tasks/{TASK_A}", tok_c)
ok = st == 200 and isinstance(b, dict)
check("get A 200", ok, str(st))
if ok:
    check("get A key order", keys(b) == FULL_KEYS, str(keys(b)))
    check("get A checkpointStage null", b.get("checkpointStage") is None, repr(b.get("checkpointStage")))
    evs = b.get("events")
    check("get A events full",
          isinstance(evs, list) and len(evs) == 2
          and evs[0].get("seq") == 1 and evs[1].get("agent") == "教研智能体",
          repr(evs)[:160])
    check("get A request", b.get("request", {}).get("kpId") == f"{TAG}-kpA"
          and b.get("request", {}).get("customize") is True, str(b.get("request"))[:140])
    check("get A values",
          b.get("resourceType") == "lecture" and b.get("title") == f"{TAG}-custA标题"
          and b.get("status") == "generating" and b.get("progress") == 40
          and b.get("createdAt") == "2026-10-01T08:00:00",
          str({k: b.get(k) for k in ("resourceType", "title", "status", "progress", "createdAt")}))

st, b = req("GET", f"/v1/customize-tasks/{TASK_N}", tok_c)
check("get non-cust 200 (no customize check)",
      st == 200 and isinstance(b, dict) and b.get("title") == f"{TAG}-非定制行"
      and b.get("request", {}).get("customize") is False,
      f"{st} {str(b and b.get('title'))}")

st, b = req("GET", f"/v1/customize-tasks/{GHOST}", tok_c)
check("get ghost 404",
      st == 404 and isinstance(b, dict) and b.get("detail") == "Customization task not found",
      f"{st} {str(b)[:100]}")

st, b = req("GET", f"/v1/customize-tasks/{TASK_D}", tok_c)
check("get cross-owner 404", st == 404, str(st))

# ---------------------------------------------------------------- slides --

print("\n---- slides ----")

st, b = req("GET", f"/v1/customize-tasks/{TASK_A}/slides", tok_c)
ok = st == 200 and isinstance(b, dict)
check("slides A 200", ok, str(st))
if ok:
    check("slides A key order",
          keys(b) == ["slides", "total", "completed", "status", "resourceId",
                      "resourceType", "title", "stageMessage", "kpId"],
          str(keys(b)))
    check("slides A coalesced cards", b.get("slides") == SLIDES_A_EXPECTED,
          json.dumps(b.get("slides"), ensure_ascii=False)[:400])
    check("slides A counters",
          b.get("total") == 5 and b.get("completed") == 4 and b.get("status") == "generating",
          f"total={b.get('total')} completed={b.get('completed')} status={b.get('status')}")
    check("slides A envelope values",
          b.get("resourceId") is None and b.get("resourceType") == "lecture"
          and b.get("title") == f"{TAG}-custA标题" and b.get("stageMessage") == "生成中"
          and b.get("kpId") == f"{TAG}-kpA",
          json.dumps({k: b.get(k) for k in ("resourceId", "resourceType", "title",
                                            "stageMessage", "kpId")}, ensure_ascii=False))

st, b = req("GET", f"/v1/customize-tasks/{TASK_B}/slides", tok_c)
ok = st == 200 and isinstance(b, dict)
check("slides B 200", ok, str(st))
if ok:
    check("slides B completed totals",
          b.get("status") == "completed" and b.get("total") == 2 and b.get("completed") == 2,
          f"{b.get('status')}/{b.get('total')}/{b.get('completed')}")
    check("slides B resourceId",
          b.get("resourceId") == str(uuid.UUID(RES_B)), repr(b.get("resourceId")))
    check("slides B cards passthrough",
          b.get("slides") == [dict(SLIDES_B[0], index=0), dict(SLIDES_B[1], index=1)],
          json.dumps(b.get("slides"), ensure_ascii=False)[:300])

st, b = req("GET", f"/v1/customize-tasks/{TASK_C}/slides", tok_c)
ok = st == 200 and isinstance(b, dict)
check("slides C 200", ok, str(st))
if ok:
    check("slides C failed empty",
          b.get("slides") == [] and b.get("status") == "failed"
          and b.get("total") == 5 and b.get("completed") == 0
          and b.get("kpId") is None and b.get("resourceId") is None,
          json.dumps(b, ensure_ascii=False)[:240])

st, b = req("GET", f"/v1/customize-tasks/{GHOST}/slides", tok_c)
check("slides ghost 404",
      st == 404 and isinstance(b, dict) and b.get("detail") == "Customization task not found",
      f"{st} {str(b)[:100]}")

st, b = req("GET", f"/v1/customize-tasks/{TASK_D}/slides", tok_c)
check("slides cross-owner 404", st == 404, str(st))

# ---------------------------------------------------------------- cleanup --

print("\n---- cleanup ----")
try:
    cur.execute(
        f"DELETE FROM {TASK} WHERE id IN ({','.join(['UNHEX(%s)'] * len(SEED_IDS))})",
        SEED_IDS)
    print("  tasks deleted:", cur.rowcount)
finally:
    cur.close()
    conn.close()

fails = [r for r in results if r[1] == "FAIL"]
print(f"\n=== TOTAL {len(results) - len(fails)}/{len(results)} | fails={len(fails)} ===")
for name, _, detail in fails:
    print("  FAIL:", name, "|", detail)
sys.exit(1 if fails else 0)
