package web.repository
import web.config.DatabaseConfig
import web.database.MySqlConnection
import web.database.DbTransaction
import web.domain.User
import web.security.GeneratedToken
import web.security.HashingSupport
public class UserSessionRepository {
    private let config: DatabaseConfig
    public init(config: DatabaseConfig) {
        this.config = config
    }
    public func save(user: User, token: GeneratedToken,
        ipAddress: Option<String>, userAgent: Option<String>): Unit {
        let inserted = MySqlConnection.execute(config, insertSql(user, token, ipAddress, userAgent))
        if (inserted != 1) { throw Exception("Login session was not saved") }
    }
    public func save(tx: DbTransaction, user: User, token: GeneratedToken,
        ipAddress: Option<String>, userAgent: Option<String>): Unit {
        let inserted = tx.execute(insertSql(user, token, ipAddress, userAgent))
        if (inserted != 1) { throw Exception("Login session was not saved") }
    }
    private static func insertSql(user: User, token: GeneratedToken,
        ipAddress: Option<String>, userAgent: Option<String>): String {
        if (token.value.isEmpty() || token.expiresAtSeconds <= token.issuedAtSeconds) {
            throw IllegalArgumentException("Invalid login token")
        }
        let tokenHash = HashingSupport.sha256(token.value)
        let sql = "INSERT INTO user_sessions " +
            "(token_hash, user_id, created_at, expires_at, revoked_at, ip_address, user_agent) " +
            "VALUES (" + textLiteral(tokenHash) + ", UUID_TO_BIN(" +
            textLiteral(user.getId()) + ", 0), UTC_TIMESTAMP(6), " +
            "FROM_UNIXTIME(${token.expiresAtSeconds}), NULL, " +
            optionalLiteral(safeIp(ipAddress)) + ", " +
            optionalLiteral(safeUserAgent(userAgent)) + ")"
        return sql
    }
    private static func safeIp(value: Option<String>): Option<String> {
        match (value) {
            case None => return None
            case Some(text) =>
                // An IPv4/IPv6 address consists of ASCII characters.
                if (text.toArray().size > 45) { return None }
                return Some(text)
        }
    }
    private static func safeUserAgent(value: Option<String>): Option<String> {
        match (value) {
            case None => return None
            case Some(text) =>
                let bytes = text.toArray()
                var end = 0
                var units = 0
                // Java limits this value to 512 UTF-16 units. Keep Unicode characters whole.
                while (end < bytes.size) {
                    let first = bytes[end]
                    let width = if (first < 128) { 1 } else if (first < 224) { 2 }
                        else if (first < 240) { 3 } else { 4 }
                    let nextUnits = if (width == 4) { 2 } else { 1 }
                    if (units + nextUnits > 512) { break }
                    end += width
                    units += nextUnits
                }
                return Some(String.fromUtf8(bytes.slice(0, end)))
        }
    }
    public static func userAgentSql(value: Option<String>): String {
        return optionalLiteral(safeUserAgent(value))
    }
    private static func optionalLiteral(value: Option<String>): String {
        match (value) {
            case None => return "NULL"
            case Some(text) => return textLiteral(text)
        }
    }
    // UTF-8 hex literals keep quotes, backslashes and Unicode out of SQL syntax.
    private static func textLiteral(value: String): String {
        let digits = "0123456789abcdef".toArray()
        let bytes = value.toArray()
        let hex = Array<UInt8>(bytes.size * 2, { _ => 0u8 })
        for (i in 0..bytes.size) {
            hex[i * 2] = digits[Int64(bytes[i] / 16)]
            hex[i * 2 + 1] = digits[Int64(bytes[i] % 16)]
        }
        return "CONVERT(X'" + String.fromUtf8(hex) + "' USING utf8mb4)"
    }
}
