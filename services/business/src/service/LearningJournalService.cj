package web.service

import std.collection.*
import std.convert.*
import std.regex.Regex
import std.unicode.*
import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.security.AuthUtilities

public class LearningJournalService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func get(user: User, requested: Option<String>): String {
        let validated = validateDate(requested)
        return DbTransaction.run<String>(database, { tx => read(tx, user, date(tx, validated)).toString() })
    }
    public func generate(user: User, requested: Option<String>): String {
        let validated = validateDate(requested)
        return DbTransaction.run<String>(database, { tx =>
            LearningActivityStore.lockUser(tx, user)
            let target = date(tx, validated)
            let journal = read(tx, user, target)
            let stats = journal.get("stats").getOrThrow().asObject()
            let size = journal.get("timeline").getOrThrow().asArray().getItems().size
            var content = "今天未学习，无法生成小结。"
            if (size > 0) {
                content = "今天共记录 ${size} 个学习节点"
                let focus = integer(stats, "focusSeconds")
                let resources = integer(stats, "resourceCount")
                let knowledge = integer(stats, "knowledgeCount")
                let questions = integer(stats, "questionCount")
                if (focus > 0) { content += "，完成 ${minutes(focus)} 分钟专注" }
                if (resources > 0) { content += "，学习 ${resources} 项资源" }
                if (knowledge > 0) { content += "，涉及 ${knowledge} 个知识点" }
                if (questions > 0) {
                    let correct = integer(stats, "correctCount")
                    let accuracy = (correct * 200 + questions) / (questions * 2)
                    content += "。完成 ${questions} 道题，正确率 ${accuracy}%"
                    content += if (integer(stats, "wrongCount") > 0) { "，建议优先复习今日错题关联的知识点。" } else { "，本轮作答保持稳定。" }
                } else { content += "。可以用一组短测验检验今天的学习效果。" }
            }
            tx.execute("INSERT INTO learning_daily_summaries (id, user_id, summary_date, summary_text, metrics_json, generated_at, updated_at) VALUES (" +
                AuthUtilities.uuidSql(AuthUtilities.uuid()) + ", " + AuthUtilities.uuidSql(user.getId()) + ", " + AuthUtilities.text(target) + ", " +
                AuthUtilities.text(content) + ", " + AuthUtilities.text(stats.toString()) + ", UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)) " +
                "ON DUPLICATE KEY UPDATE summary_text = VALUES(summary_text), metrics_json = VALUES(metrics_json), " +
                "generated_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)")
            journal.put("summary", summary(tx, user, target))
            return journal.toString()
        })
    }
    private static func read(tx: DbTransaction, user: User, target: String): JsonObject {
        let uid = AuthUtilities.uuidSql(user.getId())
        // Preserve the Java repository's inclusive BETWEEN boundary and Shanghai calendar day.
        let from = "DATE_SUB(CAST(" + AuthUtilities.text(target) + " AS DATETIME), INTERVAL 8 HOUR)"
        let to = "DATE_ADD(" + from + ", INTERVAL 1 DAY)"
        let eventFilter = " e.user_id = " + uid + " AND e.created_at BETWEEN " + from + " AND " + to
        let quizFilter = " q.user_id = " + uid + " AND q.created_at BETWEEN " + from + " AND " + to
        let rows = tx.query("SELECT * FROM (SELECT LOWER(BIN_TO_UUID(e.id, 0)) AS id, " +
            "DATE_FORMAT(e.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS occurred_at, e.event_type AS event_type, e.source_type AS source_type, " +
            "e.duration_seconds AS duration_seconds, c.name AS knowledge_name, e.metadata AS metadata, NULL AS correct_count, NULL AS wrong_count, " +
            "NULL AS difficulty_level, 0 AS entry_order FROM learning_events e LEFT JOIN knowledge_category c ON c.id = e.knowledge_category_id " +
            "WHERE " + eventFilter + " AND e.event_type <> 'QUIZ_SUBMIT' UNION ALL " +
            "SELECT LOWER(BIN_TO_UUID(q.id, 0)), DATE_FORMAT(q.created_at, '%Y-%m-%dT%H:%i:%s.%fZ'), 'QUIZ_SUBMIT', 'QUIZ', " +
            "q.duration_seconds, c.name, NULL, q.correct_count, GREATEST(0, q.question_count - q.correct_count), q.difficulty_level, 1 " +
            "FROM quiz_results q LEFT JOIN knowledge_category c ON c.id = q.knowledge_category_id WHERE " + quizFilter +
            ") journal_entries ORDER BY occurred_at ASC, entry_order ASC")
        let timeline = JsonArray()
        let knowledgeNames = HashSet<String>()
        for (row in rows) {
            let event = row[2].getOrThrow()
            let metadata = object(row[6])
            let name: Option<String> = if (row[5].isSome()) { row[5] } else if (event == "QUIZ_SUBMIT") { None } else { text(metadata, "knowledgePoint") }
            if (let Some(value) <- name) { knowledgeNames.add(value) }
            let duration = match (row[4]) { case Some(value) => Int64.parse(value); case None => 0 }
            let isQuiz = row[10].getOrThrow() == "1"
            let title = if (isQuiz) { "完成一组分阶测试" } else { eventTitle(event, metadata, name) }
            let description = if (isQuiz) { row[9].getOrDefault({ => "根据作答结果更新掌握情况" }) } else {
                eventDescription(row[3].getOrThrow(), metadata, duration)
            }
            let item = JsonValue.fromStr(ProfileJson.row(["id", "occurredAt"], row, [])).asObject()
            item.put("kind", JsonString(kind(event)))
            item.put("title", JsonString(title))
            item.put("description", JsonString(if (isQuiz && row[9].isSome()) { "难度 · " + description } else { description }))
            item.put("durationSeconds", raw(row[4])); item.put("knowledgeName", string(name))
            item.put("correctCount", raw(row[7])); item.put("wrongCount", raw(row[8]))
            timeline.add(item)
        }
        let eventStats = tx.query("SELECT COALESCE(SUM(CASE WHEN e.event_type = 'STUDY_END' THEN e.duration_seconds ELSE 0 END), 0), " +
            "COALESCE(SUM(e.duration_seconds), 0), COALESCE(SUM(e.event_type = 'RESOURCE_VIEW'), 0) FROM learning_events e WHERE " + eventFilter)[0]
        let quizStats = tx.query("SELECT COALESCE(SUM(q.question_count), 0), COALESCE(SUM(q.correct_count), 0) FROM quiz_results q WHERE " + quizFilter)[0]
        let questions = Int64.parse(quizStats[0].getOrThrow()); let correct = Int64.parse(quizStats[1].getOrThrow())
        let stats = JsonValue.fromStr(ProfileJson.row(["focusSeconds", "totalDurationSeconds", "resourceCount"], eventStats, [0, 1, 2])).asObject()
        stats.put("knowledgeCount", JsonValue.fromStr("${knowledgeNames.size}"))
        stats.put("questionCount", raw(quizStats[0])); stats.put("correctCount", raw(quizStats[1]))
        stats.put("wrongCount", JsonValue.fromStr(if (questions > correct) { "${questions - correct}" } else { "0" }))
        let result = JsonObject(); result.put("date", JsonString(target)); result.put("stats", stats)
        result.put("timeline", timeline); result.put("summary", summary(tx, user, target))
        return result
    }
    private static func summary(tx: DbTransaction, user: User, target: String): JsonValue {
        let rows = tx.query("SELECT summary_text, CAST(metrics_json AS CHAR), DATE_FORMAT(generated_at, '%Y-%m-%dT%H:%i:%s.%fZ') " +
            "FROM learning_daily_summaries WHERE user_id = " + AuthUtilities.uuidSql(user.getId()) + " AND summary_date = " + AuthUtilities.text(target))
        return if (rows.isEmpty()) { JsonValue.fromStr("null") } else {
            JsonValue.fromStr(ProfileJson.row(["content", "metricsJson", "generatedAt"], rows[0], []))
        }
    }
    private static func date(tx: DbTransaction, requested: Option<String>): String {
        return requested.getOrDefault({ => tx.query("SELECT DATE_FORMAT(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR), '%Y-%m-%d')")[0][0].getOrThrow() })
    }
    private static func validateDate(requested: Option<String>): Option<String> {
        if (let Some(value) <- requested) {
            if (value.isEmpty()) { return None }
            if (!Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$").matches(value)) { throw ProfileJson.invalid("date 必须为 YYYY-MM-DD 格式") }
            let parts = value.split("-"); let year = Int64.parse(parts[0]); let month = Int64.parse(parts[1]); let day = Int64.parse(parts[2])
            if (year < 1 || month < 1 || month > 12) { throw ProfileJson.invalid("日期无效") }
            let days = [31, if (year % 400 == 0 || (year % 4 == 0 && year % 100 != 0)) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
            if (day < 1 || day > days[month - 1]) { throw ProfileJson.invalid("日期无效") }
        }
        return requested
    }
    private static func object(value: Option<String>): JsonObject {
        try { return JsonValue.fromStr(value.getOrDefault({ => "{}" })).asObject() } catch (_: Exception) { return JsonObject() }
    }
    private static func text(value: JsonObject, key: String): Option<String> {
        if (let Some(item) <- value.get(key)) {
            if (item.toString() == "null") { return None }
            try { return Some(item.asString().getValue()) } catch (_: Exception) {
                let rendered = item.toString()
                return Some(if (rendered.startsWith("{") || rendered.startsWith("[")) { "" } else { rendered })
            }
        }
        return None
    }
    private static func kind(event: String): String {
        return match (event) {
            case "STUDY_START" | "STUDY_END" => "focus"
            case "RESOURCE_VIEW" => "resource"
            case "KP_MASTERY_CHECK" => "knowledge"
            case "CHAT_INTERACTION" => "chat"
            case _ => "quiz"
        }
    }
    private static func eventTitle(event: String, metadata: JsonObject, knowledge: Option<String>): String {
        let supplied = text(metadata, "title").getOrDefault({ => text(metadata, "resourceTitle").getOrDefault({ => "" }) })
        if (!supplied.trim().isEmpty()) { return supplied }
        return match (event) {
            case "STUDY_START" => "开始专注"
            case "STUDY_END" => "完成专注"
            case "RESOURCE_VIEW" => "学习了一项资源"
            case "CHAT_INTERACTION" => "进行交互导学"
            case "KP_MASTERY_CHECK" => match (knowledge) { case Some(name) => "学习「" + name + "」"; case None => "复习知识点" }
            case _ => "完成测试"
        }
    }
    private static func eventDescription(source: String, metadata: JsonObject, duration: Int64): String {
        let detail = text(metadata, "description").getOrDefault({ => text(metadata, "action").getOrDefault({ => "" }) })
        if (!detail.trim().isEmpty()) { return detail }
        if (duration > 0) { return "持续 ${minutes(duration)} 分钟" }
        return match (source) {
            case "CHAT" => "围绕当前领域提问与交流"
            case "RESOURCE" => "打开并学习个性化资源"
            case "KNOWLEDGE_BASE" => "浏览知识库内容"
            case "QUIZ" => "完成题目并更新掌握情况"
            case _ => "完成一段学习流程"
        }
    }
    private static func minutes(seconds: Int64): Int64 { return if (seconds < 60) { 1 } else { seconds / 60 } }
    private static func integer(value: JsonObject, key: String): Int64 { return Int64.parse(value.get(key).getOrThrow().toString()) }
    private static func raw(value: Option<String>): JsonValue { return JsonValue.fromStr(value.getOrDefault({ => "null" })) }
    private static func string(value: Option<String>): JsonValue { return match (value) { case Some(item) => JsonString(item); case None => JsonValue.fromStr("null") } }
}
