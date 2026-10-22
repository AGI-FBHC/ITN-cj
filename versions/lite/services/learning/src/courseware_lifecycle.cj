package zhixun_learning

import std.collection.*
import std.core.*
import stdx.encoding.json.*

func cwSourceDocId(row: Row): String {
    if (row.text("source_doc_id").size > 0) { return row.text("source_doc_id") }
    let sources = jsonArrayFromText(row.text("sources_json"))
    if (sources.size() > 0 && isJsObject(sources[0])) {
        let source = sources[0].asObject()
        if (cwField(source, "kind") == "kb-courseware") { return cwField(source, "id") }
    }
    ""
}

func cwResourceVersion(cfg: Config, row: Row, kind: String): Int64 {
    let docId = cwSourceDocId(row)
    if (docId.size == 0) { return 0 }
    let rows = query(cfg, "SELECT generation FROM kb_courseware WHERE doc_id=" + sqlQuote(docId) +
        " AND kind=" + sqlQuote(kind) + " AND is_current=1 AND published=1 AND status='ready' LIMIT 1")
    if (rows.size == 0) { -1 } else { rows[0].int("generation") }
}

func cwCheckResourceVersion(cfg: Config, row: Row, kind: String, body: JsonObject): Bool {
    let current = cwResourceVersion(cfg, row, kind)
    if (current == 0) { return true }
    // Generation one remains compatible with older clients; replaced resources require a version.
    current > 0 && (jsonGetInt(body, "resourceVersion") ?? 1) == current
}

func cwResourceVersionsJson(cfg: Config, row: Row): String {
    let out = JsonWriter()
    let docId = cwSourceDocId(row)
    if (docId.size > 0) {
        for (resource in query(cfg, "SELECT kind,generation FROM kb_courseware WHERE doc_id=" +
            sqlQuote(docId) + " AND is_current=1 AND published=1 AND status='ready'")) {
            out.putInt(resource.text("kind"), resource.int("generation"))
        }
    }
    out.toJson()
}

func cwResourceProgressSql(userId: String, courseId: String, index: Int64, kind: String,
                          generation: Int64, score: String, completed: String): String {
    "INSERT INTO lesson_resource_progress(user_id,course_id,lesson_index,kind,generation,is_read,score,completed) VALUES(" +
    sqlQuote(userId) + "," + sqlQuote(courseId) + "," + index.toString() + "," + sqlQuote(kind) + "," +
    maxInt(1, generation).toString() + ",1," + score + "," + completed + ") ON DUPLICATE KEY UPDATE " +
    "generation=VALUES(generation),is_read=1,score=" + (if (score == "NULL") { "score" } else { "VALUES(score)" }) +
    ",completed=GREATEST(completed,VALUES(completed)),updated_at=NOW(6)"
}

func cwResourceProgressJson(cfg: Config, userId: String, courseId: String, index: Int64): String {
    let out = JsonWriter()
    for (row in query(cfg, "SELECT kind,generation,is_read,score,completed FROM lesson_resource_progress WHERE user_id=" +
        sqlQuote(userId) + " AND course_id=" + sqlQuote(courseId) + " AND lesson_index=" + index.toString())) {
        let resource = JsonWriter()
        resource.putInt("version", row.int("generation"))
        resource.putBool("read", row.int("is_read") == 1)
        resource.putBool("completed", row.int("completed") == 1)
        resource.putOptInt("score", if (row.isNull("score")) { None } else { Some(row.int("score")) })
        out.putRaw(row.text("kind"), resource.toJson())
    }
    out.toJson()
}

func cwBookmarkKind(item: JsonObject): String {
    let specified = cwField(item, "resourceKind")
    if (cwValidKind(specified)) { return specified }
    let id = cwField(item, "id")
    if (id.startsWith("quiz-")) { return "bank" }
    "lecture"
}

func cwBookmarkJson(item: JsonObject): String {
    let out = JsonWriter()
    for (key in ["id", "courseId", "courseName", "lessonTitle", "heading", "text", "savedAt", "resourceKind", "sourceDocId"]) {
        if (jsonHas(item, key)) { out.putStr(key, cwField(item, key)) }
    }
    for (key in ["lessonIndex", "resourceVersion"]) {
        match (jsonGetInt(item, key)) { case Some(value) => out.putInt(key, value); case None => () }
    }
    out.toJson()
}

