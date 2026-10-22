package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * HTTP handlers for learning-resources + knowledge-category match.
 * Path/method/status/body contracts mirror
 * src/agents/app/routers/public.py so the old frontend can point here unchanged.
 *
 * Batch 1 (read):
 *   GET /v1/learning-resources
 *   GET /v1/learning-resources/{resource_id}
 *   GET /v1/learning-resources/{resource_id}/traceability
 *   GET /v1/knowledge-categories/match
 * Batch 2 (write-back, no LLM):
 *   POST /v1/learning-resources/{resource_id}/complete
 *   PATCH /v1/learning-resources/{resource_id}/progress
 *   POST /v1/learning-resources/{resource_id}/reset
 *   POST /v1/learning-resources/{resource_id}/answers
 *   POST /v1/learning-resources/{resource_id}/answers/grade
 *   POST /v1/learning-resources/{resource_id}/source-feedback
 * Batch 3 (Phase 1 close-out, no LLM):
 *   POST /v1/learning-resources/{resource_id}/ability-reward
 *   GET  /v1/learning-resources/{resource_id}/messages
 *
 * Phase 2 (still Python): generation, regenerate, chat, _record_memory_event,
 * _refresh_adaptive_task_after_answer.
 */
public func registerResourceRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/learning-resources") {
        ctx => handleListLearningResources(ctx, cfg)
    }
    app.mapGet("v1/knowledge-categories/match") {
        ctx => handleKnowledgeMatch(ctx, cfg)
    }
    app.mapGet("v1/learning-resources/{resource_id}") {
        ctx => handleGetLearningResource(ctx, cfg)
    }
    app.mapGet("v1/learning-resources/{resource_id}/traceability") {
        ctx => handleTraceability(ctx, cfg)
    }
    app.mapPost("v1/learning-resources/{resource_id}/complete") {
        ctx => handleCompleteLearningResource(ctx, cfg)
    }
    app.mapPatch("v1/learning-resources/{resource_id}/progress") {
        ctx => handleUpdateProgress(ctx, cfg)
    }
    app.mapPost("v1/learning-resources/{resource_id}/reset") {
        ctx => handleResetLearningResource(ctx, cfg)
    }
    app.mapPost("v1/learning-resources/{resource_id}/answers/grade") {
        ctx => handleGradeAnswer(ctx, cfg)
    }
    app.mapPost("v1/learning-resources/{resource_id}/answers") {
        ctx => handleAnswerQuestion(ctx, cfg)
    }
    app.mapGet("v1/learning-resources/{resource_id}/next-question") {
        ctx => handleNextQuestion(ctx, cfg)
    }
    app.mapPost("v1/learning-resources/{resource_id}/source-feedback") {
        ctx => handleSourceFeedback(ctx, cfg)
    }
    app.mapPost("v1/learning-resources/{resource_id}/ability-reward") {
        ctx => handleAbilityReward(ctx, cfg)
    }
    app.mapGet("v1/learning-resources/{resource_id}/messages") {
        ctx => handleListResourceMessages(ctx, cfg)
    }
}

/* -------- read -------- */

func handleListLearningResources(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            /* resource_type: str | None = None — no alias, so only that key binds.
             * Bad values raise HTTPException 422 {"detail":"Invalid resource type"},
             * not the pydantic envelope (public.py:4462). */
            match (queryParam(ctx.request, "resource_type")) {
                case Some(k) =>
                    if (k != "lecture" && k != "practice" && k != "quiz") {
                        writeDetail(ctx.response, 422, "Invalid resource type")
                        return
                    }
                case None => ()
            }
            /* Exact binding per queryUuidOk — learner_id/kp_id bind only those keys. */
            if (!queryUuidOk(ctx, "learner_id") ||
                !queryUuidOk(ctx, "courseId") || !queryUuidOk(ctx, "chapterId")) {
                return
            }
            if (!queryLenOk(ctx, "kp_id", 64)) {
                return
            }
            if (!queryBoolOk(ctx, "include_course")) {
                return
            }

            var learnerId: ?Array<Byte> = None
            match (queryParam(ctx.request, "learner_id")) {
                case Some(t) => learnerId = uuidParse(t)
                case None => ()
            }
            var courseId: ?Array<Byte> = None
            match (queryParam(ctx.request, "courseId")) {
                case Some(t) => courseId = uuidParse(t)
                case None => ()
            }
            var chapterId: ?Array<Byte> = None
            match (queryParam(ctx.request, "chapterId")) {
                case Some(t) => chapterId = uuidParse(t)
                case None => ()
            }
            let includeCourse = queryTruthy(ctx.request, "include_course") ||
                optHas(courseId) || optHas(chapterId)

            /* scope=own：只看本人生成的资源（「我的资源」页），不返回公共共享资源 */
            var ownOnly = false
            match (queryParam(ctx.request, "scope")) {
                case Some(raw) =>
                    let scope = raw.trimAscii().toAsciiLower()
                    if (scope == "own") {
                        ownOnly = true
                    } else if (!scope.isEmpty() && scope != "all") {
                        writeDetail(ctx.response, 422, "Invalid scope")
                        return
                    }
                case None => ()
            }

            if (storageUnavailable(cfg)) {
                writeDetail(ctx.response, 503, "Learning resource storage is unavailable")
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        let store = ResourcesStore(conn)
                        let items = store.list(
                            userId, queryParam(ctx.request, "resource_type"), includeCourse,
                            learnerId, queryParam(ctx.request, "kp_id"),
                            queryParam(ctx.request, "form"), queryParam(ctx.request, "level"),
                            courseId, chapterId, ownOnly)
                        conn.close()
                        let arr = JsonArrWriter()
                        for (item in items) {
                            arr.addRaw(item)
                        }
                        let obj = JsonWriter()
                        obj.putRaw("resources", arr.toJson())
                        writeJsonEtag(ctx.response, ctx.request, obj.toJson(), "res")
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "listLearningResources: " + e.message)
                    }
            }
    }
}

func handleGetLearningResource(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "resource_id")) {
                case None => return
                case Some(resourceId) =>
                    match (loadResource(ctx, cfg, userId, resourceId)) {
                        case None => return
                        case Some(row) => writeJson(ctx.response, 200, row)
                    }
            }
    }
}

func handleTraceability(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "resource_id")) {
                case None => return
                case Some(resourceId) =>
                    match (loadResource(ctx, cfg, userId, resourceId)) {
                        case None => return
                        case Some(row) =>
                            let obj = JsonWriter()
                            obj.putRaw("items", buildTraceability(row))
                            writeJson(ctx.response, 200, obj.toJson())
                    }
            }
    }
}

/*
 * GET /knowledge-categories/match (public.py:3001).
 *   query: str = Query(min_length=1, max_length=1000)  — required, NOT stripped.
 * Measured: absent -> missing at ["query","query"] input null; "" -> string_too_short;
 * 1001 chars -> string_too_long; "  " (two spaces) -> 200, because min_length
 * counts raw characters. Python then passes the raw value through to the
 * matcher, which does its own term extraction.
 */
func checkKnowledgeMatchQuery(ctx: HttpContext): ?String {
    match (queryParam(ctx.request, "query")) {
        case None =>
            writeValidation422(ctx.response, ["query", "query"], "missing",
                               "Field required", "null", None)
            return None
        case Some(raw) =>
            let n = charCount(raw)
            if (n < 1) {
                writeValidation422(ctx.response, ["query", "query"], "string_too_short",
                                   "String should have at least 1 character",
                                   jsonQuote(raw), Some("{\"min_length\":1}"))
                return None
            }
            if (n > 1000) {
                writeValidation422(ctx.response, ["query", "query"], "string_too_long",
                                   "String should have at most 1000 characters",
                                   jsonQuote(raw), Some("{\"max_length\":1000}"))
                return None
            }
            return Some(raw)
    }
}

func handleKnowledgeMatch(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(_) =>
            match (checkKnowledgeMatchQuery(ctx)) {
                case None => return
                case Some(q) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Knowledge category storage is unavailable")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let matcher = KnowledgeMatcher(conn)
                                let candidates = matcher.candidates(q, 30)
                                let best = matcher.findMatch(q)
                                conn.close()
                                let arr = JsonArrWriter()
                                for (item in candidates) {
                                    let c = JsonWriter()
                                    c.putInt("id", item.id)
                                    c.putStr("name", item.name)
                                    c.putStr("description", item.description)
                                    c.putStr("path", item.path)
                                    arr.addRaw(c.toJson())
                                }
                                let obj = JsonWriter()
                                match (best) {
                                    case Some(m) =>
                                        let mw = JsonWriter()
                                        mw.putInt("id", m.id)
                                        mw.putStr("name", m.name)
                                        mw.putStr("path", m.path)
                                        mw.putFloat("confidence", roundTo(m.confidence, 3))
                                        obj.putRaw("match", mw.toJson())
                                    case None => obj.putRaw("match", "null")
                                }
                                obj.putRaw("candidates", arr.toJson())
                                writeJson(ctx.response, 200, obj.toJson())
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "knowledgeMatch: " + e.message)
                            }
                    }
            }
    }
}

/* -------- write-back -------- */

func handleCompleteLearningResource(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "resource_id")) {
                case None => return
                case Some(resourceId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Learning resource storage is unavailable")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let item = ResourcesStore(conn).markLearned(userId, resourceId)
                                conn.close()
                                match (item) {
                                    case None => writeDetail(ctx.response, 404, "Learning resource not found")
                                    case Some(row) =>
                                        let obj = JsonWriter()
                                        obj.putBool("learned", true)
                                        obj.putRaw("resource", row)
                                        writeJson(ctx.response, 200, obj.toJson())
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "complete: " + e.message)
                            }
                    }
            }
    }
}

