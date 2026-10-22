package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * /v1 面剩下两条纯 SQL 端点（无 LLM、无流式）：
 *
 *   GET /v1/course-recommendations   首页「最近课程/课件」候选
 *   GET /v1/learning-context         目标驱动的生成上下文
 *
 * 契约来源：
 *   routers/public.py:4820-4855        course-recommendations
 *   services/goal_context.py:32-179    GoalContextService.build
 *   storage/learning_resources.py:352-381（资源可见性）
 *
 * 两个端点都是 require_user_principal 级别（/v1 面），所以走 requireUser。
 */

public func registerLearnContextRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/course-recommendations") {
        ctx => handleCourseRecommendations(ctx, cfg)
    }
    app.mapGet("v1/learning-context") {
        ctx => handleLearningContext(ctx, cfg)
    }
}

/* ==================== GET /v1/course-recommendations ==================== */

struct LcCandidate {
    let kind: String
    let id: String
    let title: String
    let courseId: ?String
    let chapterId: ?String
    let updatedAt: String

    init(kind: String, id: String, title: String, courseId: ?String,
         chapterId: ?String, updatedAt: String) {
        this.kind = kind
        this.id = id
        this.title = title
        this.courseId = courseId
        this.chapterId = chapterId
        this.updatedAt = updatedAt
    }
}

func lcCandidateJson(c: LcCandidate): String {
    let w = JsonWriter()
    w.putStr("type", c.kind)
    w.putStr("id", c.id)
    w.putStr("title", c.title)
    w.putOptStr("courseId", c.courseId)
    w.putOptStr("chapterId", c.chapterId)
    w.putStr("updatedAt", c.updatedAt)
    return w.toJson()
}

func handleCourseRecommendations(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            /* limit: Query(20, ge=1, le=50) */
            var limit: Int64 = 20
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
                            if (v > 50) {
                                writePyConstraint422(ctx.response, ["query", "limit"],
                                    "less_than_equal",
                                    "Input should be less than or equal to 50",
                                    jsonQuote(raw), "{\"le\":50}")
                                return
                            }
                            limit = v
                    }
            }
            lcLoadCandidates(ctx, cfg, userId, limit)
    }
}

func lcLoadCandidates(ctx: HttpContext, cfg: AppConfig, userId: Array<Byte>,
                      limit: Int64): Unit {
    match (openDb(cfg)) {
        case None =>
            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
        case Some(conn) =>
            try {
                let owner = sqlBinary(userId)
                let out = ArrayList<LcCandidate>()
                let sql1 = "SELECT id,resource_type,title,course_id,chapter_id,updated_at" +
                    " FROM generated_learning_resources" +
                    " WHERE archived_at IS NULL AND resource_scope='USER'" +
                    " AND (user_id=" + owner + " OR is_public=1) AND course_id IS NOT NULL" +
                    " ORDER BY updated_at DESC LIMIT " + limit.toString()
                match (conn.query(sql1)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        for (row in rs.rows) {
                            out.add(LcCandidate(
                                cellText(row, 1),
                                uuidText(row, 0) ?? "",
                                cellText(row, 2),
                                uuidText(row, 3),
                                uuidText(row, 4),
                                isoNaiveFromDb(cellText(row, 5))))
                        }
                }
                let sql2 = "SELECT id,title,updated_at FROM presentation_tasks" +
                    " WHERE archived_at IS NULL AND resource_scope='USER'" +
                    " AND (user_id=" + owner + " OR is_public=1) AND status='completed'" +
                    " ORDER BY updated_at DESC LIMIT " + limit.toString()
                match (conn.query(sql2)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        for (row in rs.rows) {
                            let title = optCellText(row, 1) ?? ""
                            out.add(LcCandidate(
                                "ppt",
                                uuidText(row, 0) ?? "",
                                if (title.size == 0) { "最近的 PPT" } else { title },
                                None, None,
                                isoNaiveFromDb(cellText(row, 2))))
                        }
                }
                conn.close()
                let sorted = lcSortDesc(out.toArray())
                let arr = JsonArrWriter()
                var i: Int64 = 0
                while (i < sorted.size && i < limit) {
                    arr.addRaw(lcCandidateJson(sorted[i]))
                    i += 1
                }
                let w = JsonWriter()
                w.putRaw("candidates", arr.toJson())
                writeJson(ctx.response, 200, w.toJson())
            } catch (e: Exception) {
                conn.close()
                writeInternalDebug(ctx.response, "courseRecommendations: " + e.message)
            }
    }
}

