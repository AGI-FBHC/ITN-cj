package lumin.tools

import std.collection.*
import std.env.*
import std.fs.*
import std.posix.*
import std.process.*
import std.sync.*
import std.time.*
import std.time.*
import lumin.pi.*

/*
 * 工作区：所有文件/命令工具都被关在这个目录里（这是我们的收紧，Pi 是直接用进程的系统权限）。
 * 模型给的是相对路径，先归一化（反斜杠当分隔符、消掉 . 与 .. 段），
 * 越界、带盘符、带冒号一律拒绝；命令的 cwd 也钉在工作区里。
 */

/**
 * 文件写入串行化。
 * Pi 有 file-mutation-queue.ts 做同一件事：并行执行工具时，两个写操作不能同时改同一个文件。
 * 读操作不锁（Pi 也不锁），所以"读到的可能是半旧内容"这一点两边一样。
 */
let FILE_MUTEX = Mutex()

public class Workspace {
    public let root: String
    /**
     * 保护目录（绝对路径前缀）：CLI 的数据目录（trust.json / workspaces.json / 会话文件）在里面，
     * 落在这些前缀下的路径一律拒绝。
     */
    private var denyRoots = ArrayList<String>()
    /** 明确不许读的文件（绝对路径）：就是模型自己在用的那份配置（.env.local） */
    private var denyFiles = ArrayList<String>()
    /**
     * 权限档位：ask（默认，沙箱在）/ auto / full。
     * ask 之外的档位不再把路径限制在工作区内（对齐 Codex 的"完全访问权限"），
     * 只保留"不交出自己在用的 Key"这一条红线。
     */
    public var level: String = "ask"
    public let maxListEntries: Int64 = 500
    public let maxFindResults: Int64 = 1000
    public let maxGrepMatches: Int64 = 100
    public let maxScanBytes: Int64 = 512 * 1024

    public init(root: String) {
        this.root = stripTrailingSeps(absNorm(root))
    }

    public init(root: String, denyRoots: ArrayList<String>) {
        this.root = stripTrailingSeps(absNorm(root))
        for (d in denyRoots) {
            if (d.size > 0) {
                this.denyRoots.add(stripTrailingSeps(absNorm(d)))
            }
        }
    }

    public init(root: String, denyRoots: ArrayList<String>, denyFiles: ArrayList<String>, level: String) {
        this.root = stripTrailingSeps(absNorm(root))
        this.level = level
        for (d in denyRoots) {
            if (d.size > 0) {
                this.denyRoots.add(stripTrailingSeps(absNorm(d)))
            }
        }
        for (f in denyFiles) {
            if (f.size > 0) {
                this.denyFiles.add(stripTrailingSeps(absNorm(f)))
            }
        }
    }

    /** 是否把路径关在工作区内（只有 ask 档关）。 */
    public func sandboxed(): Bool {
        return level == "ask"
    }

    /**
     * 拒绝原因（空串 = 允许）：越出工作区、或命中敏感路径/保护目录。
     *
     * 敏感路径 = 任何一段以 .env 开头、或叫 .git / .ssh / trust.json / workspaces.json。
     * 为什么比 Pi 严：Pi 不拦这些（它信任"项目里的可执行资源"，工具用进程系统权限），
     * 而我们的 Key 就在项目里的 .env.local，默认工作区又是启动目录 —— 不拦等于把 Key 摆在模型面前。
     */
    public func denyReason(rel: String): String {
        let t = trimStr(rel)
        if (t.size == 0) {
            return ""
        }
        var full = ""
        if (!sandboxed()) {
            full = joinAbs(t)
        } else {
            match (normalizeRel(t)) {
                case None => return "路径越出工作区，拒绝访问"
                case Some(n) =>
                    // 沙箱档额外遮住敏感路径
                    if (hasSensitiveSegment(n)) {
                        return "这是敏感路径（.env / .git / .ssh 之类），已拒绝访问"
                    }
                    full = if (n.size == 0) { root } else { root + "/" + n }
            }
        }
        // 任何档位都不交出去的红线：模型自己在用的配置 + 数据目录
        let norm = stripTrailingSeps(absNorm(full))
        for (f in denyFiles) {
            if (norm == f) {
                return "这是模型自己在用的配置文件（里面有 API Key），拒绝访问"
            }
        }
        for (d in denyRoots) {
            if (hasPrefix(norm, d)) {
                return "这个路径在受保护目录里（放着模型的配置与会话），拒绝访问"
            }
        }
        return ""
    }

    public func relOf(rel: String): String {
        match (normalizeRel(rel)) {
            case Some(n) => return n
            case None => return rel
        }
    }

    public func resolve(rel: String): ?String {
        if (!sandboxed()) {
            // 非沙箱档：绝对路径直接用；相对路径挂到工作区上（.. 交给系统解析，就是要能走出去）
            let t = trimStr(rel)
            if (t.size == 0) {
                return Some(root)
            }
            return Some(joinAbs(t))
        }
        match (normalizeRel(rel)) {
            case Some(n) =>
                if (n.size == 0) {
                    return Some(root)
                }
                return Some(root + "/" + n)
            case None => return None
        }
    }

