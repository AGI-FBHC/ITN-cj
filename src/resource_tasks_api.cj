package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * HTTP handlers for learning-resource generation tasks.
 *
 * Mirrors src/agents/app/routers/public.py:
 *   POST /v1/learning-resource-tasks/{resource_type}   (202)
 *   GET  /v1/learning-resource-tasks
 *   GET  /v1/learning-resource-tasks/{task_id}
 *   POST /v1/learning-resource-tasks/{task_id}/restart
 *   POST /v1/learning-resource-tasks/{task_id}/cancel
 *   DELETE /v1/learning-resource-tasks/{task_id}
 *
 * P3 routing split (2026-10-17):
 *   GET  list / GET by id            → LOCAL (read side, already point-verified)
 *   POST create / restart / cancel,
 *   DELETE                          → NOT registered here. The catch-all
 *     forwarder sends them to Python, because only Python can run
 *     `_enqueue_generation(...)` / pop `_learning_resource_generation_tasks`.
 *     A Spire-local write would create the DB row and never start or stop the
 *     generation — the P3 §C5 trap. The local handleCreate/Restart/Cancel/
 *     Delete bodies below are kept for differential comparison against
 *     Python and are not on the live request path.
 *
 * Deliberate differences from the presentations list route:
 *   - limit is Query(30, ge=1, le=1000): out of range is a 422, not a clamp
 *   - summary defaults to False (presentations default True)
 *   - no ETag / 304 support
 */
public func registerResourceTaskRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/learning-resource-tasks") {
        ctx => handleListResourceTasks(ctx, cfg)
    }
    app.mapGet("v1/learning-resource-tasks/{task_id}") {
        ctx => handleGetResourceTask(ctx, cfg)
    }
}

/* GET /v1/learning-resource-tasks */
func handleListResourceTasks(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            var limit: Int64 = 30
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
                            if (v > 1000) {
                                writePyConstraint422(ctx.response, ["query", "limit"],
                                                     "less_than_equal",
                                                     "Input should be less than or equal to 1000",
                                                     jsonQuote(raw), "{\"le\":1000}")
                                return
                            }
                            limit = v
                    }
            }
            var summary = false
            match (queryBoolParam(ctx.request, "summary")) {
                case BoolParamResult.Missing => ()
                case BoolParamResult.Value(v) => summary = v
                case BoolParamResult.Bad(raw) =>
                    writePyType422(ctx.response, ["query", "summary"], "bool_parsing",
                                   "Input should be a valid boolean, unable to interpret input",
                                   jsonQuote(raw))
                    return
            }
            if (storageUnavailable(cfg)) {
                writeDetail(ctx.response, 503, "Presentation storage is not configured")
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        let store = ResourceTasksStore(conn)
                        let items = store.list(userId, limit, summary)
                        conn.close()
                        let arr = JsonArrWriter()
                        for (item in items) {
                            arr.addRaw(item)
                        }
                        let obj = JsonWriter()
                        obj.putRaw("tasks", arr.toJson())
                        writeJson(ctx.response, 200, obj.toJson())
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "listResourceTasks: " + e.message)
                    }
            }
    }
}

/*
 * GET /v1/learning-resource-tasks/{task_id}
 * Owner-only; 404 detail string matches public.py:280502-280511.
 */
func handleGetResourceTask(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parsePathUuidFastApi(ctx, "task_id")) {
                case None => return
                case Some(taskId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Presentation storage is not configured")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let store = ResourceTasksStore(conn)
                                match (store.get(userId, taskId)) {
                                    case None =>
                                        conn.close()
                                        writeDetail(ctx.response, 404,
                                                    "Learning resource generation task not found")
                                    case Some(raw) =>
                                        let enriched = attachResourceEventSummaries(conn, userId,
                                                                                    taskId, raw)
                                        conn.close()
                                        writeJson(ctx.response, 200, enriched)
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "getResourceTask: " + e.message)
                            }
                    }
            }
    }
}

/*
 * DELETE /v1/learning-resource-tasks/{task_id} — public.py:5960-5972 +
 * storage/resource_generation_tasks.py:456-470 (plain DELETE WHERE id AND
 * user_id, no cascade). 404 detail 任务不存在或无权删除; 204 on success.
 */
