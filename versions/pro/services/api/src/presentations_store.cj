package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*

/*
 * Persistence for presentation_tasks / presentation_task_user_state and the
 * admin_event_summaries read-side back-fill.
 * Ported from src/agents/app/presentations/store.py (PresentationStore) and
 * src/agents/app/storage/event_summaries.py (latest_by_task).
 *
 * Scope — read + learning-state write-back only:
 *   list / get / mark_learned / update_learning / delete / batch_delete
 *
 * Generation (create / generate / restart / cancel / chat / tts) stays in the
 * Python service — those paths need the PPT agent and the LLM task queue.
 */

/*
 * presentation_tasks full column order (explicit, so positions stay stable —
 * Python uses SELECT * and then dict.get, which is order-independent):
 *   0 id, 1 user_id, 2 organization_id, 3 domain_code, 4 category_node_code,
 *   5 resource_group, 6 resource_scope, 7 review_status, 8 title, 9 status,
 *  10 progress, 11 stage_message, 12 request_json, 13 outline_json,
 *  14 events_json, 15 resume_enabled, 16 checkpoint_stage, 17 checkpoint_json,
 *  18 learned_json, 19 output_path, 20 error_message, 21 is_public,
 *  22 archived_at, 23 created_at, 24 updated_at
 */
func presentationFullColumns(): String {
    "id,user_id,organization_id,domain_code,category_node_code,resource_group," +
        "resource_scope,review_status,title,status,progress,stage_message," +
        "request_json,outline_json,events_json,resume_enabled,checkpoint_stage," +
        "checkpoint_json,learned_json,output_path,error_message,is_public," +
        "archived_at,created_at,updated_at"
}

/*
 * Summary column order (store.py:418). DictCursor quirks that the serializer
 * must reproduce literally:
 *   - checkpoint_stage is NOT selected → checkpointStage is always null
 *   - output_path is NOT selected → outputPath is always ""
 *   - request_json is selected only when exclude_course is set, so the summary
 *     payload carries a `request` key only in that case
 */
func presentationSummaryColumns(withRequest: Bool): String {
    let base = "id,title,status,progress,stage_message,error_message," +
        "created_at,updated_at,learned_json,user_id,is_public,resource_scope"
    if (withRequest) {
        return base + ",request_json"
    }
    return base
}

/*
 * Visibility clause shared by get/list. mark_learned and update_learning reuse
 * the same triple-OR but WITHOUT the archived_at filter (store.py:309 vs :248).
 *
 * The organization arm compares HEX(id) to the uppercase hex of the caller
 * UUID because PyMySQL can mis-encode BINARY(16) parameters (store.py:255).
 */
func presentationVisibility(userId: Array<Byte>): String {
    "((user_id=" + sqlBinary(userId) + " AND resource_scope IN ('USER','ORGANIZATION')) OR " +
        "(resource_scope='USER' AND is_public=1) OR " +
        "(resource_scope='ORGANIZATION' AND organization_id=(" +
        "SELECT organization_id FROM users WHERE HEX(id)=" +
        sqlQuote(bytesToHexUpper(userId)) + ")))"
}

func bytesEq(a: Array<Byte>, b: Array<Byte>): Bool {
    if (a.size != b.size) {
        return false
    }
    var i: Int64 = 0
    while (i < a.size) {
        if (a[i] != b[i]) {
            return false
        }
        i += 1
    }
    return true
}

/* Python ", ".join(items) — comma + space. Also valid inside SQL IN (...). */
func joinComma(items: Array<String>): String {
    var out = ""
    var first = true
    for (s in items) {
        if (!first) {
            out = out + ", "
        }
        first = false
        out = out + s
    }
    return out
}

/* Python: (row.get("is_public") or _is_org_shared(row, user_id)) and not _is_owner(row, user_id) */
func presentationIsSharedViewer(userCell: MyCell, scopeText: String,
                                isPublic: Int64, userId: Array<Byte>): Bool {
    if (!userCell.isNull && bytesEq(userCell.bytes, userId)) {
        return false
    }
    return isPublic != 0 || scopeText == "ORGANIZATION"
}

func presentationIsOwner(userCell: MyCell, userId: Array<Byte>): Bool {
    !userCell.isNull && bytesEq(userCell.bytes, userId)
}

