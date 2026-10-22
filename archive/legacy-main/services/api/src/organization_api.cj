package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import std.random.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * 机构与成员管理（Spring Boot /api/v1/organization、/api/v1/admin）——
 * 从 OrganizationController 移植到 Spire。
 *
 *   GET    /api/v1/organization/branding            机构品牌（任意登录用户）
 *   GET    /api/v1/organization/branding/logo       机构 Logo 字节流
 *   GET    /api/v1/admin/organization               机构品牌（机构管理员）
 *   PUT    /api/v1/admin/organization               改名 + 缩写
 *   DELETE /api/v1/admin/organization/logo          恢复默认 Logo
 *   GET    /api/v1/admin/users                      本机构账号分页
 *   GET    /api/v1/admin/users/{id}                 本机构账号详情
 *   POST   /api/v1/admin/users/{id}/enable          启用账号
 *   POST   /api/v1/admin/users/{id}/disable         停用账号
 *   POST   /api/v1/admin/users/{id}/reset           重置学习者使用记录
 *   POST   /api/v1/admin/organization/invites       生成机构邀请码
 *
 * 有意仍留在 Java 的一条：POST /api/v1/admin/organization/logo
 * 它是 multipart 上传 + ImageIO 重新编码（最长边压到 1024 的 PNG），
 * 仓颉侧没有图像编解码库，硬搬会改变落库字节，所以继续走 gateway 转发。
 *
 * 契约来源：
 *   web/OrganizationController.java:48-126
 *   service/OrganizationAdminService.java:53-290
 *   service/OrganizationInviteService.java:33-79
 *   domain/{Organization,OrganizationInvite,User}.java
 *   web/dto/{OrganizationBrandingResponse,AdminUserResponse,AdminUserPageResponse,
 *            UpdateOrganizationRequest,CreateOrganizationInviteRequest,
 *            OrganizationInviteResponse,ApiResponse}.java
 *   web/GlobalExceptionHandler.java + exception/ErrorCode.java
 *   security/JwtAuthenticationFilter.java -> requireUserApi（已存在）
 *
 * 列类型：organizations / organization_invites / users 的时间列都是
 * timestamp(6)，读出来要按 dbUtcOffsetMicros 折算成 UTC 再打印。
 */

/* ==================== 路由 ==================== */

/* exception/ErrorCode.java */
const ORG_CODE_VALIDATION_FAILED: Int64 = 1000
const ORG_CODE_UNAUTHORIZED: Int64 = 1006
const ORG_CODE_INTERNAL_ERROR: Int64 = 1500
const ORG_CODE_KNOWLEDGE_ASSET_NOT_FOUND: Int64 = 4001

public func registerOrganizationRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("api/v1/organization/branding") {
        ctx => orgHandleBranding(ctx, cfg)
    }
    app.mapGet("api/v1/organization/branding/logo") {
        ctx => orgHandleLogo(ctx, cfg)
    }
    app.mapGet("api/v1/admin/organization") {
        ctx => orgHandleAdminOrganization(ctx, cfg)
    }
    app.mapPut("api/v1/admin/organization") {
        ctx => orgHandleUpdateOrganization(ctx, cfg)
    }
    app.mapDelete("api/v1/admin/organization/logo") {
        ctx => orgHandleDeleteLogo(ctx, cfg)
    }
    app.mapGet("api/v1/admin/users") {
        ctx => orgHandleUsers(ctx, cfg)
    }
    app.mapGet("api/v1/admin/users/{id}") {
        ctx => orgHandleUser(ctx, cfg)
    }
    app.mapPost("api/v1/admin/users/{id}/enable") {
        ctx => orgHandleSetEnabled(ctx, cfg, true)
    }
    app.mapPost("api/v1/admin/users/{id}/disable") {
        ctx => orgHandleSetEnabled(ctx, cfg, false)
    }
    app.mapPost("api/v1/admin/users/{id}/reset") {
        ctx => orgHandleResetUsage(ctx, cfg)
    }
    app.mapPost("api/v1/admin/organization/invites") {
        ctx => orgHandleCreateInvite(ctx, cfg)
    }
}

/* ==================== 鉴权 / 机构解析 ==================== */

struct OrgCaller {
    let userId: Array<Byte>
    let accountType: String
    let orgId: ?Array<Byte>

    init(userId: Array<Byte>, accountType: String, orgId: ?Array<Byte>) {
        this.userId = userId
        this.accountType = accountType
        this.orgId = orgId
    }
}

func orgLoadCaller(conn: MyConnection, userId: Array<Byte>): ?OrgCaller {
    let sql = "SELECT account_type,organization_id FROM users WHERE id=" +
        sqlBinary(userId) + " LIMIT 1"
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return None
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return None
            }
            let row = rs.rows[0]
            var orgId: ?Array<Byte> = None
            if (row.size >= 2 && !row[1].isNull && row[1].bytes.size == 16) {
                orgId = Some(row[1].bytes)
            }
            return Some(OrgCaller(userId, cellText(row, 0), orgId))
    }
}

/*
 * OrganizationAdminService.requireOrganizationAdmin — 403 / 1006
 * 「仅机构管理员可以执行此操作」。注意先判管理员，再判机构是否存在。
 */
func orgRequireAdmin(caller: OrgCaller, response: HttpResponse): Bool {
    match (caller.orgId) {
        case None =>
            writeApiErr(response, 403, ORG_CODE_UNAUTHORIZED, "仅机构管理员可以执行此操作")
            return false
        case Some(_) =>
            if (caller.accountType != "ADMIN") {
                writeApiErr(response, 403, ORG_CODE_UNAUTHORIZED, "仅机构管理员可以执行此操作")
                return false
            }
            return true
    }
}

/*
 * OrganizationAdminService.requireOrganization —— 未加入机构 403，
 * 机构行不存在 403。两条都是 1006 UNAUTHORIZED。
 */
