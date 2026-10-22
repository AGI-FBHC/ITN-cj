package zhixun_learning

import std.core.*

const PASSWORD_RESET_PURPOSE = "RESET_PASSWORD"

func validVerificationCode(code: String): Bool {
    let bytes = code.toArray()
    if (bytes.size != 6) { return false }
    for (value in bytes) {
        if (value < 48 || value > 57) { return false }
    }
    true
}

/** Lock the latest challenge and rotate credentials in the same transaction. */
func resetPasswordWithCode(cfg: Config, email: String, code: String, password: String): Bool {
    let conn = connect(cfg)
    try {
        ignoreOk(conn.query("START TRANSACTION"))
        try {
            let codes = rowsOf(conn.query(
                "SELECT id,code_hash,failed_attempts,consumed_at,IF(expires_at>NOW(6),1,0) valid " +
                "FROM email_verification_codes WHERE email=" + sqlQuote(email) +
                " AND purpose=" + sqlQuote(PASSWORD_RESET_PURPOSE) +
                " ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE"))
            if (codes.size == 0 || !codes[0].isNull("consumed_at") ||
                codes[0].int("valid") == 0 || codes[0].int("failed_attempts") >= 5) {
                ignoreOk(conn.query("ROLLBACK"))
                return false
            }
            if (codes[0].text("code_hash") != codeDigest(cfg, email, PASSWORD_RESET_PURPOSE, code)) {
                ignoreOk(conn.query("UPDATE email_verification_codes SET failed_attempts=failed_attempts+1 WHERE id=" +
                    sqlQuote(codes[0].text("id"))))
                ignoreOk(conn.query("COMMIT"))
                return false
            }
            let users = rowsOf(conn.query("SELECT id FROM users WHERE login_key=" + sqlQuote(email) + " LIMIT 1 FOR UPDATE"))
            if (users.size == 0) {
                ignoreOk(conn.query("ROLLBACK"))
                return false
            }
            let userId = users[0].text("id")
            let salt = bytesToHex(uuidV4())
            ignoreOk(conn.query("UPDATE users SET password_salt=" + sqlQuote(salt) +
                ",password_hash=" + sqlQuote(passwordDigest(salt, password)) + " WHERE id=" + sqlQuote(userId)))
            ignoreOk(conn.query("UPDATE email_verification_codes SET consumed_at=NOW(6) WHERE email=" +
                sqlQuote(email) + " AND purpose IN ('LOGIN'," + sqlQuote(PASSWORD_RESET_PURPOSE) + ") AND consumed_at IS NULL"))
            ignoreOk(conn.query("DELETE FROM user_sessions WHERE user_id=" + sqlQuote(userId)))
            ignoreOk(conn.query("COMMIT"))
            true
        } catch (error: Exception) {
            try { ignoreOk(conn.query("ROLLBACK")) } catch (_: Exception) {}
            throw error
        }
    } finally { conn.close() }
}
