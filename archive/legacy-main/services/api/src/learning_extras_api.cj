package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * /v1 面上的纯数据库端点（无 LLM、无流式、无文件生成）。
 *
 *   POST v1/learning-resources/batch-delete      批量删除自有资源 + 聊天记录
 *   GET  v1/teaching-group/runs                  教研组运行列表
 *   GET  v1/teaching-group/runs/{run_id}         教研组运行详情
 *
 * 契约来源：
 *   routers/public.py:4934-4947
 *   storage/learning_resources.py:602-627
 *   routers/public.py:1112-1132
 *   storage/teaching_group_runs.py:126-178
 *
 * 鉴权沿用 /v1 面：requireUser（只验 JWT 签名，不查会话），与同目录其它
 * /v1 模块一致。错误体沿用 Python 的两种形状：
 *   业务错 HTTPException -> {"detail": "..."}
 *   参数校验 -> {"code":"VALIDATION_FAILED","details":[...]}
 */

public func registerLearningExtrasRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapPost("v1/learning-resources/batch-delete") {
        ctx => handleBatchDeleteResources(ctx, cfg)
    }
    app.mapGet("v1/teaching-group/runs") {
        ctx => handleListTeachingGroupRuns(ctx, cfg)
    }
    app.mapGet("v1/teaching-group/runs/{run_id}") {
        ctx => handleGetTeachingGroupRun(ctx, cfg)
    }
}

/* ==================== POST /v1/learning-resources/batch-delete ==================== */

func handleBatchDeleteResources(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (readPyBodyObject(ctx)) {
                case None => ()
                case Some(root) =>
                    let rawIds = match (root.get("resourceIds")) {
                        case Some(v) => v
                        case None => JsonValue.fromStr("null")
                    }
                    let isList = match (rawIds.kind()) {
                        case JsonKind.JsArray => true
                        case _ => false
                    }
                    if (!isList || rawIds.asArray().size() == 0 || rawIds.asArray().size() > 100) {
                        writeDetail(ctx.response, 422,
                            "resourceIds must contain 1 to 100 items")
                        return
                    }
                    /* dict.fromkeys：去重且保留首次出现顺序。 */
                    let ids = ArrayList<Array<Byte>>()
                    let seen = HashSet<String>()
                    let arr = rawIds.asArray()
                    var idx: Int64 = 0
                    while (idx < arr.size()) {
                        let item = match (arr.get(idx)) {
                            case Some(v) => v
                            case None =>
                                writeDetail(ctx.response, 422, "Invalid resource id")
                                return
                        }
                        idx += 1
                        let text = lePyStr(item)
                        match (uuidParse(text)) {
                            case None =>
                                writeDetail(ctx.response, 422, "Invalid resource id")
                                return
                            case Some(bytes) =>
                                let key = bytesToHex(bytes)
                                if (!seen.contains(key)) {
                                    seen.add(key)
                                    ids.add(bytes)
                                }
                        }
                    }
                    leDeleteResources(ctx, cfg, userId, ids.toArray())
            }
    }
}

/* str(value) 对字符串取原文，其余类型的可用文本形态；非法 UUID 一律 422。 */
func lePyStr(v: JsonValue): String {
    match (v.kind()) {
        case JsonKind.JsString => return v.asString().getValue()
        case JsonKind.JsInt => return v.asInt().getValue().toString()
        case JsonKind.JsFloat => return javaDoubleText(v.asFloat().getValue())
        case JsonKind.JsBool => return if (v.asBool().getValue()) { "True" } else { "False" }
        case JsonKind.JsNull => return "None"
        case _ => return ""
    }
}

