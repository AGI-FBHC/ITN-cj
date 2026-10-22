package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
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
 * 管理员「新建资源」：上传文档 → 自动转成教材结构 → 在资源中心形成一棵新目录。
 *
 *   POST api/v1/admin/resources/knowledge/parse   解析文档，给出章 / 知识点建议（不写库）
 *   POST api/v1/admin/resources/knowledge/import  建目录 + 文档切片入库 + 切片按标题绑定
 *
 * 三种模式：
 *   domain   新建大章节：建 knowledge_domain + L1 根节点 + L2 章 + L3 知识点
 *   chapters 在已有大章节（L1）下新增章：建 L2 章 + L3 知识点
 *   point    在已有知识点（L3）下补充内容：不建节点，切片全部挂到该知识点
 *
 * 切片由 predeal(:8020) 负责规范化与切分；本文件只做目录落库和按标题路径绑定
 * knowledge_chunk_category（relation_type='heading'，source='ingest'）。
 */

const KI_MAX_BYTES: Int64 = 12 * 1024 * 1024
const KI_MAX_CHAPTERS: Int64 = 60
const KI_MAX_POINTS: Int64 = 400
const KI_BAD_JSON: String = "请求体不是有效的 JSON 或字段类型错误"
const KI_UNSUPPORTED: String = "该格式暂不支持入库（支持 Markdown / Word(.docx) / PPT(.pptx)）"
const KI_UPSTREAM: String = "文档解析服务不可用，请稍后重试"
const KI_EMPTY_TREE: String = "目录为空，请至少保留一个章"

public func registerKnowledgeImportRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapPost("api/v1/admin/resources/knowledge/parse") {
        ctx => handleKnowledgeParse(ctx, cfg)
    }
    app.mapPost("api/v1/admin/resources/knowledge/import") {
        ctx => handleKnowledgeImport(ctx, cfg)
    }
    app.mapDelete("api/v1/admin/resources/knowledge/domains/{code}") {
        ctx => handleDeleteDomain(ctx, cfg)
    }
    app.mapPatch("api/v1/admin/resources/knowledge/domains/{code}") {
        ctx => handleUpdateDomain(ctx, cfg)
    }
    app.mapPost("api/v1/admin/resources/knowledge/domains/{code}/categories") {
        ctx => kiHandleCreateCategory(ctx, cfg)
    }
    app.mapPatch("api/v1/admin/resources/knowledge/domains/{code}/categories/{node}") {
        ctx => kiHandleUpdateCategory(ctx, cfg)
    }
    app.mapDelete("api/v1/admin/resources/knowledge/domains/{code}/categories/{node}") {
        ctx => kiHandleDeleteCategory(ctx, cfg)
    }
}

struct KiChunk {
    let id: Int64
    let titlePath: String

    init(id: Int64, titlePath: String) {
        this.id = id
        this.titlePath = titlePath
    }
}

func kiSupported(fileName: String): Bool {
    let parts = fileName.split(".")
    if (parts.size <= 1) {
        return false
    }
    let ext = parts[parts.size - 1].trimAscii().toAsciiLower()
    return ext == "md" || ext == "markdown" || ext == "docx" || ext == "pptx"
}

/* 入库要跑完整的规范化 + 切片流水线，单独给一个更长的超时。 */
func kiPostPredeal(path: String, body: String): (Int64, String) {
    let client = ClientBuilder().autoRedirect(false).tlsConfig(TlsClientConfig())
        .readTimeout(Duration.minute * 10).writeTimeout(Duration.minute * 10).build()
    try {
        let builder = HttpRequestBuilder().method("POST").url(rcPredealBase() + path)
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

func kiReadJson(ctx: HttpContext, conn: MyConnection): ?JsonObject {
    var objOpt: ?JsonObject = None
    match (jsonParse(readBodyText(ctx.request))) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsObject => objOpt = Some(v.asObject())
                case _ => ()
            }
        case None => ()
    }
    match (objOpt) {
        case Some(obj) => return Some(obj)
        case None =>
            conn.close()
            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, KI_BAD_JSON)
            return None
    }
}

/* 统一的文件校验，返回 (fileName, base64)；失败时已写好响应并返回 None。 */
func kiReadFile(ctx: HttpContext, conn: MyConnection, obj: JsonObject): ?(String, String) {
    let fileName = pyStrOrEmpty(obj.get("fileName")).trimAscii()
    let dataB64 = pyStrOrEmpty(obj.get("dataBase64"))
    if (fileName.size == 0 || dataB64.size == 0) {
        conn.close()
        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "缺少文件名或文件内容")
        return None
    }
    if (!kiSupported(fileName)) {
        conn.close()
        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, KI_UNSUPPORTED)
        return None
    }
    match (fromBase64String(dataB64)) {
        case Some(bytes) =>
            if (bytes.isEmpty()) {
                conn.close()
                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "文件内容为空")
                return None
            }
            if (Int64(bytes.size) > KI_MAX_BYTES) {
                conn.close()
                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "文件超过 12MB，请压缩后再上传")
                return None
            }
        case None =>
            conn.close()
            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "文件内容不是有效的 base64")
            return None
    }
    return Some((fileName, dataB64))
}

/* ---- 解析（不写库） ---- */

