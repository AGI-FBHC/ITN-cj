package itn_desktop_core.guided

import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.kb.stamp
import itn_desktop_core.learning.*
import itn_desktop_core.session.SessionStore
import itn_desktop_core.study.intValue
import itn_desktop_core.study.StudyNote
import itn_desktop_core.study.StudyStore
import itn_desktop_core.util.*

/*
 * 交互导学侧栏的宿主状态。
 *
 * 这里不运行模型，也不相信前端传来的“当前页正文”。资源、页码、教学检查点
 * 每次都从 LearningStore 的确认版本重新读取；会话与资源版本之间的绑定放在
 * sessions_meta。导学会话同时属于普通对话列表，并带 resource 标签；学习页按
 * 资源版本筛出这些会话，记住最近一次选择，并在重启后恢复。
 */

func objectOf(v: JsonValue): JsonObject {
    match (objOf(v)) {
        case Some(o) => return o
        case None => return JsonObject()
    }
}

func objectField(o: JsonObject, key: String): JsonObject {
    match (o.get(key)) {
        case Some(v) => return objectOf(v)
        case None => return JsonObject()
    }
}

func fieldOrDefault(o: JsonObject, key: String, fallback: JsonValue): JsonValue {
    match (o.get(key)) {
        case Some(v) => return v
        case None => return fallback
    }
}

func intArrayHas(a: JsonArray, value: Int64): Bool {
    var i = 0
    while (i < a.size()) {
        if (intValue(a[i]) == value) {
            return true
        }
        i += 1
    }
    return false
}

func addIntOnce(a: JsonArray, value: Int64): Unit {
    if (!intArrayHas(a, value)) {
        a.add(JsonInt(value))
    }
}

func textArray(a: JsonArray): ArrayList<String> {
    let out = ArrayList<String>()
    var i = 0
    while (i < a.size()) {
        let s = strValue(a[i])
        if (s.size > 0) {
            out.add(s)
        }
        i += 1
    }
    return out
}

func momentById(store: LearningStore, resource: JsonObject, momentId: String): JsonObject {
    let content = objectField(resource, "content")
    let slides = arrOf(content, "slides")
    var i = 0
    while (i < slides.size()) {
        let slide = objectOf(slides[i])
        let moments = arrOf(slide, "teachingMoments")
        var j = 0
        while (j < moments.size()) {
            let m = objectOf(moments[j])
            if (strOf(m, "momentId") == momentId) {
                return m
            }
            j += 1
        }
        i += 1
    }
    throw Exception("教学检查点不存在：" + momentId)
}

public class GuidedStore {
    public let dataDir: String

    public init(dataDir: String) {
        this.dataDir = dataDir
    }

    private func db(): Db {
        return DbHub.open(dataDir)
    }

    private func guidedKey(resourceId: String, version: Int64): String {
        return "guided-session:" + resourceId + ":v" + version.toString()
    }

    private func resourceOf(resourceId: String, version: Int64): JsonObject {
        if (resourceId.size == 0) {
            throw Exception("缺少资源编号")
        }
        let res = LearningStore(dataDir).resource(resourceId, version)
        if (strOf(res, "kind") != "ppt") {
            throw Exception("只有 PPT 演示资源可以开启交互导学")
        }
        let slides = arrOf(objectField(res, "content"), "slides")
        if (slides.size() == 0) {
            throw Exception("这份演示没有可导学的页面")
        }
        return res
    }

    private func bindingOf(sessionId: String): JsonObject {
        if (sessionId.size == 0) {
            throw Exception("缺少导学会话编号")
        }
        let raw = db().getKv("sessions_meta", "guided:" + sessionId, "")
        if (raw.size == 0) {
            throw Exception("这不是一个导学会话")
        }
        return objectOf(JsonValue.fromStr(raw))
    }

    private func putBinding(sessionId: String, binding: JsonObject): Unit {
        binding.put("updatedAt", JsonString(stamp()))
        db().putKv("sessions_meta", "guided:" + sessionId, binding.toString())
    }

    private func metaObject(raw: String): JsonObject {
        if (raw.size == 0) { return JsonObject() }
        try { return objectOf(JsonValue.fromStr(raw)) } catch (e: Exception) { return JsonObject() }
    }

    private func resourceMetaOf(sessionId: String): JsonObject {
        return metaObject(db().getKv("sessions_meta", "resource:" + sessionId, ""))
    }

