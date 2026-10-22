package itn_desktop_core.util

import std.fs.*
import std.env.*
import std.convert.*
import std.collection.*
import std.io.*
import stdx.encoding.json.*

public func ensureDir(dir: String): Unit {
    if (!exists(dir)) {
        Directory.create(dir, recursive: true)
    }
}

public func readTextOr(path: String, fallback: String): String {
    if (!exists(path)) {
        return fallback
    }
    return String.fromUtf8(File.readFrom(path))
}

public func writeText(path: String, text: String): Unit {
    File.writeTo(path, text.toArray())
}

/**
 * 按字节数截断字符串，但绝不落在多字节字符中间。
 *
 * 这是一个必须记住的坑：仓颉里 `String.toArray()` 给的是 UTF-8 字节，
 * 直接 `String.fromUtf8(b[0..40])` 一旦把某个汉字切成两半就抛
 * `Invalid utf8 byte sequence` —— 而且是在读取路径上抛，会让整个接口 500。
 * 中文一个字 3 字节，40 字节约等于 13 个字，随便一句中文提问都能踩到。
 */
public func byteSafePrefix(s: String, maxBytes: Int64): String {
    let b = s.toArray()
    if (b.size <= maxBytes) {
        return s
    }
    var end = maxBytes
    while (end > 0 && (b[end] & 192) == 128) {
        end = end - 1
    }
    if (end <= 0) {
        return ""
    }
    return String.fromUtf8(b[0..end])
}

/** 按字节上限切分字符串，但每一段的起止都落在 UTF-8 字符边界上。 */
public func splitUtf8Safe(s: String, maxBytes: Int64): ArrayList<String> {
    let out = ArrayList<String>()
    let bytes = s.toArray()
    if (bytes.size == 0) { return out }
    let limit = if (maxBytes > 0) { maxBytes } else { 1 }
    var start: Int64 = 0
    while (start < bytes.size) {
        var end = start + limit
        if (end > bytes.size) { end = bytes.size }
        if (end < bytes.size) {
            while (end > start && (bytes[end] & 192) == 128) { end = end - 1 }
            if (end == start) {
                end = start + 1
                while (end < bytes.size && (bytes[end] & 192) == 128) { end = end + 1 }
            }
        }
        out.add(String.fromUtf8(bytes[start..end]))
        start = end
    }
    return out
}

public func hasPrefix(s: String, prefix: String): Bool {
    let sb = s.toArray()
    let pb = prefix.toArray()
    if (pb.size > sb.size) {
        return false
    }
    var i = 0
    while (i < pb.size) {
        if (sb[i] != pb[i]) {
            return false
        }
        i = i + 1
    }
    return true
}

public func hasSuffix(s: String, suffix: String): Bool {
    let sb = s.toArray()
    let xb = suffix.toArray()
    if (xb.size > sb.size) {
        return false
    }
    var i = 0
    while (i < xb.size) {
        if (sb[sb.size - xb.size + i] != xb[i]) {
            return false
        }
        i = i + 1
    }
    return true
}

// 同时支持 "--flag value" 与 "--flag=value" 两种写法
public func argValue(args: Array<String>, flag: String): ?String {
    let pref = flag + "="
    var i = 0
    while (i < args.size) {
        if (args[i] == flag && i + 1 < args.size) {
            return Some(args[i + 1])
        }
        if (hasPrefix(args[i], pref)) {
            let ab = args[i].toArray()
            let skip = pref.toArray().size
            return Some(String.fromUtf8(ab[skip..ab.size]))
        }
        i = i + 1
    }
    return None
}

/**
 * 把整个输入流读成字符串。
 *
 * 这里**不能**"每读一块就 String.fromUtf8 一次"：UTF-8 的一个字最多 4 字节，
 * 8KB 的读边界很可能落在一个汉字的中间，那一块单独解码就是非法序列
 * （表现为 "Invalid utf8 byte sequence"，而且只有中文/emoji 响应才会触发）。
 * 正确做法是先把字节攒齐，最后整体转一次。
 */
public func readAllString(input: InputStream): String {
    let out = ArrayList<UInt8>()
    let buf = Array<UInt8>(8192, repeat: 0)
    while (true) {
        let n = input.read(buf)
        if (n <= 0) {
            break
        }
        var i = 0
        while (i < n) {
            out.add(buf[i])
            i = i + 1
        }
    }
    if (out.size == 0) {
        return ""
    }
    return String.fromUtf8(out.toArray())
}

public func defaultDataDir(): String {
    match (getVariable("LOCALAPPDATA")) {
        case Some(v) => v + "\\ITN-Desktop"
        case None => "."
    }
}

/**
 * 默认工作目录：用户没有在设置里指定时，Lumin 就用它。
 *
 * 为什么要有默认值：常规聊天是"整机只读 + 只对默认工作目录可写"，没有这个目录，
 * 常规聊天就变成了纯只读 —— 用户想让 Lumin 帮他把答案写成文件都做不到。
 * 选 Documents\\Lumin 是因为它在用户自己的文档目录里、看得见、可备份，而且不用管理员权限。
 */