func handleKnowledgeParse(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            let conn = actx.conn
            match (kiReadJson(ctx, conn)) {
                case None => return
                case Some(obj) =>
                    match (kiReadFile(ctx, conn, obj)) {
                        case None => return
                        case Some(pair) =>
                            conn.close()
                            let (fileName, dataB64) = pair
                            let payload = "{\"fileName\":" + jsonQuote(fileName) +
                                ",\"dataBase64\":" + jsonQuote(dataB64) + "}"
                            let (status, body) = kiPostPredeal("/api/v1/catalog/outline", payload)
                            if (status < 0) {
                                writeApiErr(ctx.response, 502, CODE_INTERNAL_ERROR, KI_UPSTREAM)
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

/* ---- 导入（建目录 + 入库 + 绑定） ---- */

func handleKnowledgeImport(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => return
        case Some(actx) =>
            let conn = actx.conn
            match (kiReadJson(ctx, conn)) {
                case None => return
                case Some(obj) =>
                    let skipIngest = jsonGetBool(obj, "skipIngest") ?? false
                    var fileName = ""
                    var dataB64 = ""
                    if (!skipIngest) {
                        match (kiReadFile(ctx, conn, obj)) {
                            case None => return
                            case Some(pair) =>
                                let (name, data) = pair
                                fileName = name
                                dataB64 = data
                        }
                    }
                    let mode = (jsonGetString(obj, "mode") ?? "chapters").trimAscii()
                    let domainName = (jsonGetString(obj, "domainName") ?? "").trimAscii()
                    let domainType = (jsonGetString(obj, "domainType") ?? "").trimAscii()
                    let domainCategory = (jsonGetString(obj, "category") ?? "").trimAscii()
                    let parentIdText = (jsonGetString(obj, "parentId") ?? "").trimAscii()
                    /* 树接口返回的节点 id 超过 JS 安全整数，内容补充改用 domainCode + nodeCode 定位 */
                    let targetDomainCode = (jsonGetString(obj, "domainCode") ?? "").trimAscii()
                    let targetNodeCode = (jsonGetString(obj, "nodeCode") ?? "").trimAscii()
                    let chapters = rcParseChapters(obj)
                    var pointCount: Int64 = 0
                    for (chapter in chapters) {
                        pointCount += Int64(chapter.points.size)
                    }
                    if (Int64(chapters.size) > KI_MAX_CHAPTERS || pointCount > KI_MAX_POINTS) {
                        conn.close()
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED,
                            "目录过大：一次最多 60 个章、400 个知识点")
                        return
                    }
                    kiImport(mode, domainName, domainType, domainCategory, parentIdText, targetDomainCode, targetNodeCode,
                        chapters, fileName, dataB64, skipIngest, actx, ctx)
            }
    }
}

func kiImport(mode: String, domainName: String, domainTypeRaw: String, domainCategoryRaw: String, parentIdText: String,
              targetDomainCode: String, targetNodeCode: String,
              chapters: ArrayList<RcChapter>, fileName: String, dataB64: String,
              skipIngest: Bool, actx: ArAdminCtx, ctx: HttpContext): Unit {
    let conn = actx.conn
    /* knowledge_domain.id 是 BIGINT UNSIGNED（可能超过 Int64），统一按字符串传递 */
    var domainId = "0"
    var domainCode = ""
    var parentId: Int64 = 0
    var parentLevel: Int64 = 0
    var createdIds = ArrayList<Int64>()
    let pointMap = HashMap<String, Int64>()
    let chapterMap = HashMap<String, Int64>()

    if (mode == "point") {
        var target = Int64.tryParse(parentIdText) ?? 0
        if (target <= 0 && targetNodeCode.size > 0) {
            /* 节点 id 超过 JS 安全整数，前端可能只传 domainCode + nodeCode */
            var sql = "SELECT c.id FROM knowledge_category c"
            if (targetDomainCode.size > 0) {
                sql = sql + " JOIN knowledge_domain d ON d.id=c.domain_id" +
                    " WHERE BINARY d.code=BINARY " + sqlQuote(targetDomainCode) +
                    " AND BINARY c.node_code=BINARY " + sqlQuote(targetNodeCode) +
                    " AND c.status=1 LIMIT 1"
            } else {
                sql = sql + " WHERE BINARY c.node_code=BINARY " + sqlQuote(targetNodeCode) +
                    " AND c.status=1 LIMIT 1"
            }
            match (conn.query(sql)) {
                case QueryOutcome.ResultSet(rs) =>
                    if (!rs.rows.isEmpty()) {
                        target = Int64.tryParse(cellText(rs.rows[0], 0)) ?? 0
                    }
                case _ => ()
            }
        }
        if (target <= 0) {
            conn.close()
            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请选择要补充内容的节点")
            return
        }
        parentId = target
        /* 章或知识点都可以补充内容：整份文档的切片全部挂到该节点 */
        var found = false
        try {
            match (conn.query("SELECT domain_id, level FROM knowledge_category WHERE id=" +
                parentId.toString() + " AND status=1 LIMIT 1")) {
                case QueryOutcome.ResultSet(rs) =>
                    if (!rs.rows.isEmpty()) {
                        found = true
                        domainId = cellText(rs.rows[0], 0)
                        parentLevel = Int64.tryParse(cellText(rs.rows[0], 1)) ?? 3
                    }
                case _ => ()
            }
        } catch (e: Exception) {
            ()
        }
        if (!found) {
            conn.close()
            writeApiErr(ctx.response, 404, CODE_VALIDATION_FAILED, "目标节点不存在或已停用")
            return
        }
    } else if (mode == "domain") {
        if (domainName.size == 0) {
            conn.close()
            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请填写领域名称")
            return
        }
        if (chapters.isEmpty() && !skipIngest) {
            conn.close()
            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, KI_EMPTY_TREE)
            return
        }
        let hex = rcShortPrefix().replace("-", "")
        domainCode = "doc_" + hex
        /* 显式分配小号 id：knowledge_domain 自增已到 9.4e18，超过 Int64，
           而业务侧 rag/domains、rag/tree 按 Int64 解析 domain.id 会溢出报 500。 */
        var newDomainId: Int64 = 5
        let domainDesc = if (fileName.size == 0) { "由管理员在资源中心创建" } else { "由管理员上传文档自动生成" }
        try {
            arBegin(conn)
            match (conn.query("SELECT COALESCE(MAX(id),0) FROM knowledge_domain WHERE id < 9000000000000000000")) {
                case QueryOutcome.ResultSet(rs) =>
                    if (!rs.rows.isEmpty()) {
                        let current = Int64.tryParse(cellText(rs.rows[0], 0)) ?? 0
                        newDomainId = if (current < 4) { 5 } else { current + 1 }
                    }
                case _ => ()
            }
            let domainType = if (domainTypeRaw.size == 0) { "课程" } else { domainTypeRaw }
            let domainCategory = domainCategoryRaw
            let insertDomain = "INSERT INTO knowledge_domain" +
                "(id,code,name,description,domain_type,category,status,created_at,updated_at) VALUES (" +
                newDomainId.toString() + "," + sqlQuote(domainCode) + "," +
                sqlQuote(domainName) + "," + sqlQuote(domainDesc) + "," + sqlQuote(domainType) + "," + sqlQuote(domainCategory) +
                ",1,NOW(),NOW())"
            match (conn.query(insertDomain)) {
                case QueryOutcome.Ok(ok) =>
                    if (ok.affectedRows != 1) {
                        arRollback(conn)
                        conn.close()
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "领域创建失败，请稍后重试")
                        return
                    }
                case QueryOutcome.ResultSet(_) =>
                    arRollback(conn)
                    conn.close()
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "领域创建失败，请稍后重试")
                    return
            }
            match (conn.query("SELECT id FROM knowledge_domain WHERE code=" + sqlQuote(domainCode) +
                " LIMIT 1")) {
                case QueryOutcome.ResultSet(rs) =>
                    if (!rs.rows.isEmpty()) {
                        domainId = cellText(rs.rows[0], 0)
                    }
                case _ => ()
            }
            arCommit(conn)
        } catch (e: Exception) {
            arRollback(conn)
            conn.close()
            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "大章节名称已存在，请换一个名称")
            return
        }
        if (domainId == "0" || domainId.size == 0) {
            conn.close()
            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "领域创建失败，请稍后重试")
            return
        }
        /* L1 根节点：与「智能体」下的一级目录同级 */
        let rootId = rcInsertRootCategory(conn, domainId, "doc" + hex + "-root", domainName,
            domainDesc, 1)
        if (rootId <= 0) {
            conn.close()
            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "目录创建失败，请稍后重试")
            return
        }
        createdIds.add(rootId)
        parentId = rootId
        parentLevel = 1
    } else {
        /* chapters：在已有大章节（L1）下新增章 */
        let target = Int64.tryParse(parentIdText) ?? 0
        if (target <= 0) {
            conn.close()
            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请选择要挂载的大章节")
            return
        }
        if (chapters.isEmpty() && !skipIngest) {
            conn.close()
            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, KI_EMPTY_TREE)
            return
        }
        parentId = target
        var found = false
        try {
            match (conn.query("SELECT domain_id, level FROM knowledge_category WHERE id=" +
                parentId.toString() + " AND parent_id IS NULL AND node_type='category' " +
                "AND status=1 LIMIT 1")) {
                case QueryOutcome.ResultSet(rs) =>
                    if (!rs.rows.isEmpty()) {
                        found = true
                        domainId = cellText(rs.rows[0], 0)
                        parentLevel = Int64.tryParse(cellText(rs.rows[0], 1)) ?? 1
                    }
                case _ => ()
            }
        } catch (e: Exception) {
            ()
        }
        if (!found) {
            conn.close()
            writeApiErr(ctx.response, 404, CODE_VALIDATION_FAILED, "目标大章节不存在或已停用")
            return
        }
    }

    /* 建 L2 / L3 节点（point 模式不建） */
    let codePrefix = "doc" + rcShortPrefix().replace("-", "")
    if (mode != "point") {
        arBegin(conn)
        try {
            var cIndex: Int64 = 0
            for (chapter in chapters) {
                cIndex += 1
                let level = parentLevel + 1
                let chapterId = rcInsertCategory(conn, domainId, parentId,
                    rcUniqueCode(conn, domainId, codePrefix + "-c" + cIndex.toString()),
                    chapter.name, chapter.description, level, "category", cIndex)
                if (chapterId <= 0) {
                    arRollback(conn)
                    conn.close()
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "目录写入失败，请稍后重试")
                    return
                }
                createdIds.add(chapterId)
                chapterMap[chapter.name] = chapterId
                var pIndex: Int64 = 0
                for (point in chapter.points) {
                    pIndex += 1
                    let pointId = rcInsertCategory(conn, domainId, chapterId,
                        rcUniqueCode(conn, domainId, codePrefix + "-c" + cIndex.toString() +
                            "-p" + pIndex.toString()),
                        point.name, point.description, level + 1, "knowledge_point", pIndex)
                    if (pointId > 0) {
                        createdIds.add(pointId)
                        pointMap[point.name] = pointId
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
    }

    var chunks = ArrayList<KiChunk>()
    var bound: Int64 = 0
    if (!skipIngest) {
        /* 文档规范化 + 切片入库 */
        let ingestBody = "{\"fileName\":" + jsonQuote(fileName) +
            ",\"dataBase64\":" + jsonQuote(dataB64) + "}"
        let (status, body) = kiPostPredeal("/api/v1/catalog/ingest", ingestBody)
        if (status < 200 || status >= 300) {
            /* 入库失败：回滚刚建的目录节点 */
            kiDeleteCreated(conn, createdIds, domainId, mode)
            conn.close()
            if (status < 0) {
                writeApiErr(ctx.response, 502, CODE_INTERNAL_ERROR, KI_UPSTREAM)
            } else {
                writeApiErr(ctx.response, 422, CODE_VALIDATION_FAILED,
                    rcErrorOf(body, "文档入库失败"))
            }
            return
        }

        chunks = kiParseChunks(body)
        if (!chunks.isEmpty()) {
            arBegin(conn)
            try {
                for (chunk in chunks) {
                    var categoryId = if (mode == "point") {
                        parentId
                    } else {
                        kiMatchCategory(chunk.titlePath, pointMap, chapterMap)
                    }
                    if (categoryId <= 0) {
                        categoryId = parentId
                    }
                    let sql = "INSERT IGNORE INTO knowledge_chunk_category" +
                        "(chunk_id,category_id,relation_type,confidence,source,created_at) VALUES (" +
                        chunk.id.toString() + "," + categoryId.toString() +
                        ",'heading',1.0000,'ingest',NOW())"
                    if (arExec(conn, sql) == 1) {
                        bound += 1
                    }
                }
                arCommit(conn)
            } catch (e: Exception) {
                arRollback(conn)
            }
        }
    }
    conn.close()

    let w = JsonWriter()
    w.putStr("mode", mode)
    w.putStr("domainCode", domainCode)
    w.putStr("domainId", domainId)
    w.putInt("parentId", parentId)
    w.putInt("chapters", Int64(chapterMap.size))
    w.putInt("points", Int64(pointMap.size))
    w.putInt("chunkCount", Int64(chunks.size))
    w.putInt("boundChunks", bound)
    writeJson(ctx.response, 200, apiOk(w.toJson()))
}

func kiDeleteCreated(conn: MyConnection, ids: ArrayList<Int64>, domainId: String, mode: String): Unit {
    try {
        /* 先删子节点，再删章 / 根节点 */
        let sorted = ids.toArray()
        var i: Int64 = sorted.size - 1
        while (i >= 0) {
            arExec(conn, "DELETE FROM knowledge_category WHERE id=" + sorted[i].toString())
            i -= 1
        }
        if (mode == "domain" && domainId.size > 0 && domainId != "0") {
            arExec(conn, "DELETE FROM knowledge_domain WHERE id=" + domainId)
        }
    } catch (e: Exception) {
        ()
    }
}

func kiParseChunks(body: String): ArrayList<KiChunk> {
    let result = ArrayList<KiChunk>()
    match (jsonParse(body)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsObject =>
                    match (jsonGetArray(v.asObject(), "chunks")) {
                        case Some(items) =>
                            for (i in 0..items.size()) {
                                match (items.get(i)) {
                                    case Some(item) =>
                                        match (item.kind()) {
                                            case JsonKind.JsObject =>
                                                let obj = item.asObject()
                                                let id = jsonGetInt(obj, "id") ?? 0
                                                if (id > 0) {
                                                    result.add(KiChunk(id,
                                                        jsonGetString(obj, "titlePath") ?? ""))
                                                }
                                            case _ => ()
                                        }
                                    case None => ()
                                }
                            }
                        case None => ()
                    }
                case _ => ()
            }
        case None => ()
    }
    return result
}

/* 一级目录：parent_id 必须为 NULL，不能复用带 parent 的插入语句。 */
func rcInsertRootCategory(conn: MyConnection, domainId: String, code: String, name: String,
                          description: String, sortOrder: Int64): Int64 {
    let sql = "INSERT INTO knowledge_category" +
        "(domain_id,parent_id,node_code,name,full_path,level,node_type,description,sort_order," +
        "status,created_by,created_at,updated_at) VALUES (" +
        domainId + ",NULL," + sqlQuote(code) + "," + sqlQuote(name) +
        ",NULL,1,'category'," + sqlQuote(description) + "," + sortOrder.toString() +
        ",1,'agent',NOW(),NOW())"
    match (conn.query(sql)) {
        case QueryOutcome.Ok(ok) =>
            if (ok.affectedRows != 1) {
                return 0
            }
        case QueryOutcome.ResultSet(_) => return 0
    }
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

/* 按标题路径从深到浅匹配知识点 / 章 */
func kiMatchCategory(titlePath: String, pointMap: HashMap<String, Int64>,
                     chapterMap: HashMap<String, Int64>): Int64 {
    let parts = titlePath.split(">")
    var i: Int64 = parts.size - 1
    while (i >= 0) {
        let name = parts[i].trimAscii()
        if (name.size > 0) {
            match (pointMap.get(name)) {
                case Some(id) => return id
                case None => ()
            }
            match (chapterMap.get(name)) {
                case Some(id) => return id
                case None => ()
            }
        }
        i -= 1
    }
    return 0
}

/* ================= 删除领域 ================= */

/* 把结果集第一列拼成 SQL 的 IN 列表；统一加引号，避免和 varchar 列比较时把整列转成数字 */
func kiJoinIds(parts: ArrayList<String>): String {
    var out = ""
    for (part in parts) {
        if (out.size > 0) { out += "," }
        out += part
    }
    return out
}

func kiCollectIds(conn: MyConnection, sql: String): String {
    let parts = ArrayList<String>()
    match (conn.query(sql)) {
        case QueryOutcome.ResultSet(rs) =>
            for (row in rs.rows) {
                let text = cellText(row, 0).trimAscii()
                if (text.size > 0) { parts.add(sqlQuote(text)) }
            }
        case _ => ()
    }
    return kiJoinIds(parts)
}

func kiCollectTexts(conn: MyConnection, sql: String): String {
    let parts = ArrayList<String>()
    match (conn.query(sql)) {
        case QueryOutcome.ResultSet(rs) =>
            for (row in rs.rows) {
                let text = cellText(row, 0).trimAscii()
                if (text.size > 0) { parts.add(sqlQuote(text)) }
            }
        case _ => ()
    }
    return kiJoinIds(parts)
}

func kiMergeKeys(left: String, right: String): String {
    if (left.size == 0) { return right }
    if (right.size == 0) { return left }
    return left + "," + right
}

/*
 * DELETE api/v1/admin/resources/knowledge/domains/{code}
 * 删除一个领域：目录、切片绑定、生成的资源与任务，以及学习者侧按知识点挂的进度记录。
 * knowledge_document 只有在没有任何切片剩余时才删，避免误删被其它领域复用的文档。
 */
func handleDeleteDomain(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => ()
        case Some(actx) =>
            let conn = actx.conn
            let code = (routeParam(ctx.request, "code") ?? "").trimAscii()
            if (code.size == 0) {
                conn.close()
                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "缺少领域编码")
                return
            }
            var domainId = ""
            var domainName = ""
            match (conn.query("SELECT id,name FROM knowledge_domain WHERE code=" + sqlQuote(code) + " LIMIT 1")) {
                case QueryOutcome.ResultSet(rs) =>
                    if (!rs.rows.isEmpty()) {
                        domainId = cellText(rs.rows[0], 0)
                        domainName = cellText(rs.rows[0], 1)
                    }
                case _ => ()
            }
            if (domainId.size == 0) {
                conn.close()
                writeApiErr(ctx.response, 404, CODE_VALIDATION_FAILED, "领域不存在或已删除")
                return
            }
            /* learning_goals 对 knowledge_domain 是 RESTRICT，先给明确提示 */
            var goalRefs: Int64 = 0
            match (conn.query("SELECT COUNT(*) FROM learning_goals WHERE knowledge_domain_id=" + domainId)) {
                case QueryOutcome.ResultSet(rs) =>
                    if (!rs.rows.isEmpty()) { goalRefs = Int64.tryParse(cellText(rs.rows[0], 0)) ?? 0 }
                case _ => ()
            }
            if (goalRefs > 0) {
                conn.close()
                writeApiErr(ctx.response, 409, CODE_VALIDATION_FAILED, "该领域已被学习目标引用，请先更换学习目标再删除")
                return
            }

            let categoryIds = kiCollectIds(conn, "SELECT id FROM knowledge_category WHERE domain_id=" + domainId)
            let chunkIds = kiCollectIds(conn,
                "SELECT DISTINCT kcc.chunk_id FROM knowledge_chunk_category kcc " +
                "JOIN knowledge_category c ON c.id=kcc.category_id WHERE c.domain_id=" + domainId)
            let docIds = if (chunkIds.size > 0) {
                kiCollectIds(conn, "SELECT DISTINCT document_id FROM knowledge_chunk WHERE id IN (" + chunkIds + ")")
            } else {
                ""
            }
            let nodeCodes = kiCollectTexts(conn,
                "SELECT node_code FROM knowledge_category WHERE domain_id=" + domainId)
            let leafCodes = kiCollectTexts(conn,
                "SELECT node_code FROM knowledge_category WHERE domain_id=" + domainId + " AND level=3")
            let kpKeys = kiMergeKeys(categoryIds, nodeCodes)
            let topicKeys = kiMergeKeys(categoryIds, leafCodes)

            try {
                arBegin(conn)
                if (categoryIds.size > 0) {
                    arExec(conn, "DELETE FROM knowledge_chunk_category WHERE category_id IN (" + categoryIds + ")")
                }
                if (chunkIds.size > 0) {
                    arExec(conn, "DELETE c FROM knowledge_chunk c WHERE c.id IN (" + chunkIds +
                        ") AND NOT EXISTS (SELECT 1 FROM knowledge_chunk_category kcc WHERE kcc.chunk_id=c.id)")
                }
                if (docIds.size > 0) {
                    arExec(conn, "DELETE d FROM knowledge_document d WHERE d.id IN (" + docIds +
                        ") AND NOT EXISTS (SELECT 1 FROM knowledge_chunk c WHERE c.document_id=d.id)")
                }
                arExec(conn, "DELETE FROM knowledge_category_prerequisite WHERE domain_id=" + domainId +
                    " OR source_domain_id=" + domainId)
                arExec(conn, "DELETE FROM knowledge_retrieval_miss WHERE domain_id=" + domainId)
                arExec(conn, "DELETE FROM knowledge_point WHERE domain_id=" + domainId)
                if (kpKeys.size > 0) {
                    arExec(conn, "DELETE FROM learning_notes WHERE kp_id IN (" + kpKeys + ")")
                    arExec(conn, "DELETE FROM learning_wrong_answers WHERE kp_id IN (" + kpKeys + ")")
                    arExec(conn, "DELETE FROM tutoring_sessions WHERE kp_id IN (" + kpKeys + ")")
                    arExec(conn, "DELETE FROM personalized_learning_units WHERE kp_id IN (" + kpKeys + ")")
                    arExec(conn, "DELETE FROM learner_knowledge_state WHERE knowledge_point_id IN (" + categoryIds + ")")
                }
                if (topicKeys.size > 0) {
                    arExec(conn, "DELETE FROM personalized_learning_units WHERE topic_id IN (" + topicKeys + ")")
                }
                arExec(conn, "DELETE FROM generated_learning_resources WHERE domain_code=" + sqlQuote(code))
                arExec(conn, "DELETE FROM presentation_tasks WHERE domain_code=" + sqlQuote(code))
                arExec(conn, "DELETE FROM predeal_upload_tasks WHERE domain_code=" + sqlQuote(code))
                arExec(conn, "DELETE FROM knowledge_category WHERE domain_id=" + domainId)
                arExec(conn, "DELETE FROM knowledge_domain WHERE id=" + domainId)
                arCommit(conn)
                conn.close()
                let w = JsonWriter()
                w.putStr("code", code)
                w.putStr("name", domainName)
                writeJson(ctx.response, 200, apiOk(w.toJson()))
            } catch (e: Exception) {
                arRollback(conn)
                conn.close()
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "领域删除失败：" + e.message)
            }
    }
}

