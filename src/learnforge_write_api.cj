package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * P2 batch 6: learner-profile write side.
 *   POST /api/v1/learner-profile/events     → 201
 *   POST /api/v1/learner-profile/quiz       → 201
 *   POST /api/v1/learner-profile/journal/summary → 200
 *
 * Contract: LearnerProfileController.java:40-82,
 * LearningAnalyticsService.java:63-108, 315-344.
 *
 * Response envelope: ApiResponse with message (not "success").
 * events/quiz return 201 with data omitted (null).
 * journal/summary returns 200 with the full LearningJournalResponse.
 */

public func registerWriteRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapPost("api/v1/learner-profile/events") {
        ctx => handleRecordEvent(ctx, cfg)
    }
    app.mapPost("api/v1/learner-profile/quiz") {
        ctx => handleRecordQuiz(ctx, cfg)
    }
    app.mapPost("api/v1/learner-profile/journal/summary") {
        ctx => handleJournalSummary(ctx, cfg)
    }
    /* batch 7 */
    app.mapPut("api/v1/profile") {
        ctx => handleUpsertProfile(ctx, cfg)
    }
    app.mapPost("api/v1/learners") {
        ctx => handleCreateLearner(ctx, cfg)
    }
    app.mapPut("api/v1/learners/{learnerId}") {
        ctx => handleUpdateLearner(ctx, cfg)
    }
}

/* ===================================================================
 * batch 7: PUT /profile, POST /learners, PUT /learners/{id}
 * =================================================================== */

/*
 * PUT /api/v1/profile — ProfileController.upsert → ProfileService.upsert.
 * normalizeNullable: blank → null, else strip().
 * normalizeVoice: blank → "苏打", else strip().
 * normalizeSpeed: only very_slow/slow/fast/very_fast accepted, else "normal".
 */
func handleUpsertProfile(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(userId) =>
            match (readJsonBody(ctx)) {
                case None =>
                    writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请求体不是有效的 JSON 或字段类型错误")
                    return
                case Some(root) =>
                    /* profileCompleted: @NotNull Boolean */
                    var profileCompleted = false
                    match (jsonObjBool(root, "profileCompleted")) {
                        case Some(b) => profileCompleted = b
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "profileCompleted: 不能为空")
                            return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                        case Some(conn) =>
                            try {
                                let store = LearnForgeStore(conn)
                                /* normalize fields */
                                let edu = normalizeNullableJson(root, "educationLevel")
                                let major = normalizeNullableJson(root, "major")
                                let tech = normalizeNullableJson(root, "technicalFoundation")
                                let pref = jsonObjStr(root, "learningPreference")
                                let voice = normalizeVoiceJson(root, "ttsVoice")
                                let speed = normalizeSpeedJson(root, "ttsSpeed")
                                let name = normalizeNullableJson(root, "name")
                                let avatar = normalizeNullableJson(root, "avatar")
                                let role = normalizeNullableJson(root, "role")
                                let jobTitle = normalizeNullableJson(root, "jobTitle")
                                let orgId = jsonObjStr(root, "organizationId")
                                let deptId = jsonObjStr(root, "departmentId")
                                let weeklyHours = jsonObjOptInt(root, "weeklyHours")
                                let learningStyle = jsonObjRawArray(root, "learningStyle")
                                let goal = normalizeNullableJson(root, "goal")
                                let preferredFormat = normalizeNullableJson(root, "preferredFormat")
                                let selfAssessment = jsonObjRawObject(root, "selfAssessment")
                                let diagnosisSummary = jsonObjRawObject(root, "diagnosisSummary")
                                /* upsert */
                                store.upsertProfile(userId, edu, major, tech, pref,
                                    profileCompleted, voice, speed, name, avatar, role,
                                    jobTitle, orgId, deptId, weeklyHours, learningStyle,
                                    goal, preferredFormat, selfAssessment, diagnosisSummary)
                                /* return ProfileResponse */
                                var row = RawProfile(userId)
                                match (store.getProfileByUser(userId)) {
                                    case Some(found) => row = found
                                    case None => ()
                                }
                                conn.close()
                                writeJson(ctx.response, 200,
                                    "{\"code\":0,\"message\":" + jsonQuote("用户画像保存成功") +
                                    ",\"data\":" + profileToJson(row) +
                                    ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                            } catch (e: Exception) {
                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            }
                    }
            }
    }
}

