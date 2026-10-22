package itn_spire

import std.env.*
import std.core.*
import std.convert.*

public struct AppConfig {
    public let jwtSecret: ?String
    public let platformDbUrl: ?String
    public let httpUrl: String
    /* Python agents-service origin for the P3 forwarding gateway, e.g.
     * "http://127.0.0.1:8000". Spire never holds LLM keys — it only relays. */
    public let agentsUpstream: String
    /* Spring Boot origin for the not-yet-migrated /api/v1 surface, e.g.
     * "http://127.0.0.1:8080". Same relay, different service. */
    public let javaUpstream: String
    /* agents-service 内部 HMAC secret（AGENT_INTERNAL_SECRET）。未配置时
     * 管理员彻底删除/分组删除的 agents 调用按 502 处理（与 Java 一致）。 */
    public let agentInternalSecret: ?String
    /* 管理员知识服务代理目标（AdminKnowledgeProxyController 的迁移）。 */
    public let knowledgeCoreUrl: String
    public let questionBankUrl: String
    /* 知识服务内部 HMAC secret；未配置时不附加签名头（与 Java 一致）。 */
    public let kcInternalSecret: ?String
    public let qbInternalSecret: ?String

    public init() {
        jwtSecret = getVariable("JWT_SECRET")
        platformDbUrl = getVariable("PLATFORM_DB_URL")
        httpUrl = getVariable("SPIRE_HTTP_URL") ?? "http://127.0.0.1:8100"
        agentsUpstream = getVariable("AGENTS_UPSTREAM") ?? "http://127.0.0.1:8000"
        javaUpstream = getVariable("JAVA_UPSTREAM") ?? "http://127.0.0.1:8080"
        agentInternalSecret = getVariable("AGENT_INTERNAL_SECRET")
        knowledgeCoreUrl = getVariable("KNOWLEDGE_CORE_URL") ?? "http://127.0.0.1:8010"
        questionBankUrl = getVariable("QUESTIONBANK_URL") ?? "http://127.0.0.1:8030"
        kcInternalSecret = getVariable("KC_INTERNAL_SECRET")
        qbInternalSecret = getVariable("QB_INTERNAL_SECRET")
    }
}

/* mysql://user:password@host:port/database */
public struct DbTarget {
    public let host: String
    public let port: UInt16
    public let user: String
    public let password: String
    public let database: String

    public init(host: String, port: UInt16, user: String, password: String, database: String) {
        this.host = host
        this.port = port
        this.user = user
        this.password = password
        this.database = database
    }
}

public func parseDbUrl(url: String): ?DbTarget {
    var rest = url.trimAscii()
    if (rest.startsWith("mysql://")) {
        rest = rest[8..rest.size]
    } else if (rest.startsWith("mysql:")) {
        rest = rest[6..rest.size]
    } else {
        return None
    }
    while (rest.startsWith("/")) {
        rest = rest[1..rest.size]
    }
    var hostPart = rest
    var database = ""
    match (rest.indexOf("/")) {
        case Some(slash) =>
            hostPart = rest[0..slash]
            database = rest[(slash + 1)..rest.size]
        case None => ()
    }
    var userInfo = ""
    var hostPort = hostPart
    match (hostPart.indexOf("@")) {
        case Some(at) =>
            userInfo = hostPart[0..at]
            hostPort = hostPart[(at + 1)..hostPart.size]
        case None => ()
    }
    var user = ""
    var password = ""
    match (userInfo.indexOf(":")) {
        case Some(colon) =>
            user = userInfo[0..colon]
            password = userInfo[(colon + 1)..userInfo.size]
        case None =>
            user = userInfo
    }
    var host = hostPort
    var port: Int64 = 3306
    match (hostPort.indexOf(":")) {
        case Some(colon) =>
            host = hostPort[0..colon]
            match (Int64.tryParse(hostPort[(colon + 1)..hostPort.size])) {
                case Some(p) => port = p
                case None => ()
            }
        case None => ()
    }
    if (host.size == 0 || port <= 0 || port > 65535) {
        return None
    }
    if (port < 0 || port > 65535) {
        return None
    }
    return Some(DbTarget(host, UInt16(port), user, password, database))
}

/* Last openDb failure reason; kept for diagnostics only, never sent to clients. */
public var lastDbError: String = ""

public func openDb(cfg: AppConfig): ?MyConnection {
    lastDbError = ""
    var url = ""
    match (cfg.platformDbUrl) {
        case Some(u) => url = u
        case None =>
            lastDbError = "no PLATFORM_DB_URL"
            return None
    }
    if (url.trimAscii().size == 0) {
        lastDbError = "empty PLATFORM_DB_URL"
        return None
    }
    var target: DbTarget = DbTarget("", 0, "", "", "")
    match (parseDbUrl(url)) {
        case Some(t) => target = t
        case None =>
            lastDbError = "parseDbUrl failed for url len=" + url.size.toString()
            return None
    }
    /* Transient "read data timeout" on connect is common to this MySQL host. */
    var attempt = 0
    while (attempt < 3) {
        try {
            return Some(MyConnection.connect(target.host, target.port, target.user,
                                             target.password, target.database))
        } catch (e: MySqlError) {
            lastDbError = "connect " + target.host + ":" + target.port.toString() + " " + target.database
                + " -> MySQL " + e.messageText + " / msg=" + e.message
        } catch (e: Exception) {
            lastDbError = "connect " + target.host + ":" + target.port.toString() + " " + target.database
                + " -> EXC " + e.message
        }
        attempt += 1
    }
    return None
}
