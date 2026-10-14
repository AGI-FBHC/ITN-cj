package itn_desktop_core.agent

import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import itn_desktop_core.store.*
import itn_desktop_core.llm.*
import itn_desktop_core.kb.*
import itn_desktop_core.tools.*
import itn_desktop_core.session.*
import itn_desktop_core.util.*

func stepPayload(index: Int64, name: String): JsonObject {
    let o = JsonObject()
    o.put("index", JsonInt(index))
    o.put("name", JsonString(name))
    return o
}

/** 把检索命中拼成模型可读的上下文，每条带编号出处。 */
public func contextFromHits(hits: JsonArray): String {
    let sb = StringBuilder()
    var i = 0
    while (i < hits.size()) {
        let n = i + 1
        sb.append("[")
        sb.append(n.toString())
        sb.append("] ")
        match (objOf(hits[i])) {
            case Some(h) =>
                sb.append("《")
                sb.append(strOf(h, "docTitle"))
                sb.append("》")
                let hp = strOf(h, "headingPath")
                if (hp.size > 0) {
                    sb.append(" · ")
                    sb.append(hp)
                }
                sb.append("（")
                sb.append(strOf(h, "docPath"))
                sb.append("）\n")
                sb.append(strOf(h, "text"))
                let cap = strOf(h, "caption")
                if (cap.size > 0) {
                    sb.append("\n[图片描述] ")
                    sb.append(cap)
                }
            case None => ()
        }
        sb.append("\n\n")
        i = i + 1
    }
    return sb.toString()
}

/** 列出出处，供界面展示与产物附录使用。 */
public func citationsFromHits(hits: JsonArray): JsonArray {
    let arr = JsonArray()
    var i = 0
    while (i < hits.size()) {
        match (objOf(hits[i])) {
            case Some(h) =>
                let c = JsonObject()
                c.put("index", JsonInt(i + 1))
                c.put("docTitle", JsonString(strOf(h, "docTitle")))
                c.put("docPath", JsonString(strOf(h, "docPath")))
                c.put("headingPath", JsonString(strOf(h, "headingPath")))
                arr.add(c)
            case None => ()
        }
        i = i + 1
    }
    return arr
}

/** 统计产物的引用覆盖情况：段落数、带引用的段落数、越界引用编号。 */
public func citationReport(markdown: String, sourceCount: Int64): JsonObject {
    var paragraphs: Int64 = 0
    var cited: Int64 = 0
    var outOfRange: Int64 = 0
    for (block in markdown.split("\n\n")) {
        let t = trimStr(block)
        if (t.size == 0 || t.toArray()[0] == 35) {
            continue
        }
        paragraphs = paragraphs + 1
        let marks = scanCitations(t)
        if (marks.size > 0) {
            cited = cited + 1
        }
        for (m in marks) {
            if (m > sourceCount) {
                outOfRange = outOfRange + 1
            }
        }
    }
    let o = JsonObject()
    o.put("paragraphs", JsonInt(paragraphs))
    o.put("citedParagraphs", JsonInt(cited))
    o.put("outOfRange", JsonInt(outOfRange))
    return o
}

/** 扫描文本里的 [n] 引用标记，返回编号列表。 */
public func scanCitations(text: String): ArrayList<Int64> {
    let out = ArrayList<Int64>()
    let b = text.toArray()
    var i = 0
    while (i < b.size) {
        if (b[i] == 91) {
            var j = i + 1
            var digits = ArrayList<UInt8>()
            while (j < b.size && b[j] >= 48 && b[j] <= 57) {
                digits.add(b[j])
                j = j + 1
            }
            if (digits.size > 0 && j < b.size && b[j] == 93) {
                out.add(Int64.parse(String.fromUtf8(digits.toArray())))
                i = j
            }
        }
        i = i + 1
    }
    return out
}

func quotedStrings(text: String): ArrayList<String> {
    let out = ArrayList<String>()
    let b = text.toArray()
    var i = 0
    while (i < b.size) {
        if (b[i] == 34) {
            var j = i + 1
            while (j < b.size && b[j] != 34) {
                j = j + 1
            }
            if (j < b.size) {
                let s = trimStr(String.fromUtf8(b[(i + 1)..j]))
                if (s.size > 0) {
                    out.add(s)
                }
                i = j
            }
        }
        i = i + 1
    }
    return out
}

