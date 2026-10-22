package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*

/*
 * Persistence for generated_learning_resources and the per-viewer state /
 * source-feedback side tables.
 * Ported from src/agents/app/storage/learning_resources.py
 *   get / list / update_state / update_progress / mark_learned /
 *   create_source_feedback / _serialize
 * Knowledge-point matching lives in knowledge_match.cj.
 */

public struct OwnerRow {
    public let userId: Array<Byte>
    public let isPublic: Bool

    public init(userId: Array<Byte>, isPublic: Bool) {
        this.userId = userId
        this.isPublic = isPublic
    }
}

public struct ProgressReq {
    public let currentBlockId: ?String
    public let visitedBlockIds: Array<String>
    public let completedStepIds: Array<String>
    public let elapsedSeconds: Int64
    public let selfAssessments: Array<(String, Float64)>

    public init(currentBlockId: ?String, visitedBlockIds: Array<String>,
                completedStepIds: Array<String>, elapsedSeconds: Int64,
                selfAssessments: Array<(String, Float64)>) {
        this.currentBlockId = currentBlockId
        this.visitedBlockIds = visitedBlockIds
        this.completedStepIds = completedStepIds
        this.elapsedSeconds = elapsedSeconds
        this.selfAssessments = selfAssessments
    }
}

/*
 * Summary list columns (no content/sources/context/decision):
 *   0 id, 1 user_id, 2 learner_id, 3 kp_id, 4 form, 5 level, 6 version,
 *   7 quiz_ids_json, 8 kb_refs_json, 9 resource_type, 10 title, 11 topic,
 *  12 learning_goal_id, 13 course_id, 14 chapter_id,
 *  15 state_json, 16 created_at, 17 updated_at, 18 is_public
 * Detail columns add content/sources/state/context/decision before is_public:
 *  15 content_json, 16 sources_json, 17 state_json, 18 context_json,
 *  19 decision_json, 20 is_public, 21 created_at, 22 updated_at
 */
private func summaryColumns(): String {
    "id,user_id,learner_id,kp_id,form,level,version,quiz_ids_json,kb_refs_json," +
        "resource_type,title,topic,learning_goal_id,course_id,chapter_id," +
        "state_json,created_at,updated_at,is_public"
}

private func detailColumns(prefix: String): String {
    prefix + "id," + prefix + "user_id," + prefix + "learner_id," + prefix + "kp_id," +
        prefix + "form," + prefix + "level," + prefix + "version," +
        prefix + "quiz_ids_json," + prefix + "kb_refs_json," +
        prefix + "resource_type," + prefix + "title," + prefix + "topic," +
        prefix + "learning_goal_id," + prefix + "course_id," + prefix + "chapter_id," +
        prefix + "content_json," + prefix + "sources_json," + prefix + "state_json," +
        prefix + "context_json," + prefix + "decision_json," +
        prefix + "is_public," + prefix + "created_at," + prefix + "updated_at"
}

public class ResourcesStore {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    /* -------- visibility helpers -------- */

