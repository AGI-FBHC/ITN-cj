package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * P2 batch 3: growth + report + knowledge-graph reads.
 *   GET /api/v1/learner-profile/growth
 *   GET /api/v1/learner-profile/report
 *   GET /api/v1/knowledge-graph
 *
 * Contract: LearnForgeSupportController.java:66-101,
 * LearnForgeSupportService.java:124-213.
 *
 * growth() auto-creates a GrowthState row when absent. If no learner exists,
 * ensureFromProfile() seeds one from user_profiles (W2). report() wraps
 * learner + overall + blindSpots + pathRoadmap + growth.
 */

public func registerGrowthRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("api/v1/learner-profile/growth") {
        ctx => handleGrowth(ctx, cfg)
    }
    app.mapGet("api/v1/learner-profile/report") {
        ctx => handleReport(ctx, cfg)
    }
    app.mapGet("api/v1/knowledge-graph") {
        ctx => handleKnowledgeGraph(ctx, cfg)
    }
}

/* ---- resolveLearner (mirrors LearnForgeSupportService.resolveLearner) ---- */

func resolveLearnerId(store: LearnForgeStore, userId: Array<Byte>,
                      rawLearnerId: ?String): ?Array<Byte> {
    match (rawLearnerId) {
        case Some(raw) =>
            let trimmed = raw.trimAscii()
            if (trimmed.size == 0) {
                return firstOrCreateLearner(store, userId)
            }
            match (uuidParse(trimmed)) {
                case None => return None
                case Some(lid) =>
                    match (store.getByUser(userId, lid)) {
                        case None => return None
                        case Some(_) => return Some(lid)
                    }
            }
        case None => return firstOrCreateLearner(store, userId)
    }
}

/* First learner by created_at ASC, or create from profile. */
func firstOrCreateLearner(store: LearnForgeStore, userId: Array<Byte>): ?Array<Byte> {
    match (store.firstLearnerId(userId)) {
        case Some(id) => return Some(id)
        case None => return Some(ensureLearnerFromProfile(store, userId))
    }
}

/*
 * ensureFromProfile — create a learner row from user_profiles if none exists.
 * Name priority: profile.name > user.nickname > "学习者".
 * scores_json = profile.self_assessment_json (or "{}").
 */
func ensureLearnerFromProfile(store: LearnForgeStore, userId: Array<Byte>): Array<Byte> {
    let learnerId = uuidV4()
    var name = "学习者"
    var scoresJson = "{}"
    match (store.getProfileByUser(userId)) {
        case Some(p) =>
            match (p.name) {
                case Some(n) =>
                    if (n.trimAscii().size > 0) { name = n }
                case None => ()
            }
            match (p.selfAssessmentJson) {
                case Some(s) => scoresJson = s
                case None => ()
            }
        case None => ()
    }
    store.insertLearnerDefault(learnerId, userId, name, scoresJson)
    return learnerId
}

/* ---- GrowthResponse JSON ---- */

func growthJson(gstore: LearnForgeGrowthStore, userId: Array<Byte>,
                learnerId: Array<Byte>): String {
    /* auto-create GrowthState if absent */
    var state = gstore.getGrowthState(userId, learnerId)
    match (state) {
        case None =>
            gstore.insertGrowthState(userId, learnerId)
            state = gstore.getGrowthState(userId, learnerId)
        case Some(_) => ()
    }
    let events = gstore.listGrowthEvents(userId, learnerId, 30)
    let w = JsonWriter()
    match (state) {
        case Some(s) =>
            w.putRaw("orb", s.orb.toString())
            w.putRaw("watered", s.watered.toString())
            w.putOptStr("stage", s.stage)
        case None =>
            w.putRaw("orb", "0")
            w.putRaw("watered", "0")
            w.putOptStr("stage", "seed")
    }
    let arr = JsonArrWriter()
    for (e in events) {
        let ew = JsonWriter()
        ew.putStr("eventType", e.eventType)
        ew.putStr("title", e.title)
        ew.putRaw("amount", e.amount.toString())
        ew.putRaw("createdAt", jsonQuote(isoInstantFromDb(e.createdAtUtc)))
        arr.addRaw(ew.toJson())
    }
    w.putRaw("events", arr.toJson())
    return w.toJson()
}

/* ---- GET /api/v1/learner-profile/growth ---- */

func handleGrowth(ctx: HttpContext, cfg: AppConfig): Unit {
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
                                let body = growthJson(gstore, userId, learnerId)
                                conn.close()
                                writeJson(ctx.response, 200, apiOk(body))
                        }
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

/* ---- GET /api/v1/knowledge-graph ---- */

