package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*

/*
 * Persistence for generated_courses / generated_course_chapters, plus the
 * read-side ppt overlay from presentation_tasks.
 * Ported from src/agents/app/storage/courses.py
 *   list / get / update_course_meta / update_chapter_meta / delete
 *   _course / _chapter / _loads
 * and src/agents/app/routers/public.py _enrich_course_presentation_status.
 *
 * Generation (create / regenerate / retry / chapter resource retry) stays in
 * the Python service — those paths need the LLM task queue.
 */

/*
 * generated_courses columns:
 *  0 id, 1 user_id, 2 learner_id, 3 learning_goal_id, 4 learning_goal_ids_json,
 *  5 title, 6 description, 7 prompt, 8 domain_name, 9 depth, 10 scale,
 * 11 course_style, 12 resource_types_json, 13 status, 14 progress,
 * 15 stage_message, 16 current_chapter_id, 17 events_json, 18 error_message,
 * 19 created_at, 20 updated_at
 */
private func courseColumns(): String {
    "id,user_id,learner_id,learning_goal_id,learning_goal_ids_json,title," +
        "description,prompt,domain_name,depth,scale,course_style," +
        "resource_types_json,status,progress,stage_message,current_chapter_id," +
        "events_json,error_message,created_at,updated_at"
}

/*
 * generated_course_chapters columns:
 *  0 id, 1 course_id, 2 chapter_index, 3 title, 4 summary,
 *  5 objectives_json, 6 sections_json, 7 status, 8 progress,
 *  9 resources_json, 10 created_at, 11 updated_at
 */
private func chapterColumns(): String {
    "id,course_id,chapter_index,title,summary,objectives_json,sections_json," +
        "status,progress,resources_json,created_at,updated_at"
}

public class CoursesStore {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    /* -------- read -------- */

