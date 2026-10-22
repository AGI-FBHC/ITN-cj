package itn_desktop_core.pi_tools

import std.collection.*
import std.regex.*
import stdx.encoding.json.*
import itn_desktop_core.pi.*

/*
 * 八个真实工具，名字/参数/说明都对齐 Pi 的内置工具：
 *   read     读文件（offset/limit 分段）        read
 *   write    写文件（整个覆盖）                  write
 *   edit     精确替换（一次可多段，匹配原文）     write
 *   ls       列目录                             read
 *   find     按 glob 找文件                     read
 *   grep     按正则/字面量搜内容                 read
 *   powershell 执行命令（Windows 上代替 bash）   external
 *
 * 与 Pi 的差别：路径被关在工作区里（Pi 用进程的系统权限）；命令执行要显式开 --allow-exec。
 */

public func registerWorkspaceTools(reg: ToolRegistry, ws: Workspace, allowExec: Bool, drafts!: ?DraftStore = None): Unit {
    reg.add(ReadTool(ws))
    reg.add(WriteTool(ws, drafts))
    reg.add(EditTool(ws, drafts))
    reg.add(LsTool(ws))
    reg.add(FindTool(ws))
    reg.add(GrepTool(ws))
    reg.add(PowerShellTool(ws))
    if (!allowExec) {
        reg.markUnavailable("powershell", "启动时没有加 --allow-exec，执行本机命令被关掉了")
    }
}

class ReadTool <: Tool {
    private let ws: Workspace

    public init(ws: Workspace) {
        this.ws = ws
    }

    public func spec(): ToolSpec {
        let s = ToolSpec("read", "读文件", "Read file contents",
            "Read a file from the workspace. Optional offset (1-indexed line) and limit (lines) for large files.",
            "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"description\":\"Path to the file to read (relative or absolute)\"},\"offset\":{\"type\":\"number\",\"description\":\"Line number to start reading from (1-indexed)\"},\"limit\":{\"type\":\"number\",\"description\":\"Maximum number of lines to read\"}},\"required\":[\"path\"]}",
            "read")
        s.guidelines = ["Use read to examine files instead of cat or sed.", "大文件用 offset/limit 分段读，不要整篇塞进上下文。"]
        return s
    }

    public func run(callId: String, args: JsonObject): ToolResult {
        let path = strOf(args, "path")
        if (path.size == 0) {
            return ToolResult.err("缺少 path 参数")
        }
        let why = ws.denyReasonRead(path)
        if (why.size > 0) {
            return ToolResult.err(why + "：" + path)
        }
        let raw = match (ws.readText(path)) {
            case Some(t) => t
            case None => return ToolResult.err("读不到 " + path + "（不存在、是目录，或者没有权限）")
        }
        let rel = ws.shownPath(path)
        let details = JsonObject()
        details.put("path", JsonString(rel))
        let offset = intOf(args, "offset")
        let limit = intOf(args, "limit")
        if (offset <= 0 && limit <= 0) {
            let t = truncateHead(raw, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES)
            details.put("truncated", JsonBool(t.truncated))
            let head = "读到 " + rel + "（" + formatSize(raw.size) + "）"
            if (t.truncated) {
                return ToolResult.ok(head + "，已截断", t.content, details)
            }
            return ToolResult.ok(head, t.content, details)
        }
        let lines = splitLines(raw)
        var start: Int64 = 0
        if (offset > 1) {
            start = offset - 1
        }
        if (start > lines.size) {
            start = lines.size
        }
        var end = lines.size
        if (limit > 0 && start + limit < end) {
            end = start + limit
        }
        let sb = StringBuilder()
        sb.append("文件 " + rel + " 第 " + (start + 1).toString() + "-" + end.toString() + " 行（共 " +
            lines.size.toString() + " 行）：\n")
        var i = start
        while (i < end) {
            sb.append(lines[i])
            sb.append("\n")
            i = i + 1
        }
        details.put("truncated", JsonBool(false))
        return ToolResult.ok("读到 " + rel + " 的 " + (end - start).toString() + " 行", sb.toString(), details)
    }
}

/**
 * 文本行数（按 \n 数；末尾没有换行也算一行）。
 *
 * 只在"改了哪个文件、增删多少行"这类给人看的统计上用，不参与任何权限或流程判断。
 */