func handleDeleteResourceTask(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parsePathUuidValidated(ctx, "task_id")) {
                case None => return
                case Some(taskId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Presentation storage is not configured")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                var removed = false
                                match (conn.query("DELETE FROM learning_resource_generation_tasks " +
                                                  "WHERE id=" + sqlBinary(taskId) +
                                                  " AND user_id=" + sqlBinary(userId))) {
                                    case QueryOutcome.Ok(ok) => removed = ok.affectedRows > 0
                                    case QueryOutcome.ResultSet(_) => removed = false
                                }
                                conn.close()
                                if (removed) {
                                    ctx.response.statusCode = 204
                                } else {
                                    writeDetail(ctx.response, 404, "任务不存在或无权删除")
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "deleteResourceTask: " + e.message)
                            }
                    }
            }
    }
}

/* ------------------------------------------------------------------ *
 * Write side: create / restart / cancel
 * ------------------------------------------------------------------ */

/*
 * LearningResourceCreateRequest (models.py:226-255) plus the derived fields
 * the create handler needs after `_with_admin_resume` (public.py:1169-1176).
 * requestJson is model_dump() with snake_case keys — what
 * json.dumps(request, default=str) writes into request_json.
 */
private struct ResourceCreateReq {
    public let requestJson: String
    public let topic: String
    public let title: String
    public let adminGeneration: Bool
    public let domainCode: String
    public let nodeCode: String
    public let groupName: String
    public let regenerate: Bool
    public let learnerId: ?Array<Byte>
    public let kpId: ?String

    public init(requestJson: String, topic: String, title: String,
                adminGeneration: Bool, domainCode: String, nodeCode: String,
                groupName: String, regenerate: Bool,
                learnerId: ?Array<Byte>, kpId: ?String) {
        this.requestJson = requestJson
        this.topic = topic
        this.title = title
        this.adminGeneration = adminGeneration
        this.domainCode = domainCode
        this.nodeCode = nodeCode
        this.groupName = groupName
        this.regenerate = regenerate
        this.learnerId = learnerId
        this.kpId = kpId
    }
}

/*
 * POST /v1/learning-resource-tasks/{resource_type} — public.py:5188-5254.
 *
 * Order of checks is the contract:
 *   1. resource_type path value (HTTPException 422 {"detail":"Invalid resource type"})
 *   2. body (LearningResourceCreateRequest pydantic 422)
 *   3. admin group uniqueness (409) when generation_context.adminGeneration is
 *      exactly JSON true and both domainCode and nodeCode are truthy
 *   4. reuse an existing resource (non-admin only) → create_reused + 202
 *   5. otherwise create + 202
 * replace_previous_tasks then deletes the older same-name rows.
 */
func handleCreateResourceTask(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            var resourceType = ""
            match (routeParam(ctx.request, "resource_type")) {
                case Some(t) => resourceType = t
                case None => ()
            }
            if (resourceType != "lecture" && resourceType != "practice" && resourceType != "quiz") {
                writeDetail(ctx.response, 422, "Invalid resource type")
                return
            }
            match (readPyBodyObject(ctx)) {
                case None => return
                case Some(root) =>
                    match (parseLearningResourceCreate(ctx, root)) {
                        case None => return
                        case Some(req) =>
                            if (storageUnavailable(cfg)) {
                                writeDetail(ctx.response, 503, "Presentation storage is not configured")
                                return
                            }
                            match (openDb(cfg)) {
                                case None =>
                                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                case Some(conn) =>
                                    try {
                                        let titleText = effectiveTitle(req.topic, req.title, resourceType)
                                        if (req.adminGeneration && req.domainCode != "" &&
                                            req.nodeCode != "" && !req.regenerate) {
                                            if (adminGroupHasType(conn, req.domainCode,
                                                                  req.nodeCode, req.groupName,
                                                                  resourceType)) {
                                                conn.close()
                                                writeDetail(ctx.response, 409,
                                                            "该分组已存在对应资源，同一分组内各资源唯一")
                                                return
                                            }
                                        }
                                        let created = createResourceTaskRow(conn, userId, resourceType,
                                                                            req, titleText)
                                        conn.close()
                                        match (created) {
                                            case None => ()
                                            case Some(taskRaw) =>
                                                writeJson(ctx.response, 202, taskRaw)
                                        }
                                    } catch (e: Exception) {
                                        conn.close()
                                        writeInternalDebug(ctx.response, "createResourceTask: " + e.message)
                                    }
                            }
                    }
            }
    }
}

