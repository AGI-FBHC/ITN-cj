package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * 「我的学习」选课关系 + 领域学习人数。
 *
 *   GET    v1/learner/courses              当前用户书架里的课程编码
 *   POST   v1/learner/courses              加入书架 {"code":"..."}
 *   DELETE v1/learner/courses/{code}       移出书架
 *   GET    v1/learner/domain-popularity    每个领域的学习人数（热学榜）
 *
 * 选课关系落库到 learner_course_enrollments，解决「谁在学哪门课」只存在浏览器
 * localStorage 的问题；热学榜人数由选课关系 + 已有学习资源去重统计。
 */
public func registerLearnerCourseRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/learner/courses") {
        ctx => handleListMyCourses(ctx, cfg)
    }
    app.mapPost("v1/learner/courses") {
        ctx => handleAddMyCourse(ctx, cfg)
    }
    app.mapDelete("v1/learner/courses/{code}") {
        ctx => handleRemoveMyCourse(ctx, cfg)
    }
    app.mapGet("v1/learner/domain-popularity") {
        ctx => handleDomainPopularity(ctx, cfg)
    }
}

/* -------- helpers -------- */

private func lceCodes(conn: MyConnection, userId: Array<Byte>): ArrayList<String> {
    let out = ArrayList<String>()
    let sql = "SELECT domain_code FROM learner_course_enrollments WHERE user_id=" + sqlBinary(userId) +
        " ORDER BY updated_at DESC, domain_code ASC"
    match (conn.query(sql)) {
        case QueryOutcome.Ok(_) => ()
        case QueryOutcome.ResultSet(rs) =>
            for (row in rs.rows) {
                let code = cellText(row, 0)
                if (!code.isEmpty()) {
                    out.add(code)
                }
            }
    }
    return out
}

private func lceWriteCodes(ctx: HttpContext, codes: ArrayList<String>): Unit {
    let arr = JsonArrWriter()
    for (code in codes) {
        arr.addRaw(jsonQuote(code))
    }
    let obj = JsonWriter()
    obj.putRaw("codes", arr.toJson())
    writeJson(ctx.response, 200, obj.toJson())
}

private func lceCodeParam(value: String): ?String {
    let code = value.trimAscii()
    if (code.isEmpty() || code.size > 64) {
        return None
    }
    return Some(code)
}

/* -------- GET v1/learner/courses -------- */

func handleListMyCourses(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            if (storageUnavailable(cfg)) {
                writeDetail(ctx.response, 503, "Course storage is unavailable")
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        let codes = lceCodes(conn, userId)
                        conn.close()
                        lceWriteCodes(ctx, codes)
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "listMyCourses: " + e.message)
                    }
            }
    }
}

/* -------- POST v1/learner/courses -------- */

func handleAddMyCourse(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            let raw = match (readJsonBody(ctx)) {
                case Some(body) => jsonObjStr(body, "code") ?? ""
                case None => ""
            }
            let code = match (lceCodeParam(raw)) {
                case Some(value) => value
                case None =>
                    writeDetail(ctx.response, 422, "Invalid course code")
                    return
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
                        let sql = "INSERT INTO learner_course_enrollments (user_id, domain_code, created_at, updated_at) " +
                            "VALUES (" + sqlBinary(userId) + "," + sqlQuote(code) + ",UTC_TIMESTAMP(6),UTC_TIMESTAMP(6)) " +
                            "ON DUPLICATE KEY UPDATE updated_at=UTC_TIMESTAMP(6)"
                        match (conn.query(sql)) {
                            case QueryOutcome.Ok(_) => ()
                            case QueryOutcome.ResultSet(_) => ()
                        }
                        let codes = lceCodes(conn, userId)
                        conn.close()
                        lceWriteCodes(ctx, codes)
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "addMyCourse: " + e.message)
                    }
            }
    }
}

/* -------- DELETE v1/learner/courses/{code} -------- */

func handleRemoveMyCourse(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            let raw = routeParam(ctx.request, "code") ?? ""
            let code = match (lceCodeParam(raw)) {
                case Some(value) => value
                case None =>
                    writeDetail(ctx.response, 422, "Invalid course code")
                    return
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
                        let sql = "DELETE FROM learner_course_enrollments WHERE user_id=" + sqlBinary(userId) +
                            " AND domain_code=" + sqlQuote(code)
                        match (conn.query(sql)) {
                            case QueryOutcome.Ok(_) => ()
                            case QueryOutcome.ResultSet(_) => ()
                        }
                        let codes = lceCodes(conn, userId)
                        conn.close()
                        lceWriteCodes(ctx, codes)
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "removeMyCourse: " + e.message)
                    }
            }
    }
}

/* -------- GET v1/learner/domain-popularity -------- */

func handleDomainPopularity(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(_) =>
            if (storageUnavailable(cfg)) {
                writeDetail(ctx.response, 503, "Course storage is unavailable")
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        /* 选课关系 + 已生成学习资源，同一用户同一领域只算一次 */
                        let sql = "SELECT t.domain_code, COUNT(DISTINCT t.user_id) FROM (" +
                            "SELECT user_id, domain_code COLLATE utf8mb4_unicode_ci AS domain_code " +
                            "FROM learner_course_enrollments " +
                            "UNION ALL SELECT user_id, domain_code COLLATE utf8mb4_unicode_ci AS domain_code " +
                            "FROM generated_learning_resources " +
                            "WHERE domain_code IS NOT NULL AND domain_code <> '' AND archived_at IS NULL" +
                            ") t JOIN knowledge_domain d ON d.code = t.domain_code " +
                            "GROUP BY t.domain_code"
                        let arr = JsonArrWriter()
                        match (conn.query(sql)) {
                            case QueryOutcome.Ok(_) => ()
                            case QueryOutcome.ResultSet(rs) =>
                                for (row in rs.rows) {
                                    let code = cellText(row, 0)
                                    if (code.isEmpty()) {
                                        continue
                                    }
                                    let obj = JsonWriter()
                                    obj.putStr("code", code)
                                    obj.putInt("learners", optCellInt(row, 1) ?? 0)
                                    arr.addRaw(obj.toJson())
                                }
                        }
                        conn.close()
                        let out = JsonWriter()
                        out.putRaw("items", arr.toJson())
                        writeJson(ctx.response, 200, out.toJson())
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "domainPopularity: " + e.message)
                    }
            }
    }
}
