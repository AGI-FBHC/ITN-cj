"""Isolated live matrix for Spire presentations read-side + learning-resource-tasks.

Seeds SPIREVERIFYPT* rows on two known test users only, exercises the 11 routes,
then cleans those rows up. Real rows are never touched.

Env required: JWT_SECRET, VERIFY_MYSQL_PW, VERIFY_BASE (optional), PPT_OUT (optional).
"""
import os, sys, json, time, hmac, hashlib, base64, urllib.request, urllib.error
import pymysql

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:19355")
JWT_SECRET = os.environ["JWT_SECRET"]
PPT_OUT = os.environ.get("PPT_OUT", "D:/cangjie/zyqprojects/itn_spire/tmp_verify/ppt_out")
DB = dict(
    host=os.environ.get("VERIFY_MYSQL_HOST", "43.160.236.121"),
    port=int(os.environ.get("VERIFY_MYSQL_PORT", "3306")),
    user=os.environ.get("VERIFY_MYSQL_USER", "root"),
    password=os.environ["VERIFY_MYSQL_PW"],
    database=os.environ.get("VERIFY_MYSQL_DB", "itn_cangjie_dev"),
    charset="utf8mb4",
    connect_timeout=15,
)
TAG = "SPIREVERIFYPT" + time.strftime("%H%M%S")
USER_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
USER_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
ORG_1 = "99999999-0001-4000-8000-000000000001"
ORG_2 = "99999999-0002-4000-8000-000000000002"

# ---- presentation fixtures ----
P_OWN = "aaaaaaaa-7001-4000-8000-000000000001"   # A, USER, completed -> A only
P_PUB = "bbbbbbbb-7002-4000-8000-000000000002"   # B, USER, is_public=1 -> shared w/ A
P_PRIV = "bbbbbbbb-7003-4000-8000-000000000003"  # B, USER, private -> hidden from A
P_ORG = "bbbbbbbb-7004-4000-8000-000000000004"   # B, ORGANIZATION org_1 -> visible to A
P_ORG2 = "bbbbbbbb-7005-4000-8000-000000000005"  # B, ORGANIZATION org_2 -> hidden from A
P_ARCH = "aaaaaaaa-7006-4000-8000-000000000006"  # A, archived -> list/get 404, write ok
P_RUN = "aaaaaaaa-7007-4000-8000-000000000007"   # A, running -> delete 409, slides 409
P_FAIL = "aaaaaaaa-7008-4000-8000-000000000008"  # A, failed -> delete ok
P_COURSE = "aaaaaaaa-7009-4000-8000-000000000009"  # A, generationContext.courseId set
P_PROG = "aaaaaaaa-700a-4000-8000-00000000000a"  # A, completed -> progress write-back
P_DL = "aaaaaaaa-700b-4000-8000-00000000000b"    # A, completed -> download/complete
P_B1 = "aaaaaaaa-700c-4000-8000-00000000000c"    # A, batch delete ok
P_B2 = "aaaaaaaa-700d-4000-8000-00000000000d"    # A, batch delete ok
P_BACT = "aaaaaaaa-700e-4000-8000-00000000000e"  # A, running -> batch 409
P_SLIDE = "aaaaaaaa-700f-4000-8000-00000000000f"  # A, completed, outline + disk files
P_NOUT = "aaaaaaaa-7010-4000-8000-000000000010"  # A, completed, no pptx on disk
P_EV = "aaaaaaaa-7011-4000-8000-000000000011"    # A, completed, events + summaries
P_CTX = "aaaaaaaa-7012-4000-8000-000000000012"   # A, generationContext w/o courseId -> request probe
P_MISS = "aaaaaaaa-7013-4000-8000-000000000013"  # A, completed, output_path unresolvable -> download 404 missing

GHOST = "ffffffff-ffff-4fff-8fff-ffffffffffff"

# ---- resource-task fixtures ----
R_OK = "aaaaaaaa-7101-4000-8000-000000000001"   # A, full (events + checkpointStage)
R_SUM = "aaaaaaaa-7102-4000-8000-000000000002"   # A, older -> summary mode probe
R_B = "bbbbbbbb-7103-4000-8000-000000000003"     # B, owner-only 404 for A
R_EV = "aaaaaaaa-7104-4000-8000-000000000004"    # A, events lacking executionSummary


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_jwt(sub: str) -> str:
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64url(json.dumps({"sub": sub, "exp": int(time.time()) + 3600}, separators=(",", ":")).encode())
    msg = f"{header}.{payload}".encode()
    sig = hmac.new(JWT_SECRET.encode(), msg, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(sig)}"


def req(method, path, token=None, body=None, raw=None):
    """Returns (status, body, headers). `raw` (bytes|str) overrides JSON encoding;
    `body=None` with `raw=None` sends no body. Dicts are always returned on
    decode failure so callers can .get() without crashing."""
    url = BASE + path
    if raw is not None:
        data = raw if isinstance(raw, bytes) else raw.encode("utf-8")
    elif body is None:
        data = None
    else:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            rb = resp.read()
            if not rb:
                return resp.status, None, dict(resp.headers)
            try:
                return resp.status, json.loads(rb.decode("utf-8")), dict(resp.headers)
            except Exception:
                return resp.status, {"__raw__": rb.decode("utf-8", "replace")[:400],
                                     "__bytes__": len(rb)}, dict(resp.headers)
    except urllib.error.HTTPError as e:
        rb = e.read()
        try:
            return e.code, json.loads(rb.decode("utf-8")), dict(e.headers)
        except Exception:
            return e.code, {"__raw__": rb.decode("utf-8", "replace")[:400],
                            "__bytes__": len(rb)}, dict(e.headers)
    except Exception as e:
        return None, {"__err__": f"{type(e).__name__}: {e}"}, {}


results = []


def check(name, cond, detail=""):
    results.append((name, "PASS" if cond else "FAIL", detail))
    safe = str(detail).encode("gbk", "replace").decode("gbk", "replace")
    print(f"{'PASS' if cond else 'FAIL':4} | {name} | {safe}")


def uhex(u):
    return u.replace("-", "")


def keys(obj):
    return list(obj.keys()) if isinstance(obj, dict) else None


def detail_of(body):
    return (body or {}).get("detail") if isinstance(body, dict) else None


def item0(body):
    """First pydantic 422 item, or {}.

    Two envelopes are in play: the real agents-service wrapper
    {"code":"VALIDATION_FAILED","details":[...]} and FastAPI's native
    {"detail":[...]}. Accept both so the assertions survive either.
    """
    if not isinstance(body, dict):
        return {}
    for key in ("details", "detail"):
        d = body.get(key)
        if isinstance(d, list) and d and isinstance(d[0], dict):
            return d[0]
    return {}


def hget(hdr, name):
    """Case-insensitive header lookup: urllib's dict(resp.headers) may present
    header keys with different casing than the canonical spelling."""
    if not hdr:
        return None
    if name in hdr:
        return hdr[name]
    low = name.lower()
    for k, v in hdr.items():
        if k.lower() == low:
            return v
    return None


print("TAG", TAG, "BASE", BASE, "PPT_OUT", PPT_OUT)

