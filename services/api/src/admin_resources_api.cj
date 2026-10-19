package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.crypto.digest.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * P4-2: 管理员资源中心，移植自 Spring Boot。
 *
 *   GET    api/v1/admin/resources/stats
 *   GET    api/v1/admin/resources
 *   GET    api/v1/admin/resources/{id}
 *   POST   api/v1/admin/resources/{id}/restore
 *   POST   api/v1/admin/resources/{id}/candidate
 *   POST   api/v1/admin/resources/{id}/review
 *   POST   api/v1/admin/resources/{id}/archive
 *   POST   api/v1/admin/resources/{id}/template
 *   DELETE api/v1/admin/resources/{id}
 *   DELETE api/v1/admin/resources/groups
 *   DELETE api/v1/admin/resources/archived
 *   GET    api/v1/learning-template-resources
 *
 * 契约来源:
 *   web/AdminResourceController.java
 *   service/AdminResourceService.java
 *   service/AdminPresentationPurgeClient.java
 *   web/LearningTemplateResourceController.java
 *   web/dto/ApiResponse.java, exception/ErrorCode.java
 *
 * 鉴权与返回信封沿用 learnforge_api.cj 的 /api/v1 既有约定:
 *   requireUserApi -> users.account_type='ADMIN' 且 organization_id 非空,
 *   否则 403 + {"code":1006,...}。
 *   void 端点走 ApiResponse.success(message, null)，因 @JsonInclude(NON_NULL)
 *   省略 data，只输出 code/message/timestamp。
 *
 * 时间字段沿用现有 /api/v1 写法: DATETIME 直接 isoInstantFromDb，
 * TIMESTAMP 先按会话时区 shiftTimestampText 再 isoInstantFromDb。
 */

const AR_CODE_UNAUTHORIZED: Int64 = 1006
const AR_CODE_AGENT_UNAVAILABLE: Int64 = 3001
const AR_CODE_ASSET_NOT_FOUND: Int64 = 4001

const AR_DENIED: String = "仅机构管理员可以执行此操作"
const AR_NOT_FOUND: String = "资源不存在或不属于当前机构"
const AR_PURGE_FAILED: String = "交互课件文件清理失败，未执行彻底删除"
const AR_BAD_JSON: String = "请求体不是有效的 JSON 或字段类型错误"
const AR_DEFAULT_GROUP: String = "默认分组"

/* ---- 注册 ---- */

public func registerAdminResourceRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("api/v1/admin/resources/stats") {
        ctx => handleAdminResourceStats(ctx, cfg)
    }
    app.mapGet("api/v1/admin/resources") {
        ctx => handleAdminResourceList(ctx, cfg)
    }
    /* literal 路由先于 /{id} 注册 */
    app.mapDelete("api/v1/admin/resources/groups") {
        ctx => handleAdminResourceDeleteGroup(ctx, cfg)
    }
    app.mapDelete("api/v1/admin/resources/archived") {
        ctx => handleAdminResourcePurgeArchived(ctx, cfg)
    }
    app.mapPost("api/v1/admin/resources/{id}/restore") {
        ctx => handleAdminResourceRestore(ctx, cfg)
    }
    app.mapPost("api/v1/admin/resources/{id}/candidate") {
        ctx => handleAdminResourceCandidate(ctx, cfg)
    }
    app.mapPost("api/v1/admin/resources/{id}/review") {
        ctx => handleAdminResourceReview(ctx, cfg)
    }
    app.mapPost("api/v1/admin/resources/{id}/archive") {
        ctx => handleAdminResourceArchive(ctx, cfg)
    }
    app.mapPost("api/v1/admin/resources/{id}/template") {
        ctx => handleAdminResourceTemplate(ctx, cfg)
    }
    app.mapGet("api/v1/admin/resources/{id}") {
        ctx => handleAdminResourceDetail(ctx, cfg)
    }
    app.mapDelete("api/v1/admin/resources/{id}") {
        ctx => handleAdminResourceDelete(ctx, cfg)
    }
    app.mapGet("api/v1/learning-template-resources") {
        ctx => handleLearningTemplateResources(ctx, cfg)
    }
}

/* ---- 信封 ---- */

/* ApiResponse.success(message, data) */
func arOkMsg(message: String, dataJson: String): String {
    "{\"code\":0,\"message\":" + jsonQuote(message) +
        ",\"data\":" + dataJson +
        ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}"
}

/* ApiResponse.success(message, null): data is dropped by NON_NULL */
func arOkVoid(message: String): String {
    "{\"code\":0,\"message\":" + jsonQuote(message) +
        ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}"
}

/* ---- 鉴权 ---- */

struct ArAdmin {
    let userId: String
    let orgId: String

    init(userId: String, orgId: String) {
        this.userId = userId
        this.orgId = orgId
    }
}

struct ArAdminCtx {
    let conn: MyConnection
    let admin: ArAdmin

    init(conn: MyConnection, admin: ArAdmin) {
        this.conn = conn
        this.admin = admin
    }
}

/*
 * OrganizationAdminService.requireOrganizationAdmin:
 * account_type == ADMIN && organization_id != null, otherwise 403/1006.
 */
func arLoadAdmin(conn: MyConnection, userId: Array<Byte>, response: HttpResponse): ?ArAdmin {
    let sql = "SELECT account_type,organization_id FROM users WHERE id=" +
        sqlBinary(userId) + " LIMIT 1"
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) =>
            writeApiErr(response, 403, AR_CODE_UNAUTHORIZED, AR_DENIED)
            return None
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                writeApiErr(response, 403, AR_CODE_UNAUTHORIZED, AR_DENIED)
                return None
            }
            let row = rs.rows[0]
            let accountType = cellText(row, 0)
            if (accountType != "ADMIN" || row.size < 2 || row[1].isNull ||
                row[1].bytes.size != 16) {
                writeApiErr(response, 403, AR_CODE_UNAUTHORIZED, AR_DENIED)
                return None
            }
            return Some(ArAdmin(uuidFormat(userId), uuidFormat(row[1].bytes)))
    }
}

func arAdminContext(ctx: HttpContext, cfg: AppConfig): ?ArAdminCtx {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return None
        case Some(userId) =>
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    return None
                case Some(conn) =>
                    match (arLoadAdmin(conn, userId, ctx.response)) {
                        case None =>
                            conn.close()
                            return None
                        case Some(admin) =>
                            return Some(ArAdminCtx(conn, admin))
                    }
            }
    }
}

/* learning-template-resources: 只要登录，不要求 ADMIN。 */
struct ArUserCtx {
    let conn: MyConnection
    let userId: Array<Byte>
    let orgId: ?String

    init(conn: MyConnection, userId: Array<Byte>, orgId: ?String) {
        this.conn = conn
        this.userId = userId
        this.orgId = orgId
    }
}

func arUserContext(ctx: HttpContext, cfg: AppConfig): ?ArUserCtx {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return None
        case Some(userId) =>
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    return None
                case Some(conn) =>
                    let sql = "SELECT organization_id FROM users WHERE id=" +
                        sqlBinary(userId) + " LIMIT 1"
                    match (conn.query(sql)) {
                        case QueryOutcome.Ok(_) =>
                            return Some(ArUserCtx(conn, userId, None))
                        case QueryOutcome.ResultSet(rs) =>
                            if (rs.rows.isEmpty() || rs.rows[0].isEmpty() ||
                                rs.rows[0][0].isNull || rs.rows[0][0].bytes.size != 16) {
                                return Some(ArUserCtx(conn, userId, None))
                            }
                            return Some(ArUserCtx(conn, userId,
                                Some(uuidFormat(rs.rows[0][0].bytes))))
                    }
            }
    }
}

func arRouteUuid(ctx: HttpContext): ?Array<Byte> {
    var text = ""
    match (routeParam(ctx.request, "id")) {
        case Some(t) => text = t
        case None => ()
    }
    match (uuidParse(text)) {
        case Some(bytes) => return Some(bytes)
        case None =>
            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "参数类型不正确：id")
            return None
    }
}

/* ---- SQL / 事务辅助 ---- */

/*
 * 16-byte UUID literal. Java binds UUID_TO_BIN(?), but the platform MySQL used
 * by Spire here does not ship that function (MariaDB / MySQL 5.7), so the
 * same BINARY(16) value is inlined as X'hex'. Semantics are identical.
 */
func arUuid(text: String): String {
    let packed = arRemoveDashes(text.trimAscii().toAsciiLower())
    if (packed.size != 32) {
        return "NULL"
    }
    "X'" + packed + "'"
}

func arExec(conn: MyConnection, sql: String): Int64 {
    match (conn.query(sql)) {
        case QueryOutcome.Ok(ok) => return ok.affectedRows
        case QueryOutcome.ResultSet(_) => return 0
    }
}

