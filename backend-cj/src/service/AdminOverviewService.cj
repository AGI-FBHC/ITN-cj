package web.service

import std.convert.*
import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.exception.*
import web.security.AuthUtilities

public class AdminOverviewService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func users(admin: User, page: Int64, size: Int64): String {
        AccountAccessService.requireAdmin(admin)
        let safePage = if (page < 0) { 0 } else { page }
        let safeSize = if (size < 1) { 1 } else if (size > 100) { 100 } else { size }
        // Spring's page parameter is an int. Reject oversized offsets rather than wrap.
        if (safePage > 2147483647) { throw ProfileJson.invalid("page 超出范围") }
        return DbTransaction.run<String>(database, { tx =>
            let filter = " WHERE organization_id = " + AuthUtilities.uuidSql(admin.getOrganizationId().getOrThrow())
            let total = Int64.parse(tx.query("SELECT COUNT(*) FROM users" + filter)[0][0].getOrThrow())
            let items = JsonArray()
            for (row in tx.query(columns + filter + " ORDER BY created_at DESC LIMIT ${safeSize} OFFSET ${safePage * safeSize}")) {
                items.add(record(row))
            }
            let pages = (total + safeSize - 1) / safeSize
            return "{\"items\":" + items.toString() + ",\"page\":${safePage},\"size\":${safeSize},\"totalElements\":${total},\"totalPages\":${pages}}"
        })
    }
    public func user(admin: User, requested: String): String {
        AccountAccessService.requireAdmin(admin)
        let id = ProfileJson.uuid(requested)
        return DbTransaction.run<String>(database, { tx =>
            let rows = tx.query(columns + " WHERE id = " + AuthUtilities.uuidSql(id) + " AND organization_id = " +
                AuthUtilities.uuidSql(admin.getOrganizationId().getOrThrow()))
            if (rows.isEmpty()) { throw BusinessException(ErrorCode.LEARNER_NOT_FOUND, 404, "本机构内未找到该账号") }
            return record(rows[0]).toString()
        })
    }
    public func resourceStats(admin: User): String {
        AccountAccessService.requireAdmin(admin)
        let org = AuthUtilities.uuidSql(admin.getOrganizationId().getOrThrow())
        return DbTransaction.run<String>(database, { tx =>
            let result = JsonObject()
            let conditions = [
                ("library", "archived_at IS NULL AND resource_scope = 'ORGANIZATION'"),
                ("pending", "archived_at IS NULL AND resource_scope = 'ORGANIZATION' AND review_status = 'PENDING'"),
                ("published", "archived_at IS NULL AND resource_scope = 'ORGANIZATION' AND review_status = 'PUBLISHED'"),
                ("recycle", "archived_at IS NOT NULL")
            ]
            for ((name, condition) in conditions) {
                let row = tx.query("SELECT (SELECT COUNT(*) FROM generated_learning_resources WHERE organization_id = " + org +
                    " AND " + condition + ") + (SELECT COUNT(*) FROM presentation_tasks WHERE organization_id = " + org +
                    " AND " + condition + ")")[0]
                result.put(name, JsonValue.fromStr(row[0].getOrThrow()))
            }
            return result.toString()
        })
    }
    private static let columns = "SELECT LOWER(BIN_TO_UUID(id, 0)), email, nickname, account_type, IF(active = 1, 'true', 'false'), " +
        "DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') FROM users"
    private static func record(row: Array<Option<String>>): JsonValue {
        return JsonValue.fromStr(ProfileJson.row(["id", "email", "nickname", "accountType", "active", "createdAt", "updatedAt"], row, [4]))
    }
}
