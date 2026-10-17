package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * HTTP handlers for the presentation read-side + learning-state write-back.
 *
 * Mirrors src/agents/app/routers/public.py:
 *   GET    /v1/presentations
 *   GET    /v1/presentations/{task_id}
 *   GET    /v1/presentations/{task_id}/download   (copies the live decorator bug)
 *   POST   /v1/presentations/{task_id}/complete
 *   POST   /v1/presentations/{task_id}/progress
 *   DELETE /v1/presentations/{task_id}
 *   POST   /v1/presentations/batch-delete
 *   GET    /v1/presentations/{task_id}/slides     (data layer only)
 *   GET    /v1/presentations/{task_id}/slides/{slide_index}
 *
 * Generation, chat, TTS and PDF→PNG rendering stay in the Python service.
 */
public func registerPresentationRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/presentations") {
        ctx => handleListPresentations(ctx, cfg)
    }
    app.mapPost("v1/presentations/batch-delete") {
        ctx => handleBatchDeletePresentations(ctx, cfg)
    }
    app.mapGet("v1/presentations/{task_id}") {
        ctx => handleGetPresentation(ctx, cfg)
    }
    /* public.py:1479-1486 — GET .../download is stacked on complete_presentation.
     * download_presentation below it has no decorator and is dead code. Keep the
     * live behaviour (mark learned + {"learned":true}) rather than the intent. */
    app.mapGet("v1/presentations/{task_id}/download") {
        ctx => handleCompletePresentation(ctx, cfg)
    }
    app.mapPost("v1/presentations/{task_id}/complete") {
        ctx => handleCompletePresentation(ctx, cfg)
    }
    app.mapPost("v1/presentations/{task_id}/progress") {
        ctx => handleUpdatePresentationProgress(ctx, cfg)
    }
    app.mapGet("v1/presentations/{task_id}/slides") {
        ctx => handleGetSlideshowSlides(ctx, cfg)
    }
    app.mapGet("v1/presentations/{task_id}/slides/{slide_index}") {
        ctx => handleGetSlideImage(ctx, cfg)
    }
    app.mapDelete("v1/presentations/{task_id}") {
        ctx => handleDeletePresentation(ctx, cfg)
    }
}

/* -------- path parsing -------- */

/*
 * FastAPI path-UUID 422. The msg embeds the uuid crate's own diagnostic, so
 * uuidParseError rebuilds it from the offending text.
 */
func parsePathUuidFastApi(ctx: HttpContext, name: String): ?Array<Byte> {
    var text = ""
    match (routeParam(ctx.request, name)) {
        case Some(t) => text = t
        case None => ()
    }
    match (uuidParse(text)) {
        case Some(bytes) => return Some(bytes)
        case None =>
            match (uuidParseError(text)) {
                case Some(detail) =>
                    writeFastApi422(ctx.response, ["path", name], "uuid_parsing",
                                    "Input should be a valid UUID, " + detail,
                                    jsonQuote(text),
                                    Some("{\"error\":" + jsonQuote(detail) + "}"))
                case None =>
                    writeFastApi422(ctx.response, ["path", name], "uuid_parsing",
                                    "Input should be a valid UUID",
                                    jsonQuote(text),
                                    Some("{\"error\":\"Invalid UUID\"}"))
            }
            return None
    }
}

func parsePathIntFastApi(ctx: HttpContext, name: String): ?Int64 {
    var text = ""
    match (routeParam(ctx.request, name)) {
        case Some(t) => text = t
        case None => ()
    }
    match (pythonIntText(text)) {
        case Some(v) => return Some(v)
        case None =>
            writePyType422(ctx.response, ["path", name], "int_parsing",
                           "Input should be a valid integer, unable to parse string as an integer",
                           jsonQuote(text))
            return None
    }
}

enum BoolParamResult {
    Missing | Value(Bool) | Bad(String)
}

