package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * HTTP handlers for 「我的学习 · 课程」 read + metadata write-back.
 * Path/method/status/body contracts mirror
 * src/agents/app/routers/public.py:4342-4447 so the old frontend can point
 * here unchanged.
 *
 * In scope:
 *   GET    /v1/courses
 *   GET    /v1/courses/{course_id}
 *   PUT    /v1/courses/{course_id}
 *   PUT    /v1/courses/{course_id}/chapters/{chapter_id}
 *   DELETE /v1/courses/{course_id}
 *   GET    /v1/course-progress?learnerId=
 *
 * Phase 2 (still Python — needs the LLM task queue):
 *   POST /v1/courses, /regenerate, /retry,
 *   POST /v1/courses/{id}/chapters/{id}/resources/{type}/retry
 */
public func registerCourseRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/course-progress") {
        ctx => handleCourseProgress(ctx, cfg)
    }
    app.mapGet("v1/courses") {
        ctx => handleListCourses(ctx, cfg)
    }
    app.mapGet("v1/courses/{course_id}") {
        ctx => handleGetCourse(ctx, cfg)
    }
    app.mapPut("v1/courses/{course_id}") {
        ctx => handleUpdateCourseMeta(ctx, cfg)
    }
    app.mapPut("v1/courses/{course_id}/chapters/{chapter_id}") {
        ctx => handleUpdateChapterMeta(ctx, cfg)
    }
    app.mapDelete("v1/courses/{course_id}") {
        ctx => handleDeleteCourse(ctx, cfg)
    }
}

/*
 * Optional learnerId query param (Query(default=None, alias="learnerId")).
 * Returns false when a uuid_parsing 422 was already written. Measured:
 * "zz" and "" both reject; "" is invalid length, not "absent".
 */
func checkLearnerIdQuery(ctx: HttpContext): Bool {
    match (queryParam(ctx.request, "learnerId")) {
        case None => return true
        case Some(raw) =>
            match (uuidParse(raw)) {
                case Some(_) => return true
                case None =>
                    match (uuidParseError(raw)) {
                        case Some(err) =>
                            writeValidation422(ctx.response, ["query", "learnerId"], "uuid_parsing",
                                               "Input should be a valid UUID, " + err,
                                               jsonQuote(raw),
                                               Some("{\"error\":" + jsonQuote(err) + "}"))
                        case None =>
                            writeValidation422(ctx.response, ["query", "learnerId"], "uuid_parsing",
                                               "Input should be a valid UUID",
                                               jsonQuote(raw),
                                               Some("{\"error\":\"Invalid UUID\"}"))
                    }
                    return false
            }
    }
}

/* GET /course-progress (public.py:4330). No course → {"total":0,"completed":0,"percent":0}. */
func handleCourseProgress(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            if (!checkLearnerIdQuery(ctx)) {
                return
            }
            var learnerId: ?Array<Byte> = None
            match (queryParam(ctx.request, "learnerId")) {
                case Some(t) => learnerId = uuidParse(t)
                case None => ()
            }
            if (storageUnavailable(cfg)) {
                writeDetail(ctx.response, 503, "Course storage is unavailable")
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        let store = CoursesStore(conn)
                        match (store.progress(userId, learnerId)) {
                            case None =>
                                conn.close()
                                writeJson(ctx.response, 200, "{\"total\":0,\"completed\":0,\"percent\":0}")
                            case Some(raw) =>
                                conn.close()
                                writeJson(ctx.response, 200, raw)
                        }
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalError(ctx.response)
                    }
            }
    }
}

/* -------- read -------- */

func handleListCourses(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            /* FastAPI: learner_id: UUID | None = Query(default=None, alias="learnerId") */
            if (!checkLearnerIdQuery(ctx)) {
                return
            }
            var learnerId: ?Array<Byte> = None
            match (queryParam(ctx.request, "learnerId")) {
                case Some(t) => learnerId = uuidParse(t)
                case None => ()
            }
            if (storageUnavailable(cfg)) {
                writeDetail(ctx.response, 503, "Course storage is unavailable")
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        let store = CoursesStore(conn)
                        let items = store.list(userId, learnerId)
                        let arr = JsonArrWriter()
                        for (raw in items) {
                            arr.addRaw(enrichCoursePpt(raw, userId, conn))
                        }
                        conn.close()
                        let obj = JsonWriter()
                        obj.putRaw("courses", arr.toJson())
                        writeJson(ctx.response, 200, obj.toJson())
                    } catch (e: Exception) {
                        writeInternalError(ctx.response)
                    }
            }
    }
}

func handleGetCourse(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "course_id")) {
                case None => return
                case Some(courseId) =>
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalError(ctx.response)
                        case Some(conn) =>
                            try {
                                let store = CoursesStore(conn)
                                match (store.get(userId, courseId)) {
                                    case None =>
                                        conn.close()
                                        writeDetail(ctx.response, 404, "Course not found")
                                    case Some(raw) =>
                                        let enriched = enrichCoursePpt(raw, userId, conn)
                                        conn.close()
                                        writeJson(ctx.response, 200, enriched)
                                }
                            } catch (e: Exception) {
                                writeInternalError(ctx.response)
                            }
                    }
            }
    }
}

