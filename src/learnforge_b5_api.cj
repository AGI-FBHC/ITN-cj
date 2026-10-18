package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import std.fs.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * P2 batch 5: onboarding reads.
 *   GET /api/v1/onboarding/meta
 *   GET /api/v1/onboarding/target-categories
 *   GET /api/v1/onboarding/targets
 *   GET /api/v1/onboarding/jobs
 *
 * Contract: OnboardingController.java:34-52, OnboardingAssessmentService.java.
 * /targets and /jobs return the same targetOptions().
 * meta() combines knowledge_points + static lists + target_categories +
 * target_options + questions from onboarding/quiz-bank.json.
 *
 * The 3 pure-computation POSTs (answer/generate-profile/diagnose) are NOT
 * in this batch — they require the full scoring algorithm port.
 */

/* onboarding/quiz-bank.json — read at startup and cached. */
let ONBOARDING_QUESTIONS: ?String = None

/* Static lists from OnboardingAssessmentService */
let TAGS_LIST: Array<String> = [
    "在校学生", "应届毕业生", "职场新人（1-3年）", "中级工程师（3-5年）",
    "高级工程师（5年+）", "转岗/跨领域", "自由学习者"]
let EDU_LIST: Array<String> = ["初中及以下", "高中", "大专", "本科", "硕士", "博士"]
let STYLES_LIST: Array<String> = [
    "理论先行", "实操驱动", "图示学习", "案例迁移", "步骤清单",
    "碎片化学习", "视频演示", "项目实战", "同伴讨论"]
let SELF_LEVELS_LIST: Array<String> = ["未接触", "需要指导", "可独立完成", "能处理复杂情况", "能指导他人"]

public func registerOnboardingRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("api/v1/onboarding/meta") {
        ctx => handleMeta(ctx, cfg)
    }
    app.mapGet("api/v1/onboarding/target-categories") {
        ctx => handleTargetCategories(ctx, cfg)
    }
    app.mapGet("api/v1/onboarding/targets") {
        ctx => handleTargetOptions(ctx, cfg)
    }
    app.mapGet("api/v1/onboarding/jobs") {
        ctx => handleTargetOptions(ctx, cfg)
    }
}

/* ---- TargetCategory ---- */

func targetCategoryToJson(id: Int64, code: String, name: String,
                           description: ?String, sortOrder: Int64, enabled: Bool): String {
    let w = JsonWriter()
    w.putRaw("id", id.toString())
    w.putStr("code", code)
    w.putStr("name", name)
    w.putOptStr("description", description)
    w.putRaw("sortOrder", sortOrder.toString())
    w.putRaw("enabled", if (enabled) { "true" } else { "false" })
    return w.toJson()
}