func handleUpdateProgress(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "resource_id")) {
                case None => return
                case Some(resourceId) =>
                    match (readJsonObjectBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (parseProgressRequest(ctx, root)) {
                                case None => return
                                case Some(req) =>
                                    if (storageUnavailable(cfg)) {
                                        writeDetail(ctx.response, 503, "Learning resource storage is unavailable")
                                        return
                                    }
                                    match (openDb(cfg)) {
                                        case None =>
                                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                        case Some(conn) =>
                                            try {
                                                let item = ResourcesStore(conn).updateProgress(userId, resourceId, req)
                                                conn.close()
                                                match (item) {
                                                    case None => writeDetail(ctx.response, 404, "Learning resource not found")
                                                    case Some(row) =>
                                                        let obj = JsonWriter()
                                                        obj.putRaw("resource", row)
                                                        writeJson(ctx.response, 200, obj.toJson())
                                                }
                                            } catch (e: Exception) {
                                                conn.close()
                                                writeInternalDebug(ctx.response, "progress: " + e.message)
                                            }
                                    }
                            }
                    }
            }
    }
}

func handleResetLearningResource(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "resource_id")) {
                case None => return
                case Some(resourceId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Learning resource storage is unavailable")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let store = ResourcesStore(conn)
                                /* Python 404s on a missing resource with this exact string. */
                                match (store.get(userId, resourceId)) {
                                    case None =>
                                        conn.close()
                                        writeDetail(ctx.response, 404, "Resource not found")
                                    case Some(original) =>
                                        store.updateState(userId, resourceId, "{}")
                                        /* Best-effort wrong-answer cleanup, matching Python's try/except. */
                                        try {
                                            WrongAnswersStore(conn).deleteByResource(userId, resourceId)
                                        } catch (_: Exception) {
                                            ()
                                        }
                                        let fresh = store.get(userId, resourceId)
                                        conn.close()
                                        var payload = original
                                        match (fresh) {
                                            case Some(f) => payload = f
                                            case None => ()
                                        }
                                        let obj = JsonWriter()
                                        obj.putRaw("resource", payload)
                                        writeJson(ctx.response, 200, obj.toJson())
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "reset: " + e.message)
                            }
                    }
            }
    }
}

func handleSourceFeedback(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "resource_id")) {
                case None => return
                case Some(resourceId) =>
                    match (readJsonObjectBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (parseSourceFeedback(ctx, root)) {
                                case None => return
                                case Some(req) =>
                                    if (storageUnavailable(cfg)) {
                                        writeDetail(ctx.response, 503, "Learning resource storage is unavailable")
                                        return
                                    }
                                    match (openDb(cfg)) {
                                        case None =>
                                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                        case Some(conn) =>
                                            try {
                                                let item = ResourcesStore(conn).createSourceFeedback(
                                                    userId, resourceId, req.sourceId, req.issueType, req.note)
                                                conn.close()
                                                match (item) {
                                                    case None => writeDetail(ctx.response, 404, "Learning resource not found")
                                                    case Some(row) =>
                                                        let obj = JsonWriter()
                                                        obj.putRaw("feedback", row)
                                                        writeJson(ctx.response, 201, obj.toJson())
                                                }
                                            } catch (e: Exception) {
                                                conn.close()
                                                writeInternalDebug(ctx.response, "sourceFeedback: " + e.message)
                                            }
                                    }
                            }
                    }
            }
    }
}

/* -------- ability-reward / messages (Phase 1 close-out) -------- */

/*
 * public.py:6558-6595 reward_learning_resource_ability. Pure data I/O: load
 * the resource, derive correct_rate + hint, then AbilityRewardStore writes
 * learning_resource_ability_rewards and learners.scores_json. Every business
 * refusal is HTTP 200 {"rewarded": false, "reason": ...}; only a missing
 * resource is 404 "Resource not found".
 */
func handleAbilityReward(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parsePathUuidValidated(ctx, "resource_id")) {
                case None => return
                case Some(resourceId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Learning resource storage is unavailable")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let store = ResourcesStore(conn)
                                match (store.get(userId, resourceId)) {
                                    case None =>
                                        conn.close()
                                        writeDetail(ctx.response, 404, "Resource not found")
                                    case Some(row) =>
                                        let resource = parseObject(row)
                                        match (jsonGetString(resource, "learnerId")) {
                                            case None =>
                                                conn.close()
                                                writeJson(ctx.response, 200,
                                                          rewardFalseJson("no-learner"))
                                                return
                                            case Some(learnerText) =>
                                                match (uuidParse(learnerText)) {
                                                    case None =>
                                                        conn.close()
                                                        writeJson(ctx.response, 200,
                                                                  rewardFalseJson("invalid-learner"))
                                                        return
                                                    case Some(learnerId) =>
                                                        /* Python: str(resource.get("type") or "lecture") — "" is falsy too. */
                                                        let typeRaw = jsonGetString(resource, "type") ?? ""
                                                        let resourceType =
                                                            if (typeRaw.isEmpty()) { "lecture" } else { typeRaw }
                                                        /* correct_rate from state.answered (route:6581-6585). */
                                                        var correctRate = 1.0
                                                        match (jsonGetObject(resource, "state")) {
                                                            case Some(state) =>
                                                                match (jsonGetArray(state, "answered")) {
                                                                    case Some(answered) =>
                                                                        if (answered.size() > 0) {
                                                                            var correct: Int64 = 0
                                                                            var ai: Int64 = 0
                                                                            while (ai < answered.size()) {
                                                                                match (answered.get(ai)) {
                                                                                    case Some(item) =>
                                                                                        if (isJsObject(item)) {
                                                                                            match (item.asObject().get("correct")) {
                                                                                                case Some(cv) =>
                                                                                                    if (pyTruthy(cv)) {
                                                                                                        correct += 1
                                                                                                    }
                                                                                                case None => ()
                                                                                            }
                                                                                        }
                                                                                    case None => ()
                                                                                }
                                                                                ai += 1
                                                                            }
                                                                            correctRate =
                                                                                floatFromInt(correct) /
                                                                                floatFromInt(answered.size())
                                                                        }
                                                                    case None => ()
                                                                }
                                                            case None => ()
                                                        }
                                                        /* hint: str(None) -> "None" for missing titles. */
                                                        let hintParts = ArrayList<String>()
                                                        hintParts.add(jsonGetString(resource, "title") ?? "None")
                                                        let content = match (jsonGetObject(resource, "content")) {
                                                            case Some(c) => c
                                                            case None => emptyObject()
                                                        }
                                                        hintParts.add(jsonGetString(content, "title") ?? "None")
                                                        match (jsonGetArray(content, "knowledgePoints")) {
                                                            case Some(pts) =>
                                                                var pi: Int64 = 0
                                                                while (pi < pts.size()) {
                                                                    match (pts.get(pi)) {
                                                                        case Some(p) =>
                                                                            if (isJsObject(p)) {
                                                                                let kpObj = p.asObject()
                                                                                let name =
                                                                                    jsonGetString(kpObj, "name") ?? ""
                                                                                let id =
                                                                                    jsonGetString(kpObj, "id") ?? ""
                                                                                hintParts.add(
                                                                                    if (!name.isEmpty()) { name }
                                                                                    else if (!id.isEmpty()) { id }
                                                                                    else { "" })
                                                                            }
                                                                        case None => ()
                                                                    }
                                                                    pi += 1
                                                                }
                                                            case None => ()
                                                        }
                                                        var hint = ""
                                                        var hi: Int64 = 0
                                                        while (hi < hintParts.size) {
                                                            if (hi > 0) {
                                                                hint = hint + " "
                                                            }
                                                            hint = hint + hintParts[hi]
                                                            hi += 1
                                                        }
                                                        hint = excerptSlice(hint, 300)
                                                        let result = AbilityRewardStore(conn).apply(
                                                            userId, learnerId, resourceId, resourceType,
                                                            jsonGetString(resource, "kpId"), hint, correctRate)
                                                        conn.close()
                                                        writeJson(ctx.response, 200, result)
                                            }
                                        }
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "abilityReward: " + e.message)
                            }
                    }
            }
    }
}

private func rewardFalseJson(reason: String): String {
    let obj = JsonWriter()
    obj.putBool("rewarded", false)
    obj.putStr("reason", reason)
    return obj.toJson()
}

/*
 * public.py:6614-6617 list_learning_resource_messages. No resource existence
 * check (always 200); visibility is the user_id filter, ordered by created_at.
 */
func handleListResourceMessages(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parsePathUuidValidated(ctx, "resource_id")) {
                case None => return
                case Some(resourceId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Learning resource storage is unavailable")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let sql = "SELECT role,content,created_at FROM learning_resource_messages " +
                                    "WHERE resource_id=" + sqlBinary(resourceId) +
                                    " AND user_id=" + sqlBinary(userId) + " ORDER BY created_at"
                                let arr = JsonArrWriter()
                                match (conn.query(sql)) {
                                    case QueryOutcome.Ok(_) => ()
                                    case QueryOutcome.ResultSet(rs) =>
                                        for (row in rs.rows) {
                                            let m = JsonWriter()
                                            m.putStr("role", cellText(row, 0))
                                            m.putStr("content", cellText(row, 1))
                                            m.putStr("createdAt", isoNaiveFromDb(cellText(row, 2)))
                                            arr.addRaw(m.toJson())
                                        }
                                }
                                conn.close()
                                let obj = JsonWriter()
                                obj.putRaw("messages", arr.toJson())
                                writeJson(ctx.response, 200, obj.toJson())
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "listResourceMessages: " + e.message)
                            }
                    }
            }
    }
}

