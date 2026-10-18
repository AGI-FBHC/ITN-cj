package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * HTTP handlers for the user-memory CRUD endpoints.
 * Paths, methods, status codes and body contracts mirror
 * src/agents/app/routers/public.py around the memory routes so an existing
 * frontend can point here unchanged.
 *
 * In scope:
 *   GET    memories
 *   POST   memory/context
 *   PUT    memories
 *   DELETE memories/{memory_id}
 */

public func registerMemoryRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/memories") {
        ctx => handleListMemories(ctx, cfg)
    }
    app.mapPost("v1/memory/context") {
        ctx => handleMemoryContext(ctx, cfg)
    }
    app.mapPut("v1/memories") {
        ctx => handleUpsertMemory(ctx, cfg)
    }
    app.mapDelete("v1/memories/{memory_id}") {
        ctx => handleDeleteMemory(ctx, cfg)
    }
}

func handleListMemories(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            if (storageUnavailable(cfg)) {
                writeDetail(ctx.response, 503, "Memory storage is unavailable")
                return
            }
            match (openDb(cfg)) {
                case None => writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        let store = MemoryStore(conn)
                        pyDrop(store.bootstrapProfile(userId))
                        let items = store.list(userId, queryParam(ctx.request, "namespace"))
                        conn.close()
                        let arr = JsonArrWriter()
                        for (item in items) {
                            arr.addRaw(memToJson(item))
                        }
                        let obj = JsonWriter()
                        obj.putRaw("items", arr.toJson())
                        writeJson(ctx.response, 200, obj.toJson())
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "listMemories: " + e.message)
                    }
            }
    }
}

func handleMemoryContext(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (readJsonObjectBody(ctx)) {
                case None => return
                case Some(root) =>
                    match (parseMemoryContext(ctx, root)) {
                        case None => return
                        case Some(req) =>
                            if (storageUnavailable(cfg)) {
                                writeDetail(ctx.response, 503, "Memory storage is unavailable")
                                return
                            }
                            match (openDb(cfg)) {
                                case None => writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                case Some(conn) =>
                                    try {
                                        let store = MemoryStore(conn)
                                        let body = memBuildContext(store, userId, req.scene, req.scope,
                                                                   req.taskId)
                                        conn.close()
                                        writeJson(ctx.response, 200, body)
                                    } catch (e: Exception) {
                                        conn.close()
                                        writeInternalDebug(ctx.response, "memoryContext: " + e.message)
                                    }
                            }
                    }
            }
    }
}

func handleUpsertMemory(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (readJsonObjectBody(ctx)) {
                case None => return
                case Some(root) =>
                    match (parseMemoryUpsert(ctx, root)) {
                        case None => return
                        case Some(req) =>
                            if (!memEditableNamespace(req.namespace)) {
                                writeDetail(ctx.response, 422,
                                            "Only profile, goal and preference memories can be edited")
                                return
                            }
                            if (storageUnavailable(cfg)) {
                                writeDetail(ctx.response, 503, "Memory storage is unavailable")
                                return
                            }
                            match (openDb(cfg)) {
                                case None => writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                case Some(conn) =>
                                    try {
                                        let store = MemoryStore(conn)
                                        let learnerId = store.primaryLearnerId(userId)
                                        let item = store.upsert(userId, learnerId, req.namespace, req.key,
                                                                req.scope, req.value, req.summary,
                                                                "user_declared", 1.0, 0.9)
                                        conn.close()
                                        match (item) {
                                            case Some(rec) => writeJson(ctx.response, 200, memToJson(rec))
                                            case None => writeJson(ctx.response, 200, "{}")
                                        }
                                    } catch (e: Exception) {
                                        conn.close()
                                        writeInternalDebug(ctx.response, "upsertMemory: " + e.message)
                                    }
                            }
                    }
            }
    }
}

func handleDeleteMemory(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "memory_id")) {
                case None => return
                case Some(memoryId) =>
                    if (storageUnavailable(cfg)) {
                        writeDetail(ctx.response, 503, "Memory storage is unavailable")
                        return
                    }
                    match (openDb(cfg)) {
                        case None => writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let store = MemoryStore(conn)
                                let removed = store.delete(memoryId, userId)
                                conn.close()
                                if (removed) {
                                    ctx.response.statusCode = 204
                                } else {
                                    writeDetail(ctx.response, 404, "Memory not found")
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "deleteMemory: " + e.message)
                            }
                    }
            }
    }
}

/* -------- request models -------- */

/*
 * scene: str            (required)
 * scope: dict = {}      (must be a JSON object; present but null is a type error)
 * taskId: str | None = None
 */
