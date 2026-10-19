package itn_desktop_core.resource

import std.collection.*
import std.random.*
import stdx.encoding.json.*
import itn_desktop_core.store.*
import itn_desktop_core.llm.*
import itn_desktop_core.tools.*
import itn_desktop_core.pi_provider.OpenAiChatProvider
import itn_desktop_core.pi.ChatProvider
import itn_desktop_core.pi.StepContext
import itn_desktop_core.pi.Message
import itn_desktop_core.pi.MsgRole
import itn_desktop_core.pi.EventStream
import itn_desktop_core.pi.PiEvent
import itn_desktop_core.pi.kindText
import itn_desktop_core.util.*

/*
 * 生成流程（把网页版 ResourceGenerationTeam + LearningContentService 的能力翻过来）。
 *
 * 一条链，四个类型共用：
 *   ① 检索证据（本机知识库，[n] 与出处一一对应）
 *   ② 出结构（JSON：讲义分章分节 / 实操步骤 / 知识点 / 幻灯片页）——不用自由文本
 *   ③ 按结构写（讲义逐节写并流式吐字；其余类型结构里已经带正文）
 *   ④ 质检 + 定向返修（≤2 轮；引用越界、缺斤短两、选项重复都会被指出来重做）
 *   ⑤ 渲染成 Markdown 产物 + 出处附录 + 引用自检
 *
 * 与网页版的差别（有意为之）：
 *   - 没有 MySQL / 没有多 Agent 编排器：证据只有本机知识库（外加调用方已经落进知识库的网页资料）；
 *   - 不追求"多角色辩论"这种流程复杂度，但**保留两个硬闸门**：结构化质检 + 引用越界必须返修；
 *   - 失败不硬造内容：讲义/演示稿宁可不产出，也不拿模板冒充；实操给"通用骨架"时必须明确标注。
 */

/** 一次生成请求。 */
public class ResourceRequest {
    /** lecture | practice | quiz | ppt */
    public var kind: String = "lecture"
    public var topic: String = ""
    public var kbId: String = ""
    /** concise | balanced | detailed */
    public var detail: String = "balanced"
    /** 题量 / 页数（0 = 用默认） */
    public var count: Int64 = 0
    /** 是否落成产物文件 */
    public var save: Bool = true
    /** 返修轮数上限 */
    public var maxRepair: Int64 = 2
    public var learningContext: String = ""
    public var revision: String = ""
    public var provider: ?ChatProvider = None
    public var sourceSnapshots: JsonArray = JsonArray()
    /** 当前会话绑定的思维导图目标；普通资源生成时为空。 */
    public var courseTarget: JsonObject = JsonObject()
    /** PPT 展示参数：audience/purpose/style/backgroundStyle/language/aspectRatio。 */
    public var presentation: JsonObject = JsonObject()
}

/** 一次生成的结果。 */
public class ResourceResult {
    public var ok: Bool = true
    public var kind: String = ""
    public var title: String = ""
    public var markdown: String = ""
    public var content: JsonValue = JsonNull()
    public var citations: JsonArray = JsonArray()
    public var quality: JsonObject = JsonObject()
    public var artifactName: String = ""
    public var artifactPath: String = ""
    public var format: String = ""
    public var previewPath: String = ""
    public var designPath: String = ""
    public var requestedSlides: Int64 = 0
    public var renderedSlides: Int64 = 0
    public var message: String = ""
    public var warnings: ArrayList<String> = ArrayList<String>()
    /** 结构化内容是不是"兜底骨架"（没有模型输出时） */
    public var fallback: Bool = false
}

public class ResourceProgress {
    public var steps: ArrayList<JsonObject> = ArrayList<JsonObject>()
}

func noopEvent(kind: String, payload: JsonObject): Unit {
}

/* ---------- 从模型输出里抠 JSON ---------- */

func stripFences(text: String): String {
    let sb = StringBuilder()
    for (line in text.split("\n")) {
        let t = trimStr(line)
        if (t.size >= 3 && t.toArray()[0] == 96 && t.toArray()[1] == 96 && t.toArray()[2] == 96) {
            continue
        }
        sb.append(line)
        sb.append("\n")
    }
    return sb.toString()
}

/** 从 start 处开始找配对的括号（跳过字符串里的括号与转义）。 */
func matchBracket(b: Array<UInt8>, start: Int64, open: UInt8, close: UInt8): Int64 {
    var depth: Int64 = 0
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
        } else if (c == 34) {
            inStr = true
        } else if (c == open) {
            depth = depth + 1
        } else if (c == close) {
            depth = depth - 1
            if (depth == 0) {
                return i
            }
        }
        i = i + 1
    }
    return -1
}

func jsonSlice(text: String, open: UInt8, close: UInt8): String {
    let b = text.toArray()
    var i = 0
    while (i < b.size) {
        if (b[i] == open) {
            let end = matchBracket(b, i, open, close)
            if (end > i) {
                return String.fromUtf8(b[i..(end + 1)])
            }
        }
        i = i + 1
    }
    return ""
}

public func jsonObjectFromModel(text: String): ?JsonObject {
    let raw = jsonSlice(stripFences(text), 123, 125)
    if (raw.size == 0) {
        return None
    }
    try {
        match (JsonValue.fromStr(raw)) {
            case o: JsonObject => return Some(o)
            case _ => return None
        }
    } catch (e: Exception) {
        return None
    }
}

public func jsonArrayFromModel(text: String): ?JsonArray {
    let raw = jsonSlice(stripFences(text), 91, 93)
    if (raw.size == 0) {
        return None
    }
    try {
        match (JsonValue.fromStr(raw)) {
            case a: JsonArray => return Some(a)
            case _ => return None
        }
    } catch (e: Exception) {
        return None
    }
}

/* ---------- 证据 ---------- */

func truthy(o: JsonObject, key: String): Bool {
    match (o.get(key)) {
        case Some(v) =>
            match (v) {
                case b: JsonBool => return b.getValue()
                case _ => return false
            }
        case None => return false
    }
}

/** 把命中的切片整理成证据上下文（带 [n] 编号，与出处列表一一对应）。 */
func evidenceContext(hits: JsonArray): String {
    if (hits.size() == 0) {
        return "（本机知识库里没有检索到直接相关的资料。只写通用框架，并且明确说明没有资料依据，不要编造具体事实。）"
    }
    return contextFromHits(hits)
}