func jsonFloatOrZero(v: JsonValue): Float64 {
    match (v.kind()) {
        case JsonKind.JsInt => return floatFromInt(v.asInt().getValue())
        case JsonKind.JsFloat => return v.asFloat().getValue()
        case JsonKind.JsString => return Float64.tryParse(v.asString().getValue()) ?? 0.0
        case JsonKind.JsBool => return if (v.asBool().getValue()) { 1.0 } else { 0.0 }
        case _ => return 0.0
    }
}

func jsonIntOrZero(v: JsonValue): Int64 {
    match (v.kind()) {
        case JsonKind.JsInt => return v.asInt().getValue()
        case JsonKind.JsFloat => return truncateFloat(v.asFloat().getValue())
        case JsonKind.JsString => return Int64.tryParse(v.asString().getValue()) ?? 0
        case JsonKind.JsBool => return if (v.asBool().getValue()) { 1 } else { 0 }
        case _ => return 0
    }
}

/*
 * Python json.dumps of a float keeps the decimal point ("1.0", not "1").
 * valueToRaw's jsonFloatText strips it for the courses overlay; mastery and
 * anchorRatio need the Python shape instead.
 */
func jsonFloatPy(v: Float64): String {
    let s = v.toString()
    if (s.contains(".") || s.contains("e") || s.contains("E") ||
        s.contains("inf") || s.contains("NaN") || s.contains("nan")) {
        return s
    }
    return s + ".0"
}

func jfloatPy(v: Float64): JsonValue {
    match (jsonParse(jsonFloatPy(v))) {
        case Some(x) => return x
        case None => return JsonValue.fromStr("0.0")
    }
}

/*
 * Python `{**item, "k": v, ...}`: original keys keep their positions with
 * overridden values; override keys absent from item are appended in override
 * order. JsonObject.getFields() preserves insertion order.
 */
func jsonOverlay(obj: JsonObject, overrides: Array<(String, JsonValue)>): String {
    let w = JsonWriter()
    for ((k, v) in obj.getFields()) {
        var replaced = false
        for (pair in overrides) {
            if (k == pair[0]) {
                w.putRaw(k, valueToRaw(pair[1]))
                replaced = true
                break
            }
        }
        if (!replaced) {
            w.putRaw(k, valueToRaw(v))
        }
    }
    for (pair in overrides) {
        if (!obj.containsKey(pair[0])) {
            w.putRaw(pair[0], valueToRaw(pair[1]))
        }
    }
    return w.toJson()
}

func loadsObject(text: String, fallbackRaw: String): String {
    if (text.isEmpty()) {
        return fallbackRaw
    }
    match (jsonParse(text)) {
        case None => return fallbackRaw
        case Some(v) =>
            if (isJsObject(v)) {
                return jsonObjectToRaw(v.asObject())
            }
            return fallbackRaw
    }
}

func loadsAny(text: String, fallbackRaw: String): String {
    if (text.isEmpty()) {
        return fallbackRaw
    }
    match (jsonParse(text)) {
        case None => return fallbackRaw
        case Some(v) => return valueToRaw(v)
    }
}

/*
 * PresentationStore._serialize (store.py:102-142).
 *
 * Key order is the contract — the verify matrix compares field-by-field and
 * the single-task payload is what the player reads.
 */
func serializePresentationSummary(row: Array<MyCell>, hasRequest: Bool,
                                  sharedLearnedRaw: ?String): String {
    let w = JsonWriter()
    let idText = uuidText(row, 0) ?? ""
    let status = cellText(row, 2)
    w.putStr("id", idText)
    w.putStr("title", cellText(row, 1))
    w.putStr("status", status)
    w.putInt("progress", optCellInt(row, 3) ?? 0)
    w.putStr("stageMessage", cellText(row, 4))
    /* DictCursor quirk: checkpoint_stage is not selected. */
    w.putRaw("checkpointStage", "null")
    w.putOptStr("errorMessage", optCellText(row, 5))
    if (status == "completed") {
        w.putStr("downloadUrl", "/v1/presentations/" + idText + "/download")
    } else {
        w.putRaw("downloadUrl", "null")
    }
    /* DictCursor quirk: output_path is not selected → "". */
    w.putStr("outputPath", "")
    match (sharedLearnedRaw) {
        case Some(raw) => writeLearnedFields(w, raw)
        case None => writeLearnedFields(w, cellText(row, 8))
    }
    w.putStr("createdAt", isoNaiveFromDb(cellText(row, 6)))
    w.putStr("updatedAt", isoNaiveFromDb(cellText(row, 7)))
    if (hasRequest) {
        match (summaryRequestContext(cellText(row, 12))) {
            case Some(raw) => w.putRaw("request", raw)
            case None => ()
        }
    }
    return w.toJson()
}

