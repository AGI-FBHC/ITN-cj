package web.service

import std.collection.*
import std.env.getVariables
import std.net.*
import std.regex.Regex
import std.time.*
import std.unicode.*
import stdx.crypto.digest.*
import stdx.encoding.hex.toHexString
import stdx.net.http.ClientBuilder
import stdx.net.http.HttpRequestBuilder
import stdx.net.tls.TlsClientConfig
import web.domain.User
import web.exception.*
import web.security.AuthUtilities

public class KnowledgeGatewayResponse {
    public let status: UInt16
    public let body: Array<UInt8>
    public let mime: Option<String>
    public let requestId: Option<String>
    public init(status: UInt16, body: Array<UInt8>, mime: Option<String>, requestId: Option<String>) {
        this.status = status; this.body = body; this.mime = mime; this.requestId = requestId
    }
}

// Spring business-layer migration: authenticate and forward existing KnowledgeCore contracts.
public class AdminKnowledgeGateway {
    private let baseUrl: String
    private let secret: String
    public init() {
        var url = "http://127.0.0.1:8010"; var key = ""
        for ((name, value) in getVariables()) {
            if (name == "KNOWLEDGE_CORE_URL" && !value.trim().isEmpty()) { url = value.trim() }
            if (name == "KC_INTERNAL_SECRET") { key = value.trim() }
        }
        while (url.endsWith("/")) { url = String.fromUtf8(url.toArray().slice(0, url.toArray().size - 1)) }
        if (!(url.startsWith("http://") || url.startsWith("https://")) || url.contains("?") || url.contains("#")) {
            throw IllegalArgumentException("KNOWLEDGE_CORE_URL must be an HTTP(S) base URL")
        }
        baseUrl = url; secret = key
    }
    public func forward(user: User, method: String, suffix: String, query: String, contentType: Option<String>, accept: Option<String>,
        bytes: Array<UInt8>, requestedId: Option<String>): KnowledgeGatewayResponse {
        allow(method, suffix)
        let path = if (suffix == "/health") { "/health" } else { "/api/v1" + suffix }
        let requestId = normalizeRequestId(requestedId)
        let client = ClientBuilder().autoRedirect(false).tlsConfig(TlsClientConfig()).readTimeout(Duration.minute * 30)
            .writeTimeout(Duration.minute * 30).connector({ address =>
                let socket = TcpSocket(address)
                try { socket.connect(timeout: Some(Duration.second * 10)); return socket }
                catch (e: Exception) { socket.close(); throw e }
            }).build()
        try {
            let builder = HttpRequestBuilder().method(method).url(baseUrl + path + query)
                .header("X-Request-Id", requestId).header("X-ITN-User-Id", user.getId())
                .header("X-ITN-Organization-Id", user.getOrganizationId().getOrThrow()).header("X-ITN-Roles", "admin")
            if (let Some(value) <- contentType) { if (!value.trim().isEmpty()) { builder.header("Content-Type", value) } }
            if (let Some(value) <- accept) { if (!value.trim().isEmpty()) { builder.header("Accept", value) } }
            if (!bytes.isEmpty()) { builder.body(bytes) }
            if (!secret.isEmpty()) {
                let timestamp = DateTime.nowUTC().toUnixTimeStamp().toSeconds().toString()
                let nonce = AuthUtilities.uuid().replace("-", "")
                let hash = SHA256(); hash.write(bytes)
                let canonical = method.toUpper(CasingOption.Other) + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" +
                    user.getId() + "\n" + toHexString(hash.finish())
                let mac = HMAC(secret.toArray(), { => SHA256() }); mac.write(canonical.toArray())
                builder.header("X-ITN-Timestamp", timestamp).header("X-ITN-Nonce", nonce).header("X-ITN-Signature", toHexString(mac.finish()))
            }
            let response = client.send(builder.build())
            let buffer = Array<UInt8>(65536, repeat: 0); let body = ArrayList<UInt8>()
            while (true) {
                let count = response.body.read(buffer)
                if (count == 0) { break }
                for (i in 0..count) { body.add(buffer[i]) }
            }
            return KnowledgeGatewayResponse(response.status, body.toArray(), response.headers.getFirst("Content-Type"), response.headers.getFirst("X-Request-Id"))
        } catch (e: BusinessException) { throw e }
        catch (_: Exception) { throw BusinessException(ErrorCode.AGENT_SERVICE_UNAVAILABLE, 502, "上游知识服务不可用") }
        finally { client.close() }
    }
    public static func allow(method: String, path: String): Unit {
        let reads = ["/health", "/knowledge/categories", "/knowledge/coverage", "/knowledge/chunks", "/knowledge/chunks/by-ids",
            "/knowledge/classifications/audit", "/knowledge/graph/edges", "/knowledge/documents"]
        let writes = ["/knowledge/classifications/correct", "/knowledge/graph/validate", "/knowledge/graph/prerequisites",
            "/knowledge/graph/review"]
        if (method == "GET") {
            for (item in reads) { if (item == path) { return } }
            if (Regex("^/knowledge/documents/[A-Za-z0-9_-]+(/chunks)?$").matches(path)) { return }
        }
        if (method == "POST") {
            for (item in writes) { if (item == path) { return } }
            if (Regex("^/knowledge/graph/edges/[0-9]+/(approve|reject|reverse)$").matches(path)) { return }
        }
        if (method == "DELETE" && Regex("^/knowledge/graph/edges/[0-9]+$").matches(path)) { return }
        throw BusinessException(ErrorCode.UNAUTHORIZED, 403, "该内部服务路径未在平台白名单中开放")
    }
    private static func normalizeRequestId(requested: Option<String>): String {
        let value = requested.getOrDefault({ => "" })
        if (value.trim().isEmpty()) { return AuthUtilities.uuid() }
        let bytes = value.toArray(); var length = if (bytes.size > 64) { 64 } else { bytes.size }
        while (length > 0) {
            try { return String.fromUtf8(bytes.slice(0, length)) } catch (_: Exception) { length -= 1 }
        }
        return AuthUtilities.uuid()
    }
}
