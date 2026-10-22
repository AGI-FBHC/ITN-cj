package web.service

import stdx.encoding.hex.*
import stdx.encoding.json.*
import std.unicode.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.exception.*
import web.security.AuthUtilities

public class OrganizationBrandingService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func update(admin: User, body: JsonObject, requestId: Option<String>): String {
        AccountAccessService.requireAdmin(admin)
        let name = ProfileJson.text(body, "name", 128).getOrDefault({ => throw ProfileJson.invalid("机构名称不能为空") }).trim()
        let short = ProfileJson.text(body, "shortName", 64).getOrDefault({ => throw ProfileJson.invalid("机构简称不能为空") }).trim()
        if (name.isEmpty() || short.isEmpty()) { throw ProfileJson.invalid("机构名称和简称不能为空") }
        return DbTransaction.run<String>(database, { tx =>
            let org = organization(tx, admin, true)
            let previous = tx.query("SELECT name, short_name FROM organizations WHERE id = " + org)[0]
            // Java Map.of rejects null names; legacy organizations may have a null short_name.
            // Preserve the old values as JSON null so first-time branding can be saved.
            let before = ProfileJson.row(["name", "shortName"], previous, [])
            let after = JsonObject(); after.put("name", JsonString(name)); after.put("shortName", JsonString(short))
            tx.execute("UPDATE organizations SET name = " + AuthUtilities.text(name) + ", short_name = " + AuthUtilities.text(short) +
                ", updated_at = UTC_TIMESTAMP(6) WHERE id = " + org)
            audit(tx, admin, "ORGANIZATION_BRANDING_UPDATED", Some(before), Some(after.toString()), requestId)
            return branding(tx, org)
        })
    }
    public func upload(admin: User, bytes: Array<UInt8>, requestId: Option<String>): String {
        AccountAccessService.requireAdmin(admin)
        let png = OrganizationLogoCodec.normalize(bytes)
        return DbTransaction.run<String>(database, { tx =>
            let org = organization(tx, admin, true)
            tx.execute("UPDATE organizations SET logo_data = X'" + toHexString(png) + "', logo_content_type = 'image/png', " +
                "logo_updated_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6) WHERE id = " + org)
            let after = "{\"contentType\":\"image/png\",\"bytes\":${png.size}}"
            audit(tx, admin, "ORGANIZATION_LOGO_UPDATED", None, Some(after), requestId)
            return branding(tx, org)
        })
    }
    public func delete(admin: User, requestId: Option<String>): String {
        AccountAccessService.requireAdmin(admin)
        return DbTransaction.run<String>(database, { tx =>
            let org = organization(tx, admin, true)
            tx.execute("UPDATE organizations SET logo_data = NULL, logo_content_type = NULL, logo_updated_at = NULL, " +
                "updated_at = UTC_TIMESTAMP(6) WHERE id = " + org)
            audit(tx, admin, "ORGANIZATION_LOGO_DELETED", None, None, requestId)
            return branding(tx, org)
        })
    }
    public func logo(user: User): (Array<UInt8>, String) {
        return DbTransaction.run<(Array<UInt8>, String)>(database, { tx =>
            let org = organization(tx, user, false)
            // BLOBs must be converted to ASCII before the UTF-8 MySQL row reader.
            let rows = tx.query("SELECT HEX(logo_data), logo_content_type FROM organizations WHERE id = " + org)
            if (rows[0][0].isNone()) { throw BusinessException(ErrorCode.KNOWLEDGE_ASSET_NOT_FOUND, 404, "机构尚未配置 Logo") }
            return (fromHexString(rows[0][0].getOrThrow()).getOrThrow(), rows[0][1].getOrDefault({ => "image/png" }))
        })
    }
    public func logoByCode(code: String): (Array<UInt8>, String) {
        return DbTransaction.run<(Array<UInt8>, String)>(database, { tx =>
            let rows = tx.query("SELECT HEX(logo_data), logo_content_type FROM organizations WHERE code = " +
                AuthUtilities.text(code) + " AND status = 1 LIMIT 1")
            if (rows.isEmpty() || rows[0][0].isNone()) {
                throw BusinessException(ErrorCode.KNOWLEDGE_ASSET_NOT_FOUND, 404, "机构尚未配置 Logo")
            }
            return (fromHexString(rows[0][0].getOrThrow()).getOrThrow(), rows[0][1].getOrDefault({ => "image/png" }))
        })
    }
    private static func organization(tx: DbTransaction, user: User, locked: Bool): String {
        let id = user.getOrganizationId().getOrDefault({ => throw BusinessException(ErrorCode.UNAUTHORIZED, 403, "当前账号未加入机构") })
        let org = AuthUtilities.uuidSql(id)
        if (tx.query("SELECT 1 FROM organizations WHERE id = " + org + if (locked) { " FOR UPDATE" } else { "" }).isEmpty()) {
            throw BusinessException(ErrorCode.UNAUTHORIZED, 403, "账号所属机构不存在")
        }
        return org
    }
    private static func branding(tx: DbTransaction, org: String): String {
        let row = tx.query("SELECT code, name, short_name, IF(logo_data IS NULL, NULL, CONCAT('/api/v1/organization/branding/logo?org=', " +
            "code, '&v=', CAST(UNIX_TIMESTAMP(logo_updated_at) * 1000 AS UNSIGNED))), DATE_FORMAT(logo_updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') " +
            "FROM organizations WHERE id = " + org)[0]
        return ProfileJson.row(["code", "name", "shortName", "logoUrl", "logoUpdatedAt"], row, [])
    }
    private static func audit(tx: DbTransaction, actor: User, action: String, before: Option<String>, after: Option<String>, requested: Option<String>): Unit {
        var request = requested.getOrDefault({ => "" })
        if (request.trim().isEmpty()) { request = AuthUtilities.uuid() }
        // X-Request-Id is normally ASCII; retain a valid UTF-8 prefix when truncating.
        if (request.toArray().size > 64) {
            let bytes = request.toArray(); var length = 64; var value = ""
            while (length > 0) {
                try { value = String.fromUtf8(bytes.slice(0, length)); break } catch (_: Exception) { length -= 1 }
            }
            request = value
        }
        tx.execute("INSERT INTO organization_audit_log (organization_id, actor_user_id, action, target_type, target_id, before_json, after_json, request_id) VALUES (" +
            AuthUtilities.uuidSql(actor.getOrganizationId().getOrThrow()) + ", " + AuthUtilities.uuidSql(actor.getId()) + ", " +
            AuthUtilities.text(action) + ", 'organization', " + AuthUtilities.text(actor.getOrganizationId().getOrThrow()) + ", " +
            ProfileJson.textSql(before) + ", " + ProfileJson.textSql(after) + ", " + AuthUtilities.text(request) + ")")
    }
}
