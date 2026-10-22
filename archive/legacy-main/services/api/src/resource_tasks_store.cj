package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*

/*
 * ResourceGenerationTaskStore read-side (storage/resource_generation_tasks.py).
 *
 * Owner-only, no visibility triple-OR and no archived filter — the table has
 * neither column. `request` keeps its snake_case keys exactly as stored
 * (model_dump() without by_alias), which is the opposite of presentations.
 *
 * Key order is the contract.
 */

/*
 * Summary column list — resource_generation_tasks.py:list() SELECTs user_id
 * too, but Python's _serialize_summary reads the row BY NAME and never emits
 * it. Our serializer is positional over this list (serializeResourceTaskSummary:
 * id,resource_type,title,...), so user_id MUST be absent — including it shifts
 * every field after id (resourceType would read the BINARY(16) user id).
 * The remaining columns MUST match the serializer index order:
 * resource_id,error_message,request_json — not the table's DDL order.
 */
func resourceSummaryColumns(): String {
    "id,resource_type,title,status,progress,stage_message,resource_id," +
        "error_message,request_json,created_at,updated_at"
}

/* Full column list — SELECT * order made explicit so ALTERs cannot shift it. */
func resourceFullColumns(): String {
    "id,resource_type,title,status,progress,stage_message,events_json,resource_id," +
        "checkpoint_stage,error_message,request_json,created_at,updated_at"
}

/*
 * ResourceGenerationTaskStore._serialize (resource_generation_tasks.py:47-59).
 *   checkpointStage is present (SELECT * includes the column) and null when
 *   the column is NULL.
 */
func serializeResourceTaskFull(row: Array<MyCell>): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putStr("resourceType", cellText(row, 1))
    w.putStr("title", cellText(row, 2))
    w.putStr("status", cellText(row, 3))
    w.putInt("progress", optCellInt(row, 4) ?? 0)
    w.putStr("stageMessage", cellText(row, 5))
    w.putRaw("events", loadsAny(cellText(row, 6), "[]"))
    w.putOptStr("resourceId", uuidText(row, 7))
    w.putOptStr("checkpointStage", optCellText(row, 8))
    w.putOptStr("errorMessage", optCellText(row, 9))
    w.putRaw("request", loadsAny(cellText(row, 10), "{}"))
    w.putStr("createdAt", isoNaiveFromDb(cellText(row, 11)))
    w.putStr("updatedAt", isoNaiveFromDb(cellText(row, 12)))
    return w.toJson()
}

/*
 * ResourceGenerationTaskStore._serialize_summary (…:_serialize_summary).
 * `events` is forced to [] and `checkpointStage` is OMITTED entirely — the
 * summary column list does not select it and the dict comprehension never
 * adds the key.
 */
func serializeResourceTaskSummary(row: Array<MyCell>): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putStr("resourceType", cellText(row, 1))
    w.putStr("title", cellText(row, 2))
    w.putStr("status", cellText(row, 3))
    w.putInt("progress", optCellInt(row, 4) ?? 0)
    w.putStr("stageMessage", cellText(row, 5))
    w.putRaw("events", "[]")
    w.putOptStr("resourceId", uuidText(row, 6))
    w.putOptStr("errorMessage", optCellText(row, 7))
    w.putRaw("request", loadsAny(cellText(row, 8), "{}"))
    w.putStr("createdAt", isoNaiveFromDb(cellText(row, 9)))
    w.putStr("updatedAt", isoNaiveFromDb(cellText(row, 10)))
    return w.toJson()
}

