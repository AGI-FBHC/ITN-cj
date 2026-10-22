package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import std.env.getVariables
import std.time.*
import stdx.encoding.base64.*
import stdx.encoding.json.*
import stdx.net.http.ClientBuilder
import stdx.net.http.HttpRequestBuilder
import stdx.net.tls.TlsClientConfig
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * 管理员「文档 → 知识目录」。
 *
 *   GET  api/v1/admin/resources/catalog/domains          可选的一级目录（领域）
 *   POST api/v1/admin/resources/{id}/catalog/suggest    文档解析出章 / 知识点建议
 *   POST api/v1/admin/resources/{id}/catalog/apply      确认后写入 knowledge_category
 *
 * 目录格式对齐平台既有知识目录：
 *   L1 领域（已有，不新建）
 *   L2 章   node_type='category'
 *   L3 知识点 node_type='knowledge_point'
 *
 * 解析放在 predeal（Python，:8020）里做，因为仓颉侧没有 docx/pptx 解析能力；
 * 这里只负责取文件字节、转发、以及在管理员确认后落库。
 * PDF 不参与目录生成（用户要求不做 PDF）。
 */

const RC_PREDEAL_DEFAULT: String = "http://127.0.0.1:8020"
const RC_SUGGEST_PATH: String = "/api/v1/catalog/outline"
const RC_MAX_FILE_BYTES: Int64 = 12 * 1024 * 1024
const RC_MAX_CHAPTERS: Int64 = 60
const RC_MAX_POINTS: Int64 = 200
const RC_NOT_FOUND: String = "文档不存在或不属于当前机构"
const RC_UNSUPPORTED: String = "该格式暂不支持生成目录（支持 Markdown / Word(.docx) / PPT(.pptx)）"
const RC_UPSTREAM: String = "文档解析服务不可用，请稍后重试"

public func registerResourceCatalogRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("api/v1/admin/resources/catalog/domains") {
        ctx => handleCatalogDomains(ctx, cfg)
    }
    app.mapPost("api/v1/admin/resources/{id}/catalog/suggest") {
        ctx => handleCatalogSuggest(ctx, cfg)
    }
    app.mapPost("api/v1/admin/resources/{id}/catalog/apply") {
        ctx => handleCatalogApply(ctx, cfg)
    }
}

/* 目录生成只接受这几种文本型文档，PDF 明确不支持。 */
func rcCatalogSuffix(fileName: String): String {
    let parts = fileName.split(".")
    if (parts.size <= 1) {
        return ""
    }
    return parts[parts.size - 1].trimAscii().toAsciiLower()
}

func rcCatalogSupported(fileName: String): Bool {
    let ext = rcCatalogSuffix(fileName)
    return ext == "md" || ext == "markdown" || ext == "docx" || ext == "pptx"
}

func rcPredealBase(): String {
    var url = RC_PREDEAL_DEFAULT
    try {
        for ((name, value) in getVariables()) {
            if ((name == "PREDEAL_URL" || name == "ITN_PREDEAL_URL") && !value.trimAscii().isEmpty()) {
                url = value.trimAscii()
            }
        }
    } catch (_: Exception) {
        ()
    }
    while (url.endsWith("/")) {
        let bytes = url.toArray()
        if (bytes.size <= 1) {
            break
        }
        url = String.fromUtf8(bytes.slice(0, bytes.size - 1))
    }
    return url
}

/* 一次性的上游调用：返回 (HTTP 状态码, 响应体)；异常返回 (-1, 消息)。 */
func rcPostJson(url: String, body: String): (Int64, String) {
    let client = ClientBuilder().autoRedirect(false).tlsConfig(TlsClientConfig())
        .readTimeout(Duration.minute * 3).writeTimeout(Duration.minute * 3).build()
    try {
        let builder = HttpRequestBuilder().method("POST").url(url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(body.toArray())
        let response = client.send(builder.build())
        let buffer = Array<UInt8>(65536, repeat: 0)
        let out = ArrayList<UInt8>()
        while (true) {
            let count = response.body.read(buffer)
            if (count == 0) {
                break
            }
            for (i in 0..count) {
                out.add(buffer[i])
            }
        }
        return (Int64(response.status), String.fromUtf8(out.toArray()))
    } catch (e: Exception) {
        return (-1, "")
    } finally {
        client.close()
    }
}

/* ---- 一级目录（领域）列表 ---- */

func handleCatalogDomains(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            let conn = actx.conn
            var failed = false
            let items = ArrayList<String>()
            try {
                let sql = "SELECT k.id, k.domain_id, COALESCE(d.name,''), k.name, " +
                    "(SELECT COUNT(*) FROM knowledge_category c " +
                    " WHERE c.parent_id=k.id AND c.status=1) " +
                    "FROM knowledge_category k LEFT JOIN knowledge_domain d ON d.id=k.domain_id " +
                    "WHERE k.parent_id IS NULL AND k.status=1 " +
                    "ORDER BY k.domain_id, k.sort_order, k.id"
                match (conn.query(sql)) {
                    case QueryOutcome.Ok(_) => failed = true
                    case QueryOutcome.ResultSet(rs) =>
                        for (row in rs.rows) {
                            let w = JsonWriter()
                            w.putStr("id", cellText(row, 0))
                            w.putStr("domainId", cellText(row, 1))
                            w.putStr("domainName", cellText(row, 2))
                            w.putStr("name", cellText(row, 3))
                            w.putInt("chapterCount", Int64.tryParse(cellText(row, 4)) ?? 0)
                            items.add(w.toJson())
                        }
                }
            } catch (e: Exception) {
                failed = true
            }
            conn.close()
            if (failed) {
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                return
            }
            var joined = ""
            var first = true
            for (item in items.toArray()) {
                if (!first) {
                    joined = joined + ","
                }
                joined = joined + item
                first = false
            }
            writeJson(ctx.response, 200, apiOk("[" + joined + "]"))
    }
}