/*
 * PATCH api/v1/admin/resources/knowledge/domains/{code}
 * 修改领域资料：名称、说明、类型标签、封面图（传空字符串表示清除封面）。
 */
func handleUpdateDomain(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => ()
        case Some(actx) =>
            let conn = actx.conn
            let code = (routeParam(ctx.request, "code") ?? "").trimAscii()
            if (code.size == 0) {
                conn.close()
                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "缺少领域编码")
                return
            }
            match (kiReadJson(ctx, conn)) {
                case None => ()
                case Some(obj) =>
                    let sets = ArrayList<String>()
                    match (jsonGetString(obj, "name")) {
                        case Some(raw) =>
                            let value = raw.trimAscii()
                            if (value.size == 0 || value.size > 128) {
                                conn.close()
                                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "领域名称需为 1–128 个字符")
                                return
                            }
                            sets.add("name=" + sqlQuote(value))
                        case None => ()
                    }
                    match (jsonGetString(obj, "description")) {
                        case Some(raw) =>
                            let value = raw.trimAscii()
                            if (value.size > 4000) {
                                conn.close()
                                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "领域说明不能超过 4000 个字符")
                                return
                            }
                            sets.add("description=" + sqlQuote(value))
                        case None => ()
                    }
                    match (jsonGetString(obj, "domainType")) {
                        case Some(raw) =>
                            let value = raw.trimAscii()
                            if (value.size == 0 || value.size > 32) {
                                conn.close()
                                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请填写领域类型（不超过 32 个字符）")
                                return
                            }
                            sets.add("domain_type=" + sqlQuote(value))
                        case None => ()
                    }
                    match (jsonGetString(obj, "category")) {
                        case Some(raw) =>
                            let value = raw.trimAscii()
                            if (value.size > 64) {
                                conn.close()
                                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "类别不能超过 64 个字符")
                                return
                            }
                            sets.add("category=" + sqlQuote(value))
                        case None => ()
                    }
                    match (jsonGetString(obj, "coverImage")) {
                        case Some(raw) =>
                            let value = raw.trimAscii()
                            if (value.size > 3000000) {
                                conn.close()
                                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "封面图过大，请控制在 2MB 以内")
                                return
                            }
                            sets.add("cover_image=" + sqlQuote(value))
                        case None => ()
                    }
                    if (sets.size == 0) {
                        conn.close()
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "没有需要更新的字段")
                        return
                    }
                    var update = "UPDATE knowledge_domain SET "
                    var index = 0
                    while (index < sets.size) {
                        if (index > 0) { update += "," }
                        update += sets[index]
                        index += 1
                    }
                    update += ", updated_at=NOW() WHERE code=" + sqlQuote(code)
                    var changed: Int64 = 0
                    try {
                        changed = arExec(conn, update)
                    } catch (e: Exception) {
                        conn.close()
                        writeApiErr(ctx.response, 409, CODE_VALIDATION_FAILED, "保存失败：领域名称可能已被占用")
                        return
                    }
                    conn.close()
                    if (changed != 1) {
                        writeApiErr(ctx.response, 404, CODE_VALIDATION_FAILED, "领域不存在或已删除")
                        return
                    }
                    let w = JsonWriter()
                    w.putStr("code", code)
                    writeJson(ctx.response, 200, apiOk(w.toJson()))
            }
    }
}

