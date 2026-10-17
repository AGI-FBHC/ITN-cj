package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * HTTP handlers for the wrong-answer (错题本) module.
 * Path/method/status/body contracts mirror
 * src/agents/app/routers/public.py wrong-answer endpoints so the old frontend
 * can point at this service unchanged.
 */
public func registerWrongAnswerRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/wrong-answers") {
        ctx => handleListWrongAnswers(ctx, cfg)
    }
    app.mapPost("v1/wrong-answers/add") {
        ctx => handleAddToWrongBook(ctx, cfg)
    }
    app.mapPatch("v1/wrong-answers/{wrong_id}") {
        ctx => handleUpdateWrongAnswer(ctx, cfg)
    }
    app.mapPost("v1/wrong-answers/{wrong_id}/review") {
        ctx => handleReviewWrongAnswer(ctx, cfg)
    }
    app.mapDelete("v1/wrong-answers/{wrong_id}") {
        ctx => handleDeleteWrongAnswer(ctx, cfg)
    }
}

func handleListWrongAnswers(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            if (storageUnavailable(cfg)) {
                writeDetail(ctx.response, 503, "Wrong answer storage is unavailable")
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        let store = WrongAnswersStore(conn)
                        let items = store.list(userId, queryParam(ctx.request, "keyword"))
                        conn.close()
                        let arr = JsonArrWriter()
                        for (item in items) {
                            arr.addRaw(item)
                        }
                        let obj = JsonWriter()
                        obj.putRaw("items", arr.toJson())
                        writeJson(ctx.response, 200, obj.toJson())
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "listWrongAnswers: " + e.message)
                    }
            }
    }
}

func handleAddToWrongBook(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (readJsonObjectBody(ctx)) {
                case None => return
                case Some(root) =>
                    match (parseAddToWrongBook(ctx, root)) {
                        case None => return
                        case Some(req) =>
                            if (storageUnavailable(cfg)) {
                                writeDetail(ctx.response, 503, "Wrong answer storage is unavailable")
                                return
                            }
                            try {
                                match (openDb(cfg)) {
                                    case None =>
                                        writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                    case Some(conn) =>
                                        try {
                                            let store = WrongAnswersStore(conn)
                                            let item = store.record(
                                                userId, req.resourceId, req.questionId, req.stem,
                                                req.options, req.userAnswer, req.correctAnswer,
                                                req.explanation, req.difficulty,
                                                None, req.kpId, "quiz", Array<String>(0, repeat: ""),
                                                Array<String>(0, repeat: ""),
                                                None, req.knowledgeCategoryName)
                                            conn.close()
                                            match (item) {
                                                case Some(row) => writeJson(ctx.response, 201, row)
                                                case None =>
                                                    writeInternalDebug(ctx.response, "record returned None")
                                            }
                                        } catch (e: Exception) {
                                            conn.close()
                                            writeInternalDebug(ctx.response, "addToWrongBook: " + e.message)
                                        }
                                }
                            } catch (e: Exception) {
                                writeInternalDebug(ctx.response, "addToWrongBook outer: " + e.message)
                            }
                    }
            }
    }
}

func handleUpdateWrongAnswer(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "wrong_id")) {
                case None => return
                case Some(wrongId) =>
                    match (readJsonObjectBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (parseWrongUpdate(ctx, root)) {
                                case None => return
                                case Some(req) =>
                                    if (storageUnavailable(cfg)) {
                                        writeDetail(ctx.response, 503, "Wrong answer storage is unavailable")
                                        return
                                    }
                                    match (openDb(cfg)) {
                                        case None =>
                                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                        case Some(conn) =>
                                            try {
                                                let store = WrongAnswersStore(conn)
                                                let item = store.update(userId, wrongId, req)
                                                conn.close()
                                                match (item) {
                                                    case Some(row) => writeJson(ctx.response, 200, row)
                                                    case None => writeDetail(ctx.response, 404, "Wrong answer not found")
                                                }
                                            } catch (e: Exception) {
                                                conn.close()
                                                writeInternalDebug(ctx.response, "updateWrongAnswer: " + e.message)
                                            }
                                    }
                            }
                    }
            }
    }
}

