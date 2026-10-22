package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * /api/v1/auth 里三条不涉及签发、bcrypt、邮件的纯数据端点：
 *
 *   GET  /api/v1/auth/me            当前登录用户
 *   POST /api/v1/auth/logout        注销当前会话（置 revoked_at）
 *   POST /api/v1/auth/bind-identity 绑定身份（写 user_identities）
 *
 * 契约来源：
 *   web/AuthController.java:154-171
 *   service/AuthService.java:338-361, 415-425, 441-447
 *   domain/UserIdentity.java, domain/IdentityType.java
 *   web/dto/{UserResponse,BindIdentityRequest,ApiResponse}.java
 *   security/JwtAuthenticationFilter.java -> requireUserApi（已存在）
 *
 * 仍然转发 Java 的：login / register / send-code / *-login / identity-register /
 * reset-password / register-enterprise —— 它们要 bcrypt、验证码与邮件。
 */

const AUTH_CODE_VALIDATION_FAILED: Int64 = 1000
const AUTH_CODE_EMAIL_ALREADY_REGISTERED: Int64 = 1001
const AUTH_CODE_INTERNAL_ERROR: Int64 = 1500

public func registerAuthRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("api/v1/auth/me") {
        ctx => handleAuthMe(ctx, cfg)
    }
    app.mapPost("api/v1/auth/logout") {
        ctx => handleAuthLogout(ctx, cfg)
    }
    app.mapPost("api/v1/auth/bind-identity") {
        ctx => handleBindIdentity(ctx, cfg)
    }
}

/* UserResponse(id, email, nickname, active, createdAt)；created_at 是 timestamp(6)。 */
func authUserJson(row: Array<MyCell>, utcOff: Int64): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putStr("email", cellText(row, 1))
    w.putOptStr("nickname", optCellText(row, 2))
    w.putRaw("active", if ((optCellInt(row, 3) ?? 0) != 0) { "true" } else { "false" })
    match (optCellText(row, 4)) {
        case Some(t) =>
            w.putStr("createdAt", isoInstantFromDb(shiftTimestampText(t, utcOff)))
        case None => w.putRaw("createdAt", "null")
    }
    return w.toJson()
}

func authLoadUser(conn: MyConnection, userId: Array<Byte>, utcOff: Int64): ?String {
    let sql = "SELECT id,email,nickname,active,created_at FROM users WHERE id=" +
        sqlBinary(userId) + " LIMIT 1"
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return None
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return None
            }
            return Some(authUserJson(rs.rows[0], utcOff))
    }
}

/* ==================== GET /api/v1/auth/me ==================== */

