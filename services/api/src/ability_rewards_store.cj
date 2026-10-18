package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*

/*
 * Port of src/agents/app/storage/ability_rewards.py (AbilityRewardStore).
 *
 * POST /v1/learning-resources/{id}/ability-reward calls apply() after the
 * route has loaded the resource. Tables touched:
 *   - learning_resource_ability_rewards (created here if missing, mirroring
 *     Python ensure_schema; the dev DB may never have run the Python path)
 *   - learners.scores_json (Spring Boot's six-dimension profile; TEXT column,
 *     status=1 rows only)
 *
 * Fidelity notes (all deliberate):
 *   - pythonRoundInt (banker's rounding) for _clamp and quiz point scaling;
 *     round(x, 2) is pythonRoundInt(v*100)/100.0 (matches CPython for this
 *     value domain; double-rounding edge cases do not occur with the fixed
 *     point table and small-integer correct rates)
 *   - `float(scores.get(dim) or 50)`: falsy (null/missing/false/0/0.0/"")
 *     falls back to 50; corrupt values raise, producing a 500 like Python
 *   - UPDATE learners rowcount==0 -> {"rewarded": false, "reason":
 *     "update-failed"} (learner vanished between read and update)
 *   - timestamps are naive UTC (datetime.utcnow()), unlike the +08:00
 *     learnedAt values written by the presentations complete path
 */

/* Stable-ordered chapter -> dimension weights (ability_rewards.py:13-30). */
private func chapterAbilityWeights(): Array<(String, Array<(String, Float64)>)> {
    [
        ("ch1-intro", [("kp-agent", 0.6), ("kp-ds", 0.4)]),
        ("ch2-history", [("kp-ds", 0.6), ("kp-agent", 0.4)]),
        ("ch3-llm", [("kp-ds", 0.7), ("kp-co", 0.3)]),
        ("ch4-paradigms", [("kp-co", 0.6), ("kp-os", 0.4)]),
        ("ch5-lowcode", [("kp-os", 0.7), ("kp-db", 0.3)]),
        ("ch6-frameworks", [("kp-os", 0.6), ("kp-db", 0.4)]),
        ("ch7-helloagents", [("kp-os", 0.8), ("kp-co", 0.2)]),
        ("ch8-memory-rag", [("kp-ds", 0.5), ("kp-network", 0.5)]),
        ("ch9-context", [("kp-network", 0.6), ("kp-ds", 0.4)]),
        ("ch10-protocols", [("kp-network", 0.6), ("kp-db", 0.4)]),
        ("ch11-agentic-rl", [("kp-co", 0.5), ("kp-db", 0.5)]),
        ("ch12-evaluation", [("kp-db", 0.5), ("kp-co", 0.5)]),
        ("ch13-travel", [("kp-os", 0.5), ("kp-db", 0.5)]),
        ("ch14-research", [("kp-network", 0.5), ("kp-ds", 0.5)]),
        ("ch15-cyber", [("kp-os", 0.5), ("kp-db", 0.5)]),
        ("ch16-graduation", [("kp-db", 0.6), ("kp-os", 0.4)]),
    ]
}

/* First-match keyword groups, in Python's iteration order (lines 32-39). */
private func keywordDimensions(): Array<(Array<String>, String)> {
    [
        (["推理", "逻辑", "判断", "分析"], "kp-co"),
        (["代码", "工程", "实现", "实践", "实操", "开发"], "kp-os"),
        (["网络", "协议", "排查", "诊断", "问题"], "kp-network"),
        (["设计", "架构", "方案", "建模"], "kp-db"),
        (["迁移", "应用", "结合", "举一反三"], "kp-agent"),
        (["理解", "概念", "知识", "记忆"], "kp-ds"),
    ]
}

private func resourceRewardsPoints(resourceType: String): ?(Float64, Float64) {
    if (resourceType == "lecture") {
        return Some((1.0, 0.5))
    }
    if (resourceType == "practice") {
        return Some((2.0, 1.0))
    }
    if (resourceType == "ppt") {
        return Some((1.5, 0.75))
    }
    if (resourceType == "quiz") {
        return Some((2.0, 1.0))
    }
    return None
}