/** 按字节数截断字符串，但不切断多字节字符（切断会抛 Invalid utf8）。 */
func byteSafePrefix(s: String, maxBytes: Int64): String {
    let b = s.toArray()
    if (b.size <= maxBytes) {
        return s
    }
    var end = maxBytes
    while (end > 0 && (b[end] & 192) == 128) {
        end = end - 1
    }
    if (end <= 0) {
        return ""
    }
    return String.fromUtf8(b[0..end])
}

/** 从 start 处的左花括号找到配对的右花括号，返回下标；找不到返回 -1。 */
func matchBrace(b: Array<UInt8>, start: Int64): Int64 {
    var depth = 0
    var inStr = false
    var esc = false
    var i = start
    while (i < b.size) {
        let c = b[i]
        if (inStr) {
            if (esc) {
                esc = false
            } else if (c == 92) {
                esc = true
            } else if (c == 34) {
                inStr = false
            }
        } else {
            if (c == 34) {
                inStr = true
            } else if (c == 123 || c == 91) {
                depth = depth + 1
            } else if (c == 125 || c == 93) {
                depth = depth - 1
                if (depth == 0) {
                    return i
                }
            }
        }
        i = i + 1
    }
    return -1
}

/**
 * 从模型回复里提取工具调用。
 *
 * 约定：需要调用工具时模型只输出一个 JSON 对象 `{"tool":"...","args":{...}}`。
 * 之所以不用 OpenAI 的 function calling：那套要供应商支持，而用户可能接任何
 * OpenAI 兼容服务（比如只提供 /chat/completions 的自建网关）。提示词协议到处都能跑。
 */
/**
 * 去掉正文开头重复的标题行。
 *
 * 模型写小节正文时经常先把小节标题再抄一遍，于是落盘的讲义里同一句话会出现三次
 * （大纲一行、我们拼的 `## n 标题` 一行、模型正文里一行），翻页播放时还会多出一页空白。
 * 只去 1~2 级标题：`###` 及以下属于真正的子结构，保留。
 */
func stripLeadingSectionHeadings(text: String): String {
    let lines = text.split("\n")
    var i: Int64 = 0
    while (i < lines.size) {
        let t = trimStr(lines[i])
        if (t.size == 0) {
            i = i + 1
            continue
        }
        var hashes: Int64 = 0
        let b = t.toArray()
        while (hashes < b.size && b[hashes] == 35) {
            hashes = hashes + 1
        }
        if (hashes > 0 && hashes <= 2) {
            i = i + 1
            continue
        }
        break
    }
    let sb = StringBuilder()
    var first = true
    var j = i
    while (j < lines.size) {
        if (!first) {
            sb.append("\n")
        }
        sb.append(lines[j])
        first = false
        j = j + 1
    }
    return trimStr(sb.toString())
}

func extractToolCall(text: String): ?JsonObject {
    let b = text.toArray()
    var i = 0
    while (i < b.size) {
        if (b[i] == 123) {
            let end = matchBrace(b, i)
            if (end > i) {
                let seg = String.fromUtf8(b[i..(end + 1)])
                try {
                    match (objOf(JsonValue.fromStr(seg))) {
                        case Some(o) =>
                            if (strOf(o, "tool").size > 0) {
                                return Some(o)
                            }
                        case None => ()
                    }
                } catch (e: Exception) {
                    ()
                }
            }
            if (end > i) {
                i = end
            }
        }
        i = i + 1
    }
    return None
}

public class Agent {
    public let store: Store
    public let sessions: SessionStore
    public let tools: ToolRegistry

    public let box: ToolBox

    public init(store: Store) {
        this.store = store
        this.sessions = SessionStore(store.dataDir)
        this.tools = ToolRegistry(store)
        this.box = ToolBox(store)
    }

