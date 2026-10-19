package itn_desktop_core.agent

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.Store
import itn_desktop_core.resource.ResourceRequest
import itn_desktop_core.resource.ResourceResult
import itn_desktop_core.resource.retrieveHits
import itn_desktop_core.resource.contextFromHits
import itn_desktop_core.resource.citationsFromHits
import itn_desktop_core.resource.normalizeCount
import itn_desktop_core.resource.normalizePptTeachingMoments
import itn_desktop_core.util.*

/*
 * PPT 学习资源适配层。
 *
 * 这里不重新发明 PPT 生成器：仓颉只负责把思维导图节点范围、检索证据和学习上下文
 * 交给 PresentationAgent，随后读取渲染器归一化后的 outline。真实 .pptx 是唯一文件
 * 真相；content.slides 只是供导学、索引和无桌面预览时使用的页级镜像。
 */

func pptObject(v: JsonValue): JsonObject {
    return objOf(v).getOrDefault({ => JsonObject() })
}

func pptArray(o: JsonObject, key: String): JsonArray {
    return match (o.get(key)) {
        case Some(v) => arrOf(v).getOrDefault({ => JsonArray() })
        case None => JsonArray()
    }
}

func pptText(v: JsonValue): String {
    return strValue(v)
}

func pptEvent(index: Int64, name: String): JsonObject {
    let o = JsonObject()
    o.put("index", JsonInt(index))
    o.put("name", JsonString(name))
    return o
}

func pptEnd(ok: Bool, message: String): JsonObject {
    let o = JsonObject()
    o.put("ok", JsonBool(ok))
    o.put("message", JsonString(message))
    return o
}

func pptNode(target: JsonObject): JsonObject {
    return match (target.get("node")) {
        case Some(v) => pptObject(v)
        case None => JsonObject()
    }
}

func pptEvidenceQuery(req: ResourceRequest): String {
    let node = pptNode(req.courseTarget)
    let sb = StringBuilder()
    sb.append(req.topic)
    let title = strOf(node, "title")
    let description = strOf(node, "description")
    if (title.size > 0 && title != req.topic) {
        sb.append(" ")
        sb.append(title)
    }
    if (description.size > 0) {
        sb.append(" ")
        sb.append(description)
    }
    let sources = pptArray(node, "sources")
    var i = 0
    while (i < sources.size()) {
        sb.append(" ")
        sb.append(pptText(sources[i]))
        i += 1
    }
    if (req.revision.size > 0) {
        sb.append(" ")
        sb.append(byteSafePrefix(req.revision, 1200))
    }
    return sb.toString()
}

func pptContext(req: ResourceRequest, hits: JsonArray): String {
    let sb = StringBuilder()
    sb.append("学习上下文（目标与偏好只影响讲法，不作为资料事实）：\n")
    sb.append(byteSafePrefix(req.learningContext, 6000))
    sb.append("\n\n")
    let node = pptNode(req.courseTarget)
    if (strOf(node, "id").size > 0 || strOf(node, "title").size > 0) {
        sb.append("本次只围绕思维导图节点范围生成：\n")
        sb.append("节点标题：")
        sb.append(strOf(node, "title"))
        sb.append("\n节点说明：")
        sb.append(strOf(node, "description"))
        sb.append("\n节点来源清单：")
        sb.append(pptArray(node, "sources").toString())
        sb.append("\n\n")
    }
    sb.append("知识库原文证据（带 [n] 编号）：\n")
    sb.append(contextFromHits(hits))
    if (req.revision.size > 0) {
        sb.append("\n\n本轮修改要求：\n")
        sb.append(byteSafePrefix(req.revision, 5000))
    }
    return byteSafePrefix(sb.toString(), 18000)
}

func pptBullets(slide: JsonObject): JsonArray {
    let out = JsonArray()
    let points = pptArray(slide, "points")
    var i = 0
    while (i < points.size()) {
        let point = pptObject(points[i])
        let heading = trimStr(strOf(point, "heading"))
        let detail = trimStr(strOf(point, "detail"))
        let text = if (heading.size > 0 && detail.size > 0) {
            heading + "：" + detail
        } else if (detail.size > 0) {
            detail
        } else {
            heading
        }
        if (text.size > 0) {
            out.add(JsonString(text))
        }
        i += 1
    }
    if (out.size() == 0) {
        let process = pptArray(slide, "process")
        i = 0
        while (i < process.size()) {
            let item = pptObject(process[i])
            let label = trimStr(strOf(item, "label"))
            let detail = trimStr(strOf(item, "detail"))
            if (label.size > 0 || detail.size > 0) {
                out.add(JsonString(if (label.size > 0) { label + "：" + detail } else { detail }))
            }
            i += 1
        }
    }
    return out
}

