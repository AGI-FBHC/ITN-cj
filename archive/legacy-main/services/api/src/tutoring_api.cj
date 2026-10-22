package itn_spire

import std.core.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * HTTP handlers for the pure-rule tutoring module (five endpoints).
 *
 * Mirrors src/agents/app/routers/public.py:
 *   GET  /v1/tutoring/scripts/{learner_code}
 *   POST /v1/tutoring/sessions                      -> 201
 *   GET  /v1/tutoring/sessions/{session_id}
 *   POST /v1/tutoring/sessions/{session_id}/answer
 *   POST /v1/tutoring/sessions/{session_id}/complete
 *
 * Error envelope is NOT uniform on purpose:
 *   route-level 404s keep the literal detail
 *     ("Tutoring script not found" / "Tutoring session not found")
 *   service KeyError  -> 404 {"detail":"'the message'"}   (str(KeyError) quotes)
 *   service ValueError-> 422 {"detail":"the message"}     (no quotes)
 *   request bodies    -> 422 {"code":"VALIDATION_FAILED","details":[...]}
 */

public func registerTutoringRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/tutoring/scripts/{learner_code}") {
        ctx => handleGetTutoringScript(ctx, cfg)
    }
    app.mapPost("v1/tutoring/sessions") {
        ctx => handleCreateTutoringSession(ctx, cfg)
    }
    app.mapGet("v1/tutoring/sessions/{session_id}") {
        ctx => handleGetTutoringSession(ctx, cfg)
    }
    app.mapPost("v1/tutoring/sessions/{session_id}/answer") {
        ctx => handleAnswerTutoringSession(ctx, cfg)
    }
    app.mapPost("v1/tutoring/sessions/{session_id}/complete") {
        ctx => handleCompleteTutoringSession(ctx, cfg)
    }
}

/* -------- GET /v1/tutoring/scripts/{learner_code} -------- */

/*
 * get_script is called WITHOUT user_id here (public.py:3641), so a
 * `resource:{uuid}` code never resolves on this route — it falls through to
 * the static-file lookup and 404s. Dynamic quiz scripts only appear through
 * POST /tutoring/sessions.
 */
func handleGetTutoringScript(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(_) =>
            var code = ""
            match (routeParam(ctx.request, "learner_code")) {
                case Some(c) => code = c
                case None => ()
            }
            if (storageUnavailable(cfg)) {
                writeDetail(ctx.response, 503, "Tutoring storage is not configured")
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        let svc = TutoringService(conn)
                        match (svc.getScript(code, None)) {
                            case None =>
                                conn.close()
                                writeDetail(ctx.response, 404, "Tutoring script not found")
                            case Some(script) =>
                                conn.close()
                                writeJson(ctx.response, 200, jsonObjectToRaw(script))
                        }
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "getTutoringScript: " + e.message)
                    }
            }
    }
}

/* -------- POST /v1/tutoring/sessions -------- */

func handleCreateTutoringSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (readJsonObjectBody(ctx)) {
                case None => return
                case Some(root) =>
                    match (parseTutoringSessionCreate(ctx, root)) {
                        case None => return
                        case Some(req) =>
                            if (storageUnavailable(cfg)) {
                                writeDetail(ctx.response, 503, "Tutoring storage is not configured")
                                return
                            }
                            match (openDb(cfg)) {
                                case None =>
                                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                case Some(conn) =>
                                    try {
                                        let svc = TutoringService(conn)
                                        let outcome = svc.createSession(userId, req.learnerCode,
                                                                        req.resourceId)
                                        conn.close()
                                        writeTutoringOutcome(ctx.response, outcome, 201)
                                    } catch (e: Exception) {
                                        conn.close()
                                        writeInternalDebug(ctx.response, "createTutoringSession: " + e.message)
                                    }
                            }
                    }
            }
    }
}

/* -------- GET /v1/tutoring/sessions/{session_id} -------- */

func handleGetTutoringSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parsePathUuidValidated(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Tutoring storage is not configured")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let svc = TutoringService(conn)
                                match (svc.getSession(userId, sessionId)) {
                                    case None =>
                                        conn.close()
                                        writeDetail(ctx.response, 404, "Tutoring session not found")
                                    case Some(raw) =>
                                        conn.close()
                                        writeJson(ctx.response, 200, raw)
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "getTutoringSession: " + e.message)
                            }
                    }
            }
    }
}

/* -------- POST /v1/tutoring/sessions/{session_id}/answer -------- */

func handleAnswerTutoringSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parsePathUuidValidated(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    match (readJsonObjectBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (parseTutoringAnswer(ctx, root)) {
                                case None => return
                                case Some(req) =>
                                    if (storageUnavailable(cfg)) {
                                        writeDetail(ctx.response, 503, "Tutoring storage is not configured")
                                        return
                                    }
                                    match (openDb(cfg)) {
                                        case None =>
                                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                        case Some(conn) =>
                                            try {
                                                let svc = TutoringService(conn)
                                                let outcome = svc.answer(userId, sessionId,
                                                                         req.optionIndex,
                                                                         req.optionLabel,
                                                                         req.freeText)
                                                conn.close()
                                                writeTutoringOutcome(ctx.response, outcome, 200)
                                            } catch (e: Exception) {
                                                conn.close()
                                                writeInternalDebug(ctx.response, "answerTutoringSession: " + e.message)
                                            }
                                    }
                            }
                    }
            }
    }
}

/* -------- POST /v1/tutoring/sessions/{session_id}/complete -------- */

/* No request body on this route (public.py:3728) — do not read one. */
func handleCompleteTutoringSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parsePathUuidValidated(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Tutoring storage is not configured")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let svc = TutoringService(conn)
                                let outcome = svc.complete(userId, sessionId)
                                conn.close()
                                writeTutoringOutcome(ctx.response, outcome, 200)
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "completeTutoringSession: " + e.message)
                            }
                    }
            }
    }
}

/* -------- service outcome -> HTTP -------- */

/*
 * NotFound carries a KeyError-style message: Python `detail=str(exc)` on
 * KeyError quotes the argument, so the body is `"'session not found'"`.
 * Invalid carries a ValueError-style message and is emitted unquoted.
 */
func writeTutoringOutcome(response: HttpResponse, outcome: TutoringOutcome,
                          okStatus: UInt16): Unit {
    match (outcome) {
        case TutoringOutcome.Done(raw) => writeJson(response, okStatus, raw)
        case TutoringOutcome.NotFound(msg) =>
            writeDetail(response, 404, "'" + msg + "'")
        case TutoringOutcome.Invalid(msg) =>
            writeDetail(response, 422, msg)
    }
}

/* -------- request bodies -------- */

struct TutoringSessionCreate {
    let learnerCode: ?String
    let resourceId: ?Array<Byte>

    init(learnerCode: ?String, resourceId: ?Array<Byte>) {
        this.learnerCode = learnerCode
        this.resourceId = resourceId
    }
}

struct TutoringAnswerReq {
    let optionIndex: ?Int64
    let optionLabel: ?String
    let freeText: ?String

    init(optionIndex: ?Int64, optionLabel: ?String, freeText: ?String) {
        this.optionIndex = optionIndex
        this.optionLabel = optionLabel
        this.freeText = freeText
    }
}

/*
 * TutoringSessionCreateRequest (models.py:428). Declaration order is
 * validation-collection order. `title` is accepted and validated but never
 * passed to create_session — the service ignores it.
 */
func parseTutoringSessionCreate(ctx: HttpContext, root: JsonObject): ?TutoringSessionCreate {
    let bag = PyBag()

    var learnerCode: ?String = None
    /* learner_code: str | None = Field(min_length=1, max_length=64) */
    match (pyFieldOpt(root, "learner_code", "learnerCode")) {
        case None => ()
        case Some(f) => learnerCode = pyStr(bag, f, 1, 64)
    }
    var resourceId: ?Array<Byte> = None
    /* resource_id: UUID | None */
    match (pyFieldOpt(root, "resource_id", "resourceId")) {
        case None => ()
        case Some(f) => resourceId = pyUuidField(bag, f)
    }
    /* title: str | None = Field(max_length=255) — no alias, unused downstream */
    match (pyFieldOpt(root, "title", "title")) {
        case None => ()
        case Some(f) => pyDrop(pyStr(bag, f, 0, 255))
    }

    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(TutoringSessionCreate(learnerCode, resourceId))
}

/*
 * TutoringAnswerRequest (models.py:438). Declaration order is validation
 * collection order. All three are Optional; the service uses the first one
 * present in if/elif/elif order.
 */
func parseTutoringAnswer(ctx: HttpContext, root: JsonObject): ?TutoringAnswerReq {
    let bag = PyBag()

    var optionIndex: ?Int64 = None
    /* option_index: int | None = Field(ge=0) */
    match (pyFieldOpt(root, "option_index", "optionIndex")) {
        case None => ()
        case Some(f) => optionIndex = pyInt(bag, f, Some(0), None)
    }
    var optionLabel: ?String = None
    /* option_label: str | None = Field(max_length=500) */
    match (pyFieldOpt(root, "option_label", "optionLabel")) {
        case None => ()
        case Some(f) => optionLabel = pyStr(bag, f, 0, 500)
    }
    var freeText: ?String = None
    /* free_text: str | None = Field(max_length=4000) */
    match (pyFieldOpt(root, "free_text", "freeText")) {
        case None => ()
        case Some(f) => freeText = pyStr(bag, f, 0, 4000)
    }

    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(TutoringAnswerReq(optionIndex, optionLabel, freeText))
}