func queryBoolParam(request: HttpRequest, name: String): BoolParamResult {
    match (queryParam(request, name)) {
        case None => return BoolParamResult.Missing
        case Some(raw) =>
            match (parsePyBoolText(raw)) {
                case Some(b) => return BoolParamResult.Value(b)
                case None => return BoolParamResult.Bad(raw)
            }
    }
}

/* -------- GET /v1/presentations -------- */

/*
 * public.py:1450 — summary=True, limit=20, exclude_course=False.
 * limit is clamped to 1..1000 (no 422 for range); a non-integer limit is a
 * FastAPI 422. Resource-task limit is the opposite (see resource_tasks_api.cj).
 */
func handleListPresentations(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            var summary = true
            match (queryBoolParam(ctx.request, "summary")) {
                case BoolParamResult.Missing => ()
                case BoolParamResult.Value(v) => summary = v
                case BoolParamResult.Bad(raw) =>
                    writePyType422(ctx.response, ["query", "summary"], "bool_parsing",
                                   "Input should be a valid boolean, unable to interpret input",
                                   jsonQuote(raw))
                    return
            }
            var limit: Int64 = 20
            match (queryParam(ctx.request, "limit")) {
                case None => ()
                case Some(raw) =>
                    match (pythonIntText(raw)) {
                        case None =>
                            writePyType422(ctx.response, ["query", "limit"], "int_parsing",
                                           "Input should be a valid integer, unable to parse string as an integer",
                                           jsonQuote(raw))
                            return
                        case Some(v) => limit = v
                    }
            }
            if (limit < 1) {
                limit = 1
            }
            if (limit > 1000) {
                limit = 1000
            }
            var excludeCourse = false
            match (queryBoolParam(ctx.request, "exclude_course")) {
                case BoolParamResult.Missing => ()
                case BoolParamResult.Value(v) => excludeCourse = v
                case BoolParamResult.Bad(raw) =>
                    writePyType422(ctx.response, ["query", "exclude_course"], "bool_parsing",
                                   "Input should be a valid boolean, unable to interpret input",
                                   jsonQuote(raw))
                    return
            }
            if (storageUnavailable(cfg)) {
                writeDetail(ctx.response, 503, "Presentation storage is not configured")
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        let store = PresentationsStore(conn)
                        let items = store.list(userId, limit, summary, excludeCourse)
                        conn.close()
                        let arr = JsonArrWriter()
                        for (item in items) {
                            arr.addRaw(item)
                        }
                        let obj = JsonWriter()
                        obj.putRaw("tasks", arr.toJson())
                        writeJsonEtag(ctx.response, ctx.request, obj.toJson(), "ppt")
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "listPresentations: " + e.message)
                    }
            }
    }
}

/* -------- GET /v1/presentations/{task_id} -------- */

func handleGetPresentation(ctx: HttpContext, cfg: AppConfig): Unit {
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
                                let store = PresentationsStore(conn)
                                /* store.get already back-fills executionSummary. */
                                match (store.get(userId, taskId)) {
                                    case None =>
                                        conn.close()
                                        writeDetail(ctx.response, 404, "Presentation task not found")
                                    case Some(raw) =>
                                        conn.close()
                                        writeJson(ctx.response, 200, raw)
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "getPresentation: " + e.message)
                            }
                    }
            }
    }
}

/* -------- GET/POST .../download + .../complete -------- */

/*
 * public.py:1479-1486. Both HTTP methods land on complete_presentation:
 * mark_learned, then {"learned": true}, or 404 "Completed presentation task not
 * found". The real FileResponse download below it is unreachable dead code.
 */
func handleCompletePresentation(ctx: HttpContext, cfg: AppConfig): Unit {
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
                                let store = PresentationsStore(conn)
                                let learned = store.markLearned(userId, taskId)
                                conn.close()
                                if (!learned) {
                                    writeDetail(ctx.response, 404, "Completed presentation task not found")
                                } else {
                                    writeJson(ctx.response, 200, "{\"learned\":true}")
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "completePresentation: " + e.message)
                            }
                    }
            }
    }
}

