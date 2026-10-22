package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import std.env.*
import stdx.encoding.json.*

/*
 * Pure-rule tutoring state machine. Zero LLM.
 * Ported from src/agents/app/services/tutoring.py:TutoringService
 *   scripts / get_script / create_session / get_session / answer / complete
 *   _match_free_text / _script_from_quiz / _enter_node / _accuracy / _score_before
 *
 * Error surface matches Python's handlers exactly:
 *   KeyError   -> HTTP 404 {"detail":"'the message'"}  (str(KeyError) adds quotes)
 *   ValueError -> HTTP 422 {"detail":"the message"}
 * Raised as TutoringOutcome so the API layer can pick the status/body.
 */

public enum TutoringOutcome {
    Done(String) | NotFound(String) | Invalid(String)
}

/* Session JSON fields assembled by the state machine before the store write. */
struct TutoringDraft {
    let messagesJson: String
    let answersJson: String
    let decisionsJson: String
    let level: Int64
    let currentNodeId: ?String
    let status: String
    let scoreAfter: ?Int64

    init(messagesJson: String, answersJson: String, decisionsJson: String,
         level: Int64, currentNodeId: ?String, status: String, scoreAfter: ?Int64) {
        this.messagesJson = messagesJson
        this.answersJson = answersJson
        this.decisionsJson = decisionsJson
        this.level = level
        this.currentNodeId = currentNodeId
        this.status = status
        this.scoreAfter = scoreAfter
    }
}

public class TutoringService {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    /* -------- scripts -------- */

    /* Static scripts file; empty list when the file is missing/unreadable. */
    public func scripts(): JsonArray {
        match (loadTutoringScriptsText()) {
            case None => return jarr()
            case Some(text) =>
                match (jsonParse(text)) {
                    case Some(v) =>
                        if (isJsArray(v)) {
                            return v.asArray()
                        }
                    case None => ()
                }
                return jarr()
        }
    }

    /*
     * Python get_script: `resource:{uuid}` only resolves when user_id is
     * provided (the scripts route calls get_script without one and therefore
     * never builds a dynamic script). Static lookup matches learnerId against
     * the lowercased/stripped code.
     */
    public func getScript(learnerCode: String, userId: ?Array<Byte>): ?JsonObject {
        let code = pyStrip(learnerCode).toAsciiLower()
        if (code.startsWith("resource:")) {
            match (userId) {
                case None => ()
                case Some(uid) =>
                    let idText = code[9..code.size]
                    match (uuidParse(idText)) {
                        case None => return None
                        case Some(rid) =>
                            match (ResourcesStore(conn).get(uid, rid)) {
                                case None => return None
                                case Some(raw) => return scriptFromQuiz(raw)
                            }
                    }
            }
        }
        let arr = scripts()
        var i: Int64 = 0
        while (i < arr.size()) {
            match (arr.get(i)) {
                case Some(item) =>
                    if (isJsObject(item)) {
                        let obj = item.asObject()
                        match (jsonGetString(obj, "learnerId")) {
                            case Some(lid) =>
                                if (lid == code) {
                                    return Some(obj)
                                }
                            case None => ()
                        }
                    }
                case None => ()
            }
            i += 1
        }
        return None
    }

    /* -------- session lifecycle -------- */

    public func createSession(userId: Array<Byte>, learnerCode: ?String,
                              resourceId: ?Array<Byte>): TutoringOutcome {
        var code: ?String = None
        match (resourceId) {
            case Some(rid) => code = Some("resource:" + uuidFormat(rid))
            case None => code = learnerCode
        }
        var finalCode = ""
        match (code) {
            case Some(c) => finalCode = c
            case None => return TutoringOutcome.Invalid("learnerCode or resourceId is required")
        }
        if (finalCode.size == 0) {
            return TutoringOutcome.Invalid("learnerCode or resourceId is required")
        }
        match (getScript(finalCode, Some(userId))) {
            case None => return TutoringOutcome.NotFound("tutoring script not found")
            case Some(script) =>
                /* Python script["startId"] — a missing key is KeyError('startId'). */
                match (jsonGetString(script, "startId")) {
                    case None => return TutoringOutcome.NotFound("startId")
                    case Some(_) => ()
                }
                let startId = jsonGetString(script, "startId") ?? ""
                let entered = enterNode("[]", "[]", 2, script, Some(startId))
                let before = scoreBeforeFor(finalCode, jsonGetString(script, "kpId"))
                let kp = jsonGetString(script, "kpId") ?? ""
                let title = jsonGetString(script, "title") ?? ""
                match (TutoringStore(conn).create(userId, finalCode, kp, title,
                                                  entered.currentNodeId,
                                                  entered.messagesJson,
                                                  before)) {
                    case None => return TutoringOutcome.NotFound("session not found")
                    case Some(sessionRaw) =>
                        match (enrichSession(userId, sessionRaw, Some(script))) {
                            case None => return TutoringOutcome.NotFound("session not found")
                            case Some(full) => return TutoringOutcome.Done(full)
                        }
                }
        }
    }

    public func getSession(userId: Array<Byte>, sessionId: Array<Byte>): ?String {
        match (TutoringStore(conn).get(userId, sessionId)) {
            case None => return None
            case Some(sessionRaw) => return enrichSession(userId, sessionRaw, None)
        }
    }

    public func answer(userId: Array<Byte>, sessionId: Array<Byte>,
                       optionIndex: ?Int64, optionLabel: ?String,
                       freeText: ?String): TutoringOutcome {
        match (TutoringStore(conn).get(userId, sessionId)) {
            case None => return TutoringOutcome.NotFound("session not found")
            case Some(sessionRaw) =>
                match (jsonParse(sessionRaw)) {
                    case None => return TutoringOutcome.NotFound("session not found")
                    case Some(sessionVal) =>
                        if (!isJsObject(sessionVal)) {
                            return TutoringOutcome.NotFound("session not found")
                        }
                        return answerParsed(userId, sessionId, sessionVal.asObject(),
                                            optionIndex, optionLabel, freeText)
                }
        }
    }

