package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import std.fs.*
import std.env.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * 知识库读侧（Spring Boot /api/v1/knowledge）—— 从 Java 移植到 Spire。
 *
 *   GET /api/v1/knowledge/articles            列表（分页 + 过滤 + 模糊搜索）
 *   GET /api/v1/knowledge/articles/{id}       正文（markdown 里的资产协议重写）
 *   GET /api/v1/knowledge/categories          分类聚合（排序 / 展示名）
 *   GET /api/v1/knowledge/assets/{assetId}    静态资产文件（ETag + 缓存）
 *
 * 契约来源（全部）：
 *   web/KnowledgeController.java:31-101
 *   service/KnowledgeService.java:26-236
 *   repository/KnowledgeArticleRepository.java:13-52
 *   web/dto/{KnowledgeArticleSummary, KnowledgeArticleDetail,
 *            KnowledgeArticlePageResponse, KnowledgeCategoryResponse, ApiResponse}.java
 *   domain/{KnowledgeArticle, KnowledgeAsset, KnowledgeSource}.java
 *   config/SecurityConfig.java（articles、categories 要登录，assets 段 permitAll）
 *   exception/ErrorCode.java（4000 文章 / 4001 资产 / 1000 参数类型）
 *   resources/application.yml（app.knowledge.asset-dir 默认 data/knowledge-base/assets）
 *
 * 仍然是转发的（不从 Java 搬）：auth 前缀（登录签名与邮件、JWT 签发）、
 * rag 前缀（RagFlow 外部调用）。见 route 扫描报告。
 */

const K_CODE_VALIDATION_FAILED: Int64 = 1000
const K_CODE_ARTICLE_NOT_FOUND: Int64 = 4000
const K_CODE_ASSET_NOT_FOUND: Int64 = 4001

public func registerKnowledgeRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("api/v1/knowledge/articles") {
        ctx => handleKnowledgeArticles(ctx, cfg)
    }
    app.mapGet("api/v1/knowledge/articles/{articleId}") {
        ctx => handleKnowledgeArticle(ctx, cfg)
    }
    app.mapGet("api/v1/knowledge/categories") {
        ctx => handleKnowledgeCategories(ctx, cfg)
    }
    app.mapGet("api/v1/knowledge/assets/{assetId}") {
        ctx => handleKnowledgeAsset(ctx, cfg)
    }
}

/* ==================== GET /api/v1/knowledge/articles ==================== */

struct KPageParams {
    let page: Int64
    let size: Int64

    init(page: Int64, size: Int64) {
        this.page = page
        this.size = size
    }
}

/*
 * @RequestParam(defaultValue="0") int page —— 缺失取默认值；出现但不是整数
 * （含空串）Spring 抛 MethodArgumentTypeMismatchException，GlobalExceptionHandler
 * 变成 400 VALIDATION_FAILED「参数类型不正确：<name>」。
 */
func kIntParam(ctx: HttpContext, name: String, dflt: Int64): ?Int64 {
    match (queryParam(ctx.request, name)) {
        case None => return Some(dflt)
        case Some(raw) =>
            match (Int64.tryParse(raw.trimAscii())) {
                case Some(v) => return Some(v)
                case None =>
                    writeApiErr(ctx.response, 400, K_CODE_VALIDATION_FAILED,
                        "参数类型不正确：" + name)
                    return None
            }
    }
}

func kPageParams(ctx: HttpContext): ?KPageParams {
    var page: Int64 = 0
    var size: Int64 = 20
    match (kIntParam(ctx, "page", 0)) {
        case None => return None
        case Some(v) => page = v
    }
    match (kIntParam(ctx, "size", 20)) {
        case None => return None
        case Some(v) => size = v
    }
    return Some(KPageParams(page, size))
}

func handleKnowledgeArticles(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(_) =>
            match (kPageParams(ctx)) {
                case None => return
                case Some(p) => kListArticles(ctx, cfg, p.page, p.size)
            }
    }
}

