package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * P2 batch 8: growth writes + goals CRUD + review complete.
 *   POST /api/v1/learner-profile/growth-events
 *   POST /api/v1/learner-profile/growth/nourish
 *   POST /api/v1/learning-goals
 *   POST /api/v1/learning-goals/domain/{domainId}/ensure
 *   PUT /api/v1/learning-goals/{goalId}
 *   DELETE /api/v1/learning-goals/{goalId}
 *   PUT /api/v1/learning-goals/{goalId}/current
 *   DELETE /api/v1/learning-goals/current
 *   POST /api/v1/review-states/{code}/complete
 *
 * Contract: LearnForgeSupportController, LearningGoalController,
 * LearnForgeController + LearnForgeSupportService, LearningGoalService,
 * LearnForgeService + GrowthState, ReviewSchedule entities.
 */

public func registerBatch8Routes(app: WebHost, cfg: AppConfig): Unit {
    app.mapPost("api/v1/learner-profile/growth-events") {
        ctx => handleGrowthEvent(ctx, cfg)
    }
    app.mapPost("api/v1/learner-profile/growth/nourish") {
        ctx => handleNourish(ctx, cfg)
    }
    app.mapPost("api/v1/learning-goals") {
        ctx => handleCreateGoal(ctx, cfg)
    }
    app.mapPost("api/v1/learning-goals/domain/{domainId}/ensure") {
        ctx => handleEnsureGoal(ctx, cfg)
    }
    app.mapPut("api/v1/learning-goals/{goalId}") {
        ctx => handleUpdateGoal(ctx, cfg)
    }
    app.mapDelete("api/v1/learning-goals/{goalId}") {
        ctx => handleDeleteGoal(ctx, cfg)
    }
    app.mapPut("api/v1/learning-goals/{goalId}/current") {
        ctx => handleSetCurrentGoal(ctx, cfg)
    }
    app.mapDelete("api/v1/learning-goals/current") {
        ctx => handleClearCurrentGoal(ctx, cfg)
    }
    app.mapPost("api/v1/review-states/{code}/complete") {
        ctx => handleCompleteReview(ctx, cfg)
    }
}

/* ---- growthReward (LearnForgeSupportService:188-200) ---- */

func growthReward(eventType: String, requestedAmount: ?Int64): Int64 {
    var amt: Int64 = 0
    match (requestedAmount) {
        case Some(v) => amt = v
        case None => ()
    }
    if (eventType == "quiz-answer-correct") { return 5 }
    if (eventType == "quiz-answer") { return 1 }
    if (eventType == "lecture-read") { return 15 }
    if (eventType == "guide-complete") { return 20 }
    if (eventType == "tutoring-finished") { return 25 }
    if (eventType == "note-taken") { return 8 }
    if (eventType == "courseware-complete") { return 15 }
    if (eventType == "focus-bonus") {
        /* Math.max(0, Math.min(25, amt)) */
        if (amt < 0) { return 0 }
        if (amt > 25) { return 25 }
        return amt
    }
    /* default: Math.min(0, amt) */
    if (amt > 0) { return 0 }
    return amt
}

/* ---- GrowthState.water / stageOf ---- */

func stageOf(watered: Int64): String {
    if (watered >= 280) { return "tree" }
    if (watered >= 160) { return "young_tree" }
    if (watered >= 80) { return "seedling" }
    if (watered >= 30) { return "sprout" }
    return "seed"
}

/* ---- POST /growth-events ---- */

