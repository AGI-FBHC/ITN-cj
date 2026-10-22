package itn_spire

import std.core.*
import std.collection.*
import std.convert.*

/*
 * P2 batch 6 store: write side for learner-profile.
 *   POST /api/v1/learner-profile/events
 *   POST /api/v1/learner-profile/quiz
 *   POST /api/v1/learner-profile/journal/summary
 *
 * Mirrors LearningAnalyticsService.recordEvent/recordQuizResult/
 * generateJournalSummary + StudySession.addEvent + KnowledgeMastery.recordAttempt.
 */
public class LearnForgeWriteStore {
    private let conn: MyConnection
    private let utcOff: Int64

    public init(conn: MyConnection) {
        this.conn = conn
        this.utcOff = dbUtcOffsetMicros(conn)
    }

    /* -------- learning_events -------- */

    public func insertEvent(userId: Array<Byte>, eventType: String, sourceType: String,
                             sourceId: ?String, knowledgeCategoryId: ?Int64,
                             durationSeconds: ?Int64, metadata: ?String): Array<Byte> {
        let id = uuidV4()
        var srcId = "NULL"
        match (sourceId) {
            case Some(s) => srcId = sqlQuote(s)
            case None => ()
        }
        var catId = "NULL"
        match (knowledgeCategoryId) {
            case Some(n) => catId = n.toString()
            case None => ()
        }
        var dur = "NULL"
        match (durationSeconds) {
            case Some(d) => dur = d.toString()
            case None => ()
        }
        var meta = "NULL"
        match (metadata) {
            case Some(m) => meta = sqlQuote(m)
            case None => ()
        }
        let sql = "INSERT INTO learning_events (id, user_id, event_type, source_type," +
            " source_id, knowledge_category_id, duration_seconds, metadata, created_at)" +
            " VALUES (" + sqlBinary(id) + "," + sqlBinary(userId) + "," +
            sqlQuote(eventType) + "," + sqlQuote(sourceType) + "," +
            srcId + "," + catId + "," + dur + "," + meta + ",NOW(6))"
        match (conn.query(sql)) {
            case _ => return id
        }
    }

    /* -------- study_sessions (addEvent) -------- */

    /*
     * Find-or-create today's session and apply addEvent:
     *   eventCount++, totalDurationSeconds += duration (if > 0),
     *   then increment chatCount/resourceCount/quizCount by sourceType.
     * today is LocalDate.now(Asia/Shanghai).
     */
    public func upsertSessionEvent(userId: Array<Byte>, sourceType: String,
                                    durationSeconds: ?Int64): Unit {
        let today = nowUtc8Date()
        let todayStr = dateIsoText(today)
        /* find existing */
        var eventId: ?Array<Byte> = None
        var totalDur: Int64 = 0
        var evCount: Int64 = 0
        var chatCount: Int64 = 0
        var resCount: Int64 = 0
        var quizCount: Int64 = 0
        let sel = "SELECT id, total_duration_seconds, event_count, chat_count," +
            " resource_count, quiz_count FROM study_sessions" +
            " WHERE user_id=" + sqlBinary(userId) +
            " AND session_date=" + sqlQuote(todayStr) + " LIMIT 1"
        match (conn.query(sel)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                if (!rs.rows.isEmpty()) {
                    let row = rs.rows[0]
                    eventId = Some(row[0].bytes)
                    totalDur = optCellInt(row, 1) ?? 0
                    evCount = optCellInt(row, 2) ?? 0
                    chatCount = optCellInt(row, 3) ?? 0
                    resCount = optCellInt(row, 4) ?? 0
                    quizCount = optCellInt(row, 5) ?? 0
                }
        }
        /* apply addEvent */
        evCount += 1
        match (durationSeconds) {
            case Some(d) =>
                if (d > 0) { totalDur += d }
            case None => ()
        }
        if (sourceType == "CHAT") {
            chatCount += 1
        } else if (sourceType == "RESOURCE" || sourceType == "KNOWLEDGE_BASE") {
            resCount += 1
        } else if (sourceType == "QUIZ") {
            quizCount += 1
        }
        match (eventId) {
            case Some(id) =>
                let upd = "UPDATE study_sessions SET total_duration_seconds=" + totalDur.toString() +
                    ", event_count=" + evCount.toString() +
                    ", chat_count=" + chatCount.toString() +
                    ", resource_count=" + resCount.toString() +
                    ", quiz_count=" + quizCount.toString() +
                    ", updated_at=NOW(6) WHERE id=" + sqlBinary(id)
                match (conn.query(upd)) { case _ => () }
            case None =>
                let ins = "INSERT INTO study_sessions (id, user_id, session_date," +
                    " total_duration_seconds, event_count, chat_count, resource_count," +
                    " quiz_count, created_at, updated_at) VALUES (" +
                    sqlBinary(uuidV4()) + "," + sqlBinary(userId) + "," +
                    sqlQuote(todayStr) + "," + totalDur.toString() + "," +
                    evCount.toString() + "," + chatCount.toString() + "," +
                    resCount.toString() + "," + quizCount.toString() +
                    ",NOW(6),NOW(6))"
                match (conn.query(ins)) { case _ => () }
        }
    }

