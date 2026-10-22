"""Batch B — 「我的学习」browser UI 点验 orchestrator.

Seeds isolated UISTUDY* rows (user is the shared test user 1111...aaaa),
points the Vite proxy at Spire 19406, runs tmp_verify/ui_check/ui_study_check.js
(Edge remote-debug + injected JWT), then cleans up DB rows and disk fixtures.

Covered surfaces:
  /me                          -> GET /v1/courses          (useCourseLearning)
  /resources?courseId&chapter  -> GET /v1/learning-resources + quiz POST /answers
  /learn/ppt-preview/{id}      -> GET /v1/presentations/{id} + /slides data layer
  /agents (AgentDock)          -> GET /v1/agent-sessions

Env: JWT_SECRET, VERIFY_MYSQL_PW; optional VERIFY_MYSQL_HOST/PORT/USER/DB,
     VERIFY_BASE (Spire), VITE_PORT.
Only executed results are reported — see MIGRATION_REPORT.md §12.
"""
import os
import sys
import json
import time
import base64
import shutil
import subprocess
import urllib.request
import urllib.error

import pymysql

HERE = os.path.dirname(os.path.abspath(__file__))
UI_DIR = os.path.join(HERE, "ui_check")
FRONT_DIR = r"D:\cangjie\ITN-Beta\src\front"
ENV_LOCAL = os.path.join(FRONT_DIR, ".env.local")
PPT_OUT = os.path.join(HERE, "ppt_out").replace("\\", "/")

BASE = os.environ.get("VERIFY_BASE", "http://127.0.0.1:19406")
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
TAG = "UISTUDY" + time.strftime("%H%M%S")
VITE_PORT = int(os.environ.get("VITE_PORT", "3002"))
# Vite 7 binds localhost which resolves to [::1] here — use the hostname, not 127.0.0.1.
VITE = f"http://localhost:{VITE_PORT}"

USER = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
COURSE = "aaaaaaaa-5101-4000-8000-000000000001"
CHAPTER = "aaaaaaaa-5102-4000-8000-000000000002"
R_QUIZ = "aaaaaaaa-5103-4000-8000-000000000003"
R_LECT = "aaaaaaaa-5104-4000-8000-000000000004"
PPT = "aaaaaaaa-5105-4000-8000-000000000005"
SESS = "aaaaaaaa-5106-4000-8000-000000000006"
SESS_MSG = "aaaaaaaa-5107-4000-8000-000000000007"


def uhex(u):
    return u.replace("-", "")


def now_str(micro=False):
    t = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    return t + (".123456" if micro else "")


def netstat_lines():
    return subprocess.run("netstat -ano", capture_output=True, text=True, shell=True).stdout.splitlines()


def port_listening(port):
    for line in netstat_lines():
        parts = line.split()
        if len(parts) >= 5 and parts[0].startswith("TCP") and f":{port}" in parts[1] \
                and parts[3] == "LISTENING":
            return True
    return False


def port_pid(port):
    for line in netstat_lines():
        parts = line.split()
        if len(parts) >= 5 and parts[0].startswith("TCP") and f":{port}" in parts[1] \
                and parts[3] == "LISTENING":
            return int(parts[4])
    return None


# ---------- disk fixtures for /slides (pptx + slide PNGs) ----------
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
        {"kind": "concept", "speakerNotes": "本节小结讲解内容",
         "points": [{"heading": "K1"}, {"heading": "K2"}, {"heading": "K3"}]},
        {"kind": "conclusion", "speakerNotes": "", "teachingMoments": []},
        {"kind": "concept", "speakerNotes": None, "teachingMoments": []},
    ]
}

