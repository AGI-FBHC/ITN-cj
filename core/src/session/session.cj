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
    /**
     * 从某一轮分叉：新建一段会话，把这一轮**之前**的事件原样复制过去。
     *
     * 与 rewind 的差别是原会话一字不动（Codex 里"从这里开个分支"就是这个意思：
     * 想换个问法重来，又不想丢掉原来那条线）。
     * 名字：在新会话上叫「旧名字（2）」，再开就是（3）（4）…… 谁也不覆盖谁。
     */
    public func branch(sessionId: String, turnId: String): String {
        let from = turnStartEventId(sessionId, turnId)
        let newSid = newId()
        let now = DateTime.now().toString()
        db().run("INSERT OR REPLACE INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)",
            va([tv(newSid), tv(now), tv(now)]))
        if (from > 0) {
            // 逐行复制：payload 是原始 JSON 文本，直接搬过去，不做解析再序列化
            //（解析一遍会把大 payload 重新格式化，既慢又可能改动字符）
            let stmt = "INSERT INTO session_events (session_id, ts, kind, turn_id, payload) " +
                "SELECT ?, ts, kind, turn_id, payload FROM session_events WHERE session_id = ? AND id < ? ORDER BY id"
            db().run(stmt, va([tv(newSid), tv(sessionId), nv(from)]))
        }
        // 起名：旧名字 +（N）。N 取"当前没被占用的最小序号"，所以开第 2、3、4 个分支也各自有名字
        let base = branchBaseTitle(sessionId)
        rename(newSid, branchTitleFor(base))
        return newSid
    }

    /** 分叉的基线名字：优先用当前标题，没有就用第一句提问，再没有就叫"新对话"。 */
    private func branchBaseTitle(sessionId: String): String {
        let t = trimStr(titleOf(sessionId))
        if (t.size > 0) {
            return stripBranchSuffix(t)
        }
        let first = trimStr(firstUserText(sessionId))
        if (first.size > 0) {
            return byteSafePrefix(first, 24)
        }
        return "新对话"
    }

    /**
     * 去掉结尾的「（N）」。
     *
     * 从一个分支再开分支时，基线名字得回到原来的那条线上：
     * 否则「X（2）」会被当成基线，编号叠成「X（2）（2）」（实测过）。
     */
    private func stripBranchSuffix(t: String): String {
        let s = trimStr(t)
        let b = s.toArray()
        if (b.size < 6) {
            return s
        }
        // 「）」= EF BC 89，「（」= EF BC 88
        if (!(b[b.size - 3] == 0xEF && b[b.size - 2] == 0xBC && b[b.size - 1] == 0x89)) {
            return s
        }
        var i: Int64 = b.size - 4
        while (i >= 2) {
            if (b[i] == 0x88 && b[i - 1] == 0xBC && b[i - 2] == 0xEF) {
                let numLen = b.size - 3 - (i + 1)
                if (numLen <= 0 || numLen > 3) {
                    return s
                }
                var ok = true
                var k = i + 1
                while (k < b.size - 3) {
                    if (b[k] < 0x30 || b[k] > 0x39) {
                        ok = false
                    }
                    k += 1
                }
                if (!ok) {
                    return s
                }
                return String.fromUtf8(b[0..(i - 2)])
            }
            i -= 1
        }
        return s
    }

    /** 「基线（N）」：N 从 2 起，取当前没有任何会话占用的最小序号。 */
    private func branchTitleFor(base: String): String {
        let used = HashSet<String>()
        for (s in list()) {
            used.add(trimStr(strOf(s, "title")))
        }
        var n: Int64 = 2
        while (n < 1000) {
            let candidate = base + "（" + n.toString() + "）"
            if (!used.contains(candidate)) {
                return candidate
            }
            n += 1
        }
        return base + "（" + n.toString() + "）"
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

    /**
     * 这段会话的标题已经定了吗（模型起过名，或用户手动改过）。
     *
     * 「第一次提问之后让模型起一次名」靠它守住"只做一次"：用户后来改写了第一条提问、
     * 或者把当前这轮删掉重发，都不会再生成第二个名字。
     */
    /** 这段会话当前定的名字（没定过就是空串）。 */
    public func titleOf(sessionId: String): String {
        return db().getKv("sessions_meta", "title:" + sessionId, "")
    }

    public func titleReady(sessionId: String): Bool {
        if (db().getKv("sessions_meta", "title:" + sessionId, "").size > 0) {
            return true
        }
        return db().getKv("sessions_meta", "titlegen:" + sessionId, "").size > 0
    }

    /**
     * 记下"这个名字已经定下来了"（**只在对上之后才调**）。
     *
     * 一开始是"问之前就记上、失败也不重试"，实测太脆：第一次提问时模型正忙着生成正文，
     * 那次起名请求很可能撞上超时（单模型的本地服务尤其明显），于是这段对话永远只剩
     * 第一句话当标题。现在只在**成功起名**时落这个标记：成功即"只做一次"照旧守住
     * （用户后来改写第一条提问、删掉这轮重发都不会再生成第二个名字）；
     * 失败则留待下一轮补一次（前端每轮最多问一次，见 maybeGenerateTitle）。
     */
    public func markTitleAsked(sessionId: String): Unit {
        db().putKv("sessions_meta", "titlegen:" + sessionId, "1")
    }

    /** 这段会话的第一句用户提问（模型起名、列表兜底标题都用它）。 */
    public func firstUserText(sessionId: String): String {
        var t = ""
        match (db().one("SELECT payload FROM session_events WHERE session_id = ? AND kind = ? ORDER BY id LIMIT 1",
            va([tv(sessionId), tv("user/message")]))) {
            case Some(r) => t = payloadText(r.text(0), "text")
            case None => ()
        }
        return t
    }

    /**
     * 从"现在"分叉：新会话把这段会话的事件**全部**原样复制过去（含最后一轮）。
     *
     * 与 branch 的差别：branch 是"从某一轮之前分"—— 删掉那一轮换个问法；
     * 这个是"整段带走，换条路继续走"，界面 ⋯ 里的「新建分支」用的是它。
     */
    public func branchAll(sessionId: String): String {
        let newSid = newId()
        let now = DateTime.now().toString()
        db().run("INSERT OR REPLACE INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)",
            va([tv(newSid), tv(now), tv(now)]))
        // 逐行复制原始 JSON 文本，不解析再序列化（大 payload 重排既慢又可能改字符）
        let stmt = "INSERT INTO session_events (session_id, ts, kind, turn_id, payload) " +
            "SELECT ?, ts, kind, turn_id, payload FROM session_events WHERE session_id = ? ORDER BY id"
        db().run(stmt, va([tv(newSid), tv(sessionId)]))
        return newSid
    }

    /** 删掉一段会话（它自己的事件与摘要行 + 标题覆盖）。知识库、笔记、错题、产物都不是这段会话的数据，不动。 */
    public func remove(sessionId: String): Unit {
        let ops = ArrayList<DbOp>()
        ops.add(DbOp("DELETE FROM session_events WHERE session_id = ?", va([tv(sessionId)])))
        ops.add(DbOp("DELETE FROM sessions WHERE id = ?", va([tv(sessionId)])))
        db().batch(ops)
        db().delKv("sessions_meta", "title:" + sessionId)
        db().delKv("sessions_meta", "titlegen:" + sessionId)
        db().delKv("sessions_meta", "context:" + sessionId)
        db().delKv("sessions_meta", "state:" + sessionId)
        db().delKv("sessions_meta", "project:" + sessionId)
    }

    /**
     * 会话列表。
     *
     * 形状是"每段会话一行摘要"，但**不能按 sessionId 逐条查** —— 那样 40 段会话要发
     * 150+ 条语句，每条都要 prepare/close，21MB 的库上界面每刷一次列表就卡一下（实测数百毫秒）。
     * 这里改成固定 4 趟：
     *   ① 分组统计（走 ix_session_events(session_id, id)）：条数与最后一条的 id；
     *   ② 每段的第一个 user/message（走 ix_session_events_kind(kind, id)）：标题；
     *   ③ 每段的第一个 turn/start（同一条索引）：类型与知识库；
     *   ④ 每段的最后一条事件（按 rowid 取，20 段会话 20 次主键查找）。
     *   ⑤ sessions_meta 一次读完：改过的标题与项目归属。
     * 注意别把 ②③ 改写成 GROUP BY + MIN 或 id IN (SELECT MAX...)：自研驱动对这些形状没有把握，
     * 实测在 21MB 的真库上直接卡死（这版是回退后重新测过的）。
     */
    public func list(): ArrayList<JsonObject> {
        let out = ArrayList<JsonObject>()
        migrateFromJson()
        let dbh = db()

        let counts = HashMap<String, Int64>()
        let lastIds = HashMap<String, Int64>()
        for (r in dbh.querySql("SELECT session_id, COUNT(*), MAX(id) FROM session_events GROUP BY session_id")) {
            counts[r.text(0)] = r.int(1)
            lastIds[r.text(0)] = r.int(2)
        }
        /* 清单以 sessions 表为准，而不是"有事件的会话"：
           分叉出来的新会话（以及刚开、还没说话的空会话）在里面有行但可能还没有事件 ——
           它们同样要出现在侧栏里，否则用户点了"新建分支"就像什么也没发生（实测反馈）。 */
        let ids = ArrayList<String>()
        let createdAt = HashMap<String, String>()
        for (r in dbh.querySql("SELECT id, created_at FROM sessions ORDER BY updated_at DESC")) {
            let sid = r.text(0)
            ids.add(sid)
            createdAt[sid] = r.text(1)
        }
        for ((sid, _) in counts) {
            if (!createdAt.contains(sid)) {
                ids.add(sid)   // 老数据里可能只有事件、没有 sessions 行
            }
        }
        if (ids.size == 0) {
            return out
        }

        /*
         * 每个会话只要"第一条 user/message"。
         *
         * 不能写成 WHERE kind='user/message' ORDER BY id 之后在内存里去掉重复 ——
         * 那会把**所有**提问的 payload 都从磁盘读出来（实测 20 段的库上这一条就占了
         * 大半个 145ms）。SQLite 有"min/max 配 GROUP BY 时其它列取自那一行"的规矩，
         * 正好拿来只读每段会话的第一条。
         */
        let titles = HashMap<String, String>()
        for (r in dbh.querySql("SELECT session_id, payload FROM session_events WHERE kind = 'user/message' ORDER BY id")) {
            let sid = r.text(0)
            if (titles.contains(sid)) {
                continue
            }
            titles[sid] = payloadText(r.text(1), "text")
        }

        let kinds = HashMap<String, String>()
        let kbs = HashMap<String, String>()
        for (r in dbh.querySql("SELECT session_id, payload FROM session_events WHERE kind = 'turn/start' ORDER BY id")) {
            let sid = r.text(0)
            if (kinds.contains(sid)) {
                continue
            }
            let p = r.text(1)
            kinds[sid] = payloadText(p, "kind")
            kbs[sid] = payloadText(p, "kbId")
        }

        let customTitles = HashMap<String, String>()
        let projectOf = HashMap<String, String>()
        for (r in dbh.querySql("SELECT k, v FROM sessions_meta")) {
            let k = r.text(0)
            let v = r.text(1)
            if (hasPrefix(k, "title:")) {
                customTitles[k.replace("title:", "")] = v
            } else if (hasPrefix(k, "project:")) {
                projectOf[k.replace("project:", "")] = v
            }
        }

        for (sid in ids) {
            let o = JsonObject()
            o.put("sessionId", JsonString(sid))
            o.put("eventCount", JsonInt(counts.get(sid) ?? 0))
            var title = titles.get(sid) ?? ""
            let custom = customTitles.get(sid) ?? ""
            if (custom.size > 0) {
                title = custom
            } else if (title.size > 60) {
                title = byteSafePrefix(title, 60) + "…"
            }
            var lastAt = ""
            var lastType = ""
            match (dbh.one("SELECT ts, kind FROM session_events WHERE id = ?", va([nv(lastIds.get(sid) ?? 0)]))) {
                case Some(r) =>
                    lastAt = r.text(0)
                    lastType = r.text(1)
                case None =>
                    lastAt = createdAt.get(sid) ?? ""
            }
            o.put("title", JsonString(title))
            o.put("lastType", JsonString(lastType))
            o.put("lastAt", JsonString(lastAt))
            o.put("kind", JsonString(kinds.get(sid) ?? ""))
            o.put("kbId", JsonString(kbs.get(sid) ?? ""))
            o.put("projectId", JsonString(projectOf.get(sid) ?? ""))
            out.add(o)
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

/**
 * 把模型给的"名字"清成一行短标题。
 *
 * 模型偶尔会连解释一起吐出来（"标题：X\n因为……"），也会用引号包一层、结尾带句号；
 * 列表那一行只放得下十来个字，所以这里：只取第一行 -> 剥前缀 -> 剥成对引号 -> 去尾标点 ->
 * 砍到 24 字节（中文 8 字）。清不出东西就返回空串，调用方退回"第一句话 + 省略号"。
 */
public func cleanSessionTitle(raw: String): String {
    var t = trimStr(raw)
    if (t.size == 0) {
        return ""
    }
    // 只取第一行
    let b0 = t.toArray()
    var cut = b0.size
    var i = 0
    while (i < b0.size) {
        if (b0[i] == 10 || b0[i] == 13) {
            cut = i
            break
        }
        i = i + 1
    }
    t = trimStr(String.fromUtf8(b0[0..cut]))
    // "标题：X" / "Title: X" 这类前缀
    for (pre in ["标题：", "标题:", "名字：", "名字:", "会话名称：", "会话名称:", "Title:", "title:"]) {
        if (hasPrefix(t, pre)) {
            t = trimStr(String.fromUtf8(t.toArray()[pre.size..t.size]))
        }
    }
    /*
     * 剥"结尾标点"与"成对的引号"，来回过几遍：
     * 模型常给成 "“上下文工程入门”。" 这一种 —— 先看到的是句号，把句号剥掉才看得见成对引号。
     */
    var pass = 0
    while (pass < 4) {
        pass = pass + 1
        // 结尾的标点不要（起名不是造句）
        for (tl in ["。", "，", "！", "？", "、", ".", ",", "!", "?"]) {
            if (t.size > tl.size && hasSuffix(t, tl)) {
                t = trimStr(String.fromUtf8(t.toArray()[0..(t.size - tl.size)]))
            }
        }
        // 成对的引号才剥（单边引号可能真是名字的一部分）；34 = 双引号
        let qb = t.toArray()
        if (qb.size >= 2 && qb[0] == 34 && qb[qb.size - 1] == 34) {
            t = trimStr(String.fromUtf8(qb[1..(qb.size - 1)]))
            continue
        }
        var stripped = false
        for (pair in ["“”", "《》", "「」"]) {
            let open = String.fromUtf8(pair.toArray()[0..3])
            let close = String.fromUtf8(pair.toArray()[3..6])
            if (t.size >= 6 && hasPrefix(t, open) && hasSuffix(t, close)) {
                t = trimStr(String.fromUtf8(t.toArray()[3..(t.size - 3)]))
                stripped = true
                break
            }
        }
        if (!stripped) {
            break
        }
    }
    if (t.size > 24) {
        t = byteSafePrefix(t, 24)
    }
    return t
}
