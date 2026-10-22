package web.service

import std.convert.*
import std.regex.Regex
import std.time.DateTime
import std.unicode.*
import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.security.AuthUtilities
import web.exception.*

public class LearningGoalService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func list(user: User): String { return DbTransaction.run<String>(database, { tx => records(tx, user, "") }) }
    public func get(user: User, id: String): String { return DbTransaction.run<String>(database, { tx => owned(tx, user, ProfileJson.uuid(id)) }) }
    public func save(user: User, id: Option<String>, object: JsonObject): String {
        let domainId = ProfileJson.number(object, "knowledgeDomainId", -9223372036854775807, 9223372036854775807)
            .getOrDefault({ => throw ProfileJson.invalid("缺少 knowledgeDomainId") })
        let title = ProfileJson.text(object, "title", 128).getOrDefault({ => "" })
        if (title.trim().isEmpty()) { throw ProfileJson.invalid("请填写学习目标标题") }
        let description = ProfileJson.text(object, "description", 5000)
        let kind = ProfileJson.choice(object, "goalType", ["JOB_PREPARATION", "COURSE_STUDY", "PROJECT_DEVELOPMENT", "SKILL_IMPROVEMENT", "EXAM_PREPARATION", "CUSTOM"], true)
        let expected = ProfileJson.choice(object, "expectedLevel", ["BEGINNER", "ELEMENTARY", "PROFICIENT", "EXPERT"], true)
        let initial = ProfileJson.choice(object, "initialLevel", ["BEGINNER", "ELEMENTARY", "PROFICIENT", "EXPERT"], false)
        let method = ProfileJson.choice(object, "assessmentMethod", ["SELF", "TEST"], false)
        let status = ProfileJson.choice(object, "status", ["DRAFT", "ACTIVE", "COMPLETED", "ARCHIVED"], true)
        let target = ProfileJson.text(object, "targetDate", 10)
        if (let Some(date) <- target) {
            if (!Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$").matches(date)) { throw ProfileJson.invalid("targetDate 格式须为 yyyy-MM-dd") }
            try { DateTime.parse(date + "T00:00:00Z") } catch (_: Exception) { throw ProfileJson.invalid("targetDate 日期无效") }
            // Match the local server calendar used by Java @FutureOrPresent.
            let today = String.fromUtf8(DateTime.now().toString().toArray().slice(0, 10))
            if (date < today) { throw ProfileJson.invalid("targetDate 不得早于今天") }
        }
        let goalId = match (id) { case Some(value) => ProfileJson.uuid(value); case None => AuthUtilities.uuid() }
        let assignments = "knowledge_domain_id = ${domainId}, goal_type = " + ProfileJson.textSql(kind) +
            ", title = " + AuthUtilities.text(title.trim()) + ", description = " + ProfileJson.textSql(description, true) +
            ", expected_level = " + ProfileJson.textSql(expected) + ", initial_level = " + ProfileJson.textSql(initial) +
            ", assessment_method = " + ProfileJson.textSql(method) + ", status = " + ProfileJson.textSql(status) +
            ", target_date = " + ProfileJson.textSql(target) + ", updated_at = UTC_TIMESTAMP(6)"
        return DbTransaction.run<String>(database, { tx =>
            lockUser(tx, user)
            if (id.isSome()) { lockOwned(tx, user, goalId) }
            requireDomain(tx, domainId)
            if (id.isSome()) {
                tx.execute("UPDATE learning_goals SET " + assignments + " WHERE id = " + AuthUtilities.uuidSql(goalId) +
                    " AND user_id = " + AuthUtilities.uuidSql(user.getId()))
            } else {
                tx.execute("INSERT INTO learning_goals SET id = " + AuthUtilities.uuidSql(goalId) + ", user_id = " +
                    AuthUtilities.uuidSql(user.getId()) + ", created_at = UTC_TIMESTAMP(6), " + assignments)
            }
            return owned(tx, user, goalId)
        })
    }
    public func ensureDomain(user: User, domainId: Int64): String {
        return DbTransaction.run<String>(database, { tx =>
            lockUser(tx, user)
            let domain = requireDomain(tx, domainId)
            let previous = tx.query("SELECT LOWER(BIN_TO_UUID(id, 0)) FROM learning_goals WHERE user_id = " +
                AuthUtilities.uuidSql(user.getId()) + " AND knowledge_domain_id = ${domainId} ORDER BY updated_at DESC LIMIT 1 FOR UPDATE")
            if (!previous.isEmpty()) { return owned(tx, user, previous[0][0].getOrThrow()) }
            let id = AuthUtilities.uuid()
            tx.execute("INSERT INTO learning_goals SET id = " + AuthUtilities.uuidSql(id) + ", user_id = " +
                AuthUtilities.uuidSql(user.getId()) + ", knowledge_domain_id = ${domainId}, goal_type = 'SKILL_IMPROVEMENT', title = " +
                AuthUtilities.text(domain[0].getOrThrow()) + ", description = " + ProfileJson.textSql(domain[1], true) +
                ", expected_level = 'PROFICIENT', initial_level = 'BEGINNER', assessment_method = 'SELF', status = 'ACTIVE', " +
                "created_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)")
            return owned(tx, user, id)
        })
    }
    public func setCurrent(user: User, id: String): String {
        let goalId = ProfileJson.uuid(id)
        return DbTransaction.run<String>(database, { tx =>
            lockUser(tx, user)
            lockOwned(tx, user, goalId)
            PersonalProfileService.ensure(tx, user)
            tx.execute("UPDATE user_profiles SET current_goal_id = " + AuthUtilities.uuidSql(goalId) +
                ", updated_at = UTC_TIMESTAMP(6) WHERE user_id = " + AuthUtilities.uuidSql(user.getId()))
            return owned(tx, user, goalId)
        })
    }
    public func clearCurrent(user: User): Unit {
        DbTransaction.run<Unit>(database, { tx =>
            lockUser(tx, user)
            tx.execute("UPDATE user_profiles SET current_goal_id = NULL, updated_at = UTC_TIMESTAMP(6) WHERE user_id = " +
                AuthUtilities.uuidSql(user.getId()))
        })
    }
    public func delete(user: User, id: String): Unit {
        let goalId = ProfileJson.uuid(id)
        DbTransaction.run<Unit>(database, { tx =>
            lockUser(tx, user)
            lockOwned(tx, user, goalId)
            tx.execute("UPDATE user_profiles SET current_goal_id = NULL, updated_at = UTC_TIMESTAMP(6) WHERE user_id = " +
                AuthUtilities.uuidSql(user.getId()) + " AND current_goal_id = " + AuthUtilities.uuidSql(goalId))
            tx.execute("DELETE FROM learning_goals WHERE user_id = " + AuthUtilities.uuidSql(user.getId()) +
                " AND id = " + AuthUtilities.uuidSql(goalId))
        })
    }
    private static func lockUser(tx: DbTransaction, user: User): Unit {
        tx.query("SELECT 1 FROM users WHERE id = " + AuthUtilities.uuidSql(user.getId()) + " FOR UPDATE")
    }
    private static func lockOwned(tx: DbTransaction, user: User, id: String): Unit {
        if (tx.query("SELECT 1 FROM learning_goals WHERE user_id = " + AuthUtilities.uuidSql(user.getId()) +
            " AND id = " + AuthUtilities.uuidSql(id) + " FOR UPDATE").isEmpty()) { throw missing() }
    }
    private static func requireDomain(tx: DbTransaction, id: Int64): Array<Option<String>> {
        let rows = tx.query("SELECT name, description FROM knowledge_domain WHERE id = ${id} AND status = 1 LIMIT 1")
        if (rows.isEmpty()) { throw ProfileJson.invalid("学习领域不存在或尚未启用") }
        return rows[0]
    }
    private static func owned(tx: DbTransaction, user: User, id: String): String {
        let items = JsonValue.fromStr(records(tx, user, " AND g.id = " + AuthUtilities.uuidSql(id))).asArray().getItems()
        if (items.isEmpty()) { throw missing() }
        return items[0].toString()
    }
    private static func records(tx: DbTransaction, user: User, filter: String): String {
        let rows = tx.query("SELECT LOWER(BIN_TO_UUID(g.id, 0)), g.knowledge_domain_id, d.code, d.name, g.goal_type, " +
            "CASE WHEN d.id IS NULL THEN g.title ELSE d.name END, g.description, g.expected_level, g.initial_level, " +
            "g.assessment_method, g.status, DATE_FORMAT(g.target_date, '%Y-%m-%d'), " +
            "CASE WHEN p.current_goal_id = g.id THEN 'true' ELSE 'false' END, " +
            "DATE_FORMAT(g.created_at, '%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(g.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') " +
            "FROM learning_goals g LEFT JOIN knowledge_domain d ON d.id = g.knowledge_domain_id " +
            "LEFT JOIN user_profiles p ON p.user_id = g.user_id WHERE g.user_id = " +
            AuthUtilities.uuidSql(user.getId()) + filter + " ORDER BY g.updated_at DESC")
        let names = ["id", "knowledgeDomainId", "knowledgeDomainCode", "knowledgeDomainName", "goalType", "title", "description",
            "expectedLevel", "initialLevel", "assessmentMethod", "status", "targetDate", "current", "createdAt", "updatedAt"]
        var result = "["
        for (i in 0..rows.size) { if (i > 0) { result += "," }; result += ProfileJson.row(names, rows[i], [1, 12]) }
        return result + "]"
    }
    private static func missing(): BusinessException { return BusinessException(ErrorCode.LEARNING_GOAL_NOT_FOUND, 404, "学习目标不存在") }
}
