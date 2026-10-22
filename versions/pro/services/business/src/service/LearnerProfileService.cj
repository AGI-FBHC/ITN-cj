package web.service

import std.unicode.*
import std.convert.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.*
import web.exception.*
import web.security.AuthUtilities
import stdx.encoding.json.*

public class LearnerProfileService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func list(user: User): String {
        let admin = match (user.getAccountType()) { case AccountType.ADMIN => true; case _ => false }
        return DbTransaction.run<String>(database, { tx =>
            return records(tx, if (admin) { "" } else { " WHERE l.user_id = " + AuthUtilities.uuidSql(user.getId()) })
        })
    }
    public func get(user: User, id: String): String {
        return DbTransaction.run<String>(database, { tx => owned(tx, user, ProfileJson.uuid(id)) })
    }
    public func save(user: User, id: Option<String>, object: JsonObject): String {
        // Validate every request field before entering the transaction.
        let strings = [("name", "name", 64), ("avatar", "avatar", 255), ("role", "role", 128),
            ("education", "education", 255), ("targetJob", "target_job", 255), ("goal", "goal", 500),
            ("preferredFormat", "preferred_format", 64), ("diagnosisSummary", "diagnosis_summary", 1000),
            ("confidenceMethod", "confidence_method", 16)]
        let code = ProfileJson.text(object, "code", 64)
        var assignments = ""
        for ((key, column, max) in strings) {
            let value = ProfileJson.text(object, key, max)
            if (value.isSome()) { assignments += ", " + column + " = " + ProfileJson.textSql(value) }
        }
        let hours = ProfileJson.number(object, "weeklyHours", 0, 168)
        let confidence = ProfileJson.number(object, "confidenceValue", 0, 100)
        if (hours.isSome()) { assignments += ", weekly_hours = " + ProfileJson.numericSql(hours) }
        if (confidence.isSome()) { assignments += ", confidence_value = " + ProfileJson.numericSql(confidence) }
        let styles = ProfileJson.strings(object, "learningStyle", 32)
        let blind = ProfileJson.strings(object, "blindSpots", 64)
        let scores = ProfileJson.objectJson(object, "scores", true)
        if (styles.isSome()) { assignments += ", learning_style_json = " + ProfileJson.textSql(styles) }
        if (blind.isSome()) { assignments += ", blind_spots_json = " + ProfileJson.textSql(blind) }
        if (scores.isSome()) { assignments += ", scores_json = " + ProfileJson.textSql(scores) }
        let requestedId: Option<String> = match (id) { case Some(value) => Some(ProfileJson.uuid(value)); case None => None }
        let newId = AuthUtilities.uuid()
        let newCode = match (code) {
            case Some(value) => if (value.trim().isEmpty()) { "learner-" + newId.split("-")[0] } else { value.trim() }
            case None => "learner-" + newId.split("-")[0]
        }
        let updates = assignments
        return DbTransaction.run<String>(database, { tx =>
            tx.query("SELECT 1 FROM users WHERE id = " + AuthUtilities.uuidSql(user.getId()) + " FOR UPDATE")
            var learnerId = requestedId.getOrDefault({ => newId })
            if (requestedId.isSome()) {
                let found = tx.query("SELECT 1 FROM learners WHERE user_id = " + AuthUtilities.uuidSql(user.getId()) +
                    " AND id = " + AuthUtilities.uuidSql(learnerId) + " FOR UPDATE")
                if (found.isEmpty()) { throw missing() }
            } else {
                /* 一个账号只保留一份画像：已有学习者时更新最早那份，不再新建 */
                let existing = tx.query("SELECT LOWER(BIN_TO_UUID(id, 0)) FROM learners WHERE user_id = " +
                    AuthUtilities.uuidSql(user.getId()) + " ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE")
                if (!existing.isEmpty()) {
                    learnerId = existing[0][0].getOrThrow()
                } else {
                    tx.execute("INSERT INTO learners (id, user_id, code, name, status, created_at, updated_at) VALUES (" +
                        AuthUtilities.uuidSql(learnerId) + ", " + AuthUtilities.uuidSql(user.getId()) + ", " +
                        AuthUtilities.text(newCode) + ", " + AuthUtilities.text("学习者") + ", 1, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))")
                }
            }
            // Like Java updateFromRequest, omitted/null values preserve existing learner fields.
            // Legacy learner code is only used during creation, not changed by update.
            tx.execute("UPDATE learners SET updated_at = UTC_TIMESTAMP(6)" + updates +
                " WHERE id = " + AuthUtilities.uuidSql(learnerId) + " AND user_id = " + AuthUtilities.uuidSql(user.getId()))
            return owned(tx, user, learnerId)
        })
    }
    private static func owned(tx: DbTransaction, user: User, id: String): String {
        let result = JsonValue.fromStr(records(tx, " WHERE l.user_id = " + AuthUtilities.uuidSql(user.getId()) +
            " AND l.id = " + AuthUtilities.uuidSql(id))).asArray().getItems()
        if (result.isEmpty()) { throw missing() }
        return result[0].toString()
    }
    private static func records(tx: DbTransaction, filter: String): String {
        let rows = tx.query("SELECT LOWER(BIN_TO_UUID(l.id, 0)), l.code, l.name, l.avatar, l.role, l.education, " +
            "l.target_job, l.weekly_hours, l.learning_style_json, l.scores_json, l.goal, l.blind_spots_json, " +
            "l.preferred_format, l.diagnosis_summary, l.confidence_method, l.confidence_value, " +
            "DATE_FORMAT(l.created_at, '%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(l.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') " +
            "FROM learners l" + filter + " ORDER BY l.created_at ASC")
        let names = ["id", "code", "name", "avatar", "role", "education", "targetJob", "weeklyHours", "learningStyle", "scores",
            "goal", "blindSpots", "preferredFormat", "diagnosisSummary", "confidenceMethod", "confidenceValue", "createdAt", "updatedAt"]
        let result = JsonArray()
        for (row in rows) {
            let scores = JsonValue.fromStr(ProfileJson.safeJson(row[9], "{}", false)).asObject()
            if (scores.size() == 0) {
                let points = tx.query("SELECT code FROM knowledge_point WHERE status = 1 ORDER BY sort_order ASC, id ASC")
                for (point in points) { scores.put(point[0].getOrThrow(), JsonValue.fromStr("50")) }
            }
            var total = 0i64
            var count = 0i64
            for ((_, score) in scores.getFields()) {
                if (score.toString() != "null") { total += Int64.parse(score.toString()); count += 1 }
            }
            // Java HALF_UP rounded to one decimal; preserve integer score maps.
            let scaled = if (count == 0) { 0 } else {
                let magnitude = if (total < 0) { -total } else { total }
                let rounded = (magnitude * 10 * 2 + count) / (2 * count)
                if (total < 0) { -rounded } else { rounded }
            }
            let data = JsonObject()
            for (i in 0..names.size) {
                if (i == 8 || i == 11) { data.put(names[i], JsonValue.fromStr(ProfileJson.safeJson(row[i], "[]", true))) }
                else if (i == 9) { data.put(names[i], scores) }
                else if (let Some(value) <- row[i]) {
                    data.put(names[i], if (i == 7 || i == 15) { JsonValue.fromStr(value) } else { JsonString(value) })
                } else {
                    data.put(names[i], JsonValue.fromStr("null"))
                }
            }
            data.put("overallMastery", JsonValue.fromStr("${Float64(scaled) / 10.0}"))
            result.add(data)
        }
        return result.toString()
    }
    private static func missing(): BusinessException { return BusinessException(ErrorCode.LEARNER_NOT_FOUND, 404, "学习者不存在") }
}