func cwClearResourceRecords(cfg: Config, bundleId: String, docId: String, kinds: HashSet<String>,
                           statements: ArrayList<String>): Unit {
    let names = ArrayList<String>()
    for (kind in kinds) { names.add(sqlQuote(kind)) }
    let kindSql = String.join(names.toArray(), delimiter: ",")
    let lessons = query(cfg, "SELECT l.course_id,l.lesson_index,l.title FROM lessons l JOIN kb_bundles b ON b.course_id=l.course_id " +
        "WHERE b.id=" + sqlQuote(bundleId) + " AND (l.source_doc_id=" + sqlQuote(docId) +
        " OR JSON_UNQUOTE(JSON_EXTRACT(l.sources_json,'$[0].id'))=" + sqlQuote(docId) + ")")
    for (lesson in lessons) {
        let courseId = lesson.text("course_id")
        let filter = "course_id=" + sqlQuote(courseId) + " AND lesson_index=" + lesson.int("lesson_index").toString()
        statements.add("DELETE FROM lesson_resource_progress WHERE " + filter + " AND kind IN (" + kindSql + ")")
        if (kinds.contains("bank")) { statements.add("DELETE FROM quiz_attempts WHERE " + filter) }
        let remaining = "SELECT 1 FROM lesson_resource_progress r WHERE r.user_id=p.user_id AND r.course_id=p.course_id AND r.lesson_index=p.lesson_index"
        let read = "EXISTS(" + remaining + " AND r.is_read=1)"
        let done = "EXISTS(" + remaining + " AND r.completed=1)"
        statements.add("UPDATE lesson_progress p SET is_read=IF(" + read +
            (if (kinds.contains("bank")) { "" } else { " OR p.score IS NOT NULL" }) + ",1,0),completed=" +
            (if (kinds.contains("bank")) { "0" } else { "IF(p.score>=60,p.completed,IF(" + done + ",1,0))" }) +
            (if (kinds.contains("bank")) { ",score=NULL" } else { "" }) + " WHERE " + filter)
        statements.add("DELETE FROM lesson_progress WHERE " + filter + " AND is_read=0 AND completed=0 AND score IS NULL")
        let states = query(cfg, "SELECT user_id,bookmarks_json FROM user_state WHERE bookmarks_json LIKE " + sqlQuote("%" + courseId + "%"))
        for (state in states) {
            let kept = JsonArrWriter()
            var removed = false
            let saved = jsonArrayFromText(state.text("bookmarks_json"))
            var savedIndex: Int64 = 0
            while (savedIndex < saved.size()) {
                let value = saved[savedIndex]
                savedIndex += 1
                if (!isJsObject(value)) { continue }
                let item = value.asObject()
                let source = cwField(item, "sourceDocId")
                let sameChapter = if (source.size > 0) { source == docId } else { cwField(item, "lessonTitle") == lesson.text("title") }
                if (cwField(item, "courseId") == courseId && sameChapter && kinds.contains(cwBookmarkKind(item))) {
                    removed = true
                } else { kept.addRaw(cwBookmarkJson(item)) }
            }
            if (removed) { statements.add("UPDATE user_state SET bookmarks_json=" + sqlQuote(kept.toJson()) +
                " WHERE user_id=" + sqlQuote(state.text("user_id"))) }
        }
    }
}

class CwEnqueueResult {
    let error: String
    let items: String
    init(error: String, items: String) { this.error = error; this.items = items }
}

func cwEnqueueResources(cfg: Config, bundleId: String, docId: String, kinds: JsonArray,
                       options: CwGenerationOptions, model: String, replaceExisting: Bool,
                       expected: ?JsonObject): CwEnqueueResult {
    cwCourseSyncLock.lock()
    try {
        let chosen = ArrayList<String>()
        let seen = HashSet<String>()
        var kindIndex: Int64 = 0
        while (kindIndex < kinds.size()) {
            let value = kinds[kindIndex]
            kindIndex += 1
            match (value.kind()) {
                case JsonKind.JsString => ()
                case _ => continue
            }
            let kind = value.asString().getValue()
            if (cwValidKind(kind) && !seen.contains(kind)) { chosen.add(kind); seen.add(kind) }
        }
        if (chosen.size == 0) { return CwEnqueueResult("请选择有效的资源类型", "[]") }
        let rows = query(cfg, "SELECT id,kind,status,published,generation FROM kb_courseware WHERE doc_id=" +
            sqlQuote(docId) + " AND is_current=1")
        for (row in rows) {
            let kind = row.text("kind")
            if (!seen.contains(kind)) { continue }
            if (row.text("status") == "queued" || row.text("status") == "generating") {
                return CwEnqueueResult(cwLabel(kind) + "已经在生成中，请等待完成", "[]")
            }
            if (!replaceExisting) { return CwEnqueueResult("已有资源，重新生成需要确认下架并清空对应学习记录", "[]") }
            let version = match (expected) { case Some(obj) => jsonGetInt(obj, kind) ?? -1; case None => -1 }
            if (version != row.int("generation")) { return CwEnqueueResult("资源状态已变化，请刷新后重新确认", "[]") }
        }
        let statements = ArrayList<String>()
        let items = JsonArrWriter()
        let replaced = HashSet<String>()
        for (row in rows) { if (seen.contains(row.text("kind"))) { replaced.add(row.text("kind")) } }
        if (replaced.size > 0) { cwClearResourceRecords(cfg, bundleId, docId, replaced, statements) }
        for (kind in chosen) {
            var id = ""
            for (row in rows) { if (row.text("kind") == kind) { id = row.text("id") } }
            if (id.size > 0) {
                statements.add("UPDATE kb_courseware SET published=0,status='queued',title='',content_json=NULL,steps_json='[]'," +
                    "error_message='',model=" + sqlQuote(model) + ",options_json=" + sqlQuote(options.toJson()) +
                    ",generation=generation+1,created_at=NOW(6),updated_at=NOW(6) WHERE id=" + sqlQuote(id))
            } else {
                id = uuidFormat(uuidV4())
                statements.add("INSERT INTO kb_courseware(id,bundle_id,doc_id,kind,title,status,model,options_json,is_current,generation) VALUES(" +
                    sqlQuote(id) + "," + sqlQuote(bundleId) + "," + sqlQuote(docId) + "," + sqlQuote(kind) + ",'','queued'," +
                    sqlQuote(model) + "," + sqlQuote(options.toJson()) + ",1,1)")
            }
            let item = JsonWriter(); item.putStr("id", id); item.putStr("kind", kind); item.putStr("status", "queued")
            items.addRaw(item.toJson())
        }
        transaction(cfg, statements.toArray())
        cwSyncBundleCourseLocked(cfg, bundleId, "")
        kbBumpVersion()
        CwEnqueueResult("", items.toJson())
    } finally { cwCourseSyncLock.unlock() }
}