public func defaultWorkDir(): String {
    let base = match (getVariable("USERPROFILE")) {
        case Some(v) => v
        case None => "."
    }
    let d = base + "\\Documents\\Lumin"
    try {
        ensureDir(d)
    } catch (e: Exception) {
        ()
    }
    return d
}

// ---------- JSON 取值辅助 ----------

public func strValue(v: JsonValue): String {
    match (v) {
        case s: JsonString => s.getValue()
        case _ => ""
    }
}

public func strOf(o: JsonObject, key: String): String {
    match (o.get(key)) {
        case Some(v) => strValue(v)
        case None => ""
    }
}

public func intOf(o: JsonObject, key: String): Int64 {
    match (o.get(key)) {
        case Some(v) =>
            match (v) {
                case j: JsonInt => j.getValue()
                case _ => 0
            }
        case None => 0
    }
}

public func floatValue(v: JsonValue): Float64 {
    match (v) {
        case f: JsonFloat => f.getValue()
        case i: JsonInt => Float64(i.getValue())
        // 前端有些字段按界面偏好的约定发字符串数字（"663"、"1.15"）—— 必须认。
        // 不认的后果不是报错而是**静默变成 0**：设置怎么改都存不进去（分栏宽度就踩过这条）。
        case s: JsonString =>
            try {
                Float64.parse(trimStr(s.getValue()))
            } catch (e: Exception) {
                0.0
            }
        case _ => 0.0
    }
}

/**
 * 读一个"真假值"。
 *
 * 前端可能发 JSON 布尔（true/false），也可能按界面偏好的约定发字符串 "1"/"0"——
 * 两种都得认。之前只认字符串，于是联网开关怎么点都存不进去（存进去的永远是 false）。
 * 这里不去依赖 JsonBool 的具体取值接口：直接看它的 JSON 文本。
 */
public func boolOf(o: JsonObject, key: String): Bool {
    match (o.get(key)) {
        case Some(v) =>
            let t = trimStr(strValue(v))
            if (t == "1" || t == "true" || t == "yes" || t == "on") {
                return true
            }
            if (t == "0" || t == "false" || t == "no" || t == "off") {
                return false
            }
            let raw = trimStr(v.toString())
            return raw == "true" || raw == "1"
        case None => return false
    }
}

public func objOf(v: JsonValue): ?JsonObject {
    match (v) {
        case o: JsonObject => Some(o)
        case _ => None
    }
}

public func arrOf(v: JsonValue): ?JsonArray {
    match (v) {
        case a: JsonArray => Some(a)
        case _ => None
    }
}

public func strArrayOf(o: JsonObject, key: String): ArrayList<String> {
    let out = ArrayList<String>()
    match (o.get(key)) {
        case Some(v) =>
            match (v) {
                case a: JsonArray =>
                    var i = 0
                    while (i < a.size()) {
                        out.add(strValue(a[i]))
                        i = i + 1
                    }
                case _ => ()
            }
        case None => ()
    }
    return out
}

// ---------- 文本辅助 ----------

public func splitLines(s: String): ArrayList<String> {
    let out = ArrayList<String>()
    let bytes = s.toArray()
    var start = 0
    var i = 0
    while (i < bytes.size) {
        if (bytes[i] == 10) {
            var e = i
            if (e > start && bytes[e - 1] == 13) {
                e = e - 1
            }
            out.add(String.fromUtf8(bytes[start..e]))
            start = i + 1
        }
        i = i + 1
    }
    if (start < bytes.size) {
        out.add(String.fromUtf8(bytes[start..bytes.size]))
    }
    return out
}

/** 读 "a|b|c" 这种键值串里的第 idx 段（读不出来当 0 / 空串）。 */
public func kvInt(parts: Array<String>, idx: Int64): Int64 {
    if (idx >= parts.size) {
        return 0
    }
    try {
        return Int64.parse(trimStr(parts[idx]))
    } catch (e: Exception) {
        return 0
    }
}

public func kvStr(parts: Array<String>, idx: Int64): String {
    if (idx >= parts.size) {
        return ""
    }
    return trimStr(parts[idx])
}

public func trimStr(s: String): String {
    let b = s.toArray()
    var start = 0
    var end = b.size
    while (start < end && (b[start] == 32 || b[start] == 9 || b[start] == 13 || b[start] == 10)) { start = start + 1 }
    while (end > start && (b[end - 1] == 32 || b[end - 1] == 9 || b[end - 1] == 13 || b[end - 1] == 10)) { end = end - 1 }
    return String.fromUtf8(b[start..end])
}

public func joinWith(parts: ArrayList<String>, sep: String): String {
    let sb = StringBuilder()
    var first = true
    for (p in parts) {
        if (!first) { sb.append(sep) }
        sb.append(p)
        first = false
    }
    return sb.toString()
}
