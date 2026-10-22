"""DB-backed matrix for the Spire resource-task WRITE side (§14.4).

Covers POST /v1/learning-resource-tasks/{type} (202), .../{id}/restart
(200/409) and .../{id}/cancel (200/404), with pymysql readback. Seeds
SPIREWBT* rows under two isolation users only; real rows are never touched.
AI enqueue (in-process asyncio registry) stays in Python and is out of scope.

Env required: JWT_SECRET, VERIFY_MYSQL_PW, VERIFY_BASE (optional).

Run:
  JWT_SECRET=... VERIFY_MYSQL_PW=... VERIFY_BASE=http://127.0.0.1:19413 \
    python verify_rtask_write.py
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
TAG = "SPIREWBT" + time.strftime("%H%M%S")
USER_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
USER_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
GHOST = "ffffffff-ffff-4fff-8fff-ffffffffffff"
RES_REUSE = "aaaaaaaa-5001-4000-8000-000000000001"
ERR_RES = "aaaaaaaa-5002-4000-8000-000000000002"

TASK = "learning_resource_generation_tasks"
created_ids = []          # hex ids created via the HTTP API
seeded_ids = []           # hex ids seeded directly
seeded_res_ids = []       # generated_learning_resources ids


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


def hexid(u):
    if isinstance(u, uuid.UUID):
        return u.hex
    return u.replace("-", "")


print("TAG", TAG, "BASE", BASE)
tok_a = make_jwt(USER_A)
tok_b = make_jwt(USER_B)

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


seed_user(USER_A, f"{TAG.lower()}-a@example.com")
seed_user(USER_B, f"{TAG.lower()}-b@example.com")


def seed_task(task_id, user_id, kind, title, status, progress=5, stage="点验播种",
              events=None, request=None, error=None, resource_id=None):
    """Insert a task row directly. Returns the hex id."""
    tid = hexid(task_id)
    uid = hexid(user_id)
    if events is None:
        events = [{"seq": 1, "time": datetime.now().isoformat(), "agent": "SYSTEM",
                   "agentName": "系统流程", "actorType": "system", "eventType": "task_lifecycle",
                   "status": status, "phase": status, "title": "点验播种", "detail": TAG,
                   "snapshot": {"resourceType": kind}}]
    if request is None:
        request = {"topic": title, "customize": False}
    cur.execute(
        f"INSERT INTO {TASK} (id,user_id,resource_type,title,status,progress,stage_message,"
        "events_json,resource_id,request_json,created_at,updated_at) "
        "VALUES (UNHEX(%s),UNHEX(%s),%s,%s,%s,%s,%s,CAST(%s AS JSON),%s,CAST(%s AS JSON),NOW(6),NOW(6))",
        (tid, uid, kind, title[:160], status, progress, stage,
         json.dumps(events, ensure_ascii=False),
         bytes.fromhex(hexid(resource_id)) if resource_id else None,
         json.dumps(request, ensure_ascii=False)),
    )
    seeded_ids.append(tid)
    return tid


def db_row(tid_hex):
    cur.execute(
        f"SELECT status,progress,stage_message,events_json,error_message,resource_id,"
        f"resume_enabled,request_json FROM {TASK} WHERE id=UNHEX(%s)", (tid_hex,))
    return cur.fetchone()


def db_exists(tid_hex):
    cur.execute(f"SELECT 1 FROM {TASK} WHERE id=UNHEX(%s)", (tid_hex,))
    return cur.fetchone() is not None


def ev_keys(ev):
    return set(ev.keys())


CREATE_EV_KEYS = {"seq", "time", "agent", "agentName", "actorType", "eventType",
                  "status", "phase", "title", "detail", "snapshot"}

# ---------------------------------------------------------------- create --

print("\n---- create ----")

# 1) lecture minimal
st, b = req("POST", "/v1/learning-resource-tasks/lecture", tok_a, {"topic": f"{TAG}-lecture"})
ok = st == 202 and isinstance(b, dict)
check("create lecture minimal status", ok, f"{st}")
if ok:
    created_ids.append(hexid(b["id"]))
    check("create lecture title suffix",
          b["title"] == f"{TAG}-lecture · 定制讲义", b.get("title"))
    check("create lecture status tuple",
          b["status"] == "queued" and b["progress"] == 2 and b["stageMessage"] == "等待教研组执行",
          f"{b.get('status')}/{b.get('progress')}/{b.get('stageMessage')}")
    ev = (b.get("events") or [{}])[0]
    check("create lecture seed event",
          len(b.get("events") or []) == 1 and ev.get("seq") == 1 and ev.get("agent") == "SYSTEM"
          and ev.get("agentName") == "系统流程" and ev.get("actorType") == "system"
          and ev.get("eventType") == "task_lifecycle" and ev.get("status") == "queued"
          and ev.get("title") == "任务已创建" and ev.get("detail") == "等待 AI 教研组开始执行"
          and ev.get("snapshot") == {"resourceType": "lecture"} and ev_keys(ev) == CREATE_EV_KEYS,
          str(ev)[:160])
    check("create lecture empty fields",
          b.get("resourceId") is None and b.get("checkpointStage") is None
          and b.get("errorMessage") is None, str({k: b.get(k) for k in ("resourceId", "checkpointStage", "errorMessage")}))
    expect_req = {"topic": f"{TAG}-lecture", "title": None, "learning_goal_id": None,
                  "learner_id": None, "kp_id": None, "form": None, "level": None,
                  "version": None, "quiz_ids": [], "kb_refs": [], "detail_level": "balanced",
                  "question_count": 15, "goal_driven": False, "generation_context": None}
    check("create lecture request dict", b.get("request") == expect_req,
          json.dumps(b.get("request"), ensure_ascii=False)[:200])
    for k in ("createdAt", "updatedAt"):
        try:
            datetime.fromisoformat(b.get(k) or "")
            iso_ok = True
        except Exception:
            iso_ok = False
        check(f"create lecture {k} iso", iso_ok, b.get(k))
    row = db_row(hexid(b["id"]))
    check("create lecture db readback",
          row is not None and row[0] == "queued" and row[1] == 2 and row[2] == "等待教研组执行"
          and row[5] is None and int(row[6]) == 0 and json.loads(row[7])["topic"] == f"{TAG}-lecture",
          str(row and (row[0], row[1], row[6])))

# 2) practice suffix
st, b = req("POST", "/v1/learning-resource-tasks/practice", tok_a, {"topic": f"{TAG}-practice"})
ok = st == 202 and isinstance(b, dict)
check("create practice status", ok, str(st))
if ok:
    created_ids.append(hexid(b["id"]))
    check("create practice title suffix", b["title"] == f"{TAG}-practice · 实操指南", b.get("title"))

# 3) quiz default topic + title
st, b = req("POST", "/v1/learning-resource-tasks/quiz", tok_a, {})
ok = st == 202 and isinstance(b, dict)
check("create quiz defaults status", ok, str(st))
if ok:
    created_ids.append(hexid(b["id"]))
    check("create quiz default title",
          b["title"] == "个性化学习资源 · 分阶测试"
          and (b.get("request") or {}).get("topic") is None, b.get("title"))

# 4) explicit title
st, b = req("POST", "/v1/learning-resource-tasks/lecture", tok_a,
            {"topic": f"{TAG}-t4", "title": f"{TAG}-自定义标题"})
ok = st == 202 and isinstance(b, dict)
check("create explicit title status", ok, str(st))
if ok:
    created_ids.append(hexid(b["id"]))
    check("create explicit title used", b["title"] == f"{TAG}-自定义标题", b.get("title"))

# 5) empty-string title falls back
st, b = req("POST", "/v1/learning-resource-tasks/lecture", tok_a, {"topic": f"{TAG}-t5", "title": ""})
ok = st == 202 and isinstance(b, dict)
check("create empty title status", ok, str(st))
if ok:
    created_ids.append(hexid(b["id"]))
    check("create empty title fallback", b["title"] == f"{TAG}-t5 · 定制讲义", b.get("title"))

# 6) adminGeneration -> resumeEnabled injected + resume_enabled=1
admin_body = {"topic": f"{TAG}-admin", "generation_context": {
    "adminGeneration": True, "domainCode": f"{TAG}-D1", "nodeCode": f"{TAG}-N1"}}
st, b = req("POST", "/v1/learning-resource-tasks/lecture", tok_a, admin_body)
ok = st == 202 and isinstance(b, dict)
admin_task = b if ok else None
check("create admin status", ok, str(st))
if ok:
    created_ids.append(hexid(b["id"]))
    gctx = (b.get("request") or {}).get("generation_context")
    check("create admin resumeEnabled injected",
          isinstance(gctx, dict) and gctx.get("resumeEnabled") is True
          and gctx.get("adminGeneration") is True
          and gctx.get("domainCode") == f"{TAG}-D1"
          and gctx.get("nodeCode") == f"{TAG}-N1",
          json.dumps(gctx, ensure_ascii=False)[:160])
    row = db_row(hexid(b["id"]))
    check("create admin resume_enabled column", row is not None and int(row[6]) == 1,
          str(row and row[6]))

# 7) admin duplicate group -> 409
st, b = req("POST", "/v1/learning-resource-tasks/lecture", tok_a, admin_body)
check("create admin duplicate group 409",
      st == 409 and isinstance(b, dict) and b.get("detail") == "该分组已存在对应资源，同一分组内各资源唯一",
      f"{st} {str(b)[:120]}")

# 8) admin regenerate bypasses 409 + same-name replacement
regen_body = {"topic": f"{TAG}-admin", "generation_context": {
    "adminGeneration": True, "domainCode": f"{TAG}-D1", "nodeCode": f"{TAG}-N1", "regenerate": True}}
st, b = req("POST", "/v1/learning-resource-tasks/lecture", tok_a, regen_body)
ok = st == 202 and isinstance(b, dict)
check("create admin regenerate 202", ok, str(st))
if ok and admin_task:
    created_ids.append(hexid(b["id"]))
    check("create admin regenerate replaced same-name",
          not db_exists(hexid(admin_task["id"])) and db_exists(hexid(b["id"])),
          f"old_gone={not db_exists(hexid(admin_task['id']))}")

# 9) non-admin reuse: resource title wins over computed title
cur.execute("DELETE FROM generated_learning_resources WHERE id=UNHEX(%s)", (hexid(RES_REUSE),))
cur.execute(
    "INSERT INTO generated_learning_resources "
    "(id,user_id,resource_type,title,topic,content_json,sources_json,state_json,"
    "context_json,decision_json,kp_id,form,level,version,quiz_ids_json,kb_refs_json,"
    "is_public,resource_scope,review_status,created_at,updated_at) "
    "VALUES (UNHEX(%s),UNHEX(%s),'lecture',%s,%s,'{}','[]',CAST('{}' AS JSON),"
    "NULL,NULL,NULL,'lecture','basic','1','[]','[]',0,'USER','PUBLISHED',NOW(6),NOW(6))",
    (hexid(RES_REUSE), hexid(USER_A), f"{TAG}-资源原标题", f"{TAG}-reused-topic"),
)
seeded_res_ids.append(hexid(RES_REUSE))
st, b = req("POST", "/v1/learning-resource-tasks/lecture", tok_a, {"topic": f"{TAG}-reused-topic"})
ok = st == 202 and isinstance(b, dict)
check("create reuse status", ok, str(st))
if ok:
    created_ids.append(hexid(b["id"]))
    check("create reuse completed tuple",
          b["status"] == "completed" and b["progress"] == 100 and b["stageMessage"] == "已复用现有资源",
          f"{b.get('status')}/{b.get('progress')}/{b.get('stageMessage')}")
    check("create reuse task titled after resource",
          b["title"] == f"{TAG}-资源原标题", b.get("title"))
    check("create reuse linked resource",
          b.get("resourceId") == str(uuid.UUID(hexid(RES_REUSE))), b.get("resourceId"))
    evs = b.get("events") or []
    ev1 = evs[1] if len(evs) > 1 else {}
    check("create reuse second event",
          len(evs) == 2 and ev1.get("status") == "completed" and ev1.get("title") == "复用已生成资源"
          and ev1.get("detail") == "该知识点已有可用资源，本次任务已关联现有资源"
          and ev1.get("snapshot") == {"resourceType": "lecture",
                                      "resourceId": str(uuid.UUID(hexid(RES_REUSE))),
                                      "reused": True},
          str(ev1)[:180])

# 10) same-name replacement (non-admin)
st1, b1 = req("POST", "/v1/learning-resource-tasks/lecture", tok_a, {"topic": f"{TAG}-repl"})
st2, b2 = req("POST", "/v1/learning-resource-tasks/lecture", tok_a, {"topic": f"{TAG}-repl"})
if st1 == 202 and st2 == 202 and isinstance(b1, dict) and isinstance(b2, dict):
    created_ids.append(hexid(b2["id"]))
    check("create replace same-name",
          not db_exists(hexid(b1["id"])) and db_exists(hexid(b2["id"])),
          f"first={st1} second={st2}")
else:
    check("create replace same-name", False, f"{st1}/{st2}")

# 11) invalid type -> HTTPException detail (not envelope)
st, b = req("POST", "/v1/learning-resource-tasks/ppt", tok_a, {"topic": f"{TAG}-x"})
check("create invalid type 422 detail",
      st == 422 and isinstance(b, dict) and b.get("detail") == "Invalid resource type",
      f"{st} {str(b)[:100]}")

# 12) no token -> 401/403 (envelope itself is Phase-1 territory)
st, b = req("POST", "/v1/learning-resource-tasks/lecture", None, {"topic": f"{TAG}-x"})
check("create no token unauthorized", st in (401, 403), str(st))

# ---------------------------------------------------------------- restart --

print("\n---- restart ----")

tid_failed = seed_task(uuid.uuid4(), USER_A, "lecture", f"{TAG}-failed行", "failed",
                       error="点验失败信息", resource_id=ERR_RES)
st, b = req("POST", f"/v1/learning-resource-tasks/{uuid.UUID(hex=tid_failed)}/restart", tok_a)
ok = st == 200 and isinstance(b, dict)
check("restart failed 200", ok, str(st))
if ok:
    check("restart failed tuple",
          b["status"] == "queued" and b["progress"] == 2 and b["stageMessage"] == "任务已重新启动",
          f"{b.get('status')}/{b.get('progress')}/{b.get('stageMessage')}")
    check("restart failed clears error+resource",
          b.get("errorMessage") is None and b.get("resourceId") is None,
          str({k: b.get(k) for k in ("errorMessage", "resourceId")}))
    evs = b.get("events") or []
    ev = evs[-1] if evs else {}
    check("restart failed appended event",
          len(evs) == 2 and ev.get("seq") == 2 and ev.get("agent") == "SYSTEM"
          and ev.get("status") == "queued" and ev.get("title") == "任务已重新启动"
          and ev.get("detail") == "已从失败/取消状态重新启动生成" and ev.get("snapshot") == {},
          str(ev)[:180])
    row = db_row(tid_failed)
    check("restart failed db readback",
          row is not None and row[0] == "queued" and row[4] is None and row[5] is None
          and len(json.loads(row[3])) == 2,
          str(row and (row[0], row[4], row[5], len(json.loads(row[3])))))

tid_cxl_seed = seed_task(uuid.uuid4(), USER_A, "lecture", f"{TAG}-cancelled行", "cancelled")
st, b = req("POST", f"/v1/learning-resource-tasks/{uuid.UUID(hex=tid_cxl_seed)}/restart", tok_a)
check("restart cancelled 200", st == 200 and isinstance(b, dict) and b.get("status") == "queued",
      f"{st} {str(b and b.get('status'))}")

tid_queued = seed_task(uuid.uuid4(), USER_A, "lecture", f"{TAG}-queued行", "queued")
st, b = req("POST", f"/v1/learning-resource-tasks/{uuid.UUID(hex=tid_queued)}/restart", tok_a)
check("restart queued 409",
      st == 409 and isinstance(b, dict) and b.get("detail") == "任务不存在或当前状态不允许重启",
      f"{st} {str(b)[:100]}")

tid_done = seed_task(uuid.uuid4(), USER_A, "lecture", f"{TAG}-completed行", "completed")
st, b = req("POST", f"/v1/learning-resource-tasks/{uuid.UUID(hex=tid_done)}/restart", tok_a)
check("restart completed 409", st == 409, str(st))

st, b = req("POST", f"/v1/learning-resource-tasks/{GHOST}/restart", tok_a)
check("restart ghost 409", st == 409 and isinstance(b, dict) and b.get("detail") == "任务不存在或当前状态不允许重启",
      f"{st} {str(b)[:100]}")

tid_b_failed = seed_task(uuid.uuid4(), USER_B, "lecture", f"{TAG}-B行", "failed")
st, b = req("POST", f"/v1/learning-resource-tasks/{uuid.UUID(hex=tid_b_failed)}/restart", tok_a)
check("restart cross-owner 409", st == 409, str(st))

# ----------------------------------------------------------------- cancel --

print("\n---- cancel ----")

tid_q2 = seed_task(uuid.uuid4(), USER_A, "lecture", f"{TAG}-待取消", "queued")
st, b = req("POST", f"/v1/learning-resource-tasks/{uuid.UUID(hex=tid_q2)}/cancel", tok_a)
ok = st == 200 and isinstance(b, dict)
check("cancel queued 200", ok, str(st))
if ok:
    check("cancel queued tuple",
          b["status"] == "cancelled" and b["progress"] == 100 and b["stageMessage"] == "任务已取消",
          f"{b.get('status')}/{b.get('progress')}/{b.get('stageMessage')}")
    check("cancel appended no event", len(b.get("events") or []) == 1,
          str(len(b.get("events") or [])))
    row = db_row(tid_q2)
    check("cancel db readback no event",
          row is not None and row[0] == "cancelled" and len(json.loads(row[3])) == 1,
          str(row and (row[0], len(json.loads(row[3])))))
    st2, b2 = req("POST", f"/v1/learning-resource-tasks/{uuid.UUID(hex=tid_q2)}/cancel", tok_a)
    check("cancel twice 404",
          st2 == 404 and isinstance(b2, dict) and b2.get("detail") == "任务不存在或已结束，无需取消",
          f"{st2} {str(b2)[:100]}")

tid_gen = seed_task(uuid.uuid4(), USER_A, "quiz", f"{TAG}-generating行", "generating", progress=40)
st, b = req("POST", f"/v1/learning-resource-tasks/{uuid.UUID(hex=tid_gen)}/cancel", tok_a)
check("cancel generating 200", st == 200 and isinstance(b, dict) and b.get("status") == "cancelled",
      f"{st} {str(b and b.get('status'))}")

st, b = req("POST", f"/v1/learning-resource-tasks/{uuid.UUID(hex=tid_done)}/cancel", tok_a)
check("cancel completed 404",
      st == 404 and isinstance(b, dict) and b.get("detail") == "任务不存在或已结束，无需取消",
      f"{st} {str(b)[:100]}")

st, b = req("POST", f"/v1/learning-resource-tasks/{GHOST}/cancel", tok_a)
check("cancel ghost 404", st == 404, str(st))

tid_b_q = seed_task(uuid.uuid4(), USER_B, "lecture", f"{TAG}-B待取消", "queued")
st, b = req("POST", f"/v1/learning-resource-tasks/{uuid.UUID(hex=tid_b_q)}/cancel", tok_a)
check("cancel cross-owner 404", st == 404, str(st))
# owner can still cancel their own
st, b = req("POST", f"/v1/learning-resource-tasks/{uuid.UUID(hex=tid_b_q)}/cancel", tok_b)
check("cancel by owner 200", st == 200 and isinstance(b, dict) and b.get("status") == "cancelled",
      f"{st}")

# ---------------------------------------------------------------- cleanup --

print("\n---- cleanup ----")
try:
    ids = set(created_ids + seeded_ids)
    if ids:
        cur.execute(
            f"DELETE FROM {TASK} WHERE id IN ({','.join(['UNHEX(%s)'] * len(ids))})",
            list(ids))
        print("  tasks deleted:", cur.rowcount)
    if seeded_res_ids:
        cur.execute(
            "DELETE FROM generated_learning_resources WHERE id IN "
            f"({','.join(['UNHEX(%s)'] * len(seeded_res_ids))})", seeded_res_ids)
        print("  resources deleted:", cur.rowcount)
finally:
    cur.close()
    conn.close()

fails = [r for r in results if r[1] == "FAIL"]
print(f"\n=== TOTAL {len(results) - len(fails)}/{len(results)} | fails={len(fails)} ===")
for name, _, detail in fails:
    print("  FAIL:", name, "|", detail)
sys.exit(1 if fails else 0)