/* -------- POST /v1/presentations/{task_id}/progress -------- */

/*
 * PresentationProgressRequest (domain/models.py:146-152, extra="ignore"):
 *   page_index / pageIndex : int   | None, ge=0
 *   page_count  / pageCount  : int   | None, ge=1
 *   learned                 : bool  | None
 *   mastery                 : float | None, ge=0, le=1
 * Body {} is valid; a missing body is a `missing` 422.
 */
func handleUpdatePresentationProgress(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parsePathUuidFastApi(ctx, "task_id")) {
                case None => return
                case Some(taskId) =>
                    match (parseProgressBody(ctx)) {
                        case None => return
                        case Some(req) =>
                            if (storageUnavailable(cfg)) {
                                writeDetail(ctx.response, 503, "Presentation storage is not configured")
                                return
                            }
                            match (openDb(cfg)) {
                                case None =>
                                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                case Some(conn) =>
                                    try {
                                        let store = PresentationsStore(conn)
                                        match (store.updateLearning(userId, taskId, req.pageIndex,
                                                                    req.pageCount, req.learned, req.mastery)) {
                                            case None =>
                                                conn.close()
                                                writeDetail(ctx.response, 404,
                                                            "Presentation task not found or not completed")
                                            case Some(raw) =>
                                                conn.close()
                                                writeJson(ctx.response, 200, raw)
                                        }
                                    } catch (e: Exception) {
                                        conn.close()
                                        writeInternalDebug(ctx.response, "updateProgress: " + e.message)
                                    }
                            }
                    }
            }
    }
}

struct ProgressRequest {
    let pageIndex: ?Int64
    let pageCount: ?Int64
    let learned: ?Bool
    let mastery: ?Float64
    init(pageIndex: ?Int64, pageCount: ?Int64, learned: ?Bool, mastery: ?Float64) {
        this.pageIndex = pageIndex
        this.pageCount = pageCount
        this.learned = learned
        this.mastery = mastery
    }
}