    /** 从事件流里取最近若干轮对话，供多轮上下文使用。 */
    func history(sessionId: String, maxTurns: Int64): JsonArray {
        let msgs = JsonArray()
        let collected = ArrayList<JsonObject>()
        for (e in sessions.events(sessionId)) {
            let kind = strOf(e, "type")
            if (kind != "user/message" && kind != "assistant/message") {
                continue
            }
            var text = ""
            match (e.get("payload")) {
                case Some(pv) =>
                    match (objOf(pv)) {
                        case Some(po) => text = strOf(po, "text")
                        case None => ()
                    }
                case None => ()
            }
            if (text.size == 0) {
                continue
            }
            let m = JsonObject()
            m.put("role", JsonString(if (kind == "user/message") { "user" } else { "assistant" }))
            m.put("content", JsonString(byteSafePrefix(text, 800)))
            collected.add(m)
        }
        let keep = maxTurns * 2
        var start: Int64 = 0
        if (collected.size > keep) {
            start = collected.size - keep
        }
        var i = start
        while (i < collected.size) {
            msgs.add(collected[i])
            i = i + 1
        }
        return msgs
    }

    /** 按名字执行工具。只做本地操作，失败返回 ok=false。 */
    func executeTool(name: String, args: JsonObject, kbId: String, sessionId: String): ToolResult {
        if (name == "kb_search") {
            var topK: Int64 = 6
            let k = intOf(args, "top_k")
            if (k > 0) {
                topK = k
            }
            return tools.kbSearch(kbId, strOf(args, "query"), topK)
        }
        if (name == "list_documents") {
            return box.listDocuments(kbId)
        }
        if (name == "read_chunk") {
            return box.readChunk(kbId, strOf(args, "chunk_id"))
        }
        if (name == "current_time") {
            return box.currentTime()
        }
        if (name == "calc") {
            return box.calc(strOf(args, "expr"))
        }
        if (name == "save_note") {
            return box.saveNote(kbId, "", strOf(args, "title"), strOf(args, "text"))
        }
        if (name == "save_artifact") {
            return tools.saveArtifact(strOf(args, "name"), strOf(args, "content"))
        }
        let r = ToolResult()
        r.name = name
        r.ok = false
        r.summary = "没有这个工具：" + name
        return r
    }

    /**
     * 把工具结果整理成给模型看的文本。
     * 工具补充结果统一用 [T1] 前缀，与正文引用 [n] 区分开——否则模型会拿工具结果的
     * 序号去引用，和界面上按资料顺序生成的出处列表对不上。
     */
    func toolResultText(res: ToolResult): String {
        let sb = StringBuilder()
        sb.append(res.summary)
        sb.append("\n")
        match (res.data) {
            case a: JsonArray =>
                var i = 0
                while (i < a.size()) {
                    match (objOf(a[i])) {
                        case Some(o) =>
                            sb.append("[T")
                            sb.append((i + 1).toString())
                            sb.append("] ")
                            let title = strOf(o, "docTitle")
                            if (title.size > 0) {
                                sb.append("《")
                                sb.append(title)
                                sb.append("》 ")
                            }
                            let hp = strOf(o, "headingPath")
                            if (hp.size > 0) {
                                sb.append(hp)
                                sb.append(" ")
                            }
                            sb.append("id=")
                            sb.append(strOf(o, "id"))
                            sb.append("\n")
                            sb.append(byteSafePrefix(strOf(o, "text"), 700))
                            sb.append("\n")
                        case None => ()
                    }
                    i = i + 1
                }
            case o: JsonObject => sb.append(o.toString())
            case sv: JsonString => sb.append(sv.getValue())
            case _ => ()
        }
        return sb.toString()
    }

    /** 供界面展示的工具清单。 */
    public func toolsJson(): JsonArray {
        let arr = JsonArray()
        for (t in toolCatalog()) {
            let o = JsonObject()
            o.put("name", JsonString(t.name))
            o.put("title", JsonString(t.title))
            o.put("usage", JsonString(t.usage))
            o.put("desc", JsonString(t.desc))
            arr.add(o)
        }
        return arr
    }

    func log(sessionId: String, turnId: String, kind: String, payload: JsonObject): Unit {
        let e = SessionEvent()
        e.sessionId = sessionId
        e.turnId = turnId
        e.kind = kind
        e.payload = payload
        sessions.append(e)
    }

    func chatClient(): ?LlmClient {
        let s = store.load()
        if (s.chatModelId.size == 0) {
            return None
        }
        match (s.findModel(s.chatModelId)) {
            case Some(cfg) => return Some(LlmClient(cfg))
            case None => return None
        }
    }