    /** 绝对路径原样；相对路径接到 root 后面。 */
    private func joinAbs(t: String): String {
        let b = t.toArray()
        if (b.size >= 2 && b[1] == 58) {
            return t
        }
        if (b[0] == 47 || b[0] == 92) {
            return t
        }
        return root + "/" + t
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
                FILE_MUTEX.lock()
                try {
                    File.writeTo(full, text.toArray())
                    return true
                } catch (e: Exception) {
                    return false
                } finally {
                    FILE_MUTEX.unlock()
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
     * 在工作区里跑 PowerShell 命令（可选超时，与 Pi 的 bash/powershell 同参数）。
     *
     * 实现要点：std.process 的 executeWithOutput 不带 timeout，所以这里用
     * Process.start + 一个读线程把管道抽干（否则输出超过管道缓冲会卡住子进程）+
     * 主线程 wait(timeout) 计时；超时就 terminate(force) 杀掉再返回。
     */
    public func runPowerShell(cmd: String, rel: String, timeoutSec: Int64): CmdOutcome {
        var dir: ?Path = None
        match (resolve(rel)) {
            case Some(d) => dir = Some(Path(d))
            case None => dir = Some(Path(root))
        }
        let start = nowMillis()
        // Pi 在命令前插一句把控制台输出编码设成 UTF-8 —— Windows 上不设，中文输出就是乱码
        let prefix = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n"
        if (timeoutSec <= 0) {
            // 没给超时：用 executeWithOutput。它会把 stdout/stderr 接管并返回三元组；
            // Process.start 默认**不接管管道**（实测输出会漏到控制台、waitOutput 拿到空），所以这里不能用它。
            try {
                let (code, out, err) = executeWithOutput("powershell",
                    ["-NoProfile", "-NonInteractive", "-Command", prefix + cmd], workingDirectory: dir)
                return CmdOutcome(code, cap(safeUtf8(out, 0, out.size)), cap(safeUtf8(err, 0, err.size)),
                    nowMillis() - start, false)
            } catch (ex: Exception) {
                return CmdOutcome(-1, "", "命令没能正常结束：" + ex.message, nowMillis() - start, false)
            }
        }
        // 给了超时：没有带 timeout 的 executeWithOutput，只能自己起进程 + 计时 + 超时杀。
        // 输出让 PowerShell 重定向到临时文件（与 Pi 的 bash 一样输出是 stdout+stderr 合并的）。
        let tmp = tempFilePath()
        let script = prefix + "& { " + cmd + " } *>&1 | Out-File -FilePath '" + tmp + "' -Encoding utf8\n" +
            "if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE } else { exit 0 }"
        try {
            let proc = Process.start("powershell", ["-NoProfile", "-NonInteractive", "-Command", script])
            var code: Int64 = -1
            try {
                code = proc.wait(timeout: Duration.second * timeoutSec)
            } catch (ex: Exception) {
                try {
                    proc.terminate(force: true)
                } catch (e2: Exception) {
                    ()
                }
                return CmdOutcome(-1, readTmp(tmp), "命令超过 " + timeoutSec.toString() +
                    " 秒还没结束，已终止（输出是终止前写下的部分）", nowMillis() - start, true)
            }
            return CmdOutcome(code, cap(readTmp(tmp)), "", nowMillis() - start, false)
        } catch (ex: Exception) {
            return CmdOutcome(-1, "", "命令没能启动：" + ex.message, nowMillis() - start, false)
        }
    }

    private func readTmp(path: String): String {
        try {
            return cap(safeUtf8(File.readFrom(path), 0, 2 * 1024 * 1024))
        } catch (e: Exception) {
            return ""
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
    public let timedOut: Bool

    public init(code: Int64, out: String, err: String, wallMs: Int64, timedOut: Bool) {
        this.code = code
        this.out = out
        this.err = err
        this.wallMs = wallMs
        this.timedOut = timedOut
    }
}


/** 归一成"绝对路径 + 正斜杠"：工作区与红线名单两边都过这一遍，字符串才可直接比。 */
func absNorm(p: String): String {
    let t = trimStr(p)
    if (t.size == 0) {
        return toSlashes(getcwd().toString())
    }
    let b = t.toArray()
    if (b.size >= 2 && b[1] == 58) {
        return toSlashes(t)
    }
    if (b[0] == 47 || b[0] == 92) {
        return toSlashes(t)
    }
    return toSlashes(getcwd().toString()) + "/" + toSlashes(t)
}

/** 路径里有没有敏感段（.env*、.git、.ssh、CLI 数据文件名）。 */
func hasSensitiveSegment(rel: String): Bool {
    let b = rel.toArray()
    var start: Int64 = 0
    var i: Int64 = 0
    while (i <= b.size) {
        if (i == b.size || b[i] == 47 || b[i] == 92) {
            let seg = safeUtf8(b, start, i)
            if (hasPrefix(seg, ".env") || seg == ".git" || seg == ".ssh" ||
                seg == "trust.json" || seg == "workspaces.json") {
                return true
            }
            start = i + 1
        }
        i = i + 1
    }
    return false
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

/** 临时文件路径（超时路径下用文件接命令输出；名字带毫秒，避免并行调用互相覆盖）。 */
func tempFilePath(): String {
    var dir = ""
    match (getVariable("TEMP")) {
        case Some(v) =>
            if (v.size > 0) {
                dir = v
            }
        case None => ()
    }
    if (dir.size == 0) {
        match (getVariable("TMP")) {
            case Some(v2) =>
                if (v2.size > 0) {
                    dir = v2
                }
            case None => ()
        }
    }
    if (dir.size == 0) {
        dir = "."
    }
    return dir + "/lumin-cmd-" + (nowMillis() % 100000000).toString() + ".txt"
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