func parseProgressBody(ctx: HttpContext): ?ProgressRequest {
    let body = readBodyText(ctx.request)
    /*
     * The order below is fastapi/routing.py's own, not an arbitrary choice:
     *
     *   1. no bytes at all            -> body stays None -> pydantic `missing`
     *   2. request.json() raises      -> json_invalid with e.msg / e.pos
     *   3. decoded null               -> body stays None -> pydantic `missing`
     *   4. decoded non-object         -> model_attributes_type, echo the value
     *   5. object                     -> per-field coercion
     *
     * Step 2 used to fall through to step 4 with the raw text as `input`,
     * which is not JSON — the whole 422 body failed to parse. The decoded
     * value, not the source text, is what Python echoes in every other case.
     */
    /*
     * Zero BYTES, not "no visible characters": routing.py branches on
     * `if body_bytes`, so "  " still reaches request.json() and dies as
     * json_invalid["body",2] "Expecting value", while "" alone yields
     * body=None -> pydantic `missing`. A trim made both look like "".
     */
    if (body.size == 0) {
        writeFastApi422(ctx.response, ["body"], "missing", "Field required", "null", None)
        return None
    }
    match (pyJsonDecodeError(body)) {
        case Some(e) =>
            writeJsonInvalid422(ctx.response, e)
            return None
        case None => ()
    }
    match (jsonParse(body)) {
        case None =>
            /*
             * CPython accepted the text but stdx could not build a value
             * (NaN / Infinity / a lone surrogate escape). Python reaches its
             * own crash rendering `nan` into the response; answer with a
             * well-formed 422 rather than an unparseable body.
             */
            writeFastApi422(ctx.response, ["body"], "model_attributes_type",
                            "Input should be a valid dictionary or object to extract fields from",
                            "{}", None)
            return None
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsNull =>
                    writeFastApi422(ctx.response, ["body"], "missing", "Field required", "null", None)
                    return None
                case _ => ()
            }
            if (!isJsObject(v)) {
                writeFastApi422(ctx.response, ["body"], "model_attributes_type",
                                "Input should be a valid dictionary or object to extract fields from",
                                valueToRaw(v), None)
                return None
            }
            let root = v.asObject()
            var pageIndex: ?Int64 = None
            var pageCount: ?Int64 = None
            var learned: ?Bool = None
            var mastery: ?Float64 = None

            match (bodyFieldByAlias(root, "page_index", "pageIndex")) {
                case None => ()
                case Some(field) =>
                    match (coercePyInt(field.value)) {
                        case PInt.Fail(t, m, input) =>
                            writePyType422(ctx.response, ["body", field.key], t, m, input)
                            return None
                        case PInt.Done(n) =>
                            if (n < 0) {
                                writePyConstraint422(ctx.response, ["body", field.key],
                                                     "greater_than_equal",
                                                     "Input should be greater than or equal to 0",
                                                     valueToRaw(field.value), "{\"ge\":0}")
                                return None
                            }
                            pageIndex = Some(n)
                    }
            }
            match (bodyFieldByAlias(root, "page_count", "pageCount")) {
                case None => ()
                case Some(field) =>
                    match (coercePyInt(field.value)) {
                        case PInt.Fail(t, m, input) =>
                            writePyType422(ctx.response, ["body", field.key], t, m, input)
                            return None
                        case PInt.Done(n) =>
                            if (n < 1) {
                                writePyConstraint422(ctx.response, ["body", field.key],
                                                     "greater_than_equal",
                                                     "Input should be greater than or equal to 1",
                                                     valueToRaw(field.value), "{\"ge\":1}")
                                return None
                            }
                            pageCount = Some(n)
                    }
            }
            match (bodyFieldByAlias(root, "learned", "learned")) {
                case None => ()
                case Some(field) =>
                    match (coercePyBool(field.value)) {
                        case PBool.Fail(t, m, input) =>
                            writePyType422(ctx.response, ["body", field.key], t, m, input)
                            return None
                        case PBool.Done(b) => learned = Some(b)
                    }
            }
            match (bodyFieldByAlias(root, "mastery", "mastery")) {
                case None => ()
                case Some(field) =>
                    match (coercePyFloat(field.value)) {
                        case PFloat.Fail(t, m, input) =>
                            writePyType422(ctx.response, ["body", field.key], t, m, input)
                            return None
                        case PFloat.Done(f) =>
                            if (f < 0.0) {
                                writePyConstraint422(ctx.response, ["body", field.key],
                                                     "greater_than_equal",
                                                     "Input should be greater than or equal to 0",
                                                     valueToRaw(field.value), "{\"ge\":0.0}")
                                return None
                            }
                            if (f > 1.0) {
                                writePyConstraint422(ctx.response, ["body", field.key],
                                                     "less_than_equal",
                                                     "Input should be less than or equal to 1",
                                                     valueToRaw(field.value), "{\"le\":1.0}")
                                return None
                            }
                            mastery = Some(f)
                    }
            }
            return Some(ProgressRequest(pageIndex, pageCount, learned, mastery))
    }
}

/* -------- DELETE /v1/presentations/{task_id} -------- */

/*
 * public.py:1500-1517. get → 404; non-terminal status → 409; delete → 404;
 * unlink the PPTX when it resolves under presentation_output_dir; 204 empty.
 * Hard delete with no cascade to presentation_task_user_state.
 */