/** 给"出结构"那一步的资料摘要：只要标题级信息，避免把整篇正文塞进规划提示词。 */
func evidenceDigest(hits: JsonArray): String {
    if (hits.size() == 0) {
        return "（没有检索到资料）"
    }
    let sb = StringBuilder()
    var i = 0
    while (i < hits.size() && i < 8) {
        match (objOf(hits[i])) {
            case Some(h) =>
                sb.append("- ")
                sb.append(strOf(h, "docTitle"))
                let hp = strOf(h, "headingPath")
                if (hp.size > 0) {
                    sb.append(" · ")
                    sb.append(hp)
                }
                sb.append("：")
                sb.append(byteSafePrefix(strOf(h, "text"), 120))
                sb.append("\n")
            case None => ()
        }
        i = i + 1
    }
    return sb.toString()
}

public func retrieveHits(store: Store, kbId: String, topic: String, topK: Int64, shouldAbort: () -> Bool): JsonArray {
    if (topic.size == 0) {
        return JsonArray()
    }
    let tools = ToolRegistry(store)
    tools.shouldAbort = shouldAbort
    let res = tools.kbSearch(kbId, topic, topK)
    if (!res.ok) {
        return JsonArray()
    }
    match (res.data) {
        case a: JsonArray => return a
        case _ => return JsonArray()
    }
}

/* ---------- 提示词 ---------- */

const WRITER_SYSTEM = "你是教培内容作者。只能依据给定资料写作，每个论断后用 [编号] 标注出处，不要编造资料之外的内容。输出 Markdown 正文，不要重复小节标题。"
const STRUCTURED_SYSTEM = "你是严谨的学习内容作者。严格按用户给出的结构输出一个合法 JSON 对象，不输出解释或 Markdown 围栏。文字字段可含 Markdown，换行必须转义。依据给定资料，用 [编号] 标注真实来源，不编造编号。"

func lecturePlanPrompt(topic: String, detail: String, digest: String): String {
    let minCh = detailMinChapters(detail)
    let minSec = detailMinSections(detail)
    return "你是课程设计者。只输出一个 JSON 对象（不要解释、不要 Markdown 围栏），结构：\n" +
        "{\"title\":\"\",\"objective\":\"\",\"objectives\":[\"\",\"\"],\"chapters\":[{\"title\":\"\",\"introduction\":\"\",\"sections\":[{\"title\":\"\"}]}]}\n" +
        (if (detail == "concise") { "要求：正好2章，每章2节，全篇4节；" } else { "要求：" + minCh.toString() + "~4 章，每章 2~3 节，全篇至少 " + minSec.toString() + " 节；" }) +
        "章节标题要具体（写清对象与范围），不要出现「第一章 概述」这类空标题；objectives 写 3 条可检验的学习目标。\n" +
        "主题：" + topic + "\n已有资料线索：\n" + digest
}

func lectureSectionPrompt(topic: String, chapter: String, index: Int64, title: String, context: String): String {
    return "依据下面的资料，撰写《" + topic + "》讲义的第 " + index.toString() + " 节：「" + title + "」（属于《" + chapter + "》这一章）。" +
        "写 300 字以上，要有具体示例或可操作的说明；每个论断后用 [编号] 标注出处。\n\n资料：\n" + context
}

func practicePrompt(topic: String, detail: String, digest: String, context: String): String {
    return "你是实训导师。只输出一个 JSON 对象（不要解释、不要 Markdown 围栏），结构：\n" +
        "{\"title\":\"\",\"objective\":\"\",\"estimatedMinutes\":60,\"prerequisites\":[\"\"],\"environment\":[\"\"]," +
        "\"steps\":[{\"title\":\"\",\"instruction\":\"\",\"code\":\"\",\"expectedOutput\":\"\",\"safety\":\"safe\",\"warning\":\"\"}]," +
        "\"safetyChecklist\":[\"\"],\"safetyNotice\":\"\",\"acceptanceCriteria\":[\"\"],\"troubleshooting\":[{\"problem\":\"\",\"solution\":\"\"}],\"challenge\":\"\"}\n" +
        "要求：至少 4 个步骤，每步 instruction 写清「怎么做」（90 字以上，含明确动作词），expectedOutput 写清「看到什么算成功」；" +
        "safety 只能是 safe/caution/danger；acceptanceCriteria 至少 3 条可客观判定；troubleshooting 至少 2 条。" +
        "主题：" + topic + "\n已有资料线索：\n" + digest + "\n\n资料原文：\n" + context
}

func quizKnowledgePrompt(topic: String, digest: String): String {
    return "你是测评设计者。只输出一个 JSON 对象：{\"knowledgePoints\":[{\"id\":\"kp-1\",\"name\":\"\",\"description\":\"\"}]}，" +
        "3~5 个知识点，id 用 kp-1 / kp-2 这样；description 说清「这个概念用来判断什么」。\n主题：" + topic + "\n已有资料线索：\n" + digest
}

func quizQuestionsPrompt(topic: String, count: Int64, kps: String, context: String): String {
    return "你是测评设计者。只输出一个 JSON 对象：{\"title\":\"\",\"questions\":[{\"id\":\"q-1\",\"knowledgePointId\":\"kp-1\"," +
        "\"difficulty\":\"easy\",\"stem\":\"\",\"options\":[\"\",\"\",\"\",\"\"],\"correctIndex\":0,\"explanation\":\"\"}]}。\n" +
        "要求：正好 " + count.toString() + " 题；difficulty 用 easy/medium/hard，3 题以上覆盖三档，少于 3 题无需三档齐全；每题 4 个互不相同的选项；" +
        "stem 要给出具体情境（不要直接问定义）；explanation 至少 40 字，说明为什么对、其余错在哪；正确答案的位置要分散。\n" +
        "知识点（只能用这些 id）：\n" + kps + "\n主题：" + topic + "\n资料原文：\n" + context
}

func pptPrompt(topic: String, count: Int64, digest: String, context: String): String {
    return "你是演示稿设计者，同时负责设计课堂中的即时检查点。只输出一个 JSON 对象：" +
        "{\"title\":\"\",\"subtitle\":\"\",\"slides\":[{\"title\":\"\",\"eyebrow\":\"\",\"kind\":\"concept|process|summary\"," +
        "\"bullets\":[\"\",\"\"],\"speakerNote\":\"\",\"teachingMoments\":[" +
        "{\"momentId\":\"s3-quiz-1\",\"type\":\"quiz\",\"title\":\"检查理解\",\"prompt\":\"\",\"options\":[\"\",\"\",\"\",\"\"]," +
        "\"answerIndex\":0,\"explanation\":\"\",\"anchorText\":\"\"}," +
        "{\"momentId\":\"s8-summary-1\",\"type\":\"summary\",\"title\":\"本页小结\",\"points\":[\"\",\"\"]," +
        "\"notePrompt\":\"\",\"anchorText\":\"\"}]}]}。\n" +
        "要求：正好 " + count.toString() + " 页；每页 2~5 条要点，每条一行、不超过 40 字；标题不重复；speakerNote 写这一页怎么讲（30 字以上）。\n" +
        "teachingMoments 可以为空数组；从第 3 页起，任意连续 3 页内至少有一道 quiz。最后一页必须至少有一个 summary。" +
        "quiz 必须能仅凭当前页内容作答，prompt 是具体情境题，options 恰好 4 个且互不重复，answerIndex 为 0~3 的整数，" +
        "explanation 至少 30 字并说明正确项与错误项；summary 的 points 为 2~4 条可复述要点，notePrompt 引导用户用自己的话写笔记。" +
        "momentId 全篇唯一；anchorText 必须逐字来自本页某条 bullets。不要在其他字段里泄露 answerIndex 或 explanation。\n" +
        "主题：" + topic + "\n已有资料线索：\n" + digest + "\n\n资料原文：\n" + context
}