    private func answerParsed(userId: Array<Byte>, sessionId: Array<Byte>,
                              session: JsonObject, optionIndex: ?Int64,
                              optionLabel: ?String, freeText: ?String): TutoringOutcome {
        let sessionStatus = jsonGetString(session, "status") ?? ""
        if (sessionStatus == "completed") {
            return TutoringOutcome.Invalid("tutoring session already completed")
        }
        let learnerCode = jsonGetString(session, "learnerCode") ?? ""
        match (getScript(learnerCode, Some(userId))) {
            case None => return TutoringOutcome.NotFound("tutoring script not found")
            case Some(script) =>
                let currentNodeId = jsonGetString(session, "currentNodeId")
                var node: ?JsonObject = None
                match (currentNodeId) {
                    case None => ()
                    case Some(nid) => node = scriptNode(script, nid)
                }
                match (node) {
                    case None => return TutoringOutcome.Invalid("invalid current node")
                    case Some(nodeObj) =>
                        return answerOnNode(userId, sessionId, session, script, nodeObj,
                                            currentNodeId, optionIndex, optionLabel, freeText)
                }
        }
    }

    private func answerOnNode(userId: Array<Byte>, sessionId: Array<Byte>,
                              session: JsonObject, script: JsonObject,
                              nodeObj: JsonObject, currentNodeId: ?String,
                              optionIndex: ?Int64, optionLabel: ?String,
                              freeText: ?String): TutoringOutcome {
        let options = nodeOptions(nodeObj)
        var selected: ?JsonObject = None
        var text: ?String = freeText

        match (optionIndex) {
            case Some(idx) =>
                if (idx < 0 || idx >= options.size()) {
                    return TutoringOutcome.Invalid("invalid option index")
                }
                match (options.get(idx)) {
                    case None => return TutoringOutcome.Invalid("invalid option index")
                    case Some(opt) =>
                        match (asOptionObject(opt)) {
                            case None => return TutoringOutcome.Invalid("invalid option index")
                            case Some(optObj) =>
                                selected = Some(optObj)
                                text = optionLabelOf(optObj)
                        }
                }
            case None => ()
        }
        /* Python if/elif/elif — only the first provided selector runs. */
        var stillUnselected = true
        match (selected) {
            case Some(_) => stillUnselected = false
            case None => ()
        }
        if (stillUnselected) {
            match (optionLabel) {
                case Some(want) =>
                    var found: ?JsonObject = None
                    var i: Int64 = 0
                    while (i < options.size()) {
                        match (options.get(i)) {
                            case Some(opt) =>
                                match (asOptionObject(opt)) {
                                    case Some(optObj) =>
                                        match (optionLabelOf(optObj)) {
                                            case Some(lab) =>
                                                if (lab == want) {
                                                    match (found) {
                                                        case None => found = Some(optObj)
                                                        case Some(_) => ()
                                                    }
                                                }
                                            case None => ()
                                        }
                                    case None => ()
                                }
                            case None => ()
                        }
                        i += 1
                    }
                    match (found) {
                        case None => return TutoringOutcome.Invalid("invalid option label")
                        case Some(optObj) =>
                            selected = Some(optObj)
                            text = optionLabelOf(optObj)
                            stillUnselected = false
                    }
                case None => ()
            }
        }
        if (stillUnselected) {
            match (freeText) {
                case Some(ft) =>
                    text = freeText
                    selected = matchFreeText(ft, options)
                case None => ()
            }
        }

        var finalText = ""
        match (text) {
            case Some(t) => finalText = t
            case None => return TutoringOutcome.Invalid("answer is required")
        }
        if (pyStrip(finalText).size == 0) {
            return TutoringOutcome.Invalid("answer is required")
        }

        let level = jsonGetInt(session, "level") ?? 2
        var messagesJson = parseJsonArrayText(jsonRawField(session, "messages"))
        var answersJson = parseJsonArrayText(jsonRawField(session, "answers"))
        let decisionsJson = parseJsonArrayText(jsonRawField(session, "decisions"))
        let before = jsonGetInt(session, "scoreBefore") ?? 50

        /* messages.append({"kind":"learner","text":str(text)}) */
        let learnerMsg = JsonWriter()
        learnerMsg.putStr("kind", "learner")
        learnerMsg.putStr("text", finalText)
        messagesJson = jsonArrayAppendRaw(messagesJson, learnerMsg.toJson())

        /* free-text unmatched: stay on the node, no answers entry */
        var unmatchedFree = false
        match (freeText) {
            case Some(_) =>
                match (selected) {
                    case None => unmatchedFree = true
                    case Some(_) => ()
                }
            case None => ()
        }
        if (unmatchedFree) {
            let fb = JsonWriter()
            fb.putStr("kind", "feedback")
            fb.putStr("verdict", "wrong")
            fb.putStr("text", "我已经记下你的想法，但暂时无法稳定映射到本题选项。可以补充关键词，或点一个最接近的快答继续。")
            messagesJson = jsonArrayAppendRaw(messagesJson, fb.toJson())
            match (TutoringStore(conn).save(userId, sessionId, currentNodeId, "running", level,
                                            messagesJson, answersJson, decisionsJson, None)) {
                case None => return TutoringOutcome.NotFound("session not found")
                case Some(saved) =>
                    match (enrichSession(userId, saved, Some(script))) {
                        case None => return TutoringOutcome.NotFound("session not found")
                        case Some(full) => return TutoringOutcome.Done(full)
                    }
            }
        }

        /* selected is not None and selected.get("correct") is not None -> answers + feedback.
           bool() follows Python truthiness, so 0/""/[] are False. */
        var hasCorrect = false
        var correctVal = false
        match (selected) {
            case None => ()
            case Some(optObj) =>
                match (optObj.get("correct")) {
                    case None => ()
                    case Some(cVal) =>
                        if (!pyIsNone(Some(cVal))) {
                            hasCorrect = true
                            correctVal = jsonValTruthy(cVal)
                        }
                }
        }
        if (hasCorrect) {
            answersJson = jsonArrayAppendRaw(answersJson, if (correctVal) { "true" } else { "false" })
            let fb = JsonWriter()
            fb.putStr("kind", "feedback")
            fb.putStr("verdict", if (correctVal) { "correct" } else { "wrong" })
            if (correctVal) {
                fb.putStr("text", "答对了，这一步的因果链你已经抓住了。")
            } else {
                fb.putStr("text", "先别急，换个角度再想想。")
            }
            messagesJson = jsonArrayAppendRaw(messagesJson, fb.toJson())
        }

        /*
         * Python target resolution. The generator yields the FIRST truthy-correct
         * option's next (possibly None); `or` then falls through to
         * options[0].next on None and "".
         */
        var target: ?String = None
        match (selected) {
            case Some(optObj) => target = optionNext(optObj)
            case None =>
                var genNext: ?String = None
                var genDone = false
                var firstOptionNext: ?String = None
                var gotFirst = false
                var i: Int64 = 0
                while (i < options.size()) {
                    match (options.get(i)) {
                        case Some(opt) =>
                            match (asOptionObject(opt)) {
                                case Some(optObj) =>
                                    let n = optionNext(optObj)
                                    if (!gotFirst) {
                                        gotFirst = true
                                        firstOptionNext = n
                                    }
                                    if (!genDone) {
                                        match (optObj.get("correct")) {
                                            case None => ()
                                            case Some(cVal) =>
                                                if (jsonValTruthy(cVal)) {
                                                    genDone = true
                                                    genNext = n
                                                }
                                        }
                                    }
                                case None => ()
                            }
                        case None => ()
                    }
                    i += 1
                }
                var useFallback = true
                match (genNext) {
                    case Some(p) =>
                        if (p.size > 0) {
                            target = Some(p)
                            useFallback = false
                        }
                    case None => ()
                }
                if (useFallback && gotFirst) {
                    target = firstOptionNext
                }
        }

        var nextNode = currentNodeId
        var nextLevel = level
        var nextMessages = messagesJson
        var nextDecisions = decisionsJson
        match (target) {
            case None => ()
            case Some(t) =>
                if (t.size > 0) {
                    let entered = enterNode(nextMessages, nextDecisions, nextLevel, script, Some(t))
                    nextMessages = entered.messagesJson
                    nextDecisions = entered.decisionsJson
                    nextLevel = entered.level
                    nextNode = entered.currentNodeId
                }
        }
        var completed = false
        match (nextNode) {
            case None => completed = true
            case Some(_) => ()
        }
        let status = if (completed) { "completed" } else { "running" }
        var scoreAfter: ?Int64 = None
        if (completed) {
            scoreAfter = Some(before + 6)
        }
        match (TutoringStore(conn).save(userId, sessionId, nextNode, status, nextLevel,
                                        nextMessages, answersJson, nextDecisions, scoreAfter)) {
            case None => return TutoringOutcome.NotFound("session not found")
            case Some(saved) =>
                match (enrichSession(userId, saved, Some(script))) {
                    case None => return TutoringOutcome.NotFound("session not found")
                    case Some(full) => return TutoringOutcome.Done(full)
                }
        }
    }