func handleDeletePresentation(ctx: HttpContext, cfg: AppConfig): Unit {
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
                                let store = PresentationsStore(conn)
                                match (store.getRaw(userId, taskId)) {
                                    case None =>
                                        conn.close()
                                        writeDetail(ctx.response, 404, "Presentation task not found")
                                    case Some(raw) =>
                                        var status = ""
                                        match (jsonParse(raw)) {
                                            case Some(rv) =>
                                                if (isJsObject(rv)) {
                                                    match (jsonGetString(rv.asObject(), "status")) {
                                                        case Some(s) => status = s
                                                        case None => ()
                                                    }
                                                }
                                            case None => ()
                                        }
                                        if (status != "completed" && status != "failed" && status != "cancelled") {
                                            conn.close()
                                            writeDetail(ctx.response, 409,
                                                        "Presentation generation is still in progress")
                                            return
                                        }
                                        match (store.delete(userId, taskId)) {
                                            case None =>
                                                conn.close()
                                                writeDetail(ctx.response, 404, "Presentation task not found")
                                            case Some(outputPath) =>
                                                conn.close()
                                                unlinkPresentationOutput(outputPath)
                                                ctx.response.statusCode = 204
                                        }
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "deletePresentation: " + e.message)
                            }
                    }
            }
    }
}

/* -------- POST /v1/presentations/batch-delete -------- */

/*
 * public.py:1520-1556. Body is a raw dict; keys "taskIds" or "task_ids".
 *
 * Two different 422 shapes live in this one route and must not be unified:
 *   - fastapi/routing.py decodes the JSON and pydantic validates the `dict`
 *     parameter BEFORE the handler exists, so those failures carry the
 *     pydantic array shape (missing / json_invalid / dict_type);
 *   - once inside, HTTPException produces the plain {"detail": "..."} body
 *     ("taskIds must be a non-empty array" and friends).
 *
 * All-or-nothing: missing → 404, active → 409, both carrying the Chinese
 * messages verbatim so the route can discriminate on "仍在进行中". Success
 * echoes the INPUT ids in input order.
 */