/* -------- answers / answers/grade -------- */

func handleGradeAnswer(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "resource_id")) {
                case None => return
                case Some(resourceId) =>
                    match (readJsonObjectBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (parseQuizAnswer(ctx, root)) {
                                case None => return
                                case Some(req) =>
                                    /* Python: missing or type!=quiz -> 404 "Quiz not found". */
                                    match (loadQuizRow(ctx, cfg, userId, resourceId)) {
                                        case None => return
                                        case Some(row) =>
                                            match (gradeQuizAnswer(row, req, JsonArray())) {
                                                case GradeResult.Missing =>
                                                    writeDetail(ctx.response, 404, "Quiz not found")
                                                case GradeResult.AlreadyAnswered =>
                                                    writeDetail(ctx.response, 409, "Question is missing or already answered")
                                                case GradeResult.Ok(g) =>
                                                    /* grade endpoint: feedback only, no writes. */
                                                    writeJson(ctx.response, 200, g.feedbackJson)
                                            }
                                    }
                            }
                    }
            }
    }
}

func handleAnswerQuestion(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "resource_id")) {
                case None => return
                case Some(resourceId) =>
                    match (readJsonObjectBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (parseQuizAnswer(ctx, root)) {
                                case None => return
                                case Some(req) =>
                                    if (storageUnavailable(cfg)) {
                                        writeDetail(ctx.response, 503, "Learning resource storage is unavailable")
                                        return
                                    }
                                    match (openDb(cfg)) {
                                        case None =>
                                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                        case Some(conn) =>
                                            try {
                                                answerWithConn(ctx, conn, userId, resourceId, req)
                                            } catch (e: Exception) {
                                                conn.close()
                                                writeInternalDebug(ctx.response, "answer: " + e.message)
                                            }
                                    }
                            }
                    }
            }
    }
}

private func answerWithConn(ctx: HttpContext, conn: MyConnection,
                            userId: Array<Byte>, resourceId: Array<Byte>, req: QuizAnswerReq): Unit {
    let store = ResourcesStore(conn)
    match (store.get(userId, resourceId)) {
        case None =>
            conn.close()
            writeDetail(ctx.response, 404, "Quiz not found")
            return
        case Some(row) =>
            let adaptiveTaskId = adaptiveTaskIdOf(row)
            let adaptivePool = match (adaptiveTaskId) {
                case Some(tid) =>
                    match (uuidParse(tid)) {
                        case Some(taskBytes) => loadAdaptivePool(conn, userId, taskBytes)
                        case None => JsonArray()
                    }
                case None => JsonArray()
            }
            match (gradeQuizAnswer(row, req, adaptivePool)) {
                case GradeResult.Missing =>
                    conn.close()
                    writeDetail(ctx.response, 404, "Quiz not found")
                    return
                case GradeResult.AlreadyAnswered =>
                    conn.close()
                    writeDetail(ctx.response, 409, "Question is missing or already answered")
                    return
                case GradeResult.Ok(g) =>
                    /* Incorrect answers land in learning_wrong_answers (Python record()). */
                    var wrongRow: ?String = None
                    if (!g.correct) {
                        try {
                            wrongRow = WrongAnswersStore(conn).record(
                                userId, Some(resourceId),
                                g.questionId, g.stem, g.options,
                                g.userAnswer, g.correctAnswer,
                                g.explanation, g.difficulty,
                                g.learnerId, Some(g.kpId), "quiz",
                                g.kbRefs, g.citations,
                                g.categoryId, g.categoryName)
                        } catch (_: Exception) {
                            /* enrichment only */
                        }
                    }

                    /* Persist state / adaptive content exactly like LearningContentService + public.py. */
                    var nextQuestion: ?String = None
                    var effectiveContent: ?String = None
                    if (g.adaptive) {
                        if (g.adaptiveFinal) {
                            store.replaceContentAndState(userId, resourceId, g.contentJson, g.newStateJson)
                            effectiveContent = Some(g.contentJson)
                        } else {
                            match (g.nextContentJson) {
                                case Some(contentJson) =>
                                    store.replaceContentAndState(userId, resourceId, contentJson, g.newStateJson)
                                    nextQuestion = g.nextQuestionJson
                                    effectiveContent = Some(contentJson)
                                case None =>
                                    store.updateState(userId, resourceId, g.newStateJson)
                            }
                        }
                    } else {
                        store.updateState(userId, resourceId, g.newStateJson)
                    }
                    /* 同步生成任务：否则定制页会一直停在「定制中 / 第 1/5 题」。
                       与 Python _refresh_adaptive_task_after_answer 对齐。 */
                    match (adaptiveTaskId) {
                        case Some(tid) =>
                            match (uuidParse(tid)) {
                                case Some(taskBytes) =>
                                    match (effectiveContent) {
                                        case Some(contentJson) =>
                                            refreshAdaptiveTask(
                                                conn, userId, taskBytes,
                                                answeredCountFromState(g.newStateJson),
                                                adaptiveTotalQuestions(row),
                                                g.adaptiveFinal, contentJson,
                                            )
                                        case None => ()
                                    }
                                case None => ()
                            }
                        case None => ()
                    }
                    /* Python falls back to the in-memory state when the store write returns None. */
                    conn.close()
                    finishAnswerResponse(ctx, g, g.newStateJson, nextQuestion, wrongRow)
            }
    }
}

private func finishAnswerResponse(ctx: HttpContext, g: GradedAnswer, stateJson: String,
                                  nextQuestion: ?String, wrongRow: ?String): Unit {
    let obj = JsonWriter()
    /* Spread feedback keys first (correct / correctIndex / explanation / ability / mastery / completed). */
    match (jsonParse(g.feedbackJson)) {
        case Some(v) =>
            if (isJsObject(v)) {
                for ((k, vv) in v.asObject().getFields()) {
                    obj.putRaw(k, valueToRaw(vv))
                }
            }
        case None => ()
    }
    obj.putRaw("knowledgePoint", g.pointJson)
    match (wrongRow) {
        case Some(row) => obj.putRaw("wrongAnswer", row)
        case None => obj.putRaw("wrongAnswer", "null")
    }
    obj.putRaw("state", stateJson)
    obj.putFloat("masteryDelta", g.masteryDelta)
    obj.putFloat("confidence", g.confidence)
    obj.putRaw("decision", g.decisionJson)
    obj.putBool("adaptive", g.adaptive)
    obj.putBool("adaptiveFinal", g.adaptiveFinal)
    match (nextQuestion) {
        case Some(q) => obj.putRaw("nextQuestion", q)
        case None => obj.putRaw("nextQuestion", "null")
    }
    writeJson(ctx.response, 200, obj.toJson())
}

/* Shared GET-or-404. `notFound` is the Python detail string for this route. */
private func loadResourceWith(ctx: HttpContext, cfg: AppConfig,
                              userId: Array<Byte>, resourceId: Array<Byte>,
                              notFound: String): ?String {
    if (storageUnavailable(cfg)) {
        writeDetail(ctx.response, 503, "Learning resource storage is unavailable")
        return None
    }
    match (openDb(cfg)) {
        case None =>
            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
            return None
        case Some(conn) =>
            try {
                let item = ResourcesStore(conn).get(userId, resourceId)
                conn.close()
                match (item) {
                    case Some(row) => return Some(row)
                    case None =>
                        writeDetail(ctx.response, 404, notFound)
                        return None
                }
            } catch (e: Exception) {
                conn.close()
                writeInternalDebug(ctx.response, "loadResource: " + e.message)
                return None
            }
    }
}

private func loadResource(ctx: HttpContext, cfg: AppConfig,
                          userId: Array<Byte>, resourceId: Array<Byte>): ?String {
    loadResourceWith(ctx, cfg, userId, resourceId, "Learning resource not found")
}

private func loadQuizRow(ctx: HttpContext, cfg: AppConfig,
                         userId: Array<Byte>, resourceId: Array<Byte>): ?String {
    loadResourceWith(ctx, cfg, userId, resourceId, "Quiz not found")
}

/* -------- grading (LearningContentService.answer) -------- */

private enum GradeResult {
    Missing | AlreadyAnswered | Ok(GradedAnswer)
}

private struct GradedAnswer {
    public let feedbackJson: String
    public let newStateJson: String
    public let contentJson: String
    public let nextContentJson: ?String
    public let nextQuestionJson: ?String
    public let pointJson: String
    public let wrongAnswerJson: String
    public let masteryDelta: Float64
    public let confidence: Float64
    public let decisionJson: String
    public let adaptive: Bool
    public let adaptiveFinal: Bool
    public let correct: Bool
    /* inputs for WrongAnswersStore.record */
    public let questionId: String
    public let stem: String
    public let options: Array<String>
    public let userAnswer: Int64
    public let correctAnswer: Int64
    public let explanation: String
    public let difficulty: String
    public let learnerId: ?Array<Byte>
    public let kpId: String
    public let kbRefs: Array<String>
    public let citations: Array<String>
    public let categoryId: ?Int64
    public let categoryName: ?String