func leDeleteResources(ctx: HttpContext, cfg: AppConfig, userId: Array<Byte>,
                       ids: Array<Array<Byte>>): Unit {
    match (openDb(cfg)) {
        case None =>
            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
        case Some(conn) =>
            try {
                let idList = leBinaryList(ids)
                let owner = sqlBinary(userId)
                let selectSql = "SELECT id FROM generated_learning_resources" +
                    " WHERE user_id=" + owner + " AND id IN (" + idList + ")"
                let owned = ArrayList<Array<Byte>>()
                match (conn.query(selectSql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        for (row in rs.rows) {
                            owned.add(row[0].bytes)
                        }
                }
                if (owned.size > 0) {
                    arBegin(conn)
                    let ownedList = leBinaryList(owned.toArray())
                    arExec(conn, "DELETE FROM learning_resource_messages" +
                        " WHERE user_id=" + owner + " AND resource_id IN (" + ownedList + ")")
                    arExec(conn, "DELETE FROM generated_learning_resources" +
                        " WHERE user_id=" + owner + " AND id IN (" + ownedList + ")")
                    arCommit(conn)
                }
                conn.close()
                let arr = JsonArrWriter()
                for (id in owned) {
                    arr.addRaw(jsonQuote(uuidFormat(id)))
                }
                let w = JsonWriter()
                w.putRaw("deleted", arr.toJson())
                w.putInt("count", owned.size)
                writeJson(ctx.response, 200, w.toJson())
            } catch (e: Exception) {
                try {
                    arRollback(conn)
                } catch (re: Exception) {
                    ()
                }
                conn.close()
                writeInternalDebug(ctx.response, "batchDeleteResources: " + e.message)
            }
    }
}

func leBinaryList(ids: Array<Array<Byte>>): String {
    var out = ""
    var i: Int64 = 0
    while (i < ids.size) {
        if (i > 0) {
            out = out + ","
        }
        out = out + sqlBinary(ids[i])
        i += 1
    }
    return out
}

/* ==================== GET /v1/teaching-group/runs ==================== */

func handleListTeachingGroupRuns(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            /* limit: Query(default=30, ge=1, le=100) */
            var limit: Int64 = 30
            match (queryParam(ctx.request, "limit")) {
                case None => ()
                case Some(raw) =>
                    match (pythonIntText(raw)) {
                        case None =>
                            writePyType422(ctx.response, ["query", "limit"], "int_parsing",
                                "Input should be a valid integer, unable to parse string as an integer",
                                jsonQuote(raw))
                            return
                        case Some(v) =>
                            if (v < 1) {
                                writePyConstraint422(ctx.response, ["query", "limit"],
                                    "greater_than_equal",
                                    "Input should be greater than or equal to 1",
                                    jsonQuote(raw), "{\"ge\":1}")
                                return
                            }
                            if (v > 100) {
                                writePyConstraint422(ctx.response, ["query", "limit"],
                                    "less_than_equal",
                                    "Input should be less than or equal to 100",
                                    jsonQuote(raw), "{\"le\":100}")
                                return
                            }
                            limit = v
                    }
            }
            /* learnerId: UUID | None = Query(default=None, alias="learnerId") */
            var learnerId: ?Array<Byte> = None
            match (queryParam(ctx.request, "learnerId")) {
                case None => ()
                case Some(raw) =>
                    match (uuidParse(raw)) {
                        case Some(bytes) => learnerId = Some(bytes)
                        case None =>
                            let bag = PyBag()
                            let diag = uuidParseError(raw) ?? "Invalid UUID"
                            bag.add(pyUuidParsing(["query", "learnerId"], jsonQuote(raw), diag))
                            bag.write(ctx.response)
                            return
                    }
            }
            leListRuns(ctx, cfg, userId, limit, learnerId)
    }
}

