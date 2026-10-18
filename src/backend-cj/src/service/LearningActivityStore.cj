package web.service

import std.convert.*
import web.database.DbTransaction
import web.domain.User
import web.security.AuthUtilities
import web.exception.*

public class LearningActivityStore {
    public static func lockUser(tx: DbTransaction, user: User): Unit {
        tx.query("SELECT 1 FROM users WHERE id = " + AuthUtilities.uuidSql(user.getId()) + " FOR UPDATE")
    }
    public static func learner(tx: DbTransaction, user: User, requested: Option<String>): String {
        lockUser(tx, user)
        if (let Some(value) <- requested) {
            let id = ProfileJson.uuid(value)
            if (tx.query("SELECT 1 FROM learners WHERE id = " + AuthUtilities.uuidSql(id) + " AND user_id = " +
                AuthUtilities.uuidSql(user.getId())).isEmpty()) {
                throw BusinessException(ErrorCode.LEARNER_NOT_FOUND, 404, "学习者不存在")
            }
            return id
        }
        let old = tx.query("SELECT LOWER(BIN_TO_UUID(id, 0)) FROM learners WHERE user_id = " +
            AuthUtilities.uuidSql(user.getId()) + " ORDER BY created_at ASC LIMIT 1")
        if (!old.isEmpty()) { return old[0][0].getOrThrow() }
        // Preserve Java ensureFromProfile: create the user's default learner only if none exists.
        let id = AuthUtilities.uuid()
        tx.execute("INSERT INTO learners (id, user_id, code, name, avatar, role, education, weekly_hours, learning_style_json, " +
            "goal, preferred_format, diagnosis_summary, scores_json, status, created_at, updated_at) " +
            "SELECT " + AuthUtilities.uuidSql(id) + ", u.id, 'default', COALESCE(p.name, u.nickname, '学习者'), " +
            "p.avatar, p.role, p.education_level, p.weekly_hours, p.learning_style_json, p.goal, p.preferred_format, " +
            "p.diagnosis_summary_json, COALESCE(p.self_assessment_json, '{}'), 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6) " +
            "FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = " + AuthUtilities.uuidSql(user.getId()))
        return id
    }
    public static func recordEvent(tx: DbTransaction, user: User, event: String, source: String,
        sourceId: Option<String>, category: Option<Int64>, duration: Option<Int64>, metadata: Option<String>): Unit {
        lockUser(tx, user)
        var categorySql = "NULL"
        if (let Some(value) <- category) {
            if (!tx.query("SELECT 1 FROM knowledge_category WHERE id = ${value}").isEmpty()) { categorySql = "${value}" }
        }
        let linkedCategory = categorySql
        tx.execute("INSERT INTO learning_events (id, user_id, event_type, source_type, source_id, knowledge_category_id, " +
            "duration_seconds, metadata, created_at) VALUES (" + AuthUtilities.uuidSql(AuthUtilities.uuid()) + ", " +
            AuthUtilities.uuidSql(user.getId()) + ", " + AuthUtilities.text(event) + ", " + AuthUtilities.text(source) +
            ", " + ProfileJson.textSql(sourceId) + ", " + linkedCategory + ", " + ProfileJson.numericSql(duration) +
            ", " + ProfileJson.textSql(metadata) + ", UTC_TIMESTAMP(6))")
        let seconds = duration.getOrDefault({ => 0 })
        let positive = if (seconds > 0) { seconds } else { 0 }
        let chat = if (source == "CHAT") { 1 } else { 0 }
        let resource = if (source == "RESOURCE" || source == "KNOWLEDGE_BASE") { 1 } else { 0 }
        let quiz = if (source == "QUIZ") { 1 } else { 0 }
        tx.execute("INSERT INTO study_sessions (id, user_id, session_date, total_duration_seconds, event_count, chat_count, " +
            "resource_count, quiz_count, created_at, updated_at) VALUES (" + AuthUtilities.uuidSql(AuthUtilities.uuid()) +
            ", " + AuthUtilities.uuidSql(user.getId()) + ", DATE(DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 8 HOUR)), " +
            "${positive}, 1, ${chat}, ${resource}, ${quiz}, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)) " +
            "ON DUPLICATE KEY UPDATE total_duration_seconds = total_duration_seconds + ${positive}, event_count = event_count + 1, " +
            "chat_count = chat_count + ${chat}, resource_count = resource_count + ${resource}, quiz_count = quiz_count + ${quiz}, " +
            "updated_at = UTC_TIMESTAMP(6)")
    }
}