func handleBatchDeletePresentations(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            let body = readBodyText(ctx.request)
            /* Zero BYTES only — see parseProgressBody: "  " is json_invalid. */
            if (body.size == 0) {
                writeFastApi422(ctx.response, ["body"], "missing", "Field required", "null", None)
                return
            }
            match (pyJsonDecodeError(body)) {
                case Some(e) =>
                    writeJsonInvalid422(ctx.response, e)
                    return
                case None => ()
            }
            match (jsonParse(body)) {
                case None =>
                    /* Python accepted the text but stdx could not materialise it. */
                    writeFastApi422(ctx.response, ["body"], "dict_type",
                                    "Input should be a valid dictionary", "{}", None)
                    return
                case Some(pv) =>
                    match (pv.kind()) {
                        case JsonKind.JsNull =>
                            writeFastApi422(ctx.response, ["body"], "missing",
                                            "Field required", "null", None)
                            return
                        case _ => ()
                    }
                    if (!isJsObject(pv)) {
                        writeFastApi422(ctx.response, ["body"], "dict_type",
                                        "Input should be a valid dictionary",
                                        valueToRaw(pv), None)
                        return
                    }
                    let payload = pv.asObject()
                    /* Python: payload.get("taskIds") or payload.get("task_ids") or [] */
                    var idsVal: ?JsonValue = None
                    match (payload.get("taskIds")) {
                        case Some(v) =>
                            if (jsonValTruthy(v)) {
                                idsVal = Some(v)
                            }
                        case None => ()
                    }
                    var haveIds = false
                    match (idsVal) {
                        case Some(_) => haveIds = true
                        case None => ()
                    }
                    if (!haveIds) {
                        match (payload.get("task_ids")) {
                            case Some(v) =>
                                if (jsonValTruthy(v)) {
                                    idsVal = Some(v)
                                }
                            case None => ()
                        }
                    }
                    match (idsVal) {
                        case None =>
                            writeDetail(ctx.response, 422, "taskIds must be a non-empty array")
                            return
                        case Some(v) =>
                            if (!isJsArray(v)) {
                                writeDetail(ctx.response, 422, "taskIds must be a non-empty array")
                                return
                            }
                            let idsArr = v.asArray()
                            if (idsArr.size() == 0) {
                                writeDetail(ctx.response, 422, "taskIds must be a non-empty array")
                                return
                            }
                            if (idsArr.size() > 100) {
                                writeDetail(ctx.response, 422, "taskIds cannot contain more than 100 items")
                                return
                            }
                            let taskIds = ArrayList<Array<Byte>>()
                            let echo = ArrayList<String>()
                            var i: Int64 = 0
                            while (i < idsArr.size()) {
                                match (idsArr.get(i)) {
                                    case None =>
                                        writeDetail(ctx.response, 422, "taskIds contains invalid UUIDs")
                                        return
                                    case Some(item) =>
                                        /* Python UUID(str(item)) — str() of any JSON scalar. */
                                        var text = ""
                                        match (item.kind()) {
                                            case JsonKind.JsString => text = item.asString().getValue()
                                            case JsonKind.JsInt => text = item.asInt().getValue().toString()
                                            case JsonKind.JsBool =>
                                                text = if (item.asBool().getValue()) { "True" } else { "False" }
                                            case JsonKind.JsFloat => text = valueToRaw(item)
                                            case _ =>
                                                writeDetail(ctx.response, 422, "taskIds contains invalid UUIDs")
                                                return
                                        }
                                        match (uuidParse(text)) {
                                            case None =>
                                                writeDetail(ctx.response, 422, "taskIds contains invalid UUIDs")
                                                return
                                            case Some(bytes) =>
                                                taskIds.add(bytes)
                                                echo.add(uuidFormat(bytes))
                                        }
                                }
                                i += 1
                            }
                            if (storageUnavailable(cfg)) {
                                writeDetail(ctx.response, 503, "Presentation storage is not configured")
                                return
                            }
                            match (openDb(cfg)) {
                                case None =>
                                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                case Some(conn) =>
                                    try {
                                        let store = PresentationsStore(conn)
                                        match (store.batchDelete(userId, taskIds.toArray())) {
                                            case BatchDeleteOutcome.Err(message) =>
                                                conn.close()
                                                if (message.contains("仍在进行中")) {
                                                    writeDetail(ctx.response, 409, message)
                                                } else {
                                                    writeDetail(ctx.response, 404, message)
                                                }
                                            case BatchDeleteOutcome.Ok(outputs) =>
                                                conn.close()
                                                for (raw in outputs) {
                                                    unlinkPresentationOutput(raw)
                                                }
                                                let del = JsonArrWriter()
                                                for (idText in echo) {
                                                    del.addRaw(jsonQuote(idText))
                                                }
                                                let obj = JsonWriter()
                                                obj.putRaw("deleted", del.toJson())
                                                obj.putInt("count", echo.size)
                                                writeJson(ctx.response, 200, obj.toJson())
                                        }
                                    } catch (e: Exception) {
                                        conn.close()
                                        writeInternalDebug(ctx.response, "batchDeletePresentations: " + e.message)
                                    }
                            }
                    }
            }
    }
}

/* -------- GET /v1/presentations/{task_id}/slides -------- */

/*
 * public.py:1559-1631 without the side effects: no synchronous PDF→PNG render
 * of the first two pages, no background render of the rest, no TTS warm.
 * Metadata (speakerNotes / teachingMoments / audioAvailable) is computed from
 * outline_json plus whatever PNG/wav files already exist on disk.
 */
func handleGetSlideshowSlides(ctx: HttpContext, cfg: AppConfig): Unit {
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
                                let store = PresentationsStore(conn)
                                match (store.getRaw(userId, taskId)) {
                                    case None =>
                                        conn.close()
                                        writeDetail(ctx.response, 404, "Presentation task not found")
                                    case Some(raw) =>
                                        conn.close()
                                        writeSlidesPayload(ctx, taskId, raw)
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "getSlides: " + e.message)
                            }
                    }
            }
    }
}