func repairPrompt(kind: String, issues: ArrayList<String>, bad: String): String {
    let sb = StringBuilder()
    sb.append("你是内容质检员。下面这份 ")
    sb.append(kind)
    sb.append(" 的 JSON 有问题，请只输出修正后的 JSON（同样的结构，不要解释、不要围栏）。\nresourceType: ")
    sb.append(kind)
    sb.append("\n问题清单：\n")
    for (x in issues) {
        sb.append("- ")
        sb.append(x)
        sb.append("\n")
    }
    sb.append("\n原内容：\n")
    sb.append(byteSafePrefix(bad, 12000))
    return sb.toString()
}

/* ---------- 生成时的运行状态 ---------- */

class Run {
    var client: ChatProvider
    var shouldAbort: () -> Bool = { => false }
    var context: String = ""
    var store: Store
    var emit: (String, JsonObject) -> Unit
    var cancelKey: String = ""
    var warnings: ArrayList<String> = ArrayList<String>()
    var deltas: Int64 = 0
    var repairRounds: Int64 = 0

    init(client: ChatProvider, store: Store, emit: (String, JsonObject) -> Unit) {
        this.client = client
        this.store = store
        this.emit = emit
    }
}

func stepEvent(index: Int64, name: String): JsonObject {
    let o = JsonObject()
    o.put("index", JsonInt(index))
    o.put("name", JsonString(name))
    return o
}

func endEvent(ok: Bool, message: String): JsonObject {
    let o = JsonObject()
    o.put("ok", JsonBool(ok))
    o.put("message", JsonString(message))
    return o
}

func stepStart(run: Run, index: Int64, name: String): Unit {
    run.emit("step/start", stepEvent(index, name))
}

func stepEnd(run: Run, index: Int64, name: String): Unit {
    run.emit("step/end", stepEvent(index, name))
}

func emitDelta(run: Run, text: String, label: String): Unit {
    run.deltas = run.deltas + 1
    let o = JsonObject()
    o.put("text", JsonString(text))
    o.put("stage", JsonString("write"))
    o.put("label", JsonString(label))
    run.emit("assistant/delta", o)
}

func emitValidation(run: Run, kind: String, report: JsonObject, citations: JsonArray): Unit {
    let o = JsonObject()
    o.put("kind", JsonString(kind))
    o.put("report", report)
    o.put("citations", citations)
    run.emit("validation", o)
}

class CancelException <: Exception { public init() { super("已取消") } }

func resourceModel(run: Run, system: String, user: String, delta: (String) -> Unit): String {
    if (run.shouldAbort()) { throw CancelException() }
    let ctx = StepContext()
    ctx.system = system + "\n个人学习上下文（只用于解释深度与偏好，不作为资料事实）：\n" + run.context
    let m = Message(UserMsg)
    m.text = user
    ctx.messages.add(m)
    let stream = EventStream()
    stream.on({ e: PiEvent =>
        if (kindText(e.kind) == "message_update") {
            match (e.payload.get("assistantEvent")) {
                case Some(v) => match (objOf(v)) {
                    case Some(o) => if (strOf(o, "type") == "text_delta") { delta(strOf(o, "delta")) }
                    case None => ()
                }
                case None => ()
            }
        }
    })
    let reply = match (run.client) {
        case p: OpenAiChatProvider => p.respondForWriting(ctx, stream)
        case _ => run.client.respond(ctx, stream)
    }
    if (run.shouldAbort() || reply.stopReason == "aborted") { throw CancelException() }
    if (reply.stopReason == "length") { throw Exception("输出被截断：已按更大上限重发过一次仍不完整，请重试或缩小篇幅") }
    if (reply.stopReason == "error" || reply.text.size == 0) { throw Exception("资源模型调用失败：" + reply.errorMessage) }
    return reply.text
}

/** 一次"要 JSON"的模型调用：流式吐字（界面能看到在写），最后抠出 JSON。 */
func askJson(run: Run, system: String, user: String, label: String): ?JsonObject {
    if (run.shouldAbort()) {
        throw CancelException()
    }
    let stream: (String) -> Unit = { piece: String =>
        if (run.shouldAbort()) {
            throw CancelException()
        }
        emitDelta(run, piece, label)
    }
    var text = ""
    try {
        text = resourceModel(run, STRUCTURED_SYSTEM, user, stream)
    } catch (e: CancelException) {
        throw e
    } catch (e: Exception) {
        run.warnings.add(label + " 调用失败：" + e.message)
        return None
    }
    var obj = jsonObjectFromModel(text)
    if (obj.isNone() && !run.shouldAbort()) {
        // 长 JSON 会偶发"字符串没转义 / 某一次被截断"这类坏样本。一次失败不等于这一轮没救：
        // 同一份任务再要一遍，并把"只输出完整 JSON"说死；仍失败才把原因记进警告。
        run.warnings.add(label + " 第一遍不是可解析的 JSON，已自动重试一遍")
        try {
            text = resourceModel(run, STRUCTURED_SYSTEM,
                user + "\n\n注意：上一次输出不是合法 JSON（可能被截断，或字符串里有未转义的引号/换行）。请完整重发上面这个 JSON 对象，只输出 JSON，不要任何解释。",
                stream)
        } catch (e: CancelException) {
            throw e
        } catch (e: Exception) {
            run.warnings.add(label + " 重试调用失败：" + e.message)
            return None
        }
        obj = jsonObjectFromModel(text)
    }
    match (obj) {
        case None => run.warnings.add(label + " 没有返回可解析的 JSON（" + byteSafePrefix(trimStr(text), 120) + "）")
        case Some(_) => ()
    }
    return obj
}

