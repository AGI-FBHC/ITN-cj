package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * HTTP handlers for the presentation-chat module. Path/method/status contracts
 * mirror src/agents/app/routers/public.py:1734-1790.
 *
 * In scope:
 *   POST   v1/presentations/{task_id}/chat/sessions
 *   GET    v1/presentations/{task_id}/chat/sessions
 *   GET    v1/presentations/{task_id}/chat/sessions/{session_id}/messages
 *   DELETE v1/presentations/{task_id}/chat/sessions/{session_id}   204
 *
 * _owned_presentation runs first on every route except DELETE (which relies on
 * store.delete's own owned() check), yielding 404 "Presentation task not found"
 * or 404 "Presentation chat session not found".
 */
public func registerPresentationChatRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapPost("v1/presentations/{task_id}/chat/sessions") {
        ctx => handleCreatePresentationChatSession(ctx, cfg)
    }
    app.mapGet("v1/presentations/{task_id}/chat/sessions") {
        ctx => handleListPresentationChatSessions(ctx, cfg)
    }
    app.mapGet("v1/presentations/{task_id}/chat/sessions/{session_id}/messages") {
        ctx => handleListPresentationChatMessages(ctx, cfg)
    }
    app.mapDelete("v1/presentations/{task_id}/chat/sessions/{session_id}") {
        ctx => handleDeletePresentationChatSession(ctx, cfg)
    }
}

/*
 * _owned_presentation (public.py:1734-1738): the caller-visible presentation
 * task, else 404 "Presentation task not found". Returns false once the 404 has
 * been written.
 */
func presentationTaskOwned(conn: MyConnection, ctx: HttpContext,
                           userId: Array<Byte>, taskId: Array<Byte>): Bool {
    let store = PresentationsStore(conn)
    match (store.get(userId, taskId)) {
        case None =>
            writeDetail(ctx.response, 404, "Presentation task not found")
            return false
        case Some(_) => return true
    }
}

func presentationChatSessionNotFound(ctx: HttpContext): Unit {
    writeDetail(ctx.response, 404, "Presentation chat session not found")
}

func handleCreatePresentationChatSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "task_id")) {
                case None => return
                case Some(taskId) =>
                    /* model_provider: str = "mimo" is an optional query param. */
                    var provider = "mimo"
                    match (queryParam(ctx.request, "model_provider")) {
                        case Some(raw) => provider = raw
                        case None => ()
                    }
                    let selected = if (provider.toAsciiLower() == "qwen") { "qwen" } else { "mimo" }
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                if (!presentationTaskOwned(conn, ctx, userId, taskId)) {
                                    conn.close()
                                    return
                                }
                                let store = PresentationChatStore(conn)
                                let raw = store.create(userId, taskId, selected)
                                conn.close()
                                writeJson(ctx.response, 200, raw)
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "createPresentationChatSession: " + e.message)
                            }
                    }
            }
    }
}

func handleListPresentationChatSessions(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "task_id")) {
                case None => return
                case Some(taskId) =>
                    match (openDb(cfg)) {
                        case None =>
                            writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                        case Some(conn) =>
                            try {
                                if (!presentationTaskOwned(conn, ctx, userId, taskId)) {
                                    conn.close()
                                    return
                                }
                                let store = PresentationChatStore(conn)
                                let items = store.list(userId, taskId)
                                conn.close()
                                let arr = JsonArrWriter()
                                for (item in items) {
                                    arr.addRaw(item)
                                }
                                writeJson(ctx.response, 200, arr.toJson())
                            } catch (e: Exception) {
                                conn.close()
                                writeInternalDebug(ctx.response, "listPresentationChatSessions: " + e.message)
                            }
                    }
            }
    }
}

func handleListPresentationChatMessages(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "task_id")) {
                case None => return
                case Some(taskId) =>
                    match (parseRouteUuid(ctx, "session_id")) {
                        case None => return
                        case Some(sessionId) =>
                            match (openDb(cfg)) {
                                case None =>
                                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                case Some(conn) =>
                                    try {
                                        if (!presentationTaskOwned(conn, ctx, userId, taskId)) {
                                            conn.close()
                                            return
                                        }
                                        let store = PresentationChatStore(conn)
                                        if (!store.owned(userId, taskId, sessionId)) {
                                            conn.close()
                                            presentationChatSessionNotFound(ctx)
                                            return
                                        }
                                        let raw = store.messages(sessionId)
                                        conn.close()
                                        writeJson(ctx.response, 200, raw)
                                    } catch (e: Exception) {
                                        conn.close()
                                        writeInternalDebug(ctx.response, "listPresentationChatMessages: " + e.message)
                                    }
                            }
                    }
            }
    }
}

func handleDeletePresentationChatSession(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUser(ctx.request, ctx.response, cfg.jwtSecret)) {
        case None => return
        case Some(userId) =>
            match (parseRouteUuid(ctx, "task_id")) {
                case None => return
                case Some(taskId) =>
                    match (parseRouteUuid(ctx, "session_id")) {
                        case None => return
                        case Some(sessionId) =>
                            match (openDb(cfg)) {
                                case None =>
                                    writeInternalDebug(ctx.response, "openDb failed: " + lastDbError)
                                case Some(conn) =>
                                    try {
                                        let store = PresentationChatStore(conn)
                                        let deleted = store.delete(userId, taskId, sessionId)
                                        conn.close()
                                        if (deleted) {
                                            ctx.response.statusCode = 204
                                        } else {
                                            presentationChatSessionNotFound(ctx)
                                        }
                                    } catch (e: Exception) {
                                        conn.close()
                                        writeInternalDebug(ctx.response, "deletePresentationChatSession: " + e.message)
                                    }
                            }
                    }
            }
    }
}