/* ---- 解析文档，给出目录建议（不写库） ---- */

func handleCatalogSuggest(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            let conn = actx.conn
            match (arRouteUuid(ctx)) {
                case None =>
                    conn.close()
                    return
                case Some(id) =>
                    let idText = uuidFormat(id)
                    var fileName = ""
                    var bytes: ?Array<Byte> = None
                    var failed = false
                    try {
                        let sql = "SELECT f.file_name, f.data FROM resource_files f " +
                            "JOIN generated_learning_resources r ON r.id=f.resource_id " +
                            "WHERE f.resource_id=" + arUuid(idText) +
                            " AND r.archived_at IS NULL AND r.organization_id=" +
                            arUuid(actx.admin.orgId)
                        match (conn.query(sql)) {
                            case QueryOutcome.Ok(_) => failed = true
                            case QueryOutcome.ResultSet(rs) =>
                                if (!rs.rows.isEmpty()) {
                                    let row = rs.rows[0]
                                    fileName = cellText(row, 0)
                                    if (row.size >= 2 && !row[1].isNull && row[1].bytes.size > 0) {
                                        bytes = Some(row[1].bytes)
                                    }
                                }
                        }
                    } catch (e: Exception) {
                        failed = true
                    }
                    conn.close()
                    if (failed) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                        return
                    }
                    match (bytes) {
                        case None =>
                            writeApiErr(ctx.response, 404, AR_CODE_ASSET_NOT_FOUND, RC_NOT_FOUND)
                        case Some(data) =>
                            if (!rcCatalogSupported(fileName)) {
                                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, RC_UNSUPPORTED)
                                return
                            }
                            if (Int64(data.size) > RC_MAX_FILE_BYTES) {
                                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED,
                                    "文件超过 12MB，无法解析目录")
                                return
                            }
                            let payload = "{\"fileName\":" + jsonQuote(fileName) +
                                ",\"dataBase64\":" + jsonQuote(toBase64String(data)) + "}"
                            let (status, body) = rcPostJson(rcPredealBase() + RC_SUGGEST_PATH, payload)
                            if (status < 0) {
                                writeApiErr(ctx.response, 502, CODE_INTERNAL_ERROR, RC_UPSTREAM)
                                return
                            }
                            if (status < 200 || status >= 300) {
                                writeApiErr(ctx.response, 422, CODE_VALIDATION_FAILED,
                                    rcErrorOf(body, "文档解析失败"))
                                return
                            }
                            writeJson(ctx.response, 200, apiOk(body))
                    }
            }
    }
}

/* 随机 8 位十六进制前缀，用作生成目录的 node_code 前缀。 */
func rcShortPrefix(): String {
    let chars = uuidFormat(uuidV4()).toArray()
    if (chars.size <= 8) {
        return String.fromUtf8(chars)
    }
    return String.fromUtf8(chars.slice(0, 8))
}

/* 从上游错误体 {"error": "..."} 里取消息。 */
func rcErrorOf(body: String, fallback: String): String {
    match (jsonParse(body)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsObject =>
                    let text = jsonGetString(v.asObject(), "error")
                    match (text) {
                        case Some(t) => if (!t.trimAscii().isEmpty()) { return t }
                        case None => ()
                    }
                case _ => ()
            }
        case None => ()
    }
    return fallback
}

/* ---- 确认后写入 knowledge_category ---- */

struct RcPoint {
    let name: String
    let description: String

    init(name: String, description: String) {
        this.name = name
        this.description = description
    }
}