public class ResourceTasksStore {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    /*
     * list (resource_generation_tasks.py:13732ff). Two-phase on purpose: the
     * first query sorts compact ids only so MySQL never filesorts events_json,
     * then the chosen rows load unordered and Python re-orders them.
     */
    public func list(userId: Array<Byte>, limit: Int64, summary: Bool): Array<String> {
        let idsSql = "SELECT id FROM learning_resource_generation_tasks WHERE user_id=" +
            sqlBinary(userId) + " ORDER BY updated_at DESC LIMIT " + sqlInt(limit)
        let orderedIds = ArrayList<Array<Byte>>()
        match (conn.query(idsSql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                for (row in rs.rows) {
                    if (row[0].isBinary16()) {
                        orderedIds.add(row[0].bytes)
                    }
                }
        }
        if (orderedIds.isEmpty()) {
            return Array<String>(0, repeat: "")
        }
        let parts = ArrayList<String>()
        for (id in orderedIds) {
            parts.add(sqlBinary(id))
        }
        let columns = if (summary) { resourceSummaryColumns() } else { resourceFullColumns() }
        let rowsSql = "SELECT " + columns +
            " FROM learning_resource_generation_tasks WHERE id IN (" + joinComma(parts.toArray()) + ")"
        let byId = HashMap<String, Array<MyCell>>()
        match (conn.query(rowsSql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                for (row in rs.rows) {
                    if (row[0].isBinary16()) {
                        byId.add(uuidFormat(row[0].bytes), row)
                    }
                }
        }
        let out = ArrayList<String>()
        for (id in orderedIds) {
            match (byId.get(uuidFormat(id))) {
                case Some(row) =>
                    out.add(if (summary) { serializeResourceTaskSummary(row) }
                            else { serializeResourceTaskFull(row) })
                case None => ()
            }
        }
        return out.toArray()
    }

    /* get (resource_generation_tasks.py:21450) — strictly owner-only. */
    public func get(userId: Array<Byte>, taskId: Array<Byte>): ?String {
        let sql = "SELECT " + resourceFullColumns() +
            " FROM learning_resource_generation_tasks WHERE id=" + sqlBinary(taskId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(serializeResourceTaskFull(rs.rows[0]))
        }
    }

    /* -------- write side -------- */

    /*
     * create (resource_generation_tasks.py:90-115). Events seed is the seq-1
     * SYSTEM "任务已创建" row; status/progress/stage_message are literals.
     * request_json is the model_dump() dict (snake_case keys).
     */
    public func create(userId: Array<Byte>, kind: String, title: String,
                       requestJson: String): ?String {
        let taskId = uuidV4()
        let now = sqlNowUtc8Literal()
        let eventTime = isoUtc8Now()
        let event = JsonWriter()
        event.putInt("seq", 1)
        event.putStr("time", eventTime)
        event.putStr("agent", "SYSTEM")
        event.putStr("agentName", "系统流程")
        event.putStr("actorType", "system")
        event.putStr("eventType", "task_lifecycle")
        event.putStr("status", "queued")
        event.putStr("phase", "queued")
        event.putStr("title", "任务已创建")
        event.putStr("detail", "等待 AI 教研组开始执行")
        let snap = JsonWriter()
        snap.putStr("resourceType", kind)
        event.putRaw("snapshot", snap.toJson())
        let eventsRaw = "[" + event.toJson() + "]"
        let resume = resumeEnabledFlag(requestJson)
        let sql = "INSERT INTO learning_resource_generation_tasks " +
            "(id,user_id,resource_type,title,status,progress,stage_message,request_json," +
            "events_json,resume_enabled,created_at,updated_at) VALUES(" +
            sqlBinary(taskId) + "," + sqlBinary(userId) + "," + sqlQuote(kind) + "," +
            sqlQuote(runeSlice(title, 160)) + ",'queued',2,'等待教研组执行'," +
            sqlQuote(requestJson) + "," + sqlQuote(eventsRaw) + "," +
            sqlInt(resume) + "," + now + "," + now + ")"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        return get(userId, taskId)
    }

    /*
     * create_reused (…:154-170) — create, then one `update` that completes it
     * and links the existing resource. Returns the post-update get().
     */
    public func createReused(userId: Array<Byte>, kind: String, title: String,
                             requestJson: String, resourceId: Array<Byte>): ?String {
        match (create(userId, kind, title, requestJson)) {
            case None => return None
            case Some(created) =>
                match (jsonGetStringFromRaw(created, "id")) {
                    case None => return Some(created)
                    case Some(idText) =>
                        match (uuidParse(idText)) {
                            case None => return Some(created)
                            case Some(taskId) =>
                                let snap = JsonWriter()
                                snap.putStr("resourceType", kind)
                                snap.putStr("resourceId", uuidFormat(resourceId))
                                snap.putBool("reused", true)
                                pyDrop(updateTask(taskId, userId, "completed", 100,
                                                  "已复用现有资源", "orchestrator",
                                                  "复用已生成资源",
                                                  "该知识点已有可用资源，本次任务已关联现有资源",
                                                  Some(resourceId), None, snap.toJson()))
                                return get(userId, taskId)
                        }
                }
        }
    }

    /*
     * update (…:365-408). Appends one event to events_json and rewrites the
     * status tuple. Returns the appended event as raw JSON, or None when the
     * row is missing (Python returns None early without writing).
     * `snapshotRaw` must be a JSON object; pass "{}" when empty.
     */
    public func updateTask(taskId: Array<Byte>, userId: Array<Byte>,
                           status: String, progress: Int64, stage: String,
                           agent: String, title: String, detail: String,
                           resourceId: ?Array<Byte>, error: ?String,
                           snapshotRaw: String): ?String {
        match (loadEventsRaw(taskId, userId)) {
            case None => return None
            case Some(evRaw) =>
                var seq: Int64 = 1
                match (jsonParse(evRaw)) {
                    case Some(evVal) =>
                        if (isJsArray(evVal)) {
                            seq = evVal.asArray().size() + 1
                        }
                    case None => ()
                }
                let (agentId, agentName) = agentIdentity(agent)
                let now = isoUtc8Now()
                let event = JsonWriter()
                event.putInt("seq", seq)
                event.putStr("time", now)
                event.putStr("agent", agentId)
                event.putStr("agentName", agentName)
                event.putStr("status", status)
                event.putStr("phase", status)
                event.putStr("title", title)
                event.putStr("detail", detail)
                event.putRaw("snapshot", snapshotRaw)
                if (agentId == "SYSTEM") {
                    event.putStr("actorType", "system")
                    event.putStr("eventType", "task_lifecycle")
                } else {
                    event.putStr("actorType", "agent")
                    event.putStr("eventType", "agent_work")
                }
                let newEvents = appendJsonArrayItem(evRaw, event.toJson())
                var prog = progress
                if (prog < 0) {
                    prog = 0
                }
                if (prog > 100) {
                    prog = 100
                }
                let sql = "UPDATE learning_resource_generation_tasks SET status=" +
                    sqlQuote(status) + ",progress=" + sqlInt(prog) +
                    ",stage_message=" + sqlQuote(runeSlice(stage, 500)) +
                    ",events_json=" + sqlQuote(newEvents) +
                    ",resource_id=" + sqlOptBinary(resourceId) +
                    ",error_message=" + sqlOptString(error) +
                    ",updated_at=" + sqlNowUtc8Literal() +
                    " WHERE id=" + sqlBinary(taskId) + " AND user_id=" + sqlBinary(userId)
                match (conn.query(sql)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(_) => ()
                }
                return Some(event.toJson())
        }
    }

    /*
     * cancel (…:220-233). Plain UPDATE — no event is appended. Returns the
     * post-update get() only when the row was still running.
     */
    public func cancel(userId: Array<Byte>, taskId: Array<Byte>): ?String {
        let sql = "UPDATE learning_resource_generation_tasks SET status='cancelled'," +
            "progress=100,stage_message='任务已取消',updated_at=" + sqlNowUtc8Literal() +
            " WHERE id=" + sqlBinary(taskId) + " AND user_id=" + sqlBinary(userId) +
            " AND status NOT IN ('completed','failed','cancelled')"
        var affected = false
        match (conn.query(sql)) {
            case QueryOutcome.Ok(ok) => affected = ok.affectedRows > 0
            case QueryOutcome.ResultSet(_) => affected = false
        }
        if (!affected) {
            return None
        }
        return get(userId, taskId)
    }

    /*
     * restart (…:437-454). Only failed/cancelled rows restart; anything else
     * returns None so the HTTP layer can answer 409.
     */
    public func restart(userId: Array<Byte>, taskId: Array<Byte>): ?String {
        var allowed = false
        match (conn.query("SELECT status FROM learning_resource_generation_tasks WHERE id=" +
                          sqlBinary(taskId) + " AND user_id=" + sqlBinary(userId))) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                let st = cellText(rs.rows[0], 0)
                allowed = (st == "failed" || st == "cancelled")
        }
        if (!allowed) {
            return None
        }
        pyDrop(updateTask(taskId, userId, "queued", 2, "任务已重新启动", "orchestrator",
                          "任务已重新启动", "已从失败/取消状态重新启动生成",
                          None, None, "{}"))
        return get(userId, taskId)
    }

    /*
     * list_same_name (…:332-347) — owned rows with the same (kind, title),
     * newest first. Returns (id, status) pairs.
     */
    public func listSameName(userId: Array<Byte>, kind: String,
                             title: String): Array<(String, String)> {
        let sql = "SELECT id,status FROM learning_resource_generation_tasks" +
            " WHERE user_id=" + sqlBinary(userId) + " AND resource_type=" + sqlQuote(kind) +
            " AND title=" + sqlQuote(runeSlice(title, 160)) +
            " ORDER BY created_at DESC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<(String, String)>(0, repeat: ("", ""))
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<(String, String)>()
                for (row in rs.rows) {
                    out.add((uuidText(row, 0) ?? "", cellText(row, 1)))
                }
                return out.toArray()
        }
    }