func writeSlidesPayload(ctx: HttpContext, taskId: Array<Byte>, taskRaw: String): Unit {
    match (jsonParse(taskRaw)) {
        case None =>
            writeInternalError(ctx.response)
        case Some(tv) =>
            if (!isJsObject(tv)) {
                writeInternalError(ctx.response)
                return
            }
            let task = tv.asObject()
            var status = ""
            match (jsonGetString(task, "status")) {
                case Some(s) => status = s
                case None => ()
            }
            if (status != "completed") {
                writeDetail(ctx.response, 409, "Presentation is not completed yet")
                return
            }
            var outputPath = ""
            match (jsonGetString(task, "outputPath")) {
                case Some(p) => outputPath = p
                case None => ()
            }
            let taskIdText = uuidFormat(taskId)
            match (resolvePresentationOutput(taskIdText, outputPath)) {
                case None =>
                    writeDetail(ctx.response, 404, "PPTX file is missing")
                case Some(pptxPath) =>
                    let assetDir = slideshowAssetDir(pptxPath, taskIdText)
                    let slideDir = pathJoin(assetDir, "slides")
                    var outlineSlidesRaw = "[]"
                    match (jsonGetObject(task, "outline")) {
                        case Some(outline) =>
                            match (jsonGetArray(outline, "slides")) {
                                case Some(sarr) => outlineSlidesRaw = jsonArrayToRaw(sarr)
                                case None => ()
                            }
                        case None => ()
                    }
                    let normalizedSlides = ensureTeachingMoments(outlineSlidesRaw)
                    var n: Int64 = 0
                    match (jsonParse(normalizedSlides)) {
                        case Some(sv) =>
                            if (isJsArray(sv)) {
                                n = sv.asArray().size()
                            }
                        case None => ()
                    }
                    if (n <= 0) {
                        n = slideImageCount(slideDir)
                    }
                    let speakerNotes = ArrayList<String>()
                    let teachingMoments = ArrayList<String>()
                    match (jsonParse(normalizedSlides)) {
                        case Some(sv) =>
                            if (isJsArray(sv)) {
                                let sarr = sv.asArray()
                                var i: Int64 = 0
                                while (i < n) {
                                    var note = ""
                                    var momentsRaw = "[]"
                                    if (i < sarr.size()) {
                                        match (sarr.get(i)) {
                                            case Some(item) =>
                                                if (isJsObject(item)) {
                                                    let sobj = item.asObject()
                                                    /* Python str(s.get("speakerNotes","")) turns an
                                                     * explicit null into "None"; Spire keeps "". */
                                                    match (jsonGetString(sobj, "speakerNotes")) {
                                                        case Some(t) => note = t
                                                        case None => ()
                                                    }
                                                    match (sobj.get("teachingMoments")) {
                                                        case Some(mv) =>
                                                            if (isJsArray(mv)) {
                                                                momentsRaw = jsonArrayToRaw(mv.asArray())
                                                            }
                                                        case None => ()
                                                    }
                                                }
                                            case None => ()
                                        }
                                    }
                                    speakerNotes.add(note)
                                    teachingMoments.add(momentsRaw)
                                    i += 1
                                }
                            }
                        case None => ()
                    }
                    while (speakerNotes.size < n) {
                        speakerNotes.add("")
                    }
                    while (teachingMoments.size < n) {
                        teachingMoments.add("[]")
                    }
                    let audioAvailable = ArrayList<String>()
                    var ai: Int64 = 0
                    while (ai < n) {
                        var avail = !pyStrip(speakerNotes[ai]).isEmpty()
                        if (!avail) {
                            avail = audioAvailableAt(assetDir, ai)
                        }
                        audioAvailable.add(if (avail) { "true" } else { "false" })
                        ai += 1
                    }
                    let obj = JsonWriter()
                    obj.putInt("slideCount", n)
                    obj.putStr("imageUrl", "/v1/presentations/" + taskIdText + "/slides/{index}")
                    obj.putStr("audioUrl", "/v1/presentations/" + taskIdText + "/audio/{index}")
                    obj.putRaw("speakerNotes", jsonStringArray(speakerNotes.toArray()))
                    let tm = JsonArrWriter()
                    for (m in teachingMoments) {
                        tm.addRaw(m)
                    }
                    obj.putRaw("teachingMoments", tm.toJson())
                    let aa = JsonArrWriter()
                    for (a in audioAvailable) {
                        aa.addRaw(a)
                    }
                    obj.putRaw("audioAvailable", aa.toJson())
                    writeJson(ctx.response, 200, obj.toJson())
            }
    }
}

