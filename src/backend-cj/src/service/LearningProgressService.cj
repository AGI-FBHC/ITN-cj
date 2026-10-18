package web.service

import std.convert.*
import std.regex.Regex
import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.security.AuthUtilities

public class LearningProgressService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func profile(user: User): String {
        return DbTransaction.run<String>(database, { tx =>
            let uid = AuthUtilities.uuidSql(user.getId())
            let result = JsonObject()
            let profiles = tx.query("SELECT education_level, major, learning_preference, technical_foundation FROM user_profiles WHERE user_id = " + uid)
            result.put("profile", JsonValue.fromStr(ProfileJson.row(["educationLevel", "major", "learningPreference", "technicalFoundation"],
                if (profiles.isEmpty()) { Array<Option<String>>(4, { _ => None }) } else { profiles[0] }, [])))
            let goals = tx.query("SELECT COALESCE(d.name, g.title), g.goal_type, g.expected_level, " +
                "CASE WHEN g.status = 'COMPLETED' THEN 1.0 WHEN g.target_date IS NULL OR DATEDIFF(g.target_date, DATE(g.created_at)) <= 0 " +
                "THEN 0.0 ELSE LEAST(1.0, GREATEST(0.0, DATEDIFF(UTC_DATE(), DATE(g.created_at)) / DATEDIFF(g.target_date, DATE(g.created_at)))) END " +
                "FROM user_profiles p JOIN learning_goals g ON g.id = p.current_goal_id LEFT JOIN knowledge_domain d ON d.id = g.knowledge_domain_id " +
                "WHERE p.user_id = " + uid)
            result.put("currentGoal", if (goals.isEmpty()) { JsonValue.fromStr("null") } else {
                JsonValue.fromStr(ProfileJson.row(["title", "goalType", "expectedLevel", "progress"], goals[0], [3]))
            })
            result.put("stats", studyStats(tx, user))
            let mastered = tx.query("SELECT c.id, c.name, m.mastery_score, m.attempt_count FROM knowledge_mastery m " +
                "JOIN knowledge_category c ON c.id = m.knowledge_category_id WHERE m.user_id = " + uid + " ORDER BY m.mastery_score DESC")
            let mastery = JsonObject()
            let categories = JsonArray()
            let strong = JsonArray()
            let weak = JsonArray()
            for (row in mastered) {
                categories.add(JsonValue.fromStr(ProfileJson.row(["id", "name", "score", "attempts"], row, [0, 2, 3])))
                let score = Float64.parse(row[2].getOrThrow())
                if (score >= 0.7 && strong.getItems().size < 5) { strong.add(JsonString(row[1].getOrThrow())) }
                if (score < 0.4 && weak.getItems().size < 5) { weak.add(JsonString(row[1].getOrThrow())) }
            }
            let average = tx.query("SELECT COALESCE(ROUND(AVG(mastery_score), 2), 0.0) FROM knowledge_mastery WHERE user_id = " + uid)[0][0].getOrThrow()
            mastery.put("overall", JsonValue.fromStr(average))
            mastery.put("categories", categories); mastery.put("strongPoints", strong); mastery.put("weakPoints", weak)
            result.put("mastery", mastery)
            let quizzes = JsonArray()
            for (row in tx.query("SELECT q.quiz_type, q.score, c.name, DATE_FORMAT(q.created_at, '%Y-%m-%dT%H:%i:%s.%f') FROM quiz_results q " +
                "LEFT JOIN knowledge_category c ON c.id = q.knowledge_category_id WHERE q.user_id = " + uid + " ORDER BY q.created_at DESC LIMIT 10")) {
                quizzes.add(JsonValue.fromStr(ProfileJson.row(["quizType", "score", "categoryName", "createdAt"], row, [1])))
            }
            result.put("recentQuizzes", quizzes)
            return result.toString()
        })
    }
    public func event(user: User, object: JsonObject): Unit {
        let event = ProfileJson.choice(object, "eventType", ["STUDY_START", "STUDY_END", "QUIZ_SUBMIT", "RESOURCE_VIEW", "CHAT_INTERACTION", "KP_MASTERY_CHECK"], true).getOrThrow()
        let source = ProfileJson.choice(object, "sourceType", ["CHAT", "RESOURCE", "QUIZ", "KNOWLEDGE_BASE", "WORKFLOW"], true).getOrThrow()
        let sourceId = ProfileJson.text(object, "sourceId", 128)
        let category = ProfileJson.number(object, "knowledgeCategoryId", -9223372036854775807, 9223372036854775807)
        let duration = ProfileJson.number(object, "durationSeconds", -2147483648, 2147483647)
        let metadata = ProfileJson.text(object, "metadata", 65536)
        DbTransaction.run<Unit>(database, { tx => LearningActivityStore.recordEvent(tx, user, event, source, sourceId, category, duration, metadata) })
    }
    public func quiz(user: User, object: JsonObject): Unit {
        let kind = ProfileJson.choice(object, "quizType", ["DIAGNOSTIC", "FORMATIVE", "SUMMATIVE", "CHALLENGE"], true).getOrThrow()
        let category = ProfileJson.number(object, "knowledgeCategoryId", -9223372036854775807, 9223372036854775807)
        let questions = ProfileJson.number(object, "questionCount", 1, 2147483647).getOrDefault({ => throw ProfileJson.invalid("缺少 questionCount") })
        let correct = ProfileJson.number(object, "correctCount", 0, 2147483647).getOrDefault({ => 0 })
        let duration = ProfileJson.number(object, "durationSeconds", -2147483648, 2147483647)
        let difficulty = ProfileJson.text(object, "difficultyLevel", 32)
        let details = ProfileJson.text(object, "details", 65536)
        let rawScore = ProfileJson.value(object, "score")
        let score = match (rawScore) { case Some(value) => value.toString(); case None => "NULL" }
        if (score != "NULL" && !Regex("^-?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$").matches(score)) { throw ProfileJson.invalid("score 必须为数字") }
        DbTransaction.run<Unit>(database, { tx =>
            LearningActivityStore.lockUser(tx, user)
            var categorySql = "NULL"
            if (let Some(id) <- category) {
                if (!tx.query("SELECT 1 FROM knowledge_category WHERE id = ${id}").isEmpty()) { categorySql = "${id}"; updateMastery(tx, user, id, questions, correct) }
            }
            let id = AuthUtilities.uuid()
            tx.execute("INSERT INTO quiz_results (id, user_id, quiz_type, knowledge_category_id, question_count, correct_count, score, duration_seconds, " +
                "difficulty_level, details, created_at) VALUES (" + AuthUtilities.uuidSql(id) + ", " + AuthUtilities.uuidSql(user.getId()) +
                ", " + AuthUtilities.text(kind) + ", " + categorySql + ", ${questions}, ${correct}, ${score}, " + ProfileJson.numericSql(duration) +
                ", " + ProfileJson.textSql(difficulty) + ", " + ProfileJson.textSql(details) + ", UTC_TIMESTAMP(6))")
            LearningActivityStore.recordEvent(tx, user, "QUIZ_SUBMIT", "QUIZ", Some(id), category, duration, None)
        })
    }
    private static func updateMastery(tx: DbTransaction, user: User, category: Int64, questions: Int64, requestedCorrect: Int64): Unit {
        let filter = " WHERE user_id = " + AuthUtilities.uuidSql(user.getId()) + " AND knowledge_category_id = ${category}"
        let old = tx.query("SELECT ROUND(mastery_score * 10000), attempt_count, correct_count, streak_correct, streak_wrong FROM knowledge_mastery" + filter + " FOR UPDATE")
        let row = if (old.isEmpty()) { [Some("0"), Some("0"), Some("0"), Some("0"), Some("0")] } else { old[0] }
        let correct = if (requestedCorrect > questions) { questions } else { requestedCorrect }
        let wrong = questions - correct
        var scaled = Int64.parse(row[0].getOrThrow())
        // Same rounded EMA per attempt as Java, with early termination at a fixed point.
        for (_ in 0..correct) { let next = (scaled * 7 + 30000 + 5) / 10; if (next == scaled) { break }; scaled = next }
        for (_ in 0..wrong) { let next = (scaled * 7 + 5) / 10; if (next == scaled) { break }; scaled = next }
        let attempts = Int64.parse(row[1].getOrThrow()) + questions
        let successes = Int64.parse(row[2].getOrThrow()) + correct
        let streakCorrect = if (wrong > 0) { 0 } else { Int64.parse(row[3].getOrThrow()) + correct }
        let streakWrong = if (wrong == 0) { 0 } else if (correct > 0) { wrong } else { Int64.parse(row[4].getOrThrow()) + wrong }
        tx.execute("INSERT INTO knowledge_mastery (id, user_id, knowledge_category_id, mastery_score, attempt_count, correct_count, last_attempt_at, " +
            "streak_correct, streak_wrong, updated_at) VALUES (" + AuthUtilities.uuidSql(AuthUtilities.uuid()) + ", " + AuthUtilities.uuidSql(user.getId()) +
            ", ${category}, ${scaled}/10000.0, ${attempts}, ${successes}, UTC_TIMESTAMP(6), ${streakCorrect}, ${streakWrong}, UTC_TIMESTAMP(6)) " +
            "ON DUPLICATE KEY UPDATE mastery_score = ${scaled}/10000.0, attempt_count = ${attempts}, correct_count = ${successes}, " +
            "last_attempt_at = UTC_TIMESTAMP(6), streak_correct = ${streakCorrect}, streak_wrong = ${streakWrong}, updated_at = UTC_TIMESTAMP(6)")
    }
    private static func studyStats(tx: DbTransaction, user: User): JsonObject {
        let uid = AuthUtilities.uuidSql(user.getId())
        let totals = tx.query("SELECT COALESCE(SUM(total_duration_seconds) DIV 60, 0), COUNT(*) FROM study_sessions WHERE user_id = " + uid)[0]
        let result = JsonValue.fromStr(ProfileJson.row(["totalStudyMinutes", "totalDays"], totals, [0, 1])).asObject()
        let dates = tx.query("SELECT DATE_FORMAT(session_date, '%Y-%m-%d'), total_duration_seconds DIV 60, DATEDIFF(UTC_DATE(), session_date) " +
            "FROM study_sessions WHERE user_id = " + uid + " ORDER BY session_date DESC")
        var expected = 0i64
        if (!dates.isEmpty() && dates[0][2].getOrThrow() != "0") { expected = 1 }
        var streak = 0i64
        for (row in dates) {
            let delta = Int64.parse(row[2].getOrThrow())
            if (delta == expected) { streak += 1; expected += 1 } else if (delta > expected) { break }
        }
        result.put("streakDays", JsonValue.fromStr("${streak}"))
        let weekly = Array<Int64>(7, repeat: 0)
        let calendar = JsonArray()
        for (i in 0..dates.size) {
            let row = dates[dates.size - 1 - i]
            let delta = Int64.parse(row[2].getOrThrow())
            if (delta >= 0 && delta <= 6) { weekly[6 - delta] = Int64.parse(row[1].getOrThrow()) }
            if (delta >= 0 && delta <= 59) { calendar.add(JsonString(row[0].getOrThrow())) }
        }
        let minutes = JsonArray()
        for (value in weekly) { minutes.add(JsonValue.fromStr("${value}")) }
        result.put("weeklyMinutes", minutes); result.put("studyDates", calendar)
        let distribution = JsonObject()
        for (row in tx.query("SELECT source_type, COUNT(*) FROM learning_events WHERE user_id = " + uid +
            " AND created_at BETWEEN DATE_SUB(UTC_DATE(), INTERVAL 30 DAY) AND UTC_TIMESTAMP(6) GROUP BY source_type")) {
            distribution.put(row[0].getOrThrow(), JsonValue.fromStr(row[1].getOrThrow()))
        }
        result.put("eventDistribution", distribution)
        return result
    }
}
