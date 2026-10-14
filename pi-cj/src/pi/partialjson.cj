package pi_cj.pi

import std.collection.*
import stdx.encoding.json.*

/**
 * 流式解析"还没写完"的工具调用 JSON。
 *
 * 这是从 Pi Agent 借的第三条、也是最容易被跳过的一条：工具参数是边生成边到达的，
 * 不等它完整就实时解析（Pi 里叫 `toolcall_delta`），用户才能早早看到"正在检索知识库 · 查询：提示词"，
 * 而不是盯着转圈等整段返回。
 *
 * 两种形态都支持（实际服务端两种都出现过）：
 *
 *   扁平（我们的提示词协议 / 简单原生调用）：
 *     {"name":"kb_search","args":{"query":"提示词","top_k":6}}
 *
 *   OpenAI 原生（arguments 本身是一段**字符串形式的 JSON**，要再解一层）：
 *     {"index":0,"id":"call_1","type":"function",
 *      "function":{"name":"kb_search","arguments":"{\"query\":\"提示词\"}"}}
 *
 * 实现取舍：每次 push 都**从头重扫整个缓冲**（工具调用只有几百字节，代价可忽略），
 * 换来"不需要可恢复状态机"的健壮性——半截字符串、转义引号、嵌套对象都不会让它崩。
 *
 * **字节安全**：缓冲区尾部很可能正好切在一个汉字中间（网络分片就是这样），
 * 所以任何对尾部的解码都必须先回退到字符边界。这类问题内核里已经踩过两次。
 */

/** 一段字节范围：起点 / 终点(exclusive) / 是否闭合。 */
class ScanRange {
    var start: Int64 = -1
    var end: Int64 = -1
    var closed: Bool = false

    init(start: Int64, end: Int64, closed: Bool) {
        this.start = start
        this.end = end
        this.closed = closed
    }

    func found(): Bool {
        return start >= 0
    }
}

/** 字符串成员的值 + 是否闭合。 */
class TextValue {
    var value: String = ""
    var closed: Bool = false

    init(value: String, closed: Bool) {
        this.value = value
        this.closed = closed
    }
}

/** 解析到某一时刻的"视图"：工具名、已完整的参数、正在到达的那个参数。 */
public class ToolCallView {
    public var name: String = ""
    public var nameKnown: Bool = false
    public let keys = ArrayList<String>()
    public let values = ArrayList<String>()
    public var partialKey: String = ""
    public var partialValue: String = ""
    public var complete: Bool = false

    /** 取参数值（**去掉 JSON 外层引号**，给界面/断言用；argsJson() 里仍是合法 JSON 文本）。 */
    public func valueOf(k: String): String {
        var i = 0
        while (i < keys.size) {
            if (keys[i] == k) {
                return stripQuotes(values[i])
            }
            i = i + 1
        }
        return ""
    }

    public func hasKey(k: String): Bool {
        var i = 0
        while (i < keys.size) {
            if (keys[i] == k) {
                return true
            }
            i = i + 1
        }
        return false
    }

    /** 已完整的参数组装成 JSON 对象。 */
    public func argsJson(): JsonObject {
        let o = JsonObject()
        var i = 0
        while (i < keys.size) {
            o.put(keys[i], parseLoose(values[i]))
            i = i + 1
        }
        return o
    }
}

/** values 里存的是 JSON 文本（字符串带引号），展示时去掉外层引号并反转义。 */
func stripQuotes(s: String): String {
    let b = s.toArray()
    if (b.size >= 2 && b[0] == 34 && b[b.size - 1] == 34) {
        return unescapeJson(String.fromUtf8(b[1..b.size - 1]))
    }
    return s
}

/** 把"看起来像 JSON 的值"还原成 JsonValue；解析不了就当字符串。 */
func parseLoose(raw: String): JsonValue {
    let t = raw
    if (t == "true") { return JsonBool(true) }
    if (t == "false") { return JsonBool(false) }
    if (t == "null") { return JsonNull() }
    try {
        return JsonValue.fromStr(t)
    } catch (e: Exception) {
        return JsonString(t)
    }
}

/** 把字节区间安全地解码成字符串：若末尾落在多字节字符中间，回退到字符边界。 */
/**
 * 把字节区间安全地解码成字符串。
 *
 * 这是全项目最容易踩的一类坑：网络分片会把一个汉字切成两半，直接 String.fromUtf8 会抛
 * （内核 util.cj 的 readAllString 就因为按 8KB 各自解码、中文被切断而报
 * "Invalid utf8 byte sequence"）。这里的规矩是：**只解码完整字符，末尾的半截丢掉**，
 * 剩下的字节下次再拼进来。
 *
 * 注意"丢"的单位是整个不完整的字符。只退到"非续字节"是不够的：3 字节的汉字只到了第 1 个
 * 字节时，末字节是个首字节、不是续字节，按那个判据会原样保留 -> 解出半个字符直接抛。
 */
