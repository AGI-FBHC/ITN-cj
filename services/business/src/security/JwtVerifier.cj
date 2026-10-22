package web.security

import std.convert.*
import std.regex.Regex
import std.time.DateTime
import stdx.encoding.base64.*
import stdx.encoding.json.*
import stdx.crypto.digest.*
import web.config.AuthConfig

public class JwtVerifier {
    private let auth: AuthConfig
    public init(auth: AuthConfig) { this.auth = auth }
    public func subject(token: String): String {
        if (token.toArray().size > 16384) { throw IllegalArgumentException("Invalid token") }
        let parts = token.split(".")
        if (parts.size != 3) { throw IllegalArgumentException("Invalid token") }
        let key = auth.getJwtSecret().toArray()
        let header = JsonValue.fromStr(String.fromUtf8(decode(parts[0]))).asObject()
        let algorithm = header.get("alg").getOrThrow().asString().getValue()
        let expected = if (key.size >= 64) { "HS512" } else if (key.size >= 48) { "HS384" } else { "HS256" }
        if (algorithm != expected) { throw IllegalArgumentException("Invalid token algorithm") }
        let mac = if (algorithm == "HS512") { HMAC(key, { => SHA512() }) }
            else if (algorithm == "HS384") { HMAC(key, { => SHA384() }) }
            else { HMAC(key, { => SHA256() }) }
        mac.write((parts[0] + "." + parts[1]).toArray())
        let signature = toBase64String(mac.finish()).replace("+", "-").replace("/", "_").replace("=", "")
        if (!AuthUtilities.equal(signature, parts[2])) { throw IllegalArgumentException("Invalid token signature") }
        let payload = JsonValue.fromStr(String.fromUtf8(decode(parts[1]))).asObject()
        let expires = Int64.parse(payload.get("exp").getOrThrow().toString())
        if (expires <= DateTime.nowUTC().toUnixTimeStamp().toSeconds()) { throw IllegalArgumentException("Expired token") }
        if (let Some(value) <- payload.get("nbf")) {
            if (Int64.parse(value.toString()) > DateTime.nowUTC().toUnixTimeStamp().toSeconds()) {
                throw IllegalArgumentException("Token not active")
            }
        }
        let subject = payload.get("sub").getOrThrow().asString().getValue()
        if (!Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$").matches(subject)) {
            throw IllegalArgumentException("Invalid token subject")
        }
        return subject
    }
    private static func decode(value: String): Array<UInt8> {
        if (value.isEmpty() || !Regex("^[A-Za-z0-9_-]+$").matches(value)) {
            throw IllegalArgumentException("Invalid token encoding")
        }
        var normalized = value.replace("-", "+").replace("_", "/")
        while (normalized.toArray().size % 4 != 0) { normalized += "=" }
        return fromBase64String(normalized).getOrThrow()
    }
}