    /* Python complete(): always status=completed, score_after=scoreBefore+6. */
    public func complete(userId: Array<Byte>, sessionId: Array<Byte>): TutoringOutcome {
        match (TutoringStore(conn).get(userId, sessionId)) {
            case None => return TutoringOutcome.NotFound("session not found")
            case Some(sessionRaw) =>
                match (jsonParse(sessionRaw)) {
                    case None => return TutoringOutcome.NotFound("session not found")
                    case Some(sessionVal) =>
                        if (!isJsObject(sessionVal)) {
                            return TutoringOutcome.NotFound("session not found")
                        }
                        let session = sessionVal.asObject()
                        let level = jsonGetInt(session, "level") ?? 2
                        let before = jsonGetInt(session, "scoreBefore") ?? 50
                        match (TutoringStore(conn).save(
                            userId, sessionId, None, "completed", level,
                            parseJsonArrayText(jsonRawField(session, "messages")),
                            parseJsonArrayText(jsonRawField(session, "answers")),
                            parseJsonArrayText(jsonRawField(session, "decisions")),
                            Some(before + 6))) {
                            case None => return TutoringOutcome.NotFound("session not found")
                            case Some(saved) =>
                                match (enrichSession(userId, saved, None)) {
                                    case None => return TutoringOutcome.NotFound("session not found")
                                    case Some(full) => return TutoringOutcome.Done(full)
                                }
                        }
                }
        }
    }

    /* -------- _score_before -------- */

