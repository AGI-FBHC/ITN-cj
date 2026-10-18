package web.config

import std.env.getVariables
import std.convert.*

public class AuthConfig {
    private let jwtSecret: String
    public let accessTokenTtlSeconds: Int64

    public init(jwtSecret: String, accessTokenTtlSeconds: Int64) {
        if (jwtSecret.toArray().size < 32) {
            throw IllegalArgumentException(
                "JWT_SECRET must contain at least 32 UTF-8 bytes"
            )
        }
        if (accessTokenTtlSeconds <= 0) {
            throw IllegalArgumentException(
                "ACCESS_TOKEN_TTL_SECONDS must be greater than zero"
            )
        }

        this.jwtSecret = jwtSecret
        this.accessTokenTtlSeconds = accessTokenTtlSeconds
    }

    public func getJwtSecret(): String {
        return jwtSecret
    }

    public static func fromEnvironment(): AuthConfig {
        var secret = ""
        var ttlText = "86400"

        for ((key, value) in getVariables()) {
            match (key) {
                case "JWT_SECRET" => secret = value
                case "ACCESS_TOKEN_TTL_SECONDS" => ttlText = value
                case _ => ()
            }
        }

        return AuthConfig(secret, Int64.parse(ttlText))
    }
}