func orgRequireOrganization(conn: MyConnection, caller: OrgCaller,
                            response: HttpResponse): ?Array<Byte> {
    match (caller.orgId) {
        case None =>
            writeApiErr(response, 403, ORG_CODE_UNAUTHORIZED, "当前账号未加入机构")
            return None
        case Some(orgId) =>
            let sql = "SELECT id FROM organizations WHERE id=" + sqlBinary(orgId) + " LIMIT 1"
            match (conn.query(sql)) {
                case QueryOutcome.Ok(_) =>
                    writeApiErr(response, 403, ORG_CODE_UNAUTHORIZED, "账号所属机构不存在")
                    return None
                case QueryOutcome.ResultSet(rs) =>
                    if (rs.rows.isEmpty()) {
                        writeApiErr(response, 403, ORG_CODE_UNAUTHORIZED, "账号所属机构不存在")
                        return None
                    }
                    return Some(orgId)
            }
    }
}

struct OrgAdminCtx {
    let conn: MyConnection
    let caller: OrgCaller
    let orgId: Array<Byte>

    init(conn: MyConnection, caller: OrgCaller, orgId: Array<Byte>) {
        this.conn = conn
        this.caller = caller
        this.orgId = orgId
    }
}

/* requireUserApi -> openDb -> 管理员 -> 机构存在。 */
func orgAdminContext(ctx: HttpContext, cfg: AppConfig): ?OrgAdminCtx {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return None
        case Some(userId) =>
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
                    return None
                case Some(conn) =>
                    match (orgLoadCaller(conn, userId)) {
                        case None =>
                            conn.close()
                            writeApiErr(ctx.response, 403, ORG_CODE_UNAUTHORIZED,
                                "仅机构管理员可以执行此操作")
                            return None
                        case Some(caller) =>
                            if (!orgRequireAdmin(caller, ctx.response)) {
                                conn.close()
                                return None
                            }
                            match (orgRequireOrganization(conn, caller, ctx.response)) {
                                case None =>
                                    conn.close()
                                    return None
                                case Some(orgId) =>
                                    return Some(OrgAdminCtx(conn, caller, orgId))
                            }
                    }
            }
    }
}

/* requireUserApi -> openDb -> 机构存在（不要求 ADMIN）。 */
struct OrgViewCtx {
    let conn: MyConnection
    let orgId: Array<Byte>

    init(conn: MyConnection, orgId: Array<Byte>) {
        this.conn = conn
        this.orgId = orgId
    }
}

func orgViewContext(ctx: HttpContext, cfg: AppConfig): ?OrgViewCtx {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return None
        case Some(userId) =>
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
                    return None
                case Some(conn) =>
                    match (orgLoadCaller(conn, userId)) {
                        case None =>
                            conn.close()
                            writeApiErr(ctx.response, 403, ORG_CODE_UNAUTHORIZED,
                                "当前账号未加入机构")
                            return None
                        case Some(caller) =>
                            match (orgRequireOrganization(conn, caller, ctx.response)) {
                                case None =>
                                    conn.close()
                                    return None
                                case Some(orgId) =>
                                    return Some(OrgViewCtx(conn, orgId))
                            }
                    }
            }
    }
}

/* ==================== 品牌 / Logo ==================== */

/*
 * SELECT 列序：0 code,1 name,2 short_name,3 logo_data,4 logo_updated_at
 * logo_data 是 MEDIUMBLOB，只用来判空，避免把整块字节拉进内存。
 */
func orgBrandingColumns(): String {
    "SELECT code,name,short_name," +
        "CASE WHEN logo_data IS NULL THEN 0 ELSE 1 END,logo_updated_at"
}

func orgBrandingJson(conn: MyConnection, row: Array<MyCell>, utcOff: Int64): String {
    let code = cellText(row, 0)
    let name = cellText(row, 1)
    let shortName = optCellText(row, 2)
    let hasLogo = (optCellInt(row, 3) ?? 0) != 0
    let logoUpdatedAt = optCellText(row, 4)
    let w = JsonWriter()
    w.putStr("code", code)
    w.putStr("name", name)
    w.putOptStr("shortName", shortName)
    if (hasLogo) {
        let millis = match (logoUpdatedAt) {
            case Some(t) => timePartsToEpochMicros(parseDbDatetime(
                shiftTimestampText(t, utcOff))) / 1000
            case None => 0
        }
        w.putStr("logoUrl", "/api/v1/organization/branding/logo?v=" + millis.toString())
    } else {
        w.putRaw("logoUrl", "null")
    }
    w.putRaw("logoUpdatedAt", orgTimeJson(logoUpdatedAt, utcOff))
    return w.toJson()
}

func orgTimeJson(text: ?String, utcOff: Int64): String {
    match (text) {
        case None => return "null"
        case Some(t) =>
            if (t.size == 0) {
                return "null"
            }
            return jsonQuote(isoInstantFromDb(shiftTimestampText(t, utcOff)))
    }
}