/* learned / learnedMeta from learned_json (store.py:111-112). */
func writeLearnedFields(w: JsonWriter, learnedRaw: String): Unit {
    let obj = presentationLearnedObject(learnedRaw)
    match (obj.get("learned")) {
        case Some(v) => w.putRaw("learned", valueToRaw(v))
        case None => w.putRaw("learned", "false")
    }
    w.putRaw("learnedMeta", jsonObjectToRaw(obj))
}

func presentationLearnedObject(learnedRaw: String): JsonObject {
    match (jsonParse(learnedRaw)) {
        case Some(v) =>
            if (isJsObject(v)) {
                return v.asObject()
            }
            return emptyObject()
        case None => return emptyObject()
    }
}

/*
 * Summary-mode `request` (store.py:116-124): only when request_json parses to
 * an object carrying a generationContext object, and only the eight management
 * keys — the full request/generationContext deliberately stays off the list.
 * The key is omitted entirely otherwise (not null).
 */
func summaryRequestContext(requestRaw: String): ?String {
    match (jsonParse(requestRaw)) {
        case None => return None
        case Some(v) =>
            if (!isJsObject(v)) {
                return None
            }
            match (jsonGetObject(v.asObject(), "generationContext")) {
                case None => return None
                case Some(ctx) =>
                    let keys = ["adminGeneration", "topicName", "domainCode", "nodeCode",
                                "kpId", "groupName", "queueSequence", "batchId"]
                    let inner = JsonWriter()
                    for (k in keys) {
                        match (ctx.get(k)) {
                            case Some(val) => inner.putRaw(k, valueToRaw(val))
                            case None => inner.putRaw(k, "null")
                        }
                    }
                    let outer = JsonWriter()
                    outer.putRaw("generationContext", inner.toJson())
                    return Some(outer.toJson())
            }
    }
}

func serializePresentationFull(row: Array<MyCell>, sharedLearnedRaw: ?String,
                               eventsRaw: String): String {
    let w = JsonWriter()
    let idText = uuidText(row, 0) ?? ""
    let status = cellText(row, 9)
    w.putStr("id", idText)
    w.putStr("title", cellText(row, 8))
    w.putStr("status", status)
    w.putInt("progress", optCellInt(row, 10) ?? 0)
    w.putStr("stageMessage", cellText(row, 11))
    w.putOptStr("checkpointStage", optCellText(row, 16))
    w.putOptStr("errorMessage", optCellText(row, 20))
    if (status == "completed") {
        w.putStr("downloadUrl", "/v1/presentations/" + idText + "/download")
    } else {
        w.putRaw("downloadUrl", "null")
    }
    w.putStr("outputPath", cellText(row, 19))
    match (sharedLearnedRaw) {
        case Some(raw) => writeLearnedFields(w, raw)
        case None => writeLearnedFields(w, cellText(row, 18))
    }
    w.putStr("createdAt", isoNaiveFromDb(cellText(row, 23)))
    w.putStr("updatedAt", isoNaiveFromDb(cellText(row, 24)))
    w.putRaw("request", loadsObject(cellText(row, 12), "{}"))
    /* Python: base["outline"] = outline_data (None when SQL NULL). */
    if (row[13].isNull) {
        w.putRaw("outline", "null")
    } else {
        w.putRaw("outline", loadsAny(row[13].text(), "null"))
    }
    w.putRaw("events", eventsRaw)
    return w.toJson()
}