/*
 * Python: sorted(weights.items(), key=..., reverse=True) is a stable sort, so
 * equal weights keep the literal (dict insertion) order. Insertion sort with
 * "insert before the first strictly smaller weight" preserves that.
 */
private func rankedChapterDims(weights: Array<(String, Float64)>): Array<(String, Float64)> {
    let n = weights.size
    var out = Array<(String, Float64)>(n, repeat: ("", 0.0))
    var i: Int64 = 0
    while (i < n) {
        out[i] = weights[i]
        i += 1
    }
    /* Stable bubble sort descending by weight (strict < keeps equals in order). */
    var pass: Int64 = 0
    while (pass < n) {
        var j: Int64 = 0
        while (j + 1 < n) {
            if (out[j][1] < out[j + 1][1]) {
                let tmp = out[j]
                out[j] = out[j + 1]
                out[j + 1] = tmp
            }
            j += 1
        }
        pass += 1
    }
    return out
}

/* ability_rewards.py:53-67 resolve_dimensions. */
func resolveAbilityDimensions(kpId: ?String, hint: String): (String, String) {
    let kp = kpId ?? ""
    var weights: ?Array<(String, Float64)> = None
    for (entry in chapterAbilityWeights()) {
        if (entry[0] == kp) {
            weights = Some(entry[1])
        }
    }
    match (weights) {
        case Some(w) =>
            let ranked = rankedChapterDims(w)
            let primary = ranked[0][0]
            var secondary: ?String = None
            var i: Int64 = 1
            while (i < ranked.size) {
                if (ranked[i][0] != primary) {
                    secondary = Some(ranked[i][0])
                    break
                }
                i += 1
            }
            let sec = secondary ?? (if (primary != "kp-co") { "kp-co" } else { "kp-ds" })
            return (primary, sec)
        case None => ()
    }
    let searchable = kp + " " + hint
    var primary = "kp-ds"
    for (group in keywordDimensions()) {
        var hit = false
        for (kw in group[0]) {
            if (searchable.contains(kw)) {
                hit = true
            }
        }
        if (hit) {
            primary = group[1]
            break
        }
    }
    let secondary = if (primary != "kp-co") { "kp-co" } else { "kp-ds" }
    return (primary, secondary)
}

/* Python round(x, 2) for non-negative x (quiz point scaling). */
func pythonRound2(v: Float64): Float64 {
    Float64(pythonRoundInt(v * 100.0)) / 100.0
}

/* Python _clamp: max(12, min(96, round(value))) with banker's rounding. */
private func clampAbilityScore(v: Float64): Int64 {
    let r = pythonRoundInt(v)
    if (r < 12) {
        return 12
    }
    if (r > 96) {
        return 96
    }
    return r
}

/*
 * Python truthiness of a scores_json value inside `float(value or 50)`:
 * falsy -> caller supplies the 50 fallback; truthy numeric/bool/string is
 * converted; corrupt values raise -> route 500s like FastAPI.
 */
private func pyTruthFloatOr50(v: JsonValue): ?Float64 {
    match (v.kind()) {
        case JsonKind.JsInt =>
            let n = v.asInt().getValue()
            return if (n == 0) { None } else { Some(floatFromInt(n)) }
        case JsonKind.JsFloat =>
            let f = v.asFloat().getValue()
            return if (f == 0.0) { None } else { Some(f) }
        case JsonKind.JsBool =>
            return if (v.asBool().getValue()) { Some(1.0) } else { None }
        case JsonKind.JsString =>
            let s = v.asString().getValue()
            if (s.isEmpty()) {
                return None
            }
            match (Float64.tryParse(s)) {
                case Some(f) => return Some(f)
                case None =>
                    throw Exception("float() argument must be a string or a real number")
            }
        case JsonKind.JsNull => return None
        case JsonKind.JsObject =>
            /* Python float({} or 50) -> 50 (falsy); float({...}) raises. */
            return if (jsonTruthyContainer(v)) {
                throw Exception("float() argument must be a string or a real number")
            } else { None }
        case JsonKind.JsArray =>
            return if (jsonTruthyContainer(v)) {
                throw Exception("float() argument must be a string or a real number")
            } else { None }
        case _ => return None
    }
}