func pptSlideBody(slide: JsonObject): String {
    let sb = StringBuilder()
    let code = pptObject(match (slide.get("code")) {
        case Some(v) => v
        case None => JsonNull()
    })
    if (strOf(code, "content").size > 0) {
        let lang = trimStr(strOf(code, "language"))
        sb.append("```")
        sb.append(lang)
        sb.append("\n")
        sb.append(strOf(code, "content"))
        sb.append("\n```")
    }
    let table = pptObject(match (slide.get("table")) {
        case Some(v) => v
        case None => JsonNull()
    })
    let headers = pptArray(table, "headers")
    if (headers.size() > 0) {
        if (sb.toString().size > 0) { sb.append("\n\n") }
        sb.append("| ")
        var i = 0
        while (i < headers.size()) {
            if (i > 0) { sb.append(" | ") }
            sb.append(pptText(headers[i]))
            i += 1
        }
        sb.append(" |\n|")
        i = 0
        while (i < headers.size()) {
            sb.append(" --- |")
            i += 1
        }
        let rows = pptArray(table, "rows")
        var ri = 0
        while (ri < rows.size()) {
            let row = match (rows[ri]) {
                case a: JsonArray => a
                case _ => JsonArray()
            }
            sb.append("\n| ")
            i = 0
            while (i < row.size()) {
                if (i > 0) { sb.append(" | ") }
                sb.append(pptText(row[i]))
                i += 1
            }
            sb.append(" |")
            ri += 1
        }
    }
    return sb.toString()
}

func pptContentFromDesign(path: String, fallbackTitle: String, rendered: Int64): JsonObject {
    let raw = readTextOr(path, "")
    if (raw.size == 0) {
        throw Exception("PPT设计快照不存在：" + path)
    }
    let root = match (JsonValue.fromStr(raw)) {
        case o: JsonObject => o
        case _ => throw Exception("PPT设计快照不是JSON对象")
    }
    let outline = pptObject(match (root.get("outline")) {
        case Some(v) => v
        case None => JsonObject()
    })
    let source = pptArray(outline, "slides")
    let slides = JsonArray()
    var i = 0
    while (i < source.size()) {
        let item = pptObject(source[i])
        let slide = JsonObject()
        slide.put("title", JsonString(strOf(item, "title")))
        slide.put("kind", JsonString(if (strOf(item, "kind").size > 0) { strOf(item, "kind") } else { "content" }))
        slide.put("bullets", pptBullets(item))
        slide.put("body", JsonString(pptSlideBody(item)))
        slide.put("speakerNote", JsonString(strOf(item, "speakerNotes")))
        slide.put("eyebrow", JsonString(if (strOf(item, "kind") == "section") { "章节" } else { "" }))
        slide.put("teachingMoments", pptArray(item, "teachingMoments"))
        slides.add(slide)
        i += 1
    }
    let content = JsonObject()
    content.put("title", JsonString(if (strOf(outline, "title").size > 0) { strOf(outline, "title") } else { fallbackTitle }))
    content.put("subtitle", JsonString(strOf(outline, "subtitle")))
    content.put("slides", slides)
    content.put("renderedSlides", JsonInt(rendered))
    return content
}

func pptMarkdown(title: String, content: JsonObject): String {
    let sb = StringBuilder()
    sb.append("# ")
    sb.append(title)
    sb.append("\n\n")
    let slides = pptArray(content, "slides")
    var i = 0
    while (i < slides.size()) {
        let slide = pptObject(slides[i])
        sb.append("## ")
        sb.append((i + 1).toString())
        sb.append(". ")
        sb.append(strOf(slide, "title"))
        sb.append("\n\n")
        let bullets = pptArray(slide, "bullets")
        var j = 0
        while (j < bullets.size()) {
            sb.append("- ")
            sb.append(pptText(bullets[j]))
            sb.append("\n")
            j += 1
        }
        let body = strOf(slide, "body")
        if (body.size > 0) {
            sb.append("\n")
            sb.append(body)
            sb.append("\n")
        }
        sb.append("\n")
        i += 1
    }
    return sb.toString()
}

func pptFileName(path: String): String {
    let parts = path.replace("\\", "/").split("/")
    return if (parts.size > 0) { parts[parts.size - 1] } else { path }
}