/* candidates.sort(key=updatedAt, reverse=True)：稳定排序，降序。 */
func lcSortDesc(items: Array<LcCandidate>): Array<LcCandidate> {
    let n = items.size
    var a: Int64 = 1
    while (a < n) {
        let cur = items[a]
        var b = a - 1
        while (b >= 0 && items[b].updatedAt < cur.updatedAt) {
            items[b + 1] = items[b]
            b -= 1
        }
        items[b + 1] = cur
        a += 1
    }
    return items
}

/* ==================== GET /v1/learning-context ==================== */

/* GoalContextService.LEVEL_SCORE */
func lcLevelScore(level: String): Float64 {
    if (level == "BEGINNER") {
        return 0.18
    } else if (level == "ELEMENTARY") {
        return 0.32
    } else if (level == "INTERMEDIATE") {
        return 0.5
    } else if (level == "PROFICIENT") {
        return 0.68
    } else if (level == "ADVANCED") {
        return 0.82
    } else if (level == "EXPERT") {
        return 0.92
    }
    return 0.28
}

func lcHasLevel(name: String): Bool {
    name == "BEGINNER" || name == "ELEMENTARY" || name == "INTERMEDIATE" ||
        name == "PROFICIENT" || name == "ADVANCED" || name == "EXPERT"
}

func handleLearningContext(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            var goalId: ?Array<Byte> = None
            match (queryParam(ctx.request, "learning_goal_id")) {
                case None => ()
                case Some(raw) =>
                    match (uuidParse(raw)) {
                        case Some(bytes) => goalId = Some(bytes)
                        case None =>
                            let bag = PyBag()
                            let diag = uuidParseError(raw) ?? "Invalid UUID"
                            bag.add(pyUuidParsing(["query", "learning_goal_id"], jsonQuote(raw), diag))
                            bag.write(ctx.response)
                            return
                    }
            }
            lcBuildContext(ctx, cfg, userId, goalId)
    }
}

struct LcMasteryItem {
    let categoryId: Int64
    let name: String
    let path: String
    let score: Float64
    let attempts: Int64

    init(categoryId: Int64, name: String, path: String, score: Float64, attempts: Int64) {
        this.categoryId = categoryId
        this.name = name
        this.path = path
        this.score = score
        this.attempts = attempts
    }
}

struct LcCoverageRow {
    let name: String
    let level: Int64
    let chunkCount: Int64

    init(name: String, level: Int64, chunkCount: Int64) {
        this.name = name
        this.level = level
        this.chunkCount = chunkCount
    }
}