/*
 * POST /api/v1/learners — LearnForgeSupportController.createLearner.
 * code default "learner-" + UUID[:8]; name default "学习者".
 * updateFromRequest: null fields don't overwrite.
 */
func handleCreateLearner(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(userId) =>
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
                                let store = LearnForgeStore(conn)
                                let learnerId = uuidV4()
                                /* code: blank → "learner-" + UUID[:8] */
                                var code = ""
                                match (jsonObjStr(root, "code")) {
                                    case Some(c) =>
                                        if (c.trimAscii().size > 0) { code = c.trimAscii() }
                                        else { code = "learner-" + uuidFormat(learnerId)[0..8] }
                                    case None => code = "learner-" + uuidFormat(learnerId)[0..8]
                                }
                                /* name: blank → "学习者" */
                                var name = "学习者"
                                match (jsonObjStr(root, "name")) {
                                    case Some(n) =>
                                        if (n.trimAscii().size > 0) { name = n.trimAscii() }
                                    case None => ()
                                }
                                store.insertLearner(learnerId, userId, code, name)
                                /* applyRequest */
                                applyLearnerRequest(store, userId, learnerId, root)
                                /* return LearnerResponse */
                                match (store.getByUser(userId, learnerId)) {
                                    case None =>
                                        conn.close()
                                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                                    case Some(row) =>
                                        let kpCodes = store.enabledKnowledgePointCodes()
                                        conn.close()
                                        writeJson(ctx.response, 200,
                                            "{\"code\":0,\"message\":" + jsonQuote("学习者创建成功") +
                                            ",\"data\":" + learnerToJson(row, kpCodes) +
                                            ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                                }
                            } catch (e: Exception) {
                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            }
                    }
            }
    }
}

/*
 * PUT /api/v1/learners/{learnerId} — updateLearner.
 * Ownership check: findByIdAndUser_Id → 404 if not found.
 */