    /* delete_same_name_except (…:349-363). */
    public func deleteSameNameExcept(userId: Array<Byte>, kind: String, title: String,
                                     keepTaskId: Array<Byte>): Int64 {
        let sql = "DELETE FROM learning_resource_generation_tasks WHERE user_id=" +
            sqlBinary(userId) + " AND resource_type=" + sqlQuote(kind) +
            " AND title=" + sqlQuote(runeSlice(title, 160)) +
            " AND id<>" + sqlBinary(keepTaskId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(ok) => return ok.affectedRows
            case QueryOutcome.ResultSet(_) => return 0
        }
    }

    /* get_slides (…:259-273) — None when the owned row is missing. */
    public func getSlides(userId: Array<Byte>, taskId: Array<Byte>): ?String {
        let sql = "SELECT slides_json FROM learning_resource_generation_tasks WHERE id=" +
            sqlBinary(taskId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(loadsAny(cellText(rs.rows[0], 0), "[]"))
        }
    }

    /*
     * customize_service._list_user_customize_tasks (…:295-318). Summary shape,
     * ordered by created_at DESC; the kpId filter runs in Python against
     * request.kpId so the SQL keeps the exact JSON_EXTRACT predicate.
     */
    public func listCustomize(userId: Array<Byte>): Array<String> {
        let sql = "SELECT " + resourceSummaryColumns() +
            " FROM learning_resource_generation_tasks WHERE user_id=" + sqlBinary(userId) +
            " AND JSON_EXTRACT(request_json, '$.customize')=TRUE " +
            "ORDER BY created_at DESC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<String>(0, repeat: "")
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<String>()
                for (row in rs.rows) {
                    out.add(serializeResourceTaskSummary(row))
                }
                return out.toArray()
        }
    }

    private func loadEventsRaw(taskId: Array<Byte>, userId: Array<Byte>): ?String {
        let sql = "SELECT events_json FROM learning_resource_generation_tasks WHERE id=" +
            sqlBinary(taskId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(loadsAny(cellText(rs.rows[0], 0), "[]"))
        }
    }
}