# ---- disk fixtures for /slides ----
SLIDE_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
OUTLINE = {
    "slides": [
        {"kind": "title", "speakerNotes": "标题页说明",
         "teachingMoments": [{"type": "quiz", "options": ["a", "b", "c", "d"], "answerIndex": 0}]},
        {"kind": "concept", "speakerNotes": "正文讲解内容",
         "teachingMoments": [{"type": "quiz", "title": "T1", "prompt": "P1",
                              "options": ["A1", "B1", "C1", "D1"], "answerIndex": 1}]},
        {"kind": "concept", "speakerNotes": "本节小结讲解内容", "points": [
            {"heading": "K1"}, {"heading": "K2"}, {"heading": "K3"}]},
        {"kind": "conclusion", "speakerNotes": "", "teachingMoments": []},
        {"kind": "concept", "speakerNotes": None, "teachingMoments": []},
    ]
}


def seed_disk():
    root = PPT_OUT.rstrip("/\\")
    d = os.path.join(root, P_SLIDE)
    os.makedirs(os.path.join(d, "slides"), exist_ok=True)
    os.makedirs(os.path.join(d, "audio", "pcm_stretch_v3", "苏打"), exist_ok=True)
    with open(os.path.join(root, P_SLIDE + ".pptx"), "wb") as f:
        f.write(b"PK\x03\x04 fake pptx for verification")
    with open(os.path.join(root, P_NOUT + ".pptx"), "wb") as f:
        f.write(b"PK\x03\x04 fake pptx no outline")
    # P_DL is the download fixture: a real PPTX so GET .../download can return
    # the bytes. P_MISS deliberately has neither its output_path nor its
    # task_id.pptx on disk, so resolvePresentationOutput must fail.
    with open(os.path.join(root, P_DL + ".pptx"), "wb") as f:
        f.write(b"PK\x03\x04 fake pptx downloadable body")
    # slides 1..4 exist; slide 5 deliberately absent
    for i in (1, 2, 3, 4):
        with open(os.path.join(d, "slides", f"slide-{i}.png"), "wb") as f:
            f.write(SLIDE_PNG)
    # index 3 -> slide_003.wav makes audioAvailable true despite empty notes
    with open(os.path.join(d, "audio", "pcm_stretch_v3", "苏打", "slide_003.wav"), "wb") as f:
        f.write(b"RIFF0000WAVEfake")


conn = pymysql.connect(**DB)
conn.autocommit(True)
cur = conn.cursor()
tok_a = make_jwt(USER_A)
tok_b = make_jwt(USER_B)

NOW = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())


def ts(offset_secs):
    t = time.time() + offset_secs
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t)) + ".123456"


def seed_user(uid, email):
    cur.execute(
        "INSERT INTO users (id,email,password_hash,nickname,active,account_type,"
        "created_at,updated_at) VALUES (UNHEX(%s),%s,'x',%s,1,'LEARNER',NOW(6),NOW(6)) "
        "ON DUPLICATE KEY UPDATE nickname=VALUES(nickname), organization_id=NULL",
        (uhex(uid), email, TAG),
    )


def insert_ppt(pid, uid, learned, *, title, status="completed", progress=100,
               is_public=0, scope="USER", org=None, archived=None, request=None,
               outline=None, events=None, output_path="", created=None, updated=None):
    req_j = json.dumps(request if request is not None else {"tag": TAG}, ensure_ascii=False)
    outl = None if outline is None else json.dumps(outline, ensure_ascii=False)
    evs = None if events is None else json.dumps(events, ensure_ascii=False)
    cur.execute(
        "INSERT INTO presentation_tasks(id,user_id,organization_id,resource_scope,"
        "is_public,title,status,progress,stage_message,error_message,request_json,"
        "learned_json,output_path,outline_json,events_json,created_at,updated_at,"
        "archived_at,checkpoint_stage,review_status,is_template,revision,resume_enabled) "
        "VALUES(UNHEX(%s),UNHEX(%s),UNHEX(%s),%s,%s,%s,%s,%s,'stage',NULL,"
        "CAST(%s AS JSON),CAST(%s AS JSON),%s,CAST(%s AS JSON),CAST(%s AS JSON),%s,%s,"
        "%s,'ck','needs_review',0,1,1)",
        (uhex(pid), uhex(uid), (uhex(org) if org else None), scope, is_public,
         f"{TAG} {title}", status, progress, req_j,
         json.dumps(learned, ensure_ascii=False), output_path, outl, evs,
         created or ts(-100), updated or ts(-100), archived),
    )


def insert_ppt_state(pid, uid, learned):
    cur.execute(
        "INSERT INTO presentation_task_user_state(task_id,user_id,learned_json,updated_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),CAST(%s AS JSON),NOW(6)) "
        "ON DUPLICATE KEY UPDATE learned_json=VALUES(learned_json)",
        (uhex(pid), uhex(uid), json.dumps(learned, ensure_ascii=False)),
    )


def insert_res(rid, uid, rtype, *, status="completed", progress=100, stage="stage",
               events=None, resource_id=None, checkpoint=None, error=None,
               request=None, created=None, updated=None, title=None):
    evs = json.dumps(events if events is not None else [], ensure_ascii=False)
    req_j = json.dumps(request if request is not None else {"model_name": "mimo-1"}, ensure_ascii=False)
    cur.execute(
        "INSERT INTO learning_resource_generation_tasks(id,user_id,resource_type,title,"
        "status,progress,stage_message,request_json,events_json,resource_id,"
        "checkpoint_stage,error_message,created_at,updated_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),%s,%s,%s,%s,%s,CAST(%s AS JSON),CAST(%s AS JSON),UNHEX(%s),%s,%s,%s,%s)",
        (uhex(rid), uhex(uid), rtype, f"{TAG} {title or rtype}", status, progress, stage,
         req_j, evs, (uhex(resource_id) if resource_id else None), checkpoint, error,
         created or ts(-200), updated or ts(-200)),
    )


def insert_summary(uid, tid, seq, rev, text):
    cur.execute(
        "INSERT INTO admin_event_summaries(user_id,task_type,task_id,seq,revision,"
        "event_title,event_agent,summary,model,fallback,created_at) "
        "VALUES(UNHEX(%s),'ppt',UNHEX(%s),%s,%s,%s,'sys',%s,'m',0,NOW(6)) "
        "ON DUPLICATE KEY UPDATE summary=VALUES(summary)",
        (uhex(uid), uhex(tid), seq, rev, f"{TAG} ev", text),
    )


def insert_summary_res(uid, tid, seq, rev, text):
    cur.execute(
        "INSERT INTO admin_event_summaries(user_id,task_type,task_id,seq,revision,"
        "event_title,event_agent,summary,model,fallback,created_at) "
        "VALUES(UNHEX(%s),'resource',UNHEX(%s),%s,%s,%s,'sys',%s,'m',0,NOW(6)) "
        "ON DUPLICATE KEY UPDATE summary=VALUES(summary)",
        (uhex(uid), uhex(tid), seq, rev, f"{TAG} ev", text),
    )