/** 一次纯文本的模型调用（讲义逐节写作走这条）。 */
func askText(run: Run, system: String, user: String, label: String): String {
    if (run.shouldAbort()) {
        throw CancelException()
    }
    try {
        return resourceModel(run, system, user, { piece: String =>
            if (run.shouldAbort()) {
                throw CancelException()
            }
            emitDelta(run, piece, label)
        })
    } catch (e: CancelException) {
        throw e
    } catch (e: Exception) {
        run.warnings.add(label + " 调用失败：" + e.message)
        return ""
    }
}

/* ---------- 结构化内容的"可用性"与正文抽取 ---------- */

func nonEmptySections(content: JsonObject): Int64 {
    var n: Int64 = 0
    for (c in objsOf(content, "chapters")) {
        for (s in objsOf(c, "sections")) {
            if (txt(s, "content").size > 0) {
                n = n + 1
            }
        }
    }
    return n
}

func bodyTextOf(kind: String, content: JsonObject): String {
    let sb = StringBuilder()
    if (kind == "lecture") {
        for (c in objsOf(content, "chapters")) {
            sb.append(txt(c, "introduction"))
            sb.append("\n\n")
            for (s in objsOf(c, "sections")) {
                sb.append(txt(s, "content"))
                sb.append("\n\n")
            }
        }
        return sb.toString()
    }
    if (kind == "practice") {
        for (s in objsOf(content, "steps")) {
            sb.append(txt(s, "instruction"))
            sb.append("\n\n")
            sb.append(txt(s, "expectedOutput"))
            sb.append("\n\n")
        }
        for (x in listOf(content, "acceptanceCriteria")) {
            sb.append(x)
            sb.append("\n")
        }
        return sb.toString()
    }
    if (kind == "quiz") {
        for (q in objsOf(content, "questions")) {
            sb.append(txt(q, "stem"))
            sb.append("\n\n")
            sb.append(txt(q, "explanation"))
            sb.append("\n\n")
        }
        return sb.toString()
    }
    for (s in objsOf(content, "slides")) {
        sb.append(txt(s, "title"))
        sb.append("\n")
        for (b in listOf(s, "bullets")) {
            sb.append(b)
            sb.append("\n")
        }
        sb.append(txt(s, "speakerNote"))
        sb.append("\n\n")
    }
    return sb.toString()
}

/** 结构上还能不能交付：有一点点内容就算可用（质量分另有 warnings 说清楚）。 */
func usable(kind: String, content: JsonObject): Bool {
    if (kind == "lecture") {
        return nonEmptySections(content) > 0
    }
    if (kind == "practice") {
        return objsOf(content, "steps").size > 0
    }
    if (kind == "quiz") {
        return objsOf(content, "questions").size > 0
    }
    return objsOf(content, "slides").size > 0
}

/** 硬伤：编造出处。这一条不允许"带着问题交付"。 */
func hasFabricatedCitations(issues: ArrayList<String>): Bool {
    for (x in issues) {
        if (x.contains("引用了不存在")) {
            return true
        }
    }
    return false
}

/* ---------- 四种类型的生成 ---------- */

/** 讲义：先出章节结构，再逐节写正文。 */
func generateLecture(run: Run, req: ResourceRequest, hits: JsonArray): ?JsonObject {
    let context = evidenceContext(hits)
    let digest = evidenceDigest(hits)
    stepStart(run, 2, "plan")
    let plan = askJson(run, WRITER_SYSTEM, lecturePlanPrompt(req.topic, req.detail, digest), "大纲")
    stepEnd(run, 2, "plan")
    var content = JsonObject()
    match (plan) {
        case Some(o) => content = o
        case None => return None
    }
    // 逐节写：一节一算，界面能看到字一个个出来
    var idx: Int64 = 0
    var written: Int64 = 0
    for (c in objsOf(content, "chapters")) {
        let chapterTitle = txt(c, "title")
        for (s in objsOf(c, "sections")) {
            idx = idx + 1
            let secTitle = txt(s, "title")
            stepStart(run, 3 + idx, "write_section")
            let text = askText(run, WRITER_SYSTEM,
                lectureSectionPrompt(req.topic, chapterTitle, idx, secTitle, context), secTitle)
            if (text.size > 0) {
                s.put("content", JsonString(stripLeadingHeadings(text, secTitle)))
                written = written + 1
            }
            stepEnd(run, 3 + idx, "write_section")
        }
    }
    if (written == 0) {
        run.warnings.add("逐节写作没有拿到任何正文")
    }
    return Some(content)
}

/** 去掉模型爱重复的那行小节标题。 */
func stripLeadingHeadings(text: String, secTitle: String): String {
    let sb = StringBuilder()
    var skipped = 0
    for (line in text.split("\n")) {
        let t = trimStr(line)
        if (skipped < 2 && t.size > 0) {
            let isHeading = (t.size >= 2 && t.toArray()[0] == 35) ||
                (secTitle.size > 0 && t == secTitle)
            if (isHeading) {
                skipped = skipped + 1
                continue
            }
        }
        sb.append(line)
        sb.append("\n")
    }
    return trimStr(sb.toString())
}

/** 实操 / 演示：一次出结构。 */
func generateStructured(run: Run, req: ResourceRequest, hits: JsonArray): ?JsonObject {
    let context = evidenceContext(hits)
    let digest = evidenceDigest(hits)
    stepStart(run, 2, "structure")
    var prompt = ""
    var label = ""
    if (req.kind == "practice") {
        prompt = practicePrompt(req.topic, req.detail, digest, context)
        label = "实操结构"
    } else {
        prompt = pptPrompt(req.topic, req.count, digest, context)
        label = "幻灯片结构"
    }
    let out = askJson(run, WRITER_SYSTEM, prompt, label)
    stepEnd(run, 2, "structure")
    return out
}

/* ---------- 演示稿教学检查点：服务端规范化 ---------- */

func jsonObjectValue(v: JsonValue): JsonObject {
    match (objOf(v)) {
        case Some(o) => return o
        case None => return JsonObject()
    }
}

func jsonArrayField(o: JsonObject, key: String): JsonArray {
    match (o.get(key)) {
        case Some(v) => match (arrOf(v)) {
            case Some(a) => return a
            case None => return JsonArray()
        }
        case None => return JsonArray()
    }
}

func momentAnswerIndex(m: JsonObject): Int64 {
    match (m.get("answerIndex")) {
        case Some(v) => match (v) {
            case j: JsonInt => return j.getValue()
            case _ => return -1
        }
        case None => return -1
    }
}

