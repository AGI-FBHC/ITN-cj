package zhixun_learning

import std.collection.*
import std.core.*
import std.sync.*
import stdx.encoding.json.*

/**
 * 多智能体生成流程（角色划分沿用旧仓库 ITN-cj 的 agent 链）：
 *   规划 Planner → 检索 Retriever → 撰写 Writer → 质检 Reviewer → 仲裁 Arbiter（按需返修）
 * 每一步都写进 steps_json，管理端能看到推进过程；质检不通过先返修一轮，仍不通过就标记失败并保留问题清单。
 */

const CW_ROLE_PLANNER = "规划"
const CW_ROLE_RETRIEVER = "检索"
const CW_ROLE_WRITER = "撰写"
const CW_ROLE_REVIEWER = "质检"
const CW_ROLE_ARBITER = "仲裁"
let cwCourseSyncLock = Mutex()

const CW_WRITER_SYSTEM = "你是教培内容作者。只能依据给定资料写作，每个论断后用 [编号] 标注出处，不要编造资料之外的内容。输出 Markdown 正文，不要重复小节标题。"
const CW_STRUCTURED_SYSTEM = "你是严谨的学习内容作者。严格按用户给出的结构输出一个合法 JSON 对象，不输出解释或 Markdown 围栏。文字字段可含 Markdown，换行必须转义。依据给定资料，用 [编号] 标注真实来源，不编造编号。"

class CwStep {
    let role: String
    var status: String
    var summary: String
    var error: String

    init(role: String, status: String, summary: String, error: String) {
        this.role = role
        this.status = status
        this.summary = summary
        this.error = error
    }
}

class CwTrace {
    let steps: ArrayList<CwStep>

    init() {
        this.steps = ArrayList<CwStep>()
    }

    func add(role: String, status: String, summary: String, error: String): CwStep {
        let step = CwStep(role, status, summary, error)
        steps.add(step)
        step
    }

    func toJson(): String {
        let arr = JsonArrWriter()
        for (step in steps) {
            let item = JsonWriter()
            item.putStr("role", step.role)
            item.putStr("status", step.status)
            item.putStr("summary", kbTruncate(step.summary, 600))
            item.putStr("error", step.error)
            arr.addRaw(item.toJson())
        }
        arr.toJson()
    }
}

func cwValidKind(kind: String): Bool {
    kind == "lecture" || kind == "guide" || kind == "bank" || kind == "slides"
}

func cwLabel(kind: String): String {
    if (kind == "guide") { return "实操指南" }
    if (kind == "bank") { return "题库" }
    if (kind == "slides") { return "教学幻灯片" }
    "讲义文稿"
}

/** 去掉 ```json 围栏，模型偶尔会带。 */
func cwStripFences(text: String): String {
    var value = text.trimAscii()
    if (!value.startsWith("```")) { return value }
    let firstBreak = value.indexOf("\n")
    match (firstBreak) {
        case Some(position) => value = value[position + 1..value.size]
        case None => return value
    }
    let closing = value.lastIndexOf("```")
    match (closing) {
        case Some(position) => value[0..position].trimAscii()
        case None => value.trimAscii()
    }
}

func cwSliceJson(text: String, open: String, close: String): String {
    let start = text.indexOf(open)
    let end = text.lastIndexOf(close)
    match (start) {
        case Some(begin) =>
            match (end) {
                case Some(last) => if (last > begin) { text[begin..last + 1] } else { "" }
                case None => ""
            }
        case None => ""
    }
}

func cwJsonObjectFrom(text: String): ?JsonObject {
    let cleaned = cwStripFences(text)
    let slice = if (cleaned.startsWith("{")) { cleaned } else { cwSliceJson(cleaned, "{", "}") }
    if (slice.size == 0) { return None }
    match (jsonParse(slice)) {
        case Some(value) =>
            match (value.kind()) {
                case JsonKind.JsObject => Some(value.asObject())
                case _ => None
            }
        case None => None
    }
}

func cwTextOf(text: String, limit: Int64): String {
    let bytes = text.toArray()
    if (bytes.size <= limit) { return text }
    var end = limit
    while (end > 0 && !kbIsLeadByte(bytes[end])) { end -= 1 }
    String.fromUtf8(bytes.slice(0, end))
}

func cwCharCount(text: String): Int64 {
    kbCharsBetween(text.toArray(), 0, text.toArray().size)
}

func cwDigest(title: String, content: String): String {
    "标题：" + title + "\n开头内容：\n" + cwTextOf(content, 900)
}

/* ---------- ① 规划：先定结构，再写正文 ---------- */