try:
    # Kill-safety: a previous run that died before its finally-block leaves
    # admin_event_summaries behind, and the executionSummary outer join keys on
    # (seq, revision) globally — purge this suite's fixed task ids first.
    # NOTE: task_id is BINARY(16): pass UNHEX(%s), never the bare hex string
    # (a string literal silently matches nothing against the binary column).
    cur.execute("DELETE FROM admin_event_summaries WHERE task_id IN "
                "(UNHEX(%s),UNHEX(%s),UNHEX(%s),UNHEX(%s))",
                tuple(uhex(x) for x in [P_EV, R_EV, R_OK, R_B]))
    seed_disk()
    # ---- seed ----
    seed_user(USER_A, f"{TAG.lower()}-a@example.com")
    seed_user(USER_B, f"{TAG.lower()}-b@example.com")
    cur.execute(
        "INSERT INTO organizations(id,code,name,status,created_at,updated_at) "
        "VALUES(UNHEX(%s),%s,%s,1,NOW(6),NOW(6)) ON DUPLICATE KEY UPDATE name=VALUES(name)",
        (uhex(ORG_1), TAG + "-org1", TAG + " 组织一"))
    cur.execute(
        "INSERT INTO organizations(id,code,name,status,created_at,updated_at) "
        "VALUES(UNHEX(%s),%s,%s,1,NOW(6),NOW(6)) ON DUPLICATE KEY UPDATE name=VALUES(name)",
        (uhex(ORG_2), TAG + "-org2", TAG + " 组织二"))
    cur.execute("UPDATE users SET organization_id=UNHEX(%s) WHERE id=UNHEX(%s)",
                (uhex(ORG_1), uhex(USER_A)))
    cur.execute("UPDATE users SET organization_id=UNHEX(%s) WHERE id=UNHEX(%s)",
                (uhex(ORG_1), uhex(USER_B)))

    insert_ppt(P_OWN, USER_A, {"learned": False}, title="own", created=ts(-400))
    insert_ppt(P_PUB, USER_B, {"learned": False}, title="pub",
               is_public=1, created=ts(-390))
    insert_ppt_state(P_PUB, USER_A, {"learned": False, "note": "viewer"})
    insert_ppt(P_PRIV, USER_B, {"learned": True}, title="priv", created=ts(-380))
    insert_ppt(P_ORG, USER_B, {"learned": False}, title="org1", scope="ORGANIZATION",
               org=ORG_1, created=ts(-370))
    insert_ppt_state(P_ORG, USER_A, {"learned": False, "note": "org-viewer"})
    insert_ppt(P_ORG2, USER_B, {"learned": False}, title="org2", scope="ORGANIZATION",
               org=ORG_2, created=ts(-360))
    insert_ppt(P_ARCH, USER_A, {"learned": False}, title="archived",
               archived=ts(-10), created=ts(-350))
    insert_ppt(P_RUN, USER_A, {"learned": False}, title="running", status="running",
               progress=40, created=ts(-340))
    insert_ppt(P_FAIL, USER_A, {"learned": False}, title="failed", status="failed",
               created=ts(-330))
    insert_ppt(P_COURSE, USER_A, {"learned": False}, title="course",
               request={"topicName": f"{TAG} 话题",
                        "generationContext": {"adminGeneration": True,
                                              "topicName": f"{TAG} 话题",
                                              "courseId": "course-fixed-1",
                                              "batchId": "B-1"}},
               created=ts(-320))
    insert_ppt(P_PROG, USER_A, {"learned": False}, title="progress", created=ts(-310))
    # P_DL downloads successfully: output_path points at the seeded file.
    # learned_json deliberately has NO `learned` key so "download must not
    # touch learning state" is observable.
    insert_ppt(P_DL, USER_A, {"mastery": 0.5}, title="download",
               output_path=f"{PPT_OUT.replace(os.sep, '/')}/{P_DL}.pptx",
               created=ts(-300))
    insert_ppt(P_B1, USER_A, {"learned": False}, title="batch1", created=ts(-290))
    insert_ppt(P_B2, USER_A, {"learned": False}, title="batch2", created=ts(-280))
    insert_ppt(P_BACT, USER_A, {"learned": False}, title="batch-act", status="running",
               created=ts(-270))
    insert_ppt(P_SLIDE, USER_A, {"learned": False}, title="slides", outline=OUTLINE,
               output_path=f"{PPT_OUT.replace(os.sep, '/')}/{P_SLIDE}.pptx",
               created=ts(-260))
    insert_ppt(P_NOUT, USER_A, {"learned": False}, title="no-output",
               output_path="/nonexistent/definitely/missing.pptx", created=ts(-250))
    insert_ppt(P_EV, USER_A, {"learned": False}, title="events",
               events=[{"seq": 1, "title": "first"},
                       {"seq": 2, "title": "second", "executionSummary": "keep-me"},
                       {"title": "third"}],
               created=ts(-240))
    # latest_by_task's outer join matches (seq, revision) GLOBALLY — no user/
    # task predicate on the outer side (identical SQL in Python and Spire).
    # revision 99 exists nowhere else in the table, so only our own rows are
    # matched; seqs stay disjoint between P_EV and R_EV for the same reason.
    insert_summary(USER_A, P_EV, 1, 99, f"{TAG} summary-one")
    insert_summary(USER_A, P_EV, 3, 99, f"{TAG} summary-three")
    # P_CTX: generationContext WITHOUT courseId — survives exclude_course=true,
    # so the summary-mode `request` trim (8 management keys) is observable.
    insert_ppt(P_CTX, USER_A, {"learned": False}, title="ctx",
               request={"topicName": f"{TAG} 话题",
                        "generationContext": {"adminGeneration": True,
                                              "topicName": f"{TAG} 话题",
                                              "domainCode": "DC-1", "nodeCode": "NC-1",
                                              "kpId": "KP-1", "groupName": "G-1",
                                              "queueSequence": 7, "batchId": "B-9"}},
               created=ts(-230))
    # P_MISS: output_for returns a non-empty path, but neither that path nor
    # {task_id}.pptx exists on disk -> download 404 "Presentation file is missing".
    insert_ppt(P_MISS, USER_A, {"learned": False}, title="missing-file",
               output_path=f"{PPT_OUT.replace(os.sep, '/')}/no-such-name-{P_MISS}.pptx",
               created=ts(-220))

    insert_res(R_OK, USER_A, "knowledge", title="full",
               request={"model_name": "mimo-1", "generation_context": {"adminGeneration": True}},
               checkpoint="generate", events=[{"seq": 1, "title": "a"}, {"seq": 2, "title": "b"}],
               resource_id="aaaaaaaa-7199-4000-8000-000000000099",
               created=ts(-400), updated=ts(-100))
    insert_res(R_SUM, USER_A, "quiz", title="summary",
               created=ts(-400), updated=ts(-200))
    insert_res(R_B, USER_B, "lecture", title="other", updated=ts(-150))
    insert_res(R_EV, USER_A, "pptx", title="events",
               # seqs must not collide with P_EV's (1, 3): the outer summary
               # join keys on (seq, revision) globally, exactly like Python.
               events=[{"seq": 9, "title": "has"}, {"seq": 2, "title": "no-summary"}],
               created=ts(-400), updated=ts(-90), checkpoint=None)
    insert_summary_res(USER_A, R_EV, 9, 99, f"{TAG} res-summary-1")

    # =====================================================================
    # 1. GET /v1/presentations — visibility, summary, limit, ETag
    # =====================================================================
    st, body, hdr = req("GET", "/v1/presentations", tok_a)
    tasks = (body or {}).get("tasks") or []
    ids = [t.get("id") for t in tasks]
    check("list 200", st == 200, str(st))
    check("list has ETag", bool(hget(hdr, "ETag")), str(hget(hdr, "ETag")))
    check("list ETag prefix ppt", str(hget(hdr, "ETag") or "").startswith('"ppt-'),
          str(hget(hdr, "ETag")))
    check("list sees own", P_OWN in ids, ids)
    check("list sees shared public", P_PUB in ids, ids)
    check("list sees org shared", P_ORG in ids, ids)
    check("list hides private", P_PRIV not in ids, ids)
    check("list hides other org", P_ORG2 not in ids, ids)
    check("list hides archived", P_ARCH not in ids, ids)
    check("list hides course ctx by default? no", P_COURSE in ids, ids)

    own = next((t for t in tasks if t.get("id") == P_OWN), {}) or {}
    check("summary key order", keys(own) == [
        "id", "title", "status", "progress", "stageMessage", "checkpointStage",
        "errorMessage", "downloadUrl", "outputPath", "learned", "learnedMeta",
        "createdAt", "updatedAt"], keys(own))
    check("summary checkpointStage null", own.get("checkpointStage") is None,
          repr(own.get("checkpointStage")))
    check("summary outputPath empty", own.get("outputPath") == "",
          repr(own.get("outputPath")))
    check("summary downloadUrl set", own.get("downloadUrl") ==
          f"/v1/presentations/{P_OWN}/download", repr(own.get("downloadUrl")))
    check("summary no request key (exclude_course false)", "request" not in own, keys(own))
    check("summary no outline/events", "outline" not in own and "events" not in own, keys(own))
    check("summary createdAt naive", "T" in str(own.get("createdAt")) and
          "+" not in str(own.get("createdAt")) and "." in str(own.get("createdAt")),
          repr(own.get("createdAt")))

    # shared viewer learned comes from presentation_task_user_state
    pub = next((t for t in tasks if t.get("id") == P_PUB), {}) or {}
    check("shared learned from state", pub.get("learnedMeta", {}).get("note") == "viewer",
          repr(pub.get("learnedMeta")))

    # default summary=true has no `request` even with generationContext
    st, body2, _ = req("GET", "/v1/presentations?summary=true&exclude_course=true", tok_a)
    ids2 = [t.get("id") for t in (body2 or {}).get("tasks") or []]
    check("exclude_course drops course row", P_COURSE not in ids2, ids2)
    own2 = next((t for t in (body2 or {}).get("tasks") or [] if t.get("id") == P_OWN), {}) or {}
    check("own summary no request (no generationContext)", "request" not in own2, keys(own2))
    ctx2 = next((t for t in (body2 or {}).get("tasks") or [] if t.get("id") == P_CTX), {}) or {}
    check("exclude_course summary has request", "request" in ctx2, keys(ctx2))
    rq = ctx2.get("request") or {}
    gctx = rq.get("generationContext") or {}
    check("request generationContext keys", list(gctx.keys()) == [
        "adminGeneration", "topicName", "domainCode", "nodeCode", "kpId",
        "groupName", "queueSequence", "batchId"], list(gctx.keys()))
    check("request outer keys only generationContext", list(rq.keys()) == ["generationContext"],
          list(rq.keys()))

    # limit clamps silently (presentations) — not a 422
    st, body3, _ = req("GET", "/v1/presentations?limit=0", tok_a)
    check("limit=0 clamps to 1 (200)", st == 200 and len((body3 or {}).get("tasks") or []) == 1,
          f"{st} {len((body3 or {}).get('tasks') or [])}")
    st, body3b, _ = req("GET", "/v1/presentations?limit=1000", tok_a)
    check("limit=1000 ok", st == 200, str(st))
    st, body4, _ = req("GET", "/v1/presentations?limit=abc", tok_a)
    it = item0(body4)
    check("limit=abc 422 int_parsing", st == 422 and it.get("type") == "int_parsing"
          and it.get("loc") == ["query", "limit"], f"{st} {it}")
    st, body5, _ = req("GET", "/v1/presentations?summary=2", tok_a)
    it = item0(body5)
    check("summary=2 422 bool_parsing", st == 422 and it.get("type") == "bool_parsing"
          and it.get("loc") == ["query", "summary"], f"{st} {it}")

    # ETag / 304
    et = hget(hdr, "ETag")
    st, body6, hdr6 = req("GET", "/v1/presentations", tok_a)
    check("etag stable across calls", hget(hdr6, "ETag") == et,
          f"{et} vs {hget(hdr6, 'ETag')}")
    r = urllib.request.Request(BASE + "/v1/presentations", method="GET")
    r.add_header("Content-Type", "application/json")
    r.add_header("Authorization", f"Bearer {tok_a}")
    r.add_header("If-None-Match", et or "")
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            st304, raw304, h304 = resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        st304, raw304, h304 = e.code, e.read(), dict(e.headers)
    except Exception as e:
        st304, raw304, h304 = None, b"", {}
    check("If-None-Match -> 304", st304 == 304 and len(raw304) == 0
          and hget(h304, "ETag") == et, f"{st304} {len(raw304)} {hget(h304, 'ETag')}")

    # =====================================================================
    # 2. GET /v1/presentations/{task_id} — full + executionSummary enrich
    # =====================================================================
    st, body, _ = req("GET", f"/v1/presentations/{P_EV}", tok_a)
    check("get 200", st == 200, str(st))
    check("full key order", keys(body) == [
        "id", "title", "status", "progress", "stageMessage", "checkpointStage",
        "errorMessage", "downloadUrl", "outputPath", "learned", "learnedMeta",
        "createdAt", "updatedAt", "request", "outline", "events"], keys(body))
    evs = body.get("events") or []
    check("event1 gains executionSummary", evs[0].get("executionSummary") == f"{TAG} summary-one",
          repr(evs[0] if evs else None))
    check("event2 keeps own summary", evs[1].get("executionSummary") == "keep-me",
          repr(evs[1] if len(evs) > 1 else None))
    check("event3 gains summary (seq falls back to index+1)",
          evs[2].get("executionSummary") == f"{TAG} summary-three", repr(evs[2] if len(evs) > 2 else None))
    check("full has request camelCase", "request" in body and isinstance(body.get("request"), dict),
          keys(body))
    # outline_json is SQL NULL for P_EV: Python puts the key with an explicit null
    check("full outline is null", "outline" in (keys(body) or [])
          and body.get("outline") is None, repr(body.get("outline")))

    st, body, _ = req("GET", f"/v1/presentations/{GHOST}", tok_a)
    check("get missing 404", st == 404 and detail_of(body) == "Presentation task not found",
          f"{st} {detail_of(body)}")
    st, body, _ = req("GET", f"/v1/presentations/{P_PRIV}", tok_a)
    check("get other private 404", st == 404 and detail_of(body) == "Presentation task not found",
          f"{st} {detail_of(body)}")
    st, body, _ = req("GET", f"/v1/presentations/{P_ARCH}", tok_a)
    check("get archived 404", st == 404, str(st))
    st, body, _ = req("GET", f"/v1/presentations/{P_PUB}", tok_a)
    check("get shared public 200", st == 200 and (body or {}).get("id") == P_PUB, str(st))
    check("get shared learned from state",
          (body or {}).get("learnedMeta", {}).get("note") == "viewer", repr((body or {}).get("learnedMeta")))

    # path UUID 422 grammar
    st, body, _ = req("GET", "/v1/presentations/not-a-uuid", tok_a)
    it = item0(body)
    check("uuid bad char 422", st == 422 and it.get("type") == "uuid_parsing"
          and it.get("loc") == ["path", "task_id"]
          and it.get("msg", "").startswith("Input should be a valid UUID, invalid character")
          and it.get("ctx", {}).get("error", "").startswith("invalid character"),
          f"{st} {it}")
    st, body, _ = req("GET", "/v1/presentations/0000000000000000000000000000000", tok_a)
    it = item0(body)
    check("uuid short 31 hex 422", st == 422 and "invalid length: expected length 32" in
          it.get("msg", ""), f"{st} {it.get('msg')}")
    st, body, _ = req("GET", "/v1/presentations/00000000000000000000000000000000", tok_a)
    check("uuid 32 hex no dashes accepted (404 not 422)", st == 404, str(st))
    st, body, _ = req("GET", f"/v1/presentations/{GHOST[:8]}-1234", tok_a)
    it = item0(body)
    check("uuid group count 422", st == 422 and "invalid group count: expected 5" in
          it.get("msg", ""), f"{st} {it.get('msg')}")
    st, body, _ = req("GET", f"/v1/presentations/{GHOST[:13]}1234-1234-1234-123456789012",
                      tok_a)
    it = item0(body)
    check("uuid group length 422", st == 422 and "invalid group length in group" in
          it.get("msg", ""), f"{st} {it.get('msg')}")

    # =====================================================================
    # 3. GET .../download + POST .../complete
    #
    # P0 2026-10-17 (原负责人拍板): GET .../download returns the PPTX file and
    # must NOT touch learning state. Marking learned stays on POST /complete,
    # fired by the courseware player during study.
    # =====================================================================
    # Snapshot BEFORE the download so "no learning-state mutation" is provable.
    cur.execute("SELECT learned_json, updated_at FROM presentation_tasks WHERE id=UNHEX(%s)",
                (uhex(P_DL),))
    row = cur.fetchone()
    dl_before = (row[0] if row else None, str(row[1]) if row else None)

    st, body, _ = req("GET", f"/v1/presentations/{GHOST}/download", tok_a)
    check("download missing 404 not-ready", st == 404
          and detail_of(body) == "Presentation file is not ready",
          f"{st} {detail_of(body)}")
    # output_for filters status='completed', so a running task is "not ready"
    # — it must NOT behave like complete any more.
    st, body, _ = req("GET", f"/v1/presentations/{P_RUN}/download", tok_a)
    check("download running 404 not-ready (no longer acts like complete)", st == 404
          and detail_of(body) == "Presentation file is not ready",
          f"{st} {detail_of(body)}")
    st, body, _ = req("GET", f"/v1/presentations/{P_MISS}/download", tok_a)
    check("download unresolvable path 404 missing", st == 404
          and detail_of(body) == "Presentation file is missing",
          f"{st} {detail_of(body)}")

    # 200 path — raw request so the PPTX bytes come back unmangled.
    r = urllib.request.Request(BASE + f"/v1/presentations/{P_DL}/download", method="GET")
    r.add_header("Content-Type", "application/json")
    r.add_header("Authorization", f"Bearer {tok_a}")
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            st_dl, dl_bytes, dh = resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        st_dl, dl_bytes, dh = e.code, e.read(), dict(e.headers)
    except Exception:
        st_dl, dl_bytes, dh = None, b"", {}
    check("download 200 pptx magic", st_dl == 200 and (dl_bytes or b"")[:4] == b"PK\x03\x04",
          f"{st_dl} {len(dl_bytes or b'')}")
    check("download body is the seeded pptx",
          dl_bytes == b"PK\x03\x04 fake pptx downloadable body",
          f"{len(dl_bytes or b'')} bytes")
    check("download content-type pptx",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          in str(hget(dh, "Content-Type")), str(hget(dh, "Content-Type")))
    check("download disposition filename",
          hget(dh, "Content-Disposition") == f'attachment; filename="ITN-Presentation-{P_DL}.pptx"',
          str(hget(dh, "Content-Disposition")))

    # THE P0 POINT: download left learning state byte-identical.
    cur.execute("SELECT learned_json, updated_at FROM presentation_tasks WHERE id=UNHEX(%s)",
                (uhex(P_DL),))
    row = cur.fetchone()
    dl_after = (row[0] if row else None, str(row[1]) if row else None)
    check("download did NOT touch learning state", dl_after == dl_before,
          f"{dl_before} -> {dl_after}")
    lj = json.loads(dl_after[0]) if dl_after and dl_after[0] else {}
    check("download left learned/learnedAt unset",
          "learned" not in lj and "learnedAt" not in lj,
          json.dumps(lj, ensure_ascii=False))
    check("download left mastery 0.5", float(lj.get("mastery") or 0) == 0.5,
          json.dumps(lj, ensure_ascii=False))

    st, body, _ = req("POST", f"/v1/presentations/{P_OWN}/complete", tok_a)
    check("complete 200 learned:true", st == 200 and body == {"learned": True}, f"{st} {body}")
    cur.execute("SELECT learned_json FROM presentation_tasks WHERE id=UNHEX(%s)",
                (uhex(P_OWN),))
    row = cur.fetchone()
    lj = json.loads(row[0]) if row and row[0] else {}
    check("complete persisted learned", lj.get("learned") is True, json.dumps(lj))

    # shared VIEWER (A) completes B's public task — only A's state row changes,
    # B's owner row must stay byte-identical (Python mark_learned viewer branch).
    before_pub = None
    cur.execute("SELECT learned_json FROM presentation_tasks WHERE id=UNHEX(%s)", (uhex(P_PUB),))
    row = cur.fetchone()
    before_pub = row[0] if row else None
    st, body, _ = req("POST", f"/v1/presentations/{P_PUB}/complete", tok_a)
    check("shared viewer complete 200", st == 200 and body == {"learned": True}, f"{st} {body}")
    cur.execute("SELECT learned_json FROM presentation_tasks WHERE id=UNHEX(%s)", (uhex(P_PUB),))
    row = cur.fetchone()
    after_pub = row[0] if row else None
    check("shared does not touch owner row", after_pub == before_pub,
          f"{before_pub} -> {after_pub}")
    cur.execute("SELECT learned_json FROM presentation_task_user_state "
                "WHERE task_id=UNHEX(%s) AND user_id=UNHEX(%s)", (uhex(P_PUB), uhex(USER_A)))
    row = cur.fetchone()
    us = json.loads(row[0]) if row and row[0] else {}
    check("shared writes viewer state", us.get("learned") is True, json.dumps(us, ensure_ascii=False))

    # =====================================================================
    # 4. POST .../progress — pydantic lax coercion + 422 shapes
    # =====================================================================
    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a, raw="")
    it = item0(body)
    check("progress empty body missing", st == 422 and it.get("type") == "missing"
          and it.get("msg") == "Field required" and it.get("input") is None
          and it.get("loc") == ["body"], f"{st} {it}")

    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a, body=[1, 2])
    it = item0(body)
    check("progress array body", st == 422 and it.get("type") == "model_attributes_type"
          and it.get("loc") == ["body"], f"{st} {it}")

    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a, body={})
    check("progress {} 200", st == 200 and (body or {}).get("id") == P_PROG, f"{st}")

    # lax coercions that must succeed
    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a,
                      body={"pageIndex": "3", "learned": "on", "mastery": "0.5"})
    check("progress coerced 200", st == 200, f"{st} {body}")
    cur.execute("SELECT learned_json FROM presentation_tasks WHERE id=UNHEX(%s)", (uhex(P_PROG),))
    row = cur.fetchone()
    lj = json.loads(row[0]) if row and row[0] else {}
    check("progress coerced persisted", lj.get("maxPageViewed") == 4
          and lj.get("learned") is True and float(lj.get("mastery") or 0) == 0.5
          and str(lj.get("updatedAt", "")).endswith("+08:00"),
          json.dumps(lj, ensure_ascii=False))

    # mastery never decreases
    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a,
                      body={"mastery": 0.1})
    cur.execute("SELECT learned_json FROM presentation_tasks WHERE id=UNHEX(%s)", (uhex(P_PROG),))
    row = cur.fetchone()
    lj = json.loads(row[0]) if row and row[0] else {}
    check("progress mastery monotonic", float(lj.get("mastery") or 0) == 0.5,
          json.dumps(lj, ensure_ascii=False))

    # page_index monotonic 1-based
    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a,
                      body={"pageIndex": 1})
    cur.execute("SELECT learned_json FROM presentation_tasks WHERE id=UNHEX(%s)", (uhex(P_PROG),))
    row = cur.fetchone()
    lj = json.loads(row[0]) if row and row[0] else {}
    check("progress maxPageViewed monotonic", lj.get("maxPageViewed") == 4,
          json.dumps(lj, ensure_ascii=False))

    # 422 cases
    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a,
                      body={"pageIndex": -1})
    it = item0(body)
    check("pageIndex -1 ge 0", st == 422 and it.get("type") == "greater_than_equal"
          and it.get("loc") == ["body", "pageIndex"] and it.get("ctx") == {"ge": 0}
          and it.get("input") == -1, f"{st} {it}")

    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a,
                      body={"page_index": 0, "pageCount": 0})
    it = item0(body)
    # FastAPI reference (fastapi_ref_presentations.json "pc_zero") reports the
    # AS-GIVEN alias key: ["body","pageCount"], not the declared field name.
    check("page_count 0 ge 1 with alias loc", st == 422
          and it.get("loc") == ["body", "pageCount"] and it.get("ctx") == {"ge": 1},
          f"{st} {it}")

    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a,
                      body={"pageIndex": "abc"})
    it = item0(body)
    check("pageIndex abc int_parsing", st == 422 and it.get("type") == "int_parsing"
          and it.get("input") == "abc" and it.get("loc") == ["body", "pageIndex"],
          f"{st} {it}")

    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a,
                      body={"pageIndex": 1.5})
    it = item0(body)
    check("pageIndex 1.5 int_from_float", st == 422 and it.get("type") == "int_from_float"
          and it.get("input") == 1.5, f"{st} {it}")

    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a,
                      body={"pageIndex": [1]})
    it = item0(body)
    check("pageIndex [1] int_type", st == 422 and it.get("type") == "int_type", f"{st} {it}")

    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a,
                      body={"mastery": 1.5})
    it = item0(body)
    check("mastery 1.5 le 1.0 float ctx", st == 422 and it.get("type") == "less_than_equal"
          and it.get("ctx") == {"le": 1.0} and it.get("input") == 1.5, f"{st} {it}")

    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a,
                      body={"mastery": -0.1})
    it = item0(body)
    check("mastery -0.1 ge 0.0 float ctx", st == 422 and it.get("type") == "greater_than_equal"
          and it.get("ctx") == {"ge": 0.0}, f"{st} {it}")

    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a,
                      body={"learned": 2})
    it = item0(body)
    check("learned 2 bool_parsing", st == 422 and it.get("type") == "bool_parsing"
          and it.get("loc") == ["body", "learned"], f"{st} {it}")

    st, body, _ = req("POST", f"/v1/presentations/{P_PROG}/progress", tok_a,
                      body={"learned": {}})
    it = item0(body)
    check("learned {} bool_type", st == 422 and it.get("type") == "bool_type", f"{st} {it}")

    st, body, _ = req("POST", f"/v1/presentations/{GHOST}/progress", tok_a, body={})
    check("progress missing task 404", st == 404 and detail_of(body) ==
          "Presentation task not found or not completed", f"{st} {detail_of(body)}")
    st, body, _ = req("POST", f"/v1/presentations/{P_RUN}/progress", tok_a, body={})
    check("progress running 404", st == 404, str(st))

    # =====================================================================
    # 5. DELETE /v1/presentations/{task_id}
    # =====================================================================
    st, body, _ = req("DELETE", f"/v1/presentations/{GHOST}", tok_a)
    check("delete missing 404", st == 404 and detail_of(body) == "Presentation task not found",
          f"{st} {detail_of(body)}")
    st, body, _ = req("DELETE", f"/v1/presentations/{P_PUB}", tok_a)
    check("delete shared non-owner 404", st == 404, str(st))
    st, body, _ = req("DELETE", f"/v1/presentations/{P_ARCH}", tok_a)
    check("delete archived 404 (getRaw filters)", st == 404, str(st))
    st, body, _ = req("DELETE", f"/v1/presentations/{P_RUN}", tok_a)
    check("delete running 409", st == 409 and detail_of(body) ==
          "Presentation generation is still in progress", f"{st} {detail_of(body)}")
    cur.execute("SELECT COUNT(*) FROM presentation_tasks WHERE id=UNHEX(%s)", (uhex(P_RUN),))
    check("delete running kept", cur.fetchone()[0] == 1)

    st, body, hdr = req("DELETE", f"/v1/presentations/{P_FAIL}", tok_a)
    check("delete failed 204 empty", st == 204 and body is None, f"{st} {body!r}")
    cur.execute("SELECT COUNT(*) FROM presentation_tasks WHERE id=UNHEX(%s)", (uhex(P_FAIL),))
    check("delete failed row gone", cur.fetchone()[0] == 0)
    st, body, _ = req("DELETE", f"/v1/presentations/{P_FAIL}", tok_a)
    check("delete again 404", st == 404, str(st))

    # =====================================================================
    # 6. POST /v1/presentations/batch-delete
    # =====================================================================
    st, body, _ = req("POST", "/v1/presentations/batch-delete", tok_a, raw="")
    it = item0(body)
    # 0-byte body never reaches json parsing (same pipeline as progress): the
    # pydantic `missing` shape, not a plain-detail business error.
    check("batch empty body 422 missing", st == 422 and it.get("type") == "missing"
          and it.get("msg") == "Field required" and it.get("input") is None
          and it.get("loc") == ["body"], f"{st} {it}")
    st, body, _ = req("POST", "/v1/presentations/batch-delete", tok_a, body={"taskIds": []})
    check("batch [] 422", st == 422 and detail_of(body) == "taskIds must be a non-empty array",
          f"{st} {detail_of(body)}")
    st, body, _ = req("POST", "/v1/presentations/batch-delete", tok_a, body={"taskIds": None})
    check("batch null -> task_ids fallback 422", st == 422 and detail_of(body) ==
          "taskIds must be a non-empty array", f"{st} {detail_of(body)}")
    st, body, _ = req("POST", "/v1/presentations/batch-delete", tok_a,
                      body={"taskIds": [f"{i:032x}" for i in range(101)]})
    check("batch 101 422", st == 422 and detail_of(body) ==
          "taskIds cannot contain more than 100 items", f"{st} {detail_of(body)}")
    st, body, _ = req("POST", "/v1/presentations/batch-delete", tok_a, body={"taskIds": ["nope"]})
    check("batch bad uuid 422", st == 422 and detail_of(body) == "taskIds contains invalid UUIDs",
          f"{st} {detail_of(body)}")
    st, body, _ = req("POST", "/v1/presentations/batch-delete", tok_a, body={"taskIds": [GHOST]})
    check("batch missing 404 Chinese", st == 404 and detail_of(body) ==
          f"任务不存在或不属于当前用户: {GHOST}", f"{st} {detail_of(body)}")
    st, body, _ = req("POST", "/v1/presentations/batch-delete", tok_a,
                      body={"taskIds": [P_B1, GHOST]})
    check("batch all-or-nothing missing", st == 404 and detail_of(body) ==
          f"任务不存在或不属于当前用户: {GHOST}", f"{st} {detail_of(body)}")
    cur.execute("SELECT COUNT(*) FROM presentation_tasks WHERE id IN (UNHEX(%s),UNHEX(%s))",
                (uhex(P_B1), uhex(GHOST)))
    check("batch all-or-nothing kept P_B1", cur.fetchone()[0] == 1)

    st, body, _ = req("POST", "/v1/presentations/batch-delete", tok_a,
                      body={"taskIds": [P_BACT, P_B2]})
    check("batch active 409 Chinese", st == 409 and detail_of(body) ==
          f"任务仍在进行中，无法删除: {P_BACT}", f"{st} {detail_of(body)}")
    cur.execute("SELECT COUNT(*) FROM presentation_tasks WHERE id IN (UNHEX(%s),UNHEX(%s))",
                (uhex(P_B1), uhex(P_B2)))
    check("batch active kept all", cur.fetchone()[0] == 2)

    st, body, _ = req("POST", "/v1/presentations/batch-delete", tok_a,
                      body={"task_ids": [P_B2, P_B1]})
    ids_echo = (body or {}).get("deleted")
    check("batch alias task_ids ok", st == 200 and (body or {}).get("count") == 2
          and ids_echo == [P_B2, P_B1], f"{st} {body}")
    cur.execute("SELECT COUNT(*) FROM presentation_tasks WHERE id IN (UNHEX(%s),UNHEX(%s))",
                (uhex(P_B1), uhex(P_B2)))
    check("batch deleted rows", cur.fetchone()[0] == 0)

    # =====================================================================
    # 7. GET /v1/presentations/{task_id}/slides   (data layer only)
    # =====================================================================
    st, body, _ = req("GET", f"/v1/presentations/{GHOST}/slides", tok_a)
    check("slides missing 404", st == 404 and detail_of(body) == "Presentation task not found",
          f"{st} {detail_of(body)}")
    st, body, _ = req("GET", f"/v1/presentations/{P_RUN}/slides", tok_a)
    check("slides running 409", st == 409 and detail_of(body) == "Presentation is not completed yet",
          f"{st} {detail_of(body)}")
    # seed_disk writes {P_NOUT}.pptx, so resolve succeeds via the task_id
    # fallback; outline is NULL and no slide dir exists -> n=0 payload
    # (Python get_slideshow_slides returns 200 with empty arrays in this state).
    st, body, _ = req("GET", f"/v1/presentations/{P_NOUT}/slides", tok_a)
    check("slides no outline 200 slideCount 0", st == 200
          and (body or {}).get("slideCount") == 0
          and (body or {}).get("speakerNotes") == []
          and (body or {}).get("teachingMoments") == []
          and (body or {}).get("audioAvailable") == [],
          f"{st} {body}")

    st, body, _ = req("GET", f"/v1/presentations/{P_SLIDE}/slides", tok_a)
    check("slides 200", st == 200, f"{st} {body}")
    check("slides key order", keys(body) == ["slideCount", "imageUrl", "audioUrl",
                                             "speakerNotes", "teachingMoments",
                                             "audioAvailable"], keys(body))
    check("slides count 5", (body or {}).get("slideCount") == 5, repr((body or {}).get("slideCount")))
    check("slides imageUrl literal {index}",
          (body or {}).get("imageUrl") == f"/v1/presentations/{P_SLIDE}/slides/{{index}}",
          repr((body or {}).get("imageUrl")))
    check("slides audioUrl literal {index}",
          (body or {}).get("audioUrl") == f"/v1/presentations/{P_SLIDE}/audio/{{index}}",
          repr((body or {}).get("audioUrl")))
    notes = (body or {}).get("speakerNotes") or []
    tm = (body or {}).get("teachingMoments") or []
    aa = (body or {}).get("audioAvailable") or []
    check("speakerNotes[0]", notes[0] == "标题页说明", repr(notes[:1]))
    check("speakerNotes title slide keeps notes", len(notes) == 5 and notes[3] == "",
          repr(notes))
    check("teachingMoments title slide forced []", tm[0] == [], repr(tm[0]))
    check("teachingMoments quiz normalised", isinstance(tm[1], list) and len(tm[1]) == 1
          and tm[1][0].get("type") == "quiz" and tm[1][0].get("momentId")
          and tm[1][0].get("anchorRatio") is not None, repr(tm[1] if len(tm[1]) > 1 else None)[:300])
    check("teachingMoments chapter_end auto summary", isinstance(tm[2], list) and len(tm[2]) >= 1
          and tm[2][0].get("type") == "summary", repr(tm[2] if len(tm[2]) > 1 else None)[:300])
    check("teachingMoments empty note forced []", tm[3] == [], repr(tm[3]))
    check("audioAvailable notes -> true", aa[0] is True and aa[1] is True and aa[2] is True,
          repr(aa))
    check("audioAvailable wav -> true", aa[3] is True, repr(aa))
    check("audioAvailable no wav -> false", aa[4] is False, repr(aa))

    # =====================================================================
    # 8. GET .../slides/{slide_index}
    # =====================================================================
    st, body, _ = req("GET", f"/v1/presentations/{P_SLIDE}/slides/abc", tok_a)
    it = item0(body)
    check("slide_index abc 422 int_parsing", st == 422 and it.get("type") == "int_parsing"
          and it.get("loc") == ["path", "slide_index"], f"{st} {it}")

    r = urllib.request.Request(BASE + f"/v1/presentations/{P_SLIDE}/slides/0", method="GET")
    r.add_header("Content-Type", "application/json")
    r.add_header("Authorization", f"Bearer {tok_a}")
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            st_img, img, ih = resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        st_img, img, ih = e.code, e.read(), dict(e.headers)
    except Exception as e:
        st_img, img, ih = None, b"", {}
    check("slide image 200 png", st_img == 200 and (img or b"")[:8] ==
          b"\x89PNG\r\n\x1a\n", f"{st_img} {len(img or b'')}")
    check("slide image content-type", hget(ih, "Content-Type") == "image/png"
          or "image/png" in str(hget(ih, "Content-Type")), str(hget(ih, "Content-Type")))
    check("slide image disposition",
          hget(ih, "Content-Disposition") == 'attachment; filename="slide_0.png"',
          str(hget(ih, "Content-Disposition")))

    st, body, _ = req("GET", f"/v1/presentations/{P_SLIDE}/slides/-1", tok_a)
    check("slide index -1 404 (not 422)", st == 404 and detail_of(body) == "Slide image not found",
          f"{st} {detail_of(body)}")
    st, body, _ = req("GET", f"/v1/presentations/{P_SLIDE}/slides/5", tok_a)
    check("slide index OOB 404", st == 404 and detail_of(body) == "Slide image not found",
          f"{st} {detail_of(body)}")
    st, body, _ = req("GET", f"/v1/presentations/{P_SLIDE}/slides/4", tok_a)
    check("slide index no png 404", st == 404 and detail_of(body) == "Slide image not found",
          f"{st} {detail_of(body)}")
    st, body, _ = req("GET", f"/v1/presentations/{GHOST}/slides/0", tok_a)
    check("slide missing task 404", st == 404, str(st))
    st, body, _ = req("GET", f"/v1/presentations/{P_NOUT}/slides/0", tok_a)
    # resolve succeeds (task_id fallback), but outline is NULL -> slideCount 0
    # -> bounds 404, mirroring Python's len(outline.slides) check.
    check("slide no outline bounds 404", st == 404 and detail_of(body) == "Slide image not found",
          f"{st} {detail_of(body)}")

    # =====================================================================
    # 9. GET /v1/learning-resource-tasks  (limit policy split, no ETag)
    # =====================================================================
    st, body, hdr = req("GET", "/v1/learning-resource-tasks", tok_a)
    rts = (body or {}).get("tasks") or []
    rids = [t.get("id") for t in rts]
    check("rt list 200", st == 200, str(st))
    check("rt list NO ETag", not hget(hdr, "ETag"), str(hget(hdr, "ETag")))
    check("rt list sees own", R_OK in rids and R_SUM in rids and R_EV in rids, rids)
    check("rt list hides other user", R_B not in rids, rids)
    check("rt default summary=false full", rids.index(R_OK) < rids.index(R_SUM)
          if R_OK in rids and R_SUM in rids else False, rids)
    full = next((t for t in rts if t.get("id") == R_OK), {}) or {}
    check("rt full key order", keys(full) == [
        "id", "resourceType", "title", "status", "progress", "stageMessage", "events",
        "resourceId", "checkpointStage", "errorMessage", "request", "createdAt",
        "updatedAt"], keys(full))
    check("rt full checkpointStage present", full.get("checkpointStage") == "generate",
          repr(full.get("checkpointStage")))
    check("rt full events populated", isinstance(full.get("events"), list)
          and len(full.get("events")) == 2, repr(full.get("events"))[:200])
    check("rt request snake_case", isinstance(full.get("request"), dict)
          and "model_name" in (full.get("request") or {}), repr(full.get("request")))
    check("rt resourceId uuid", full.get("resourceId") == "aaaaaaaa-7199-4000-8000-000000000099",
          repr(full.get("resourceId")))

    st, body, _ = req("GET", "/v1/learning-resource-tasks?summary=true", tok_a)
    rts = (body or {}).get("tasks") or []
    sm = next((t for t in rts if t.get("id") == R_OK), {}) or {}
    check("rt summary key order", keys(sm) == [
        "id", "resourceType", "title", "status", "progress", "stageMessage", "events",
        "resourceId", "errorMessage", "request", "createdAt", "updatedAt"], keys(sm))
    check("rt summary omits checkpointStage", "checkpointStage" not in sm, keys(sm))
    check("rt summary forces events []", sm.get("events") == [], repr(sm.get("events")))
    check("rt summary has request", isinstance(sm.get("request"), dict), keys(sm))

    # limit policy: 422 out of range (opposite of presentations)
    st, body, _ = req("GET", "/v1/learning-resource-tasks?limit=0", tok_a)
    it = item0(body)
    check("rt limit=0 422 ge 1", st == 422 and it.get("type") == "greater_than_equal"
          and it.get("loc") == ["query", "limit"] and it.get("ctx") == {"ge": 1},
          f"{st} {it}")
    st, body, _ = req("GET", "/v1/learning-resource-tasks?limit=1001", tok_a)
    it = item0(body)
    check("rt limit=1001 422 le 1000", st == 422 and it.get("type") == "less_than_equal"
          and it.get("ctx") == {"le": 1000}, f"{st} {it}")
    st, body, _ = req("GET", "/v1/learning-resource-tasks?limit=abc", tok_a)
    it = item0(body)
    check("rt limit=abc 422 int_parsing", st == 422 and it.get("type") == "int_parsing",
          f"{st} {it}")
    st, body, _ = req("GET", "/v1/learning-resource-tasks?limit=1", tok_a)
    check("rt limit=1 200", st == 200 and len((body or {}).get("tasks") or []) == 1,
          f"{st} {len((body or {}).get('tasks') or [])}")

    # =====================================================================
    # 10. GET /v1/learning-resource-tasks/{task_id}
    # =====================================================================
    st, body, _ = req("GET", f"/v1/learning-resource-tasks/{GHOST}", tok_a)
    check("rt get missing 404", st == 404 and detail_of(body) ==
          "Learning resource generation task not found", f"{st} {detail_of(body)}")
    st, body, _ = req("GET", f"/v1/learning-resource-tasks/{R_B}", tok_a)
    check("rt get other user 404", st == 404 and detail_of(body) ==
          "Learning resource generation task not found", f"{st} {detail_of(body)}")
    st, body, _ = req("GET", f"/v1/learning-resource-tasks/{R_B}", tok_b)
    check("rt get owner 200", st == 200 and (body or {}).get("id") == R_B, str(st))

    st, body, _ = req("GET", f"/v1/learning-resource-tasks/{R_EV}", tok_a)
    evs = (body or {}).get("events") or []
    check("rt get enriches executionSummary",
          evs[0].get("executionSummary") == f"{TAG} res-summary-1", repr(evs[0] if evs else None))
    check("rt get event without summary untouched", "executionSummary" not in evs[1]
          if len(evs) > 1 else False, repr(evs[1] if len(evs) > 1 else None))

    # =====================================================================
    # 11. auth on a representative route
    # =====================================================================
    st, body, _ = req("GET", "/v1/presentations")
    check("no token 401", st == 401 and detail_of(body) == "Bearer token required",
          f"{st} {detail_of(body)}")
    st, body, _ = req("GET", "/v1/learning-resource-tasks", "bad.token.here")
    check("bad token 401", st == 401 and detail_of(body) == "Invalid or expired token",
          f"{st} {detail_of(body)}")

