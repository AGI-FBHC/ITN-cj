package itn_desktop_core.pi_tools

import std.collection.*
import std.fs.*
import std.random.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.util.*
import itn_desktop_core.pi.safeUtf8

/*
 * 改动草稿：AI 动过的每个文件，在**写之前**先留一份原样。
 *
 * 用户要的是"AI 改了我的文件，我得能看它改了什么、能一键还原"。这里先做最小可用的那一半：
 * 改动照旧落原件，但每一处都可查差异、可整体还原。（pi-studio 那种"写进 worktree、确认后
 * 才落原件"需要一整套影子文件系统 —— 模型同一轮里 write 完再 read 要读到新内容、用户跑构建
 * 要看到新内容 —— 那是另一个 feature。）
 *
 * 存放：drafts 表一行 = 一次改动；备份正文在 <dataDir>/drafts/<id>.bak
 *       （原来不存在的文件没有备份，撤销 = 把它删掉）。
 * 状态：open（可撤销）→ merged（用户确认保留，备份删掉）/ discarded（已还原）。
 */
public class DraftStore {
    private let dataDir: String
    private let sessionId: String
    private let turnId: String

    public init(dataDir: String) {
        this.dataDir = dataDir
        this.sessionId = ""
        this.turnId = ""
    }

    public init(dataDir: String, sessionId: String, turnId: String) {
        this.dataDir = dataDir
        this.sessionId = sessionId
        this.turnId = turnId
    }

    private func bakDir(): String {
        let d = dataDir + "/drafts"
        ensureDir(d)
        return d
    }

    private func bakPath(id: String): String {
        return bakDir() + "/" + id + ".bak"
    }

    /** 写之前留一份原样（before = 旧正文；None = 这个文件原来不存在）。返回草稿 id。 */
    public func record(rel: String, absPath: String, before: ?String, addN: Int64, delN: Int64): String {
        let id = "d" + Random().nextUInt64().toString()
        var existed = false
        match (before) {
            case Some(t) =>
                existed = true
                try {
                    File.writeTo(bakPath(id), t.toArray())
                } catch (e: Exception) {
                    ()
                }
            case None => ()
        }
        DbHub.open(dataDir).run(
            "INSERT INTO drafts (id, session_id, turn_id, rel, abs_path, existed, add_n, del_n, created_at, state) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            va([tv(id), tv(sessionId), tv(turnId), tv(rel), tv(absPath),
                nv(if (existed) { 1 } else { 0 }), nv(addN), nv(delN), tv(DateTime.now().toString()), tv("open")]))
        return id
    }

    /** 这段会话里还没被确认/撤销的改动。 */
    public func listOpen(sessionId: String): ArrayList<JsonObject> {
        let out = ArrayList<JsonObject>()
        for (r in DbHub.open(dataDir).query(
            "SELECT id, turn_id, rel, existed, add_n, del_n, created_at FROM drafts " +
                "WHERE session_id = ? AND state = 'open' ORDER BY rowid",
            va([tv(sessionId)]))) {
            let o = JsonObject()
            o.put("id", JsonString(r.text(0)))
            o.put("turnId", JsonString(r.text(1)))
            o.put("path", JsonString(r.text(2)))
            o.put("created", JsonBool(r.int(3) == 0))
            o.put("add", JsonInt(r.int(4)))
            o.put("del", JsonInt(r.int(5)))
            o.put("at", JsonString(r.text(6)))
            out.add(o)
        }
        return out
    }

    /** 原样 vs 现在。两侧各截 200KB（大文件只给人看个大概）。 */
    public func diffOf(id: String): JsonObject {
        let o = JsonObject()
        o.put("ok", JsonBool(false))
        match (DbHub.open(dataDir).one("SELECT rel, abs_path, existed, state FROM drafts WHERE id = ?", va([tv(id)]))) {
            case Some(r) =>
                let existed = r.int(2) == 1
                o.put("ok", JsonBool(true))
                o.put("path", JsonString(r.text(0)))
                o.put("existed", JsonBool(existed))
                o.put("state", JsonString(r.text(3)))
                o.put("before", JsonString(if (existed) { readCapped(bakPath(id)) } else { "" }))
                o.put("after", JsonString(readCapped(r.text(1))))
            case None => ()
        }
        return o
    }

    /** 确认保留：备份删掉，记录标 merged。 */
    public func merge(id: String): Bool {
        let db = DbHub.open(dataDir)
        if (db.run("UPDATE drafts SET state = 'merged' WHERE id = ? AND state = 'open'", va([tv(id)])) <= 0) {
            return false
        }
        try {
            removeIfExists(bakPath(id))
        } catch (e: Exception) {
            ()
        }
        return true
    }

    /** 还原：原来有就写回原样，原来没有就把文件删掉。 */
    public func discard(id: String): Bool {
        let db = DbHub.open(dataDir)
        var restored = false
        match (db.one("SELECT abs_path, existed FROM drafts WHERE id = ? AND state = 'open'", va([tv(id)]))) {
            case Some(r) =>
                let absPath = r.text(0)
                let existed = r.int(1) == 1
                try {
                    if (existed) {
                        File.writeTo(absPath, File.readFrom(bakPath(id)))
                    } else {
                        removeIfExists(absPath)
                    }
                    restored = true
                } catch (e: Exception) {
                    restored = false
                }
                if (restored) {
                    db.run("UPDATE drafts SET state = 'discarded' WHERE id = ?", va([tv(id)]))
                    try {
                        removeIfExists(bakPath(id))
                    } catch (e: Exception) {
                        ()
                    }
                }
            case None => ()
        }
        return restored
    }

    /** 这段会话里所有未确认的改动一起还原（"全部撤销"）。返回还原了几处。 */
    public func discardAllOf(sessionId: String): Int64 {
        let ids = ArrayList<String>()
        for (r in DbHub.open(dataDir).query(
            "SELECT id FROM drafts WHERE session_id = ? AND state = 'open' ORDER BY rowid", va([tv(sessionId)]))) {
            ids.add(r.text(0))
        }
        var n: Int64 = 0
        for (id in ids) {
            if (discard(id)) {
                n += 1
            }
        }
        return n
    }

    private func readCapped(path: String): String {
        try {
            let bytes = File.readFrom(path)
            let cap: Int64 = 200 * 1024
            let to = if (bytes.size > cap) { cap } else { bytes.size }
            return safeUtf8(bytes, 0, to)
        } catch (e: Exception) {
            return ""
        }
    }
}
