package itn_desktop_core.session

import std.fs.*
import std.collection.*
import std.time.*
import std.random.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.util.*

/** 一条只追加的会话事件。payload 承载该事件的自由结构。 */
public class SessionEvent {
    public var sessionId: String = ""
    public var kind: String = ""
    public var at: String = ""
    public var turnId: String = ""
    public var payload: JsonObject = JsonObject()

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("sessionId", JsonString(sessionId))
        o.put("type", JsonString(kind))
        o.put("at", JsonString(at))
        o.put("turnId", JsonString(turnId))
        o.put("payload", payload)
        return o
    }
}

/*
 * 会话仓库。
 *
 * 每条事件一行，只插入不更新，与原来的 JSONL 语义一致；区别是列表和摘要不再需要
 * 把每个会话的整个文件读进来解析一遍。
 */
public class SessionStore {
    public let dataDir: String

    public init(dataDir: String) {
        this.dataDir = dataDir
    }

    private func db(): Db {
        return DbHub.open(dataDir)
    }

    public func newId(): String {
        return "s" + Random().nextUInt64().toString()
    }

    public func newTurnId(): String {
        return "t" + Random().nextUInt64().toString()
    }

    public func append(event: SessionEvent): Unit {
        if (event.at.size == 0) {
            event.at = DateTime.now().toString()
        }
        migrateFromJson()
        let ops = ArrayList<DbOp>()
        ops.add(DbOp("INSERT OR IGNORE INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)",
            va([tv(event.sessionId), tv(event.at), tv(event.at)])))
        ops.add(DbOp("UPDATE sessions SET updated_at = ? WHERE id = ?", va([tv(event.at), tv(event.sessionId)])))
        ops.add(DbOp("INSERT INTO session_events (session_id, ts, kind, turn_id, payload) VALUES (?, ?, ?, ?, ?)",
            va([tv(event.sessionId), tv(event.at), tv(event.kind), tv(event.turnId), tv(event.payload.toString())])))
        db().batch(ops)
    }

    public func events(sessionId: String): ArrayList<JsonObject> {
        return eventsSince(sessionId, 0)
    }

    /**
     * 只取 id 大于 sinceId 的事件。
     *
     * 流式输出时前端每 200ms 拉一次：整段历史重传既费带宽也让浏览器反复解析大 JSON，
     * 长会话里这正是"打字机"发卡的主因。带上游标只回增量，顺便把每条事件的 id 回给前端，
     * 下一次接着从它开始拉。
     */
    public func eventsSince(sessionId: String, sinceId: Int64): ArrayList<JsonObject> {
        let out = ArrayList<JsonObject>()
        let sql = if (sinceId > 0) {
            "SELECT id, ts, kind, turn_id, payload FROM session_events WHERE session_id = ? AND id > ? ORDER BY id"
        } else {
            "SELECT id, ts, kind, turn_id, payload FROM session_events WHERE session_id = ? ORDER BY id"
        }
        let args = if (sinceId > 0) { va([tv(sessionId), nv(sinceId)]) } else { va([tv(sessionId)]) }
        for (r in db().query(sql, args)) {
            let o = JsonObject()
            o.put("id", JsonInt(r.int(0)))
            o.put("sessionId", JsonString(sessionId))
            o.put("type", JsonString(r.text(2)))
            o.put("at", JsonString(r.text(1)))
            o.put("turnId", JsonString(r.text(3)))
            let payload = r.text(4)
            if (payload.size > 0) {
                try {
                    o.put("payload", JsonValue.fromStr(payload))
                } catch (e: Exception) {
                    o.put("payload", JsonObject())
                }
            } else {
                o.put("payload", JsonObject())
            }
            out.add(o)
        }
        return out
    }

    /** 会话摘要：事件数、最后一条事件的时间与类型、首个用户提问作为标题。 */
    /**
     * 这一轮的第一条事件的 id；没有这一轮就返回 0。
     *
     * rewind / branch 都以它为分界：**从这一轮的第一条开始删（或从这里往后复制）**。
     */
    public func turnStartEventId(sessionId: String, turnId: String): Int64 {
        if (sessionId.size == 0 || turnId.size == 0) {
            return 0
        }
        return db().scalarInt("SELECT MIN(id) FROM session_events WHERE session_id = ? AND turn_id = ?",
            va([tv(sessionId), tv(turnId)]))
    }

