package zhixun_learning

import std.core.*
import stdx.encoding.json.*

func tutorConversationOwnerFilter(userId: String, conversationId: String): String {
    "user_id=" + sqlQuote(userId) + " AND conversation_id=" + sqlQuote(conversationId)
}

func tutorConversationCheckId(conversationId: String): Unit {
    if (!tutorValidConversationId(conversationId)) {
        tutorReject(400, "conversationId 格式不正确")
    }
}

func tutorConversationCleanTitle(raw: String): String {
    let title = raw.trimAscii()
    let runes = try { title.toRuneArray() } catch (_: Exception) {
        tutorReject(400, "标题必须是合法的 Unicode 文本")
    }
    if (runes.size < 1 || runes.size > 64) { tutorReject(400, "标题需为 1–64 个字符") }
    var visible = false
    for (rune in runes) {
        let code = UInt32(rune)
        if (code < 32 || (code >= 127 && code <= 159) ||
            (code >= 0xD800 && code <= 0xDFFF) || code > 0x10FFFF) {
            tutorReject(400, "标题不能包含控制字符或无效 Unicode 字符")
        }
        if (code != 32 && code != 0xA0 && code != 0x1680 &&
            !(code >= 0x2000 && code <= 0x200A) && code != 0x2028 &&
            code != 0x2029 && code != 0x202F && code != 0x205F && code != 0x3000) {
            visible = true
        }
    }
    if (!visible) { tutorReject(400, "标题不能为空") }
    title
}

func tutorConversationUpdateAssignments(body: JsonObject): String {
    var assignments = ""
    match (body.get("title")) {
        case Some(value) =>
            if (!isJsString(value)) { tutorReject(400, "title 必须是文本") }
            assignments = "title=" + sqlQuote(tutorConversationCleanTitle(value.asString().getValue()))
        case None => ()
    }
    if (jsonHas(body, "archived")) {
        let archived = match (jsonGetBool(body, "archived")) {
            case Some(value) => value
            case None => tutorReject(400, "archived 必须是布尔值")
        }
        if (assignments.size > 0) { assignments += "," }
        assignments += "archived=" + if (archived) { "1" } else { "0" }
    }
    if (assignments.size == 0) { tutorReject(400, "请提供 title 或 archived") }
    assignments + ",updated_at=NOW(6)"
}

// NULL is the automatic-title sentinel. Sending messages never changes a custom title or archive state.
func tutorConversationEnsureSql(userId: String, conversationId: String): String {
    "INSERT INTO tutor_conversations(user_id,conversation_id) VALUES(" +
        sqlQuote(userId) + "," + sqlQuote(conversationId) +
        ") ON DUPLICATE KEY UPDATE updated_at=GREATEST(updated_at,NOW(6))"
}

func tutorConversationEnsure(cfg: Config, userId: String, conversationId: String): Unit {
    tutorConversationCheckId(conversationId)
    let conn = connect(cfg)
    try { ignoreOk(conn.query(tutorConversationEnsureSql(userId, conversationId))) }
    finally { conn.close() }
}

func tutorManagedConversationTitle(customTitle: String, firstUser: String,
                                  courseName: String, lessonTitle: String): String {
    if (customTitle.size > 0) { return customTitle }
    let automatic = tutorConversationExcerpt(firstUser, 64)
    if (automatic.size > 0) { return automatic }
    tutorConversationTitle(courseName, lessonTitle, "")
}

// Only the selected (at most 100) conversations load message bodies. All lookups use the owner/key index.
func tutorConversationDetailsSql(userId: String, candidates: String): String {
    let owner = sqlQuote(userId)
    let course = "COALESCE(NULLIF(r.course_id,''),m.course_id,'')"
    let lesson = "CASE WHEN r.course_id<>'' THEN r.lesson_index ELSE COALESCE(m.lesson_index,-1) END"
    "SELECT r.conversation_id,COALESCE(r.title,'') custom_title,r.archived," +
        "DATE_FORMAT(r.created_at,'%Y-%m-%d %H:%i:%s') created_at," +
        "DATE_FORMAT(GREATEST(r.updated_at,COALESCE(m.created_at,r.updated_at)),'%Y-%m-%d %H:%i:%s') updated_at," +
        course + " course_id," + lesson + " lesson_index," +
        "COALESCE(m.content,'') latest_content,COALESCE(c.name,'') course_name," +
        "COALESCE((SELECT l.title FROM lessons l WHERE l.course_id=" + course + " AND " +
        "COALESCE(l.display_index,l.lesson_index)=(" + lesson + ") LIMIT 1),'') lesson_title," +
        "COALESCE((SELECT u.content FROM tutor_messages u WHERE u.user_id=" + owner +
        " AND u.conversation_id=r.conversation_id AND u.role='user' ORDER BY u.created_at ASC,u.id ASC LIMIT 1),'') first_user_content," +
        "(SELECT COUNT(*) FROM tutor_messages n WHERE n.user_id=" + owner +
        " AND n.conversation_id=r.conversation_id) message_count " +
        "FROM (" + candidates + ") r LEFT JOIN tutor_messages m ON m.user_id=" + owner +
        " AND m.conversation_id=r.conversation_id AND m.id=(SELECT latest.id FROM tutor_messages latest WHERE latest.user_id=" +
        owner + " AND latest.conversation_id=r.conversation_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1) " +
        "LEFT JOIN courses c ON c.id=" + course + " ORDER BY r.updated_at DESC,r.conversation_id DESC"
}

