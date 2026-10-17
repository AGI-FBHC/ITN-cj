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
 *   POST/PUT /learners, GET /profile, GET /learner-profile (and its subpaths),
 *   growth writes.
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
const CODE_LEARNER_NOT_FOUND: Int64 = 3004

public func registerLearnForgeRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("api/v1/learners") {
        ctx => handleListLearners(ctx, cfg)
    }
    app.mapGet("api/v1/learners/{learnerId}") {
        ctx => handleGetLearner(ctx, cfg)
    }
}

/* ---- handlers ---- */

func handleListLearners(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
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
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
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
    w.putRaw("createdAt", jsonQuote(isoUtcZFromDb(row.createdAt)))
    w.putRaw("updatedAt", jsonQuote(isoUtcZFromDb(row.updatedAt)))
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
