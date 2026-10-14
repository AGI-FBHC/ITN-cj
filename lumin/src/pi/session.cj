package lumin.pi

import std.collection.*
import std.fs.*
import std.time.*
import stdx.encoding.json.*

/*
 * 会话：照 Pi 的 JSONL + 树来做。
 *
 *   第 1 行 header：{"type":"session","version":3,"id":..,"timestamp":..,"cwd":..}
 *   之后每行一条 entry：{"type":..,"id":"a0b1c2d3","parentId":..,"timestamp":..,...}
 *
 * entry 类型（挑 Pi 里用得上的几种）：
 *   message       一条消息（user / assistant / toolResult），system 另见 appendSystemSections
 *   model_change  换模型
 *   compaction    压缩：summary + firstKeptEntryId（这条往后保留，之前的被摘要替代）
 *   session_info  会话名
 *
 * 续聊 = 往当前叶子后面追加；分叉 = 把叶子指回更早的 entry 再追加（同一个文件，就是 Pi 的树）。
 * 落盘策略：整文件重写。会话是 KB 级，换来的是"不会写坏半行"的简单性（Pi 用的是真追加）。
 */

/** 8 位十六进制 id（Pi 的 entry id 就是这个形状）。 */
public func hex8(n: Int64): String {
    let digits = "0123456789abcdef".toArray()
    let out = Array<UInt8>(8, repeat: 48)
    var v = n
    if (v < 0) {
        v = 0 - v
    }
    var i: Int64 = 7
    while (i >= 0) {
        out[i] = digits[v % 16]
        v = v / 16
        i = i - 1
    }
    return String.fromUtf8(out)
}

/** 路径 -> 会话目录名（Pi 的做法：去掉开头的分隔符，把 / \ : 换成 -）。 */
public func sessionDirName(cwd: String): String {
    let b = cwd.toArray()
    let sb = StringBuilder()
    sb.append("--")
    var started = false
    var i = 0
    while (i < b.size) {
        let c = b[i]
        if (!started && (c == 47 || c == 92)) {
            i = i + 1
            continue
        }
        started = true
        if (c == 47 || c == 92 || c == 58) {
            sb.append("-")
        } else if (c < 128) {
            sb.append(String.fromUtf8(b[i..i + 1]))
        } else {
            let n = utf8CharLen(c)
            var j = i + n
            if (j > b.size) {
                j = b.size
            }
            sb.append(String.fromUtf8(b[i..j]))
            i = j
            continue
        }
        i = i + 1
    }
    sb.append("--")
    return sb.toString()
}

/** 时间戳文件名前缀：20261014-181233。 */
public func stampName(iso: String): String {
    let b = iso.toArray()
    var digits = ""
    var i = 0
    while (i < b.size && digits.size < 14) {
        if (b[i] >= 48 && b[i] <= 57) {
            digits = digits + String.fromUtf8(b[i..i + 1])
        }
        i = i + 1
    }
    if (digits.size <= 8) {
        return digits
    }
    return safeUtf8(digits.toArray(), 0, 8) + "-" + safeUtf8(digits.toArray(), 8, digits.size)
}

public func sessionRoot(dataDir: String, cwd: String): String {
    return dataDir + "/sessions/" + sessionDirName(cwd)
}

public class Session {
    public var id: String = ""
    public var cwd: String = ""
    public var path: String = ""
    public var parentSession: String = ""
    public let entries = ArrayList<JsonObject>()
    public var leafId: String = ""
    public var counter: Int64 = 0

    public init() {}

    /* ---------- 追加 ---------- */

    private func nextId(): String {
        counter = counter + 1
        return hex8(counter)
    }

    /** 追加一条 entry，返回它的 id。 */
    public func appendEntry(e: JsonObject): String {
        let id = strOf(e, "id")
        if (id.size == 0) {
            let nid = nextId()
            e.put("id", JsonString(nid))
            if (!hasKeyOf(e, "parentId")) {
                e.put("parentId", if (leafId.size > 0) { JsonString(leafId) } else { JsonNull() })
            }
            if (!hasKeyOf(e, "timestamp")) {
                e.put("timestamp", JsonString(DateTime.now().toString()))
            }
            entries.add(e)
            leafId = nid
            save()
            return nid
        }
        entries.add(e)
        leafId = id
        save()
        return id
    }

    public func appendMessage(m: Message): String {
        let e = JsonObject()
        e.put("type", JsonString("message"))
        e.put("message", m.toJson())
        return appendEntry(e)
    }