    private func ownerOf(resourceId: Array<Byte>): ?OwnerRow {
        let sql = "SELECT user_id,is_public FROM generated_learning_resources " +
            "WHERE id=" + sqlBinary(resourceId) +
            " AND archived_at IS NULL AND resource_scope='USER'"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                let row = rs.rows[0]
                return Some(OwnerRow(row[0].bytes, optCellBool(row, 1) ?? false))
        }
    }

    private func isOwner(owner: OwnerRow, userId: Array<Byte>): Bool {
        bytesEqual(owner.userId, userId)
    }

    private func userStateJson(resourceId: Array<Byte>, userId: Array<Byte>): String {
        let sql = "SELECT state_json FROM learning_resource_user_state " +
            "WHERE resource_id=" + sqlBinary(resourceId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return "{}"
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return "{}"
                }
                return parseState(cellText(rs.rows[0], 0))
        }
    }

    private func saveUserState(resourceId: Array<Byte>, userId: Array<Byte>, stateJson: String): Unit {
        let now = mysqlDatetime(nowUtcParts())
        let sql = "INSERT INTO learning_resource_user_state (resource_id,user_id,state_json,updated_at) VALUES (" +
            sqlBinary(resourceId) + "," + sqlBinary(userId) + "," + sqlQuote(stateJson) + "," + sqlQuote(now) + ") " +
            "ON DUPLICATE KEY UPDATE state_json=VALUES(state_json), updated_at=VALUES(updated_at)"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
    }

    private func ownerStateJson(resourceId: Array<Byte>, userId: Array<Byte>): String {
        let sql = "SELECT state_json FROM generated_learning_resources " +
            "WHERE id=" + sqlBinary(resourceId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return ""
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return ""
                }
                return parseState(cellText(rs.rows[0], 0))
        }
    }

    /* -------- read -------- */

    public func list(userId: Array<Byte>, kind: ?String, includeCourse: Bool,
                     learnerId: ?Array<Byte>, kpId: ?String, form: ?String, level: ?String,
                     courseId: ?Array<Byte>, chapterId: ?Array<Byte>, ownOnly: Bool): Array<String> {
        /* ownOnly：只看本人生成的资源，不掺入 is_public 的共享资源（「我的资源」页用） */
        let ownership = if (ownOnly) {
            "user_id=" + sqlBinary(userId)
        } else {
            "(user_id=" + sqlBinary(userId) + " OR is_public=1)"
        }
        var sql = "SELECT " + summaryColumns() +
            " FROM generated_learning_resources WHERE archived_at IS NULL " +
            "AND resource_scope='USER' AND " + ownership
        if (!includeCourse) {
            sql = sql + " AND course_id IS NULL"
        }
        match (kind) {
            case Some(k) => sql = sql + " AND resource_type=" + sqlQuote(k)
            case None => ()
        }
        match (learnerId) {
            case Some(l) => sql = sql + " AND learner_id=" + sqlBinary(l)
            case None => ()
        }
        match (kpId) {
            case Some(k) => sql = sql + " AND kp_id=" + sqlQuote(k)
            case None => ()
        }
        match (form) {
            case Some(f) => sql = sql + " AND form=" + sqlQuote(f)
            case None => ()
        }
        match (level) {
            case Some(l) => sql = sql + " AND level=" + sqlQuote(l)
            case None => ()
        }
        match (courseId) {
            case Some(c) => sql = sql + " AND course_id=" + sqlBinary(c)
            case None => ()
        }
        match (chapterId) {
            case Some(c) => sql = sql + " AND chapter_id=" + sqlBinary(c)
            case None => ()
        }
        sql = sql + " ORDER BY updated_at DESC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<String>(0, repeat: "")
            case QueryOutcome.ResultSet(rs) =>
                /* Batch-load per-viewer state for public rows we do not own (no N+1). */
                let sharedRowIdx = ArrayList<Int64>()
                let sharedResourceIds = ArrayList<Array<Byte>>()
                var i: Int64 = 0
                while (i < rs.rows.size) {
                    let row = rs.rows[i]
                    let isPublic = optCellBool(row, 18) ?? false
                    if (isPublic && !bytesEqual(row[1].bytes, userId)) {
                        sharedRowIdx.add(i)
                        sharedResourceIds.add(row[0].bytes)
                    }
                    i += 1
                }
                let stateByUuid = HashMap<String, String>()
                if (!sharedResourceIds.isEmpty()) {
                    var idList = ""
                    var j: Int64 = 0
                    while (j < sharedResourceIds.size) {
                        if (j > 0) {
                            idList = idList + ","
                        }
                        idList = idList + sqlBinary(sharedResourceIds[j])
                        j += 1
                    }
                    let stSql = "SELECT resource_id,state_json FROM learning_resource_user_state " +
                        "WHERE user_id=" + sqlBinary(userId) + " AND resource_id IN (" + idList + ")"
                    match (conn.query(stSql)) {
                        case QueryOutcome.Ok(_) => ()
                        case QueryOutcome.ResultSet(st) =>
                            var k: Int64 = 0
                            while (k < st.rows.size) {
                                stateByUuid.add(uuidFormat(st.rows[k][0].bytes), cellText(st.rows[k], 1))
                                k += 1
                            }
                    }
                }
                let out = ArrayList<String>()
                var r: Int64 = 0
                while (r < rs.rows.size) {
                    var stateText = cellText(rs.rows[r], 15)
                    var s: Int64 = 0
                    while (s < sharedRowIdx.size) {
                        if (sharedRowIdx[s] == r) {
                            match (stateByUuid.get(uuidFormat(rs.rows[r][0].bytes))) {
                                case Some(v) => stateText = parseState(v)
                                case None => stateText = "{}"
                            }
                        }
                        s += 1
                    }
                    out.add(serializeSummary(rs.rows[r], stateText))
                    r += 1
                }
                return out.toArray()
        }
    }

    public func get(userId: Array<Byte>, resourceId: Array<Byte>): ?String {
        let sql = "SELECT " + detailColumns("resource.") +
            " FROM generated_learning_resources resource " +
            "JOIN users viewer ON viewer.id=" + sqlBinary(userId) +
            " WHERE resource.id=" + sqlBinary(resourceId) +
            " AND resource.archived_at IS NULL AND (" +
            "(resource.resource_scope='USER' AND (resource.user_id=" + sqlBinary(userId) + " OR resource.is_public=1)) OR " +
            "(resource.resource_scope='ORGANIZATION' AND resource.organization_id=viewer.organization_id AND (" +
            "EXISTS (SELECT 1 FROM generated_learning_resources marker " +
            "WHERE marker.organization_id=resource.organization_id " +
            "AND BINARY marker.domain_code=BINARY resource.domain_code " +
            "AND BINARY marker.category_node_code=BINARY resource.category_node_code " +
            "AND BINARY COALESCE(marker.resource_group,'默认分组')=BINARY COALESCE(resource.resource_group,'默认分组') " +
            "AND marker.resource_scope='ORGANIZATION' AND marker.is_template=1 AND marker.archived_at IS NULL) OR " +
            "EXISTS (SELECT 1 FROM presentation_tasks marker " +
            "WHERE marker.organization_id=resource.organization_id " +
            "AND BINARY marker.domain_code=BINARY resource.domain_code " +
            "AND BINARY marker.category_node_code=BINARY resource.category_node_code " +
            "AND BINARY COALESCE(marker.resource_group,'默认分组')=BINARY COALESCE(resource.resource_group,'默认分组') " +
            "AND marker.resource_scope='ORGANIZATION' AND marker.is_template=1 AND marker.archived_at IS NULL)" +
            ")))"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                let row = rs.rows[0]
                let isPublic = optCellBool(row, 20) ?? false
                let ownerBytes = row[1].bytes
                let scope = resourceScope(resourceId)
                var stateText = cellText(row, 17)
                /* Public non-owner and shared ORGANIZATION templates substitute
                 * per-viewer state from learning_resource_user_state. */
                let shared = scope == "ORGANIZATION" || (isPublic && !bytesEqual(ownerBytes, userId))
                if (shared) {
                    stateText = userStateJson(resourceId, userId)
                }
                return Some(serializeDetail(row, stateText))
        }
    }

    private func resourceScope(resourceId: Array<Byte>): String {
        let sql = "SELECT resource_scope FROM generated_learning_resources WHERE id=" + sqlBinary(resourceId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return "USER"
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return "USER"
                }
                return cellText(rs.rows[0], 0)
        }
    }

    /* -------- write-back -------- */

    public func markLearned(userId: Array<Byte>, resourceId: Array<Byte>): ?String {
        match (ownerOf(resourceId)) {
            case None => return None
            case Some(owner) =>
                let now = mysqlDatetime(nowUtcParts())
                if (owner.isPublic && !isOwner(owner, userId)) {
                    let merged = mergeStateJson(userStateJson(resourceId, userId), "learned")
                    saveUserState(resourceId, userId, merged)
                } else {
                    let cur = ownerStateJson(resourceId, userId)
                    if (cur == "") {
                        return None
                    }
                    let merged = mergeStateJson(cur, "learned")
                    let sql = "UPDATE generated_learning_resources SET state_json=" + sqlQuote(merged) +
                        ",updated_at=" + sqlQuote(now) +
                        " WHERE id=" + sqlBinary(resourceId) + " AND user_id=" + sqlBinary(userId)
                    match (conn.query(sql)) {
                        case QueryOutcome.Ok(_) => ()
                        case QueryOutcome.ResultSet(_) => ()
                    }
                }
                return get(userId, resourceId)
        }
    }

    public func updateProgress(userId: Array<Byte>, resourceId: Array<Byte>, req: ProgressReq): ?String {
        match (ownerOf(resourceId)) {
            case None => return None
            case Some(owner) =>
                let now = mysqlDatetime(nowUtcParts())
                let publicShared = owner.isPublic && !isOwner(owner, userId)
                var baseState = "{}"
                if (publicShared) {
                    baseState = userStateJson(resourceId, userId)
                } else {
                    baseState = ownerStateJson(resourceId, userId)
                    if (baseState == "") {
                        return None
                    }
                }
                let merged = mergeProgress(baseState, req, isoDatetime(nowUtcParts()))
                if (publicShared) {
                    saveUserState(resourceId, userId, merged)
                } else {
                    let sql = "UPDATE generated_learning_resources SET state_json=" + sqlQuote(merged) +
                        ",updated_at=" + sqlQuote(now) +
                        " WHERE id=" + sqlBinary(resourceId) + " AND user_id=" + sqlBinary(userId)
                    match (conn.query(sql)) {
                        case QueryOutcome.Ok(_) => ()
                        case QueryOutcome.ResultSet(_) => ()
                    }
                }
                return get(userId, resourceId)
        }
    }

    /* Replace state wholesale (reset). Pass "{}" to clear learner progress. */
    public func updateState(userId: Array<Byte>, resourceId: Array<Byte>, stateJson: String): ?String {
        match (ownerOf(resourceId)) {
            case None => return None
            case Some(owner) =>
                let now = mysqlDatetime(nowUtcParts())
                if (owner.isPublic && !isOwner(owner, userId)) {
                    saveUserState(resourceId, userId, stateJson)
                } else {
                    let sql = "UPDATE generated_learning_resources SET state_json=" + sqlQuote(stateJson) +
                        ",updated_at=" + sqlQuote(now) +
                        " WHERE id=" + sqlBinary(resourceId) + " AND user_id=" + sqlBinary(userId)
                    match (conn.query(sql)) {
                        case QueryOutcome.Ok(ok) =>
                            if (ok.affectedRows <= 0) {
                                return None
                            }
                        case QueryOutcome.ResultSet(_) => return None
                    }
                }
                return get(userId, resourceId)
        }
    }

    /* Quiz answers that also rewrite content (adaptive next-question injection). */
    public func replaceContentAndState(userId: Array<Byte>, resourceId: Array<Byte>,
                                       contentJson: String, stateJson: String): ?String {
        let now = mysqlDatetime(nowUtcParts())
        let sql = "UPDATE generated_learning_resources SET content_json=" + sqlQuote(contentJson) +
            ",state_json=" + sqlQuote(stateJson) + ",updated_at=" + sqlQuote(now) +
            " WHERE id=" + sqlBinary(resourceId) + " AND user_id=" + sqlBinary(userId) +
            " AND resource_scope='USER'"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(ok) =>
                if (ok.affectedRows <= 0) {
                    return None
                }
            case QueryOutcome.ResultSet(_) => return None
        }
        return get(userId, resourceId)
    }

    public func createSourceFeedback(userId: Array<Byte>, resourceId: Array<Byte>,
                                     sourceId: String, issueType: String, note: ?String): ?String {
        let feedbackId = uuidV4()
        let now = mysqlDatetime(nowUtcParts())
        let sql = "INSERT INTO learning_resource_source_feedback " +
            "(id,resource_id,user_id,source_id,issue_type,note,status,created_at) " +
            "SELECT " + sqlBinary(feedbackId) + ",id," + sqlBinary(userId) + "," +
            sqlQuote(sourceId) + "," + sqlQuote(issueType) + "," + sqlOptString(note) +
            ",'submitted'," + sqlQuote(now) +
            " FROM generated_learning_resources WHERE id=" + sqlBinary(resourceId) +
            " AND archived_at IS NULL AND resource_scope='USER' AND (user_id=" + sqlBinary(userId) +
            " OR is_public=1)"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(ok) =>
                if (ok.affectedRows != 1) {
                    return None
                }
            case QueryOutcome.ResultSet(_) => return None
        }
        let obj = JsonWriter()
        obj.putStr("id", uuidFormat(feedbackId))
        obj.putStr("resourceId", uuidFormat(resourceId))
        obj.putStr("sourceId", sourceId)
        obj.putStr("issueType", issueType)
        obj.putOptStr("note", note)
        obj.putStr("status", "submitted")
        obj.putStr("createdAt", isoDatetime(nowUtcParts()))
        return Some(obj.toJson())
    }
}

