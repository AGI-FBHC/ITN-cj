package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * HTTP handlers for the customize-task read side.
 *
 * Mirrors src/agents/app/routers/public.py:
 *   GET /v1/customize-tasks
 *   GET /v1/customize-tasks/{task_id}
 *   GET /v1/customize-tasks/{task_id}/slides
 *
 * POST /v1/customize-resource (create) is NOT part of this module — the task
 * only asked for the read side that the UI still hits at a 404.
 *
 * The list route filters in Python (`if kp_id:` then request.kpId == kp_id),
 * so the SQL keeps the exact JSON_EXTRACT('$.customize')=TRUE predicate and the
 * kpId comparison runs here. An empty query string is NOT a filter.
 *
 * The slides route runs CustomizeService.coalesce_legacy_unit_slides before
 * computing total/completed, so the hand-rolled scanners below have to match
 * re.sub exactly: leftmost non-overlapping, greedy with backtracking, Python $
 * matching end-of-string and the position just before a single trailing newline.
 */
public func registerCustomizeTaskRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/customize-tasks") {
        ctx => handleListCustomizeTasks(ctx, cfg)
    }
    app.mapGet("v1/customize-tasks/{task_id}") {
        ctx => handleGetCustomizeTask(ctx, cfg)
    }
    app.mapGet("v1/customize-tasks/{task_id}/slides") {
        ctx => handleGetCustomizeTaskSlides(ctx, cfg)
    }
}

/* GET /v1/customize-tasks?kpId= */
func handleListCustomizeTasks(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            /* FastAPI: kpId: str | None = Query(None) binds the field name only. */
            let kpId = queryParam(ctx.request, "kpId")
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
                        let items = store.listCustomize(userId)
                        conn.close()
                        let filtered = filterCustomizeByKp(items, kpId)
                        let arr = JsonArrWriter()
                        for (item in filtered) {
                            arr.addRaw(item)
                        }
                        let obj = JsonWriter()
                        obj.putRaw("tasks", arr.toJson())
                        writeJson(ctx.response, 200, obj.toJson())
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "listCustomizeTasks: " + e.message)
                    }
            }
    }
}

/*
 * GET /v1/customize-tasks/{task_id} — plain store.get, owner-only.
 * Does NOT check $.customize and does NOT attach event summaries.
 */
func handleGetCustomizeTask(ctx: HttpContext, cfg: AppConfig): Unit {
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
                                                    "Customization task not found")
                                    case Some(raw) =>
                                        conn.close()
                                        writeJson(ctx.response, 200, raw)
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "getCustomizeTask: " + e.message)
                            }
                    }
            }
    }
}

/* GET /v1/customize-tasks/{task_id}/slides */
func handleGetCustomizeTaskSlides(ctx: HttpContext, cfg: AppConfig): Unit {
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
                                                    "Customization task not found")
                                    case Some(taskRaw) =>
                                        var slidesRaw = "[]"
                                        match (store.getSlides(userId, taskId)) {
                                            case Some(s) => slidesRaw = s
                                            case None => ()
                                        }
                                        conn.close()
                                        writeJson(ctx.response, 200,
                                                  customizeSlidesResponse(taskRaw, slidesRaw))
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response,
                                                   "getCustomizeTaskSlides: " + e.message)
                            }
                    }
            }
    }
}

/* ------------------------------------------------------------------ *
 * kpId filter — Python: if kp_id: tasks = [t for t in tasks if
 * (t.get("request") or {}).get("kpId") == kp_id]
 * ------------------------------------------------------------------ */

func filterCustomizeByKp(tasks: Array<String>, kpId: ?String): Array<String> {
    var kp = ""
    var active = false
    match (kpId) {
        case Some(k) =>
            if (!k.isEmpty()) {
                kp = k
                active = true
            }
        case None => ()
    }
    if (!active) {
        return tasks
    }
    let out = ArrayList<String>()
    for (raw in tasks) {
        if (customizeKpIdEquals(raw, kp)) {
            out.add(raw)
        }
    }
    return out.toArray()
}

