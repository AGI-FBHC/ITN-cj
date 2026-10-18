package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * HTTP handlers for the agent session / collaboration log module.
 * Path/method/status/body contracts mirror
 * src/agents/app/routers/public.py:3080-3168 so the old frontend can point
 * here unchanged.
 *
 * In scope:
 *   GET    /v1/agent-sessions
 *   POST   /v1/agent-sessions                201 session
 *   GET    /v1/agent-sessions/{session_id}
 *   PATCH  /v1/agent-sessions/{session_id}
 *   POST   /v1/agent-sessions/{session_id}/complete
 *   DELETE /v1/agent-sessions/{session_id}   204
 *   GET    /v1/agent-sessions/{session_id}/messages
 *   POST   /v1/agent-sessions/{session_id}/messages    201 session
 *   GET    /v1/agent-sessions/{session_id}/decisions
 *   POST   /v1/agent-sessions/{session_id}/decisions   201 session
 *
 * 404 detail is always "Agent session not found" (public.py).
 */
public func registerAgentSessionRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/agent-sessions") {
        ctx => handleListAgentSessions(ctx, cfg)
    }
    app.mapPost("v1/agent-sessions") {
        ctx => handleCreateAgentSession(ctx, cfg)
    }
    app.mapGet("v1/agent-sessions/{session_id}") {
        ctx => handleGetAgentSession(ctx, cfg)
    }
    app.mapPatch("v1/agent-sessions/{session_id}") {
        ctx => handleUpdateAgentSession(ctx, cfg)
    }
    app.mapPost("v1/agent-sessions/{session_id}/complete") {
        ctx => handleCompleteAgentSession(ctx, cfg)
    }
    app.mapDelete("v1/agent-sessions/{session_id}") {
        ctx => handleDeleteAgentSession(ctx, cfg)
    }
    app.mapGet("v1/agent-sessions/{session_id}/messages") {
        ctx => handleListAgentMessages(ctx, cfg)
    }
    app.mapPost("v1/agent-sessions/{session_id}/messages") {
        ctx => handleAppendAgentMessage(ctx, cfg)
    }
    app.mapGet("v1/agent-sessions/{session_id}/decisions") {
        ctx => handleListAgentDecisions(ctx, cfg)
    }
    app.mapPost("v1/agent-sessions/{session_id}/decisions") {
        ctx => handleAppendAgentDecision(ctx, cfg)
    }
}

private func sessionNotFound(ctx: HttpContext): Unit {
    writeDetail(ctx.response, 404, "Agent session not found")
}

func handleListAgentSessions(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            if (storageUnavailable(cfg)) {
                writeDetail(ctx.response, 503, "Agent storage is unavailable")
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        let store = AgentSessionsStore(conn)
                        let items = store.list(userId)
                        conn.close()
                        let arr = JsonArrWriter()
                        for (raw in items) {
                            arr.addRaw(raw)
                        }
                        let obj = JsonWriter()
                        obj.putRaw("sessions", arr.toJson())
                        writeJson(ctx.response, 200, obj.toJson())
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalError(ctx.response)
                    }
            }
    }
}

func handleCreateAgentSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (readJsonObjectBody(ctx)) {
                case None => return
                case Some(root) =>
                    match (parseAgentSessionCreate(ctx, root)) {
                        case None => return
                        case Some(req) =>
                            if (storageUnavailable(cfg)) {
                                writeDetail(ctx.response, 503, "Agent storage is unavailable")
                                return
                            }
                            match (openDb(cfg)) {
                                case None =>
                                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                case Some(conn) =>
                                    try {
                                        let store = AgentSessionsStore(conn)
                                        match (store.create(userId, req.learnerId, req.sessionType, req.title)) {
                                            case None =>
                                                conn.close()
                                                writeInternalError(ctx.response)
                                            case Some(raw) =>
                                                conn.close()
                                                writeJson(ctx.response, 201, raw)
                                        }
                                    } catch (e: Exception) {
                                        conn.close()
                                        writeInternalError(ctx.response)
                                    }
                            }
                    }
            }
    }
}

func handleGetAgentSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalError(ctx.response)
                        case Some(conn) =>
                            try {
                                let store = AgentSessionsStore(conn)
                                match (store.get(userId, sessionId)) {
                                    case None =>
                                        conn.close()
                                        sessionNotFound(ctx)
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
}

func handleUpdateAgentSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    match (readJsonObjectBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (parseAgentSessionUpdate(ctx, root)) {
                                case None => return
                                case Some(title) =>
                                    match (openDb(cfg)) {
                                        case None =>
                                            writeInternalError(ctx.response)
                                        case Some(conn) =>
                                            try {
                                                let store = AgentSessionsStore(conn)
                                                match (store.updateTitle(userId, sessionId, title)) {
                                                    case None =>
                                                        conn.close()
                                                        sessionNotFound(ctx)
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
            }
    }
}

func handleCompleteAgentSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalError(ctx.response)
                        case Some(conn) =>
                            try {
                                let store = AgentSessionsStore(conn)
                                match (store.complete(userId, sessionId)) {
                                    case None =>
                                        conn.close()
                                        sessionNotFound(ctx)
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
}

func handleDeleteAgentSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalError(ctx.response)
                        case Some(conn) =>
                            try {
                                let store = AgentSessionsStore(conn)
                                let deleted = store.delete(userId, sessionId)
                                conn.close()
                                if (deleted) {
                                    ctx.response.statusCode = 204
                                } else {
                                    sessionNotFound(ctx)
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalError(ctx.response)
                            }
                    }
            }
    }
}

func handleListAgentMessages(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalError(ctx.response)
                        case Some(conn) =>
                            try {
                                let store = AgentSessionsStore(conn)
                                match (store.get(userId, sessionId)) {
                                    case None =>
                                        conn.close()
                                        sessionNotFound(ctx)
                                    case Some(raw) =>
                                        conn.close()
                                        match (jsonParse(raw)) {
                                            case None =>
                                                writeInternalError(ctx.response)
                                            case Some(v) =>
                                                if (!isJsObject(v)) {
                                                    writeInternalError(ctx.response)
                                                } else {
                                                    let obj = JsonWriter()
                                                    match (jsonGetArray(v.asObject(), "messages")) {
                                                        case None => obj.putRaw("messages", "[]")
                                                        case Some(arr) => obj.putRaw("messages", jsonArrayToRaw(arr))
                                                    }
                                                    writeJson(ctx.response, 200, obj.toJson())
                                                }
                                        }
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalError(ctx.response)
                            }
                    }
            }
    }
}

func handleListAgentDecisions(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalError(ctx.response)
                        case Some(conn) =>
                            try {
                                let store = AgentSessionsStore(conn)
                                match (store.get(userId, sessionId)) {
                                    case None =>
                                        conn.close()
                                        sessionNotFound(ctx)
                                    case Some(raw) =>
                                        conn.close()
                                        match (jsonParse(raw)) {
                                            case None =>
                                                writeInternalError(ctx.response)
                                            case Some(v) =>
                                                if (!isJsObject(v)) {
                                                    writeInternalError(ctx.response)
                                                } else {
                                                    let obj = JsonWriter()
                                                    match (jsonGetArray(v.asObject(), "decisions")) {
                                                        case None => obj.putRaw("decisions", "[]")
                                                        case Some(arr) => obj.putRaw("decisions", jsonArrayToRaw(arr))
                                                    }
                                                    writeJson(ctx.response, 200, obj.toJson())
                                                }
                                        }
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalError(ctx.response)
                            }
                    }
            }
    }
}

func handleAppendAgentMessage(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    match (readJsonObjectBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (parseAgentMessageCreate(ctx, root)) {
                                case None => return
                                case Some(req) =>
                                    match (openDb(cfg)) {
                                        case None =>
                                            writeInternalError(ctx.response)
                                        case Some(conn) =>
                                            try {
                                                let store = AgentSessionsStore(conn)
                                                match (store.appendMessage(userId, sessionId,
                                                                           req.agentId, req.kind, req.content)) {
                                                    case None =>
                                                        conn.close()
                                                        sessionNotFound(ctx)
                                                    case Some(raw) =>
                                                        conn.close()
                                                        writeJson(ctx.response, 201, raw)
                                                }
                                            } catch (e: Exception) {
                                                conn.close()
                                                writeInternalError(ctx.response)
                                            }
                                    }
                            }
                    }
            }
    }
}

func handleAppendAgentDecision(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    match (readJsonObjectBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (parseAgentDecisionCreate(ctx, root)) {
                                case None => return
                                case Some(req) =>
                                    match (openDb(cfg)) {
                                        case None =>
                                            writeInternalError(ctx.response)
                                        case Some(conn) =>
                                            try {
                                                let store = AgentSessionsStore(conn)
                                                /* public.py always passes learner_id=None here. */
                                                match (store.appendDecision(userId, sessionId, None,
                                                                           req.stage, req.text)) {
                                                    case None =>
                                                        conn.close()
                                                        sessionNotFound(ctx)
                                                    case Some(raw) =>
                                                        conn.close()
                                                        writeJson(ctx.response, 201, raw)
                                                }
                                            } catch (e: Exception) {
                                                conn.close()
                                                writeInternalError(ctx.response)
                                            }
                                    }
                            }
                    }
            }
    }
}

/* -------- request bodies (models.py:402-426) -------- */

struct AgentSessionCreateReq {
    let learnerId: ?Array<Byte>
    let sessionType: String
    let title: ?String

    init(learnerId: ?Array<Byte>, sessionType: String, title: ?String) {
        this.learnerId = learnerId
        this.sessionType = sessionType
        this.title = title
    }
}

struct AgentMessageCreateReq {
    let agentId: ?String
    let kind: String
    let content: String

    init(agentId: ?String, kind: String, content: String) {
        this.agentId = agentId
        this.kind = kind
        this.content = content
    }
}