func uniqueMomentId(baseIn: String, used: HashSet<String>): String {
    var base = trimStr(baseIn)
    if (base.size == 0) {
        base = "moment"
    }
    var id = base
    var n: Int64 = 1
    while (used.contains(id)) {
        n = n + 1
        id = base + "-" + n.toString()
    }
    used.add(id)
    return id
}

func momentOptions(values: ArrayList<String>): JsonArray {
    let out = JsonArray()
    for (x in values) {
        out.add(JsonString(x))
    }
    return out
}

func fallbackQuiz(allSlides: ArrayList<JsonObject>, slide: JsonObject, slideNo: Int64,
    used: HashSet<String>): JsonObject {
    let title = strOf(slide, "title")
    let bullets = strListIn(slide, "bullets")
    var correct = if (bullets.size > 0) { bullets[0] } else { "本页的标题与讲解要点" }
    if (trimStr(correct).size == 0) {
        correct = "本页的标题与讲解要点"
    }
    let options = JsonArray()
    let seen = HashSet<String>()
    options.add(JsonString(correct))
    seen.add(correct)
    var i = 0
    while (i < bullets.size && options.size() < 4) {
        let x = bullets[i]
        if (!seen.contains(x)) {
            seen.add(x)
            options.add(JsonString(x))
        }
        i = i + 1
    }
    i = 0
    while (i < allSlides.size && options.size() < 4) {
        if (i != slideNo - 1) {
            for (x in strListIn(allSlides[i], "bullets")) {
                if (options.size() >= 4) { break }
                if (!seen.contains(x)) {
                    seen.add(x)
                    options.add(JsonString(x))
                }
            }
        }
        i = i + 1
    }
    let distractors = ["只需记住结论，不必说明依据", "跳过示例，直接记下答案", "所有情况都使用同一种做法"]
    for (x in distractors) {
        if (options.size() >= 4) { break }
        if (!seen.contains(x)) {
            seen.add(x)
            options.add(JsonString(x))
        }
    }
    let m = JsonObject()
    m.put("momentId", JsonString(uniqueMomentId("s" + slideNo.toString() + "-quiz-fallback", used)))
    m.put("type", JsonString("quiz"))
    m.put("title", JsonString("检查理解"))
    m.put("prompt", JsonString("关于「" + (if (title.size > 0) { title } else { "本页内容" }) + "」，以下哪一项是本页明确列出的要点？"))
    m.put("options", options)
    m.put("answerIndex", JsonInt(0))
    m.put("explanation", JsonString("本页把「" + correct + "」列为明确要点；其余选项并非这一页的内容。判断时应回到本页要点，而不是凭印象选择。"))
    m.put("anchorText", JsonString(correct))
    return m
}

func fallbackSummary(slide: JsonObject, slideNo: Int64, used: HashSet<String>): JsonObject {
    let title = strOf(slide, "title")
    let points = JsonArray()
    let bullets = strListIn(slide, "bullets")
    var i = 0
    while (i < bullets.size && points.size() < 4) {
        points.add(JsonString(bullets[i]))
        i = i + 1
    }
    if (points.size() < 2) {
        points.add(JsonString("本页主题：" + (if (title.size > 0) { title } else { "第 " + slideNo.toString() + " 页" })))
    }
    if (points.size() < 2) {
        points.add(JsonString("能用自己的话复述本页的核心判断"))
    }
    let m = JsonObject()
    m.put("momentId", JsonString(uniqueMomentId("s" + slideNo.toString() + "-summary-fallback", used)))
    m.put("type", JsonString("summary"))
    m.put("title", JsonString("本页小结"))
    m.put("points", points)
    m.put("notePrompt", JsonString("用一句话写下你对「" + (if (title.size > 0) { title } else { "本页内容" }) + "」的理解。"))
    m.put("anchorText", JsonString(if (bullets.size > 0) { bullets[0] } else { title }))
    return m
}

/**
 * 模型输出是草稿，结构化导学元数据必须过一遍服务端规范化：
 * - 去掉缺题干、选项重复、答案越界的 quiz；
 * - 统一 2~4 条 summary 要点与笔记提示；
 * - 全篇 momentId 去重；
 * - 模型漏检查点时，按本页原文补一个最小可用检查点，并在质量警告里如实说明。
 */
