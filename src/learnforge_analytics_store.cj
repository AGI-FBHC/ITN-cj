package itn_spire

import std.core.*
import std.collection.*
import std.convert.*

/*
 * P2 batch 2: the aggregate reads behind
 *   GET /api/v1/learner-profile
 *   GET /api/v1/learner-profile/journal
 *
 * Mirrors service/LearningAnalyticsService.java (395 lines) and the derived
 * queries on StudySessionRepository / LearningEventRepository /
 * QuizResultRepository / KnowledgeMasteryRepository /
 * LearningDailySummaryRepository. The behaviours that are easy to lose live in
 * the service, not here — this file is only "the rows Java would see".
 *
 * Two wire-format facts this layer has to serve:
 *
 *   1. Every *_at column below is timestamp(6). MySQL renders those in the
 *      session time zone (SYSTEM = UTC+08:00 here) while java.time.Instant is
 *      absolute and ISO_INSTANT prints UTC, so every timestamp cell is passed
 *      through shiftTimestampText. DATE columns (session_date, summary_date,
 *      target_date) are a naked calendar day and are left alone.
 *
 *   2. Java's `Between` is `>=` AND `<=` — both ends inclusive. The journal
 *      window is [target 00:00 Asia/Shanghai, target+1 00:00 Asia/Shanghai),
 *      but as a SQL BETWEEN it also admits a row sitting exactly on the closing
 *      boundary, so that instant lands in both adjacent days. Reproduce it.
 */
public class LearnForgeAnalyticsStore {
    private let conn: MyConnection
    private let utcOff: Int64

    public init(conn: MyConnection) {
        this.conn = conn
        this.utcOff = dbUtcOffsetMicros(conn)
    }

    /* -------- learning_goals (CurrentGoalInfo) -------- */

    /*
     * The goal hanging off user_profiles.current_goal_id, plus the domain name
     * that CurrentGoalInfo prefers over the goal's own title. A LEFT JOIN
     * because knowledge_domain_id is nullable.
     */
    public func getGoalInfo(goalId: Array<Byte>): ?RawGoalInfo {
        let sql = "SELECT g.title, d.name, g.goal_type, g.expected_level," +
            " g.status, g.target_date, g.created_at, g.knowledge_domain_id" +
            " FROM learning_goals g" +
            " LEFT JOIN knowledge_domain d ON d.id = g.knowledge_domain_id" +
            " WHERE g.id=" + sqlBinary(goalId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                let row = rs.rows[0]
                return Some(RawGoalInfo(
                    cellText(row, 0),
                    optCellText(row, 1),
                    cellText(row, 2),
                    cellText(row, 3),
                    cellText(row, 4),
                    optCellText(row, 5),
                    shiftTimestampText(cellText(row, 6), utcOff),
                    optCellInt(row, 7)))
        }
    }

    /* -------- study_sessions (StudyStatsInfo + streak) -------- */

