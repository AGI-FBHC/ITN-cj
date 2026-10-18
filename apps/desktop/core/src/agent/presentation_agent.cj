package itn_desktop_core.agent

import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import itn_desktop_core.presentation.DesktopJobs
import itn_desktop_core.learning.LearningStore
import itn_desktop_core.llm.LlmClient
import itn_desktop_core.resource.jsonObjectFromModel
import itn_desktop_core.store.Store
import itn_desktop_core.util.*

func presentationText(o: JsonObject, key: String): String {
    match (o.get(key)) {
        case Some(v) => match (v) {
            case s: JsonString => return s.getValue()
            case _ => return v.toString()
        }
        case None => return ""
    }
}
func presentationArray(o: JsonObject, key: String): JsonArray {
    match (o.get(key)) {
        case Some(v) => match (v) {
            case a: JsonArray => return a
            case _ => return JsonArray()
        }
        case None => return JsonArray()
    }
}
/**
 * 固定流水线的 PPT 子 Agent。
 *
 * 它不是让模型自由编排的外层 Agent：只做一条可重复的链路：
 * 需求归一化 -> 结构化提纲 -> 旧网页版 python-pptx 兼容渲染 -> 候选 PPTX。
 * 模型只负责提纲和页面内容，流程/文件/失败处理都在仓颉里。
 */
public class PresentationAgent {
    let store: Store

    public init(store: Store) {
        this.store = store
    }

    func chooseSlideCount(args: JsonObject): Int64 {
        let requested = intOf(args, "slideCount")
        if (requested > 0) { return requested }
        let detail = presentationDetail(presentationText(args, "detailLevel"))
        if (detail == "concise") { return 12 }
        if (detail == "balanced") { return 20 }
        return 24
    }

    func presentationOutlineUsable(outline: JsonObject, target: Int64): Bool {
        let slides = presentationArray(outline, "slides")
        if (target > 0 && Int64(slides.size()) != target) { return false }
        if (slides.size() == 0) { return false }
        var i = 0
        while (i < slides.size()) {
            match (slides[i]) {
                case slide: JsonObject => if (presentationText(slide, "title").size == 0) { return false }
                case _ => return false
            }
            i = i + 1
        }
        return true
    }
func presentationDetail(raw: String): String {
    let value = trimStr(raw)
    if (value == "精简" || value == "简洁" || value == "concise") { return "concise" }
    if (value == "均衡" || value == "balanced") { return "balanced" }
    if (value == "详细" || value == "detailed") { return "detailed" }
    return "detailed"
}
func presentationBackground(raw: String): String {
    let value = trimStr(raw)
    let allowed = ["none", "colorful-ink", "sunset-mountains", "abstract-gradient", "clean-minimal",
        "cartoon-doodle", "blue-white-minimal", "blue-conference", "morandi-blue-gray", "business-gray", "watercolor"]
    for (name in allowed) { if (value == name) { return value } }
    if (value.contains("蓝白")) { return "blue-white-minimal" }
    if (value.contains("蓝")) { return "blue-conference" }
    if (value.contains("水墨")) { return "colorful-ink" }
    if (value.contains("水彩")) { return "watercolor" }
    if (value.contains("商务")) { return "business-gray" }
    if (value.contains("渐变")) { return "abstract-gradient" }
    if (value.contains("卡通")) { return "cartoon-doodle" }
    if (value.contains("山") || value.contains("夕阳")) { return "sunset-mountains" }
    if (value.contains("莫兰迪")) { return "morandi-blue-gray" }
    return "clean-minimal"
}
func requestJson(args: JsonObject, requirement: String, title: String, slideCount: Int64): JsonObject {
        let r = JsonObject()
        r.put("requirement", JsonString(requirement))
        r.put("title", JsonString(title))
        var audience = trimStr(presentationText(args, "audience"))
        if (audience.size == 0) { audience = "students" }
        var purpose = trimStr(presentationText(args, "purpose"))
        if (purpose.size == 0) { purpose = "courseware" }
        var style = trimStr(presentationText(args, "style"))
        if (style.size == 0) { style = "education" }
        var bg = presentationBackground(presentationText(args, "backgroundStyle"))
        var language = trimStr(presentationText(args, "language"))
        if (language.size == 0) { language = "zh-CN" }
        var ratio = trimStr(presentationText(args, "aspectRatio"))
        if (ratio.size == 0) { ratio = "16:9" }
        var detail = presentationDetail(presentationText(args, "detailLevel"))
        if (detail.size == 0) { detail = "detailed" }
        r.put("audience", JsonString(audience))
        r.put("purpose", JsonString(purpose))
        r.put("style", JsonString(style))
        r.put("backgroundStyle", JsonString(bg))
        r.put("language", JsonString(language))
        r.put("slideCount", JsonInt(slideCount))
        r.put("aspectRatio", JsonString(ratio))
        r.put("detailLevel", JsonString(detail))
        r.put("includeSpeakerNotes", JsonBool(true))
        r.put("modelProvider", JsonString("mimo"))
        r.put("generationMode", JsonString("template"))
        return r
    }

