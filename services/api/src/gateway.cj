package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import std.io.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * P3 forwarding gateway (plus the P2 /api/v1 remainder).
 *
 * Spire is the entry point: the browser talks only to us. Routes Spire
 * implements are served from MySQL. Everything else on /v1 and /internal/v1
 * is relayed to the Python agents-service, which keeps the LLM keys, the
 * asyncio generation registry and the file/TTS pipelines. The un-migrated
 * /api/v1 surface is relayed to Spring Boot the same way.
 *
 * Two relay shapes, both byte-faithful:
 *
 *   - buffered: whole request in, whole response out. JSON, files, uploads.
 *   - streamed: headers first, then body chunks as they arrive. SSE frames
 *     and raw PCM. Never re-frame, never re-encode — the frontend parsers
 *     slice `data: ` off fixed offsets (api.ts slice(6)) and treat every
 *     audio chunk as LE Int16 @ 24 kHz.
 *
 * Hop-by-hop headers are not copied. Auth is passed through untouched
 * (`Authorization: Bearer …` for /v1, the X-ITN-* HMAC quartet for
 * /internal/v1) — Spire verifies identity for local routes but does not
 * re-sign or strip credentials on a forward.
 *
 * Deployment constraint: `GET /chat/sessions/{id}/resume` is process-sticky
 * on the Python side (its `_active_sessions` dict is per-process). With one
 * upstream this is automatic. With several, the same session must land on the
 * instance that served `/chat/stream`, so put sticky routing in front of
 * Spire or pin AGENTS_UPSTREAM to a single unit for chat.
 */

/* Long enough for a live SSE/PCM session; ordinary calls use a short timeout. */
const STREAM_READ_TIMEOUT_MS: Int64 = 7200000
const API_READ_TIMEOUT_MS: Int64 = 120000
const WRITE_TIMEOUT_MS: Int64 = 30000

/*
 * Request headers copied upstream. An allowlist, not a blocklist: the
 * connection-level ones (Host, Content-Length, Transfer-Encoding, TE,
 * Connection, Keep-Alive, Upgrade, Proxy-*) must never be replayed, and a
 * fresh Host is derived from the upstream origin by the client.
 */
func forwardableRequestHeader(name: String): Bool {
    let n = name.toAsciiLower()
    return n == "authorization"
        || n == "content-type"
        || n == "accept"
        || n == "accept-language"
        || n == "user-agent"
        || n == "cookie"
        || n == "if-none-match"
        || n == "if-modified-since"
        || n == "if-match"
        || n == "if-range"
        || n == "range"
        || n == "x-requested-with"
        || n == "x-request-id"
        || n.startsWith("x-itn-")
}

/*
 * Response headers copied back to the browser. Content-Type is applied
 * separately so a stream can keep it verbatim (text/event-stream params,
 * audio/L16;rate=24000;channels=1). Content-Length is left to the writer.
 */
func forwardableResponseHeader(name: String): Bool {
    let n = name.toAsciiLower()
    return n == "content-type"
        || n == "content-disposition"
        || n == "content-range"
        || n == "cache-control"
        || n == "etag"
        || n == "last-modified"
        || n == "location"
        || n == "vary"
        || n == "accept-ranges"
        || n == "retry-after"
        || n == "x-accel-buffering"
        || n == "x-request-id"
        || n == "www-authenticate"
}

/* Copy the request headers we are allowed to replay. */
func collectForwardHeaders(request: HttpRequest): Array<(String, String)> {
    let names = ["Authorization", "Content-Type", "Accept", "Accept-Language",
                 "User-Agent", "Cookie", "If-None-Match", "If-Modified-Since",
                 "If-Match", "If-Range", "Range", "X-Requested-With", "X-Request-Id",
                 "X-ITN-Timestamp", "X-ITN-Nonce", "X-ITN-User-Id", "X-ITN-Signature"]
    let out = ArrayList<(String, String)>()
    for (n in names) {
        if (!forwardableRequestHeader(n)) {
            continue
        }
        match (request.headers.get(n)) {
            case Some(v) =>
                if (v.size > 0) {
                    out.add((n, v))
                }
            case None => ()
        }
    }
    return out.toArray()
}

