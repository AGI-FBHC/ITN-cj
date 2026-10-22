package web.repository

import std.convert.*
import web.database.DbTransaction
import web.security.AuthUtilities

public class VerificationCodeRecord {
    public let id: String
    public let hash: String
    public let createdAt: Int64
    public let valid: Bool
    public init(id: String, hash: String, createdAt: Int64, valid: Bool) {
        this.id = id
        this.hash = hash
        this.createdAt = createdAt
        this.valid = valid
    }
}

public class EmailVerificationCodeRepository {
    public init() {}
    public func latest(tx: DbTransaction, email: String, purpose: String,
        unconsumed: Bool): Option<VerificationCodeRecord> {
        let filter = if (unconsumed) { " AND consumed_at IS NULL" } else { "" }
        let rows = tx.query("SELECT LOWER(BIN_TO_UUID(id, 0)), code_hash, " +
            "CAST(FLOOR(UNIX_TIMESTAMP(created_at)) AS CHAR), IF(expires_at > UTC_TIMESTAMP(6), '1', '0') " +
            "FROM email_verification_codes WHERE email = " + AuthUtilities.text(email) +
            " COLLATE utf8mb4_unicode_ci AND purpose = " + AuthUtilities.text(purpose) +
            " COLLATE utf8mb4_unicode_ci" + filter + " ORDER BY created_at DESC LIMIT 1 FOR UPDATE")
        if (rows.isEmpty()) { return None }
        let row = rows[0]
        return Some(VerificationCodeRecord(row[0].getOrThrow(), row[1].getOrThrow(),
            Int64.parse(row[2].getOrThrow()), row[3].getOrThrow() == "1"))
    }
    public func save(tx: DbTransaction, email: String, purpose: String, hash: String,
        expiresAt: Int64): Unit {
        let count = tx.execute("INSERT INTO email_verification_codes " +
            "(id, email, code_hash, purpose, created_at, expires_at, consumed_at) VALUES (" +
            AuthUtilities.uuidSql(AuthUtilities.uuid()) + ", " + AuthUtilities.text(email) +
            ", " + AuthUtilities.text(hash) + ", " + AuthUtilities.text(purpose) +
            ", UTC_TIMESTAMP(6), FROM_UNIXTIME(${expiresAt}), NULL)")
        if (count != 1) { throw Exception("Verification code was not saved") }
    }
    public func consume(tx: DbTransaction, id: String): Bool {
        return tx.execute("UPDATE email_verification_codes SET consumed_at = UTC_TIMESTAMP(6) " +
            "WHERE id = " + AuthUtilities.uuidSql(id) +
            " AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP(6)") == 1
    }
}