func cwPlanPrompt(kind: String, title: String, digest: String): String {
    if (kind == "guide") {
        return "你是实训导师，负责设计实操任务的结构（先不写正文）。只输出一个 JSON 对象：\n" +
        "{\"title\":\"\",\"objective\":\"\",\"steps\":[{\"title\":\"\",\"goal\":\"\"}]}\n" +
        "要求：4~7 步，每步目标一句话说清「做完能得到什么」。\n主题：" + title + "\n资料线索：\n" + digest
    }
    if (kind == "slides") {
        return "你是演示稿设计者，只设计分页结构（先不写要点）。只输出一个 JSON 对象：\n" +
        "{\"title\":\"\",\"subtitle\":\"\",\"slides\":[{\"title\":\"\"}]}\n" +
        "要求：正好 10 页，标题不重复，顺序遵循「问题→概念→方法→案例→小结」。\n主题：" + title + "\n资料线索：\n" + digest
    }
    if (kind == "bank") {
        return "你是测评设计者。只输出一个 JSON 对象：{\"knowledgePoints\":[{\"id\":\"kp-1\",\"name\":\"\",\"description\":\"\"}]}，" +
        "3~5 个知识点，id 用 kp-1 / kp-2 这样；description 说清「这个概念用来判断什么」。\n主题：" + title + "\n资料线索：\n" + digest
    }
    "你是课程设计者，先规划讲义结构（先不写正文）。只输出一个 JSON 对象：\n" +
    "{\"title\":\"\",\"objective\":\"\",\"objectives\":[\"\",\"\"],\"sections\":[{\"heading\":\"\",\"brief\":\"\"}]}\n" +
    "要求：3~5 节，小节标题要具体（写清对象与范围），不要出现「概述」「小结」这类空标题；objectives 写 3 条可检验的学习目标。\n" +
    "主题：" + title + "\n资料线索：\n" + digest
}

/* ---------- ③ 撰写：按大纲与证据写正文 ---------- */

func cwWritePrompt(kind: String, title: String, plan: String, evidence: String, context: String): String {
    if (kind == "guide") {
        return "你是实训导师。按下面已确定的结构写完整实操指南，只输出一个 JSON 对象（不要解释、不要围栏），结构：\n" +
        "{\"title\":\"\",\"objective\":\"\",\"estimatedMinutes\":60,\"prerequisites\":[\"\"],\"environment\":[\"\"]," +
        "\"steps\":[{\"title\":\"\",\"instruction\":\"\",\"code\":\"\",\"expectedOutput\":\"\",\"safety\":\"safe\",\"warning\":\"\"}]," +
        "\"safetyChecklist\":[\"\"],\"safetyNotice\":\"\",\"acceptanceCriteria\":[\"\"],\"troubleshooting\":[{\"problem\":\"\",\"solution\":\"\"}],\"challenge\":\"\"}\n" +
        "要求：每步 instruction 90 字以上、含明确动作词；expectedOutput 写清「看到什么算成功」；safety 只能是 safe/caution/danger；" +
        "acceptanceCriteria 至少 3 条可客观判定；troubleshooting 至少 2 条。\n" +
        "主题：" + title + "\n已确定结构：\n" + plan + "\n可引用证据：\n" + evidence + "\n资料原文：\n" + context
    }
    if (kind == "slides") {
        return "你是演示稿设计者。按下面已确定的分页写完整内容，只输出一个 JSON 对象：\n" +
        "{\"title\":\"\",\"subtitle\":\"\",\"slides\":[{\"title\":\"\",\"bullets\":[\"\",\"\"],\"speakerNote\":\"\"}]}\n" +
        "要求：每页 2~5 条要点，每条不超过 40 字；speakerNote 写这一页怎么讲（30 字以上）。\n" +
        "主题：" + title + "\n已确定分页：\n" + plan + "\n可引用证据：\n" + evidence + "\n资料原文：\n" + context
    }
    if (kind == "bank") {
        return "你是测评设计者。按下面的知识点出题，只输出一个 JSON 对象：\n" +
        "{\"title\":\"\",\"questions\":[{\"id\":\"q-1\",\"knowledgePointId\":\"kp-1\",\"difficulty\":\"easy\",\"stem\":\"\"," +
        "\"options\":[\"\",\"\",\"\",\"\"],\"correctIndex\":0,\"explanation\":\"\"}]}\n" +
        "要求：正好 8 题；difficulty 用 easy/medium/hard 且覆盖三档；每题 4 个互不相同的选项；stem 给具体情境；" +
        "explanation 至少 40 字，说明为什么对、其余错在哪；正确答案位置要分散。\n" +
        "知识点（只能用这些 id）：\n" + plan + "\n主题：" + title + "\n可引用证据：\n" + evidence + "\n资料原文：\n" + context
    }
    "你是教培内容作者。按下面已确定的结构写完整讲义，只输出一个 JSON 对象：\n" +
    "{\"title\":\"\",\"objective\":\"\",\"objectives\":[\"\",\"\"],\"sections\":[{\"heading\":\"\",\"body\":\"\"}]}\n" +
    "要求：每节 body 300 字以上，要有具体示例或可操作说明；每个论断后用 [编号] 标注出处。\n" +
    "主题：" + title + "\n已确定结构：\n" + plan + "\n可引用证据：\n" + evidence + "\n资料原文：\n" + context
}

func cwRepairPrompt(kind: String, issues: ArrayList<String>, bad: String): String {
    let sb = StringBuilder()
    sb.append("你是内容质检员。下面这份 ")
    sb.append(cwLabel(kind))
    sb.append(" 的 JSON 有问题，请只输出修正后的 JSON（同样的结构，不要解释、不要围栏）。\nresourceType: ")
    sb.append(kind)
    sb.append("\n问题清单：\n")
    for (item in issues) {
        sb.append("- ")
        sb.append(item)
        sb.append("\n")
    }
    sb.append("\n原内容：\n")
    sb.append(cwTextOf(bad, 12000))
    sb.toString()
}

