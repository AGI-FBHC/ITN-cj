package web.config

import std.env.getVariables
import std.collection.HashMap
import std.convert.*

public class MailConfig {
    public let host: String
    public let port: UInt16
    public let username: String
    private let password: String
    public let from: String
    public let fromName: String
    public let subjectPrefix: String
    public init(host: String, port: UInt16, username: String, password: String,
        from: String, fromName: String, subjectPrefix: String) {
        this.host = host
        this.port = port
        this.username = username
        this.password = password
        this.from = from
        this.fromName = fromName
        this.subjectPrefix = subjectPrefix
    }
    public func getPassword(): String { return password }
    public func validate(): Unit {
        if (host.isEmpty() || port == 0 || username.isEmpty() || password.isEmpty() || from.isEmpty()) {
            throw IllegalArgumentException("SMTP configuration is incomplete")
        }
        for (value in [host, username, from, fromName, subjectPrefix]) {
            if (value.contains("\r") || value.contains("\n") || value.contains("\u{0}")) {
                throw IllegalArgumentException("Invalid SMTP configuration")
            }
        }
    }
    public static func fromEnvironment(): MailConfig {
        let env = HashMap<String, String>()
        for ((key, value) in getVariables()) { env[key] = value }
        return MailConfig(env.get("SMTP_HOST").getOrDefault({ => "smtp.qq.com" }),
            UInt16.parse(env.get("SMTP_PORT").getOrDefault({ => "465" })),
            env.get("SMTP_USERNAME").getOrDefault({ => "" }),
            env.get("SMTP_PASSWORD").getOrDefault({ => "" }),
            env.get("EMAIL_FROM").getOrDefault({ =>
                env.get("SMTP_FROM").getOrDefault({ => env.get("SMTP_USERNAME").getOrDefault({ => "" }) }) }),
            env.get("MAIL_FROM_NAME").getOrDefault({ => "智训云枢" }),
            env.get("MAIL_SUBJECT_PREFIX").getOrDefault({ => "[ITN]" }))
    }
}