    public init(feedbackJson: String, newStateJson: String, contentJson: String,
                nextContentJson: ?String, nextQuestionJson: ?String,
                pointJson: String, wrongAnswerJson: String,
                masteryDelta: Float64, confidence: Float64, decisionJson: String,
                adaptive: Bool, adaptiveFinal: Bool, correct: Bool,
                questionId: String, stem: String, options: Array<String>,
                userAnswer: Int64, correctAnswer: Int64, explanation: String,
                difficulty: String, learnerId: ?Array<Byte>, kpId: String,
                kbRefs: Array<String>, citations: Array<String>,
                categoryId: ?Int64, categoryName: ?String) {
        this.feedbackJson = feedbackJson
        this.newStateJson = newStateJson
        this.contentJson = contentJson
        this.nextContentJson = nextContentJson
        this.nextQuestionJson = nextQuestionJson
        this.pointJson = pointJson
        this.wrongAnswerJson = wrongAnswerJson
        this.masteryDelta = masteryDelta
        this.confidence = confidence
        this.decisionJson = decisionJson
        this.adaptive = adaptive
        this.adaptiveFinal = adaptiveFinal
        this.correct = correct
        this.questionId = questionId
        this.stem = stem
        this.options = options
        this.userAnswer = userAnswer
        this.correctAnswer = correctAnswer
        this.explanation = explanation
        this.difficulty = difficulty
        this.learnerId = learnerId
        this.kpId = kpId
        this.kbRefs = kbRefs
        this.citations = citations
        this.categoryId = categoryId
        this.categoryName = categoryName
    }
}

/*
 * Port of LearningContentService.answer plus the adaptive next-question step.
 * Pure: no DB access. The caller owns persistence and wrong-answer writes.
 * adaptivePool: 任务 checkpoint 里保存的完整题库快照；为空时退回 content.questions。
 */
private func gradeQuizAnswer(resourceJson: String, req: QuizAnswerReq,
                             adaptivePool: JsonArray): GradeResult {
    let resource = parseObject(resourceJson)
    if ((jsonGetString(resource, "type") ?? "") != "quiz") {
        return GradeResult.Missing
    }
    let content = match (jsonGetObject(resource, "content")) {
        case Some(c) => c
        case None => emptyObject()
    }
    let state = match (jsonGetObject(resource, "state")) {
        case Some(s) => s
        case None => emptyObject()
    }
    let questions = match (jsonGetArray(content, "questions")) {
        case Some(a) => a
        case None => return GradeResult.Missing
    }

    var question: ?JsonObject = None
    var qi: Int64 = 0
    while (qi < questions.size()) {
        match (questions.get(qi)) {
            case Some(q) =>
                if (isJsObject(q) &&
                    (jsonGetString(q.asObject(), "id") ?? "") == req.questionId) {
                    question = Some(q.asObject())
                }
            case None => ()
        }
        qi += 1
    }
    match (question) {
        case None => return GradeResult.AlreadyAnswered
        case Some(_) => ()
    }
    match (jsonGetArray(state, "answered")) {
        case Some(answered) =>
            var ai: Int64 = 0
            while (ai < answered.size()) {
                match (answered.get(ai)) {
                    case Some(item) =>
                        if (isJsObject(item) &&
                            (jsonGetString(item.asObject(), "questionId") ?? "") == req.questionId) {
                            return GradeResult.AlreadyAnswered
                        }
                    case None => ()
                }
                ai += 1
            }
        case None => ()
    }

    let q = match (question) {
        case Some(x) => x
        case None => return GradeResult.AlreadyAnswered
    }

    /* selected = int(answer) else match option text else -1 */
    let asInt = Int64.tryParse(req.answer)
    var selected: Int64 = -1
    match (asInt) {
        case Some(n) => selected = n
        case None =>
            let optionsArr = match (jsonGetArray(q, "options")) {
                case Some(a) => a
                case None => JsonArray()
            }
            var oi: Int64 = 0
            while (oi < optionsArr.size()) {
                match (optionsArr.get(oi)) {
                    case Some(opt) =>
                        if (isJsString(opt) &&
                            opt.asString().getValue().trimAscii() == req.answer.trimAscii()) {
                            selected = oi
                        }
                    case None => ()
                }
                oi += 1
            }
    }
    let correctIndex = jsonGetInt(q, "correctIndex") ?? -1
    let correct = selected == correctIndex

    /* Python: {"easy": .08, "medium": .12, "hard": .16}[question["difficulty"]] */
    let difficulty = jsonGetString(q, "difficulty") ?? "medium"
    var weight = 0.12
    if (difficulty == "easy") {
        weight = 0.08
    } else if (difficulty == "hard") {
        weight = 0.16
    }
    /* Python: .02 if duration and duration < 45 else -.02 if duration > 180 else 0 */
    var speed = 0.0
    if (req.durationSeconds > 0 && req.durationSeconds < 45) {
        speed = 0.02
    } else if (req.durationSeconds > 180) {
        speed = -0.02
    }
    let abilityPrev = jsonGetFloat(state, "ability") ?? 0.35
    var ability = abilityPrev + (if (correct) { weight + speed } else { -weight })
    if (ability < 0.05) {
        ability = 0.05
    }
    if (ability > 0.95) {
        ability = 0.95
    }
    ability = round4(ability)

    let kp = jsonGetString(q, "knowledgePointId") ?? ""
    var prevMastery = 0.35
    match (jsonGetObject(state, "mastery")) {
        case Some(m) => prevMastery = jsonGetFloat(m, kp) ?? 0.35
        case None => ()
    }
    let newMastery = round4(0.7 * prevMastery + 0.3 * (if (correct) { 1.0 } else { 0.0 }))

    /* answered[] append */
    let answeredRaw = ArrayList<String>()
    match (jsonGetArray(state, "answered")) {
        case Some(old) =>
            var i: Int64 = 0
            while (i < old.size()) {
                match (old.get(i)) {
                    case Some(item) => answeredRaw.add(valueToRaw(item))
                    case None => ()
                }
                i += 1
            }
        case None => ()
    }
    let ans = JsonWriter()
    ans.putStr("questionId", req.questionId)
    ans.putStr("knowledgePointId", kp)
    ans.putStr("difficulty", difficulty)
    ans.putBool("correct", correct)
    ans.putInt("selectedIndex", selected)
    ans.putInt("durationSeconds", req.durationSeconds)
    answeredRaw.add(ans.toJson())

    let completed = answeredRaw.size >= questions.size()
    let learnedAt = if (completed) { isoDatetime(nowUtcParts()) } else { "" }

    /* mastery[kp] updated, other keys kept */
    let masteryW = JsonWriter()
    match (jsonGetObject(state, "mastery")) {
        case Some(prev) =>
            for ((k, v) in prev.getFields()) {
                if (k != kp) {
                    masteryW.putRaw(k, valueToRaw(v))
                }
            }
        case None => ()
    }
    masteryW.putRaw(kp, jsonFloatText(newMastery))

    /* Build new state: keep unknown keys, overwrite the ones answer() owns. */
    let stateW = JsonWriter()
    for ((k, v) in state.getFields()) {
        if (k != "ability" && k != "mastery" && k != "answered" &&
            k != "completed" && k != "learned" && k != "learnedAt") {
            stateW.putRaw(k, valueToRaw(v))
        }
    }
    stateW.putFloat("ability", ability)
    stateW.putRaw("mastery", masteryW.toJson())
    stateW.putRaw("answered", strArrayJson(answeredRaw))
    stateW.putBool("completed", completed)
    if (completed) {
        stateW.putBool("learned", true)
        stateW.putStr("learnedAt", learnedAt)
    } else {
        if (jsonHas(state, "learned")) {
            match (state.get("learned")) {
                case Some(v) => stateW.putRaw("learned", valueToRaw(v))
                case None => ()
            }
        }
        if (jsonHas(state, "learnedAt") && !jsonIsNull(state, "learnedAt")) {
            match (state.get("learnedAt")) {
                case Some(v) => stateW.putRaw("learnedAt", valueToRaw(v))
                case None => ()
            }
        }
    }
    let newStateJson = stateW.toJson()

    /* knowledgePoints lookup (empty object when missing, like Python {}) */
    var pointJson = "{}"
    match (jsonGetArray(content, "knowledgePoints")) {
        case Some(pts) =>
            var pi: Int64 = 0
            while (pi < pts.size()) {
                match (pts.get(pi)) {
                    case Some(p) =>
                        if (isJsObject(p) &&
                            (jsonGetString(p.asObject(), "id") ?? "") == kp) {
                            pointJson = jsonObjectToRaw(p.asObject())
                        }
                    case None => ()
                }
                pi += 1
            }
        case None => ()
    }
    let point = parseObject(pointJson)

    /* Wrong-answer row shape (only used when incorrect). */
    let pointKp = jsonGetString(point, "kpId") ?? jsonGetString(point, "id") ?? kp
    var categoryId: ?Int64 = None
    match (jsonGetInt(point, "categoryId")) {
        case Some(id) =>
            if (id > 0) {
                categoryId = Some(id)
            }
        case None => ()
    }
    let categoryName = firstString(point, "categoryName", "name")
    var learnerId: ?Array<Byte> = None
    match (jsonGetString(resource, "learnerId")) {
        case Some(t) => learnerId = uuidParse(t)
        case None => ()
    }
    let stem = jsonGetString(q, "stem") ?? ""
    let explanation = jsonGetString(q, "explanation") ?? ""
    let options = stringArrayFromJson(q, "options")
    let citations = stringArrayFromJson(q, "citations")
    let kbRefs = stringArrayFromJson(resource, "kbRefs")
    /* Python uses int(request.answer) and 500s on option text; use selected instead. */
    let userAnswer = selected

    /* masteryDelta / confidence / decision */
    let masteryDelta = roundTo((newMastery - prevMastery) * 100.0, 1)
    var confidence = 40.0 + floatFromInt(answeredRaw.size) * 4.0
    if (confidence > 95.0) {
        confidence = 95.0
    }
    let decision = JsonWriter()
    decision.putStr("type", "writeback")
    decision.putStr("title", "答题回写")
    decision.putStr("detail", "ARB-05 根据本轮作答更新知识点掌握度")
    let deltas = JsonArrWriter()
    let d = JsonWriter()
    d.putStr("kpId", kp)
    d.putFloat("from", roundTo(prevMastery * 100.0, 1))
    d.putFloat("to", roundTo(newMastery * 100.0, 1))
    deltas.addRaw(d.toJson())
    decision.putRaw("deltas", deltas.toJson())

    let feedback = JsonWriter()
    feedback.putBool("correct", correct)
    feedback.putInt("correctIndex", correctIndex)
    feedback.putStr("explanation", explanation)
    feedback.putFloat("ability", ability)
    feedback.putRaw("mastery", masteryW.toJson())
    feedback.putBool("completed", completed)

    /* Adaptive path */
    let adaptiveMeta: JsonObject = match (jsonGetObject(content, "adaptiveQuiz")) {
        case Some(a) => a
        case None =>
            match (jsonGetObject(resource, "context")) {
                case Some(ctxObj) =>
                    match (jsonGetObject(ctxObj, "adaptiveQuiz")) {
                        case Some(a) => a
                        case None => emptyObject()
                    }
                case None => emptyObject()
            }
    }
    let adaptive = jsonGetBool(adaptiveMeta, "adaptive") ?? false
    var adaptiveFinal = false
    var nextContentJson: ?String = None
    var nextQuestionJson: ?String = None
    let contentJson = jsonObjectToRaw(content)
    var stateOut = newStateJson

    if (adaptive) {
        let answeredCount = answeredRaw.size
        let totalQuestions = jsonGetInt(adaptiveMeta, "totalQuestions") ?? 5
        adaptiveFinal = answeredCount >= totalQuestions
        if (!adaptiveFinal) {
            /* Force in-progress flags; learnedAt is dropped. */
            let sw = JsonWriter()
            match (jsonParse(newStateJson)) {
                case Some(sv) =>
                    if (isJsObject(sv)) {
                        for ((k, v) in sv.asObject().getFields()) {
                            if (k != "completed" && k != "learned" && k != "learnedAt") {
                                sw.putRaw(k, valueToRaw(v))
                            }
                        }
                    }
                case None => ()
            }
            sw.putBool("completed", false)
            sw.putBool("learned", false)
            stateOut = sw.toJson()
        }

        /* 自适应题必须用任务 checkpoint 保存的完整题池；
           只用 content.questions 时答完第 1 题就无题可出，任务会永远停在「第 1/5 题」。 */
        let pool = if (adaptivePool.size() > 0) {
            adaptivePool
        } else {
            match (jsonGetArray(content, "questions")) {
                case Some(a) => a
                case None => JsonArray()
            }
        }
        if (!adaptiveFinal) {
            let currentDiff = jsonGetString(adaptiveMeta, "currentDifficulty") ??
                jsonGetString(adaptiveMeta, "initialDifficulty") ?? "medium"
            let nextDiff = adaptiveNextDifficulty(stateOut, currentDiff)
            let used = answeredIdSetFromState(stateOut)
            /* 已经生成到资源里的题也不能再追加，避免重复出题。 */
            let existing = match (jsonGetArray(content, "questions")) {
                case Some(a) => a
                case None => JsonArray()
            }
            var ei: Int64 = 0
            while (ei < existing.size()) {
                match (existing.get(ei)) {
                    case Some(item) =>
                        if (isJsObject(item)) {
                            used.add(jsonGetString(item.asObject(), "id") ?? "")
                        }
                    case None => ()
                }
                ei += 1
            }
            match (pickAdaptiveQuestion(pool, nextDiff, used)) {
                case Some(nxt) =>
                    nextQuestionJson = Some(publicQuestionJson(nxt))
                    nextContentJson = Some(buildAdaptiveContent(content, adaptiveMeta, nxt, nextDiff))
                case None => ()
            }
        }
    }

    return GradeResult.Ok(GradedAnswer(
        feedback.toJson(), stateOut, contentJson, nextContentJson, nextQuestionJson,
        pointJson, "null", masteryDelta, confidence, decision.toJson(),
        adaptive, adaptiveFinal, correct,
        req.questionId, stem, options, userAnswer, correctIndex,
        explanation, difficulty, learnerId, pointKp, kbRefs, citations,
        categoryId, categoryName))
}

