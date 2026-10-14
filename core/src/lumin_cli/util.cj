package itn_desktop_core.lumin_cli

import std.collection.*
import std.env.*
import std.fs.*
import std.io.*
import stdx.encoding.json.*
import itn_desktop_core.pi.*

/* CLI 这一层的小工具：URL / JSON / 配置文件 / 家目录。 */

func trimTrailingSlash(s: String): String {
    let b = s.toArray()
    var n = b.size
    while (n > 0 && b[n - 1] == 47) {
        n = n - 1
    }
    return safeUtf8(b, 0, n)
}

/** 显式设 SNI：仓颉的 HTTP 客户端不会自动把域名带进 TLS 握手，缺了会被多数云厂商拒。 */
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

func pickInt(v: JsonValue, path: Array<String>, dflt: Int64): Int64 {
    match (pickPath(v, path)) {
        case Some(x) =>
            match (x) {
                case j: JsonInt => return j.getValue()
                case _ => return dflt
            }
        case None => return dflt
    }
}

/** 整包字节攒完再解码：分片解码会把汉字切断（内核 util.cj 踩过）。 */
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

func preview(s: String, maxBytes: Int64): String {
    let t = trimStr(s)
    if (t.size <= maxBytes) {
        return t
    }
    return safeUtf8(t.toArray(), 0, maxBytes) + " …"
}

func tailBytes(s: String, n: Int64): String {
    let b = s.toArray()
    if (b.size <= n) {
        return s
    }
    return safeUtf8(b, b.size - n, b.size)
}

/** 读 UTF-8 文本文件（中文问题走文件，Windows 下中文进 argv 会让运行时在 main 之前崩）。 */
func readTextFileSafe(path: String, maxBytes: Int64): ?String {
    try {
        let bytes = File.readFrom(path)
        return Some(safeUtf8(bytes, 0, bytes.size))
    } catch (e: Exception) {
        return None
    }
}

func homeDir(): String {
    let a = envOr("USERPROFILE", "")
    if (a.size > 0) {
        return a
    }
    let b = envOr("HOME", "")
    if (b.size > 0) {
        return b
    }
    return "."
}

/* ---------- .env.local（KEY=value） ---------- */

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
}

func loadEnvFile(path: String): EnvFile {
    let out = EnvFile()
    match (readTextFileSafe(path, 64 * 1024)) {
        case Some(text) =>
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
        case None => ()
    }
    return out
}

/** 取值顺序：环境变量 > .env.local > 默认。 */
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
