package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.base64.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * 管理员上传学习资料（文件型资源）。
 *
 *   POST api/v1/admin/resources/upload     创建文件型机构资源（JSON + base64）
 *   GET  api/v1/resources/{id}/file        读取文件字节（同机构学习者可读）
 *
 * 为什么走 JSON + base64 而不是 multipart：Cangjie 侧没有 multipart 解析
 * （机构 Logo 上传因此仍留在 Java），而 base64 能复用现有 readBodyText + JSON，
 * 文档场景体积可控（上限 12MB）。资源主记录仍落 generated_learning_resources，
 * 文件字节单独放 resource_files，避免大字段拖慢资源列表查询。
 */

const RU_MAX_BYTES: Int64 = 12 * 1024 * 1024
const RU_BAD_JSON: String = "请求体不是有效的 JSON 或字段类型错误"
const RU_TOO_LARGE: String = "文件超过 12MB，请压缩后再上传"
const RU_BAD_TYPE: String = "暂不支持该文件类型（支持 PDF / PPT / Word / Excel / 图片 / 文本）"
const RU_NOT_FOUND: String = "文件不存在或不属于当前机构"

public func registerResourceUploadRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapPost("api/v1/admin/resources/upload") {
        ctx => handleResourceUpload(ctx, cfg)
    }
    app.mapGet("api/v1/resources/{id}/file") {
        ctx => handleResourceFile(ctx, cfg)
    }
}

/* 文件类型白名单：按扩展名判定 MIME，避免客户端伪造 */
func ruMimeOf(fileName: String, given: String): String {
    let parts = fileName.split(".")
    var ext = ""
    if (parts.size > 1) {
        ext = parts[parts.size - 1].trimAscii().toAsciiLower()
    }
    if (ext == "pdf") { return "application/pdf" }
    if (ext == "png") { return "image/png" }
    if (ext == "jpg") { return "image/jpeg" }
    if (ext == "jpeg") { return "image/jpeg" }
    if (ext == "webp") { return "image/webp" }
    if (ext == "txt") { return "text/plain; charset=utf-8" }
    if (ext == "md") { return "text/plain; charset=utf-8" }
    if (ext == "csv") { return "text/csv; charset=utf-8" }
    if (ext == "pptx") {
        return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    }
    if (ext == "ppt") { return "application/vnd.ms-powerpoint" }
    if (ext == "docx") {
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }
    if (ext == "doc") { return "application/msword" }
    if (ext == "xlsx") {
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }
    if (ext == "xls") { return "application/vnd.ms-excel" }
    if (given.trimAscii().size > 0) { return given.trimAscii() }
    return ""
}

/* 去掉扩展名，作为默认标题 */
func ruBaseName(fileName: String): String {
    let parts = fileName.split(".")
    if (parts.size <= 1) {
        return fileName
    }
    var out = ""
    var i: Int64 = 0
    while (i < parts.size - 1) {
        if (i > 0) {
            out = out + "."
        }
        out = out + parts[i]
        i += 1
    }
    return out
}