/*
 * title = request.title or f"{topic} · " + {"lecture":"定制讲义",
 * "practice":"实操指南","quiz":"分阶测试"}[resource_type]
 */
private func effectiveTitle(topic: String, title: String, resourceType: String): String {
    if (title != "") {
        return title
    }
    var suffix = "定制讲义"
    if (resourceType == "practice") {
        suffix = "实操指南"
    } else if (resourceType == "quiz") {
        suffix = "分阶测试"
    }
    return topic + " · " + suffix
}

/*
 * The store-level create path shared by the HTTP handler. Writes either a
 * reused-completed task or a fresh queued one, then drops the replaced rows.
 */
private func createResourceTaskRow(conn: MyConnection, userId: Array<Byte>,
                                   resourceType: String, req: ResourceCreateReq,
                                   title: String): ?String {
    let store = ResourceTasksStore(conn)
    let previousIds = store.listSameName(userId, resourceType, title)
    var newTask: ?String = None
    if (!req.adminGeneration) {
        match (findReusedResource(conn, userId, resourceType, req.learnerId, req.kpId,
                                  req.topic, title)) {
            case None => ()
            case Some(reusedPair) =>
                let (resourceId, resourceTitle) = reusedPair
                /* Python: item.get("title") or title — the reused resource's own title. */
                let reuseTitle = if (resourceTitle != "") { resourceTitle } else { title }
                newTask = store.createReused(userId, resourceType, reuseTitle,
                                             req.requestJson, resourceId)
        }
    }
    match (newTask) {
        case None => newTask = store.create(userId, resourceType, title, req.requestJson)
        case Some(_) => ()
    }
    match (newTask) {
        case None => return None
        case Some(taskRaw) =>
            match (jsonGetStringFromRaw(taskRaw, "id")) {
                case None => return Some(taskRaw)
                case Some(idText) =>
                    match (uuidParse(idText)) {
                        case None => return Some(taskRaw)
                        case Some(newId) =>
                            if (previousIds.size > 0) {
                                pyDrop(store.deleteSameNameExcept(userId, resourceType,
                                                                  title, newId))
                            }
                            return Some(taskRaw)
                    }
            }
    }
}

/*
 * The non-admin reuse probe (public.py:5228-5240) walks
 * learning_resource_store().list(...) in updated_at DESC order and stops at
 * the first row whose topic strips equal or whose title matches exactly.
 * Returns (id, resource title) — create_reused titles the task after the
 * resource (`item.get("title") or title`), not after the computed title.
 */
private func findReusedResource(conn: MyConnection, userId: Array<Byte>, kind: String,
                                learnerId: ?Array<Byte>, kpId: ?String,
                                topic: String, title: String): ?(Array<Byte>, String) {
    var sql = "SELECT id,topic,title FROM generated_learning_resources " +
        "WHERE archived_at IS NULL AND resource_scope='USER' AND (user_id=" +
        sqlBinary(userId) + " OR is_public=1) AND course_id IS NULL AND resource_type=" +
        sqlQuote(kind)
    match (learnerId) {
        case Some(l) => sql = sql + " AND learner_id=" + sqlBinary(l)
        case None => ()
    }
    match (kpId) {
        case Some(k) =>
            if (k != "") {
                sql = sql + " AND kp_id=" + sqlQuote(k)
            }
        case None => ()
    }
    sql = sql + " ORDER BY updated_at DESC"
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return None
        case QueryOutcome.ResultSet(rs) =>
            for (row in rs.rows) {
                let rowTopic = (optCellText(row, 1) ?? "").trimAscii()
                let rowTitle = optCellText(row, 2) ?? ""
                if (rowTopic == topic.trimAscii() || rowTitle == title) {
                    if (row[0].isBinary16()) {
                        return Some((row[0].bytes, rowTitle))
                    }
                }
            }
            return None
    }
}

/*
 * list_admin_generation_groups is a five-query aggregation; only the "does this
 * group already own this resource type (generated/generating)" question matters
 * for the create 409. Statuses failed/cancelled never enter the group `types`
 * set (learning_resources.py:418-421), so they are excluded here too.
 * Group comparison is BINARY because Python compares the fetched strings with
 * `==`, which is case-sensitive unlike MySQL's utf8mb4 collation.
 */