/* ---------- JSON 取值与校验 ---------- */

func cwStringList(obj: JsonObject, key: String): ArrayList<String> {
    let out = ArrayList<String>()
    match (jsonGetArray(obj, key)) {
        case Some(items) =>
            var i: Int64 = 0
            while (i < items.size()) {
                let item = items[i]
                match (item.kind()) {
                    case JsonKind.JsString =>
                        try { out.add(item.asString().getValue()) } catch (_: Exception) {}
                    case _ => ()
                }
                i += 1
            }
        case None => ()
    }
    out
}

func cwObjectList(obj: JsonObject, key: String): ArrayList<JsonObject> {
    let out = ArrayList<JsonObject>()
    match (jsonGetArray(obj, key)) {
        case Some(items) =>
            var i: Int64 = 0
            while (i < items.size()) {
                let item = items[i]
                match (item.kind()) {
                    case JsonKind.JsObject => out.add(item.asObject())
                    case _ => ()
                }
                i += 1
            }
        case None => ()
    }
    out
}

func cwField(obj: JsonObject, key: String): String {
    (jsonGetString(obj, key) ?? "").trimAscii()
}

func cwLectureIssues(obj: JsonObject): ArrayList<String> {
    let issues = ArrayList<String>()
    let sections = cwObjectList(obj, "sections")
    if (sections.size == 0) {
        issues.add("没有分节内容（模型可能没返回结构化讲义）")
        return issues
    }
    if (sections.size < 3) { issues.add("分节不足（当前 " + sections.size.toString() + " 节，至少 3 节）") }
    var short = 0
    var total: Int64 = 0
    for (section in sections) {
        let chars = cwCharCount(cwField(section, "body"))
        total += chars
        if (chars < 200) { short += 1 }
    }
    if (total < 900) { issues.add("正文过短（当前 " + total.toString() + " 字，期望 900 字以上）") }
    if (short > 0) { issues.add("有 " + short.toString() + " 节正文少于 200 字") }
    if (cwStringList(obj, "objectives").size < 3) { issues.add("学习目标少于 3 条") }
    issues
}

func cwGuideIssues(obj: JsonObject): ArrayList<String> {
    let issues = ArrayList<String>()
    let steps = cwObjectList(obj, "steps")
    if (steps.size == 0) {
        issues.add("没有可执行步骤（模型可能没返回结构化实操指南）")
        return issues
    }
    if (steps.size < 4) { issues.add("可执行步骤不足（当前 " + steps.size.toString() + " 步，至少 4 步）") }
    var short = 0
    var missingOut = 0
    var badSafety = 0
    for (step in steps) {
        if (cwCharCount(cwField(step, "instruction")) < 60) { short += 1 }
        if (cwField(step, "expectedOutput").size == 0) { missingOut += 1 }
        let safety = cwField(step, "safety")
        if (safety != "safe" && safety != "caution" && safety != "danger") { badSafety += 1 }
    }
    if (short > 0) { issues.add("有 " + short.toString() + " 个步骤说明过短") }
    if (missingOut > 0) { issues.add("有 " + missingOut.toString() + " 个步骤缺少具体预期结果") }
    if (badSafety > 0) { issues.add("有 " + badSafety.toString() + " 个步骤缺少有效风险等级（safe/caution/danger）") }
    if (cwStringList(obj, "acceptanceCriteria").size < 3) { issues.add("可客观判定的验收标准不足 3 条") }
    if (cwObjectList(obj, "troubleshooting").size < 2) { issues.add("故障排查不足 2 条") }
    issues
}

func cwBankIssues(obj: JsonObject, expected: Int64): ArrayList<String> {
    let issues = ArrayList<String>()
    let questions = cwObjectList(obj, "questions")
    if (questions.size == 0) {
        issues.add("没有题目（模型可能没返回结构化题库）")
        return issues
    }
    if (questions.size != expected) {
        issues.add("题量不正确（当前 " + questions.size.toString() + " 题，应为 " + expected.toString() + " 题）")
    }
    var badOptions = 0
    var shortExplain = 0
    var badAnswer = 0
    var missingKp = 0
    for (question in questions) {
        let options = cwStringList(question, "options")
        var distinct = HashSet<String>()
        for (option in options) { distinct.add(option) }
        if (options.size != 4 || distinct.size < 4) { badOptions += 1 }
        if (cwCharCount(cwField(question, "explanation")) < 40) { shortExplain += 1 }
        let correct = jsonGetInt(question, "correctIndex") ?? -1
        if (correct < 0 || correct >= options.size) { badAnswer += 1 }
        if (cwField(question, "knowledgePointId").size == 0) { missingKp += 1 }
    }
    if (badOptions > 0) { issues.add("有 " + badOptions.toString() + " 题未提供 4 个互不重复的选项") }
    if (shortExplain > 0) { issues.add("有 " + shortExplain.toString() + " 题解析过短") }
    if (badAnswer > 0) { issues.add("存在无效正确答案索引") }
    if (missingKp > 0) { issues.add("有 " + missingKp.toString() + " 题没有关联知识点") }
    issues
}