/* ================= 目录节点（章 / 知识点）增删改 ================= */

class KiNodeInfo {
    var id: Int64 = 0
    var domainId: Int64 = 0
    var parentId: Int64 = 0
    var level: Int64 = 1
    var nodeType: String = "category"
    var name: String = ""
    var nodeCode: String = ""
}

/* 'chapter' | 'category' → category；'point' | 'knowledge_point' → knowledge_point */
func kiNormalizeNodeType(raw: String): String {
    let value = raw.trimAscii().toAsciiLower()
    if (value == "category" || value == "chapter") {
        return "category"
    }
    if (value == "knowledge_point" || value == "point") {
        return "knowledge_point"
    }
    return ""
}

func kiLoadNode(conn: MyConnection, id: Int64): ?KiNodeInfo {
    match (conn.query("SELECT id, domain_id, IFNULL(parent_id,0), level, node_type, name, node_code " +
        "FROM knowledge_category WHERE id=" + id.toString() + " LIMIT 1")) {
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return None
            }
            let row = rs.rows[0]
            let info = KiNodeInfo()
            info.id = Int64.tryParse(cellText(row, 0)) ?? 0
            info.domainId = Int64.tryParse(cellText(row, 1)) ?? 0
            info.parentId = Int64.tryParse(cellText(row, 2)) ?? 0
            info.level = Int64.tryParse(cellText(row, 3)) ?? 1
            info.nodeType = cellText(row, 4)
            info.name = cellText(row, 5)
            info.nodeCode = cellText(row, 6)
            return Some(info)
        case _ => return None
    }
}