func kListArticles(ctx: HttpContext, cfg: AppConfig, page: Int64, size: Int64): Unit {
    let safePage = if (page < 0) { 0 } else { page }
    var safeSize = size
    if (safeSize < 1) {
        safeSize = 1
    }
    if (safeSize > 50) {
        safeSize = 50
    }
    let srcId = kNormalize(queryParam(ctx.request, "sourceId"))
    let cat = kNormalize(queryParam(ctx.request, "category"))
    let sub = kNormalize(queryParam(ctx.request, "subcategory"))
    let search = kNormalize(queryParam(ctx.request, "search"))
    let whereSql = kArticleWhere(srcId, cat, sub, search)
    match (openDb(cfg)) {
        case None => writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
        case Some(conn) =>
            try {
                let utcOff = dbUtcOffsetMicros(conn)
                let total = kCountPublished(conn, whereSql)
                let offset = safePage * safeSize
                let sql = "SELECT a.id,a.source_id,s.name,a.slug,a.title,a.category," +
                    "a.subcategory,a.excerpt,a.image_count,a.word_count,a.updated_at" +
                    " FROM knowledge_articles a JOIN knowledge_sources s ON s.id=a.source_id" +
                    whereSql + " ORDER BY a.source_path ASC LIMIT " + safeSize.toString() +
                    " OFFSET " + offset.toString()
                let items = JsonArrWriter()
                match (conn.query(sql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        for (row in rs.rows) {
                            items.addRaw(kArticleSummaryJson(row, utcOff))
                        }
                }
                conn.close()
                let data = JsonWriter()
                data.putInt("total", total)
                data.putInt("page", safePage)
                data.putInt("size", safeSize)
                data.putRaw("items", items.toJson())
                writeJson(ctx.response, 200, apiOk(data.toJson()))
            } catch (e: Exception) {
                conn.close()
                writeInternalDebug(ctx.response, "listArticles: " + e.message)
            }
    }
}

func kCountPublished(conn: MyConnection, whereSql: String): Int64 {
    let sql = "SELECT COUNT(*) FROM knowledge_articles a" + whereSql
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return 0
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return 0
            }
            return optCellInt(rs.rows[0], 0) ?? 0
    }
}

/* JPQL searchPublished 的 WHERE（:param IS NULL OR … 展开成条件拼接）。 */
func kArticleWhere(srcId: ?String, cat: ?String, sub: ?String, search: ?String): String {
    var w = " WHERE a.status='PUBLISHED'"
    match (srcId) {
        case Some(v) => w = w + " AND a.source_id=" + sqlQuote(v)
        case None => ()
    }
    match (cat) {
        case Some(v) => w = w + " AND a.category=" + sqlQuote(v)
        case None => ()
    }
    match (sub) {
        case Some(v) => w = w + " AND a.subcategory=" + sqlQuote(v)
        case None => ()
    }
    match (search) {
        case Some(v) =>
            let like = sqlQuote("%" + v + "%")
            w = w + " AND (LOWER(a.title) LIKE LOWER(" + like + ")" +
                " OR LOWER(a.excerpt) LIKE LOWER(" + like + ")" +
                " OR LOWER(a.plain_text) LIKE LOWER(" + like + "))"
        case None => ()
    }
    return w
}

/* Java String.strip() 语义：全空白 → null，否则去掉首尾空白。 */
func kNormalize(value: ?String): ?String {
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

/*
 * SELECT 列序：0 id,1 source_id,2 source_name,3 slug,4 title,5 category,
 * 6 subcategory,7 excerpt,8 image_count,9 word_count,10 updated_at
 */
func kArticleSummaryJson(row: Array<MyCell>, utcOff: Int64): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putStr("sourceId", cellText(row, 1))
    w.putStr("sourceName", cellText(row, 2))
    w.putStr("slug", cellText(row, 3))
    w.putStr("title", cellText(row, 4))
    w.putStr("category", cellText(row, 5))
    w.putOptStr("subcategory", optCellText(row, 6))
    w.putOptStr("excerpt", optCellText(row, 7))
    w.putInt("imageCount", optCellInt(row, 8) ?? 0)
    w.putInt("wordCount", optCellInt(row, 9) ?? 0)
    w.putRaw("updatedAt", kInstantRaw(optCellText(row, 10), utcOff))
    return w.toJson()
}