struct MemoryContextReq {
    let scene: String
    let scope: JsonObject
    let taskId: ?String

    init(scene: String, scope: JsonObject, taskId: ?String) {
        this.scene = scene
        this.scope = scope
        this.taskId = taskId
    }
}

/*
 * namespace: str  (required)
 * key: str        (required)
 * scope: dict = {}
 * value: dict     (required)
 * summary: str    (required)
 */
struct MemoryUpsertReq {
    let namespace: String
    let key: String
    let scope: JsonObject
    let value: JsonObject
    let summary: String

    init(namespace: String, key: String, scope: JsonObject, value: JsonObject, summary: String) {
        this.namespace = namespace
        this.key = key
        this.scope = scope
        this.value = value
        this.summary = summary
    }
}

func parseMemoryContext(ctx: HttpContext, root: JsonObject): ?MemoryContextReq {
    let bag = PyBag()
    let parentRaw = jsonObjectToRaw(root)
    var scene = ""
    match (pyField(root, "scene", "scene")) {
        case None => bag.add(pyMissing(["body", "scene"], parentRaw))
        case Some(f) =>
            match (pyStr(bag, f, 0, 0)) {
                case Some(s) => scene = s
                case None => ()
            }
    }
    var scope = JsonObject()
    match (pyField(root, "scope", "scope")) {
        case None => ()
        case Some(f) =>
            match (f.value.kind()) {
                case JsonKind.JsObject => scope = f.value.asObject()
                case _ => bag.add(pyDictType(["body", "scope"], f.raw))
            }
    }
    var taskId: ?String = None
    match (pyFieldOpt(root, "taskId", "taskId")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 0)) {
                case Some(s) => taskId = Some(s)
                case None => ()
            }
    }
    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(MemoryContextReq(scene, scope, taskId))
}

func parseMemoryUpsert(ctx: HttpContext, root: JsonObject): ?MemoryUpsertReq {
    let bag = PyBag()
    let parentRaw = jsonObjectToRaw(root)
    var namespace = ""
    match (pyField(root, "namespace", "namespace")) {
        case None => bag.add(pyMissing(["body", "namespace"], parentRaw))
        case Some(f) =>
            match (pyStr(bag, f, 0, 0)) {
                case Some(s) => namespace = s
                case None => ()
            }
    }
    var key = ""
    match (pyField(root, "key", "key")) {
        case None => bag.add(pyMissing(["body", "key"], parentRaw))
        case Some(f) =>
            match (pyStr(bag, f, 0, 0)) {
                case Some(s) => key = s
                case None => ()
            }
    }
    var scope = JsonObject()
    match (pyField(root, "scope", "scope")) {
        case None => ()
        case Some(f) =>
            match (f.value.kind()) {
                case JsonKind.JsObject => scope = f.value.asObject()
                case _ => bag.add(pyDictType(["body", "scope"], f.raw))
            }
    }
    var value = JsonObject()
    match (pyField(root, "value", "value")) {
        case None => bag.add(pyMissing(["body", "value"], parentRaw))
        case Some(f) =>
            match (f.value.kind()) {
                case JsonKind.JsObject => value = f.value.asObject()
                case _ => bag.add(pyDictType(["body", "value"], f.raw))
            }
    }
    var summary = ""
    match (pyField(root, "summary", "summary")) {
        case None => bag.add(pyMissing(["body", "summary"], parentRaw))
        case Some(f) =>
            match (pyStr(bag, f, 0, 0)) {
                case Some(s) => summary = s
                case None => ()
            }
    }
    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(MemoryUpsertReq(namespace, key, scope, value, summary))
}

func memEditableNamespace(namespace: String): Bool {
    return namespace == "profile" || namespace == "goal" || namespace == "preference"
}

/* -------- context assembly (user_memory.py) -------- */

