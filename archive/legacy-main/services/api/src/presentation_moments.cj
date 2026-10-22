package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*

/*
 * PptAgent._ensure_teaching_moments (presentations/agent.py:986-1054).
 *
 * Pure normalisation of outline.slides[i].teachingMoments — no rendering, no
 * LLM. Called at /slides read time so pre-existing tasks gain the classroom
 * behaviour without rewriting the DB row.
 *
 * Literal-port notes:
 *   - Python `{**item, ...}` keeps original key order with overridden values
 *     and appends new keys; jsonOverlay does the same via getFields().
 *   - round() is half-to-even (pythonRoundFloat).
 *   - note.find / note[-16:] / len(note) are code-point based (pyFind/pySlice).
 *   - Python `item.get("options", [])` raises TypeError when options is
 *     explicit null; Spire treats non-list as empty and documents that.
 *   - isinstance(stored_anchor, int) is True for Python bool; Spire requires
 *     a real integer.
 */

func momentAnchorChar(stored: JsonValue, note: String): Int64 {
    /* Python: isinstance(stored, int) and 0 < stored <= len(note) */
    match (stored.kind()) {
        case JsonKind.JsInt =>
            let v = stored.asInt().getValue()
            if (v > 0 && v <= charCount(note)) {
                return v
            }
            return 0
        case _ => return 0
    }
}

func momentTextList(value: ?JsonValue): Array<String> {
    match (value) {
        case None => return Array<String>(0, repeat: "")
        case Some(v) =>
            if (!isJsArray(v)) {
                return Array<String>(0, repeat: "")
            }
            let arr = v.asArray()
            let out = ArrayList<String>()
            var i: Int64 = 0
            while (i < arr.size()) {
                match (arr.get(i)) {
                    case Some(item) =>
                        match (item.kind()) {
                            case JsonKind.JsString =>
                                let s = pyStrip(item.asString().getValue())
                                if (!s.isEmpty()) {
                                    out.add(s)
                                }
                            case _ => ()
                        }
                    case None => ()
                }
                i += 1
            }
            return out.toArray()
    }
}

/*
 * Build one normalised moment from a raw teachingMoments item.
 * Returns None when the item is dropped the way Python `continue`s.
 */
