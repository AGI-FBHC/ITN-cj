package zhixun_learning

import std.collection.*
import std.convert.*
import std.core.*
import std.fs.*
import std.io.*
import stdx.encoding.json.*

/**
 * 资料包整理用的 Agent 工作区工具。
 *
 * 沙箱规则：所有路径都相对工作目录；读只允许 in/ 与 out/，写只允许 out/，
 * 任何绝对路径、`..`、盘符一律拒绝。模型只能在这些工具里活动。
 */
class KbWorkspace {
    let root: String

    init(root: String) {
        this.root = root
    }

    func resolve(relative: String, allowWrite: Bool): String {
        let cleaned = kbPathNormalize(relative)
        if (cleaned.size == 0) { throw Exception("路径为空") }
        let first = kbFirstSegment(cleaned)
        if (allowWrite) {
            if (first != "out") { throw Exception("只能写 out/ 目录") }
        } else if (first != "in" && first != "out") {
            throw Exception("只能读 in/ 与 out/ 目录")
        }
        root + "/" + cleaned
    }

    func listFiles(relative: String): String {
        let base = if (relative.size == 0) { root } else { resolve(relative, false) }
        let out = ArrayList<String>()
        kbWalkFiles(base, "", out, 0)
        let result = StringBuilder()
        var i: Int64 = 0
        while (i < out.size && i < 600) {
            result.append(out[i])
            result.append("\n")
            i += 1
        }
        if (out.size > 600) { result.append("…（共 " + out.size.toString() + " 个文件，已截断）\n") }
        result.toString()
    }

    func readFile(relative: String, limit: Int64): String {
        let full = resolve(relative, false)
        if (!exists(Path(full))) { throw Exception("文件不存在：" + relative) }
        let data = File.readFrom(Path(full))
        let maxBytes = if (limit <= 0) { 20000 } else if (limit > 60000) { 60000 } else { limit }
        let take = if (data.size > maxBytes) { maxBytes } else { data.size }
        String.fromUtf8(data.slice(0, take))
    }

    func writeFile(relative: String, content: String): Unit {
        let full = resolve(relative, true)
        kbWriteTextDeep(full, content)
    }

    func deleteFile(relative: String): Unit {
        let full = resolve(relative, false)
        if (exists(Path(full))) { try { remove(Path(full)) } catch (_: Exception) {} }
    }
}

func kbPathNormalize(raw: String): String {
    var text = raw.trimAscii()
    text = text.replace("\\", "/")
    if (text.startsWith("/") || text.contains(":")) { throw Exception("不接受绝对路径：" + raw) }
    let parts = ArrayList<String>()
    for (part in text.split("/")) {
        let piece = part.trimAscii()
        if (piece.size == 0 || piece == ".") { continue }
        if (piece == "..") { throw Exception("不接受 .. 路径：" + raw) }
        parts.add(piece)
    }
    var out = ""
    var i: Int64 = 0
    while (i < parts.size) {
        if (i > 0) { out += "/" }
        out += parts[i]
        i += 1
    }
    out
}

func kbFirstSegment(path: String): String {
    match (path.indexOf("/")) {
        case Some(position) => path[0..position]
        case None => path
    }
}

func kbWriteTextDeep(full: String, text: String): Unit {
    kbWriteFileDeep(full, text.toArray())
}

func kbWriteFileDeep(full: String, data: Array<Byte>): Unit {
    var directory = full
    match (full.lastIndexOf("/")) {
        case Some(position) => directory = full[0..position]
        case None => directory = ""
    }
    if (directory.size > 0 && !exists(Path(directory))) { Directory.create(Path(directory), recursive: true) }
    File.writeTo(Path(full), data)
}

func kbWalkFiles(base: String, prefix: String, out: ArrayList<String>, depth: Int64): Unit {
    if (depth > 8 || out.size >= 400) { return }
    let entries = try {
        Directory.readFrom(Path(base))
    } catch (_: Exception) {
        return
    }
    for (entry in entries) {
        let name = entry.name
        let child = if (prefix.size == 0) { name } else { prefix + "/" + name }
        let full = base + "/" + name
        var isDir = false
        try {
            Directory.readFrom(Path(full))
            isDir = true
        } catch (_: Exception) {
            isDir = false
        }
        if (isDir) {
            kbWalkFiles(full, child, out, depth + 1)
        } else {
            out.add(child)
        }
    }
}

/** Agent 运行日志：只保留末尾一段，避免把整段对话塞进数据库。 */
class KbAgentLog {
    private var buffer: String = ""
    private var count: Int64 = 0

    func add(line: String): Unit {
        count += 1
        buffer += line + "\n"
        if (buffer.size > 40000) {
            buffer = buffer[buffer.size - 30000..buffer.size]
        }
    }

    func text(): String {
        buffer
    }

    func steps(): Int64 {
        count
    }
}