public func normalizePptTeachingMoments(content: JsonObject, warnings: ArrayList<String>): Unit {
    let slides = objsIn(content, "slides")
    if (slides.size == 0) {
        return
    }
    let usedIds = HashSet<String>()
    let cleaned = ArrayList<JsonArray>()
    let quizCounts = ArrayList<Int64>()
    var si = 0
    while (si < slides.size) {
        let slide = slides[si]
        let source = jsonArrayField(slide, "teachingMoments")
        let kept = JsonArray()
        let defaultAnchor = if (strListIn(slide, "bullets").size > 0) { strListIn(slide, "bullets")[0] } else { strOf(slide, "title") }
        var quizzes: Int64 = 0
        var mi = 0
        while (mi < source.size()) {
            let m = jsonObjectValue(source[mi])
            let typ = strOf(m, "type")
            if (typ == "quiz") {
                let options = strListIn(m, "options")
                let uniq = HashSet<String>()
                for (x in options) { uniq.add(x) }
                let answer = momentAnswerIndex(m)
                let prompt = trimStr(strOf(m, "prompt"))
                if (options.size == 4 && uniq.size == 4 && answer >= 0 && answer <= 3 && prompt.size > 0) {
                    let title = trimStr(strOf(m, "title"))
                    let explanation = trimStr(strOf(m, "explanation"))
                    let anchor = trimStr(strOf(m, "anchorText"))
                    m.put("momentId", JsonString(uniqueMomentId(strOf(m, "momentId"), usedIds)))
                    m.put("title", JsonString(if (title.size > 0) { title } else { "检查理解" }))
                    m.put("options", momentOptions(options))
                    m.put("answerIndex", JsonInt(answer))
                    m.put("explanation", JsonString(if (explanation.size >= 10) { explanation } else {
                        "正确选项与本页要点一致；其余选项不是这一页的讲解内容。判断时应回到本页原文。"
                    }))
                    m.put("anchorText", JsonString(if (anchor.size > 0) { anchor } else { defaultAnchor }))
                    kept.add(m)
                    quizzes = quizzes + 1
                }
            } else if (typ == "summary") {
                let rawPoints = strListIn(m, "points")
                if (rawPoints.size > 0) {
                    let points = JsonArray()
                    var pi = 0
                    while (pi < rawPoints.size && points.size() < 4) {
                        points.add(JsonString(rawPoints[pi]))
                        pi = pi + 1
                    }
                    if (points.size() < 2) {
                        points.add(JsonString("能用自己的话复述本页的核心判断"))
                    }
                    let title = trimStr(strOf(m, "title"))
                    let notePrompt = trimStr(strOf(m, "notePrompt"))
                    let anchor = trimStr(strOf(m, "anchorText"))
                    m.put("momentId", JsonString(uniqueMomentId(strOf(m, "momentId"), usedIds)))
                    m.put("title", JsonString(if (title.size > 0) { title } else { "本页小结" }))
                    m.put("points", points)
                    m.put("notePrompt", JsonString(if (notePrompt.size > 0) { notePrompt } else {
                        "用一句话写下你对本页内容的理解。"
                    }))
                    m.put("anchorText", JsonString(if (anchor.size > 0) { anchor } else { defaultAnchor }))
                    kept.add(m)
                }
            }
            mi = mi + 1
        }
        cleaned.add(kept)
        quizCounts.add(quizzes)
        si = si + 1
    }

    var injectedQuiz: Int64 = 0
    var lastQuizSlide: Int64 = 0
    si = 0
    while (si < slides.size) {
        let slideNo = si + 1
        if (quizCounts[si] > 0) {
            lastQuizSlide = slideNo
        } else {
            let overdue = (lastQuizSlide == 0 && slideNo >= 3) || (lastQuizSlide > 0 && slideNo - lastQuizSlide >= 3)
            if (overdue) {
                cleaned[si].add(fallbackQuiz(slides, slides[si], slideNo, usedIds))
                lastQuizSlide = slideNo
                injectedQuiz = injectedQuiz + 1
            }
        }
        si = si + 1
    }
    if (lastQuizSlide == 0 && slides.size > 0) {
        let last = slides.size - 1
        cleaned[last].add(fallbackQuiz(slides, slides[last], slides.size, usedIds))
        injectedQuiz = injectedQuiz + 1
    }

    let lastIndex = slides.size - 1
    var hasLastSummary = false
    var li = 0
    while (li < cleaned[lastIndex].size()) {
        if (strOf(jsonObjectValue(cleaned[lastIndex][li]), "type") == "summary") {
            hasLastSummary = true
            break
        }
        li = li + 1
    }
    var injectedSummary: Int64 = 0
    if (!hasLastSummary) {
        cleaned[lastIndex].add(fallbackSummary(slides[lastIndex], slides.size, usedIds))
        injectedSummary = 1
    }

    si = 0
    while (si < slides.size) {
        slides[si].put("teachingMoments", cleaned[si])
        si = si + 1
    }
    if (injectedQuiz > 0 || injectedSummary > 0) {
        warnings.add("为保证交互导学可用，服务端按本页要点补充了 " + injectedQuiz.toString() + " 道检查题、" +
            injectedSummary.toString() + " 个总结检查点")
    }
}

/** 分阶测试：先定知识点，再按三档难度分批出题。 */
func generateQuiz(run: Run, req: ResourceRequest, hits: JsonArray): ?JsonObject {
    stepStart(run, 2, "questions")
    let prompt = "只输出一个 JSON 对象，完整结构：" +
        "{\"title\":\"\",\"knowledgePoints\":[{\"id\":\"kp-1\",\"name\":\"\",\"description\":\"\"}]," +
        "\"questions\":[{\"id\":\"q-1\",\"knowledgePointId\":\"kp-1\",\"difficulty\":\"easy\",\"stem\":\"\"," +
        "\"options\":[\"\",\"\",\"\",\"\"],\"correctIndex\":0,\"explanation\":\"\"}]}。\n" +
        "正好 " + req.count.toString() + " 题；3~5 个知识点；每题 id 唯一并关联有效知识点；" +
        "difficulty 用 easy/medium/hard，至少覆盖三档；题干给出不同的具体场景；4 个互不重复的选项；" +
        "correctIndex 必须是 0~3 的整数且答案位置分散；解析说明正确与错误选项的原因，至少40字，依据资料标注引用。\n" +
        "主题：" + req.topic + "\n资料原文：\n" + evidenceContext(hits)
    let result = askJson(run, STRUCTURED_SYSTEM, prompt, "分阶测试")
    stepEnd(run, 2, "questions")
    return result
}

/* ---------- 质检 + 定向返修 ---------- */

func checkContent(kind: String, content: JsonObject, detail: String, count: Int64, sources: JsonArray): ArrayList<String> {
    let issues = qualityIssues(kind, content, detail, count)
    let body = bodyTextOf(kind, content)
    for (x in citationIssues(body, sources.size())) {
        if (x.contains("引用了不存在")) { issues.add(x) }
    }
    return issues
}

/**
 * 返修：把问题清单甩回模型，让它只改有问题的地方。
 *
 * 讲义特殊一点：返修回来的是"结构 + 正文"，如果模型把正文弄丢了（只回了骨架），
 * 就保留上一版正文——不能让一次返修把已经写好的内容弄没。
 */
func repairContent(run: Run, kind: String, content: JsonObject, detail: String, count: Int64,
    sources: JsonArray, maxRepair: Int64): JsonObject {
    var cur = content
    var round: Int64 = 0
    while (round < maxRepair) {
        let issues = checkContent(kind, cur, detail, count, sources)
        if (issues.size == 0) {
            return cur
        }
        round = round + 1
        run.repairRounds = round
        stepStart(run, 90 + round, "repair")
        let fixed = askJson(run, WRITER_SYSTEM, repairPrompt(kind, issues, cur.toString()), "返修第 " + round.toString() + " 轮")
        stepEnd(run, 90 + round, "repair")
        match (fixed) {
            case Some(o) =>
                if (kind == "lecture" && nonEmptySections(o) == 0 && nonEmptySections(cur) > 0) {
                    run.warnings.add("返修返回的讲义没有正文，保留上一版正文（只采纳结构）")
                    return cur
                }
                cur = o
            case None => return cur
        }
    }
    return cur
}