/* Instant -> ISO_INSTANT：先按 dbUtcOffsetMicros 折算成 UTC 再打印。 */
func kInstantRaw(text: ?String, utcOff: Int64): String {
    match (text) {
        case Some(t) =>
            if (t.size == 0) {
                return "null"
            }
            return jsonQuote(isoInstantFromDb(shiftTimestampText(t, utcOff)))
        case None => return "null"
    }
}

/* ==================== GET /api/v1/knowledge/articles/{id} ==================== */

/*
 * @PathVariable UUID：不是合法 UUID 时 Spring 的转换失败 → 400 VALIDATION_FAILED
 * （不是 Python 面的 422 uuid_parsing，所以不能复用 parseRouteUuid）。
 */
func kPathUuid(ctx: HttpContext, name: String): ?Array<Byte> {
    var text = ""
    match (routeParam(ctx.request, name)) {
        case Some(t) => text = t
        case None => ()
    }
    match (uuidParse(text)) {
        case Some(bytes) => return Some(bytes)
        case None =>
            writeApiErr(ctx.response, 400, K_CODE_VALIDATION_FAILED,
                "参数类型不正确：" + name)
            return None
    }
}

func handleKnowledgeArticle(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(_) =>
            match (kPathUuid(ctx, "articleId")) {
                case None => return
                case Some(articleId) => kGetArticle(ctx, cfg, articleId)
            }
    }
}

func kGetArticle(ctx: HttpContext, cfg: AppConfig, articleId: Array<Byte>): Unit {
    match (openDb(cfg)) {
        case None => writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
        case Some(conn) =>
            try {
                let utcOff = dbUtcOffsetMicros(conn)
                let sql = "SELECT a.id,a.source_id,s.name,a.slug,a.title,a.category," +
                    "a.subcategory,a.excerpt,a.markdown,a.image_count,a.word_count," +
                    "a.published_at,a.updated_at" +
                    " FROM knowledge_articles a JOIN knowledge_sources s ON s.id=a.source_id" +
                    " WHERE a.id=" + sqlBinary(articleId) + " AND a.status='PUBLISHED'"
                var body: ?String = None
                match (conn.query(sql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        if (!rs.rows.isEmpty()) {
                            body = Some(kArticleDetailJson(rs.rows[0], utcOff, kBaseUrl(ctx.request)))
                        }
                }
                conn.close()
                match (body) {
                    case Some(json) => writeJson(ctx.response, 200, apiOk(json))
                    case None =>
                        writeApiErr(ctx.response, 404, K_CODE_ARTICLE_NOT_FOUND,
                            "Knowledge article not found")
                }
            } catch (e: Exception) {
                conn.close()
                writeInternalDebug(ctx.response, "getArticle: " + e.message)
            }
    }
}

/*
 * SELECT 列序：0 id,1 source_id,2 source_name,3 slug,4 title,5 category,
 * 6 subcategory,7 excerpt,8 markdown,9 image_count,10 word_count,
 * 11 published_at,12 updated_at
 */
func kArticleDetailJson(row: Array<MyCell>, utcOff: Int64, baseUrl: String): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putStr("sourceId", cellText(row, 1))
    w.putStr("sourceName", cellText(row, 2))
    w.putStr("slug", cellText(row, 3))
    w.putStr("title", cellText(row, 4))
    w.putStr("category", cellText(row, 5))
    w.putOptStr("subcategory", optCellText(row, 6))
    w.putOptStr("excerpt", optCellText(row, 7))
    w.putStr("markdown", cellText(row, 8).replace(
        "knowledge-asset://", baseUrl + "/api/v1/knowledge/assets/"))
    w.putInt("imageCount", optCellInt(row, 9) ?? 0)
    w.putInt("wordCount", optCellInt(row, 10) ?? 0)
    w.putRaw("publishedAt", kInstantRaw(optCellText(row, 11), utcOff))
    w.putRaw("updatedAt", kInstantRaw(optCellText(row, 12), utcOff))
    return w.toJson()
}