/* -------- shared helpers -------- */

func bytesEqual(a: Array<Byte>, b: Array<Byte>): Bool {
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

func parseState(text: String): String {
    let t = text.trimAscii()
    if (t.isEmpty() || !t.startsWith("{")) {
        return "{}"
    }
    return t
}

/* Recursive JSON text writer — never JsonObject.toJsonString(). */
func valueToRaw(v: JsonValue): String {
    match (v.kind()) {
        case JsonKind.JsString => return jsonQuote(v.asString().getValue())
        case JsonKind.JsInt => return v.asInt().getValue().toString()
        case JsonKind.JsFloat => return jsonFloatText(v.asFloat().getValue())
        case JsonKind.JsBool => return if (v.asBool().getValue()) { "true" } else { "false" }
        case JsonKind.JsNull => return "null"
        case JsonKind.JsObject => return jsonObjectToRaw(v.asObject())
        case JsonKind.JsArray => return jsonArrayToRaw(v.asArray())
    }
}

func jsonObjectToRaw(obj: JsonObject): String {
    let w = JsonWriter()
    for ((k, v) in obj.getFields()) {
        w.putRaw(k, valueToRaw(v))
    }
    return w.toJson()
}

func jsonArrayToRaw(arr: JsonArray): String {
    let w = JsonArrWriter()
    var i: Int64 = 0
    while (i < arr.size()) {
        match (arr.get(i)) {
            case Some(item) => w.addRaw(valueToRaw(item))
            case None => ()
        }
        i += 1
    }
    return w.toJson()
}

func emptyObject(): JsonObject {
    match (jsonParse("{}")) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsObject => return v.asObject()
                case _ => return jobj()
            }
        case None => return jobj()
    }
}