func handleKnowledgeGraph(ctx: HttpContext, cfg: AppConfig): Unit {
    match (openDb(cfg)) {
        case None =>
            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
        case Some(conn) =>
            try {
                let gstore = LearnForgeGrowthStore(conn)
                let body = knowledgeGraphJson(gstore)
                conn.close()
                writeJson(ctx.response, 200, apiOk(body))
            } catch (e: Exception) {
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

/*
 * KnowledgeGraphResponse(nodes, edges).
 * nodes = KnowledgePoint(code, name, enName, targetLevel, coverage, weight).
 * edges = one per prerequisite code in prerequisites_json.
 */
func knowledgeGraphJson(gstore: LearnForgeGrowthStore): String {
    let points = gstore.listKnowledgePoints()
    let nodes = JsonArrWriter()
    let edges = JsonArrWriter()
    for (p in points) {
        let nw = JsonWriter()
        nw.putStr("id", p.code)
        nw.putStr("name", p.name)
        nw.putOptStr("enName", p.enName)
        nw.putRaw("targetLevel", p.targetLevel.toString())
        nw.putRaw("coverage", p.coverage.toString())
        match (p.weight) {
            case Some(t) =>
                match (javaDoubleFromText(t)) {
                    case Some(v) => nw.putRaw("weight", javaDoubleText(v))
                    case None => nw.putRaw("weight", "0.0")
                }
            case None => nw.putRaw("weight", "0.0")
        }
        nodes.addRaw(nw.toJson())
        /* edges from prerequisites_json */
        let prereqs = jsonStringArray(p.prerequisitesJson)
        match (jsonParse(prereqs)) {
            case Some(arrv) =>
                if (isJsArray(arrv)) {
                    let a = arrv.asArray()
                    var i: Int64 = 0
                    while (i < a.size()) {
                        match (a.get(i)) {
                            case Some(item) =>
                                if (isJsString(item)) {
                                    let ew = JsonWriter()
                                    ew.putStr("source", p.code)
                                    ew.putStr("target", item.asString().getValue())
                                    ew.putStr("type", "requires")
                                    edges.addRaw(ew.toJson())
                                }
                            case None => ()
                        }
                        i += 1
                    }
                }
            case None => ()
        }
    }
    let w = JsonWriter()
    w.putRaw("nodes", nodes.toJson())
    w.putRaw("edges", edges.toJson())
    return w.toJson()
}

/* ---- GET /api/v1/learner-profile/report ---- */

/*
 * report = {learner, overall, blindSpots, pathRoadmap, growth}
 * learner is the full LearnerResponse (same as GET /learners/{id}).
 * overall is learner.overallMastery() (BigDecimal scale 0 or 1).
 * pathRoadmap is knowledgeGraph().edges().
 */
func handleReport(ctx: HttpContext, cfg: AppConfig): Unit {
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
                                match (store.getByUser(userId, learnerId)) {
                                    case None =>
                                        conn.close()
                                        writeApiErr(ctx.response, 404, CODE_LEARNER_NOT_FOUND, "学习者不存在")
                                    case Some(row) =>
                                        let kpCodes = store.enabledKnowledgePointCodes()
                                        let learnerJsonStr = learnerToJson(row, kpCodes)
                                        let scores = resolveScores(row.scoresJson, kpCodes)
                                        let overallJson = overallMasteryJson(scores)
                                        let blindJson = jsonStringArray(row.blindSpotsJson)
                                        let growthStr = growthJson(gstore, userId, learnerId)
                                        /* pathRoadmap = knowledgeGraph().edges() */
                                        let gstore2 = LearnForgeGrowthStore(conn)
                                        let points = gstore2.listKnowledgePoints()
                                        let edges = JsonArrWriter()
                                        for (p in points) {
                                            let prereqs = jsonStringArray(p.prerequisitesJson)
                                            match (jsonParse(prereqs)) {
                                                case Some(av) =>
                                                    if (isJsArray(av)) {
                                                        let a = av.asArray()
                                                        var i: Int64 = 0
                                                        while (i < a.size()) {
                                                            match (a.get(i)) {
                                                                case Some(item) =>
                                                                    if (isJsString(item)) {
                                                                        let ew = JsonWriter()
                                                                        ew.putStr("source", p.code)
                                                                        ew.putStr("target", item.asString().getValue())
                                                                        ew.putStr("type", "requires")
                                                                        edges.addRaw(ew.toJson())
                                                                    }
                                                                case None => ()
                                                            }
                                                            i += 1
                                                        }
                                                    }
                                                case None => ()
                                            }
                                        }
                                        conn.close()
                                        let w = JsonWriter()
                                        w.putRaw("learner", learnerJsonStr)
                                        w.putRaw("overall", overallJson)
                                        w.putRaw("blindSpots", blindJson)
                                        w.putRaw("pathRoadmap", edges.toJson())
                                        w.putRaw("growth", growthStr)
                                        writeJson(ctx.response, 200, apiOk(w.toJson()))
                                }
                        }
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}
