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
    // 输出文件与原文一一关联，图片按源文件所在目录解析。
    let documentSources = HashMap<String, String>()

    init(root: String) {
        this.root = root
    }

    func resolve(relative: String, allowWrite: Bool): String {
        let cleaned = kbPathNormalize(relative)
        if (cleaned.size == 0) { throw Exception("路径为空") }
        let first = kbFirstSegment(cleaned)
        // 模型经常直接用 list_files 看到的相对路径，这里自动补上 in//out/ 前缀，仍然锁在工作区内。
        if (allowWrite) {
            if (first == "out") { return root + "/" + cleaned }
            return root + "/out/" + cleaned
        }
        if (first == "in" || first == "out") { return root + "/" + cleaned }
        root + "/in/" + cleaned
    }

    func listFiles(relative: String): String {
        let base = if (relative.size == 0) { root } else { resolve(relative, false) }
        let out = ArrayList<String>()
        kbWalkFiles(base, "", out, 0)
        let result = StringBuilder()
        var i: Int64 = 0
        out.sort()
        while (i < out.size) {
            result.append(out[i])
            result.append("\n")
            i += 1
        }
        result.toString()
    }

    func readFile(relative: String, limit: Int64): String {
        let full = resolve(relative, false)
        if (!exists(Path(full))) { throw Exception("文件不存在：" + relative) }
        let data = File.readFrom(Path(full))
        let maxBytes = if (limit <= 0) { 20000 } else if (limit > 60000) { 60000 } else { limit }
        if (data.size <= maxBytes) { return String.fromUtf8(data) }
        // 按 UTF-8 边界回退，切在半个汉字上会直接抛异常
        var take = maxBytes
        while (take > 0 && !kbIsLeadByte(data[take])) { take -= 1 }
        String.fromUtf8(data.slice(0, take)) + "\n…（已截断）"
    }

    func copyDocument(source: String, destination: String): String {
        let input = kbInputDocumentPath(source)
        var output = kbPathNormalize(destination)
        if (output.startsWith("out/")) { output = output[4..output.size] }
        if (!output.toAsciiLower().endsWith(".md")) { throw Exception("输出章节须使用 .md 后缀") }
        if (!kbIsSourceDocument(input)) { throw Exception("只把 Markdown、文本和 RST 文件作为章节，图片由资源处理保留") }
        for ((saved, original) in documentSources) {
            if (saved.toAsciiLower() == output.toAsciiLower() && (saved != output || original != input)) {
                throw Exception("输出文件已占用，请使用不同的章节文件名：" + output)
            }
            if (original == input && saved != output) { throw Exception("原文已经保存在 " + saved + "，不应重复生成") }
        }
        let full = root + "/in/" + input
        if (!exists(Path(full))) { throw Exception("原文件不存在：" + input) }
        let bytes = File.readFrom(Path(full))
        // 校验文本编码，但复制完整文件，不受 read_file 的预览长度限制。
        let _text = String.fromUtf8(bytes)
        kbWriteFileDeep(root + "/out/" + output, bytes)
        documentSources[output] = input
        "已原样保留 " + input + " → " + output + "（" + bytes.size.toString() + " 字节）"
    }

    func formatDocument(relative: String, before: String, after: String): String {
        var output = kbPathNormalize(relative)
        if (output.startsWith("out/")) { output = output[4..output.size] }
        if (!documentSources.contains(output)) { throw Exception("请先用 copy_document / organize_documents 保留原文") }
        if (before.size == 0 || before == after) { throw Exception("请提供实际需要修复的格式片段") }
        // 只允许增加/去除 Markdown 标记与排版空白；词句、标点、数字和 URL 不可改写。
        if (kbFormatFingerprint(before) != kbFormatFingerprint(after)) {
            throw Exception("拒绝修改：只能修复 Markdown 格式，不能改变原文措辞、标点或链接")
        }
        let full = root + "/out/" + output
        let content = String.fromUtf8(File.readFrom(Path(full)))
        if (!content.contains(before)) { throw Exception("没有找到该原文片段") }
        let next = content.replace(before, after)
        if (kbProtectedLiterals(content) != kbProtectedLiterals(next)) {
            throw Exception("拒绝修改：代码和数学公式须保留原样")
        }
        kbWriteTextDeep(full, next)
        "已修复格式，原文措辞保持不变：" + output
    }

    func missingDocuments(): String {
        let files = ArrayList<String>()
        kbWalkFiles(root + "/in", "", files, 0)
        files.sort()
        let included = HashSet<String>()
        for ((_, original) in documentSources) { included.add(original) }
        let missing = StringBuilder()
        for (file in files) {
            if (kbIsSourceDocument(file) && !included.contains(file)) { missing.append(file + "\n") }
        }
        missing.toString()
    }
}

