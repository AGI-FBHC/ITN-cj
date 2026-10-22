package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*

/*
 * User-memory persistence for user_memories / user_memory_usage.
 * Ported from src/agents/app/storage/user_memories.py (UserMemoryStore) and
 * src/agents/app/services/user_memory.py (UserMemoryService.bootstrap_profile).
 *
 * Spire never runs DDL: Python's ensure_schema() is an idempotent CREATE TABLE
 * and is skipped here, so a missing table surfaces as an exception and the API
 * layer reports it through writeInternalDebug.
 */

/* Column order must match memRecordFromRow's positional reads. */
func memColumns(): String {
    "id,learner_id,namespace,memory_key,scope_json,value_json,summary,source_type," +
        "confidence,importance,status,version,last_used_at,created_at,updated_at"
}

public struct MemoryRecord {
    public let id: String
    public let learnerId: ?String
    public let namespace: String
    public let key: String
    public let scopeJson: String
    public let valueJson: String
    public let summary: String
    public let sourceType: String
    public let confidence: Float64
    public let importance: Float64
    public let status: String
    public let version: Int64
    public let lastUsedAt: ?String
    public let createdAt: String
    public let updatedAt: String

    public init(id: String, learnerId: ?String, namespace: String, key: String,
                scopeJson: String, valueJson: String, summary: String, sourceType: String,
                confidence: Float64, importance: Float64, status: String, version: Int64,
                lastUsedAt: ?String, createdAt: String, updatedAt: String) {
        this.id = id
        this.learnerId = learnerId
        this.namespace = namespace
        this.key = key
        this.scopeJson = scopeJson
        this.valueJson = valueJson
        this.summary = summary
        this.sourceType = sourceType
        this.confidence = confidence
        this.importance = importance
        this.status = status
        this.version = version
        this.lastUsedAt = lastUsedAt
        this.createdAt = createdAt
        this.updatedAt = updatedAt
    }
}

public class MemoryStore {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    /*
     * scope_hash — byte-identical with Python:
     *   sha256(json.dumps(scope or {}, sort_keys=True, ensure_ascii=False,
     *                     separators=(",", ":"))).hexdigest()
     * The normaliser sorts keys by code point, emits "," and ":" without
     * spaces, keeps non-ASCII raw and does not escape "/".
     */
    public static func scopeHash(scope: JsonObject): String {
        bytesToHex(sha256Bytes(memPyDumpsObject(scope, true).toArray()))
    }

