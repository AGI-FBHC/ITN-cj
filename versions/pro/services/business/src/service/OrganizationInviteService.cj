package web.service

import std.unicode.*
import web.config.DatabaseConfig
import web.database.*
import web.domain.User
import web.exception.*
import web.security.*
import stdx.encoding.json.JsonString
import stdx.crypto.crypto.SecureRandom

public class OrganizationInviteService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func create(user: User, label: Option<String>, maxUses: Option<Int64>, expiresDays: Option<Int64>): String {
        AccountAccessService.requireAdmin(user)
        if (let Some(value) <- label) { if (ProfileJson.length(value) > 128) { throw ProfileJson.invalid("label 长度超过上限") } }
        if (let Some(value) <- maxUses) { if (value < 1 || value > 10000) { throw ProfileJson.invalid("maxUses 超出允许范围") } }
        if (let Some(value) <- expiresDays) { if (value < 1 || value > 365) { throw ProfileJson.invalid("expiresInDays 超出允许范围") } }
        return DbTransaction.run<String>(database, { tx =>
            let org = AuthUtilities.uuidSql(user.getOrganizationId().getOrThrow())
            if (tx.query("SELECT 1 FROM organizations WHERE id = " + org + " FOR UPDATE").isEmpty()) {
                throw BusinessException(ErrorCode.UNAUTHORIZED, 403, "账号所属机构不存在")
            }
            var plain = ""
            var hash = ""
            while (true) {
                plain = generate()
                hash = HashingSupport.sha256(normalize(plain))
                if (tx.query("SELECT 1 FROM organization_invites WHERE code_hash = " +
                    AuthUtilities.text(hash) + " COLLATE utf8mb4_unicode_ci LIMIT 1").isEmpty()) { break }
            }
            let id = AuthUtilities.uuid()
            let labelSql = match (label) {
                case Some(value) => if (value.trim().isEmpty()) { "NULL" } else { AuthUtilities.text(value.trim()) }
                case None => "NULL"
            }
            let limitSql = match (maxUses) { case Some(value) => "${value}"; case None => "NULL" }
            let expirySql = match (expiresDays) {
                case Some(value) => "DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ${value} DAY)"
                case None => "NULL"
            }
            let inserted = tx.execute("INSERT INTO organization_invites " +
                "(id, organization_id, code_hash, label, max_uses, used_count, expires_at, active, created_by, created_at, updated_at) " +
                "VALUES (" + AuthUtilities.uuidSql(id) + ", " + org + ", " + AuthUtilities.text(hash) +
                ", " + labelSql + ", " + limitSql + ", 0, " + expirySql + ", 1, " +
                AuthUtilities.uuidSql(user.getId()) + ", UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))")
            if (inserted != 1) { throw Exception("Organization invitation was not saved") }
            let row = tx.query("SELECT label, DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.%fZ'), " +
                "DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') FROM organization_invites WHERE id = " +
                AuthUtilities.uuidSql(id))[0]
            // NON_NULL applies to the outer ApiResponse, not the nested invite DTO.
            // Preserve all eight DTO fields including null optional values.
            let limit: Option<String> = match (maxUses) { case Some(value) => Some("${value}"); case None => None }
            return ProfileJson.row(["id", "invitationCode", "label", "maxUses", "usedCount", "expiresAt", "active", "createdAt"],
                [Some(id), Some(plain), row[0], limit, Some("0"), row[1], Some("true"), row[2]], [3, 4, 6])
        })
    }
    public static func normalize(value: String): String {
        return value.replace("-", "").replace(" ", "").toUpper(CasingOption.Other)
    }
    // Must receive the registration transaction; never commit usage independently.
    // Return organization id, code and name for the new member's login response.
    public static func consume(tx: DbTransaction, plain: String): Array<String> {
        let hash = HashingSupport.sha256(normalize(plain))
        let rows = tx.query("SELECT LOWER(BIN_TO_UUID(i.id, 0)), LOWER(BIN_TO_UUID(o.id, 0)), o.code, o.name, " +
            "(i.active = 1 AND (i.expires_at IS NULL OR i.expires_at > UTC_TIMESTAMP(6)) " +
            "AND (i.max_uses IS NULL OR i.used_count < i.max_uses)) FROM organization_invites i " +
            "JOIN organizations o ON o.id = i.organization_id WHERE i.code_hash = " + AuthUtilities.text(hash) +
            " COLLATE utf8mb4_unicode_ci LIMIT 1 FOR UPDATE")
        if (rows.isEmpty()) { throw ProfileJson.invalid("机构邀请码无效") }
        let row = rows[0]
        if (row[4].getOrThrow() != "1") { throw ProfileJson.invalid("机构邀请码已过期或使用次数已达上限") }
        let changed = tx.execute("UPDATE organization_invites SET " +
            "active = CASE WHEN max_uses IS NOT NULL AND used_count + 1 >= max_uses THEN 0 ELSE active END, " +
            "used_count = used_count + 1, updated_at = UTC_TIMESTAMP(6) WHERE id = " + AuthUtilities.uuidSql(row[0].getOrThrow()) +
            " AND active = 1 AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP(6)) " +
            "AND (max_uses IS NULL OR used_count < max_uses)")
        if (changed != 1) { throw ProfileJson.invalid("机构邀请码已过期或使用次数已达上限") }
        return [row[1].getOrThrow(), row[2].getOrThrow(), row[3].getOrThrow()]
    }
    private static func generate(): String {
        let alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".toArray()
        let random = SecureRandom()
        var result = "CB-"
        while (result.toArray().size < 13) {
            let byte = Int64(random.nextBytes(1)[0])
            if (byte < 256 - 256 % alphabet.size) { result += String.fromUtf8([alphabet[byte % alphabet.size]]) }
        }
        return result
    }
    private static func quoted(value: String): String { return JsonString(value).toString() }
}
