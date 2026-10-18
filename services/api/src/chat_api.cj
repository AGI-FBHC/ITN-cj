package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * HTTP handlers for the chat-session module. Path/method/status/body contracts
 * mirror src/agents/app/routers/public.py so the existing frontend can point
 * at this service unchanged.
 *
 * In scope:
 *   POST   v1/chat/sessions                              200 session
 *   GET    v1/chat/sessions                              ?archived=<bool>
 *   GET    v1/chat/sessions/{session_id}/messages
 *   PUT    v1/chat/sessions/{session_id}/rename
 *   PUT    v1/chat/sessions/{session_id}/archive
 *   DELETE v1/chat/sessions/{session_id}                 204
 *
 * 404 detail is always "Chat session not found"; a missing platform DB is a
 * 503 "Chat session storage is not configured" (public.py require_chat_store).
 */
public func registerChatRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapPost("v1/chat/sessions") {
        ctx => handleCreateChatSession(ctx, cfg)
    }
    app.mapGet("v1/chat/sessions") {
        ctx => handleListChatSessions(ctx, cfg)
    }
    app.mapGet("v1/chat/sessions/{session_id}/messages") {
        ctx => handleListChatMessages(ctx, cfg)
    }
    app.mapPut("v1/chat/sessions/{session_id}/rename") {
        ctx => handleRenameChatSession(ctx, cfg)
    }
    app.mapPut("v1/chat/sessions/{session_id}/archive") {
        ctx => handleArchiveChatSession(ctx, cfg)
    }
    app.mapDelete("v1/chat/sessions/{session_id}") {
        ctx => handleDeleteChatSession(ctx, cfg)
    }
}

func chatSessionNotFound(ctx: HttpContext): Unit {
    writeDetail(ctx.response, 404, "Chat session not found")
}

func chatStorageNotConfigured(ctx: HttpContext): Unit {
    writeDetail(ctx.response, 503, "Chat session storage is not configured")
}

func handleCreateChatSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            if (storageUnavailable(cfg)) {
                chatStorageNotConfigured(ctx)
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        let store = ChatSessionsStore(conn)
                        let raw = store.createSession(userId)
                        conn.close()
                        writeJson(ctx.response, 200, raw)
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "createChatSession: " + e.message)
                    }
            }
    }
}

func handleListChatSessions(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            var archived = false
            match (queryBoolParam(ctx.request, "archived")) {
                case BoolParamResult.Missing => ()
                case BoolParamResult.Value(v) => archived = v
                case BoolParamResult.Bad(raw) =>
                    writePyType422(ctx.response, ["query", "archived"], "bool_parsing",
                                   "Input should be a valid boolean, unable to interpret input",
                                   jsonQuote(raw))
                    return
            }
            if (storageUnavailable(cfg)) {
                chatStorageNotConfigured(ctx)
                return
            }
            match (openDb(cfg)) {
                case None =>
                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                case Some(conn) =>
                    try {
                        let store = ChatSessionsStore(conn)
                        let items = store.listSessions(userId, archived)
                        conn.close()
                        let arr = JsonArrWriter()
                        for (item in items) {
                            arr.addRaw(item)
                        }
                        let obj = JsonWriter()
                        obj.putRaw("sessions", arr.toJson())
                        writeJson(ctx.response, 200, obj.toJson())
                    } catch (e: Exception) {
                        conn.close()
                        writeInternalDebug(ctx.response, "listChatSessions: " + e.message)
                    }
            }
    }
}

func handleListChatMessages(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    if (storageUnavailable(cfg)) {
                        chatStorageNotConfigured(ctx)
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let store = ChatSessionsStore(conn)
                                match (store.getSession(userId, sessionId)) {
                                    case None =>
                                        conn.close()
                                        chatSessionNotFound(ctx)
                                    case Some(_) =>
                                        let raw = store.listMessages(sessionId)
                                        conn.close()
                                        let obj = JsonWriter()
                                        obj.putRaw("messages", raw)
                                        writeJson(ctx.response, 200, obj.toJson())
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "listChatMessages: " + e.message)
                            }
                    }
            }
    }
}

func handleRenameChatSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    match (readChatDictBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (chatRenameTitle(ctx, root)) {
                                case None => return
                                case Some(title) =>
                                    if (storageUnavailable(cfg)) {
                                        chatStorageNotConfigured(ctx)
                                        return
                                    }
                                    match (openDb(cfg)) {
                                        case None =>
                                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                        case Some(conn) =>
                                            try {
                                                let store = ChatSessionsStore(conn)
                                                match (store.getSession(userId, sessionId)) {
                                                    case None =>
                                                        conn.close()
                                                        chatSessionNotFound(ctx)
                                                    case Some(_) =>
                                                        match (store.renameSession(userId, sessionId, title)) {
                                                            case None =>
                                                                conn.close()
                                                                chatSessionNotFound(ctx)
                                                            case Some(raw) =>
                                                                conn.close()
                                                                writeJson(ctx.response, 200, raw)
                                                        }
                                                }
                                            } catch (e: Exception) {
                                                conn.close()
                                                writeInternalDebug(ctx.response, "renameChatSession: " + e.message)
                                            }
                                    }
                            }
                    }
            }
    }
}

func handleArchiveChatSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    match (readChatDictBody(ctx)) {
                        case None => return
                        case Some(root) =>
                            match (chatArchivedField(ctx, root)) {
                                case None => return
                                case Some(archived) =>
                                    if (storageUnavailable(cfg)) {
                                        chatStorageNotConfigured(ctx)
                                        return
                                    }
                                    match (openDb(cfg)) {
                                        case None =>
                                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                        case Some(conn) =>
                                            try {
                                                let store = ChatSessionsStore(conn)
                                                match (store.setArchived(userId, sessionId, archived)) {
                                                    case None =>
                                                        conn.close()
                                                        chatSessionNotFound(ctx)
                                                    case Some(raw) =>
                                                        conn.close()
                                                        writeJson(ctx.response, 200, raw)
                                                }
                                            } catch (e: Exception) {
                                                conn.close()
                                                writeInternalDebug(ctx.response, "archiveChatSession: " + e.message)
                                            }
                                    }
                            }
                    }
            }
    }
}

func handleDeleteChatSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "session_id")) {
                case None => return
                case Some(sessionId) =>
                    if (storageUnavailable(cfg)) {
                        chatStorageNotConfigured(ctx)
                        return
                    }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                let store = ChatSessionsStore(conn)
                                let deleted = store.deleteSession(userId, sessionId)
                                conn.close()
                                if (deleted) {
                                    ctx.response.statusCode = 204
                                } else {
                                    chatSessionNotFound(ctx)
                                }
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "deleteChatSession: " + e.message)
                            }
                    }
            }
    }
}

/* -------- request validation -------- */

/*
 * The rename/archive bodies are bare `body: dict` parameters, so FastAPI
 * validates them before the handler runs and the failures carry the pydantic
 * array shape rather than {"detail": "..."}: zero bytes -> missing, bad JSON ->
 * json_invalid, non-object -> dict_type, an explicit null -> missing. Same
 * shape as public.py's batch-delete payload (see presentations_api.cj).
 */
func readChatDictBody(ctx: HttpContext): ?JsonObject {
    let body = readBodyText(ctx.request)
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
            writeFastApi422(ctx.response, ["body"], "dict_type",
                            "Input should be a valid dictionary", "{}", None)
            return None
        case Some(pv) =>
            match (pv.kind()) {
                case JsonKind.JsNull =>
                    writeFastApi422(ctx.response, ["body"], "missing",
                                    "Field required", "null", None)
                    return None
                case _ => ()
            }
            if (!isJsObject(pv)) {
                writeFastApi422(ctx.response, ["body"], "dict_type",
                                "Input should be a valid dictionary", valueToRaw(pv), None)
                return None
            }
            return Some(pv.asObject())
    }
}

/*
 * public.py rename: `title = (body.get("title") or "").strip()`; blank ->
 * HTTPException 422 {"detail": "Title is required"} (not the pydantic array).
 * Python's `or ""` makes every falsy value fall back to "", while a truthy
 * non-string reaches .strip() and dies as a 500 — reproduced here.
 */
func chatRenameTitle(ctx: HttpContext, root: JsonObject): ?String {
    var title = ""
    match (root.get("title")) {
        case None => ()
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsString => title = pyStrip(v.asString().getValue())
                case _ =>
                    if (jsonValTruthy(v)) {
                        writeInternalError(ctx.response)
                        return None
                    }
            }
    }
    if (title.isEmpty()) {
        writeDetail(ctx.response, 422, "Title is required")
        return None
    }
    return Some(title)
}

/* `isinstance(archived, bool)` — only a JSON literal true/false passes. */
func chatArchivedField(ctx: HttpContext, root: JsonObject): ?Bool {
    match (root.get("archived")) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsBool => return Some(v.asBool().getValue())
                case _ => ()
            }
        case None => ()
    }
    writeDetail(ctx.response, 422, "Archived must be a boolean")
    return None
}