func leListRuns(ctx: HttpContext, cfg: AppConfig, userId: Array<Byte>, limit: Int64,
                learnerId: ?Array<Byte>): Unit {
    match (openDb(cfg)) {
        case None =>
            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
        case Some(conn) =>
            try {
                var whereSql = " WHERE user_id=" + sqlBinary(userId)
                match (learnerId) {
                    case Some(lid) => whereSql = whereSql + " AND learner_id=" + sqlBinary(lid)
                    case None => ()
                }
                let sql = leRunColumns() + whereSql +
                    " ORDER BY updated_at DESC LIMIT " + limit.toString()
                let arr = JsonArrWriter()
                match (conn.query(sql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        for (row in rs.rows) {
                            arr.addRaw(leRunJson(row, false))
                        }
                }
                conn.close()
                let w = JsonWriter()
                w.putRaw("runs", arr.toJson())
                writeJson(ctx.response, 200, w.toJson())
            } catch (e: Exception) {
                conn.close()
                writeInternalDebug(ctx.response, "listTeachingGroupRuns: " + e.message)
            }
    }
}

func leRunColumns(): String {
    "SELECT id,learner_id,knowledge_point_id,mode,prompt,status,events_json," +
        "result_json,error_code,created_at,updated_at FROM teaching_group_runs"
}

/*
 * TeachingGroupRunStore._serialize —— 字段顺序与 Python dict 字面量一致。
 * 时间列是 TIMESTAMP(6)，Python 侧拿到的是会话时区的 naive datetime，
 * 直接 isoformat()，所以这里用 isoNaiveFromDb，不做 UTC 折算。
 */
func leRunJson(row: Array<MyCell>, includeEvents: Bool): String {
    let eventsRaw = arRawJsonCell(row, 6)
    let eventCount = leJsonArrayLen(eventsRaw)
    let resultRaw = arRawJsonCell(row, 7)
    let focus = leResultField(resultRaw, "diagnosis", "focus")
    let nextAction = leResultField(resultRaw, "decision", "nextAction")
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putStr("runId", uuidText(row, 0) ?? "")
    w.putStr("learnerId", uuidText(row, 1) ?? "")
    w.putOptStr("knowledgePointId", optCellText(row, 2))
    w.putStr("mode", cellText(row, 3))
    w.putOptStr("prompt", optCellText(row, 4))
    w.putStr("status", cellText(row, 5))
    w.putInt("eventCount", eventCount)
    w.putStr("focus", focus)
    w.putStr("nextAction", nextAction)
    w.putOptStr("errorCode", optCellText(row, 8))
    w.putRaw("createdAt", leIsoWithNaive(optCellText(row, 9)))
    w.putRaw("updatedAt", leIsoWithNaive(optCellText(row, 10)))
    if (includeEvents) {
        w.putRaw("events", if (leIsJsonArray(eventsRaw)) { eventsRaw } else { "[]" })
        w.putRaw("result", if (resultRaw == "null") { "null" } else { resultRaw })
    }
    return w.toJson()
}

func leIsoWithNaive(text: ?String): String {
    match (text) {
        case None => return "null"
        case Some(t) =>
            if (t.size == 0) {
                return "null"
            }
            return jsonQuote(isoNaiveFromDb(t))
    }
}

func leIsJsonArray(raw: String): Bool {
    let t = raw.trimAscii()
    t.size >= 2 && t[0..1] == "[" && t[(t.size - 1)..t.size] == "]"
}

/* result.get("diagnosis"/"decision") 是对象时取子字段，最后 str(... or "")。 */
func leResultField(resultRaw: String, group: String, field: String): String {
    let parsed = jsonParse(resultRaw)
    match (parsed) {
        case None => return ""
        case Some(v) =>
            if (!isJsObject(v)) {
                return ""
            }
            match (v.asObject().get(group)) {
                case None => return ""
                case Some(inner) =>
                    if (!isJsObject(inner)) {
                        return ""
                    }
                    match (inner.asObject().get(field)) {
                        case None => return ""
                        case Some(f) => return lePyStr(f)
                    }
            }
    }
}

func leJsonArrayLen(raw: String): Int64 {
    let parsed = jsonParse(raw)
    match (parsed) {
        case None => return 0
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsArray => return v.asArray().size()
                case _ => return 0
            }
    }
}

/* ==================== GET /v1/teaching-group/runs/{run_id} ==================== */

func handleGetTeachingGroupRun(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "run_id")) {
                case None => ()
                case Some(runId) => leGetRun(ctx, cfg, userId, runId)
            }
    }
}

func leGetRun(ctx: HttpContext, cfg: AppConfig, userId: Array<Byte>,
              runId: Array<Byte>): Unit {
    match (openDb(cfg)) {
        case None =>
            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
        case Some(conn) =>
            try {
                let sql = leRunColumns() + " WHERE id=" + sqlBinary(runId) +
                    " AND user_id=" + sqlBinary(userId) + " LIMIT 1"
                var body: ?String = None
                match (conn.query(sql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        if (!rs.rows.isEmpty()) {
                            body = Some(leRunJson(rs.rows[0], true))
                        }
                }
                conn.close()
                match (body) {
                    case Some(json) => writeJson(ctx.response, 200, json)
                    case None =>
                        writeDetail(ctx.response, 404, "Teaching group run not found")
                }
            } catch (e: Exception) {
                conn.close()
                writeInternalDebug(ctx.response, "getTeachingGroupRun: " + e.message)
            }
    }
}
