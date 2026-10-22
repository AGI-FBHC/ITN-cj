package itn_spire

import std.core.*
import std.collection.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * HTTP handlers for the two deterministic administrator queries that used to
 * live in src/agents/app/routers/public.py and
 * src/agents/app/storage/learning_resources.py:
 *   GET v1/admin-generation-groups
 *   GET v1/admin-generation-resources/{resource_id}
 *
 * Read-only against the platform DB. Spire does NOT run Python's idempotent
 * ensure_schema DDL. The LLM / in-process asyncio admin routes
 * (summarize, backfill-summaries, admin-generation-batches and the task
 * stream) are deliberately left in Python.
 */
public func registerAdminQueryRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/admin-generation-groups") {
        ctx => handleAdminGenerationGroups(ctx, cfg)
    }
    app.mapGet("v1/admin-generation-resources/{resource_id}") {
        ctx => handleAdminGenerationResource(ctx, cfg)
    }
}

/* -------- GET v1/admin-generation-groups -------- */

/*
 * list_admin_generation_groups (public.py list_admin_generation_groups):
 * domainCode and nodeCode are Query(..., min_length=1) — REQUIRED, and NOT
 * stripped, so min_length counts raw characters. Measured shape: absent ->
 * missing at ["query",<name>] with input null; "" -> string_too_short. Both
 * missing params are reported together, in declaration order.
 */
struct AdminGroupQuery {
    let domainCode: String
    let nodeCode: String

    init(domainCode: String, nodeCode: String) {
        this.domainCode = domainCode
        this.nodeCode = nodeCode
    }
}

func parseAdminGroupQuery(ctx: HttpContext): ?AdminGroupQuery {
    let bag = PyBag()
    var domainCode = ""
    match (queryParam(ctx.request, "domainCode")) {
        case None => bag.add(pyMissing(["query", "domainCode"], "null"))
        case Some(raw) =>
            if (charCount(raw) < 1) {
                bag.add(pyStringTooShort(["query", "domainCode"], jsonQuote(raw), 1))
            } else {
                domainCode = raw
            }
    }
    var nodeCode = ""
    match (queryParam(ctx.request, "nodeCode")) {
        case None => bag.add(pyMissing(["query", "nodeCode"], "null"))
        case Some(raw) =>
            if (charCount(raw) < 1) {
                bag.add(pyStringTooShort(["query", "nodeCode"], jsonQuote(raw), 1))
            } else {
                nodeCode = raw
            }
    }
    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(AdminGroupQuery(domainCode, nodeCode))
}

func handleAdminGenerationGroups(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(_) =>
            match (parseAdminGroupQuery(ctx)) {
                case None => return
                case Some(params) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Learning resource storage is unavailable")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let store = AdminQueriesStore(conn)
                                let groups = store.listAdminGenerationGroups(
                                    params.domainCode, params.nodeCode)
                                conn.close()
                                let obj = JsonWriter()
                                obj.putRaw("groups", groups)
                                writeJson(ctx.response, 200, obj.toJson())
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response,
                                    "listAdminGenerationGroups: " + e.message)
                            }
                    }
            }
    }
}

/* -------- GET v1/admin-generation-resources/{resource_id} -------- */

func handleAdminGenerationResource(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "resource_id")) {
                case None => return
                case Some(resourceId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Learning resource storage is unavailable")
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let store = AdminQueriesStore(conn)
                                let resource = store.getAdmin(userId, resourceId)
                                conn.close()
                                match (resource) {
                                    case Some(row) => writeJson(ctx.response, 200, row)
                                    case None =>
                                        writeDetail(ctx.response, 404, "资源不存在或不属于当前机构")
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response,
                                    "getAdminGenerationResource: " + e.message)
                            }
                    }
            }
    }
}

/* -------- storage -------- */

/*
 * generated_learning_resources SELECT order for get_admin. It mirrors the
 * shared detail-column layout (so serializeDetail can be reused) and then
 * appends the governance columns the admin view adds on top:
 *   0 id, 1 user_id, 2 learner_id, 3 kp_id, 4 form, 5 level, 6 version,
 *   7 quiz_ids_json, 8 kb_refs_json, 9 resource_type, 10 title, 11 topic,
 *  12 learning_goal_id, 13 course_id, 14 chapter_id, 15 content_json,
 *  16 sources_json, 17 state_json, 18 context_json, 19 decision_json,
 *  20 is_public, 21 created_at, 22 updated_at,
 *  23 resource_scope, 24 review_status, 25 revision, 26 domain_code,
 *  27 category_node_code, 28 base_resource_id, 29 is_template,
 *  30 archived_at, 31 archive_reason
 */
private func adminResourceColumns(): String {
    "id,user_id,learner_id,kp_id,form,level,version,quiz_ids_json,kb_refs_json," +
        "resource_type,title,topic,learning_goal_id,course_id,chapter_id," +
        "content_json,sources_json,state_json,context_json,decision_json," +
        "is_public,created_at,updated_at," +
        "resource_scope,review_status,revision,domain_code,category_node_code," +
        "base_resource_id,is_template,archived_at,archive_reason"
}

