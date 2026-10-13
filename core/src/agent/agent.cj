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

public class Agent {
    public let store: Store
    public let sessions: SessionStore
    public let tools: ToolRegistry

    public init(store: Store) {
        this.store = store
        this.sessions = SessionStore(store.dataDir)
        this.tools = ToolRegistry(store)
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

    /** 主链路一：检索增强问答，回答带出处。 */
    public func ask(kbId: String, question: String, sessionIdIn: String): JsonObject {
        var sessionId = sessionIdIn
        if (sessionId.size == 0) {
            sessionId = sessions.newId()
        }
        let turnId = sessions.newTurnId()
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
                ()
                log(sessionId, turnId, "step/start", stepPayload(1, "retrieve"))
                let hits = retrieve(sessionId, turnId, kbId, question, 6)
                log(sessionId, turnId, "step/end", stepPayload(1, "retrieve"))

                log(sessionId, turnId, "step/start", stepPayload(2, "answer"))
                let system = "你是教培内容助手。只能依据给定资料回答，每个论断后用 [编号] 标注出处；资料中没有的内容要明确说明不知道，不要补充资料之外的信息。"
                let user = "资料：\n" + contextFromHits(hits) + "\n问题：" + question
                var reply = ""
                try {
                    reply = client.chat(system, user)
                } catch (e: Exception) {
                    log(sessionId, turnId, "turn/end", endPayload(false, e.message))
                    out.put("ok", JsonBool(false))
                    out.put("message", JsonString("生成失败：" + e.message))
                    return out
                }
                let ap = JsonObject()
                ap.put("text", JsonString(reply))
                log(sessionId, turnId, "assistant/message", ap)
                log(sessionId, turnId, "step/end", stepPayload(2, "answer"))

                let report = citationReport(reply, hits.size())
                let rp = JsonObject()
                rp.put("report", report)
                log(sessionId, turnId, "validation", rp)

                log(sessionId, turnId, "turn/end", endPayload(true, ""))
                out.put("ok", JsonBool(true))
                out.put("answer", JsonString(reply))
                out.put("citations", citationsFromHits(hits))
                out.put("citationReport", report)
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
                    body.append(text)
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