func cwSlidesIssues(obj: JsonObject, expected: Int64): ArrayList<String> {
    let issues = ArrayList<String>()
    let slides = cwObjectList(obj, "slides")
    if (slides.size == 0) {
        issues.add("没有幻灯片（模型可能没返回结构化演示稿）")
        return issues
    }
    if (slides.size != expected) {
        issues.add("页数不正确（当前 " + slides.size.toString() + " 页，应为 " + expected.toString() + " 页）")
    }
    var badBullets = 0
    var longBullets = 0
    var shortNote = 0
    for (slide in slides) {
        let bullets = cwStringList(slide, "bullets")
        if (bullets.size < 2 || bullets.size > 5) { badBullets += 1 }
        for (bullet in bullets) {
            if (cwCharCount(bullet) > 40) { longBullets += 1 }
        }
        if (cwCharCount(cwField(slide, "speakerNote")) < 30) { shortNote += 1 }
    }
    if (badBullets > 0) { issues.add("有 " + badBullets.toString() + " 页要点数量不在 2~5 条之间") }
    if (longBullets > 0) { issues.add("有 " + longBullets.toString() + " 条要点超过 40 字") }
    if (shortNote > 0) { issues.add("有 " + shortNote.toString() + " 页缺少讲稿（30 字以上）") }
    issues
}

func cwIssuesOf(kind: String, obj: JsonObject): ArrayList<String> {
    if (kind == "guide") { return cwGuideIssues(obj) }
    if (kind == "bank") { return cwBankIssues(obj, 8) }
    if (kind == "slides") { return cwSlidesIssues(obj, 10) }
    cwLectureIssues(obj)
}

/* ---------- ② 检索：从知识库取跨章证据 ---------- */

func cwEvidence(cfg: Config, settings: KbSettings, title: String, plan: String): String {
    let queryText = title + " " + cwTextOf(plan, 300)
    let result = kbSearch(cfg, settings, queryText, 4)
    if (result.hits.size == 0) { return "（知识库中没有可引用的其他片段，仅按本章原文撰写）" }
    let sb = StringBuilder()
    var i: Int64 = 0
    while (i < result.hits.size) {
        let hit = result.hits[i]
        sb.append("[")
        sb.append((i + 1).toString())
        sb.append("] 《")
        sb.append(hit.docTitle)
        sb.append("》")
        if (hit.headingPath.size > 0) {
            sb.append(" · ")
            sb.append(hit.headingPath)
        }
        sb.append("\n")
        sb.append(cwTextOf(hit.text, 500))
        sb.append("\n\n")
        i += 1
    }
    sb.toString()
}

/* ---------- 流水线 ---------- */

class CwOutcome {
    let ok: Bool
    let title: String
    let contentJson: String
    let error: String

    init(ok: Bool, title: String, contentJson: String, error: String) {
        this.ok = ok
        this.title = title
        this.contentJson = contentJson
        this.error = error
    }
}

func cwJoinIssues(issues: ArrayList<String>): String {
    let sb = StringBuilder()
    var i: Int64 = 0
    while (i < issues.size && i < 4) {
        if (i > 0) { sb.append("；") }
        sb.append(issues[i])
        i += 1
    }
    sb.toString()
}

func cwPersistTrace(cfg: Config, id: String, trace: CwTrace): Unit {
    execute(cfg, "UPDATE kb_courseware SET steps_json=" + sqlQuote(trace.toJson()) + " WHERE id=" + sqlQuote(id))
}

