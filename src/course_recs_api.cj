package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * GET /v1/course-recommendations — home-dock recent course-resource candidates.
 *
 * Mirrors src/agents/app/routers/public.py:4859-4894
 * list_course_recommendations. Pure read: two SELECTs over
 * generated_learning_resources + presentation_tasks, then a stable sort.
 *
 * Contract notes (from the Python source):
 *   - limit: int = Query(20, ge=1, le=50) — out of range is a 422, not a clamp.
 *   - /v1 face -> bare JSON, requireUser (JWT signature only).
 *   - Q1 requires course_id IS NOT NULL; Q2 requires status='completed'.
 *   - PPT title falls back to "最近的 PPT" when the column is empty.
 *   - Both queries are ORDER BY updated_at DESC LIMIT n; Python then
 *     concatenates Q1 rows then Q2 rows and does a STABLE sort by updatedAt
 *     descending, so equal timestamps keep Q1 before Q2. Both sides are
 *     already descending, so a stable two-way merge reproduces it exactly.
 *   - updatedAt is Python `datetime.isoformat()` on a naive datetime ->
 *     isoNaiveFromDb (microseconds only when non-zero, no tz suffix).
 */
public func registerCourseRecRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/course-recommendations") {
        ctx => handleCourseRecommendations(ctx, cfg)
    }
}

/* One candidate row plus its sort key, kept together for the merge. */
private struct RecItem {
    public let json: String
    public let updatedAt: String
    public init(json: String, updatedAt: String) {
        this.json = json
        this.updatedAt = updatedAt
    }
}

func handleCourseRecommendations(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (recLimit(ctx)) {
                case None => return
                case Some(limit) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Learning resource storage is unavailable")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                writeRecResponse(ctx, conn, userId, limit)
                                conn.close()
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "courseRecommendations: " + e.message)
                            }
                    }
            }
    }
}

/* limit: int = Query(20, ge=1, le=50). Absent -> 20; out of range -> 422. */
private func recLimit(ctx: HttpContext): ?Int64 {
    match (queryParam(ctx.request, "limit")) {
        case None => return Some(20)
        case Some(raw) =>
            match (pythonIntText(raw)) {
                case None =>
                    writePyType422(ctx.response, ["query", "limit"], "int_parsing",
                                   "Input should be a valid integer, unable to parse string as an integer",
                                   jsonQuote(raw))
                    return None
                case Some(v) =>
                    if (v < 1) {
                        writePyConstraint422(ctx.response, ["query", "limit"],
                                             "greater_than_equal",
                                             "Input should be greater than or equal to 1",
                                             jsonQuote(raw), "{\"ge\":1}")
                        return None
                    }
                    if (v > 50) {
                        writePyConstraint422(ctx.response, ["query", "limit"],
                                             "less_than_equal",
                                             "Input should be less than or equal to 50",
                                             jsonQuote(raw), "{\"le\":50}")
                        return None
                    }
                    return Some(v)
            }
    }
}

private func writeRecResponse(ctx: HttpContext, conn: MyConnection,
                              userId: Array<Byte>, limit: Int64): Unit {
    let q1 = loadResourceRecs(conn, userId, limit)
    let q2 = loadPresentationRecs(conn, userId, limit)

    /* Stable merge of two updatedAt-descending lists. On a tie the Q1 side
     * wins, matching Python's stable sort over [q1..., q2...]. */
    let merged = ArrayList<String>()
    var i: Int64 = 0
    var j: Int64 = 0
    while (merged.size < limit && (i < q1.size || j < q2.size)) {
        if (i < q1.size && j < q2.size) {
            if (q2[j].updatedAt > q1[i].updatedAt) {
                merged.add(q2[j].json)
                j += 1
            } else {
                merged.add(q1[i].json)
                i += 1
            }
        } else if (i < q1.size) {
            merged.add(q1[i].json)
            i += 1
        } else {
            merged.add(q2[j].json)
            j += 1
        }
    }

    let arr = JsonArrWriter()
    for (item in merged) {
        arr.addRaw(item)
    }
    let w = JsonWriter()
    w.putRaw("candidates", arr.toJson())
    writeJson(ctx.response, 200, w.toJson())
}

/*
 * Q1 — generated_learning_resources.
 *   SELECT id, resource_type, title, course_id, chapter_id, updated_at
 *   FROM generated_learning_resources
 *   WHERE archived_at IS NULL AND resource_scope='USER'
 *     AND (user_id=%s OR is_public=1) AND course_id IS NOT NULL
 *   ORDER BY updated_at DESC LIMIT %s
 * Item field order: type, id, title, courseId, chapterId, updatedAt.
 */
private func loadResourceRecs(conn: MyConnection, userId: Array<Byte>, limit: Int64): Array<RecItem> {
    let sql = "SELECT id, resource_type, title, course_id, chapter_id, updated_at" +
        " FROM generated_learning_resources" +
        " WHERE archived_at IS NULL AND resource_scope='USER'" +
        " AND (user_id=" + sqlBinary(userId) + " OR is_public=1)" +
        " AND course_id IS NOT NULL" +
        " ORDER BY updated_at DESC LIMIT " + limit.toString()
    let out = ArrayList<RecItem>()
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return out.toArray()
        case QueryOutcome.ResultSet(rs) =>
            for (row in rs.rows) {
                let w = JsonWriter()
                w.putStr("type", cellText(row, 1))
                w.putStr("id", uuidText(row, 0) ?? "")
                w.putStr("title", cellText(row, 2))
                w.putOptStr("courseId", uuidText(row, 3))
                w.putOptStr("chapterId", uuidText(row, 4))
                let updatedAt = isoNaiveFromDb(cellText(row, 5))
                w.putStr("updatedAt", updatedAt)
                out.add(RecItem(w.toJson(), updatedAt))
            }
            return out.toArray()
    }
}

/*
 * Q2 — presentation_tasks.
 *   SELECT id, title, updated_at FROM presentation_tasks
 *   WHERE archived_at IS NULL AND resource_scope='USER'
 *     AND (user_id=%s OR is_public=1) AND status='completed'
 *   ORDER BY updated_at DESC LIMIT %s
 * Item field order: type, id, title, courseId, chapterId, updatedAt — with
 * type fixed at "ppt" and courseId/chapterId always null. `title or "最近的 PPT"`
 * means empty title falls back to the placeholder (column is NOT NULL).
 */
private func loadPresentationRecs(conn: MyConnection, userId: Array<Byte>, limit: Int64): Array<RecItem> {
    let sql = "SELECT id, title, updated_at FROM presentation_tasks" +
        " WHERE archived_at IS NULL AND resource_scope='USER'" +
        " AND (user_id=" + sqlBinary(userId) + " OR is_public=1)" +
        " AND status='completed'" +
        " ORDER BY updated_at DESC LIMIT " + limit.toString()
    let out = ArrayList<RecItem>()
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => return out.toArray()
        case QueryOutcome.ResultSet(rs) =>
            for (row in rs.rows) {
                var title = cellText(row, 1)
                if (title.isEmpty()) {
                    title = "最近的 PPT"
                }
                let updatedAt = isoNaiveFromDb(cellText(row, 2))
                let w = JsonWriter()
                w.putStr("type", "ppt")
                w.putStr("id", uuidText(row, 0) ?? "")
                w.putStr("title", title)
                w.putRaw("courseId", "null")
                w.putRaw("chapterId", "null")
                w.putStr("updatedAt", updatedAt)
                out.add(RecItem(w.toJson(), updatedAt))
            }
            return out.toArray()
    }
}
