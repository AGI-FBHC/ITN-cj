package web.service

import std.unicode.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.exception.*
import web.security.AuthUtilities

public class AdminAccountStatusService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func setEnabled(admin: User, requested: String, enabled: Bool, requestId: Option<String>): String {
        AccountAccessService.requireAdmin(admin)
        let id = ProfileJson.uuid(requested)
        let org = AuthUtilities.uuidSql(admin.getOrganizationId().getOrThrow())
        let target = AuthUtilities.uuidSql(id)
        return DbTransaction.run<String>(database, { tx =>
            let filter = " WHERE id = " + target + " AND organization_id = " + org
            let rows = tx.query(columns + filter + " FOR UPDATE")
            if (rows.isEmpty()) { throw BusinessException(ErrorCode.LEARNER_NOT_FOUND, 404, "本机构内未找到该账号") }
            if (!enabled && id.toLower(CasingOption.Other) == admin.getId().toLower(CasingOption.Other)) {
                throw ProfileJson.invalid("不能停用当前登录的管理员账号")
            }
            let before = rows[0][4].getOrThrow()
            let after = if (enabled) { "true" } else { "false" }
            let activeSql = if (enabled) { "1" } else { "0" }
            // Like Hibernate dirty checking, an unchanged active flag does not bump updated_at.
            if (before != after) {
                tx.execute("UPDATE users SET active = " + activeSql +
                    ", updated_at = UTC_TIMESTAMP(6)" + filter)
            }
            let auditRequest = normalizeRequestId(requestId)
            tx.execute("INSERT INTO organization_audit_log (organization_id, actor_user_id, action, target_type, target_id, " +
                "before_json, after_json, request_id) VALUES (" + org + ", " + AuthUtilities.uuidSql(admin.getId()) + ", " +
                AuthUtilities.text(if (enabled) { "USER_ENABLED" } else { "USER_DISABLED" }) + ", 'user', " + AuthUtilities.text(id) +
                ", " + AuthUtilities.text("{\"active\":" + before + "}") + ", " + AuthUtilities.text("{\"active\":" + after + "}") +
                ", " + AuthUtilities.text(auditRequest) + ")")
            let row = tx.query(columns + filter)[0]
            return ProfileJson.row(["id", "email", "nickname", "accountType", "active", "createdAt", "updatedAt"], row, [4])
        })
    }
    private static let columns = "SELECT LOWER(BIN_TO_UUID(id, 0)), email, nickname, account_type, IF(active = 1, 'true', 'false'), " +
        "DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') FROM users"
    private static func normalizeRequestId(requested: Option<String>): String {
        let value = requested.getOrDefault({ => "" })
        if (value.trim().isEmpty()) { return AuthUtilities.uuid() }
        let bytes = value.toArray()
        if (bytes.size <= 64) { return value }
        var length = 64
        while (length > 0) {
            try { return String.fromUtf8(bytes.slice(0, length)) } catch (_: Exception) { length -= 1 }
        }
        return AuthUtilities.uuid()
    }
}
