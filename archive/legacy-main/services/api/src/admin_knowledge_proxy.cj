package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.crypto.digest.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * P4-F1: 管理员知识服务代理，移植自 Spring Boot
 * web/AdminKnowledgeProxyController.java + service/AdminServiceProxy.java。
 *
 *   ANY api/v1/admin/knowledge-core/{*rest}  -> KNOWLEDGE_CORE_URL
 *   ANY api/v1/admin/questions/{*rest}       -> QUESTIONBANK_URL
 *
 * 与 Java 的契约保持一致：
 *   - 先 requireUserApi，再要求 users.account_type='ADMIN' 且
 *     organization_id 非空；否则 403 + ApiResponse code 1006。
 *   - 内部路径白名单在 Spire 本地判定，白名单外不发任何上游请求。
 *   - 上游状态码 / Content-Type / X-Request-Id / 响应体原样透传，
 *     不做 JSON 重编码。
 *   - 配置了 KC_INTERNAL_SECRET / QB_INTERNAL_SECRET 时附加
 *     X-ITN-Timestamp / X-ITN-Nonce / X-ITN-Signature（canonical 不含 query）。
 *
 * api/v1/admin/predeal 下的路径仍由 gateway.cj 的兜底规则转发给 Java。
 */

const AK_KC_PREFIX: String = "api/v1/admin/knowledge-core"
const AK_QB_PREFIX: String = "api/v1/admin/questions"

const AK_CODE_UNAUTHORIZED: Int64 = 1006
const AK_CODE_UPSTREAM_UNAVAILABLE: Int64 = 3001

const AK_ADMIN_DENIED: String = "仅管理员账号可以访问知识管理服务"
const AK_PATH_DENIED: String = "该内部服务路径未在平台白名单中开放"
const AK_UPSTREAM_UNAVAILABLE: String = "上游知识服务不可用"

let AK_KC_GET_PATHS: Array<String> = [
    "/health",
    "/knowledge/categories",
    "/knowledge/coverage",
    "/knowledge/chunks",
    "/knowledge/chunks/by-ids",
    "/knowledge/classifications/audit",
    "/knowledge/graph/edges",
    "/knowledge/documents"
]

let AK_KC_POST_PATHS: Array<String> = [
    "/knowledge/classifications/correct",
    "/knowledge/graph/validate",
    "/knowledge/graph/prerequisites",
    "/knowledge/graph/review"
]

let AK_QB_GET_PATHS: Array<String> = [
    "/categories",
    "/stats/overview",
    "/stats/by-category",
    "/review-queue"
]

let AK_QB_POST_PATHS: Array<String> = [
    "/import",
    "/review/batch"
]

struct AkAdmin {
    let userId: String
    let orgId: String

    init(userId: String, orgId: String) {
        this.userId = userId
        this.orgId = orgId
    }
}

/* ---- 注册：literal catch-all，必须早于 registerGatewayRoutes ---- */

public func registerAdminKnowledgeProxyRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.map(AK_KC_PREFIX + "/{*rest}") {
        ctx => handleKnowledgeCoreProxy(ctx, cfg)
    }
    app.map(AK_KC_PREFIX) {
        ctx => handleKnowledgeCoreProxy(ctx, cfg)
    }
    app.map(AK_QB_PREFIX + "/{*rest}") {
        ctx => handleQuestionBankProxy(ctx, cfg)
    }
    app.map(AK_QB_PREFIX) {
        ctx => handleQuestionBankProxy(ctx, cfg)
    }
}

/* ---- 鉴权 ---- */

func akLoadAdmin(conn: MyConnection, userId: Array<Byte>): ?AkAdmin {
    let sql = "SELECT account_type,organization_id FROM users WHERE id=" +
        sqlBinary(userId) + " LIMIT 1"
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return None
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return None
            }
            let row = rs.rows[0]
            if (row.size < 2 || cellText(row, 0) != "ADMIN" || row[1].isNull ||
                row[1].bytes.size != 16) {
                return None
            }
            return Some(AkAdmin(uuidFormat(userId), uuidFormat(row[1].bytes)))
    }
}