/*
 * Python `json.dumps(events)` round-trip: keep existing items raw and append
 * one new object. `json.dumps` on a list always writes the compact form.
 */
func appendJsonArrayItem(arrRaw: String, itemRaw: String): String {
    let trimmed = arrRaw.trimAscii()
    if (trimmed == "[]" || trimmed == "") {
        return "[" + itemRaw + "]"
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        let runes = trimmed.toRuneArray()
        var inner = ""
        var i: Int64 = 1
        while (i < runes.size - 1) {
            inner = inner + runes[i].toString()
            i += 1
        }
        let cleaned = inner.trimAscii()
        if (cleaned == "") {
            return "[" + itemRaw + "]"
        }
        return "[" + cleaned + "," + itemRaw + "]"
    }
    return "[" + itemRaw + "]"
}

/*
 * resource_generation_tasks.create resume_enabled predicate (…:93-100).
 * Python truthiness — a present-but-falsy resumeEnabled still falls through to
 * the generation_context.adminGeneration fallback.
 */
func resumeEnabledFlag(requestJson: String): Int64 {
    match (jsonParse(requestJson)) {
        case None => return 0
        case Some(rv) =>
            if (!isJsObject(rv)) {
                return 0
            }
            let root = rv.asObject()
            if (pyTruthyValue(root.get("resumeEnabled")) ||
                pyTruthyValue(root.get("resume_enabled"))) {
                return 1
            }
            match (root.get("generation_context")) {
                case None =>
                    match (root.get("generationContext")) {
                        case None => return 0
                        case Some(g) => return resumeFromContext(g)
                    }
                case Some(g) => return resumeFromContext(g)
            }
    }
}