    /** 检索一次，返回 json 数组形式命中，并写入会话事件。 */
    func retrieve(sessionId: String, turnId: String, kbId: String, query: String, topK: Int64): JsonArray {
        log(sessionId, turnId, "tool/call", callPayload("kb_search", query))
        let res = tools.kbSearch(kbId, query, topK)
        let rp = JsonObject()
        rp.put("tool", JsonString("kb_search"))
        rp.put("ok", JsonBool(res.ok))
        rp.put("summary", JsonString(res.summary))
        log(sessionId, turnId, "tool/result", rp)
        match (res.data) {
            case a: JsonArray => return a
            case _ => return JsonArray()
        }
    }

    /**
     * 主链路一：检索增强问答。
     *
     * 与第一版的区别：会带上会话历史（多轮），并允许模型在作答前调用本地工具。
     * 每收到一段正文就写一条 assistant/delta 事件，界面靠轮询这些事件做流式输出——
     * 内核的 HTTP 服务是多线程的，长生成不会挡住其他请求，所以不需要另做 SSE。
     */
    public func ask(kbId: String, question: String, sessionIdIn: String): JsonObject {
        var sessionId = sessionIdIn
        if (sessionId.size == 0) {
            sessionId = sessions.newId()
        }
        // 历史必须在写入本轮提问之前取，否则本轮问题会被当成历史再喂给模型
        let hist = history(sessionId, 6)
        let turnId = sessions.newTurnId()
        // 流式回调是闭包，只能捕获不可变变量，这里留一份只读副本
        let sid = sessionId
        let tid = turnId
        log(sessionId, turnId, "turn/start", kindPayload("ask"))
        let up = JsonObject()
        up.put("text", JsonString(question))
        log(sessionId, turnId, "user/message", up)

        let out = JsonObject()
        out.put("sessionId", JsonString(sessionId))

        match (chatClient()) {
            case None =>
                log(sessionId, turnId, "turn/end", endPayload(false, "没有可用的对话模型"))
                out.put("ok", JsonBool(false))
                out.put("message", JsonString("没有可用的对话模型，请先在设置里配置"))
                return out
            case Some(client) =>
                log(sessionId, turnId, "step/start", stepPayload(1, "retrieve"))
                let hits = retrieve(sessionId, turnId, kbId, question, 6)
                log(sessionId, turnId, "step/end", stepPayload(1, "retrieve"))

                let system = "你是教培内容助手。只能依据给定资料回答，每个论断后用 [编号] 标注出处；资料中没有的内容要明确说明不知道，不要补充资料之外的信息。" + "\n\n" + toolPrompt()
                let msgs = JsonArray()
                let sysMsg = JsonObject()
                sysMsg.put("role", JsonString("system"))
                sysMsg.put("content", JsonString(system))
                msgs.add(sysMsg)
                var hi: Int64 = 0
                while (hi < hist.size()) {
                    msgs.add(hist[hi])
                    hi = hi + 1
                }
                let usr = JsonObject()
                usr.put("role", JsonString("user"))
                usr.put("content", JsonString("资料：\n" + contextFromHits(hits) + "\n问题：" + question))
                msgs.add(usr)

                var answer = ""
                var round: Int64 = 0
                var toolCalls: Int64 = 0
                let used = ArrayList<String>()
                var guard: Int64 = 0
                while (guard < 5) {
                    round = round + 1
                    guard = round
                    log(sessionId, turnId, "step/start", stepPayload(10 + round, "model_call"))
                    var reply = ""
                    try {
                        reply = client.chatMessagesStream(msgs, { piece: String =>
                            let dp = JsonObject()
                            dp.put("text", JsonString(piece))
                            log(sid, tid, "assistant/delta", dp)
                        })
                    } catch (e: Exception) {
                        log(sessionId, turnId, "turn/end", endPayload(false, e.message))
                        out.put("ok", JsonBool(false))
                        out.put("message", JsonString("生成失败：" + e.message))
                        return out
                    }
                    log(sessionId, turnId, "step/end", stepPayload(10 + round, "model_call"))
                    match (extractToolCall(reply)) {
                        case Some(call) =>
                            let name = strOf(call, "tool")
                            var args = JsonObject()
                            match (call.get("args")) {
                                case Some(av) =>
                                    match (objOf(av)) {
                                        case Some(ao) => args = ao
                                        case None => ()
                                    }
                                case None => ()
                            }
                            let cp = JsonObject()
                            cp.put("tool", JsonString(name))
                            cp.put("args", args)
                            log(sessionId, turnId, "tool/call", cp)
                            log(sessionId, turnId, "step/start", stepPayload(30 + round, "tool_exec"))
                            let res = executeTool(name, args, kbId, sessionId)
                            let rp = JsonObject()
                            rp.put("tool", JsonString(name))
                            rp.put("ok", JsonBool(res.ok))
                            rp.put("summary", JsonString(res.summary))
                            log(sessionId, turnId, "tool/result", rp)
                            log(sessionId, turnId, "step/end", stepPayload(30 + round, "tool_exec"))
                            toolCalls = toolCalls + 1
                            used.add(name)
                            let am = JsonObject()
                            am.put("role", JsonString("assistant"))
                            am.put("content", JsonString(reply))
                            msgs.add(am)
                            let trm = JsonObject()
                            trm.put("role", JsonString("user"))
                            trm.put("content", JsonString("工具 " + name + " 的结果：\n" + toolResultText(res) +
                                "\n请基于这些结果继续回答。引用编号只能用资料里的 [n]，工具结果不要编号引用。"))
                            msgs.add(trm)
                        case None =>
                            answer = reply
                            guard = 99
                    }
                }
                if (answer.size == 0) {
                    answer = "（这一轮没有拿到可用的回答，可以换个问法，或检查模型配置）"
                }
                let ap = JsonObject()
                ap.put("text", JsonString(answer))
                log(sessionId, turnId, "assistant/message", ap)

                log(sessionId, turnId, "step/start", stepPayload(100, "citation_check"))
                let report = citationReport(answer, hits.size())
                let vp = JsonObject()
                vp.put("report", report)
                // 出处也写进事件：重新打开历史会话时，界面仍能还原"[1] 出自哪篇资料"
                vp.put("citations", citationsFromHits(hits))
                log(sessionId, turnId, "validation", vp)
                log(sessionId, turnId, "step/end", stepPayload(100, "citation_check"))

                log(sessionId, turnId, "turn/end", endPayload(true, ""))
                out.put("ok", JsonBool(true))
                out.put("answer", JsonString(answer))
                out.put("citations", citationsFromHits(hits))
                out.put("citationReport", report)
                out.put("toolCalls", JsonInt(toolCalls))
                let ua = JsonArray()
                for (u in used) {
                    ua.add(JsonString(u))
                }
                out.put("toolsUsed", ua)
                return out
        }
    }