    /**
     * 退回到某一轮之前：把那一轮以及它之后的全部事件删掉，返回删掉的条数。
     *
     * 用途是"我上一条说错了，改一下重发"。删除是物理删除（列表与历史都以事件为准），
     * 同时把这段会话的上下文缓存与运行状态清掉 —— 它们描述的是"删掉之前的对话"，
     * 留着会让下一轮把已经不存在的历史发给模型。清掉之后下一轮会按剩下的事件重建。
     */
    public func rewind(sessionId: String, turnId: String): Int64 {
        let from = turnStartEventId(sessionId, turnId)
        if (from <= 0) {
            return 0
        }
        let removed = db().run("DELETE FROM session_events WHERE session_id = ? AND id >= ?",
            va([tv(sessionId), nv(from)]))
        db().delKv("sessions_meta", "context:" + sessionId)
        db().delKv("sessions_meta", "state:" + sessionId)
        return removed
    }

    /**
     * 从某一轮分叉：新建一段会话，把这一轮**之前**的事件原样复制过去。
     *
     * 与 rewind 的差别是原会话一字不动（Codex 里"从这里开个分支"就是这个意思：
     * 想换个问法重来，又不想丢掉原来那条线）。
     */
    public func branch(sessionId: String, turnId: String): String {
        let from = turnStartEventId(sessionId, turnId)
        let newSid = newId()
        let now = DateTime.now().toString()
        db().run("INSERT OR REPLACE INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)",
            va([tv(newSid), tv(now), tv(now)]))
        if (from <= 0) {
            return newSid
        }
        // 逐行复制：payload 是原始 JSON 文本，直接搬过去，不做解析再序列化
        //（解析一遍会把大 payload 重新格式化，既慢又可能改动字符）
        let stmt = "INSERT INTO session_events (session_id, ts, kind, turn_id, payload) " +
            "SELECT ?, ts, kind, turn_id, payload FROM session_events WHERE session_id = ? AND id < ? ORDER BY id"
        db().run(stmt, va([tv(newSid), tv(sessionId), nv(from)]))
        return newSid
    }

    public func summary(sessionId: String): JsonObject {
        let o = JsonObject()
        o.put("sessionId", JsonString(sessionId))
        let count = db().scalarInt("SELECT COUNT(*) FROM session_events WHERE session_id = ?", va([tv(sessionId)]))
        o.put("eventCount", JsonInt(count))
        var title = ""
        var lastType = ""
        var lastAt = ""
        match (db().one("SELECT ts, kind, payload FROM session_events WHERE session_id = ? AND kind = ? ORDER BY id LIMIT 1",
            va([tv(sessionId), tv("user/message")]))) {
            case Some(r) =>
                title = payloadText(r.text(2), "text")
            case None => ()
        }
        match (db().one("SELECT ts, kind FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT 1", va([tv(sessionId)]))) {
            case Some(r) =>
                lastAt = r.text(0)
                lastType = r.text(1)
            case None => ()
        }
        // 改过名的会话用用户给的名字（空 = 没改过，标题仍是首个提问）
        let custom = db().getKv("sessions_meta", "title:" + sessionId, "")
        if (custom.size > 0) {
            title = custom
        } else if (title.size > 60) {
            // 不能直接切字节：中文标题会把某个汉字切成两半，抛 Invalid utf8 让 sessions/list 整体 500。
            // 用 util 的安全截断；60 字节 ≈ 20 个汉字，够看清是哪一段对话，再长由界面按宽度省略。
            title = byteSafePrefix(title, 60) + "…"
        }
        // 这一轮是问答 / 讲义 / 练习，以及它用的是哪个知识库：界面用它给会话列表分类和标注
        var kind = ""
        var kbId = ""
        match (db().one("SELECT payload FROM session_events WHERE session_id = ? AND kind = ? ORDER BY id LIMIT 1",
            va([tv(sessionId), tv("turn/start")]))) {
            case Some(r) =>
                kind = payloadText(r.text(0), "kind")
                kbId = payloadText(r.text(0), "kbId")
            case None => ()
        }
        o.put("title", JsonString(title))
        o.put("lastType", JsonString(lastType))
        o.put("lastAt", JsonString(lastAt))
        o.put("kind", JsonString(kind))
        o.put("kbId", JsonString(kbId))
        // 会话挂在哪个项目下（侧栏按项目分组用；''=未归档）
        o.put("projectId", JsonString(db().getKv("sessions_meta", "project:" + sessionId, "")))
        return o
    }