func countLines(text: String): Int64 {
    if (text.size == 0) {
        return 0
    }
    var n: Int64 = 1
    var i = 0
    let b = text.toArray()
    while (i < b.size) {
        if (b[i] == 10) {
            n += 1
        }
        i += 1
    }
    if (b[b.size - 1] == 10) {
        n -= 1
    }
    return n
}

/** 草稿要记绝对路径（还原时不经过 Workspace）：解析不出来就退回原样。 */
func absPathOf(ws: Workspace, path: String): String {
    match (ws.resolve(path)) {
        case Some(p) => return p
        case None => return path
    }
}

class WriteTool <: Tool {
    private let ws: Workspace
    private let drafts: ?DraftStore

    public init(ws: Workspace, drafts: ?DraftStore) {
        this.ws = ws
        this.drafts = drafts
    }

    public func spec(): ToolSpec {
        let s = ToolSpec("write", "写文件", "Create or overwrite files",
            "Write content to a file in the workspace. Overwrites existing files; creates parent directories.",
            "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"description\":\"Path to the file to write (relative or absolute)\"},\"content\":{\"type\":\"string\",\"description\":\"Content to write to the file\"}},\"required\":[\"path\",\"content\"]}",
            "write")
        s.guidelines = ["Use write only for new files or complete rewrites.", "改几处小地方用 edit，不要整篇重写。"]
        return s
    }

    public func run(callId: String, args: JsonObject): ToolResult {
        let path = strOf(args, "path")
        if (path.size == 0) {
            return ToolResult.err("缺少 path 参数")
        }
        let why = ws.denyReason(path)
        if (why.size > 0) {
            return ToolResult.err(why + "：" + path)
        }
        let content = strOf(args, "content")
        // 覆盖写之前先量一下旧文件的行数：界面要拿它算"这一轮改了多少行"（+/-），
        // 没有旧内容时（新建）增行数就是全部、减行数为 0。
        var oldLines: Int64 = 0
        var before: ?String = None
        match (ws.readText(path)) {
            case Some(b) =>
                before = Some(b)
                oldLines = countLines(b)
            case None => ()
        }
        if (ws.writeText(path, content)) {
            let add = countLines(content)
            let d = JsonObject()
            d.put("path", JsonString(ws.relOf(path)))
            d.put("absPath",JsonString(absPathOf(ws,path)))
            d.put("add", JsonInt(add))
            d.put("del", JsonInt(oldLines))
            d.put("created", JsonBool(oldLines == 0))
            // 改动草稿：写之前那份原样留在 drafts 里，界面据此给"看差异 / 撤销这次改动"
            match (drafts) {
                case Some(ds) =>
                    d.put("draftId", JsonString(ds.record(ws.relOf(path), absPathOf(ws, path), before, add, oldLines)))
                case None => ()
            }
            return ToolResult.ok("已写入 " + ws.relOf(path) + "（" + formatSize(content.size) + "）",
                "已写入 " + ws.relOf(path) + "（" + content.size.toString() + " 字节）", d)
        }
        return ToolResult.err("写不进去 " + path)
    }
}

class EditTool <: Tool {
    private let ws: Workspace
    private let drafts: ?DraftStore

    public init(ws: Workspace, drafts: ?DraftStore) {
        this.ws = ws
        this.drafts = drafts
    }

    public func spec(): ToolSpec {
        let s = ToolSpec("edit", "改文件", "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
            "Replace exact text in a file. Each edits[].oldText must match the original file uniquely; edits are matched against the original content, not incrementally.",
            "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"description\":\"Path to the file to edit (relative or absolute)\"},\"edits\":{\"type\":\"array\",\"description\":\"One or more targeted replacements; each is matched against the original file\",\"items\":{\"type\":\"object\",\"properties\":{\"oldText\":{\"type\":\"string\",\"description\":\"Exact text for one targeted replacement; must be unique in the original file\"},\"newText\":{\"type\":\"string\",\"description\":\"Replacement text\"}},\"required\":[\"oldText\",\"newText\"]}}},\"required\":[\"path\",\"edits\"]}",
            "write")
        s.guidelines = [
            "Use edit for precise changes (edits[].oldText must match exactly)",
            "When changing multiple separate locations in one file, use one edit call with multiple edits[] instead of multiple edit calls",
            "Each edits[].oldText is matched against the original file, not after earlier edits are applied",
            "Keep edits[].oldText as small as possible while still being unique"
        ]
        return s
    }