public func safeUtf8(bytes: Array<UInt8>, from: Int64, toExclusive: Int64): String {
    var start = from
    if (start < 0) {
        start = 0
    }
    var end = toExclusive
    if (end > bytes.size) {
        end = bytes.size
    }
    if (start >= end) {
        return ""
    }
    var e = end
    while (e > start) {
        var lead = e - 1
        while (lead > start && (bytes[lead] & 192) == 128) {
            lead = lead - 1
        }
        if (lead + utf8CharLen(bytes[lead]) <= e) {
            break
        }
        e = lead
    }
    if (e <= start) {
        return ""
    }
    return String.fromUtf8(bytes[start..e])
}

/** UTF-8 首字节 -> 该字符占几个字节；非法字节按 1 处理，保证不越界。 */
func utf8CharLen(b: UInt8): Int64 {
    if (b < 128) {
        return 1
    }
    if ((b & 224) == 192) {
        return 2
    }
    if ((b & 240) == 224) {
        return 3
    }
    if ((b & 248) == 240) {
        return 4
    }
    return 1
}


/** JSON 字符串反转义（常见几个转义，够用）。 */
func unescapeJson(s: String): String {
    if (s.split("\\").size <= 1) {
        return s
    }
    let b = s.toArray()
    let out = ArrayList<UInt8>()
    var i = 0
    while (i < b.size) {
        if (b[i] == 92 && i + 1 < b.size) {
            let n = b[i + 1]
            if (n == 110) { out.add(10) } else if (n == 116) { out.add(9) } else if (n == 114) { out.add(13) }
            else if (n == 34) { out.add(34) } else if (n == 92) { out.add(92) } else if (n == 47) { out.add(47) }
            else { out.add(n) }
            i = i + 2
            continue
        }
        out.add(b[i])
        i = i + 1
    }
    return String.fromUtf8(out.toArray())
}

/** 转义成 JSON 字符串内容（把"半截字符串值"安全地放进事件里展示）。 */
/** 转义成 JSON 字符串内容（把"半截字符串值"安全地放进事件里展示）。 */


public class PartialJsonParser {
    private var buf = ArrayList<UInt8>()
    private var lastView = ToolCallView()
    /**
     * 半截字符串值每增长这么多**字节**就报一次增量（避免逐字节刷屏）。
     * 注意仓颉的 String.size 是 UTF-8 字节数而不是字符数，所以这里按字节计：
     * 24 字节大约等于 8 个汉字或 24 个 ASCII 字符。
     */
    public var partialChunkBytes: Int64 = 24

    public init() {}

    /**
     * 喂一片（可能是半截的）JSON。
     *
     * 早先这里还会顺手产出 tool/call_* 事件；改成对齐 Pi 之后，增量事件由提供方按
     * toolcall_delta 直接推（Pi 也是把 arguments 的原样片段推给上层），这里只负责"把视图算出来"。
     */
    public func push(fragment: String): Unit {
        let fb = fragment.toArray()
        var i = 0
        while (i < fb.size) {
            buf.add(fb[i])
            i = i + 1
        }
        lastView = scan()
    }

    public func view(): ToolCallView {
        return lastView
    }

    public func isComplete(): Bool {
        return lastView.complete
    }

    public func rawText(): String {
        return String.fromUtf8(buf.toArray())
    }

    /* ---------- 扫描 ---------- */

    private func scan(): ToolCallView {
        let v = ToolCallView()
        let bytes = buf.toArray()
        let root = objectRange(bytes, 0)
        if (!root.found()) {
            return v
        }
        var scopeStart = root.start
        var scopeEnd = root.end
        var closed = root.closed
        // 形态二：OpenAI 原生，name/arguments 藏在 function 里
        let fn = memberRange(bytes, scopeStart, scopeEnd, "function")
        if (fn.found()) {
            scopeStart = fn.start
            scopeEnd = fn.end
            closed = fn.closed
        }
        // 工具名：内核协议用 tool，OpenAI 原生用 name，两种都认
        // 名字必须"整个字符串到齐"才算已知：否则流式到达时会把半个名字当工具名发出去
        // （按 5 字节分片喂 {"tool":"kb_search",...} 时，第一版发出的是 "k"）。
        let name = stringMember(bytes, scopeStart, scopeEnd, "name")
        if (name.value.size > 0 && name.closed) {
            v.name = name.value
            v.nameKnown = true
        } else {
            let alt = stringMember(bytes, scopeStart, scopeEnd, "tool")
            if (alt.value.size > 0 && alt.closed) {
                v.name = alt.value
                v.nameKnown = true
            }
        }
        // 参数容器：扁平是 args/arguments 对象；原生是 arguments 字符串（里面还是 JSON）
        var argR = memberRange(bytes, scopeStart, scopeEnd, "args")
        if (!argR.found()) {
            argR = memberRange(bytes, scopeStart, scopeEnd, "arguments")
        }
        var argClosed = false
        if (argR.found()) {
            let inner = stringMember(bytes, scopeStart, scopeEnd, "arguments")
            let isStringArgs = argR.closed && bytes[argR.start] == 34 && inner.closed
            if (isStringArgs) {
                // arguments 是字符串：先反转义，再当作一层 JSON 重新扫描
                let raw = safeUtf8(bytes, argR.start + 1, argR.end - 1)
                let decoded = unescapeJson(raw)
                let db = decoded.toArray()
                let innerRoot = objectRange(db, 0)
                if (innerRoot.found()) {
                    collectMembers(db, innerRoot.start, innerRoot.end, v)
                    argClosed = innerRoot.closed
                }
            } else if (bytes[argR.start] == 123) {
                collectMembers(bytes, argR.start, argR.end, v)
                argClosed = argR.closed
            }
        }
        v.complete = closed && v.nameKnown && argR.found() && argClosed
        return v
    }