func kbInputDocumentPath(raw: String): String {
    let path = kbPathNormalize(raw)
    if (path.startsWith("out/")) { throw Exception("源文件必须来自 in/ 目录") }
    if (path.startsWith("in/")) { path[3..path.size] } else { path }
}

func kbIsSourceDocument(path: String): Bool {
    let lower = path.toAsciiLower()
    lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdx") ||
        lower.endsWith(".txt") || lower.endsWith(".rst")
}

func kbFormatWord(byte: Byte): Bool {
    byte >= 128 || (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)
}

func kbFormatFingerprint(text: String): String {
    let bytes = text.toArray()
    let result = ArrayList<Byte>()
    var i: Int64 = 0
    while (i < bytes.size) {
        let byte = bytes[i]
        if (byte == 9 || byte == 10 || byte == 13 || byte == 32) {
            var next = i + 1
            while (next < bytes.size && (bytes[next] == 9 || bytes[next] == 10 || bytes[next] == 13 || bytes[next] == 32)) { next += 1 }
            if (result.size > 0 && next < bytes.size && kbFormatWord(result[result.size - 1]) && kbFormatWord(bytes[next])) { result.add(32) }
            i = next
            continue
        }
        if (byte == 35 || byte == 42 || byte == 95 || byte == 96 || byte == 126) {
            var end = i + 1
            while (end < bytes.size && bytes[end] == byte) { end += 1 }
            // An underscore/star inside a name or expression is content, not a formatting marker.
            if (end == i + 1 && i > 0 && end < bytes.size && kbFormatWord(bytes[i - 1]) && kbFormatWord(bytes[end])) { result.add(byte) }
            i = end
            continue
        }
        result.add(byte)
        i += 1
    }
    String.fromUtf8(result.toArray())
}

// Fenced blocks, inline code and all supported TeX delimiters are immutable.
func kbProtectedLiterals(text: String): String {
    let out = ArrayList<Byte>()
    var fence = ""
    var marker: Byte = 0
    var markerLength: Int64 = 0
    var bracket: Byte = 0
    for (line in text.split("\n")) {
        let trimmed = line.trimAscii()
        if (fence.size > 0) {
            for (byte in (line + "\n").toArray()) { out.add(byte) }
            if (trimmed.startsWith(fence)) { fence = "" }
            continue
        }
        if (marker == 0 && (trimmed.startsWith("```") || trimmed.startsWith("~~~"))) {
            fence = trimmed[0..3]
            for (byte in (line + "\n").toArray()) { out.add(byte) }
            continue
        }
        let bytes = line.toArray()
        var i: Int64 = 0
        while (i < bytes.size) {
            let byte = bytes[i]
            if (marker == 92) {
                out.add(byte)
                if (byte == 92 && i + 1 < bytes.size && bytes[i + 1] == bracket) {
                    out.add(bytes[i + 1]); i += 2; marker = 0; continue
                }
            } else if (byte == 96 || byte == 36) {
                var run: Int64 = 1
                while (i + run < bytes.size && bytes[i + run] == byte) { run += 1 }
                if (marker == 0) {
                    marker = byte; markerLength = run; out.add(124)
                    var n: Int64 = 0
                    while (n < run) { out.add(byte); n += 1 }
                } else if (marker == byte && run == markerLength) {
                    var n: Int64 = 0
                    while (n < run) { out.add(byte); n += 1 }
                    marker = 0
                } else if (marker != 0) {
                    var n: Int64 = 0
                    while (n < run) { out.add(byte); n += 1 }
                }
                i += run; continue
            } else if (marker == 0 && byte == 92 && i + 1 < bytes.size && (bytes[i + 1] == 40 || bytes[i + 1] == 91)) {
                marker = 92; bracket = if (bytes[i + 1] == 40) { 41 } else { 93 }
                out.add(124); out.add(byte); out.add(bytes[i + 1]); i += 2; continue
            } else if (marker != 0) { out.add(byte) }
            i += 1
        }
        if (marker != 0) { out.add(10) }
    }
    String.fromUtf8(out.toArray())
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
    if (depth > 32 || out.size > 4000) { throw Exception("资料目录过深或文件数超过 4000，未截断内容，请拆分上传") }
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
            buffer = kbTailText(buffer, 30000)
        }
    }

    func text(): String {
        buffer
    }

    func steps(): Int64 {
        count
    }
}