/* Copy every key of `base` that `patch` does not carry, then overlay `patch`. */
func jsonMergeObjects(base: JsonObject, patch: JsonObject): String {
    let w = JsonWriter()
    for ((k, v) in base.getFields()) {
        if (!patch.containsKey(k)) {
            w.putRaw(k, valueToRaw(v))
        }
    }
    for ((k, v) in patch.getFields()) {
        w.putRaw(k, valueToRaw(v))
    }
    return w.toJson()
}

/*
 * mark_learned / answer writeback: set learned=true and learnedAt, keep the
 * rest of the state blob.
 */
func mergeStateJson(baseText: String, mode: String): String {
    match (jsonParse(baseText)) {
        case None => return "{}"
        case Some(v) =>
            var base = emptyObject()
            if (isJsObject(v)) {
                base = v.asObject()
            }
            if (mode == "learned") {
                let patch = JsonWriter()
                patch.putRaw("learned", "true")
                patch.putStr("learnedAt", isoDatetime(nowUtcParts()))
                match (jsonParse(patch.toJson())) {
                    case Some(pv) =>
                        if (isJsObject(pv)) {
                            return jsonMergeObjects(base, pv.asObject())
                        }
                    case None => ()
                }
            }
            return jsonObjectToRaw(base)
    }
}