func orgHandleBranding(ctx: HttpContext, cfg: AppConfig): Unit {
    match (orgViewContext(ctx, cfg)) {
        case None => ()
        case Some(c) =>
            try {
                let utcOff = dbUtcOffsetMicros(c.conn)
                let sql = orgBrandingColumns() + " FROM organizations WHERE id=" +
                    sqlBinary(c.orgId) + " LIMIT 1"
                match (c.conn.query(sql)) {
                    case QueryOutcome.Ok(_) =>
                        c.conn.close()
                        writeApiErr(ctx.response, 403, ORG_CODE_UNAUTHORIZED, "账号所属机构不存在")
                    case QueryOutcome.ResultSet(rs) =>
                        if (rs.rows.isEmpty()) {
                            c.conn.close()
                            writeApiErr(ctx.response, 403, ORG_CODE_UNAUTHORIZED,
                                "账号所属机构不存在")
                            return
                        }
                        let body = apiOk(orgBrandingJson(c.conn, rs.rows[0], utcOff))
                        c.conn.close()
                        writeJson(ctx.response, 200, body)
                }
            } catch (e: Exception) {
                c.conn.close()
                writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

/*
 * GET /organization/branding/logo —— 没有 Logo 时 404 / 4001「机构尚未配置 Logo」。
 * Cache-Control 来自 CacheControl.maxAge(1h).cachePrivate()。
 */
func orgHandleLogo(ctx: HttpContext, cfg: AppConfig): Unit {
    match (orgViewContext(ctx, cfg)) {
        case None => ()
        case Some(c) =>
            var mime: ?String = None
            var bytes: ?Array<Byte> = None
            var failed = false
            try {
                let sql = "SELECT logo_content_type,logo_data FROM organizations WHERE id=" +
                    sqlBinary(c.orgId) + " LIMIT 1"
                match (c.conn.query(sql)) {
                    case QueryOutcome.Ok(_) => failed = true
                    case QueryOutcome.ResultSet(rs) =>
                        if (!rs.rows.isEmpty()) {
                            let row = rs.rows[0]
                            if (row.size >= 2 && !row[1].isNull && row[1].bytes.size > 0) {
                                bytes = Some(row[1].bytes)
                                let ct = cellText(row, 0)
                                mime = Some(if (ct.size == 0) { "application/octet-stream" } else { ct })
                            }
                        }
                }
            } catch (e: Exception) {
                failed = true
            }
            c.conn.close()
            if (failed) {
                writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
                return
            }
            match (bytes) {
                case None =>
                    writeApiErr(ctx.response, 404, ORG_CODE_KNOWLEDGE_ASSET_NOT_FOUND,
                        "机构尚未配置 Logo")
                case Some(data) =>
                    ctx.response.contentType = mime ?? "application/octet-stream"
                    ctx.response.headers.add("Cache-Control", "max-age=3600, private")
                    ctx.response.write(data)
            }
    }
}

func orgHandleAdminOrganization(ctx: HttpContext, cfg: AppConfig): Unit {
    match (orgAdminContext(ctx, cfg)) {
        case None => ()
        case Some(c) =>
            try {
                let utcOff = dbUtcOffsetMicros(c.conn)
                let sql = orgBrandingColumns() + " FROM organizations WHERE id=" +
                    sqlBinary(c.orgId) + " LIMIT 1"
                match (c.conn.query(sql)) {
                    case QueryOutcome.Ok(_) =>
                        c.conn.close()
                        writeApiErr(ctx.response, 403, ORG_CODE_UNAUTHORIZED, "账号所属机构不存在")
                    case QueryOutcome.ResultSet(rs) =>
                        if (rs.rows.isEmpty()) {
                            c.conn.close()
                            writeApiErr(ctx.response, 403, ORG_CODE_UNAUTHORIZED,
                                "账号所属机构不存在")
                            return
                        }
                        let body = apiOk(orgBrandingJson(c.conn, rs.rows[0], utcOff))
                        c.conn.close()
                        writeJson(ctx.response, 200, body)
                }
            } catch (e: Exception) {
                c.conn.close()
                writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

/* ==================== PUT /admin/organization ==================== */

/*
 * Jackson 对 String 目标会接受标量（数字 / 布尔），其余类型视为不可读，
 * 与 GlobalExceptionHandler 的 400「请求体不是有效的 JSON 或字段类型错误」一致。
 */
func orgBodyString(obj: JsonValue, field: String): ?String {
    if (!isJsObject(obj)) {
        return None
    }
    match (obj.asObject().get(field)) {
        case None => return None
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsNull => return None
                case JsonKind.JsString => return Some(v.asString().getValue())
                case JsonKind.JsInt => return Some(v.asInt().getValue().toString())
                case JsonKind.JsFloat => return Some(javaDoubleText(v.asFloat().getValue()))
                case JsonKind.JsBool => return Some(if (v.asBool().getValue()) { "true" } else { "false" })
                case _ => return None
            }
    }
}

func orgBodyInt(obj: JsonValue, field: String): ?Int64 {
    match (jsonObjOptInt(obj, field)) {
        case Some(v) => return Some(v)
        case None => ()
    }
    /* 字符串数字："12" —— Jackson 对 Integer 目标接受字符串数字。 */
    match (orgBodyString(obj, field)) {
        case Some(text) => return Int64.tryParse(text.trimAscii())
        case None => return None
    }
}

/* @NotBlank @Size(max=128) name; @NotBlank @Size(max=64) shortName */
func orgValidateUpdate(body: JsonValue): ?Array<String> {
    let errors = ArrayList<String>()
    let name = orgBodyString(body, "name")
    match (name) {
        case None => errors.add("name: must not be blank")
        case Some(v) =>
            if (v.trimAscii().size == 0) {
                errors.add("name: must not be blank")
            } else if (orgUtf8Len(v) > 128) {
                errors.add("name: size must be between 0 and 128")
            }
    }
    let shortName = orgBodyString(body, "shortName")
    match (shortName) {
        case None => errors.add("shortName: must not be blank")
        case Some(v) =>
            if (v.trimAscii().size == 0) {
                errors.add("shortName: must not be blank")
            } else if (orgUtf8Len(v) > 64) {
                errors.add("shortName: size must be between 0 and 64")
            }
    }
    if (errors.size == 0) {
        return None
    }
    return Some(errors.toArray())
}

/* @Size 的语义是 UTF-16 code unit 数；ASCII 与中文 BMP 字符都按 1 计。 */
func orgUtf8Len(value: String): Int64 {
    value.toRuneArray().size
}

func orgHandleUpdateOrganization(ctx: HttpContext, cfg: AppConfig): Unit {
    match (orgAdminContext(ctx, cfg)) {
        case None => ()
        case Some(c) =>
            let raw = readBodyText(ctx.request).trimAscii()
            var parsed: ?JsonValue = None
            if (raw.size > 0) {
                parsed = jsonParse(raw)
            }
            match (parsed) {
                case None =>
                    c.conn.close()
                    writeApiErr(ctx.response, 400, ORG_CODE_VALIDATION_FAILED,
                        "请求体不是有效的 JSON 或字段类型错误")
                case Some(body) =>
                    if (!isJsObject(body)) {
                        c.conn.close()
                        writeApiErr(ctx.response, 400, ORG_CODE_VALIDATION_FAILED,
                            "请求体不是有效的 JSON 或字段类型错误")
                        return
                    }
                    match (orgValidateUpdate(body)) {
                        case Some(errors) =>
                            c.conn.close()
                            writeApiErr(ctx.response, 400, ORG_CODE_VALIDATION_FAILED,
                                orgJoin(errors, "; "))
                        case None =>
                            let name = (orgBodyString(body, "name") ?? "").trimAscii()
                            let shortName = (orgBodyString(body, "shortName") ?? "").trimAscii()
                            orgApplyUpdate(ctx, c, name, shortName)
                    }
            }
    }
}

func orgApplyUpdate(ctx: HttpContext, c: OrgAdminCtx, name: String, shortName: String): Unit {
    let requestId = orgRequestId(ctx.request)
    try {
        let utcOff = dbUtcOffsetMicros(c.conn)
        arBegin(c.conn)
        let orgSql = orgBrandingColumns() + " FROM organizations WHERE id=" +
            sqlBinary(c.orgId) + " LIMIT 1 FOR UPDATE"
        var beforeName = ""
        var beforeShort: ?String = None
        var code = ""
        var logoUpdatedAt: ?String = None
        var hasLogo = false
        match (c.conn.query(orgSql)) {
            case QueryOutcome.Ok(_) =>
                arRollback(c.conn)
                c.conn.close()
                writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
                return
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    arRollback(c.conn)
                    c.conn.close()
                    writeApiErr(ctx.response, 403, ORG_CODE_UNAUTHORIZED, "账号所属机构不存在")
                    return
                }
                let row = rs.rows[0]
                code = cellText(row, 0)
                beforeName = cellText(row, 1)
                beforeShort = optCellText(row, 2)
                hasLogo = (optCellInt(row, 3) ?? 0) != 0
                logoUpdatedAt = optCellText(row, 4)
        }
        let update = "UPDATE organizations SET name=" + sqlQuote(name) +
            ",short_name=" + sqlQuote(shortName) + ",updated_at=NOW(6) WHERE id=" +
            sqlBinary(c.orgId)
        arExec(c.conn, update)
        let beforeJson = "{\"name\":" + jsonQuote(beforeName) +
            ",\"shortName\":" + sqlNullableJson(beforeShort) + "}"
        let afterJson = "{\"name\":" + jsonQuote(name) +
            ",\"shortName\":" + jsonQuote(shortName) + "}"
        let auditOk = orgAudit(c.conn, c, "ORGANIZATION_BRANDING_UPDATED", "organization",
            uuidFormat(c.orgId), beforeJson, afterJson, requestId)
        if (!auditOk) {
            arRollback(c.conn)
            c.conn.close()
            writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
            return
        }
        arCommit(c.conn)
        let w = JsonWriter()
        w.putStr("code", code)
        w.putStr("name", name)
        w.putStr("shortName", shortName)
        if (hasLogo) {
            let millis = match (logoUpdatedAt) {
                case Some(t) => timePartsToEpochMicros(parseDbDatetime(
                    shiftTimestampText(t, utcOff))) / 1000
                case None => 0
            }
            w.putStr("logoUrl", "/api/v1/organization/branding/logo?v=" + millis.toString())
        } else {
            w.putRaw("logoUrl", "null")
        }
        w.putRaw("logoUpdatedAt", orgTimeJson(logoUpdatedAt, utcOff))
        let body = arOkMsg("机构信息已更新", w.toJson())
        c.conn.close()
        writeJson(ctx.response, 200, body)
    } catch (e: Exception) {
        try {
            arRollback(c.conn)
        } catch (re: Exception) {
            ()
        }
        c.conn.close()
        writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
    }
}

func sqlNullableJson(value: ?String): String {
    match (value) {
        case None => return "null"
        case Some(v) => return jsonQuote(v)
    }
}

/* ==================== DELETE /admin/organization/logo ==================== */

func orgHandleDeleteLogo(ctx: HttpContext, cfg: AppConfig): Unit {
    match (orgAdminContext(ctx, cfg)) {
        case None => ()
        case Some(c) =>
            let requestId = orgRequestId(ctx.request)
            try {
                let utcOff = dbUtcOffsetMicros(c.conn)
                arBegin(c.conn)
                let selectSql = orgBrandingColumns() + " FROM organizations WHERE id=" +
                    sqlBinary(c.orgId) + " LIMIT 1 FOR UPDATE"
                var code = ""
                var name = ""
                var shortName: ?String = None
                match (c.conn.query(selectSql)) {
                    case QueryOutcome.Ok(_) =>
                        arRollback(c.conn)
                        c.conn.close()
                        writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
                        return
                    case QueryOutcome.ResultSet(rs) =>
                        if (rs.rows.isEmpty()) {
                            arRollback(c.conn)
                            c.conn.close()
                            writeApiErr(ctx.response, 403, ORG_CODE_UNAUTHORIZED,
                                "账号所属机构不存在")
                            return
                        }
                        let row = rs.rows[0]
                        code = cellText(row, 0)
                        name = cellText(row, 1)
                        shortName = optCellText(row, 2)
                }
                arExec(c.conn, "UPDATE organizations SET logo_data=NULL," +
                    "logo_content_type=NULL,logo_updated_at=NULL,updated_at=NOW(6)" +
                    " WHERE id=" + sqlBinary(c.orgId))
                let auditOk = orgAudit(c.conn, c, "ORGANIZATION_LOGO_DELETED", "organization",
                    uuidFormat(c.orgId), "", "", requestId)
                if (!auditOk) {
                    arRollback(c.conn)
                    c.conn.close()
                    writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
                    return
                }
                arCommit(c.conn)
                let w = JsonWriter()
                w.putStr("code", code)
                w.putStr("name", name)
                w.putOptStr("shortName", shortName)
                w.putRaw("logoUrl", "null")
                w.putRaw("logoUpdatedAt", "null")
                let body = arOkMsg("机构 Logo 已恢复默认", w.toJson())
                c.conn.close()
                writeJson(ctx.response, 200, body)
            } catch (e: Exception) {
                try {
                    arRollback(c.conn)
                } catch (re: Exception) {
                    ()
                }
                c.conn.close()
                writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

/* ==================== /admin/users ==================== */

func orgAdminUserJson(row: Array<MyCell>, utcOff: Int64): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putStr("email", cellText(row, 1))
    w.putOptStr("nickname", optCellText(row, 2))
    w.putStr("accountType", cellText(row, 3))
    w.putRaw("active", if ((optCellInt(row, 4) ?? 0) != 0) { "true" } else { "false" })
    w.putRaw("createdAt", orgTimeJson(optCellText(row, 5), utcOff))
    w.putRaw("updatedAt", orgTimeJson(optCellText(row, 6), utcOff))
    return w.toJson()
}

func orgUserColumns(): String {
    "SELECT id,email,nickname,account_type,active,created_at,updated_at FROM users"
}

func orgHandleUsers(ctx: HttpContext, cfg: AppConfig): Unit {
    match (orgAdminContext(ctx, cfg)) {
        case None => ()
        case Some(c) =>
            var page: Int64 = 0
            var size: Int64 = 20
            match (kIntParam(ctx, "page", 0)) {
                case None =>
                    c.conn.close()
                    return
                case Some(v) => page = v
            }
            match (kIntParam(ctx, "size", 20)) {
                case None =>
                    c.conn.close()
                    return
                case Some(v) => size = v
            }
            let safePage = if (page < 0) { 0 } else { page }
            let safeSize = if (size < 1) { 1 } else if (size > 100) { 100 } else { size }
            try {
                let utcOff = dbUtcOffsetMicros(c.conn)
                let total = orgCount(c.conn, "users", "organization_id=" + sqlBinary(c.orgId))
                let sql = orgUserColumns() + " WHERE organization_id=" + sqlBinary(c.orgId) +
                    " ORDER BY created_at DESC LIMIT " + safeSize.toString() +
                    " OFFSET " + (safePage * safeSize).toString()
                let items = JsonArrWriter()
                match (c.conn.query(sql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        for (row in rs.rows) {
                            items.addRaw(orgAdminUserJson(row, utcOff))
                        }
                }
                c.conn.close()
                let totalPages = (total + safeSize - 1) / safeSize
                let w = JsonWriter()
                w.putRaw("items", items.toJson())
                w.putInt("page", safePage)
                w.putInt("size", safeSize)
                w.putInt("totalElements", total)
                w.putInt("totalPages", totalPages)
                writeJson(ctx.response, 200, apiOk(w.toJson()))
            } catch (e: Exception) {
                c.conn.close()
                writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

func orgCount(conn: MyConnection, table: String, condition: String): Int64 {
    let sql = "SELECT COUNT(*) FROM " + table + " WHERE " + condition
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return 0
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return 0
            }
            return optCellInt(rs.rows[0], 0) ?? 0
    }
}

/* @PathVariable UUID -> 400 / 1000「参数类型不正确：id」 */
func orgRouteId(ctx: HttpContext): ?Array<Byte> {
    var text = ""
    match (routeParam(ctx.request, "id")) {
        case Some(t) => text = t
        case None => ()
    }
    match (uuidParse(text)) {
        case Some(bytes) => return Some(bytes)
        case None =>
            writeApiErr(ctx.response, 400, ORG_CODE_VALIDATION_FAILED, "参数类型不正确：id")
            return None
    }
}

/* findByOrganizationId(admin.org, id) -> 404 / 3004「本机构内未找到该账号」 */
func orgLoadScopedUser(conn: MyConnection, targetId: Array<Byte>,
                       orgId: Array<Byte>): ?Array<MyCell> {
    let sql = orgUserColumns() + " WHERE id=" + sqlBinary(targetId) +
        " AND organization_id=" + sqlBinary(orgId) + " LIMIT 1"
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return None
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return None
            }
            return Some(rs.rows[0])
    }
}

func orgHandleUser(ctx: HttpContext, cfg: AppConfig): Unit {
    match (orgAdminContext(ctx, cfg)) {
        case None => ()
        case Some(c) =>
            match (orgRouteId(ctx)) {
                case None => c.conn.close()
                case Some(targetId) =>
                    try {
                        let utcOff = dbUtcOffsetMicros(c.conn)
                        match (orgLoadScopedUser(c.conn, targetId, c.orgId)) {
                            case None =>
                                c.conn.close()
                                writeApiErr(ctx.response, 404, CODE_LEARNER_NOT_FOUND,
                                    "本机构内未找到该账号")
                            case Some(row) =>
                                let body = apiOk(orgAdminUserJson(row, utcOff))
                                c.conn.close()
                                writeJson(ctx.response, 200, body)
                        }
                    } catch (e: Exception) {
                        c.conn.close()
                        writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

func orgHandleSetEnabled(ctx: HttpContext, cfg: AppConfig, enabled: Bool): Unit {
    match (orgAdminContext(ctx, cfg)) {
        case None => ()
        case Some(c) =>
            match (orgRouteId(ctx)) {
                case None => c.conn.close()
                case Some(targetId) =>
                    orgApplySetEnabled(ctx, c, targetId, enabled)
            }
    }
}

func orgApplySetEnabled(ctx: HttpContext, c: OrgAdminCtx, targetId: Array<Byte>,
                        enabled: Bool): Unit {
    let requestId = orgRequestId(ctx.request)
    try {
        let utcOff = dbUtcOffsetMicros(c.conn)
        let targetSql = "SELECT active FROM users WHERE id=" + sqlBinary(targetId) +
            " AND organization_id=" + sqlBinary(c.orgId) + " LIMIT 1"
        var beforeActive: ?Int64 = None
        match (c.conn.query(targetSql)) {
            case QueryOutcome.Ok(_) =>
                c.conn.close()
                writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
                return
            case QueryOutcome.ResultSet(rs) =>
                if (!rs.rows.isEmpty()) {
                    beforeActive = optCellInt(rs.rows[0], 0)
                }
        }
        match (beforeActive) {
            case None =>
                c.conn.close()
                writeApiErr(ctx.response, 404, CODE_LEARNER_NOT_FOUND, "本机构内未找到该账号")
                return
            case Some(_) => ()
        }
        /* 不能停用当前登录的管理员账号（只在 disable 时判）。 */
        if (!enabled && uuidFormat(targetId) == uuidFormat(c.caller.userId)) {
            c.conn.close()
            writeApiErr(ctx.response, 400, ORG_CODE_VALIDATION_FAILED,
                "不能停用当前登录的管理员账号")
            return
        }
        arBegin(c.conn)
        arExec(c.conn, "UPDATE users SET active=" + (if (enabled) { "1" } else { "0" }) +
            ",updated_at=NOW(6) WHERE id=" + sqlBinary(targetId))
        let beforeJson = "{\"active\":" +
            (if ((beforeActive ?? 0) != 0) { "true" } else { "false" }) + "}"
        let afterJson = "{\"active\":" + (if (enabled) { "true" } else { "false" }) + "}"
        let auditOk = orgAudit(c.conn, c, if (enabled) { "USER_ENABLED" } else { "USER_DISABLED" },
            "user", uuidFormat(targetId), beforeJson, afterJson, requestId)
        if (!auditOk) {
            arRollback(c.conn)
            c.conn.close()
            writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
            return
        }
        let row = orgLoadScopedUser(c.conn, targetId, c.orgId)
        arCommit(c.conn)
        match (row) {
            case None =>
                c.conn.close()
                writeApiErr(ctx.response, 404, CODE_LEARNER_NOT_FOUND, "本机构内未找到该账号")
            case Some(r) =>
                let body = arOkMsg(if (enabled) { "账号已启用" } else { "账号已停用" },
                    orgAdminUserJson(r, utcOff))
                c.conn.close()
                writeJson(ctx.response, 200, body)
        }
    } catch (e: Exception) {
        try {
            arRollback(c.conn)
        } catch (re: Exception) {
            ()
        }
        c.conn.close()
        writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
    }
}

/* ==================== POST /admin/users/{id}/reset ==================== */

func orgHandleResetUsage(ctx: HttpContext, cfg: AppConfig): Unit {
    match (orgAdminContext(ctx, cfg)) {
        case None => ()
        case Some(c) =>
            match (orgRouteId(ctx)) {
                case None => c.conn.close()
                case Some(targetId) => orgApplyReset(ctx, c, targetId)
            }
    }
}

func orgApplyReset(ctx: HttpContext, c: OrgAdminCtx, targetId: Array<Byte>): Unit {
    let requestId = orgRequestId(ctx.request)
    try {
        let utcOff = dbUtcOffsetMicros(c.conn)
        let row = orgLoadScopedUser(c.conn, targetId, c.orgId)
        match (row) {
            case None =>
                c.conn.close()
                writeApiErr(ctx.response, 404, CODE_LEARNER_NOT_FOUND, "本机构内未找到该账号")
                return
            case Some(r) =>
                if (cellText(r, 3) != "LEARNER") {
                    c.conn.close()
                    writeApiErr(ctx.response, 400, ORG_CODE_VALIDATION_FAILED,
                        "仅可重置学习者账号的使用记录")
                    return
                }
        }
        orgDeleteLearnerUsage(c.conn, targetId)
        let auditOk = orgAudit(c.conn, c, "USER_USAGE_RESET", "user", uuidFormat(targetId),
            "", "{\"usageReset\":true}", requestId)
        if (!auditOk) {
            c.conn.close()
            writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
            return
        }
        let refreshed = orgLoadScopedUser(c.conn, targetId, c.orgId)
        match (refreshed) {
            case None =>
                c.conn.close()
                writeApiErr(ctx.response, 404, CODE_LEARNER_NOT_FOUND, "本机构内未找到该账号")
            case Some(rr) =>
                let body = arOkMsg("使用记录已重置，该账号将重新进入画像建档",
                    orgAdminUserJson(rr, utcOff))
                c.conn.close()
                writeJson(ctx.response, 200, body)
        }
    } catch (e: Exception) {
        c.conn.close()
        writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
    }
}

/*
 * OrganizationAdminService.deleteLearnerUsage 的逐句移植。
 *
 * 先按已知外键删子表，再扫 information_schema 里所有带 user_id / learner_id
 * 的表兜底清理；users 与 user_identities 显式排除，备份表同样排除。
 * Java 用 SET FOREIGN_KEY_CHECKS=0 包住整段，这里保持一致。
 */
func orgDeleteLearnerUsage(conn: MyConnection, userId: Array<Byte>): Unit {
    let userKey = bytesToHexUpper(userId)
    let learnerKeys = orgHexIds(conn, "learners", "user_id=" + sqlBinary(userId))
    let chatSessionIds = orgHexIds(conn, "chat_sessions", "user_id=" + sqlBinary(userId))
    let agentSessionIds = orgHexIds(conn, "agent_sessions", "user_id=" + sqlBinary(userId))
    let courseIds = orgHexIds(conn, "generated_courses", "user_id=" + sqlBinary(userId))
    let presentationChatSessionIds = orgHexIds(conn, "presentation_chat_sessions",
        "user_id=" + sqlBinary(userId))
    let agentRunIds = orgTextIds(conn, "agent_runs", userKey)

    arExec(conn, "SET FOREIGN_KEY_CHECKS = 0")
    try {
        orgDeleteBinaryIds(conn, "chat_messages", "session_id", chatSessionIds)
        orgDeleteBinaryIds(conn, "chat_attachments", "session_id", chatSessionIds)
        orgDeleteBinaryIds(conn, "presentation_chat_messages", "session_id",
            presentationChatSessionIds)
        orgDeleteBinaryIds(conn, "generated_course_chapters", "course_id", courseIds)
        orgDeleteTextIds(conn, "agent_events", "run_id", agentRunIds)
        orgDeleteDirectOwnerTables(conn, userKey, learnerKeys)
    } finally {
        arExec(conn, "SET FOREIGN_KEY_CHECKS = 1")
    }
}

/* SELECT HEX(id) FROM <table> WHERE <condition> */
func orgHexIds(conn: MyConnection, table: String, condition: String): Array<String> {
    let out = ArrayList<String>()
    let sql = "SELECT HEX(id) FROM " + table + " WHERE " + condition
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => ()
        case QueryOutcome.ResultSet(rs) =>
            for (row in rs.rows) {
                out.add(cellText(row, 0))
            }
    }
    return out.toArray()
}

/* ownerTextIds：UPPER(REPLACE(user_id,'-','')) 比 32 位大写 hex。 */
func orgTextIds(conn: MyConnection, table: String, userKey: String): Array<String> {
    let out = ArrayList<String>()
    let sql = "SELECT id FROM " + table +
        " WHERE UPPER(REPLACE(user_id, '-', ''))=" + sqlQuote(userKey)
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => ()
        case QueryOutcome.ResultSet(rs) =>
            for (row in rs.rows) {
                out.add(cellText(row, 0))
            }
    }
    return out.toArray()
}

func orgDeleteBinaryIds(conn: MyConnection, table: String, column: String,
                        hexIds: Array<String>): Unit {
    if (hexIds.size == 0) {
        return
    }
    let out = ArrayList<String>()
    for (h in hexIds) {
        out.add("X'" + h.toAsciiLower() + "'")
    }
    arExec(conn, "DELETE FROM " + table + " WHERE " + column +
        " IN (" + orgJoin(out.toArray(), ",") + ")")
}

func orgDeleteTextIds(conn: MyConnection, table: String, column: String,
                      keys: Array<String>): Unit {
    if (keys.size == 0) {
        return
    }
    let out = ArrayList<String>()
    for (k in keys) {
        out.add(sqlQuote(k))
    }
    arExec(conn, "DELETE FROM " + table + " WHERE " + column +
        " IN (" + orgJoin(out.toArray(), ",") + ")")
}

struct OrgOwnerColumn {
    let table: String
    let column: String
    let binary: Bool

    init(table: String, column: String, binary: Bool) {
        this.table = table
        this.column = column
        this.binary = binary
    }
}

func orgDeleteDirectOwnerTables(conn: MyConnection, userKey: String,
                                learnerKeys: Array<String>): Unit {
    let sql = "SELECT table_name,column_name,data_type FROM information_schema.columns" +
        " WHERE table_schema=DATABASE()" +
        " AND LOWER(column_name) IN ('user_id','learner_id')" +
        " AND table_name NOT IN ('users','user_identities')" +
        " AND table_name NOT LIKE 'codex_backup_%'" +
        " AND table_name NOT LIKE 'generated_learning_resources_backup%'" +
        " ORDER BY table_name"
    let cols = ArrayList<OrgOwnerColumn>()
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => ()
        case QueryOutcome.ResultSet(rs) =>
            for (row in rs.rows) {
                let table = cellText(row, 0)
                let column = cellText(row, 1)
                let dataType = cellText(row, 2).toAsciiLower()
                cols.add(OrgOwnerColumn(table, column, dataType == "binary"))
            }
    }
    for (col in cols) {
        let isUserColumn = col.column.toAsciiLower() == "user_id"
        let userKeys = Array<String>(1, repeat: userKey)
        if (isUserColumn) {
            if (col.binary) {
                orgDeleteBinaryIds(conn, col.table, col.column, userKeys)
            } else {
                orgDeleteTextIds(conn, col.table, col.column, userKeys)
            }
        } else {
            if (learnerKeys.size == 0) {
                continue
            }
            if (col.binary) {
                orgDeleteBinaryIds(conn, col.table, col.column, learnerKeys)
            } else {
                orgDeleteTextIds(conn, col.table, col.column, learnerKeys)
            }
        }
    }
}

/* ==================== POST /admin/organization/invites ==================== */

/* OrganizationInviteService.ALPHABET */
func orgInviteAlphabet(): Array<Byte> {
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".toArray()
}

/*
 * generateCode(): "CB-" + 10 个字母表字符。SecureRandom 的逐字节取模有偏，
 * 这里用拒绝采样把偏差去掉（248 = 8 * 31，只接受 0..247）。
 */
func orgGenerateInviteCode(): String {
    let alphabet = orgInviteAlphabet()
    let rnd = Random()
    var out = "CB-"
    var produced: Int64 = 0
    while (produced < 10) {
        let b = Int64(rnd.nextUInt8())
        if (b >= 248) {
            continue
        }
        out = out + String.fromUtf8(Array<Byte>(1, repeat: alphabet[b % 31]))
        produced += 1
    }
    return out
}

/* normalize(value): 去掉 "-" 与空格再转大写。 */
func orgNormalizeInviteCode(value: String): String {
    var out = ""
    for (b in value.toArray()) {
        let bi = Int64(b)
        if (bi == 45 || bi == 32) {
            continue
        }
        if (bi >= 97 && bi <= 122) {
            out = out + String.fromUtf8(Array<Byte>(1, repeat: UInt8(bi - 32)))
        } else {
            out = out + String.fromUtf8(Array<Byte>(1, repeat: b))
        }
    }
    return out
}

/* CreateOrganizationInviteRequest 的 jakarta 校验。 */
func orgValidateInvite(body: JsonValue): ?Array<String> {
    let errors = ArrayList<String>()
    match (orgBodyString(body, "label")) {
        case Some(v) =>
            if (orgUtf8Len(v) > 128) {
                errors.add("label: size must be between 0 and 128")
            }
        case None => ()
    }
    match (jsonBodyIntOrNull(body, "maxUses")) {
        case Some(v) =>
            if (v < 1) {
                errors.add("maxUses: must be greater than or equal to 1")
            } else if (v > 10000) {
                errors.add("maxUses: must be less than or equal to 10000")
            }
        case None => ()
    }
    match (jsonBodyIntOrNull(body, "expiresInDays")) {
        case Some(v) =>
            if (v < 1) {
                errors.add("expiresInDays: must be greater than or equal to 1")
            } else if (v > 365) {
                errors.add("expiresInDays: must be less than or equal to 365")
            }
        case None => ()
    }
    if (errors.size == 0) {
        return None
    }
    return Some(errors.toArray())
}

/* 区分「缺省 / null」与「有值但类型不对」。类型不对按 Jackson 的 400 处理。 */
func jsonBodyIntOrNull(body: JsonValue, field: String): ?Int64 {
    if (!isJsObject(body)) {
        return None
    }
    match (body.asObject().get(field)) {
        case None => return None
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsNull => return None
                case JsonKind.JsInt => return Some(v.asInt().getValue())
                case JsonKind.JsFloat => return Some(Int64(v.asFloat().getValue()))
                case JsonKind.JsString => return Int64.tryParse(v.asString().getValue().trimAscii())
                case _ => return None
            }
    }
}

func orgHandleCreateInvite(ctx: HttpContext, cfg: AppConfig): Unit {
    match (orgAdminContext(ctx, cfg)) {
        case None => ()
        case Some(c) =>
            let raw = readBodyText(ctx.request).trimAscii()
            var parsed: ?JsonValue = None
            if (raw.size > 0) {
                parsed = jsonParse(raw)
            }
            match (parsed) {
                case None =>
                    c.conn.close()
                    writeApiErr(ctx.response, 400, ORG_CODE_VALIDATION_FAILED,
                        "请求体不是有效的 JSON 或字段类型错误")
                case Some(body) =>
                    if (!isJsObject(body)) {
                        c.conn.close()
                        writeApiErr(ctx.response, 400, ORG_CODE_VALIDATION_FAILED,
                            "请求体不是有效的 JSON 或字段类型错误")
                        return
                    }
                    match (orgValidateInvite(body)) {
                        case Some(errors) =>
                            c.conn.close()
                            writeApiErr(ctx.response, 400, ORG_CODE_VALIDATION_FAILED,
                                orgJoin(errors, "; "))
                        case None =>
                            let labelRaw = orgBodyString(body, "label")
                            let label = orgTrimToNull(labelRaw)
                            let maxUses = jsonBodyIntOrNull(body, "maxUses")
                            let days = jsonBodyIntOrNull(body, "expiresInDays")
                            orgApplyCreateInvite(ctx, c, label, maxUses, days)
                    }
            }
    }
}

func orgTrimToNull(value: ?String): ?String {
    match (value) {
        case None => return None
        case Some(v) =>
            let t = v.trimAscii()
            if (t.size == 0) {
                return None
            }
            return Some(t)
    }
}

func orgApplyCreateInvite(ctx: HttpContext, c: OrgAdminCtx, label: ?String,
                          maxUses: ?Int64, days: ?Int64): Unit {
    try {
        let utcOff = dbUtcOffsetMicros(c.conn)
        let nowMicros = timePartsToEpochMicros(nowUtcParts())
        var plainCode = ""
        var codeHash = ""
        var attempts = 0
        while (attempts < 64) {
            plainCode = orgGenerateInviteCode()
            codeHash = bytesToHex(sha256Bytes(orgNormalizeInviteCode(plainCode).toArray()))
            let sql = "SELECT 1 FROM organization_invites WHERE code_hash=" +
                sqlQuote(codeHash) + " LIMIT 1"
            var exists = false
            match (c.conn.query(sql)) {
                case QueryOutcome.Ok(_) => exists = false
                case QueryOutcome.ResultSet(rs) => exists = !rs.rows.isEmpty()
            }
            if (!exists) {
                break
            }
            attempts += 1
        }
        let inviteId = uuidV4()
        var expiresText: ?String = None
        var expiresJson = "null"
        match (days) {
            case Some(d) =>
                let expMicros = nowMicros + d * 86400000000
                expiresText = Some(mysqlDatetime(epochMicrosToTimeParts(expMicros + utcOff)))
                expiresJson = jsonQuote(isoInstantFromDb(
                    mysqlDatetime(epochMicrosToTimeParts(expMicros))))
            case None => ()
        }
        let createdAtText = mysqlDatetime(epochMicrosToTimeParts(nowMicros + utcOff))
        let createdJson = jsonQuote(isoInstantFromDb(
            mysqlDatetime(epochMicrosToTimeParts(nowMicros))))
        let insert = "INSERT INTO organization_invites" +
            "(id,organization_id,code_hash,label,max_uses,used_count,expires_at," +
            "active,created_by,created_at,updated_at) VALUES(" +
            sqlBinary(inviteId) + "," + sqlBinary(c.orgId) + "," + sqlQuote(codeHash) + "," +
            sqlNullableJson(label) + "," + sqlOptInt(maxUses) + ",0," +
            (match (expiresText) {
                case Some(t) => sqlQuote(t)
                case None => "NULL"
            }) + ",1," + sqlBinary(c.caller.userId) + "," +
            sqlQuote(createdAtText) + "," + sqlQuote(createdAtText) + ")"
        arExec(c.conn, insert)
        let w = JsonWriter()
        w.putStr("id", uuidFormat(inviteId))
        w.putStr("invitationCode", plainCode)
        w.putOptStr("label", label)
        w.putRaw("maxUses", match (maxUses) {
            case Some(v) => v.toString()
            case None => "null"
        })
        w.putInt("usedCount", 0)
        w.putRaw("expiresAt", expiresJson)
        w.putRaw("active", "true")
        w.putRaw("createdAt", createdJson)
        let body = arOkMsg("邀请码已生成，请立即安全发送给机构成员", w.toJson())
        c.conn.close()
        writeJson(ctx.response, 200, body)
    } catch (e: Exception) {
        c.conn.close()
        writeApiErr(ctx.response, 500, ORG_CODE_INTERNAL_ERROR, "服务器内部错误")
    }
}

/* ==================== 公共辅助 ==================== */

/*
 * OrganizationAdminService.audit。organization_audit_log.before_json/after_json
 * 是 JSON 列：直接写 JSON 文本即可（MySQL 5.7 与 8.0 都会在写入时校验并转换），
 * 不用 CAST(? AS JSON)——那是 8.0 才稳的写法。
 */
func orgAudit(conn: MyConnection, c: OrgAdminCtx, action: String, targetType: String,
              targetId: String, beforeJson: String, afterJson: String,
              requestId: String): Bool {
    let beforeSql = if (beforeJson.size == 0) { "NULL" } else { sqlQuote(beforeJson) }
    let afterSql = if (afterJson.size == 0) { "NULL" } else { sqlQuote(afterJson) }
    let sql = "INSERT INTO organization_audit_log" +
        "(organization_id,actor_user_id,action,target_type,target_id," +
        "before_json,after_json,request_id) VALUES(" +
        sqlBinary(c.orgId) + "," + sqlBinary(c.caller.userId) + "," +
        sqlQuote(action) + "," + sqlQuote(targetType) + "," + sqlQuote(targetId) + "," +
        beforeSql + "," + afterSql + "," + sqlQuote(requestId) + ")"
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return true
        case QueryOutcome.ResultSet(_) => return true
    }
}

/* normalizeRequestId: 空则随机 UUID，否则截到 64 字符。 */
func orgRequestId(request: HttpRequest): String {
    var raw = ""
    match (request.headers.get("X-Request-Id")) {
        case Some(v) => raw = v.trimAscii()
        case None => ()
    }
    if (raw.size == 0) {
        return uuidFormat(uuidV4())
    }
    if (raw.size > 64) {
        return raw[0..64]
    }
    return raw
}

func orgJoin(items: Array<String>, sep: String): String {
    var out = ""
    var i: Int64 = 0
    while (i < items.size) {
        if (i > 0) {
            out = out + sep
        }
        out = out + items[i]
        i += 1
    }
    return out
}