    public func primaryLearnerId(userId: Array<Byte>): ?Array<Byte> {
        let sql = "SELECT id FROM learners WHERE user_id=" + sqlBinary(userId) +
            " AND status=1 ORDER BY (target_job IS NOT NULL) DESC," +
            "(diagnosis_summary IS NOT NULL) DESC,updated_at DESC LIMIT 1"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                let row = rs.rows[0]
                if (row.size > 0 && !row[0].isNull && row[0].bytes.size == 16) {
                    return Some(row[0].bytes)
                }
                return uuidParse(cellText(row, 0))
        }
    }

    public func list(userId: Array<Byte>, namespace: ?String): Array<MemoryRecord> {
        let empty = ArrayList<MemoryRecord>()
        var sql = "SELECT " + memColumns() + " FROM user_memories WHERE user_id=" + sqlBinary(userId) +
            " AND status='active' AND (expires_at IS NULL OR expires_at>NOW())"
        match (namespace) {
            case Some(ns) =>
                if (!ns.isEmpty()) {
                    sql = sql + " AND namespace=" + sqlQuote(ns)
                }
            case None => ()
        }
        sql = sql + " ORDER BY importance DESC,confidence DESC,updated_at DESC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return empty.toArray()
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<MemoryRecord>()
                for (row in rs.rows) {
                    out.add(memRecordFromRow(row))
                }
                return out.toArray()
        }
    }

    public func get(memoryId: Array<Byte>, userId: Array<Byte>): ?MemoryRecord {
        let sql = "SELECT " + memColumns() + " FROM user_memories WHERE id=" + sqlBinary(memoryId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(memRecordFromRow(rs.rows[0]))
        }
    }

    /*
     * upsert — SELECT ... FOR UPDATE first, then UPDATE (version + 1) or INSERT
     * a fresh row, and finally read the row back through get().
     */
    public func upsert(userId: Array<Byte>, learnerId: ?Array<Byte>, namespace: String,
                       memoryKey: String, scope: JsonObject, value: JsonObject,
                       summary: String, sourceType: String,
                       confidence: Float64, importance: Float64): ?MemoryRecord {
        let now = nowUtcParts()
        let scopeDigest = MemoryStore.scopeHash(scope)
        var memoryId = Array<Byte>(16, repeat: 0)
        var version: Int64 = 1
        var found = false
        let sel = "SELECT id,version FROM user_memories WHERE user_id=" + sqlBinary(userId) +
            " AND namespace=" + sqlQuote(namespace) + " AND memory_key=" + sqlQuote(memoryKey) +
            " AND scope_hash=" + sqlQuote(scopeDigest) + " AND status='active' LIMIT 1 FOR UPDATE"
        match (conn.query(sel)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                if (!rs.rows.isEmpty()) {
                    let row = rs.rows[0]
                    found = true
                    if (row.size > 0 && !row[0].isNull && row[0].bytes.size == 16) {
                        memoryId = row[0].bytes
                    }
                    version = optCellInt(row, 1) ?? 1
                }
        }
        if (found) {
            let upd = "UPDATE user_memories SET learner_id=" + sqlOptBinary(learnerId) +
                ",value_json=" + sqlQuote(memPyDumpsObject(value, false)) +
                ",summary=" + sqlQuote(pySlice(summary, 0, 500)) +
                ",source_type=" + sqlQuote(sourceType) +
                ",confidence=" + sqlQuote(jsonFloatPy(memClamp01(confidence))) +
                ",importance=" + sqlQuote(jsonFloatPy(memClamp01(importance))) +
                ",version=" + sqlInt(version + 1) +
                ",updated_at=" + sqlQuote(mysqlDatetime(now)) +
                " WHERE id=" + sqlBinary(memoryId)
            match (conn.query(upd)) {
                case QueryOutcome.Ok(_) => ()
                case QueryOutcome.ResultSet(_) => ()
            }
        } else {
            memoryId = uuidV4()
            let ins = "INSERT INTO user_memories " +
                "(id,user_id,learner_id,namespace,memory_key,scope_json,scope_hash,value_json,summary," +
                "source_type,confidence,importance,status,version,created_at,updated_at) VALUES (" +
                sqlBinary(memoryId) + "," +
                sqlBinary(userId) + "," +
                sqlOptBinary(learnerId) + "," +
                sqlQuote(namespace) + "," +
                sqlQuote(memoryKey) + "," +
                sqlQuote(memPyDumpsObject(scope, false)) + "," +
                sqlQuote(scopeDigest) + "," +
                sqlQuote(memPyDumpsObject(value, false)) + "," +
                sqlQuote(pySlice(summary, 0, 500)) + "," +
                sqlQuote(sourceType) + "," +
                sqlQuote(jsonFloatPy(memClamp01(confidence))) + "," +
                sqlQuote(jsonFloatPy(memClamp01(importance))) + "," +
                "'active',1," +
                sqlQuote(mysqlDatetime(now)) + "," +
                sqlQuote(mysqlDatetime(now)) + ")"
            match (conn.query(ins)) {
                case QueryOutcome.Ok(_) => ()
                case QueryOutcome.ResultSet(_) => ()
            }
        }
        return get(memoryId, userId)
    }

    public func hasTombstone(userId: Array<Byte>, namespace: String, memoryKey: String,
                             scope: JsonObject): Bool {
        let sql = "SELECT 1 FROM user_memories WHERE user_id=" + sqlBinary(userId) +
            " AND namespace=" + sqlQuote(namespace) + " AND memory_key=" + sqlQuote(memoryKey) +
            " AND scope_hash=" + sqlQuote(MemoryStore.scopeHash(scope)) +
            " AND status='deleted' LIMIT 1"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return false
            case QueryOutcome.ResultSet(rs) => return !rs.rows.isEmpty()
        }
    }

    /*
     * delete — tombstone: locate the active row, drop the previous deleted row
     * with the same (namespace, memory_key, scope_hash) and mark the active one
     * deleted. Returns whether the UPDATE changed a row.
     */
    public func delete(memoryId: Array<Byte>, userId: Array<Byte>): Bool {
        var namespace = ""
        var memoryKey = ""
        var scopeDigest = ""
        var found = false
        let sel = "SELECT namespace,memory_key,scope_hash FROM user_memories WHERE id=" +
            sqlBinary(memoryId) + " AND user_id=" + sqlBinary(userId) +
            " AND status='active' LIMIT 1 FOR UPDATE"
        match (conn.query(sel)) {
            case QueryOutcome.Ok(_) => return false
            case QueryOutcome.ResultSet(rs) =>
                if (!rs.rows.isEmpty()) {
                    let row = rs.rows[0]
                    namespace = cellText(row, 0)
                    memoryKey = cellText(row, 1)
                    scopeDigest = cellText(row, 2)
                    found = true
                }
        }
        if (!found) {
            return false
        }
        let del = "DELETE FROM user_memories WHERE user_id=" + sqlBinary(userId) +
            " AND namespace=" + sqlQuote(namespace) + " AND memory_key=" + sqlQuote(memoryKey) +
            " AND scope_hash=" + sqlQuote(scopeDigest) + " AND status='deleted'"
        match (conn.query(del)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        let upd = "UPDATE user_memories SET status='deleted',updated_at=" +
            sqlQuote(mysqlDatetime(nowUtcParts())) +
            " WHERE id=" + sqlBinary(memoryId) + " AND user_id=" + sqlBinary(userId) +
            " AND status='active'"
        match (conn.query(upd)) {
            case QueryOutcome.Ok(ok) => return ok.affectedRows > 0
            case QueryOutcome.ResultSet(_) => return false
        }
    }

    /* Invalid UUID strings are skipped, matching Python's UUID(value) try/except. */
    public func recordUsage(userId: Array<Byte>, memoryIds: Array<String>, scene: String,
                            taskId: ?String): Unit {
        if (memoryIds.isEmpty()) {
            return
        }
        let now = nowUtcParts()
        for (value in memoryIds) {
            match (uuidParse(value)) {
                case None => continue
                case Some(mid) =>
                    let ins = "INSERT INTO user_memory_usage " +
                        "(id,user_id,memory_id,scene,task_id,created_at) VALUES (" +
                        sqlBinary(uuidV4()) + "," + sqlBinary(userId) + "," + sqlBinary(mid) + "," +
                        sqlQuote(scene) + "," + sqlOptString(taskId) + "," +
                        sqlQuote(mysqlDatetime(now)) + ")"
                    match (conn.query(ins)) {
                        case QueryOutcome.Ok(_) => ()
                        case QueryOutcome.ResultSet(_) => ()
                    }
                    let upd = "UPDATE user_memories SET last_used_at=" +
                        sqlQuote(mysqlDatetime(now)) + " WHERE id=" + sqlBinary(mid) +
                        " AND user_id=" + sqlBinary(userId)
                    match (conn.query(upd)) {
                        case QueryOutcome.Ok(_) => ()
                        case QueryOutcome.ResultSet(_) => ()
                    }
            }
        }
    }

    /*
     * bootstrap_profile — seed profile.basic / goal.primary /
     * preference.content_format from the primary learner unless a tombstone
     * exists for that exact key. Returns the learner id (None when the user has
     * no active learner).
     */
    public func bootstrapProfile(userId: Array<Byte>): ?Array<Byte> {
        match (primaryLearnerId(userId)) {
            case None => return None
            case Some(learnerId) =>
                let sel = "SELECT role,education,target_job,weekly_hours,learning_style_json,scores_json," +
                    "goal,blind_spots_json,preferred_format,diagnosis_summary FROM learners WHERE id=" +
                    sqlBinary(learnerId) + " AND user_id=" + sqlBinary(userId)
                var cells = Array<MyCell>(0, repeat: MyCell.nullCell())
                match (conn.query(sel)) {
                    case QueryOutcome.Ok(_) => ()
                    case QueryOutcome.ResultSet(rs) =>
                        if (!rs.rows.isEmpty()) {
                            cells = rs.rows[0]
                        }
                }
                let learningStyleRaw = cellText(cells, 4)
                let profile = JsonWriter()
                profile.putRaw("role", memJsonCellOrNull(cells, 0))
                profile.putRaw("education", memJsonCellOrNull(cells, 1))
                profile.putRaw("targetJob", memJsonCellOrNull(cells, 2))
                profile.putRaw("weeklyHours", memJsonIntCellOrNull(cells, 3))
                profile.putRaw("preferredFormat", memJsonCellOrNull(cells, 8))
                profile.putRaw("learningStyle", memJsonRaw(learningStyleRaw, "[]"))
                if (!hasTombstone(userId, "profile", "profile.basic", JsonObject())) {
                    pyDrop(upsert(userId, Some(learnerId), "profile", "profile.basic", JsonObject(),
                                  memParsedObject(profile.toJson()), "用户的基础学习背景",
                                  "system_calculated", 1.0, 0.9))
                }
                var goalText = cellText(cells, 6)
                if (goalText.isEmpty()) {
                    goalText = cellText(cells, 2)
                }
                goalText = pyStrip(goalText)
                if (!goalText.isEmpty() && !hasTombstone(userId, "goal", "goal.primary", JsonObject())) {
                    let goal = JsonWriter()
                    goal.putStr("goal", goalText)
                    goal.putRaw("targetRole", memJsonCellOrNull(cells, 2))
                    goal.putInt("priority", 1)
                    pyDrop(upsert(userId, Some(learnerId), "goal", "goal.primary", JsonObject(),
                                  memParsedObject(goal.toJson()), "主要学习目标：" + goalText,
                                  "user_declared", 1.0, 1.0))
                }
                let prefs = memStringList(learningStyleRaw)
                let preferred = ArrayList<String>()
                for (p in prefs) {
                    preferred.add(p)
                }
                let preferredFormat = cellText(cells, 8)
                if (!preferredFormat.isEmpty()) {
                    preferred.add(preferredFormat)
                }
                if (preferred.size > 0 &&
                    !hasTombstone(userId, "preference", "preference.content_format", JsonObject())) {
                    let deduped = memOrderedDedupe(preferred)
                    let pref = JsonWriter()
                    pref.putStr("dimension", "content_format")
                    pref.putRaw("preferred", jsonStringArray(deduped.toArray()))
                    pref.putRaw("avoided", "[]")
                    pyDrop(upsert(userId, Some(learnerId), "preference", "preference.content_format",
                                  JsonObject(), memParsedObject(pref.toJson()),
                                  "偏好的学习内容形式：" + memJoinDun(deduped),
                                  "user_declared", 1.0, 0.8))
                }
                return Some(learnerId)
        }
    }
}