func handleGrowthEvent(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (readJsonBody(ctx)) {
                case None =>
                    writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请求体不是有效的 JSON 或字段类型错误")
                    return
                case Some(root) =>
                    /* eventType: @NotNull @Size(max=64) */
                    var eventType = ""
                    match (jsonObjStr(root, "eventType")) {
                        case Some(v) => eventType = v
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "eventType: 不能为空")
                            return
                    }
                    /* title: @NotNull @Size(max=255) */
                    var title = ""
                    match (jsonObjStr(root, "title")) {
                        case Some(v) => title = v
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "title: 不能为空")
                            return
                    }
                    /* amount: @NotNull Integer */
                    var amount: Int64 = 0
                    match (jsonObjOptInt(root, "amount")) {
                        case Some(v) => amount = v
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "amount: 不能为空")
                            return
                    }
                    let metadata = jsonObjRawObject(root, "metadata")
                    match (openDb(cfg)) {
                        case None =>
                            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                        case Some(conn) =>
                            try {
                                let store = LearnForgeStore(conn)
                                let gstore = LearnForgeGrowthStore(conn)
                                /* resolveLearner */
                                match (resolveLearnerId(store, userId, queryParam(ctx.request, "learnerId"))) {
                                    case None =>
                                        conn.close()
                                        writeApiErr(ctx.response, 404, CODE_LEARNER_NOT_FOUND, "学习者不存在")
                                    case Some(learnerId) =>
                                        /* growthReward */
                                        let reward = growthReward(eventType, Some(amount))
                                        /* get or create GrowthState */
                                        var state = gstore.getGrowthState(userId, learnerId)
                                        match (state) {
                                            case None =>
                                                gstore.insertGrowthState(userId, learnerId)
                                                state = gstore.getGrowthState(userId, learnerId)
                                            case Some(_) => ()
                                        }
                                        /* addOrb: orb = max(0, orb + reward) */
                                        match (state) {
                                            case Some(s) =>
                                                var newOrb = s.orb + reward
                                                if (newOrb < 0) { newOrb = 0 }
                                                gstore.updateGrowthOrb(userId, learnerId, newOrb)
                                            case None => ()
                                        }
                                        /* insert GrowthEvent */
                                        gstore.insertGrowthEvent(userId, learnerId, eventType, title, reward, metadata)
                                        /* return growth() */
                                        let body = growthJson(gstore, userId, learnerId)
                                        conn.close()
                                        writeJson(ctx.response, 200,
                                            "{\"code\":0,\"message\":" + jsonQuote("成长事件记录成功") +
                                            ",\"data\":" + body +
                                            ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                                }
                            } catch (e: Exception) {
                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            }
                    }
            }
    }
}

/* ---- POST /growth/nourish ---- */

func handleNourish(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let store = LearnForgeStore(conn)
                        let gstore = LearnForgeGrowthStore(conn)
                        match (resolveLearnerId(store, userId, queryParam(ctx.request, "learnerId"))) {
                            case None =>
                                conn.close()
                                writeApiErr(ctx.response, 404, CODE_LEARNER_NOT_FOUND, "学习者不存在")
                            case Some(learnerId) =>
                                /* get or create GrowthState */
                                var state = gstore.getGrowthState(userId, learnerId)
                                match (state) {
                                    case None =>
                                        gstore.insertGrowthState(userId, learnerId)
                                        state = gstore.getGrowthState(userId, learnerId)
                                    case Some(_) => ()
                                }
                                /* water(): spent = orb; watered += spent; orb = 0; stage = stageOf(watered) */
                                match (state) {
                                    case Some(s) =>
                                        let spent = s.orb
                                        let newWatered = s.watered + spent
                                        let newStage = stageOf(newWatered)
                                        gstore.updateGrowthWater(userId, learnerId, spent, newWatered, newStage)
                                        if (spent > 0) {
                                            gstore.insertGrowthEvent(userId, learnerId, "nourish", "滋养园子", 0 - spent, None)
                                        }
                                    case None => ()
                                }
                                let body = growthJson(gstore, userId, learnerId)
                                conn.close()
                                writeJson(ctx.response, 200,
                                    "{\"code\":0,\"message\":" + jsonQuote("园子滋养成功") +
                                    ",\"data\":" + body +
                                    ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                        }
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

/* ---- LearningGoals CRUD ---- */

/* POST /learning-goals */
func handleCreateGoal(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (readJsonBody(ctx)) {
                case None =>
                    writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请求体不是有效的 JSON 或字段类型错误")
                    return
                case Some(root) =>
                    /* knowledgeDomainId: @NotNull Long */
                    var domainId: Int64 = 0
                    match (jsonObjOptInt(root, "knowledgeDomainId")) {
                        case Some(v) => domainId = v
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "knowledgeDomainId: 不能为空")
                            return
                    }
                    /* goalType: @NotNull enum */
                    var goalType = ""
                    match (jsonObjStr(root, "goalType")) {
                        case Some(v) => goalType = v
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "goalType: 不能为空")
                            return
                    }
                    /* title: @NotBlank @Size(max=128) — Java does title.strip() */
                    var title = ""
                    match (jsonObjStr(root, "title")) {
                        case Some(v) =>
                            let t = v.trimAscii()
                            if (t.size > 0) { title = t }
                            else {
                                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "title: 不能为空")
                                return
                            }
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "title: 不能为空")
                            return
                    }
                    /* description: normalizeNullable — blank becomes null */
                    var description: ?String = None
                    match (jsonObjStr(root, "description")) {
                        case Some(d) =>
                            let t = d.trimAscii()
                            if (t.size > 0) { description = Some(t) }
                        case None => ()
                    }
                    /* expectedLevel: @NotNull enum */
                    var expectedLevel = ""
                    match (jsonObjStr(root, "expectedLevel")) {
                        case Some(v) => expectedLevel = v
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "expectedLevel: 不能为空")
                            return
                    }
                    let initialLevel = jsonObjStr(root, "initialLevel")
                    let assessmentMethod = jsonObjStr(root, "assessmentMethod")
                    /* status: @NotNull enum */
                    var status = ""
                    match (jsonObjStr(root, "status")) {
                        case Some(v) => status = v
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "status: 不能为空")
                            return
                    }
                    let targetDate = jsonObjStr(root, "targetDate")
                    match (openDb(cfg)) {
                        case None =>
                            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                        case Some(conn) =>
                            try {
                                let store = LearnForgeB4Store(conn)
                                /* requireActiveDomain */
                                match (store.getGoalById(domainId)) {
                                    case None =>
                                        conn.close()
                                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "学习领域不存在或尚未启用")
                                    case Some(_) =>
                                        let goalId = uuidV4()
                                        store.insertGoal(userId, goalId, domainId, goalType,
                                            title, description, expectedLevel, initialLevel,
                                            assessmentMethod, status, targetDate)
                                        let curId = store.currentGoalId(userId)
                                        match (store.getGoal(userId, goalId)) {
                                            case None =>
                                                conn.close()
                                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                                            case Some(g) =>
                                                conn.close()
                                                writeJson(ctx.response, 201,
                                                    "{\"code\":0,\"message\":" + jsonQuote("学习目标创建成功") +
                                                    ",\"data\":" + goalB4ToJson(g, curId) +
                                                    ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                                        }
                                }
                            } catch (e: Exception) {
                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            }
                    }
            }
    }
}

