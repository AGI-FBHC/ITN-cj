package web.repository
import web.config.DatabaseConfig
import web.database.MySqlConnection
import web.domain.*
public class UserRepository {
    private let config: DatabaseConfig
    public init(config: DatabaseConfig) {
        this.config = config
    }
    public func findByEmail(email: String): Option<User> {
        // Encode UTF-8 bytes as a hex literal: quotes in input cannot become SQL.
        let emailLiteral = "CONVERT(X'" + utf8Hex(email) + "' USING utf8mb4) COLLATE utf8mb4_unicode_ci"
        let sql = "SELECT LOWER(BIN_TO_UUID(id, 0)), email, password_hash, nickname, " +
            "active, account_type, LOWER(BIN_TO_UUID(organization_id, 0)), admin_scope, " +
            "DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ'), " +
            "DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') " +
            "FROM users WHERE email = " + emailLiteral + " LIMIT 1"
        let rows = MySqlConnection.query(config, sql)
        if (rows.isEmpty()) { return None }
        return Some(fromRow(rows[0]))
    }
    public static func fromRow(row: Array<Option<String>>): User {
        if (row.size != 10) { throw Exception("Unexpected users column count") }
        let accountType = match (required(row[5], "account_type")) {
            case "LEARNER" => AccountType.LEARNER
            case "ADMIN" => AccountType.ADMIN
            case _ => throw Exception("Unknown users.account_type")
        }
        let adminScope: Option<AdminScope> = match (row[7]) {
            case None => None
            case Some("PLATFORM") => Some(AdminScope.PLATFORM)
            case Some("ORGANIZATION") => Some(AdminScope.ORGANIZATION)
            case _ => throw Exception("Unknown users.admin_scope")
        }
        let active = match (required(row[4], "active")) {
            case "1" => true
            case "0" => false
            case _ => throw Exception("Invalid users.active")
        }
        return User(required(row[0], "id"), required(row[1], "email"),
            required(row[2], "password_hash"), row[3], active, accountType,
            row[6], adminScope, required(row[8], "created_at"),
            required(row[9], "updated_at"))
    }
    public func existsByEmail(email: String): Bool {
        return findByEmail(email).isSome()
    }
    private static func required(value: Option<String>, column: String): String {
        match (value) {
            case Some(text) => return text
            case None => throw Exception("Unexpected NULL in users." + column)
        }
    }
    private static func utf8Hex(value: String): String {
        let digits = "0123456789abcdef".toArray()
        let bytes = value.toArray()
        let hex = Array<UInt8>(bytes.size * 2, { _ => 0u8 })
        for (i in 0..bytes.size) {
            hex[i * 2] = digits[Int64(bytes[i] / 16)]
            hex[i * 2 + 1] = digits[Int64(bytes[i] % 16)]
        }
        return String.fromUtf8(hex)
    }
}