func akAdminContext(ctx: HttpContext, cfg: AppConfig): ?AkAdmin {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return None
        case Some(userId) =>
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    return None
                case Some(conn) =>
                    let admin = akLoadAdmin(conn, userId)
                    conn.close()
                    match (admin) {
                        case None =>
                            writeApiErr(ctx.response, 403, AK_CODE_UNAUTHORIZED, AK_ADMIN_DENIED)
                            return None
                        case Some(a) => return Some(a)
                    }
            }
    }
}

/* ---- KnowledgeCore ---- */

func handleKnowledgeCoreProxy(ctx: HttpContext, cfg: AppConfig): Unit {
    match (akAdminContext(ctx, cfg)) {
        case None => return
        case Some(admin) =>
            let method = ctx.request.method.toAsciiUpper()
            let suffix = akSuffix(ctx.request, AK_KC_PREFIX)
            if (!akKcAllowed(method, suffix)) {
                writeApiErr(ctx.response, 403, AK_CODE_UNAUTHORIZED, AK_PATH_DENIED)
                return
            }
            let upstreamPath = if (suffix == "/health") {
                "/health"
            } else {
                "/api/v1" + suffix
            }
            akForward(ctx, cfg.knowledgeCoreUrl, cfg.kcInternalSecret, method,
                      upstreamPath, admin)
    }
}

/* ---- QuestionBank ---- */

func handleQuestionBankProxy(ctx: HttpContext, cfg: AppConfig): Unit {
    match (akAdminContext(ctx, cfg)) {
        case None => return
        case Some(admin) =>
            let method = ctx.request.method.toAsciiUpper()
            let suffix = akSuffix(ctx.request, AK_QB_PREFIX)
            if (!akQbAllowed(method, suffix)) {
                writeApiErr(ctx.response, 403, AK_CODE_UNAUTHORIZED, AK_PATH_DENIED)
                return
            }
            akForward(ctx, cfg.questionBankUrl, cfg.qbInternalSecret, method,
                      "/v1/questions" + suffix, admin)
    }
}

/* ---- 内部路径白名单 ---- */

func akInList(value: String, values: Array<String>): Bool {
    for (v in values) {
        if (v == value) {
            return true
        }
    }
    return false
}

func akAllDigits(text: String): Bool {
    if (text.size == 0) {
        return false
    }
    for (ch in text.toArray()) {
        let v = Int64(ch) & 0xff
        if (v < 48 || v > 57) {
            return false
        }
    }
    return true
}

/* GET /knowledge/documents/{id} 与 /knowledge/documents/{id}/chunks */
func akKcDocumentPath(suffix: String): Bool {
    let prefix = "/knowledge/documents/"
    if (!suffix.startsWith(prefix)) {
        return false
    }
    let rest = suffix[prefix.size..suffix.size]
    if (rest.size == 0) {
        return false
    }
    let parts = rest.split("/")
    if (parts.size == 1) {
        return parts[0].size > 0
    }
    if (parts.size == 2) {
        return parts[0].size > 0 && parts[1] == "chunks"
    }
    return false
}

/* POST /knowledge/graph/edges/{id}/(approve|reject|reverse) */
func akKcGraphEdgeAction(suffix: String): Bool {
    let prefix = "/knowledge/graph/edges/"
    if (!suffix.startsWith(prefix)) {
        return false
    }
    let rest = suffix[prefix.size..suffix.size]
    let parts = rest.split("/")
    if (parts.size != 2 || !akAllDigits(parts[0])) {
        return false
    }
    return parts[1] == "approve" || parts[1] == "reject" || parts[1] == "reverse"
}

/* DELETE /knowledge/graph/edges/{id} */
func akKcGraphEdgeDelete(suffix: String): Bool {
    let prefix = "/knowledge/graph/edges/"
    if (!suffix.startsWith(prefix)) {
        return false
    }
    let rest = suffix[prefix.size..suffix.size]
    return rest.size > 0 && !rest.contains("/") && akAllDigits(rest)
}

