package pi_cj.tools

import std.collection.*
import std.fs.*
import std.process.*
import std.time.*
import pi_cj.pi.*

/*
 * 工作区：所有文件/命令工具都被关在这个目录里（这是我们的收紧，Pi 是直接用进程的系统权限）。
 * 模型给的是相对路径，先归一化（反斜杠当分隔符、消掉 . 与 .. 段），
 * 越界、带盘符、带冒号一律拒绝；命令的 cwd 也钉在工作区里。
 */

public class Workspace {
    public let root: String
    public let maxListEntries: Int64 = 500
    public let maxFindResults: Int64 = 1000
    public let maxGrepMatches: Int64 = 100
    public let maxScanBytes: Int64 = 512 * 1024

    public init(root: String) {
        this.root = stripTrailingSeps(root)
    }

    public func relOf(rel: String): String {
        match (normalizeRel(rel)) {
            case Some(n) => return n
            case None => return ""
        }
    }

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
                    return Some(safeUtf8(File.readFrom(full), 0, 32 * 1024 * 1024))
                } catch (e: Exception) {
                    return None
                }
            case None => return None
        }
    }

    public func writeText(rel: String, text: String): Bool {
        match (resolve(rel)) {
            case Some(full) =>
                let slash = lastSlashOf(full)
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

    /** 列目录（只列一层，名字后面带 / 表示目录）。 */
    public func list(rel: String, limit: Int64): ArrayList<String> {
        let out = ArrayList<String>()
        match (resolve(rel)) {
            case Some(full) =>
                if (!exists(full)) {
                    return out
                }
                try {
                    Directory.walk(Path(full), { fi: FileInfo =>
                        if (out.size < limit) {
                            let nm = fi.name
                            if (fi.isDirectory()) {
                                out.add(nm + "/")
                            } else {
                                out.add(nm + "  " + formatSize(fi.size))
                            }
                        }
                        true
                    })
                } catch (e: Exception) {
                    ()
                }
            case None => ()
        }
        return out
    }

    /** 递归列出文件（相对路径，跳过噪声目录）。 */
    public func walkFiles(rel: String, maxFiles: Int64): ArrayList<String> {
        let out = ArrayList<String>()
        walkInto(relOf(rel), maxFiles, out)
        return out
    }

    private func walkInto(cur: String, maxFiles: Int64, out: ArrayList<String>): Unit {
        if (out.size >= maxFiles) {
            return
        }
        let full = if (cur.size == 0) { root } else { root + "/" + cur }
        let dirs = ArrayList<String>()
        try {
            Directory.walk(Path(full), { fi: FileInfo =>
                let nm = fi.name
                if (fi.isDirectory()) {
                    if (!skipDirName(nm)) {
                        dirs.add(nm)
                    }
                } else {
                    if (out.size < maxFiles) {
                        out.add(if (cur.size == 0) { nm } else { cur + "/" + nm })
                    }
                }
                true
            })
        } catch (e: Exception) {
            ()
        }
        for (d in dirs) {
            if (out.size >= maxFiles) {
                return
            }
            walkInto(if (cur.size == 0) { d } else { cur + "/" + d }, maxFiles, out)
        }
    }

    public func sizeOf(rel: String): Int64 {
        match (resolve(rel)) {
            case Some(full) =>
                try {
                    Directory.walk(Path(full), { fi: FileInfo =>
                        if (!fi.isDirectory() && fi.size > 0) {
                            ()
                        }
                        true
                    })
                } catch (e: Exception) {
                    ()
                }
                return 0
            case None => return 0
        }
    }

    /**
     * 在工作区里跑 PowerShell 命令。
     *
     * 已知缺口：这版 std.process 的 executeWithOutput 不带 timeout 参数（Pi 的 bash/powershell 有），
     * 所以交互式/常驻命令会一直挂着 —— 工具说明里已经警告模型别这么干。
     */
    public func runPowerShell(cmd: String, rel: String): CmdOutcome {
        var dir: ?Path = None
        match (resolve(rel)) {
            case Some(d) => dir = Some(Path(d))
            case None => dir = Some(Path(root))
        }
        let start = nowMillis()
        // Pi 在命令前插一句把控制台输出编码设成 UTF-8 —— Windows 上不设，中文输出就是乱码
        let prefix = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n"
        try {
            let (code, out, err) = executeWithOutput("powershell",
                ["-NoProfile", "-NonInteractive", "-Command", prefix + cmd], workingDirectory: dir)
            return CmdOutcome(code, cap(safeUtf8(out, 0, out.size)), cap(safeUtf8(err, 0, err.size)),
                nowMillis() - start)
        } catch (ex: Exception) {
            return CmdOutcome(-1, "", "命令没能正常结束：" + ex.message, nowMillis() - start)
        }
    }

    public func cap(s: String): String {
        return byteSafePrefix(s, 50 * 1024)
    }
}

public class CmdOutcome {
    public let code: Int64
    public let out: String
    public let err: String
    public let wallMs: Int64

    public init(code: Int64, out: String, err: String, wallMs: Int64) {
        this.code = code
        this.out = out
        this.err = err
        this.wallMs = wallMs
    }
}

/** 这些目录不列也不搜。 */
func skipDirName(nm: String): Bool {
    let nb = nm.toArray()
    if (nb.size == 0 || nb[0] == 46) {
        return true
    }
    return nm == "node_modules" || nm == "target" || nm == "dist" || nm == "build" ||
        nm == "venv" || nm == "__pycache__" || nm == "artifacts" || nm == "out"
}

func stripTrailingSeps(s: String): String {
    let b = s.toArray()
    var n = b.size
    while (n > 1 && (b[n - 1] == 47 || b[n - 1] == 92)) {
        n = n - 1
    }
    return safeUtf8(b, 0, n)
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

/** 归一化相对路径：越界（.. 多到栈空）、带盘符或冒号都返回 None。 */
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
                } else if (hasColonOf(seg)) {
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

func hasColonOf(s: String): Bool {
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
