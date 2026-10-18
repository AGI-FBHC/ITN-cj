package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * P2 batch 9: onboarding pure-compute POSTs.
 *   POST /api/v1/onboarding/answer
 *   POST /api/v1/onboarding/generate-profile
 *   POST /api/v1/onboarding/diagnose
 *
 * Contract: OnboardingAssessmentService.java:139-245.
 * All pure computation — no DB writes. scores/confidence/estimates are
 * computed from request + quiz-bank.json + knowledge_point metadata.
 */

public func registerBatch9Routes(app: WebHost, cfg: AppConfig): Unit {
    app.mapPost("api/v1/onboarding/generate-profile") {
        ctx => handleGenerateProfile(ctx, cfg)
    }
    app.mapPost("api/v1/onboarding/diagnose") {
        ctx => handleDiagnose(ctx, cfg)
    }
    app.mapPost("api/v1/onboarding/answer") {
        ctx => handleAnswer(ctx, cfg)
    }
}

/* ---- shared: abilityName, goalText, diagnosisSummary ---- */

func goalText(targetCategoryCode: ?String, weakest: String, targetJob: ?String): String {
    let job = targetJob ?? ""
    match (targetCategoryCode) {
        case Some("EXAM") => return "3 个月内补齐「" + weakest + "」等短板，对齐「" + job + "」考试科目要求。"
        case Some("CERT") => return "3 个月内补齐「" + weakest + "」等短板，对齐「" + job + "」证书考核要求。"
        case _ => return "3 个月内补齐「" + weakest + "」等短板，向「" + job + "」岗位能力对齐。"
    }
}

func diagnosisSummaryText(strongestName: String, strongestScore: Int64,
                           weakestName: String, weakestScore: Int64): String {
    "DIA-01 诊断：最强「" + strongestName + "」" + strongestScore.toString() +
        " 分，最弱「" + weakestName + "」" + weakestScore.toString() +
        " 分。建议从「" + weakestName + "」切入，用分阶题巩固优势维度。"
}

/* ---- POST /onboarding/generate-profile ---- */