func handleUpdateLearner(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "learnerId")) {
                case None => return
                case Some(learnerId) =>
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
                                        let store = LearnForgeStore(conn)
                                        match (store.getByUser(userId, learnerId)) {
                                            case None =>
                                                conn.close()
                                                writeApiErr(ctx.response, 404, CODE_LEARNER_NOT_FOUND, "学习者不存在")
                                            case Some(_) =>
                                                applyLearnerRequest(store, userId, learnerId, root)
                                                match (store.getByUser(userId, learnerId)) {
                                                    case None =>
                                                        conn.close()
                                                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                                                    case Some(row) =>
                                                        let kpCodes = store.enabledKnowledgePointCodes()
                                                        conn.close()
                                                        writeJson(ctx.response, 200,
                                                            "{\"code\":0,\"message\":" + jsonQuote("学习者更新成功") +
                                                            ",\"data\":" + learnerToJson(row, kpCodes) +
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

/* applyRequest → updateFromRequest: null fields don't overwrite. */
func applyLearnerRequest(store: LearnForgeStore, userId: Array<Byte>,
                          learnerId: Array<Byte>, root: JsonValue): Unit {
    let name = jsonObjStr(root, "name")
    let avatar = jsonObjStr(root, "avatar")
    let role = jsonObjStr(root, "role")
    let education = jsonObjStr(root, "education")
    let targetJob = jsonObjStr(root, "targetJob")
    let weeklyHours = jsonObjOptInt(root, "weeklyHours")
    let learningStyle = jsonObjRawArray(root, "learningStyle")
    let scores = jsonObjRawObject(root, "scores")
    let goal = jsonObjStr(root, "goal")
    let blindSpots = jsonObjRawArray(root, "blindSpots")
    let preferredFormat = jsonObjStr(root, "preferredFormat")
    let diagnosisSummary = jsonObjStr(root, "diagnosisSummary")
    let confidenceMethod = jsonObjStr(root, "confidenceMethod")
    let confidenceValue = jsonObjOptInt(root, "confidenceValue")
    store.updateLearnerFields(learnerId, userId, name, avatar, role, education,
        targetJob, weeklyHours, learningStyle, scores, goal, blindSpots,
        preferredFormat, diagnosisSummary, confidenceMethod, confidenceValue)
}

/* ---- normalization helpers (mirror UserProfile) ---- */

func normalizeNullableJson(obj: JsonValue, field: String): ?String {
    match (jsonObjStr(obj, field)) {
        case Some(s) =>
            let trimmed = s.trimAscii()
            if (trimmed.size == 0) { return None }
            return Some(trimmed)
        case None => return None
    }
}

func normalizeVoiceJson(obj: JsonValue, field: String): String {
    match (jsonObjStr(obj, field)) {
        case Some(s) =>
            let trimmed = s.trimAscii()
            if (trimmed.size == 0) { return "苏打" }
            return trimmed
        case None => return "苏打"
    }
}

func normalizeSpeedJson(obj: JsonValue, field: String): String {
    match (jsonObjStr(obj, field)) {
        case Some(s) =>
            if (s == "very_slow" || s == "slow" || s == "fast" || s == "very_fast") {
                return s
            }
            return "normal"
        case None => return "normal"
    }
}

/* Raw JSON array text for List<String> fields (writeJson semantics). */
func jsonObjRawArray(obj: JsonValue, field: String): ?String {
    if (!isJsObject(obj)) { return None }
    match (obj.asObject().get(field)) {
        case Some(v) =>
            if (isJsArray(v)) {
                return Some(valueToRaw(v))
            }
            return None
        case None => return None
    }
}

/* Raw JSON object text for Map fields (writeJson semantics). */
func jsonObjRawObject(obj: JsonValue, field: String): ?String {
    if (!isJsObject(obj)) { return None }
    match (obj.asObject().get(field)) {
        case Some(v) =>
            if (isJsObject(v)) {
                return Some(valueToRaw(v))
            }
            return None
        case None => return None
    }
}

func jsonObjBool(obj: JsonValue, field: String): ?Bool {
    if (!isJsObject(obj)) { return None }
    match (obj.asObject().get(field)) {
        case Some(v) =>
            if (isJsBool(v)) {
                return Some(v.asBool().getValue())
            }
            return None
        case None => return None
    }
}

/* ---- POST /api/v1/learner-profile/events ---- */

func handleRecordEvent(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(userId) =>
            /* parse body */
            match (readJsonBody(ctx)) {
                case None =>
                    writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请求体不是有效的 JSON 或字段类型错误")
                    return
                case Some(root) =>
                    /* eventType: required enum */
                    var eventType = ""
                    match (jsonObjStr(root, "eventType")) {
                        case Some(v) => eventType = v
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED,
                                "eventType: 不能为空")
                            return
                    }
                    if (!isValidEventType(eventType)) {
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED,
                            "eventType: 类型错误")
                        return
                    }
                    /* sourceType: required enum */
                    var sourceType = ""
                    match (jsonObjStr(root, "sourceType")) {
                        case Some(v) => sourceType = v
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED,
                                "sourceType: 不能为空")
                            return
                    }
                    if (!isValidSourceType(sourceType)) {
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED,
                            "sourceType: 类型错误")
                        return
                    }
                    let sourceId = jsonObjStr(root, "sourceId")
                    let catId = jsonObjOptInt(root, "knowledgeCategoryId")
                    let dur = jsonObjOptInt(root, "durationSeconds")
                    let meta = jsonObjStr(root, "metadata")
                    match (openDb(cfg)) {
                        case None =>
                            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                        case Some(conn) =>
                            try {
                                let store = LearnForgeWriteStore(conn)
                                store.insertEvent(userId, eventType, sourceType,
                                    sourceId, catId, dur, meta)
                                store.upsertSessionEvent(userId, sourceType, dur)
                                conn.close()
                                /* 201 Created, ApiResponse.success("事件记录成功", null) */
                                writeJson(ctx.response, 201,
                                    "{\"code\":0,\"message\":" + jsonQuote("事件记录成功") +
                                    ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                            } catch (e: Exception) {
                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            }
                    }
            }
    }
}