    /** 收集某个对象里的顶层成员，并把"正在到达"的关键/值填进视图。 */
    private func collectMembers(bytes: Array<UInt8>, start: Int64, end: Int64, v: ToolCallView): Unit {
        var i = start + 1
        // start 就是对象自身的 '{'，i 已经在对象内部 —— 顶层成员所在的层级就是 1。
        var depth: Int64 = 1
        var inStr = false
        var esc = false
        var pendingKey = ""
        var keyStart: Int64 = -1
        while (i < end) {
            let c = bytes[i]
            if (inStr) {
                if (esc) { esc = false }
                else if (c == 92) { esc = true }
                else if (c == 34) {
                    inStr = false
                    if (pendingKey.size == 0 && depth == 1) {
                        let s = safeUtf8(bytes, keyStart + 1, i)
                        if (s.size > 0) {
                            pendingKey = s
                        }
                    }
                }
                i = i + 1
                continue
            }
            if (c == 34) {
                inStr = true
                esc = false
                keyStart = i
                i = i + 1
                continue
            }
            if (c == 123 || c == 91) {
                depth = depth + 1
                i = i + 1
                continue
            }
            if (c == 125 || c == 93) {
                depth = depth - 1
                i = i + 1
                continue
            }
            if (c == 58 && depth == 1 && pendingKey.size > 0) {
                var j = i + 1
                while (j < end && isSpace(bytes[j])) {
                    j = j + 1
                }
                if (j >= end) {
                    v.partialKey = pendingKey
                    v.partialValue = ""
                    return
                }
                if (bytes[j] == 34) {
                    var k = j + 1
                    var e2 = false
                    var closedAt: Int64 = -1
                    while (k < end) {
                        if (e2) { e2 = false }
                        else if (bytes[k] == 92) { e2 = true }
                        else if (bytes[k] == 34) {
                            closedAt = k
                            break
                        }
                        k = k + 1
                    }
                    if (closedAt < 0) {
                        v.partialKey = pendingKey
                        v.partialValue = unescapeJson(safeUtf8(bytes, j + 1, end))
                        return
                    }
                    v.keys.add(pendingKey)
                    v.values.add("\"" + escapeJson(unescapeJson(safeUtf8(bytes, j + 1, closedAt))) + "\"")
                    pendingKey = ""
                    i = closedAt + 1
                    continue
                }
                var k2 = j
                var d2: Int64 = 0
                var closed2: Int64 = -1
                while (k2 < end) {
                    let c2 = bytes[k2]
                    if (c2 == 123 || c2 == 91) {
                        d2 = d2 + 1
                    } else if (c2 == 125 || c2 == 93) {
                        if (d2 == 0) {
                            closed2 = k2
                            break
                        }
                        d2 = d2 - 1
                    } else if (c2 == 44 && d2 == 0) {
                        closed2 = k2
                        break
                    }
                    k2 = k2 + 1
                }
                if (closed2 < 0) {
                    v.partialKey = pendingKey
                    v.partialValue = safeUtf8(bytes, j, end)
                    return
                }
                v.keys.add(pendingKey)
                v.values.add(safeUtf8(bytes, j, closed2))
                pendingKey = ""
                i = closed2 + 1
                continue
            }
            if (c == 44 && depth == 1) {
                pendingKey = ""
            }
            i = i + 1
        }
        v.partialKey = pendingKey
    }

