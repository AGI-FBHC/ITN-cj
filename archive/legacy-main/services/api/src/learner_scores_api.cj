package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * P2 scores_json single-writer step 1 (§17.4): PUT /v1/learners/scores.
 *
 * Ported from src/agents/app/routers/public.py:4805-4838 (the UPDATE is at
 * :4829). This is the /v1 bare-JSON surface, NOT the /api/v1 ApiResponse
 * envelope — the response is {"ok": true} and errors are FastAPI
 * HTTPException {"detail": "..."}.
 *
 * Why LOCAL: learners.scores_json previously had six writers. W4 (this route)
 * did a whole-column replace while W5/W6 (ability-reward) do a read-modify-write
 * merge, with no lock between them and inconsistent clamps (W4 clamps 0-100,
 * W5/W6 clamp 12-96). Moving this route into Spire is the first step toward a
 * single writer with a uniform clamp policy.
 *
 * Clamp policy adopted here (step 1 of the §17.4 funnel): 0-100, matching the
 * Python W4 semantics exactly so the wire behaviour does not change. The
 * unified clamp across W5/W6 lands in step 2.
 *
 * NOTE: the Python route still exists in ITN-Beta and is NOT touched from here
 * (that tree is outside this repo's git management). Taking the Python route
 * offline is a separate deployment-side step.
 */

public func registerLearnerScoresRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapPut("v1/learners/scores") {
        ctx => handleUpsertLearnerScores(ctx, cfg)
    }
}

/*
 * PUT /v1/learners/scores — update the six-dimension scores for the current
 * user's primary learner.
 *
 * Python contract (update_learner_scores):
 *   - request body {"scores": {"kp-ds": 80, ...}} (ScoreUpdateRequest)
 *   - each value: int(v) then clamp 0-100; unparseable values are SKIPPED
 *     (try/except continue), not rejected
 *   - no primary learner, or nothing left after filtering → 404
 *     {"detail": "Learner not found or no valid scores"}
 *   - success → {"ok": true}
 */
func handleUpsertLearnerScores(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (readJsonObjectBody(ctx)) {
                case None => return
                case Some(root) =>
                    match (parseScoresUpsert(ctx, root)) {
                        case None => return
                        case Some(clean) =>
                            /* Python: if not clean: return False → 404. An
                             * empty map after filtering is NOT a silent no-op. */
                            if (clean.size == 0) {
                                writeDetail(ctx.response, 404,
                                    "Learner not found or no valid scores")
                                return
                            }
                            match (openDb(cfg)) {
                                case None =>
                                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                case Some(conn) =>
                                    try {
                                        let store = MemoryStore(conn)
                                        match (store.primaryLearnerId(userId)) {
                                            case None =>
                                                conn.close()
                                                writeDetail(ctx.response, 404,
                                                    "Learner not found or no valid scores")
                                            case Some(learnerId) =>
                                                /* §17.4 step 2: merge the supplied
                                                 * dimensions atomically (JSON_SET)
                                                 * instead of replacing the whole
                                                 * column, so a concurrent
                                                 * ability-reward write cannot lose
                                                 * keys. */
                                                var setExpr = "COALESCE(NULLIF(scores_json,''),'{}')"
                                                for (k in clean.keys()) {
                                                    match (clean.get(k)) {
                                                        case Some(n) =>
                                                            setExpr = "JSON_SET(" + setExpr +
                                                                ", '$.\"" + k + "\"', " +
                                                                n.toString() + ")"
                                                        case None => ()
                                                    }
                                                }
                                                let now = mysqlDatetime(nowUtcParts())
                                                let sql = "UPDATE learners SET scores_json=" +
                                                    setExpr + ", updated_at=" + sqlQuote(now) +
                                                    " WHERE id=" + sqlBinary(learnerId) +
                                                    " AND user_id=" + sqlBinary(userId)
                                                match (conn.query(sql)) {
                                                    case QueryOutcome.Ok(_) =>
                                                        conn.close()
                                                        writeJson(ctx.response, 200, "{\"ok\":true}")
                                                    case QueryOutcome.ResultSet(_) =>
                                                        conn.close()
                                                        writeDetail(ctx.response, 404,
                                                            "Learner not found or no valid scores")
                                                }
                                        }
                                    } catch (e: Exception) {
                                        conn.close()
                                        writeInternalDebug(ctx.response,
                                            "updateLearnerScores: " + e.message)
                                    }
                            }
                    }
            }
    }
}