private func resumeFromContext(g: JsonValue): Int64 {
    if (!isJsObject(g)) {
        return 0
    }
    let ctx = g.asObject()
    if (pyTruthyValue(ctx.get("resumeEnabled")) ||
        pyTruthyValue(ctx.get("resume_enabled")) ||
        pyTruthyValue(ctx.get("adminGeneration"))) {
        return 1
    }
    return 0
}

/* Python truthiness for a JSON value: None/False/0/""/[]/{} are falsy. */
func pyTruthyValue(v: ?JsonValue): Bool {
    match (v) {
        case None => return false
        case Some(x) =>
            match (x.kind()) {
                case JsonKind.JsNull => return false
                case JsonKind.JsBool => return x.asBool().getValue()
                case JsonKind.JsString => return x.asString().getValue() != ""
                case JsonKind.JsInt => return x.asInt().getValue() != 0
                case JsonKind.JsFloat => return x.asFloat().getValue() != 0.0
                case JsonKind.JsArray => return x.asArray().size() > 0
                case JsonKind.JsObject => return x.asObject().getFields().size > 0
                case _ => return true
            }
    }
}

/*
 * update() agent → (agentId, agentName) map (resource_generation_tasks.py:377-387).
 * Unknown agents keep their own name as both fields.
 */
func agentIdentity(agent: String): (String, String) {
    if (agent == "planner") {
        return ("DIA-01", "教学策划 Agent")
    }
    if (agent == "retrieval") {
        return ("RET-02", "知识检索 Agent")
    }
    if (agent == "writer" || agent == "revision") {
        return ("GEN-03", "内容生成 Agent")
    }
    if (agent == "schema_validator" || agent == "citation_verifier" || agent == "reviewer") {
        return ("VER-04", "质量核验 Agent")
    }
    if (agent == "judge") {
        return ("ARB-05", "发布仲裁 Agent")
    }
    if (agent == "orchestrator") {
        return ("SYSTEM", "系统流程")
    }
    return (agent, agent)
}

/* Read one top-level string field out of a serialized task object. */
func jsonGetStringFromRaw(raw: String, key: String): ?String {
    match (jsonParse(raw)) {
        case None => return None
        case Some(v) =>
            if (!isJsObject(v)) {
                return None
            }
            return jsonGetString(v.asObject(), key)
    }
}

/*
 * _attach_stored_summaries_to_task (public.py:6009-6023) for task_type
 * "resource". Mutates each event in place: an event with no truthy
 * executionSummary gains one from admin_event_summaries when a summary exists.
 */
func attachResourceEventSummaries(conn: MyConnection, userId: Array<Byte>,
                                  taskId: Array<Byte>, taskRaw: String): String {
    match (jsonParse(taskRaw)) {
        case None => return taskRaw
        case Some(tv) =>
            if (!isJsObject(tv)) {
                return taskRaw
            }
            let task = tv.asObject()
            match (task.get("events")) {
                case None => return taskRaw
                case Some(evVal) =>
                    if (!isJsArray(evVal)) {
                        return taskRaw
                    }
                    if (evVal.asArray().size() == 0) {
                        return taskRaw
                    }
                    let newEvents = attachEventSummaries(conn, userId, "resource", taskId,
                                                         jsonArrayToRaw(evVal.asArray()))
                    return jsonSetKey(task, "events", newEvents)
            }
    }
}