func handleTargetCategories(ctx: HttpContext, cfg: AppConfig): Unit {
    match (openDb(cfg)) {
        case None => writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
        case Some(conn) =>
            try {
                let rows = queryTargetCategories(conn)
                conn.close()
                writeJson(ctx.response, 200, apiOk(rows))
            } catch (e: Exception) {
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

func queryTargetCategories(conn: MyConnection): String {
    let sql = "SELECT id, code, name, description, sort_order, status" +
        " FROM target_categories WHERE status=1 ORDER BY sort_order ASC, id ASC"
    let arr = JsonArrWriter()
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => ()
        case QueryOutcome.ResultSet(rs) =>
            for (row in rs.rows) {
                let id = optCellInt(row, 0) ?? 0
                let enabled = cellText(row, 5) == "1"
                arr.addRaw(targetCategoryToJson(id, cellText(row, 1), cellText(row, 2),
                    optCellText(row, 3), optCellInt(row, 4) ?? 0, enabled))
            }
    }
    arr.toJson()
}

/* ---- TargetOption (targets / jobs) ---- */

func targetOptionToJson(id: Int64, code: String, categoryCode: ?String, name: String,
                         description: ?String, sortOrder: Int64, enabled: Bool): String {
    let w = JsonWriter()
    w.putRaw("id", id.toString())
    w.putStr("code", code)
    w.putOptStr("categoryCode", categoryCode)
    w.putStr("name", name)
    w.putOptStr("description", description)
    w.putRaw("sortOrder", sortOrder.toString())
    w.putRaw("enabled", if (enabled) { "true" } else { "false" })
    return w.toJson()
}

func handleTargetOptions(ctx: HttpContext, cfg: AppConfig): Unit {
    match (openDb(cfg)) {
        case None => writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
        case Some(conn) =>
            try {
                let rows = queryTargetOptions(conn)
                conn.close()
                writeJson(ctx.response, 200, apiOk(rows))
            } catch (e: Exception) {
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

func queryTargetOptions(conn: MyConnection): String {
    let sql = "SELECT id, code, category_code, name, description, sort_order, status" +
        " FROM target_options WHERE status=1 ORDER BY sort_order ASC, id ASC"
    let arr = JsonArrWriter()
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => ()
        case QueryOutcome.ResultSet(rs) =>
            for (row in rs.rows) {
                let id = optCellInt(row, 0) ?? 0
                let enabled = cellText(row, 6) == "1"
                arr.addRaw(targetOptionToJson(id, cellText(row, 1), optCellText(row, 2),
                    cellText(row, 3), optCellText(row, 4), optCellInt(row, 5) ?? 0, enabled))
            }
    }
    arr.toJson()
}

/* ---- Meta ---- */

/*
 * Meta(knowledgePoints, tags, edu, targetCategories, targetOptions,
 *      styles, selfLevels, questions)
 *
 * knowledgePoints from knowledge_point table; tags/edu/styles/selfLevels are
 * static lists; targetCategories/targetOptions from DB; questions from
 * onboarding/quiz-bank.json (classpath resource in Java, file in Spire).
 */
func handleMeta(ctx: HttpContext, cfg: AppConfig): Unit {
    match (openDb(cfg)) {
        case None => writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
        case Some(conn) =>
            try {
                let kpJson = queryKnowledgePointMetas(conn)
                let tcJson = queryTargetCategories(conn)
                let toJson = queryTargetOptions(conn)
                conn.close()
                let questionsJson = loadQuizBank()
                let w = JsonWriter()
                w.putRaw("knowledgePoints", kpJson)
                w.putRaw("tags", jsonStringArray(TAGS_LIST))
                w.putRaw("edu", jsonStringArray(EDU_LIST))
                w.putRaw("targetCategories", tcJson)
                w.putRaw("targetOptions", toJson)
                w.putRaw("styles", jsonStringArray(STYLES_LIST))
                w.putRaw("selfLevels", jsonStringArray(SELF_LEVELS_LIST))
                w.putRaw("questions", questionsJson)
                writeJson(ctx.response, 200, apiOk(w.toJson()))
            } catch (e: Exception) {
                writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
            }
    }
}

func queryKnowledgePointMetas(conn: MyConnection): String {
    let sql = "SELECT code, name, en_name, weight, target_level, coverage," +
        " description, core_topics_json FROM knowledge_point" +
        " WHERE status=1 ORDER BY sort_order ASC, id ASC"
    let arr = JsonArrWriter()
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => ()
        case QueryOutcome.ResultSet(rs) =>
            for (row in rs.rows) {
                let code = cellText(row, 0)
                let w = JsonWriter()
                w.putStr("id", code)
                w.putStr("name", abilityName(code))
                w.putOptStr("en", optCellText(row, 2))
                match (optCellText(row, 3)) {
                    case Some(t) =>
                        match (javaDoubleFromText(t)) {
                            case Some(v) => w.putRaw("weight", javaDoubleText(v))
                            case None => w.putRaw("weight", "0.0")
                        }
                    case None => w.putRaw("weight", "0.0")
                }
                w.putRaw("targetLevel", (optCellInt(row, 4) ?? 80).toString())
                w.putRaw("coverage", (optCellInt(row, 5) ?? 90).toString())
                w.putOptStr("description", optCellText(row, 6))
                w.putRaw("coreTopics", jsonStringArray(optCellText(row, 7)))
                arr.addRaw(w.toJson())
            }
    }
    arr.toJson()
}

func abilityName(kpId: String): String {
    if (kpId == "kp-ds") { return "知识理解" }
    if (kpId == "kp-co") { return "逻辑推理" }
    if (kpId == "kp-os") { return "工程实践" }
    if (kpId == "kp-network") { return "问题诊断" }
    if (kpId == "kp-db") { return "系统设计" }
    if (kpId == "kp-agent") { return "学习迁移" }
    return "综合能力"
}

/* Load onboarding/quiz-bank.json from the project resources directory. */
func loadQuizBank(): String {
    match (ONBOARDING_QUESTIONS) {
        case Some(q) => return q
        case None => ()
    }
    let paths = [
        "resources/onboarding/quiz-bank.json",
        "src/main/resources/onboarding/quiz-bank.json",
        "../resources/onboarding/quiz-bank.json",
        "D:/cangjie/zyqprojects/itn_spire/resources/onboarding/quiz-bank.json"
    ]
    for (p in paths) {
        match (readWholeFile(p)) {
            case Some(content) =>
                match (jsonParse(String.fromUtf8(content))) {
                    case Some(v) =>
                        if (isJsArray(v)) {
                            return String.fromUtf8(content)
                        }
                    case None => ()
                }
            case None => ()
        }
    }
    return "[]"
}