    /* StudySessionRepository.countByUserId */
    public func countSessions(userId: Array<Byte>): Int64 {
        let sql = "SELECT COUNT(*) FROM study_sessions WHERE user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return 0
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return 0
                }
                return Int64.tryParse(rs.rows[0][0].text()) ?? 0
        }
    }

    /*
     * StudySessionRepository.totalDurationByUserId — SUM over an empty set is
     * NULL, which Java turns into 0 minutes. COALESCE keeps that here.
     */
    public func sumSessionSeconds(userId: Array<Byte>): Int64 {
        let sql = "SELECT COALESCE(SUM(total_duration_seconds),0)" +
            " FROM study_sessions WHERE user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return 0
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return 0
                }
                return Int64.tryParse(rs.rows[0][0].text()) ?? 0
        }
    }

    /*
     * findByUserIdAndSessionDateBetweenOrderBySessionDate — both ends
     * inclusive, ascending. Every row is returned (Java's toMap would throw on
     * a duplicate session_date; the table is keyed so that cannot happen, and
     * Spire just keeps the last row rather than failing the request).
     */
    public func listSessionsInRange(userId: Array<Byte>, from: CivilDate, to: CivilDate): Array<RawSessionDay> {
        let sql = "SELECT session_date, total_duration_seconds FROM study_sessions" +
            " WHERE user_id=" + sqlBinary(userId) +
            " AND session_date BETWEEN " + sqlQuote(dateIsoText(from)) +
            " AND " + sqlQuote(dateIsoText(to)) +
            " ORDER BY session_date ASC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<RawSessionDay>(0, repeat: RawSessionDay())
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<RawSessionDay>()
                for (row in rs.rows) {
                    out.add(RawSessionDay(cellText(row, 0), optCellInt(row, 1) ?? 0))
                }
                return out.toArray()
        }
    }

    /* findRecentByUserId — every session, newest first. Drives the streak. */
    public func listSessionDatesDesc(userId: Array<Byte>): Array<String> {
        let sql = "SELECT session_date FROM study_sessions WHERE user_id=" + sqlBinary(userId) +
            " ORDER BY session_date DESC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<String>(0, repeat: "")
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<String>()
                for (row in rs.rows) {
                    out.add(cellText(row, 0))
                }
                return out.toArray()
        }
    }

    /* -------- learning_events (eventDistribution + journal) -------- */

    /*
     * countBySourceTypeGrouped. The JPQL has no ORDER BY, so the map's key
     * order is whatever MySQL groups into — not specified here either.
     *
     * The window is NOT the journal window: the service asks for
     *   from = (UTC today - 30).atStartOfDay(UTC)
     *   to   = Instant.now()
     * so the lower bound is UTC midnight regardless of USER_ZONE. `todayUtc`
     * is LocalDate.now(ZoneOffset.UTC) and `nowUtcMicros` is Instant.now().
     */
    public func listSourceCounts(userId: Array<Byte>, todayUtc: CivilDate,
                                 nowUtcMicros: Int64): Array<RawSourceCount> {
        let monthAgo = addDays(todayUtc, -30)
        let fromMicros = timePartsToEpochMicros(
            TimeParts(monthAgo.year, monthAgo.month, monthAgo.day, 0, 0, 0, 0))
        let from = sqlQuote(mysqlDatetime(epochMicrosToTimeParts(fromMicros + utcOff)))
        let to = sqlQuote(mysqlDatetime(epochMicrosToTimeParts(nowUtcMicros + utcOff)))
        let sql = "SELECT source_type, COUNT(*) FROM learning_events" +
            " WHERE user_id=" + sqlBinary(userId) +
            " AND created_at BETWEEN " + from + " AND " + to +
            " GROUP BY source_type"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<RawSourceCount>(0, repeat: RawSourceCount())
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<RawSourceCount>()
                for (row in rs.rows) {
                    out.add(RawSourceCount(cellText(row, 0), optCellInt(row, 1) ?? 0))
                }
                return out.toArray()
        }
    }

    /*
     * The journal window, as SQL literals against the session's wall clock.
     *
     * Java asks for the absolute range
     *   [target 00:00 Asia/Shanghai, target+1 00:00 Asia/Shanghai)
     * which in UTC is exactly [target-1 16:00, target 16:00]. Adding the
     * session offset turns that into the local wall clock the column is
     * compared against, so a session at +08:00 lands on [target 00:00:00,
     * target+1 00:00:00) and a UTC session on [target-1 16:00, target 16:00).
     * JPA's Between is inclusive on both ends, so a row exactly on the
     * closing boundary is returned for both adjacent days.
     */
    private func journalWindow(target: CivilDate): (String, String) {
        let fromD = addDays(target, -1)
        let toD = target
        let fromMicros = timePartsToEpochMicros(
            TimeParts(fromD.year, fromD.month, fromD.day, 16, 0, 0, 0))
        let toMicros = timePartsToEpochMicros(
            TimeParts(toD.year, toD.month, toD.day, 16, 0, 0, 0))
        return (sqlQuote(mysqlDatetime(epochMicrosToTimeParts(fromMicros + utcOff))),
                sqlQuote(mysqlDatetime(epochMicrosToTimeParts(toMicros + utcOff))))
    }

    /*
     * findByUserIdAndCreatedAtBetweenOrderByCreatedAtDesc — DESC, both ends
     * inclusive. The category name is joined here because TimelineItem's
     * knowledgeName prefers it over the metadata's "knowledgePoint".
     */
    public func listJournalEvents(userId: Array<Byte>, target: CivilDate): Array<RawJournalEvent> {
        let win = journalWindow(target)
        let sql = "SELECT e.id, e.event_type, e.source_type, c.name," +
            " e.duration_seconds, e.metadata, e.created_at" +
            " FROM learning_events e" +
            " LEFT JOIN knowledge_category c ON c.id = e.knowledge_category_id" +
            " WHERE e.user_id=" + sqlBinary(userId) +
            " AND e.created_at BETWEEN " + win[0] + " AND " + win[1] +
            " ORDER BY e.created_at DESC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<RawJournalEvent>(0, repeat: RawJournalEvent())
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<RawJournalEvent>()
                for (row in rs.rows) {
                    out.add(RawJournalEvent(
                        row[0].bytes,
                        cellText(row, 1),
                        cellText(row, 2),
                        optCellText(row, 3),
                        optCellInt(row, 4),
                        optCellText(row, 5),
                        shiftTimestampText(cellText(row, 6), utcOff)))
                }
                return out.toArray()
        }
    }

    /* -------- quiz_results (recentQuizzes + journal) -------- */

    /* findTop10ByUserIdOrderByCreatedAtDesc. */
    public func listRecentQuizzes(userId: Array<Byte>): Array<RawQuizSummary> {
        let sql = "SELECT q.quiz_type, q.score, c.name, q.created_at" +
            " FROM quiz_results q" +
            " LEFT JOIN knowledge_category c ON c.id = q.knowledge_category_id" +
            " WHERE q.user_id=" + sqlBinary(userId) +
            " ORDER BY q.created_at DESC LIMIT 10"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<RawQuizSummary>(0, repeat: RawQuizSummary())
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<RawQuizSummary>()
                for (row in rs.rows) {
                    out.add(RawQuizSummary(
                        cellText(row, 0),
                        optCellText(row, 1),
                        optCellText(row, 2),
                        shiftTimestampText(cellText(row, 3), utcOff)))
                }
                return out.toArray()
        }
    }

    /* findByUserIdAndCreatedAtBetweenOrderByCreatedAtAsc — ASC, both ends inclusive. */
    public func listJournalQuizzes(userId: Array<Byte>, target: CivilDate): Array<RawJournalQuiz> {
        let win = journalWindow(target)
        let sql = "SELECT q.id, q.question_count, q.correct_count, q.duration_seconds," +
            " q.difficulty_level, c.name, q.created_at" +
            " FROM quiz_results q" +
            " LEFT JOIN knowledge_category c ON c.id = q.knowledge_category_id" +
            " WHERE q.user_id=" + sqlBinary(userId) +
            " AND q.created_at BETWEEN " + win[0] + " AND " + win[1] +
            " ORDER BY q.created_at ASC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<RawJournalQuiz>(0, repeat: RawJournalQuiz())
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<RawJournalQuiz>()
                for (row in rs.rows) {
                    out.add(RawJournalQuiz(
                        row[0].bytes,
                        optCellInt(row, 1) ?? 0,
                        optCellInt(row, 2) ?? 0,
                        optCellInt(row, 3),
                        optCellText(row, 4),
                        optCellText(row, 5),
                        shiftTimestampText(cellText(row, 6), utcOff)))
                }
                return out.toArray()
        }
    }

    /* -------- knowledge_mastery (MasteryInfo) -------- */

    /*
     * findByUserIdOrderByMasteryScoreDesc. knowledgeCategory is optional=false
     * on the entity, so the join is inner — a dangling category id is a data
     * error Java would fail on too.
     *
     * Ties on mastery_score are left in whatever order MySQL returns them,
     * exactly as the derived query does.
     */
    public func listMastery(userId: Array<Byte>): Array<RawMasteryRow> {
        let sql = "SELECT km.knowledge_category_id, c.name, km.mastery_score," +
            " km.attempt_count" +
            " FROM knowledge_mastery km" +
            " JOIN knowledge_category c ON c.id = km.knowledge_category_id" +
            " WHERE km.user_id=" + sqlBinary(userId) +
            " ORDER BY km.mastery_score DESC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<RawMasteryRow>(0, repeat: RawMasteryRow())
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<RawMasteryRow>()
                for (row in rs.rows) {
                    out.add(RawMasteryRow(
                        optCellInt(row, 0) ?? 0,
                        cellText(row, 1),
                        cellText(row, 2),
                        optCellInt(row, 3) ?? 0))
                }
                return out.toArray()
        }
    }

    /* -------- learning_daily_summaries (DailySummary) -------- */

    /* findByUserIdAndSummaryDate. */
    public func getDailySummary(userId: Array<Byte>, summaryDate: CivilDate): ?RawDailySummary {
        let sql = "SELECT summary_text, metrics_json, generated_at" +
            " FROM learning_daily_summaries" +
            " WHERE user_id=" + sqlBinary(userId) +
            " AND summary_date=" + sqlQuote(dateIsoText(summaryDate))
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                let row = rs.rows[0]
                return Some(RawDailySummary(
                    cellText(row, 0),
                    cellText(row, 1),
                    shiftTimestampText(cellText(row, 2), utcOff)))
        }
    }
}