    /*
     * Python _score_before:
     *   resource:* -> 50
     *   else int(scores_json[kpId] or 50)  — 0/False/""/None fall back to 50
     * kp_id may be empty; scores.get("") is normally missing -> 50.
     */
    private func scoreBeforeFor(learnerCode: String, kpId: ?String): Int64 {
        if (learnerCode.startsWith("resource:")) {
            return 50
        }
        var kp = ""
        match (kpId) {
            case Some(k) => kp = k
            case None => ()
        }
        if (kp.size == 0) {
            return 50
        }
        let sql = "SELECT scores_json FROM learners WHERE code=" + sqlQuote(learnerCode) + " LIMIT 1"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return 50
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return 50
                }
                let text = cellText(rs.rows[0], 0)
                if (text.size == 0) {
                    return 50
                }
                match (jsonParse(text)) {
                    case None => return 50
                    case Some(v) =>
                        if (!isJsObject(v)) {
                            return 50
                        }
                        return pyIntOr(v.asObject().get(kp), 50)
                }
        }
    }

    /* -------- enrichment -------- */

    private func enrichSession(userId: Array<Byte>, sessionRaw: String,
                               script: ?JsonObject): ?String {
        match (jsonParse(sessionRaw)) {
            case None => return None
            case Some(sessionVal) =>
                if (!isJsObject(sessionVal)) {
                    return None
                }
                let session = sessionVal.asObject()
                var scriptObj: ?JsonObject = None
                match (script) {
                    case Some(s) => scriptObj = Some(s)
                    case None =>
                        match (jsonGetString(session, "learnerCode")) {
                            case None => ()
                            case Some(code) => scriptObj = getScript(code, Some(userId))
                        }
                }

                var node: ?JsonObject = None
                match (jsonGetString(session, "currentNodeId")) {
                    case None => ()
                    case Some(nid) =>
                        match (scriptObj) {
                            case Some(s) => node = scriptNode(s, nid)
                            case None => ()
                        }
                }

                let w = JsonWriter()
                w.putStr("id", jsonGetString(session, "id") ?? "")
                w.putStr("learnerCode", jsonGetString(session, "learnerCode") ?? "")
                w.putOptStr("kpId", jsonGetString(session, "kpId"))
                w.putOptStr("scriptTitle", jsonGetString(session, "scriptTitle"))
                w.putStr("status", jsonGetString(session, "status") ?? "")
                w.putOptStr("currentNodeId", jsonGetString(session, "currentNodeId"))
                w.putInt("level", jsonGetInt(session, "level") ?? 2)
                w.putRaw("messages", parseJsonArrayText(jsonRawField(session, "messages")))
                w.putRaw("answers", parseJsonArrayText(jsonRawField(session, "answers")))
                w.putRaw("decisions", parseJsonArrayText(jsonRawField(session, "decisions")))
                w.putInt("scoreBefore", jsonGetInt(session, "scoreBefore") ?? 50)
                w.putOptInt("scoreAfter", jsonGetInt(session, "scoreAfter"))
                w.putStr("createdAt", jsonGetString(session, "createdAt") ?? "")
                w.putStr("updatedAt", jsonGetString(session, "updatedAt") ?? "")

                match (node) {
                    case None => w.putRaw("currentNode", "null")
                    case Some(n) =>
                        let cw = JsonWriter()
                        cw.putRaw("id", jsonRawOrNull(n, "id"))
                        cw.putRaw("stage", jsonRawOrNull(n, "stage"))
                        let opts = JsonArrWriter()
                        let rawOpts = nodeOptions(n)
                        var i: Int64 = 0
                        while (i < rawOpts.size()) {
                            match (rawOpts.get(i)) {
                                case Some(opt) =>
                                    let ow = JsonWriter()
                                    /* Python: {"label": option.get("label", "")} —
                                       missing key is "", present null stays null. */
                                    match (asOptionObject(opt)) {
                                        case Some(optObj) =>
                                            match (optObj.get("label")) {
                                                case None => ow.putStr("label", "")
                                                case Some(lab) => ow.putRaw("label", valueToRaw(lab))
                                            }
                                        case None =>
                                            ow.putStr("label", "")
                                    }
                                    opts.addRaw(ow.toJson())
                                case None => ()
                            }
                            i += 1
                        }
                        cw.putRaw("options", opts.toJson())
                        w.putRaw("currentNode", cw.toJson())
                }

                match (scriptObj) {
                    case None =>
                        w.putRaw("topics", "[]")
                        w.putRaw("resourceId", "null")
                    case Some(s) =>
                        match (jsonGetArray(s, "topics")) {
                            case None => w.putRaw("topics", "[]")
                            case Some(arr) =>
                                if (arr.size() == 0) {
                                    w.putRaw("topics", "[]")
                                } else {
                                    w.putRaw("topics", jsonArrayToRaw(arr))
                                }
                        }
                        match (jsonGetString(s, "resourceId")) {
                            case None => w.putRaw("resourceId", "null")
                            case Some(rid) => w.putStr("resourceId", rid)
                        }
                }
                return Some(w.toJson())
        }
    }
}

/* -------- node / option accessors -------- */

func scriptNode(script: JsonObject, nodeId: String): ?JsonObject {
    match (jsonGetObject(script, "nodes")) {
        case None => return None
        case Some(nodes) =>
            match (nodes.get(nodeId)) {
                case None => return None
                case Some(v) =>
                    if (isJsObject(v)) {
                        return Some(v.asObject())
                    }
                    return None
            }
    }
}

func nodeOptions(node: JsonObject): JsonArray {
    match (jsonGetArray(node, "options")) {
        case None => return jarr()
        case Some(arr) => return arr
    }
}

func asOptionObject(v: JsonValue): ?JsonObject {
    if (isJsObject(v)) {
        return Some(v.asObject())
    }
    return None
}

func optionLabelOf(opt: JsonObject): ?String {
    jsonGetString(opt, "label")
}

func optionNext(opt: JsonObject): ?String {
    jsonGetString(opt, "next")
}

func optionCorrect(opt: JsonObject): ?Bool {
    jsonGetBool(opt, "correct")
}

/* Raw JSON text of a field that is already an array/object/null. */
func jsonRawField(obj: JsonObject, key: String): String {
    match (obj.get(key)) {
        case None => return "[]"
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsNull => return "[]"
                case JsonKind.JsArray => return jsonArrayToRaw(v.asArray())
                case _ => return valueToRaw(v)
            }
    }
}

func jsonArrayAppendRaw(arrRaw: String, itemRaw: String): String {
    match (jsonParse(arrRaw)) {
        case None => return "[" + itemRaw + "]"
        case Some(v) =>
            if (!isJsArray(v)) {
                return "[" + itemRaw + "]"
            }
            let arr = v.asArray()
            let w = JsonArrWriter()
            var i: Int64 = 0
            while (i < arr.size()) {
                match (arr.get(i)) {
                    case Some(item) => w.addRaw(valueToRaw(item))
                    case None => ()
                }
                i += 1
            }
            w.addRaw(itemRaw)
            return w.toJson()
    }
}