/* POST /learning-goals/domain/{domainId}/ensure */
func handleEnsureGoal(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            let domainIdStr = routeParamStr(ctx, "domainId") ?? "0"
            let domainId = Int64.tryParse(domainIdStr) ?? 0
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let store = LearnForgeB4Store(conn)
                        match (store.getDomainById(domainId)) {
                            case None =>
                                conn.close()
                                writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "学习领域不存在或尚未启用")
                            case Some((domainName, domainDesc)) =>
                                /* findFirstByUserIdAndKnowledgeDomainIdOrderByUpdatedAtDesc */
                                match (store.findGoalByDomain(userId, domainId)) {
                                    case Some(g) =>
                                        let curId = store.currentGoalId(userId)
                                        conn.close()
                                        writeJson(ctx.response, 200,
                                            "{\"code\":0,\"message\":" + jsonQuote("success") +
                                            ",\"data\":" + goalB4ToJson(g, curId) +
                                            ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                                    case None =>
                                        /* create with defaults: title=domain.name, description=domain.description */
                                        let goalId = uuidV4()
                                        store.insertGoal(userId, goalId, domainId,
                                            "SKILL_IMPROVEMENT", domainName.trimAscii(), domainDesc,
                                            "PROFICIENT", "BEGINNER", "SELF", "ACTIVE", None)
                                        let curId = store.currentGoalId(userId)
                                        match (store.getGoal(userId, goalId)) {
                                            case None =>
                                                conn.close()
                                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                                            case Some(g) =>
                                                conn.close()
                                                writeJson(ctx.response, 200,
                                                    "{\"code\":0,\"message\":" + jsonQuote("success") +
                                                    ",\"data\":" + goalB4ToJson(g, curId) +
                                                    ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                                        }
                                }
                        }
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

/* PUT /learning-goals/{goalId} */
func handleUpdateGoal(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "goalId")) {
                case None => return
                case Some(goalId) =>
                    match (readJsonBody(ctx)) {
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请求体不是有效的 JSON 或字段类型错误")
                            return
                        case Some(root) =>
                            match (openDb(cfg)) {
                                case None =>
                                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                                case Some(conn) =>
                                    try {
                                        let store = LearnForgeB4Store(conn)
                                        match (store.getGoal(userId, goalId)) {
                                            case None =>
                                                conn.close()
                                                writeApiErr(ctx.response, 404, CODE_LEARNING_GOAL_NOT_FOUND, "学习目标不存在")
                                            case Some(_) =>
                                                let domainId = jsonObjOptInt(root, "knowledgeDomainId") ?? 0
                                                let goalType = jsonObjStr(root, "goalType") ?? ""
                                                /* title: Java does title.strip() */
                                                let title = (jsonObjStr(root, "title") ?? "").trimAscii()
                                                /* description: normalizeNullable — blank becomes null */
                                                var description: ?String = None
                                                match (jsonObjStr(root, "description")) {
                                                    case Some(d) =>
                                                        let t = d.trimAscii()
                                                        if (t.size > 0) { description = Some(t) }
                                                    case None => ()
                                                }
                                                let expectedLevel = jsonObjStr(root, "expectedLevel") ?? ""
                                                let initialLevel = jsonObjStr(root, "initialLevel")
                                                let assessmentMethod = jsonObjStr(root, "assessmentMethod")
                                                let status = jsonObjStr(root, "status") ?? ""
                                                let targetDate = jsonObjStr(root, "targetDate")
                                                store.updateGoal(goalId, userId, domainId, goalType,
                                                    title, description, expectedLevel, initialLevel,
                                                    assessmentMethod, status, targetDate)
                                                let curId = store.currentGoalId(userId)
                                                match (store.getGoal(userId, goalId)) {
                                                    case None =>
                                                        conn.close()
                                                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                                                    case Some(g) =>
                                                        conn.close()
                                                        writeJson(ctx.response, 200,
                                                            "{\"code\":0,\"message\":" + jsonQuote("学习目标更新成功") +
                                                            ",\"data\":" + goalB4ToJson(g, curId) +
                                                            ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                                                }
                                        }
                                    } catch (e: Exception) {
                                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                                    }
                            }
                    }
            }
    }
}