    /** system 消息：把提示词的各个 section 存进会话（Pi 的做法），便于回放当时的提示词。 */
    public func appendSystemSections(sections: JsonObject): String {
        let e = JsonObject()
        e.put("type", JsonString("message"))
        let m = JsonObject()
        m.put("role", JsonString("system"))
        m.put("content", JsonString(""))
        m.put("sections", sections)
        m.put("timestamp", JsonInt(nowMillis()))
        e.put("message", m)
        return appendEntry(e)
    }

    public func appendModelChange(model: String): String {
        let e = JsonObject()
        e.put("type", JsonString("model_change"))
        e.put("modelId", JsonString(model))
        return appendEntry(e)
    }

    public func appendCompaction(summary: String, firstKeptEntryId: String): String {
        let e = JsonObject()
        e.put("type", JsonString("compaction"))
        e.put("summary", JsonString(summary))
        e.put("firstKeptEntryId", JsonString(firstKeptEntryId))
        return appendEntry(e)
    }

    public func appendSessionInfo(name: String): String {
        let e = JsonObject()
        e.put("type", JsonString("session_info"))
        e.put("name", JsonString(name))
        return appendEntry(e)
    }

    /** 分叉：把叶子指回更早的 entry，之后追加的新 entry 天然形成另一条分支。 */
    public func forkFrom(entryId: String): Bool {
        if (entryId.size == 0) {
            leafId = ""
            return true
        }
        for (e in entries) {
            if (strOf(e, "id") == entryId) {
                leafId = entryId
                return true
            }
        }
        return false
    }

    /* ---------- 读取 ---------- */

    public func entryOf(id: String): ?JsonObject {
        for (e in entries) {
            if (strOf(e, "id") == id) {
                return Some(e)
            }
        }
        return None
    }

    public func name(): String {
        var out = ""
        for (e in entries) {
            if (strOf(e, "type") == "session_info") {
                out = strOf(e, "name")
            }
        }
        return out
    }

    /** 当前叶子回溯到根的 entry 列表（从早到晚）。 */
    public func branchEntries(): ArrayList<JsonObject> {
        let chain = ArrayList<JsonObject>()
        var cur = leafId
        var guard: Int64 = 0
        while (cur.size > 0 && guard < 10000) {
            guard = guard + 1
            match (entryOf(cur)) {
                case Some(e) =>
                    chain.add(e)
                    cur = parentIdOf(e)
                case None => cur = ""
            }
        }
        // 反转成从早到晚
        let out = ArrayList<JsonObject>()
        var i = chain.size - 1
        while (i >= 0) {
            out.add(chain[i])
            i = i - 1
        }
        return out
    }

    /** 给模型的消息列表：走当前分支，应用最近一次压缩。 */
    public func messagesForModel(): ArrayList<Message> {
        let branch = branchEntries()
        // 最近一次压缩
        var compIdx: Int64 = -1
        var i: Int64 = 0
        while (i < branch.size) {
            if (strOf(branch[i], "type") == "compaction") {
                compIdx = i
            }
            i = i + 1
        }
        var keepFrom: Int64 = 0
        var summary = ""
        if (compIdx >= 0) {
            summary = strOf(branch[compIdx], "summary")
            let firstKept = strOf(branch[compIdx], "firstKeptEntryId")
            keepFrom = indexOfEntry(branch, firstKept)
            if (keepFrom < 0) {
                keepFrom = compIdx + 1
            }
        }
        let out = ArrayList<Message>()
        if (summary.size > 0) {
            let m = Message(UserMsg)
            m.text = "（以下是本次会话更早内容的摘要）\n" + summary
            out.add(m)
        }
        var k = keepFrom
        while (k < branch.size) {
            let e = branch[k]
            if (strOf(e, "type") == "message") {
                match (e.get("message")) {
                    case Some(mv) =>
                        match (objOf(mv)) {
                            case Some(mo) =>
                                if (strOf(mo, "role") != "system") {
                                    match (messageFromJson(mo)) {
                                        case Some(m) => out.add(m)
                                        case None => ()
                                    }
                                }
                            case None => ()
                        }
                    case None => ()
                }
            }
            k = k + 1
        }
        return out
    }

    /** 会话里第一条 user 消息（列会话时当摘要用）。 */
    public func firstUserText(): String {
        for (e in entries) {
            if (strOf(e, "type") == "message") {
                match (e.get("message")) {
                    case Some(mv) =>
                        match (objOf(mv)) {
                            case Some(mo) =>
                                if (strOf(mo, "role") == "user") {
                                    return byteSafePrefix(strOf(mo, "content"), 80)
                                }
                            case None => ()
                        }
                    case None => ()
                }
            }
        }
        return ""
    }