func jsonArrayPrependRaw(arrRaw: String, itemRaw: String): String {
    match (jsonParse(arrRaw)) {
        case None => return "[" + itemRaw + "]"
        case Some(v) =>
            if (!isJsArray(v)) {
                return "[" + itemRaw + "]"
            }
            let arr = v.asArray()
            let w = JsonArrWriter()
            w.addRaw(itemRaw)
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
}

/* -------- _enter_node -------- */

/*
 * Appends backstage + tutor messages, an optional decision (inserted at the
 * front of decisions), level nudge, and an optional summary when the node is
 * an end node. currentNode is None on an end node or when the id is unknown.
 */
func enterNode(messagesJson: String, decisionsJson: String, level: Int64,
               script: JsonObject, nodeId: ?String): TutoringDraft {
    var nid = ""
    match (nodeId) {
        case None =>
            return TutoringDraft(messagesJson, "[]", decisionsJson, level, None, "running", None)
        case Some(v) => nid = v
    }
    match (scriptNode(script, nid)) {
        case None =>
            return TutoringDraft(messagesJson, "[]", decisionsJson, level, None, "running", None)
        case Some(node) =>
            var messages = messagesJson
            var decisions = decisionsJson
            var lvl = level

            match (jsonGetArray(node, "backstage")) {
                case None => ()
                case Some(notes) =>
                    if (notes.size() > 0) {
                        let w = JsonWriter()
                        w.putStr("kind", "backstage")
                        w.putRaw("notes", jsonArrayToRaw(notes))
                        messages = jsonArrayAppendRaw(messages, w.toJson())
                    }
            }

            /* Python passes stage/text/kbRefs through raw (missing -> null). */
            let tw = JsonWriter()
            tw.putStr("kind", "tutor")
            tw.putRaw("stage", jsonRawOrNull(node, "stage"))
            tw.putRaw("text", jsonRawOrNull(node, "tutor"))
            tw.putRaw("kbRefs", jsonRawOrNull(node, "kbRefs"))
            messages = jsonArrayAppendRaw(messages, tw.toJson())

            /* if node.get("decision"):  — truthy check, not "key present". */
            match (node.get("decision")) {
                case None => ()
                case Some(decVal) =>
                    if (jsonValTruthy(decVal)) {
                        let decType = pyStrOf(decVal)
                        var isChallenge = false
                        if (decType == "challenge") {
                            isChallenge = true
                        }
                        let reason = pyStrOrEmpty(node.get("decisionReason"))
                        let dw = JsonWriter()
                        dw.putStr("id", "d-" + uuidHex8())
                        dw.putRaw("type", valueToRaw(decVal))
                        if (isChallenge) {
                            dw.putStr("label", "进阶挑战")
                        } else {
                            dw.putStr("label", "降维解释")
                        }
                        dw.putStr("reason", reason)
                        if (isChallenge) {
                            dw.putRaw("confidence", "0.95")
                        } else {
                            dw.putRaw("confidence", "0.92")
                        }
                        decisions = jsonArrayPrependRaw(decisions, dw.toJson())

                        let dm = JsonWriter()
                        dm.putStr("kind", "decision")
                        dm.putRaw("type", valueToRaw(decVal))
                        dm.putStr("reason", reason)
                        dm.putInt("accuracy", messagesAccuracy(messages))
                        dm.putInt("asked", messagesFeedbackCount(messages))
                        messages = jsonArrayAppendRaw(messages, dm.toJson())

                        if (isChallenge) {
                            if (lvl + 1 > 5) { lvl = 5 } else { lvl = lvl + 1 }
                        } else {
                            if (lvl - 1 < 1) { lvl = 1 } else { lvl = lvl - 1 }
                        }
                    }
            }

            match (jsonGetBool(node, "end")) {
                case Some(true) =>
                    let sw = JsonWriter()
                    sw.putStr("kind", "summary")
                    messages = jsonArrayAppendRaw(messages, sw.toJson())
                    return TutoringDraft(messages, "[]", decisions, lvl, None, "running", None)
                case _ => ()
            }
            return TutoringDraft(messages, "[]", decisions, lvl, Some(nid), "running", None)
    }
}

/* Python round(correct * 100 / len(answers)) over kind=="feedback" messages. */
func messagesAccuracy(messagesJson: String): Int64 {
    let total = messagesFeedbackCount(messagesJson)
    if (total == 0) {
        return 0
    }
    var correct = 0
    match (jsonParse(messagesJson)) {
        case None => return 0
        case Some(v) =>
            if (!isJsArray(v)) {
                return 0
            }
            let arr = v.asArray()
            var i: Int64 = 0
            while (i < arr.size()) {
                match (arr.get(i)) {
                    case Some(item) =>
                        if (isJsObject(item)) {
                            let obj = item.asObject()
                            match (jsonGetString(obj, "kind")) {
                                case Some(k) =>
                                    if (k == "feedback") {
                                        match (jsonGetString(obj, "verdict")) {
                                            case Some(ver) =>
                                                if (ver == "correct") {
                                                    correct += 1
                                                }
                                            case None => ()
                                        }
                                    }
                                case None => ()
                            }
                        }
                    case None => ()
                }
                i += 1
            }
    }
    return pythonRoundInt(floatFromInt(correct) * 100.0 / floatFromInt(total))
}

func messagesFeedbackCount(messagesJson: String): Int64 {
    match (jsonParse(messagesJson)) {
        case None => return 0
        case Some(v) =>
            if (!isJsArray(v)) {
                return 0
            }
            let arr = v.asArray()
            var n = 0
            var i: Int64 = 0
            while (i < arr.size()) {
                match (arr.get(i)) {
                    case Some(item) =>
                        if (isJsObject(item)) {
                            match (jsonGetString(item.asObject(), "kind")) {
                                case Some(k) =>
                                    if (k == "feedback") {
                                        n += 1
                                    }
                                case None => ()
                            }
                        }
                    case None => ()
                }
                i += 1
            }
            return n
    }
}

/* Python round(correct * 100 / len(answers)) uses half-to-even; see pythonRoundInt. */

/* 8 hex chars from a fresh uuid — Python uuid4().hex[:8]. */
func uuidHex8(): String {
    let bytes = uuidV4()
    var out = ""
    var i: Int64 = 0
    while (i < 4) {
        out = out + byteHex(bytes[i])
        i += 1
    }
    return out
}

func byteHex(b: Byte): String {
    let n = Int64(b)
    let hi = n / 16
    let lo = n % 16
    return hexDigit(hi) + hexDigit(lo)
}

func hexDigit(n: Int64): String {
    if (n < 10) {
        return n.toString()
    }
    if (n == 10) { return "a" }
    if (n == 11) { return "b" }
    if (n == 12) { return "c" }
    if (n == 13) { return "d" }
    if (n == 14) { return "e" }
    return "f"
}

/* -------- _match_free_text -------- */

/*
 * normalize: keep a-z0-9 + CJK (U+4E00..U+9FFF) after ASCII lower.
 * score = max(contained, Jaccard(char sets), SequenceMatcher.ratio)
 * pick the first option with the highest score; accept when score >= 0.36.
 */
func matchFreeText(text: String, options: JsonArray): ?JsonObject {
    let query = tutoringNormalize(text)
    if (query.size == 0) {
        return None
    }
    let queryRunes = query.toRuneArray()
    var bestScore = -1.0
    var best: ?JsonObject = None
    var i: Int64 = 0
    while (i < options.size()) {
        match (options.get(i)) {
            case Some(opt) =>
                match (asOptionObject(opt)) {
                    case None => ()
                    case Some(optObj) =>
                        let label = tutoringNormalize(optionLabelOf(optObj) ?? "")
                        if (label.size > 0) {
                            var score = 0.0
                            var contained = false
                            match (query.indexOf(label)) {
                                case Some(_) => contained = true
                                case None => ()
                            }
                            match (label.indexOf(query)) {
                                case Some(_) => contained = true
                                case None => ()
                            }
                            if (contained) {
                                score = 1.0
                            }
                            let shared = jaccardChars(queryRunes, label.toRuneArray())
                            if (shared > score) { score = shared }
                            let sequence = sequenceRatio(queryRunes, label.toRuneArray())
                            if (sequence > score) { score = sequence }
                            if (score > bestScore) {
                                bestScore = score
                                best = Some(optObj)
                            }
                        }
                }
            case None => ()
        }
        i += 1
    }
    if (bestScore >= 0.36) {
        return best
    }
    return None
}

func tutoringNormalize(value: String): String {
    var out = ""
    for (ch in value.toAsciiLower().toRuneArray()) {
        let c = runeCode(ch)
        if ((c >= 0x30 && c <= 0x39) ||
            (c >= 0x61 && c <= 0x7a) ||
            (c >= 0x4e00 && c <= 0x9fff)) {
            out = out + ch.toString()
        }
    }
    return out
}

func jaccardChars(a: Array<Rune>, b: Array<Rune>): Float64 {
    let ka = ArrayList<Int64>()
    let sa = HashMap<Int64, Bool>()
    for (ch in a) {
        let c = runeCode(ch)
        match (sa.get(c)) {
            case Some(_) => ()
            case None =>
                sa.add(c, true)
                ka.add(c)
        }
    }
    let sb = HashMap<Int64, Bool>()
    var bUnique = 0
    for (ch in b) {
        let c = runeCode(ch)
        match (sb.get(c)) {
            case Some(_) => ()
            case None =>
                sb.add(c, true)
                bUnique += 1
        }
    }
    var inter = 0
    var i = 0
    while (i < ka.size) {
        match (sb.get(ka[i])) {
            case Some(_) => inter += 1
            case None => ()
        }
        i += 1
    }
    /* Python: len(set(a) & set(b)) / max(1, len(set(a) | set(b))) */
    let union = ka.size + bUnique - inter
    if (union <= 0) {
        return 0.0
    }
    return floatFromInt(inter) / floatFromInt(union)
}

/* SequenceMatcher.ratio ≈ 2*M / (len(a)+len(b)) over matching blocks. */
func sequenceRatio(a: Array<Rune>, b: Array<Rune>): Float64 {
    let n = a.size
    let m = b.size
    if (n == 0 && m == 0) {
        return 1.0
    }
    if (n == 0 || m == 0) {
        return 0.0
    }
    let matched = matchingBlockTotal(a, 0, n, b, 0, m)
    return 2.0 * floatFromInt(matched) / floatFromInt(n + m)
}

private func matchingBlockTotal(a: Array<Rune>, a1: Int64, a2: Int64,
                                b: Array<Rune>, b1: Int64, b2: Int64): Int64 {
    var bestLen = 0
    var bestI = -1
    var bestJ = -1
    var i = a1
    while (i < a2) {
        var j = b1
        while (j < b2) {
            if (runeCode(a[i]) == runeCode(b[j])) {
                var k = 0
                while (i + k < a2 && j + k < b2 && runeCode(a[i + k]) == runeCode(b[j + k])) {
                    k += 1
                }
                if (k > bestLen) {
                    bestLen = k
                    bestI = i
                    bestJ = j
                }
                j += k
            } else {
                j += 1
            }
        }
        i += 1
    }
    if (bestLen == 0) {
        return 0
    }
    return bestLen +
        matchingBlockTotal(a, a1, bestI, b, b1, bestJ) +
        matchingBlockTotal(a, bestI + bestLen, a2, b, bestJ + bestLen, b2)
}

/* -------- _script_from_quiz -------- */

/*
 * Builds a tutoring script from a quiz learning-resource JSON (serializeDetail
 * shape). Returns None unless type == "quiz" and content.questions is non-empty.
 */
func scriptFromQuiz(resourceRaw: String): ?JsonObject {
    match (jsonParse(resourceRaw)) {
        case None => return None
        case Some(v) =>
            if (!isJsObject(v)) {
                return None
            }
            return scriptFromQuizObj(v.asObject())
    }
}

func scriptFromQuizObj(resource: JsonObject): ?JsonObject {
    match (jsonGetString(resource, "type")) {
        case Some(t) =>
            if (t != "quiz") {
                return None
            }
        case None => return None
    }
    var content = emptyObject()
    match (jsonGetObject(resource, "content")) {
        case Some(c) => content = c
        case None => ()
    }
    var questionsArr = jarr()
    match (jsonGetArray(content, "questions")) {
        case Some(qs) => questionsArr = qs
        case None => ()
    }
    /* keep dict entries only, then take the first 6 */
    let questions = ArrayList<JsonObject>()
    var qi: Int64 = 0
    while (qi < questionsArr.size() && questions.size < 6) {
        match (questionsArr.get(qi)) {
            case Some(item) =>
                if (isJsObject(item)) {
                    questions.add(item.asObject())
                }
            case None => ()
        }
        qi += 1
    }
    if (questions.size == 0) {
        return None
    }

    let nodes = JsonWriter()
    var n: Int64 = 0
    let total = questions.size
    while (n < total) {
        let question = questions[n]
        let nodeId = "q" + (n + 1).toString()
        let nextId = if (n + 1 < total) { "q" + (n + 2).toString() } else { "summary" }

        let labels = ArrayList<String>()
        match (jsonGetArray(question, "options")) {
            case None => ()
            case Some(opts) =>
                var oi: Int64 = 0
                while (oi < opts.size()) {
                    match (opts.get(oi)) {
                        case Some(item) =>
                            match (asStringValue(item)) {
                                case Some(s) => labels.add(s)
                                case None => labels.add("")
                            }
                        case None => labels.add("")
                    }
                    oi += 1
                }
        }
        /* int(question.get("correctIndex", -1)) with TypeError/ValueError -> -1 */
        let correctIndex = pyIntDefault(question.get("correctIndex"), -1)

        let optArr = JsonArrWriter()
        var oi: Int64 = 0
        while (oi < labels.size) {
            var correct = false
            if (oi == correctIndex) {
                correct = true
            }
            let ow = JsonWriter()
            ow.putStr("label", labels[oi])
            ow.putBool("correct", correct)
            if (correct) {
                ow.putStr("next", nextId)
            } else {
                ow.putStr("next", nodeId + "-explain")
            }
            optArr.addRaw(ow.toJson())
            oi += 1
        }

        /* question.get("kbRefs") or resource.get("kbRefs") or [] — empty list falls through. */
        var refsRaw = "[]"
        match (question.get("kbRefs")) {
            case Some(v) =>
                if (jsonValTruthy(v)) {
                    refsRaw = valueToRaw(v)
                }
            case None => ()
        }
        if (refsRaw == "[]") {
            match (resource.get("kbRefs")) {
                case Some(v) =>
                    if (jsonValTruthy(v)) {
                        refsRaw = valueToRaw(v)
                    }
                case None => ()
            }
        }

        var stage = "确认"
        if (n == 0) {
            stage = "引导"
        } else if (n < total - 1) {
            stage = "追问"
        }
        let stem = pyOrStr(question.get("stem"), None,
                           "第 " + (n + 1).toString() + " 个问题")
        let difficulty = pyOrStr(question.get("difficulty"), None, "自适应")

        /* qN */
        let nw = JsonWriter()
        nw.putStr("id", nodeId)
        nw.putStr("stage", stage)
        nw.putStr("tutor", stem)
        nw.putRaw("options", optArr.toJson())
        nw.putRaw("kbRefs", refsRaw)
        let notes = JsonArrWriter()
        let note = JsonWriter()
        note.putStr("agent", "DIA-01")
        note.putStr("content", "依据真实课程题目评估「" + difficulty + "」层级掌握情况")
        notes.addRaw(note.toJson())
        nw.putRaw("backstage", notes.toJson())
        nodes.putRaw(nodeId, nw.toJson())

        /* qN-explain */
        let explanation = pyOrStr(question.get("explanation"), None,
                                  "先回到题干中的关键条件，再判断各选项之间的差异。")
        var correctText = "参考正确选项"
        if (correctIndex >= 0 && correctIndex < labels.size) {
            correctText = labels[correctIndex]
        }
        let ew = JsonWriter()
        ew.putStr("id", nodeId + "-explain")
        ew.putStr("stage", "追问")
        ew.putStr("tutor", "我们把这一步拆开：" + explanation + " 因此更合适的判断是「" + correctText + "」。")
        let eopts = JsonArrWriter()
        let eopt = JsonWriter()
        eopt.putStr("label", "我理解了，继续")
        eopt.putStr("next", nextId)
        eopts.addRaw(eopt.toJson())
        ew.putRaw("options", eopts.toJson())
        ew.putRaw("kbRefs", refsRaw)
        ew.putStr("decision", "simplify")
        ew.putStr("decisionReason", "本题首次未命中，ARB-05 下发解释后再继续下一步")
        let enotes = JsonArrWriter()
        let en1 = JsonWriter()
        en1.putStr("agent", "VER-04")
        en1.putStr("content", "核对答案与生成题目的解析一致性")
        enotes.addRaw(en1.toJson())
        let en2 = JsonWriter()
        en2.putStr("agent", "ARB-05")
        en2.putStr("content", "采用降维解释，保留学习节奏而不重复扣分")
        enotes.addRaw(en2.toJson())
        ew.putRaw("backstage", enotes.toJson())
        nodes.putRaw(nodeId + "-explain", ew.toJson())

        n += 1
    }

    /* summary node */
    let resTitle = pyOrStr(resource.get("title"), None, "课程导学")
    let sw = JsonWriter()
    sw.putStr("id", "summary")
    sw.putStr("stage", "确认")
    sw.putStr("tutor", "本轮《" + resTitle + "》已经完成。系统已保存会话、答题走势和动态决策，可以回到课程继续学习。")
    sw.putStr("decision", "challenge")
    sw.putStr("decisionReason", "完成本轮真实课程导学，建议进入下一项课程资源")
    let snotes = JsonArrWriter()
    let sn1 = JsonWriter()
    sn1.putStr("agent", "DIA-01")
    sn1.putStr("content", "汇总本轮答题表现")
    snotes.addRaw(sn1.toJson())
    let sn2 = JsonWriter()
    sn2.putStr("agent", "ARB-05")
    sn2.putStr("content", "生成下一步学习建议")
    snotes.addRaw(sn2.toJson())
    sw.putRaw("backstage", snotes.toJson())
    sw.putBool("end", true)
    nodes.putRaw("summary", sw.toJson())

    /* topics from content.knowledgePoints[:4] */
    let topicsArr = JsonArrWriter()
    var points = jarr()
    match (jsonGetArray(content, "knowledgePoints")) {
        case Some(p) => points = p
        case None => ()
    }
    var kbRefRaw = "null"
    match (jsonGetArray(resource, "kbRefs")) {
        case Some(refs) =>
            if (refs.size() > 0) {
                match (refs.get(0)) {
                    case Some(first) => kbRefRaw = valueToRaw(first)
                    case None => ()
                }
            }
        case None => ()
    }
    var pi: Int64 = 0
    while (pi < points.size() && pi < 4) {
        match (points.get(pi)) {
            case Some(item) =>
                if (isJsObject(item)) {
                    let p = item.asObject()
                    /* str(item.get("id") or item.get("categoryId") or index) */
                    let pid = pyOrStr(p.get("id"), p.get("categoryId"), pi.toString())
                    let tw = JsonWriter()
                    tw.putStr("id", pid)
                    tw.putStr("name", topicName(p, resource, pi))
                    tw.putStr("description", pyOrStr(p.get("description"), None, "来自当前课程分阶题"))
                    tw.putRaw("kbRef", kbRefRaw)
                    topicsArr.addRaw(tw.toJson())
                }
            case None => ()
        }
        pi += 1
    }
    var fallbackKp = ""
    if (topicsArr.toJson() == "[]") {
        let tw = JsonWriter()
        /* resource.get("kpId") or "course-topic" / topic or title or "课程知识点" */
        let fallbackId = pyOrStr(resource.get("kpId"), None, "course-topic")
        fallbackKp = fallbackId
        tw.putStr("id", fallbackId)
        tw.putStr("name", pyOrStr(resource.get("topic"), resource.get("title"), "课程知识点"))
        tw.putStr("description", "来自当前课程的真实分阶题")
        tw.putRaw("kbRef", kbRefRaw)
        topicsArr.addRaw(tw.toJson())
    }

    /* resource.get("kpId") or topics[0]["id"] */
    var kp = pyOrStr(resource.get("kpId"), None, "")
    if (kp.size == 0) {
        match (jsonParse(topicsArr.toJson())) {
            case Some(v) =>
                if (isJsArray(v)) {
                    match (v.asArray().get(0)) {
                        case Some(first) =>
                            if (isJsObject(first)) {
                                kp = jsonGetString(first.asObject(), "id") ?? fallbackKp
                            }
                        case None => ()
                    }
                }
            case None => ()
        }
    }

    /* f"苏格拉底导学 · {resource.get('title') or resource.get('topic')}" —
       both missing formats Python None as "None". */
    let titleText = pyOrStr(resource.get("title"), resource.get("topic"), "None")

    let out = JsonWriter()
    out.putStr("learnerId", "resource:" + pyStrOrEmpty(resource.get("id")))
    out.putStr("resourceId", pyStrOrEmpty(resource.get("id")))
    out.putStr("title", "苏格拉底导学 · " + titleText)
    out.putStr("kpId", kp)
    out.putRaw("topics", topicsArr.toJson())
    out.putStr("startId", "q1")
    out.putRaw("nodes", nodes.toJson())
    match (jsonParse(out.toJson())) {
        case Some(v) =>
            if (isJsObject(v)) {
                return Some(v.asObject())
            }
        case None => ()
    }
    return None
}

/*
 * Python str(option) for quiz option labels.
 * str(None)=="None" (not ""), str(True)=="True". Integral floats keep a ".0"
 * like Python. Arrays/objects would be Python repr() — "" is the documented
 * divergence already used by pyStrOf.
 */
func asStringValue(v: JsonValue): ?String {
    if (isJsString(v)) {
        return Some(v.asString().getValue())
    }
    match (v.kind()) {
        case JsonKind.JsInt => return Some(v.asInt().getValue().toString())
        case JsonKind.JsFloat =>
            let s = v.asFloat().getValue().toString()
            if (pyFind(s, ".") < 0 && pyFind(s, "e") < 0 && pyFind(s, "E") < 0) {
                return Some(s + ".0")
            }
            return Some(s)
        case JsonKind.JsBool =>
            return Some(if (v.asBool().getValue()) { "True" } else { "False" })
        case JsonKind.JsNull => return Some("None")
        case _ => return Some("")
    }
}

/*
 * Python int(x) with a failure default — tutoring.py's
 *   try: correct_index = int(question.get("correctIndex", -1))
 *   except (TypeError, ValueError): correct_index = -1
 */
func pyIntDefault(val: ?JsonValue, fallback: Int64): Int64 {
    match (val) {
        case None => return fallback
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsNull => return fallback
                case JsonKind.JsInt => return v.asInt().getValue()
                case JsonKind.JsFloat => return truncateFloat(v.asFloat().getValue())
                case JsonKind.JsBool => return if (v.asBool().getValue()) { 1 } else { 0 }
                case JsonKind.JsString =>
                    return pythonIntText(v.asString().getValue()) ?? fallback
                case _ => return fallback
            }
    }
}

