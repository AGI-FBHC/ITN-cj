package lumin.tools

import std.collection.*
import lumin.pi.*

/*
 * 输出截断：常量与策略照 Pi（truncate.ts）。
 *   默认 2000 行 / 50KB；grep 的每一行最多 500 字符。
 * 截断**必须**按字节安全做，否则会把一个汉字切两半（我们已经踩过这个坑）。
 */

public let DEFAULT_MAX_LINES: Int64 = 2000
public let DEFAULT_MAX_BYTES: Int64 = 50 * 1024
public let GREP_MAX_LINE_LENGTH: Int64 = 500

public class Truncation {
    public let content: String
    public let truncated: Bool

    public init(content: String, truncated: Bool) {
        this.content = content
        this.truncated = truncated
    }
}

public func truncateHead(text: String, maxLines: Int64, maxBytes: Int64): Truncation {
    var out = text
    var cut = false
    let lines = splitLines(text)
    if (lines.size > maxLines) {
        let sb = StringBuilder()
        var i: Int64 = 0
        while (i < maxLines) {
            sb.append(lines[i])
            sb.append("\n")
            i = i + 1
        }
        sb.append("...（还有 ")
        sb.append((lines.size - maxLines).toString())
        sb.append(" 行没显示，用 offset/limit 分段读）")
        out = sb.toString()
        cut = true
    }
    if (out.size > maxBytes) {
        out = byteSafePrefix(out, maxBytes) + "\n...（超过 " + formatSize(maxBytes) + "，已截断）"
        cut = true
    }
    return Truncation(out, cut)
}

public func formatSize(n: Int64): String {
    if (n < 1024) {
        return n.toString() + "B"
    }
    if (n < 1024 * 1024) {
        return (n / 1024).toString() + "KB"
    }
    return (n / (1024 * 1024)).toString() + "MB"
}

public func truncateLine(s: String): String {
    if (s.size <= GREP_MAX_LINE_LENGTH) {
        return s
    }
    return byteSafePrefix(s, GREP_MAX_LINE_LENGTH) + "…"
}

/** UTF-8 首字节 -> 该字符占几个字节（非法按 1，保证不越界）。tools 包里自己带一份，避免跨包依赖。 */
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

/** glob -> 正则（find/grep 的过滤器用）。支持 * ? ** 与 **\/。 */
public func globToRegex(pat: String): String {
    let b = pat.toArray()
    let sb = StringBuilder()
    sb.append("^")
    var i = 0
    while (i < b.size) {
        let c = b[i]
        if (c == 42) {
            if (i + 1 < b.size && b[i + 1] == 42) {
                if (i + 2 < b.size && b[i + 2] == 47) {
                    sb.append("(.*/)?")
                    i = i + 2
                } else {
                    sb.append(".*")
                    i = i + 1
                }
            } else {
                sb.append("[^/]*")
            }
        } else if (c == 63) {
            sb.append("[^/]")
        } else if (c == 46) {
            sb.append("\\.")
        } else if (c == 47 || c == 45 || c == 95 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
            sb.append(String.fromUtf8(b[i..i + 1]))
        } else if (c < 128) {
            sb.append("\\")
            sb.append(String.fromUtf8(b[i..i + 1]))
        } else {
            // 非 ASCII 字符整块追加（逐字节解码会抛 Invalid utf8）
            var j = i + utf8CharLen(c)
            if (j > b.size) {
                j = b.size
            }
            sb.append(String.fromUtf8(b[i..j]))
            i = j
            continue
        }
        i = i + 1
    }
    sb.append("$")
    return sb.toString()
}