func kiLoadNodeByCode(conn: MyConnection, domainId: Int64, code: String): ?KiNodeInfo {
    match (conn.query("SELECT id, domain_id, IFNULL(parent_id,0), level, node_type, name, node_code " +
        "FROM knowledge_category WHERE domain_id=" + domainId.toString() +
        " AND BINARY node_code=BINARY " + sqlQuote(code) + " LIMIT 1")) {
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return None
            }
            let row = rs.rows[0]
            let info = KiNodeInfo()
            info.id = Int64.tryParse(cellText(row, 0)) ?? 0
            info.domainId = Int64.tryParse(cellText(row, 1)) ?? 0
            info.parentId = Int64.tryParse(cellText(row, 2)) ?? 0
            info.level = Int64.tryParse(cellText(row, 3)) ?? 1
            info.nodeType = cellText(row, 4)
            info.name = cellText(row, 5)
            info.nodeCode = cellText(row, 6)
            return Some(info)
        case _ => return None
    }
}

func kiDomainIdOf(conn: MyConnection, code: String): Int64 {
    match (conn.query("SELECT id FROM knowledge_domain WHERE code=" + sqlQuote(code) +
        " COLLATE utf8mb4_unicode_ci LIMIT 1")) {
        case QueryOutcome.ResultSet(rs) =>
            if (!rs.rows.isEmpty()) {
                return Int64.tryParse(cellText(rs.rows[0], 0)) ?? 0
            }
        case _ => ()
    }
    return 0
}