/* Python `a or b` for a raw JSON field, then str() of the survivor. */
func pyOrStr(a: ?JsonValue, b: ?JsonValue, fallback: String): String {
    match (a) {
        case Some(v) =>
            if (jsonValTruthy(v)) {
                return pyStrOf(v)
            }
        case None => ()
    }
    match (b) {
        case Some(v) =>
            if (jsonValTruthy(v)) {
                return pyStrOf(v)
            }
        case None => ()
    }
    return fallback
}

/* Raw JSON of a field, with Python `x if x is not None else "null"` passthrough. */
func jsonRawOrNull(obj: JsonObject, key: String): String {
    match (obj.get(key)) {
        case None => return "null"
        case Some(v) => return valueToRaw(v)
    }
}

/*
 * Python _topic_name: prefer categoryName/name unless the value looks like a
 * machine identifier (fullmatch [a-zA-Z0-9_.-]+ AND contains '_'); otherwise
 * "topic · 要点 N" (or just topic for index 0).
 *   value = str(item.get("categoryName") or item.get("name") or "").strip()
 *   topic = str(resource.get("topic") or resource.get("title") or "课程知识点").strip()
 */
func topicName(item: JsonObject, resource: JsonObject, index: Int64): String {
    let value = pyStrip(pyOrStr(item.get("categoryName"), item.get("name"), ""))
    if (value.size > 0 && !isMachineIdent(value)) {
        return value
    }
    let topic = pyStrip(pyOrStr(resource.get("topic"), resource.get("title"), "课程知识点"))
    if (index == 0) {
        return topic
    }
    return topic + " · 要点 " + (index + 1).toString()
}