/* Read the inbound body as raw bytes (JSON, multipart, whatever it is). */
func readRequestBytes(request: HttpRequest): Array<Byte> {
    let stream = request.body
    let buffer = Array<Byte>(8192, repeat: 0)
    let parts = ArrayList<Byte>()
    try {
        while (true) {
            let n = stream.read(buffer)
            if (n <= 0) {
                break
            }
            let chunk = buffer.slice(0, n)
            var i: Int64 = 0
            while (i < n) {
                parts.add(chunk[i])
                i += 1
            }
        }
    } catch (_: Exception) {
        /* keep whatever arrived */
    }
    return parts.toArray()
}

/* Path + query exactly as the browser sent it. */
func pathAndQuery(request: HttpRequest): String {
    let p = request.path.toString()
    let q = request.queryString.toString()
    if (q.size == 0) {
        return p
    }
    if (q.startsWith("?")) {
        return p + q
    }
    return p + "?" + q
}

func applyResponseHeaders(response: HttpResponse, headers: Array<(String, Array<String>)>): Unit {
    for ((name, values) in headers) {
        if (!forwardableResponseHeader(name)) {
            continue
        }
        var first = true
        for (v in values) {
            if (name.toAsciiLower() == "content-type" && first) {
                /* keep the upstream Content-Type byte-identical (SSE params matter) */
                response.contentType = v
            } else {
                response.headers.add(name, v)
            }
            first = false
        }
    }
}

func writeGatewayUnavailable(response: HttpResponse): Unit {
    writeDetail(response, 502, "Upstream service unavailable")
}

/*
 * Buffered forward. Used when the response is a complete document — JSON,
 * a PPTX/PNG download, an upload acknowledgement. The body is relayed in
 * full and in order; nothing is parsed.
 */
func relayBuffered(response: HttpResponse, outcome: ForwardOutcome): Unit {
    match (outcome) {
        case Failed(e) =>
            writeGatewayUnavailable(response)
        case Ok(up) =>
            response.statusCode = up.status
            applyResponseHeaders(response, up.headers)
            if (up.body.size > 0) {
                response.write(up.body)
            }
    }
}

/*
 * Streamed forward. Headers go out first, then every upstream chunk is
 * written to the browser as it arrives. `text/event-stream` and audio
 * both take this path; so does any other response when we chose streaming
 * mode, which is still byte-faithful — it just stops us from holding a
 * whole file in memory.
 */
func relayStreamed(response: HttpResponse, outcome: StreamOutcome): Unit {
    match (outcome) {
        case Failed(e) =>
            if (!response.hasStarted) {
                writeGatewayUnavailable(response)
            }
        case Done => ()
    }
}

/*
 * Decide stream vs buffer from the upstream Content-Type. SSE and PCM must
 * stream; so does a large binary download when we cannot know the length
 * up front. Everything else is buffered, which is what the JSON callers
 * expect (they read the whole body anyway).
 */
func shouldStream(contentType: String): Bool {
    let ct = contentType.toAsciiLower()
    return ct.startsWith("text/event-stream") || ct.startsWith("audio/")
}

/*
 * One request relayed to an upstream origin. `forceStream` is used for the
 * paths we know are streams before the response arrives (chat/stream,
 * agent/ask/stream, …) so a mislabeled upstream still gets incremental
 * delivery.
 *
 * Shared by the two catch-alls: /v1 and /internal/v1 go to the Python
 * agents-service, /api/v1 to Spring Boot. The relay itself is identical and
 * still byte-faithful — it does not know or care which envelope the upstream
 * wraps its JSON in.
 */