    /* -------- quiz_results -------- */

    public func insertQuizResult(userId: Array<Byte>, quizType: String,
                                  knowledgeCategoryId: ?Int64, questionCount: Int64,
                                  correctCount: Int64, score: ?String,
                                  durationSeconds: ?Int64, difficultyLevel: ?String,
                                  details: ?String): Array<Byte> {
        let id = uuidV4()
        var catId = "NULL"
        match (knowledgeCategoryId) {
            case Some(n) => catId = n.toString()
            case None => ()
        }
        var scoreVal = "NULL"
        match (score) {
            case Some(s) => scoreVal = s
            case None => ()
        }
        var dur = "NULL"
        match (durationSeconds) {
            case Some(d) => dur = d.toString()
            case None => ()
        }
        var diff = "NULL"
        match (difficultyLevel) {
            case Some(d) => diff = sqlQuote(d)
            case None => ()
        }
        var det = "NULL"
        match (details) {
            case Some(d) => det = sqlQuote(d)
            case None => ()
        }
        let sql = "INSERT INTO quiz_results (id, user_id, quiz_type," +
            " knowledge_category_id, question_count, correct_count, score," +
            " duration_seconds, difficulty_level, details, created_at) VALUES (" +
            sqlBinary(id) + "," + sqlBinary(userId) + "," + sqlQuote(quizType) + "," +
            catId + "," + questionCount.toString() + "," + correctCount.toString() + "," +
            scoreVal + "," + dur + "," + diff + "," + det + ",NOW(6))"
        match (conn.query(sql)) {
            case _ => return id
        }
    }

    /* -------- knowledge_mastery (recordAttempt × questionCount) -------- */

    /*
     * EMA update loop: for i in 0..questionCount-1, recordAttempt(i < correctCount).
     * alpha = 0.3; newScore = alpha * (correct ? 1 : 0) + (1 - alpha) * oldScore;
     * masteryScore = BigDecimal.valueOf(Math.round(newScore * 10000) / 10000.0)
     */
    public func updateMastery(userId: Array<Byte>, knowledgeCategoryId: Int64,
                               questionCount: Int64, correctCount: Int64): Unit {
        /* find or create */
        var masteryId: ?Array<Byte> = None
        var score: Float64 = 0.0
        var attempts: Int64 = 0
        var corrects: Int64 = 0
        var streakC: Int64 = 0
        var streakW: Int64 = 0
        let sel = "SELECT id, mastery_score, attempt_count, correct_count," +
            " streak_correct, streak_wrong FROM knowledge_mastery" +
            " WHERE user_id=" + sqlBinary(userId) +
            " AND knowledge_category_id=" + knowledgeCategoryId.toString() + " LIMIT 1"
        match (conn.query(sel)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                if (!rs.rows.isEmpty()) {
                    let row = rs.rows[0]
                    masteryId = Some(row[0].bytes)
                    score = javaDoubleFromText(cellText(row, 1)) ?? 0.0
                    attempts = optCellInt(row, 2) ?? 0
                    corrects = optCellInt(row, 3) ?? 0
                    streakC = optCellInt(row, 4) ?? 0
                    streakW = optCellInt(row, 5) ?? 0
                }
        }
        /* apply recordAttempt × questionCount */
        var i: Int64 = 0
        while (i < questionCount) {
            let correct = i < correctCount
            attempts += 1
            if (correct) {
                corrects += 1
                streakC += 1
                streakW = 0
            } else {
                streakW += 1
                streakC = 0
            }
            let newValue = if (correct) { 1.0 } else { 0.0 }
            let newScore = 0.3 * newValue + 0.7 * score
            /* BigDecimal.valueOf(Math.round(newScore * 10000) / 10000.0) */
            score = Float64(javaMathRound(newScore * 10000.0)) / 10000.0
            i += 1
        }
        /* persist */
        let scoreStr = formatScale4Mastery(score)
        match (masteryId) {
            case Some(id) =>
                let upd = "UPDATE knowledge_mastery SET mastery_score=" + scoreStr +
                    ", attempt_count=" + attempts.toString() +
                    ", correct_count=" + corrects.toString() +
                    ", streak_correct=" + streakC.toString() +
                    ", streak_wrong=" + streakW.toString() +
                    ", last_attempt_at=NOW(6), updated_at=NOW(6)" +
                    " WHERE id=" + sqlBinary(id)
                match (conn.query(upd)) { case _ => () }
            case None =>
                let ins = "INSERT INTO knowledge_mastery (id, user_id," +
                    " knowledge_category_id, mastery_score, attempt_count," +
                    " correct_count, last_attempt_at, streak_correct," +
                    " streak_wrong, updated_at) VALUES (" +
                    sqlBinary(uuidV4()) + "," + sqlBinary(userId) + "," +
                    knowledgeCategoryId.toString() + "," + scoreStr + "," +
                    attempts.toString() + "," + corrects.toString() + ",NOW(6)," +
                    streakC.toString() + "," + streakW.toString() + ",NOW(6))"
                match (conn.query(ins)) { case _ => () }
        }
    }

