package itn_desktop_core.session

import std.fs.*
import std.collection.*
import std.convert.*
import std.time.*
import std.random.*
import std.sync.*
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

/**
 * 会话树索引：id 升序的事件列表 + 父子关系 + 每条事件属于哪一轮。
 *
 * 一次查询建出来，之后"当前分支是哪几条事件""某一轮属于哪条线"都在内存里算。
 */
public class SessionChain {
    public var ids = ArrayList<Int64>()
    public var parent = HashMap<Int64, Int64>()
    public var children = HashMap<Int64, ArrayList<Int64>>()
    public var turnOf = HashMap<Int64, String>()
}

/*
 * 会话仓库。
 *
 * 每条事件一行，只插入不更新，与原来的 JSONL 语义一致；区别是列表和摘要不再需要
 * 把每个会话的整个文件读进来解析一遍。
 */
/*
 * 会话列表的进程内缓存。
 *
 * 为什么必须缓存：仓颉的 sqlite 驱动在涉及全表聚合/连表的语句上极慢（实测 1.8 万条事件的
 * 库，组装一次列表要 1–2 秒，JOIN 版本更夸张到 65 秒）。列表只需要“有变化才重算”：
 * 指纹没变就把上次结果直接返回。多线程 HTTP 下用锁保护；换数据目录时目录名不匹配自然失效。
 */
let sessionListCacheLock = Mutex()
var sessionListCache: ?ArrayList<JsonObject> = None
var sessionListCacheDir: String = ""
var sessionListCacheEpoch: Int64 = -1
// single-flight 与节流标记：流式期间每条 delta 都推纪元，若每个到达的列表请求都各自全量重算，
// 会轮番占住数据库锁把 state/settings/tasks 等轻接口一起拖死（实测并发 3 个列表共 3.68 秒）。
var sessionListLastComputeMs: Int64 = -3000
// >0 表示一次重算已开始（带 3 秒超时自愈：即便重算抛异常也不会永久退回陈旧缓存）
var sessionListComputeStartedMs: Int64 = 0