/* -------- metadata write-back -------- */

func handleUpdateCourseMeta(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "course_id")) {
                case None => return
                case Some(courseId) =>
                    match (readJsonObjectBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (parseCourseUpdate(ctx, root)) {
                                case None => return
                                case Some(patch) =>
                                    match (openDb(cfg)) {
                                        case None =>
                                            writeInternalError(ctx.response)
                                        case Some(conn) =>
                                            try {
                                                let store = CoursesStore(conn)
                                                match (store.updateCourseMeta(userId, courseId,
                                                    patch.title, patch.description)) {
                                                    case None =>
                                                        conn.close()
                                                        writeDetail(ctx.response, 404, "Course not found")
                                                    case Some(raw) =>
                                                        let enriched = enrichCoursePpt(raw, userId, conn)
                                                        conn.close()
                                                        writeJson(ctx.response, 200, enriched)
                                                }
                                            } catch (e: Exception) {
                                                writeInternalError(ctx.response)
                                            }
                                    }
                            }
                    }
            }
    }
}

func handleUpdateChapterMeta(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "course_id")) {
                case None => return
                case Some(courseId) =>
                    match (parseRouteUuid(ctx, "chapter_id")) {
                        case None => return
                        case Some(chapterId) =>
                            match (readJsonObjectBody(ctx)) {
                                case None => return
                                case Some(root) =>
                                    match (parseChapterUpdate(ctx, root)) {
                                        case None => return
                                        case Some(patch) =>
                                            match (openDb(cfg)) {
                                                case None =>
                                                    writeInternalError(ctx.response)
                                                case Some(conn) =>
                                                    try {
                                                        let store = CoursesStore(conn)
                                                        match (store.updateChapterMeta(userId, courseId,
                                                            chapterId, patch.title, patch.summary)) {
                                                            case None =>
                                                                conn.close()
                                                                writeDetail(ctx.response, 404,
                                                                    "Course chapter not found")
                                                            case Some(raw) =>
                                                                let enriched = enrichCoursePpt(raw, userId, conn)
                                                                conn.close()
                                                                writeJson(ctx.response, 200, enriched)
                                                        }
                                                    } catch (e: Exception) {
                                                        writeInternalError(ctx.response)
                                                    }
                                            }
                                    }
                            }
                    }
            }
    }
}

func handleDeleteCourse(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "course_id")) {
                case None => return
                case Some(courseId) =>
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalError(ctx.response)
                        case Some(conn) =>
                            try {
                                let store = CoursesStore(conn)
                                let deleted = store.delete(userId, courseId)
                                conn.close()
                                if (deleted) {
                                    ctx.response.statusCode = 204
                                } else {
                                    writeDetail(ctx.response, 404, "Course not found")
                                }
                            } catch (e: Exception) {
                                writeInternalError(ctx.response)
                            }
                    }
            }
    }
}

/* -------- request bodies -------- */

struct CourseMetaPatch {
    let title: ?String
    let description: ?String

    init(title: ?String, description: ?String) {
        this.title = title
        this.description = description
    }
}

struct ChapterMetaPatch {
    let title: ?String
    let summary: ?String

    init(title: ?String, summary: ?String) {
        this.title = title
        this.summary = summary
    }
}

/*
 * CourseUpdateRequest (models.py:346): extra="ignore"; title 1-160 then a
 * field_validator that strips and raises PydanticCustomError("blank_title")
 * when the stripped value is empty; description ≤2000.
 *
 * Order matters and is measured: constraints run BEFORE the validator, so
 * "" is string_too_short while "   " is blank_title. Absent or explicit null
 * leaves the field unchanged.
 */
func parseCourseUpdate(ctx: HttpContext, root: JsonObject): ?CourseMetaPatch {
    let bag = PyBag()
    var title: ?String = None
    match (pyFieldOpt(root, "title", "title")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 1, 160)) {
                case None => ()
                case Some(raw) =>
                    let stripped = raw.trimAscii()
                    if (stripped.isEmpty()) {
                        bag.add(pyBlankTitle(["body", f.key], f.raw))
                    } else {
                        title = Some(stripped)
                    }
            }
    }
    var description: ?String = None
    match (pyFieldOpt(root, "description", "description")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 2000)) {
                case Some(d) => description = Some(d)
                case None => ()
            }
    }
    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(CourseMetaPatch(title, description))
}

/* CourseChapterUpdateRequest (models.py:362): title 1-200 stripped + blank_title; summary ≤1000. */
func parseChapterUpdate(ctx: HttpContext, root: JsonObject): ?ChapterMetaPatch {
    let bag = PyBag()
    var title: ?String = None
    match (pyFieldOpt(root, "title", "title")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 1, 200)) {
                case None => ()
                case Some(raw) =>
                    let stripped = raw.trimAscii()
                    if (stripped.isEmpty()) {
                        bag.add(pyBlankTitle(["body", f.key], f.raw))
                    } else {
                        title = Some(stripped)
                    }
            }
    }
    var summary: ?String = None
    match (pyFieldOpt(root, "summary", "summary")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 1000)) {
                case Some(s) => summary = Some(s)
                case None => ()
            }
    }
    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(ChapterMetaPatch(title, summary))
}
