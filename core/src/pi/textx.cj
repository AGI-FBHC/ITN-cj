package itn_desktop_core.pi

import std.collection.*

/**
 * 纯字符串小工具（运行时与工具层共用）。
 *
 * 放在运行时包里是为了让上层不用各写一份：内核 util.cj 里也有同样几个函数，
 * 合并时二选一即可。
 */

/** 去掉首尾空白（含 \r：SSE 的行尾是 \r\n）。 */
public func trimStr(s: String): String {
    let b = s.toArray()
    var st: Int64 = 0
    var en = b.size
    while (st < en && isSpaceByte(b[st])) {
        st = st + 1
    }
    while (en > st && isSpaceByte(b[en - 1])) {
        en = en - 1
    }
    if (st == 0 && en == b.size) {
        return s
    }
    if (st >= en) {
        return ""
    }
    return safeUtf8(b, st, en)
}

public func isSpaceByte(c: UInt8): Bool {
    return c == 32 || c == 9 || c == 10 || c == 13
}

public func hasPrefix(s: String, p: String): Bool {
    let a = s.toArray()
    let b = p.toArray()
    if (a.size < b.size) {
        return false
    }
    var i: Int64 = 0
    while (i < b.size) {
        if (a[i] != b[i]) {
            return false
        }
        i = i + 1
    }
    return true
}

public func hasSuffix(s: String, p: String): Bool {
    let a = s.toArray()
    let b = p.toArray()
    if (a.size < b.size) {
        return false
    }
    var i: Int64 = 0
    while (i < b.size) {
        if (a[a.size - b.size + i] != b[i]) {
            return false
        }
        i = i + 1
    }
    return true
}

/** 子串位置（字节偏移），找不到返回 -1。 */
public func indexOfSub(s: String, needle: String): Int64 {
    let a = s.toArray()
    let b = needle.toArray()
    if (b.size == 0) {
        return 0
    }
    if (b.size > a.size) {
        return -1
    }
    var i: Int64 = 0
    while (i + b.size <= a.size) {
        var j: Int64 = 0
        var ok = true
        while (j < b.size) {
            if (a[i + j] != b[j]) {
                ok = false
                break
            }
            j = j + 1
        }
        if (ok) {
            return i
        }
        i = i + 1
    }
    return -1
}

public func containsSub(s: String, needle: String): Bool {
    return indexOfSub(s, needle) >= 0
}

/** 按行切分（\n 与 \r\n 都认），行尾分隔符不留在结果里。 */
public func splitLines(text: String): ArrayList<String> {
    let out = ArrayList<String>()
    let b = text.toArray()
    var start: Int64 = 0
    var i: Int64 = 0
    while (i < b.size) {
        if (b[i] == 10) {
            var e = i
            if (e > start && b[e - 1] == 13) {
                e = e - 1
            }
            out.add(safeUtf8(b, start, e))
            start = i + 1
        }
        i = i + 1
    }
    if (start < b.size) {
        out.add(safeUtf8(b, start, b.size))
    }
    return out
}

/** 把 '\' 换成 '/'（Windows 路径归一化用）。 */
public func toSlashes(s: String): String {
    let b = s.toArray()
    let out = StringBuilder()
    var i: Int64 = 0
    while (i < b.size) {
        if (b[i] == 92) {
            out.append("/")
        } else {
            out.append(String.fromUtf8(b[i..i + 1]))
        }
        i = i + 1
    }
    return out.toString()
}