func kbToolProperty(description: String): String {
    let out = JsonWriter()
    out.putStr("type", "string")
    out.putStr("description", description)
    out.toJson()
}

func kbAgentTool(name: String, description: String, properties: JsonWriter, required: Array<String>): String {
    let params = JsonWriter()
    params.putStr("type", "object")
    params.putRaw("properties", properties.toJson())
    let mandatory = JsonArrWriter()
    for (key in required) { mandatory.addRaw(jsonQuote(key)) }
    params.putRaw("required", mandatory.toJson())
    let fn = JsonWriter()
    fn.putStr("name", name)
    fn.putStr("description", description)
    fn.putRaw("parameters", params.toJson())
    let tool = JsonWriter()
    tool.putStr("type", "function")
    tool.putRaw("function", fn.toJson())
    tool.toJson()
}

func kbAgentToolsJson(): String {
    let tools = JsonArrWriter()
    let list = JsonWriter()
    list.putRaw("dir", kbToolProperty("相对目录，例如 in 或 in/docs，留空列出全部"))
    tools.addRaw(kbAgentTool("list_files", "列出资料目录的完整文件清单，包含文档与图片", list, []))

    let read = JsonWriter()
    read.putRaw("path", kbToolProperty("源文件相对路径，例如 in/docs/章节.md"))
    let limit = JsonWriter()
    limit.putStr("type", "integer")
    limit.putStr("description", "预览的最大字节数，默认20000；整理复制完整原文，不受预览截断影响")
    read.putRaw("limit", limit.toJson())
    tools.addRaw(kbAgentTool("read_file", "预览原文以判断章节顺序；图片无需读取二进制", read, ["path"]))

    let copy = JsonWriter()
    copy.putRaw("source", kbToolProperty("in/下的原文路径，完整原文由工具直接复制"))
    copy.putRaw("path", kbToolProperty("out/下输出Markdown路径，序号+原章节名，例如 out/01-前言.md"))
    tools.addRaw(kbAgentTool("copy_document", "完整保留一篇原文，仅指定输出位置与顺序；自动保留图片引用关联", copy, ["source", "path"]))

    let items = JsonWriter()
    items.putStr("type", "object")
    items.putRaw("properties", copy.toJson())
    items.putRaw("required", "[\"source\",\"path\"]")
    let documentList = JsonWriter()
    documentList.putStr("type", "array")
    documentList.putRaw("items", items.toJson())
    let batch = JsonWriter()
    batch.putRaw("documents", documentList.toJson())
    tools.addRaw(kbAgentTool("organize_documents", "一次安排多篇原文的章节顺序并完整复制，推荐批量调用以尽快完成；禁止遗漏或概括原文", batch, ["documents"]))

    let format = JsonWriter()
    format.putRaw("path", kbToolProperty("已复制到out/下的Markdown文件"))
    format.putRaw("before", kbToolProperty("需要微调的原文格式片段，必须精确匹配"))
    format.putRaw("after", kbToolProperty("仅修Markdown标记/空白后的片段；所有措辞、标点、数字、链接和代码须不变"))
    tools.addRaw(kbAgentTool("format_document", "可选：微调排版，禁止改写、总结、翻译、增删正文；图片相对路径由系统自动修复", format, ["path", "before", "after"]))

    let finish = JsonWriter()
    finish.putRaw("title", kbToolProperty("保留原资料标题，不能自行概括内容"))
    tools.addRaw(kbAgentTool("finish", "全部原文组织完后结束；遗漏文档会退回继续处理，不能丢弃图片", finish, ["title"]))
    tools.toJson()
}

