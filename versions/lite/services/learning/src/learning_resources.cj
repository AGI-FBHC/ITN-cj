package zhixun_learning

import std.collection.*
import std.core.*
import std.fs.*
import stdx.encoding.json.*

/** Preserve validated JSON strings verbatim; stdx serialization can lose escapes. */
func lrContainer(raw: String, key: String, opening: Byte, closing: Byte): String {
    let marker = "\"" + key + "\""
    let found = raw.indexOf(marker)
    if (found == None) { return "" }
    let bytes = raw.toArray()
    var start = found.getOrThrow() + marker.size
    while (start < bytes.size && (bytes[start] == 32 || bytes[start] == 9 || bytes[start] == 10 || bytes[start] == 13)) { start += 1 }
    if (start >= bytes.size || bytes[start] != 58) { return "" }
    start += 1
    while (start < bytes.size && (bytes[start] == 32 || bytes[start] == 9 || bytes[start] == 10 || bytes[start] == 13)) { start += 1 }
    if (start >= bytes.size || bytes[start] != opening) { return "" }
    var i = start
    var depth: Int64 = 0
    var quoted = false
    var escaped = false
    while (i < bytes.size) {
        let b = bytes[i]
        if (quoted) {
            if (escaped) { escaped = false }
            else if (b == 92) { escaped = true }
            else if (b == 34) { quoted = false }
        } else if (b == 34) { quoted = true }
        else if (b == opening) { depth += 1 }
        else if (b == closing) {
            depth -= 1
            if (depth == 0) { return raw[start..i + 1] }
        }
        i += 1
    }
    ""
}

func lrObject(raw: String, key: String): String { lrContainer(raw, key, 123, 125) }
func lrArray(raw: String, key: String): String {
    let value = lrContainer(raw, key, 91, 93)
    if (value.size > 0) { value } else { "[]" }
}
func lrMergeArrays(left: String, right: String): String {
    let a = left.trimAscii(); let b = right.trimAscii()
    if (a.size <= 2) { return b }
    if (b.size <= 2) { return a }
    a[0..a.size - 1] + "," + b[1..b.size]
}
func lrTypesJson(types: Array<String>): String {
    let out = JsonArrWriter()
    for (kind in types) { out.addRaw(jsonQuote(kind)) }
    out.toJson()
}

func lrSlidesForViewer(parsed: JsonObject): String {
    let slides = JsonArrWriter()
    for (slide in cwObjectList(parsed, "slides")) {
        let item = JsonWriter()
        item.putStr("title", cwField(slide, "title"))
        item.putStr("kind", cwField(slide, "kind"))
        item.putStr("subtitle", "课程课件")
        let bullets = JsonArrWriter()
        let oldBullets = cwStringList(slide, "bullets")
        if (oldBullets.size > 0) {
            for (bullet in oldBullets) { bullets.addRaw(jsonQuote(bullet)) }
        } else {
            for (point in cwObjectList(slide, "points")) {
                let heading = cwField(point, "heading")
                let detail = cwField(point, "detail")
                let text = if (heading.size > 0 && detail.size > 0) { heading + "：" + detail } else { heading + detail }
                if (text.size > 0) { bullets.addRaw(jsonQuote(text)) }
            }
        }
        item.putRaw("bullets", bullets.toJson())
        let notes = cwField(slide, "speakerNotes")
        item.putStr("notes", if (notes.size > 0) { notes } else { cwField(slide, "speakerNote") })
        slides.addRaw(item.toJson())
    }
    slides.toJson()
}

func lrPresentationForViewer(coursewareId: String, raw: String): String {
    let metadata = match (cwJsonObjectFrom(raw)) {
        case Some(value) => value
        case None => return raw
    }
    let designPath = "data/presentations/" + coursewareId + "/presentation.pptx.json"
    if (!exists(Path(designPath))) { return raw }
    let design = match (cwJsonObjectFrom(String.fromUtf8(File.readFrom(Path(designPath))))) {
        case Some(value) => value
        case None => return raw
    }
    let outline = match (jsonGetObject(design, "outline")) {
        case Some(value) => value
        case None => return raw
    }
    let outlineSlides = jsonGetArray(outline, "slides") ?? JsonArray()
    var noteCount: Int64 = 0
    var i: Int64 = 0
    while (i < outlineSlides.size()) {
        if (isJsObject(outlineSlides[i]) &&
            cwField(outlineSlides[i].asObject(), "speakerNotes").size > 0) {
            noteCount += 1
        }
        i += 1
    }
    let out = JsonWriter()
    out.putStr("kind", jsonGetString(metadata, "kind") ?? "pptx")
    out.putStr("downloadUrl", jsonGetString(metadata, "downloadUrl") ??
        ("/api/presentation/" + coursewareId + "/download.pptx"))
    out.putStr("previewUrl", jsonGetString(metadata, "previewUrl") ??
        ("/api/presentation/" + coursewareId + "/preview"))
    out.putInt("slideCount", outlineSlides.size())
    out.putInt("speakerNoteCount", noteCount)
    out.putStr("backgroundStyle", jsonGetString(metadata, "backgroundStyle") ?? "clean-minimal")
    out.putStr("generationMode", jsonGetString(metadata, "generationMode") ?? "template")
    out.putStr("renderer", jsonGetString(metadata, "renderer") ?? "lumin-python-pptx-v1")
    out.toJson()
}