private func adminGroupHasType(conn: MyConnection, domainCode: String, nodeCode: String,
                               group: String, resourceType: String): Bool {
    let d = sqlQuote(domainCode)
    let n = sqlQuote(nodeCode)
    let g = sqlQuote(group)
    let t = sqlQuote(resourceType)
    let resSql = "SELECT 1 FROM generated_learning_resources WHERE domain_code=" + d +
        " AND category_node_code=" + n +
        " AND resource_scope='ORGANIZATION' AND archived_at IS NULL" +
        " AND BINARY COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(context_json,'$.resourceGroup')))" +
        " = BINARY " + g + " AND resource_type=" + t + " LIMIT 1"
    if (rowExists(conn, resSql)) {
        return true
    }
    let taskSql = "SELECT 1 FROM learning_resource_generation_tasks" +
        " WHERE status NOT IN ('completed','failed','cancelled')" +
        " AND BINARY JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.domainCode')) = BINARY " + d +
        " AND BINARY JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.nodeCode')) = BINARY " + n +
        " AND BINARY COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.groupName')),''),'默认分组')" +
        " = BINARY " + g + " AND resource_type=" + t + " LIMIT 1"
    if (rowExists(conn, taskSql)) {
        return true
    }
    if (resourceType != "ppt") {
        return false
    }
    let pptDone = "SELECT 1 FROM presentation_tasks WHERE domain_code=" + d +
        " AND category_node_code=" + n +
        " AND resource_scope='ORGANIZATION' AND status='completed' AND archived_at IS NULL" +
        " AND BINARY COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName')))" +
        " = BINARY " + g + " LIMIT 1"
    if (rowExists(conn, pptDone)) {
        return true
    }
    let pptRun = "SELECT 1 FROM presentation_tasks WHERE domain_code=" + d +
        " AND category_node_code=" + n +
        " AND resource_scope='ORGANIZATION' AND status NOT IN ('completed','failed','cancelled')" +
        " AND archived_at IS NULL" +
        " AND BINARY COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName')))" +
        " = BINARY " + g + " LIMIT 1"
    return rowExists(conn, pptRun)
}

private func rowExists(conn: MyConnection, sql: String): Bool {
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return false
        case QueryOutcome.ResultSet(rs) => return !rs.rows.isEmpty()
    }
}

/*
 * POST /v1/learning-resource-tasks/{task_id}/restart — public.py:5925-5943.
 * 409 text when the row is missing or not failed/cancelled; 200 with the
 * updated task otherwise. The re-enqueued AI chain stays in Python.
 */
func handleRestartResourceTask(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parsePathUuidValidated(ctx, "task_id")) {
                case None => return
                case Some(taskId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Presentation storage is not configured")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let store = ResourceTasksStore(conn)
                                match (store.restart(userId, taskId)) {
                                    case None =>
                                        conn.close()
                                        writeDetail(ctx.response, 409, "任务不存在或当前状态不允许重启")
                                    case Some(raw) =>
                                        conn.close()
                                        writeJson(ctx.response, 200, raw)
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "restartResourceTask: " + e.message)
                            }
                    }
            }
    }
}

/*
 * POST /v1/learning-resource-tasks/{task_id}/cancel — public.py:5945-5957.
 * 404 text when the row is missing or already ended; 200 with the cancelled
 * task otherwise. Cancelling the in-process asyncio task stays in Python.
 */
func handleCancelResourceTask(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parsePathUuidValidated(ctx, "task_id")) {
                case None => return
                case Some(taskId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Presentation storage is not configured")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let store = ResourceTasksStore(conn)
                                match (store.cancel(userId, taskId)) {
                                    case None =>
                                        conn.close()
                                        writeDetail(ctx.response, 404, "任务不存在或已结束，无需取消")
                                    case Some(raw) =>
                                        conn.close()
                                        writeJson(ctx.response, 200, raw)
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "cancelResourceTask: " + e.message)
                            }
                    }
            }
    }
}

/*
 * LearningResourceCreateRequest — declaration order (models.py:227-255):
 *   topic, title, learning_goal_id, learner_id, kp_id, form, level, version,
 *   quiz_ids, kb_refs, detail_level, question_count, goal_driven,
 *   generation_context
 *
 * Measured null semantics: topic/title/learning_goal_id/learner_id/kp_id/
 * form/level/version/generation_context are `T | None` so explicit null is
 * absent; quiz_ids/kb_refs/detail_level/question_count/goal_driven are
 * non-Optional with defaults, so explicit null is the type error
 * (list_type / literal_error / int_type / bool_type).
 *
 * Measured {"question_count": 15, "questionCount": "x"} -> 200 (AliasChoices
 * first-wins commits to the snake key and never reads the camel one).
 */