/* 领域根节点（L1，parent 为空） */
func kiRootNodeId(conn: MyConnection, domainId: Int64): Int64 {
    match (conn.query("SELECT id FROM knowledge_category WHERE domain_id=" + domainId.toString() +
        " AND parent_id IS NULL AND status=1 ORDER BY level ASC, id ASC LIMIT 1")) {
        case QueryOutcome.ResultSet(rs) =>
            if (!rs.rows.isEmpty()) {
                return Int64.tryParse(cellText(rs.rows[0], 0)) ?? 0
            }
        case _ => ()
    }
    return 0
}

/* 章必须挂在 L1 下：给定的父节点若不是 L1，就一路往上爬到 L1 */
func kiClimbToRoot(conn: MyConnection, parentId: Int64): Int64 {
    var cursor = parentId
    var guard = 0
    while (cursor > 0 && guard < 8) {
        guard += 1
        match (kiLoadNode(conn, cursor)) {
            case Some(info) =>
                if (info.parentId <= 0 || info.level <= 1) {
                    return cursor
                }
                cursor = info.parentId
            case None => return 0
        }
    }
    return cursor
}

func kiCollectSubtree(conn: MyConnection, rootId: Int64): ArrayList<Int64> {
    let result = ArrayList<Int64>()
    result.add(rootId)
    var frontier = ArrayList<Int64>()
    frontier.add(rootId)
    var guard = 0
    while (frontier.size > 0 && guard < 20) {
        guard += 1
        var inList = ""
        for (item in frontier) {
            if (inList.size > 0) { inList += "," }
            inList += item.toString()
        }
        let next = ArrayList<Int64>()
        match (conn.query("SELECT id FROM knowledge_category WHERE parent_id IN (" + inList + ")")) {
            case QueryOutcome.ResultSet(rs) =>
                for (row in rs.rows) {
                    let id = Int64.tryParse(cellText(row, 0)) ?? 0
                    if (id > 0) {
                        result.add(id)
                        next.add(id)
                    }
                }
            case _ => ()
        }
        frontier = next
    }
    return result
}

/*
 * POST api/v1/admin/resources/knowledge/domains/{code}/categories
 * 新建「章」或「知识点」。
 *   章：父节点若给的是章 / 知识点，会自动上溯到领域根，做成并列的下一章
 *   知识点：必须挂在章下面；若给的是知识点，则挂到它所在的章（即同级下一个知识点）
 */
