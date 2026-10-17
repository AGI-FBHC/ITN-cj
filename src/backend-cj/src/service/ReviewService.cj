package web.service

import std.convert.*
import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.security.AuthUtilities
import web.exception.*

public class ReviewService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func list(user: User): String { return DbTransaction.run<String>(database, { tx => read(tx, user, "") }) }
    public func complete(user: User, code: String, object: JsonObject): String {
        let score = ProfileJson.number(object, "score", 0, 100).getOrDefault({ => throw ProfileJson.invalid("缺少 score") })
        let sourceId = ProfileJson.text(object, "sourceId", 128)
        let duration = ProfileJson.number(object, "durationSeconds", -2147483648, 2147483647)
        return DbTransaction.run<String>(database, { tx =>
            LearningActivityStore.lockUser(tx, user)
            let points = tx.query("SELECT id FROM knowledge_point WHERE code = " + AuthUtilities.text(code) +
                " COLLATE utf8mb4_unicode_ci AND status = 1 LIMIT 1")
            if (points.isEmpty()) { throw BusinessException(ErrorCode.KNOWLEDGE_POINT_NOT_FOUND, 404, "知识点不存在") }
            let pointId = Int64.parse(points[0][0].getOrThrow())
            let userSql = AuthUtilities.uuidSql(user.getId())
            let old = tx.query("SELECT reps FROM review_schedules WHERE user_id = " + userSql + " AND knowledge_point_id = ${pointId} FOR UPDATE")
            let reps = if (old.isEmpty()) { 0 } else { Int64.parse(old[0][0].getOrThrow()) }
            let interval = if (reps == 0) { 1 } else if (reps == 1) { 2 } else if (reps == 2) { 4 } else { 7 }
            let bounded = if (score < 5) { 5 } else if (score > 96) { 96 } else { score }
            tx.execute("INSERT INTO review_schedules (user_id, knowledge_point_id, last_at, reps, mastery, due_at, created_at, updated_at) " +
                "VALUES (" + userSql + ", ${pointId}, UTC_TIMESTAMP(6), 1, ${bounded}/100.0, " +
                "DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${interval} DAY), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)) " +
                "ON DUPLICATE KEY UPDATE last_at = UTC_TIMESTAMP(6), reps = reps + 1, mastery = ${bounded}/100.0, " +
                "due_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${interval} DAY), updated_at = UTC_TIMESTAMP(6)")
            let metadata = "{\"knowledgePoint\":" + JsonString(code).toString() + ",\"score\":${score}}"
            LearningActivityStore.recordEvent(tx, user, "KP_MASTERY_CHECK", "KNOWLEDGE_BASE", sourceId, None, duration, Some(metadata))
            return JsonValue.fromStr(read(tx, user, " AND p.id = ${pointId}")).asArray().getItems()[0].toString()
        })
    }
    private static func read(tx: DbTransaction, user: User, filter: String): String {
        let rows = tx.query("SELECT p.code, p.name, DATE_FORMAT(r.last_at, '%Y-%m-%dT%H:%i:%s.%fZ'), " +
            "COALESCE(r.reps, 0), COALESCE(r.mastery, 0.5000), " +
            "DATE_FORMAT(COALESCE(r.due_at, UTC_TIMESTAMP(6)), '%Y-%m-%dT%H:%i:%s.%fZ'), " +
            "CASE WHEN r.id IS NULL OR r.due_at <= UTC_TIMESTAMP(6) THEN 'true' ELSE 'false' END, " +
            "GREATEST(0, COALESCE(TIMESTAMPDIFF(DAY, r.due_at, UTC_TIMESTAMP(6)), 0)) FROM knowledge_point p " +
            "LEFT JOIN review_schedules r ON r.knowledge_point_id = p.id AND r.user_id = " + AuthUtilities.uuidSql(user.getId()) +
            " WHERE p.status = 1" + filter + " ORDER BY p.sort_order ASC, p.id ASC")
        let result = JsonArray()
        for (row in rows) { result.add(JsonValue.fromStr(ProfileJson.row(["kpId", "name", "lastAt", "reps", "mastery", "dueAt", "due", "overdueDays"], row, [3, 4, 6, 7]))) }
        return result.toString()
    }
}