func handleGenerateProfile(ctx: HttpContext, cfg: AppConfig): Unit {
    match (readJsonBody(ctx)) {
        case None =>
            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请求体不是有效的 JSON 或字段类型错误")
            return
        case Some(root) =>
            let method = jsonObjStr(root, "method")
            let name = jsonObjStr(root, "name")
            let avatar = jsonObjStr(root, "avatar")
            let tag = jsonObjStr(root, "tag")
            let education = jsonObjStr(root, "education")
            let targetJob = jsonObjStr(root, "targetJob")
            let targetCategoryCode = jsonObjStr(root, "targetCategoryCode")
            /* scores: Map<String, Integer> */
            let scoresRaw = jsonObjRawObject(root, "scores")
            var scores = ArrayList<(String, Int64)>()
            match (scoresRaw) {
                case Some(sr) =>
                    match (jsonParse(sr)) {
                        case Some(sv) =>
                            if (isJsObject(sv)) {
                                for ((k, v) in sv.asObject().getFields()) {
                                    match (v.kind()) {
                                        case JsonKind.JsInt =>
                                            scores.add((k, v.asInt().getValue()))
                                        case JsonKind.JsFloat =>
                                            scores.add((k, Int64(v.asFloat().getValue())))
                                        case _ => ()
                                    }
                                }
                            }
                        case None => ()
                    }
                case None => ()
            }
            let confidence = jsonObjOptInt(root, "confidence") ?? 33
            let answers = jsonObjRawArray(root, "answers")

            /* sort scores by value ascending */
            let arr = scores.toArray()
            let n = arr.size
            var sorted = Array<(String, Int64)>(n, repeat: ("", 0i64))
            var i: Int64 = 0
            while (i < n) { sorted[i] = arr[i]; i += 1 }
            var k: Int64 = 1
            while (k < n) {
                let cur = sorted[k]
                var j = k - 1
                while (j >= 0 && sorted[j][1] > cur[1]) {
                    sorted[j + 1] = sorted[j]
                    j -= 1
                }
                sorted[j + 1] = cur
                k += 1
            }

            /* strongest/weakest */
            var strongestName = "知识理解"
            var weakestName = "知识理解"
            var strongestScore: Int64 = 50
            var weakestScore: Int64 = 50
            if (n > 0) {
                strongestName = abilityName(sorted[n - 1][0])
                weakestName = abilityName(sorted[0][0])
                strongestScore = sorted[n - 1][1]
                weakestScore = sorted[0][1]
            }

            /* blindSpots: lowest 2 */
            let blindSpots = ArrayList<String>()
            var bi: Int64 = 0
            while (bi < n && bi < 2) {
                blindSpots.add(abilityName(sorted[bi][0]))
                bi += 1
            }
            let weakest = if (blindSpots.size > 0) { blindSpots.get(0) ?? "短板" } else { "短板" }

            /* goal + diagnosisSummary */
            let goal = goalText(targetCategoryCode, weakest, targetJob)
            let diagSummary = diagnosisSummaryText(strongestName, strongestScore, weakestName, weakestScore)

            /* methodLabel */
            let isQuick = method == Some("quick")
            let methodLabel = if (isQuick) { "背景先验起档" } else { "完整测评建档" }

            /* steps */
            let steps = JsonArrWriter()
            steps.addRaw(stepJson("汇总建档信息", "身份「" + (tag ?? "") + "」 · 学历「" + (education ?? "") + "」 · 目标「" + (targetJob ?? "") + "」"))
            steps.addRaw(stepJson("生成能力向量", "最强「" + strongestName + "」" + strongestScore.toString() + " 分 · 最弱「" + weakestName + "」" + weakestScore.toString() + " 分"))
            steps.addRaw(stepJson("定位提升重点", "优先补齐「" + weakestName + "」等短板"))
            steps.addRaw(stepJson("评估画像置信度", methodLabel + " · 平均置信度 " + confidence.toString() + "%"))

            /* evidence */
            let evidence = JsonArrWriter()
            evidence.addRaw(jsonQuote("身份「" + (tag ?? "") + "」"))
            evidence.addRaw(jsonQuote("学历「" + (education ?? "") + "」"))
            evidence.addRaw(jsonQuote("目标「" + (targetJob ?? "") + "」"))
            /* answerCount from answers array */
            var answerCount: Int64 = 0
            match (answers) {
                case Some(a) =>
                    match (jsonParse(a)) {
                        case Some(av) =>
                            if (isJsArray(av)) { answerCount = av.asArray().size() }
                        case None => ()
                    }
                case None => ()
            }
            let evidence4 = if (isQuick) { "背景先验 → 六维起点" } else { "六维自评 + 理论自测 " + answerCount.toString() + " 题" }
            evidence.addRaw(jsonQuote(evidence4))

            /* scores JSON */
            let scoresJson = match (scoresRaw) { case Some(s) => s case None => "{}" }

            /* blindSpots JSON */
            let bsArr = JsonArrWriter()
            for (bs in blindSpots) { bsArr.addRaw(jsonQuote(bs)) }

            /* ForgeResponse */
            let w = JsonWriter()
            w.putOptStr("name", name)
            w.putOptStr("avatar", avatar)
            w.putRaw("scores", scoresJson)
            w.putRaw("confidence", confidence.toString())
            w.putOptStr("method", method)
            w.putRaw("steps", steps.toJson())
            w.putRaw("evidence", evidence.toJson())
            w.putRaw("blindSpots", bsArr.toJson())
            w.putStr("goal", goal)
            w.putStr("diagnosisSummary", diagSummary)

            writeJson(ctx.response, 200,
                "{\"code\":0,\"message\":" + jsonQuote("success") +
                ",\"data\":" + w.toJson() +
                ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
    }
}

/* ---- POST /onboarding/diagnose ---- */

func handleDiagnose(ctx: HttpContext, cfg: AppConfig): Unit {
    match (readJsonBody(ctx)) {
        case None =>
            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请求体不是有效的 JSON 或字段类型错误")
            return
        case Some(root) =>
            let tag = jsonObjStr(root, "tag")
            let education = jsonObjStr(root, "education")
            let targetJob = jsonObjStr(root, "targetJob")
            let targetCategoryCode = jsonObjStr(root, "targetCategoryCode")
            let selfLevelsRaw = jsonObjRawObject(root, "selfLevels")
            let answersRaw = jsonObjRawArray(root, "answers")

            /* estimates + confidence — need DB for knowledge points */
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let b4store = LearnForgeB4Store(conn)
                        let kps = b4store.listKnowledgePointsFull()
                        conn.close()

                        /* build knowledgeMap: code → name */
                        let kpNames = HashMap<String, String>()
                        for (kp in kps) {
                            kpNames.add(kp.code, abilityName(kp.code))
                        }

                        /* parse selfLevels */
                        var selfLevels = HashMap<String, Int64>()
                        match (selfLevelsRaw) {
                            case Some(sr) =>
                                match (jsonParse(sr)) {
                                    case Some(sv) =>
                                        if (isJsObject(sv)) {
                                            for ((k, v) in sv.asObject().getFields()) {
                                                match (v.kind()) {
                                                    case JsonKind.JsInt =>
                                                        selfLevels.add(k, v.asInt().getValue())
                                                    case _ => ()
                                                }
                                            }
                                        }
                                    case None => ()
                                }
                            case None => ()
                        }

                        /* parse answers */
                        var answerList = ArrayList<JsonValue>()
                        match (answersRaw) {
                            case Some(ar) =>
                                match (jsonParse(ar)) {
                                    case Some(av) =>
                                        if (isJsArray(av)) {
                                            let aa = av.asArray()
                                            var i: Int64 = 0
                                            while (i < aa.size()) {
                                                match (aa.get(i)) {
                                                    case Some(item) => answerList.add(item)
                                                    case None => ()
                                                }
                                                i += 1
                                            }
                                        }
                                    case None => ()
                                }
                            case None => ()
                        }

                        /* estimates */
                        let questions = loadQuizQuestions()
                        let estimates = computeEstimates(kpNames, tag, education, selfLevels, answerList, questions)
                        let confidence = computeConfidence(kpNames, selfLevels, answerList, questions)
                        let avg = averageOf(confidence)

                        /* sort estimates by value ascending */
                        let sorted = sortByValue(estimates)
                        let n = sorted.size
                        var strongestName = "知识理解"
                        var weakestName = "知识理解"
                        var strongestScore: Int64 = 50
                        var weakestScore: Int64 = 50
                        if (n > 0) {
                            strongestName = abilityName(sorted[n - 1][0])
                            weakestName = abilityName(sorted[0][0])
                            strongestScore = sorted[n - 1][1]
                            weakestScore = sorted[0][1]
                        }
                        let blindSpots = ArrayList<String>()
                        var bi: Int64 = 0
                        while (bi < n && bi < 2) {
                            blindSpots.add(abilityName(sorted[bi][0]))
                            bi += 1
                        }
                        let weakest = if (blindSpots.size > 0) { blindSpots.get(0) ?? "短板" } else { "短板" }
                        let goal = goalText(targetCategoryCode, weakest, targetJob)
                        let diagSummary = diagnosisSummaryText(strongestName, strongestScore, weakestName, weakestScore)

                        /* build response */
                        let w = JsonWriter()
                        w.putRaw("scores", kvToJson(estimates))
                        w.putRaw("confidence", kvToJson(confidence))
                        w.putRaw("averageConfidence", avg.toString())
                        let bsArr = JsonArrWriter()
                        for (bs in blindSpots) { bsArr.addRaw(jsonQuote(bs)) }
                        w.putRaw("blindSpots", bsArr.toJson())
                        w.putStr("goal", goal)
                        w.putStr("diagnosisSummary", diagSummary)

                        writeJson(ctx.response, 200,
                            "{\"code\":0,\"message\":" + jsonQuote("success") +
                            ",\"data\":" + w.toJson() +
                            ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

/* ---- POST /onboarding/answer ---- */

func handleAnswer(ctx: HttpContext, cfg: AppConfig): Unit {
    match (readJsonBody(ctx)) {
        case None =>
            writeApiErr(ctx.response, 400, CODE_VALIDATION_FAILED, "请求体不是有效的 JSON 或字段类型错误")
            return
        case Some(root) =>
            let tag = jsonObjStr(root, "tag")
            let education = jsonObjStr(root, "education")
            let targetJob = jsonObjStr(root, "targetJob")
            let selfLevelsRaw = jsonObjRawObject(root, "selfLevels")
            let answersRaw = jsonObjRawArray(root, "answers")
            let queueIdsRaw = jsonObjRawArray(root, "queueIds")

            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let b4store = LearnForgeB4Store(conn)
                        let kps = b4store.listKnowledgePointsFull()
                        conn.close()
                        let kpNames = HashMap<String, String>()
                        for (kp in kps) {
                            kpNames.add(kp.code, abilityName(kp.code))
                        }
                        var selfLevels = HashMap<String, Int64>()
                        match (selfLevelsRaw) {
                            case Some(sr) =>
                                match (jsonParse(sr)) {
                                    case Some(sv) =>
                                        if (isJsObject(sv)) {
                                            for ((k, v) in sv.asObject().getFields()) {
                                                match (v.kind()) {
                                                    case JsonKind.JsInt =>
                                                        selfLevels.add(k, v.asInt().getValue())
                                                    case _ => ()
                                                }
                                            }
                                        }
                                    case None => ()
                                }
                            case None => ()
                        }
                        var answerList = ArrayList<JsonValue>()
                        match (answersRaw) {
                            case Some(ar) =>
                                match (jsonParse(ar)) {
                                    case Some(av) =>
                                        if (isJsArray(av)) {
                                            let aa = av.asArray()
                                            var i: Int64 = 0
                                            while (i < aa.size()) {
                                                match (aa.get(i)) {
                                                    case Some(item) => answerList.add(item)
                                                    case None => ()
                                                }
                                                i += 1
                                            }
                                        }
                                    case None => ()
                                }
                            case None => ()
                        }

                        let questions = loadQuizQuestions()
                        let estimates = computeEstimates(kpNames, tag, education, selfLevels, answerList, questions)
                        let confidence = computeConfidence(kpNames, selfLevels, answerList, questions)
                        let avg = averageOf(confidence)

                        /* comment + nextQuestion from last answer (Java answer:193-210) */
                        var comment = ""
                        var nextQuestion = "null"
                        var nextReason = "null"
                        var quizDone = "true"
                        if (answerList.size > 0) {
                            match (answerList.get(answerList.size - 1)) {
                                case Some(lastA) =>
                                    if (isJsObject(lastA)) {
                                        let lastQId = jsonObjStr(lastA, "questionId") ?? ""
                                        let lastResult = jsonObjStr(lastA, "result") ?? ""
                                        match (findQuizQ(questions, lastQId)) {
                                            case Some(q) =>
                                                let est = estimates.get(q.kpId) ?? 50
                                                comment = commentOf(q.level, q.kpId, lastResult, est)
                                                let queueIds = parseStrArray(queueIdsRaw)
                                                match (maybeEnqueue(targetJob, selfLevels, answerList, queueIds, questions)) {
                                                    case Some((qRaw, rsn)) =>
                                                        nextQuestion = qRaw
                                                        nextReason = jsonQuote(rsn)
                                                        quizDone = "false"
                                                    case None => ()
                                                }
                                            case None => ()
                                        }
                                    }
                                case None => ()
                            }
                        }

                        let w = JsonWriter()
                        w.putRaw("estimates", kvToJson(estimates))
                        w.putRaw("confidence", kvToJson(confidence))
                        w.putRaw("averageConfidence", avg.toString())
                        w.putStr("comment", comment)
                        w.putRaw("nextQuestion", nextQuestion)
                        w.putRaw("nextReason", nextReason)
                        w.putRaw("quizDone", quizDone)

                        writeJson(ctx.response, 200,
                            "{\"code\":0,\"message\":" + jsonQuote("success") +
                            ",\"data\":" + w.toJson() +
                            ",\"timestamp\":" + jsonQuote(isoUtcNowZ()) + "}")
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

/* ---- quiz-bank question lookup (id → kpId, level, raw JSON) ---- */

struct QuizQ {
    let id: String
    let kpId: String
    let level: String
    let raw: String

    init(id: String, kpId: String, level: String, raw: String) {
        this.id = id; this.kpId = kpId; this.level = level; this.raw = raw
    }
}

func loadQuizQuestions(): Array<QuizQ> {
    let out = ArrayList<QuizQ>()
    match (jsonParse(loadQuizBank())) {
        case Some(v) =>
            if (isJsArray(v)) {
                let arr = v.asArray()
                var i: Int64 = 0
                while (i < arr.size()) {
                    match (arr.get(i)) {
                        case Some(item) =>
                            if (isJsObject(item)) {
                                let o = item.asObject()
                                out.add(QuizQ(
                                    jsonGetString(o, "id") ?? "",
                                    jsonGetString(o, "kpId") ?? "",
                                    jsonGetString(o, "level") ?? "",
                                    valueToRaw(item)))
                            }
                        case None => ()
                    }
                    i += 1
                }
            }
        case None => ()
    }
    return out.toArray()
}

func findQuizQ(questions: Array<QuizQ>, qid: String): ?QuizQ {
    for (q in questions) {
        if (q.id == qid) { return Some(q) }
    }
    return None
}

func containsStr(arr: Array<String>, s: String): Bool {
    for (x in arr) {
        if (x == s) { return true }
    }
    return false
}

func parseStrArray(raw: ?String): ArrayList<String> {
    let out = ArrayList<String>()
    match (raw) {
        case Some(r) =>
            match (jsonParse(r)) {
                case Some(v) =>
                    if (isJsArray(v)) {
                        let arr = v.asArray()
                        var i: Int64 = 0
                        while (i < arr.size()) {
                            match (arr.get(i)) {
                                case Some(item) =>
                                    match (item.kind()) {
                                        case JsonKind.JsString => out.add(item.asString().getValue())
                                        case _ => ()
                                    }
                                case None => ()
                            }
                            i += 1
                        }
                    }
                case None => ()
            }
        case None => ()
    }
    return out
}

/*
 * answerDelta (OnboardingAssessmentService:349-365):
 *   correct: basic+10, advanced+14, other+18
 *   wrong:   basic-10, other-6
 *   else:    -6
 *   attribution "concept" -3, "careless" +5
 */
func answerDelta(level: String, resultStr: String, attribution: String): Int64 {
    var delta: Int64 = 0
    if (resultStr == "correct") {
        if (level == "basic") { delta = 10 }
        else if (level == "advanced") { delta = 14 }
        else { delta = 18 }
    } else if (resultStr == "wrong") {
        if (level == "basic") { delta = -10 }
        else { delta = -6 }
    } else {
        delta = -6
    }
    if (attribution == "concept") { delta -= 3 }
    if (attribution == "careless") { delta += 5 }
    return delta
}

/* commentOf (OnboardingAssessmentService:336-347) */
func commentOf(level: String, kpId: String, resultStr: String, estimate: Int64): String {
    let kp = abilityName(kpId)
    var levelLabel = "挑战"
    if (level == "basic") { levelLabel = "基础" }
    else if (level == "advanced") { levelLabel = "进阶" }
    if (resultStr == "uncertain") {
        return "诚实比蒙对更有用——「" + kp + "」我先按偏弱记，之后再核。"
    }
    return levelLabel + "题已完成，「" + kp + "」当前估计 " + estimate.toString() + " 分。"
}

/* priorityAbilities (OnboardingAssessmentService:381-387) */
func priorityAbilities(targetJob: ?String): Array<String> {
    match (targetJob) {
        case None => return ["kp-os", "kp-agent"]
        case Some(j) =>
            if (j.contains("RAG")) { return ["kp-ds", "kp-db", "kp-network"] }
            if (j.contains("多智能体")) { return ["kp-co", "kp-db", "kp-network"] }
            if (j.contains("平台")) { return ["kp-db", "kp-network", "kp-os"] }
            return ["kp-os", "kp-agent", "kp-co"]
    }
}

func selfLevelOf(kpId: String, selfLevels: HashMap<String, Int64>): Int64 {
    return selfLevels.get(kpId) ?? 2
}

/*
 * maybeEnqueue (OnboardingAssessmentService:283-334).
 * Returns Some((questionRawJson, reason)) or None.
 * MAX_TOTAL=14, MAX_EXTRA_PER_KP=2.
 */
func maybeEnqueue(targetJob: ?String, selfLevels: HashMap<String, Int64>,
                   answers: ArrayList<JsonValue>, queueIds: ArrayList<String>,
                   questions: Array<QuizQ>): ?(String, String) {
    if (answers.size == 0) { return None }
    if (queueIds.size >= 14) { return None }
    match (answers.get(answers.size - 1)) {
        case None => return None
        case Some(last) =>
            if (!isJsObject(last)) { return None }
            let lastQId = jsonObjStr(last, "questionId") ?? ""
            let lastResult = jsonObjStr(last, "result") ?? ""
            let lastExtra = jsonObjBool(last, "extra") ?? false
            match (findQuizQ(questions, lastQId)) {
                case None => return None
                case Some(q) =>
                    let kpId = q.kpId
                    var extraCount: Int64 = 0
                    for (a in answers) {
                        if (!isJsObject(a)) { continue }
                        if (!(jsonObjBool(a, "extra") ?? false)) { continue }
                        let aQId = jsonObjStr(a, "questionId") ?? ""
                        match (findQuizQ(questions, aQId)) {
                            case Some(aq) =>
                                if (aq.kpId == kpId) { extraCount += 1 }
                            case None => ()
                        }
                    }
                    if (extraCount >= 2) { return None }
                    var level = ""
                    var reason = ""
                    if (lastResult == "wrong" && !lastExtra) {
                        level = "basic"
                        reason = "「" + abilityName(kpId) + "」答错了，我再确认一道"
                    } else if (lastResult == "uncertain") {
                        level = "basic"
                        reason = "不确定没关系，「" + abilityName(kpId) + "」换道题再试"
                    } else if (lastResult == "correct" && selfLevelOf(kpId, selfLevels) >= 3 && !lastExtra) {
                        level = "advanced"
                        reason = "你自评较高，上道进阶题验证"
                    } else if (lastResult == "correct" && !lastExtra
                               && containsStr(priorityAbilities(targetJob), kpId)) {
                        level = "advanced"
                        reason = "「" + abilityName(kpId) + "」是「" + (targetJob ?? "") + "」的重点能力，多测一道进阶题"
                    }
                    if (level.size == 0) { return None }
                    var next: ?QuizQ = None
                    var fallback: ?QuizQ = None
                    for (item in questions) {
                        if (item.kpId != kpId) { continue }
                        var used = false
                        for (u in queueIds) {
                            if (u == item.id) { used = true; break }
                        }
                        if (used) { continue }
                        match (fallback) {
                            case None => fallback = Some(item)
                            case Some(_) => ()
                        }
                        if (item.level == level) {
                            match (next) {
                                case None => next = Some(item)
                                case Some(_) => ()
                            }
                        }
                    }
                    match (next) {
                        case Some(n) => return Some((n.raw, reason))
                        case None =>
                            match (fallback) {
                                case Some(f) => return Some((f.raw, reason))
                                case None => return None
                            }
                    }
            }
    }
}

/* ---- shared scoring helpers ---- */

/*
 * estimates: for each kp, 50 + prior(tag,edu) + round(self*0.4)
 * self = selfScore(level) - 50; selfScore = 20 + level*15
 * then per-answer answerDelta, clampScore: max(20, min(92, value))
 */
func computeEstimates(kpNames: HashMap<String, String>, tag: ?String, education: ?String,
                       selfLevels: HashMap<String, Int64>,
                       answers: ArrayList<JsonValue>, questions: Array<QuizQ>): HashMap<String, Int64> {
    let result = HashMap<String, Int64>()
    for (kpId in kpNames.keys()) {
        let level = selfLevels.get(kpId) ?? 2
        let self = (20 + level * 15) - 50
        let prior = priorOf(tag, education, kpId)
        var estimate = 50 + prior + javaMathRound(Float64(self) * 0.4)
        estimate = clampScore(estimate)
        result.add(kpId, estimate)
    }
    for (a in answers) {
        if (!isJsObject(a)) { continue }
        let qId = jsonObjStr(a, "questionId") ?? ""
        let resultStr = jsonObjStr(a, "result") ?? ""
        let attribution = jsonObjStr(a, "attribution") ?? ""
        match (findQuizQ(questions, qId)) {
            case Some(q) =>
                let current = result.get(q.kpId) ?? 50
                let updated = clampScore(current + answerDelta(q.level, resultStr, attribution))
                result.remove(q.kpId)
                result.add(q.kpId, updated)
            case None => ()
        }
    }
    return result
}

/*
 * confidence: initial 33 per kp; each answer adds +8 (uncertain) / +18 (basic)
 * / +22 (other), +4 if attribution non-blank, cap 92.
 */
func computeConfidence(kpNames: HashMap<String, String>,
                        selfLevels: HashMap<String, Int64>,
                        answers: ArrayList<JsonValue>, questions: Array<QuizQ>): HashMap<String, Int64> {
    let result = HashMap<String, Int64>()
    for (kpId in kpNames.keys()) {
        result.add(kpId, 33)
    }
    for (a in answers) {
        if (!isJsObject(a)) { continue }
        let qId = jsonObjStr(a, "questionId") ?? ""
        let resultStr = jsonObjStr(a, "result") ?? ""
        let attribution = jsonObjStr(a, "attribution") ?? ""
        match (findQuizQ(questions, qId)) {
            case Some(q) =>
                var base: Int64 = 22
                if (resultStr == "uncertain") { base = 8 }
                else if (q.level == "basic") { base = 18 }
                if (attribution.trimAscii().size > 0) { base += 4 }
                let current = result.get(q.kpId) ?? 33
                var updated = current + base
                if (updated > 92) { updated = 92 }
                result.remove(q.kpId)
                result.add(q.kpId, updated)
            case None => ()
        }
    }
    return result
}

func priorOf(tag: ?String, education: ?String, kpId: String): Int64 {
    var prior: Int64 = 0
    /* TAG_PRIOR */
    match (tag) {
        case Some(t) =>
            if (t == "在校学生") {
                if (kpId == "kp-ds") { prior += 4 } else if (kpId == "kp-co") { prior += 2 }
                else if (kpId == "kp-os") { prior += 1 } else if (kpId == "kp-network") { prior += 1 }
                else if (kpId == "kp-db") { prior += 0 } else if (kpId == "kp-agent") { prior += -1 }
            } else if (t == "应届毕业生") {
                if (kpId == "kp-ds") { prior += 8 } else if (kpId == "kp-co") { prior += 5 }
                else if (kpId == "kp-network") { prior += 4 } else if (kpId == "kp-os") { prior += 3 }
                else if (kpId == "kp-db") { prior += 2 } else if (kpId == "kp-agent") { prior += -2 }
            } else if (t == "职场新人（1-3年）") {
                if (kpId == "kp-network") { prior += 5 } else if (kpId == "kp-db") { prior += 4 }
                else if (kpId == "kp-os") { prior += 3 } else if (kpId == "kp-ds") { prior += 1 }
            } else if (t == "中级工程师（3-5年）") {
                if (kpId == "kp-network") { prior += 8 } else if (kpId == "kp-db") { prior += 6 }
                else if (kpId == "kp-os") { prior += 5 } else if (kpId == "kp-ds") { prior += -1 }
                else if (kpId == "kp-agent") { prior += 1 }
            } else if (t == "高级工程师（5年+）") {
                if (kpId == "kp-network") { prior += 10 } else if (kpId == "kp-db") { prior += 9 }
                else if (kpId == "kp-os") { prior += 8 } else if (kpId == "kp-agent") { prior += 2 }
            } else if (t == "转岗/跨领域") {
                if (kpId == "kp-network") { prior += 6 } else if (kpId == "kp-db") { prior += 4 }
                else if (kpId == "kp-os") { prior += 3 } else if (kpId == "kp-agent") { prior += -2 }
                else if (kpId == "kp-ds") { prior += -3 }
            }
        case None => ()
    }
    /* EDU_PRIOR */
    match (education) {
        case Some(ed) =>
            if (ed == "初中及以下") {
                if (kpId == "kp-ds") { prior += -6 } else if (kpId == "kp-co") { prior += -4 }
            } else if (ed == "高中") {
                if (kpId == "kp-ds") { prior += -3 } else if (kpId == "kp-co") { prior += -2 }
            } else if (ed == "大专") {
                if (kpId == "kp-network") { prior += 3 } else if (kpId == "kp-db") { prior += 1 }
            } else if (ed == "本科") {
                if (kpId == "kp-ds") { prior += 3 } else if (kpId == "kp-co") { prior += 1 }
                else if (kpId == "kp-os") { prior += 1 }
            } else if (ed == "硕士") {
                if (kpId == "kp-ds") { prior += 6 } else if (kpId == "kp-agent") { prior += 4 }
                else if (kpId == "kp-co") { prior += 2 }
            } else if (ed == "博士") {
                if (kpId == "kp-ds") { prior += 8 } else if (kpId == "kp-agent") { prior += 6 }
                else if (kpId == "kp-co") { prior += 4 }
            }
        case None => ()
    }
    return prior
}

func clampScore(v: Int64): Int64 {
    if (v < 20) { return 20 }
    if (v > 92) { return 92 }
    return v
}

func stepJson(text: String, detail: String): String {
    let w = JsonWriter()
    w.putStr("text", text)
    w.putStr("detail", detail)
    w.toJson()
}

func kvToJson(map: HashMap<String, Int64>): String {
    let w = JsonWriter()
    for (k in map.keys()) {
        w.putRaw(k, (map.get(k) ?? 0).toString())
    }
    w.toJson()
}

func sortByValue(map: HashMap<String, Int64>): Array<(String, Int64)> {
    let arr = ArrayList<(String, Int64)>()
    for (k in map.keys()) {
        arr.add((k, map.get(k) ?? 0))
    }
    let a = arr.toArray()
    let n = a.size
    var sorted = Array<(String, Int64)>(n, repeat: ("", 0i64))
    var i: Int64 = 0
    while (i < n) { sorted[i] = a[i]; i += 1 }
    var k: Int64 = 1
    while (k < n) {
        let cur = sorted[k]
        var j = k - 1
        while (j >= 0 && sorted[j][1] > cur[1]) {
            sorted[j + 1] = sorted[j]
            j -= 1
        }
        sorted[j + 1] = cur
        k += 1
    }
    return sorted
}

func averageOf(map: HashMap<String, Int64>): Int64 {
    if (map.size == 0) { return 0 }
    var sum: Int64 = 0
    for (k in map.keys()) {
        sum += map.get(k) ?? 0
    }
    return javaMathRound(Float64(sum) / Float64(map.size))
}