/* DELETE /learning-goals/{goalId} */
func handleDeleteGoal(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "goalId")) {
                case None => return
                case Some(goalId) =>
                    match (openDb(cfg)) {
                        case None =>
                            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                        case Some(conn) =>
                            try {
                                let store = LearnForgeB4Store(conn)
                                match (store.getGoal(userId, goalId)) {
                                    case None =>
                                        conn.close()
                                        writeApiErr(ctx.response, 404, CODE_LEARNING_GOAL_NOT_FOUND, "学习目标不存在")
                                    case Some(_) =>
                                        /* clear current_goal_id if it points to this goal */
                                        store.clearCurrentIfMatches(userId, goalId)
                                        store.deleteGoal(goalId, userId)
                                        conn.close()
                                        writeJson(ctx.response, 200,
                                            "{\"code\":0,\"message\":" + jsonQuote("学习目标删除成功") +
                                            ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                                }
                            } catch (e: Exception) {
                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            }
                    }
            }
    }
}

/* PUT /learning-goals/{goalId}/current */
func handleSetCurrentGoal(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "goalId")) {
                case None => return
                case Some(goalId) =>
                    match (openDb(cfg)) {
                        case None =>
                            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                        case Some(conn) =>
                            try {
                                let store = LearnForgeB4Store(conn)
                                match (store.getGoal(userId, goalId)) {
                                    case None =>
                                        conn.close()
                                        writeApiErr(ctx.response, 404, CODE_LEARNING_GOAL_NOT_FOUND, "学习目标不存在")
                                    case Some(g) =>
                                        /* upsert user_profiles.current_goal_id */
                                        store.setCurrentGoal(userId, goalId)
                                        conn.close()
                                        writeJson(ctx.response, 200,
                                            "{\"code\":0,\"message\":" + jsonQuote("当前学习目标切换成功") +
                                            ",\"data\":" + goalB4ToJson(g, Some(goalId)) +
                                            ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                                }
                            } catch (e: Exception) {
                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            }
                    }
            }
    }
}

