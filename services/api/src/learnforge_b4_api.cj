package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * P2 batch 4 reads:
 *   GET /api/v1/knowledge-points, /knowledge-points/{code}
 *   GET /api/v1/learning-path
 *   GET /api/v1/review-states
 *   GET /api/v1/learning-goals, /learning-goals/{goalId}
 *   GET /api/v1/job-targets
 *
 * Contract: LearnForgeController.java, LearningGoalController.java (reads only),
 * JobTargetController.java, LearnForgeService.java, LearningGoalService.java.
 */

public func registerLearnForgeB4Routes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("api/v1/knowledge-points") {
        ctx => handleListKp(ctx, cfg)
    }
    app.mapGet("api/v1/knowledge-points/{code}") {
        ctx => handleGetKp(ctx, cfg)
    }
    app.mapGet("api/v1/learning-path") {
        ctx => handleLearningPath(ctx, cfg)
    }
    app.mapGet("api/v1/review-states") {
        ctx => handleReviewStates(ctx, cfg)
    }
    app.mapGet("api/v1/learning-goals") {
        ctx => handleListGoals(ctx, cfg)
    }
    app.mapGet("api/v1/learning-goals/{goalId}") {
        ctx => handleGetGoal(ctx, cfg)
    }
    app.mapGet("api/v1/job-targets") {
        ctx => handleJobTargets(ctx, cfg)
    }
}

/*
 * BigDecimal(scale=4).toString() — always 4 decimal places, trailing zeros kept.
 * Jackson emits BigDecimal as a bare JSON number with toString() text.
 * DEFAULT_MASTERY = new BigDecimal("0.5000") → "0.5000", not "0.5".
 */
func formatScale4(x: Float64): String {
    var neg = false
    var v = x
    if (v < 0.0) {
        neg = true
        v = 0.0 - v
    }
    let scaled = javaMathRound(v * 10000.0)
    let whole = scaled / 10000
    var frac = (scaled - whole * 10000).toString()
    while (frac.size < 4) {
        frac = "0" + frac
    }
    let sign = if (neg) { "-" } else { "" }
    return sign + whole.toString() + "." + frac
}

/* ---- KnowledgePointResponse ---- */

func kpToJson(kp: RawKpFull): String {
    let w = JsonWriter()
    match (Int64.tryParse(kp.id)) {
        case Some(n) => w.putRaw("id", n.toString())
        case None => w.putRaw("id", "null")
    }
    w.putStr("code", kp.code)
    w.putStr("name", kp.name)
    w.putOptStr("enName", kp.enName)
    /* weight is BigDecimal — Jackson emits toString() as a bare JSON number. */
    match (kp.weight) {
        case Some(t) => w.putRaw("weight", t)
        case None => w.putRaw("weight", "null")
    }
    w.putRaw("targetLevel", kp.targetLevel.toString())
    w.putRaw("coverage", kp.coverage.toString())
    w.putOptStr("description", kp.description)
    w.putRaw("coreTopics", jsonStringArray(kp.coreTopicsJson))
    w.putRaw("prerequisites", jsonStringArray(kp.prerequisitesJson))
    w.putOptStr("domainCode", kp.domainCode)
    w.putOptStr("domainName", kp.domainName)
    return w.toJson()
}