    public func list(userId: Array<Byte>, learnerId: ?Array<Byte>): Array<String> {
        var sql = "SELECT " + courseColumns() +
            " FROM generated_courses WHERE user_id=" + sqlBinary(userId)
        match (learnerId) {
            case Some(l) => sql = sql + " AND learner_id=" + sqlBinary(l)
            case None => ()
        }
        sql = sql + " ORDER BY updated_at DESC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<String>(0, repeat: "")
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<String>()
                for (row in rs.rows) {
                    out.add(serializeCourse(row, loadChapters(row[0].bytes, userId)))
                }
                return out.toArray()
        }
    }

    public func get(userId: Array<Byte>, courseId: Array<Byte>): ?String {
        let sql = "SELECT " + courseColumns() +
            " FROM generated_courses WHERE id=" + sqlBinary(courseId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(serializeCourse(rs.rows[0], loadChapters(courseId, userId)))
        }
    }

    private func loadChapters(courseId: Array<Byte>, userId: Array<Byte>): String {
        let sql = "SELECT " + chapterColumns() +
            " FROM generated_course_chapters WHERE course_id=" + sqlBinary(courseId) +
            " ORDER BY chapter_index"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return "[]"
            case QueryOutcome.ResultSet(rs) =>
                let arr = JsonArrWriter()
                for (row in rs.rows) {
                    arr.addRaw(serializeChapter(row, userId))
                }
                return arr.toJson()
        }
    }

    /* -------- write-back (metadata only) -------- */

    /*
     * update_course_meta: PATCH-style. An absent/null field is left alone; when
     * neither field is supplied the row is returned unchanged (Python returns
     * get() without running UPDATE). A row that does not match id+user yields
     * None so the handler can answer 404.
     */
    public func updateCourseMeta(userId: Array<Byte>, courseId: Array<Byte>,
                                 title: ?String, description: ?String): ?String {
        let sets = ArrayList<String>()
        match (title) {
            case Some(t) => sets.add("title=" + sqlQuote(runeSlice(t, 160)))
            case None => ()
        }
        match (description) {
            case Some(d) => sets.add("description=" + sqlQuote(runeSlice(d, 2000)))
            case None => ()
        }
        if (sets.isEmpty()) {
            return get(userId, courseId)
        }
        sets.add("updated_at=" + sqlQuote(mysqlDatetime(nowUtcParts())))
        match (conn.query(buildUpdate("generated_courses", sets.toArray(),
            " WHERE id=" + sqlBinary(courseId) + " AND user_id=" + sqlBinary(userId)))) {
            case QueryOutcome.Ok(ok) =>
                if (ok.affectedRows <= 0) {
                    return None
                }
            case QueryOutcome.ResultSet(_) => return None
        }
        return get(userId, courseId)
    }

    /*
     * update_chapter_meta: 404 detail is "Course chapter not found" for both a
     * missing course and a missing chapter (Python raises that one message).
     * An empty body skips the UPDATE and still returns the parent course.
     */
    public func updateChapterMeta(userId: Array<Byte>, courseId: Array<Byte>,
                                  chapterId: Array<Byte>,
                                  title: ?String, summary: ?String): ?String {
        let sets = ArrayList<String>()
        match (title) {
            case Some(t) => sets.add("title=" + sqlQuote(runeSlice(t, 200)))
            case None => ()
        }
        match (summary) {
            case Some(s) => sets.add("summary=" + sqlQuote(runeSlice(s, 1000)))
            case None => ()
        }
        if (sets.isEmpty()) {
            return get(userId, courseId)
        }
        sets.add("updated_at=" + sqlQuote(mysqlDatetime(nowUtcParts())))
        let whereClause = " WHERE id=" + sqlBinary(chapterId) +
            " AND course_id=" + sqlBinary(courseId) +
            " AND course_id IN (SELECT id FROM generated_courses WHERE id=" +
            sqlBinary(courseId) + " AND user_id=" + sqlBinary(userId) + ")"
        match (conn.query(buildUpdate("generated_course_chapters", sets.toArray(), whereClause))) {
            case QueryOutcome.Ok(ok) =>
                if (ok.affectedRows <= 0) {
                    return None
                }
            case QueryOutcome.ResultSet(_) => return None
        }
        return get(userId, courseId)
    }

    public func delete(userId: Array<Byte>, courseId: Array<Byte>): Bool {
        let probe = "SELECT id FROM generated_courses WHERE id=" + sqlBinary(courseId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(probe)) {
            case QueryOutcome.Ok(_) => return false
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return false
                }
        }
        match (conn.query("DELETE FROM generated_course_chapters WHERE course_id=" + sqlBinary(courseId))) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        match (conn.query("DELETE FROM generated_courses WHERE id=" + sqlBinary(courseId) +
            " AND user_id=" + sqlBinary(userId))) {
            case QueryOutcome.Ok(_) => return true
            case QueryOutcome.ResultSet(_) => return false
        }
    }

    /*
     * CourseStore.progress (courses.py:213) for GET /course-progress.
     * Latest course for the user (optionally narrowed by learner), then count
     * completed resources that the viewer has marked learned.
     * Returns None when there is no matching course — the API maps that to
     * {"total":0,"completed":0,"percent":0}.
     */
    public func progress(userId: Array<Byte>, learnerId: ?Array<Byte>): ?String {
        var sql = "SELECT id,title,resource_types_json FROM generated_courses WHERE user_id=" +
            sqlBinary(userId)
        match (learnerId) {
            case Some(l) => sql = sql + " AND learner_id=" + sqlBinary(l)
            case None => ()
        }
        sql = sql + " ORDER BY updated_at DESC LIMIT 1"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                let row = rs.rows[0]
                let courseId = row[0].bytes
                let courseTitle = cellText(row, 1)
                let kinds = jsonStringList(parseJsonArrayText(cellText(row, 2)))
                var total: Int64 = 0
                var completed: Int64 = 0
                let chapterSql = "SELECT resources_json FROM generated_course_chapters WHERE course_id=" +
                    sqlBinary(courseId)
                match (conn.query(chapterSql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(chs) =>
                        for (ch in chs.rows) {
                            let resources = jsonParseObjectText(cellText(ch, 0))
                            for (kind in kinds) {
                                match (jsonGetObject(resources, kind)) {
                                    case None => ()
                                    case Some(item) =>
                                        let statusOk = jsonGetString(item, "status") == Some("completed")
                                        var hasId = false
                                        match (jsonGetString(item, "id")) {
                                            case Some(idText) => hasId = !idText.trimAscii().isEmpty()
                                            case None => ()
                                        }
                                        if (statusOk && hasId) {
                                            total += 1
                                            match (jsonGetString(item, "id")) {
                                                case None => ()
                                                case Some(idText) =>
                                                    match (uuidParse(idText)) {
                                                        case None => ()
                                                        case Some(rid) =>
                                                            if (resourceLearned(conn, userId, kind, rid)) {
                                                                completed += 1
                                                            }
                                                    }
                                            }
                                        }
                                }
                            }
                        }
                }
                var percent: Int64 = 0
                if (total > 0) {
                    percent = pythonRoundInt(floatFromInt(completed) / floatFromInt(total) * 100.0)
                }
                let w = JsonWriter()
                w.putStr("courseId", uuidFormat(courseId))
                w.putStr("courseTitle", courseTitle)
                w.putInt("total", total)
                w.putInt("completed", completed)
                w.putInt("percent", percent)
                return Some(w.toJson())
        }
    }
}