func arBegin(conn: MyConnection): Unit {
    match (conn.query("START TRANSACTION")) {
        case _ => ()
    }
}

func arCommit(conn: MyConnection): Unit {
    match (conn.query("COMMIT")) {
        case _ => ()
    }
}

func arRollback(conn: MyConnection): Unit {
    match (conn.query("ROLLBACK")) {
        case _ => ()
    }
}

func arCount(conn: MyConnection, presentations: Bool, org: String, condition: String): Int64 {
    let table = if (presentations) { "presentation_tasks" } else { "generated_learning_resources" }
    let sql = "SELECT COUNT(*) FROM " + table + " WHERE organization_id=" +
        arUuid(org) + " AND " + condition
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return 0
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return 0
            }
            return Int64.tryParse(cellText(rs.rows[0], 0)) ?? 0
    }
}

/* DATETIME: no shift. TIMESTAMP: session -> UTC first (learnforge convention). */
func arTimeJson(text: ?String, utcOff: Int64, shift: Bool): String {
    match (text) {
        case None => return "null"
        case Some(t) =>
            let value = if (shift) { shiftTimestampText(t, utcOff) } else { t }
            return jsonQuote(isoInstantFromDb(value))
    }
}

func arRawJsonCell(row: Array<MyCell>, idx: Int64): String {
    if (idx >= row.size || row[idx].isNull) {
        return "null"
    }
    return row[idx].text()
}

func arNonBlank(value: String): Bool {
    value.trimAscii().size > 0
}

/* ---- 列表 / 详情 ---- */

func arResourceListJson(rs: MyResultSet): String {
    let arr = JsonArrWriter()
    for (row in rs.rows) {
        let w = JsonWriter()
        w.putOptStr("id", uuidText(row, 0))
        w.putOptStr("type", optCellText(row, 1))
        w.putOptStr("title", optCellText(row, 2))
        w.putOptStr("topic", optCellText(row, 3))
        w.putOptStr("scope", optCellText(row, 4))
        w.putOptStr("reviewStatus", optCellText(row, 5))
        w.putOptInt("revision", optCellInt(row, 6))
        w.putOptStr("domainCode", optCellText(row, 7))
        w.putOptStr("nodeCode", optCellText(row, 8))
        w.putBool("template", optCellBool(row, 9) ?? false)
        w.putOptStr("groupName", optCellText(row, 10))
        w.putOptStr("baseResourceId", uuidText(row, 11))
        w.putOptStr("learnerId", uuidText(row, 12))
        w.putOptStr("kpId", optCellText(row, 13))
        w.putRaw("createdAt", arTimeJson(optCellText(row, 14), 0, false))
        w.putRaw("updatedAt", arTimeJson(optCellText(row, 15), 0, false))
        w.putRaw("archivedAt", arTimeJson(optCellText(row, 16), 0, false))
        w.putOptStr("archiveReason", optCellText(row, 17))
        w.putOptStr("ownerAccount", optCellText(row, 18))
        arr.addRaw(w.toJson())
    }
    return arr.toJson()
}

func arPresentationListJson(rs: MyResultSet, utcOff: Int64): String {
    let arr = JsonArrWriter()
    for (row in rs.rows) {
        let w = JsonWriter()
        w.putOptStr("id", uuidText(row, 0))
        w.putOptStr("type", optCellText(row, 1))
        w.putOptStr("status", optCellText(row, 2))
        w.putOptStr("title", optCellText(row, 3))
        w.putOptStr("topic", optCellText(row, 4))
        w.putOptStr("scope", optCellText(row, 5))
        w.putOptStr("reviewStatus", optCellText(row, 6))
        w.putOptInt("revision", optCellInt(row, 7))
        w.putOptStr("domainCode", optCellText(row, 8))
        w.putOptStr("nodeCode", optCellText(row, 9))
        w.putBool("template", optCellBool(row, 10) ?? false)
        w.putOptStr("groupName", optCellText(row, 11))
        w.putOptStr("baseResourceId", uuidText(row, 12))
        w.putOptStr("learnerId", uuidText(row, 13))
        w.putOptStr("kpId", optCellText(row, 14))
        w.putRaw("createdAt", arTimeJson(optCellText(row, 15), utcOff, true))
        w.putRaw("updatedAt", arTimeJson(optCellText(row, 16), utcOff, true))
        w.putRaw("archivedAt", arTimeJson(optCellText(row, 17), utcOff, false))
        w.putOptStr("archiveReason", optCellText(row, 18))
        w.putOptStr("ownerAccount", optCellText(row, 19))
        arr.addRaw(w.toJson())
    }
    return arr.toJson()
}

func arAppendTreeFilter(sql: String, alias: String, domainCode: ?String,
                        nodeCode: ?String): String {
    var out = sql
    var domain = ""
    var hasDomain = false
    match (domainCode) {
        case Some(v) =>
            domain = v
            hasDomain = true
        case None => ()
    }
    if (hasDomain && domain == "__unassigned__") {
        out = out + " AND " + alias + ".domain_code IS NULL"
        return out
    }
    if (hasDomain && arNonBlank(domain)) {
        out = out + " AND " + alias + ".domain_code=" + sqlQuote(domain.trimAscii())
    }
    match (nodeCode) {
        case Some(v) =>
            if (arNonBlank(v)) {
                out = out + " AND " + alias + ".category_node_code=" + sqlQuote(v.trimAscii())
            }
        case None => ()
    }
    return out
}

func arListResources(conn: MyConnection, admin: ArAdmin, view: String, typeParam: ?String,
                     keyword: ?String, domainCode: ?String, nodeCode: ?String): String {
    let condition = if (view == "library") {
        "r.archived_at IS NULL AND r.resource_scope='ORGANIZATION'"
    } else {
        "r.archived_at IS NOT NULL"
    }
    var sql = "SELECT r.id id, r.resource_type type, r.title, r.topic, " +
        "r.resource_scope scope, r.review_status reviewStatus, r.revision, " +
        "r.domain_code domainCode, r.category_node_code nodeCode, r.is_template template, " +
        "JSON_UNQUOTE(JSON_EXTRACT(r.context_json,'$.resourceGroup')) groupName, " +
        "r.base_resource_id baseResourceId, " +
        "r.learner_id learnerId, r.kp_id kpId, " +
        "r.created_at createdAt, r.updated_at updatedAt, r.archived_at archivedAt, " +
        "r.archive_reason archiveReason, u.email ownerAccount " +
        "FROM generated_learning_resources r " +
        "LEFT JOIN users u ON u.id=r.user_id " +
        "WHERE r.organization_id=" + arUuid(admin.orgId) + " AND " + condition
    match (typeParam) {
        case Some(t) =>
            if (arNonBlank(t)) {
                sql = sql + " AND r.resource_type=" + sqlQuote(t.trimAscii())
            }
        case None => ()
    }
    sql = arAppendTreeFilter(sql, "r", domainCode, nodeCode)
    match (keyword) {
        case Some(k) =>
            if (arNonBlank(k)) {
                let q = "%" + k.trimAscii() + "%"
                sql = sql + " AND (r.title LIKE " + sqlQuote(q) +
                    " OR r.topic LIKE " + sqlQuote(q) +
                    " OR r.kp_id LIKE " + sqlQuote(q) + ")"
            }
        case None => ()
    }
    sql = sql + " ORDER BY COALESCE(r.archived_at,r.updated_at) DESC LIMIT 500"
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return "[]"
        case QueryOutcome.ResultSet(rs) => return arResourceListJson(rs)
    }
}

func arListPresentations(conn: MyConnection, admin: ArAdmin, view: String,
                         keyword: ?String, domainCode: ?String, nodeCode: ?String): String {
    let condition = if (view == "library") {
        "p.archived_at IS NULL AND p.resource_scope='ORGANIZATION' AND p.status='completed'"
    } else {
        "p.archived_at IS NOT NULL AND p.status='completed'"
    }
    var sql = "SELECT p.id id,'ppt' type,p.status status,p.title," +
        "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'$.generationContext.topicName'))," +
        "JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'$.generationContext.current.topicName'))," +
        "JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'$.requirement')),p.title) topic," +
        "p.resource_scope scope,p.review_status reviewStatus,p.revision," +
        "p.domain_code domainCode,p.category_node_code nodeCode,p.is_template template," +
        "COALESCE(p.resource_group,JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'$.generationContext.groupName')),'默认分组') groupName," +
        "p.base_presentation_id baseResourceId,NULL learnerId," +
        "JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'$.generationContext.kpId')) kpId," +
        "p.created_at createdAt,p.updated_at updatedAt,p.archived_at archivedAt," +
        "p.archive_reason archiveReason,u.email ownerAccount " +
        "FROM presentation_tasks p LEFT JOIN users u ON u.id=p.user_id " +
        "WHERE p.organization_id=" + arUuid(admin.orgId) + " AND " + condition
    sql = arAppendTreeFilter(sql, "p", domainCode, nodeCode)
    match (keyword) {
        case Some(k) =>
            if (arNonBlank(k)) {
                let q = "%" + k.trimAscii() + "%"
                sql = sql + " AND (p.title LIKE " + sqlQuote(q) +
                    " OR JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'$.requirement')) LIKE " +
                    sqlQuote(q) + ")"
            }
        case None => ()
    }
    sql = sql + " ORDER BY COALESCE(p.archived_at,p.updated_at) DESC LIMIT 500"
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return "[]"
        case QueryOutcome.ResultSet(rs) =>
            return arPresentationListJson(rs, dbUtcOffsetMicros(conn))
    }
}