func lcBuildContext(ctx: HttpContext, cfg: AppConfig, userId: Array<Byte>,
                    requestedGoal: ?Array<Byte>): Unit {
    match (openDb(cfg)) {
        case None =>
            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
        case Some(conn) =>
            try {
                let owner = sqlBinary(userId)
                /* user_profiles（可能整行不存在） */
                var educationLevel: ?String = None
                var major: ?String = None
                var technicalFoundation: ?String = None
                var learningPreference: ?String = None
                var currentGoal: ?Array<Byte> = None
                let profileSql = "SELECT education_level,major,technical_foundation," +
                    "learning_preference,current_goal_id FROM user_profiles WHERE user_id=" +
                    owner + " LIMIT 1"
                match (conn.query(profileSql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        if (!rs.rows.isEmpty()) {
                            let row = rs.rows[0]
                            educationLevel = optCellText(row, 0)
                            major = optCellText(row, 1)
                            technicalFoundation = optCellText(row, 2)
                            learningPreference = optCellText(row, 3)
                            if (row.size >= 5 && !row[4].isNull && row[4].bytes.size == 16) {
                                currentGoal = Some(row[4].bytes)
                            }
                        }
                }
                let selectedGoal = match (requestedGoal) {
                    case Some(g) => Some(g)
                    case None => currentGoal
                }

                /* learning_goals（只有显式/画像里选中了目标才查） */
                var goalFound = false
                var goalIdText: ?String = None
                var goalTitle: ?String = None
                var goalDesc: ?String = None
                var goalType: ?String = None
                var goalExpected: ?String = None
                var goalInitial: ?String = None
                var goalAssessment: ?String = None
                var goalTargetDate: ?String = None
                var goalStatus: ?String = None
                match (selectedGoal) {
                    case Some(gid) =>
                        let sql = "SELECT id,goal_type,title,description,expected_level," +
                            "initial_level,assessment_method,target_date,status" +
                            " FROM learning_goals WHERE id=" + sqlBinary(gid) +
                            " AND user_id=" + owner + " LIMIT 1"
                        match (conn.query(sql)) {
                            case QueryOutcome.Ok(_) => ()
                            case QueryOutcome.ResultSet(rs) =>
                                if (!rs.rows.isEmpty()) {
                                    goalFound = true
                                    let row = rs.rows[0]
                                    goalIdText = uuidText(row, 0)
                                    goalType = optCellText(row, 1)
                                    goalTitle = optCellText(row, 2)
                                    goalDesc = optCellText(row, 3)
                                    goalExpected = optCellText(row, 4)
                                    goalInitial = optCellText(row, 5)
                                    goalAssessment = optCellText(row, 6)
                                    goalTargetDate = optCellText(row, 7)
                                    goalStatus = optCellText(row, 8)
                                }
                        }
                    case None => ()
                }

                /* knowledge_mastery */
                let mastery = ArrayList<LcMasteryItem>()
                let masterySql = "SELECT km.knowledge_category_id,c.name,c.full_path," +
                    "km.mastery_score,km.attempt_count" +
                    " FROM knowledge_mastery km JOIN knowledge_category c" +
                    " ON c.id=km.knowledge_category_id" +
                    " WHERE km.user_id=" + owner +
                    " ORDER BY km.mastery_score ASC,km.attempt_count DESC LIMIT 30"
                match (conn.query(masterySql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        for (row in rs.rows) {
                            mastery.add(LcMasteryItem(
                                optCellInt(row, 0) ?? 0,
                                cellText(row, 1),
                                optCellText(row, 2) ?? "",
                                optCellFloat(row, 3) ?? 0.0,
                                optCellInt(row, 4) ?? 0))
                        }
                }

                /* 知识覆盖盘点（只读） */
                let coverageRows = ArrayList<LcCoverageRow>()
                let coverageSql = "SELECT c.id,c.name,c.full_path,c.level," +
                    "COUNT(kcc.id) chunk_count" +
                    " FROM knowledge_category c" +
                    " JOIN knowledge_domain d ON d.id=c.domain_id" +
                    " LEFT JOIN knowledge_chunk_category kcc ON kcc.category_id=c.id" +
                    " WHERE d.code='agent' AND c.status=1" +
                    " GROUP BY c.id,c.name,c.full_path,c.level" +
                    " ORDER BY c.level DESC,c.sort_order,c.id"
                match (conn.query(coverageSql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        for (row in rs.rows) {
                            coverageRows.add(LcCoverageRow(
                                cellText(row, 1),
                                optCellInt(row, 3) ?? 0,
                                optCellInt(row, 4) ?? 0))
                        }
                }
                conn.close()

                let goalJson = lcGoalJson(goalFound, goalIdText, goalTitle, goalDesc, goalType,
                    goalExpected, goalInitial, goalAssessment, goalTargetDate, goalStatus)
                let covered = ArrayList<LcCoverageRow>()
                var level3Total: Int64 = 0
                var level3Covered: Int64 = 0
                for (row in coverageRows) {
                    if (row.level == 3) {
                        level3Total += 1
                    }
                    if (row.chunkCount > 0) {
                        covered.add(row)
                        if (row.level == 3) {
                            level3Covered += 1
                        }
                    }
                }
                var expectedLevel = "PROFICIENT"
                if (goalFound) {
                    match (goalExpected) {
                        case Some(v) =>
                            if (v.size > 0) {
                                expectedLevel = v
                            }
                        case None => ()
                    }
                }
                let recommendation = lcRecommend(goalTitle ?? "", expectedLevel,
                    goalInitial, goalFound, learningPreference, mastery.toArray(),
                    covered.toArray())

                let w = JsonWriter()
                w.putStr("generatedAt", lcGeneratedAt())
                w.putStr("mode", "goal_driven")
                w.putRaw("goal", goalJson)
                let p = JsonWriter()
                p.putOptStr("educationLevel", educationLevel)
                p.putOptStr("major", major)
                p.putOptStr("technicalFoundation", technicalFoundation)
                p.putOptStr("learningPreference", learningPreference)
                w.putRaw("profile", p.toJson())
                let m = JsonWriter()
                if (mastery.size == 0) {
                    m.putInt("overall", 0)
                } else {
                    var sum: Float64 = 0.0
                    for (item in mastery) {
                        sum += item.score
                    }
                    m.putRaw("overall", lcFloat(round4(sum / floatFromInt(mastery.size))))
                }
                let mitems = JsonArrWriter()
                for (item in mastery) {
                    let iw = JsonWriter()
                    iw.putInt("categoryId", item.categoryId)
                    iw.putStr("name", item.name)
                    iw.putStr("path", item.path)
                    iw.putRaw("score", lcFloat(item.score))
                    iw.putInt("attempts", item.attempts)
                    mitems.addRaw(iw.toJson())
                }
                m.putRaw("items", mitems.toJson())
                m.putStr("evidenceLevel", if (mastery.size == 0) { "cold_start" } else { "observed" })
                w.putRaw("mastery", m.toJson())
                let c = JsonWriter()
                c.putStr("domainCode", "agent")
                c.putStr("domainName", "智能体")
                c.putInt("knowledgePointCount", level3Total)
                c.putInt("coveredKnowledgePointCount", level3Covered)
                c.putInt("coveredCategoryCount", covered.size)
                c.putStr("status", if (covered.size < coverageRows.size) {
                    "partial"
                } else {
                    "complete"
                })
                w.putRaw("knowledgeCoverage", c.toJson())
                w.putRaw("recommendation", recommendation)
                writeJson(ctx.response, 200, w.toJson())
            } catch (e: Exception) {
                conn.close()
                writeInternalDebug(ctx.response, "learningContext: " + e.message)
            }
    }
}

/* datetime.now(timezone.utc).isoformat() —— 固定 +00:00，微秒为 0 时省略。 */
func lcGeneratedAt(): String {
    let p = nowUtcParts()
    var s = pad4(p.year) + "-" + pad2(p.month) + "-" + pad2(p.day) + "T" +
        pad2(p.hour) + ":" + pad2(p.minute) + ":" + pad2(p.second)
    if (p.micros != 0) {
        s = s + "." + pad6(p.micros)
    }
    return s + "+00:00"
}

/* Python float 序列化：整数值保留 ".0"。 */
func lcFloat(v: Float64): String {
    let s = v.toString()
    if (s.contains(".")) {
        return s
    }
    return s + ".0"
}

/* round(x)：Python 的 round 无 ndigits 时返回 int。 */
func lcRoundInt(v: Float64): Int64 {
    Int64(roundTo(v, 0))
}

func lcGoalJson(found: Bool, id: ?String, title: ?String, desc: ?String,
                goalType: ?String, expected: ?String, initial: ?String,
                assessment: ?String, targetDate: ?String, status: ?String): String {
    let w = JsonWriter()
    if (!found) {
        w.putRaw("id", "null")
        w.putStr("title", "大模型智能体工程：从原理到独立项目开发")
        w.putStr("description", "系统掌握智能体原理、框架、工具、记忆、RAG、评估与工程实践。")
        w.putStr("goalType", "SKILL_IMPROVEMENT")
        w.putStr("expectedLevel", "PROFICIENT")
        w.putRaw("initialLevel", "null")
        w.putStr("assessmentMethod", "DIAGNOSTIC_TEST")
        w.putStr("status", "ACTIVE")
        w.putBool("inferred", true)
        return w.toJson()
    }
    w.putOptStr("id", id)
    w.putOptStr("title", title)
    w.putOptStr("description", desc)
    w.putOptStr("goalType", goalType)
    w.putOptStr("expectedLevel", expected)
    w.putOptStr("initialLevel", initial)
    w.putOptStr("assessmentMethod", assessment)
    /* date.isoformat()：DATE 列只到日 */
    match (targetDate) {
        case Some(d) =>
            if (d.size >= 10) {
                w.putStr("targetDate", d[0..10])
            } else {
                w.putStr("targetDate", d)
            }
        case None => w.putRaw("targetDate", "null")
    }
    w.putOptStr("status", status)
    w.putBool("inferred", false)
    return w.toJson()
}

func lcRecommend(goalTitle: String, expectedLevel: String, goalInitial: ?String,
                 goalFound: Bool, learningPreference: ?String,
                 mastery: Array<LcMasteryItem>,
                 covered: Array<LcCoverageRow>): String {
    let expected = if (lcHasLevel(expectedLevel)) {
        lcLevelScore(expectedLevel)
    } else {
        0.68
    }
    /* observed = attempts > 0；weakest = 第一个最小 score */
    var weakest: ?LcMasteryItem = None
    var observedCount: Int64 = 0
    for (item in mastery) {
        if (item.attempts <= 0) {
            continue
        }
        observedCount += 1
        match (weakest) {
            case None => weakest = Some(item)
            case Some(cur) =>
                if (item.score < cur.score) {
                    weakest = Some(item)
                }
        }
    }
    let observedEmpty = observedCount == 0
    var topic = ""
    var reason = ""
    var ability: Float64 = 0.0
    match (weakest) {
        case Some(w) =>
            topic = w.name
            ability = w.score
            let pct = lcRoundInt(ability * 100.0)
            if (ability < expected) {
                reason = "该知识点当前掌握度约 " + pct.toString() + "%，低于目标水平。"
            } else {
                reason = "已有学习证据显示掌握度约 " + pct.toString() +
                    "%，可以通过进阶测试验证迁移能力。"
            }
        case None =>
            var preferred: ?LcCoverageRow = None
            var preferredSet = false
            for (row in covered) {
                if (row.level == 3 && !preferredSet) {
                    preferred = Some(row)
                    preferredSet = true
                }
            }
            topic = match (preferred) {
                case Some(r) => r.name
                case None => "大模型智能体核心原理与工程实践"
            }
            reason = "当前缺少足够的作答证据，先通过讲义与短测完成能力冷启动。"
            let initial = goalInitial ?? "BEGINNER"
            ability = lcLevelScore(initial)
    }
    let difficulty = if (ability < 0.42) {
        "foundation"
    } else if (ability < 0.72) {
        "advanced"
    } else {
        "challenge"
    }
    let preference = learningPreference ?? "PRACTICE_DRIVEN"
    let detail = if (ability < 0.45) { "detailed" } else { "balanced" }
    let pct = lcRoundInt(ability * 100.0)
    let w = JsonWriter()
    w.putStr("topic", topic)
    w.putStr("reason", reason)
    w.putRaw("ability", lcFloat(round4(ability)))
    w.putStr("difficulty", difficulty)
    w.putStr("detailLevel", detail)
    w.putStr("preferredFormat", preference)
    w.putStr("nextResourceType", if (observedEmpty || ability < 0.55) { "lecture" } else { "quiz" })
    w.putInt("questionCount", if (ability < 0.55) { 9 } else { 12 })
    let ppt = JsonWriter()
    ppt.putStr("title", topic + "：个性化学习课件")
    let requirement = "围绕“" + topic + "”生成服务于当前学习目标“" +
        (if (goalFound) { goalTitle } else { "" }) + "”的个性化课件。" +
        "学习者当前能力约为 " + pct.toString() + "%，目标水平为 " + expectedLevel + "。" +
        "优先使用智能体领域知识库中的可溯源内容，包含原理解释、工程案例、代码或流程、易错点和练习。"
    ppt.putStr("requirement", requirement)
    ppt.putInt("slideCount", if (ability < 0.55) { 20 } else { 12 })
    ppt.putStr("detailLevel", detail)
    w.putRaw("ppt", ppt.toJson())
    return w.toJson()
}