/* DELETE /learning-goals/current */
func handleClearCurrentGoal(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let store = LearnForgeB4Store(conn)
                        store.clearCurrentGoal(userId)
                        conn.close()
                        writeJson(ctx.response, 200,
                            "{\"code\":0,\"message\":" + jsonQuote("当前学习目标已清除") +
                            ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

/* ---- POST /review-states/{code}/complete ---- */

func handleCompleteReview(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            let code = routeParamStr(ctx, "code") ?? ""
            match (readJsonBody(ctx)) {
                case None =>
                    writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请求体不是有效的 JSON 或字段类型错误")
                    return
                case Some(root) =>
                    /* score: @NotNull @Min(0) @Max(100) */
                    var score: Int64 = 0
                    match (jsonObjOptInt(root, "score")) {
                        case Some(v) => score = v
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "score: 不能为空")
                            return
                    }
                    if (score < 0 || score > 100) {
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "score: 必须在0到100之间")
                        return
                    }
                    let sourceId = jsonObjStr(root, "sourceId")
                    let durationSeconds = jsonObjOptInt(root, "durationSeconds")
                    match (openDb(cfg)) {
                        case None =>
                            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                        case Some(conn) =>
                            try {
                                let store = LearnForgeB4Store(conn)
                                /* findPoint(code) */
                                match (store.getKnowledgePointByCode(code)) {
                                    case None =>
                                        conn.close()
                                        writeApiErr(ctx.response, 404, CODE_KNOWLEDGE_POINT_NOT_FOUND, "知识点不存在")
                                    case Some(kp) =>
                                        /* find or create ReviewSchedule */
                                        match (store.getReviewSchedule(userId, code)) {
                                            case None =>
                                                store.insertReviewSchedule(userId, code, score)
                                            case Some(rv) =>
                                                /* intervalDays: reps==0→1, 1→2, 2→4, default→7 */
                                                var intervalDays: Int64 = 7
                                                if (rv.reps == 0) { intervalDays = 1 }
                                                else if (rv.reps == 1) { intervalDays = 2 }
                                                else if (rv.reps == 2) { intervalDays = 4 }
                                                store.completeReview(userId, code, score, intervalDays)
                                        }
                                        /* recordEvent KP_MASTERY_CHECK */
                                        let wstore = LearnForgeWriteStore(conn)
                                        let metaJson = "{\"knowledgePoint\":" + jsonQuote(code) +
                                            ",\"score\":" + score.toString() + "}"
                                        wstore.insertEvent(userId, "KP_MASTERY_CHECK",
                                            "KNOWLEDGE_BASE", sourceId, None, durationSeconds,
                                            Some(metaJson))
                                        /* return ReviewStateResponse */
                                        match (store.getReviewSchedule(userId, code)) {
                                            case None =>
                                                conn.close()
                                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                                            case Some(rv) =>
                                                let nowMicros = timePartsToEpochMicros(nowUtcParts())
                                                let dueMicros = timePartsToEpochMicros(parseDbDatetime(rv.dueAtUtc))
                                                let due = dueMicros <= nowMicros
                                                var overdue: Int64 = 0
                                                if (dueMicros < nowMicros) {
                                                    overdue = (nowMicros - dueMicros) / 86400000000
                                                }
                                                conn.close()
                                                let w = JsonWriter()
                                                w.putStr("kpId", kp.code)
                                                w.putStr("name", kp.name)
                                                match (rv.lastAtUtc) {
                                                    case Some(t) => w.putRaw("lastAt", jsonQuote(isoInstantFromDb(t)))
                                                    case None => w.putRaw("lastAt", "null")
                                                }
                                                w.putRaw("reps", rv.reps.toString())
                                                w.putRaw("mastery", rv.mastery)
                                                w.putRaw("dueAt", jsonQuote(isoInstantFromDb(rv.dueAtUtc)))
                                                w.putRaw("due", if (due) { "true" } else { "false" })
                                                w.putRaw("overdueDays", overdue.toString())
                                                writeJson(ctx.response, 200,
                                                    "{\"code\":0,\"message\":" + jsonQuote("复习记录成功") +
                                                    ",\"data\":" + w.toJson() +
                                                    ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                                        }
                                }
                            } catch (e: Exception) {
                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            }
                    }
            }
    }
}