/** Typed published payloads reuse the existing renderers, without quiz answers. */
func lrTypedResources(rows: Array<Row>): String {
    lrTypedResources(rows, "[]")
}

func lrTypedResources(rows: Array<Row>, chapterReferences: String): String {
    let lectures = JsonArrWriter(); let slides = JsonArrWriter()
    var lectureCount: Int64 = 0; var slideCount: Int64 = 0
    var presentation = ""
    var deckTitle = ""
    var deckSubtitle = ""
    var lectureReferences = "[]"
    for (resource in rows) {
        let kind = resource.text("kind")
        let raw = resource.text("content_json")
        let parsed = match (cwJsonObjectFrom(raw)) { case Some(value) => value; case None => continue }
        if (kind == "lecture") {
            let savedReferences = lrArray(raw, "references")
            let references = if (savedReferences != "[]") { savedReferences } else { chapterReferences }
            lectureReferences = references
            for (item in cwObjectList(parsed, "sections")) {
                let section = JsonWriter()
                section.putStr("id", "lecture-" + lectureCount.toString())
                section.putStr("eyebrow", "讲义")
                section.putStr("heading", cwNormalizeCoursewareCitations(cwField(item, "heading"), "[]"))
                section.putStr("text", cwNormalizeCoursewareCitations(cwField(item, "body"), references))
                lectures.addRaw(section.toJson()); lectureCount += 1
            }
        } else if (kind == "slides") {
            if (deckTitle.size == 0) { deckTitle = cwField(parsed, "title") }
            if (deckSubtitle.size == 0) { deckSubtitle = cwField(parsed, "subtitle") }
            if (presentation.size == 0) {
                presentation = lrPresentationForViewer(resource.text("id"), lrObject(raw, "presentation"))
            }
            let publicSlides = jsonArrayFromText(lrSlidesForViewer(parsed))
            var slideIndex: Int64 = 0
            while (slideIndex < publicSlides.size()) {
                slides.addRaw(publicSlides[slideIndex].toJsonString())
                slideCount += 1
                slideIndex += 1
            }
        }
    }
    let out = JsonWriter()
    if (lectureCount > 0) {
        let value = JsonWriter()
        value.putRaw("sections", lectures.toJson())
        value.putRaw("references", lectureReferences)
        value.putRaw("sources", lectureReferences)
        out.putRaw("lecture", value.toJson())
    }
    if (slideCount > 0) {
        let value = JsonWriter()
        value.putStr("title", deckTitle)
        value.putStr("subtitle", deckSubtitle)
        value.putRaw("slides", slides.toJson())
        if (presentation.size > 0) { value.putRaw("presentation", presentation) }
        out.putRaw("slides", value.toJson())
    }
    out.toJson()
}