func handleReviewWrongAnswer(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "wrong_id")) {
                case None => return
                case Some(wrongId) =>
                    match (readJsonObjectBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (parseReviewAnswer(ctx, root)) {
                                case None => return
                                case Some(answer) =>
                                    if (storageUnavailable(cfg)) {
                                        writeDetail(ctx.response, 503, "Wrong answer storage is unavailable")
                                        return
                                    }
                                    match (openDb(cfg)) {
                                        case None =>
                                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                        case Some(conn) =>
                                            try {
                                                let store = WrongAnswersStore(conn)
                                                let result = store.review(userId, wrongId, answer)
                                                conn.close()
                                                match (result) {
                                                    case None =>
                                                        writeDetail(ctx.response, 404, "Wrong answer not found")
                                                    case Some(outcome) =>
                                                        if (outcome.outOfRange) {
                                                            writeDetail(ctx.response, 422,
                                                                "Answer index is outside the available options")
                                                            return
                                                        }
                                                        match (outcome.item) {
                                                            case None =>
                                                                writeDetail(ctx.response, 404, "Wrong answer not found")
                                                            case Some(item) =>
                                                                let obj = JsonWriter()
                                                                obj.putRaw("item", item)
                                                                obj.putBool("correct", outcome.correct)
                                                                writeJson(ctx.response, 200, obj.toJson())
                                                        }
                                                }
                                            } catch (e: Exception) {
                                                conn.close()
                                                writeInternalDebug(ctx.response, "reviewWrongAnswer: " + e.message)
                                            }
                                    }
                            }
                    }
            }
    }
}

func handleDeleteWrongAnswer(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "wrong_id")) {
                case None => return
                case Some(wrongId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Wrong answer storage is unavailable")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let store = WrongAnswersStore(conn)
                                let deleted = store.delete(userId, wrongId)
                                conn.close()
                                if (deleted) {
                                    ctx.response.statusCode = 204
                                } else {
                                    writeDetail(ctx.response, 404, "Wrong answer not found")
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "deleteWrongAnswer: " + e.message)
                            }
                    }
            }
    }
}

/* -------- request parsing / validation -------- */

struct AddToWrongBookReq {
    let resourceId: ?Array<Byte>
    let questionId: String
    let stem: String
    let options: Array<String>
    let userAnswer: Int64
    let correctAnswer: Int64
    let explanation: String
    let difficulty: String
    let kpId: ?String
    let knowledgeCategoryName: ?String

    init(resourceId: ?Array<Byte>, questionId: String, stem: String, options: Array<String>,
         userAnswer: Int64, correctAnswer: Int64, explanation: String, difficulty: String,
         kpId: ?String, knowledgeCategoryName: ?String) {
        this.resourceId = resourceId
        this.questionId = questionId
        this.stem = stem
        this.options = options
        this.userAnswer = userAnswer
        this.correctAnswer = correctAnswer
        this.explanation = explanation
        this.difficulty = difficulty
        this.kpId = kpId
        this.knowledgeCategoryName = knowledgeCategoryName
    }
}

/*
 * AddToWrongBookRequest (public.py:3050) — declared with camelCase field
 * names and NO validation_alias, so `missing` locs echo those names and a
 * snake_case key is IGNORED by Python (extra default ignore). Spire binds
 * only the declared camelCase names. No field declares min/max length, so
 * only types are checked.
 *
 * Declaration order, and therefore multi-error order:
 *   resourceId, questionId, stem, options, userAnswer, correctAnswer,
 *   explanation, difficulty, kpId, knowledgeCategoryName
 * Measured {} -> four `missing` items in that order (the four required ones).
 */