public class AdminQueriesStore {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    /*
     * get_admin (learning_resources.py L383-410): an organization resource
     * owned by the calling admin account. Missing, foreign-owned, archived or
     * USER-scoped rows all return None.
     */
    public func getAdmin(userId: Array<Byte>, resourceId: Array<Byte>): ?String {
        let sql = "SELECT " + adminResourceColumns() +
            " FROM generated_learning_resources WHERE id=" + sqlBinary(resourceId) +
            " AND user_id=" + sqlBinary(userId) +
            " AND archived_at IS NULL AND resource_scope='ORGANIZATION'"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(serializeAdminResource(rs.rows[0]))
        }
    }

    /*
     * list_admin_generation_groups (learning_resources.py L412-482): six
     * queries accumulate (group -> resource types) and (group -> type ->
     * statuses); the response lists only groups that carry at least one
     * generated/generating type, but each such group still reports every
     * observed status in its details map.
     */
    public func listAdminGenerationGroups(domainCode: String, nodeCode: String): String {
        let groups = HashMap<String, HashSet<String>>()
        let details = HashMap<String, HashMap<String, HashSet<String>>>()

        /* generated_learning_resources ORGANIZATION rows -> "generated". */
        let q1 = "SELECT COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(context_json,'$.resourceGroup'))) resource_group, resource_type FROM generated_learning_resources " +
            "WHERE domain_code=" + sqlQuote(domainCode) +
            " AND category_node_code=" + sqlQuote(nodeCode) +
            " AND resource_scope='ORGANIZATION' AND archived_at IS NULL" +
            " AND COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(context_json,'$.resourceGroup'))) IS NOT NULL"
        match (conn.query(q1)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                for (row in rs.rows) {
                    addAdminStatus(groups, details, cellText(row, 0), cellText(row, 1), "generated")
                }
        }

        /* presentation_tasks completed ORGANIZATION rows -> ppt "generated". */
        let q2 = "SELECT COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName'))) resource_group FROM presentation_tasks " +
            "WHERE domain_code=" + sqlQuote(domainCode) +
            " AND category_node_code=" + sqlQuote(nodeCode) +
            " AND resource_scope='ORGANIZATION' AND status='completed' AND archived_at IS NULL" +
            " AND COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName'))) IS NOT NULL"
        match (conn.query(q2)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                for (row in rs.rows) {
                    addAdminStatus(groups, details, cellText(row, 0), "ppt", "generated")
                }
        }

        /*
         * In-flight learning_resource_generation_tasks. Domain/node are read
         * from request_json and compared in code (the SQL has no such filter).
         */
        let q3 = "SELECT resource_type, " +
            "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.domainCode')) domain_code, " +
            "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.nodeCode')) node_code, " +
            "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.groupName')) group_name " +
            "FROM learning_resource_generation_tasks " +
            "WHERE status NOT IN ('completed','failed','cancelled')"
        match (conn.query(q3)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                for (row in rs.rows) {
                    if (cellText(row, 1) == domainCode && cellText(row, 2) == nodeCode) {
                        addAdminStatus(groups, details, adminFallbackGroup(cellText(row, 3)),
                            cellText(row, 0), "generating")
                    }
                }
        }

        /* Failed / cancelled learning_resource_generation_tasks keep their status. */
        let q4 = "SELECT resource_type, " +
            "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.domainCode')) domain_code, " +
            "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.nodeCode')) node_code, " +
            "JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generation_context.groupName')) group_name, " +
            "status " +
            "FROM learning_resource_generation_tasks " +
            "WHERE status IN ('failed','cancelled')"
        match (conn.query(q4)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                for (row in rs.rows) {
                    if (cellText(row, 1) == domainCode && cellText(row, 2) == nodeCode) {
                        addAdminStatus(groups, details, adminFallbackGroup(cellText(row, 3)),
                            cellText(row, 0), cellText(row, 4))
                    }
                }
        }

        /* In-flight presentation_tasks -> ppt "generating". */
        let q5 = "SELECT COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName'))) resource_group FROM presentation_tasks " +
            "WHERE domain_code=" + sqlQuote(domainCode) +
            " AND category_node_code=" + sqlQuote(nodeCode) +
            " AND resource_scope='ORGANIZATION'" +
            " AND status NOT IN ('completed','failed','cancelled') AND archived_at IS NULL" +
            " AND COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName'))) IS NOT NULL"
        match (conn.query(q5)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                for (row in rs.rows) {
                    addAdminStatus(groups, details, cellText(row, 0), "ppt", "generating")
                }
        }

        /* Failed / cancelled presentation_tasks keep their status (no archived filter). */
        let q6 = "SELECT COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName'))) resource_group, status FROM presentation_tasks " +
            "WHERE domain_code=" + sqlQuote(domainCode) +
            " AND category_node_code=" + sqlQuote(nodeCode) +
            " AND resource_scope='ORGANIZATION' AND status IN ('failed','cancelled')" +
            " AND COALESCE(resource_group, JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.generationContext.groupName'))) IS NOT NULL"
        match (conn.query(q6)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                for (row in rs.rows) {
                    addAdminStatus(groups, details, cellText(row, 0), "ppt", cellText(row, 1))
                }
        }

        let names = ArrayList<String>()
        for ((name, _types) in groups) {
            names.add(name)
        }
        let arr = JsonArrWriter()
        for (name in memSortedKeys(names.toArray())) {
            let typeNames = ArrayList<String>()
            match (groups.get(name)) {
                case Some(types) =>
                    for (t in types) {
                        typeNames.add(t)
                    }
                case None => ()
            }
            let dw = JsonWriter()
            match (details.get(name)) {
                case Some(byType) =>
                    let detailTypes = ArrayList<String>()
                    for ((rt, _statuses) in byType) {
                        detailTypes.add(rt)
                    }
                    for (rt in memSortedKeys(detailTypes.toArray())) {
                        match (byType.get(rt)) {
                            case Some(statuses) =>
                                let statusNames = ArrayList<String>()
                                for (s in statuses) {
                                    statusNames.add(s)
                                }
                                dw.putRaw(rt, jsonStringArray(memSortedKeys(statusNames.toArray())))
                            case None => ()
                        }
                    }
                case None => ()
            }
            let g = JsonWriter()
            g.putStr("groupName", name)
            g.putRaw("types", jsonStringArray(memSortedKeys(typeNames.toArray())))
            g.putRaw("details", dw.toJson())
            arr.addRaw(g.toJson())
        }
        return arr.toJson()
    }
}