/*
 * content' = deepcopy(content) with adaptiveQuiz refreshed and nxt appended.
 * Matches public.py: content["questions"] = list(content["questions"]) + [nxt]
 */
private func buildAdaptiveContent(content: JsonObject, adaptiveMeta: JsonObject,
                                  nxt: JsonValue, nextDiff: String): String {
    let w = JsonWriter()
    for ((k, v) in content.getFields()) {
        if (k != "questions" && k != "adaptiveQuiz") {
            w.putRaw(k, valueToRaw(v))
        }
    }
    let qs = JsonArrWriter()
    var count: Int64 = 0
    match (jsonGetArray(content, "questions")) {
        case Some(old) =>
            count = old.size()
            var i: Int64 = 0
            while (i < old.size()) {
                match (old.get(i)) {
                    case Some(item) => qs.addRaw(valueToRaw(item))
                    case None => ()
                }
                i += 1
            }
        case None => ()
    }
    qs.addRaw(valueToRaw(nxt))
    w.putRaw("questions", qs.toJson())
    /* adaptiveQuiz = deepcopy(adaptive_meta) with currentDifficulty / currentIndex */
    let aq = JsonWriter()
    for ((k, v) in adaptiveMeta.getFields()) {
        if (k != "currentDifficulty" && k != "currentIndex") {
            aq.putRaw(k, valueToRaw(v))
        }
    }
    aq.putStr("currentDifficulty", nextDiff)
    aq.putInt("currentIndex", count + 1)
    w.putRaw("adaptiveQuiz", aq.toJson())
    return w.toJson()
}

/* -------- adaptive helpers -------- */

private func adaptiveRank(label: String): Int64 {
    let d = label.toAsciiLower()
    if (d == "easy") {
        return 0
    }
    if (d == "hard") {
        return 2
    }
    return 1
}

private func adaptiveLabel(item: JsonObject): String {
    let raw = (jsonGetString(item, "difficulty") ??
        jsonGetString(item, "level") ??
        jsonGetString(item, "difficultyLevel") ?? "medium").toAsciiLower().trimAscii()
    if (raw == "easy" || raw == "基础" || raw == "basic" || raw == "1" || raw == "2") {
        return "easy"
    }
    if (raw == "hard" || raw == "挑战" || raw == "综合" || raw == "advanced" || raw == "5") {
        return "hard"
    }
    return "medium"
}

private func adaptiveNextDifficulty(stateJson: String, current: String): String {
    let cur = if (current.isEmpty()) { "medium" } else { current }
    let state = parseObject(stateJson)
    let answered = match (jsonGetArray(state, "answered")) {
        case Some(a) => a
        case None => return cur
    }
    if (answered.size() == 0) {
        return cur
    }
    var rank = adaptiveRank(cur)
    let start = if (answered.size() >= 2) { answered.size() - 2 } else { 0 }
    var allCorrect = true
    var anyCorrect = false
    var recentCount: Int64 = 0
    var i = start
    while (i < answered.size()) {
        match (answered.get(i)) {
            case Some(item) =>
                if (isJsObject(item)) {
                    recentCount += 1
                    let ok = jsonGetBool(item.asObject(), "correct") ?? false
                    if (ok) {
                        anyCorrect = true
                    } else {
                        allCorrect = false
                    }
                }
            case None => ()
        }
        i += 1
    }
    if (recentCount >= 2 && allCorrect) {
        rank += 1
    } else if (recentCount >= 2 && !anyCorrect) {
        rank -= 1
    } else if (recentCount == 1 && !anyCorrect) {
        rank -= 1
    }
    if (rank < 0) {
        rank = 0
    }
    if (rank > 2) {
        rank = 2
    }
    if (rank == 0) {
        return "easy"
    }
    if (rank == 2) {
        return "hard"
    }
    return "medium"
}

private func answeredIdSetFromState(stateJson: String): HashSet<String> {
    let used = HashSet<String>()
    let state = parseObject(stateJson)
    match (jsonGetArray(state, "answered")) {
        case Some(answered) =>
            var i: Int64 = 0
            while (i < answered.size()) {
                match (answered.get(i)) {
                    case Some(item) =>
                        if (isJsObject(item)) {
                            used.add(jsonGetString(item.asObject(), "questionId") ?? "")
                        }
                    case None => ()
                }
                i += 1
            }
        case None => ()
    }
    return used
}

