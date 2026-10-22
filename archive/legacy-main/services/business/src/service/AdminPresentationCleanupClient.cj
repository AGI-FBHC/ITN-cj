package web.service

import std.env.getVariables
import std.net.*
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

public class AdminPresentationCleanupClient {
    private let baseUrl: String
    private let secret: String
    public init() {
        var url = "http://itn-agents:8000"; var key = ""
        for ((name, value) in getVariables()) {
            if (name == "AGENT_URL" && !value.trim().isEmpty()) { url = value.trim() }
            if (name == "AGENT_INTERNAL_SECRET") { key = value.trim() }
        }
        while (url.endsWith("/")) { url = String.fromUtf8(url.toArray().slice(0, url.toArray().size - 1)) }
        baseUrl = url; secret = key
    }
    public func purge(admin: User, id: String): Unit {
        if (secret.isEmpty()) { throw unavailable() }
        let path = "/internal/v1/admin/presentations/" + ProfileJson.uuid(id)
        let query = ""
        let timestamp = DateTime.nowUTC().toUnixTimeStamp().toSeconds().toString()
        let nonce = AuthUtilities.uuid().replace("-", "")
        let hash = SHA256(); hash.write(Array<UInt8>())
        let canonical = "DELETE\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + admin.getId() + "\n" + toHexString(hash.finish())
        let mac = HMAC(secret.toArray(), { => SHA256() }); mac.write(canonical.toArray())
        let client = ClientBuilder().autoRedirect(false).tlsConfig(TlsClientConfig()).readTimeout(Duration.second * 20)
            .writeTimeout(Duration.second * 20).connector({ address =>
                let socket = TcpSocket(address)
                try { socket.connect(timeout: Some(Duration.second * 5)); return socket }
                catch (e: Exception) { socket.close(); throw e }
            }).build()
        try {
            let request = HttpRequestBuilder().method("DELETE").url(baseUrl + path + query)
                .header("X-ITN-Timestamp", timestamp).header("X-ITN-Nonce", nonce).header("X-ITN-Signature", toHexString(mac.finish()))
                .header("X-ITN-User-Id", admin.getId()).header("X-ITN-Organization-Id", admin.getOrganizationId().getOrThrow())
                .header("X-ITN-Roles", "admin").build()
            let response = client.send(request)
            if (response.status == 404) { throw BusinessException(ErrorCode.KNOWLEDGE_ASSET_NOT_FOUND, 404, "交互课件不存在或不属于当前机构归档") }
            if (response.status < 200 || response.status >= 300) { throw unavailable() }
        } catch (e: BusinessException) { throw e } catch (_: Exception) { throw unavailable() }
        finally { client.close() }
    }
    private static func unavailable(): BusinessException {
        return BusinessException(ErrorCode.AGENT_SERVICE_UNAVAILABLE, 502, "交互课件文件清理失败，未执行彻底删除")
    }
    // Same UTF-8 application/x-www-form-urlencoded encoding as Java URLEncoder.
    private static func encode(value: String): String {
        let hex = "0123456789ABCDEF".toArray(); var result = ""
        for (byte in value.toArray()) {
            if ((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) ||
                byte == 45 || byte == 95 || byte == 46 || byte == 42) { result += String.fromUtf8([byte]) }
            else if (byte == 32) { result += "+" }
            else { result += "%" + String.fromUtf8([hex[Int64(byte / 16)], hex[Int64(byte % 16)]]) }
        }
        return result
    }
}
