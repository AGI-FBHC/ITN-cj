package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import std.io.*
import std.net.*
import std.time.*
import stdx.net.http.*

/*
 * Outbound HTTP client for the forwarding gateway (P3 / task B-a).
 *
 * Spire is a pure data plane: it has no LLM keys and never calls a model. What
 * it does need is the ability to hand a request to the Python microservices
 * that do (agents-service :8000 and friends) and give the browser back exactly
 * what those services produced. Two shapes matter:
 *
 *   - plain request/response (JSON, file, multipart upload) — `UpstreamClient.forward`
 *   - a long-lived byte stream (SSE frames, raw PCM audio)  — `UpstreamClient.forwardStream`
 *
 * The second one is why this is not just a `request()` call: SSE has to be
 * relayed frame by frame as it arrives. `Client.connect()` returns the response
 * headers plus a `StreamingSocket` we can pump, which is exactly that shape.
 *
 * Nothing here rewrites a body. Byte-faithfulness is a hard requirement — the
 * frontend parsers slice `data: ` off fixed offsets and `JSON.parse` the rest,
 * so any re-encoding or re-framing breaks them.
 */

/* Target Python unit, e.g. agents-service at http://127.0.0.1:8000. */
public struct UpstreamTarget {
    public let scheme: String
    public let host: String
    public let port: UInt16

    public init(scheme: String, host: String, port: UInt16) {
        this.scheme = scheme
        this.host = host
        this.port = port
    }

    public func origin(): String {
        scheme + "://" + host + ":" + port.toString()
    }
}

/* Parse "http://host:port" / "https://host" into an UpstreamTarget. */
public func parseUpstreamUrl(url: String): ?UpstreamTarget {
    var rest = url.trimAscii()
    var scheme = "http"
    if (rest.startsWith("https://")) {
        scheme = "https"
        rest = rest[8..rest.size]
    } else if (rest.startsWith("http://")) {
        rest = rest[7..rest.size]
    }
    /* strip any path — the caller always supplies the request path itself */
    var hostPort = rest
    match (rest.indexOf("/")) {
        case Some(slash) => hostPort = rest[0..slash]
        case None => ()
    }
    if (hostPort.size == 0) {
        return None
    }
    var host = hostPort
    var port: Int64 = 80
    if (scheme == "https") {
        port = 443
    }
    match (hostPort.indexOf(":")) {
        case Some(colon) =>
            host = hostPort[0..colon]
            match (Int64.tryParse(hostPort[(colon + 1)..hostPort.size])) {
                case Some(p) => port = p
                case None => return None
            }
        case None => ()
    }
    if (host.size == 0 || port <= 0 || port > 65535) {
        return None
    }
    return Some(UpstreamTarget(scheme, host, UInt16(port)))
}

/*
 * A request as the gateway wants to send it. Built from the inbound request by
 * `forwardRequestShape`, then handed to the client. Keeping this separate from
 * the soulsoft `HttpRequest` means the client module does not depend on the
 * web-hosting types and can be exercised on its own.
 */
public struct UpstreamRequest {
    public let method: String
    /* path plus query string, e.g. "/v1/chat/stream?x=1" */
    public let pathAndQuery: String
    public let body: Array<Byte>
    /* single-value headers to copy through (Authorization, Content-Type, ...) */
    public let headers: Array<(String, String)>

    public init(method: String, pathAndQuery: String, body: Array<Byte>,
                headers: Array<(String, String)>) {
        this.method = method
        this.pathAndQuery = pathAndQuery
        this.body = body
        this.headers = headers
    }
}

/* Buffered upstream response. */
public struct UpstreamResponse {
    public let status: UInt16
    public let headers: Array<(String, Array<String>)>
    public let body: Array<Byte>

    public init(status: UInt16, headers: Array<(String, Array<String>)>, body: Array<Byte>) {
        this.status = status
        this.headers = headers
        this.body = body
    }
}

/*
 * Error from the upstream call itself (connection refused, timeout, DNS). This
 * is NOT an upstream 4xx/5xx — those are ordinary UpstreamResponse values and
 * must be relayed verbatim so the browser sees the Python error shape.
 */
public struct UpstreamError {
    public let message: String

    public init(message: String) {
        this.message = message
    }
}

/* Result of a plain forward. */
public enum ForwardOutcome {
    Ok(UpstreamResponse) | Failed(UpstreamError)
}