    /**
     * 给一段会话改个名字（列表里用）。
     *
     * 空名字 = 恢复默认标题（首个提问）；名字截到 60 字节，跟自动标题同一套规矩。
     */
    public func rename(sessionId: String, title: String): Unit {
        let t = trimStr(title)
        if (t.size == 0) {
            db().delKv("sessions_meta", "title:" + sessionId)
            return
        }
        let capped = if (t.size > 60) {
            byteSafePrefix(t, 60) + "…"
        } else {
            t
        }
        db().putKv("sessions_meta", "title:" + sessionId, capped)
    }

    /** 删掉一段会话（它自己的事件与摘要行 + 标题覆盖）。知识库、笔记、错题、产物都不是这段会话的数据，不动。 */
    public func remove(sessionId: String): Unit {
        let ops = ArrayList<DbOp>()
        ops.add(DbOp("DELETE FROM session_events WHERE session_id = ?", va([tv(sessionId)])))
        ops.add(DbOp("DELETE FROM sessions WHERE id = ?", va([tv(sessionId)])))
        db().batch(ops)
        db().delKv("sessions_meta", "title:" + sessionId)
        db().delKv("sessions_meta", "context:" + sessionId)
        db().delKv("sessions_meta", "state:" + sessionId)
        db().delKv("sessions_meta", "project:" + sessionId)
    }

    public func list(): ArrayList<JsonObject> {
        let out = ArrayList<JsonObject>()
        migrateFromJson()
        for (r in db().querySql("SELECT session_id, MAX(id) FROM session_events GROUP BY session_id ORDER BY MAX(id) DESC")) {
            out.add(summary(r.text(0)))
        }
        return out
    }

    private func payloadText(payload: String, key: String): String {
        if (payload.size == 0) {
            return ""
        }
        try {
            match (objOf(JsonValue.fromStr(payload))) {
                case Some(o) => return strOf(o, key)
                case None => ()
            }
        } catch (e: Exception) {
            ()
        }
        return ""
    }

    /** 把老的 sessions 目录下的 jsonl 导进数据库，导完保留副本，只导一次。 */
    private func migrateFromJson(): Unit {
        if (migrationDone(db(), "sessions")) {
            return
        }
        let dir = dataDir + Path.Separator + "sessions"
        if (exists(dir)) {
            let ids = ArrayList<String>()
            try {
                Directory.walk(Path(dir), { fi: FileInfo =>
                    let nm = fi.name
                    if (!fi.isDirectory() && Path(nm).extensionName == "jsonl") {
                        let bytes = nm.toArray()
                        if (bytes.size > 6) {
                            ids.add(String.fromUtf8(bytes[0..(bytes.size - 6)]))
                        }
                    }
                    true
                })
            } catch (e: Exception) {
                ()
            }
            for (id in ids) {
                let raw = readTextOr(dir + Path.Separator + id + ".jsonl", "")
                if (raw.size == 0) {
                    continue
                }
                let rows = ArrayList<ArrayList<DbValue>>()
                for (line in splitLines(raw)) {
                    if (line.size == 0) {
                        continue
                    }
                    let ev = SessionEvent()
                    ev.sessionId = id
                    try {
                        match (objOf(JsonValue.fromStr(line))) {
                            case Some(o) =>
                                ev.kind = strOf(o, "type")
                                ev.at = strOf(o, "at")
                                ev.turnId = strOf(o, "turnId")
                                match (o.get("payload")) {
                                    case Some(p) => ev.payload = objOf(p).getOrThrow()
                                    case None => ()
                                }
                            case None => ()
                        }
                    } catch (e: Exception) {
                        ()
                    }
                    if (ev.kind.size == 0) {
                        continue
                    }
                    rows.add(va([tv(id), tv(ev.at), tv(ev.kind), tv(ev.turnId), tv(ev.payload.toString())]))
                }
                if (rows.size > 0) {
                    db().runMany("INSERT INTO session_events (session_id, ts, kind, turn_id, payload) VALUES (?, ?, ?, ?, ?)", rows)
                    let first = rows[0]
                    let ops = ArrayList<DbOp>()
                    ops.add(DbOp("INSERT OR IGNORE INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)",
                        va([tv(id), first[1], first[1]])))
                    db().batch(ops)
                }
            }
            archiveLegacyDir(dir)
        }
        markMigrationDone(db(), "sessions")
    }
}