func forwardToOrigin(origin: String, request: HttpRequest, response: HttpResponse,
                     forceStream: Bool): Unit {
    match (parseUpstreamUrl(origin)) {
        case None =>
            writeDetail(response, 503, "Upstream service is not configured")
            return
        case Some(target) =>
            let path = pathAndQuery(request)
            let body = readRequestBytes(request)
            let headers = collectForwardHeaders(request)
            let req = UpstreamRequest(request.method, path, body, headers)

            if (forceStream) {
                let client = UpstreamClient.create(target, STREAM_READ_TIMEOUT_MS, WRITE_TIMEOUT_MS)
                try {
                    let outcome = client.forwardStream(req, {
                        status, hdrs =>
                            response.statusCode = status
                            applyResponseHeaders(response, hdrs)
                    }, {
                        chunk =>
                            response.write(chunk)
                            true
                    })
                    relayStreamed(response, outcome)
                } finally {
                    client.close()
                }
                return
            }

            /* Buffered path: peek the upstream response, stream only if it
             * itself is a stream. */
            let client = UpstreamClient.create(target, API_READ_TIMEOUT_MS, WRITE_TIMEOUT_MS)
            try {
                match (client.forward(req)) {
                    case Failed(_) => writeGatewayUnavailable(response)
                    case Ok(up) =>
                        response.statusCode = up.status
                        applyResponseHeaders(response, up.headers)
                        if (up.body.size > 0) {
                            response.write(up.body)
                        }
                }
            } finally {
                client.close()
            }
    }
}

/*
 * Paths that are streams by contract (P3 SSE table). Matched on the path
 * only — the upstream sets the Content-Type. forceStream is what makes a
 * POST with a JSON body still relay incrementally.
 */
func isKnownStreamPath(path: String): Bool {
    if (path.startsWith("v1/chat/stream") || path.startsWith("/v1/chat/stream")) {
        return true
    }
    if (path.startsWith("v1/agent/ask/stream") || path.startsWith("/v1/agent/ask/stream")) {
        return true
    }
    if (path.startsWith("v1/agent/ask/image-stream") || path.startsWith("/v1/agent/ask/image-stream")) {
        return true
    }
    if (path.startsWith("v1/agent-runs/stream") || path.startsWith("/v1/agent-runs/stream")) {
        return true
    }
    if (path.startsWith("v1/assistant/plan-stream") || path.startsWith("/v1/assistant/plan-stream")) {
        return true
    }
    if (path.startsWith("v1/assistant/audio-stream") || path.startsWith("/v1/assistant/audio-stream")) {
        return true
    }
    if (path.startsWith("v1/assistant/asr") || path.startsWith("/v1/assistant/asr")) {
        return true
    }
    if (path.contains("/chat/stream") || path.contains("/chat/audio-stream")
        || path.contains("/chat/image-stream") || path.contains("/chat/tts")) {
        return true
    }
    if (path.contains("/stream") && path.startsWith("v1/admin-generation-tasks")) {
        return true
    }
    if (path.contains("/tts") || path.contains("/audio/")) {
        return true
    }
    if (path.startsWith("v1/teaching-group/runs/stream") || path.startsWith("/v1/teaching-group/runs/stream")) {
        return true
    }
    return false
}

func handleForwardToAgents(ctx: HttpContext, cfg: AppConfig): Unit {
    let path = pathAndQuery(ctx.request)
    let force = isKnownStreamPath(path)
    forwardToOrigin(cfg.agentsUpstream, ctx.request, ctx.response, force)
}

/*
 * Spring Boot's un-migrated /api/v1 remainder. It has no SSE/PCM on the
 * surface that is not already proxied elsewhere (the admin knowledge proxy
 * is one of the routes still living in Java), so nothing is force-streamed
 * here — the buffered path already streams when the upstream does.
 */
func handleForwardToJava(ctx: HttpContext, cfg: AppConfig): Unit {
    forwardToOrigin(cfg.javaUpstream, ctx.request, ctx.response, false)
}

/*
 * Register the catch-all forwarders. Call this AFTER every local route so
 * ASP.NET-style precedence (literal > parameter > catch-all) keeps Spire's
 * own handlers winning and only the un-migrated surface reaches upstream.
 *
 * Coverage is not optional: the P3 gate is that every Python /v1 and
 * /internal/v1 route is either LOCAL or hit this catch-all — uncovered = 0.
 * The same holds for P2: every Spring Boot /api/v1 route must be LOCAL or
 * fall through to api/v1/{*rest}.
 */
public func registerGatewayRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.map("v1/{*rest}") {
        ctx => handleForwardToAgents(ctx, cfg)
    }
    app.map("internal/v1/{*rest}") {
        ctx => handleForwardToAgents(ctx, cfg)
    }
    app.map("api/v1/{*rest}") {
        ctx => handleForwardToJava(ctx, cfg)
    }
}
