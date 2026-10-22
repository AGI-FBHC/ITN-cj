package web.security
import std.time.DateTime
import stdx.crypto.crypto.SecureRandom
import stdx.crypto.digest.*
import stdx.encoding.base64.toBase64String
import stdx.encoding.hex.toHexString
import stdx.encoding.json.JsonString
import web.config.AuthConfig
import web.domain.User
public class GeneratedToken {
    public let value: String
    public let issuedAtSeconds: Int64
    public let expiresAtSeconds: Int64
    public init(value: String, issuedAtSeconds: Int64, expiresAtSeconds: Int64) {
        this.value = value
        this.issuedAtSeconds = issuedAtSeconds
        this.expiresAtSeconds = expiresAtSeconds
    }
}
public class JwtService {
    private let config: AuthConfig
    public init(config: AuthConfig) {
        this.config = config
    }
    public func generate(user: User): GeneratedToken {
        let key = config.getJwtSecret().toArray()
        let now = DateTime.nowUTC().toUnixTimeStamp().toSeconds()
        let expiresAt = now + config.accessTokenTtlSeconds
        // Match Java JJWT's algorithm selection for a UTF-8 HMAC key.
        let (algorithm, mac) = if (key.size >= 64) {
            ("HS512", HMAC(key, { => SHA512() }))
        } else if (key.size >= 48) {
            ("HS384", HMAC(key, { => SHA384() }))
        } else {
            ("HS256", HMAC(key, { => SHA256() }))
        }
        let header = "{\"alg\":\"${algorithm}\"}"
        let payload = "{\"sub\":" + JsonString(user.getId()).toString() +
            ",\"email\":" + JsonString(user.getEmail()).toString() +
            ",\"jti\":" + JsonString(newTokenId()).toString() +
            ",\"iat\":${now},\"exp\":${expiresAt}}"
        let signingInput = base64Url(header.toArray()) + "." +
            base64Url(payload.toArray())
        mac.write(signingInput.toArray())
        let token = signingInput + "." + base64Url(mac.finish())
        return GeneratedToken(token, now, expiresAt)
    }
    private static func base64Url(bytes: Array<UInt8>): String {
        return toBase64String(bytes).replace("+", "-")
            .replace("/", "_").replace("=", "")
    }
    private static func newTokenId(): String {
        let bytes = SecureRandom().nextBytes(16)
        // RFC 4122 UUID version 4 and variant bits.
        bytes[6] = (bytes[6] & 15u8) | 64u8
        bytes[8] = (bytes[8] & 63u8) | 128u8
        let hex = toHexString(bytes).toArray()
        return String.fromUtf8(hex.slice(0, 8)) + "-" +
            String.fromUtf8(hex.slice(8, 4)) + "-" +
            String.fromUtf8(hex.slice(12, 4)) + "-" +
            String.fromUtf8(hex.slice(16, 4)) + "-" +
            String.fromUtf8(hex.slice(20, 12))
    }
}