/* Python truthiness of containers: {} and [] are falsy. */
private func jsonTruthyContainer(v: JsonValue): Bool {
    match (v.kind()) {
        case JsonKind.JsObject =>
            var has = false
            for ((_k, _vv) in v.asObject().getFields()) {
                has = true
            }
            return has
        case JsonKind.JsArray => return v.asArray().size() > 0
        case _ => return true
    }
}

/* Python truthiness for the `item.get("correct")` check in correct_rate. */
func pyTruthy(v: JsonValue): Bool {
    match (v.kind()) {
        case JsonKind.JsBool => return v.asBool().getValue()
        case JsonKind.JsInt => return v.asInt().getValue() != 0
        case JsonKind.JsFloat => return v.asFloat().getValue() != 0.0
        case JsonKind.JsString => return !v.asString().getValue().isEmpty()
        case JsonKind.JsNull => return false
        case JsonKind.JsObject => return jsonTruthyContainer(v)
        case JsonKind.JsArray => return jsonTruthyContainer(v)
        case _ => return true
    }
}

public class AbilityRewardStore {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    /* ability_rewards.py:77-97 ensure_schema — verbatim DDL. */
    public func ensureSchema(): Unit {
        let ddl = "CREATE TABLE IF NOT EXISTS learning_resource_ability_rewards (" +
            "id BINARY(16) PRIMARY KEY," +
            "user_id BINARY(16) NOT NULL," +
            "learner_id BINARY(16) NOT NULL," +
            "resource_id BINARY(16) NOT NULL," +
            "resource_type VARCHAR(16) NOT NULL," +
            "main_dimension VARCHAR(32) NOT NULL," +
            "secondary_dimension VARCHAR(32) NOT NULL," +
            "reward_points DECIMAL(4,2) NOT NULL," +
            "created_at DATETIME(6) NOT NULL," +
            "UNIQUE KEY uk_ability_reward_resource (user_id, resource_id)" +
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        match (conn.query(ddl)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
    }

    /*
     * ability_rewards.py:99-176 apply. Returns the HTTP 200 body.
     * Route-side reasons (no-learner / invalid-learner) are handled upstream.
     */
    public func apply(userId: Array<Byte>, learnerId: Array<Byte>, resourceId: Array<Byte>,
                      resourceTypeRaw: String, kpId: ?String, hint: String,
                      correctRate: Float64): String {
        ensureSchema()
        let resourceType = resourceTypeRaw.toAsciiLower()
        let points = match (resourceRewardsPoints(resourceType)) {
            case Some(p) => p
            case None => return rewardFalse("unsupported-type")
        }

        /* Once per (user_id, resource_id). */
        match (conn.query("SELECT id FROM learning_resource_ability_rewards WHERE user_id=" +
                          sqlBinary(userId) + " AND resource_id=" + sqlBinary(resourceId) +
                          " LIMIT 1")) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                if (!rs.rows.isEmpty()) {
                    return rewardFalse("already-rewarded")
                }
        }

        var scoresText: ?String = None
        match (conn.query("SELECT scores_json FROM learners WHERE id=" + sqlBinary(learnerId) +
                          " AND user_id=" + sqlBinary(userId) + " AND status=1 LIMIT 1")) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                if (!rs.rows.isEmpty()) {
                    scoresText = Some(cellText(rs.rows[0], 0))
                }
        }
        let rawScores = match (scoresText) {
            case Some(t) => t
            case None => return rewardFalse("learner-not-found")
        }

        let (primary, secondary) = resolveAbilityDimensions(kpId, hint)
        var primaryPoints = points[0]
        var secondaryPoints = points[1]
        if (resourceType == "quiz") {
            var rate = correctRate
            if (rate < 0.0) {
                rate = 0.0
            }
            if (rate > 1.0) {
                rate = 1.0
            }
            primaryPoints = pythonRound2(primaryPoints * rate)
            secondaryPoints = pythonRound2(secondaryPoints * rate)
        }