/*
 * ServletUriComponentsBuilder.fromCurrentRequest().replacePath("").replaceQuery(null)
 * .build().toUriString() —— 协议 + 主机（带端口）。forward-headers-strategy:
 * framework，所以 X-Forwarded-Proto/Host 优先于直连值。
 */
func kBaseUrl(request: HttpRequest): String {
    var proto = "http"
    match (request.headers.get("X-Forwarded-Proto")) {
        case Some(v) =>
            let p = kFirstToken(v)
            if (p.size > 0) {
                proto = p
            }
        case None => ()
    }
    var host = ""
    match (request.headers.get("X-Forwarded-Host")) {
        case Some(v) =>
            let h = kFirstToken(v)
            if (h.size > 0) {
                host = h
            }
        case None => ()
    }
    if (host.size == 0) {
        match (request.headers.get("Host")) {
            case Some(v) => host = v.trimAscii()
            case None => ()
        }
    }
    if (host.size == 0) {
        return proto + "://localhost"
    }
    return proto + "://" + host
}

/* 逗号分隔的多值头只取第一段（ForwardedHeaderFilter 的行为）。 */
func kFirstToken(v: String): String {
    let parts = v.split(",")
    if (parts.size == 0) {
        return ""
    }
    return parts[0].trimAscii()
}

/* ==================== GET /api/v1/knowledge/categories ==================== */

struct KCatRow {
    let sourceId: String
    let sourceName: String
    let category: String
    let categoryDisplayName: String
    let subcategory: ?String
    let sortOrder: Int64
    let displayName: String
    let articleCount: Int64

    init(sourceId: String, sourceName: String, category: String, categoryDisplayName: String,
         subcategory: ?String, sortOrder: Int64, displayName: String, articleCount: Int64) {
        this.sourceId = sourceId
        this.sourceName = sourceName
        this.category = category
        this.categoryDisplayName = categoryDisplayName
        this.subcategory = subcategory
        this.sortOrder = sortOrder
        this.displayName = displayName
        this.articleCount = articleCount
    }
}

func handleKnowledgeCategories(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(_) => kListCategories(ctx, cfg)
    }
}

