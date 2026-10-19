package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * P2 read side: 「画像/成长」 learner endpoints, migrated from Spring Boot.
 *
 *   GET /api/v1/learners
 *   GET /api/v1/learners/{learnerId}
 *
 * Contract source (all of it):
 *   web/LearnForgeSupportController.java:36-46
 *   service/LearnForgeSupportService.java:75-89, 258-276
 *   web/dto/ApiResponse.java, web/dto/LearnerResponse.java
 *   web/GlobalExceptionHandler.java:23-27, exception/ErrorCode.java
 *
 * Two contracts the rest of Spire does not have, and both are load-bearing:
 *
 *   1. The body is wrapped in Spring's ApiResponse envelope
 *      {"code":0,"message":"success","data":…,"timestamp":"…"} — not bare
 *      JSON like the /v1 Python surface. `@JsonInclude(NON_NULL)` is on
 *      ApiResponse only, so a successful response always carries `data`, and
 *      an error omits it entirely.
 *
 *   2. LearnerResponse has NO @JsonInclude, so its null fields are emitted as
 *      JSON null (weeklyHours, avatar, confidenceValue, …). Do not omit them.
 *
 * Not in this batch (still forwarded to Spring Boot by the api/v1 catch-all):
 *   POST/PUT /learners, growth writes.
 *
 * GET /api/v1/learner-profile and /learner-profile/journal were batch 2 and
 * now live in learnforge_analytics_api.cj. The POST/PUT /events, /quiz and
 * /journal/summary writes are still Spring Boot's.
 *
 * GET /api/v1/search is LearnForgeSupportController.java:103-106 +
 * LearnForgeSupportService.java:216-247. SecurityConfig.anyRequest().
 * authenticated() covers it even though the method has no
 * @AuthenticationPrincipal, so it needs requireUserApi like every other
 * /api/v1 route.
 */

/* ---- ApiResponse envelope (web/dto/ApiResponse.java) ---- */

/*
 * success(T) -> code 0, message "success", data, Instant.now().
 * Field order is the record component order: code, message, data, timestamp.
 */
func apiOk(dataJson: String): String {
    "{\"code\":0,\"message\":" + jsonQuote("success") +
        ",\"data\":" + dataJson +
        ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}"
}

/*
 * ApiResponse.error(code, message) -> code, message, timestamp
 * (`data` is null and @JsonInclude(NON_NULL) drops it).
 */
func apiErr(code: Int64, message: String): String {
    "{\"code\":" + code.toString() +
        ",\"message\":" + jsonQuote(message) +
        ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}"
}

/* error() re-emitted at the HTTP status GlobalExceptionHandler chose. */
func writeApiErr(response: HttpResponse, status: UInt16, code: Int64, message: String): Unit {
    writeJson(response, status, apiErr(code, message))
}

/* exception/ErrorCode.java */
const CODE_VALIDATION_FAILED: Int64 = 1000
const CODE_INTERNAL_ERROR: Int64 = 1500
const CODE_PROFILE_NOT_FOUND: Int64 = 2000
const CODE_LEARNING_GOAL_NOT_FOUND: Int64 = 2001
const CODE_KNOWLEDGE_POINT_NOT_FOUND: Int64 = 3002
const CODE_LEARNER_NOT_FOUND: Int64 = 3004

public func registerLearnForgeRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("api/v1/learners") {
        ctx => handleListLearners(ctx, cfg)
    }
    app.mapGet("api/v1/learners/{learnerId}") {
        ctx => handleGetLearner(ctx, cfg)
    }
    app.mapGet("api/v1/profile") {
        ctx => handleGetProfile(ctx, cfg)
    }
    app.mapGet("api/v1/search") {
        ctx => handleSearch(ctx, cfg)
    }
}

/* ---- GET /api/v1/search ---- */

/*
 * LearnForgeSupportService.search (216-247):
 *
 *   q = query.trim().toLowerCase(Locale.ROOT); if q.isBlank(): total 0, []
 *   for each KnowledgePoint (status=ENABLED, sort_order asc, id asc):
 *       match name / code / description / core_topics_json  -> item, stop at 20
 *   if items.size() < 20:
 *       for each KnowledgeCategory (status==1):
 *           match name / full_path  -> item, stop at 20
 *   return SearchResponse(items.size(), items)
 *
 * SearchItem: type, id, title, excerpt, url — record component order.
 *   knowledge: id = code, title = name, excerpt = description, url = "/learn/"+code
 *   category:  id = String.valueOf(id), title = name, excerpt = description,
 *              url = "/knowledge"
 * SearchItem has no @JsonInclude, so a null description IS emitted as JSON
 * null (same rule as learnerToJson's header note).
 *
 * Category matching deliberately does NOT look at description.
 *
 * Java's category loop is findAll() with no ORDER BY; MySQL returns the
 * clustered-index order, so id ASC is the deterministic equivalent and keeps
 * the item order stable across runs.
 */