func customizeKpIdEquals(summaryRaw: String, kp: String): Bool {
    match (jsonParse(summaryRaw)) {
        case None => return false
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsObject =>
                    match (jsonGetObject(v.asObject(), "request")) {
                        case None => return false
                        case Some(req) =>
                            match (req.get("kpId")) {
                                case None => return false
                                case Some(val) =>
                                    match (val.kind()) {
                                        case JsonKind.JsString =>
                                            return val.asString().getValue() == kp
                                        case _ => return false
                                    }
                            }
                    }
                case _ => return false
            }
    }
}

/* Raw JSON of request.kpId for the slides response key (null when absent). */
func customizeSlidesKpIdRaw(taskRaw: String): String {
    match (jsonParse(taskRaw)) {
        case None => return "null"
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsObject =>
                    match (jsonGetObject(v.asObject(), "request")) {
                        case None => return "null"
                        case Some(req) =>
                            match (req.get("kpId")) {
                                case None => return "null"
                                case Some(val) => return valueToRaw(val)
                            }
                    }
                case _ => return "null"
            }
    }
}

/*
 * Slides response (public.py:5866-5894). Key order is contract:
 * slides, total, completed, status, resourceId, resourceType, title,
 * stageMessage, kpId.
 */
func customizeSlidesResponse(taskRaw: String, slidesRaw: String): String {
    let coalesced = coalesceLegacyUnitSlides(slidesRaw)
    let slidesArr = parseArr(coalesced)
    let slideCount = slidesArr.size()

    var expectedUnits: Int64 = 0
    var i: Int64 = 0
    while (i < slideCount) {
        match (slidesArr.get(i)) {
            case Some(item) =>
                if (isJsObject(item)) {
                    let u = pyIntOr(item.asObject().get("totalUnits"), 0)
                    if (u > expectedUnits) {
                        expectedUnits = u
                    }
                }
            case None => ()
        }
        i += 1
    }
    if (expectedUnits == 0) {
        expectedUnits = pyIntOr(requestField(taskRaw, "expectedTotal"), 0)
    }

    let taskObj = parseObj(taskRaw)
    let rawStatus = pyStrOr(taskObj.get("status"), "generating")
    var publicStatus = "generating"
    if (rawStatus == "completed") {
        publicStatus = "completed"
    } else if (rawStatus == "failed" || rawStatus == "cancelled") {
        publicStatus = rawStatus
    }

    /* completed = len({int(item["unitIndex"]) for ... if item.get("unitIndex") is not None}) */
    let seen = HashSet<Int64>()
    i = 0
    while (i < slideCount) {
        match (slidesArr.get(i)) {
            case Some(item) =>
                if (isJsObject(item)) {
                    let uv = item.asObject().get("unitIndex")
                    if (!pyIsNone(uv)) {
                        seen.add(pyIntOf(uv))
                    }
                }
            case None => ()
        }
        i += 1
    }
    let completedUnits = seen.size

    var total = slideCount
    if (publicStatus != "completed") {
        if (expectedUnits > slideCount) {
            total = expectedUnits
        }
    }

    let w = JsonWriter()
    w.putRaw("slides", coalesced)
    w.putInt("total", total)
    w.putInt("completed", completedUnits)
    w.putStr("status", publicStatus)
    w.putRaw("resourceId", valueToRaw(taskObj.get("resourceId") ?? jnull()))
    w.putRaw("resourceType", valueToRaw(taskObj.get("resourceType") ?? jnull()))
    w.putRaw("title", valueToRaw(taskObj.get("title") ?? jnull()))
    w.putRaw("stageMessage", valueToRaw(taskObj.get("stageMessage") ?? jnull()))
    w.putRaw("kpId", customizeSlidesKpIdRaw(taskRaw))
    return w.toJson()
}

func requestField(taskRaw: String, key: String): ?JsonValue {
    match (jsonParse(taskRaw)) {
        case None => return None
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsObject =>
                    match (jsonGetObject(v.asObject(), "request")) {
                        case None => return None
                        case Some(req) => return req.get(key)
                    }
                case _ => return None
            }
    }
}

/* ------------------------------------------------------------------ *
 * Python value coercions used by the coalesce port
 * ------------------------------------------------------------------ */

/* Python str(x or "") — falsy collapses to "", truthy is str(). */
func pyStrOrEmpty(v: ?JsonValue): String {
    match (v) {
        case None => return ""
        case Some(val) =>
            if (!jsonValTruthy(val)) {
                return ""
            }
            return pyStrOf(val)
    }
}