/* ---- POST /api/v1/learner-profile/quiz ---- */

func handleRecordQuiz(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(userId) =>
            match (readJsonBody(ctx)) {
                case None =>
                    writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请求体不是有效的 JSON 或字段类型错误")
                    return
                case Some(root) =>
                    var quizType = ""
                    match (jsonObjStr(root, "quizType")) {
                        case Some(v) => quizType = v
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "quizType: 不能为空")
                            return
                    }
                    if (!isValidQuizType(quizType)) {
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "quizType: 类型错误")
                        return
                    }
                    let catId = jsonObjOptInt(root, "knowledgeCategoryId")
                    /* questionCount: @Min(1) */
                    var qCount: Int64 = 0
                    match (jsonObjOptInt(root, "questionCount")) {
                        case Some(v) => qCount = v
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "questionCount: 不能为空")
                            return
                    }
                    if (qCount < 1) {
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED,
                            "questionCount: 必须大于等于1")
                        return
                    }
                    /* correctCount: @Min(0) */
                    var cCount: Int64 = 0
                    match (jsonObjOptInt(root, "correctCount")) {
                        case Some(v) => cCount = v
                        case None =>
                            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "correctCount: 不能为空")
                            return
                    }
                    if (cCount < 0) {
                        writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED,
                            "correctCount: 必须大于等于0")
                        return
                    }
                    /* score: optional BigDecimal — emit as raw number text */
                    var scoreStr: ?String = None
                    match (jsonObjRawNum(root, "score")) {
                        case Some(t) => scoreStr = Some(t)
                        case None => ()
                    }
                    let dur = jsonObjOptInt(root, "durationSeconds")
                    let diff = jsonObjStr(root, "difficultyLevel")
                    let details = jsonObjStr(root, "details")
                    match (openDb(cfg)) {
                        case None =>
                            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                        case Some(conn) =>
                            try {
                                let store = LearnForgeWriteStore(conn)
                                let quizId = store.insertQuizResult(userId, quizType,
                                    catId, qCount, cCount, scoreStr, dur, diff, details)
                                /* updateMastery if category present */
                                match (catId) {
                                    case Some(cid) =>
                                        store.updateMastery(userId, cid, qCount, cCount)
                                    case None => ()
                                }
                                /* recordEvent QUIZ_SUBMIT */
                                store.insertEvent(userId, "QUIZ_SUBMIT", "QUIZ",
                                    Some(uuidFormat(quizId)), catId, dur, None)
                                store.upsertSessionEvent(userId, "QUIZ", dur)
                                conn.close()
                                writeJson(ctx.response, 201,
                                    "{\"code\":0,\"message\":" + jsonQuote("测评结果记录成功") +
                                    ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                            } catch (e: Exception) {
                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            }
                    }
            }
    }
}

/* ---- POST /api/v1/learner-profile/journal/summary ---- */