func handleListKp(ctx: HttpContext, cfg: AppConfig): Unit {
    match (openDb(cfg)) {
        case None => writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
        case Some(conn) =>
            try {
                let store = LearnForgeB4Store(conn)
                let rows = store.listKnowledgePointsFull()
                conn.close()
                let arr = JsonArrWriter()
                for (kp in rows) { arr.addRaw(kpToJson(kp)) }
                writeJson(ctx.response, 200, apiOk(arr.toJson()))
            } catch (e: Exception) {
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

func handleGetKp(ctx: HttpContext, cfg: AppConfig): Unit {
    let code = routeParamStr(ctx, "code") ?? ""
    match (openDb(cfg)) {
        case None => writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
        case Some(conn) =>
            try {
                let store = LearnForgeB4Store(conn)
                match (store.getKnowledgePointByCode(code)) {
                    case None =>
                        conn.close()
                        writeApiErr(ctx.response, 404, CODE_KNOWLEDGE_POINT_NOT_FOUND, "知识点不存在")
                    case Some(kp) =>
                        conn.close()
                        writeJson(ctx.response, 200, apiOk(kpToJson(kp)))
                }
            } catch (e: Exception) {
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

/* ---- LearningPathItem ---- */
/*
 * mastery = review.mastery or 0.5000; target = targetLevel/100 (HALF_UP 4dp);
 * gap = target - mastery; status = not_started|ready|recommended.
 * Sorted by mastery ASC then sequence ASC, then re-sequenced 1..n.
 */
func handleLearningPath(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (openDb(cfg)) {
                case None => writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let store = LearnForgeB4Store(conn)
                        let points = store.listKnowledgePointsFull()
                        let reviews = store.listReviewSchedules(userId)
                        conn.close()
                        /* build reviewByCode map */
                        let reviewMap = HashMap<String, RawReviewSchedule>()
                        for (r in reviews) { reviewMap.add(r.kpCode, r) }
                        /* build items */
                        var items = ArrayList<(String, String, Float64, Int64, Float64, String, Int64, Array<String>)>()
                        var seq: Int64 = 1
                        for (p in points) {
                            var mastery: Float64 = 0.5
                            var hasReview = false
                            match (reviewMap.get(p.code)) {
                                case Some(rv) =>
                                    match (javaDoubleFromText(rv.mastery)) {
                                        case Some(v) => mastery = v
                                        case None => ()
                                    }
                                    hasReview = true
                                case None => ()
                            }
                            let target = Float64(p.targetLevel) / 100.0
                            let gap = target - mastery
                            var status = "not_started"
                            if (hasReview) {
                                status = if (mastery >= target) { "ready" } else { "recommended" }
                            }
                            let prereqs = parseStringListRaw(p.prerequisitesJson)
                            items.add((p.code, p.name, mastery, p.targetLevel, gap, status, seq, prereqs))
                            seq += 1
                        }
                        /* stable sort by mastery ASC then sequence ASC */
                        let arr = items.toArray()
                        let n = arr.size
                        var sorted = Array<(String, String, Float64, Int64, Float64, String, Int64, Array<String>)>(n, repeat: arr[0])
                        var i: Int64 = 0
                        while (i < n) { sorted[i] = arr[i]; i += 1 }
                        var k: Int64 = 1
                        while (k < n) {
                            let cur = sorted[k]
                            var j = k - 1
                            while (j >= 0 && (sorted[j][2] > cur[2] || (sorted[j][2] == cur[2] && sorted[j][6] > cur[6]))) {
                                sorted[j + 1] = sorted[j]
                                j -= 1
                            }
                            sorted[j + 1] = cur
                            k += 1
                        }
                        /* re-sequence */
                        let out = JsonArrWriter()
                        i = 0
                        while (i < n) {
                            let it = sorted[i]
                            let w = JsonWriter()
                            w.putStr("kpId", it[0])
                            w.putStr("name", it[1])
                            /* BigDecimal(scale=4).toString() */
                            w.putRaw("mastery", formatScale4(it[2]))
                            w.putRaw("targetLevel", it[3].toString())
                            w.putRaw("gap", formatScale4(it[4]))
                            w.putStr("status", it[5])
                            w.putRaw("sequence", (i + 1).toString())
                            w.putRaw("prerequisites", jsonStringArray(it[7]))
                            out.addRaw(w.toJson())
                            i += 1
                        }
                        writeJson(ctx.response, 200, apiOk(out.toJson()))
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

/* ---- ReviewStateResponse ---- */

func handleReviewStates(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (openDb(cfg)) {
                case None => writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let store = LearnForgeB4Store(conn)
                        let points = store.listKnowledgePointsFull()
                        let reviews = store.listReviewSchedules(userId)
                        conn.close()
                        let reviewMap = HashMap<String, RawReviewSchedule>()
                        for (r in reviews) { reviewMap.add(r.kpCode, r) }
                        let nowMicros = timePartsToEpochMicros(nowUtcParts())
                        let out = JsonArrWriter()
                        for (p in points) {
                            let w = JsonWriter()
                            w.putStr("kpId", p.code)
                            w.putStr("name", p.name)
                            match (reviewMap.get(p.code)) {
                                case None =>
                                    /* DEFAULT_MASTERY = new BigDecimal("0.5000") */
                                    w.putRaw("lastAt", "null")
                                    w.putRaw("reps", "0")
                                    w.putRaw("mastery", "0.5000")
                                    w.putRaw("dueAt", jsonQuote(isoInstantFromDb(isoUtcNowZ())))
                                    w.putRaw("due", "true")
                                    w.putRaw("overdueDays", "0")
                                case Some(rv) =>
                                    match (rv.lastAtUtc) {
                                        case Some(t) => w.putRaw("lastAt", jsonQuote(isoInstantFromDb(t)))
                                        case None => w.putRaw("lastAt", "null")
                                    }
                                    w.putRaw("reps", rv.reps.toString())
                                    /* BigDecimal from DB — emit raw text (scale 4) */
                                    w.putRaw("mastery", rv.mastery)
                                    w.putRaw("dueAt", jsonQuote(isoInstantFromDb(rv.dueAtUtc)))
                                    /* due = !dueAt.isAfter(now) */
                                    let dueMicros = timePartsToEpochMicros(parseDbDatetime(rv.dueAtUtc))
                                    let due = dueMicros <= nowMicros
                                    w.putRaw("due", if (due) { "true" } else { "false" })
                                    var overdue: Int64 = 0
                                    if (dueMicros < nowMicros) {
                                        overdue = (nowMicros - dueMicros) / 86400000000
                                    }
                                    w.putRaw("overdueDays", overdue.toString())
                            }
                            out.addRaw(w.toJson())
                        }
                        writeJson(ctx.response, 200, apiOk(out.toJson()))
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

/* ---- LearningGoalResponse ---- */

func goalB4ToJson(g: RawGoalB4, currentGoalId: ?Array<Byte>): String {
    let w = JsonWriter()
    w.putRaw("id", jsonQuote(uuidFormat(g.id)))
    match (g.domainId) {
        case Some(n) => w.putRaw("knowledgeDomainId", n.toString())
        case None => w.putRaw("knowledgeDomainId", "null")
    }
    w.putOptStr("knowledgeDomainCode", g.domainCode)
    w.putOptStr("knowledgeDomainName", g.domainName)
    w.putStr("goalType", g.goalType)
    /* title = domain == null ? goal.title : domain.name */
    match (g.domainId) {
        case Some(_) => w.putOptStr("title", g.domainName)
        case None => w.putStr("title", g.title)
    }
    w.putOptStr("description", g.description)
    w.putStr("expectedLevel", g.expectedLevel)
    w.putOptStr("initialLevel", g.initialLevel)
    w.putOptStr("assessmentMethod", g.assessmentMethod)
    w.putStr("status", g.status)
    w.putOptStr("targetDate", g.targetDate)
    /* current = goal.id.equals(currentGoalId) */
    var isCurrent = false
    match (currentGoalId) {
        case Some(cid) =>
            if (uuidFormat(g.id) == uuidFormat(cid)) { isCurrent = true }
        case None => ()
    }
    w.putRaw("current", if (isCurrent) { "true" } else { "false" })
    w.putRaw("createdAt", jsonQuote(isoInstantFromDb(g.createdAtUtc)))
    w.putRaw("updatedAt", jsonQuote(isoInstantFromDb(g.updatedAtUtc)))
    return w.toJson()
}

func handleListGoals(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (openDb(cfg)) {
                case None => writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let store = LearnForgeB4Store(conn)
                        let curId = store.currentGoalId(userId)
                        let goals = store.listGoals(userId)
                        conn.close()
                        let arr = JsonArrWriter()
                        for (g in goals) { arr.addRaw(goalB4ToJson(g, curId)) }
                        writeJson(ctx.response, 200, apiOk(arr.toJson()))
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

func handleGetGoal(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "goalId")) {
                case None => return
                case Some(goalId) =>
                    match (openDb(cfg)) {
                        case None => writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                        case Some(conn) =>
                            try {
                                let store = LearnForgeB4Store(conn)
                                match (store.getGoal(userId, goalId)) {
                                    case None =>
                                        conn.close()
                                        writeApiErr(ctx.response, 404, CODE_VALIDATION_FAILED, "学习目标不存在")
                                    case Some(g) =>
                                        let curId = store.currentGoalId(userId)
                                        conn.close()
                                        writeJson(ctx.response, 200, apiOk(goalB4ToJson(g, curId)))
                                }
                            } catch (e: Exception) {
                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            }
                    }
            }
    }
}

/* ---- JobTargetLevel ---- */

func handleJobTargets(ctx: HttpContext, cfg: AppConfig): Unit {
    let jobCode = queryParam(ctx.request, "job")
    match (openDb(cfg)) {
        case None => writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
        case Some(conn) =>
            try {
                let store = LearnForgeB4Store(conn)
                let rows = store.listJobTargets(jobCode)
                conn.close()
                let arr = JsonArrWriter()
                for (t in rows) {
                    /* JobTargetLevel entity field order */
                    let w = JsonWriter()
                    w.putRaw("id", t.id)
                    w.putStr("jobCode", t.jobCode)
                    w.putStr("nodeCode", t.nodeCode)
                    w.putOptStr("nodeName", t.nodeName)
                    w.putRaw("targetMastery", t.targetMastery.toString())
                    w.putRaw("priority", t.priority.toString())
                    w.putRaw("sortOrder", t.sortOrder.toString())
                    w.putRaw("createdAt", jsonQuote(isoInstantFromDb(t.createdAtUtc)))
                    w.putRaw("updatedAt", jsonQuote(isoInstantFromDb(t.updatedAtUtc)))
                    arr.addRaw(w.toJson())
                }
                writeJson(ctx.response, 200, apiOk(arr.toJson()))
            } catch (e: Exception) {
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

/* ---- helpers ---- */

func routeParamStr(ctx: HttpContext, name: String): ?String {
    routeParam(ctx.request, name)
}

func parseStringListRaw(rawJson: ?String): Array<String> {
    var text = ""
    match (rawJson) {
        case Some(t) => text = t
        case None => return Array<String>(0, repeat: "")
    }
    if (text.trimAscii().size == 0) {
        return Array<String>(0, repeat: "")
    }
    match (jsonParse(text)) {
        case None => return Array<String>(0, repeat: "")
        case Some(v) =>
            if (!isJsArray(v)) {
                return Array<String>(0, repeat: "")
            }
            let arr = v.asArray()
            let out = ArrayList<String>()
            var i: Int64 = 0
            while (i < arr.size()) {
                match (arr.get(i)) {
                    case Some(item) =>
                        if (isJsString(item)) {
                            out.add(item.asString().getValue())
                        }
                    case None => ()
                }
                i += 1
            }
            return out.toArray()
    }
}