    /** 主链路二：从知识库生成讲义，落成本地 Markdown。 */
    public func lecture(kbId: String, topic: String, sessionIdIn: String): JsonObject {
        var sessionId = sessionIdIn
        if (sessionId.size == 0) {
            sessionId = sessions.newId()
        }
        let turnId = sessions.newTurnId()
        log(sessionId, turnId, "turn/start", kindPayload("lecture"))
        let up = JsonObject()
        up.put("text", JsonString("生成讲义：" + topic))
        log(sessionId, turnId, "user/message", up)

        let out = JsonObject()
        out.put("sessionId", JsonString(sessionId))

        match (chatClient()) {
            case None =>
                log(sessionId, turnId, "turn/end", endPayload(false, "没有可用的对话模型"))
                out.put("ok", JsonBool(false))
                out.put("message", JsonString("没有可用的对话模型，请先在设置里配置"))
                return out
            case Some(client) =>
                log(sessionId, turnId, "step/start", stepPayload(1, "retrieve"))
                let hits = retrieve(sessionId, turnId, kbId, topic, 10)
                log(sessionId, turnId, "step/end", stepPayload(1, "retrieve"))
                if (hits.size() == 0) {
                    log(sessionId, turnId, "turn/end", endPayload(false, "没有检索到资料"))
                    out.put("ok", JsonBool(false))
                    out.put("message", JsonString("知识库里没有检索到与该主题相关的内容"))
                    return out
                }
                let context = contextFromHits(hits)

                // step 2：大纲
                log(sessionId, turnId, "step/start", stepPayload(2, "outline"))
                var outline = ArrayList<String>()
                try {
                    let outlineText = client.chat(
                        "你是教培内容编辑。",
                        "依据下面的资料，为《" + topic + "》拟一份讲义大纲，最多 5 个小节。只输出一个 JSON 字符串数组，不要任何解释。\n\n资料：\n" + context
                    )
                    outline = quotedStrings(outlineText)
                } catch (e: Exception) {
                    ()
                }
                if (outline.size == 0) {
                    outline.add(topic)
                }
                if (outline.size > 5) {
                    let trimmed = ArrayList<String>()
                    var i = 0
                    while (i < 5) {
                        trimmed.add(outline[i])
                        i = i + 1
                    }
                    outline = trimmed
                }
                let op = JsonObject()
                let oarr = JsonArray()
                for (s in outline) {
                    oarr.add(JsonString(s))
                }
                op.put("sections", oarr)
                log(sessionId, turnId, "step/end", stepPayload(2, "outline"))

                // step 3..n：逐节写
                let body = StringBuilder()
                var idx: Int64 = 0
                for (section in outline) {
                    idx = idx + 1
                    log(sessionId, turnId, "step/start", stepPayload(2 + idx, "write_section"))
                    var text = ""
                    try {
                        text = client.chat(
                            "你是教培内容作者。只能依据给定资料写作，每个论断后用 [编号] 标注出处，不要编造资料之外的内容。输出 Markdown。",
                            "依据下面的资料，撰写《" + topic + "》讲义的第 " + idx.toString() + " 节：「" + section + "」。\n\n资料：\n" + context
                        )
                    } catch (e: Exception) {
                        text = "（本节生成失败：" + e.message + "）"
                    }
                    body.append("## ")
                    body.append(idx.toString())
                    body.append(" ")
                    body.append(section)
                    body.append("\n\n")
                    body.append(stripLeadingSectionHeadings(text))
                    body.append("\n\n")
                    let sp = JsonObject()
                    sp.put("section", JsonString(section))
                    let tp = JsonObject()
                    tp.put("chars", JsonInt(text.size))
                    log(sessionId, turnId, "section/done", sp)
                    log(sessionId, turnId, "step/end", stepPayload(2 + idx, "write_section"))
                }

                // step n+1：引用自检
                log(sessionId, turnId, "step/start", stepPayload(100, "citation_check"))
                let draft = "# " + topic + "\n\n" + body.toString()
                let report = citationReport(draft, hits.size())
                let vp = JsonObject()
                vp.put("report", report)
                vp.put("citations", citationsFromHits(hits))
                log(sessionId, turnId, "validation", vp)
                log(sessionId, turnId, "step/end", stepPayload(100, "citation_check"))

                // 附录出处
                let full = StringBuilder()
                full.append(draft)
                full.append("\n\n---\n\n## 资料来源\n\n")
                var n: Int64 = 0
                while (n < hits.size()) {
                    match (objOf(hits[n])) {
                        case Some(h) =>
                            full.append("- [")
                            full.append((n + 1).toString())
                            full.append("] 《")
                            full.append(strOf(h, "docTitle"))
                            full.append("》")
                            let hp = strOf(h, "headingPath")
                            if (hp.size > 0) {
                                full.append(" · ")
                                full.append(hp)
                            }
                            full.append("（")
                            full.append(strOf(h, "docPath"))
                            full.append("）\n")
                        case None => ()
                    }
                    n = n + 1
                }

                log(sessionId, turnId, "step/start", stepPayload(101, "artifact_save"))
                let saved = tools.saveArtifact("讲义-" + topic + ".md", full.toString())
                var artifactPath = ""
                match (saved.data) {
                    case s: JsonString => artifactPath = s.getValue()
                    case _ => ()
                }
                log(sessionId, turnId, "step/end", stepPayload(101, "artifact_save"))

                log(sessionId, turnId, "turn/end", endPayload(true, ""))
                out.put("ok", JsonBool(true))
                out.put("artifactPath", JsonString(artifactPath))
                out.put("sections", oarr)
                out.put("content", JsonString(full.toString()))
                out.put("citations", citationsFromHits(hits))
                out.put("citationReport", report)
                return out
        }
    }