func handleSearch(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(_) =>
            let raw = queryParam(ctx.request, "q") ?? ""
            let q = raw.trimAscii().toAsciiLower()
            if (q.isEmpty()) {
                writeJson(ctx.response, 200, apiOk("{\"total\":0,\"items\":[]}"))
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        writeJson(ctx.response, 200, apiOk(searchItemsJson(conn, q)))
                        conn.close()
                    } catch (e: Exception) {
                        conn.close()
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

private func searchItemsJson(conn: MyConnection, q: String): String {
    let items = JsonArrWriter()
    var count: Int64 = 0

    let kpSql = "SELECT code, name, description, core_topics_json FROM knowledge_point" +
        " WHERE status=1 ORDER BY sort_order ASC, id ASC"
    match (conn.query(kpSql)) {
        case QueryOutcome.Ok(_) => ()
        case QueryOutcome.ResultSet(rs) =>
            for (row in rs.rows) {
                if (count >= 20) {
                    break
                }
                let code = cellText(row, 0)
                if (searchHit(optCellText(row, 1), q) || searchHit(Some(code), q) ||
                    searchHit(optCellText(row, 2), q) || searchHit(optCellText(row, 3), q)) {
                    items.addRaw(searchItemJson("knowledge", code, optCellText(row, 1),
                                                optCellText(row, 2), "/learn/" + code))
                    count += 1
                }
            }
    }

    if (count < 20) {
        let catSql = "SELECT id, name, description, full_path FROM knowledge_category" +
            " WHERE status=1 ORDER BY id ASC"
        match (conn.query(catSql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                for (row in rs.rows) {
                    if (count >= 20) {
                        break
                    }
                    if (searchHit(optCellText(row, 1), q) || searchHit(optCellText(row, 3), q)) {
                        items.addRaw(searchItemJson("category", cellText(row, 0),
                                                    optCellText(row, 1),
                                                    optCellText(row, 2), "/knowledge"))
                        count += 1
                    }
                }
        }
    }

    let w = JsonWriter()
    w.putInt("total", count)
    w.putRaw("items", items.toJson())
    return w.toJson()
}

/* Java String.toLowerCase(Locale.ROOT).contains(q); None (SQL NULL) never matches. */
private func searchHit(haystack: ?String, needle: String): Bool {
    match (haystack) {
        case None => return false
        case Some(s) => return s.toAsciiLower().contains(needle)
    }
}

/* SearchItem record component order: type, id, title, excerpt, url. */
private func searchItemJson(kind: String, id: String, title: ?String,
                            excerpt: ?String, url: String): String {
    let w = JsonWriter()
    w.putStr("type", kind)
    w.putStr("id", id)
    w.putOptStr("title", title)
    w.putOptStr("excerpt", excerpt)
    w.putStr("url", url)
    return w.toJson()
}

/* ---- handlers ---- */

func handleListLearners(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(userId) =>
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let store = LearnForgeStore(conn)
                        let kpCodes = store.enabledKnowledgePointCodes()
                        let rows = store.listByUser(userId)
                        let arr = JsonArrWriter()
                        for (row in rows) {
                            arr.addRaw(learnerToJson(row, kpCodes))
                        }
                        conn.close()
                        writeJson(ctx.response, 200, apiOk(arr.toJson()))
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

func handleGetLearner(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "learnerId")) {
                case None => return
                case Some(learnerId) =>
                    match (openDb(cfg)) {
                        case None =>
                            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                        case Some(conn) =>
                            try {
                                let store = LearnForgeStore(conn)
                                match (store.getByUser(userId, learnerId)) {
                                    case None =>
                                        conn.close()
                                        /* BusinessException(LEARNER_NOT_FOUND, 404, "学习者不存在") */
                                        writeApiErr(ctx.response, 404, CODE_LEARNER_NOT_FOUND, "学习者不存在")
                                    case Some(row) =>
                                        let kpCodes = store.enabledKnowledgePointCodes()
                                        conn.close()
                                        writeJson(ctx.response, 200, apiOk(learnerToJson(row, kpCodes)))
                                }
                            } catch (e: Exception) {
                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            }
                    }
            }
    }
}

/*
 * GET /api/v1/profile — ProfileController.get -> ProfileService.get.
 *
 * This read never 404s. A missing row is synthesised as `new UserProfile(user)`
 * and still returned as 200, with only userId set, profileCompleted false and
 * the two non-null String columns at their field initialisers. createdAt and
 * updatedAt are null on that path (the transient never hits @PrePersist).
 */
func handleGetProfile(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(userId) =>
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let store = LearnForgeStore(conn)
                        var row = RawProfile(userId)
                        match (store.getProfileByUser(userId)) {
                            case Some(found) => row = found
                            case None => ()
                        }
                        conn.close()
                        writeJson(ctx.response, 200, apiOk(profileToJson(row)))
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

/*
 * ProfileResponse, field order = record component order (23 fields).
 * No @JsonInclude on the record, so null scalars are emitted. The two map
 * fields degrade to `{}` and the list to `[]` — never null.
 */
func profileToJson(row: RawProfile): String {
    let w = JsonWriter()
    w.putRaw("userId", jsonQuote(uuidFormat(row.userId)))
    w.putOptStr("educationLevel", row.educationLevel)
    w.putOptStr("major", row.major)
    w.putOptStr("technicalFoundation", row.technicalFoundation)
    w.putOptStr("learningPreference", row.learningPreference)
    match (row.currentGoalId) {
        case Some(b) => w.putRaw("currentGoalId", jsonQuote(uuidFormat(b)))
        case None => w.putRaw("currentGoalId", "null")
    }
    w.putRaw("profileCompleted", if (row.profileCompleted) { "true" } else { "false" })
    w.putStr("ttsVoice", row.ttsVoice)
    w.putStr("ttsSpeed", row.ttsSpeed)
    w.putOptStr("name", row.name)
    w.putOptStr("avatar", row.avatar)
    w.putOptStr("role", row.role)
    w.putOptStr("jobTitle", row.jobTitle)
    match (row.organizationId) {
        case Some(b) => w.putRaw("organizationId", jsonQuote(uuidFormat(b)))
        case None => w.putRaw("organizationId", "null")
    }
    match (row.departmentId) {
        case Some(b) => w.putRaw("departmentId", jsonQuote(uuidFormat(b)))
        case None => w.putRaw("departmentId", "null")
    }
    w.putOptInt("weeklyHours", row.weeklyHours)
    w.putRaw("learningStyle", jsonStringArray(row.learningStyleJson))
    w.putOptStr("goal", row.goal)
    w.putOptStr("preferredFormat", row.preferredFormat)
    w.putRaw("selfAssessment", jsonObjectField(row.selfAssessmentJson))
    w.putRaw("diagnosisSummary", jsonObjectField(row.diagnosisSummaryJson))
    match (row.createdAt) {
        case Some(t) => w.putRaw("createdAt", jsonQuote(isoInstantFromDb(t)))
        case None => w.putRaw("createdAt", "null")
    }
    match (row.updatedAt) {
        case Some(t) => w.putRaw("updatedAt", jsonQuote(isoInstantFromDb(t)))
        case None => w.putRaw("updatedAt", "null")
    }
    return w.toJson()
}

/*
 * parseMap (ProfileResponse.java:63-70): Map<String, Object> from JSON text.
 * Blank, unparseable, or not a JSON object yields Map.of() — `{}` on the
 * wire. Nested objects/arrays/values go through valueToRaw, which walks the
 * parsed tree rather than re-serialising with JsonObject.toJsonString()
 * (broken for string values in this build).
 */
func jsonObjectField(rawJson: ?String): String {
    var text = ""
    match (rawJson) {
        case Some(t) => text = t
        case None => return "{}"
    }
    if (text.trimAscii().size == 0) {
        return "{}"
    }
    match (jsonParse(text)) {
        case None => return "{}"
        case Some(v) =>
            if (!isJsObject(v)) {
                return "{}"
            }
            return jsonObjectToRaw(v.asObject())
    }
}

/*
 * LearnerResponse, field order = record component order.
 * Null scalars ARE emitted (no @JsonInclude on this record); the two
 * collection fields are never null — parseStringList/parseScores degrade to
 * empty rather than failing.
 */
func learnerToJson(row: RawLearner, kpCodes: Array<String>): String {
    let scores = resolveScores(row.scoresJson, kpCodes)
    let w = JsonWriter()
    w.putRaw("id", jsonQuote(uuidFormat(row.id)))
    w.putOptStr("code", row.code)
    w.putStr("name", row.name)
    w.putOptStr("avatar", row.avatar)
    w.putOptStr("role", row.role)
    w.putOptStr("education", row.education)
    w.putOptStr("targetJob", row.targetJob)
    w.putOptInt("weeklyHours", row.weeklyHours)
    w.putRaw("learningStyle", jsonStringArray(row.learningStyleJson))
    w.putRaw("scores", scoreMapToJson(scores))
    w.putOptStr("goal", row.goal)
    w.putRaw("blindSpots", jsonStringArray(row.blindSpotsJson))
    w.putOptStr("preferredFormat", row.preferredFormat)
    w.putOptStr("diagnosisSummary", row.diagnosisSummary)
    w.putOptStr("confidenceMethod", row.confidenceMethod)
    w.putOptInt("confidenceValue", row.confidenceValue)
    w.putRaw("overallMastery", overallMasteryJson(scores))
    w.putRaw("createdAt", jsonQuote(isoInstantFromDb(row.createdAt)))
    w.putRaw("updatedAt", jsonQuote(isoInstantFromDb(row.updatedAt)))
    return w.toJson()
}

/*
 * overallMastery is a java.math.BigDecimal with setScale(1, HALF_UP) applied
 * only when scores is non-empty; the empty branch returns BigDecimal.ZERO,
 * which has scale 0. Jackson writes the BigDecimal's toString(), so the two
 * cases differ on the wire: `0` vs `50.0`. Preserve that.
 */
func overallMasteryJson(scores: Array<(String, Int64)>): String {
    if (scores.size == 0) {
        return "0"
    }
    return formatScale1(overallMastery(scores))
}

/* One decimal place, always — "50.0", "-3.5". Matches BigDecimal(scale 1). */
func formatScale1(x: Float64): String {
    var neg = false
    var v = x
    if (v < 0.0) {
        neg = true
        v = 0.0 - v
    }
    let scaled = truncateFloat(v * 10.0 + 0.5)
    let whole = scaled / 10
    let frac = scaled - whole * 10
    let sign = if (neg) { "-" } else { "" }
    return sign + whole.toString() + "." + frac.toString()
}

/*
 * Map<String, Integer> — a JSON object of string keys to integers. Keys are
 * emitted in the order the map was built (Jackson uses LinkedHashMap, so
 * document order from scores_json, then the knowledge_point fill order).
 */
func scoreMapToJson(scores: Array<(String, Int64)>): String {
    let w = JsonWriter()
    for ((k, v) in scores) {
        w.putInt(k, v)
    }
    return w.toJson()
}

/*
 * parseStringList (LearnForgeSupportService.java:292-296): null/blank or
 * unparseable -> List.of(), never null. Rebuilt through JsonArrWriter +
 * jsonQuote rather than JsonValue re-serialisation, which the JsonWriter
 * header comment reports as broken for string values in this build.
 */
func jsonStringArray(rawJson: ?String): String {
    var text = ""
    match (rawJson) {
        case Some(t) => text = t
        case None => return "[]"
    }
    if (text.trimAscii().size == 0) {
        return "[]"
    }
    match (jsonParse(text)) {
        case None => return "[]"
        case Some(v) =>
            if (!isJsArray(v)) {
                return "[]"
            }
            let arr = v.asArray()
            let out = JsonArrWriter()
            var i: Int64 = 0
            while (i < arr.size()) {
                match (arr.get(i)) {
                    case None => return "[]"
                    case Some(item) =>
                        if (isJsString(item)) {
                            out.addRaw(jsonQuote(item.asString().getValue()))
                        } else if (isJsBool(item)) {
                            /* Jackson coerces a boolean token to "true"/"false" */
                            out.addRaw(jsonQuote(if (item.asBool().getValue()) { "true" } else { "false" }))
                        } else {
                            /* a number, object or null fails the List<String> parse */
                            return "[]"
                        }
                }
                i += 1
            }
            return out.toJson()
    }
}