func memBuildContext(store: MemoryStore, userId: Array<Byte>, scene: String,
                     scope: JsonObject, taskId: ?String): String {
    pyDrop(store.bootstrapProfile(userId))
    let allowed = memSceneNamespaces(scene)
    let kpId = memKpId(scope)
    let records = store.list(userId, None)
    let picked = ArrayList<MemoryRecord>()
    for (rec in records) {
        if (!memContains(allowed, rec.namespace)) {
            continue
        }
        let memoryKp = memKpIdOfPair(memParsedObject(rec.scopeJson), memParsedObject(rec.valueJson))
        if (!memoryKp.isEmpty() && !kpId.isEmpty() && memoryKp != kpId) {
            continue
        }
        picked.add(rec)
    }
    let pickedArr = picked.toArray()
    let limited = ArrayList<MemoryRecord>()
    var n: Int64 = 0
    while (n < pickedArr.size && n < 20) {
        limited.add(pickedArr[n])
        n += 1
    }
    let grouped = HashMap<String, ArrayList<MemoryRecord>>()
    for (rec in limited) {
        match (grouped.get(rec.namespace)) {
            case Some(bucket) => bucket.add(rec)
            case None =>
                let bucket = ArrayList<MemoryRecord>()
                bucket.add(rec)
                grouped.add(rec.namespace, bucket)
        }
    }
    let obj = JsonWriter()
    obj.putStr("scene", scene)
    obj.putRaw("scope", memPyDumpsObject(scope, false))
    obj.putRaw("profile", memFirstValue(grouped, "profile"))
    obj.putRaw("goals", memValueList(grouped, "goal", 3))
    obj.putRaw("knowledge", memFirstValue(grouped, "knowledge"))
    obj.putRaw("misconceptions", memMergedList(grouped, "misconception", 5))
    obj.putRaw("preferences", memValueList(grouped, "preference", 4))
    obj.putRaw("strategies", memValueList(grouped, "learning_strategy", 3))
    obj.putRaw("recentEpisodes", memMergedList(grouped, "episodic", 3))
    obj.putRaw("memoryRefs", memRefs(limited))
    let ids = ArrayList<String>()
    for (rec in limited) {
        ids.add(rec.id)
    }
    store.recordUsage(userId, ids.toArray(), scene, taskId)
    return obj.toJson()
}

/* SCENE_NAMESPACES: the default is the union of every scene's namespaces. */
func memSceneNamespaces(scene: String): Array<String> {
    if (scene == "lecture_customize" || scene == "practice_customize") {
        return ["profile", "goal", "preference", "knowledge", "misconception", "learning_strategy"]
    }
    if (scene == "quiz_customize" || scene == "learning_recommendation") {
        return ["goal", "preference", "knowledge", "misconception"]
    }
    if (scene == "ppt_customize") {
        return ["profile", "goal", "preference", "knowledge", "misconception"]
    }
    if (scene == "ai_tutoring") {
        return ["profile", "goal", "preference", "knowledge", "misconception", "episodic"]
    }
    return ["profile", "goal", "preference", "knowledge", "misconception", "learning_strategy", "episodic"]
}

func memFirstValue(grouped: HashMap<String, ArrayList<MemoryRecord>>, namespace: String): String {
    match (grouped.get(namespace)) {
        case Some(bucket) =>
            let arr = bucket.toArray()
            if (arr.size > 0) {
                return arr[0].valueJson
            }
            return "{}"
        case None => return "{}"
    }
}

func memValueList(grouped: HashMap<String, ArrayList<MemoryRecord>>, namespace: String,
                  limit: Int64): String {
    let arr = JsonArrWriter()
    match (grouped.get(namespace)) {
        case Some(bucket) =>
            let items = bucket.toArray()
            var i: Int64 = 0
            while (i < items.size && i < limit) {
                arr.addRaw(items[i].valueJson)
                i += 1
            }
        case None => ()
    }
    return arr.toJson()
}

/* value | {"summary": ..., "confidence": ...} */
func memMergedList(grouped: HashMap<String, ArrayList<MemoryRecord>>, namespace: String,
                   limit: Int64): String {
    let arr = JsonArrWriter()
    match (grouped.get(namespace)) {
        case Some(bucket) =>
            let items = bucket.toArray()
            var i: Int64 = 0
            while (i < items.size && i < limit) {
                let rec = items[i]
                let overrides: Array<(String, JsonValue)> = [
                    ("summary", jstr(rec.summary)),
                    ("confidence", jfloatPy(rec.confidence))
                ]
                arr.addRaw(jsonOverlay(memParsedObject(rec.valueJson), overrides))
                i += 1
            }
        case None => ()
    }
    return arr.toJson()
}

func memRefs(records: ArrayList<MemoryRecord>): String {
    let arr = JsonArrWriter()
    for (rec in records) {
        let obj = JsonWriter()
        obj.putStr("memoryId", rec.id)
        obj.putStr("summary", rec.summary)
        arr.addRaw(obj.toJson())
    }
    return arr.toJson()
}

/* str(scope.get("kpId") or "") */
func memKpId(scope: JsonObject): String {
    match (scope.get("kpId")) {
        case Some(v) =>
            if (jsonValTruthy(v)) {
                return memJsonValStr(v)
            }
            return ""
        case None => return ""
    }
}

/* str(scopeKpId or valueKpId or "") */
func memKpIdOfPair(scope: JsonObject, value: JsonObject): String {
    let fromScope = memKpId(scope)
    if (!fromScope.isEmpty()) {
        return fromScope
    }
    return memKpId(value)
}