func kListCategories(ctx: HttpContext, cfg: AppConfig): Unit {
    match (openDb(cfg)) {
        case None => writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
        case Some(conn) =>
            try {
                let sql = "SELECT a.source_id,s.name,a.category,a.subcategory,COUNT(*)" +
                    " FROM knowledge_articles a JOIN knowledge_sources s ON s.id=a.source_id" +
                    " WHERE a.status='PUBLISHED'" +
                    " GROUP BY a.source_id,s.name,a.category,a.subcategory" +
                    " ORDER BY a.source_id,a.category,a.subcategory"
                let rows = ArrayList<KCatRow>()
                match (conn.query(sql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        for (r in rs.rows) {
                            let category = cellText(r, 2)
                            let sub = optCellText(r, 3)
                            rows.add(KCatRow(
                                cellText(r, 0),
                                cellText(r, 1),
                                category,
                                kCategoryDisplayName(category),
                                sub,
                                kComputeSortOrder(category, sub),
                                kComputeDisplayName(category, sub),
                                optCellInt(r, 4) ?? 0))
                        }
                }
                conn.close()
                let sorted = kSortCatRows(rows.toArray())
                let arr = JsonArrWriter()
                for (r in sorted) {
                    let w = JsonWriter()
                    w.putStr("sourceId", r.sourceId)
                    w.putStr("sourceName", r.sourceName)
                    w.putStr("category", r.category)
                    w.putStr("categoryDisplayName", r.categoryDisplayName)
                    w.putOptStr("subcategory", r.subcategory)
                    w.putInt("sortOrder", r.sortOrder)
                    w.putStr("displayName", r.displayName)
                    w.putInt("articleCount", r.articleCount)
                    arr.addRaw(w.toJson())
                }
                writeJson(ctx.response, 200, apiOk(arr.toJson()))
            } catch (e: Exception) {
                conn.close()
                writeInternalDebug(ctx.response, "listCategories: " + e.message)
            }
    }
}

/* Comparator.comparingInt(sortOrder).thenComparing(displayName) */
func kSortCatRows(rows: Array<KCatRow>): Array<KCatRow> {
    let n = rows.size
    var a: Int64 = 1
    while (a < n) {
        let cur = rows[a]
        var b = a - 1
        while (b >= 0 && kCatLess(cur, rows[b])) {
            rows[b + 1] = rows[b]
            b -= 1
        }
        rows[b + 1] = cur
        a += 1
    }
    return rows
}

func kCatLess(a: KCatRow, b: KCatRow): Bool {
    if (a.sortOrder != b.sortOrder) {
        return a.sortOrder < b.sortOrder
    }
    return memStrLess(a.displayName, b.displayName)
}

func kComputeSortOrder(category: String, subcategory: ?String): Int64 {
    var categoryOrder: Int64 = 999
    if (category == "cs_learn") {
        categoryOrder = 10
    } else if (category == "mysql") {
        categoryOrder = 20
    } else if (category == "network") {
        categoryOrder = 30
    } else if (category == "os") {
        categoryOrder = 40
    } else if (category == "redis") {
        categoryOrder = 50
    } else if (category == "reader_nb") {
        categoryOrder = 60
    } else if (category == "overview") {
        categoryOrder = 70
    } else if (category == "docs") {
        categoryOrder = 10
    } else if (category == "code") {
        categoryOrder = 20
    } else if (category == "Additional-Chapter") {
        categoryOrder = 30
    } else if (category == "Extra-Chapter") {
        categoryOrder = 40
    } else if (category == "Co-creation-projects") {
        categoryOrder = 50
    }
    match (subcategory) {
        case None => return categoryOrder * 100
        case Some(sub) => return categoryOrder * 100 + kExtractChapterNumber(sub)
    }
}

func kComputeDisplayName(category: String, subcategory: ?String): String {
    match (subcategory) {
        case None => return kCategoryDisplayName(category)
        case Some(sub) => return kPrettyName(sub)
    }
}

func kCategoryDisplayName(category: String): String {
    if (category == "cs_learn") {
        return "CS 导论"
    } else if (category == "mysql") {
        return "MySQL 数据库"
    } else if (category == "network") {
        return "计算机网络"
    } else if (category == "os") {
        return "操作系统"
    } else if (category == "redis") {
        return "Redis 缓存"
    } else if (category == "reader_nb") {
        return "读书笔记"
    } else if (category == "overview") {
        return "项目导读"
    } else if (category == "docs") {
        return "教程正文"
    } else if (category == "code") {
        return "章节代码"
    } else if (category == "Additional-Chapter") {
        return "补充指南"
    } else if (category == "Extra-Chapter") {
        return "拓展章节"
    } else if (category == "Co-creation-projects") {
        return "共创项目"
    }
    return category
}

func kPrettyName(subcategory: String): String {
    match (kChapterNumber(subcategory)) {
        case Some(chapter) =>
            let title = kChapterTitle(chapter)
            if (title.size == 0) {
                return "第 " + chapter.toString() + " 章"
            }
            return "第 " + chapter.toString() + " 章 · " + title
        case None => ()
    }
    let stripped = kStripLeadingDigitsUnderscore(subcategory)
    if (stripped == "base") {
        return "基础"
    } else if (stripped == "http") {
        return "HTTP 协议"
    } else if (stripped == "tcp") {
        return "TCP 协议"
    } else if (stripped == "ip") {
        return "IP 协议"
    } else if (stripped == "hardware") {
        return "硬件基础"
    } else if (stripped == "os_structure") {
        return "操作系统结构"
    } else if (stripped == "memory") {
        return "内存管理"
    } else if (stripped == "process") {
        return "进程管理"
    } else if (stripped == "schedule") {
        return "进程调度"
    } else if (stripped == "file_system") {
        return "文件系统"
    } else if (stripped == "device") {
        return "设备管理"
    } else if (stripped == "network_system") {
        return "网络系统"
    } else if (stripped == "linux_cmd") {
        return "Linux 命令"
    } else if (stripped == "learn") {
        return "学习笔记"
    } else if (stripped == "buffer_pool") {
        return "缓冲池"
    } else if (stripped == "index") {
        return "索引"
    } else if (stripped == "lock") {
        return "锁机制"
    } else if (stripped == "log") {
        return "日志"
    } else if (stripped == "transaction") {
        return "事务"
    } else if (stripped == "architecture") {
        return "架构"
    } else if (stripped == "cluster") {
        return "集群"
    } else if (stripped == "data_struct") {
        return "数据结构"
    } else if (stripped == "module") {
        return "模块"
    } else if (stripped == "storage") {
        return "存储"
    }
    return stripped
}

/* subcategory.matches("chapter\\d+") -> 章号 */
func kChapterNumber(s: String): ?Int64 {
    if (!s.startsWith("chapter") || s.size <= 7) {
        return None
    }
    let rest = s[7..s.size]
    let runes = rest.toRuneArray()
    var n: Int64 = 0
    for (ch in runes) {
        let c = runeCode(ch)
        if (c < 0x30 || c > 0x39) {
            return None
        }
        n = n * 10 + Int64(c - 0x30)
    }
    return Some(n)
}

func kChapterTitle(chapter: Int64): String {
    if (chapter == 1) {
        return "初识智能体"
    } else if (chapter == 2) {
        return "智能体发展史"
    } else if (chapter == 3) {
        return "大语言模型基础"
    } else if (chapter == 4) {
        return "智能体经典范式"
    } else if (chapter == 5) {
        return "低代码智能体搭建"
    } else if (chapter == 6) {
        return "框架开发实践"
    } else if (chapter == 7) {
        return "构建 Agent 框架"
    } else if (chapter == 8) {
        return "记忆与检索"
    } else if (chapter == 9) {
        return "上下文工程"
    } else if (chapter == 10) {
        return "智能体通信协议"
    } else if (chapter == 11) {
        return "Agentic-RL"
    } else if (chapter == 12) {
        return "智能体性能评估"
    } else if (chapter == 13) {
        return "智能旅行助手"
    } else if (chapter == 14) {
        return "自动化深度研究"
    } else if (chapter == 15) {
        return "构建赛博小镇"
    } else if (chapter == 16) {
        return "毕业设计"
    }
    return ""
}

/* extractChapterNumber: 先 chapter\d+，再 ^(\d+)_ */
func kExtractChapterNumber(subcategory: String): Int64 {
    match (kChapterNumber(subcategory)) {
        case Some(n) => return n
        case None => ()
    }
    let runes = subcategory.toRuneArray()
    var i = 0
    while (i < runes.size && runeCode(runes[i]) >= 0x30 && runeCode(runes[i]) <= 0x39) {
        i += 1
    }
    if (i > 0 && i < runes.size && runeCode(runes[i]) == 0x5f) {
        var n: Int64 = 0
        var j = 0
        while (j < i) {
            n = n * 10 + Int64(runeCode(runes[j]) - 0x30)
            j += 1
        }
        return n
    }
    return 0
}

/* replaceFirst("^\\d+_", "") —— 只去掉开头的一段前导数字加下划线。 */
func kStripLeadingDigitsUnderscore(s: String): String {
    let runes = s.toRuneArray()
    var i = 0
    while (i < runes.size && runeCode(runes[i]) >= 0x30 && runeCode(runes[i]) <= 0x39) {
        i += 1
    }
    if (i > 0 && i < runes.size && runeCode(runes[i]) == 0x5f) {
        return s[i + 1..s.size]
    }
    return s
}

/* ==================== GET /api/v1/knowledge/assets/{assetId} ==================== */

/* assetId.matches("[0-9a-f]{64}") */
func kIsAssetId(s: String): Bool {
    if (s.size != 64) {
        return false
    }
    for (b in s.toArray()) {
        let c = Int64(b)
        let ok = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66)
        if (!ok) {
            return false
        }
    }
    return true
}