private func buildUpdate(table: String, sets: Array<String>, whereClause: String): String {
    var sql = "UPDATE " + table + " SET "
    var first = true
    for (s in sets) {
        if (!first) {
            sql = sql + ","
        }
        first = false
        sql = sql + s
    }
    return sql + whereClause
}

/* -------- serialisation (mirrors CourseStore._course / _chapter) -------- */

private func serializeCourse(row: Array<MyCell>, chaptersJson: String): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putStr("title", cellText(row, 5))
    w.putOptStr("learnerId", uuidText(row, 2))
    w.putStr("description", cellText(row, 6))
    w.putStr("prompt", cellText(row, 7))
    w.putOptStr("learningGoalId", uuidText(row, 3))
    w.putRaw("learningGoalIds", parseJsonArrayText(cellText(row, 4)))
    let domain = cellText(row, 8)
    w.putStr("domainName", if (domain.isEmpty()) { "当前学习领域" } else { domain })
    w.putStr("depth", cellText(row, 9))
    w.putStr("scale", cellText(row, 10))
    let style = cellText(row, 11)
    w.putStr("courseStyle", if (style.isEmpty()) { "none" } else { style })
    w.putRaw("resourceTypes", parseJsonArrayText(cellText(row, 12)))
    w.putStr("status", cellText(row, 13))
    w.putInt("progress", optCellInt(row, 14) ?? 0)
    w.putStr("stageMessage", cellText(row, 15))
    w.putOptStr("errorMessage", optCellText(row, 18))
    w.putOptStr("currentChapterId", uuidText(row, 16))
    w.putRaw("events", parseJsonArrayText(cellText(row, 17)))
    w.putStr("createdAt", isoNaiveFromDb(cellText(row, 19)))
    w.putStr("updatedAt", isoNaiveFromDb(cellText(row, 20)))
    w.putRaw("chapters", chaptersJson)
    return w.toJson()
}

private func serializeChapter(row: Array<MyCell>, userId: Array<Byte>): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putInt("index", optCellInt(row, 2) ?? 0)
    w.putStr("title", cellText(row, 3))
    w.putStr("summary", cellText(row, 4))
    w.putRaw("objectives", parseJsonArrayText(cellText(row, 5)))
    w.putRaw("sections", parseJsonArrayText(cellText(row, 6)))
    w.putStr("status", cellText(row, 7))
    w.putInt("progress", optCellInt(row, 8) ?? 0)
    w.putRaw("resources", parseState(cellText(row, 9)))
    w.putStr("createdAt", isoNaiveFromDb(cellText(row, 10)))
    w.putStr("updatedAt", isoNaiveFromDb(cellText(row, 11)))
    return w.toJson()
}

/*
 * _enrich_course_presentation_status: when chapter.resources.ppt carries a
 * presentation task id the viewer can see, overlay status/progress/title/error
 * from presentation_tasks onto that ppt object. Unknown ids are left alone.
 * Applied to every course payload the API returns.
 */
func enrichCoursePpt(courseRaw: String, userId: Array<Byte>, conn: MyConnection): String {
    match (jsonParse(courseRaw)) {
        case None => return courseRaw
        case Some(v) =>
            if (!isJsObject(v)) {
                return courseRaw
            }
            let course = v.asObject()
            match (jsonGetArray(course, "chapters")) {
                case None => return courseRaw
                case Some(chapters) =>
                    let chaptersRaw = enrichChaptersArr(chapters, userId, conn)
                    let w = JsonWriter()
                    for ((k, val) in course.getFields()) {
                        if (k == "chapters") {
                            w.putRaw("chapters", chaptersRaw)
                        } else {
                            w.putRaw(k, valueToRaw(val))
                        }
                    }
                    return w.toJson()
            }
    }
}