func handleJournalSummary(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(userId) =>
            /* parse ?date= */
            var target: CivilDate = nowUtc8Date()
            match (queryParam(ctx.request, "date")) {
                case None => ()
                case Some(raw) =>
                    match (parseIsoLocalDate(raw)) {
                        case None =>
                            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            return
                        case Some(d) => target = d
                    }
            }
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let analytics = LearnForgeAnalyticsStore(conn)
                        let writeStore = LearnForgeWriteStore(conn)
                        /* getJournal — build the journal body */
                        let journalBody = buildJournalBody(analytics, userId, target)
                        /* parse the journal to extract stats and timeline for content */
                        match (jsonParse(journalBody)) {
                            case None =>
                                conn.close()
                                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            case Some(jv) =>
                                /* build content string */
                                let content = buildSummaryContent(jv)
                                /* metricsJson = JournalStats JSON */
                                let metricsJson = extractMetricsJson(jv)
                                /* upsert daily summary */
                                let dateStr = dateIsoText(target)
                                let generatedAt = writeStore.upsertDailySummary(
                                    userId, dateStr, content, metricsJson)
                                /* rebuild journal with the new summary.
                                 * generatedAt is a java.time.Instant → ISO_INSTANT. */
                                let summaryJson = "{\"content\":" + jsonQuote(content) +
                                    ",\"metricsJson\":" + jsonQuote(metricsJson) +
                                    ",\"generatedAt\":" + jsonQuote(isoInstantFromDb(generatedAt)) + "}"
                                /* replace summary in journalBody */
                                let finalBody = replaceJsonField(journalBody, "summary", summaryJson)
                                conn.close()
                                writeJson(ctx.response, 200,
                                    "{\"code\":0,\"message\":" + jsonQuote("当日总结已生成") +
                                    ",\"data\":" + finalBody +
                                    ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                        }
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

/*
 * buildSummaryContent — mirrors generateJournalSummary's content logic.
 * timeline empty → "今天未学习，无法生成小结。"
 * Otherwise a Chinese sentence built from stats.
 */
func buildSummaryContent(jv: JsonValue): String {
    /* timeline length */
    var timelineLen: Int64 = 0
    match (jv.asObject().get("timeline")) {
        case Some(tv) =>
            if (isJsArray(tv)) { timelineLen = tv.asArray().size() }
        case None => ()
    }
    if (timelineLen == 0) {
        return "今天未学习，无法生成小结。"
    }
    /* extract stats */
    var focusSeconds: Int64 = 0
    var resourceCount: Int64 = 0
    var knowledgeCount: Int64 = 0
    var questionCount: Int64 = 0
    var correctCount: Int64 = 0
    var wrongCount: Int64 = 0
    match (jv.asObject().get("stats")) {
        case Some(sv) =>
            if (isJsObject(sv)) {
                let so = sv.asObject()
                focusSeconds = jsonGetInt64(so, "focusSeconds")
                resourceCount = jsonGetInt64(so, "resourceCount")
                knowledgeCount = jsonGetInt64(so, "knowledgeCount")
                questionCount = jsonGetInt64(so, "questionCount")
                correctCount = jsonGetInt64(so, "correctCount")
                wrongCount = jsonGetInt64(so, "wrongCount")
            }
        case None => ()
    }
    var text = "今天共记录 " + timelineLen.toString() + " 个学习节点"
    if (focusSeconds > 0) {
        var mins = focusSeconds / 60
        if (mins < 1) { mins = 1 }
        text = text + "，完成 " + mins.toString() + " 分钟专注"
    }
    if (resourceCount > 0) {
        text = text + "，学习 " + resourceCount.toString() + " 项资源"
    }
    if (knowledgeCount > 0) {
        text = text + "，涉及 " + knowledgeCount.toString() + " 个知识点"
    }
    if (questionCount > 0) {
        /* accuracy = (int) Math.round(correctCount * 100.0 / questionCount) */
        let accuracy = javaMathRound(Float64(correctCount) * 100.0 / Float64(questionCount))
        text = text + "。完成 " + questionCount.toString() + " 道题，正确率 " +
            accuracy.toString() + "%"
        if (wrongCount > 0) {
            text = text + "，建议优先复习今日错题关联的知识点。"
        } else {
            text = text + "，本轮作答保持稳定。 "
        }
    } else {
        text = text + "。可以用一组短测验检验今天的学习效果。"
    }
    /* trim — Java does text.toString().trim(). The old byte-slice loop threw
     * on multibyte tails (it split UTF-8 sequences), which surfaced as 500. */
    return text.trimAscii()
}

/* extract stats JSON from the journal body */
func extractMetricsJson(jv: JsonValue): String {
    match (jv.asObject().get("stats")) {
        case Some(sv) => return valueToRaw(sv)
        case None => return "{}"
    }
}

/* Replace a top-level field in a JSON object string. */
func replaceJsonField(jsonStr: String, field: String, newRaw: String): String {
    /* simple approach: parse and rebuild */
    match (jsonParse(jsonStr)) {
        case None => return jsonStr
        case Some(v) =>
            if (!isJsObject(v)) { return jsonStr }
            let obj = v.asObject()
            let w = JsonWriter()
            /* iterate fields in order */
            match (obj.get("date")) {
                case Some(dv) => w.putRaw("date", valueToRaw(dv))
                case None => ()
            }
            match (obj.get("stats")) {
                case Some(sv) => w.putRaw("stats", valueToRaw(sv))
                case None => ()
            }
            match (obj.get("timeline")) {
                case Some(tv) => w.putRaw("timeline", valueToRaw(tv))
                case None => ()
            }
            w.putRaw("summary", newRaw)
            return w.toJson()
    }
}

/* ---- helpers ---- */

func readJsonBody(ctx: HttpContext): ?JsonValue {
    let text = readBodyText(ctx.request)
    if (text.trimAscii().size == 0) {
        return None
    }
    return jsonParse(text)
}

func jsonObjStr(obj: JsonValue, field: String): ?String {
    if (!isJsObject(obj)) { return None }
    match (obj.asObject().get(field)) {
        case Some(v) =>
            if (isJsString(v)) {
                return Some(v.asString().getValue())
            }
            return None
        case None => return None
    }
}

func jsonObjOptInt(obj: JsonValue, field: String): ?Int64 {
    if (!isJsObject(obj)) { return None }
    match (obj.asObject().get(field)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsInt => return Some(v.asInt().getValue())
                case JsonKind.JsFloat => return Some(Int64(v.asFloat().getValue()))
                case _ => return None
            }
        case None => return None
    }
}

/* Raw number text for BigDecimal fields (score). */
func jsonObjRawNum(obj: JsonValue, field: String): ?String {
    if (!isJsObject(obj)) { return None }
    match (obj.asObject().get(field)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsInt => return Some(v.asInt().getValue().toString())
                case JsonKind.JsFloat => return Some(javaDoubleText(v.asFloat().getValue()))
                case _ => return None
            }
        case None => return None
    }
}

func jsonGetInt64(obj: JsonObject, field: String): Int64 {
    match (obj.get(field)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsInt => return v.asInt().getValue()
                case JsonKind.JsFloat => return Int64(v.asFloat().getValue())
                case _ => return 0
            }
        case None => return 0
    }
}

func isValidEventType(s: String): Bool {
    s == "STUDY_START" || s == "STUDY_END" || s == "QUIZ_SUBMIT" ||
    s == "RESOURCE_VIEW" || s == "CHAT_INTERACTION" || s == "KP_MASTERY_CHECK"
}

func isValidSourceType(s: String): Bool {
    s == "CHAT" || s == "RESOURCE" || s == "QUIZ" ||
    s == "KNOWLEDGE_BASE" || s == "WORKFLOW"
}

func isValidQuizType(s: String): Bool {
    s == "DIAGNOSTIC" || s == "FORMATIVE" || s == "SUMMATIVE" || s == "CHALLENGE"
}
