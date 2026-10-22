package zhixun_learning

import std.core.*

func learnerActivityValidKind(kind: String): Bool {
    kind == "lesson" || kind == "lecture" || kind == "bank" || kind == "slides"
}

func learnerActivityRecordSql(userId: String, courseId: String, stableIndex: Int64, kind: String): String {
    if (!learnerActivityValidKind(kind) || userId.size == 0 || courseId.size == 0 ||
        courseId.size > 100 || stableIndex < 0 || stableIndex > 2147483647) {
        throw Exception("Invalid learning activity identity")
    }
    // Generation is deliberately absent: revisiting/replacing a resource cannot darken the same day's cell.
    "INSERT IGNORE INTO learner_activity_days(user_id,activity_date,course_id,lesson_index,kind) VALUES(" +
        sqlQuote(userId) + ",DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR)," + sqlQuote(courseId) + "," +
        stableIndex.toString() + "," + sqlQuote(kind) + ")"
}

func learnerLearningDaysSql(userId: String): String {
    "SELECT COUNT(DISTINCT activity_date) learning_days FROM learner_activity_days WHERE user_id=" + sqlQuote(userId)
}

func learnerLearningDays(cfg: Config, userId: String): Int64 {
    let rows = queryIndependent(cfg, learnerLearningDaysSql(userId))
    if (rows.size == 0) { 0 } else { rows[0].int("learning_days") }
}

func learnerActivityDaysSql(userId: String, startDate: String, endDate: String): String {
    "SELECT DATE_FORMAT(activity_date,'%Y-%m-%d') activity_date,COUNT(*) activity_count " +
        "FROM learner_activity_days WHERE user_id=" + sqlQuote(userId) +
        " AND activity_date BETWEEN " + sqlQuote(startDate) + " AND " + sqlQuote(endDate) +
        " GROUP BY activity_date ORDER BY activity_date ASC"
}

func learnerPopularResourcesSql(): String {
    // Match the same source fallback as cwSourceDocId; progress uses stable identities, navigation uses display order.
    let source = "COALESCE(NULLIF(l.source_doc_id,''),CASE WHEN " +
        "JSON_UNQUOTE(JSON_EXTRACT(l.sources_json,'$[0].kind'))='kb-courseware' THEN " +
        "JSON_UNQUOTE(JSON_EXTRACT(l.sources_json,'$[0].id')) ELSE NULL END)"
    "SELECT w.id,w.title,c.id course_id,c.name course_name," +
        "COALESCE(l.display_index,l.lesson_index) lesson_index,l.title lesson_title,w.kind," +
        "COUNT(DISTINCT p.user_id) learner_count FROM lessons l " +
        "JOIN courses c ON c.id=l.course_id " +
        "JOIN kb_courseware w ON w.doc_id=" + source +
        " AND w.is_current=1 AND w.status='ready' AND w.published=1 AND w.kind IN ('lecture','bank','slides') " +
        "LEFT JOIN lesson_resource_progress p ON p.course_id=l.course_id AND p.lesson_index=l.lesson_index " +
        "AND p.kind=w.kind AND p.generation=w.generation AND (p.is_read=1 OR p.completed=1 OR p.score IS NOT NULL) " +
        "WHERE c.status='published' AND l.is_visible=1 " +
        "GROUP BY w.id,w.title,c.id,c.name,l.lesson_index,l.display_index,l.title,w.kind " +
        "ORDER BY learner_count DESC,course_id ASC,lesson_index ASC,kind ASC,id ASC LIMIT 8"
}

func learnerActivityJson(today: String, startDate: String, days: Array<Row>, learningDays: Int64): String {
    let items = JsonArrWriter()
    for (row in days) {
        if (row.int("activity_count") <= 0) { continue }
        let item = JsonWriter()
        item.putStr("date", row.text("activity_date"))
        item.putInt("count", row.int("activity_count"))
        items.addRaw(item.toJson())
    }
    let out = JsonWriter()
    out.putStr("today", today)
    out.putStr("startDate", startDate)
    out.putStr("endDate", today)
    out.putRaw("days", items.toJson())
    out.putInt("learningDays", learningDays)
    out.toJson()
}

func learnerPopularResourcesJson(rows: Array<Row>): String {
    let items = JsonArrWriter()
    var count: Int64 = 0
    for (row in rows) {
        let kind = row.text("kind")
        if (!cwValidKind(kind)) { continue }
        if (count >= 8) { break }
        let item = JsonWriter()
        let title = row.text("title").trimAscii()
        item.putStr("id", row.text("id"))
        item.putStr("title", if (title.size > 0) { title } else { row.text("lesson_title") + " · " + cwLabel(kind) })
        item.putStr("courseId", row.text("course_id"))
        item.putStr("courseName", row.text("course_name"))
        item.putInt("lessonIndex", row.int("lesson_index"))
        item.putStr("lessonTitle", row.text("lesson_title"))
        item.putStr("kind", kind)
        item.putInt("learnerCount", row.int("learner_count"))
        items.addRaw(item.toJson())
        count += 1
    }
    items.toJson()
}

func learnerDashboardBody(cfg: Config, userId: String): String {
    let conn = connect(cfg)
    try {
        ignoreOk(conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY"))
        try {
            // Capture the Beijing date once so a request crossing midnight keeps one consistent 140-day window.
            let clock = rowsOf(conn.query("SELECT DATE_FORMAT(DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR),'%Y-%m-%d') today," +
                "DATE_FORMAT(DATE_SUB(DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR),INTERVAL 139 DAY),'%Y-%m-%d') start_date"))
            if (clock.size == 0) { throw Exception("Learning activity clock unavailable") }
            let today = clock[0].text("today")
            let startDate = clock[0].text("start_date")
            let days = rowsOf(conn.query(learnerActivityDaysSql(userId, startDate, today)))
            let totals = rowsOf(conn.query(learnerLearningDaysSql(userId)))
            let popular = rowsOf(conn.query(learnerPopularResourcesSql()))
            let out = JsonWriter()
            out.putRaw("activity", learnerActivityJson(today, startDate, days,
                if (totals.size == 0) { 0 } else { totals[0].int("learning_days") }))
            out.putRaw("popularResources", learnerPopularResourcesJson(popular))
            ignoreOk(conn.query("COMMIT"))
            out.toJson()
        } catch (error: Exception) {
            try { ignoreOk(conn.query("ROLLBACK")) } catch (_: Exception) {}
            throw error
        }
    } finally { conn.close() }
}