private func enrichChaptersArr(chapters: JsonArray, userId: Array<Byte>, conn: MyConnection): String {
    let arr = JsonArrWriter()
    var i: Int64 = 0
    while (i < chapters.size()) {
        match (chapters.get(i)) {
            case None => arr.addRaw("null")
            case Some(item) =>
                if (isJsObject(item)) {
                    arr.addRaw(enrichChapterObj(item.asObject(), userId, conn))
                } else {
                    arr.addRaw(valueToRaw(item))
                }
        }
        i += 1
    }
    return arr.toJson()
}

private func enrichChapterObj(chapter: JsonObject, userId: Array<Byte>, conn: MyConnection): String {
    match (jsonGetObject(chapter, "resources")) {
        case None => return jsonObjectToRaw(chapter)
        case Some(resources) =>
            match (jsonGetObject(resources, "ppt")) {
                case None => return jsonObjectToRaw(chapter)
                case Some(ppt) =>
                    match (jsonGetString(ppt, "id")) {
                        case None => return jsonObjectToRaw(chapter)
                        case Some(idText) =>
                            match (uuidParse(idText)) {
                                case None => return jsonObjectToRaw(chapter)
                                case Some(taskId) =>
                                    match (lookupPresentation(conn, taskId, userId)) {
                                        case None => return jsonObjectToRaw(chapter)
                                        case Some(overlay) =>
                                            match (jsonParse(overlay)) {
                                                case None => return jsonObjectToRaw(chapter)
                                                case Some(ov) =>
                                                    if (!isJsObject(ov)) {
                                                        return jsonObjectToRaw(chapter)
                                                    }
                                                    let mergedPpt = jsonMergeObjects(ppt, ov.asObject())
                                                    let mergedRes = replaceField(resources, "ppt", mergedPpt)
                                                    return replaceField(chapter, "resources", mergedRes)
                                            }
                                    }
                            }
                    }
            }
    }
}

private func replaceField(obj: JsonObject, key: String, rawJson: String): String {
    let w = JsonWriter()
    for ((k, val) in obj.getFields()) {
        if (k == key) {
            w.putRaw(k, rawJson)
        } else {
            w.putRaw(k, valueToRaw(val))
        }
    }
    return w.toJson()
}

/*
 * Visibility matches PresentationStore.get; only the four fields the overlay
 * needs are selected. Failures (missing table, no row, not visible) return
 * None so the course payload is left unchanged.
 */
private func lookupPresentation(conn: MyConnection, taskId: Array<Byte>,
                                userId: Array<Byte>): ?String {
    let sql = "SELECT status,progress,title,error_message FROM presentation_tasks " +
        "WHERE id=" + sqlBinary(taskId) + " AND archived_at IS NULL AND (" +
        "(user_id=" + sqlBinary(userId) + " AND resource_scope IN ('USER','ORGANIZATION')) OR " +
        "(resource_scope='USER' AND is_public=1) OR " +
        "(resource_scope='ORGANIZATION' AND organization_id=(" +
        "SELECT organization_id FROM users WHERE id=" + sqlBinary(userId) + ")))"
    try {
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                let row = rs.rows[0]
                /* Python task.get(...) yields None for SQL NULL → JSON null. */
                let w = JsonWriter()
                w.putOptStr("status", optCellText(row, 0))
                w.putOptInt("progress", optCellInt(row, 1))
                w.putOptStr("title", optCellText(row, 2))
                w.putOptStr("error", optCellText(row, 3))
                return Some(w.toJson())
        }
    } catch (_: Exception) {
        return None
    }
}

/* Python str[:n] slices by code point. */
func runeSlice(text: String, limit: Int64): String {
    if (charCount(text) <= limit) {
        return text
    }
    var out = ""
    var n: Int64 = 0
    for (ch in text.runes()) {
        if (n >= limit) {
            break
        }
        out = out + ch.toString()
        n += 1
    }
    return out
}

/* -------- course-progress helpers -------- */

/*
 * CourseStore._resource_learned (courses.py:254).
 *
 * Visibility is narrower than PresentationStore.get: the row must be
 * non-archived, resource_scope='USER', and own-or-public.
 *
 * Python quirk ported as-is: the visibility SELECT only fetches learned_json /
 * state_json, so row.get("user_id") is always None and the code always falls
 * into the *_user_state lookup whenever the row is visible — including for the
 * owner's own resource. learned therefore comes from the per-user state table.
 */