func kbAgentToolsJson(): String {
    let tools = JsonArrWriter()
    let listTool = JsonWriter()
    listTool.putStr("type", "function")
    let listFn = JsonWriter()
    listFn.putStr("name", "list_files")
    listFn.putStr("description", "列出工作目录里的文件（相对路径）")
    let listParams = JsonWriter()
    listParams.putStr("type", "object")
    let listProps = JsonWriter()
    let dirProp = JsonWriter()
    dirProp.putStr("type", "string")
    dirProp.putStr("description", "要列出的目录，例如 in 或 in/ch01，留空表示全部")
    listProps.putRaw("dir", dirProp.toJson())
    listParams.putRaw("properties", listProps.toJson())
    listFn.putRaw("parameters", listParams.toJson())
    listTool.putRaw("function", listFn.toJson())
    tools.addRaw(listTool.toJson())

    let readTool = JsonWriter()
    readTool.putStr("type", "function")
    let readFn = JsonWriter()
    readFn.putStr("name", "read_file")
    readFn.putStr("description", "读取一个文本文件的内容")
    let readParams = JsonWriter()
    readParams.putStr("type", "object")
    let readProps = JsonWriter()
    let pathProp = JsonWriter()
    pathProp.putStr("type", "string")
    pathProp.putStr("description", "相对路径，例如 in/01.md")
    readProps.putRaw("path", pathProp.toJson())
    let limitProp = JsonWriter()
    limitProp.putStr("type", "integer")
    limitProp.putStr("description", "最多读取多少字节，默认 20000")
    readProps.putRaw("limit", limitProp.toJson())
    readParams.putRaw("properties", readProps.toJson())
    let readRequired = JsonArrWriter()
    readRequired.addRaw("\"path\"")
    readParams.putRaw("required", readRequired.toJson())
    readFn.putRaw("parameters", readParams.toJson())
    readTool.putRaw("function", readFn.toJson())
    tools.addRaw(readTool.toJson())

    let writeTool = JsonWriter()
    writeTool.putStr("type", "function")
    let writeFn = JsonWriter()
    writeFn.putStr("name", "write_file")
    writeFn.putStr("description", "把整理后的 Markdown 写入 out/ 目录，文件名以两位序号开头，例如 out/01-第一章.md")
    let writeParams = JsonWriter()
    writeParams.putStr("type", "object")
    let writeProps = JsonWriter()
    let writePath = JsonWriter()
    writePath.putStr("type", "string")
    writePath.putStr("description", "out/ 下的相对路径")
    writeProps.putRaw("path", writePath.toJson())
    let writeContent = JsonWriter()
    writeContent.putStr("type", "string")
    writeContent.putStr("description", "这一节的完整 Markdown 正文")
    writeProps.putRaw("content", writeContent.toJson())
    writeParams.putRaw("properties", writeProps.toJson())
    let writeRequired = JsonArrWriter()
    writeRequired.addRaw("\"path\"")
    writeRequired.addRaw("\"content\"")
    writeParams.putRaw("required", writeRequired.toJson())
    writeFn.putRaw("parameters", writeParams.toJson())
    writeTool.putRaw("function", writeFn.toJson())
    tools.addRaw(writeTool.toJson())

    let finishTool = JsonWriter()
    finishTool.putStr("type", "function")
    let finishFn = JsonWriter()
    finishFn.putStr("name", "finish")
    finishFn.putStr("description", "整理完成后调用，给出资料标题")
    let finishParams = JsonWriter()
    finishParams.putStr("type", "object")
    let finishProps = JsonWriter()
    let titleProp = JsonWriter()
    titleProp.putStr("type", "string")
    titleProp.putStr("description", "整理后的资料标题")
    finishProps.putRaw("title", titleProp.toJson())
    finishParams.putRaw("properties", finishProps.toJson())
    let finishRequired = JsonArrWriter()
    finishRequired.addRaw("\"title\"")
    finishParams.putRaw("required", finishRequired.toJson())
    finishFn.putRaw("parameters", finishParams.toJson())
    finishTool.putRaw("function", finishFn.toJson())
    tools.addRaw(finishTool.toJson())
    tools.toJson()
}

func kbAgentSystemPrompt(): String {
    "你是一个资料整理智能体，负责把一个结构混乱的资料包整理成规范的课程讲义。\n" +
    "工作目录里：in/ 是用户上传的原始文件（可能层级混乱、命名随意），out/ 是你的输出目录。\n" +
    "要求：\n" +
    "1. 先用 list_files 看清 in/ 的全貌，再挑关键文件用 read_file 读取（不要一次读太多，注意 limit）。\n" +
    "2. 判断内容的主线，把资料整理成有序的章节：每一节写成 out/ 下的一个 Markdown 文件，文件名形如 01-章节标题.md。\n" +
    "3. 合并重复与碎片，剔除与主题无关的素材；保留原文的事实与表述，不要编造内容，也不要加你自己的评论。\n" +
    "4. 每节正文用 Markdown，标题层级从 ## 开始；图片、附件等无法读取的文件忽略即可。\n" +
    "5. 全部写完后调用 finish，给出整理后的资料标题。不要询问用户，也不要中途停下等确认。"
}