    public func run(callId: String, args: JsonObject): ToolResult {
        let path = strOf(args, "path")
        if (path.size == 0) {
            return ToolResult.err("缺少 path 参数")
        }
        let why = ws.denyReason(path)
        if (why.size > 0) {
            return ToolResult.err(why + "：" + path)
        }
        let edits = match (args.get("edits")) {
            case Some(v) =>
                match (v) {
                    case a: JsonArray => a
                    case _ => JsonArray()
                }
            case None => JsonArray()
        }
        if (edits.size() == 0) {
            return ToolResult.err("缺少 edits 参数（至少一段 oldText/newText）")
        }
        let raw = match (ws.readText(path)) {
            case Some(t) => t
            case None => return ToolResult.err("读不到 " + path)
        }
        var text = raw
        var applied: Int64 = 0
        var i: Int64 = 0
        while (i < edits.size()) {
            let e = match (edits[i]) {
                case o: JsonObject => o
                case _ => JsonObject()
            }
            let oldText = strOf(e, "oldText")
            let newText = strOf(e, "newText")
            if (oldText.size == 0) {
                return ToolResult.err("edits[" + i.toString() + "].oldText 是空的")
            }
            let idx = indexOfSub(text, oldText)
            if (idx < 0) {
                return ToolResult.err("edits[" + i.toString() + "] 在原文里找不到那段 oldText（先 read 看清楚）")
            }
            let b = text.toArray()
            let after = safeUtf8(b, idx + oldText.size, b.size)
            if (indexOfSub(after, oldText) >= 0) {
                return ToolResult.err("edits[" + i.toString() + "] 的 oldText 在文件里不唯一，写长一点再改")
            }
            text = safeUtf8(b, 0, idx) + newText + after
            applied = applied + 1
            i = i + 1
        }
        if (!ws.writeText(path, text)) {
            return ToolResult.err("改完写不回去：" + path)
        }
        let rel = ws.relOf(path)
        // 增删行数按"新旧正文各自的行数差"算：这是给人看的量级，不是逐行 diff（逐行 diff 太贵，
        // 而且模型自己改了什么，摘要里已经写清楚了）
        let d = JsonObject()
        d.put("path", JsonString(rel))
        d.put("absPath",JsonString(absPathOf(ws,path)))
        d.put("add", JsonInt(countLines(text)))
        d.put("del", JsonInt(countLines(raw)))
        d.put("applied", JsonInt(applied))
        match (drafts) {
            case Some(ds) =>
                d.put("draftId", JsonString(ds.record(rel, absPathOf(ws, path), Some(raw), countLines(text), countLines(raw))))
            case None => ()
        }
        return ToolResult.ok("已改 " + rel + "（" + applied.toString() + " 处替换，" + formatSize(raw.size) +
            " -> " + formatSize(text.size) + "）", "已改 " + rel + "，" + applied.toString() + " 处替换完成。", d)
    }
}

class LsTool <: Tool {
    private let ws: Workspace

    public init(ws: Workspace) {
        this.ws = ws
    }

    public func spec(): ToolSpec {
        let s = ToolSpec("ls", "列目录", "List directory contents",
            "List the entries of one directory in the workspace (directories end with /).",
            "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\",\"description\":\"Directory to list (default: current directory)\"},\"limit\":{\"type\":\"number\",\"description\":\"Maximum number of entries to return (default: 500)\"}}}",
            "read")
        s.guidelines = ["先 ls 看清楚有什么，再决定读哪个文件。"]
        return s
    }

    public func run(callId: String, args: JsonObject): ToolResult {
        let path = strOf(args, "path")
        let why = ws.denyReasonRead(path)
        if (why.size > 0) {
            return ToolResult.err(why + "：" + path)
        }
        var limit = intOf(args, "limit")
        if (limit <= 0) {
            limit = ws.maxListEntries
        }
        let items = ws.list(path, limit)
        let rel = ws.shownPath(path)
        let place = if (rel.size == 0) { "工作区根目录" } else { rel }
        if (items.size == 0) {
            return ToolResult.ok(place + " 是空的", place + " 下没有任何条目。", JsonNull())
        }
        let sb = StringBuilder()
        for (it in items) {
            sb.append(it)
            sb.append("\n")
        }
        return ToolResult.ok(place + " 下 " + items.size.toString() + " 项", sb.toString(), JsonNull())
    }
}

class FindTool <: Tool {
    private let ws: Workspace

    public init(ws: Workspace) {
        this.ws = ws
    }