/* ============ row shapes ============ */

/*
 * The slice of learning_goals CurrentGoalInfo needs. `createdAtUtc` is already
 * shifted to UTC: calculateGoalProgress takes the UTC date of the Instant.
 *
 * `domainId` is selected alongside `domainName` because the title fallback is
 * `knowledgeDomain == null ? goal.title : knowledgeDomain.getName()`: a NULL
 * FK means use the title, a NULL `name` on an existing domain means emit null.
 * A FK pointing at a missing domain row is an integrity error Java would fail
 * on; Spire emits null instead of 500.
 */
public struct RawGoalInfo {
    public let title: String
    public let domainName: ?String
    public let goalType: String
    public let expectedLevel: String
    public let status: String
    public let targetDate: ?String
    public let createdAtUtc: String
    public let domainId: ?Int64

    public init() {
        title = ""; domainName = None; goalType = ""; expectedLevel = ""
        status = ""; targetDate = None; createdAtUtc = ""; domainId = None
    }

    public init(title: String, domainName: ?String, goalType: String, expectedLevel: String,
                status: String, targetDate: ?String, createdAtUtc: String, domainId: ?Int64) {
        this.title = title
        this.domainName = domainName
        this.goalType = goalType
        this.expectedLevel = expectedLevel
        this.status = status
        this.targetDate = targetDate
        this.createdAtUtc = createdAtUtc
        this.domainId = domainId
    }
}