func isMachineIdent(value: String): Bool {
    var hasUnderscore = false
    for (ch in value.toRuneArray()) {
        let c = runeCode(ch)
        if (c == 0x5f) {
            hasUnderscore = true
        } else if (!((c >= 0x30 && c <= 0x39) ||
                     (c >= 0x41 && c <= 0x5a) ||
                     (c >= 0x61 && c <= 0x7a) ||
                     c == 0x2e || c == 0x2d)) {
            return false
        }
    }
    return hasUnderscore
}

/* -------- scripts file location -------- */

func loadTutoringScriptsText(): ?String {
    match (getVariable("TUTORING_SCRIPTS_PATH")) {
        case Some(p) =>
            if (p.trimAscii().size > 0) {
                match (readWholeFile(p)) {
                    case Some(bytes) => return Some(bytesToString(bytes))
                    case None => ()
                }
            }
        case None => ()
    }
    let candidates = [
        "resources/tutoring_scripts.json",
        "../resources/tutoring_scripts.json",
        "../../resources/tutoring_scripts.json",
        "../../../resources/tutoring_scripts.json"
    ]
    for (p in candidates) {
        match (readWholeFile(p)) {
            case Some(bytes) => return Some(bytesToString(bytes))
            case None => ()
        }
    }
    return None
}