    public func spec(): ToolSpec {
        let s = ToolSpec("find", "找文件", "Find files by glob pattern",
            "Find files in the workspace by glob pattern, e.g. '*.md', '**/*.json' or 'src/**/*.cj'.",
            "{\"type\":\"object\",\"properties\":{\"pattern\":{\"type\":\"string\",\"description\":\"Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'\"},\"path\":{\"type\":\"string\",\"description\":\"Directory to search in (default: current directory)\"},\"limit\":{\"type\":\"number\",\"description\":\"Maximum number of results (default: 1000)\"}},\"required\":[\"pattern\"]}",
            "read")
        return s
    }

    public func run(callId: String, args: JsonObject): ToolResult {
        let pattern = strOf(args, "pattern")
        if (pattern.size == 0) {
            return ToolResult.err("缺少 pattern 参数")
        }
        let path = strOf(args, "path")
        let why = ws.denyReasonRead(path)
        if (why.size > 0) {
            return ToolResult.err(why + "：" + path)
        }
        var limit = intOf(args, "limit")
        if (limit <= 0) {
            limit = ws.maxFindResults
        }
        var re: ?Regex = None
        try {
            re = Some(Regex(globToRegex(pattern)))
        } catch (e: Exception) {
            return ToolResult.err("glob 写错了：" + e.message)
        }
        let files = ws.walkFiles(path, ws.maxFindResults * 4)
        let hits = ArrayList<String>()
        for (f in files) {
            if (hits.size >= limit) {
                break
            }
            // 匹配与展示都用"给人看"的路径：工作区内是相对路径，外面是绝对路径
            let disp = ws.displayPath(f)
            match (re) {
                case Some(r) =>
                    if (r.matches(disp)) {
                        hits.add(disp)
                    }
                case None => ()
            }
        }
        if (hits.size == 0) {
            return ToolResult.err("没有匹配 " + pattern + " 的文件")
        }
        let sb = StringBuilder()
        for (h in hits) {
            sb.append(h)
            sb.append("\n")
        }
        return ToolResult.ok("找到 " + hits.size.toString() + " 个文件", sb.toString(), JsonNull())
    }
}

class GrepTool <: Tool {
    private let ws: Workspace

    public init(ws: Workspace) {
        this.ws = ws
    }

    public func spec(): ToolSpec {
        let s = ToolSpec("grep", "搜内容", "Search file contents for patterns",
            "Search the workspace for a pattern line by line. Returns path:line: text. Supports regex (default), literal, ignoreCase, glob filter and context lines.",
            "{\"type\":\"object\",\"properties\":{\"pattern\":{\"type\":\"string\",\"description\":\"Search pattern (regex or literal string)\"},\"path\":{\"type\":\"string\",\"description\":\"Directory or file to search (default: current directory)\"},\"glob\":{\"type\":\"string\",\"description\":\"Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'\"},\"ignoreCase\":{\"type\":\"boolean\",\"description\":\"Case-insensitive search (default: false)\"},\"literal\":{\"type\":\"boolean\",\"description\":\"Treat pattern as literal string instead of regex (default: false)\"},\"context\":{\"type\":\"number\",\"description\":\"Number of lines to show before and after each match (default: 0)\"},\"limit\":{\"type\":\"number\",\"description\":\"Maximum number of matches to return (default: 100)\"}},\"required\":[\"pattern\"]}",
            "read")
        return s
    }