func tutorManagedConversationsSql(userId: String, archived: Bool): String {
    let owner = sqlQuote(userId)
    let flag = if (archived) { "1" } else { "0" }
    let candidates = "SELECT c.conversation_id,c.title,c.archived,c.course_id,c.lesson_index,c.created_at," +
        "GREATEST(c.updated_at,COALESCE((SELECT MAX(t.created_at) FROM tutor_messages t WHERE t.user_id=" +
        owner + " AND t.conversation_id=c.conversation_id),c.updated_at)) updated_at " +
        "FROM tutor_conversations c WHERE c.user_id=" + owner + " AND c.archived=" + flag +
        " UNION ALL SELECT legacy.conversation_id,NULL title,0 archived,'' course_id,-1 lesson_index,MIN(legacy.created_at) created_at," +
        "MAX(legacy.created_at) updated_at FROM tutor_messages legacy WHERE legacy.user_id=" + owner +
        " AND " + flag + "=0 AND NOT EXISTS(SELECT 1 FROM tutor_conversations existing WHERE existing.user_id=" +
        owner + " AND existing.conversation_id=legacy.conversation_id) GROUP BY legacy.conversation_id " +
        "ORDER BY updated_at DESC,conversation_id DESC LIMIT 100"
    tutorConversationDetailsSql(userId, candidates)
}

func tutorManagedConversationJson(row: Row): String {
    let out = JsonWriter()
    out.putStr("conversationId", row.text("conversation_id"))
    out.putStr("title", tutorManagedConversationTitle(row.text("custom_title"), row.text("first_user_content"),
        row.text("course_name"), row.text("lesson_title")))
    out.putBool("archived", row.int("archived") != 0)
    out.putStr("preview", tutorConversationPreview(row.text("latest_content")))
    out.putStr("courseId", row.text("course_id"))
    out.putInt("lessonIndex", row.int("lesson_index"))
    out.putStr("courseName", row.text("course_name"))
    out.putStr("lessonTitle", row.text("lesson_title"))
    out.putInt("messageCount", row.int("message_count"))
    out.putStr("createdAt", row.text("created_at"))
    out.putStr("updatedAt", row.text("updated_at"))
    out.toJson()
}

func tutorManagedConversationsBody(cfg: Config, userId: String, archived: Bool): String {
    let rows = queryIndependent(cfg, tutorManagedConversationsSql(userId, archived))
    let items = JsonArrWriter()
    for (row in rows) { items.addRaw(tutorManagedConversationJson(row)) }
    tutorConversationsPayload(items.toJson())
}

func tutorConversationReadObject(conn: MyConnection, userId: String, conversationId: String): String {
    let candidates = "SELECT conversation_id,title,archived,course_id,lesson_index,created_at,updated_at FROM tutor_conversations WHERE " +
        tutorConversationOwnerFilter(userId, conversationId)
    let rows = rowsOf(conn.query(tutorConversationDetailsSql(userId, candidates)))
    if (rows.size == 0) { tutorReject(404, "对话不存在") }
    tutorManagedConversationJson(rows[0])
}

func tutorConversationCreateContext(body: JsonObject): (String, Int64) {
    let courseId = tutorString(body, "courseId").trimAscii()
    var lessonIndex: Int64 = -1
    match (body.get("lessonIndex")) {
        case Some(value) =>
            match (value.kind()) {
                case JsonKind.JsInt => lessonIndex = value.asInt().getValue()
                case _ => tutorReject(400, "lessonIndex 必须是整数")
            }
        case None => ()
    }
    if (courseId.size > 100 || lessonIndex < -1 || lessonIndex > 2147483647 ||
        tutorString(body, "lessonTitle").size > 600) {
        tutorReject(400, "课程信息不正确")
    }
    if (courseId.size == 0 && lessonIndex >= 0) { tutorReject(400, "请先选择课程") }
    (courseId, lessonIndex)
}