/* -------- row -> record -> JSON -------- */

func memRecordFromRow(row: Array<MyCell>): MemoryRecord {
    return MemoryRecord(
        uuidText(row, 0) ?? "",
        uuidText(row, 1),
        cellText(row, 2),
        cellText(row, 3),
        memJsonRaw(cellText(row, 4), "{}"),
        memJsonRaw(cellText(row, 5), "{}"),
        cellText(row, 6),
        cellText(row, 7),
        optCellFloat(row, 8) ?? 0.0,
        optCellFloat(row, 9) ?? 0.0,
        cellText(row, 10),
        optCellInt(row, 11) ?? 0,
        memLastUsedAt(row),
        isoNaiveFromDb(cellText(row, 13)),
        isoNaiveFromDb(cellText(row, 14))
    )
}

func memLastUsedAt(row: Array<MyCell>): ?String {
    match (optCellText(row, 12)) {
        case Some(t) => return Some(isoNaiveFromDb(t))
        case None => return None
    }
}

public func memToJson(r: MemoryRecord): String {
    let obj = JsonWriter()
    obj.putStr("id", r.id)
    obj.putOptStr("learnerId", r.learnerId)
    obj.putStr("namespace", r.namespace)
    obj.putStr("key", r.key)
    obj.putRaw("scope", r.scopeJson)
    obj.putRaw("value", r.valueJson)
    obj.putStr("summary", r.summary)
    obj.putStr("sourceType", r.sourceType)
    obj.putRaw("confidence", jsonFloatPy(r.confidence))
    obj.putRaw("importance", jsonFloatPy(r.importance))
    obj.putStr("status", r.status)
    obj.putInt("version", r.version)
    obj.putOptStr("lastUsedAt", r.lastUsedAt)
    obj.putStr("createdAt", r.createdAt)
    obj.putStr("updatedAt", r.updatedAt)
    return obj.toJson()
}