func resourceLearned(conn: MyConnection, userId: Array<Byte>, kind: String,
                     resourceId: Array<Byte>): Bool {
    if (kind == "ppt") {
        let probe = "SELECT learned_json FROM presentation_tasks WHERE id=" + sqlBinary(resourceId) +
            " AND archived_at IS NULL AND resource_scope='USER' AND (user_id=" + sqlBinary(userId) +
            " OR is_public=1)"
        match (conn.query(probe)) {
            case QueryOutcome.Ok(_) => return false
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return false
                }
        }
        let stateSql = "SELECT learned_json FROM presentation_task_user_state WHERE task_id=" +
            sqlBinary(resourceId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(stateSql)) {
            case QueryOutcome.Ok(_) => return false
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return false
                }
                return jsonTruthyField(cellText(rs.rows[0], 0), "learned")
        }
    }
    let probe = "SELECT state_json FROM generated_learning_resources WHERE id=" + sqlBinary(resourceId) +
        " AND archived_at IS NULL AND resource_scope='USER' AND (user_id=" + sqlBinary(userId) +
        " OR is_public=1)"
    match (conn.query(probe)) {
        case QueryOutcome.Ok(_) => return false
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return false
            }
    }
    let stateSql = "SELECT state_json FROM learning_resource_user_state WHERE resource_id=" +
        sqlBinary(resourceId) + " AND user_id=" + sqlBinary(userId)
    match (conn.query(stateSql)) {
        case QueryOutcome.Ok(_) => return false
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return false
            }
            let stateRaw = cellText(rs.rows[0], 0)
            if (jsonTruthyField(stateRaw, "learned")) {
                return true
            }
            return kind == "quiz" && jsonTruthyField(stateRaw, "completed")
    }
}

/* Python bool(state.get(key)) — missing / null / false / 0 / "" / [] / {} are false. */
func jsonTruthyField(text: String, key: String): Bool {
    match (jsonParse(text)) {
        case None => return false
        case Some(v) =>
            if (!isJsObject(v)) {
                return false
            }
            let obj = v.asObject()
            match (obj.get(key)) {
                case None => return false
                case Some(val) => return jsonTruthy(val)
            }
    }
}

private func jsonTruthy(v: JsonValue): Bool {
    match (v.kind()) {
        case JsonKind.JsNull => return false
        case JsonKind.JsBool => return v.asBool().getValue()
        case JsonKind.JsInt => return v.asInt().getValue() != 0
        case JsonKind.JsFloat => return v.asFloat().getValue() != 0.0
        case JsonKind.JsString => return !v.asString().getValue().isEmpty()
        case JsonKind.JsArray => return v.asArray().size() > 0
        case JsonKind.JsObject =>
            for ((_, _) in v.asObject().getFields()) {
                return true
            }
            return false
    }
}

/*
 * Python 3 round(x) for a float: half-to-even, result used as an int.
 * Cangjie Float64.round() / roundTo() are half-away-from-zero, which would
 * turn 12.5 → 13 instead of 12 and 37.5 → 38 (same here by luck).
 */
func pythonRoundInt(v: Float64): Int64 {
    let n = truncateFloat(v)
    let frac = v - floatFromInt(n)
    if (frac > 0.5) {
        return n + 1
    }
    if (frac < 0.5) {
        return n
    }
    /* Exactly halfway: round half to even. */
    if (n % 2 == 0) {
        return n
    }
    return n + 1
}

private func jsonStringList(rawJson: String): Array<String> {
    match (jsonParse(rawJson)) {
        case None => return Array<String>(0, repeat: "")
        case Some(v) =>
            if (!isJsArray(v)) {
                return Array<String>(0, repeat: "")
            }
            let arr = v.asArray()
            let out = ArrayList<String>()
            var i: Int64 = 0
            while (i < arr.size()) {
                match (arr.get(i)) {
                    case Some(item) =>
                        if (isJsString(item)) {
                            out.add(item.asString().getValue())
                        }
                    case None => ()
                }
                i += 1
            }
            return out.toArray()
    }
}

private func jsonParseObjectText(text: String): JsonObject {
    match (jsonParse(parseState(text))) {
        case None => return emptyObject()
        case Some(v) =>
            if (isJsObject(v)) {
                return v.asObject()
            }
            return emptyObject()
    }
}
