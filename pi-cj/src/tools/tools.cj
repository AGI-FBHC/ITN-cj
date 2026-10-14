package pi_cj.tools

import std.collection.*
import std.convert.*
import std.time.*
import stdx.encoding.json.*
import pi_cj.pi.*

/**
 * 工作区的真实工具（对齐 Pi/Codex 那套"读-写-改-搜-跑"）：
 *
 *   read_file / list_files / search_text   read      只读
 *   write_file / edit_file                 write     改本机文件
 *   run_command                            external  执行本机命令（最危险的一档）
 *   current_time / calc                    read      不碰文件
 *
 * allowExec = false 时 run_command 会被标记成"不可用"：它仍然出现在清单里（前端能看到有这件
 * 武器、以及为什么关着），但不会写进提示词、调也调不动。这就是"审批门"在运行时的着落点。
 */
public func registerWorkspaceTools(reg: ToolRegistry, ws: Workspace, allowExec: Bool): Unit {
    reg.add(ReadFileTool(ws))
    reg.add(ListFilesTool(ws))
    reg.add(SearchTextTool(ws))
    reg.add(WriteFileTool(ws))
    reg.add(EditFileTool(ws))
    reg.add(CurrentTimeTool())
    reg.add(CalcTool())
    reg.add(RunCommandTool(ws))
    if (!allowExec) {
        reg.markUnavailable("run_command", "启动时没有加 --allow-exec，执行本机命令被关掉了")
    }
}

class ReadFileTool <: Tool {
    private let ws: Workspace

    public init(ws: Workspace) {
        this.ws = ws
    }

    public func spec(): ToolSpec {
        return ToolSpec("read_file", "读文件", "{\"path\": \"note.md\"}",
            "读工作区里的一个文本文件（最多 32KB，超出会截断）。path 必填，是相对工作区的路径。", "read")
    }

    public func run(args: JsonObject): ToolResult {
        let path = strOf(args, "path")
        if (path.size == 0) {
            return ToolResult.bad("缺少 path 参数")
        }
        match (ws.resolve(path)) {
            case None => return ToolResult.bad("路径越出工作区，拒绝访问：" + path +
                "（模型只能读工作区里的文件）")
            case Some(_) => ()
        }
        match (ws.readText(path)) {
            case Some(t) =>
                let arr = JsonArray()
                let o = JsonObject()
                o.put("path", JsonString(ws.relOf(path)))
                o.put("content", JsonString(t))
                arr.add(o)
                return ToolResult.goodWith("读到 " + ws.relOf(path) + "（" + t.size.toString() + " 字节）",
                    "文件 " + ws.relOf(path) + " 的内容：\n" + t, arr)
            case None =>
                return ToolResult.bad("读不到 " + path + "（不存在、是目录，或者越出了工作区）")
        }
    }
}

class ListFilesTool <: Tool {
    private let ws: Workspace

    public init(ws: Workspace) {
        this.ws = ws
    }

    public func spec(): ToolSpec {
        return ToolSpec("list_files", "列出文件", "{}",
            "列出工作区里的文件与子目录。path 可省略（默认整个工作区），recursive 默认 true。" +
            "先用它搞清楚有什么，再决定读哪个。", "read")
    }

    public func run(args: JsonObject): ToolResult {
        let path = strOf(args, "path")
        let rec = boolOf(args, "recursive", true)
        match (ws.resolve(path)) {
            case Some(_) =>
                let items = ws.list(path, rec)
                if (items.size == 0) {
                    let place = if (ws.relOf(path).size == 0) { "工作区根目录" } else { ws.relOf(path) }
                    return ToolResult.goodWith(place + " 是空的", place + " 下没有任何文件或子目录。", JsonNull())
                }
                let arr = JsonArray()
                for (it in items) {
                    arr.add(JsonString(it))
                }
                let head = if (ws.relOf(path).size == 0) { "工作区根目录" } else { ws.relOf(path) }
                return ToolResult.good(head + " 下共 " + items.size.toString() + " 项", arr)
            case None =>
                return ToolResult.bad("路径越出工作区，拒绝访问：" + path)
        }
    }
}

class SearchTextTool <: Tool {
    private let ws: Workspace

    public init(ws: Workspace) {
        this.ws = ws
    }

    public func spec(): ToolSpec {
        return ToolSpec("search_text", "搜内容", "{\"query\": \"要找的字\"}",
            "在工作区的文本文件里逐行找一段字，返回 文件:行号: 内容。path 可省略（默认整个工作区）。" +
            "比一个个读文件快得多。", "read")
    }