/** Existing published lessons acquire typed resources without republishing or generation. */
func lrAdaptLesson(cfg: Config, row: Row): ?Row {
    let raw = row.text("content_json")
    let sources = jsonArrayFromText(row.text("sources_json"))
    var docId = row.text("source_doc_id")
    var managed = docId.size > 0
    if (sources.size() > 0 && isJsObject(sources[0])) {
        let source = sources[0].asObject()
        if ((jsonGetString(source, "kind") ?? "") == "kb-courseware") {
            managed = true
            if (docId.size == 0) { docId = jsonGetString(source, "id") ?? "" }
        }
    }
    var typed = ""
    var references = lrArray(raw, "references")
    if (managed) {
        let chapterReferences = cwChapterReferences(cfg, docId)
        let records = queryIndependent(cfg, "SELECT id,kind,content_json FROM kb_courseware WHERE doc_id=" + sqlQuote(docId) +
            " AND is_current=1" +
            " AND status='ready' AND published=1 ORDER BY created_at,id")
        if (records.size == 0) { return None }
        typed = lrTypedResources(records, chapterReferences)
        references = lrArray(lrObject(typed, "lecture"), "references")
    } else {
        let out = JsonWriter()
        let adapted = cwAttachReferences(raw, references)
        let sections = lrArray(adapted, "sections")
        let slides = lrArray(raw, "slides")
        if (jsonArrayFromText(sections).size() > 0) {
            out.putRaw("lecture", "{\"sections\":" + sections + ",\"references\":" + references + ",\"sources\":" + references + "}")
        }
        if (jsonArrayFromText(slides).size() > 0) { out.putRaw("slides", "{\"slides\":" + slides + "}") }
        typed = out.toJson()
    }
    let content = JsonWriter()
    content.putRaw("sections", lrArray(raw, "sections")); content.putRaw("slides", lrArray(raw, "slides"))
    content.putRaw("resources", typed)
    let parsed = cwJsonObjectFrom(raw)
    content.putStr("sourceLabel", match (parsed) { case Some(value) => cwField(value, "sourceLabel"); case None => "" })
    let names = ["course_id", "lesson_index", "title", "content_json", "quiz_json", "sources_json", "source_doc_id"]
    let cells = ArrayList<MyCell>()
    for (name in names) { cells.add(MyCell.of((if (name == "content_json") { cwAttachReferences(content.toJson(), references) } else { row.text(name) }).toArray())) }
    Some(Row(names, cells.toArray()))
}

func lrLessonTypes(row: Row): Array<String> {
    let raw = lrObject(row.text("content_json"), "resources")
    let kinds = ArrayList<String>()
    if (jsonArrayFromText(lrArray(lrObject(raw, "lecture"), "sections")).size() > 0) { kinds.add("lecture") }
    if (lessonQuestions(row.text("quiz_json")).size() > 0) { kinds.add("bank") }
    if (jsonArrayFromText(lrArray(lrObject(raw, "slides"), "slides")).size() > 0) { kinds.add("slides") }
    kinds.toArray()
}

func lrPublicResources(row: Row): String {
    let raw = lrObject(row.text("content_json"), "resources")
    let out = JsonWriter()
    for (kind in ["lecture", "slides"]) {
        let value = lrObject(raw, kind)
        if (value.size > 0) { out.putRaw(kind, value) }
    }
    let questions = lessonQuestions(row.text("quiz_json"))
    if (questions.size() > 0) {
        let list = JsonArrWriter()
        var i: Int64 = 0
        while (i < questions.size()) { list.addRaw(publicQuestion(questions[i])); i += 1 }
        out.putRaw("bank", "{\"questions\":" + list.toJson() + "}")
    }
    out.toJson()
}

func lrAvailability(cfg: Config): HashMap<String, Row> {
    let sourceId = "COALESCE(NULLIF(l.source_doc_id,''),JSON_UNQUOTE(JSON_EXTRACT(l.sources_json,'$[0].id')))"
    let records = query(cfg, "SELECT l.course_id,COALESCE(l.display_index,l.lesson_index) display_index," +
        "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.sources_json,'$[0].kind')),'') source_kind," +
        "IF(COALESCE(l.source_doc_id,'')<>'',1,0) managed," +
        "COALESCE(JSON_LENGTH(l.content_json,'$.sections'),0) sections,COALESCE(JSON_LENGTH(l.content_json,'$.slides'),0) slides," +
        "JSON_LENGTH(l.quiz_json) questions," +
        "COALESCE((SELECT GROUP_CONCAT(DISTINCT w.kind) FROM kb_courseware w WHERE w.doc_id=" + sourceId +
        " AND w.is_current=1 AND w.status='ready' AND w.published=1),'') kinds," +
        "COALESCE((SELECT c.order_no FROM kb_courseware_chapters c WHERE c.doc_id=" + sourceId + " LIMIT 1)," +
        "COALESCE(l.display_index,l.lesson_index)+1) order_no FROM lessons l JOIN courses c ON c.id=l.course_id " +
        "WHERE l.is_visible=1 AND c.status='published'")
    let out = HashMap<String, Row>()
    for (record in records) { out[record.text("course_id") + ":" + record.int("display_index").toString()] = record }
    out
}

func lrAvailableKinds(row: Row): Array<String> {
    let out = ArrayList<String>()
    let managed = row.int("managed") == 1 || row.text("source_kind") == "kb-courseware"
    let kinds = row.text("kinds").split(",")
    for (kind in ["lecture", "bank", "slides"]) {
        var has = false
        if (managed) { for (saved in kinds) { if (saved == kind) { has = true } } }
        else {
            has = (kind == "lecture" && row.int("sections") > 0) || (kind == "slides" && row.int("slides") > 0) ||
                (kind == "bank" && row.int("questions") > 0)
        }
        if (has) { out.add(kind) }
    }
    out.toArray()
}
