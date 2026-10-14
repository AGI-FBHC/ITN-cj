package pi_cj.tools

import std.collection.*
import std.fs.*
import std.process.*
import pi_cj.pi.*

/**
 * 工作区：所有文件/命令工具都被关在这个目录里。
 *
 * 这是"工具权限"最实在的一条：模型给的是相对路径，先归一化（反斜杠当分隔符、
 * 消掉 . 和 .. 段），任何越出工作区、带盘符或带冒号的写法一律拒绝，
 * 而不是"提示它别这么干"。命令的 cwd 也钉在工作区里。
 */
public class Workspace {
    public let root: String
    public let maxReadBytes: Int64 = 32768
    public let maxListEntries: Int64 = 400
    public let maxOutputBytes: Int64 = 12000
    public let maxMatches: Int64 = 120
    public let maxScanBytes: Int64 = 262144

    public init(root: String) {
        this.root = stripTrailingSeps(root)
    }

    /** 归一化后的相对路径（用于展示与检索结果）。 */
    public func relOf(rel: String): String {
        match (normalizeRel(rel)) {
            case Some(n) => return n
            case None => return ""
        }
    }

    /** 相对路径 -> 工作区内的实际路径；越界返回 None。 */
    public func resolve(rel: String): ?String {
        match (normalizeRel(rel)) {
            case Some(n) =>
                if (n.size == 0) {
                    return Some(root)
                }
                return Some(root + "/" + n)
            case None => return None
        }
    }

    public func readText(rel: String): ?String {
        match (resolve(rel)) {
            case Some(full) =>
                try {
                    let bytes = File.readFrom(full)
                    if (bytes.size > maxReadBytes) {
                        return Some(safeUtf8(bytes, 0, maxReadBytes) + "\n\n（文件较大，只给了前 " +
                            maxReadBytes.toString() + " 字节）")
                    }
                    return Some(safeUtf8(bytes, 0, bytes.size))
                } catch (e: Exception) {
                    return None
                }
            case None => return None
        }
    }

    public func writeText(rel: String, text: String): Bool {
        match (resolve(rel)) {
            case Some(full) =>
                let slash = lastSlash(full)
                if (slash > 0) {
                    let parent = safeUtf8(full.toArray(), 0, slash)
                    if (!exists(parent)) {
                        try {
                            Directory.create(parent, recursive: true)
                        } catch (e: Exception) {
                            return false
                        }
                    }
                }
                try {
                    File.writeTo(full, text.toArray())
                    return true
                } catch (e: Exception) {
                    return false
                }
            case None => return false
        }
    }

    public func list(rel: String, recursive: Bool): ArrayList<String> {
        let out = ArrayList<String>()
        walkInto(relOf(rel), recursive, out)
        return out
    }

    public func search(query: String, rel: String): ArrayList<String> {
        let hits = ArrayList<String>()
        searchInto(relOf(rel), query, hits)
        return hits
    }

    /** 在工作区里跑一条命令（cmd /c），返回 (退出码, 输出)。 */
    public func run(cmd: String, rel: String): CmdOutcome {
        let cwd = resolve(rel)
        var dir: ?Path = None
        match (cwd) {
            case Some(d) => dir = Some(Path(d))
            case None => dir = Some(Path(root))
        }
        try {
            let (code, out, err) = executeWithOutput("cmd", ["/c", cmd], workingDirectory: dir)
            let o = cap(safeUtf8(out, 0, out.size))
            let e = cap(safeUtf8(err, 0, err.size))
            return CmdOutcome(code, o, e)
        } catch (ex: Exception) {
            return CmdOutcome(-1, "", "命令没能启动：" + ex.message)
        }
    }

    private func cap(s: String): String {
        let b = s.toArray()
        if (b.size <= maxOutputBytes) {
            return s
        }
        return safeUtf8(b, 0, maxOutputBytes) + "\n（输出过长，已截断）"
    }

    private func walkInto(cur: String, recursive: Bool, out: ArrayList<String>): Unit {
        if (out.size >= maxListEntries) {
            return
        }
        let full = if (cur.size == 0) { root } else { root + "/" + cur }
        try {
            Directory.walk(Path(full), { fi: FileInfo =>
                let nm = fi.name
                let childRel = if (cur.size == 0) { nm } else { cur + "/" + nm }
                if (fi.isDirectory()) {
                    if (!skipDirName(nm)) {
                        out.add(childRel + "/")
                        if (recursive) {
                            walkInto(childRel, recursive, out)
                        }
                    }
                } else {
                    out.add(childRel + "  " + fi.size.toString() + " 字节")
                }
                true
            })
        } catch (e: Exception) {
            ()
        }
    }