/* Python str(x or fallback). */
func pyStrOr(v: ?JsonValue, fallback: String): String {
    match (v) {
        case None => return fallback
        case Some(val) =>
            if (!jsonValTruthy(val)) {
                return fallback
            }
            return pyStrOf(val)
    }
}

/*
 * Python str(). Real fields are strings; bools/ints follow Python's
 * True/5 spellings. Floats keep a .0 for integral values. Arrays/objects
 * would be Python repr() — returning "" here is a documented divergence.
 */
func pyStrOf(val: JsonValue): String {
    match (val.kind()) {
        case JsonKind.JsString => return val.asString().getValue()
        case JsonKind.JsBool =>
            return if (val.asBool().getValue()) { "True" } else { "False" }
        case JsonKind.JsInt => return val.asInt().getValue().toString()
        case JsonKind.JsFloat =>
            let s = val.asFloat().getValue().toString()
            if (pyFind(s, ".") < 0 && pyFind(s, "e") < 0 && pyFind(s, "E") < 0) {
                return s + ".0"
            }
            return s
        case JsonKind.JsNull => return ""
        case JsonKind.JsArray => return ""
        case JsonKind.JsObject => return ""
    }
}

/* Python x is None — missing key and JSON null both count. */
func pyIsNone(v: ?JsonValue): Bool {
    match (v) {
        case None => return true
        case Some(val) =>
            match (val.kind()) {
                case JsonKind.JsNull => return true
                case _ => return false
            }
    }
}

/* Python int() on a present value. Non-integrals truncate toward zero. */
func pyIntOf(val: ?JsonValue): Int64 {
    match (val) {
        case None => return 0
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsInt => return v.asInt().getValue()
                case JsonKind.JsFloat => return truncateFloat(v.asFloat().getValue())
                case JsonKind.JsBool => return if (v.asBool().getValue()) { 1 } else { 0 }
                case JsonKind.JsString =>
                    return pythonIntText(v.asString().getValue()) ?? 0
                case _ => return 0
            }
    }
}

/* Python int(x or fallback) — falsy (None/False/0/""/[]/{}) selects fallback. */
func pyIntOr(v: ?JsonValue, fallback: Int64): Int64 {
    match (v) {
        case None => return fallback
        case Some(val) =>
            if (!jsonValTruthy(val)) {
                return fallback
            }
            return pyIntOf(Some(val))
    }
}

/* ------------------------------------------------------------------ *
 * re.sub scanners for coalesce_legacy_unit_slides
 * ------------------------------------------------------------------ */

/* The literal marker in the caution-block regex. */
func cautionMarker(): Array<Rune> {
    "**注意事项**".toRuneArray()
}

func asciiLowerCode(v: Int64): Int64 {
    if (v >= 0x41 && v <= 0x5a) {
        return v + 0x20
    }
    return v
}

func isAsciiDigitRune(c: Rune): Bool {
    let v = runeCode(c)
    return v >= 0x30 && v <= 0x39
}

func matchMarkerAt(rs: Array<Rune>, i: Int64): Bool {
    let m = cautionMarker()
    if (i < 0 || i + m.size > rs.size) {
        return false
    }
    var j: Int64 = 0
    while (j < m.size) {
        if (rs[i + j] != m[j]) {
            return false
        }
        j += 1
    }
    return true
}

/*
 * (?:safe|caution|danger) with re.IGNORECASE — alternation order is first
 * match wins, so the consumed length is 4 / 7 / 6 in that order.
 */
func matchWordAt(rs: Array<Rune>, i: Int64): ?Int64 {
    if (matchWordCIAt(rs, i, "safe")) {
        return Some(4)
    }
    if (matchWordCIAt(rs, i, "caution")) {
        return Some(7)
    }
    if (matchWordCIAt(rs, i, "danger")) {
        return Some(6)
    }
    return None
}

func matchWordCIAt(rs: Array<Rune>, i: Int64, word: String): Bool {
    let w = word.toRuneArray()
    if (i < 0 || i + w.size > rs.size) {
        return false
    }
    var j: Int64 = 0
    while (j < w.size) {
        if (asciiLowerCode(runeCode(rs[i + j])) != asciiLowerCode(runeCode(w[j]))) {
            return false
        }
        j += 1
    }
    return true
}