/* -------- Python JSON helpers -------- */

/*
 * A JSON column read back as text, re-dumped the way Python json.dumps would
 * (json.loads then dumps with ensure_ascii=False, separators=(",", ":")). The
 * fallback mirrors _loads(value, fallback) for NULL / empty / invalid text.
 * MySQL returns JSON columns with ": " and ", " separators and its own key
 * order — the re-dump removes those spaces while keeping the order.
 */
func memJsonRaw(text: String, fallback: String): String {
    let t = text.trimAscii()
    if (t.isEmpty()) {
        return fallback
    }
    match (jsonParse(t)) {
        case Some(v) => return memPyDumpsValue(v, false)
        case None => return fallback
    }
}

func memParsedObject(text: String): JsonObject {
    match (jsonParse(text)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsObject => return v.asObject()
                case _ => return JsonObject()
            }
        case None => return JsonObject()
    }
}

/*
 *_json(value) / json.dumps(value, sort_keys=..., ensure_ascii=False,
 * separators=(",", ":")). JsonObject.getFields() preserves insertion order, so
 * sortKeys is the only difference between the stored value and the scope hash.
 */
func memPyDumpsObject(obj: JsonObject, sortKeys: Bool): String {
    let keys = ArrayList<String>()
    for (pair in obj.getFields()) {
        keys.add(pair[0])
    }
    var ordered = keys.toArray()
    if (sortKeys) {
        ordered = memSortedKeys(ordered)
    }
    var out = "{"
    var first = true
    for (k in ordered) {
        match (obj.get(k)) {
            case Some(v) =>
                if (!first) {
                    out = out + ","
                }
                first = false
                out = out + memPyJsonStr(k) + ":" + memPyDumpsValue(v, sortKeys)
            case None => ()
        }
    }
    return out + "}"
}