func normalizeMoment(item: JsonObject, index: Int64, note: String,
                     momentsSoFar: Int64): ?String {
    var mtype = ""
    match (jsonGetString(item, "type")) {
        case Some(t) => mtype = t
        case None => return None
    }
    if (mtype != "quiz" && mtype != "summary") {
        return None
    }

    var anchorText = ""
    match (item.get("anchorText")) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsString => anchorText = pyStrip(v.asString().getValue())
                case _ => ()
            }
        case None => ()
    }

    var anchorAt: Int64 = 0
    match (item.get("anchorChar")) {
        case Some(stored) => anchorAt = momentAnchorChar(stored, note)
        case None => ()
    }
    if (anchorAt == 0) {
        if (!anchorText.isEmpty()) {
            let found = pyFind(note, anchorText)
            if (found >= 0) {
                anchorAt = found + charCount(anchorText)
            }
        }
    }
    if (anchorAt == 0) {
        /* max(1, round(len(note) * (0.72 quiz / 0.96 summary))) */
        let ratio: Float64 = if (mtype == "quiz") { 0.72 } else { 0.96 }
        let scaled = pythonRoundFloat(floatFromInt(charCount(note)) * ratio, 0)
        var at = truncateFloat(scaled)
        if (at < 1) {
            at = 1
        }
        anchorAt = at
        anchorText = pySlice(note, maxInt64(0, anchorAt - 16), anchorAt)
    }

    let anchorRatio = pythonRoundFloat(
        minFloat(0.98, maxFloat(0.12, floatFromInt(anchorAt) / floatFromInt(maxInt64(1, charCount(note))))),
        4)

    var momentId = ""
    match (item.get("momentId")) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsString =>
                    if (!v.asString().getValue().isEmpty()) {
                        momentId = v.asString().getValue()
                    }
                case _ => ()
            }
        case None => ()
    }
    if (momentId.isEmpty()) {
        momentId = "s" + (index + 1).toString() + "-m" + (momentsSoFar + 1).toString()
    }

    /* Python `{**item, "momentId":..., "anchorText":..., "anchorChar":..., "anchorRatio":...}` */
    let overrides = ArrayList<(String, JsonValue)>()
    overrides.add(("momentId", JsonValue.fromStr(jsonQuote(momentId))))
    overrides.add(("anchorText", JsonValue.fromStr(jsonQuote(anchorText))))
    overrides.add(("anchorChar", JsonValue.fromStr(anchorAt.toString())))
    overrides.add(("anchorRatio", jfloatPy(anchorRatio)))

    if (mtype == "quiz") {
        let options = momentTextList(item.get("options"))
        /* Python takes only the first four that strip to non-empty. */
        let opt4 = Array<String>(minInt64(4, options.size), repeat: "")
        var oi: Int64 = 0
        while (oi < opt4.size) {
            opt4[oi] = options[oi]
            oi += 1
        }
        if (opt4.size != 4) {
            return None
        }
        var answer: Int64 = -1
        match (item.get("answerIndex")) {
            case Some(v) =>
                match (v.kind()) {
                    case JsonKind.JsInt => answer = v.asInt().getValue()
                    case _ => ()
                }
            case None => ()
        }
        if (answer < 0 || answer > 3) {
            return None
        }
        var title = ""
        match (item.get("title")) {
            case Some(v) =>
                match (v.kind()) {
                    case JsonKind.JsString => title = pyStripHeadingMarks(v.asString().getValue())
                    case _ => ()
                }
            case None => ()
        }
        var prompt = ""
        match (item.get("prompt")) {
            case Some(v) =>
                match (v.kind()) {
                    case JsonKind.JsString => prompt = pyStripHeadingMarks(v.asString().getValue())
                    case _ => ()
                }
            case None => ()
        }
        if (prompt.isEmpty() && !title.isEmpty()) {
            prompt = title
            title = "课堂检查点"
        }
        if (title.isEmpty()) {
            title = "课堂检查点"
        }
        if (prompt.isEmpty()) {
            prompt = "请根据刚才讲到的内容，选择最准确的一项。"
        }
        overrides.add(("title", JsonValue.fromStr(jsonQuote(title))))
        overrides.add(("prompt", JsonValue.fromStr(jsonQuote(prompt))))
        overrides.add(("options", JsonValue.fromStr(jsonStringArray(opt4))))
        overrides.add(("answerIndex", JsonValue.fromStr(answer.toString())))
    } else {
        let points = momentTextList(item.get("points"))
        let p4 = Array<String>(minInt64(4, points.size), repeat: "")
        var pi: Int64 = 0
        while (pi < p4.size) {
            p4[pi] = points[pi]
            pi += 1
        }
        if (p4.size < 1) {
            return None
        }
        overrides.add(("points", JsonValue.fromStr(jsonStringArray(p4))))
    }
    return Some(jsonOverlay(item, overrides.toArray()))
}

func maxInt64(a: Int64, b: Int64): Int64 {
    if (a > b) { a } else { b }
}

func minInt64(a: Int64, b: Int64): Int64 {
    if (a < b) { a } else { b }
}

func minFloat(a: Float64, b: Float64): Float64 {
    if (a < b) { a } else { b }
}

func maxFloat(a: Float64, b: Float64): Float64 {
    if (a > b) { a } else { b }
}

/*
 * Normalise every slide's teachingMoments in place.
 *
 * `slides` is the parsed outline.slides JSON array. Returns the rebuilt array
 * as raw JSON text (same order, same non-dict entries passed through).
 */
func ensureTeachingMoments(slidesRaw: String): String {
    match (jsonParse(slidesRaw)) {
        case None => return slidesRaw
        case Some(v) =>
            if (!isJsArray(v)) {
                return slidesRaw
            }
            let arr = v.asArray()
            let count = arr.size()
            let out = JsonArrWriter()
            var index: Int64 = 0
            while (index < count) {
                match (arr.get(index)) {
                    case None => out.addRaw("null")
                    case Some(item) =>
                        if (!isJsObject(item)) {
                            out.addRaw(valueToRaw(item))
                        } else {
                            out.addRaw(ensureSlideMoments(item.asObject(), arr, index, count))
                        }
                }
                index += 1
            }
            return out.toJson()
    }
}

private func jsonSlideKind(obj: JsonObject): String {
    match (jsonGetString(obj, "kind")) {
        case Some(k) => return k
        case None => return ""
    }
}