/** 实操的通用骨架：模型完全不给东西时，给一套能照着做的流程，但**必须标明没有资料依据**。 */
public func practiceFallback(topic: String): JsonObject {
    let o = JsonObject()
    o.put("title", JsonString(topic + "·实操骨架"))
    o.put("objective", JsonString("通过一套可复现的流程走完「" + topic + "」：准备输入 → 执行 → 记录结果 → 验收复盘。"))
    o.put("estimatedMinutes", JsonInt(60))
    let pre = JsonArray()
    pre.add(JsonString("能创建和编辑文本文件"))
    pre.add(JsonString("读过这一章的讲义，或了解基本术语"))
    o.put("prerequisites", pre)
    let env = JsonArray()
    env.add(JsonString("任意可编辑 Markdown 的本地环境"))
    o.put("environment", env)
    let steps = JsonArray()
    let s1 = JsonObject()
    s1.put("title", JsonString("准备输入与标准"))
    s1.put("instruction", JsonString("新建一个以「" + topic + "」命名的练习目录，在 README.md 里写下这次任务的输入、处理步骤、预期输出和验收标准，并把原始输入文件复制一份留底。"))
    s1.put("code", JsonString(""))
    s1.put("expectedOutput", JsonString("README.md 里能看清输入是什么、做到什么算完成，且原始输入有备份。"))
    s1.put("safety", JsonString("caution"))
    s1.put("warning", JsonString("先确认输入里不含敏感信息，并保留原始副本。"))
    steps.add(s1)
    let s2 = JsonObject()
    s2.put("title", JsonString("按最小样例执行一遍"))
    s2.put("instruction", JsonString("用最小的一个样例执行一次完整流程，把每一步的输入、关键中间状态、输出和耗时记录到 result.md；失败时保留完整错误信息并按发生位置定位原因。"))
    s2.put("code", JsonString(""))
    s2.put("expectedOutput", JsonString("result.md 里有一组从输入到输出的完整记录，且能重复执行得到同样结果。"))
    s2.put("safety", JsonString("safe"))
    s2.put("warning", JsonString(""))
    steps.add(s2)
    let s3 = JsonObject()
    s3.put("title", JsonString("换成边界样例再执行"))
    s3.put("instruction", JsonString("把样例换成边界情况（最小、最大、异常输入各一个）再执行一遍，记录每一步输出与最终结果，并说明哪一步开始与预期不一致。"))
    s3.put("code", JsonString(""))
    s3.put("expectedOutput", JsonString("result.md 里至少两组完整记录，能区分正常路径与边界路径。"))
    s3.put("safety", JsonString("safe"))
    s3.put("warning", JsonString(""))
    steps.add(s3)
    let s4 = JsonObject()
    s4.put("title", JsonString("验收与复盘"))
    s4.put("instruction", JsonString("依据 README.md 里的标准逐条检查，对不满足的写清证据和修复动作；再补一段复盘：适用条件、一个已知限制、一个常见错误及改进方向。"))
    s4.put("code", JsonString(""))
    s4.put("expectedOutput", JsonString("每条验收标准都有结论和证据，复盘里有明确的限制与改进方向。"))
    s4.put("safety", JsonString("safe"))
    s4.put("warning", JsonString(""))
    steps.add(s4)
    o.put("steps", steps)
    let crit = JsonArray()
    crit.add(JsonString("输入、过程和输出记录完整，别人照着能复现"))
    crit.add(JsonString("最小样例与边界样例都有明确结果和判断依据"))
    crit.add(JsonString("至少记录一个限制、一个错误及对应修复动作"))
    o.put("acceptanceCriteria", crit)
    let checklist = JsonArray()
    checklist.add(JsonString("已备份原始输入与当前成果"))
    checklist.add(JsonString("已确认输入中不含不应使用的敏感信息"))
    o.put("safetyChecklist", checklist)
    o.put("safetyNotice", JsonString("改动文件前先留副本；涉及真实账号或生产数据时，先在测试环境验证。"))
    let trouble = JsonArray()
    let t1 = JsonObject()
    t1.put("problem", JsonString("执行结果与预期不一致"))
    t1.put("solution", JsonString("从输入字段、参数、关键中间状态到输出逐项比对，用最小样例定位第一处偏差。"))
    trouble.add(t1)
    let t2 = JsonObject()
    t2.put("problem", JsonString("别人无法按文档复现"))
    t2.put("solution", JsonString("补齐环境版本、文件位置与完整命令，并在空目录里重新走一遍。"))
    trouble.add(t2)
    o.put("troubleshooting", trouble)
    o.put("challenge", JsonString("换一个与现有样例不同的异常输入，先预测结果再执行验证，并说明流程需要怎样调整。"))
    return o
}

func qualityJson(kind: String, content: JsonObject, issues: ArrayList<String>, rounds: Int64, sources: Int64,
    fallback: Bool): JsonObject {
    let o = JsonObject()
    o.put("kind", JsonString(kind))
    let issuesArr = JsonArray()
    for (x in issues) {
        issuesArr.add(JsonString(x))
    }
    o.put("issues", issuesArr)
    o.put("repairRounds", JsonInt(rounds))
    o.put("sources", JsonInt(sources))
    o.put("fallback", JsonBool(fallback))
    o.put("bodyChars", JsonInt(bodyTextOf(kind, content).size))
    return o
}

/* ---------- 对外入口 ---------- */

func pickModel(s: Settings): ?ModelConfig {
    if (s.chatModelId.size > 0) {
        match (s.findModel(s.chatModelId)) {
            case Some(cfg) => return Some(cfg)
            case None => ()
        }
    }
    if (s.models.size > 0) {
        return Some(s.models[0])
    }
    return None
}

/** 不带事件回调（脚本/自测用）。 */
public func generateResource(store: Store, req: ResourceRequest): ResourceResult {
    return generateResourceIn(store, req, "", noopEvent)
}

/**
 * 生成一份资源。
 *
 * cancelKey 非空时与 /api/agent/cancel 联动（用户在界面上点「停止」能当场停手）；
 * emit 收到的事件形状与既有问答/讲义链路一致（step/start、step/end、assistant/delta、validation、turn/end）。
 */
public func generateResourceIn(store: Store, reqIn: ResourceRequest, cancelKey: String,
    emit: (String, JsonObject) -> Unit): ResourceResult {
    return generateResourceWithCancel(store, reqIn, { => false }, emit)
}