func kiHandleCreateCategory(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => ()
        case Some(actx) =>
            let conn = actx.conn
            match (kiReadJson(ctx, conn)) {
                case None => ()
                case Some(obj) =>
                    /* 领域编码走路径；父节点用 node_code（数字 id 超出 JS 安全整数会失真） */
                    let domainCode = (routeParam(ctx.request, "code") ?? "").trimAscii()
                    let name = (jsonGetString(obj, "name") ?? "").trimAscii()
                    let description = (jsonGetString(obj, "description") ?? "").trimAscii()
                    let nodeType = kiNormalizeNodeType(jsonGetString(obj, "nodeType") ?? "")
                    let parentCode = (jsonGetString(obj, "parentNodeCode") ?? "").trimAscii()
                    if (domainCode.size == 0) {
                        conn.close()
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "缺少领域编码")
                        return
                    }
                    if (name.size == 0 || name.size > 255) {
                        conn.close()
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "名称需为 1–255 个字符")
                        return
                    }
                    if (nodeType.size == 0) {
                        conn.close()
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请选择节点类型（章 / 知识点）")
                        return
                    }
                    let domainId = kiDomainIdOf(conn, domainCode)
                    if (domainId <= 0) {
                        conn.close()
                        writeApiErr(ctx.response, 404, CODE_VALIDATION_FAILED, "领域不存在或已删除")
                        return
                    }
                    var parentId: Int64 = 0
                    var parentLevel: Int64 = 1
                    if (parentCode.size > 0) {
                        match (kiLoadNodeByCode(conn, domainId, parentCode)) {
                            case Some(info) =>
                                parentId = info.id
                                parentLevel = info.level
                            case None =>
                                conn.close()
                                writeApiErr(ctx.response, 404, CODE_VALIDATION_FAILED, "父节点不存在或已删除")
                                return
                        }
                    }
                    if (nodeType == "category") {
                        /* 章统一挂到 L1 根下，保证目录层级稳定 */
                        if (parentId <= 0) {
                            parentId = kiRootNodeId(conn, domainId)
                            parentLevel = 1
                        } else if (parentLevel > 1) {
                            parentId = kiClimbToRoot(conn, parentId)
                            parentLevel = 1
                        }
                        if (parentId <= 0) {
                            conn.close()
                            writeApiErr(ctx.response, 409, CODE_VALIDATION_FAILED, "该领域缺少根节点，请先重建领域")
                            return
                        }
                    } else {
                        if (parentId <= 0) {
                            conn.close()
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "知识点需要指定所属章节")
                            return
                        }
                        if (parentLevel == 1) {
                            conn.close()
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "知识点需要挂在章下面")
                            return
                        }
                        if (parentLevel > 2) {
                            /* 传了知识点：挂到它所在的章，作为同级下一个知识点 */
                            match (kiLoadNode(conn, parentId)) {
                                case Some(info) =>
                                    parentId = info.parentId
                                    parentLevel -= 1
                                case None => ()
                            }
                        }
                    }
                    var sortOrder: Int64 = 1
                    match (conn.query("SELECT IFNULL(MAX(sort_order),0)+1 FROM knowledge_category " +
                        "WHERE domain_id=" + domainId.toString() +
                        " AND IFNULL(parent_id,0)=" + parentId.toString())) {
                        case QueryOutcome.ResultSet(rs) =>
                            if (!rs.rows.isEmpty()) {
                                sortOrder = Int64.tryParse(cellText(rs.rows[0], 0)) ?? 1
                            }
                        case _ => ()
                    }
                    let prefix = if (nodeType == "knowledge_point") { "kp-" } else { "ch-" }
                    let code = rcUniqueCode(conn, domainId.toString(),
                        prefix + uuidFormat(uuidV4())[0..8])
                    let level = parentLevel + 1
                    let createdId = rcInsertCategory(conn, domainId.toString(), parentId, code, name,
                        description, level, nodeType, sortOrder)
                    conn.close()
                    if (createdId <= 0) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "目录写入失败，请稍后重试")
                        return
                    }
                    let w = JsonWriter()
                    w.putInt("id", createdId)
                    w.putStr("nodeCode", code)
                    w.putInt("level", level)
                    w.putStr("name", name)
                    w.putStr("nodeType", nodeType)
                    writeJson(ctx.response, 200, apiOk(w.toJson()))
            }
    }
}

/*
 * PATCH api/v1/admin/resources/knowledge/domains/{code}/categories/{node}
 * 修改名称 / 说明 / 类型。章改知识点要求没有子节点，且所属章不能是领域根。
 */
func kiHandleUpdateCategory(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => ()
        case Some(actx) =>
            let conn = actx.conn
            let domainCode = (routeParam(ctx.request, "code") ?? "").trimAscii()
            let nodeCode = (routeParam(ctx.request, "node") ?? "").trimAscii()
            if (domainCode.size == 0 || nodeCode.size == 0) {
                conn.close()
                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "缺少领域编码或节点编码")
                return
            }
            let domainId = kiDomainIdOf(conn, domainCode)
            let loaded: ?KiNodeInfo = if (domainId > 0) { kiLoadNodeByCode(conn, domainId, nodeCode) } else { None }
            match (kiReadJson(ctx, conn)) {
                case None => ()
                case Some(obj) =>
                    match (loaded) {
                        case None =>
                            conn.close()
                            writeApiErr(ctx.response, 404, CODE_VALIDATION_FAILED, "目录节点不存在或已删除")
                        case Some(info) =>
                            let id = info.id
                            let nameText = jsonGetString(obj, "name")
                            let descriptionText = jsonGetString(obj, "description")
                            let typeText = jsonGetString(obj, "nodeType")
                            var name = info.name
                            var description = ""
                            var level = info.level
                            var nodeType = info.nodeType
                            if (let Some(raw) <- nameText) {
                                let value = raw.trimAscii()
                                if (value.size == 0 || value.size > 255) {
                                    conn.close()
                                    writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "名称需为 1–255 个字符")
                                    return
                                }
                                name = value
                            }
                            if (let Some(raw) <- descriptionText) {
                                description = raw
                            }
                            if (let Some(raw) <- typeText) {
                                let target = kiNormalizeNodeType(raw)
                                if (target.size == 0) {
                                    conn.close()
                                    writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "节点类型只能是章或知识点")
                                    return
                                }
                                if (target != nodeType) {
                                    if (target == "knowledge_point") {
                                        var childCount: Int64 = 0
                                        match (conn.query("SELECT COUNT(*) FROM knowledge_category WHERE parent_id=" +
                                            id.toString())) {
                                            case QueryOutcome.ResultSet(rs) =>
                                                if (!rs.rows.isEmpty()) {
                                                    childCount = Int64.tryParse(cellText(rs.rows[0], 0)) ?? 0
                                                }
                                            case _ => ()
                                        }
                                        if (childCount > 0) {
                                            conn.close()
                                            writeApiErr(ctx.response, 409, CODE_VALIDATION_FAILED,
                                                "该章节下还有子节点，请先删除子节点再改为知识点")
                                            return
                                        }
                                        if (info.parentId <= 0) {
                                            conn.close()
                                            writeApiErr(ctx.response, 409, CODE_VALIDATION_FAILED,
                                                "领域根节点不能改为知识点")
                                            return
                                        }
                                        match (kiLoadNode(conn, info.parentId)) {
                                            case Some(parent) =>
                                                if (parent.level < 2) {
                                                    conn.close()
                                                    writeApiErr(ctx.response, 409, CODE_VALIDATION_FAILED,
                                                        "该章位于领域根下，不能直接改为知识点")
                                                    return
                                                }
                                                level = parent.level + 1
                                            case None => ()
                                        }
                                    } else {
                                        level = 1
                                        if (info.parentId > 0) {
                                            match (kiLoadNode(conn, info.parentId)) {
                                                case Some(parent) => level = parent.level + 1
                                                case None => ()
                                            }
                                        }
                                        if (level <= 1) { level = 2 }
                                    }
                                    nodeType = target
                                }
                            }
                            var update = "UPDATE knowledge_category SET name=" + sqlQuote(name) +
                                ", description=" + sqlQuote(description) +
                                ", node_type=" + sqlQuote(nodeType) +
                                ", level=" + level.toString() + " WHERE id=" + id.toString()
                            let changed = arExec(conn, update)
                            conn.close()
                            if (changed != 1) {
                                writeApiErr(ctx.response, 409, CODE_VALIDATION_FAILED, "目录节点更新失败")
                                return
                            }
                            let w = JsonWriter()
                            w.putInt("id", id)
                            w.putStr("name", name)
                            w.putStr("nodeType", nodeType)
                            w.putInt("level", level)
                            writeJson(ctx.response, 200, apiOk(w.toJson()))
                    }
            }
    }
}

