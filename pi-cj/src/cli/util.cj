package pi_cj.cli

import std.collection.*
import std.env.*
import std.fs.*
import std.io.*
import stdx.encoding.json.*
import pi_cj.pi.*

/* 命令行这一层用到的小工具：SSE/URL/JSON 取值/配置文件。 */

func trimTrailingSlash(s: String): String {
    let b = s.toArray()
    var n = b.size
    while (n > 0 && b[n - 1] == 47) {
        n = n - 1
    }
    return safeUtf8(b, 0, n)
}

/** 从 url 里取主机名：必须显式设 SNI，否则多数云厂商会以 internal error 拒绝握手。 */
func hostOf(url: String): String {
    let b = url.toArray()
    var i = 0
    while (i + 2 < b.size) {
        if (b[i] == 58 && b[i + 1] == 47 && b[i + 2] == 47) {
            i = i + 3
            break
        }
        i = i + 1
    }
    let start = i
    var end = b.size
    var j = i
    while (j < b.size) {
        if (b[j] == 47 || b[j] == 58) {
            end = j
            break
        }
        j = j + 1
    }
    return safeUtf8(b, start, end)
}

func decIndex(s: String): Int64 {
    let b = s.toArray()
    if (b.size == 0) {
        return -1
    }
    var n: Int64 = 0
    var i: Int64 = 0
    while (i < b.size) {
        if (b[i] < 48 || b[i] > 57) {
            return -1
        }
        n = n * 10 + (Int64(b[i]) - 48)
        i = i + 1
    }
    return n
}

/** 按路径取值：对象按 key、数组按下标（十进制字符串）。 */
func pickPath(v: JsonValue, path: Array<String>): ?JsonValue {
    var cur = v
    for (key in path) {
        match (cur) {
            case o: JsonObject =>
                match (o.get(key)) {
                    case Some(nx) => cur = nx
                    case None => return None
                }
            case a: JsonArray =>
                let idx = decIndex(key)
                if (idx < 0 || idx >= a.size()) {
                    return None
                }
                cur = a[idx]
            case _ => return None
        }
    }
    return Some(cur)
}

func pickStr(v: JsonValue, path: Array<String>): String {
    match (pickPath(v, path)) {
        case Some(x) =>
            match (x) {
                case s: JsonString => return s.getValue()
                case _ => return ""
            }
        case None => return ""
    }
}

/** 整包字节先攒着再解码：分片解码会把汉字切断（内核 util.cj 踩过这个坑）。 */
func readAllStringSafe(input: InputStream): String {
    let raw = ArrayList<UInt8>()
    let buf = Array<UInt8>(4096, repeat: 0)
    while (true) {
        let n = input.read(buf)
        if (n <= 0) {
            break
        }
        var i = 0
        while (i < n) {
            raw.add(buf[i])
            i = i + 1
        }
    }
    return safeUtf8(raw.toArray(), 0, raw.size)
}

func envOr(name: String, dflt: String): String {
    match (getVariable(name)) {
        case Some(v) => return v
        case None => return dflt
    }
}

func argValue(args: Array<String>, name: String): ?String {
    var i: Int64 = 0
    while (i < args.size) {
        if (args[i] == name && i + 1 < args.size) {
            return Some(args[i + 1])
        }
        i = i + 1
    }
    return None
}

func hasFlag(args: Array<String>, name: String): Bool {
    for (a in args) {
        if (a == name) {
            return true
        }
    }
    return false
}

/**
 * 剥掉模型爱加的代码围栏。
 *
 * 提示词里明明写了"不要加围栏"，真模型还是会加 —— 加了也得能认出来，
 * 否则这段 JSON 会被当成"回答"直接摆给用户看。
 */
func stripFence(s: String): String {
    var t = trimStr(s)
    if (hasPrefix(t, "```")) {
        let b = t.toArray()
        var i = 0
        while (i < b.size && b[i] != 10) {
            i = i + 1
        }
        if (i < b.size) {
            i = i + 1
        }
        t = trimStr(safeUtf8(b, i, b.size))
    }
    if (t.size >= 3) {
        let b = t.toArray()
        if (b[b.size - 1] == 96 && b[b.size - 2] == 96 && b[b.size - 3] == 96) {
            t = trimStr(safeUtf8(b, 0, b.size - 3))
        }
    }
    return t
}

func startsWithBrace(s: String): Bool {
    let b = trimStr(s).toArray()
    return b.size > 0 && b[0] == 123
}

/**
 * 读一个 UTF-8 文本文件（配置、问题文件）。
 *
 * 为什么要走"文件"这条路：Windows 下命令行参数里的中文会让仓颉运行时**在 main 之前**
 * 就抛 "Invalid unicode scalar value"（argv 按 ANSI 码页解成 UTF-8 失败）。
 * 所以脚本化场景一律从文件或标准输入拿文本，别把中文塞进 argv。
 */
func readTextFileSafe(path: String, maxBytes: Int64): ?String {
    try {
        let bytes = File.readFrom(path)
        return Some(safeUtf8(bytes, 0, bytes.size))
    } catch (e: Exception) {
        return None
    }
}

/** 取末尾若干字节（调用 id 全是以 call_ 开头，看尾巴更有辨识度，也避免切断汉字）。 */
func tailBytes(s: String, n: Int64): String {
    let b = s.toArray()
    if (b.size <= n) {
        return s
    }
    return safeUtf8(b, b.size - n, b.size)
}

/** 展示用截断（不切汉字）。 */
func preview(s: String, maxBytes: Int64): String {
    let t = trimStr(s)
    if (t.size <= maxBytes) {
        return t
    }
    return safeUtf8(t.toArray(), 0, maxBytes) + " …（还有 " + (t.size - maxBytes).toString() + " 字节）"
}

/* ---------- 配置文件：键值对两列表，避免依赖 HashMap 的具体 API ---------- */

class EnvFile {
    private let keys = ArrayList<String>()
    private let vals = ArrayList<String>()

    public init() {}

    public func get(k: String): ?String {
        var i = 0
        while (i < keys.size) {
            if (keys[i] == k) {
                return Some(vals[i])
            }
            i = i + 1
        }
        return None
    }

    public func put(k: String, v: String): Unit {
        keys.add(k)
        vals.add(v)
    }

    public func size(): Int64 {
        return keys.size
    }
}

/** 读 .env.local（KEY=value，# 开头是注释）。文件不存在就返回空表。 */
func loadEnvFile(path: String): EnvFile {
    let out = EnvFile()
    var text = ""
    try {
        text = safeUtf8(File.readFrom(path), 0, 65536)
    } catch (e: Exception) {
        return out
    }
    for (line in splitLines(text)) {
        let t = trimStr(line)
        if (t.size == 0 || hasPrefix(t, "#")) {
            continue
        }
        let idx = indexOfSub(t, "=")
        if (idx <= 0) {
            continue
        }
        let k = trimStr(safeUtf8(t.toArray(), 0, idx))
        let v = trimStr(safeUtf8(t.toArray(), idx + 1, t.size))
        if (k.size > 0) {
            out.put(k, v)
        }
    }
    return out
}

/** 配置取值顺序：环境变量 > .env.local > 内置默认（两处的键名相同）。 */
func cfgValue(env: EnvFile, name: String, dflt: String): String {
    let fromEnv = envOr(name, "")
    if (fromEnv.size > 0) {
        return fromEnv
    }
    match (env.get(name)) {
        case Some(v) =>
            if (v.size > 0) {
                return v
            }
            return dflt
        case None => return dflt
    }
}