func cwRunOne(cfg: Config, id: String): Unit {
    let rows = query(cfg,
        "SELECT c.id,c.kind,c.bundle_id,c.doc_id,d.title doc_title,d.content doc_content " +
        "FROM kb_courseware c JOIN kb_bundle_docs d ON d.id=c.doc_id WHERE c.id=" + sqlQuote(id))
    if (rows.size == 0) { return }
    let row = rows[0]
    let kind = row.text("kind")
    let title = row.text("doc_title")
    let content = row.text("doc_content")
    let settings = loadKbSettings(cfg)
    let endpoint = slotEndpoint(cfg, settings.chat)
    let trace = CwTrace()
    if (!endpoint.hasChat()) {
        trace.add(CW_ROLE_PLANNER, "failed", "", "还没有配置对话模型")
        cwSetRow(cfg, id, "failed", "", "", "还没有配置对话模型")
        cwPersistTrace(cfg, id, trace)
        return
    }
    try {
        let digest = cwDigest(title, content)
        let context = cwTextOf(content, 8000)

        // ① 规划
        let planStep = trace.add(CW_ROLE_PLANNER, "running", "", "")
        let planText = chatPlain(endpoint, CW_STRUCTURED_SYSTEM, cwPlanPrompt(kind, title, digest), 0.2)
        let planObj = match (cwJsonObjectFrom(planText)) {
            case Some(value) => value
            case None =>
                planStep.status = "failed"
                planStep.error = "规划结果无法解析为 JSON"
                cwPersistTrace(cfg, id, trace)
                cwSetRow(cfg, id, "failed", "", "", "规划阶段失败：无法解析大纲")
                return
        }
        planStep.status = "done"
        planStep.summary = cwTextOf(cwStripFences(planText), 400)
        cwPersistTrace(cfg, id, trace)

        // ② 检索
        let searchStep = trace.add(CW_ROLE_RETRIEVER, "running", "", "")
        let evidence = cwEvidence(cfg, settings, title, planText)
        searchStep.status = "done"
        searchStep.summary = if (evidence.startsWith("（知识库")) { "没有额外的可引用片段" } else { cwTextOf(evidence, 300) }
        cwPersistTrace(cfg, id, trace)

        // ③ 撰写
        let writeStep = trace.add(CW_ROLE_WRITER, "running", "", "")
        var written = chatPlain(endpoint, CW_STRUCTURED_SYSTEM,
            cwWritePrompt(kind, title, cwStripFences(planText), evidence, context), 0.35)
        var obj = match (cwJsonObjectFrom(written)) {
            case Some(value) => value
            case None =>
                writeStep.status = "failed"
                writeStep.error = "正文无法解析为 JSON"
                cwPersistTrace(cfg, id, trace)
                cwSetRow(cfg, id, "failed", "", "", "撰写阶段失败：正文不是合法 JSON")
                return
        }
        writeStep.status = "done"
        writeStep.summary = "已写出 " + cwCharCount(cwStripFences(written)).toString() + " 字"
        cwPersistTrace(cfg, id, trace)

        // ④ 质检
        let reviewStep = trace.add(CW_ROLE_REVIEWER, "running", "", "")
        var issues = cwIssuesOf(kind, obj)
        reviewStep.status = if (issues.size == 0) { "done" } else { "failed" }
        reviewStep.summary = if (issues.size == 0) { "结构校验通过" } else { cwJoinIssues(issues) }
        cwPersistTrace(cfg, id, trace)

        // ⑤ 仲裁：不通过则带问题清单返修一次
        if (issues.size > 0) {
            let fixStep = trace.add(CW_ROLE_ARBITER, "running", "", "")
            let repaired = chatPlain(endpoint, CW_STRUCTURED_SYSTEM, cwRepairPrompt(kind, issues, written), 0.2)
            match (cwJsonObjectFrom(repaired)) {
                case Some(value) =>
                    if (cwIssuesOf(kind, value).size < issues.size) {
                        obj = value
                        written = repaired
                    }
                case None => ()
            }
            issues = cwIssuesOf(kind, obj)
            fixStep.status = if (issues.size == 0) { "done" } else { "failed" }
            fixStep.summary = if (issues.size == 0) { "返修后通过质检" } else { cwJoinIssues(issues) }
            cwPersistTrace(cfg, id, trace)
        }

        let objTitle = cwField(obj, "title")
        let finalTitle = if (objTitle.size > 0) { objTitle } else { title + " · " + cwLabel(kind) }
        if (issues.size > 0) {
            cwSetRow(cfg, id, "failed", finalTitle, "", cwJoinIssues(issues))
            return
        }

        // 题库是两段内容，重新拼一次原始 JSON
        var contentJson = cwStripFences(written)
        if (!contentJson.startsWith("{")) { contentJson = cwSliceJson(contentJson, "{", "}") }
        if (kind == "bank") {
            let kpRaw = cwArrayTextOf(cwStripFences(planText), "knowledgePoints")
            let questionRaw = cwArrayTextOf(contentJson, "questions")
            let merged = JsonWriter()
            merged.putRaw("knowledgePoints", if (kpRaw.size > 0) { kpRaw } else { "[]" })
            merged.putRaw("questions", if (questionRaw.size > 0) { questionRaw } else { "[]" })
            contentJson = merged.toJson()
        }
        cwSetRow(cfg, id, "ready", finalTitle, contentJson, "")
    } catch (error: Exception) {
        trace.add(CW_ROLE_ARBITER, "failed", "", kbTruncate(error.message, 300))
        cwPersistTrace(cfg, id, trace)
        cwSetRow(cfg, id, "failed", "", "", "生成失败：" + kbTruncate(error.message, 300))
    }
}

/** 取某个键后面的数组原文（按括号配对），避免用会错编字符串的 toJsonString。 */
func cwArrayTextOf(text: String, key: String): String {
    let marker = text.indexOf("\"" + key + "\"")
    match (marker) {
        case Some(position) =>
            let open = text.indexOf("[", position)
            match (open) {
                case Some(begin) =>
                    var depth: Int64 = 0
                    var i = begin
                    var inString = false
                    while (i < text.size) {
                        let ch = text[i..i + 1]
                        if (ch == "\\") {
                            i += 2
                            continue
                        }
                        if (ch == "\"") { inString = !inString }
                        if (!inString) {
                            if (ch == "[") { depth += 1 }
                            if (ch == "]") {
                                depth -= 1
                                if (depth == 0) { return text[begin..i + 1] }
                            }
                        }
                        i += 1
                    }
                    ""
                case None => ""
            }
        case None => ""
    }
}

func cwSetRow(cfg: Config, id: String, status: String, title: String, content: String, error: String): Unit {
    execute(cfg,
        "UPDATE kb_courseware SET status=" + sqlQuote(status) + ",title=" + sqlQuote(title) +
        ",content_json=" + (if (content.size > 0) { sqlQuote(content) } else { "NULL" }) +
        ",error_message=" + sqlQuote(error) + ",updated_at=NOW(6) WHERE id=" + sqlQuote(id))
}