func kAssetCacheControl(): String {
    "max-age=31536000, public, immutable"
}

/*
 * assetPath = assetDirectory.resolve(storagePath).normalize()，随后必须仍在
 * assetDirectory 之内且是普通文件，否则 404（目录穿越防护）。
 */
func kResolveAssetPath(root: String, storagePath: String): String {
    let rootNorm = kNormalizeDotSegments(root)
    if (storagePath.startsWith("/")) {
        return kNormalizeDotSegments(storagePath)
    }
    return kNormalizeDotSegments(pathJoin(rootNorm, storagePath))
}

/* Path.normalize()：消掉 "." 与 ".."（保留前导 ".."）。 */
func kNormalizeDotSegments(p: String): String {
    let np = normPath(p)
    let isAbs = np.startsWith("/")
    let parts = np.split("/")
    let stack = Array<String>(parts.size + 1, repeat: "")
    var depth: Int64 = 0
    for (part in parts) {
        if (part.size == 0 || part == ".") {
            continue
        }
        if (part == "..") {
            if (depth > 0 && stack[depth - 1] != "..") {
                depth -= 1
            } else if (!isAbs) {
                stack[depth] = ".."
                depth += 1
            }
            continue
        }
        stack[depth] = part
        depth += 1
    }
    if (depth == 0) {
        return if (isAbs) { "/" } else { "." }
    }
    var out = if (isAbs) { "/" } else { "" }
    var i: Int64 = 0
    while (i < depth) {
        if (i > 0) {
            out = out + "/"
        }
        out = out + stack[i]
        i += 1
    }
    return out
}