/*
 * re.sub(
 *   r"(?:\n\s*)?\*\*注意事项\*\*\s*\n+\s*(?:safe|caution|danger)\s*(?=\n|$)",
 *   "", content, flags=re.IGNORECASE).rstrip()
 *
 * Gap after the marker must be one whitespace run that contains at least one
 * \n, and the word starts at the end of that run. The trailing \s*(?=\n|$) is
 * greedy-with-backtracking: the longest whitespace prefix whose cut is
 * followed by \n or end-of-string, where Python $ also fires just before a
 * single trailing newline — that case is already covered by the \n branch of
 * the lookahead, so the lookahead is simply "at end or next is \n". For the
 * greedy suffix that means: at end-of-string take everything; otherwise stop
 * at the LAST \n inside the trailing whitespace run (the longest prefix whose
 * following char is still \n).
 */
func stripCautionBlock(content: String): String {
    let rs = content.toRuneArray()
    var segStart: Int64 = 0
    var out = ""
    var i: Int64 = 0
    while (i < rs.size) {
        match (matchCautionAt(rs, i)) {
            case Some(end) =>
                out = out + runesToString(rs, segStart, i)
                segStart = end
                i = end
            case None =>
                i += 1
        }
    }
    out = out + runesToString(rs, segStart, rs.size)
    return pyRStrip(out)
}

func matchCautionAt(rs: Array<Rune>, start: Int64): ?Int64 {
    if (start < 0 || start >= rs.size) {
        return None
    }
    /* (?:\n\s*)? — greedy prefix; only one candidate marker position. */
    var markerStart: Int64 = -1
    if (runeCode(rs[start]) == 0x0a) {
        var j = start + 1
        while (j < rs.size && isPySpace(rs[j])) {
            j += 1
        }
        if (!matchMarkerAt(rs, j)) {
            return None
        }
        markerStart = j
    } else {
        if (!matchMarkerAt(rs, start)) {
            return None
        }
        markerStart = start
    }

    /* \s*\n+\s* — the whole gap must be whitespace and contain a newline. */
    let gapStart = markerStart + cautionMarker().size
    var p = gapStart
    while (p < rs.size && isPySpace(rs[p])) {
        p += 1
    }
    let gapEnd = p
    if (gapEnd == gapStart) {
        return None
    }
    var hasNl = false
    var k = gapStart
    while (k < gapEnd) {
        if (runeCode(rs[k]) == 0x0a) {
            hasNl = true
        }
        k += 1
    }
    if (!hasNl) {
        return None
    }

    match (matchWordAt(rs, gapEnd)) {
        case None => return None
        case Some(wlen) =>
            let wordEnd = gapEnd + wlen
            var t = wordEnd
            while (t < rs.size && isPySpace(rs[t])) {
                t += 1
            }
            let tailEnd = t
            if (tailEnd == rs.size) {
                return Some(tailEnd)
            }
            var lastNl: Int64 = -1
            var u = wordEnd
            while (u < tailEnd) {
                if (runeCode(rs[u]) == 0x0a) {
                    lastNl = u
                }
                u += 1
            }
            if (lastNl < 0) {
                return None
            }
            return Some(lastNl)
    }
}

/*
 * re.sub(r"（\d+/\d+）$", "", str(slide.get("title") or "")).
 *
 * Python $ matches end-of-string and the position just before the newline at
 * the end of the string — so a suffix is stripped only when ） sits at the
 * very end, or immediately before a single trailing \n. "foo（1/2）\n\n"
 * is unchanged (no ） directly before either $ position).
 */
func stripPartSuffix(title: String): String {
    let rs = title.toRuneArray()
    let n = rs.size
    if (n >= 1 && runeCode(rs[n - 1]) == 0x0a) {
        if (n >= 2 && runeCode(rs[n - 2]) == 0xff09) {
            match (partSuffixStart(rs, n - 2)) {
                case Some(start) =>
                    return runesToString(rs, 0, start) + runesToString(rs, n - 1, n)
                case None => return title
            }
        }
        return title
    }
    if (n >= 1 && runeCode(rs[n - 1]) == 0xff09) {
        match (partSuffixStart(rs, n - 1)) {
            case Some(start) => return runesToString(rs, 0, start)
            case None => return title
        }
    }
    return title
}