finally:
    try:
        cur.execute("DELETE FROM presentation_task_user_state WHERE task_id IN "
                    "(UNHEX(%s),UNHEX(%s),UNHEX(%s),UNHEX(%s),UNHEX(%s),UNHEX(%s),"
                    "UNHEX(%s),UNHEX(%s),UNHEX(%s),UNHEX(%s),UNHEX(%s),UNHEX(%s),"
                    "UNHEX(%s),UNHEX(%s),UNHEX(%s),UNHEX(%s),UNHEX(%s))",
                    tuple(uhex(x) for x in [P_OWN, P_PUB, P_PRIV, P_ORG, P_ORG2, P_ARCH,
                                            P_RUN, P_FAIL, P_COURSE, P_PROG, P_DL, P_B1,
                                            P_B2, P_BACT, P_SLIDE, P_NOUT, P_EV]))
        cur.execute("DELETE FROM admin_event_summaries WHERE task_id IN "
                    "(UNHEX(%s),UNHEX(%s),UNHEX(%s),UNHEX(%s))",
                    tuple(uhex(x) for x in [P_EV, R_EV, R_OK, R_B]))
        cur.execute("DELETE FROM presentation_tasks WHERE title LIKE %s", (TAG + "%",))
        cur.execute("DELETE FROM learning_resource_generation_tasks WHERE title LIKE %s",
                    (TAG + "%",))
        cur.execute("UPDATE users SET organization_id=NULL WHERE nickname=%s", (TAG,))
        cur.execute("DELETE FROM organizations WHERE name LIKE %s", (TAG + "%",))
        cur.execute("DELETE FROM users WHERE nickname=%s", (TAG,))
        conn.commit()
        print("cleanup done")
    except Exception as e:
        print("cleanup error", e)
        conn.rollback()
    conn.close()

passed = sum(1 for _, s, _ in results if s == "PASS")
failed = sum(1 for _, s, _ in results if s == "FAIL")
print(f"\n=== {passed}/{passed + failed} passed ===")
if failed:
    for name, s, detail in results:
        if s == "FAIL":
            safe = str(detail).encode("gbk", "replace").decode("gbk", "replace")
            print(f"  FAIL {name} :: {safe}")
    sys.exit(1)