/*
 * Apply LearningResourceProgressRequest onto state.progress / state.selfAssessments,
 * mirroring LearningResourceStore.update_progress.
 */
func mergeProgress(baseText: String, req: ProgressReq, lastOpenedAt: String): String {
    match (jsonParse(baseText)) {
        case None => return baseText
        case Some(v) =>
            var base = emptyObject()
            if (isJsObject(v)) {
                base = v.asObject()
            }
            /* Prior progress: keep unknown keys, then overwrite the five we own. */
            var current = emptyObject()
            match (jsonGetObject(base, "progress")) {
                case Some(p) => current = p
                case None => ()
            }
            var curElapsed: Int64 = 0
            match (jsonGetInt(current, "elapsedSeconds")) {
                case Some(e) => curElapsed = e
                case None => ()
            }
            let elapsed = if (req.elapsedSeconds > curElapsed) { req.elapsedSeconds } else { curElapsed }
            let visited = dedupe160(req.visitedBlockIds, 500)
            let steps = dedupe160(req.completedStepIds, 200)

            let pw = JsonWriter()
            for ((k, v) in current.getFields()) {
                if (k != "currentBlockId" && k != "visitedBlockIds" &&
                    k != "completedStepIds" && k != "elapsedSeconds" &&
                    k != "lastOpenedAt") {
                    pw.putRaw(k, valueToRaw(v))
                }
            }
            match (req.currentBlockId) {
                case Some(b) => pw.putStr("currentBlockId", b)
                case None => pw.putRaw("currentBlockId", "null")
            }
            pw.putRaw("visitedBlockIds", jsonStringArray(visited))
            pw.putRaw("completedStepIds", jsonStringArray(steps))
            pw.putInt("elapsedSeconds", elapsed)
            pw.putStr("lastOpenedAt", lastOpenedAt)

            let w = JsonWriter()
            for ((k, v) in base.getFields()) {
                if (k != "progress" && k != "selfAssessments") {
                    w.putRaw(k, valueToRaw(v))
                }
            }
            w.putRaw("progress", pw.toJson())
            if (!req.selfAssessments.isEmpty()) {
                let aw = JsonWriter()
                match (jsonGetObject(base, "selfAssessments")) {
                    case Some(prev) =>
                        for ((k, v) in prev.getFields()) {
                            aw.putRaw(k, valueToRaw(v))
                        }
                    case None => ()
                }
                var i: Int64 = 0
                while (i < req.selfAssessments.size) {
                    let pair = req.selfAssessments[i]
                    let cid = pair[0].trimAscii()
                    if (!cid.isEmpty()) {
                        var shortId = cid
                        if (shortId.size > 160) {
                            shortId = shortId[0..160]
                        }
                        var val = pair[1]
                        if (val < 0.0) {
                            val = 0.0
                        }
                        if (val > 1.0) {
                            val = 1.0
                        }
                        aw.putRaw(shortId, jsonFloatText(round2(val)))
                    }
                    i += 1
                }
                w.putRaw("selfAssessments", aw.toJson())
            } else {
                match (jsonGetObject(base, "selfAssessments")) {
                    case Some(prev) => w.putRaw("selfAssessments", jsonObjectToRaw(prev))
                    case None => ()
                }
            }
            return w.toJson()
    }
}