private func pickAdaptiveQuestion(pool: JsonArray, target: String, used: HashSet<String>): ?JsonValue {
    let targetRank = adaptiveRank(target)
    var best: ?JsonValue = None
    var bestDist: Int64 = 99
    var i: Int64 = 0
    while (i < pool.size()) {
        match (pool.get(i)) {
            case Some(item) =>
                if (isJsObject(item)) {
                    let obj = item.asObject()
                    let id = jsonGetString(obj, "id") ?? ""
                    if (!used.contains(id)) {
                        var dist = adaptiveRank(adaptiveLabel(obj)) - targetRank
                        if (dist < 0) {
                            dist = -dist
                        }
                        if (dist < bestDist) {
                            bestDist = dist
                            best = Some(item)
                        }
                    }
                }
            case None => ()
        }
        i += 1
    }
    return best
}

/** 读取自适应分阶任务 checkpoint 里保存的完整题池（任务创建时写入的管理员题库快照）。 */
private func loadAdaptivePool(conn: MyConnection, userId: Array<Byte>, taskId: Array<Byte>): JsonArray {
    let sql = "SELECT checkpoint_json FROM learning_resource_generation_tasks" +
        " WHERE id=" + sqlBinary(taskId) + " AND user_id=" + sqlBinary(userId)
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return JsonArray()
        case QueryOutcome.ResultSet(rs) =>
            if (rs.rows.isEmpty()) {
                return JsonArray()
            }
            match (jsonParse(cellText(rs.rows[0], 0))) {
                case Some(v) =>
                    if (!isJsObject(v)) {
                        return JsonArray()
                    }
                    return jsonGetArray(v.asObject(), "questions") ?? JsonArray()
                case None => return JsonArray()
            }
    }
}

/** 从资源 JSON 的 content.adaptiveQuiz 中取字段。 */
private func adaptiveMetaOf(resourceJson: String): ?JsonObject {
    let resource = parseObject(resourceJson)
    let content = match (jsonGetObject(resource, "content")) {
        case Some(c) => c
        case None => return None
    }
    return jsonGetObject(content, "adaptiveQuiz")
}

private func adaptiveTaskIdOf(resourceJson: String): ?String {
    return match (adaptiveMetaOf(resourceJson)) {
        case Some(meta) => jsonGetString(meta, "taskId")
        case None => None
    }
}

private func adaptiveTotalQuestions(resourceJson: String): Int64 {
    return match (adaptiveMetaOf(resourceJson)) {
        case Some(meta) => jsonGetInt(meta, "totalQuestions") ?? 5
        case None => 5
    }
}

private func answeredCountFromState(stateJson: String): Int64 {
    let state = parseObject(stateJson)
    return match (jsonGetArray(state, "answered")) {
        case Some(a) => a.size()
        case None => 0
    }
}

/** 把当前题组重建为任务卡片列表（与 Python _adaptive_quiz_slides 对齐）。 */
private func adaptiveSlidesJson(contentJson: String, totalQuestions: Int64): String {
    let content = parseObject(contentJson)
    let questions = match (jsonGetArray(content, "questions")) {
        case Some(a) => a
        case None => JsonArray()
    }
    let total = if (questions.size() > totalQuestions) { questions.size() } else { totalQuestions }
    let arr = JsonArrWriter()
    var i: Int64 = 0
    while (i < questions.size()) {
        match (questions.get(i)) {
            case Some(q) =>
                let w = JsonWriter()
                w.putInt("index", i)
                w.putInt("unitIndex", i)
                w.putInt("totalUnits", total)
                w.putStr("type", "question")
                w.putStr("title", "第 " + (i + 1).toString() + " 题")
                w.putRaw("content", valueToRaw(q))
                w.putRaw("sources", "[]")
                w.putRaw("evidenceQuotes", "[]")
                arr.addRaw(w.toJson())
            case None => ()
        }
        i += 1
    }
    return arr.toJson()
}

/** 作答后推进生成任务：状态/进度/阶段/卡片，避免定制页永远停在「定制中」。 */
private func refreshAdaptiveTask(conn: MyConnection, userId: Array<Byte>, taskId: Array<Byte>,
                                 answeredCount: Int64, totalQuestions: Int64,
                                 final: Bool, contentJson: String): Unit {
    let total = if (totalQuestions > 0) { totalQuestions } else { 5 }
    let status = if (final) { "completed" } else { "generating" }
    var progress: Int64 = 100
    if (!final) {
        let pct = answeredCount * 100 / total
        progress = if (pct < 25) { 25 } else if (pct > 95) { 95 } else { pct }
    }
    let stage = if (final) {
        "自适应分阶已完成"
    } else {
        "第 " + (answeredCount + 1).toString() + "/" + total.toString() + " 题"
    }
    let now = mysqlDatetime(nowUtcParts())
    let sql = "UPDATE learning_resource_generation_tasks SET status=" + sqlQuote(status) +
        ",progress=" + progress.toString() +
        ",stage_message=" + sqlQuote(stage) +
        ",slides_json=" + sqlQuote(adaptiveSlidesJson(contentJson, total)) +
        ",updated_at=" + sqlQuote(now) +
        " WHERE id=" + sqlBinary(taskId) + " AND user_id=" + sqlBinary(userId)
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => ()
        case QueryOutcome.ResultSet(_) => ()
    }
}

private func publicQuestionJson(q: JsonValue): String {
    if (!isJsObject(q)) {
        return "{}"
    }
    let w = JsonWriter()
    for ((k, v) in q.asObject().getFields()) {
        if (k != "correctIndex" && k != "explanation") {
            w.putRaw(k, valueToRaw(v))
        }
    }
    return w.toJson()
}

/* -------- traceability (_build_traceability) -------- */

private func buildTraceability(resourceJson: String): String {
    let resource = parseObject(resourceJson)
    let sources = match (jsonGetArray(resource, "sources")) {
        case Some(a) => a
        case None => JsonArray()
    }
    let content = match (jsonGetObject(resource, "content")) {
        case Some(c) => c
        case None => emptyObject()
    }

    let sourceById = HashMap<Int64, JsonObject>()
    var si: Int64 = 0
    while (si < sources.size()) {
        match (sources.get(si)) {
            case Some(s) =>
                if (isJsObject(s)) {
                    let obj = s.asObject()
                    match (jsonGetInt(obj, "id")) {
                        case Some(id) => sourceById.add(id, obj)
                        case None => ()
                    }
                }
            case None => ()
        }
        si += 1
    }

    let positions = HashMap<Int64, ArrayList<String>>()
    let chapters = match (jsonGetArray(content, "chapters")) {
        case Some(a) => a
        case None => JsonArray()
    }
    var ci: Int64 = 0
    while (ci < chapters.size()) {
        match (chapters.get(ci)) {
            case Some(ch) =>
                if (isJsObject(ch)) {
                    let chap = ch.asObject()
                    let label = jsonGetString(chap, "title") ?? "章节"
                    match (jsonGetArray(chap, "sections")) {
                        case Some(secs) => collectCitations(secs, label, positions)
                        case None => ()
                    }
                }
            case None => ()
        }
        ci += 1
    }
    match (jsonGetArray(content, "sections")) {
        case Some(a) => collectCitations(a, "讲义", positions)
        case None => ()
    }
    match (jsonGetArray(content, "steps")) {
        case Some(a) => collectCitations(a, "实操指南", positions)
        case None => ()
    }
    match (jsonGetArray(content, "questions")) {
        case Some(a) => collectCitations(a, "分阶题", positions)
        case None => ()
    }

    let items = JsonArrWriter()
    for ((citationId, titles) in positions) {
        match (sourceById.get(citationId)) {
            case None => ()
            case Some(source) =>
                let similarity = jsonGetFloat(source, "similarity") ?? 0.8
                var clamped = similarity
                if (clamped < 0.0) {
                    clamped = 0.0
                }
                if (clamped > 1.0) {
                    clamped = 1.0
                }
                let credibility = roundTo(clamped * 100.0, 0)
                let sourceId = jsonGetInt(source, "id") ?? citationId
                let item = JsonWriter()
                item.putStr("id", sourceId.toString())
                item.putStr("kbId", kbId(citationId))
                item.putStr("title", jsonGetString(source, "document") ?? "知识库来源")
                item.putStr("type", jsonGetString(source, "type") ??
                    jsonGetString(source, "document_type") ?? "知识库")
                match (jsonGetString(source, "url")) {
                    case Some(u) => item.putStr("url", u)
                    case None => item.putRaw("url", "null")
                }
                item.putInt("credibility", truncateFloat(credibility))
                let excerpt = jsonGetString(source, "content") ?? ""
                item.putStr("excerpt", excerptSlice(excerpt, 240))
                /* unique titles, first 20 */
                let seen = HashSet<String>()
                let posArr = JsonArrWriter()
                var count: Int64 = 0
                var ti: Int64 = 0
                let titleArr = titles.toArray()
                while (ti < titleArr.size && count < 20) {
                    let t = titleArr[ti]
                    if (!seen.contains(t)) {
                        seen.add(t)
                        posArr.addRaw(jsonQuote(t))
                        count += 1
                    }
                    ti += 1
                }
                item.putRaw("positions", posArr.toJson())
                items.addRaw(item.toJson())
        }
    }
    return items.toJson()
}

private func kbId(citationId: Int64): String {
    if (citationId < 0) {
        return "KB-" + citationId.toString()
    }
    if (citationId < 10) {
        return "KB-00" + citationId.toString()
    }
    if (citationId < 100) {
        return "KB-0" + citationId.toString()
    }
    return "KB-" + citationId.toString()
}

