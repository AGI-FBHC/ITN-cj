package itn_desktop_core.pi_tools

import std.collection.*
import std.env.*
import std.fs.*
import std.posix.*
import std.process.*
import std.sync.*
import std.time.*
import std.time.*
import itn_desktop_core.pi.*

/*
 * 工作区（沙箱）：**只隔离写，不隔离读**。
 *   - 读：denyReasonRead —— 整台机器都能读，只有两条红线（模型自己在用的含 Key 的配置、CLI 数据目录）；
 *   - 写：denyReason —— ask 档只在工作区内写，越界要审批层批准过（allowWriteAt）才放行；
 *     工作区内的敏感段（.env/.git/.ssh）照旧拒绝。auto / full 档写不设界。
 * 模型给的是相对路径，先归一化（反斜杠当分隔符、消掉 . 与 .. 段）；命令的 cwd 钉在工作区里。
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
     * 沙箱档（ask）里"已批准的越界写目录"（绝对路径前缀）。
     * 审批层放行一次 path-outside 就往这里加一条 —— 否则会出现"问过了却被沙箱拒"的矛盾。
     */
    private var writeApproved = ArrayList<String>()
    /**
     * 权限档位：ask（默认，沙箱在）/ auto / full。
     * ask 之外的档位不再把路径限制在工作区内（对齐 Codex 的"完全访问权限"），
     * 只保留"不交出自己在用的 Key"这一条红线。
     */
    public var level: String = "ask"
    /**
     * 常规聊天：只对工作目录可写，工作目录之外一律拒绝（连"问一下就能批"都没有）。
     *
     * 与 Work 会话的差别就在这里：Work 里越界写会停下来问用户（可批准），
     * 常规聊天是用户明确选了"我不打算让它动别的目录"，所以这里直接拒，不打扰。
     */
    public var chatMode: Bool = false
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
    /**
     * **写/改**的拒绝原因（空串 = 允许）。读不走这里，走 denyReasonRead。
     * 沙箱档（ask）：工作区内直接写；越出工作区要"批准过"才放行（审批层放的，见 allowWriteAt）。
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
                case Some(n) =>
                    // 沙箱档：工作区内的写照旧遮敏感路径
                    if (hasSensitiveSegment(n)) {
                        return "这是敏感路径（.env / .git / .ssh 之类），已拒绝访问"
                    }
                    full = if (n.size == 0) { root } else { root + "/" + n }
                case None =>
                    // 越出工作区：批准过就能写，没批准过就拒 —— 并说清"要批准"，不是"永远不行"
                    let abs = collapseDots(joinAbs(t))
                    if (chatMode) {
                        return "这是常规聊天：只能在默认工作目录（" + root + "）里写文件。" +
                            "要改这个位置，请在侧栏里为它建一个 Work 会话"
                    }
                    if (!writeApprovedAt(abs)) {
                        return "路径越出工作区，需要先获得批准（写工作区外的文件会停下来问你）"
                    }
                    full = abs
            }
        }
        return denyAtRedLine(collapseDots(absNorm(full)))
    }

    /**
     * **读**的拒绝原因（空串 = 允许）。
     * 读不设边界：模型可以读这台机器上的任何文件 —— 沙箱只隔离"写"，不该隔离"读"。
     * 仍然挡住两条：模型自己在用的配置文件（里面有 API Key）、CLI 自己的数据目录（配置与会话）。
     */
    public func denyReasonRead(rel: String): String {
        let t = trimStr(rel)
        if (t.size == 0) {
            return ""
        }
        return denyAtRedLine(collapseDots(absNorm(joinAbs(t))))
    }

    /** 两条红线：模型自己在用的配置（含 Key）+ CLI 数据目录。任何档位、读和写都挡。 */
    private func denyAtRedLine(norm: String): String {
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

    /** 写路径解析（沙箱档会拦越界；已批准的越界目录放行）。 */
    public func resolve(rel: String): ?String {
        let t = trimStr(rel)
        if (!sandboxed()) {
            // 非沙箱档：绝对路径直接用；相对路径挂到工作区上（.. 交给系统解析，就是要能走出去）
            if (t.size == 0) {
                return Some(root)
            }
            return Some(collapseDots(joinAbs(t)))
        }
        match (normalizeRel(t)) {
            case Some(n) =>
                if (n.size == 0) {
                    return Some(root)
                }
                return Some(root + "/" + n)
            case None =>
                let abs = collapseDots(joinAbs(t))
                if (writeApprovedAt(abs)) {
                    return Some(abs)
                }
                return None
        }
    }

    /**
     * 读路径解析：**任何档位都不设边界**。
     * 相对路径挂到工作区，绝对路径原样，.. 交给系统解析（就是要能走出去读）。
     */
    public func resolveRead(rel: String): ?String {
        let t = trimStr(rel)
        if (t.size == 0) {
            return Some(root)
        }
        if (sandboxed()) {
            match (normalizeRel(t)) {
                case Some(n) => return Some(if (n.size == 0) { root } else { root + "/" + n })
                case None => return Some(collapseDots(joinAbs(t)))
            }
        }
        return Some(collapseDots(joinAbs(t)))
    }

    /** 审批层放行一次"写工作区外"后登记进来（前缀，含子目录）。 */
    public func allowWriteAt(abs: String): Unit {
        let a = collapseDots(absNorm(abs))
        if (a.size == 0) {
            return
        }
        for (x in writeApproved) {
            if (x == a) {
                return
            }
        }
        writeApproved.add(a)
    }

    public func writeApprovedAt(abs: String): Bool {
        let a = collapseDots(absNorm(abs))
        for (x in writeApproved) {
            if (a == x || hasPrefix(a, x + "/")) {
                return true
            }
        }
        return false
    }

    /** 这个绝对路径在工作区外面吗。 */
    public func isOutside(abs: String): Bool {
        let a = collapseDots(absNorm(abs))
        if (a == root) {
            return false
        }
        return !hasPrefix(a, root + "/")
    }

    /** 给人看的路径：工作区内给相对路径，外面给绝对路径（工作区根本身给空串）。 */
    public func displayPath(abs: String): String {
        let a = stripTrailingSeps(collapseDots(absNorm(abs)))
        if (a == root) {
            return ""
        }
        if (hasPrefix(a, root + "/")) {
            return safeUtf8(a.toArray(), root.size + 1, a.size)
        }
        return a
    }

    /** 展示用：相对/绝对 + 越界标记 —— 读到工作区外时让用户看得见。 */
    public func shownPath(rel: String): String {
        match (resolveRead(rel)) {
            case Some(f) =>
                if (isOutside(f)) {
                    return f + "（工作区外）"
                }
                return displayPath(f)
            case None => return rel
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
        match (resolveRead(rel)) {
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

    /** 列目录（只列一层，名字后面带 / 表示目录）。读操作，不设边界。 */
    public func list(rel: String, limit: Int64): ArrayList<String> {
        let out = ArrayList<String>()
        match (resolveRead(rel)) {
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

    /**
     * 递归列出文件，**返回绝对路径**（跳过噪声目录）。
     * 因为读不设边界，搜索根也可能在工作区外，所以内部一律用绝对路径；展示时再 displayPath 缩回去。
     */
    public func walkFiles(rel: String, maxFiles: Int64): ArrayList<String> {
        let out = ArrayList<String>()
        var base = ""
        match (resolveRead(rel)) {
            case Some(f) => base = f
            case None => return out
        }
        walkAbsInto(base, maxFiles, out)
        return out
    }

    private func walkAbsInto(dirAbs: String, maxFiles: Int64, out: ArrayList<String>): Unit {
        if (out.size >= maxFiles) {
            return
        }
        let dirs = ArrayList<String>()
        try {
            Directory.walk(Path(dirAbs), { fi: FileInfo =>
                let nm = fi.name
                if (fi.isDirectory()) {
                    if (!skipDirName(nm)) {
                        dirs.add(dirAbs + "/" + nm)
                    }
                } else {
                    if (out.size < maxFiles) {
                        out.add(dirAbs + "/" + nm)
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
            walkAbsInto(d, maxFiles, out)
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

/**
 * 把绝对路径里的 . 与 .. 段折叠掉（`D:/a/../b` → `D:/b`）。
 *
 * 为什么必须有这一步：红线名单（denyFiles / denyRoots）是**按字符串前缀比的**，
 * 而 `C:/x/../.env.local` 和 `C:/.env.local` 是同一个文件、字符串却不同 ——
 * 不折叠就等于红线可以被 `..` 绕过去。
 */
public func collapseDots(p: String): String {
    let slashed = toSlashes(p)
    let b = slashed.toArray()
    var acc = ""
    var start: Int64 = 0
    var i: Int64 = 0
    while (i <= b.size) {
        if (i == b.size || b[i] == 47) {
            let seg = safeUtf8(b, start, i)
            if (seg.size > 0 && seg != ".") {
                if (seg == "..") {
                    if (acc.size > 0 && !isDriveSeg(acc)) {
                        let ob = acc.toArray()
                        var e = ob.size
                        while (e > 0 && ob[e - 1] != 47) {
                            e = e - 1
                        }
                        if (e > 0) {
                            e = e - 1
                        }
                        acc = safeUtf8(ob, 0, e)
                    }
                } else {
                    if (acc.size > 0) {
                        acc = acc + "/"
                    }
                    acc = acc + seg
                }
            }
            start = i + 1
        }
        i = i + 1
    }
    if (acc.size == 0) {
        return slashed
    }
    return acc
}

/** `D:` 这种盘符段（折叠 .. 时不能被弹掉）。 */
func isDriveSeg(seg: String): Bool {
    let b = seg.toArray()
    return b.size == 2 && b[1] == 58
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