func kbAgentSystemPrompt(): String {
    "你是资料整理智能体，只负责组织原文和微调格式，不是课程作者，也不是摘要或翻译工具。\n" +
    "in/是原始文件，out/是结果。你的组织决策由工具执行，正文必须来自对应源文件。\n" +
    "1. list_files查看全部目录，选取必要的文件用read_file了解章节与顺序，不必逐篇完整阅读或在回答里重复原文。\n" +
    "2. 使用organize_documents批量安排全部Markdown、txt、rst文件，或用copy_document逐篇复制。输出名称为out/01-原章节名.md。复制保留完整原文，即使read_file只显示了开头，也不会截断最终正文。\n" +
    "3. 必须保留原文措辞、语言、章节、例子、公式、代码、表格、图片和链接。不得总结、重写、翻译、合并删减、去重或新增解释；不同语言版本与看似重复的文档也分别保留。\n" +
    "4. 图片无需用read_file读取或重新生成。网页图片保持原URL；包内图片按源文档的相对目录自动搬运并修复访问路径，../、中文及空格均支持。不得移除或改写图片标记和alt文字。\n" +
    "5. 仅确有格式错误才用format_document做小幅修复，不能改变词句、标点、数字、代码或链接。优先原样保留，已有的Markdown和TeX公式不需要转译。\n" +
    "6. 全部文件组织完后调用finish。系统会检查是否有遗漏，若退回就继续纳入。不要询问用户，不要等确认，不要编造缺失资源。"
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
            var outcome = ""
            if (call.name == "finish") {
                let missing = workspace.missingDocuments()
                if (missing.size == 0) {
                    let title = kbJsonField(call.arguments, "title")
                    log.add("[" + step.toString() + "] finish：" + title + "（原文已完整保留）")
                    return KbAgentResult(true, title, "")
                }
                outcome = "尚未完成。以下原文尚未保留，请用organize_documents全部纳入，不得删除或总结：\n" + missing
            } else {
                outcome = kbRunTool(workspace, call.name, call.arguments)
            }
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

/** 按 UTF-8 字符边界截断；直接按字节切会切出半个汉字并抛异常。 */
func kbTruncate(text: String, limit: Int64): String {
    let bytes = text.toArray()
    if (bytes.size <= limit) { return text }
    var end = limit
    while (end > 0 && !kbIsLeadByte(bytes[end])) { end -= 1 }
    String.fromUtf8(bytes.slice(0, end)) + "…"
}

func kbTailText(text: String, keepBytes: Int64): String {
    let bytes = text.toArray()
    if (bytes.size <= keepBytes) { return text }
    var start = bytes.size - keepBytes
    while (start < bytes.size && !kbIsLeadByte(bytes[start])) { start += 1 }
    String.fromUtf8(bytes.slice(start, bytes.size - start))
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
        if (name == "copy_document") {
            return workspace.copyDocument(kbJsonField(arguments, "source"), kbJsonField(arguments, "path"))
        }
        if (name == "organize_documents") {
            let parsed = jsonParse(arguments).getOrThrow()
            let documents = jsonGetArray(parsed.asObject(), "documents").getOrThrow()
            var index: Int64 = 0
            let result = StringBuilder()
            while (index < documents.size()) {
                let doc = documents[index].asObject()
                result.append(workspace.copyDocument(jsonGetString(doc, "source") ?? "", jsonGetString(doc, "path") ?? "") + "\n")
                index += 1
            }
            return result.toString()
        }
        if (name == "format_document") {
            return workspace.formatDocument(kbJsonField(arguments, "path"),
                kbJsonField(arguments, "before"), kbJsonField(arguments, "after"))
        }
        "未知工具：" + name
    } catch (error: Exception) {
        "工具执行失败：" + error.message
    }
}