    /** 整文件重写（header + 全部 entry）。 */
    public func save(): Unit {
        let sb = StringBuilder()
        let header = JsonObject()
        header.put("type", JsonString("session"))
        header.put("version", JsonInt(3))
        header.put("id", JsonString(id))
        header.put("timestamp", JsonString(DateTime.now().toString()))
        header.put("cwd", JsonString(cwd))
        if (parentSession.size > 0) {
            header.put("parentSession", JsonString(parentSession))
        }
        sb.append(header.toString())
        sb.append("\n")
        for (e in entries) {
            sb.append(e.toString())
            sb.append("\n")
        }
        let slash = lastSlashOf(path)
        if (slash > 0) {
            let dir = safeUtf8(path.toArray(), 0, slash)
            if (!exists(dir)) {
                Directory.create(dir, recursive: true)
            }
        }
        File.writeTo(path, sb.toString().toArray())
    }
}

/* ---------- 建/载/列 ---------- */

public func newSession(dataDir: String, cwd: String, id: String, parentSession: String): Session {
    let s = Session()
    s.cwd = cwd
    s.parentSession = parentSession
    var sid = id
    if (sid.size == 0) {
        // Pi 的会话 id 就是个 uuid/短十六进制；这里用毫秒低位凑 8 位，够用且可读
        sid = hex8(nowMillis() % 4294967296)
    }
    s.id = sid
    s.path = sessionRoot(dataDir, cwd) + "/" + stampName(DateTime.now().toString()) + "_" + sid + ".jsonl"
    s.save()
    return s
}

public func loadSession(path: String): Session {
    let s = Session()
    s.path = path
    var text = ""
    try {
        text = safeUtf8(File.readFrom(path), 0, 8 * 1024 * 1024)
    } catch (e: Exception) {
        return s
    }
    var first = true
    for (line in splitLines(text)) {
        let t = trimStr(line)
        if (t.size == 0) {
            continue
        }
        var obj: ?JsonObject = None
        try {
            match (JsonValue.fromStr(t)) {
                case o: JsonObject => obj = Some(o)
                case _ => ()
            }
        } catch (e: Exception) {
            obj = None
        }
        match (obj) {
            case Some(o) =>
                if (first) {
                    first = false
                    if (strOf(o, "type") == "session") {
                        s.id = strOf(o, "id")
                        s.cwd = strOf(o, "cwd")
                        s.parentSession = strOf(o, "parentSession")
                        continue
                    }
                }
                s.entries.add(o)
                s.leafId = strOf(o, "id")
            case None => ()
        }
    }
    // 计数器跳过已用过的 id，避免重复
    var maxN: Int64 = 0
    for (e in s.entries) {
        let h = strOf(e, "id")
        let n = hexValue(h)
        if (n > maxN) {
            maxN = n
        }
    }
    s.counter = maxN
    return s
}

/** 某个 cwd 下的会话文件（新的在前）。 */
public func listSessionFiles(dataDir: String, cwd: String): ArrayList<String> {
    let out = ArrayList<String>()
    let dir = sessionRoot(dataDir, cwd)
    if (!exists(dir)) {
        return out
    }
    try {
        Directory.walk(Path(dir), { fi: FileInfo =>
            let nm = fi.name
            if (!fi.isDirectory() && hasSuffix(nm, ".jsonl")) {
                out.add(dir + "/" + nm)
            }
            true
        })
    } catch (e: Exception) {
        ()
    }
    return out
}

public func hexValue(h: String): Int64 {
    let b = h.toArray()
    var v: Int64 = 0
    var i = 0
    while (i < b.size) {
        let c = b[i]
        var d: Int64 = -1
        if (c >= 48 && c <= 57) {
            d = Int64(c) - 48
        } else if (c >= 97 && c <= 102) {
            d = Int64(c) - 87
        } else if (c >= 65 && c <= 70) {
            d = Int64(c) - 55
        }
        if (d < 0) {
            return v
        }
        v = v * 16 + d
        i = i + 1
    }
    return v
}

func parentIdOf(e: JsonObject): String {
    match (e.get("parentId")) {
        case Some(v) =>
            match (v) {
                case s: JsonString => return s.getValue()
                case _ => return ""
            }
        case None => return ""
    }
}

func hasKeyOf(o: JsonObject, k: String): Bool {
    match (o.get(k)) {
        case Some(_) => return true
        case None => return false
    }
}

func indexOfEntry(list: ArrayList<JsonObject>, id: String): Int64 {
    var i: Int64 = 0
    while (i < list.size) {
        if (strOf(list[i], "id") == id) {
            return i
        }
        i = i + 1
    }
    return -1
}

func lastSlashOf(s: String): Int64 {
    let b = s.toArray()
    var i = b.size
    while (i > 0) {
        if (b[i - 1] == 47 || b[i - 1] == 92) {
            return i - 1
        }
        i = i - 1
    }
    return -1
}