/* One loaded presentation_tasks row plus its per-viewer learned_json override. */
struct RowPack {
    let row: Array<MyCell>
    let sharedLearned: ?String
    let eventsRaw: String
    init(row: Array<MyCell>, sharedLearned: ?String, eventsRaw: String) {
        this.row = row
        this.sharedLearned = sharedLearned
        this.eventsRaw = eventsRaw
    }
}

public class PresentationsStore {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    /* -------- read -------- */

    public func list(userId: Array<Byte>, limit: Int64, summary: Bool,
                     excludeCourse: Bool): Array<String> {
        let useSummary = summary
        let withRequest = useSummary && excludeCourse
        let columns = if (useSummary) {
            presentationSummaryColumns(withRequest)
        } else {
            presentationFullColumns()
        }
        let sql = "SELECT " + columns + " FROM presentation_tasks WHERE archived_at IS NULL AND " +
            presentationVisibility(userId) + " ORDER BY created_at DESC LIMIT " + sqlInt(limit)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<String>(0, repeat: "")
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return Array<String>(0, repeat: "")
                }
                let sharedIdx = ArrayList<Int64>()
                let sharedIds = ArrayList<Array<Byte>>()
                var i: Int64 = 0
                while (i < rs.rows.size) {
                    let row = rs.rows[i]
                    let scopeText = if (useSummary) { cellText(row, 11) } else { cellText(row, 6) }
                    let isPublic = if (useSummary) {
                        optCellInt(row, 10) ?? 0
                    } else {
                        optCellInt(row, 21) ?? 0
                    }
                    let userCell = if (useSummary) { row[9] } else { row[1] }
                    if (presentationIsSharedViewer(userCell, scopeText, isPublic, userId)) {
                        if (row[0].isBinary16()) {
                            sharedIdx.add(i)
                            sharedIds.add(row[0].bytes)
                        }
                    }
                    i += 1
                }
                let learnedByRow = HashMap<Int64, String>()
                if (!sharedIdx.isEmpty()) {
                    let parts = ArrayList<String>()
                    for (tid in sharedIds) {
                        parts.add(sqlBinary(tid))
                    }
                    let stateSql = "SELECT task_id, learned_json FROM presentation_task_user_state " +
                        "WHERE user_id=" + sqlBinary(userId) + " AND task_id IN (" +
                        joinComma(parts.toArray()) + ")"
                    match (conn.query(stateSql)) {
                        case QueryOutcome.Ok(_) => ()
                        case QueryOutcome.ResultSet(st) =>
                            for (srow in st.rows) {
                                if (srow[0].isBinary16()) {
                                    let key = uuidFormat(srow[0].bytes)
                                    var si: Int64 = 0
                                    while (si < sharedIdx.size) {
                                        if (uuidFormat(sharedIds[si]) == key) {
                                            learnedByRow.add(sharedIdx[si],
                                                             loadsObject(cellText(srow, 1), "{}"))
                                        }
                                        si += 1
                                    }
                                }
                            }
                    }
                }
                let out = ArrayList<String>()
                var r: Int64 = 0
                while (r < rs.rows.size) {
                    let row = rs.rows[r]
                    if (withRequest && rowHasCourseContext(cellText(row, 12))) {
                        r += 1
                        continue
                    }
                    var sharedRaw: ?String = None
                    match (learnedByRow.get(r)) {
                        case Some(learned) => sharedRaw = Some(learned)
                        case None => ()
                    }
                    if (useSummary) {
                        out.add(serializePresentationSummary(row, withRequest, sharedRaw))
                    } else {
                        out.add(serializePresentationFull(row, sharedRaw,
                                                          parseJsonArrayText(cellText(row, 14))))
                    }
                    r += 1
                }
                return out.toArray()
        }
    }

    /* get (store.py:248-265) — includes the executionSummary back-fill. */
    public func get(userId: Array<Byte>, taskId: Array<Byte>): ?String {
        match (loadRow(userId, taskId)) {
            case None => return None
            case Some(pack) =>
                let eventsRaw = attachEventSummaries(this.conn, userId, "ppt", taskId, pack.eventsRaw)
                return Some(serializePresentationFull(pack.row, pack.sharedLearned, eventsRaw))
        }
    }

    /*
     * Raw get — no executionSummary enrich. update_learning returns this,
     * matching store.py:402 (`return self.get(...)` runs _serialize only; the
     * route attaches summaries only on the GET-single route).
     */
    public func getRaw(userId: Array<Byte>, taskId: Array<Byte>): ?String {
        match (loadRow(userId, taskId)) {
            case None => return None
            case Some(pack) =>
                return Some(serializePresentationFull(pack.row, pack.sharedLearned, pack.eventsRaw))
        }
    }

    /*
     * store.py:404-416 output_for — the persisted output_path of a visible,
     * non-archived, status='completed' task. Unlike getRaw this filters
     * archived_at AND status, and skips serialization entirely.
     *
     * Python returns `row.get("output_path") if row else None`, so a NULL
     * column and a missing row both come back falsy and the route raises the
     * same 404. Collapsed here to None for both.
     */
    public func outputFor(userId: Array<Byte>, taskId: Array<Byte>): ?String {
        let sql = "SELECT output_path FROM presentation_tasks WHERE id=" + sqlBinary(taskId) +
            " AND archived_at IS NULL AND " + presentationVisibility(userId) +
            " AND status='completed'"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                let path = cellText(rs.rows[0], 0)
                if (path.isEmpty()) {
                    return None
                }
                return Some(path)
        }
    }

    private func loadRow(userId: Array<Byte>, taskId: Array<Byte>): ?RowPack {
        let sql = "SELECT " + presentationFullColumns() +
            " FROM presentation_tasks WHERE id=" + sqlBinary(taskId) +
            " AND archived_at IS NULL AND " + presentationVisibility(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                let row = rs.rows[0]
                var sharedRaw: ?String = None
                if (presentationIsSharedViewer(row[1], cellText(row, 6),
                                               optCellInt(row, 21) ?? 0, userId)) {
                    sharedRaw = Some(loadUserLearned(userId, taskId))
                }
                return Some(RowPack(row, sharedRaw, parseJsonArrayText(cellText(row, 14))))
        }
    }

    /* store.py:_user_learned */
    private func loadUserLearned(userId: Array<Byte>, taskId: Array<Byte>): String {
        let sql = "SELECT learned_json FROM presentation_task_user_state WHERE task_id=" +
            sqlBinary(taskId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return "{}"
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return "{}"
                }
                return loadsObject(cellText(rs.rows[0], 0), "{}")
        }
    }

    /* store.py:_save_user_learned — INSERT ... ON DUPLICATE KEY UPDATE. */
    private func saveUserLearned(userId: Array<Byte>, taskId: Array<Byte>,
                                 learnedRaw: String): Unit {
        let sql = "INSERT INTO presentation_task_user_state (task_id, user_id, learned_json) " +
            "VALUES (" + sqlBinary(taskId) + "," + sqlBinary(userId) + "," + sqlQuote(learnedRaw) + ") " +
            "ON DUPLICATE KEY UPDATE learned_json=VALUES(learned_json)"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
    }

    /*
     * mark_learned (store.py:309-345).
     *
     * Visibility here does NOT filter archived_at. Shared non-owners write only
     * learned/learnedAt into presentation_task_user_state; owners also raise
     * mastery to at least 1.0 and stamp updated_at on the task row.
     */
    public func markLearned(userId: Array<Byte>, taskId: Array<Byte>): Bool {
        let now = isoUtc8Now()
        let sql = "SELECT user_id, is_public, resource_scope, status, learned_json " +
            "FROM presentation_tasks WHERE id=" + sqlBinary(taskId) +
            " AND " + presentationVisibility(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return false
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return false
                }
                let row = rs.rows[0]
                if (cellText(row, 3) != "completed") {
                    return false
                }
                let isOwner = presentationIsOwner(row[0], userId)
                let isPublic = optCellInt(row, 1) ?? 0
                let scopeText = cellText(row, 2)
                if ((isPublic != 0 || scopeText == "ORGANIZATION") && !isOwner) {
                    let current = presentationLearnedObject(loadUserLearned(userId, taskId))
                    let ovr = ArrayList<(String, JsonValue)>()
                    ovr.add(("learned", JsonValue.fromStr("true")))
                    if (!current.containsKey("learnedAt")) {
                        ovr.add(("learnedAt", JsonValue.fromStr(jsonQuote(now))))
                    }
                    saveUserLearned(userId, taskId, jsonOverlay(current, ovr.toArray()))
                    return true
                }
                let current = presentationLearnedObject(cellText(row, 4))
                let ovr = ArrayList<(String, JsonValue)>()
                ovr.add(("learned", JsonValue.fromStr("true")))
                if (!current.containsKey("learnedAt")) {
                    ovr.add(("learnedAt", JsonValue.fromStr(jsonQuote(now))))
                }
                var mastery: Float64 = 0.0
                match (current.get("mastery")) {
                    case Some(m) => mastery = jsonFloatOrZero(m)
                    case None => ()
                }
                if (mastery < 1.0) {
                    mastery = 1.0
                }
                ovr.add(("mastery", jfloatPy(mastery)))
                ovr.add(("updatedAt", JsonValue.fromStr(jsonQuote(now))))
                let merged = jsonOverlay(current, ovr.toArray())
                let upd = "UPDATE presentation_tasks SET learned_json=" + sqlQuote(merged) +
                    ",updated_at=" + sqlNowUtc8Literal() + " WHERE id=" + sqlBinary(taskId) +
                    " AND user_id=" + sqlBinary(userId) + " AND status='completed'"
                match (conn.query(upd)) {
                    case QueryOutcome.Ok(ok) => return ok.affectedRows > 0
                    case QueryOutcome.ResultSet(_) => return false
                }
        }
    }

    /*
     * update_learning (store.py:347-402). page_index is 0-based in and becomes
     * a monotonic 1-based maxPageViewed; mastery is clamped to [0,1] and never
     * decreases. Returns the raw get() payload — no executionSummary enrich.
     */
    public func updateLearning(userId: Array<Byte>, taskId: Array<Byte>,
                               pageIndex: ?Int64, pageCount: ?Int64,
                               learned: ?Bool, mastery: ?Float64): ?String {
        let now = isoUtc8Now()
        let sql = "SELECT user_id, is_public, resource_scope, status, learned_json " +
            "FROM presentation_tasks WHERE id=" + sqlBinary(taskId) +
            " AND " + presentationVisibility(userId)
        var publicShared = false
        var current: JsonObject = emptyObject()
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                let row = rs.rows[0]
                if (cellText(row, 3) != "completed") {
                    return None
                }
                let isOwner = presentationIsOwner(row[0], userId)
                let isPublic = optCellInt(row, 1) ?? 0
                let scopeText = cellText(row, 2)
                publicShared = (isPublic != 0 || scopeText == "ORGANIZATION") && !isOwner
                current = if (publicShared) {
                    presentationLearnedObject(loadUserLearned(userId, taskId))
                } else {
                    presentationLearnedObject(cellText(row, 4))
                }
        }
        let ovr = ArrayList<(String, JsonValue)>()
        match (pageIndex) {
            case Some(pi) =>
                var prev: Int64 = 0
                match (current.get("maxPageViewed")) {
                    case Some(v) => prev = jsonIntOrZero(v)
                    case None => ()
                }
                let next = pi + 1
                ovr.add(("maxPageViewed", JsonValue.fromStr((if (prev > next) { prev } else { next }).toString())))
            case None => ()
        }
        match (pageCount) {
            case Some(pc) => ovr.add(("pageCount", JsonValue.fromStr(pc.toString())))
            case None => ()
        }
        match (learned) {
            case Some(lv) =>
                ovr.add(("learned", JsonValue.fromStr(if (lv) { "true" } else { "false" })))
                if (lv && !current.containsKey("learnedAt")) {
                    ovr.add(("learnedAt", JsonValue.fromStr(jsonQuote(now))))
                }
            case None => ()
        }
        match (mastery) {
            case Some(mv) =>
                var prev: Float64 = 0.0
                match (current.get("mastery")) {
                    case Some(v) => prev = jsonFloatOrZero(v)
                    case None => ()
                }
                var clamped = mv
                if (clamped > 1.0) {
                    clamped = 1.0
                }
                if (clamped < 0.0) {
                    clamped = 0.0
                }
                ovr.add(("mastery", jfloatPy(if (prev > clamped) { prev } else { clamped })))
            case None => ()
        }
        ovr.add(("updatedAt", JsonValue.fromStr(jsonQuote(now))))
        let merged = jsonOverlay(current, ovr.toArray())
        if (publicShared) {
            saveUserLearned(userId, taskId, merged)
        } else {
            let upd = "UPDATE presentation_tasks SET learned_json=" + sqlQuote(merged) +
                ",updated_at=" + sqlNowUtc8Literal() + " WHERE id=" + sqlBinary(taskId) +
                " AND user_id=" + sqlBinary(userId)
            match (conn.query(upd)) {
                case QueryOutcome.Ok(_) => ()
                case QueryOutcome.ResultSet(_) => ()
            }
        }
        return getRaw(userId, taskId)
    }

    /*
     * delete (store.py:691-713). Owner-only, terminal states only. Returns the
     * former output_path (empty string when the column is NULL) or None when
     * the row is missing / not owned / still running.
     */
    public func delete(userId: Array<Byte>, taskId: Array<Byte>): ?String {
        let probe = "SELECT output_path FROM presentation_tasks WHERE id=" + sqlBinary(taskId) +
            " AND user_id=" + sqlBinary(userId) +
            " AND status IN ('completed','failed','cancelled')"
        var outputPath = ""
        match (conn.query(probe)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                outputPath = cellText(rs.rows[0], 0)
        }
        match (conn.query("DELETE FROM presentation_tasks WHERE id=" + sqlBinary(taskId) +
            " AND user_id=" + sqlBinary(userId))) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        return Some(outputPath)
    }

    /*
     * batch_delete (store.py:728-763). All-or-nothing inside one transaction:
     * any missing / not-owned / still-active id aborts the whole batch.
     * The Chinese ValueError messages are returned verbatim so the route can
     * map the substring "仍在进行中" to 409 and everything else to 404.
     */
    public func batchDelete(userId: Array<Byte>, taskIds: Array<Array<Byte>>): BatchDeleteOutcome {
        if (taskIds.isEmpty()) {
            return BatchDeleteOutcome.Ok(Array<String>(0, repeat: ""))
        }
        match (conn.query("START TRANSACTION")) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        let parts = ArrayList<String>()
        for (tid in taskIds) {
            parts.add(sqlBinary(tid))
        }
        let inList = joinComma(parts.toArray())
        let probe = "SELECT id, output_path, status FROM presentation_tasks WHERE user_id=" +
            sqlBinary(userId) + " AND id IN (" + inList + ") FOR UPDATE"
        let found = HashSet<String>()
        let rowOrder = ArrayList<Array<Byte>>()
        let rowStatus = ArrayList<String>()
        let rowOutput = ArrayList<String>()
        match (conn.query(probe)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                for (row in rs.rows) {
                    if (row[0].isBinary16()) {
                        found.add(uuidFormat(row[0].bytes))
                        rowOrder.add(row[0].bytes)
                        rowStatus.add(cellText(row, 2))
                        rowOutput.add(cellText(row, 1))
                    }
                }
        }
        /* Missing ids follow the INPUT order (store.py:741). */
        let missing = ArrayList<String>()
        for (tid in taskIds) {
            if (!found.contains(uuidFormat(tid))) {
                missing.add(uuidFormat(tid))
            }
        }
        if (!missing.isEmpty()) {
            rollback()
            return BatchDeleteOutcome.Err("任务不存在或不属于当前用户: " + joinComma(missing.toArray()))
        }
        /* Active ids follow the SELECT row order (store.py:744). */
        let active = ArrayList<String>()
        var i: Int64 = 0
        while (i < rowOrder.size) {
            let st = rowStatus[i]
            if (st != "completed" && st != "failed" && st != "cancelled") {
                active.add(uuidFormat(rowOrder[i]))
            }
            i += 1
        }
        if (!active.isEmpty()) {
            rollback()
            return BatchDeleteOutcome.Err("任务仍在进行中，无法删除: " + joinComma(active.toArray()))
        }
        match (conn.query("DELETE FROM presentation_tasks WHERE user_id=" + sqlBinary(userId) +
            " AND id IN (" + inList + ")")) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        match (conn.query("COMMIT")) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        return BatchDeleteOutcome.Ok(rowOutput.toArray())
    }

    private func rollback(): Unit {
        match (conn.query("ROLLBACK")) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
    }
}