func resourceMetaField(raw: String): JsonValue {
    if (raw.size == 0) { return JsonNull() }
    try {
        match (JsonValue.fromStr(raw)) {
            case o: JsonObject => return o
            case _ => return JsonNull()
        }
    } catch (e: Exception) {
        return JsonNull()
    }
}

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

    /** 会话的下一轮思考模式；独立于 checkpoint/state，压缩、停止与切分支不覆盖它。 */
    public func reasoningMode(sessionId: String): String {
        if (sessionId.size == 0) { return "default" }
        return db().getKv("sessions_meta", "reasoning:" + sessionId, "default")
    }

    public func setReasoningMode(sessionId: String, mode: String): Unit {
        if (sessionId.size == 0) { throw Exception("缺少 sessionId，无法保存思考模式") }
        if (mode.size == 0) { throw Exception("缺少思考模式 mode") }
        db().putKv("sessions_meta", "reasoning:" + sessionId, mode)
    }

    public func append(event: SessionEvent): Unit {
        if (event.at.size == 0) {
            event.at = DateTime.now().toString()
        }
        migrateFromJson()
        migrateTree()
        // 接在当前末端后面：这就是"树"的全部 —— 事件只追加，分支由 leaf 决定
        var parent = leafOf(event.sessionId)
        // 待分叉（用户点了"从这条开分支"）：这条事件接在分叉点上，原来那条线一字不动
        var branched = false
        let pending = db().getKv("sessions_meta", "split:" + event.sessionId, "")
        if (pending.size > 0) {
            let parsed = try {
                Int64.parse(pending)
            } catch (e: Exception) {
                -1
            }
            if (parsed >= 0) {
                parent = parsed
                branched = true
            }
        }
        let ops = ArrayList<DbOp>()
        ops.add(DbOp("INSERT OR IGNORE INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)",
            va([tv(event.sessionId), tv(event.at), tv(event.at)])))
        ops.add(DbOp("UPDATE sessions SET updated_at = ? WHERE id = ?", va([tv(event.at), tv(event.sessionId)])))
        ops.add(DbOp("INSERT INTO session_events (session_id, ts, kind, turn_id, payload, parent_id) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
            va([tv(event.sessionId), tv(event.at), tv(event.kind), tv(event.turnId), tv(event.payload.toString()),
                nv(parent)])))
        // 追加之后"末端"就是这条新事件（= MAX(id)），显式 leaf 键与待分叉键都可以撤了
        ops.add(DbOp("DELETE FROM sessions_meta WHERE k = ?", va([tv("leaf:" + event.sessionId)])))
        ops.add(DbOp("DELETE FROM sessions_meta WHERE k = ?", va([tv("split:" + event.sessionId)])))
        if (branched) {
            // 真分了叉才打这个标记：之后这段会话的历史都按"当前分支"过滤
            ops.add(DbOp("INSERT OR REPLACE INTO sessions_meta (k, v) VALUES (?, ?)",
                va([tv("tree:" + event.sessionId), tv("1")])))
        }
        db().batch(ops)
    }

    /**
     * 这一段会话的**当前分支**（根 → 末端），别的分支不在这里出现。
     *
     * 事件表里可能留着好几条线（改一条重发、从某轮开分支都只是挪末端），
     * 但"对话"只该看见当前这条 —— 会话树面板负责让你看见并切到别条。
     */
    public func events(sessionId: String): ArrayList<JsonObject> {
        let all = eventsSince(sessionId, 0)
        let ids = branchEventIds(sessionId)
        if (ids.size == 0 || ids.size == all.size) {
            return all
        }
        let keep = HashSet<Int64>()
        for (x in ids) {
            keep.add(x)
        }
        let out = ArrayList<JsonObject>()
        for (e in all) {
            match (e.get("id")) {
                case Some(v) => match (v) {
                    case n: JsonInt => if (keep.contains(n.getValue())) { out.add(e) }
                    case _ => ()
                }
                case None => ()
            }
        }
        return out
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
        // 分过叉的会话：只回**当前分支**上的事件（别的线还在库里，切过去才看得到）。
        // 流式轮询也走这里，所以过滤必须在这一层做，否则增量那半段会把别的分支带回来。
        let onChain = activeChainSet(sessionId)
        for (r in db().query(sql, args)) {
            let id = r.int(0)
            if (onChain.size > 0 && !onChain.contains(id)) {
                continue
            }
            let o = JsonObject()
            o.put("id", JsonInt(id))
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

    /**
     * 这一段的当前分支末端（leaf）的事件 id；0 = 还没有事件。
     *
     * 平时 leaf 就是最后一条事件（追加总是往末端接），所以只在"被显式挪过"时才往
     * sessions_meta 里存 —— 追加之后这个键会被清掉（末端又回到最新那条）。
     */
    public func leafOf(sessionId: String): Int64 {
        let raw = db().getKv("sessions_meta", "leaf:" + sessionId, "")
        if (raw.size > 0) {
            // 解析失败（键被人手改坏过）就退回"最后一条事件"这个默认语义，不要抛
            let parsed = try {
                Int64.parse(raw)
            } catch (e: Exception) {
                -1
            }
            if (parsed >= 0) {
                return parsed
            }
        }
        return db().scalarInt("SELECT MAX(id) FROM session_events WHERE session_id = ?", va([tv(sessionId)]))
    }

    /**
     * 把这段会话切到某条事件（会话树的"切分支"）。
     *
     * 不删任何数据：事件只追加，切分支只是换个末端。上下文缓存与运行状态要清掉 ——
     * 它们描述的是切换之前那条线，留着会让下一轮把不属于当前分支的历史发给模型。
     */
    public func setLeaf(sessionId: String, eventId: Int64): Bool {
        if (sessionId.size == 0 || eventId < 0) {
            return false
        }
        if (eventId > 0) {
            let exists = db().scalarInt("SELECT COUNT(*) FROM session_events WHERE id = ? AND session_id = ?",
                va([nv(eventId), tv(sessionId)]))
            if (exists == 0) {
                return false
            }
        }
        db().putKv("sessions_meta", "leaf:" + sessionId, eventId.toString())
        // 挪过末端就说明这段会话有分支/回退：历史从此按"当前分支"过滤
        db().putKv("sessions_meta", "tree:" + sessionId, "1")
        db().delKv("sessions_meta", "split:" + sessionId)
        db().delKv("sessions_meta", "context:" + sessionId)
        db().delKv("sessions_meta", "state:" + sessionId)
        return true
    }

    /** 某条事件的父事件 id（0 = 根）。 */
    public func parentOf(eventId: Int64): Int64 {
        if (eventId <= 0) {
            return 0
        }
        return db().scalarInt("SELECT parent_id FROM session_events WHERE id = ?", va([nv(eventId)]))
    }

    /**
     * 会话树的索引：一次轻查询（只要 id / parent_id / turn_id）在内存里补成父子关系。
     *
     * 老事件没有 parent_id（NULL 或 0）：按线性回退成"上一条事件" —— 它们本来就在
     * 一条线上，补完之后行为与分叉之前一模一样，只是从此可以分叉了。不能逐个事件去
     * 发 SQL：长会话上那是几十次 prepare/close，界面每拉一次历史就卡一下。
     */
    public func chainIndex(sessionId: String): SessionChain {
        let ci = SessionChain()
        var prev: Int64 = 0
        for (r in db().query("SELECT id, parent_id, turn_id FROM session_events WHERE session_id = ? ORDER BY id",
            va([tv(sessionId)]))) {
            let id = r.int(0)
            var p: Int64 = 0
            if (!r.isNull(1)) {
                p = r.int(1)
            } else if (prev != 0) {
                /* 只有 NULL 才是"加这一列之前的老数据"，按线性回退成上一条（迁移会补齐）。
                   0 是**真正的根** —— 从某一轮开分支长出来的新线，parent 就是 0；
                   把它也当成"老数据"会让整棵树退化成一条线（实测踩过）。 */
                p = prev
            }
            ci.ids.add(id)
            ci.parent[id] = p
            match (ci.children.get(p)) {
                case Some(kids) => kids.add(id)
                case None =>
                    let kids = ArrayList<Int64>()
                    kids.add(id)
                    ci.children[p] = kids
            }
            ci.turnOf[id] = r.text(2)
            prev = id
        }
        return ci
    }

    /** 从某条事件沿 parent 走到根，返回**顺序**的 id 列表（根在前、这条在后）。 */
    public func chainTo(sessionId: String, eventId: Int64): ArrayList<Int64> {
        return chainFromIndex(chainIndex(sessionId), eventId)
    }

    private func chainFromIndex(ci: SessionChain, eventId: Int64): ArrayList<Int64> {
        let rev = ArrayList<Int64>()
        var cur = eventId
        var guard: Int64 = 0
        var going = true
        while (cur > 0 && guard < 200000 && going) {
            match (ci.parent.get(cur)) {
                case Some(p) =>
                    rev.add(cur)
                    cur = p
                case None =>
                    // 末端指向不存在的事件（库被人手改过）：停在这儿，别顺着乱走
                    going = false
            }
            guard += 1
        }
        let out = ArrayList<Int64>()
        var i = rev.size - 1
        while (i >= 0) {
            out.add(rev[i])
            i -= 1
        }
        return out
    }

    /** 当前分支的事件 id（根 → 末端）。分支切换之后就是那条线。 */
    public func branchEventIds(sessionId: String): ArrayList<Int64> {
        return chainFromIndex(chainIndex(sessionId), leafOf(sessionId))
    }

    /** 这段会话分过叉吗。没分过叉的走线性快路径：连索引都不用建。 */
    public func hasTree(sessionId: String): Bool {
        return db().getKv("sessions_meta", "tree:" + sessionId, "").size > 0
    }

    /** 当前分支的事件 id 集合；空集合 = "没分过叉，全都可见"。 */
    public func activeChainSet(sessionId: String): HashSet<Int64> {
        let out = HashSet<Int64>()
        if (!hasTree(sessionId)) {
            return out
        }
        for (id in branchEventIds(sessionId)) {
            out.add(id)
        }
        return out
    }

    /**
     * 从某一轮**之前**开一段会话内分支（pi 的 "edit → 兄弟分支" 语义）。
     *
     * 只是记下"下一条事件接在哪儿"：分叉点 = 这一轮第一条事件的父事件。用户真发出下一条
     * 消息时，append 会把新的一轮接在分叉点上 —— 原来那条线（这一轮及其后续）一字不动地
     * 留在树上，可以用 ‹ n/m › 切回去。用户没发就取消：什么都不变（重要：不能先把末端
     * 挪走，那样界面上这一段会当场消失，用户还找不到切回来的入口）。
     */
    public func split(sessionId: String, turnId: String): Int64 {
        let from = db().scalarInt("SELECT MIN(id) FROM session_events WHERE session_id = ? AND turn_id = ?",
            va([tv(sessionId), tv(turnId)]))
        if (from <= 0) {
            return -1
        }
        let ci = chainIndex(sessionId)
        let p = ci.parent.get(from) ?? 0
        db().putKv("sessions_meta", "split:" + sessionId, p.toString())
        return p
    }

    /** 取消"待分叉"（用户点了开分支又不想发了）。 */
    public func cancelSplit(sessionId: String): Unit {
        db().delKv("sessions_meta", "split:" + sessionId)
    }

    /**
     * 切到某一轮所在的那条分支：末端 = 这一轮的最后一条事件。
     *
     * 不删数据，只是换个末端；上下文缓存与运行状态一起清掉 —— 它们描述的是切换之前那条线，
     * 留着会让下一轮把不属于当前分支的历史发给模型。
     */
    /** Reveal a search hit without truncating the remainder of its branch. */
    public func revealTurn(sessionId: String, turnId: String): Bool {
        let ci = chainIndex(sessionId)
        var target: Int64 = 0
        for (id in ci.ids) { if ((ci.turnOf.get(id) ?? "") == turnId) { target = id } }
        if (target == 0) { return false }
        for (id in chainFromIndex(ci, leafOf(sessionId))) { if (id == target) { return true } }
        let descendants = HashSet<Int64>()
        descendants.add(target)
        var tip = target
        for (id in ci.ids) {
            if (descendants.contains(ci.parent.get(id) ?? 0)) { descendants.add(id); tip = id }
        }
        return setLeaf(sessionId, tip)
    }

    /** Literal text search: streaming deltas are merged, final messages take precedence. */
    public func search(query: String, limitIn: Int64): JsonArray {
        let out = JsonArray()
        let q = trimStr(byteSafePrefix(query, 300)).toAsciiLower()
        if (q.size == 0) { return out }
        let limit = if (limitIn > 0 && limitIn < 50) { limitIn } else { 50 }
        for (s in list()) {
            let sid = strOf(s, "sessionId")
            let title = strOf(s, "title")
            let texts = HashMap<String, String>()
            let turns = HashMap<String, String>()
            let roles = HashMap<String, String>()
            let times = HashMap<String, String>()
            let order = ArrayList<String>()
            for (r in db().query("SELECT turn_id, kind, payload, ts FROM session_events WHERE session_id = ? AND kind IN ('user/message','assistant/message','assistant/delta') ORDER BY id", va([tv(sid)]))) {
                let tid = r.text(0)
                let role = if (r.text(1) == "user/message") { "user" } else { "assistant" }
                let key = tid + ":" + role
                if (!texts.contains(key)) { order.add(key); texts[key] = "" }
                let text = payloadText(r.text(2), "text")
                texts[key] = if (r.text(1) == "assistant/delta") { (texts.get(key) ?? "") + text } else { text }
                turns[key] = tid; roles[key] = role; times[key] = r.text(3)
            }
            var found = false
            for (key in order) {
                let text = texts.get(key) ?? ""
                if (!text.toAsciiLower().contains(q)) { continue }
                let o = JsonObject()
                o.put("sessionId", JsonString(sid)); o.put("title", JsonString(title))
                o.put("turnId", JsonString(turns.get(key) ?? "")); o.put("role", JsonString(roles.get(key) ?? ""))
                let start = text.toAsciiLower().indexOf(q).getOrDefault({ => 0 })
                o.put("snippet", JsonString((if (start > 0) { "…" } else { "" }) + byteSafePrefix(String.fromUtf8(text.toArray()[start..]), 240)))
                o.put("at", JsonString(times.get(key) ?? ""))
                out.add(o); found = true
                if (out.size() >= limit) { return out }
            }
            if (!found && title.toAsciiLower().contains(q)) {
                let o = JsonObject()
                o.put("sessionId", JsonString(sid)); o.put("title", JsonString(title))
                o.put("turnId", JsonString("")); o.put("snippet", JsonString("会话标题匹配"))
                o.put("role", JsonString("title")); out.add(o)
                if (out.size() >= limit) { return out }
            }
        }
        return out
    }

    public func activateTurn(sessionId: String, turnId: String): Bool {
        let last = db().scalarInt("SELECT MAX(id) FROM session_events WHERE session_id = ? AND turn_id = ?",
            va([tv(sessionId), tv(turnId)]))
        if (last <= 0) {
            return false
        }
        db().putKv("sessions_meta", "tree:" + sessionId, "1")
        return setLeaf(sessionId, last)
    }

    /**
     * 会话树里"同一个分叉点上的几兄弟"，给界面画 ‹ 2/3 › 用。
     *
     * 兄弟 = 首事件的父事件相同的那几轮：正常续写时父是上一轮的末事件，从某一轮开分支时
     * 父是那一轮的前一个事件 —— 两种都落在"同一个父事件"上，正好是一族。每个兄弟带一个
     * tipTurnId：那条线一直延伸到的末端轮次（切过去时拿它当末端）。
     */
    public func treeInfo(sessionId: String): JsonObject {
        let o = JsonObject()
        let fams = JsonArray()
        o.put("families", fams)
        if (!hasTree(sessionId)) {
            return o
        }
        let ci = chainIndex(sessionId)
        let turnFirst = HashMap<String, Int64>()
        let turnLast = HashMap<String, Int64>()
        let turnParent = HashMap<String, Int64>()
        let order = ArrayList<String>()
        for (id in ci.ids) {
            let tid = ci.turnOf.get(id) ?? ""
            if (tid.size == 0) {
                continue
            }
            if (!turnFirst.contains(tid)) {
                turnFirst[tid] = id
                turnParent[tid] = ci.parent.get(id) ?? 0
                order.add(tid)
            }
            turnLast[tid] = id
        }
        let groups = HashMap<Int64, ArrayList<String>>()
        let groupOrder = ArrayList<Int64>()
        for (tid in order) {
            let key = turnParent.get(tid) ?? 0
            match (groups.get(key)) {
                case Some(g) => g.add(tid)
                case None =>
                    let g = ArrayList<String>()
                    g.add(tid)
                    groups[key] = g
                    groupOrder.add(key)
            }
        }
        let onChain = activeChainSet(sessionId)
        for (key in groupOrder) {
            let members = groups.get(key) ?? ArrayList<String>()
            if (members.size < 2) {
                continue
            }
            let arr = JsonArray()
            var activeIndex: Int64 = -1
            var idx: Int64 = 0
            for (tid in members) {
                if (onChain.contains(turnFirst.get(tid) ?? 0)) {
                    activeIndex = idx
                }
                let m = JsonObject()
                m.put("turnId", JsonString(tid))
                m.put("tipTurnId", JsonString(lineTip(ci, turnLast, tid)))
                arr.add(m)
                idx += 1
            }
            if (activeIndex < 0) {
                continue      // 这一族整条都不在活动链上（在别的分支的深处）：不显示
            }
            let f = JsonObject()
            f.put("count", JsonInt(members.size))
            f.put("activeIndex", JsonInt(activeIndex))
            f.put("members", arr)
            fams.add(f)
        }
        return o
    }

    /** 一条线延伸到的末端轮次：从这一轮的末事件往下走，每步取 id 最大的子事件那一轮。 */
    private func lineTip(ci: SessionChain, turnLast: HashMap<String, Int64>, turnId: String): String {
        var cur = turnId
        var guard: Int64 = 0
        while (guard < 500) {
            let last = turnLast.get(cur) ?? 0
            let kids = ci.children.get(last) ?? ArrayList<Int64>()
            if (kids.size == 0) {
                return cur
            }
            var best: Int64 = 0
            for (k in kids) {
                if (k > best) {
                    best = k
                }
            }
            let nextTurn = ci.turnOf.get(best) ?? ""
            if (nextTurn.size == 0 || nextTurn == cur) {
                return cur
            }
            cur = nextTurn
            guard += 1
        }
        return cur
    }

    /** 这一轮第一条事件的父事件 id（-1 = 没有这一轮）。 */
    public func parentOfTurn(sessionId: String, turnId: String): Int64 {
        let from = turnStartEventId(sessionId, turnId)
        if (from <= 0) {
            return -1
        }
        // 走索引：老事件的 parent_id 是空的，直接读列会得到 0（当成根），那就分错地方了
        let ci = chainIndex(sessionId)
        return ci.parent.get(from) ?? 0
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

    /** 这一轮最后一条事件的 id（"从这一轮分出去"要把这一轮一起带上）；没有这一轮就返回 0。 */
    public func turnLastEventId(sessionId: String, turnId: String): Int64 {
        if (sessionId.size == 0 || turnId.size == 0) {
            return 0
        }
        return db().scalarInt("SELECT MAX(id) FROM session_events WHERE session_id = ? AND turn_id = ?",
            va([tv(sessionId), tv(turnId)]))
    }

    /**
     * 退回到某一轮之前（"我上一条说错了，改一下重发"）：**真删**这一轮及其后代。
     *
     * 用户要的语义是"改最近一条 → 最新的回复记录被删掉覆盖"。想保留原来那条线时走另一条路
     * （"另开分支再发" = split），所以这里的删除是有意为之：删的是**这一轮及其后代**，
     * 别的分支不受影响 —— 老实现按 `id >= from` 删，会把后来长出来的兄弟线一起带走。
     * 删完把末端挪到这一轮之前，下一轮就从这里重新长。
     */
    public func rewind(sessionId: String, turnId: String): Int64 {
        let from = turnStartEventId(sessionId, turnId)
        if (from <= 0) {
            return 0
        }
        let ci = chainIndex(sessionId)
        let doomed = ArrayList<Int64>()
        let queue = ArrayList<Int64>()
        queue.add(from)
        var qi = 0
        while (qi < queue.size && doomed.size < 200000) {
            let cur = queue[qi]
            qi += 1
            doomed.add(cur)
            match (ci.children.get(cur)) {
                case Some(kids) =>
                    for (k in kids) {
                        queue.add(k)
                    }
                case None => ()
            }
        }
        var removed: Int64 = 0
        var chunkStart = 0
        while (chunkStart < doomed.size) {
            var chunkEnd = chunkStart + 200
            if (chunkEnd > doomed.size) {
                chunkEnd = doomed.size
            }
            let sb = StringBuilder("DELETE FROM session_events WHERE session_id = ? AND id IN (")
            let args = ArrayList<DbValue>()
            args.add(tv(sessionId))
            var k = chunkStart
            while (k < chunkEnd) {
                if (k > chunkStart) {
                    sb.append(", ")
                }
                sb.append("?")
                args.add(nv(doomed[k]))
                k += 1
            }
            sb.append(")")
            removed += db().run(sb.toString(), args)
            chunkStart = chunkEnd
        }
        // 末端挪到这一轮之前：下一轮从被删掉的位置重新长
        let backTo = ci.parent.get(from) ?? 0
        db().putKv("sessions_meta", "tree:" + sessionId, "1")
        setLeaf(sessionId, backTo)
        return removed
    }

    /**
     * 从某一轮分叉：新建一段会话，把**这一轮（含）以及之前**的事件原样复制过去。
     *
     * 与 rewind 的差别是原会话一字不动（Codex 里"从这里开个分支"就是这个意思：
     * 想换个问法重来，又不想丢掉原来那条线）。
     */
    /**
     * 从某一轮分叉：新建一段会话，把**这一轮（含）以及之前**的事件原样复制过去。
     *
     * 与 rewind 的差别是原会话一字不动（Codex 里"从这里开个分支"就是这个意思：
     * 想换个问法重来，又不想丢掉原来那条线）。
     * 名字：在新会话上叫「旧名字（2）」，再开就是（3）（4）…… 谁也不覆盖谁。
     */
    public func branch(sessionId: String, turnId: String): String {
        let last = turnLastEventId(sessionId, turnId)
        let newSid = newId()
        let now = DateTime.now().toString()
        db().run("INSERT OR REPLACE INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)",
            va([tv(newSid), tv(now), tv(now)]))
        if (last > 0) {
            /* 复制的是"到这一轮为止的那条线"，**含这一轮**：分叉点自己留着，之后才分道
               （界面"从这里开分支"就是这个意思）。必须沿 parent 走，不能按 `id <= last`：
               事件表里可能同时躺着别的分支，那些行的 id 也满足条件（踩过）。 */
            copyChain(sessionId, newSid, chainTo(sessionId, last))
        }
        // 起名：旧名字 +（N）。N 取"当前没被占用的最小序号"，所以开第 2、3、4 个分支也各自有名字
        let base = branchBaseTitle(sessionId)
        rename(newSid, branchTitleFor(base))
        setReasoningMode(newSid, reasoningMode(sessionId))
        return newSid
    }

    /**
     * 分叉的基线名字：优先用当前标题，没有就用第一句提问，再没有就叫"新对话"。
     *
     * 名字是**一层一层接上去**的（用户定的规矩）：
     *   同一段会话开第 2、3 个分支 → X（2）、X（3）；
     *   从一个分支再分出去 → 接在这个分支自己的名字后面 → X（2）（2）、X（2）（3）。
     * 所以基线取"父会话当前的名字本身"，不剥尾号。
     */
    private func branchBaseTitle(sessionId: String): String {
        let t = trimStr(titleOf(sessionId))
        if (t.size > 0) {
            return t
        }
        let first = trimStr(firstUserText(sessionId))
        if (first.size > 0) {
            return byteSafePrefix(first, 24)
        }
        return "新对话"
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
        // 事件数算的是**当前分支**：库里可能还躺着被放弃的分支（改一条重发留下的），
        // 它们不该出现在"这一段有多少条"里
        let branchIds = branchEventIds(sessionId)
        o.put("eventCount", JsonInt(branchIds.size))
        var title = ""
        var lastType = ""
        var lastAt = ""
        match (db().one("SELECT ts, kind, payload FROM session_events WHERE session_id = ? AND kind = ? ORDER BY id LIMIT 1",
            va([tv(sessionId), tv("user/message")]))) {
            case Some(r) =>
                title = payloadText(r.text(2), "text")
            case None => ()
        }
        match (db().one("SELECT ts, kind FROM session_events WHERE id = ?", va([nv(leafOf(sessionId))]))) {
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
        // 导学等资源会话同时属于普通对话；resource 标签供列表显示和播放器筛选。
        o.put("resource", resourceMetaField(db().getKv("sessions_meta", "resource:" + sessionId, "")))
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
        copyChain(sessionId, newSid, branchEventIds(sessionId))
        rename(newSid, branchTitleFor(branchBaseTitle(sessionId)))
        setReasoningMode(newSid, reasoningMode(sessionId))
        return newSid
    }

    /**
     * 把一条链按原顺序复制到新会话，parent 关系一起搬。
     *
     * payload 原样搬（不解析再序列化：大 payload 重排既慢又可能改字符）。
     * 返回新会话的末端 id（0 = 什么都没复制）。
     */
    private func copyChain(sessionId: String, newSid: String, chain: ArrayList<Int64>): Int64 {
        var prevNew: Int64 = 0
        for (oldId in chain) {
            match (db().one("SELECT ts, kind, turn_id, payload FROM session_events WHERE id = ?", va([nv(oldId)]))) {
                case Some(r) =>
                    db().run("INSERT INTO session_events (session_id, ts, kind, turn_id, payload, parent_id) " +
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        va([tv(newSid), tv(r.text(0)), tv(r.text(1)), tv(r.text(2)), tv(r.text(3)), nv(prevNew)]))
                    prevNew = db().scalarInt("SELECT MAX(id) FROM session_events WHERE session_id = ?", va([tv(newSid)]))
                case None => ()
            }
        }
        return prevNew
    }

    /**
     * 会话树：把这段会话里出现过的每一轮列出来，并标出它们接在谁后面、现在这条分支在哪。
     *
     * 界面的「会话树」面板靠它：点某一轮就是"切到这条"（setLeaf），
     * 从某一轮再往下接就是"在这条上继续"。
     * 每个节点的形状：{turnId, eventId, user, at, parentTurnId, active, ok, tools}
     */
    public func turnTree(sessionId: String): ArrayList<JsonObject> {
        let out = ArrayList<JsonObject>()
        let activeIds = HashSet<Int64>()
        for (id in branchEventIds(sessionId)) {
            activeIds.add(id)
        }
        // 每轮的第一条事件 + 提问 + 是否完成
        let firstOfTurn = ArrayList<(Int64, String)>()
        var lastTurn = ""
        for (r in db().query("SELECT id, turn_id FROM session_events WHERE session_id = ? ORDER BY id",
            va([tv(sessionId)]))) {
            let tid = r.text(1)
            if (tid != lastTurn) {
                firstOfTurn.add((r.int(0), tid))
                lastTurn = tid
            }
        }
        // 事件 id → 轮次，用来把"父事件"翻译成"父轮次"
        let turnOfEvent = HashMap<Int64, String>()
        var cur = ""
        var i: Int64 = 0
        for (r in db().query("SELECT id, turn_id FROM session_events WHERE session_id = ? ORDER BY id",
            va([tv(sessionId)]))) {
            turnOfEvent[r.int(0)] = r.text(1)
        }
        for ((evId, tid) in firstOfTurn) {
            let o = JsonObject()
            o.put("turnId", JsonString(tid))
            o.put("eventId", JsonInt(evId))
            // 父轮次：从这一轮的第一条往上一格；父事件还落在同一轮里就继续往上找
            var parentTurn = ""
            var probe = parentOf(evId)
            var guard: Int64 = 0
            while (probe > 0 && guard < 100000) {
                let pt = turnOfEvent.get(probe) ?? ""
                if (pt != tid) {
                    parentTurn = pt
                    break
                }
                probe = parentOf(probe)
                guard += 1
            }
            o.put("parentTurnId", JsonString(parentTurn))
            o.put("active", JsonBool(activeIds.contains(evId)))
            var user = ""
            var at = ""
            var ok: Int64 = -1
            var tools: Int64 = 0
            for (r in db().query(
                "SELECT kind, payload, ts FROM session_events WHERE session_id = ? AND turn_id = ? ORDER BY id",
                va([tv(sessionId), tv(tid)]))) {
                let kind = r.text(0)
                if (kind == "user/message" && user.size == 0) {
                    user = payloadText(r.text(1), "text")
                    at = r.text(2)
                } else if (kind == "tool/call") {
                    tools += 1
                } else if (kind == "turn/end") {
                    ok = if (payloadBool(r.text(1), "ok", false)) { 1 } else { 0 }
                }
            }
            o.put("user", JsonString(byteSafePrefix(user, 60)))
            o.put("at", JsonString(at))
            o.put("ok", JsonInt(ok))
            o.put("tools", JsonInt(tools))
            out.add(o)
        }
        return out
    }

    /** 从 payload 取一个布尔（缺省按 false）。 */
    private func payloadBool(payload: String, key: String, fallback: Bool): Bool {
        if (payload.size == 0) {
            return fallback
        }
        try {
            match (objOf(JsonValue.fromStr(payload))) {
                case Some(o) => return boolOf(o, key)
                case None => ()
            }
        } catch (e: Exception) {
            ()
        }
        return fallback
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
        db().delKv("sessions_meta", "resource:" + sessionId)
        db().delKv("sessions_meta", "guided:" + sessionId)
        db().delKv("sessions_meta", "reasoning:" + sessionId)
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
        migrateFromJson()
        // 纪元命中直接回缓存：凡是写 sessions/session_events/sessions_meta 的 SQL 都会把
        // 纪元 +1（见 db.cj），没变就是没变。组装一次要 ~1 秒（引擎怕全表聚合），
        // 聊天期间每轮都会来读，缓存把稳态压到几毫秒。
        let epoch = sessionEpoch()
        sessionListCacheLock.lock()
        try {
            if (sessionListCacheDir == dataDir && sessionListCacheEpoch == epoch) {
                match (sessionListCache) {
                    case Some(cached) =>
                        return copySessionList(cached)
                    case None => ()
                }
            }
            // 过期时回「上一份」并把重算挪去后台（stale-while-revalidate）：流式期间每条 delta 都推纪元，
            // 若调用线程自己等全量重算，一次切换就要陪跑几秒（实测切回对话页 sessions/list 6.1 秒）。
            // 有旧结果就先给旧的；距上次算完不足 1 秒也不再重复安排，把重算交给在飞的那个。
            // 冷启动没有旧结果时才在本线程算（调用方必须拿到数据）。
            let nowMs = DateTime.now().toUnixTimeStamp().toMilliseconds()
            let inFlight = sessionListComputeStartedMs > 0 && nowMs - sessionListComputeStartedMs < 15000
            var stale: ?ArrayList<JsonObject> = None
            if (sessionListCacheDir == dataDir) {
                match (sessionListCache) {
                    case Some(cached) => stale = Some(copySessionList(cached))
                    case None => ()
                }
            }
            var needCompute = !inFlight
            if (needCompute) {
                match (stale) {
                    case Some(_) => if (nowMs - sessionListLastComputeMs < 1000) { needCompute = false }
                    case None => ()
                }
            }
            if (needCompute) {
                sessionListComputeStartedMs = nowMs
                if (inFlight) {
                    // 冷启动撞上在飞重算：极少见，按旧版行为再算一份，后写回者胜。
                    sessionListCacheLock.unlock()
                    return computeSessionList(epoch)
                }
                let _background = spawn {
                    this.computeSessionList(epoch)
                }
            }
            match (stale) {
                case Some(cached) =>
                    return cached
                case None =>
                    // 理论不可达（needCompute 且无旧结果才会走到 spawn 之外），兜底再算一次。
                    sessionListCacheLock.unlock()
                    return computeSessionList(epoch)
            }
        } finally {
            sessionListCacheLock.unlock()
        }
    }

    /* 全量组装并写回缓存。后台线程与冷启动共用；抛异常时在飞标记按超时自愈。 */
    private func computeSessionList(epoch: Int64): ArrayList<JsonObject> {
        let out = ArrayList<JsonObject>()
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
        // 每个会话只取第一条消息 / 第一条 turn/start：按 (session_id, id) 索引逐会话 LIMIT 1。
        // 不要写成 JOIN + MIN(id) 子查询——third_party 那个纯仓颉 SQL 引擎对这类连表在
        // 1.8 万条事件的库上要 65 秒/条（官方 SQLite 同句 6ms，已对照实测），页面切换全被它拖死。
        // 两条信息一条语句拿：按 id 升序扫这个会话最前面的若干条，
        // 见到第一条第 user/message 与第一条 turn/start 就收工。
        // （引擎每条语句固定开销 ~8ms，56 个会话从 112 条语句减到 56 条，省掉近半秒）
        let titles = HashMap<String, String>()
        let kinds = HashMap<String, String>()
        let kbs = HashMap<String, String>()
        for (sid in ids) {
            var gotTitle = false
            var gotTurn = false
            for (r in dbh.query("SELECT kind, payload FROM session_events WHERE session_id = ? AND (kind = 'user/message' OR kind = 'turn/start') ORDER BY id LIMIT 12", va([tv(sid)]))) {
                let kind = r.text(0)
                if (kind == "user/message" && !gotTitle) {
                    titles[sid] = payloadText(r.text(1), "text")
                    gotTitle = true
                } else if (kind == "turn/start" && !gotTurn) {
                    let p = r.text(1)
                    kinds[sid] = payloadText(p, "kind")
                    kbs[sid] = payloadText(p, "kbId")
                    gotTurn = true
                }
                if (gotTitle && gotTurn) {
                    break
                }
            }
        }

        let customTitles = HashMap<String, String>()
        let projectOf = HashMap<String, String>()
        let resourceOf = HashMap<String, JsonValue>()
        // 顺手把 leaf/tree 标记也读出来：行的循环里就不用每个会话再单独 getKv 一次
        //（纯仓颉引擎上每多一条语句都是毫秒级开销，56 个会话就是几百毫秒）
        let leafMap = HashMap<String, Int64>()
        let treeSet = HashSet<String>()
        for (r in dbh.querySql("SELECT k, v FROM sessions_meta")) {
            let k = r.text(0)
            let v = r.text(1)
            if (hasPrefix(k, "title:")) {
                customTitles[k.replace("title:", "")] = v
            } else if (hasPrefix(k, "project:")) {
                projectOf[k.replace("project:", "")] = v
            } else if (hasPrefix(k, "resource:")) {
                resourceOf[k.replace("resource:", "")] = resourceMetaField(v)
            } else if (hasPrefix(k, "leaf:")) {
                try { leafMap[k.replace("leaf:", "")] = Int64.parse(v) } catch (e: Exception) { () }
            } else if (hasPrefix(k, "tree:")) {
                treeSet.add(k.replace("tree:", ""))
            }
        }

        for (sid in ids) {
            let o = JsonObject()
            o.put("sessionId", JsonString(sid))
            // 计数同样按**当前分支**：被放弃的分支不计入。
            // 没分过叉的会话两值恒等：直接用前面已聚合的 counts，省掉逐会话扫全表建链。
            o.put("eventCount", JsonInt(if (treeSet.contains(sid)) { branchEventIds(sid).size } else { counts.get(sid) ?? 0 }))
            var title = titles.get(sid) ?? ""
            let custom = customTitles.get(sid) ?? ""
            if (custom.size > 0) {
                title = custom
            } else if (title.size > 60) {
                title = byteSafePrefix(title, 60) + "…"
            }
            var lastAt = ""
            var lastType = ""
            let leaf = match (leafMap.get(sid)) {
                case Some(v) => v
                case None => lastIds.get(sid) ?? 0   // 没挪过末端：leaf 就是最后一条事件
            }
            match (dbh.one("SELECT ts, kind FROM session_events WHERE id = ?", va([nv(leaf)]))) {
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
            o.put("resource", resourceOf.get(sid) ?? JsonNull())
            out.add(o)
        }
        sessionListCacheLock.lock()
        try {
            sessionListCache = Some(out)
            sessionListCacheDir = dataDir
            sessionListCacheEpoch = epoch
            sessionListLastComputeMs = DateTime.now().toUnixTimeStamp().toMilliseconds()
            sessionListComputeStartedMs = 0
        } finally {
            sessionListCacheLock.unlock()
        }
        return copySessionList(out)
    }
    private func copySessionList(src: ArrayList<JsonObject>): ArrayList<JsonObject> {
        let out = ArrayList<JsonObject>()
        for (o in src) {
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

    /**
     * 老库一次性补 parent_id：按 (会话, id) 顺序把每段会话串成一条链 ——
     * 它本来就是一条线，补完之后行为与原来一模一样，只是从此可以分叉了。
     */
    private func migrateTree(): Unit {
        if (migrationDone(db(), "session_tree")) {
            return
        }
        let ops = ArrayList<DbOp>()
        var lastSid = ""
        var lastId: Int64 = 0
        for (r in db().querySql("SELECT id, session_id, parent_id FROM session_events ORDER BY session_id, id")) {
            let id = r.int(0)
            let sid = r.text(1)
            if (r.isNull(2)) {
                let parent = if (sid == lastSid) { lastId } else { 0 }
                ops.add(DbOp("UPDATE session_events SET parent_id = ? WHERE id = ?", va([nv(parent), nv(id)])))
            }
            lastSid = sid
            lastId = id
        }
        db().batch(ops)
        markMigrationDone(db(), "session_tree")
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