private func parseLearningResourceCreate(ctx: HttpContext, root: JsonObject): ?ResourceCreateReq {
    let bag = PyBag()

    var topic: ?String = None
    match (pyFieldOpt(root, "topic", "topic")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 2, 500)) {
                case Some(s) => topic = Some(s)
                case None => ()
            }
    }
    var title: ?String = None
    match (pyFieldOpt(root, "title", "title")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 160)) {
                case Some(s) => title = Some(s)
                case None => ()
            }
    }
    var learningGoalId: ?Array<Byte> = None
    match (pyFieldOpt(root, "learning_goal_id", "learningGoalId")) {
        case None => ()
        case Some(f) =>
            match (pyUuidField(bag, f)) {
                case Some(b) => learningGoalId = Some(b)
                case None => ()
            }
    }
    var learnerId: ?Array<Byte> = None
    match (pyFieldOpt(root, "learner_id", "learnerId")) {
        case None => ()
        case Some(f) =>
            match (pyUuidField(bag, f)) {
                case Some(b) => learnerId = Some(b)
                case None => ()
            }
    }
    var kpId: ?String = None
    match (pyFieldOpt(root, "kp_id", "kpId")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 64)) {
                case Some(s) => kpId = Some(s)
                case None => ()
            }
    }
    var form: ?String = None
    match (pyFieldOpt(root, "form", "form")) {
        case None => ()
        case Some(f) =>
            match (pyLiteralField(bag, f, ["lecture", "guide", "quiz", "practice"])) {
                case Some(s) => form = Some(s)
                case None => ()
            }
    }
    var level: ?String = None
    match (pyFieldOpt(root, "level", "level")) {
        case None => ()
        case Some(f) =>
            match (pyLiteralField(bag, f, ["basic", "advanced", "challenge"])) {
                case Some(s) => level = Some(s)
                case None => ()
            }
    }
    var version: ?String = None
    match (pyFieldOpt(root, "version", "version")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 16)) {
                case Some(s) => version = Some(s)
                case None => ()
            }
    }
    var quizIds = Array<String>(0, repeat: "")
    match (pyField(root, "quiz_ids", "quizIds")) {
        case None => ()
        case Some(f) =>
            match (pyStrList(bag, f, 100)) {
                case Some(items) => quizIds = items
                case None => ()
            }
    }
    var kbRefs = Array<String>(0, repeat: "")
    match (pyField(root, "kb_refs", "kbRefs")) {
        case None => ()
        case Some(f) =>
            match (pyStrList(bag, f, 50)) {
                case Some(items) => kbRefs = items
                case None => ()
            }
    }
    var detailLevel = "balanced"
    match (pyField(root, "detail_level", "detailLevel")) {
        case None => ()
        case Some(f) =>
            match (pyLiteralField(bag, f, ["concise", "balanced", "detailed"])) {
                case Some(s) => detailLevel = s
                case None => ()
            }
    }
    var questionCount: Int64 = 15
    match (pyField(root, "question_count", "questionCount")) {
        case None => ()
        case Some(f) =>
            match (pyInt(bag, f, Some(6), Some(30))) {
                case Some(n) => questionCount = n
                case None => ()
            }
    }
    var goalDriven = false
    match (pyField(root, "goal_driven", "goalDriven")) {
        case None => ()
        case Some(f) =>
            match (pyBoolField(bag, f)) {
                case Some(b) => goalDriven = b
                case None => ()
            }
    }
    var genCtxRaw = "null"
    match (pyFieldOpt(root, "generation_context", "generationContext")) {
        case None => ()
        case Some(f) =>
            match (f.value.kind()) {
                case JsonKind.JsObject => genCtxRaw = f.raw
                case _ => bag.add(pyDictType(["body", f.key], f.raw))
            }
    }

    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }

    /* _with_admin_resume (public.py:1169-1176) mutates generation_context. */
    genCtxRaw = withAdminResume(genCtxRaw)

    /* model_dump() snake_case order. */
    let w = JsonWriter()
    w.putOptStr("topic", topic)
    w.putOptStr("title", title)
    match (learningGoalId) {
        case Some(b) => w.putStr("learning_goal_id", uuidFormat(b))
        case None => w.putRaw("learning_goal_id", "null")
    }
    match (learnerId) {
        case Some(b) => w.putStr("learner_id", uuidFormat(b))
        case None => w.putRaw("learner_id", "null")
    }
    w.putOptStr("kp_id", kpId)
    w.putOptStr("form", form)
    w.putOptStr("level", level)
    w.putOptStr("version", version)
    w.putRaw("quiz_ids", jsonStrListRaw(quizIds))
    w.putRaw("kb_refs", jsonStrListRaw(kbRefs))
    w.putStr("detail_level", detailLevel)
    w.putInt("question_count", questionCount)
    w.putBool("goal_driven", goalDriven)
    w.putRaw("generation_context", genCtxRaw)

    /* topic = request.topic or "个性化学习资源" */
    var effTopic = "个性化学习资源"
    match (topic) {
        case Some(t) =>
            if (t != "") {
                effTopic = t
            }
        case None => ()
    }
    /* title is resolved later — the suffix depends on the path resource_type. */
    var effTitle = ""
    match (title) {
        case Some(t) => effTitle = t
        case None => ()
    }

    /* generation_context flags (public.py:5198-5207). `is True` on adminGeneration. */
    var adminGeneration = false
    var domainCode = ""
    var nodeCode = ""
    var groupName = "默认分组"
    var regenerate = false
    if (genCtxRaw != "null") {
        match (jsonParse(genCtxRaw)) {
            case None => ()
            case Some(gv) =>
                if (isJsObject(gv)) {
                    let g = gv.asObject()
                    match (g.get("adminGeneration")) {
                        case Some(av) =>
                            if (isJsBool(av) && av.asBool().getValue()) {
                                adminGeneration = true
                            }
                        case None => ()
                    }
                    domainCode = pythonStrOr(g.get("domainCode"), "")
                    nodeCode = pythonStrOr(g.get("nodeCode"), "")
                    groupName = pythonStrOr(g.get("groupName"), "默认分组")
                    regenerate = pyTruthyValue(g.get("regenerate"))
                }
        }
    }

    return Some(ResourceCreateReq(w.toJson(), effTopic, effTitle, adminGeneration,
                                  domainCode, nodeCode, groupName, regenerate,
                                  learnerId, kpId))
}