QUIZ_CONTENT = {
    "knowledgePoints": [
        {"id": "kp1", "name": f"{TAG} 基础概念"},
        {"id": "kp2", "name": f"{TAG} 综合应用"},
    ],
    "questions": [
        {"id": f"{TAG}-q1", "knowledgePointId": "kp1", "difficulty": "easy",
         "stem": f"{TAG} 第一题 题干", "options": ["甲", "乙"],
         "correctIndex": 0, "explanation": f"{TAG} 解析一", "citations": [1]},
        {"id": f"{TAG}-q2", "knowledgePointId": "kp1", "difficulty": "medium",
         "stem": f"{TAG} 第二题 题干", "options": ["丙", "丁"],
         "correctIndex": 1, "explanation": f"{TAG} 解析二", "citations": [1, 2]},
    ],
}
LECT_CONTENT = {
    "chapters": [{"title": f"{TAG} 第一章", "sections": [
        {"title": f"{TAG} 第一节", "content": "正文一", "citations": [1]}]}],
    "sections": [{"title": f"{TAG} 概述", "content": "概述正文", "citations": [1]}],
    "steps": [], "questions": [],
}
SOURCES = [{"id": 1, "document": f"{TAG} 教材", "url": "https://example.com/1",
            "content": "A" * 80, "similarity": 0.9, "type": "知识库"}]


def seed_disk():
    d = os.path.join(PPT_OUT, PPT)
    os.makedirs(os.path.join(d, "slides"), exist_ok=True)
    with open(os.path.join(PPT_OUT, PPT + ".pptx"), "wb") as f:
        f.write(b"PK\x03\x04 fake pptx for ui verification")
    for i in range(1, 6):
        with open(os.path.join(d, "slides", f"slide-{i}.png"), "wb") as f:
            f.write(SLIDE_PNG)


def clean_disk():
    shutil.rmtree(os.path.join(PPT_OUT, PPT), ignore_errors=True)
    try:
        os.remove(os.path.join(PPT_OUT, PPT + ".pptx"))
    except OSError:
        pass