func akKcAllowed(method: String, suffix: String): Bool {
    if (method == "GET") {
        return akInList(suffix, AK_KC_GET_PATHS) || akKcDocumentPath(suffix)
    }
    if (method == "POST") {
        return akInList(suffix, AK_KC_POST_PATHS) || akKcGraphEdgeAction(suffix)
    }
    if (method == "DELETE") {
        return akKcGraphEdgeDelete(suffix)
    }
    return false
}

/* "/{id}" */
func akQbItem(suffix: String): Bool {
    if (!suffix.startsWith("/")) {
        return false
    }
    let rest = suffix[1..suffix.size]
    return rest.size > 0 && !rest.contains("/") && akAllDigits(rest)
}

/* "/{id}/{tail}" */
func akQbItemTail(suffix: String, tail: String): Bool {
    if (!suffix.startsWith("/")) {
        return false
    }
    let rest = suffix[1..suffix.size]
    let parts = rest.split("/")
    if (parts.size != 2 || !akAllDigits(parts[0])) {
        return false
    }
    return parts[1] == tail
}

func akQbAllowed(method: String, suffix: String): Bool {
    if (method == "GET") {
        if (suffix.size == 0 || akInList(suffix, AK_QB_GET_PATHS)) {
            return true
        }
        return akQbItem(suffix) || akQbItemTail(suffix, "stats")
    }
    if (method == "POST") {
        if (suffix.size == 0 || akInList(suffix, AK_QB_POST_PATHS)) {
            return true
        }
        return akQbItemTail(suffix, "review") || akQbItemTail(suffix, "deprecate")
    }
    if (method == "PUT" || method == "DELETE") {
        return akQbItem(suffix)
    }
    return false
}

/* ---- 转发 ---- */

/* request.path 去掉 "/" + prefix；空前缀（根）返回 ""。 */
func akSuffix(request: HttpRequest, prefix: String): String {
    var path = request.path.toString()
    if (!path.startsWith("/")) {
        path = "/" + path
    }
    let full = "/" + prefix
    if (path.startsWith(full)) {
        return path[full.size..path.size]
    }
    return path
}

func akReadBodyBytes(request: HttpRequest): Array<Byte> {
    let stream = request.body
    let buffer = Array<Byte>(8192, repeat: 0)
    let parts = ArrayList<Byte>()
    try {
        while (true) {
            let n = stream.read(buffer)
            if (n <= 0) {
                break
            }
            let chunk = buffer.slice(0, n)
            var i: Int64 = 0
            while (i < n) {
                parts.add(chunk[i])
                i += 1
            }
        }
    } catch (_: Exception) {
        /* keep whatever arrived */
    }
    return parts.toArray()
}

func akHmacSha256Hex(secret: String, text: String): String {
    try {
        let mac = HMAC(secret.toArray(), HashType.SHA256)
        mac.write(text.toArray())
        return bytesToHex(mac.finish())
    } catch (_: Exception) {
        return ""
    }
}

func akHexDigit(v: Int64): UInt8 {
    if (v < 10) {
        return UInt8(48 + v)
    }
    return UInt8(55 + v)
}

/*
 * queryString 保留入站原始百分号编码；但 stdx 的出站客户端在解析 URL 时会把
 * %XX 解码一次（实测 %41 -> A、%E4%B8%AD -> UTF-8 字节）。这里先按字节把
 * % 转义为 %25（并把非 ASCII / 空白编码），客户端解码一次后上游收到的仍是
 * 原始查询串，与 Java getQueryString() 的透传结果一致。
 */
func akEncodeQuery(raw: String): String {
    let safe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789" +
        "-._~!$&'()*+,;=:@/?"
    let out = ArrayList<Byte>()
    for (b in raw.toArray()) {
        let v = Int64(b) & 0xff
        let ch = String.fromUtf8(Array<Byte>(1, repeat: b))
        if (v >= 0x21 && v <= 0x7e && safe.contains(ch)) {
            out.add(b)
        } else {
            out.add(b'%')
            out.add(akHexDigit((v >> 4) & 0x0f))
            out.add(akHexDigit(v & 0x0f))
        }
    }
    return String.fromUtf8(out.toArray())
}