struct RcChapter {
    let name: String
    let description: String
    let points: ArrayList<RcPoint>

    init(name: String, description: String, points: ArrayList<RcPoint>) {
        this.name = name
        this.description = description
        this.points = points
    }
}

func handleCatalogApply(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            let conn = actx.conn
            let body = readBodyText(ctx.request)
            var objOpt: ?JsonObject = None
            match (jsonParse(body)) {
                case Some(v) =>
                    match (v.kind()) {
                        case JsonKind.JsObject => objOpt = Some(v.asObject())
                        case _ => ()
                    }
                case None => ()
            }
            let obj = match (objOpt) {
                case Some(o) => o
                case None =>
                    conn.close()
                    writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请求体不是有效的 JSON")
                    return
            }
            let parentId = Int64.tryParse(jsonGetString(obj, "parentId") ?? "") ?? 0
            if (parentId <= 0) {
                conn.close()
                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请选择要挂载的一级目录（领域）")
                return
            }
            let chapters = rcParseChapters(obj)
            if (chapters.isEmpty()) {
                conn.close()
                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "目录为空，请至少保留一个章")
                return
            }
            if (Int64(chapters.size) > RC_MAX_CHAPTERS) {
                conn.close()
                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "一次最多写入 60 个章")
                return
            }

            /* 目标一级目录：必须存在、是 category、且是顶层节点 */
            /* knowledge_domain.id 是 BIGINT UNSIGNED，可能超过 Int64，统一按字符串传递 */
            var domainId = "0"
            var parentLevel: Int64 = 0
            var parentFound = false
            var failed = false
            try {
                match (conn.query("SELECT domain_id, level FROM knowledge_category " +
                    "WHERE id=" + parentId.toString() + " AND parent_id IS NULL " +
                    "AND node_type='category' AND status=1 LIMIT 1")) {
                    case QueryOutcome.Ok(_) => failed = true
                    case QueryOutcome.ResultSet(rs) =>
                        if (!rs.rows.isEmpty()) {
                            parentFound = true
                            domainId = cellText(rs.rows[0], 0)
                            parentLevel = Int64.tryParse(cellText(rs.rows[0], 1)) ?? 1
                        }
                }
            } catch (e: Exception) {
                failed = true
            }
            if (failed) {
                conn.close()
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                return
            }
            if (!parentFound) {
                conn.close()
                writeApiErr(ctx.response, 404, CODE_VALIDATION_FAILED, "目标一级目录不存在或已停用")
                return
            }

            var baseSort: Int64 = 0
            try {
                match (conn.query("SELECT COALESCE(MAX(sort_order),0) FROM knowledge_category " +
                    "WHERE domain_id=" + domainId + " AND parent_id=" +
                    parentId.toString())) {
                    case QueryOutcome.ResultSet(rs) =>
                        if (!rs.rows.isEmpty()) {
                            baseSort = Int64.tryParse(cellText(rs.rows[0], 0)) ?? 0
                        }
                    case _ => ()
                }
            } catch (e: Exception) {
                ()
            }

            var pointCount: Int64 = 0
            let insertedChapters = ArrayList<Int64>()
            let codePrefix = "doc" + rcShortPrefix()
            arBegin(conn)
            try {
                var cIndex: Int64 = 0
                for (chapter in chapters) {
                    cIndex += 1
                    let level = parentLevel + 1
                    var chapterId = rcFindCategory(conn, domainId, parentId, level, chapter.name) ?? 0
                    if (chapterId == 0) {
                        let code = rcUniqueCode(conn, domainId,
                            codePrefix + "-c" + cIndex.toString())
                        chapterId = rcInsertCategory(conn, domainId, parentId, code, chapter.name,
                            chapter.description, level, "category", baseSort + cIndex)
                    }
                    if (chapterId <= 0) {
                        arRollback(conn)
                        conn.close()
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "目录写入失败，请稍后重试")
                        return
                    }
                    insertedChapters.add(chapterId)
                    var pIndex: Int64 = 0
                    for (point in chapter.points) {
                        pIndex += 1
                        let pointLevel = level + 1
                        let existed = rcFindCategory(conn, domainId, chapterId, pointLevel, point.name)
                        match (existed) {
                            case Some(_) => continue
                            case None => ()
                        }
                        let code = rcUniqueCode(conn, domainId,
                            codePrefix + "-c" + cIndex.toString() + "-p" + pIndex.toString())
                        if (rcInsertCategory(conn, domainId, chapterId, code, point.name,
                            point.description, pointLevel, "knowledge_point", pIndex) > 0) {
                            pointCount += 1
                        }
                    }
                }
                arCommit(conn)
            } catch (e: Exception) {
                arRollback(conn)
                conn.close()
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "目录写入失败，请稍后重试")
                return
            }
            conn.close()

            let w = JsonWriter()
            w.putInt("parentId", parentId)
            w.putInt("chapters", Int64(insertedChapters.size))
            w.putInt("points", pointCount)
            writeJson(ctx.response, 200, apiOk(w.toJson()))
    }
}