public struct RawSessionDay {
    public let sessionDate: String
    public let totalDurationSeconds: Int64

    public init() {
        sessionDate = ""
        totalDurationSeconds = 0
    }

    public init(sessionDate: String, totalDurationSeconds: Int64) {
        this.sessionDate = sessionDate
        this.totalDurationSeconds = totalDurationSeconds
    }
}

public struct RawSourceCount {
    public let sourceType: String
    public let count: Int64

    public init() {
        sourceType = ""
        count = 0
    }

    public init(sourceType: String, count: Int64) {
        this.sourceType = sourceType
        this.count = count
    }
}

/*
 * mastery_score stays as the decimal(5,4) text: CategoryMastery.score is
 * BigDecimal.doubleValue(), which is the correctly-rounded double of that
 * decimal — javaDoubleFromText is the exact conversion.
 */
public struct RawMasteryRow {
    public let categoryId: Int64
    public let categoryName: String
    public let scoreText: String
    public let attemptCount: Int64

    public init() {
        categoryId = 0
        categoryName = ""
        scoreText = "0"
        attemptCount = 0
    }

    public init(categoryId: Int64, categoryName: String, scoreText: String, attemptCount: Int64) {
        this.categoryId = categoryId
        this.categoryName = categoryName
        this.scoreText = scoreText
        this.attemptCount = attemptCount
    }
}

/* score is decimal(5,2) and nullable — QuizSummary.score is a boxed Double. */
public struct RawQuizSummary {
    public let quizType: String
    public let scoreText: ?String
    public let categoryName: ?String
    public let createdAtUtc: String

    public init() {
        quizType = ""
        scoreText = None
        categoryName = None
        createdAtUtc = ""
    }

    public init(quizType: String, scoreText: ?String, categoryName: ?String, createdAtUtc: String) {
        this.quizType = quizType
        this.scoreText = scoreText
        this.categoryName = categoryName
        this.createdAtUtc = createdAtUtc
    }
}

public struct RawJournalEvent {
    public let id: Array<Byte>
    public let eventType: String
    public let sourceType: String
    public let categoryName: ?String
    public let durationSeconds: ?Int64
    public let metadataJson: ?String
    public let createdAtUtc: String

    public init() {
        id = Array<Byte>(0, repeat: 0)
        eventType = ""
        sourceType = ""
        categoryName = None
        durationSeconds = None
        metadataJson = None
        createdAtUtc = ""
    }

    public init(id: Array<Byte>, eventType: String, sourceType: String, categoryName: ?String,
                durationSeconds: ?Int64, metadataJson: ?String, createdAtUtc: String) {
        this.id = id
        this.eventType = eventType
        this.sourceType = sourceType
        this.categoryName = categoryName
        this.durationSeconds = durationSeconds
        this.metadataJson = metadataJson
        this.createdAtUtc = createdAtUtc
    }
}

public struct RawJournalQuiz {
    public let id: Array<Byte>
    public let questionCount: Int64
    public let correctCount: Int64
    public let durationSeconds: ?Int64
    public let difficultyLevel: ?String
    public let categoryName: ?String
    public let createdAtUtc: String

    public init() {
        id = Array<Byte>(0, repeat: 0)
        questionCount = 0
        correctCount = 0
        durationSeconds = None
        difficultyLevel = None
        categoryName = None
        createdAtUtc = ""
    }

    public init(id: Array<Byte>, questionCount: Int64, correctCount: Int64,
                durationSeconds: ?Int64, difficultyLevel: ?String,
                categoryName: ?String, createdAtUtc: String) {
        this.id = id
        this.questionCount = questionCount
        this.correctCount = correctCount
        this.durationSeconds = durationSeconds
        this.difficultyLevel = difficultyLevel
        this.categoryName = categoryName
        this.createdAtUtc = createdAtUtc
    }
}

public struct RawDailySummary {
    public let content: String
    public let metricsJson: String
    public let generatedAtUtc: String

    public init() {
        content = ""
        metricsJson = ""
        generatedAtUtc = ""
    }

    public init(content: String, metricsJson: String, generatedAtUtc: String) {
        this.content = content
        this.metricsJson = metricsJson
        this.generatedAtUtc = generatedAtUtc
    }
}