class KbAgentResult {
    let finished: Bool
    let title: String
    let message: String

    init(finished: Bool, title: String, message: String) {
        this.finished = finished
        this.title = title
        this.message = message
    }
}

func kbJsonField(raw: String, key: String): String {
    let value = match (jsonParse(raw)) {
        case Some(parsed) => parsed
        case None => return ""
    }
    match (value.kind()) {
        case JsonKind.JsObject => jsonGetString(value.asObject(), key) ?? ""
        case _ => ""
    }
}

/** Agent 主循环：模型 → 工具调用 → 结果回填，直到 finish 或达到步数上限。 */
func kbRunAgent(endpoint: ModelEndpoint, workspace: KbWorkspace, log: KbAgentLog, maxSteps: Int64): KbAgentResult {
    let messages = ArrayList<String>()
    let systemPart = JsonWriter()
    systemPart.putStr("role", "system")
    systemPart.putStr("content", kbAgentSystemPrompt())
    messages.add(systemPart.toJson())
    let userPart = JsonWriter()
    userPart.putStr("role", "user")
    userPart.putStr("content", "请整理工作目录里的资料。先 list_files 查看 in/ 的内容。")
    messages.add(userPart.toJson())
    let tools = kbAgentToolsJson()

    var step: Int64 = 0
    while (step < maxSteps) {
        step += 1
        let payload = JsonArrWriter()
        for (message in messages) { payload.addRaw(message) }
        let turn = try {
            chatWithTools(endpoint, payload.toJson(), tools)
        } catch (error: Exception) {
            log.add("[" + step.toString() + "] 模型调用失败：" + error.message)
            return KbAgentResult(false, "", "模型调用失败：" + error.message)
        }
        if (turn.content.size > 0) {
            log.add("[" + step.toString() + "] 模型：" + kbTruncate(turn.content, 200))
        }
        if (turn.calls.size == 0) {
            // 没有工具调用也没有 finish：让模型继续，但避免死循环。
            let nudge = JsonWriter()
            nudge.putStr("role", "user")
            nudge.putStr("content", "请继续，或者调用 finish 结束。")
            messages.add(nudge.toJson())
            continue
        }
        let assistant = JsonWriter()
        assistant.putStr("role", "assistant")
        if (turn.content.size > 0) {
            assistant.putStr("content", turn.content)
        } else {
            assistant.putStr("content", "")
        }
        let callArr = JsonArrWriter()
        for (call in turn.calls) {
            let item = JsonWriter()
            item.putStr("id", call.id)
            item.putStr("type", "function")
            let fn = JsonWriter()
            fn.putStr("name", call.name)
            fn.putStr("arguments", call.arguments)
            item.putRaw("function", fn.toJson())
            callArr.addRaw(item.toJson())
        }
        assistant.putRaw("tool_calls", callArr.toJson())
        messages.add(assistant.toJson())

        for (call in turn.calls) {
            if (call.name == "finish") {
                let title = kbJsonField(call.arguments, "title")
                log.add("[" + step.toString() + "] finish：" + title)
                return KbAgentResult(true, title, "")
            }
            let outcome = kbRunTool(workspace, call.name, call.arguments)
            log.add("[" + step.toString() + "] " + call.name + " -> " + kbTruncate(outcome, 160))
            let toolMessage = JsonWriter()
            toolMessage.putStr("role", "tool")
            toolMessage.putStr("tool_call_id", call.id)
            toolMessage.putStr("content", outcome)
            messages.add(toolMessage.toJson())
        }
    }
    KbAgentResult(false, "", "达到步数上限仍未完成（" + maxSteps.toString() + " 步）")
}

func kbTruncate(text: String, limit: Int64): String {
    if (text.size <= limit) { return text }
    text[0..limit] + "…"
}

func kbRunTool(workspace: KbWorkspace, name: String, arguments: String): String {
    try {
        if (name == "list_files") {
            let dir = kbJsonField(arguments, "dir")
            return workspace.listFiles(dir)
        }
        if (name == "read_file") {
            let path = kbJsonField(arguments, "path")
            let limit = Int64.tryParse(kbJsonField(arguments, "limit")) ?? 20000
            return workspace.readFile(path, limit)
        }
        if (name == "write_file") {
            let path = kbJsonField(arguments, "path")
            let content = kbJsonField(arguments, "content")
            if (content.size == 0) { return "写入失败：content 为空" }
            if (content.size > 200000) { return "写入失败：内容超过 200KB" }
            workspace.writeFile(path, content)
            return "已写入 " + path + "（" + content.size.toString() + " 字节）"
        }
        if (name == "delete_file") {
            let path = kbJsonField(arguments, "path")
            workspace.deleteFile(path)
            return "已删除 " + path
        }
        "未知工具：" + name
    } catch (error: Exception) {
        "工具执行失败：" + error.message
    }
}