/* -------- aggregation / serialisation -------- */

/*
 * add_status: a generated/generating outcome registers the resource type in
 * `groups`; every outcome registers the status in `details`.
 */
func addAdminStatus(groups: HashMap<String, HashSet<String>>,
                    details: HashMap<String, HashMap<String, HashSet<String>>>,
                    groupName: String, resourceType: String, status: String): Unit {
    if (status == "generated" || status == "generating") {
        match (groups.get(groupName)) {
            case Some(types) =>
                types.add(resourceType)
                ()
            case None =>
                let types = HashSet<String>()
                types.add(resourceType)
                groups.add(groupName, types)
                ()
        }
    }
    match (details.get(groupName)) {
        case Some(byType) =>
            match (byType.get(resourceType)) {
                case Some(statuses) =>
                    statuses.add(status)
                    ()
                case None =>
                    let statuses = HashSet<String>()
                    statuses.add(status)
                    byType.add(resourceType, statuses)
                    ()
            }
            ()
        case None =>
            let statuses = HashSet<String>()
            statuses.add(status)
            let byType = HashMap<String, HashSet<String>>()
            byType.add(resourceType, statuses)
            details.add(groupName, byType)
            ()
    }
}

/* Python: str(row.get("group_name") or "默认分组"). */
func adminFallbackGroup(groupName: String): String {
    if (groupName.size == 0) {
        return "默认分组"
    }
    return groupName
}

/*
 * get_admin = _serialize(row) (non-summary) followed by item.update({...}).
 * serializeDetail builds the _serialize object; we then re-emit its keys in
 * order and append the governance keys, matching Python dict insertion order.
 */
func serializeAdminResource(row: Array<MyCell>): String {
    let baseObj = parseContextObject(serializeDetail(row, cellText(row, 17)))
    let w = JsonWriter()
    for ((k, v) in baseObj.getFields()) {
        w.putRaw(k, valueToRaw(v))
    }
    w.putStr("scope", cellText(row, 23))
    w.putOptStr("reviewStatus", optCellText(row, 24))
    w.putOptInt("revision", optCellInt(row, 25))
    w.putOptStr("domainCode", optCellText(row, 26))
    w.putOptStr("nodeCode", optCellText(row, 27))
    w.putOptStr("baseResourceId", uuidText(row, 28))
    w.putBool("template", optCellBool(row, 29) ?? false)
    w.putRaw("groupName", adminGroupNameRaw(cellText(row, 18)))
    w.putRaw("archivedAt", adminArchivedAtRaw(optCellText(row, 30)))
    w.putOptStr("archiveReason", optCellText(row, 31))
    w.putRaw("ownerAccount", "null")
    return w.toJson()
}

/*
 * groupName = _loads(context_json, {}).get("resourceGroup") — a raw JSON value
 * (usually a string) or null when the key is absent or the blob is not an
 * object.
 */
func adminGroupNameRaw(contextText: String): String {
    match (parseContextObject(contextText).get("resourceGroup")) {
        case Some(v) => return valueToRaw(v)
        case None => return "null"
    }
}

/*
 * archivedAt = row["archived_at"].isoformat() if present else null. Python's
 * naive datetime.isoformat() drops zero microseconds — isoNaiveFromDb matches.
 */
func adminArchivedAtRaw(archivedAt: ?String): String {
    match (archivedAt) {
        case Some(t) => return jsonQuote(isoNaiveFromDb(t))
        case None => return "null"
    }
}

/* Parse a JSON text blob into an object, falling back to {} like _loads. */
func parseContextObject(text: String): JsonObject {
    match (jsonParse(parseState(text))) {
        case Some(v) =>
            if (isJsObject(v)) {
                return v.asObject()
            }
        case None => ()
    }
    return emptyObject()
}