func cwLaunch(cfg: Config, ids: Array<String>): Unit {
    for (id in ids) {
        spawn {
            try { cwRunOne(cfg, id) } catch (_: Exception) {}
        }
    }
}

/* ---------- 章节上架：用户端只看到已上架章节的已发布课件 ---------- */

func cwChapterOrderTaken(cfg: Config, bundleId: String, order: Int64, exceptDocId: String): Bool {
    let rows = query(cfg,
        "SELECT doc_id FROM kb_courseware_chapters WHERE bundle_id=" + sqlQuote(bundleId) +
        " AND order_no=" + order.toString())
    if (rows.size == 0) { return false }
    if (rows[0].text("doc_id") == exceptDocId) { return false }
    true
}

func cwMarkDocCoursewarePublished(cfg: Config, docId: String, published: Bool): Unit {
    execute(cfg, "UPDATE kb_courseware SET published=" + (if (published) { "1" } else { "0" }) +
        ",updated_at=NOW(6) WHERE doc_id=" + sqlQuote(docId) + " AND status='ready'")
}

func cwPublishChapter(cfg: Config, bundleId: String, docId: String, order: Int64): String {
    if (order < 1 || order > 999) { return "序号需要在 1–999 之间" }
    if (!kbBundlePublished(cfg, bundleId)) { return "课程还没有上架，先上架课程再发布课件" }
    let docs = query(cfg, "SELECT id,title FROM kb_bundle_docs WHERE id=" + sqlQuote(docId) +
        " AND bundle_id=" + sqlQuote(bundleId))
    if (docs.size == 0) { return "这个章节不属于所选知识库" }
    let ready = query(cfg,
        "SELECT COUNT(*) n FROM kb_courseware WHERE doc_id=" + sqlQuote(docId) +
        " AND status='ready' AND published=1")
    if (ready.size == 0 || ready[0].int("n") == 0) { return "这个章节还没有已发布的资源" }
    if (cwChapterOrderTaken(cfg, bundleId, order, docId)) { return "序号 " + order.toString() + " 已被占用" }
    transaction(cfg, [
        "DELETE FROM kb_courseware_chapters WHERE bundle_id=" + sqlQuote(bundleId) +
            " AND doc_id=" + sqlQuote(docId),
        "INSERT INTO kb_courseware_chapters(bundle_id,doc_id,order_no,updated_at) VALUES(" +
            sqlQuote(bundleId) + "," + sqlQuote(docId) + "," + order.toString() + ",NOW(6))"
    ])
    cwRebuildBundleCourse(cfg, bundleId, "")
    ""
}

func cwUnpublishChapter(cfg: Config, bundleId: String, docId: String): Unit {
    execute(cfg, "DELETE FROM kb_courseware_chapters WHERE bundle_id=" + sqlQuote(bundleId) +
        " AND doc_id=" + sqlQuote(docId))
    cwRebuildBundleCourse(cfg, bundleId, "")
}

/** 从已上架章节重建课程课时：讲义/实操/幻灯片进 sections+slides，题库进 quiz_json。
 *  forceStatus 非空时覆盖课程状态；为空表示保留课程当前的上架状态。 */
func cwRebuildBundleCourse(cfg: Config, bundleId: String, forceStatus: String): Unit {
    cwCourseSyncLock.lock()
    try { cwSyncBundleCourseLocked(cfg, bundleId, forceStatus) } finally { cwCourseSyncLock.unlock() }
}

/** Resolve legacy source metadata once; a bound identity never follows a display number. */
func cwLessonSourceId(bound: String, sources: String, refs: HashMap<String, String>): String {
    if (bound.size > 0) { return bound }
    let values = jsonArrayFromText(sources)
    if (values.size() == 0 || !isJsObject(values[0])) { return "" }
    refs.get(jsonGetString(values[0].asObject(), "id") ?? "") ?? ""
}