public enum BatchDeleteOutcome {
    Ok(Array<String>) | Err(String)
}

/* store.py:_row_has_course_context — truthy request_json.generationContext.courseId. */
func rowHasCourseContext(requestRaw: String): Bool {
    match (jsonParse(requestRaw)) {
        case None => return false
        case Some(v) =>
            if (!isJsObject(v)) {
                return false
            }
            match (jsonGetObject(v.asObject(), "generationContext")) {
                case None => return false
                case Some(ctx) =>
                    match (ctx.get("courseId")) {
                        case None => return false
                        case Some(cv) => return jsonValTruthy(cv)
                    }
            }
    }
}

/*
 * admin_event_summaries.latest_by_task (event_summaries.py:85-103) and
 * public.py:_attach_stored_summaries_to_task.
 *
 * Per-viewer: the summary table is keyed by user_id, so a shared presentation
 * shows each viewer their own summaries. Only MAX(revision) per seq counts.
 * An event that already carries a truthy executionSummary is left alone.
 */
func attachEventSummaries(conn: MyConnection, userId: Array<Byte>, taskType: String,
                          taskId: Array<Byte>, eventsRaw: String): String {
    match (jsonParse(eventsRaw)) {
        case None => return eventsRaw
        case Some(evVal) =>
            if (!isJsArray(evVal)) {
                return eventsRaw
            }
            let events = evVal.asArray()
            if (events.size() == 0) {
                return eventsRaw
            }
            let summaries = loadLatestEventSummaries(conn, userId, taskType, taskId)
            if (summaries.isEmpty()) {
                return eventsRaw
            }
            let out = JsonArrWriter()
            var i: Int64 = 0
            while (i < events.size()) {
                match (events.get(i)) {
                    case None => out.addRaw("null")
                    case Some(item) =>
                        if (!isJsObject(item)) {
                            out.addRaw(valueToRaw(item))
                        } else {
                            let obj = item.asObject()
                            /* Python: seq = int(raw.get("seq") or index + 1) */
                            var seq: Int64 = i + 1
                            match (obj.get("seq")) {
                                case Some(sv) =>
                                    let s = jsonIntOrZero(sv)
                                    if (s != 0) {
                                        seq = s
                                    }
                                case None => ()
                            }
                            var already = false
                            match (obj.get("executionSummary")) {
                                case Some(ev) => already = jsonValTruthy(ev)
                                case None => ()
                            }
                            if (already) {
                                out.addRaw(jsonObjectToRaw(obj))
                            } else {
                                match (summaries.get(seq)) {
                                    case None => out.addRaw(jsonObjectToRaw(obj))
                                    case Some(text) =>
                                        if (text.isEmpty()) {
                                            out.addRaw(jsonObjectToRaw(obj))
                                        } else {
                                            let ovr = ArrayList<(String, JsonValue)>()
                                            ovr.add(("executionSummary",
                                                     JsonValue.fromStr(jsonQuote(text))))
                                            out.addRaw(jsonOverlay(obj, ovr.toArray()))
                                        }
                                }
                            }
                        }
                }
                i += 1
            }
            return out.toJson()
    }
}

func loadLatestEventSummaries(conn: MyConnection, userId: Array<Byte>, taskType: String,
                              taskId: Array<Byte>): HashMap<Int64, String> {
    let out = HashMap<Int64, String>()
    let sql = "SELECT s.seq, s.summary FROM admin_event_summaries s JOIN (" +
        "SELECT seq, MAX(revision) revision FROM admin_event_summaries " +
        "WHERE user_id=" + sqlBinary(userId) + " AND task_type=" + sqlQuote(taskType) +
        " AND task_id=" + sqlBinary(taskId) + " GROUP BY seq" +
        ") latest ON latest.seq=s.seq AND latest.revision=s.revision"
    try {
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                for (row in rs.rows) {
                    out.add(optCellInt(row, 0) ?? 0, cellText(row, 1))
                }
        }
    } catch (_: Exception) {
        /* admin_event_summaries is optional — a missing table just means no summaries. */
    }
    return out
}