    private func putResourceMeta(sessionId: String, resource: JsonObject, version: Int64): Unit {
        let meta = JsonObject()
        meta.put("resourceId", JsonString(strOf(resource, "id")))
        meta.put("resourceVersion", JsonInt(version))
        meta.put("resourceTitle", JsonString(strOf(resource, "title")))
        db().putKv("sessions_meta", "resource:" + sessionId, meta.toString())
    }

    private func matchesResource(sessionId: String, resourceId: String, version: Int64): Bool {
        let meta = resourceMetaOf(sessionId)
        return strOf(meta, "resourceId") == resourceId && intOf(meta, "resourceVersion") == version &&
            isGuided(sessionId)
    }

    private func selectSession(resourceId: String, version: Int64, sessionId: String): Unit {
        db().putKv("meta", guidedKey(resourceId, version), sessionId)
    }

    private func latestResourceSession(resourceId: String, version: Int64): String {
        let dbh = db()
        var latest = ""
        var latestAt = ""
        for (r in dbh.querySql("SELECT k, v FROM sessions_meta")) {
            let key = r.text(0)
            if (hasPrefix(key, "resource:")) {
                let sid = key.replace("resource:", "")
                if (matchesResource(sid, resourceId, version)) {
                    match (dbh.one("SELECT updated_at FROM sessions WHERE id = ?", va([tv(sid)]))) {
                        case Some(row) =>
                            let at = row.text(0)
                            if (latestAt.size == 0 || at > latestAt) { latest = sid; latestAt = at }
                        case None => ()
                    }
                }
            }
        }
        return latest
    }

    private func createResourceSession(resourceId: String, resource: JsonObject, version: Int64, slideIn: Int64): String {
        let sessions = SessionStore(dataDir)
        let sessionId = sessions.newId()
        let now = stamp()
        db().run(
            "INSERT OR IGNORE INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)",
            va([tv(sessionId), tv(now), tv(now)])
        )
        let count = arrOf(objectField(resource, "content"), "slides").size()
        var slide = if (slideIn > 0) { slideIn } else { 1 }
        if (slide > count) { slide = count }
        let binding = JsonObject()
        binding.put("sessionId", JsonString(sessionId))
        binding.put("resourceId", JsonString(resourceId))
        binding.put("version", JsonInt(version))
        binding.put("kbId", JsonString(strOf(resource, "kbId")))
        binding.put("title", JsonString(strOf(resource, "title")))
        binding.put("slide", JsonInt(slide))
        binding.put("slideCount", JsonInt(count))
        binding.put("visitedSlides", JsonArray())
        binding.put("answeredCheckpoints", JsonObject())
        binding.put("createdAt", JsonString(now))
        putBinding(sessionId, binding)
        putResourceMeta(sessionId, resource, version)
        var total = 0
        for (r in db().querySql("SELECT k, v FROM sessions_meta")) {
            let key = r.text(0)
            if (hasPrefix(key, "resource:")) {
                let meta = metaObject(r.text(1))
                if (strOf(meta, "resourceId") == resourceId && intOf(meta, "resourceVersion") == version) { total += 1 }
            }
        }
        let suffix = if (total > 1) { " · " + total.toString() } else { "" }
        db().putKv("sessions_meta", "title:" + sessionId, "导学 · " + strOf(resource, "title") + suffix)
        selectSession(resourceId, version, sessionId)
        return sessionId
    }

    private func resolvedOutput(resource: JsonObject, resourceId: String, version: Int64, sessionId: String,
        createdNow: Bool): JsonObject {
        let binding = bindingOf(sessionId)
        let content = objectField(resource, "content")
        let count = arrOf(content, "slides").size()
        binding.put("resourceId", JsonString(resourceId))
        binding.put("version", JsonInt(version))
        binding.put("kbId", JsonString(strOf(resource, "kbId")))
        binding.put("title", JsonString(strOf(resource, "title")))
        binding.put("slideCount", JsonInt(count))
        var slide = intOf(binding, "slide")
        if (slide < 1) { slide = 1 }
        if (slide > count) { slide = count }
        binding.put("slide", JsonInt(slide))
        let visited = arrOf(binding, "visitedSlides")
        addIntOnce(visited, slide)
        binding.put("visitedSlides", visited)
        putBinding(sessionId, binding)
        putResourceMeta(sessionId, resource, version)
        let out = JsonObject()
        out.put("sessionId", JsonString(sessionId))
        out.put("resourceId", JsonString(resourceId))
        out.put("version", JsonInt(version))
        out.put("title", JsonString(strOf(resource, "title")))
        out.put("slide", JsonInt(slide))
        out.put("slideCount", JsonInt(count))
        out.put("created", JsonBool(createdNow))
        out.put("context", context(sessionId))
        return out
    }

