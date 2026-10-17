package web.service

import std.unicode.*
import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.security.AuthUtilities

public class PersonalProfileService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func get(user: User): String { return DbTransaction.run<String>(database, { tx => read(tx, user) }) }
    public func save(user: User, object: JsonObject): String {
        let completion = ProfileJson.value(object, "profileCompleted").getOrDefault({ => throw ProfileJson.invalid("缺少 profileCompleted") }).toString()
        if (completion != "true" && completion != "false") { throw ProfileJson.invalid("profileCompleted 必须为布尔值") }
        var assignments = "profile_completed = " + if (completion == "true") { "1" } else { "0" }
        let fields = [("educationLevel", "education_level", 32), ("major", "major", 128),
            ("technicalFoundation", "technical_foundation", 1000), ("name", "name", 64),
            ("avatar", "avatar", 255), ("role", "role", 64), ("jobTitle", "job_title", 64),
            ("goal", "goal", 500), ("preferredFormat", "preferred_format", 64)]
        for ((key, column, max) in fields) {
            assignments += ", " + column + " = " + ProfileJson.textSql(ProfileJson.text(object, key, max), true)
        }
        let preference = ProfileJson.choice(object, "learningPreference", ["THEORY", "CASE_DRIVEN", "PRACTICAL"], false)
        assignments += ", learning_preference = " + ProfileJson.textSql(preference)
        let voice = ProfileJson.text(object, "ttsVoice", 32).getOrDefault({ => "苏打" }).trim()
        let speed = ProfileJson.text(object, "ttsSpeed", 16).getOrDefault({ => "normal" })
        let normalizedSpeed = if (speed == "very_slow" || speed == "slow" || speed == "fast" || speed == "very_fast") { speed } else { "normal" }
        assignments += ", tts_voice = " + AuthUtilities.text(if (voice.isEmpty()) { "苏打" } else { voice }) +
            ", tts_speed = " + AuthUtilities.text(normalizedSpeed)
        for ((key, column) in [("organizationId", "organization_id"), ("departmentId", "department_id")]) {
            let value = ProfileJson.text(object, key, 36)
            assignments += ", " + column + " = " + match (value) {
                case Some(text) => AuthUtilities.uuidSql(ProfileJson.uuid(text))
                case None => "NULL"
            }
        }
        assignments += ", weekly_hours = " + ProfileJson.numericSql(ProfileJson.number(object, "weeklyHours", 0, 168))
        assignments += ", learning_style_json = " + ProfileJson.textSql(ProfileJson.strings(object, "learningStyle", 32))
        assignments += ", self_assessment_json = " + ProfileJson.textSql(ProfileJson.objectJson(object, "selfAssessment", false))
        assignments += ", diagnosis_summary_json = " + ProfileJson.textSql(ProfileJson.objectJson(object, "diagnosisSummary", false))
        let updates = assignments
        return DbTransaction.run<String>(database, { tx =>
            tx.query("SELECT 1 FROM users WHERE id = " + AuthUtilities.uuidSql(user.getId()) + " FOR UPDATE")
            ensure(tx, user)
            tx.execute("UPDATE user_profiles SET " + updates + ", updated_at = UTC_TIMESTAMP(6) WHERE user_id = " +
                AuthUtilities.uuidSql(user.getId()))
            return read(tx, user)
        })
    }
    public static func ensure(tx: DbTransaction, user: User): Unit {
        tx.execute("INSERT INTO user_profiles (user_id, profile_completed, tts_voice, tts_speed, created_at, updated_at) " +
            "VALUES (" + AuthUtilities.uuidSql(user.getId()) + ", 0, " + AuthUtilities.text("苏打") +
            ", 'normal', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE user_id = user_id")
    }
    private static func read(tx: DbTransaction, user: User): String {
        let rows = tx.query("SELECT LOWER(BIN_TO_UUID(user_id, 0)), education_level, major, technical_foundation, learning_preference, " +
            "LOWER(BIN_TO_UUID(current_goal_id, 0)), profile_completed, tts_voice, tts_speed, name, avatar, role, job_title, " +
            "LOWER(BIN_TO_UUID(organization_id, 0)), LOWER(BIN_TO_UUID(department_id, 0)), weekly_hours, learning_style_json, goal, " +
            "preferred_format, self_assessment_json, diagnosis_summary_json, " +
            "DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') " +
            "FROM user_profiles WHERE user_id = " + AuthUtilities.uuidSql(user.getId()) + " LIMIT 1")
        let names = ["userId", "educationLevel", "major", "technicalFoundation", "learningPreference", "currentGoalId", "profileCompleted",
            "ttsVoice", "ttsSpeed", "name", "avatar", "role", "jobTitle", "organizationId", "departmentId", "weeklyHours", "learningStyle",
            "goal", "preferredFormat", "selfAssessment", "diagnosisSummary", "createdAt", "updatedAt"]
        let row = if (rows.isEmpty()) { Array<Option<String>>(23, { _ => None }) } else { rows[0] }
        if (rows.isEmpty()) { row[0] = Some(user.getId()); row[7] = Some("苏打"); row[8] = Some("normal") }
        row[6] = Some(if (row[6].getOrDefault({ => "0" }) == "1") { "true" } else { "false" })
        row[16] = Some(ProfileJson.safeJson(row[16], "[]", true))
        row[19] = Some(ProfileJson.safeJson(row[19], "{}", false))
        row[20] = Some(ProfileJson.safeJson(row[20], "{}", false))
        return ProfileJson.row(names, row, [6, 15, 16, 19, 20])
    }
}