func rcParseChapters(obj: JsonObject): ArrayList<RcChapter> {
    let result = ArrayList<RcChapter>()
    let raw = jsonGetArray(obj, "chapters")
    match (raw) {
        case None => return result
        case Some(items) =>
            for (i in 0..items.size()) {
                match (items.get(i)) {
                    case None => ()
                    case Some(value) =>
                        match (value.kind()) {
                            case JsonKind.JsObject =>
                                let chapterObj = value.asObject()
                                let name = (jsonGetString(chapterObj, "name") ?? "").trimAscii()
                                if (name.isEmpty()) {
                                    continue
                                }
                                let description = jsonGetString(chapterObj, "description") ?? ""
                                let points = ArrayList<RcPoint>()
                                match (jsonGetArray(chapterObj, "points")) {
                                    case Some(pointItems) =>
                                        for (j in 0..pointItems.size()) {
                                            match (pointItems.get(j)) {
                                                case None => ()
                                                case Some(pointValue) =>
                                                    match (pointValue.kind()) {
                                                        case JsonKind.JsObject =>
                                                            let pointObj = pointValue.asObject()
                                                            let pointName = (jsonGetString(pointObj, "name") ?? "").trimAscii()
                                                            if (pointName.isEmpty()) {
                                                                continue
                                                            }
                                                            points.add(RcPoint(pointName,
                                                                jsonGetString(pointObj, "description") ?? ""))
                                                        case _ => ()
                                                    }
                                            }
                                        }
                                    case None => ()
                                }
                                result.add(RcChapter(name, description, points))
                            case _ => ()
                        }
                }
            }
    }
    return result
}

/* 同父节点下同名的节点直接复用，避免重复生成目录时写重复行。 */
func rcFindCategory(conn: MyConnection, domainId: String, parentId: Int64,
                    level: Int64, name: String): ?Int64 {
    let sql = "SELECT id FROM knowledge_category WHERE domain_id=" + domainId +
        " AND parent_id=" + parentId.toString() + " AND level=" + level.toString() +
        " AND BINARY name=BINARY " + sqlQuote(name) + " AND status=1 LIMIT 1"
    match (conn.query(sql)) {
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return None
            }
            return Int64.tryParse(cellText(rs.rows[0], 0))
        case _ => return None
    }
}

/* node_code 在 (domain_id, node_code) 上唯一，冲突时追加 -2/-3... */
func rcUniqueCode(conn: MyConnection, domainId: String, base: String): String {
    var code = base
    var suffix: Int64 = 1
    while (true) {
        let sql = "SELECT 1 FROM knowledge_category WHERE domain_id=" + domainId +
            " AND BINARY node_code=BINARY " + sqlQuote(code) + " LIMIT 1"
        var exists = false
        match (conn.query(sql)) {
            case QueryOutcome.ResultSet(rs) => exists = !rs.rows.isEmpty()
            case _ => ()
        }
        if (!exists) {
            return code
        }
        suffix += 1
        code = base + "-" + suffix.toString()
    }
    return code
}

func rcInsertCategory(conn: MyConnection, domainId: String, parentId: Int64, code: String,
                      name: String, description: String, level: Int64, nodeType: String,
                      sortOrder: Int64): Int64 {
    let sql = "INSERT INTO knowledge_category" +
        "(domain_id,parent_id,node_code,name,full_path,level,node_type,description,sort_order," +
        "status,created_by,created_at,updated_at) VALUES (" +
        domainId + "," + parentId.toString() + "," + sqlQuote(code) + "," +
        sqlQuote(name) + ",NULL," + level.toString() + "," + sqlQuote(nodeType) + "," +
        sqlQuote(description) + "," + sortOrder.toString() + ",1,'agent',NOW(),NOW())"
    match (conn.query(sql)) {
        case QueryOutcome.Ok(ok) =>
            if (ok.affectedRows != 1) {
                return 0
            }
        case QueryOutcome.ResultSet(_) => return 0
    }
    /* node_code 在 domain 内唯一，回查比 LAST_INSERT_ID 更稳（连接池可能换连接） */
    match (conn.query("SELECT id FROM knowledge_category WHERE domain_id=" + domainId +
        " AND BINARY node_code=BINARY " + sqlQuote(code) + " LIMIT 1")) {
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return 0
            }
            return Int64.tryParse(cellText(rs.rows[0], 0)) ?? 0
        case _ => return 0
    }
}