/* Result of a streaming forward. `Done` means the relay ran to completion. */
public enum StreamOutcome {
    Done | Failed(UpstreamError)
}

public class UpstreamClient {
    private let target: UpstreamTarget
    private let client: Client

    private init(target: UpstreamTarget, client: Client) {
        this.target = target
        this.client = client
    }

    public static func create(target: UpstreamTarget, readTimeoutMs: Int64,
                              writeTimeoutMs: Int64): UpstreamClient {
        let builder = ClientBuilder()
        builder.readTimeout(Duration.millisecond * readTimeoutMs)
        builder.writeTimeout(Duration.millisecond * writeTimeoutMs)
        return UpstreamClient(target, builder.build())
    }

    public func origin(): String {
        target.origin()
    }

    private func buildRequest(req: UpstreamRequest): HttpRequest {
        let builder = HttpRequestBuilder()
        builder.method(req.method)
        builder.url(target.origin() + req.pathAndQuery)
        for (h in req.headers) {
            builder.header(h[0], h[1])
        }
        if (req.body.size > 0) {
            builder.body(req.body)
        }
        return builder.build()
    }

    private static func collectHeaders(h: HttpHeaders): Array<(String, Array<String>)> {
        let out = ArrayList<(String, Array<String>)>()
        /* Iterator has no hasNext; for-in drives next() via iterator(). */
        for ((name, values) in h.iterator()) {
            out.add((name, values.toArray()))
        }
        return out.toArray()
    }

    /*
     * Plain forward: send the whole request, buffer the whole response. Use for
     * JSON, file downloads and multipart uploads — everything that is not a
     * live stream.
     */
    public func forward(req: UpstreamRequest): ForwardOutcome {
        try {
            let resp = client.send(buildRequest(req))
            let bodyStream = resp.body
            let buffer = Array<Byte>(8192, repeat: 0)
            let parts = ArrayList<Byte>()
            while (true) {
                let n = bodyStream.read(buffer)
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
            let out = UpstreamResponse(resp.status, collectHeaders(resp.headers), parts.toArray())
            try {
                resp.close()
            } catch (_: Exception) {
                ()
            }
            return ForwardOutcome.Ok(out)
        } catch (e: Exception) {
            return ForwardOutcome.Failed(UpstreamError("upstream " + target.origin() + " failed: " + e.message))
        }
    }

    /*
     * Streaming forward: send the request, hand the caller the response
     * headers, then relay body bytes as they arrive. `onChunk` receives each
     * chunk and writes it to the browser; returning `false` stops the relay
     * (client went away).
     *
     * Used for SSE and for raw PCM audio. The chunk boundaries here are NOT
     * frame boundaries — never re-chunk on top of this.
     *
     * `Client.send` exposes the body as an `InputStream`, which is what we
     * pump. `Client.connect`/`upgrade` return a raw `StreamingSocket` but only
     * for GET-without-body / protocol-upgrade shapes; POST SSE (chat/stream)
     * has a body, so the body stream is the general path.
     */
    public func forwardStream(req: UpstreamRequest,
                              onHeaders: (UInt16, Array<(String, Array<String>)>) -> Unit,
                              onChunk: (Array<Byte>) -> Bool): StreamOutcome {
        var opened: ?HttpResponse = None
        try {
            let resp = client.send(buildRequest(req))
            opened = Some(resp)
            onHeaders(resp.status, collectHeaders(resp.headers))
            drainStream(resp.body, onChunk)
            return StreamOutcome.Done
        } catch (e: Exception) {
            return StreamOutcome.Failed(UpstreamError("upstream stream " + target.origin() + " failed: " + e.message))
        } finally {
            match (opened) {
                case Some(r) =>
                    try {
                        r.close()
                    } catch (_: Exception) {
                        ()
                    }
                case None => ()
            }
        }
    }

    public func close(): Unit {
        try {
            client.close()
        } catch (_: Exception) {
            ()
        }
    }
}

private func drainStream(stream: InputStream, onChunk: (Array<Byte>) -> Bool): Unit {
    let buffer = Array<Byte>(4096, repeat: 0)
    try {
        while (true) {
            let n = stream.read(buffer)
            if (n <= 0) {
                break
            }
            if (!onChunk(buffer.slice(0, n))) {
                break
            }
        }
    } catch (_: Exception) {
        ()
    }
}
