package itn_desktop_core.session

import std.fs.*
import std.collection.*
import std.time.*
import std.random.*
import stdx.encoding.json.*
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

/** 会话日志：每个会话一个 JSONL 文件，只追加不修改。 */
public class SessionStore {
    public let dataDir: String

    public init(dataDir: String) {
        this.dataDir = dataDir
    }

    public func dir(): String {
        return dataDir + Path.Separator + "sessions"
    }

    public func path(sessionId: String): String {
        return dir() + Path.Separator + sessionId + ".jsonl"
    }

    public func newId(): String {
        return "s" + Random().nextUInt64().toString()
    }

    public func newTurnId(): String {
        return "t" + Random().nextUInt64().toString()
    }

    public func append(event: SessionEvent): Unit {
        ensureDir(dir())
        if (event.at.size == 0) {
            event.at = DateTime.now().toString()
        }
        let line = event.toJson().toString() + "\n"
        let p = path(event.sessionId)
        writeText(p, readTextOr(p, "") + line)
    }

    public func events(sessionId: String): ArrayList<JsonObject> {
        let out = ArrayList<JsonObject>()
        let raw = readTextOr(path(sessionId), "")
        if (raw.size == 0) {
            return out
        }
        for (line in splitLines(raw)) {
            let t = line
            if (t.size == 0) {
                continue
            }
            try {
                match (objOf(JsonValue.fromStr(t))) {
                    case Some(o) => out.add(o)
                    case None => ()
                }
            } catch (e: Exception) {
                ()
            }
        }
        return out
    }

    /** 从日志推导会话摘要：事件数、最后一条事件的时间与类型、首条用户问题。 */
    public func summary(sessionId: String): JsonObject {
        let evs = events(sessionId)
        let o = JsonObject()
        o.put("sessionId", JsonString(sessionId))
        o.put("eventCount", JsonInt(evs.size))
        var title = ""
        var lastType = ""
        var lastAt = ""
        for (e in evs) {
            let ty = strOf(e, "type")
            lastType = ty
            lastAt = strOf(e, "at")
            if (title.size == 0 && ty == "user/message") {
                match (e.get("payload")) {
                    case Some(pv) =>
                        match (objOf(pv)) {
                            case Some(po) => title = strOf(po, "text")
                            case None => ()
                        }
                    case None => ()
                }
            }
        }
        if (title.size > 40) {
            title = String.fromUtf8(title.toArray()[0..40])
        }
        o.put("title", JsonString(title))
        o.put("lastType", JsonString(lastType))
        o.put("lastAt", JsonString(lastAt))
        return o
    }

    public func list(): ArrayList<JsonObject> {
        let out = ArrayList<JsonObject>()
        ensureDir(dir())
        let ids = ArrayList<String>()
        try {
            Directory.walk(Path(dir()), { fi: FileInfo =>
                let nm = fi.name
                if (!fi.isDirectory() && nm.size > 6) {
                    let ext = Path(nm).extensionName
                    if (ext == "jsonl") {
                        ids.add(String.fromUtf8(nm.toArray()[0..(nm.toArray().size - 6)]))
                    }
                }
                true
            })
        } catch (e: Exception) {
            ()
        }
        for (id in ids) {
            out.add(summary(id))
        }
        return out
    }
}