    public func run(args: JsonObject): ToolResult {
        let query = strOf(args, "query")
        if (query.size == 0) {
            return ToolResult.bad("缺少 query 参数")
        }
        let path = strOf(args, "path")
        let hits = ws.search(query, path)
        if (hits.size == 0) {
            return ToolResult.bad("没搜到「" + query + "」")
        }
        let arr = JsonArray()
        for (h in hits) {
            arr.add(JsonString(h))
        }
        return ToolResult.good("在 " + hits.size.toString() + " 处找到「" + query + "」", arr)
    }
}

class WriteFileTool <: Tool {
    private let ws: Workspace

    public init(ws: Workspace) {
        this.ws = ws
    }

    public func spec(): ToolSpec {
        return ToolSpec("write_file", "写文件", "{\"path\": \"相对路径\", \"content\": \"完整内容\"}",
            "把内容整个写进一个文件（已有文件会被覆盖，父目录会自动建）。批量改造用 edit_file 更稳。", "write")
    }

    public func run(args: JsonObject): ToolResult {
        let path = strOf(args, "path")
        if (path.size == 0) {
            return ToolResult.bad("缺少 path 参数")
        }
        match (ws.resolve(path)) {
            case None => return ToolResult.bad("路径越出工作区，拒绝写入：" + path)
            case Some(_) => ()
        }
        let content = strOf(args, "content")
        if (ws.writeText(path, content)) {
            return ToolResult.good("已写入 " + ws.relOf(path) + "（" + content.size.toString() + " 字节）", JsonNull())
        }
        return ToolResult.bad("写不进去 " + path + "（路径越出工作区，或者没有权限）")
    }
}

class EditFileTool <: Tool {
    private let ws: Workspace

    public init(ws: Workspace) {
        this.ws = ws
    }

    public func spec(): ToolSpec {
        return ToolSpec("edit_file", "改文件",
            "{\"path\": \"相对路径\", \"old_text\": \"原文\", \"new_text\": \"新文\"}",
            "把文件里**唯一出现**的一段原文换成新文。找不到、或出现多次都会拒绝（避免改错地方）。", "write")
    }

    public func run(args: JsonObject): ToolResult {
        let path = strOf(args, "path")
        let oldText = strOf(args, "old_text")
        let newText = strOf(args, "new_text")
        if (path.size == 0 || oldText.size == 0) {
            return ToolResult.bad("需要 path 与 old_text")
        }
        match (ws.resolve(path)) {
            case None => return ToolResult.bad("路径越出工作区，拒绝访问：" + path)
            case Some(_) => ()
        }
        var text = ""
        match (ws.readText(path)) {
            case Some(t) => text = t
            case None => return ToolResult.bad("读不到 " + path)
        }
        let idx = indexOfSub(text, oldText)
        if (idx < 0) {
            return ToolResult.bad("在 " + path + " 里找不到那段 old_text，先 read_file 看清楚再改")
        }
        if (indexOfSub(safeUtf8(text.toArray(), idx + oldText.size, text.size), oldText) >= 0) {
            return ToolResult.bad("old_text 在 " + path + " 里出现了不止一次，先写出更长的上下文再改")
        }
        let b = text.toArray()
        let replaced = safeUtf8(b, 0, idx) + newText + safeUtf8(b, idx + oldText.size, b.size)
        if (!ws.writeText(path, replaced)) {
            return ToolResult.bad("改完写不回去：" + path)
        }
        return ToolResult.good("已改 " + ws.relOf(path) + "（替换 1 处，长度 " + text.size.toString() +
            " -> " + replaced.size.toString() + " 字节）", JsonNull())
    }
}

class RunCommandTool <: Tool {
    private let ws: Workspace

    public init(ws: Workspace) {
        this.ws = ws
    }

    public func spec(): ToolSpec {
        return ToolSpec("run_command", "执行命令", "{\"command\": \"dir /b\"}",
            "在工作区目录里用 cmd /c 执行一条命令，返回退出码与输出。cwd 可省略。" +
            "不要跑交互式或常驻的命令（没有超时保护，会一直挂着）。", "external")
    }