/* Start of （\d+/\d+） whose closing ） is at closeIdx. */
func partSuffixStart(rs: Array<Rune>, closeIdx: Int64): ?Int64 {
    var p = closeIdx
    while (p > 0 && isAsciiDigitRune(rs[p - 1])) {
        p -= 1
    }
    if (p == closeIdx || p == 0 || runeCode(rs[p - 1]) != 0x2f) {
        return None
    }
    let slash = p - 1
    var q = slash
    while (q > 0 && isAsciiDigitRune(rs[q - 1])) {
        q -= 1
    }
    if (q == slash || q == 0 || runeCode(rs[q - 1]) != 0xff08) {
        return None
    }
    return Some(q - 1)
}

/* ------------------------------------------------------------------ *
 * coalesce_legacy_unit_slides (customize_service.py:1105-1145)
 * ------------------------------------------------------------------ */

func coalesceLegacyUnitSlides(slidesRaw: String): String {
    let slidesArr = parseArr(slidesRaw)
    let bodies = HashMap<Int64, String>()
    let positions = HashMap<String, Int64>()
    var count: Int64 = 0

    var i: Int64 = 0
    while (i < slidesArr.size()) {
        match (slidesArr.get(i)) {
            case None => ()
            case Some(raw) =>
                if (isJsObject(raw)) {
                    let obj = raw.asObject()
                    let slideType = pyStrOrEmpty(obj.get("type"))
                    var slideRaw = jsonObjectToRaw(obj)

                    /* Only prose cards get the legacy text cleanup. */
                    var mergeContent = pyStrOrEmpty(obj.get("content"))
                    if (slideType != "question") {
                        match (obj.get("content")) {
                            case Some(c) =>
                                if (isJsString(c)) {
                                    let cleaned = pyRStrip(
                                        stripCautionBlock(c.asString().getValue()))
                                    slideRaw = jsonSetKey(parseObj(slideRaw), "content",
                                                          jsonQuote(cleaned))
                                    mergeContent = cleaned
                                }
                            case None => ()
                        }
                    }

                    let partCount = pyIntOr(obj.get("partCount"), 1)
                    if (pyIsNone(obj.get("unitIndex")) || slideType == "question" ||
                        partCount <= 1) {
                        bodies.add(count, slideRaw)
                        count += 1
                    } else {
                        let key = "[" + jsonQuote(slideType) + "," +
                            pyIntOf(obj.get("unitIndex")).toString() + "]"
                        match (positions.get(key)) {
                            case None =>
                                let title = stripPartSuffix(pyStrOrEmpty(obj.get("title")))
                                var s = jsonSetKey(parseObj(slideRaw), "title", jsonQuote(title))
                                s = jsonSetKey(parseObj(s), "partIndex", "0")
                                s = jsonSetKey(parseObj(s), "partCount", "1")
                                bodies.add(count, s)
                                positions.add(key, count)
                                count += 1
                            case Some(pos) =>
                                match (bodies.get(pos)) {
                                    case None => ()
                                    case Some(exRaw) =>
                                        let ex = parseObj(exRaw)
                                        let left = pyRStrip(pyStrOrEmpty(ex.get("content")))
                                        let right = pyLStrip(mergeContent)
                                        var joined = ""
                                        if (!left.isEmpty()) {
                                            joined = left
                                            if (!right.isEmpty()) {
                                                joined = left + "\n\n" + right
                                            }
                                        } else {
                                            joined = right
                                        }
                                        bodies.add(pos, jsonSetKey(ex, "content",
                                                                  jsonQuote(joined)))
                                }
                        }
                    }
                }
        }
        i += 1
    }

    let out = JsonArrWriter()
    var n: Int64 = 0
    while (n < count) {
        match (bodies.get(n)) {
            case Some(raw) => out.addRaw(jsonSetKey(parseObj(raw), "index", n.toString()))
            case None => ()
        }
        n += 1
    }
    return out.toJson()
}

func parseObj(raw: String): JsonObject {
    match (jsonParse(raw)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsObject => return v.asObject()
                case _ => return jobj()
            }
        case None => return jobj()
    }
}

func parseArr(raw: String): JsonArray {
    match (jsonParse(raw)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsArray => return v.asArray()
                case _ => return jarr()
            }
        case None => return jarr()
    }
}