struct AgentDecisionCreateReq {
    let stage: String
    let text: String

    init(stage: String, text: String) {
        this.stage = stage
        this.text = text
    }
}

/* Three-state string field: absent/null / present-but-invalid (422 written) / value. */
private struct StrFieldResult {
    let kind: UuidFieldKind
    let value: ?String

    init(kind: UuidFieldKind, value: ?String) {
        this.kind = kind
        this.value = value
    }
}

/*
 * AgentSessionCreateRequest (models.py). Declaration order is
 * learner_id, session_type, title — multi-error collection follows it.
 *
 * Alias note: only learner_id declares validation_alias. session_type and
 * title are bare field names, so Python IGNORES a camelCase "sessionType"
 * (extra="ignore") and falls back to the default "agent" (measured 200 for
 * {"sessionType": "s"*33}). Spire binds only the declared field names.
 */
func parseAgentSessionCreate(ctx: HttpContext, root: JsonObject): ?AgentSessionCreateReq {
    let bag = PyBag()
    let parentRaw = jsonObjectToRaw(root)

    /* learner_id: UUID | None */
    var learner: ?Array<Byte> = None
    match (pyFieldOpt(root, "learner_id", "learnerId")) {
        case None => ()
        case Some(f) => learner = pyUuidField(bag, f)
    }
    /* session_type: str = Field(default="agent", max_length=32) */
    var sessionType = "agent"
    match (pyField(root, "session_type", "session_type")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 32)) {
                case Some(s) => sessionType = s
                case None => ()
            }
    }
    /* title: str | None = Field(max_length=255) — no min_length */
    var title: ?String = None
    match (pyFieldOpt(root, "title", "title")) {
        case None => ()
        case Some(f) => title = pyStr(bag, f, 0, 255)
    }

    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    pyDrop(parentRaw)
    return Some(AgentSessionCreateReq(learner, sessionType, title))
}

/* AgentSessionUpdateRequest: title required, 1-255. No strip/blank check (unlike CourseUpdateRequest). */
func parseAgentSessionUpdate(ctx: HttpContext, root: JsonObject): ?String {
    let bag = PyBag()
    let parentRaw = jsonObjectToRaw(root)
    var title: ?String = None
    match (pyField(root, "title", "title")) {
        case None => bag.add(pyMissing(["body", "title"], parentRaw))
        case Some(f) => title = pyStr(bag, f, 1, 255)
    }
    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return title
}

/*
 * AgentMessageCreateRequest. Declaration order: agent_id, kind, content.
 * agent_id and kind have no validation_alias — Python ignores a camelCase
 * "agentId" (extra="ignore", measured 200 for a 65-char agentId). Spire
 * binds only the declared field names.
 */
func parseAgentMessageCreate(ctx: HttpContext, root: JsonObject): ?AgentMessageCreateReq {
    let bag = PyBag()
    let parentRaw = jsonObjectToRaw(root)

    /* agent_id: str | None = Field(max_length=64) */
    var agentId: ?String = None
    match (pyFieldOpt(root, "agent_id", "agent_id")) {
        case None => ()
        case Some(f) => agentId = pyStr(bag, f, 0, 64)
    }
    /* kind: str = Field(default="agent", max_length=32) */
    var kind = "agent"
    match (pyField(root, "kind", "kind")) {
        case None => ()
        case Some(f) =>
            match (pyStr(bag, f, 0, 32)) {
                case Some(s) => kind = s
                case None => ()
            }
    }
    /* content: str = Field(min_length=1, max_length=10000) */
    var content = ""
    match (pyField(root, "content", "content")) {
        case None => bag.add(pyMissing(["body", "content"], parentRaw))
        case Some(f) =>
            match (pyStr(bag, f, 1, 10000)) {
                case Some(s) => content = s
                case None => ()
            }
    }

    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(AgentMessageCreateReq(agentId, kind, content))
}

/* AgentDecisionCreateRequest: stage 1-32, text 1-1000. Measured {"stage":null,"text":null} reports both. */
func parseAgentDecisionCreate(ctx: HttpContext, root: JsonObject): ?AgentDecisionCreateReq {
    let bag = PyBag()
    let parentRaw = jsonObjectToRaw(root)
    var stage = ""
    match (pyField(root, "stage", "stage")) {
        case None => bag.add(pyMissing(["body", "stage"], parentRaw))
        case Some(f) =>
            match (pyStr(bag, f, 1, 32)) {
                case Some(s) => stage = s
                case None => ()
            }
    }
    var text = ""
    match (pyField(root, "text", "text")) {
        case None => bag.add(pyMissing(["body", "text"], parentRaw))
        case Some(f) =>
            match (pyStr(bag, f, 1, 1000)) {
                case Some(s) => text = s
                case None => ()
            }
    }
    if (!bag.ok()) {
        bag.write(ctx.response)
        return None
    }
    return Some(AgentDecisionCreateReq(stage, text))
}