/* Python `str(x or default)` for a JSON value — numbers/bools stringify too. */
private func pythonStrOr(v: ?JsonValue, fallback: String): String {
    match (v) {
        case None => return fallback
        case Some(x) =>
            if (!pyTruthyValue(Some(x))) {
                return fallback
            }
            match (x.kind()) {
                case JsonKind.JsString => return x.asString().getValue()
                case JsonKind.JsInt => return x.asInt().getValue().toString()
                case JsonKind.JsFloat => return x.asFloat().getValue().toString()
                case JsonKind.JsBool => return if (x.asBool().getValue()) { "True" } else { "False" }
                case _ => return fallback
            }
    }
}

/* json.dumps(list_of_str, ensure_ascii=False) */
private func jsonStrListRaw(items: Array<String>): String {
    let arr = JsonArrWriter()
    for (s in items) {
        arr.addRaw(jsonQuote(s))
    }
    return arr.toJson()
}

/*
 * _with_admin_resume (public.py:1169-1176): when generation_context is an
 * object whose adminGeneration is exactly JSON true and whose resumeEnabled is
 * falsy, copy the dict and add resumeEnabled: true (appended last).
 */
private func withAdminResume(genCtxRaw: String): String {
    if (genCtxRaw == "null") {
        return genCtxRaw
    }
    match (jsonParse(genCtxRaw)) {
        case None => return genCtxRaw
        case Some(gv) =>
            if (!isJsObject(gv)) {
                return genCtxRaw
            }
            let g = gv.asObject()
            match (g.get("adminGeneration")) {
                case None => return genCtxRaw
                case Some(av) =>
                    if (!(isJsBool(av) && av.asBool().getValue())) {
                        return genCtxRaw
                    }
            }
            if (pyTruthyValue(g.get("resumeEnabled"))) {
                return genCtxRaw
            }
            let w = JsonWriter()
            for ((k, v) in g.getFields()) {
                w.putRaw(k, valueToRaw(v))
            }
            w.putBool("resumeEnabled", true)
            return w.toJson()
    }
}