func cwSyncBundleCourseLocked(cfg: Config, bundleId: String, forceStatus: String): Unit {
    let bundles = query(cfg, "SELECT title,name,course_id FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
    if (bundles.size == 0) { return }
    let title = if (bundles[0].text("title").size > 0) { bundles[0].text("title") } else { bundles[0].text("name") }
    let existingCourse = bundles[0].text("course_id")
    let courseId = if (existingCourse.size > 0) { existingCourse } else { "kb-" + bundleId.replace("-", "") }
    let chapters = query(cfg,
        "SELECT c.doc_id,c.order_no,d.title doc_title FROM kb_courseware_chapters c " +
        "JOIN kb_bundle_docs d ON d.id=c.doc_id WHERE c.bundle_id=" + sqlQuote(bundleId) +
        " AND EXISTS(SELECT 1 FROM kb_courseware w WHERE w.doc_id=c.doc_id AND w.published=1 AND w.status='ready') " +
        "ORDER BY c.order_no")

    let refs = HashMap<String, String>()
    for (doc in query(cfg, "SELECT id,COALESCE(document_id,'') document_id FROM kb_bundle_docs WHERE bundle_id=" + sqlQuote(bundleId))) {
        refs[doc.text("id")] = doc.text("id")
        if (doc.text("document_id").size > 0) { refs[doc.text("document_id")] = doc.text("id") }
    }
    let slots = HashMap<String, Int64>()
    var nextSlot: Int64 = 0
    for (lesson in query(cfg, "SELECT lesson_index,COALESCE(source_doc_id,'') source_doc_id,sources_json FROM lessons WHERE course_id=" + sqlQuote(courseId))) {
        let slot = lesson.int("lesson_index")
        if (slot >= nextSlot) { nextSlot = slot + 1 }
        let source = cwLessonSourceId(lesson.text("source_doc_id"), lesson.text("sources_json"), refs)
        if (source.size == 0) { continue }
        if (slots.contains(source)) { throw Exception("章节学习记录对应重复，原记录已保留，请先检查课程内容") }
        slots[source] = slot
    }
    let statements = ArrayList<String>()
    // Hide retained lessons first, then upsert the current content atomically.
    // Never delete their FK identities: progress and quiz history stay attached.
    statements.add("UPDATE lessons SET is_visible=0,display_index=NULL WHERE course_id=" + sqlQuote(courseId))
    let keepStatusSql = if (forceStatus.size > 0) { "status=VALUES(status)," } else { "" }
    if (chapters.size == 0) {
        let emptyStatus = if (forceStatus.size > 0) { forceStatus } else { "draft" }
        statements.add("INSERT INTO courses(id,name,icon,description,level,duration,chapters_json,source_label,status,sort_order) VALUES(" +
            sqlQuote(courseId) + "," + sqlQuote(title) + "," + sqlQuote("/api/kb/bundles/" + bundleId + "/logo") +
            ",'','入门',0,'[]'," + sqlQuote("知识库《" + title + "》") + "," + sqlQuote(emptyStatus) + ",100) " +
            "ON DUPLICATE KEY UPDATE " + keepStatusSql + "chapters_json='[]',updated_at=NOW(6)")
        statements.add("UPDATE kb_bundles SET course_id=" + sqlQuote(courseId) + " WHERE id=" + sqlQuote(bundleId))
        transaction(cfg, statements.toArray())
        kbBumpVersion()
        return
    }

    let liveStatus = if (forceStatus.size > 0) { forceStatus } else { "published" }
    let chapterArr = JsonArrWriter()
    var lessonIndex: Int64 = 0
    for (chapter in chapters) {
        let docId = chapter.text("doc_id")
        let docTitle = chapter.text("doc_title")
        let savedSlot = slots.get(docId)
        let stableIndex = savedSlot ?? nextSlot
        if (savedSlot == None) { nextSlot += 1; slots[docId] = stableIndex }
        let chapterJson = JsonWriter()
        chapterJson.putStr("title", docTitle)
        chapterArr.addRaw(chapterJson.toJson())

        let resources = query(cfg,
            "SELECT kind,content_json FROM kb_courseware WHERE doc_id=" + sqlQuote(docId) +
            " AND status='ready' AND published=1 ORDER BY CASE kind WHEN 'lecture' THEN 1 WHEN 'guide' THEN 2 " +
            "WHEN 'slides' THEN 3 ELSE 4 END")
        let sections = JsonArrWriter()
        let slides = JsonArrWriter()
        let quiz = JsonArrWriter()
        var sectionIndex: Int64 = 0
        for (resource in resources) {
            let kind = resource.text("kind")
            let parsed = match (cwJsonObjectFrom(resource.text("content_json"))) {
                case Some(value) => value
                case None => continue
            }
            if (kind == "lecture") {
                for (item in cwObjectList(parsed, "sections")) {
                    let section = JsonWriter()
                    section.putStr("id", "cw-" + sectionIndex.toString())
                    section.putStr("eyebrow", "讲义")
                    section.putStr("heading", cwField(item, "heading"))
                    section.putStr("text", cwField(item, "body"))
                    sections.addRaw(section.toJson())
                    sectionIndex += 1
                }
            } else if (kind == "guide") {
                for (step in cwObjectList(parsed, "steps")) {
                    let section = JsonWriter()
                    section.putStr("id", "cw-" + sectionIndex.toString())
                    section.putStr("eyebrow", "实操")
                    section.putStr("heading", cwField(step, "title"))
                    var body = cwField(step, "instruction")
                    let code = cwField(step, "code")
                    if (code.size > 0) { body = body + "\n\n```\n" + code + "\n```" }
                    let expect = cwField(step, "expectedOutput")
                    if (expect.size > 0) { body = body + "\n\n预期结果：" + expect }
                    section.putStr("text", body)
                    sections.addRaw(section.toJson())
                    sectionIndex += 1
                }
            } else if (kind == "slides") {
                for (slide in cwObjectList(parsed, "slides")) {
                    let slideJson = JsonWriter()
                    slideJson.putStr("title", cwField(slide, "title"))
                    slideJson.putStr("subtitle", "课程课件")
                    let bullets = JsonArrWriter()
                    for (bullet in cwStringList(slide, "bullets")) {
                        bullets.addRaw(jsonQuote(bullet))
                    }
                    slideJson.putRaw("bullets", bullets.toJson())
                    slideJson.putStr("notes", cwField(slide, "speakerNote"))
                    slides.addRaw(slideJson.toJson())
                }
            } else if (kind == "bank") {
                for (question in cwObjectList(parsed, "questions")) {
                    let quizItem = JsonWriter()
                    quizItem.putStr("id", cwField(question, "id"))
                    quizItem.putStr("question", cwField(question, "stem"))
                    let options = JsonArrWriter()
                    for (option in cwStringList(question, "options")) {
                        options.addRaw(jsonQuote(option))
                    }
                    quizItem.putRaw("options", options.toJson())
                    quizItem.putInt("correct", jsonGetInt(question, "correctIndex") ?? 0)
                    quizItem.putStr("explanation", cwField(question, "explanation"))
                    quizItem.putStr("theoryTitle", cwField(question, "knowledgePointId"))
                    quiz.addRaw(quizItem.toJson())
                }
            }
        }
        let content = JsonWriter()
        content.putRaw("sections", sections.toJson())
        content.putRaw("slides", slides.toJson())
        content.putRaw("resources", lrTypedResources(resources))
        content.putStr("sourceLabel", "知识库《" + title + "》")
        let sources = JsonArrWriter()
        let source = JsonWriter()
        source.putStr("id", docId)
        source.putStr("title", docTitle)
        source.putStr("kind", "kb-courseware")
        sources.addRaw(source.toJson())
        statements.add("INSERT INTO lessons(course_id,lesson_index,title,content_json,quiz_json,sources_json,source_doc_id,display_index,is_visible) VALUES(" +
            sqlQuote(courseId) + "," + stableIndex.toString() + "," + sqlQuote(docTitle) + "," +
            sqlQuote(content.toJson()) + "," + sqlQuote(quiz.toJson()) + "," + sqlQuote(sources.toJson()) + "," +
            sqlQuote(docId) + "," + lessonIndex.toString() + ",1) ON DUPLICATE KEY UPDATE " +
            "title=VALUES(title),content_json=VALUES(content_json),quiz_json=VALUES(quiz_json),sources_json=VALUES(sources_json)," +
            "source_doc_id=VALUES(source_doc_id),display_index=VALUES(display_index),is_visible=1,updated_at=NOW(6)")
        lessonIndex += 1
    }
    statements.add("INSERT INTO courses(id,name,icon,description,level,duration,chapters_json,source_label,status,sort_order) VALUES(" +
        sqlQuote(courseId) + "," + sqlQuote(title) + "," + sqlQuote("/api/kb/bundles/" + bundleId + "/logo") +
        ",'','入门'," + (chapters.size * 15).toString() + "," + sqlQuote(chapterArr.toJson()) + "," +
        sqlQuote("知识库《" + title + "》") + "," + sqlQuote(liveStatus) + ",100) " +
        "ON DUPLICATE KEY UPDATE name=VALUES(name),icon=VALUES(icon),duration=VALUES(duration)," +
        "chapters_json=VALUES(chapters_json),source_label=VALUES(source_label)," + keepStatusSql + "updated_at=NOW(6)")
    statements.add("UPDATE kb_bundles SET course_id=" + sqlQuote(courseId) + " WHERE id=" + sqlQuote(bundleId))
    transaction(cfg, statements.toArray())
    kbBumpVersion()
}

/** 单份资源的发布状态变化后，同步它所属章节的课程内容（章节未上架时无需重建）。 */
func cwSyncCoursewareCourse(cfg: Config, coursewareId: String): Unit {
    let rows = query(cfg, "SELECT bundle_id,doc_id FROM kb_courseware WHERE id=" + sqlQuote(coursewareId))
    if (rows.size == 0) { return }
    cwSyncChapterCourse(cfg, rows[0].text("bundle_id"), rows[0].text("doc_id"))
}

func cwSyncChapterCourse(cfg: Config, bundleId: String, docId: String): Unit {
    if (query(cfg, "SELECT doc_id FROM kb_courseware_chapters WHERE bundle_id=" + sqlQuote(bundleId) +
        " AND doc_id=" + sqlQuote(docId)).size == 0) { return }
    cwRebuildBundleCourse(cfg, bundleId, "")
}

func cwChaptersBody(cfg: Config, bundleId: String): String {
    let published = query(cfg,
        "SELECT c.doc_id,c.order_no,d.title doc_title," +
        "(SELECT COUNT(*) FROM kb_courseware w WHERE w.doc_id=c.doc_id AND w.published=1 AND w.status='ready') live_count " +
        "FROM kb_courseware_chapters c JOIN kb_bundle_docs d ON d.id=c.doc_id " +
        "WHERE c.bundle_id=" + sqlQuote(bundleId) + " ORDER BY c.order_no")
    let arr = JsonArrWriter()
    var used = HashSet<Int64>()
    for (row in published) {
        let item = JsonWriter()
        item.putStr("docId", row.text("doc_id"))
        item.putStr("docTitle", row.text("doc_title"))
        item.putInt("orderNo", row.int("order_no"))
        item.putInt("liveCount", row.int("live_count"))
        arr.addRaw(item.toJson())
        used.add(row.int("order_no"))
    }
    var nextFree: Int64 = 1
    while (used.contains(nextFree)) { nextFree += 1 }
    let out = JsonWriter()
    out.putRaw("published", arr.toJson())
    out.putInt("nextFree", nextFree)
    out.putInt("publishedCount", published.size)
    out.toJson()
}