func arResourceDetailJson(row: Array<MyCell>): String {
    let w = JsonWriter()
    w.putOptStr("id", uuidText(row, 0))
    w.putOptStr("type", optCellText(row, 1))
    w.putOptStr("title", optCellText(row, 2))
    w.putOptStr("topic", optCellText(row, 3))
    w.putOptStr("scope", optCellText(row, 4))
    w.putOptStr("reviewStatus", optCellText(row, 5))
    w.putOptInt("revision", optCellInt(row, 6))
    w.putOptStr("domainCode", optCellText(row, 7))
    w.putOptStr("nodeCode", optCellText(row, 8))
    w.putBool("template", optCellBool(row, 9) ?? false)
    w.putOptStr("kpId", optCellText(row, 10))
    w.putOptStr("groupName", optCellText(row, 11))
    w.putRaw("content", arRawJsonCell(row, 12))
    w.putRaw("sources", arRawJsonCell(row, 13))
    w.putRaw("decision", arRawJsonCell(row, 14))
    w.putRaw("createdAt", arTimeJson(optCellText(row, 15), 0, false))
    w.putRaw("updatedAt", arTimeJson(optCellText(row, 16), 0, false))
    w.putRaw("archivedAt", arTimeJson(optCellText(row, 17), 0, false))
    w.putOptStr("archiveReason", optCellText(row, 18))
    return w.toJson()
}

func arPresentationDetailJson(row: Array<MyCell>, utcOff: Int64): String {
    let w = JsonWriter()
    w.putOptStr("id", uuidText(row, 0))
    w.putOptStr("type", optCellText(row, 1))
    w.putOptStr("title", optCellText(row, 2))
    w.putOptStr("topic", optCellText(row, 3))
    w.putOptStr("scope", optCellText(row, 4))
    w.putOptStr("reviewStatus", optCellText(row, 5))
    w.putOptInt("revision", optCellInt(row, 6))
    w.putOptStr("domainCode", optCellText(row, 7))
    w.putOptStr("nodeCode", optCellText(row, 8))
    w.putBool("template", optCellBool(row, 9) ?? false)
    w.putOptStr("kpId", optCellText(row, 10))
    w.putRaw("content", arRawJsonCell(row, 11))
    w.putRaw("sources", arRawJsonCell(row, 12))
    w.putRaw("decision", arRawJsonCell(row, 13))
    w.putRaw("createdAt", arTimeJson(optCellText(row, 14), utcOff, true))
    w.putRaw("updatedAt", arTimeJson(optCellText(row, 15), utcOff, true))
    w.putRaw("archivedAt", arTimeJson(optCellText(row, 16), utcOff, false))
    w.putOptStr("archiveReason", optCellText(row, 17))
    return w.toJson()
}

/* ---- 请求体 ---- */

/* kind: 0 = absent, 1 = malformed/non-object, 2 = parsed object */
struct ArBodyResult {
    let kind: Int64
    let obj: ?JsonObject

    init(kind: Int64, obj: ?JsonObject) {
        this.kind = kind
        this.obj = obj
    }
}

func arReadBody(request: HttpRequest): ArBodyResult {
    let text = readBodyText(request).trimAscii()
    if (text.size == 0) {
        return ArBodyResult(0, None)
    }
    match (jsonParse(text)) {
        case None => return ArBodyResult(1, None)
        case Some(v) =>
            if (isJsObject(v)) {
                return ArBodyResult(2, Some(v.asObject()))
            }
            return ArBodyResult(1, None)
    }
}

/* ---- 审核 ---- */

func arActionStatus(action: String): ?String {
    if (action == "submit") {
        return Some("PENDING")
    }
    if (action == "approve") {
        return Some("APPROVED")
    }
    if (action == "reject") {
        return Some("REJECTED")
    }
    if (action == "publish") {
        return Some("PUBLISHED")
    }
    if (action == "deprecate") {
        return Some("DEPRECATED")
    }
    return None
}

func arTransitionAllowed(action: String, current: String): Bool {
    if (action == "submit") {
        return current == "DRAFT" || current == "REJECTED"
    }
    if (action == "approve" || action == "reject") {
        return current == "PENDING"
    }
    if (action == "publish") {
        return current == "APPROVED"
    }
    if (action == "deprecate") {
        return current == "PUBLISHED"
    }
    return false
}

func arEventSql(admin: ArAdmin, id: String, action: String, from: ?String,
                to: ?String, comment: ?String): String {
    "INSERT INTO learning_resource_review_events(resource_id,organization_id,actor_user_id,action,from_status,to_status,comment) VALUES(" +
        arUuid(id) + "," + arUuid(admin.orgId) + "," + arUuid(admin.userId) + "," +
        sqlQuote(action) + "," + arOptText(from) + "," + arOptText(to) + "," +
        arOptText(comment) + ")"
}

func arPresentationEventSql(admin: ArAdmin, id: String, action: String, from: ?String,
                            to: ?String, comment: ?String): String {
    "INSERT INTO presentation_review_events(presentation_id,organization_id,actor_user_id,action,from_status,to_status,comment) VALUES(" +
        arUuid(id) + "," + arUuid(admin.orgId) + "," + arUuid(admin.userId) + "," +
        sqlQuote(action) + "," + arOptText(from) + "," + arOptText(to) + "," +
        arOptText(comment) + ")"
}

func arOptText(value: ?String): String {
    match (value) {
        case Some(v) => return sqlQuote(v)
        case None => return "NULL"
    }
}

/* ---- handlers ---- */