    private func slideAt(content: JsonObject, index: Int64): JsonObject {
        let slides = arrOf(content, "slides")
        if (index < 0 || index >= slides.size()) {
            return JsonObject()
        }
        return objectOf(slides[index])
    }

    /** 给模型看的幻灯片副本：绝不下发选择题答案和解析。 */
    private func safeSlide(source: JsonObject): JsonObject {
        let out = JsonObject()
        for (key in ["title", "eyebrow", "kind", "bullets", "body", "speakerNote"]) {
            match (source.get(key)) {
                case Some(v) => out.put(key, v)
                case None => ()
            }
        }
        let moments = JsonArray()
        let rawMoments = arrOf(source, "teachingMoments")
        var mi = 0
        while (mi < rawMoments.size()) {
            let m = objectOf(rawMoments[mi])
            let safe = JsonObject()
            for (key in ["momentId", "type", "title", "prompt", "options", "points", "notePrompt", "anchorText"]) {
                match (m.get(key)) {
                    case Some(v) => safe.put(key, v)
                    case None => ()
                }
            }
            moments.add(safe)
            mi += 1
        }
        out.put("teachingMoments", moments)
        return out
    }

    /** 导学 Agent 的只读上下文。答案索引、正确答案和解析在这一层剥离。 */
    public func agentContext(sessionId: String): JsonObject {
        let full = context(sessionId)
        let safe = JsonObject()
        for (key in ["sessionId", "resourceId", "version", "kbId", "title", "slideCount", "currentSlide",
            "visitedSlides", "answeredCheckpoints"]) {
            match (full.get(key)) {
                case Some(v) => safe.put(key, v)
                case None => ()
            }
        }
        match (full.get("currentSlideContent")) {
            case Some(v) => safe.put("currentSlideContent", safeSlide(objectOf(v)))
            case None => safe.put("currentSlideContent", JsonNull())
        }
        match (full.get("previousSlide")) {
            case Some(v) => safe.put("previousSlide", safeSlide(objectOf(v)))
            case None => safe.put("previousSlide", JsonNull())
        }
        match (full.get("nextSlide")) {
            case Some(v) => safe.put("nextSlide", safeSlide(objectOf(v)))
            case None => safe.put("nextSlide", JsonNull())
        }
        let safeMoments = JsonArray()
        let rawMoments = arrOf(full, "teachingMoments")
        var mi = 0
        while (mi < rawMoments.size()) {
            let m = objectOf(rawMoments[mi])
            let entry = JsonObject()
            for (key in ["momentId", "type", "title", "prompt", "options", "points", "notePrompt", "anchorText", "slide"]) {
                match (m.get(key)) {
                    case Some(v) => entry.put(key, v)
                    case None => ()
                }
            }
            safeMoments.add(entry)
            mi += 1
        }
        safe.put("teachingMoments", safeMoments)
        safe.put("outline", fieldOrDefault(full, "outline", JsonArray()))
        return safe
    }

    public func isGuided(sessionId: String): Bool {
        if (sessionId.size == 0) {
            return false
        }
        return db().getKv("sessions_meta", "guided:" + sessionId, "").size > 0 ||
            db().getKv("sessions_meta", "resource:" + sessionId, "").size > 0
    }

    public func resolve(resourceId: String, versionIn: Int64): JsonObject {
        let resource = resourceOf(resourceId, versionIn)
        let version = intOf(resource, "version")
        let key = guidedKey(resourceId, version)
        var sessionId = db().getKv("meta", key, "")
        var createdNow = false
        if (sessionId.size == 0 || !matchesResource(sessionId, resourceId, version)) {
            sessionId = latestResourceSession(resourceId, version)
        }
        if (sessionId.size == 0) {
            createdNow = true
            sessionId = createResourceSession(resourceId, resource, version, 1)
        } else {
            selectSession(resourceId, version, sessionId)
        }
        return resolvedOutput(resource, resourceId, version, sessionId, createdNow)
    }

    public func sessions(resourceId: String, versionIn: Int64): JsonArray {
        let resource = resourceOf(resourceId, versionIn)
        let version = intOf(resource, "version")
        let out = JsonArray()
        let dbh = db()
        for (r in dbh.querySql("SELECT id FROM sessions ORDER BY updated_at DESC")) {
            let sid = r.text(0)
            if (matchesResource(sid, resourceId, version)) {
                let summary = SessionStore(dataDir).summary(sid)
                summary.put("resource", resourceMetaOf(sid))
                out.add(summary)
            }
        }
        return out
    }