    public func run(args: JsonObject): ToolResult {
        let cmd = strOf(args, "command")
        if (cmd.size == 0) {
            return ToolResult.bad("缺少 command 参数")
        }
        let cwd = strOf(args, "cwd")
        let r = ws.run(cmd, cwd)
        let arr = JsonArray()
        let o = JsonObject()
        o.put("exitCode", JsonInt(r.code))
        o.put("stdout", JsonString(r.out))
        o.put("stderr", JsonString(r.err))
        arr.add(o)
        let head = "命令退出码 " + r.code.toString()
        let body = "命令：" + cmd + "\n退出码：" + r.code.toString() + "\nstdout：\n" + r.out +
            "\nstderr：\n" + r.err
        if (r.code != 0) {
            return ToolResult.goodWith(head + "（失败）", body, arr)
        }
        return ToolResult.goodWith(head, body, arr)
    }
}

class CurrentTimeTool <: Tool {
    public init() {}

    public func spec(): ToolSpec {
        return ToolSpec("current_time", "看当前时间", "{}",
            "返回本机当前的日期时间，用来算「还剩几天」这类问题。", "read")
    }

    public func run(args: JsonObject): ToolResult {
        let now = DateTime.now().toString()
        return ToolResult.good("现在时间是 " + now, JsonString(now))
    }
}

/* ---------- 四则运算求值器：与内核 core/src/tools/registry.cj 的 Calc 保持一致 ---------- */

class Calc {
    let src: Array<UInt8>
    var pos: Int64 = 0
    var err: String = ""

    init(text: String) {
        this.src = text.toArray()
    }

    func skip(): Unit {
        while (pos < src.size && (src[pos] == 32 || src[pos] == 9)) {
            pos = pos + 1
        }
    }

    func peek(): UInt8 {
        skip()
        if (pos < src.size) {
            return src[pos]
        }
        return 0
    }

    func expr(): Float64 {
        var v = term()
        while (err.size == 0) {
            let c = peek()
            if (c == 43) {
                pos = pos + 1
                v = v + term()
            } else if (c == 45) {
                pos = pos + 1
                v = v - term()
            } else {
                break
            }
        }
        return v
    }

    func term(): Float64 {
        var v = unary()
        while (err.size == 0) {
            let c = peek()
            if (c == 42) {
                pos = pos + 1
                v = v * unary()
            } else if (c == 47) {
                pos = pos + 1
                let d = unary()
                if (d == 0.0) {
                    err = "除数不能为零"
                    return 0.0
                }
                v = v / d
            } else {
                break
            }
        }
        return v
    }

    func unary(): Float64 {
        let c = peek()
        if (c == 45) {
            pos = pos + 1
            return 0.0 - unary()
        }
        if (c == 43) {
            pos = pos + 1
            return unary()
        }
        return primary()
    }

    func primary(): Float64 {
        let c = peek()
        if (c == 40) {
            pos = pos + 1
            let v = expr()
            if (peek() != 41) {
                err = "括号不配对"
                return 0.0
            }
            pos = pos + 1
            return v
        }
        return number()
    }

    func number(): Float64 {
        skip()
        let start = pos
        var dot = false
        while (pos < src.size) {
            let c = src[pos]
            if (c >= 48 && c <= 57) {
                pos = pos + 1
            } else if (c == 46 && !dot) {
                dot = true
                pos = pos + 1
            } else {
                break
            }
        }
        if (pos == start) {
            err = "表达式里有无法识别的字符"
            return 0.0
        }
        let t = safeUtf8(src, start, pos)
        try {
            return Float64.parse(t)
        } catch (e: Exception) {
            err = "无法解析数字：" + t
            return 0.0
        }
    }

    func done(): Bool {
        skip()
        return pos >= src.size
    }

    public func value(): Float64 {
        let v = expr()
        if (err.size == 0 && !done()) {
            err = "表达式没写完，剩下的部分看不懂"
        }
        return v
    }
}

class CalcTool <: Tool {
    public init() {}

    public func spec(): ToolSpec {
        return ToolSpec("calc", "计算", "{\"expr\": \"(12+8)*3/4\"}",
            "四则运算（支持 + - * / 与括号），别自己心算。", "read")
    }

    public func run(args: JsonObject): ToolResult {
        let e = strOf(args, "expr")
        if (e.size == 0) {
            return ToolResult.bad("缺少 expr 参数")
        }
        let c = Calc(e)
        let v = c.value()
        if (c.err.size > 0) {
            return ToolResult.bad(c.err)
        }
        return ToolResult.good(e + " = " + v.toString(), JsonFloat(v))
    }
}