func tutorConversationCreateBody(cfg: Config, userId: String, body: JsonObject): String {
    let (courseId, lessonIndex) = tutorConversationCreateContext(body)
    let conversationId = "agent-" + uuidFormat(uuidV4())
    let conn = connect(cfg)
    try {
        if (courseId.size > 0) {
            let courses = rowsOf(conn.query("SELECT id FROM courses WHERE id=" + sqlQuote(courseId) +
                " AND status='published' LIMIT 1"))
            if (courses.size == 0) { tutorReject(404, "该课程暂未上架或已下架") }
            if (lessonIndex >= 0) {
                let lessons = rowsOf(conn.query("SELECT lesson_index FROM lessons WHERE course_id=" + sqlQuote(courseId) +
                    " AND is_visible=1 AND COALESCE(display_index,lesson_index)=" + lessonIndex.toString() + " LIMIT 1"))
                if (lessons.size == 0) { tutorReject(404, "该章节暂未发布或已下架") }
            }
        }
        // Names and the initial display title come from database joins, never client-supplied title fields.
        ignoreOk(conn.query("INSERT INTO tutor_conversations(user_id,conversation_id,course_id,lesson_index) VALUES(" +
            sqlQuote(userId) + "," + sqlQuote(conversationId) + "," + sqlQuote(courseId) + "," + lessonIndex.toString() + ")"))
        tutorConversationReadObject(conn, userId, conversationId)
    } finally { conn.close() }
}

// The upsert acquires only this metadata key before touching messages, matching the delete/ensure lock order.
// An inserted row is valid only if legacy messages still exist; a 404 rolls the provisional row back.
func tutorConversationLockExisting(conn: MyConnection, userId: String, conversationId: String): Unit {
    let inserted = match (conn.query("INSERT INTO tutor_conversations(user_id,conversation_id) VALUES(" +
        sqlQuote(userId) + "," + sqlQuote(conversationId) +
        ") ON DUPLICATE KEY UPDATE conversation_id=conversation_id")) {
        case Ok(ok) => ok.affectedRows == 1
        case ResultSet(_) => throw Exception("Expected a conversation write")
    }
    if (inserted) {
        let filter = tutorConversationOwnerFilter(userId, conversationId)
        let rows = rowsOf(conn.query("SELECT DATE_FORMAT(MIN(created_at),'%Y-%m-%d %H:%i:%s.%f') created_at," +
            "DATE_FORMAT(MAX(created_at),'%Y-%m-%d %H:%i:%s.%f') updated_at FROM tutor_messages WHERE " + filter))
        if (rows.size == 0 || rows[0].isNull("created_at")) { tutorReject(404, "对话不存在") }
        ignoreOk(conn.query("UPDATE tutor_conversations SET created_at=" + sqlQuote(rows[0].text("created_at")) +
            ",updated_at=" + sqlQuote(rows[0].text("updated_at")) + " WHERE " + filter))
    }
}

func tutorConversationTransaction(cfg: Config, action: (MyConnection) -> String): String {
    let conn = connect(cfg)
    try {
        ignoreOk(conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"))
        ignoreOk(conn.query("START TRANSACTION"))
        try {
            let result = action(conn)
            ignoreOk(conn.query("COMMIT"))
            result
        } catch (error: Exception) {
            try { ignoreOk(conn.query("ROLLBACK")) } catch (_: Exception) {}
            throw error
        }
    } finally { conn.close() }
}

func tutorConversationUpdateBody(cfg: Config, userId: String, conversationId: String, body: JsonObject): String {
    tutorConversationCheckId(conversationId)
    let assignments = tutorConversationUpdateAssignments(body)
    tutorConversationTransaction(cfg, { conn =>
        tutorConversationLockExisting(conn, userId, conversationId)
        ignoreOk(conn.query("UPDATE tutor_conversations SET " + assignments + " WHERE " +
            tutorConversationOwnerFilter(userId, conversationId)))
        tutorConversationReadObject(conn, userId, conversationId)
    })
}

func tutorConversationDeleteStatements(userId: String, conversationId: String): Array<String> {
    let filter = tutorConversationOwnerFilter(userId, conversationId)
    ["DELETE FROM tutor_messages WHERE " + filter, "DELETE FROM tutor_conversations WHERE " + filter]
}

func tutorConversationDeleteBody(cfg: Config, userId: String, conversationId: String): String {
    tutorConversationCheckId(conversationId)
    tutorConversationTransaction(cfg, { conn =>
        tutorConversationLockExisting(conn, userId, conversationId)
        for (statement in tutorConversationDeleteStatements(userId, conversationId)) { ignoreOk(conn.query(statement)) }
        let out = JsonWriter()
        out.putBool("ok", true)
        out.putStr("conversationId", conversationId)
        out.toJson()
    })
}