    public func createSession(resourceId: String, versionIn: Int64, slideIn: Int64): JsonObject {
        let resource = resourceOf(resourceId, versionIn)
        let version = intOf(resource, "version")
        let sessionId = createResourceSession(resourceId, resource, version, slideIn)
        return resolvedOutput(resource, resourceId, version, sessionId, true)
    }

    public func select(resourceId: String, versionIn: Int64, sessionId: String): JsonObject {
        let resource = resourceOf(resourceId, versionIn)
        let version = intOf(resource, "version")
        if (!matchesResource(sessionId, resourceId, version)) {
            throw Exception("这个会话不属于当前演示")
        }
        selectSession(resourceId, version, sessionId)
        return resolvedOutput(resource, resourceId, version, sessionId, false)
    }

    public func focus(sessionId: String, slideIn: Int64): JsonObject {
        let binding = bindingOf(sessionId)
        let resource = resourceOf(strOf(binding, "resourceId"), intOf(binding, "version"))
        let slides = arrOf(objectField(resource, "content"), "slides")
        var slide = slideIn
        if (slide < 1) {
            slide = 1
        }
        if (slide > slides.size()) {
            slide = slides.size()
        }
        binding.put("slide", JsonInt(slide))
        let visited = arrOf(binding, "visitedSlides")
        addIntOnce(visited, slide)
        binding.put("visitedSlides", visited)
        putBinding(sessionId, binding)
        return context(sessionId)
    }

    public func context(sessionId: String): JsonObject {
        let binding = bindingOf(sessionId)
        let resource = resourceOf(strOf(binding, "resourceId"), intOf(binding, "version"))
        let content = objectField(resource, "content")
        let slides = arrOf(content, "slides")
        let count = slides.size()
        var slide = intOf(binding, "slide")
        if (slide < 1) {
            slide = 1
        }
        if (slide > count) {
            slide = count
        }
        let current = slideAt(content, slide - 1)
        let previous = if (slide > 1) { slides[slide - 2] } else { JsonNull() }
        let next = if (slide < count) { slides[slide] } else { JsonNull() }
        let outline = JsonArray()
        var i = 0
        while (i < slides.size()) {
            let s = objectOf(slides[i])
            let item = JsonObject()
            item.put("slide", JsonInt(i + 1))
            item.put("title", JsonString(strOf(s, "title")))
            item.put("kind", JsonString(strOf(s, "kind")))
            outline.add(item)
            i += 1
        }
        let moments = JsonArray()
        i = 0
        while (i < slides.size()) {
            let s = objectOf(slides[i])
            let local = arrOf(s, "teachingMoments")
            var j = 0
            while (j < local.size()) {
                let source = objectOf(local[j])
                let m = JsonObject()
                for (key in ["momentId", "type", "title", "prompt", "options", "answerIndex", "explanation",
                    "points", "notePrompt", "anchorText"]) {
                    match (source.get(key)) {
                        case Some(v) => m.put(key, v)
                        case None => ()
                    }
                }
                m.put("slide", JsonInt(i + 1))
                moments.add(m)
                j += 1
            }
            i += 1
        }
        let out = JsonObject()
        out.put("sessionId", JsonString(sessionId))
        out.put("resourceId", JsonString(strOf(binding, "resourceId")))
        out.put("version", JsonInt(intOf(binding, "version")))
        out.put("kbId", JsonString(strOf(resource, "kbId")))
        out.put("title", JsonString(strOf(resource, "title")))
        out.put("slideCount", JsonInt(count))
        out.put("currentSlide", JsonInt(slide))
        out.put("currentSlideContent", current)
        out.put("previousSlide", previous)
        out.put("nextSlide", next)
        out.put("outline", outline)
        out.put("teachingMoments", moments)
        out.put("visitedSlides", fieldOrDefault(binding, "visitedSlides", JsonArray()))
        out.put("answeredCheckpoints", fieldOrDefault(binding, "answeredCheckpoints", JsonObject()))
        return out
    }