/*
 * DELETE api/v1/admin/resources/knowledge/domains/{code}/categories/{node}
 * 删除节点及其整个子树，同时清理切片绑定与学习者侧按知识点挂的记录。
 */
func kiHandleDeleteCategory(ctx: HttpContext, cfg: AppConfig): Unit {
    match (arAdminContext(ctx, cfg)) {
        case None => ()
        case Some(actx) =>
            let conn = actx.conn
            let domainCode = (routeParam(ctx.request, "code") ?? "").trimAscii()
            let nodeCode = (routeParam(ctx.request, "node") ?? "").trimAscii()
            if (domainCode.size == 0 || nodeCode.size == 0) {
                conn.close()
                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "缺少领域编码或节点编码")
                return
            }
            let domainId = kiDomainIdOf(conn, domainCode)
            let loaded: ?KiNodeInfo = if (domainId > 0) { kiLoadNodeByCode(conn, domainId, nodeCode) } else { None }
            match (loaded) {
                case None =>
                    conn.close()
                    writeApiErr(ctx.response, 404, CODE_VALIDATION_FAILED, "目录节点不存在或已删除")
                case Some(root) =>
                    let id = root.id
                    if (root.parentId <= 0) {
                        conn.close()
                        writeApiErr(ctx.response, 409, CODE_VALIDATION_FAILED, "领域根节点不能单独删除，请删除整个领域")
                        return
                    }
                    let subtree = kiCollectSubtree(conn, id)
                    var idList = ""
                    for (item in subtree) {
                        if (idList.size > 0) { idList += "," }
                        idList += item.toString()
                    }
                    let categoryIds = kiCollectIds(conn,
                        "SELECT id FROM knowledge_category WHERE id IN (" + idList + ")")
                    let nodeCodes = kiCollectTexts(conn,
                        "SELECT node_code FROM knowledge_category WHERE id IN (" + idList + ")")
                    let leafCodes = kiCollectTexts(conn,
                        "SELECT node_code FROM knowledge_category WHERE id IN (" + idList + ") AND level=3")
                    let kpKeys = kiMergeKeys(categoryIds, nodeCodes)
                    let topicKeys = kiMergeKeys(categoryIds, leafCodes)
                    let chunkIds = kiCollectIds(conn,
                        "SELECT DISTINCT chunk_id FROM knowledge_chunk_category WHERE category_id IN (" + idList + ")")
                    let docIds = if (chunkIds.size > 0) {
                        kiCollectIds(conn, "SELECT DISTINCT document_id FROM knowledge_chunk WHERE id IN (" + chunkIds + ")")
                    } else {
                        ""
                    }
                    try {
                        arBegin(conn)
                        arExec(conn, "DELETE FROM knowledge_chunk_category WHERE category_id IN (" + idList + ")")
                        if (chunkIds.size > 0) {
                            arExec(conn, "DELETE c FROM knowledge_chunk c WHERE c.id IN (" + chunkIds +
                                ") AND NOT EXISTS (SELECT 1 FROM knowledge_chunk_category kcc WHERE kcc.chunk_id=c.id)")
                        }
                        if (docIds.size > 0) {
                            arExec(conn, "DELETE d FROM knowledge_document d WHERE d.id IN (" + docIds +
                                ") AND NOT EXISTS (SELECT 1 FROM knowledge_chunk c WHERE c.document_id=d.id)")
                        }
                        arExec(conn, "DELETE FROM knowledge_category_prerequisite WHERE category_id IN (" + idList + ")" +
                            " OR prereq_category_id IN (" + idList + ")")
                        if (kpKeys.size > 0) {
                            arExec(conn, "DELETE FROM learning_notes WHERE kp_id IN (" + kpKeys + ")")
                            arExec(conn, "DELETE FROM learning_wrong_answers WHERE kp_id IN (" + kpKeys + ")")
                            arExec(conn, "DELETE FROM tutoring_sessions WHERE kp_id IN (" + kpKeys + ")")
                            arExec(conn, "DELETE FROM personalized_learning_units WHERE kp_id IN (" + kpKeys + ")")
                            arExec(conn, "DELETE FROM learner_knowledge_state WHERE knowledge_point_id IN (" + categoryIds + ")")
                        }
                        if (topicKeys.size > 0) {
                            arExec(conn, "DELETE FROM personalized_learning_units WHERE topic_id IN (" + topicKeys + ")")
                        }
                        if (nodeCodes.size > 0) {
                            arExec(conn, "DELETE FROM generated_learning_resources WHERE category_node_code IN (" + nodeCodes + ")")
                        }
                        arExec(conn, "DELETE FROM knowledge_category WHERE id IN (" + idList + ")")
                        arCommit(conn)
                        conn.close()
                        let w = JsonWriter()
                        w.putInt("id", id)
                        w.putStr("name", root.name)
                        w.putInt("deleted", Int64(subtree.size))
                        writeJson(ctx.response, 200, apiOk(w.toJson()))
                    } catch (e: Exception) {
                        arRollback(conn)
                        conn.close()
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "目录删除失败：" + e.message)
                    }
            }
    }
}

