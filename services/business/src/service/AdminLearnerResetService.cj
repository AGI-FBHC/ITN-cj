package web.service

import std.collection.*
import std.regex.Regex
import std.unicode.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.exception.*
import web.security.AuthUtilities

class LearnerResetDelete {
    let table: String
    let column: String
    let keys: Array<String>
    let binary: Bool
    init(table: String, column: String, keys: Array<String>, binary: Bool) {
        this.table = table; this.column = column; this.keys = keys; this.binary = binary
    }
}

public class AdminLearnerResetService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    /** 游客退出登录时清空自己的使用记录：不需要管理员权限，也不写组织审计 */
    public func resetSelf(user: User): Unit {
        DbTransaction.run<Unit>(database, { tx =>
            purge(tx, user.getId())
        })
    }
    /** 在调用方的事务里清空使用记录（游客每次进入体验时复用；保持调用方事务边界） */
    public func purgeUsage(tx: DbTransaction, userId: String): Unit {
        purge(tx, userId)
    }
    /** 删除该账号名下的全部使用记录（保留 users / user_identities 本体） */
    private func purge(tx: DbTransaction, id: String): Unit {
        let userKey = normalized(id)
        if (tx.query("SELECT @@foreign_key_checks")[0][0].getOrThrow() != "1") {
            throw Exception("Learner reset requires enabled foreign-key checks")
        }
        let coreTables = tx.query("SELECT engine FROM information_schema.tables WHERE table_schema = DATABASE() " +
            "AND table_name IN ('users', 'organization_audit_log') AND table_type = 'BASE TABLE'")
        if (coreTables.size != 2) { throw Exception("Learner reset audit schema is missing") }
        for (table in coreTables) { transactional(table[0]) }
        let learners = tx.query("SELECT HEX(id) FROM learners WHERE user_id = " + AuthUtilities.uuidSql(id) + " FOR UPDATE")
        let learnerKeys = ArrayList<String>()
        for (row in learners) { learnerKeys.add(row[0].getOrThrow()) }
        // Discover only actual base tables; identifiers never come from the HTTP request.
        let columns = tx.query("SELECT c.table_name, c.column_name, c.data_type, t.engine FROM information_schema.columns c " +
            "JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name " +
            "WHERE c.table_schema = DATABASE() AND t.table_type = 'BASE TABLE' " +
            "AND LOWER(c.column_name) IN ('user_id', 'learner_id') AND LOWER(c.table_name) NOT IN ('users', 'user_identities') " +
            "AND c.table_name NOT LIKE 'codex_backup_%' AND c.table_name NOT LIKE 'generated_learning_resources_backup%' " +
            "ORDER BY CASE WHEN LOWER(c.column_name) = 'learner_id' THEN 0 WHEN LOWER(c.table_name) = 'learners' THEN 2 ELSE 1 END, c.table_name")
        let steps = ArrayList<LearnerResetDelete>()
        // Legacy child records whose tables do not necessarily carry an owner column.
        children(tx, steps, "chat_sessions", "chat_messages", "session_id", id, true)
        children(tx, steps, "chat_sessions", "chat_attachments", "session_id", id, true)
        children(tx, steps, "presentation_chat_sessions", "presentation_chat_messages", "session_id", id, true)
        children(tx, steps, "generated_courses", "generated_course_chapters", "course_id", id, true)
        children(tx, steps, "agent_runs", "agent_events", "run_id", id, false)
        for (row in columns) {
            let table = row[0].getOrThrow(); let column = row[1].getOrThrow()
            transactional(row[3])
            let keys = if (column.toLower(CasingOption.Other) == "learner_id") { learnerKeys.toArray() } else { [userKey] }
            let kind = row[2].getOrThrow().toLower(CasingOption.Other)
            if (!keys.isEmpty()) { steps.add(LearnerResetDelete(table, column, keys, kind == "binary" || kind == "varbinary")) }
        }
        // Foreign keys stay enabled: cascades clean dependent records and SET NULL links remain valid.
        // Defer RESTRICT dependencies until their owned child rows have been deleted.
        var pending = steps
        while (!pending.isEmpty()) {
            let deferred = ArrayList<LearnerResetDelete>()
            for (step in pending) {
                // Keep learner rows until all earlier owned deletes have succeeded;
                // SET NULL must not erase the learner_id needed by a deferred delete.
                if (step.table.toLower(CasingOption.Other) == "learners" && !deferred.isEmpty()) {
                    deferred.add(step); continue
                }
                try { remove(tx, step) } catch (e: Exception) {
                    if (e.message.contains("Cannot delete or update a parent row") && e.message.contains("foreign key constraint fails")) {
                        deferred.add(step)
                    } else { throw e }
                }
            }
            if (deferred.size == pending.size) { throw Exception("Learner reset has unresolved foreign-key dependencies; no changes committed") }
            pending = deferred
        }
    }
    public func reset(admin: User, requested: String, requestId: Option<String>): String {
        AccountAccessService.requireAdmin(admin)
        let id = ProfileJson.uuid(requested)
        return DbTransaction.run<String>(database, { tx =>
            let rows = tx.query("SELECT LOWER(BIN_TO_UUID(id, 0)), email, nickname, account_type, IF(active = 1, 'true', 'false'), " +
                "DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') " +
                "FROM users WHERE id = " + AuthUtilities.uuidSql(id) + " AND organization_id = " +
                AuthUtilities.uuidSql(admin.getOrganizationId().getOrThrow()) + " FOR UPDATE")
            if (rows.isEmpty()) { throw BusinessException(ErrorCode.LEARNER_NOT_FOUND, 404, "本机构内未找到该账号") }
            if (rows[0][3].getOrThrow() != "LEARNER") { throw ProfileJson.invalid("仅可重置学习者账号的使用记录") }
            purge(tx, id)
            tx.execute("INSERT INTO organization_audit_log (organization_id, actor_user_id, action, target_type, target_id, " +
                "before_json, after_json, request_id) VALUES (" + AuthUtilities.uuidSql(admin.getOrganizationId().getOrThrow()) + ", " +
                AuthUtilities.uuidSql(admin.getId()) + ", 'USER_USAGE_RESET', 'user', " + AuthUtilities.text(id) +
                ", NULL, " + AuthUtilities.text("{\"usageReset\":true}") + ", " + AuthUtilities.text(auditRequest(requestId)) + ")")
            return ProfileJson.row(["id", "email", "nickname", "accountType", "active", "createdAt", "updatedAt"], rows[0], [4])
        })
    }
    private static func children(tx: DbTransaction, steps: ArrayList<LearnerResetDelete>, parent: String, child: String,
        column: String, user: String, binary: Bool): Unit {
        let parentMeta = tx.query("SELECT t.engine FROM information_schema.tables t WHERE t.table_schema = DATABASE() " +
            "AND t.table_type = 'BASE TABLE' AND t.table_name = " + AuthUtilities.text(parent))
        let childMeta = tx.query("SELECT t.engine FROM information_schema.tables t WHERE t.table_schema = DATABASE() " +
            "AND t.table_type = 'BASE TABLE' AND t.table_name = " + AuthUtilities.text(child))
        if (parentMeta.isEmpty() || childMeta.isEmpty()) { return }
        transactional(parentMeta[0][0]); transactional(childMeta[0][0])
        let selection = if (binary) { "HEX(id)" } else { "id" }
        let filter = if (binary) { "user_id = " + AuthUtilities.uuidSql(user) } else {
            "UPPER(REPLACE(user_id, '-', '')) = " + AuthUtilities.text(normalized(user)) + " COLLATE utf8mb4_unicode_ci"
        }
        let ids = tx.query("SELECT " + selection + " FROM " + identifier(parent) + " WHERE " + filter)
        let keys = ArrayList<String>()
        for (row in ids) { if (let Some(value) <- row[0]) { keys.add(normalized(value)) } }
        if (!keys.isEmpty()) { steps.add(LearnerResetDelete(child, column, keys.toArray(), binary)) }
    }
    private static func remove(tx: DbTransaction, step: LearnerResetDelete): Unit {
        let column = identifier(step.column)
        let left = if (step.binary) { column } else { "UPPER(REPLACE(" + column + ", '-', '')) COLLATE utf8mb4_unicode_ci" }
        var start = 0
        while (start < step.keys.size) {
            let end = if (start + 100 < step.keys.size) { start + 100 } else { step.keys.size }
            var values = ""
            for (index in start..end) {
                if (index > start) { values += "," }
                let key = step.keys[index]
                if (step.binary) {
                    if (!Regex("^[0-9A-F]{32}$").matches(key)) { throw Exception("Invalid binary ownership key; reset aborted") }
                    values += "X'" + key + "'"
                } else { values += AuthUtilities.text(key) + " COLLATE utf8mb4_unicode_ci" }
            }
            tx.execute("DELETE FROM " + identifier(step.table) + " WHERE " + left + " IN (" + values + ")")
            start = end
        }
    }
    private static func transactional(engine: Option<String>): Unit {
        if (engine.getOrDefault({ => "" }).toLower(CasingOption.Other) != "innodb") { throw Exception("Learner reset requires InnoDB tables for transaction rollback") }
    }
    private static func identifier(value: String): String {
        if (!Regex("^[A-Za-z0-9_]+$").matches(value)) { throw Exception("Invalid reset table or column identifier") }
        return "`" + value + "`"
    }
    private static func normalized(value: String): String { return value.replace("-", "").toUpper(CasingOption.Other) }
    private static func auditRequest(requested: Option<String>): String {
        let value = requested.getOrDefault({ => "" })
        if (value.trim().isEmpty()) { return AuthUtilities.uuid() }
        let bytes = value.toArray()
        var length = if (bytes.size > 64) { 64 } else { bytes.size }
        while (length > 0) {
            try { return String.fromUtf8(bytes.slice(0, length)) } catch (_: Exception) { length -= 1 }
        }
        return AuthUtilities.uuid()
    }
}
