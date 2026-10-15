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
        let out = ArrayList<JsonObject>()
        for (r in db().query("SELECT ts, kind, turn_id, payload FROM session_events WHERE session_id = ? ORDER BY id",
            va([tv(sessionId)]))) {
            let o = JsonObject()
            o.put("sessionId", JsonString(sessionId))
            o.put("type", JsonString(r.text(1)))
            o.put("at", JsonString(r.text(0)))
            o.put("turnId", JsonString(r.text(2)))
            let payload = r.text(3)
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
        // 不能直接切字节：中文标题会把某个汉字切成两半，抛 Invalid utf8 让 sessions/list 整体 500。
        // 用 util 的安全截断；60 字节 ≈ 20 个汉字，够看清是哪一段对话，再长由界面按宽度省略。
        if (title.size > 60) {
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
        return o
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