/* -------- GET /v1/presentations/{task_id}/slides/{slide_index} -------- */

/*
 * public.py:1634-1672 without the on-demand PDF render. Bounds come from
 * len(outline.slides) only; out-of-range and missing PNG both return 404
 * "Slide image not found" (never 422). PNG filenames are 1-based; the URL is
 * 0-based. Content-Disposition keeps the Python attachment filename.
 */
func handleGetSlideImage(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parsePathUuidFastApi(ctx, "task_id")) {
                case None => return
                case Some(taskId) =>
                    match (parsePathIntFastApi(ctx, "slide_index")) {
                        case None => return
                        case Some(slideIndex) =>
                            if (storageUnavailable(cfg)) {
                                writeDetail(ctx.response, 503, "Presentation storage is not configured")
                                return
                            }
                            match (openDb(cfg)) {
                                case None =>
                                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                case Some(conn) =>
                                    try {
                                        let store = PresentationsStore(conn)
                                        match (store.getRaw(userId, taskId)) {
                                            case None =>
                                                conn.close()
                                                writeDetail(ctx.response, 404, "Presentation task not found")
                                            case Some(raw) =>
                                                conn.close()
                                                writeSlideImage(ctx, taskId, slideIndex, raw)
                                        }
                                    } catch (e: Exception) {
                                        conn.close()
                                        writeInternalDebug(ctx.response, "getSlideImage: " + e.message)
                                    }
                            }
                    }
            }
    }
}

func writeSlideImage(ctx: HttpContext, taskId: Array<Byte>, slideIndex: Int64,
                     taskRaw: String): Unit {
    match (jsonParse(taskRaw)) {
        case None =>
            writeInternalError(ctx.response)
        case Some(tv) =>
            if (!isJsObject(tv)) {
                writeInternalError(ctx.response)
                return
            }
            let task = tv.asObject()
            var status = ""
            match (jsonGetString(task, "status")) {
                case Some(s) => status = s
                case None => ()
            }
            if (status != "completed") {
                writeDetail(ctx.response, 409, "Presentation is not completed yet")
                return
            }
            var outputPath = ""
            match (jsonGetString(task, "outputPath")) {
                case Some(p) => outputPath = p
                case None => ()
            }
            let taskIdText = uuidFormat(taskId)
            match (resolvePresentationOutput(taskIdText, outputPath)) {
                case None =>
                    writeDetail(ctx.response, 404, "PPTX file is missing")
                case Some(pptxPath) =>
                    let slideDir = pathJoin(slideshowAssetDir(pptxPath, taskIdText), "slides")
                    var slideCount: Int64 = 0
                    match (jsonGetObject(task, "outline")) {
                        case Some(outline) =>
                            match (jsonGetArray(outline, "slides")) {
                                case Some(sarr) => slideCount = sarr.size()
                                case None => ()
                            }
                        case None => ()
                    }
                    if (slideIndex < 0 || slideIndex >= slideCount) {
                        writeDetail(ctx.response, 404, "Slide image not found")
                        return
                    }
                    match (slideImageForIndex(slideDir, slideIndex)) {
                        case None =>
                            writeDetail(ctx.response, 404, "Slide image not found")
                        case Some(imagePath) =>
                            match (readWholeFile(imagePath)) {
                                case None =>
                                    writeDetail(ctx.response, 404, "Slide image not found")
                                case Some(bytes) =>
                                    ctx.response.statusCode = 200
                                    ctx.response.contentType = "image/png"
                                    ctx.response.headers.add("Content-Disposition",
                                                             "attachment; filename=\"slide_" +
                                                                 slideIndex.toString() + ".png\"")
                                    ctx.response.write(bytes)
                            }
                    }
            }
    }
}