func handleResourceUpload(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            let conn = actx.conn
            let admin = actx.admin
            try {
                let text = readBodyText(ctx.request)
                var objOpt: ?JsonObject = None
                match (jsonParse(text)) {
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
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, RU_BAD_JSON)
                        return
                }

                let titleRaw = pyStrOrEmpty(obj.get("title")).trimAscii()
                let domainCode = pyStrOrEmpty(obj.get("domainCode")).trimAscii()
                let nodeCode = pyStrOrEmpty(obj.get("nodeCode")).trimAscii()
                let fileName = pyStrOrEmpty(obj.get("fileName")).trimAscii()
                let mimeGiven = pyStrOrEmpty(obj.get("mimeType")).trimAscii()
                let summary = pyStrOrEmpty(obj.get("summary")).trimAscii()
                let dataB64 = pyStrOrEmpty(obj.get("dataBase64"))

                if (domainCode.size == 0 || nodeCode.size == 0 || fileName.size == 0 ||
                    dataB64.size == 0) {
                    conn.close()
                    writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED,
                        "缺少必填字段：领域、知识点、文件名或文件内容")
                    return
                }
                let mime = ruMimeOf(fileName, mimeGiven)
                if (mime.size == 0) {
                    conn.close()
                    writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, RU_BAD_TYPE)
                    return
                }

                let bytes = match (fromBase64String(dataB64)) {
                    case Some(b) => b
                    case None =>
                        conn.close()
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "文件内容不是有效的 base64")
                        return
                }
                let size = bytes.size
                if (size <= 0) {
                    conn.close()
                    writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "文件内容为空")
                    return
                }
                if (Int64(size) > RU_MAX_BYTES) {
                    conn.close()
                    writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, RU_TOO_LARGE)
                    return
                }

                let title = if (titleRaw.size > 0) { titleRaw } else { ruBaseName(fileName) }
                let topic = if (summary.size > 0) { summary } else { title }
                let idText = uuidFormat(uuidV4())

                /* 每个「机构 + 领域 + 知识点」只能有一个 file 模板标记；
                   其余上传记录靠该标记一起出现在模板列表里。 */
                var isTemplate: Int64 = 1
                let countSql = "SELECT COUNT(*) FROM generated_learning_resources " +
                    "WHERE organization_id=" + arUuid(admin.orgId) +
                    " AND BINARY domain_code=BINARY " + sqlQuote(domainCode) +
                    " AND BINARY category_node_code=BINARY " + sqlQuote(nodeCode) +
                    " AND resource_type='file' AND resource_scope='ORGANIZATION'" +
                    " AND is_template=1 AND archived_at IS NULL"
                match (conn.query(countSql)) {
                    case QueryOutcome.ResultSet(rs) =>
                        if (!rs.rows.isEmpty()) {
                            if ((Int64.tryParse(cellText(rs.rows[0], 0)) ?? 0) > 0) {
                                isTemplate = 0
                            }
                        }
                    case QueryOutcome.Ok(_) => ()
                }

                let contentJson = "JSON_OBJECT(" +
                    "'title'," + sqlQuote(title) + "," +
                    "'summary'," + sqlQuote(summary) + "," +
                    "'fileName'," + sqlQuote(fileName) + "," +
                    "'mimeType'," + sqlQuote(mime) + "," +
                    "'sizeBytes'," + size.toString() + ")"
                let insertResource = "INSERT INTO generated_learning_resources" +
                    "(id,user_id,organization_id,domain_code,category_node_code,is_template," +
                    "resource_scope,review_status,revision,resource_type,title,topic,content_json," +
                    "sources_json,state_json,context_json,decision_json,created_at,updated_at," +
                    "kp_id,form,is_public) VALUES (" +
                    arUuid(idText) + "," + arUuid(admin.userId) + "," + arUuid(admin.orgId) + "," +
                    sqlQuote(domainCode) + "," + sqlQuote(nodeCode) + "," + isTemplate.toString() + "," +
                    "'ORGANIZATION','PUBLISHED',1,'file'," + sqlQuote(title) + "," + sqlQuote(topic) + "," +
                    contentJson + ",'[]',NULL,JSON_OBJECT('resourceGroup','默认分组','uploadSource','admin')," +
                    "NULL,NOW(6),NOW(6)," + sqlQuote(nodeCode) + ",'file',0)"
                let insertFile = "INSERT INTO resource_files" +
                    "(resource_id,file_name,mime_type,size_bytes,data,created_at) VALUES (" +
                    arUuid(idText) + "," + sqlQuote(fileName) + "," + sqlQuote(mime) + "," +
                    size.toString() + ",X'" + bytesToHex(bytes) + "',NOW(6))"

                arBegin(conn)
                let created = arExec(conn, insertResource)
                let stored = arExec(conn, insertFile)
                if (created != 1 || stored != 1) {
                    arRollback(conn)
                    conn.close()
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "文件保存失败，请稍后重试")
                    return
                }
                arCommit(conn)
                conn.close()

                let w = JsonWriter()
                w.putStr("id", idText)
                w.putStr("title", title)
                w.putStr("type", "file")
                w.putStr("domainCode", domainCode)
                w.putStr("nodeCode", nodeCode)
                w.putStr("fileName", fileName)
                w.putStr("mimeType", mime)
                w.putInt("sizeBytes", Int64(size))
                w.putBool("template", isTemplate == 1)
                writeJson(ctx.response, 200, apiOk(w.toJson()))
            } catch (e: Exception) {
                arRollback(conn)
                conn.close()
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

func handleResourceFile(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(userId) =>
            match (arRouteUuid(ctx)) {
                case None => return
                case Some(id) =>
                    let idText = uuidFormat(id)
                    match (openDb(cfg)) {
                        case None =>
                            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                        case Some(conn) =>
                            var mime: ?String = None
                            var bytes: ?Array<Byte> = None
                            var failed = false
                            try {
                                let sql = "SELECT f.mime_type,f.data FROM resource_files f " +
                                    "JOIN generated_learning_resources r ON r.id=f.resource_id " +
                                    "WHERE f.resource_id=" + arUuid(idText) +
                                    " AND r.archived_at IS NULL AND (" +
                                    "(r.resource_scope='USER' AND (r.user_id=" + sqlBinary(userId) +
                                    " OR r.is_public=1)) OR " +
                                    "(r.resource_scope='ORGANIZATION' AND r.organization_id=" +
                                    "(SELECT organization_id FROM users WHERE id=" + sqlBinary(userId) + ")))"
                                match (conn.query(sql)) {
                                    case QueryOutcome.Ok(_) => failed = true
                                    case QueryOutcome.ResultSet(rs) =>
                                        if (!rs.rows.isEmpty()) {
                                            let row = rs.rows[0]
                                            if (row.size >= 2 && !row[1].isNull && row[1].bytes.size > 0) {
                                                bytes = Some(row[1].bytes)
                                                let ct = cellText(row, 0)
                                                mime = Some(if (ct.size == 0) {
                                                    "application/octet-stream"
                                                } else {
                                                    ct
                                                })
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
                                    writeApiErr(ctx.response, 404, AR_CODE_ASSET_NOT_FOUND, RU_NOT_FOUND)
                                case Some(data) =>
                                    ctx.response.contentType = mime ?? "application/octet-stream"
                                    ctx.response.headers.add("Content-Disposition", "inline")
                                    ctx.response.headers.add("Cache-Control", "private, max-age=60")
                                    ctx.response.write(data)
                            }
                    }
            }
    }
}