func handleAdminResourceStats(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            let conn = actx.conn
            let admin = actx.admin
            try {
                let library = arCount(conn, false, admin.orgId,
                        "archived_at IS NULL AND resource_scope='ORGANIZATION'") +
                    arCount(conn, true, admin.orgId,
                        "archived_at IS NULL AND resource_scope='ORGANIZATION'")
                let pending = arCount(conn, false, admin.orgId,
                        "archived_at IS NULL AND resource_scope='ORGANIZATION' AND review_status='PENDING'") +
                    arCount(conn, true, admin.orgId,
                        "archived_at IS NULL AND resource_scope='ORGANIZATION' AND review_status='PENDING'")
                let published = arCount(conn, false, admin.orgId,
                        "archived_at IS NULL AND resource_scope='ORGANIZATION' AND review_status='PUBLISHED'") +
                    arCount(conn, true, admin.orgId,
                        "archived_at IS NULL AND resource_scope='ORGANIZATION' AND review_status='PUBLISHED'")
                let recycle = arCount(conn, false, admin.orgId, "archived_at IS NOT NULL") +
                    arCount(conn, true, admin.orgId, "archived_at IS NOT NULL")
                let w = JsonWriter()
                w.putInt("library", library)
                w.putInt("pending", pending)
                w.putInt("published", published)
                w.putInt("recycle", recycle)
                conn.close()
                writeJson(ctx.response, 200, apiOk(w.toJson()))
            } catch (e: Exception) {
                conn.close()
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

func handleAdminResourceList(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            let conn = actx.conn
            let admin = actx.admin
            var view = "library"
            match (queryParam(ctx.request, "view")) {
                case Some(v) => view = v
                case None => ()
            }
            if (view != "library" && view != "archive" && view != "recycle") {
                conn.close()
                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "资源视图无效")
                return
            }
            let typeParam = queryParam(ctx.request, "type")
            let keyword = queryParam(ctx.request, "keyword")
            let domainCode = queryParam(ctx.request, "domainCode")
            let nodeCode = queryParam(ctx.request, "nodeCode")
            try {
                let items = if (arIsPpt(typeParam)) {
                    arListPresentations(conn, admin, view, keyword, domainCode, nodeCode)
                } else {
                    arListResources(conn, admin, view, typeParam, keyword, domainCode, nodeCode)
                }
                let w = JsonWriter()
                w.putRaw("items", items)
                w.putInt("total", arArrayLen(items))
                conn.close()
                writeJson(ctx.response, 200, apiOk(w.toJson()))
            } catch (e: Exception) {
                conn.close()
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

/* "ppt".equals(type) — raw, not trimmed */
func arIsPpt(typeParam: ?String): Bool {
    match (typeParam) {
        case Some(t) => return t == "ppt"
        case None => return false
    }
}

/* total = items.size(); parse the array we already produced. */
func arArrayLen(itemsJson: String): Int64 {
    match (jsonParse(itemsJson)) {
        case None => return 0
        case Some(v) =>
            if (isJsArray(v)) {
                return v.asArray().size()
            }
            return 0
    }
}

func handleAdminResourceDetail(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            match (arRouteUuid(ctx)) {
                case None =>
                    actx.conn.close()
                case Some(id) =>
                    let conn = actx.conn
                    let admin = actx.admin
                    let idText = uuidFormat(id)
                    try {
                        let sql = "SELECT id,resource_type type,title,topic," +
                            "resource_scope scope,review_status reviewStatus,revision," +
                            "domain_code domainCode,category_node_code nodeCode,is_template template," +
                            "kp_id kpId,JSON_UNQUOTE(JSON_EXTRACT(context_json,'$.resourceGroup')) groupName," +
                            "content_json content,sources_json sources,decision_json decision," +
                            "created_at createdAt,updated_at updatedAt,archived_at archivedAt," +
                            "archive_reason archiveReason FROM generated_learning_resources " +
                            "WHERE id=" + arUuid(idText) + " AND organization_id=" + arUuid(admin.orgId)
                        match (conn.query(sql)) {
                            case QueryOutcome.Ok(_) =>
                                conn.close()
                                writeApiErr(ctx.response, 404, AR_CODE_ASSET_NOT_FOUND, AR_NOT_FOUND)
                            case QueryOutcome.ResultSet(rs) =>
                                if (!rs.rows.isEmpty()) {
                                    let body = arResourceDetailJson(rs.rows[0])
                                    conn.close()
                                    writeJson(ctx.response, 200, apiOk(body))
                                    return
                                }
                                let psql = "SELECT id,'ppt' type,title," +
                                    "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.topicName'))," +
                                    "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.current.topicName'))," +
                                    "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.requirement')),title) topic," +
                                    "resource_scope scope,review_status reviewStatus,revision," +
                                    "domain_code domainCode,category_node_code nodeCode,is_template template," +
                                    "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.kpId')) kpId," +
                                    "request_json content,events_json sources,outline_json decision," +
                                    "created_at createdAt,updated_at updatedAt,archived_at archivedAt," +
                                    "archive_reason archiveReason FROM presentation_tasks " +
                                    "WHERE id=" + arUuid(idText) + " AND organization_id=" + arUuid(admin.orgId)
                                match (conn.query(psql)) {
                                    case QueryOutcome.Ok(_) =>
                                        conn.close()
                                        writeApiErr(ctx.response, 404, AR_CODE_ASSET_NOT_FOUND, AR_NOT_FOUND)
                                    case QueryOutcome.ResultSet(prs) =>
                                        if (prs.rows.isEmpty()) {
                                            conn.close()
                                            writeApiErr(ctx.response, 404, AR_CODE_ASSET_NOT_FOUND, AR_NOT_FOUND)
                                        } else {
                                            let body = arPresentationDetailJson(prs.rows[0],
                                                dbUtcOffsetMicros(conn))
                                            conn.close()
                                            writeJson(ctx.response, 200, apiOk(body))
                                        }
                                }
                        }
                    } catch (e: Exception) {
                        conn.close()
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

func handleAdminResourceRestore(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            match (arRouteUuid(ctx)) {
                case None =>
                    actx.conn.close()
                case Some(id) =>
                    let conn = actx.conn
                    let admin = actx.admin
                    let idText = uuidFormat(id)
                    try {
                        arBegin(conn)
                        let sql = "UPDATE generated_learning_resources SET user_id=" +
                            arUuid(admin.userId) +
                            ",learner_id=NULL,learning_goal_id=NULL,course_id=NULL,chapter_id=NULL," +
                            "archived_at=NULL,archived_by=NULL,archive_reason=NULL," +
                            "resource_scope='ORGANIZATION',review_status='DRAFT',state_json=JSON_OBJECT()," +
                            "is_public=0,updated_at=NOW(6) WHERE id=" + arUuid(idText) +
                            " AND organization_id=" + arUuid(admin.orgId) +
                            " AND archived_at IS NOT NULL"
                        let changed = arExec(conn, sql)
                        if (changed != 1) {
                            let psql = "UPDATE presentation_tasks SET user_id=" + arUuid(admin.userId) +
                                ",archived_at=NULL,archived_by=NULL,archive_reason=NULL," +
                                "resource_scope='ORGANIZATION',review_status='DRAFT'," +
                                "learned_json=JSON_OBJECT(),is_public=0,updated_at=NOW(6) WHERE id=" +
                                arUuid(idText) + " AND organization_id=" + arUuid(admin.orgId) +
                                " AND archived_at IS NOT NULL"
                            let pchanged = arExec(conn, psql)
                            if (pchanged != 1) {
                                arRollback(conn)
                                conn.close()
                                writeApiErr(ctx.response, 404, AR_CODE_ASSET_NOT_FOUND, AR_NOT_FOUND)
                                return
                            }
                            arExec(conn, arPresentationEventSql(admin, idText, "RESTORE", None,
                                Some("DRAFT"), Some("恢复到机构资源库，不绑定学习者")))
                            arCommit(conn)
                            conn.close()
                            writeJson(ctx.response, 200, arOkVoid("资源已恢复到机构资源库草稿"))
                            return
                        }
                        arExec(conn, arEventSql(admin, idText, "RESTORE", None, Some("DRAFT"),
                            Some("恢复到机构资源库，不绑定学习者")))
                        arCommit(conn)
                        conn.close()
                        writeJson(ctx.response, 200, arOkVoid("资源已恢复到机构资源库草稿"))
                    } catch (e: Exception) {
                        arRollback(conn)
                        conn.close()
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

func handleAdminResourceCandidate(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            match (arRouteUuid(ctx)) {
                case None =>
                    actx.conn.close()
                case Some(id) =>
                    let conn = actx.conn
                    let admin = actx.admin
                    let idText = uuidFormat(id)
                    let next = uuidFormat(uuidV4())
                    try {
                        arBegin(conn)
                        let sql = "INSERT INTO generated_learning_resources" +
                            "(id,user_id,organization_id,domain_code,category_node_code,resource_scope," +
                            "review_status,base_resource_id,revision," +
                            "resource_type,title,topic,learning_goal_id,course_id,chapter_id,content_json," +
                            "sources_json,state_json,context_json,decision_json,created_at,updated_at," +
                            "learner_id,kp_id,form,level,version,quiz_ids_json,kb_refs_json,is_public) " +
                            "SELECT " + arUuid(next) + "," + arUuid(admin.userId) +
                            ",organization_id,domain_code,category_node_code,'ORGANIZATION','DRAFT',id,1," +
                            "resource_type,title,topic,NULL,NULL,NULL,content_json,sources_json," +
                            "JSON_OBJECT(),context_json,decision_json,NOW(6),NOW(6),NULL,kp_id,form,level," +
                            "version,quiz_ids_json,kb_refs_json,0 FROM generated_learning_resources " +
                            "WHERE id=" + arUuid(idText) + " AND organization_id=" + arUuid(admin.orgId) +
                            " AND archived_at IS NOT NULL"
                        let changed = arExec(conn, sql)
                        if (changed != 1) {
                            let psql = "INSERT INTO presentation_tasks(id,user_id,organization_id," +
                                "domain_code,category_node_code,resource_scope,review_status," +
                                "base_presentation_id,revision,title,status,progress,stage_message," +
                                "request_json,outline_json,events_json,learned_json,output_path," +
                                "error_message,created_at,updated_at,is_public) SELECT " +
                                arUuid(next) + "," + arUuid(admin.userId) +
                                ",organization_id,domain_code,category_node_code,'ORGANIZATION','DRAFT'," +
                                "id,1,title,status,progress,stage_message,request_json,outline_json," +
                                "events_json,JSON_OBJECT(),output_path,error_message,NOW(6),NOW(6),0 " +
                                "FROM presentation_tasks WHERE id=" + arUuid(idText) +
                                " AND organization_id=" + arUuid(admin.orgId) +
                                " AND archived_at IS NOT NULL"
                            let pchanged = arExec(conn, psql)
                            if (pchanged != 1) {
                                arRollback(conn)
                                conn.close()
                                writeApiErr(ctx.response, 404, AR_CODE_ASSET_NOT_FOUND, AR_NOT_FOUND)
                                return
                            }
                            arExec(conn, arPresentationEventSql(admin, next, "CREATE_CANDIDATE",
                                None, Some("DRAFT"), Some("由历史交互课件复制")))
                            arCommit(conn)
                            conn.close()
                            writeJson(ctx.response, 200,
                                arOkMsg("已复制为通用资源草稿", "{\"id\":" + jsonQuote(next) + "}"))
                            return
                        }
                        arExec(conn, arEventSql(admin, next, "CREATE_CANDIDATE", None,
                            Some("DRAFT"), Some("由历史资源复制，不改变原资源")))
                        arCommit(conn)
                        conn.close()
                        writeJson(ctx.response, 200,
                            arOkMsg("已复制为通用资源草稿", "{\"id\":" + jsonQuote(next) + "}"))
                    } catch (e: Exception) {
                        arRollback(conn)
                        conn.close()
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

func handleAdminResourceReview(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            match (arRouteUuid(ctx)) {
                case None =>
                    actx.conn.close()
                case Some(id) =>
                    let conn = actx.conn
                    let admin = actx.admin
                    let idText = uuidFormat(id)
                    var action = ""
                    var comment: ?String = None
                    let body = arReadBody(ctx.request)
                    if (body.kind != 2) {
                        conn.close()
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, AR_BAD_JSON)
                        return
                    }
                    match (body.obj) {
                        case Some(obj) =>
                            match (jsonGetString(obj, "action")) {
                                case Some(v) => action = v
                                case None => ()
                            }
                            match (jsonGetString(obj, "comment")) {
                                case Some(v) => comment = Some(v)
                                case None => ()
                            }
                        case None => ()
                    }
                    match (arActionStatus(action)) {
                        case None =>
                            conn.close()
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "审核操作无效")
                            return
                        case Some(next) =>
                            try {
                                arBegin(conn)
                                let sql = "SELECT review_status FROM generated_learning_resources " +
                                    "WHERE id=" + arUuid(idText) + " AND organization_id=" +
                                    arUuid(admin.orgId) +
                                    " AND resource_scope='ORGANIZATION' AND archived_at IS NULL"
                                match (conn.query(sql)) {
                                    case QueryOutcome.Ok(_) =>
                                        arRollback(conn)
                                        conn.close()
                                        writeApiErr(ctx.response, 404, AR_CODE_ASSET_NOT_FOUND, AR_NOT_FOUND)
                                    case QueryOutcome.ResultSet(rs) =>
                                        if (rs.rows.isEmpty()) {
                                            let psql = "SELECT review_status FROM presentation_tasks " +
                                                "WHERE id=" + arUuid(idText) + " AND organization_id=" +
                                                arUuid(admin.orgId) +
                                                " AND resource_scope='ORGANIZATION' AND archived_at IS NULL"
                                            match (conn.query(psql)) {
                                                case QueryOutcome.Ok(_) =>
                                                    arRollback(conn)
                                                    conn.close()
                                                    writeApiErr(ctx.response, 404,
                                                        AR_CODE_ASSET_NOT_FOUND, AR_NOT_FOUND)
                                                case QueryOutcome.ResultSet(prs) =>
                                                    if (prs.rows.isEmpty()) {
                                                        arRollback(conn)
                                                        conn.close()
                                                        writeApiErr(ctx.response, 404,
                                                            AR_CODE_ASSET_NOT_FOUND, AR_NOT_FOUND)
                                                    } else {
                                                        arReviewPresentation(conn, ctx, admin, idText,
                                                            action, next, cellText(prs.rows[0], 0),
                                                            comment)
                                                    }
                                            }
                                        } else {
                                            let current = cellText(rs.rows[0], 0)
                                            if (!arTransitionAllowed(action, current)) {
                                                arRollback(conn)
                                                conn.close()
                                                writeApiErr(ctx.response, 400,
                                                    CODE_VALIDATION_FAILED,
                                                    "当前审核状态不允许执行该操作")
                                                return
                                            }
                                            arExec(conn, "UPDATE generated_learning_resources SET review_status=" +
                                                sqlQuote(next) + ",is_public=0,updated_at=NOW(6) WHERE id=" +
                                                arUuid(idText))
                                            arExec(conn, arEventSql(admin, idText,
                                                arUpperAscii(action), Some(current), Some(next), comment))
                                            arCommit(conn)
                                            conn.close()
                                            writeJson(ctx.response, 200,
                                                arOkVoid("审核状态已更新"))
                                        }
                                }
                            } catch (e: Exception) {
                                arRollback(conn)
                                conn.close()
                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            }
                    }
            }
    }
}

func arReviewPresentation(conn: MyConnection, ctx: HttpContext, admin: ArAdmin,
                          idText: String, action: String, next: String, current: String,
                          comment: ?String): Unit {
    if (!arTransitionAllowed(action, current)) {
        arRollback(conn)
        conn.close()
        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "当前审核状态不允许执行该操作")
        return
    }
    arExec(conn, "UPDATE presentation_tasks SET review_status=" + sqlQuote(next) +
        ",is_public=0,updated_at=NOW(6) WHERE id=" + arUuid(idText))
    arExec(conn, arPresentationEventSql(admin, idText, arUpperAscii(action),
        Some(current), Some(next), comment))
    arCommit(conn)
    conn.close()
    writeJson(ctx.response, 200, arOkVoid("审核状态已更新"))
}

/* action.toUpperCase(): actions are ASCII */
func arUpperAscii(text: String): String {
    var out = ""
    for (b in text.toArray()) {
        let v = Int64(b) & 0xff
        if (v >= 97 && v <= 122) {
            out = out + arByteString(UInt8(v - 32))
        } else {
            out = out + arByteString(UInt8(v))
        }
    }
    return out
}

func handleAdminResourceArchive(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            match (arRouteUuid(ctx)) {
                case None =>
                    actx.conn.close()
                case Some(id) =>
                    let conn = actx.conn
                    let admin = actx.admin
                    let idText = uuidFormat(id)
                    var reason: ?String = None
                    let body = arReadBody(ctx.request)
                    if (body.kind == 1) {
                        conn.close()
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, AR_BAD_JSON)
                        return
                    }
                    match (body.obj) {
                        case Some(obj) =>
                            match (jsonGetString(obj, "reason")) {
                                case Some(v) => reason = Some(v)
                                case None => ()
                            }
                        case None => ()
                    }
                    var reasonText = "管理员归档"
                    match (reason) {
                        case Some(rv) =>
                            if (arNonBlank(rv)) {
                                reasonText = rv.trimAscii()
                            }
                        case None => ()
                    }
                    try {
                        arBegin(conn)
                        let sql = "UPDATE generated_learning_resources SET archived_at=NOW(6)," +
                            "archived_by=" + arUuid(admin.userId) + ",archive_reason=" +
                            sqlQuote(reasonText) + ",is_template=0,is_public=0,updated_at=NOW(6) " +
                            "WHERE id=" + arUuid(idText) + " AND organization_id=" +
                            arUuid(admin.orgId) + " AND archived_at IS NULL"
                        let changed = arExec(conn, sql)
                        if (changed != 1) {
                            let psql = "UPDATE presentation_tasks SET archived_at=NOW(6)," +
                                "archived_by=" + arUuid(admin.userId) + ",archive_reason=" +
                                sqlQuote(reasonText) + ",is_template=0,is_public=0,updated_at=NOW(6) " +
                                "WHERE id=" + arUuid(idText) + " AND organization_id=" +
                                arUuid(admin.orgId) + " AND archived_at IS NULL"
                            let pchanged = arExec(conn, psql)
                            if (pchanged != 1) {
                                arRollback(conn)
                                conn.close()
                                writeApiErr(ctx.response, 404, AR_CODE_ASSET_NOT_FOUND, AR_NOT_FOUND)
                                return
                            }
                            arExec(conn, arPresentationEventSql(admin, idText, "ARCHIVE", None,
                                None, reason))
                            arCommit(conn)
                            conn.close()
                            writeJson(ctx.response, 200, arOkVoid("资源已归档"))
                            return
                        }
                        arExec(conn, arEventSql(admin, idText, "ARCHIVE", None, None, reason))
                        arCommit(conn)
                        conn.close()
                        writeJson(ctx.response, 200, arOkVoid("资源已归档"))
                    } catch (e: Exception) {
                        arRollback(conn)
                        conn.close()
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

func handleAdminResourceTemplate(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            match (arRouteUuid(ctx)) {
                case None =>
                    actx.conn.close()
                case Some(id) =>
                    let conn = actx.conn
                    let admin = actx.admin
                    let idText = uuidFormat(id)
                    try {
                        arBegin(conn)
                        let sql = "SELECT domain_code domainCode,category_node_code nodeCode," +
                            "COALESCE(resource_group,'默认分组') resourceGroup " +
                            "FROM generated_learning_resources WHERE id=" + arUuid(idText) +
                            " AND organization_id=" + arUuid(admin.orgId) +
                            " AND resource_scope='ORGANIZATION' AND archived_at IS NULL FOR UPDATE"
                        var found = false
                        var fromPresentation = false
                        var domain: ?String = None
                        var node: ?String = None
                        var group = "默认分组"
                        match (conn.query(sql)) {
                            case QueryOutcome.Ok(_) => ()
                            case QueryOutcome.ResultSet(rs) =>
                                if (!rs.rows.isEmpty()) {
                                    found = true
                                    domain = optCellText(rs.rows[0], 0)
                                    node = optCellText(rs.rows[0], 1)
                                    group = cellText(rs.rows[0], 2)
                                }
                        }
                        if (!found) {
                            let psql = "SELECT domain_code domainCode,category_node_code nodeCode," +
                                "COALESCE(resource_group,'默认分组') resourceGroup " +
                                "FROM presentation_tasks WHERE id=" + arUuid(idText) +
                                " AND organization_id=" + arUuid(admin.orgId) +
                                " AND resource_scope='ORGANIZATION' AND archived_at IS NULL FOR UPDATE"
                            match (conn.query(psql)) {
                                case QueryOutcome.Ok(_) => ()
                                case QueryOutcome.ResultSet(prs) =>
                                    if (!prs.rows.isEmpty()) {
                                        found = true
                                        fromPresentation = true
                                        domain = optCellText(prs.rows[0], 0)
                                        node = optCellText(prs.rows[0], 1)
                                        group = cellText(prs.rows[0], 2)
                                    }
                            }
                        }
                        if (!found) {
                            arRollback(conn)
                            conn.close()
                            writeApiErr(ctx.response, 404, AR_CODE_ASSET_NOT_FOUND, AR_NOT_FOUND)
                            return
                        }
                        var domainText = ""
                        var nodeText = ""
                        match (domain) {
                            case Some(v) => domainText = v
                            case None => ()
                        }
                        match (node) {
                            case Some(v) => nodeText = v
                            case None => ()
                        }
                        if (!arNonBlank(domainText) || !arNonBlank(nodeText)) {
                            arRollback(conn)
                            conn.close()
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED,
                                "未绑定知识点的资源不能设为母版")
                            return
                        }
                        let orgLit = arUuid(admin.orgId)
                        let dLit = sqlQuote(domainText)
                        let nLit = sqlQuote(nodeText)
                        let gLit = sqlQuote(group)
                        arExec(conn, "UPDATE generated_learning_resources SET is_template=0," +
                            "updated_at=NOW(6) WHERE organization_id=" + orgLit +
                            " AND domain_code=" + dLit + " AND category_node_code=" + nLit +
                            " AND resource_scope='ORGANIZATION' AND archived_at IS NULL")
                        arExec(conn, "UPDATE presentation_tasks SET is_template=0," +
                            "updated_at=NOW(6) WHERE organization_id=" + orgLit +
                            " AND domain_code=" + dLit + " AND category_node_code=" + nLit +
                            " AND resource_scope='ORGANIZATION' AND archived_at IS NULL")
                        arExec(conn, "UPDATE generated_learning_resources SET is_template=1," +
                            "updated_at=NOW(6) WHERE organization_id=" + orgLit +
                            " AND domain_code=" + dLit + " AND category_node_code=" + nLit +
                            " AND COALESCE(resource_group,'默认分组')=" + gLit +
                            " AND resource_scope='ORGANIZATION' AND archived_at IS NULL")
                        arExec(conn, "UPDATE presentation_tasks SET is_template=1," +
                            "updated_at=NOW(6) WHERE organization_id=" + orgLit +
                            " AND domain_code=" + dLit + " AND category_node_code=" + nLit +
                            " AND COALESCE(resource_group,'默认分组')=" + gLit +
                            " AND resource_scope='ORGANIZATION' AND archived_at IS NULL")
                        if (fromPresentation) {
                            arExec(conn, arPresentationEventSql(admin, idText, "SET_TEMPLATE",
                                None, None, Some("设为当前知识点与分组的唯一母版")))
                        } else {
                            arExec(conn, arEventSql(admin, idText, "SET_TEMPLATE", None, None,
                                Some("设为当前知识点与分组的唯一母版")))
                        }
                        arCommit(conn)
                        conn.close()
                        writeJson(ctx.response, 200, arOkVoid("已设为母版"))
                    } catch (e: Exception) {
                        arRollback(conn)
                        conn.close()
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

func handleAdminResourceDelete(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            match (arRouteUuid(ctx)) {
                case None =>
                    actx.conn.close()
                case Some(id) =>
                    let conn = actx.conn
                    let admin = actx.admin
                    let idText = uuidFormat(id)
                    try {
                        let sql = "DELETE FROM generated_learning_resources WHERE id=" +
                            arUuid(idText) + " AND organization_id=" + arUuid(admin.orgId) +
                            " AND archived_at IS NOT NULL"
                        let changed = arExec(conn, sql)
                        if (changed == 1) {
                            conn.close()
                            writeJson(ctx.response, 200, arOkVoid("资源已彻底删除"))
                            return
                        }
                        let csql = "SELECT COUNT(*) FROM presentation_tasks WHERE id=" +
                            arUuid(idText) + " AND organization_id=" + arUuid(admin.orgId) +
                            " AND archived_at IS NOT NULL"
                        var count: Int64 = 0
                        match (conn.query(csql)) {
                            case QueryOutcome.Ok(_) => count = 0
                            case QueryOutcome.ResultSet(rs) =>
                                if (!rs.rows.isEmpty()) {
                                    count = Int64.tryParse(cellText(rs.rows[0], 0)) ?? 0
                                }
                        }
                        if (count != 1) {
                            conn.close()
                            writeApiErr(ctx.response, 404, AR_CODE_ASSET_NOT_FOUND, AR_NOT_FOUND)
                            return
                        }
                        match (arPurgeArchivedPresentation(cfg, admin, idText)) {
                            case ArPurgeResult.Done =>
                                conn.close()
                                writeJson(ctx.response, 200, arOkVoid("资源已彻底删除"))
                            case ArPurgeResult.NotFound =>
                                conn.close()
                                writeApiErr(ctx.response, 404, AR_CODE_ASSET_NOT_FOUND,
                                    "交互课件不存在或不属于当前机构归档")
                            case ArPurgeResult.Unavailable =>
                                conn.close()
                                writeApiErr(ctx.response, 502, AR_CODE_AGENT_UNAVAILABLE,
                                    AR_PURGE_FAILED)
                        }
                    } catch (e: Exception) {
                        conn.close()
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

func handleAdminResourceDeleteGroup(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            let conn = actx.conn
            let admin = actx.admin
            var domain = ""
            var node = ""
            var group = ""
            match (queryParam(ctx.request, "domainCode")) {
                case Some(v) => domain = v
                case None => ()
            }
            match (queryParam(ctx.request, "nodeCode")) {
                case Some(v) => node = v
                case None => ()
            }
            match (queryParam(ctx.request, "groupName")) {
                case Some(v) => group = v
                case None => ()
            }
            if (!arNonBlank(domain) || !arNonBlank(node)) {
                conn.close()
                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED,
                    "未绑定知识点的资源不能设为母版")
                return
            }
            if (!arNonBlank(group)) {
                conn.close()
                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "分组名称不能为空")
                return
            }
            let groupName = group.trimAscii()
            if (groupName == AR_DEFAULT_GROUP) {
                conn.close()
                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED,
                    "默认分组不允许彻底删除，可先清空该分组下资源")
                return
            }
            let domainText = domain.trimAscii()
            let nodeText = node.trimAscii()
            /* agents 不可用也继续走下面的 DB 兜底（与 Java 一致）。 */
            match (arDeleteGroupTasks(cfg, admin, domainText, nodeText, groupName)) {
                case _ => ()
            }
            try {
                let orgLit = arUuid(admin.orgId)
                let dLit = sqlQuote(domainText)
                let nLit = sqlQuote(nodeText)
                let gLit = sqlQuote(groupName)
                let rfilter = "organization_id=" + orgLit +
                    " AND resource_scope='ORGANIZATION' AND domain_code=" + dLit +
                    " AND category_node_code=" + nLit +
                    " AND BINARY COALESCE(resource_group,JSON_UNQUOTE(JSON_EXTRACT(context_json,'$.resourceGroup')),'默认分组')=BINARY " +
                    gLit
                let pfilter = "organization_id=" + orgLit +
                    " AND resource_scope='ORGANIZATION' AND domain_code=" + dLit +
                    " AND category_node_code=" + nLit +
                    " AND BINARY COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName')), '默认分组')=BINARY " +
                    gLit
                var resourceIds = 0
                match (conn.query("SELECT id FROM generated_learning_resources WHERE " + rfilter)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) => resourceIds = rs.rows.size
                }
                var presentationIds = 0
                match (conn.query("SELECT id FROM presentation_tasks WHERE " + pfilter)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) => presentationIds = rs.rows.size
                }
                arBegin(conn)
                if (resourceIds > 0) {
                    arExec(conn, "DELETE FROM learning_resource_review_events WHERE resource_id IN " +
                        "(SELECT id FROM generated_learning_resources WHERE " + rfilter + ")")
                    arExec(conn, "DELETE FROM generated_learning_resources WHERE " + rfilter)
                }
                if (presentationIds > 0) {
                    arExec(conn, "DELETE FROM presentation_review_events WHERE presentation_id IN " +
                        "(SELECT id FROM presentation_tasks WHERE " + pfilter + ")")
                    arExec(conn, "DELETE FROM presentation_task_user_state WHERE task_id IN " +
                        "(SELECT id FROM presentation_tasks WHERE " + pfilter + ")")
                    arExec(conn, "DELETE FROM presentation_tasks WHERE " + pfilter)
                }
                let adminHex = arUpperAscii(arRemoveDashes(admin.userId))
                arExec(conn, "DELETE FROM learning_resource_generation_tasks WHERE HEX(user_id)=" +
                    sqlQuote(adminHex) +
                    " AND JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.domainCode'))=" +
                    sqlQuote(domainText) +
                    " AND JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.nodeCode'))=" +
                    sqlQuote(nodeText) +
                    " AND BINARY JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.groupName'))=BINARY " +
                    sqlQuote(groupName))
                arCommit(conn)
                conn.close()
                writeJson(ctx.response, 200, arOkVoid("分组已彻底删除"))
            } catch (e: Exception) {
                arRollback(conn)
                conn.close()
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

func handleAdminResourcePurgeArchived(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            let conn = actx.conn
            let admin = actx.admin
            try {
                let orgLit = arUuid(admin.orgId)
                let resourceIds = ArrayList<String>()
                match (conn.query("SELECT id FROM generated_learning_resources " +
                    "WHERE organization_id=" + orgLit + " AND archived_at IS NOT NULL")) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        for (row in rs.rows) {
                            resourceIds.add(uuidFormat(row[0].bytes))
                        }
                }
                let presentationIds = ArrayList<String>()
                match (conn.query("SELECT id FROM presentation_tasks " +
                    "WHERE organization_id=" + orgLit + " AND archived_at IS NOT NULL")) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        for (row in rs.rows) {
                            presentationIds.add(uuidFormat(row[0].bytes))
                        }
                }
                arBegin(conn)
                if (resourceIds.size > 0) {
                    arExec(conn, "DELETE FROM learning_resource_review_events WHERE resource_id IN " +
                        "(SELECT id FROM generated_learning_resources WHERE organization_id=" +
                        orgLit + " AND archived_at IS NOT NULL)")
                    arExec(conn, "DELETE FROM generated_learning_resources WHERE organization_id=" +
                        orgLit + " AND archived_at IS NOT NULL")
                }
                if (presentationIds.size > 0) {
                    arExec(conn, "DELETE FROM presentation_review_events WHERE presentation_id IN " +
                        "(SELECT id FROM presentation_tasks WHERE organization_id=" + orgLit +
                        " AND archived_at IS NOT NULL)")
                    arExec(conn, "DELETE FROM presentation_task_user_state WHERE task_id IN " +
                        "(SELECT id FROM presentation_tasks WHERE organization_id=" + orgLit +
                        " AND archived_at IS NOT NULL)")
                    for (pid in presentationIds) {
                        match (arPurgeArchivedPresentation(cfg, admin, pid)) {
                            case _ => ()
                        }
                    }
                    arExec(conn, "DELETE FROM presentation_tasks WHERE organization_id=" +
                        orgLit + " AND archived_at IS NOT NULL")
                }
                arCommit(conn)
                let total = Int64(resourceIds.size) + Int64(presentationIds.size)
                conn.close()
                writeJson(ctx.response, 200,
                    arOkVoid("已彻底清理 " + total.toString() + " 条归档内容"))
            } catch (e: Exception) {
                arRollback(conn)
                conn.close()
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

/* ---- learning-template-resources ---- */

struct ArTemplateItem {
    let sortKey: String
    let json: String

    init(sortKey: String, json: String) {
        this.sortKey = sortKey
        this.json = json
    }
}

func arTemplateResourceJson(row: Array<MyCell>): String {
    let w = JsonWriter()
    w.putOptStr("id", uuidText(row, 0))
    w.putOptStr("type", optCellText(row, 1))
    w.putOptStr("title", optCellText(row, 2))
    w.putOptStr("topic", optCellText(row, 3))
    w.putOptStr("domainCode", optCellText(row, 4))
    w.putOptStr("nodeCode", optCellText(row, 5))
    w.putOptStr("groupName", optCellText(row, 6))
    w.putRaw("createdAt", arTimeJson(optCellText(row, 7), 0, false))
    w.putRaw("updatedAt", arTimeJson(optCellText(row, 8), 0, false))
    return w.toJson()
}

func arTemplatePresentationJson(row: Array<MyCell>, utcOff: Int64): String {
    let w = JsonWriter()
    w.putOptStr("id", uuidText(row, 0))
    w.putOptStr("type", optCellText(row, 1))
    w.putOptStr("title", optCellText(row, 2))
    w.putOptStr("topic", optCellText(row, 3))
    w.putOptStr("domainCode", optCellText(row, 4))
    w.putOptStr("nodeCode", optCellText(row, 5))
    w.putOptStr("groupName", optCellText(row, 6))
    w.putRaw("createdAt", arTimeJson(optCellText(row, 7), utcOff, true))
    w.putRaw("updatedAt", arTimeJson(optCellText(row, 8), utcOff, true))
    return w.toJson()
}

func handleLearningTemplateResources(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arUserContext(ctx, cfg)) {
        case None => return
        case Some(uctx) =>
            let conn = uctx.conn
            match (uctx.orgId) {
                case None =>
                    conn.close()
                    writeJson(ctx.response, 200, apiOk("{\"items\":[],\"total\":0}"))
                case Some(org) =>
                    var domain: ?String = None
                    match (queryParam(ctx.request, "domainCode")) {
                        case Some(v) =>
                            if (arNonBlank(v)) {
                                domain = Some(v.trimAscii())
                            }
                        case None => ()
                    }
                    try {
                        let orgLit = arUuid(org)
                        var rsql = "SELECT r.id id, r.resource_type type, r.title, r.topic, " +
                            "r.domain_code domainCode, r.category_node_code nodeCode, " +
                            "JSON_UNQUOTE(JSON_EXTRACT(r.context_json,'$.resourceGroup')) groupName, " +
                            "r.created_at createdAt, r.updated_at updatedAt " +
                            "FROM generated_learning_resources r " +
                            "WHERE r.organization_id=" + orgLit +
                            " AND r.resource_scope='ORGANIZATION' AND r.archived_at IS NULL " +
                            "AND (EXISTS (SELECT 1 FROM generated_learning_resources marker " +
                            "WHERE marker.organization_id=r.organization_id " +
                            "AND BINARY marker.domain_code=BINARY r.domain_code " +
                            "AND BINARY marker.category_node_code=BINARY r.category_node_code " +
                            "AND BINARY COALESCE(marker.resource_group,'默认分组')=BINARY COALESCE(r.resource_group,'默认分组') " +
                            "AND marker.resource_scope='ORGANIZATION' AND marker.is_template=1 " +
                            "AND marker.archived_at IS NULL) OR EXISTS (SELECT 1 FROM presentation_tasks marker " +
                            "WHERE marker.organization_id=r.organization_id " +
                            "AND BINARY marker.domain_code=BINARY r.domain_code " +
                            "AND BINARY marker.category_node_code=BINARY r.category_node_code " +
                            "AND BINARY COALESCE(marker.resource_group,'默认分组')=BINARY COALESCE(r.resource_group,'默认分组') " +
                            "AND marker.resource_scope='ORGANIZATION' AND marker.is_template=1 " +
                            "AND marker.archived_at IS NULL))"
                        match (domain) {
                            case Some(d) => rsql = rsql + " AND r.domain_code=" + sqlQuote(d)
                            case None => ()
                        }
                        var psql = "SELECT p.id id, 'ppt' type, p.title, " +
                            "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'$.generationContext.topicName')), " +
                            "JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'$.generationContext.current.topicName')), " +
                            "p.title) topic, " +
                            "p.domain_code domainCode, p.category_node_code nodeCode, " +
                            "COALESCE(p.resource_group, JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'$.generationContext.groupName'))) groupName, " +
                            "p.created_at createdAt, p.updated_at updatedAt " +
                            "FROM presentation_tasks p " +
                            "WHERE p.organization_id=" + orgLit +
                            " AND p.resource_scope='ORGANIZATION' AND p.archived_at IS NULL " +
                            "AND p.status='completed' " +
                            "AND (EXISTS (SELECT 1 FROM generated_learning_resources marker " +
                            "WHERE marker.organization_id=p.organization_id " +
                            "AND BINARY marker.domain_code=BINARY p.domain_code " +
                            "AND BINARY marker.category_node_code=BINARY p.category_node_code " +
                            "AND BINARY COALESCE(marker.resource_group,'默认分组')=BINARY COALESCE(p.resource_group,'默认分组') " +
                            "AND marker.resource_scope='ORGANIZATION' AND marker.is_template=1 " +
                            "AND marker.archived_at IS NULL) OR EXISTS (SELECT 1 FROM presentation_tasks marker " +
                            "WHERE marker.organization_id=p.organization_id " +
                            "AND BINARY marker.domain_code=BINARY p.domain_code " +
                            "AND BINARY marker.category_node_code=BINARY p.category_node_code " +
                            "AND BINARY COALESCE(marker.resource_group,'默认分组')=BINARY COALESCE(p.resource_group,'默认分组') " +
                            "AND marker.resource_scope='ORGANIZATION' AND marker.is_template=1 " +
                            "AND marker.archived_at IS NULL))"
                        match (domain) {
                            case Some(d) => psql = psql + " AND p.domain_code=" + sqlQuote(d)
                            case None => ()
                        }
                        let utcOff = dbUtcOffsetMicros(conn)
                        let items = ArrayList<ArTemplateItem>()
                        match (conn.query(rsql)) {
                            case QueryOutcome.Ok(_) => ()
                            case QueryOutcome.ResultSet(rs) =>
                                for (row in rs.rows) {
                                    items.add(ArTemplateItem(cellText(row, 8),
                                        arTemplateResourceJson(row)))
                                }
                        }
                        match (conn.query(psql)) {
                            case QueryOutcome.Ok(_) => ()
                            case QueryOutcome.ResultSet(rs) =>
                                for (row in rs.rows) {
                                    items.add(ArTemplateItem(cellText(row, 8),
                                        arTemplatePresentationJson(row, utcOff)))
                                }
                        }
                        let sorted = arSortTemplateDesc(items.toArray())
                        let arr = JsonArrWriter()
                        for (item in sorted) {
                            arr.addRaw(item.json)
                        }
                        let w = JsonWriter()
                        w.putRaw("items", arr.toJson())
                        w.putInt("total", Int64(sorted.size))
                        conn.close()
                        writeJson(ctx.response, 200, apiOk(w.toJson()))
                    } catch (e: Exception) {
                        conn.close()
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

/* String.valueOf(updatedAt) DESC. DB text is lexicographically ordered. */
func arSortTemplateDesc(items: Array<ArTemplateItem>): Array<ArTemplateItem> {
    let n = items.size
    if (n == 0) {
        return items
    }
    let out = Array<ArTemplateItem>(n, repeat: items[0])
    var i: Int64 = 0
    while (i < n) {
        out[i] = items[i]
        i += 1
    }
    var k: Int64 = 1
    while (k < n) {
        let cur = out[k]
        var j = k - 1
        while (j >= 0 && memStrLess(out[j].sortKey, cur.sortKey)) {
            out[j + 1] = out[j]
            j -= 1
        }
        out[j + 1] = cur
        k += 1
    }
    return out
}

/* ---- agents 内部端点 ---- */

enum ArPurgeResult {
    Done | NotFound | Unavailable
}

func arRemoveDashes(text: String): String {
    var out = ""
    for (b in text.toArray()) {
        if ((Int64(b) & 0xff) != 45) {
            out = out + arByteString(b)
        }
    }
    return out
}

func arByteString(b: UInt8): String {
    let arr = Array<Byte>(1, repeat: 0)
    arr[0] = b
    String.fromUtf8(arr)
}

func arUrlEncode(value: String): String {
    let unreserved = "0123456789ABCDEF"
    var out = ""
    for (b in value.toArray()) {
        let v = Int64(b) & 0xff
        if ((v >= 48 && v <= 57) || (v >= 65 && v <= 90) || (v >= 97 && v <= 122) ||
            v == 45 || v == 46 || v == 95 || v == 42) {
            out = out + arByteString(UInt8(v))
        } else if (v == 32) {
            out = out + "+"
        } else {
            out = out + "%" + unreserved[((v >> 4) & 0x0f)..(((v >> 4) & 0x0f) + 1)] +
                unreserved[(v & 0x0f)..((v & 0x0f) + 1)]
        }
    }
    return out
}

func arHmacSha256Hex(secret: String, text: String): String {
    try {
        let mac = HMAC(secret.toArray(), HashType.SHA256)
        mac.write(text.toArray())
        return bytesToHex(mac.finish())
    } catch (_: Exception) {
        return ""
    }
}

func arInternalHeaders(secret: String, method: String, path: String, admin: ArAdmin,
                       body: Array<Byte>): Array<(String, String)> {
    let timestamp = nowEpochSeconds().toString()
    let nonce = bytesToHex(uuidV4())
    let bodyHash = bytesToHex(sha256Bytes(body))
    let canonical = method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" +
        admin.userId + "\n" + bodyHash
    let signature = arHmacSha256Hex(secret, canonical)
    let headers = Array<(String, String)>(6, repeat: ("", ""))
    headers[0] = ("X-ITN-Timestamp", timestamp)
    headers[1] = ("X-ITN-Nonce", nonce)
    headers[2] = ("X-ITN-User-Id", admin.userId)
    headers[3] = ("X-ITN-Organization-Id", admin.orgId)
    headers[4] = ("X-ITN-Roles", "admin")
    headers[5] = ("X-ITN-Signature", signature)
    return headers
}

func arSecret(cfg: AppConfig): ?String {
    match (cfg.agentInternalSecret) {
        case None => return None
        case Some(raw) =>
            let s = raw.trimAscii()
            if (s.size == 0) {
                return None
            }
            return Some(s)
    }
}

func arPurgeArchivedPresentation(cfg: AppConfig, admin: ArAdmin,
                                 taskId: String): ArPurgeResult {
    match (arSecret(cfg)) {
        case None => return ArPurgeResult.Unavailable
        case Some(secret) =>
            match (parseUpstreamUrl(cfg.agentsUpstream)) {
                case None => return ArPurgeResult.Unavailable
                case Some(target) =>
                    let path = "/internal/v1/admin/presentations/" + taskId
                    let body = Array<Byte>(0, repeat: 0)
                    let headers = arInternalHeaders(secret, "DELETE", path, admin, body)
                    let client = UpstreamClient.create(target, 20000, 20000)
                    let outcome = client.forward(UpstreamRequest("DELETE", path, body, headers))
                    client.close()
                    match (outcome) {
                        case ForwardOutcome.Failed(_) => return ArPurgeResult.Unavailable
                        case ForwardOutcome.Ok(resp) =>
                            if (resp.status == 404) {
                                return ArPurgeResult.NotFound
                            }
                            if (resp.status < 200 || resp.status >= 300) {
                                return ArPurgeResult.Unavailable
                            }
                            return ArPurgeResult.Done
                    }
            }
    }
}

func arDeleteGroupTasks(cfg: AppConfig, admin: ArAdmin, domain: String, node: String,
                        group: String): Bool {
    match (arSecret(cfg)) {
        case None => return false
        case Some(secret) =>
            match (parseUpstreamUrl(cfg.agentsUpstream)) {
                case None => return false
                case Some(target) =>
                    let path = "/internal/v1/admin/task-groups"
                    let query = "domainCode=" + arUrlEncode(domain) +
                        "&nodeCode=" + arUrlEncode(node) +
                        "&groupName=" + arUrlEncode(group)
                    let body = Array<Byte>(0, repeat: 0)
                    let headers = arInternalHeaders(secret, "DELETE", path, admin, body)
                    let client = UpstreamClient.create(target, 30000, 30000)
                    let outcome = client.forward(
                        UpstreamRequest("DELETE", path + "?" + query, body, headers))
                    client.close()
                    match (outcome) {
                        case ForwardOutcome.Failed(_) => return false
                        case ForwardOutcome.Ok(resp) =>
                            return resp.status >= 200 && resp.status < 300
                    }
            }
    }
}