        /* scores: parsed JSON kept in key order with raw values; updates and
         * newly appended dimensions follow Python dict semantics. */
        let order = ArrayList<String>()
        let rawByKey = HashMap<String, String>()
        let valueByKey = HashMap<String, JsonValue>()
        match (jsonParse(rawScores)) {
            case Some(v) =>
                if (isJsObject(v)) {
                    for ((k, vv) in v.asObject().getFields()) {
                        order.add(k)
                        rawByKey.add(k, valueToRaw(vv))
                        valueByKey.add(k, vv)
                    }
                }
            case None => ()
        }

        let deltaOrder = ArrayList<String>()
        let deltaFrom = HashMap<String, Float64>()
        let deltaTo = HashMap<String, Int64>()
        let dims = [(primary, primaryPoints), (secondary, secondaryPoints)]
        for (entry in dims) {
            let dim = entry[0]
            let pts = entry[1]
            if (pts <= 0.0) {
                continue
            }
            var before = 50.0
            match (valueByKey.get(dim)) {
                case Some(v) =>
                    match (pyTruthFloatOr50(v)) {
                        case Some(f) => before = f
                        case None => before = 50.0
                    }
                case None => before = 50.0
            }
            let after = clampAbilityScore(before + pts)
            deltaOrder.add(dim)
            deltaFrom.add(dim, before)
            deltaTo.add(dim, after)
            var found = false
            for (k in order) {
                if (k == dim) {
                    found = true
                }
            }
            if (!found) {
                order.add(dim)
            }
            rawByKey.add(dim, after.toString())
        }

        /* Rebuild scores JSON in insertion order. */
        let scoresW = JsonWriter()
        for (k in order) {
            match (rawByKey.get(k)) {
                case Some(raw) => scoresW.putRaw(k, raw)
                case None => ()
            }
        }
        let scoresJson = scoresW.toJson()

        let now = mysqlDatetime(nowUtcParts())
        match (conn.query("UPDATE learners SET scores_json=" + sqlQuote(scoresJson) +
                          ",updated_at=" + sqlQuote(now) +
                          " WHERE id=" + sqlBinary(learnerId) +
                          " AND user_id=" + sqlBinary(userId) + " AND status=1")) {
            case QueryOutcome.ResultSet(_) => return rewardFalse("update-failed")
            case QueryOutcome.Ok(ok) =>
                if (ok.affectedRows <= 0) {
                    return rewardFalse("update-failed")
                }
        }
        let rewardPoints = pythonRound2(primaryPoints + secondaryPoints)
        match (conn.query("INSERT INTO learning_resource_ability_rewards " +
                          "(id,user_id,learner_id,resource_id,resource_type,main_dimension," +
                          "secondary_dimension,reward_points,created_at) VALUES (" +
                          sqlBinary(uuidV4()) + "," + sqlBinary(userId) + "," +
                          sqlBinary(learnerId) + "," + sqlBinary(resourceId) + "," +
                          sqlQuote(resourceType) + "," + sqlQuote(primary) + "," +
                          sqlQuote(secondary) + "," + sqlQuote(rewardPoints.toString()) +
                          "," + sqlQuote(now) + ")")) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }

        let deltasW = JsonWriter()
        for (dim in deltaOrder) {
            let one = JsonWriter()
            match (deltaFrom.get(dim)) {
                case Some(f) => one.putFloat("from", f)
                case None => one.putFloat("from", 50.0)
            }
            match (deltaTo.get(dim)) {
                case Some(t) => one.putInt("to", t)
                case None => one.putInt("to", 0)
            }
            deltasW.putRaw(dim, one.toJson())
        }
        let obj = JsonWriter()
        obj.putBool("rewarded", true)
        obj.putStr("primaryDimension", primary)
        obj.putStr("secondaryDimension", secondary)
        obj.putRaw("deltas", deltasW.toJson())
        obj.putRaw("scores", scoresJson)
        return obj.toJson()
    }

    private func rewardFalse(reason: String): String {
        let obj = JsonWriter()
        obj.putBool("rewarded", false)
        obj.putStr("reason", reason)
        return obj.toJson()
    }
}