public func generateResourceWithCancel(store: Store, reqIn: ResourceRequest, shouldAbort: () -> Bool,
    emit: (String, JsonObject) -> Unit): ResourceResult {
    let res = ResourceResult()
    let kind = if (isResourceKind(reqIn.kind)) { reqIn.kind } else { "lecture" }
    res.kind = kind
    let req = ResourceRequest()
    req.kind = kind
    req.topic = trimStr(reqIn.topic)
    req.kbId = reqIn.kbId
    req.detail = normalizeDetail(reqIn.detail)
    req.count = normalizeCount(kind, reqIn.count)
    req.save = reqIn.save
    req.maxRepair = if (reqIn.maxRepair >= 0 && reqIn.maxRepair <= 2) { reqIn.maxRepair } else { 2 }
    req.learningContext = reqIn.learningContext
    req.revision = reqIn.revision
    req.sourceSnapshots = reqIn.sourceSnapshots

    if (req.topic.size == 0) {
        res.ok = false
        res.message = "先给一个主题：想生成哪一章、哪个问题的" + labelOf(kind) + "。"
        emit("turn/end", endEvent(false, res.message))
        return res
    }

    let s = store.load()
    var cfg = ModelConfig()
    if (reqIn.provider.isNone()) {
    match (pickModel(s)) {
        case Some(c) => cfg = c
        case None =>
            res.ok = false
            res.message = "还没有可用的模型接口：先去「设置 → 模型与接口」填一个并绑定「对话与生成」。"
            res.quality = qualityJson(kind, JsonObject(), res.warnings, 0, 0, false)
            emit("turn/end", endEvent(false, res.message))
            return res
    }
    }
    let network = OpenAiChatProvider(cfg)
    network.shouldAbort = Some(shouldAbort)
    let chosen: ChatProvider = match (reqIn.provider) { case Some(p) => p; case None => network }
    let run = Run(chosen, store, emit)
    run.shouldAbort = shouldAbort
    run.context = req.learningContext + "\n修改要求（若有）：" + req.revision

    stepStart(run, 1, "retrieve")
    let hits = if (req.sourceSnapshots.size() > 0) { req.sourceSnapshots } else { retrieveHits(store, req.kbId, req.topic, 10, shouldAbort) }
    stepEnd(run, 1, "retrieve")
    if (hits.size() == 0) {
        res.warnings.add("这次没有检索到本机资料：内容以通用框架为主，产物里不会标注出处")
    }

    var content = JsonObject()
    var got = false
    try {
        if (kind == "lecture") {
            match (generateLecture(run, req, hits)) {
                case Some(o) =>
                    content = o
                    got = true
                case None => ()
            }
        } else if (kind == "quiz") {
            match (generateQuiz(run, req, hits)) {
                case Some(o) =>
                    content = o
                    got = true
                case None => ()
            }
        } else {
            match (generateStructured(run, req, hits)) {
                case Some(o) =>
                    content = o
                    got = true
                case None => ()
            }
        }
    } catch (e: CancelException) {
        res.ok = false
        res.message = "已取消"
        res.quality = qualityJson(kind, JsonObject(), ArrayList<String>(), 0, hits.size(), false)
        emit("turn/end", endEvent(false, res.message))
        return res
    }

    var fallback = false
    if (!got || !usable(kind, content)) {
        res.ok = false
        res.message = "模型没有返回可用的" + labelOf(kind) + "，未保存资源，请重试或更换模型。"
        for (w in run.warnings) { res.warnings.add(w) }
        if (res.warnings.size > 0) { res.message = res.message + " 原因：" + byteSafePrefix(joinWith(res.warnings, "；"), 600) }
        emit("turn/end", endEvent(false, res.message))
        return res
    }

    var rounds: Int64 = 0
    if (!fallback) {
        try {
            content = repairContent(run, kind, content, req.detail, req.count, hits, req.maxRepair)
        } catch (e: CancelException) { res.ok = false; res.message = "已取消"; return res }
        rounds = run.repairRounds
    }

    if (kind == "ppt") {
        normalizePptTeachingMoments(content, run.warnings)
    }

    let issues = checkContent(kind, content, req.detail, req.count, hits)
    let body = bodyTextOf(kind, content)
    let report = citationReport(body, hits.size())
    emitValidation(run, kind, report, citationsFromHits(hits))

    res.title = txt(content, "title")
    if (res.title.size == 0) {
        res.title = req.topic + labelOf(kind)
    }
    res.markdown = renderResource(kind, content, hits)
    res.content = content
    res.citations = citationsFromHits(hits)
    res.fallback = fallback
    // 注意用追加：前面还有「这次没检索到资料」这类警告，直接赋值会把它冲掉
    for (w in run.warnings) {
        res.warnings.add(w)
    }
    res.quality = qualityJson(kind, content, issues, rounds, hits.size(), fallback)
    for (w in citationIssues(body, hits.size())) { res.warnings.add(w) }

    if (issues.size > 0) {
        res.ok = false
        res.message = "资源未通过质检，未保存：" + joinWith(issues, "；")
        emit("turn/end", endEvent(false, res.message))
        return res
    }

    if (req.save) {
        stepStart(run, 101, "artifact_save")
        let saved = ToolRegistry(store).saveArtifact(prefixOf(kind) + "-" + req.topic + "-" + Random().nextUInt64().toString() + ".md", res.markdown)
        stepEnd(run, 101, "artifact_save")
        if (saved.ok) {
            match (saved.data) {
                case p: JsonString =>
                    res.artifactPath = p.getValue()
                    var cut = p.getValue().size
                    let b = p.getValue().toArray()
                    var i = b.size - 1
                    while (i > 0) {
                        if (b[i] == 92 || b[i] == 47) {
                            cut = i + 1
                            break
                        }
                        i = i - 1
                    }
                    res.artifactName = String.fromUtf8(b[cut..b.size])
                case o: JsonObject =>
                    res.artifactPath = strOf(o, "path")
                    let parts = res.artifactPath.replace("\\", "/").split("/")
                    res.artifactName = parts[parts.size - 1]
                case _ => ()
            }
        } else {
            res.ok = false
            res.message = "产物没写成功：" + saved.summary
            return res
        }
    }

    res.message = if (issues.size == 0) {
        "已生成" + labelOf(kind) + "（" + hits.size().toString() + " 条资料依据）"
    } else {
        "已生成" + labelOf(kind) + "，有几处需要留意：" + joinWith(issues, "；")
    }
    emit("turn/end", endEvent(true, res.message))
    return res
}

/** 结果转 JSON（接口返回与自检都用它）。 */
public func resultJson(res: ResourceResult): JsonObject {
    let o = JsonObject()
    o.put("ok", JsonBool(res.ok))
    o.put("kind", JsonString(res.kind))
    o.put("title", JsonString(res.title))
    o.put("message", JsonString(res.message))
    o.put("markdown", JsonString(res.markdown))
    o.put("content", res.content)
    o.put("citations", res.citations)
    o.put("quality", res.quality)
    o.put("artifactName", JsonString(res.artifactName))
    o.put("artifactPath", JsonString(res.artifactPath))
    o.put("format", JsonString(res.format))
    o.put("previewPath", JsonString(res.previewPath))
    o.put("designPath", JsonString(res.designPath))
    o.put("requestedSlides", JsonInt(res.requestedSlides))
    o.put("renderedSlides", JsonInt(res.renderedSlides))
    o.put("fallback", JsonBool(res.fallback))
    let ws = JsonArray()
    for (w in res.warnings) {
        ws.add(JsonString(w))
    }
    o.put("warnings", ws)
    return o
}