func jsonFloatText(v: Float64): String {
    let s = v.toString()
    if (s.size >= 2 && s[(s.size - 2)..s.size] == ".0") {
        return s[0..(s.size - 2)]
    }
    return s
}

func dedupe160(values: Array<String>, limit: Int64): Array<String> {
    let seen = HashSet<String>()
    let out = ArrayList<String>()
    var i: Int64 = 0
    while (i < values.size && out.size < limit) {
        var s = values[i]
        if (!s.trimAscii().isEmpty()) {
            if (s.size > 160) {
                s = s[0..160]
            }
            if (!seen.contains(s)) {
                seen.add(s)
                out.add(s)
            }
        }
        i += 1
    }
    return out.toArray()
}

/* Round half away from zero without numeric casts. */
func roundTo(v: Float64, digits: Int64): Float64 {
    var factor = 1.0
    var i: Int64 = 0
    while (i < digits) {
        factor = factor * 10.0
        i += 1
    }
    let scaled = v * factor
    let shifted = if (scaled >= 0.0) { scaled + 0.5 } else { scaled - 0.5 }
    let n = truncateFloat(shifted)
    return floatFromInt(n) / factor
}

func round2(v: Float64): Float64 {
    roundTo(v, 2)
}

func round4(v: Float64): Float64 {
    roundTo(v, 4)
}

func truncateFloat(x: Float64): Int64 {
    let s = x.toString()
    match (s.indexOf(".")) {
        case Some(d) => return Int64.tryParse(s[0..d]) ?? 0
        case None => return Int64.tryParse(s) ?? 0
    }
}

func floatFromInt(v: Int64): Float64 {
    match (Float64.tryParse(v.toString())) {
        case Some(f) => return f
        case None => return 0.0
    }
}

/* Python difficulty_weights.get(..., 1.0) — unknown and missing both mean 1.0. */
func diffWeight(diff: ?String): Float64 {
    match (diff) {
        case None => return 1.0
        case Some(d0) =>
            let d = d0.toAsciiLower()
            if (d == "medium") {
                return 1.5
            }
            if (d == "hard") {
                return 2.0
            }
            return 1.0
    }
}