/*
 * Parse {"scores": {...}} the way ScoreUpdateRequest + the clean loop do.
 *
 * scores: dict[str, int] is the pydantic field. The handler then re-derives
 * clean = {str(k): max(0, min(100, int(v)))} and skips any pair where int(v)
 * raises. An empty clean map falls through to the 404 in the caller — the
 * validation layer therefore cannot reject empty, it must hand back an empty
 * map and let the 404 path decide.
 *
 * A missing / non-object "scores" is a pydantic error (422 VALIDATION_FAILED).
 */
func parseScoresUpsert(ctx: HttpContext, root: JsonObject): ?HashMap<String, Int64> {
    let bag = PyBag()
    var scoresObj: ?JsonObject = None
    match (pyField(root, "scores", "scores")) {
        case None => bag.add(pyMissing(["body", "scores"], "{}"))
        case Some(f) =>
            match (f.value.kind()) {
                case JsonKind.JsObject => scoresObj = Some(f.value.asObject())
                case _ => bag.add(pyDictType(["body", "scores"], f.raw))
            }
    }
    let clean = HashMap<String, Int64>()
    match (scoresObj) {
        case None => ()
        case Some(so) =>
            for ((k, v) in so.getFields()) {
                match (coerceScoreValue(v)) {
                    case Some(n) =>
                        /* §17.4 step 2: reject non-knowledge-point keys and
                         * out-of-range values instead of clamping silently. */
                        if (!isScoreKey(k)) {
                            bag.add(pyDictValueType("scores", k, "value_error",
                                "Value error, 非知识点键", valueToRaw(v)))
                        } else if (n < 0 || n > 100) {
                            bag.add(pyDictValueType("scores", k, "value_error",
                                "Value error, 分数值必须在 0-100 之间", valueToRaw(v)))
                        } else {
                            clean.add(k, n)
                        }
                    case None => ()
                }
            }
    }
    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(clean)
}

/*
 * int(v) semantics from the Python clean loop. Pydantic's `dict[str, int]`
 * already coerces in lax mode, so what reaches the handler is usually an int;
 * the try/except in Python still accepts the shapes int() would take:
 *   - JSON int   → as-is
 *   - JSON float → truncated toward zero (int(3.9) == 3)
 *   - JSON bool  → 1/0 (int(True) == 1)
 *   - digit string → parsed (int("60") == 60); "-"-signed too
 * Everything else is skipped, matching `except (TypeError, ValueError): continue`.
 */
func coerceScoreValue(v: JsonValue): ?Int64 {
    match (v.kind()) {
        case JsonKind.JsInt => return Some(v.asInt().getValue())
        case JsonKind.JsFloat =>
            let f = v.asFloat().getValue()
            return Some(Int64(f))
        case JsonKind.JsBool =>
            return Some(if (v.asBool().getValue()) { 1 } else { 0 })
        case JsonKind.JsString =>
            let s = v.asString().getValue().trimAscii()
            return Int64.tryParse(s)
        case _ => return None
    }
}

/*
 * python json.dumps(clean, ensure_ascii=False) — the map is re-dumped with
 * compact separators and no ASCII escaping. Key order follows the cleaned
 * iteration order.
 */
func scoresCleanToJson(clean: HashMap<String, Int64>): String {
    let w = JsonWriter()
    for (k in clean.keys()) {
        match (clean.get(k)) {
            case Some(n) => w.putRaw(k, n.toString())
            case None => ()
        }
    }
    return w.toJson()
}

/*
 * A dimension key must be a knowledge-point code: "kp-" followed by ASCII
 * alphanumerics, '_' or '-'. Besides enforcing §17.4 step 2, this keeps the key
 * safe to embed verbatim in a JSON path literal.
 */
func isScoreKey(k: String): Bool {
    let bs = k.toArray()
    if (bs.size <= 3) {
        return false
    }
    if (!(bs[0] == 0x6B && bs[1] == 0x70 && bs[2] == 0x2D)) {
        return false
    }
    var i: Int64 = 3
    while (i < bs.size) {
        let b = bs[i]
        let ok = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) ||
            (b >= 0x61 && b <= 0x7A) || b == 0x5F || b == 0x2D
        if (!ok) {
            return false
        }
        i += 1
    }
    return true
}