func handleAuthMe(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => ()
        case Some(userId) =>
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, AUTH_CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let utcOff = dbUtcOffsetMicros(conn)
                        let body = authLoadUser(conn, userId, utcOff)
                        conn.close()
                        match (body) {
                            case Some(json) => writeJson(ctx.response, 200, apiOk(json))
                            case None =>
                                writeDetail(ctx.response, 401, "Invalid or expired token")
                        }
                    } catch (e: Exception) {
                        conn.close()
                        writeApiErr(ctx.response, 500, AUTH_CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

/* ==================== POST /api/v1/auth/logout ==================== */

/*
 * AuthService.logout：按 token_hash 找会话，revoked_at 为空就置为当前时间。
 * 响应 ApiResponse.success("退出登录成功", null) —— data 被 NON_NULL 丢掉。
 */
func handleAuthLogout(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => ()
        case Some(_) =>
            let token = match (bearerToken(ctx.request)) {
                case Some(t) => t
                case None =>
                    writeDetail(ctx.response, 401, "Bearer token required")
                    return
            }
            let tokenHash = bytesToHex(sha256Bytes(token.toArray()))
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, AUTH_CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        arExec(conn, "UPDATE user_sessions SET revoked_at=NOW(6)" +
                            " WHERE token_hash=" + sqlQuote(tokenHash) +
                            " AND revoked_at IS NULL")
                        conn.close()
                        writeJson(ctx.response, 200, arOkVoid("退出登录成功"))
                    } catch (e: Exception) {
                        conn.close()
                        writeApiErr(ctx.response, 500, AUTH_CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

/* ==================== POST /api/v1/auth/bind-identity ==================== */

/*
 * BindIdentityRequest 的 jakarta 校验（声明顺序）：
 *   identityType  @NotBlank @Size(max=32)
 *   identityValue @NotBlank @Size(max=255)
 *   organizationCode @Size(max=64)
 *   nickname @Size(max=64)   —— 绑定流程里未使用，但仍要校验
 */
func authValidateBind(body: JsonValue): ?Array<String> {
    let errors = ArrayList<String>()
    match (orgBodyString(body, "identityType")) {
        case None => errors.add("identityType: must not be blank")
        case Some(v) =>
            if (v.trimAscii().size == 0) {
                errors.add("identityType: must not be blank")
            } else if (orgUtf8Len(v) > 32) {
                errors.add("identityType: size must be between 0 and 32")
            }
    }
    match (orgBodyString(body, "identityValue")) {
        case None => errors.add("identityValue: must not be blank")
        case Some(v) =>
            if (v.trimAscii().size == 0) {
                errors.add("identityValue: must not be blank")
            } else if (orgUtf8Len(v) > 255) {
                errors.add("identityValue: size must be between 0 and 255")
            }
    }
    match (orgBodyString(body, "organizationCode")) {
        case None => ()
        case Some(v) =>
            if (orgUtf8Len(v) > 64) {
                errors.add("organizationCode: size must be between 0 and 64")
            }
    }
    match (orgBodyString(body, "nickname")) {
        case None => ()
        case Some(v) =>
            if (orgUtf8Len(v) > 64) {
                errors.add("nickname: size must be between 0 and 64")
            }
    }
    if (errors.size == 0) {
        return None
    }
    return Some(errors.toArray())
}

/* IdentityType.valueOf(raw.trim().toUpperCase()) 的白名单。 */
func authIdentityType(value: String): ?String {
    let upper = value.trimAscii().toAsciiUpper()
    if (upper == "ENTERPRISE" || upper == "PHONE" || upper == "WECHAT" || upper == "DEMO") {
        return Some(upper)
    }
    return None
}

func handleBindIdentity(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => ()
        case Some(userId) =>
            let raw = readBodyText(ctx.request).trimAscii()
            var parsed: ?JsonValue = None
            if (raw.size > 0) {
                parsed = jsonParse(raw)
            }
            match (parsed) {
                case None =>
                    writeApiErr(ctx.response, 400, AUTH_CODE_VALIDATION_FAILED,
                        "请求体不是有效的 JSON 或字段类型错误")
                case Some(body) =>
                    if (!isJsObject(body)) {
                        writeApiErr(ctx.response, 400, AUTH_CODE_VALIDATION_FAILED,
                            "请求体不是有效的 JSON 或字段类型错误")
                        return
                    }
                    match (authValidateBind(body)) {
                        case Some(errors) =>
                            writeApiErr(ctx.response, 400, AUTH_CODE_VALIDATION_FAILED,
                                orgJoin(errors, "; "))
                        case None =>
                            let typeRaw = orgBodyString(body, "identityType") ?? ""
                            let identityType = match (authIdentityType(typeRaw)) {
                                case Some(t) => t
                                case None =>
                                    writeApiErr(ctx.response, 400, AUTH_CODE_VALIDATION_FAILED,
                                        "身份类型不合法")
                                    return
                            }
                            let identityValue = (orgBodyString(body, "identityValue") ?? "").trimAscii()
                            let orgCodeRaw = orgBodyString(body, "organizationCode") ?? ""
                            authApplyBind(ctx, cfg, userId, identityType, identityValue, orgCodeRaw)
                    }
            }
    }
}

func authApplyBind(ctx: HttpContext, cfg: AppConfig, userId: Array<Byte>,
                   identityType: String, identityValue: String, orgCodeRaw: String): Unit {
    match (openDb(cfg)) {
        case None =>
            writeApiErr(ctx.response, 500, AUTH_CODE_INTERNAL_ERROR, "服务器内部错误")
        case Some(conn) =>
            try {
                let utcOff = dbUtcOffsetMicros(conn)
                /* 已绑定过（任意账号）-> 409 / 1001 */
                let existsSql = "SELECT 1 FROM user_identities WHERE identity_type=" +
                    sqlQuote(identityType) + " AND identity_value=" +
                    sqlQuote(identityValue) + " LIMIT 1"
                var exists = false
                match (conn.query(existsSql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) => exists = !rs.rows.isEmpty()
                }
                if (exists) {
                    conn.close()
                    writeApiErr(ctx.response, 409, AUTH_CODE_EMAIL_ALREADY_REGISTERED,
                        "该身份已绑定其他账号")
                    return
                }
                /* organizationCode 非空白时按原文查机构；查不到不报错，只是不带 extra。 */
                var orgCode: ?String = None
                if (orgCodeRaw.trimAscii().size > 0) {
                    let orgSql = "SELECT code FROM organizations WHERE code=" +
                        sqlQuote(orgCodeRaw) + " LIMIT 1"
                    match (conn.query(orgSql)) {
                        case QueryOutcome.Ok(_) => ()
                        case QueryOutcome.ResultSet(rs) =>
                            if (!rs.rows.isEmpty()) {
                                orgCode = Some(cellText(rs.rows[0], 0))
                            }
                    }
                }
                var extraSql = "NULL"
                match (orgCode) {
                    case Some(code) =>
                        let extra = JsonWriter()
                        extra.putStr("organizationCode", code)
                        extraSql = sqlQuote(extra.toJson())
                    case None => ()
                }
                let insert = "INSERT INTO user_identities" +
                    "(id,user_id,identity_type,identity_value,identity_extra_json," +
                    "created_at,updated_at) VALUES(" +
                    sqlBinary(uuidV4()) + "," + sqlBinary(userId) + "," +
                    sqlQuote(identityType) + "," + sqlQuote(identityValue) + "," +
                    extraSql + ",NOW(6),NOW(6))"
                arExec(conn, insert)
                let body = authLoadUser(conn, userId, utcOff)
                conn.close()
                match (body) {
                    case Some(json) => writeJson(ctx.response, 200, apiOk(json))
                    case None => writeDetail(ctx.response, 401, "Invalid or expired token")
                }
            } catch (e: Exception) {
                conn.close()
                /* DataIntegrityViolationException -> 409 / 1000 */
                writeApiErr(ctx.response, 409, AUTH_CODE_VALIDATION_FAILED,
                    "数据约束冲突，请检查提交内容")
            }
    }
}