private func collectCitations(items: JsonArray, label: String,
                              positions: HashMap<Int64, ArrayList<String>>): Unit {
    var i: Int64 = 0
    while (i < items.size()) {
        match (items.get(i)) {
            case Some(item) =>
                if (isJsObject(item)) {
                    let obj = item.asObject()
                    match (jsonGetArray(obj, "citations")) {
                        case Some(cites) =>
                            let title = jsonGetString(obj, "title") ??
                                jsonGetString(obj, "stem") ?? label
                            var c: Int64 = 0
                            while (c < cites.size()) {
                                match (cites.get(c)) {
                                    case Some(cv) =>
                                        match (citationIdOf(cv)) {
                                            case None => ()
                                            case Some(id) =>
                                                match (positions.get(id)) {
                                                    case Some(list) => list.add(title)
                                                    case None =>
                                                        let list = ArrayList<String>()
                                                        list.add(title)
                                                        positions.add(id, list)
                                                }
                                        }
                                    case None => ()
                                }
                                c += 1
                            }
                        case None => ()
                    }
                }
            case None => ()
        }
        i += 1
    }
}

private func citationIdOf(v: JsonValue): ?Int64 {
    match (v.kind()) {
        case JsonKind.JsInt => return Some(v.asInt().getValue())
        case JsonKind.JsString => return Int64.tryParse(v.asString().getValue())
        case _ => return None
    }
}

/* -------- request parsing -------- */

private struct QuizAnswerReq {
    public let questionId: String
    public let answer: String
    public let durationSeconds: Int64

    public init(questionId: String, answer: String, durationSeconds: Int64) {
        this.questionId = questionId
        this.answer = answer
        this.durationSeconds = durationSeconds
    }
}

private struct SourceFeedbackReq {
    public let sourceId: String
    public let issueType: String
    public let note: ?String

    public init(sourceId: String, issueType: String, note: ?String) {
        this.sourceId = sourceId
        this.issueType = issueType
        this.note = note
    }
}

/*
 * QuizAnswerRequest (models.py:378). Declaration order:
 *   question_id, answer, duration_seconds
 * Measured {} -> two `missing` items in that order; `missing` locs use the
 * PYTHON field names (question_id / answer / duration_seconds) while value
 * errors echo the key as present (questionId / durationSeconds).
 */
private func parseQuizAnswer(ctx: HttpContext, root: JsonObject): ?QuizAnswerReq {
    let bag = PyBag()
    let parentRaw = jsonObjectToRaw(root)

    /* question_id: str = Field(min_length=1, max_length=80) */
    var questionId = ""
    match (pyField(root, "question_id", "questionId")) {
        case None => bag.add(pyMissing(["body", "question_id"], parentRaw))
        case Some(f) =>
            match (pyStr(bag, f, 1, 80)) {
                case Some(s) => questionId = s
                case None => ()
            }
    }
    /* answer: str = Field(min_length=1, max_length=4000) */
    var answer = ""
    match (pyField(root, "answer", "answer")) {
        case None => bag.add(pyMissing(["body", "answer"], parentRaw))
        case Some(f) =>
            match (pyStr(bag, f, 1, 4000)) {
                case Some(s) => answer = s
                case None => ()
            }
    }
    /* duration_seconds: int = Field(default=0, ge=0, le=7200) */
    var duration: Int64 = 0
    match (pyField(root, "duration_seconds", "durationSeconds")) {
        case None => ()
        case Some(f) =>
            match (pyInt(bag, f, Some(0), Some(7200))) {
                case Some(n) => duration = n
                case None => ()
            }
    }

    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(QuizAnswerReq(questionId, answer, duration))
}

/*
 * LearningResourceProgressRequest (models.py:307). Declaration order:
 *   current_block_id, visited_block_ids, completed_step_ids,
 *   elapsed_seconds, self_assessments
 * Every field has a default, so nothing is required. Measured multi-error
 * order follows that declaration order (visitedBlockIds too_long before
 * elapsedSeconds ge).
 *
 * self_assessments is dict[str, float]: a non-object (including null, since
 * the field is non-Optional with default_factory) is dict_type; a bad VALUE
 * errors at ["body","selfAssessments",<key>] as float_parsing / float_type.
 */
private func parseProgressRequest(ctx: HttpContext, root: JsonObject): ?ProgressReq {
    let bag = PyBag()

    /* current_block_id: str | None = Field(max_length=160) */
    var currentBlockId: ?String = None
    match (pyFieldOpt(root, "current_block_id", "currentBlockId")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 160)) {
                case Some(s) => currentBlockId = Some(s)
                case None => ()
            }
    }
    /* visited_block_ids: list[str] = Field(max_length=500) */
    var visited = Array<String>(0, repeat: "")
    match (pyField(root, "visited_block_ids", "visitedBlockIds")) {
        case None => ()
        case Some(f) =>
            match (pyStrList(bag, f, 500)) {
                case Some(items) => visited = items
                case None => ()
            }
    }
    /* completed_step_ids: list[str] = Field(max_length=200) */
    var steps = Array<String>(0, repeat: "")
    match (pyField(root, "completed_step_ids", "completedStepIds")) {
        case None => ()
        case Some(f) =>
            match (pyStrList(bag, f, 200)) {
                case Some(items) => steps = items
                case None => ()
            }
    }
    /* elapsed_seconds: int = Field(default=0, ge=0, le=31_536_000) */
    var elapsed: Int64 = 0
    match (pyField(root, "elapsed_seconds", "elapsedSeconds")) {
        case None => ()
        case Some(f) =>
            match (pyInt(bag, f, Some(0), Some(31536000))) {
                case Some(n) => elapsed = n
                case None => ()
            }
    }
    /* self_assessments: dict[str, float] = Field(default_factory=dict) */
    let assessments = ArrayList<(String, Float64)>()
    match (pyField(root, "self_assessments", "selfAssessments")) {
        case None => ()
        case Some(f) =>
            match (f.value.kind()) {
                case JsonKind.JsObject =>
                    let obj = f.value.asObject()
                    for ((k, v) in obj.getFields()) {
                        match (coercePyFloat(v)) {
                            case PFloat.Done(x) => assessments.add((k, x))
                            case PFloat.Fail(t, m, input) =>
                                bag.add(pyDictValueType(f.key, k, t, m, input))
                        }
                    }
                case _ => bag.add(pyDictType(["body", f.key], f.raw))
            }
    }

    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(ProgressReq(currentBlockId, visited, steps, elapsed, assessments.toArray()))
}

/*
 * LearningResourceSourceFeedbackRequest (models.py:332). Declaration order:
 *   source_id, issue_type, note
 * Measured {"sourceId":"","issueType":"bogus"} -> two items in that order.
 * `missing` loc is ["body","source_id"] (the Python field name); value errors
 * echo the key as present. issue_type is a non-Optional Literal with a
 * default, so an explicit null is literal_error; note is Optional so null is
 * absent.
 */
private func parseSourceFeedback(ctx: HttpContext, root: JsonObject): ?SourceFeedbackReq {
    let bag = PyBag()
    let parentRaw = jsonObjectToRaw(root)

    /* source_id: str = Field(min_length=1, max_length=160) */
    var sourceId = ""
    match (pyField(root, "source_id", "sourceId")) {
        case None => bag.add(pyMissing(["body", "source_id"], parentRaw))
        case Some(f) =>
            match (pyStr(bag, f, 1, 160)) {
                case Some(s) => sourceId = s
                case None => ()
            }
    }
    /* issue_type: Literal[...] = Field(default="needs_review") */
    var issueType = "needs_review"
    match (pyField(root, "issue_type", "issueType")) {
        case None => ()
        case Some(f) =>
            match (pyLiteralField(bag, f, ["needs_review", "mismatch", "outdated", "broken_link", "other"])) {
                case Some(s) => issueType = s
                case None => ()
            }
    }
    /* note: str | None = Field(max_length=1000) */
    var note: ?String = None
    match (pyFieldOpt(root, "note", "note")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 1000)) {
                case Some(s) => note = Some(s)
                case None => ()
            }
    }

    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(SourceFeedbackReq(sourceId, issueType, note))
}

/* -------- small helpers -------- */

private func parseObject(text: String): JsonObject {
    match (jsonParse(text)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsObject => return v.asObject()
                case _ => return emptyObject()
            }
        case None => return emptyObject()
    }
}

private func stringArrayFromJson(obj: JsonObject, key: String): Array<String> {
    let out = ArrayList<String>()
    match (jsonGetArray(obj, key)) {
        case Some(arr) =>
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
        case None => ()
    }
    return out.toArray()
}

/* Join already-serialized JSON values into a JSON array. */
private func strArrayJson(items: ArrayList<String>): String {
    var out = "["
    var first = true
    for (s in items) {
        if (!first) {
            out = out + ","
        }
        first = false
        out = out + s
    }
    return out + "]"
}

/* Python str[:240] is rune-based. */
private func excerptSlice(text: String, limit: Int64): String {
    if (charCount(text) <= limit) {
        return text
    }
    var out = ""
    var n: Int64 = 0
    for (ch in text.runes()) {
        if (n >= limit) {
            break
        }
        out = out + ch.toString()
        n += 1
    }
    return out
}

private func queryTruthy(request: HttpRequest, name: String): Bool {
    match (queryParam(request, name)) {
        case None => return false
        case Some(v) =>
            let t = v.toAsciiLower().trimAscii()
            return t == "1" || t == "true" || t == "yes" || t == "on"
    }
}