    /* -------- learning_daily_summaries (upsert) -------- */

    public func upsertDailySummary(userId: Array<Byte>, summaryDate: String,
                                    content: String, metricsJson: String): String {
        /* find existing */
        var existingId: ?Array<Byte> = None
        var generatedAt = ""
        let sel = "SELECT id, generated_at FROM learning_daily_summaries" +
            " WHERE user_id=" + sqlBinary(userId) +
            " AND summary_date=" + sqlQuote(summaryDate) + " LIMIT 1"
        match (conn.query(sel)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                if (!rs.rows.isEmpty()) {
                    existingId = Some(rs.rows[0][0].bytes)
                    generatedAt = shiftTimestampText(cellText(rs.rows[0], 1), utcOff)
                }
        }
        match (existingId) {
            case Some(id) =>
                let upd = "UPDATE learning_daily_summaries SET summary_text=" + sqlQuote(content) +
                    ", metrics_json=" + sqlQuote(metricsJson) +
                    ", generated_at=NOW(6), updated_at=NOW(6) WHERE id=" + sqlBinary(id)
                match (conn.query(upd)) { case _ => () }
                /* re-read generated_at */
                let sel2 = "SELECT generated_at FROM learning_daily_summaries WHERE id=" + sqlBinary(id)
                match (conn.query(sel2)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs2) =>
                        if (!rs2.rows.isEmpty()) {
                            generatedAt = shiftTimestampText(cellText(rs2.rows[0], 0), utcOff)
                        }
                }
            case None =>
                let id = uuidV4()
                /* learning_daily_summaries has no created_at column —
                 * only generated_at + updated_at. */
                let ins = "INSERT INTO learning_daily_summaries (id, user_id," +
                    " summary_date, summary_text, metrics_json, generated_at," +
                    " updated_at) VALUES (" +
                    sqlBinary(id) + "," + sqlBinary(userId) + "," +
                    sqlQuote(summaryDate) + "," + sqlQuote(content) + "," +
                    sqlQuote(metricsJson) + ",NOW(6),NOW(6))"
                match (conn.query(ins)) { case _ => () }
                let sel2 = "SELECT generated_at FROM learning_daily_summaries WHERE id=" + sqlBinary(id)
                match (conn.query(sel2)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs2) =>
                        if (!rs2.rows.isEmpty()) {
                            generatedAt = shiftTimestampText(cellText(rs2.rows[0], 0), utcOff)
                        }
                }
        }
        return generatedAt
    }
}

/*
 * BigDecimal.valueOf(Math.round(newScore * 10000) / 10000.0).toString()
 * → 4 decimal places, e.g. "0.7000", "0.4900".
 */
func formatScale4Mastery(x: Float64): String {
    var neg = false
    var v = x
    if (v < 0.0) {
        neg = true
        v = 0.0 - v
    }
    let scaled = javaMathRound(v * 10000.0)
    let whole = scaled / 10000
    var frac = (scaled - whole * 10000).toString()
    while (frac.size < 4) {
        frac = "0" + frac
    }
    let sign = if (neg) { "-" } else { "" }
    return sign + whole.toString() + "." + frac
}