/*
 * _serialize. Summary rows omit content/state and leave sources/context/decision
 * at their empty defaults (the list SELECT does not fetch those columns).
 */
func serializeCommon(row: Array<MyCell>, summary: Bool, stateText: String,
                     contentText: String, sourcesText: String,
                     contextText: String, decisionText: String,
                     createdAt: String, updatedAt: String): String {
    let stateJson = parseState(stateText)
    let contentJson = parseState(contentText)
    let stateObj: JsonObject = match (jsonParse(stateJson)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsObject => v.asObject()
                case _ => emptyObject()
            }
        case None => emptyObject()
    }
    let contentObj: JsonObject = match (jsonParse(contentJson)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsObject => v.asObject()
                case _ => emptyObject()
            }
        case None => emptyObject()
    }
    let progressObj: JsonObject = match (jsonGetObject(stateObj, "progress")) {
        case Some(p) => p
        case None => emptyObject()
    }
    let learned = (jsonGetBool(stateObj, "learned") ?? false) || (jsonGetBool(stateObj, "completed") ?? false)
    let answeredCount = match (jsonGetArray(stateObj, "answered")) {
        case Some(a) => a.size()
        case None => 0
    }
    let visitedCount = match (jsonGetArray(progressObj, "visitedBlockIds")) {
        case Some(a) => a.size()
        case None => 0
    }
    let stepsCount = match (jsonGetArray(progressObj, "completedStepIds")) {
        case Some(a) => a.size()
        case None => 0
    }
    let elapsed = jsonGetInt(progressObj, "elapsedSeconds") ?? 0
    let hasProgress = (jsonGetString(progressObj, "currentBlockId") ?? "") != "" ||
        visitedCount > 0 || stepsCount > 0 || elapsed > 0
    let started = learned || answeredCount > 0 || hasProgress

    let resourceType = cellText(row, 9)
    var progressRatio = 0.0
    if (learned) {
        progressRatio = 1.0
    } else if (resourceType == "quiz") {
        let total = match (jsonGetArray(contentObj, "questions")) {
            case Some(a) => a.size()
            case None => 0
        }
        if (total > 0) {
            progressRatio = floatFromInt(if (answeredCount < total) { answeredCount } else { total }) / floatFromInt(total)
        }
    } else if (resourceType == "practice") {
        let total = match (jsonGetArray(contentObj, "steps")) {
            case Some(a) => a.size()
            case None => 0
        }
        if (total > 0) {
            progressRatio = floatFromInt(if (stepsCount < total) { stepsCount } else { total }) / floatFromInt(total)
        }
    } else {
        var blocks: Int64 = 0
        match (jsonGetArray(contentObj, "sections")) {
            case Some(a) => blocks += a.size()
            case None => ()
        }
        match (jsonGetArray(contentObj, "chapters")) {
            case Some(chapters) =>
                var ci: Int64 = 0
                while (ci < chapters.size()) {
                    match (chapters.get(ci)) {
                        case Some(ch) =>
                            if (isJsObject(ch)) {
                                match (jsonGetArray(ch.asObject(), "sections")) {
                                    case Some(a) => blocks += a.size()
                                    case None => ()
                                }
                            }
                        case None => ()
                    }
                    ci += 1
                }
            case None => ()
        }
        if (blocks > 0) {
            progressRatio = floatFromInt(if (visitedCount < blocks) { visitedCount } else { blocks }) / floatFromInt(blocks)
        }
    }
    /* Summary rows have no content_json: estimate from state counts. */
    if (summary && contentJson == "{}" && !learned) {
        var estimate: Int64 = answeredCount
        if (stepsCount > estimate) {
            estimate = stepsCount
        }
        if (visitedCount > estimate) {
            estimate = visitedCount
        }
        var est = floatFromInt(estimate)
        if (est > 1.0) {
            est = 1.0
        }
        if (est > progressRatio) {
            progressRatio = est
        }
    }
    if (started && progressRatio <= 0.0) {
        progressRatio = 0.01
    }

    var masteryRatio = 0.0
    if (resourceType == "quiz") {
        var weightedTotal = 0.0
        var weightedCorrect = 0.0
        match (jsonGetArray(stateObj, "answered")) {
            case Some(answered) =>
                var ai: Int64 = 0
                while (ai < answered.size()) {
                    match (answered.get(ai)) {
                        case Some(item) =>
                            if (isJsObject(item)) {
                                let ans = item.asObject()
                                let qid = jsonGetString(ans, "questionId") ?? ""
                                var diff: ?String = Some("easy")
                                match (jsonGetArray(contentObj, "questions")) {
                                    case Some(qs) =>
                                        var qi: Int64 = 0
                                        while (qi < qs.size()) {
                                            match (qs.get(qi)) {
                                                case Some(q) =>
                                                    if (isJsObject(q) &&
                                                        (jsonGetString(q.asObject(), "id") ?? "") == qid) {
                                                        diff = jsonGetString(q.asObject(), "difficulty")
                                                    }
                                                case None => ()
                                            }
                                            qi += 1
                                        }
                                    case None => ()
                                }
                                let weight = diffWeight(match (diff) {
                                    case Some(d) => Some(d)
                                    case None => Some("easy")
                                })
                                weightedTotal += weight
                                if (jsonGetBool(ans, "correct") ?? false) {
                                    weightedCorrect += weight
                                }
                            }
                        case None => ()
                    }
                    ai += 1
                }
            case None => ()
        }
        if (weightedTotal > 0.0) {
            masteryRatio = weightedCorrect / weightedTotal
        }
    } else if (resourceType == "lecture" || resourceType == "practice") {
        match (jsonGetObject(stateObj, "selfAssessments")) {
            case Some(assess) =>
                var sum = 0.0
                var count: Int64 = 0
                for (kv in assess.getFields()) {
                    match (jsonGetFloat(assess, kv[0])) {
                        case Some(x) =>
                            var clamped = x
                            if (clamped < 0.0) {
                                clamped = 0.0
                            }
                            if (clamped > 1.0) {
                                clamped = 1.0
                            }
                            sum += clamped
                            count += 1
                        case None => ()
                    }
                }
                if (count > 0) {
                    masteryRatio = sum / floatFromInt(count)
                }
            case None => ()
        }
    }

    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putStr("type", resourceType)
    w.putStr("title", cellText(row, 10))
    w.putStr("topic", cellText(row, 11))
    w.putOptStr("learningGoalId", uuidText(row, 12))
    w.putOptStr("learnerId", uuidText(row, 2))
    w.putOptStr("kpId", optCellText(row, 3))
    w.putOptStr("form", optCellText(row, 4))
    w.putOptStr("level", optCellText(row, 5))
    w.putOptStr("version", optCellText(row, 6))
    w.putRaw("quizIds", parseJsonArrayText(cellText(row, 7)))
    w.putRaw("kbRefs", parseJsonArrayText(cellText(row, 8)))
    w.putOptStr("courseId", uuidText(row, 13))
    w.putOptStr("chapterId", uuidText(row, 14))
    w.putRaw("sources", parseJsonArrayText(sourcesText))
    w.putStr("createdAt", isoFromDb(createdAt))
    w.putStr("updatedAt", isoFromDb(updatedAt))
    w.putRaw("context", parseState(contextText))
    w.putRaw("decision", parseState(decisionText))
    w.putBool("learned", learned)
    w.putBool("started", started)
    w.putFloat("progressRatio", round4(progressRatio))
    w.putFloat("masteryRatio", round4(masteryRatio))
    match (jsonGetString(stateObj, "learnedAt")) {
        case Some(t) => w.putStr("learnedAt", t)
        case None => w.putRaw("learnedAt", "null")
    }
    if (!summary) {
        w.putRaw("content", contentJson)
        w.putRaw("state", stateJson)
    }
    return w.toJson()
}

func serializeSummary(row: Array<MyCell>, stateText: String): String {
    /* List SELECT carries no content/sources/context/decision columns. */
    serializeCommon(row, true, stateText, "{}", "[]", "{}", "{}",
                    cellText(row, 16), cellText(row, 17))
}

func serializeDetail(row: Array<MyCell>, stateText: String): String {
    serializeCommon(row, false, stateText,
                    cellText(row, 15), cellText(row, 16),
                    cellText(row, 18), cellText(row, 19),
                    cellText(row, 21), cellText(row, 22))
}