def seed_db(cur):
    now = now_str()
    now_micro = now_str(True)
    # shared test user (kept after cleanup — other verify suites reuse it)
    cur.execute(
        "INSERT INTO users (id,email,password_hash,nickname,active,account_type,"
        "created_at,updated_at) VALUES (UNHEX(%s),%s,'x',%s,1,'LEARNER',NOW(6),NOW(6)) "
        "ON DUPLICATE KEY UPDATE nickname=VALUES(nickname)",
        (uhex(USER), f"{TAG.lower()}@example.com", TAG),
    )
    # course + chapter (listCourses[0] -> chapters[0] for Resources.load fallback)
    cur.execute(
        "INSERT INTO generated_courses(id,user_id,learner_id,learning_goal_id,"
        "learning_goal_ids_json,title,description,prompt,domain_name,depth,scale,"
        "course_style,resource_types_json,status,progress,stage_message,"
        "current_chapter_id,events_json,error_message,created_at,updated_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),UNHEX(%s),NULL,'[]',%s,%s,%s,%s,'standard','medium',"
        "'none','[\"lecture\",\"quiz\"]','completed',100,'',NULL,'[]',NULL,%s,%s)",
        (uhex(COURSE), uhex(USER), uhex(USER), f"{TAG} 课程", f"{TAG} 描述",
         f"{TAG} prompt", f"{TAG} domain", now_micro, now_micro),
    )
    cur.execute(
        "INSERT INTO generated_course_chapters(id,course_id,chapter_index,title,summary,"
        "objectives_json,sections_json,status,progress,resources_json,created_at,updated_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),%s,%s,%s,'[]','[]','completed',100,%s,%s,%s)",
        (uhex(CHAPTER), uhex(COURSE), 1, f"{TAG} 章一", f"{TAG} 章摘要",
         json.dumps({"lecture": {"id": R_LECT, "status": "completed"},
                     "quiz": {"id": R_QUIZ, "status": "completed"}}, ensure_ascii=False),
         now_micro, now_micro),
    )
    # resources linked to course_id + chapter_id (listLearningResources filter)
    for rid, rtype, title, content in (
        (R_QUIZ, "quiz", f"{TAG} 测验", QUIZ_CONTENT),
        (R_LECT, "lecture", f"{TAG} 讲义", LECT_CONTENT),
    ):
        cur.execute(
            "INSERT INTO generated_learning_resources "
            "(id,user_id,resource_type,title,topic,content_json,sources_json,state_json,"
            "context_json,decision_json,kp_id,form,level,version,quiz_ids_json,kb_refs_json,"
            "is_public,resource_scope,review_status,learner_id,course_id,chapter_id,"
            "created_at,updated_at) "
            "VALUES (UNHEX(%s),UNHEX(%s),%s,%s,%s,CAST(%s AS JSON),CAST(%s AS JSON),CAST(%s AS JSON),"
            "NULL,NULL,%s,'quiz','L1','1','[]','[]',0,'USER','PUBLISHED',UNHEX(%s),UNHEX(%s),UNHEX(%s),"
            "NOW(6),NOW(6))",
            (uhex(rid), uhex(USER), rtype, title, title,
             json.dumps(content, ensure_ascii=False),
             json.dumps(SOURCES, ensure_ascii=False),
             json.dumps({"ability": 0.35, "mastery": {}, "answered": []}, ensure_ascii=False),
             f"{TAG}-kp", uhex(USER), uhex(COURSE), uhex(CHAPTER)),
        )
    # presentation task (completed + outline for /slides; pptx on disk)
    cur.execute(
        "INSERT INTO presentation_tasks(id,user_id,organization_id,resource_scope,"
        "is_public,title,status,progress,stage_message,error_message,request_json,"
        "learned_json,output_path,outline_json,events_json,created_at,updated_at,"
        "archived_at,checkpoint_stage,review_status,is_template,revision,resume_enabled) "
        "VALUES(UNHEX(%s),UNHEX(%s),NULL,'USER',0,%s,'completed',100,'stage',NULL,"
        "CAST(%s AS JSON),CAST(%s AS JSON),'',CAST(%s AS JSON),CAST(%s AS JSON),%s,%s,"
        "NULL,'ck','needs_review',0,1,1)",
        (uhex(PPT), uhex(USER), f"{TAG} 幻灯片",
         json.dumps({"tag": TAG}, ensure_ascii=False),
         json.dumps({"learned": False}, ensure_ascii=False),
         json.dumps(OUTLINE, ensure_ascii=False), json.dumps([], ensure_ascii=False),
         now, now),
    )
    # learners row (agent_sessions.learner_id FK → learners.id)
    cur.execute(
        "INSERT INTO learners (id,user_id,code,name,created_at,updated_at) "
        "VALUES (UNHEX(%s),UNHEX(%s),%s,%s,NOW(6),NOW(6)) "
        "ON DUPLICATE KEY UPDATE name=VALUES(name)",
        (uhex(USER), uhex(USER), f"{TAG}-learner", TAG),
    )
    # agent session (AgentDock select — AgentContext requires learnerId match AND messages.length > 0)
    cur.execute(
        "INSERT INTO agent_sessions(id,user_id,learner_id,session_type,title,status,"
        "created_at,updated_at) VALUES(UNHEX(%s),UNHEX(%s),UNHEX(%s),'agent',%s,'running',%s,%s)",
        (uhex(SESS), uhex(USER), uhex(USER), f"{TAG} 会话", now, now),
    )
    cur.execute(
        "INSERT INTO agent_messages(id,session_id,user_id,agent_id,kind,content,created_at) "
        "VALUES(UNHEX(%s),UNHEX(%s),UNHEX(%s),NULL,'agent',%s,%s)",
        (uhex(SESS_MSG), uhex(SESS), uhex(USER), f"{TAG} 消息", now),
    )
    seed_disk()


def clean_db(cur):
    for sql, args in (
        ("DELETE FROM learning_resource_user_state WHERE resource_id IN (UNHEX(%s),UNHEX(%s))",
         (uhex(R_QUIZ), uhex(R_LECT))),
        ("DELETE FROM generated_learning_resources WHERE id IN (UNHEX(%s),UNHEX(%s))",
         (uhex(R_QUIZ), uhex(R_LECT))),
        ("DELETE FROM generated_course_chapters WHERE id=UNHEX(%s)", (uhex(CHAPTER),)),
        ("DELETE FROM generated_courses WHERE id=UNHEX(%s)", (uhex(COURSE),)),
        ("DELETE FROM presentation_task_user_state WHERE task_id=UNHEX(%s)", (uhex(PPT),)),
        ("DELETE FROM presentation_tasks WHERE id=UNHEX(%s)", (uhex(PPT),)),
        ("DELETE FROM agent_messages WHERE session_id=UNHEX(%s)", (uhex(SESS),)),
        ("DELETE FROM agent_sessions WHERE id=UNHEX(%s)", (uhex(SESS),)),
    ):
        try:
            cur.execute(sql, args)
            print("cleaned", sql.split("WHERE")[0].strip(), cur.rowcount)
        except pymysql.Error as e:
            print("clean-skip", sql.split("WHERE")[0].strip(), type(e).__name__, e)