func akRequestId(request: HttpRequest): String {
    match (request.headers.get("X-Request-Id")) {
        case Some(v) =>
            if (v.size > 0) {
                return v[0..(if (v.size > 64) { 64 } else { v.size })]
            }
            return uuidFormat(uuidV4())
        case None => return uuidFormat(uuidV4())
    }
}

func akSecretValue(secret: ?String): ?String {
    match (secret) {
        case None => return None
        case Some(raw) =>
            let s = raw.trimAscii()
            if (s.size == 0) {
                return None
            }
            return Some(s)
    }
}

func akTrimTrailingSlash(value: String): String {
    if (value.endsWith("/")) {
        return value[0..(value.size - 1)]
    }
    return value
}

func akForward(ctx: HttpContext, baseUrl: String, secretOpt: ?String, method: String,
               upstreamPath: String, admin: AkAdmin): Unit {
    match (parseUpstreamUrl(akTrimTrailingSlash(baseUrl))) {
        case None =>
            writeApiErr(ctx.response, 502, AK_CODE_UPSTREAM_UNAVAILABLE, AK_UPSTREAM_UNAVAILABLE)
            return
        case Some(target) =>
            let body = akReadBodyBytes(ctx.request)
            var query = ctx.request.queryString.toString()
            if (query.startsWith("?")) {
                query = query[1..query.size]
            }
            if (query.size > 0) {
                query = akEncodeQuery(query)
            }
            let pathAndQuery = upstreamPath + (if (query.size > 0) { "?" + query } else { "" })

            let headers = ArrayList<(String, String)>()
            match (ctx.request.headers.get("Content-Type")) {
                case Some(v) =>
                    if (v.size > 0) {
                        headers.add(("Content-Type", v))
                    }
                case None => ()
            }
            match (ctx.request.headers.get("Accept")) {
                case Some(v) =>
                    if (v.size > 0) {
                        headers.add(("Accept", v))
                    }
                case None => ()
            }
            headers.add(("X-Request-Id", akRequestId(ctx.request)))
            headers.add(("X-ITN-User-Id", admin.userId))
            headers.add(("X-ITN-Organization-Id", admin.orgId))
            headers.add(("X-ITN-Roles", "admin"))

            match (akSecretValue(secretOpt)) {
                case Some(secret) =>
                    let timestamp = nowEpochSeconds().toString()
                    let nonce = bytesToHex(uuidV4())
                    let bodyHash = bytesToHex(sha256Bytes(body))
                    let canonical = method + "\n" + upstreamPath + "\n" + timestamp +
                        "\n" + nonce + "\n" + admin.userId + "\n" + bodyHash
                    headers.add(("X-ITN-Timestamp", timestamp))
                    headers.add(("X-ITN-Nonce", nonce))
                    headers.add(("X-ITN-Signature", akHmacSha256Hex(secret, canonical)))
                case None => ()
            }

            let client = UpstreamClient.create(target, 120000, 30000)
            try {
                match (client.forward(UpstreamRequest(method, pathAndQuery, body,
                                                      headers.toArray()))) {
                    case ForwardOutcome.Failed(_) =>
                        writeApiErr(ctx.response, 502, AK_CODE_UPSTREAM_UNAVAILABLE,
                                    AK_UPSTREAM_UNAVAILABLE)
                    case ForwardOutcome.Ok(up) =>
                        ctx.response.statusCode = up.status
                        for ((name, values) in up.headers) {
                            let lower = name.toAsciiLower()
                            if (lower == "content-type") {
                                if (values.size > 0) {
                                    ctx.response.contentType = values[0]
                                }
                            } else if (lower == "x-request-id") {
                                for (v in values) {
                                    ctx.response.headers.add("X-Request-Id", v)
                                }
                            }
                        }
                        if (up.body.size > 0) {
                            ctx.response.write(up.body)
                        }
                }
            } finally {
                client.close()
            }
    }
}