private func ensureSlideMoments(slide: JsonObject, arr: JsonArray,
                                index: Int64, count: Int64): String {
    var kind = "concept"
    match (jsonGetString(slide, "kind")) {
        case Some(k) =>
            if (!k.isEmpty()) {
                kind = k
            }
        case None => ()
    }
    var note = ""
    match (jsonGetString(slide, "speakerNotes")) {
        case Some(n) => note = pyStrip(n)
        case None => ()
    }

    if (kind == "title" || kind == "agenda" || kind == "section" || note.isEmpty()) {
        return jsonSetKey(slide, "teachingMoments", "[]")
    }

    let moments = ArrayList<String>()
    match (slide.get("teachingMoments")) {
        case Some(raw) =>
            if (isJsArray(raw)) {
                let rawArr = raw.asArray()
                var i: Int64 = 0
                while (i < rawArr.size() && i < 2) {
                    match (rawArr.get(i)) {
                        case Some(entry) =>
                            if (isJsObject(entry)) {
                                match (normalizeMoment(entry.asObject(), index, note, moments.size)) {
                                    case Some(text) => moments.add(text)
                                    case None => ()
                                }
                            }
                        case None => ()
                    }
                    i += 1
                }
            }
        case None => ()
    }

    /* chapter_end = next_kind in {section, conclusion} or index == len(slides) - 2 */
    var nextKind = ""
    if (index + 1 < count) {
        match (arr.get(index + 1)) {
            case Some(nxt) =>
                if (isJsObject(nxt)) {
                    nextKind = jsonSlideKind(nxt.asObject())
                }
            case None => ()
        }
    }
    let chapterEnd = nextKind == "section" || nextKind == "conclusion" || index == count - 2

    var hasSummary = false
    for (m in moments) {
        match (jsonParse(m)) {
            case Some(mv) =>
                if (isJsObject(mv)) {
                    match (jsonGetString(mv.asObject(), "type")) {
                        case Some(t) =>
                            if (t == "summary") {
                                hasSummary = true
                            }
                        case None => ()
                    }
                }
            case None => ()
        }
    }

    if (chapterEnd && !hasSummary) {
        let summaryPoints = ArrayList<String>()
        match (slide.get("points")) {
            case Some(pv) =>
                if (isJsArray(pv)) {
                    let parr = pv.asArray()
                    var pi: Int64 = 0
                    while (pi < parr.size() && pi < 3) {
                        match (parr.get(pi)) {
                            case Some(point) =>
                                if (isJsObject(point)) {
                                    let pobj = point.asObject()
                                    var text = ""
                                    match (jsonGetString(pobj, "heading")) {
                                        case Some(h) =>
                                            if (!h.isEmpty()) {
                                                text = h
                                            }
                                        case None => ()
                                    }
                                    if (text.isEmpty()) {
                                        match (jsonGetString(pobj, "detail")) {
                                            case Some(d) =>
                                                if (!d.isEmpty()) {
                                                    text = d
                                                }
                                            case None => ()
                                        }
                                    }
                                    text = pyStrip(text)
                                    if (!text.isEmpty()) {
                                        summaryPoints.add(text)
                                    }
                                }
                            case None => ()
                        }
                        pi += 1
                    }
                }
            case None => ()
        }
        if (!summaryPoints.isEmpty()) {
            /* Key order is the contract: momentId, type, anchorText, anchorChar,
             * anchorRatio, title, points, notePrompt. */
            let w = JsonWriter()
            w.putStr("momentId", "s" + (index + 1).toString() + "-summary")
            w.putStr("type", "summary")
            w.putStr("anchorText", pySlice(note, maxInt64(0, charCount(note) - 16), charCount(note)))
            w.putInt("anchorChar", charCount(note))
            w.putRaw("anchorRatio", "0.98")
            w.putStr("title", "这一节，先收住三个关键点")
            w.putRaw("points", jsonStringArray(summaryPoints.toArray()))
            w.putStr("notePrompt", "要不要把这一节的关键结论记进笔记？")
            moments.add(w.toJson())
        }
    }

    let list = JsonArrWriter()
    for (m in moments) {
        list.addRaw(m)
    }
    return jsonSetKey(slide, "teachingMoments", list.toJson())
}

/*
 * Single-key overlay: set `key` to the raw JSON `rawValue`, keeping the other
 * keys in their original positions (replace in place when present).
 */
func jsonSetKey(obj: JsonObject, key: String, rawValue: String): String {
    let w = JsonWriter()
    for ((k, v) in obj.getFields()) {
        if (k == key) {
            w.putRaw(k, rawValue)
        } else {
            w.putRaw(k, valueToRaw(v))
        }
    }
    if (!obj.containsKey(key)) {
        w.putRaw(key, rawValue)
    }
    return w.toJson()
}