    private func searchInto(cur: String, query: String, hits: ArrayList<String>): Unit {
        if (hits.size >= maxMatches) {
            return
        }
        let full = if (cur.size == 0) { root } else { root + "/" + cur }
        try {
            Directory.walk(Path(full), { fi: FileInfo =>
                let nm = fi.name
                let childRel = if (cur.size == 0) { nm } else { cur + "/" + nm }
                if (fi.isDirectory()) {
                    if (!skipDirName(nm)) {
                        searchInto(childRel, query, hits)
                    }
                } else if (fi.size <= maxScanBytes && isTextName(nm)) {
                    scanFile(childRel, query, hits)
                }
                true
            })
        } catch (e: Exception) {
            ()
        }
    }

    private func scanFile(rel: String, query: String, hits: ArrayList<String>): Unit {
        var text = ""
        try {
            text = safeUtf8(File.readFrom(root + "/" + rel), 0, maxReadBytes * 4)
        } catch (e: Exception) {
            return
        }
        let lines = splitLines(text)
        var i = 0
        while (i < lines.size && hits.size < maxMatches) {
            if (containsSub(lines[i], query)) {
                hits.add(rel + ":" + (i + 1).toString() + ": " + trimStr(byteSafePrefix(trimStr(lines[i]), 200)))
            }
            i = i + 1
        }
    }
}

public class CmdOutcome {
    public let code: Int64
    public let out: String
    public let err: String

    public init(code: Int64, out: String, err: String) {
        this.code = code
        this.out = out
        this.err = err
    }
}

/** 这些目录不列也不搜：列出来只会把真正有用的内容挤掉。 */
func skipDirName(nm: String): Bool {
    let nb = nm.toArray()
    if (nb.size == 0 || nb[0] == 46) {
        return true
    }
    return nm == "node_modules" || nm == "target" || nm == "dist" || nm == "build" ||
        nm == "venv" || nm == "__pycache__" || nm == "artifacts"
}

func isTextName(nm: String): Bool {
    let lower = nm.toAsciiLower()
    let exts = [".md", ".txt", ".json", ".cj", ".py", ".js", ".ts", ".vue", ".html", ".css",
        ".yml", ".yaml", ".toml", ".xml", ".csv", ".log", ".sh", ".ps1", ".bat", ".sql", ".ini", ".conf"]
    for (e in exts) {
        if (hasSuffix(lower, e)) {
            return true
        }
    }
    return false
}

func stripTrailingSeps(s: String): String {
    let b = s.toArray()
    var n = b.size
    while (n > 1 && (b[n - 1] == 47 || b[n - 1] == 92)) {
        n = n - 1
    }
    return safeUtf8(b, 0, n)
}

func lastSlash(s: String): Int64 {
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

/**
 * 归一化相对路径：反斜杠当分隔符、丢掉 . 段、用栈消掉 .. 段。
 * 越出工作区（.. 多到栈空）、带盘符或冒号、空路径都返回 None。
 */
public func normalizeRel(rel: String): ?String {
    let b = rel.toArray()
    var stack = ""
    var start: Int64 = 0
    var i: Int64 = 0
    while (i <= b.size) {
        let atEnd = i == b.size
        let isSep = !atEnd && (b[i] == 47 || b[i] == 92)
        if (atEnd || isSep) {
            let seg = trimStr(safeUtf8(b, start, i))
            if (seg.size > 0 && seg != ".") {
                if (seg == "..") {
                    if (stack.size == 0) {
                        return None
                    }
                    let ob = stack.toArray()
                    var e = ob.size
                    while (e > 0 && ob[e - 1] != 47) {
                        e = e - 1
                    }
                    if (e > 0) {
                        e = e - 1
                    }
                    stack = safeUtf8(ob, 0, e)
                } else if (hasColon(seg)) {
                    return None
                } else {
                    if (stack.size > 0) {
                        stack = stack + "/"
                    }
                    stack = stack + seg
                }
            }
            start = i + 1
        }
        i = i + 1
    }
    return Some(stack)
}

func hasColon(s: String): Bool {
    let b = s.toArray()
    var i: Int64 = 0
    while (i < b.size) {
        if (b[i] == 58) {
            return true
        }
        i = i + 1
    }
    return false
}
