package web.controllers

import std.convert.*
import std.unicode.*
import std.time.DateTime
import stdx.encoding.json.*
import soulsoft_web_http.*
import web.config.*
import web.database.*
import web.domain.*
import web.dto.*
import web.exception.*
import web.repository.*
import web.security.*
import web.service.*

public class AccountAccessController {
    private let database: DatabaseConfig
    private let access: AccountAccessService
    private let invites: OrganizationInviteService
    private let codes: VerificationCodeService
    public init(database: DatabaseConfig, auth: AuthConfig) {
        this.database = database
        this.access = AccountAccessService(database, auth)
        this.invites = OrganizationInviteService(database)
        this.codes = VerificationCodeService(database, auth, VerificationMailService(MailConfig.fromEnvironment()))
    }
    public func me(context: HttpContext): Unit {
        handle(context, { => wrap("success", AuthController.userJson(UserResponse.from(access.authenticate(bearer(context))))) })
    }
    public func logout(context: HttpContext): Unit {
        handle(context, { => access.logout(bearer(context)); return wrap("退出登录成功", None) })
    }
    public func login(context: HttpContext, admin: Bool): Unit {
        handle(context, { =>
            let object = body(context)
            let kind = required(object, "identityType", 32)
            let value = required(object, "identityValue", 255)
            optional(object, "nickname", 64)
            let result = access.login(kind, value, optional(object, "password", 128),
                optional(object, "verificationCode", 6), optional(object, "organizationCode", 64), admin,
                AuthController.clientIp(context.request.remoteAddr), context.request.headers["User-Agent"].first)
            return AuthController.successJson(result, if (admin) { "管理员登录成功" } else { "登录成功" })
        })
    }
    public func createInvite(context: HttpContext): Unit {
        handle(context, { =>
            let user = access.authenticate(bearer(context))
            AccountAccessService.requireAdmin(user)
            let object = body(context)
            let result = invites.create(user, optional(object, "label", 128),
                integer(object, "maxUses", 1, 10000), integer(object, "expiresInDays", 1, 365))
            return wrap("邀请码已生成，请立即安全发送给机构成员", result)
        })
    }
    public func branding(context: HttpContext, admin: Bool): Unit {
        handle(context, { =>
            let user = access.authenticate(bearer(context))
            if (admin) { AccountAccessService.requireAdmin(user) }
            let id = user.getOrganizationId().getOrDefault({ => "" })
            if (id.isEmpty()) { throw BusinessException(ErrorCode.UNAUTHORIZED, 403, "账号未绑定机构") }
            let rows = MySqlConnection.query(database, "SELECT code, name, short_name, " +
                "(logo_data IS NOT NULL), CAST(UNIX_TIMESTAMP(logo_updated_at) * 1000 AS UNSIGNED), " +
                "DATE_FORMAT(logo_updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') FROM organizations WHERE id = " +
                AuthUtilities.uuidSql(id) + " LIMIT 1")
            if (rows.isEmpty()) { throw BusinessException(ErrorCode.UNAUTHORIZED, 403, "账号所属机构不存在") }
            let row = rows[0]
            var data = "{\"code\":" + quoted(row[0].getOrThrow()) + ",\"name\":" + quoted(row[1].getOrThrow())
            if (let Some(value) <- row[2]) { data += ",\"shortName\":" + quoted(value) }
            if (row[3].getOrThrow() == "1") {
                data += ",\"logoUrl\":" + quoted("/api/v1/organization/branding/logo?v=" + row[4].getOrDefault({ => "0" }))
            }
            if (let Some(value) <- row[5]) { data += ",\"logoUpdatedAt\":" + quoted(value) }
            return wrap("success", data + "}")
        })
    }
    public func resetPassword(context: HttpContext): Unit {
        handle(context, { =>
            let object = body(context)
            let request = VerificationController.parseRegister(JsonValue.fromStr("{\"email\":" +
                quoted(required(object, "email", 255)) + ",\"password\":" +
                quoted(required(object, "newPassword", 64)) + ",\"verificationCode\":" +
                quoted(required(object, "verificationCode", 6)) + "}").asObject())
            let email = AuthUtilities.normalizeEmail(request.email)
            let existing = UserRepository(database).findByEmail(email)
            if (existing.isNone()) { throw BusinessException(ErrorCode.EMAIL_NOT_FOUND, 400, "该邮箱尚未注册") }
            let hash = BCryptPasswordEncoder().encode(request.password)
            let result = DbTransaction.run<UserResponse>(database, { tx =>
                codes.verifyAndConsume(tx, email, "PASSWORD_RESET", request.verificationCode)
                let rows = tx.query(AccountAccessService.columns() + " FROM users u WHERE u.id = " +
                    AuthUtilities.uuidSql(existing.getOrThrow().getId()) + " FOR UPDATE")
                if (rows.isEmpty()) { throw BusinessException(ErrorCode.EMAIL_NOT_FOUND, 400, "该邮箱尚未注册") }
                let user = UserRepository.fromRow(rows[0])
                if (!user.isActive()) { throw BusinessException(ErrorCode.ACCOUNT_DISABLED, 403, "账户已停用") }
                tx.execute("UPDATE users SET password_hash = " + AuthUtilities.text(hash) +
                    ", updated_at = UTC_TIMESTAMP(6) WHERE id = " + AuthUtilities.uuidSql(user.getId()))
                user.changePassword(hash)
                return UserResponse.from(user)
            })
            return wrap("密码重置成功", AuthController.userJson(result))
        })
    }
    public func learners(context: HttpContext): Unit {
        handle(context, { =>
            let user = access.authenticate(bearer(context))
            let admin = match (user.getAccountType()) { case AccountType.ADMIN => true; case _ => false }
            let learnerFilter = if (admin) { "" } else { " WHERE l.user_id = " + AuthUtilities.uuidSql(user.getId()) }
            let scoresSql = "CASE WHEN JSON_VALID(l.scores_json) THEN l.scores_json ELSE '{}' END"
            let rows = MySqlConnection.query(database, "SELECT LOWER(BIN_TO_UUID(l.id, 0)), l.code, l.name, l.avatar, " +
                "l.role, l.education, l.target_job, l.weekly_hours, l.learning_style_json, " + scoresSql +
                ", l.goal, l.blind_spots_json, l.preferred_format, l.diagnosis_summary, l.confidence_method, l.confidence_value, " +
                "DATE_FORMAT(l.created_at, '%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(l.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ'), " +
                "COALESCE((SELECT ROUND(AVG(CAST(JSON_UNQUOTE(JSON_EXTRACT(" + scoresSql +
                ", CONCAT('$.', JSON_QUOTE(k.code)))) AS SIGNED)), 1) FROM JSON_TABLE(JSON_KEYS(" + scoresSql +
                "), '$[*]' COLUMNS(code VARCHAR(255) PATH '$')) k), 0) FROM learners l" + learnerFilter + " ORDER BY l.created_at ASC")
            var result = "["
            let names = ["id", "code", "name", "avatar", "role", "education", "targetJob", "weeklyHours", "learningStyle",
                "scores", "goal", "blindSpots", "preferredFormat", "diagnosisSummary", "confidenceMethod", "confidenceValue", "createdAt", "updatedAt"]
            for (index in 0..rows.size) {
                if (index > 0) { result += "," }
                let row = rows[index]
                var scores = jsonValue(row[9], "{}", false)
                var overall = row[18].getOrDefault({ => "0" })
                if (scores == "{}") {
                    let points = MySqlConnection.query(database, "SELECT code FROM knowledge_point WHERE status = 1 ORDER BY sort_order ASC, id ASC")
                    scores = "{"
                    for (i in 0..points.size) {
                        if (i > 0) { scores += "," }
                        scores += quoted(points[i][0].getOrThrow()) + ":50"
                    }
                    scores += "}"
                    overall = if (points.isEmpty()) { "0" } else { "50.0" }
                }
                result += "{"
                var first = true
                for (i in 0..names.size) {
                    var value = ""
                    if (i == 8 || i == 11) { value = jsonValue(row[i], "[]", true) }
                    else if (i == 9) { value = scores }
                    else if (i == 7 || i == 15) {
                        if (row[i].isNone()) { continue }
                        value = row[i].getOrThrow()
                    } else {
                        if (row[i].isNone()) { continue }
                        value = quoted(row[i].getOrThrow())
                    }
                    if (!first) { result += "," }
                    first = false
                    result += quoted(names[i]) + ":" + value
                }
                result += ",\"overallMastery\":" + overall + "}"
            }
            return wrap("success", result + "]")
        })
    }
    private static func jsonValue(value: Option<String>, fallback: String, array: Bool): String {
        try {
            let parsed = JsonValue.fromStr(value.getOrDefault({ => fallback }))
            if (array) { parsed.asArray() } else { parsed.asObject() }
            return parsed.toString()
        } catch (_: Exception) { return fallback }
    }
    public static func bearer(context: HttpContext): String {
        let header = context.request.headers["Authorization"].first.getOrDefault({ => "" })
        if (!header.startsWith("Bearer ")) { throw AccountAccessService.unauthorized() }
        let token = String.fromUtf8(header.toArray().slice(7, header.toArray().size - 7)).trim()
        if (token.isEmpty()) { throw AccountAccessService.unauthorized() }
        return token
    }
    private static func handle(context: HttpContext, work: () -> String): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try { let response = work(); context.response.statusCode = 200; context.response.write(response) }
        catch (e: BusinessException) { context.response.statusCode = UInt16(e.status); context.response.write(AuthController.errorJson(e.code, e.message)) }
        catch (_: Exception) {
            context.response.statusCode = 500
            context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
            println("Account access request failed with an internal error")
        }
    }
    private static func body(context: HttpContext): JsonObject {
        if (context.request.contentType.getOrDefault({ => "" }).split(";")[0].trim().toLower(CasingOption.Other) != "application/json") {
            throw BusinessException(ErrorCode.VALIDATION_FAILED, 415, "Content-Type must be application/json")
        }
        try { return JsonValue.fromStr(AuthController.readBody(context)).asObject() }
        catch (e: BusinessException) { throw e }
        catch (_: Exception) { throw invalid("请求必须是 JSON 对象") }
    }
    private static func optional(object: JsonObject, key: String, max: Int64): Option<String> {
        if (let Some(value) <- object.get(key)) {
            if (value.toString() == "null") { return None }
            let text = try { value.asString().getValue() } catch (_: Exception) { throw invalid("${key} 必须为文本") }
            var length = 0
            for (byte in text.toArray()) { if (byte < 128 || byte >= 192) { length += if (byte >= 240) { 2 } else { 1 } } }
            if (length > max) { throw invalid("${key} 长度超过上限") }
            return Some(text)
        }
        return None
    }
    private static func required(object: JsonObject, key: String, max: Int64): String {
        let text = optional(object, key, max).getOrDefault({ => "" })
        if (text.trim().isEmpty()) { throw invalid("缺少有效字段：${key}") }
        return text
    }
    private static func integer(object: JsonObject, key: String, min: Int64, max: Int64): Option<Int64> {
        if (let Some(value) <- object.get(key)) {
            if (value.toString() == "null") { return None }
            let number = try { Int64.parse(value.toString()) } catch (_: Exception) { throw invalid("${key} 必须为整数") }
            if (number < min || number > max) { throw invalid("${key} 超出允许范围") }
            return Some(number)
        }
        return None
    }
    private static func quoted(value: String): String { return JsonString(value).toString() }
    private static func wrap(message: String, data: String): String { return wrap(message, Some(data)) }
    private static func wrap(message: String, data: Option<String>): String {
        return "{\"code\":0,\"message\":" + quoted(message) +
            match (data) { case Some(value) => ",\"data\":" + value; case None => "" } +
            ",\"timestamp\":" + quoted(DateTime.nowUTC().toString()) + "}"
    }
    private static func invalid(message: String): BusinessException { return BusinessException(ErrorCode.VALIDATION_FAILED, 400, message) }
}