def write_env_local():
    """Point the Vite /v1 proxy at the live Spire port (Clash TUN-safe)."""
    lines = [
        "# 本地联调：/v1 指向 Spire。",
        "# 注意：Clash TUN 会对它见过的地址回放伪 HTTP（含 127.0.0.1:8100、127.0.0.2:18768），",
        "# 请指向当前 Spire 实际监听、且 netstat 能看到 LISTENING 的端口。",
        f"VITE_AGENT_BASE=http://127.0.0.1:{BASE.rsplit(':', 1)[-1]}",
        "# /api 仍走本机 Spring Boot（若未启动，笔记/错题接口不依赖它）",
        "VITE_API_PROXY_TARGET=http://localhost:8080",
        "",
    ]
    with open(ENV_LOCAL, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("wrote", ENV_LOCAL, "-> VITE_AGENT_BASE=http://127.0.0.1:" + BASE.rsplit(":", 1)[-1])


def probe(url, timeout=8):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, r.read(200).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(200).decode("utf-8", "replace")
    except Exception as e:
        return None, f"ERR {type(e).__name__}: {e}"


def ensure_vite():
    """Vite must be running with the updated .env.local (proxy target 19406)."""
    write_env_local()
    # probe through the proxy: Spire answers 401 with its JSON envelope
    st, body = probe(f"{VITE}/v1/agent-sessions")
    if st == 401 and ("detail" in body or "code" in body):
        print("vite proxy already targets Spire", st, body[:80])
        return None
    if port_listening(VITE_PORT):
        pid = port_pid(VITE_PORT)
        print(f"vite on {VITE_PORT} is stale (probe {st} {body[:80]}) — killing pid {pid}")
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, shell=True)
        time.sleep(1)
    proc = subprocess.Popen(
        ["npm.cmd", "run", "dev"],
        cwd=FRONT_DIR,
        stdout=open(os.path.join(HERE, "vite_dev.log"), "w", encoding="utf-8"),
        stderr=subprocess.STDOUT,
    )
    print("started vite pid", proc.pid)
    for _ in range(60):
        time.sleep(1)
        if port_listening(VITE_PORT):
            break
    else:
        proc.kill()
        raise RuntimeError("vite did not open port %d" % VITE_PORT)
    for _ in range(30):
        st, body = probe(f"{VITE}/v1/agent-sessions")
        if st is not None:
            print("vite proxy probe", st, body[:100])
            if st == 401:
                return proc
        time.sleep(1)
    raise RuntimeError(f"vite proxy not reaching Spire: {st} {body[:120]}")


def main():
    print("TAG", TAG, "BASE", BASE, "VITE", VITE)
    # Spire identity (Clash TUN phantom check): real 401 JSON from the live port
    if not port_listening(int(BASE.rsplit(":", 1)[-1])):
        raise RuntimeError(f"Spire not LISTENING on {BASE}")
    st, body = probe(f"{BASE}/v1/learning-resources")
    print("spire probe", st, body[:120])
    if st != 401:
        raise RuntimeError(f"Spire identity check failed: {st} {body[:120]}")

    conn = pymysql.connect(**DB)
    conn.autocommit(True)
    cur = conn.cursor()
    vite_proc = None
    node_rc = 2
    try:
        seed_db(cur)
        print("seeded course/chapter/resources/ppt/session", COURSE, R_QUIZ, PPT, SESS)
        vite_proc = ensure_vite()
        env = dict(os.environ)
        env.update({
            "JWT_SECRET": JWT_SECRET,
            "VITE_BASE": VITE,
            "UI_TAG": TAG,
            "UI_QUIZ_ID": R_QUIZ,
            "UI_COURSE_ID": COURSE,
            "UI_CHAPTER_ID": CHAPTER,
            "UI_PPT_ID": PPT,
            "UI_SESSION_ID": SESS,
        })
        node_rc = subprocess.run(
            ["node", "ui_study_check.js"], cwd=UI_DIR, env=env
        ).returncode
        print("node exit", node_rc)
    finally:
        try:
            clean_db(cur)
        finally:
            conn.close()
        clean_disk()
        if vite_proc is not None:
            vite_proc.terminate()
    sys.exit(node_rc)


if __name__ == "__main__":
    main()