func memPyDumpsValue(v: JsonValue, sortKeys: Bool): String {
    match (v.kind()) {
        case JsonKind.JsString => return memPyJsonStr(v.asString().getValue())
        case JsonKind.JsInt => return v.asInt().getValue().toString()
        case JsonKind.JsFloat => return jsonFloatPy(v.asFloat().getValue())
        case JsonKind.JsBool => return if (v.asBool().getValue()) { "true" } else { "false" }
        case JsonKind.JsNull => return "null"
        case JsonKind.JsObject => return memPyDumpsObject(v.asObject(), sortKeys)
        case JsonKind.JsArray => return memPyDumpsArray(v.asArray(), sortKeys)
    }
}

func memPyDumpsArray(arr: JsonArray, sortKeys: Bool): String {
    var out = "["
    var i: Int64 = 0
    while (i < arr.size()) {
        if (i > 0) {
            out = out + ","
        }
        match (arr.get(i)) {
            case Some(item) => out = out + memPyDumpsValue(item, sortKeys)
            case None => out = out + "null"
        }
        i += 1
    }
    return out + "]"
}

/*
 * json.dumps string escaping with ensure_ascii=False: only ", \ and the C0
 * controls are escaped (\b \f \n \r \t spelled short, the rest as \u00xx);
 * non-ASCII and "/" are copied through.
 */
func memPyJsonStr(s: String): String {
    let bytes = s.toArray()
    let out = ArrayList<Byte>()
    out.add(UInt8(34))
    var i: Int64 = 0
    while (i < bytes.size) {
        let bi = Int64(bytes[i])
        if (bi == 34) {
            out.add(UInt8(92))
            out.add(UInt8(34))
        } else if (bi == 92) {
            out.add(UInt8(92))
            out.add(UInt8(92))
        } else if (bi == 8) {
            out.add(UInt8(92))
            out.add(UInt8(98))
        } else if (bi == 12) {
            out.add(UInt8(92))
            out.add(UInt8(102))
        } else if (bi == 10) {
            out.add(UInt8(92))
            out.add(UInt8(110))
        } else if (bi == 13) {
            out.add(UInt8(92))
            out.add(UInt8(114))
        } else if (bi == 9) {
            out.add(UInt8(92))
            out.add(UInt8(116))
        } else if (bi < 32) {
            out.add(UInt8(92))
            out.add(UInt8(117))
            out.add(UInt8(48))
            out.add(UInt8(48))
            out.add(memHexDigit((bi >> 4) & 0x0f))
            out.add(memHexDigit(bi & 0x0f))
        } else {
            out.add(bytes[i])
        }
        i += 1
    }
    out.add(UInt8(34))
    return String.fromUtf8(out.toArray())
}