    /** 主链路三：从知识库出分层练习，落成本地 Markdown。 */
    public func quiz(kbId: String, topic: String, count: Int64, sessionIdIn: String): JsonObject {
        var sessionId = sessionIdIn
        if (sessionId.size == 0) {
            sessionId = sessions.newId()
        }
        let turnId = sessions.newTurnId()
        log(sessionId, turnId, "turn/start", kindPayload("quiz"))
        let up = JsonObject()
        up.put("text", JsonString("生成练习：" + topic))
        log(sessionId, turnId, "user/message", up)

        let out = JsonObject()
        out.put("sessionId", JsonString(sessionId))

        match (chatClient()) {
            case None =>
                log(sessionId, turnId, "turn/end", endPayload(false, "没有可用的对话模型"))
                out.put("ok", JsonBool(false))
                out.put("message", JsonString("没有可用的对话模型，请先在设置里配置"))
                return out
            case Some(client) =>
                log(sessionId, turnId, "step/start", stepPayload(1, "retrieve"))
                let hits = retrieve(sessionId, turnId, kbId, topic, 10)
                log(sessionId, turnId, "step/end", stepPayload(1, "retrieve"))
                if (hits.size() == 0) {
                    log(sessionId, turnId, "turn/end", endPayload(false, "没有检索到资料"))
                    out.put("ok", JsonBool(false))
                    out.put("message", JsonString("知识库里没有检索到与该主题相关的内容"))
                    return out
                }
                let context = contextFromHits(hits)

                log(sessionId, turnId, "step/start", stepPayload(2, "quiz_create"))
                var text = ""
                try {
                    text = client.chat(
                        "你是教培测评设计者。只能依据给定资料出题，题目必须可溯源，每题后标注 [编号] 出处。输出 Markdown，包含题干、答案与解析三部分。",
                        "依据下面的资料，为《" + topic + "》出 " + count.toString() + " 道分层练习题。\n\n资料：\n" + context
                    )
                } catch (e: Exception) {
                    log(sessionId, turnId, "turn/end", endPayload(false, e.message))
                    out.put("ok", JsonBool(false))
                    out.put("message", JsonString("生成失败：" + e.message))
                    return out
                }
                log(sessionId, turnId, "step/end", stepPayload(2, "quiz_create"))

                log(sessionId, turnId, "step/start", stepPayload(3, "citation_check"))
                let draft = "# " + topic + " 练习\n\n" + text
                let report = citationReport(draft, hits.size())
                let vp = JsonObject()
                vp.put("report", report)
                vp.put("citations", citationsFromHits(hits))
                log(sessionId, turnId, "validation", vp)
                log(sessionId, turnId, "step/end", stepPayload(3, "citation_check"))

                let full = StringBuilder()
                full.append(draft)
                full.append("\n\n---\n\n## 资料来源\n\n")
                var n: Int64 = 0
                while (n < hits.size()) {
                    match (objOf(hits[n])) {
                        case Some(h) =>
                            full.append("- [")
                            full.append((n + 1).toString())
                            full.append("] 《")
                            full.append(strOf(h, "docTitle"))
                            full.append("》\n")
                        case None => ()
                    }
                    n = n + 1
                }

                log(sessionId, turnId, "step/start", stepPayload(4, "artifact_save"))
                let saved = tools.saveArtifact("练习-" + topic + ".md", full.toString())
                var artifactPath = ""
                match (saved.data) {
                    case s: JsonString => artifactPath = s.getValue()
                    case _ => ()
                }
                log(sessionId, turnId, "step/end", stepPayload(4, "artifact_save"))

                log(sessionId, turnId, "turn/end", endPayload(true, ""))
                out.put("ok", JsonBool(true))
                out.put("artifactPath", JsonString(artifactPath))
                out.put("content", JsonString(full.toString()))
                out.put("citations", citationsFromHits(hits))
                out.put("citationReport", report)
                return out
        }
    }
}

func kindPayload(kind: String): JsonObject {
    let o = JsonObject()
    o.put("kind", JsonString(kind))
    return o
}

func endPayload(ok: Bool, message: String): JsonObject {
    let o = JsonObject()
    o.put("ok", JsonBool(ok))
    if (message.size > 0) {
        o.put("message", JsonString(message))
    }
    return o
}

func callPayload(tool: String, query: String): JsonObject {
    let o = JsonObject()
    o.put("tool", JsonString(tool))
    o.put("query", JsonString(query))
    return o
}