    public func run(callId: String, args: JsonObject): ToolResult {
        let pattern = strOf(args, "pattern")
        if (pattern.size == 0) {
            return ToolResult.err("缺少 pattern 参数")
        }
        let path = strOf(args, "path")
        let why = ws.denyReasonRead(path)
        if (why.size > 0) {
            return ToolResult.err(why + "：" + path)
        }
        let literal = boolOf(args, "literal", false)
        let ic = boolOf(args, "ignoreCase", false)
        let ctxLines = intOf(args, "context")
        var limit = intOf(args, "limit")
        if (limit <= 0) {
            limit = ws.maxGrepMatches
        }
        let globPat = strOf(args, "glob")
        var re: ?Regex = None
        if (!literal) {
            try {
                if (ic) {
                    re = Some(Regex(pattern, RegexFlag.IgnoreCase))
                } else {
                    re = Some(Regex(pattern))
                }
            } catch (e: Exception) {
                return ToolResult.err("正则写错了：" + e.message + "（要用字面量搜索请传 literal=true）")
            }
        }
        var globRe: ?Regex = None
        if (globPat.size > 0) {
            try {
                globRe = Some(Regex(globToRegex(globPat)))
            } catch (e: Exception) {
                return ToolResult.err("glob 写错了：" + e.message)
            }
        }
        let files = ws.walkFiles(path, 4000)
        let hits = ArrayList<String>()
        var scanned: Int64 = 0
        for (f in files) {
            if (hits.size >= limit) {
                break
            }
            let disp = ws.displayPath(f)
            var skip = false
            match (globRe) {
                case Some(gr) =>
                    if (!gr.matches(disp)) {
                        skip = true
                    }
                case None => ()
            }
            if (skip) {
                continue
            }
            var content = ""
            match (ws.readText(f)) {
                case Some(t) => content = t
                case None => continue
            }
            if (content.size > ws.maxScanBytes) {
                continue
            }
            scanned = scanned + 1
            let lines = splitLines(content)
            var i: Int64 = 0
            while (i < lines.size && hits.size < limit) {
                if (lineMatches(lines[i], pattern, literal, ic, re)) {
                    var c = ctxLines
                    while (c > 0) {
                        let bi = i - c
                        if (bi >= 0) {
                            hits.add(disp + ":" + (bi + 1).toString() + "-" + truncateLine(lines[bi]))
                        }
                        c = c - 1
                    }
                    hits.add(disp + ":" + (i + 1).toString() + ": " + truncateLine(lines[i]))
                    var a: Int64 = 1
                    while (a <= ctxLines) {
                        let ai = i + a
                        if (ai < lines.size) {
                            hits.add(disp + ":" + (ai + 1).toString() + "-" + truncateLine(lines[ai]))
                        }
                        a = a + 1
                    }
                }
                i = i + 1
            }
        }
        if (hits.size == 0) {
            return ToolResult.err("在 " + scanned.toString() + " 个文件里没搜到「" + pattern + "」")
        }
        let sb = StringBuilder()
        for (h in hits) {
            sb.append(h)
            sb.append("\n")
        }
        return ToolResult.ok("在 " + hits.size.toString() + " 处找到「" + pattern + "」", sb.toString(), JsonNull())
    }
}

func lineMatches(line: String, pattern: String, literal: Bool, ic: Bool, re: ?Regex): Bool {
    if (literal) {
        if (ic) {
            return containsSub(line.toAsciiLower(), pattern.toAsciiLower())
        }
        return containsSub(line, pattern)
    }
    match (re) {
        case Some(r) => return r.matches(line)
        case None => return false
    }
}

class PowerShellTool <: Tool {
    private let ws: Workspace

    public init(ws: Workspace) {
        this.ws = ws
    }

    public func spec(): ToolSpec {
        let s = ToolSpec("powershell", "跑命令", "Execute PowerShell commands",
            "Run a PowerShell command inside the workspace. Output (stdout+stderr) is returned; a non-zero exit code is reported as an error. Do not run interactive or long-running commands.",
            "{\"type\":\"object\",\"properties\":{\"command\":{\"type\":\"string\",\"description\":\"Shell command to execute\"},\"timeout\":{\"type\":\"number\",\"description\":\"Timeout in seconds (optional, no default timeout)\"},\"cwd\":{\"type\":\"string\",\"description\":\"Working directory inside the workspace (optional)\"}},\"required\":[\"command\"]}",
            "external")
        s.guidelines = ["不要跑交互式或常驻的命令；长任务自己带 timeout 参数（不加就没有超时保护）。"]
        return s
    }

    public func run(callId: String, args: JsonObject): ToolResult {
        let cmd = strOf(args, "command")
        if (cmd.size == 0) {
            return ToolResult.err("缺少 command 参数")
        }
        let cwd = strOf(args, "cwd")
        let timeout = intOf(args, "timeout")
        let r = ws.runPowerShell(cmd, cwd, timeout)
        if (r.timedOut) {
            return ToolResult.err("命令超过 " + timeout.toString() + " 秒还没结束，已被终止（子进程可能残留）")
        }
        let body = "命令：" + cmd + "\n退出码：" + r.code.toString() + "\n耗时：" +
            (r.wallMs / 1000).toString() + "s\nstdout：\n" + r.out + "\nstderr：\n" + r.err
        if (r.code != 0) {
            return ToolResult.err("命令退出码 " + r.code.toString() + "\n" + body)
        }
        return ToolResult.ok("命令退出码 0，" + (r.wallMs / 1000).toString() + "s", body, JsonNull())
    }
}