    public func checkpoint(sessionId: String, momentId: String, answerIndex: Int64): JsonObject {
        if (momentId.size == 0) {
            throw Exception("缺少检查点编号")
        }
        if (answerIndex < 0 || answerIndex > 3) {
            throw Exception("答案选项无效")
        }
        let binding = bindingOf(sessionId)
        let resource = resourceOf(strOf(binding, "resourceId"), intOf(binding, "version"))
        let content = objectField(resource, "content")
        let moment = momentById(LearningStore(dataDir), resource, momentId)
        if (strOf(moment, "type") != "quiz") {
            throw Exception("这个检查点不是选择题")
        }
        let options = arrOf(moment, "options")
        if (options.size() != 4 || answerIndex >= options.size()) {
            throw Exception("检查点选项结构不完整")
        }
        let key = "guided-checkpoint:" + sessionId + ":" + momentId
        let old = db().getKv("meta", key, "")
        if (old.size > 0) {
            let repeated = objectOf(JsonValue.fromStr(old))
            repeated.put("repeated", JsonBool(true))
            return repeated
        }
        let correctIndex = intOf(moment, "answerIndex")
        let correct = answerIndex == correctIndex
        let result = JsonObject()
        result.put("momentId", JsonString(momentId))
        result.put("answerIndex", JsonInt(answerIndex))
        result.put("optionText", JsonString(strValue(options[answerIndex])))
        result.put("correct", JsonBool(correct))
        result.put("correctIndex", JsonInt(correctIndex))
        result.put("correctText", JsonString(strValue(options[correctIndex])))
        result.put("explanation", JsonString(strOf(moment, "explanation")))
        result.put("firstAttempt", JsonBool(true))
        result.put("repeated", JsonBool(false))
        db().putKv("meta", key, result.toString())
        let answered = objectField(binding, "answeredCheckpoints")
        answered.put(momentId, result)
        binding.put("answeredCheckpoints", answered)
        putBinding(sessionId, binding)
        let event = JsonObject()
        event.put("resourceId", JsonString(strOf(binding, "resourceId")))
        event.put("version", JsonInt(intOf(binding, "version")))
        event.put("momentId", JsonString(momentId))
        event.put("answerIndex", JsonInt(answerIndex))
        event.put("correct", JsonBool(correct))
        event.put("correctIndex", JsonInt(correctIndex))
        let topic = strOf(moment, "title")
        db().run(
            "INSERT INTO learning_events (id, kind, kb_id, resource_id, version, item_key, topic, correct, first_attempt, payload, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
            va([tv("guided-" + stamp()), tv("guided-checkpoint"), tv(strOf(resource, "kbId")),
                tv(strOf(binding, "resourceId")), nv(intOf(binding, "version")), tv(momentId), tv(topic),
                nv(if (correct) { 1 } else { 0 }), tv(event.toString()), tv(stamp())])
        )
        return result
    }

    public func moment(sessionId: String, momentId: String): JsonObject {
        let binding = bindingOf(sessionId)
        let resource = resourceOf(strOf(binding, "resourceId"), intOf(binding, "version"))
        return momentById(LearningStore(dataDir), resource, momentId)
    }

    public func saveNote(sessionId: String, titleIn: String, text: String, sourceQuote: String): JsonObject {
        if (trimStr(text).size == 0) {
            throw Exception("笔记内容不能为空")
        }
        if (text.size > 12000) {
            throw Exception("笔记内容不能超过 12000 字节")
        }
        let binding = bindingOf(sessionId)
        let resource = resourceOf(strOf(binding, "resourceId"), intOf(binding, "version"))
        let slide = intOf(binding, "slide")
        let current = slideAt(objectField(resource, "content"), slide - 1)
        let slideTitle = strOf(current, "title")
        let title = if (trimStr(titleIn).size > 0) { trimStr(titleIn) } else { "第 " + slide.toString() + " 页 · " + slideTitle }
        let ss = StudyStore(dataDir)
        let data = ss.load()
        let note = StudyNote()
        note.id = "n" + stamp() + data.notes.size.toString()
        note.kbId = strOf(resource, "kbId")
        note.chapter = slideTitle
        note.title = title
        note.text = text
        note.createdAt = stamp()
        note.updatedAt = stamp()
        note.resourceId = strOf(binding, "resourceId")
        note.resourceVersion = intOf(binding, "version")
        note.page = slide
        note.slideTitle = slideTitle
        note.sourceQuote = sourceQuote
        data.notes.add(note)
        ss.save(data)
        ss.saveNoteMeta(note)
        return note.toJson()
    }

    public func open(sessionId: String): JsonObject {
        let binding = bindingOf(sessionId)
        let out = JsonObject()
        out.put("sessionId", JsonString(sessionId))
        out.put("resourceId", JsonString(strOf(binding, "resourceId")))
        out.put("version", JsonInt(intOf(binding, "version")))
        out.put("href", JsonString("#/study/" + strOf(binding, "resourceId") + "@" + intOf(binding, "version").toString()))
        return out
    }
}