func parseAddToWrongBook(ctx: HttpContext, root: JsonObject): ?AddToWrongBookReq {
    let bag = PyBag()
    let parentRaw = jsonObjectToRaw(root)

    /* resourceId: UUID | None */
    var resourceId: ?Array<Byte> = None
    match (pyFieldOpt(root, "resourceId", "resourceId")) {
        case None => ()
        case Some(f) => resourceId = pyUuidField(bag, f)
    }
    /* questionId: str */
    var questionId = ""
    match (pyField(root, "questionId", "questionId")) {
        case None => bag.add(pyMissing(["body", "questionId"], parentRaw))
        case Some(f) =>
            match (pyStr(bag, f, 0, 0)) {
                case Some(s) => questionId = s
                case None => ()
            }
    }
    /* stem: str */
    var stem = ""
    match (pyField(root, "stem", "stem")) {
        case None => bag.add(pyMissing(["body", "stem"], parentRaw))
        case Some(f) =>
            match (pyStr(bag, f, 0, 0)) {
                case Some(s) => stem = s
                case None => ()
            }
    }
    /* options: list[str] = [] */
    var options = Array<String>(0, repeat: "")
    match (pyField(root, "options", "options")) {
        case None => ()
        case Some(f) =>
            match (pyStrList(bag, f, 0)) {
                case Some(items) => options = items
                case None => ()
            }
    }
    /* userAnswer: int */
    var userAnswer: Int64 = 0
    match (pyField(root, "userAnswer", "userAnswer")) {
        case None => bag.add(pyMissing(["body", "userAnswer"], parentRaw))
        case Some(f) =>
            match (pyInt(bag, f, None, None)) {
                case Some(n) => userAnswer = n
                case None => ()
            }
    }
    /* correctAnswer: int */
    var correctAnswer: Int64 = 0
    match (pyField(root, "correctAnswer", "correctAnswer")) {
        case None => bag.add(pyMissing(["body", "correctAnswer"], parentRaw))
        case Some(f) =>
            match (pyInt(bag, f, None, None)) {
                case Some(n) => correctAnswer = n
                case None => ()
            }
    }
    /* explanation: str = "" */
    var explanation = ""
    match (pyField(root, "explanation", "explanation")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 0)) {
                case Some(s) => explanation = s
                case None => ()
            }
    }
    /* difficulty: str = "medium" */
    var difficulty = "medium"
    match (pyField(root, "difficulty", "difficulty")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 0)) {
                case Some(s) => difficulty = s
                case None => ()
            }
    }
    /* kpId: str | None */
    var kpId: ?String = None
    match (pyFieldOpt(root, "kpId", "kpId")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 0)) {
                case Some(s) => kpId = Some(s)
                case None => ()
            }
    }
    /* knowledgeCategoryName: str | None */
    var knowledgeCategoryName: ?String = None
    match (pyFieldOpt(root, "knowledgeCategoryName", "knowledgeCategoryName")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 0)) {
                case Some(s) => knowledgeCategoryName = Some(s)
                case None => ()
            }
    }

    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(AddToWrongBookReq(resourceId, questionId, stem, options,
                                  userAnswer, correctAnswer, explanation, difficulty,
                                  kpId, knowledgeCategoryName))
}

/* WrongAnswerReviewRequest (models.py:398): answer: int = Field(ge=0, le=25). */
func parseReviewAnswer(ctx: HttpContext, root: JsonObject): ?Int64 {
    let bag = PyBag()
    let parentRaw = jsonObjectToRaw(root)
    var answer: ?Int64 = None
    match (pyField(root, "answer", "answer")) {
        case None => bag.add(pyMissing(["body", "answer"], parentRaw))
        case Some(f) => answer = pyInt(bag, f, Some(0), Some(25))
    }
    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return answer
}