func memHexDigit(v: Int64): Byte {
    if (v < 10) {
        return UInt8(48 + v)
    }
    return UInt8(87 + v)
}

/* Python sorted(keys) — code-point order, same as UTF-8 byte order. */
func memSortedKeys(keys: Array<String>): Array<String> {
    let n = keys.size
    let out = Array<String>(n, repeat: "")
    var i: Int64 = 0
    while (i < n) {
        out[i] = keys[i]
        i += 1
    }
    var a: Int64 = 1
    while (a < n) {
        let cur = out[a]
        var b = a - 1
        while (b >= 0 && memStrLess(cur, out[b])) {
            out[b + 1] = out[b]
            b -= 1
        }
        out[b + 1] = cur
        a += 1
    }
    return out
}

func memStrLess(a: String, b: String): Bool {
    let ra = a.toRuneArray()
    let rb = b.toRuneArray()
    let n = if (ra.size < rb.size) { ra.size } else { rb.size }
    var i: Int64 = 0
    while (i < n) {
        let ca = runeCode(ra[i])
        let cb = runeCode(rb[i])
        if (ca != cb) {
            return ca < cb
        }
        i += 1
    }
    return ra.size < rb.size
}

/* Python max(0, min(1, x)) used on confidence / importance. */
func memClamp01(x: Float64): Float64 {
    if (x < 0.0) {
        return 0.0
    }
    if (x > 1.0) {
        return 1.0
    }
    return x
}

/* A VARCHAR learner cell as JSON: null when NULL, else a JSON string. */
func memJsonCellOrNull(row: Array<MyCell>, idx: Int64): String {
    if (idx >= row.size || row[idx].isNull) {
        return "null"
    }
    return memPyJsonStr(row[idx].text())
}

/* An INT learner cell as JSON: null when NULL, else the numeric text. */
func memJsonIntCellOrNull(row: Array<MyCell>, idx: Int64): String {
    if (idx >= row.size || row[idx].isNull) {
        return "null"
    }
    return row[idx].text()
}

/* [str(item) for item in _loads(text, []) if item] */
func memStringList(text: String): Array<String> {
    let out = ArrayList<String>()
    let t = text.trimAscii()
    if (t.isEmpty()) {
        return out.toArray()
    }
    match (jsonParse(t)) {
        case None => return out.toArray()
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsArray =>
                    let arr = v.asArray()
                    var i: Int64 = 0
                    while (i < arr.size()) {
                        match (arr.get(i)) {
                            case Some(item) =>
                                if (jsonValTruthy(item)) {
                                    out.add(memJsonValStr(item))
                                }
                            case None => ()
                        }
                        i += 1
                    }
                case _ => ()
            }
    }
    return out.toArray()
}

/* Python str(value) for the JSON scalar types. */
func memJsonValStr(v: JsonValue): String {
    match (v.kind()) {
        case JsonKind.JsString => return v.asString().getValue()
        case JsonKind.JsInt => return v.asInt().getValue().toString()
        case JsonKind.JsFloat => return jsonFloatPy(v.asFloat().getValue())
        case JsonKind.JsBool => return if (v.asBool().getValue()) { "True" } else { "False" }
        case _ => return ""
    }
}

/* list(dict.fromkeys(values)) — order-preserving de-duplication. */
func memOrderedDedupe(values: ArrayList<String>): ArrayList<String> {
    let out = ArrayList<String>()
    for (v in values) {
        if (!memContains(out.toArray(), v)) {
            out.add(v)
        }
    }
    return out
}

func memContains(values: Array<String>, target: String): Bool {
    for (v in values) {
        if (v == target) {
            return true
        }
    }
    return false
}

/* "、".join(values) */
func memJoinDun(values: ArrayList<String>): String {
    var s = ""
    var first = true
    for (v in values) {
        if (!first) {
            s = s + "、"
        }
        first = false
        s = s + v
    }
    return s
}
