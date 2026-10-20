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