/*
 * WrongAnswerUpdateRequest (models.py:386). Every field is `T | None`, so an
 * explicit null is "not provided" (measured 200 for {"streak": null}).
 * Declaration order, and therefore multi-error order (measured
 * {"streak":-1,"last_pick":-2} -> two greater_than_equal items):
 *   review_status, mastered, streak, last_pick,
 *   knowledge_category_id, knowledge_category_name
 *
 * last_pick has no validation_alias, so Python ignores "lastPick"
 * (extra default ignore, measured 200 for {"lastPick": -2}); only the
 * snake_case key is bound.
 *
 * hasKnowledge tracks exclude_unset (key presence, even when the value is
 * null), which is separate from validation: pyFieldOpt treats null as absent
 * for constraint checking, while jsonHas drives the store's knowledge branch.
 */
func parseWrongUpdate(ctx: HttpContext, root: JsonObject): ?WrongUpdate {
    let bag = PyBag()

    /* review_status: Literal[...] | None */
    var hasReviewStatus = false
    var reviewStatus = "unreviewed"
    match (pyFieldOpt(root, "review_status", "reviewStatus")) {
        case None => ()
        case Some(f) =>
            match (pyLiteralField(bag, f, ["unreviewed", "reviewing", "mastered"])) {
                case Some(s) =>
                    hasReviewStatus = true
                    reviewStatus = s
                case None => ()
            }
    }
    /* mastered: bool | None */
    var hasMastered = false
    var mastered = false
    match (pyFieldOpt(root, "mastered", "mastered")) {
        case None => ()
        case Some(f) =>
            match (pyBoolField(bag, f)) {
                case Some(b) =>
                    hasMastered = true
                    mastered = b
                case None => ()
            }
    }
    /* streak: int | None = Field(ge=0) */
    var hasStreak = false
    var streak: Int64 = 0
    match (pyFieldOpt(root, "streak", "streak")) {
        case None => ()
        case Some(f) =>
            match (pyInt(bag, f, Some(0), None)) {
                case Some(n) =>
                    hasStreak = true
                    streak = n
                case None => ()
            }
    }
    /* last_pick: int | None = Field(ge=-1) */
    var hasLastPick = false
    var lastPick: Int64 = 0
    match (pyFieldOpt(root, "last_pick", "last_pick")) {
        case None => ()
        case Some(f) =>
            match (pyInt(bag, f, Some(-1), None)) {
                case Some(n) =>
                    hasLastPick = true
                    lastPick = n
                case None => ()
            }
    }
    /* knowledge_category_id presence (even null) enables the knowledge branch. */
    let hasKnowledge = jsonHas(root, "knowledge_category_id") || jsonHas(root, "knowledgeCategoryId")
    var knowledgeId: ?Int64 = None
    var knowledgeName: ?String = None
    if (hasKnowledge) {
        match (pyFieldOpt(root, "knowledge_category_id", "knowledgeCategoryId")) {
            case None => ()
            case Some(f) =>
                match (pyInt(bag, f, Some(1), None)) {
                    case Some(n) => knowledgeId = Some(n)
                    case None => ()
                }
        }
        match (pyFieldOpt(root, "knowledge_category_name", "knowledgeCategoryName")) {
            case None => ()
            case Some(f) =>
                match (pyStr(bag, f, 0, 160)) {
                    case Some(s) => knowledgeName = Some(s)
                    case None => ()
                }
        }
    } else {
        /* Name alone is ignored by Python exclude_unset (id key absent). Still validate its type/length. */
        match (pyFieldOpt(root, "knowledge_category_name", "knowledgeCategoryName")) {
            case None => ()
            case Some(f) => pyDrop(pyStr(bag, f, 0, 160))
        }
    }

    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(WrongUpdate(hasReviewStatus, reviewStatus, hasMastered, mastered,
                            hasStreak, streak, hasLastPick, lastPick,
                            hasKnowledge, knowledgeId, knowledgeName))
}