public func generatePptLearningResource(store: Store, req: ResourceRequest, shouldAbort: () -> Bool,
    emit: (String, JsonObject) -> Unit): ResourceResult {
    let res = ResourceResult()
    res.kind = "ppt"
    res.format = "pptx"
    res.title = req.topic
    if (shouldAbort()) {
        res.ok = false
        res.message = "已取消"
        emit("turn/end", pptEnd(false, res.message))
        return res
    }
    emit("step/start", pptEvent(1, "retrieve"))
    let query = pptEvidenceQuery(req)
    let hits = if (req.sourceSnapshots.size() > 0) {
        req.sourceSnapshots
    } else {
        retrieveHits(store, req.kbId, query, 14, shouldAbort)
    }
    emit("step/end", pptEvent(1, "retrieve"))
    if (hits.size() == 0) {
        res.warnings.add("这次没有检索到节点范围的原文切片：PPT 会依据节点说明和通用框架生成，出处可能为空")
    }
    let context = pptContext(req, hits)
    let args = JsonObject()
    let requirement = if (req.revision.size > 0) { req.topic + "\n修改要求：" + req.revision } else { req.topic }
    let selectedCount = if (req.count > 0) {
        req.count
    } else if (req.detail == "concise") {
        10
    } else if (req.detail == "detailed") {
        18
    } else {
        12
    }
    // PPT 提纲固定包含封面、目录和总结，至少需要 4 个输入页；章节页由渲染器补充。
    let requested = normalizeCount("ppt", selectedCount)
    args.put("requirement", JsonString(requirement))
    args.put("title", JsonString(req.topic))
    args.put("kbId", JsonString(req.kbId))
    args.put("context", JsonString(context))
    args.put("slideCount", JsonInt(requested))
    args.put("detailLevel", JsonString(if (req.detail.size > 0) { req.detail } else { "balanced" }))
    for (key in ["audience", "purpose", "style", "backgroundStyle", "language", "aspectRatio"]) {
        match (req.presentation.get(key)) {
            case Some(v) => args.put(key, v)
            case None => ()
        }
    }
    emit("step/start", pptEvent(2, "outline"))
    let rendered = try {
        PresentationAgent(store).generate(args, requirement, "", "", shouldAbort)
    } catch (e: Exception) {
        res.ok = false
        res.message = byteSafePrefix(e.message, 1600)
        emit("turn/end", pptEnd(false, res.message))
        return res
    }
    emit("step/end", pptEvent(2, "outline"))
    if (!boolOf(rendered, "ok")) {
        res.ok = false
        res.message = "PPT渲染失败：" + byteSafePrefix(strOf(rendered, "error"), 1200)
        emit("turn/end", pptEnd(false, res.message))
        return res
    }
    res.artifactPath = strOf(rendered, "path")
    res.previewPath = strOf(rendered, "previewPath")
    res.designPath = strOf(rendered, "designPath")
    res.artifactName = pptFileName(res.artifactPath)
    res.requestedSlides = if (intOf(rendered, "requestedSlides") > 0) { intOf(rendered, "requestedSlides") } else { requested }
    res.renderedSlides = if (intOf(rendered, "renderedSlides") > 0) { intOf(rendered, "renderedSlides") } else { intOf(rendered, "slides") }
    res.title = strOf(rendered, "title")
    if (res.title.size == 0) { res.title = req.topic }
    let content = pptContentFromDesign(res.designPath, res.title, res.renderedSlides)
    normalizePptTeachingMoments(content, res.warnings)
    res.content = content
    res.citations = citationsFromHits(hits)
    res.markdown = pptMarkdown(res.title, content)
    let quality = JsonObject()
    quality.put("kind", JsonString("ppt"))
    quality.put("issues", JsonArray())
    quality.put("repairRounds", JsonInt(0))
    quality.put("sources", JsonInt(hits.size()))
    quality.put("fallback", JsonBool(false))
    quality.put("bodyChars", JsonInt(res.markdown.size))
    quality.put("requestedSlides", JsonInt(res.requestedSlides))
    quality.put("renderedSlides", JsonInt(res.renderedSlides))
    quality.put("format", JsonString("pptx"))
    res.quality = quality
    res.message = "已生成真实PPTX和导学预览（" + res.renderedSlides.toString() + " 页，" + hits.size().toString() + " 条资料依据）"
    let validation = JsonObject()
    validation.put("kind", JsonString("ppt"))
    validation.put("report", quality)
    validation.put("citations", res.citations)
    emit("validation", validation)
    emit("turn/end", pptEnd(true, res.message))
    return res
}
