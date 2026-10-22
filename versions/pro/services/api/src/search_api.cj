package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * GET /api/v1/search —— 从 LearnForgeSupportController 移植到 Spire。
 *
 * 契约来源：
 *   web/LearnForgeSupportController.java:103-105
 *   service/LearnForgeSupportService.java:216-248
 *   web/dto/SearchResponse.java
 *   config/SecurityConfig.java（anyRequest().authenticated()，所以要登录）
 *
 * 语义（逐句照搬）：
 *   q = query.trim().toLowerCase(ROOT)；为空直接返回 {"total":0,"items":[]}。
 *   先扫启用知识点的 name / code / description / core_topics_json，
 *   命中就产出 type=knowledge、id=code、url=/learn/{code}；
 *   不足 20 条再扫 status=1 的知识分类的 name / full_path，
 *   命中产出 type=category、id=<数字 id>、url=/knowledge。
 *   两段都是满 20 条即停，total 是最终条数。
 */

const SR_CODE_VALIDATION_FAILED: Int64 = 1000
const SR_CODE_INTERNAL_ERROR: Int64 = 1500

public func registerSearchRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("api/v1/search") {
        ctx => handleSearch(ctx, cfg)
    }
}

func srLower(value: String): String {
    value.toAsciiLower()
}

func srContains(haystack: ?String, needle: String): Bool {
    match (haystack) {
        case None => return false
        case Some(v) => return srLower(v).contains(needle)
    }
}

struct SrItem {
    let kind: String
    let id: String
    let title: String
    let excerpt: ?String
    let url: String

    init(kind: String, id: String, title: String, excerpt: ?String, url: String) {
        this.kind = kind
        this.id = id
        this.title = title
        this.excerpt = excerpt
        this.url = url
    }
}

func srItemJson(item: SrItem): String {
    let w = JsonWriter()
    w.putStr("type", item.kind)
    w.putStr("id", item.id)
    w.putStr("title", item.title)
    w.putOptStr("excerpt", item.excerpt)
    w.putStr("url", item.url)
    return w.toJson()
}

func handleSearch(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => ()
        case Some(_) =>
            let raw = queryParam(ctx.request, "q") ?? ""
            let q = srLower(raw.trimAscii())
            if (q.size == 0) {
                let empty = JsonWriter()
                empty.putInt("total", 0)
                empty.putRaw("items", "[]")
                writeJson(ctx.response, 200, apiOk(empty.toJson()))
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, SR_CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let items = ArrayList<SrItem>()
                        /* KnowledgePoint: findAllByStatusOrderBySortOrderAscIdAsc(1) */
                        let pointSql = "SELECT code,name,description,core_topics_json" +
                            " FROM knowledge_point WHERE status=1" +
                            " ORDER BY sort_order ASC, id ASC"
                        match (conn.query(pointSql)) {
                            case QueryOutcome.Ok(_) => ()
                            case QueryOutcome.ResultSet(rs) =>
                                for (row in rs.rows) {
                                    if (items.size >= 20) {
                                        break
                                    }
                                    let name = optCellText(row, 1)
                                    let code = optCellText(row, 0)
                                    let matched = srContains(name, q) ||
                                        srContains(code, q) ||
                                        srContains(optCellText(row, 2), q) ||
                                        srContains(optCellText(row, 3), q)
                                    if (!matched) {
                                        continue
                                    }
                                    items.add(SrItem("knowledge", code ?? "", name ?? "",
                                        optCellText(row, 2), "/learn/" + (code ?? "")))
                                }
                        }
                        /* KnowledgeCategory: findAll()，只保留 status == 1。 */
                        if (items.size < 20) {
                            let catSql = "SELECT id,name,description,full_path" +
                                " FROM knowledge_category WHERE status=1 ORDER BY id ASC"
                            match (conn.query(catSql)) {
                                case QueryOutcome.Ok(_) => ()
                                case QueryOutcome.ResultSet(rs) =>
                                    for (row in rs.rows) {
                                        if (items.size >= 20) {
                                            break
                                        }
                                        let name = optCellText(row, 1)
                                        if (!srContains(name, q) &&
                                            !srContains(optCellText(row, 3), q)) {
                                            continue
                                        }
                                        items.add(SrItem("category",
                                            (optCellInt(row, 0) ?? 0).toString(),
                                            name ?? "", optCellText(row, 2), "/knowledge"))
                                    }
                            }
                        }
                        conn.close()
                        let arr = JsonArrWriter()
                        for (item in items) {
                            arr.addRaw(srItemJson(item))
                        }
                        let w = JsonWriter()
                        w.putInt("total", items.size)
                        w.putRaw("items", arr.toJson())
                        writeJson(ctx.response, 200, apiOk(w.toJson()))
                    } catch (e: Exception) {
                        conn.close()
                        writeApiErr(ctx.response, 500, SR_CODE_INTERNAL_ERROR,
                            "服务器内部错误")
                    }
            }
    }
}