    /** 找到第一个 JSON 对象范围。 */
    private func objectRange(bytes: Array<UInt8>, from: Int64): ScanRange {
        var i = from
        while (i < bytes.size) {
            if (bytes[i] == 123) {
                var depth: Int64 = 0
                var inStr = false
                var esc = false
                var j = i
                while (j < bytes.size) {
                    let c = bytes[j]
                    if (inStr) {
                        if (esc) { esc = false }
                        else if (c == 92) { esc = true }
                        else if (c == 34) { inStr = false }
                    } else {
                        if (c == 34) { inStr = true }
                        else if (c == 123) {
                            depth = depth + 1
                        } else if (c == 125) {
                            depth = depth - 1
                            if (depth == 0) {
                                return ScanRange(i, j + 1, true)
                            }
                        }
                    }
                    j = j + 1
                }
                return ScanRange(i, bytes.size, false)
            }
            i = i + 1
        }
        return ScanRange(-1, -1, false)
    }

    /** 在对象范围内找某个成员（对象或字符串或标量）的值范围。 */
    private func memberRange(bytes: Array<UInt8>, start: Int64, end: Int64, name: String): ScanRange {
        var i = start
        while (i < end) {
            if (bytes[i] == 34) {
                var j = i + 1
                var esc = false
                var closedAt: Int64 = -1
                while (j < end) {
                    if (esc) { esc = false }
                    else if (bytes[j] == 92) { esc = true }
                    else if (bytes[j] == 34) {
                        closedAt = j
                        break
                    }
                    j = j + 1
                }
                if (closedAt < 0) {
                    return ScanRange(-1, -1, false)
                }
                let keyText = safeUtf8(bytes, i + 1, closedAt)
                if (keyText == name) {
                    var k = closedAt + 1
                    while (k < end && isSpace(bytes[k])) {
                        k = k + 1
                    }
                    if (k >= end || bytes[k] != 58) {
                        return ScanRange(-1, -1, false)
                    }
                    var v = k + 1
                    while (v < end && isSpace(bytes[v])) {
                        v = v + 1
                    }
                    if (v >= end) {
                        return ScanRange(-1, -1, false)
                    }
                    if (bytes[v] == 123 || bytes[v] == 91) {
                        let open = bytes[v]
                        let close = if (open == 123) { UInt8(125) } else { UInt8(93) }
                        var depth: Int64 = 0
                        var inStr = false
                        var esc2 = false
                        var m = v
                        while (m < end) {
                            let c = bytes[m]
                            if (inStr) {
                                if (esc2) { esc2 = false }
                                else if (c == 92) { esc2 = true }
                                else if (c == 34) { inStr = false }
                            } else {
                                if (c == 34) {
                                    inStr = true
                                } else if (c == open) {
                                    depth = depth + 1
                                } else if (c == close) {
                                    depth = depth - 1
                                    if (depth == 0) {
                                        return ScanRange(v, m + 1, true)
                                    }
                                }
                            }
                            m = m + 1
                        }
                        return ScanRange(v, end, false)
                    }
                    if (bytes[v] == 34) {
                        var m2 = v + 1
                        var esc3 = false
                        while (m2 < end) {
                            if (esc3) { esc3 = false }
                            else if (bytes[m2] == 92) { esc3 = true }
                            else if (bytes[m2] == 34) {
                                return ScanRange(v, m2 + 1, true)
                            }
                            m2 = m2 + 1
                        }
                        return ScanRange(v, end, false)
                    }
                    var m3 = v
                    while (m3 < end && bytes[m3] != 44 && bytes[m3] != 125) {
                        m3 = m3 + 1
                    }
                    return ScanRange(v, m3, m3 < end)
                }
                i = closedAt + 1
                continue
            }
            i = i + 1
        }
        return ScanRange(-1, -1, false)
    }

    /** 取字符串成员的值。 */
    private func stringMember(bytes: Array<UInt8>, start: Int64, end: Int64, name: String): TextValue {
        let r = memberRange(bytes, start, end, name)
        if (!r.found() || r.start >= bytes.size || bytes[r.start] != 34) {
            return TextValue("", false)
        }
        let to = if (r.closed) { r.end - 1 } else { r.end }
        return TextValue(unescapeJson(safeUtf8(bytes, r.start + 1, to)), r.closed)
    }
}

/** 把字符串重新转义成 JSON 串内容（值要存成 JSON 文本，交给 argsJson 再解析）。 */
func escapeJson(s: String): String {
    let b = s.toArray()
    let sb = StringBuilder()
    var i: Int64 = 0
    while (i < b.size) {
        let c = b[i]
        if (c == 34) {
            sb.append("\\\"")
        } else if (c == 92) {
            sb.append("\\\\")
        } else if (c == 10) {
            sb.append("\\n")
        } else if (c == 13) {
            sb.append("\\r")
        } else if (c == 9) {
            sb.append("\\t")
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
    return sb.toString()
}

func isSpace(b: UInt8): Bool {
    return b == 32 || b == 9 || b == 10 || b == 13
}