    func outlinePrompt(request: JsonObject, context: String): String {
        let sb = StringBuilder()
        sb.append("请设计一份内容充实、可直接授课或汇报的交互课件。只输出一个 JSON 对象，不要 Markdown 围栏，不要解释。\n")
        sb.append("根节点必须包含 title、subtitle、slides。页数必须严格等于 request.slideCount。\n")
        sb.append("固定结构：第1页封面；第2页目录；最后1页总结。目录必须概括正文章节，至少3章；系统会自动在章节前插入章节页。\n")
        sb.append("每页必须有 title、kind、points、speakerNotes。points 为3-5个对象，每项含 heading 和 detail；detail 必须完整、具体，以句号结尾。\n")
        sb.append("kind 只能从 title/agenda/overview/concept/code/comparison/process/table/timeline/roadmap/spotlight/checklist/case/practice/conclusion 中选择。\n")
        sb.append("technical/编程/算法主题至少四分之一正文页用 code/case/practice；code 页额外给 code={language,caption,content,annotations,output}，代码8-22行。\n")
        sb.append("process/timeline 页给 process=[{label,detail}]；table 页给 table={headers,rows}；comparison 页用2列或4卡片，避免三栏长段落。\n")
        sb.append("speakerNotes 必须是可逐字朗读的中文口播稿，120-240字；禁止写“介绍本页/说明本章/展开讲解/引导听众”等导演式指令，也不要机械重复页面要点。\n")
        sb.append("每3-4页至少安排1道 teachingMoments quiz；每章最后一页安排1个 summary。quiz 必须有4个同主题选项、answerIndex、explanation；anchorText 必须逐字取自同页 speakerNotes。\n")
        sb.append("页面叙事要具体：给事实、例子、代码、对比、步骤和练习，不要只有口号或三段式套话。标题、副标题要自然具体。\n")
        sb.append("请优先使用视觉上不同的页面类型，避免每页都是同样的三条要点。\n")
        sb.append("用户参数：")
        sb.append(request.toString())
        sb.append("\n")
        if (context.size > 0) {
            sb.append("当前学习上下文（只作事实依据，不要整段照抄）：")
            sb.append(byteSafePrefix(context, 9000))
            sb.append("\n")
        }
        sb.append("现在直接输出完整 JSON。")
        return sb.toString()
    }

    func generateOutline(request: JsonObject, context: String, shouldAbort: () -> Bool): JsonObject {
        let settings = store.load()
        if (settings.chatModelId.size == 0) { throw Exception("请先在设置中配置对话模型") }
        let cfg = match (settings.findModel(settings.chatModelId)) {
            case Some(v) => v
            case None => throw Exception("找不到对话模型配置")
        }
        if (shouldAbort()) { throw Exception("已取消PPT生成") }
        let client = LlmClient(cfg)
        client.shouldAbort = shouldAbort
        let system = "你是 ITN 的资深课程设计师与演示文稿信息架构师。先建立叙事，再选择最适合信息的页面类型；内容必须来自资料和当前上下文，不能编造。"
        let prompt = outlinePrompt(request, context)
        var reply = client.chat(system, prompt)
        var outline = match (jsonObjectFromModel(reply)) {
            case Some(v) => v
            case None => JsonObject()
        }
        if (!presentationOutlineUsable(outline, intOf(request, "slideCount"))) {
            // 一次明确的结构化修复请求，避免模型只返回封面或输出半截。
            let target = intOf(request, "slideCount")
            let fix = "上一次输出不是可用JSON提纲。请只返回根节点为 {title,subtitle,slides} 的完整JSON；slides 必须恰好有 " + target.toString() + " 页，每页必须有 title、kind、points、speakerNotes，字段按原要求填写。上一次输出：\n" + byteSafePrefix(reply, 12000)
            reply = client.chat(system, fix)
            outline = match (jsonObjectFromModel(reply)) {
                case Some(v) => v
                case None => throw Exception("模型没有返回可解析的PPT提纲")
            }
        }
        if (!presentationOutlineUsable(outline, intOf(request, "slideCount"))) { throw Exception("模型返回的PPT提纲不完整，请重试") }
        if (presentationText(outline, "title").size == 0) { outline.put("title", JsonString(presentationText(request, "title"))) }
        if (presentationText(outline, "subtitle").size == 0) { outline.put("subtitle", JsonString("核心概念、关键方法与实践应用")) }
        return outline
    }

    public func generate(args: JsonObject, userText: String, sid: String, tid: String, shouldAbort: () -> Bool): JsonObject {
        var requirement = trimStr(presentationText(args, "requirement"))
        if (requirement.size == 0) {
            requirement = trimStr(presentationText(args, "title"))
        }
        if (requirement.size == 0) {
            requirement = trimStr(userText)
        }
        if (requirement.size == 0) { throw Exception("缺少PPT需求") }
        var title = trimStr(presentationText(args, "title"))
        if (title.size == 0) {
            let first = requirement.split("\n")
            title = if (first.size > 0) { byteSafePrefix(first[0], 60) } else { byteSafePrefix(requirement, 60) }
        }
        let count = chooseSlideCount(args)
        let request = requestJson(args, requirement, title, count)
        let kbId = trimStr(presentationText(args, "kbId"))
        let context = LearningStore(store.dataDir).context(kbId).toString()
        let outline = generateOutline(request, context, shouldAbort)
        if (shouldAbort()) { throw Exception("已取消PPT生成") }
        let result = DesktopJobs(store.dataDir).renderPresentationWithPython(request, outline, sid, tid)
        result.put("title", JsonString(title))
        result.put("kind", JsonString("pptx"))
        result.put("outline", outline)
        result.put("request", request)
        return result
    }
}