/*
 * Optional UUID query param. `name` is the EXACT query key FastAPI binds.
 *
 * Measured divergence from body fields: `Query(validation_alias=AliasChoices(
 * "learner_id","learnerId"))` binds ONLY `learner_id` — FastAPI looks the
 * value up by the field name when alias is unset, so `?learnerId=zz` is
 * silently ignored (200) while `?learner_id=zz` is uuid_parsing. `Query(
 * alias="courseId")` binds only `courseId`. Spire now matches that binding.
 * Empty string is invalid length, not "absent" (measured).
 */
private func queryUuidOk(ctx: HttpContext, name: String): Bool {
    match (queryParam(ctx.request, name)) {
        case None => return true
        case Some(raw) =>
            match (uuidParse(raw)) {
                case Some(_) => return true
                case None =>
                    match (uuidParseError(raw)) {
                        case Some(err) =>
                            writeValidation422(ctx.response, ["query", name], "uuid_parsing",
                                               "Input should be a valid UUID, " + err,
                                               jsonQuote(raw),
                                               Some("{\"error\":" + jsonQuote(err) + "}"))
                        case None =>
                            writeValidation422(ctx.response, ["query", name], "uuid_parsing",
                                               "Input should be a valid UUID",
                                               jsonQuote(raw),
                                               Some("{\"error\":\"Invalid UUID\"}"))
                    }
                    return false
            }
    }
}

/* Optional `str = Query(max_length=N)` query param — only too_long can fire. */
private func queryLenOk(ctx: HttpContext, name: String, max: Int64): Bool {
    match (queryParam(ctx.request, name)) {
        case None => return true
        case Some(v) =>
            if (charCount(v) > max) {
                writeValidation422(ctx.response, ["query", name], "string_too_long",
                                   "String should have at most " + max.toString() + " characters",
                                   jsonQuote(v),
                                   Some("{\"max_length\":" + max.toString() + "}"))
                return false
            }
            return true
    }
}

/*
 * include_course: bool = False (no alias). Absent -> default. A present value
 * is validated with Python's lax bool rules (true/false/1/0/TRUE/on/yes ...);
 * anything else, including "", is bool_parsing with input echoed as a string.
 */
private func queryBoolOk(ctx: HttpContext, name: String): Bool {
    match (queryParam(ctx.request, name)) {
        case None => return true
        case Some(raw) =>
            match (parsePyBoolText(raw)) {
                case Some(_) => return true
                case None =>
                    writeValidation422(ctx.response, ["query", name], "bool_parsing",
                                       "Input should be a valid boolean, unable to interpret input",
                                       jsonQuote(raw), None)
                    return false
            }
    }
}

private func optHas<T>(v: Option<T>): Bool {
    match (v) {
        case Some(_) => return true
        case None => return false
    }
}

/* First present string among the two keys, matching `a or b`. */
private func firstString(obj: JsonObject, a: String, b: String): ?String {
    match (jsonGetString(obj, a)) {
        case Some(s) => return Some(s)
        case None => return jsonGetString(obj, b)
    }
}

/* ==================== GET /v1/learning-resources/{id}/next-question ==================== */

/*
 * public.py:6377-6387。纯读 + 纯计算：
 *   resource = store.get(id, user)         -> 无/非 quiz 一律 404 "Quiz not found"
 *   question = LearningContentService.choose_next(content, state)
 *   返回 {"completed": bool, "question": 对外的题面, "state": 原状态}
 * 题面剔除 correctIndex / explanation（复用 adaptive 路径的 publicQuestionJson）。
 */
func handleNextQuestion(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "resource_id")) {
                case None => return
                case Some(resourceId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Learning resource storage is unavailable")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let store = ResourcesStore(conn)
                                match (store.get(userId, resourceId)) {
                                    case None =>
                                        conn.close()
                                        writeDetail(ctx.response, 404, "Quiz not found")
                                    case Some(detail) =>
                                        conn.close()
                                        nextQuestionRespond(ctx, detail)
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "nextQuestion: " + e.message)
                            }
                    }
            }
    }
}

private func nextQuestionRespond(ctx: HttpContext, detail: String): Unit {
    let resource = parseObject(detail)
    if ((jsonGetString(resource, "type") ?? "") != "quiz") {
        writeDetail(ctx.response, 404, "Quiz not found")
        return
    }
    let content = match (jsonGetObject(resource, "content")) {
        case Some(c) => c
        case None => emptyObject()
    }
    let state = match (jsonGetObject(resource, "state")) {
        case Some(s) => s
        case None => emptyObject()
    }
    let stateRaw = match (resource.get("state")) {
        case Some(v) => valueToRaw(v)
        case None => "{}"
    }
    let w = JsonWriter()
    match (chooseNextQuestion(content, state)) {
        case None =>
            w.putBool("completed", true)
            w.putRaw("question", "null")
        case Some(q) =>
            w.putBool("completed", false)
            w.putRaw("question", publicQuestionJson(q))
    }
    w.putRaw("state", stateRaw)
    writeJson(ctx.response, 200, w.toJson())
}

/*
 * LearningContentService.choose_next 逐句移植：
 *   answered = {str(aq["questionId"])}
 *   remaining = questions 中 id 未被答过的
 *   ability < .45 -> easy；< .72 -> medium；否则 hard
 *   candidates = 难度等于 target 的；没有就退回全部 remaining
 *   min by (abs(rank(difficulty) - rank(target)), mastery.get(str(kpId), .35))
 * Python 的 min 在并列时取第一个，所以这里只在严格更小时替换。
 */
private func chooseNextQuestion(content: JsonObject, state: JsonObject): ?JsonValue {
    let answered = HashSet<String>()
    match (jsonGetArray(state, "answered")) {
        case Some(arr) =>
            var i: Int64 = 0
            while (i < arr.size()) {
                match (arr.get(i)) {
                    case Some(item) =>
                        if (isJsObject(item)) {
                            match (item.asObject().get("questionId")) {
                                case Some(qid) => answered.add(pyStrValue(qid))
                                case None => ()
                            }
                        }
                    case None => ()
                }
                i += 1
            }
        case None => ()
    }
    let remaining = ArrayList<JsonValue>()
    match (jsonGetArray(content, "questions")) {
        case Some(questions) =>
            var i: Int64 = 0
            while (i < questions.size()) {
                match (questions.get(i)) {
                    case Some(q) =>
                        if (isJsObject(q)) {
                            let qid = match (q.asObject().get("id")) {
                                case Some(v) => pyStrValue(v)
                                case None => "None"
                            }
                            if (!answered.contains(qid)) {
                                remaining.add(q)
                            }
                        }
                    case None => ()
                }
                i += 1
            }
        case None => ()
    }
    if (remaining.size == 0) {
        return None
    }
    let ability = jsonGetFloat(state, "ability") ?? 0.35
    let target = if (ability < 0.45) {
        "easy"
    } else if (ability < 0.72) {
        "medium"
    } else {
        "hard"
    }
    let targetRank = lcDiffRank(target)
    let matching = ArrayList<JsonValue>()
    for (q in remaining) {
        let diff = match (q.asObject().get("difficulty")) {
            case Some(v) => pyStrValue(v)
            case None => "None"
        }
        if (diff == target) {
            matching.add(q)
        }
    }
    let candidates = if (matching.size > 0) { matching } else { remaining }
    let mastery = match (jsonGetObject(state, "mastery")) {
        case Some(m) => m
        case None => emptyObject()
    }
    var best: ?JsonValue = None
    var bestRank: Int64 = 0
    var bestMastery: Float64 = 0.0
    for (q in candidates) {
        let obj = q.asObject()
        let diff = match (obj.get("difficulty")) {
            case Some(v) => pyStrValue(v)
            case None => "None"
        }
        let rankVal = if (lcDiffRank(diff) >= 0) { lcDiffRank(diff) } else { 0 }
        let kpKey = match (obj.get("knowledgePointId")) {
            case Some(v) => pyStrValue(v)
            case None => "None"
        }
        let masteryVal = match (mastery.get(kpKey)) {
            case Some(v) => jsonNumber(v) ?? 0.35
            case None => 0.35
        }
        let delta = if (rankVal > targetRank) { rankVal - targetRank } else { targetRank - rankVal }
        match (best) {
            case None =>
                best = Some(q)
                bestRank = delta
                bestMastery = masteryVal
            case Some(_) =>
                if (delta < bestRank || (delta == bestRank && masteryVal < bestMastery)) {
                    best = Some(q)
                    bestRank = delta
                    bestMastery = masteryVal
                }
        }
    }
    return best
}

/* rank 表；未知难度按 Python 的 rank.get(..., 0) 取 0。 */
private func lcDiffRank(diff: String): Int64 {
    if (diff == "easy") {
        return 0
    } else if (diff == "medium") {
        return 1
    } else if (diff == "hard") {
        return 2
    }
    return 0
}

/* Python str(value)：字符串原样，数字/布尔/null 用 Python 的文本形态。 */
private func pyStrValue(v: JsonValue): String {
    match (v.kind()) {
        case JsonKind.JsString => return v.asString().getValue()
        case JsonKind.JsInt => return v.asInt().getValue().toString()
        case JsonKind.JsFloat => return v.asFloat().getValue().toString()
        case JsonKind.JsBool => return if (v.asBool().getValue()) { "True" } else { "False" }
        case JsonKind.JsNull => return "None"
        case _ => return ""
    }
}

private func jsonNumber(v: JsonValue): ?Float64 {
    match (v.kind()) {
        case JsonKind.JsInt => return Some(floatFromInt(v.asInt().getValue()))
        case JsonKind.JsFloat => return Some(v.asFloat().getValue())
        case _ => return None
    }
}