func handleKnowledgeAsset(ctx: HttpContext, cfg: AppConfig): Unit {
    var assetId = ""
    match (routeParam(ctx.request, "assetId")) {
        case Some(v) => assetId = v
        case None => ()
    }
    if (!kIsAssetId(assetId)) {
        writeApiErr(ctx.response, 404, K_CODE_ASSET_NOT_FOUND, "Knowledge asset not found")
        return
    }
    match (openDb(cfg)) {
        case None => writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
        case Some(conn) =>
            var row: ?Array<MyCell> = None
            var dbErr = ""
            try {
                let sql = "SELECT mime_type,storage_path,size_bytes FROM knowledge_assets" +
                    " WHERE id=" + sqlQuote(assetId)
                match (conn.query(sql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        if (!rs.rows.isEmpty()) {
                            row = Some(rs.rows[0])
                        }
                }
            } catch (e: Exception) {
                dbErr = e.message
            }
            conn.close()
            if (dbErr.size > 0) {
                writeInternalDebug(ctx.response, "getAsset: " + dbErr)
                return
            }
            match (row) {
                case None =>
                    writeApiErr(ctx.response, 404, K_CODE_ASSET_NOT_FOUND,
                        "Knowledge asset not found")
                case Some(r) => kServeAsset(ctx, assetId, r)
            }
    }
}

func kServeAsset(ctx: HttpContext, assetId: String, row: Array<MyCell>): Unit {
    let mimeType = cellText(row, 0)
    let storagePath = cellText(row, 1)
    let sizeBytes = optCellInt(row, 2) ?? 0
    let etag = "\"" + assetId + "\""
    match (ctx.request.headers.get("If-None-Match")) {
        case Some(v) =>
            if (v.contains(assetId)) {
                ctx.response.statusCode = 304
                ctx.response.headers.add("ETag", etag)
                ctx.response.headers.add("Cache-Control", kAssetCacheControl())
                return
            }
        case None => ()
    }
    let root = getVariable("KNOWLEDGE_ASSET_DIR") ?? "data/knowledge-base/assets"
    let assetPath = kResolveAssetPath(root, storagePath)
    if (!pathIsUnder(assetPath, root) || !fileIsFile(assetPath)) {
        writeApiErr(ctx.response, 404, K_CODE_ASSET_NOT_FOUND, "Knowledge asset not found")
        return
    }
    ctx.response.contentType = mimeType
    ctx.response.headers.add("Content-Length", sizeBytes.toString())
    ctx.response.headers.add("ETag", etag)
    ctx.response.headers.add("Cache-Control", kAssetCacheControl())
    ctx.response.write(File.readFrom(assetPath))
}
