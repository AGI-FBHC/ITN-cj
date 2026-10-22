package web.diagnostics

import std.env.getStdIn
import std.regex.Regex
import std.time.DateTime
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.*
import web.repository.UserRepository
import web.security.*
import web.service.*

// Explicit local setup command, never called during web startup or exposed as an HTTP endpoint.
public class LocalAdminSetup {
    public static func run(database: DatabaseConfig): Int64 {
        if ((database.host != "127.0.0.1" && database.host != "localhost") || database.database != "itn_platform_local") {
            println("Local admin setup only supports localhost / itn_platform_local.")
            return 2
        }
        let input = getStdIn().readln()
        if (input.isNone() || !Regex("^(?=.*[A-Za-z])(?=.*[0-9])[!-~]{8,64}$").matches(input.getOrThrow())) {
            println("Use an 8-64 character ASCII password containing letters and digits.")
            return 2
        }
        let password = input.getOrThrow()
        let hash = BCryptPasswordEncoder().encode(password)
        try {
            let admin = DbTransaction.run<User>(database, { tx =>
                let orgs = tx.query("SELECT LOWER(BIN_TO_UUID(id, 0)) FROM organizations " +
                    "WHERE code = 'cloudbrain-shanghai' LIMIT 1 FOR UPDATE")
                if (orgs.isEmpty()) { throw Exception("Local organization cloudbrain-shanghai is missing") }
                let orgId = orgs[0][0].getOrThrow()
                let rows = tx.query(AccountAccessService.columns() +
                    " FROM users u WHERE u.email = 'cj-local-admin@itn.local' LIMIT 1 FOR UPDATE")
                var user: User
                if (!rows.isEmpty()) {
                    user = UserRepository.fromRow(rows[0])
                    let isAdmin = match (user.getAccountType()) { case AccountType.ADMIN => true; case _ => false }
                    if (!isAdmin || user.getOrganizationId().getOrDefault({ => "" }) != orgId || !user.isActive() ||
                        !BCryptPasswordEncoder().matches(password, user.getPasswordHash())) {
                        throw Exception("Existing local setup account differs; no account or password was changed")
                    }
                } else {
                    let id = AuthUtilities.uuid()
                    let now = DateTime.nowUTC().toString()
                    user = User(id, "cj-local-admin@itn.local", hash, Some("仓颉本地联调管理员"), true,
                        AccountType.ADMIN, Some(orgId), Some(AdminScope.ORGANIZATION), now, now)
                    let saved = tx.execute("INSERT INTO users " +
                        "(id, email, password_hash, nickname, active, account_type, organization_id, admin_scope, created_at, updated_at) " +
                        "VALUES (" + AuthUtilities.uuidSql(id) + ", 'cj-local-admin@itn.local', " +
                        AuthUtilities.text(hash) + ", " + AuthUtilities.text("仓颉本地联调管理员") +
                        ", 1, 'ADMIN', " + AuthUtilities.uuidSql(orgId) + ", 'ORGANIZATION', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))")
                    if (saved != 1) { throw Exception("Local administrator was not saved") }
                }
                let identities = tx.query("SELECT LOWER(BIN_TO_UUID(user_id, 0)) FROM user_identities " +
                    "WHERE identity_type = 'ENTERPRISE' AND identity_value = 'cj-local-admin' LIMIT 1 FOR UPDATE")
                if (identities.isEmpty()) {
                    tx.execute("INSERT INTO user_identities (id, user_id, identity_type, identity_value, " +
                        "identity_extra_json, created_at, updated_at) VALUES (" +
                        AuthUtilities.uuidSql(AuthUtilities.uuid()) + ", " + AuthUtilities.uuidSql(user.getId()) +
                        ", 'ENTERPRISE', 'cj-local-admin', NULL, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))")
                } else if (identities[0][0].getOrThrow() != user.getId()) {
                    throw Exception("Local administrator identity is already assigned to another user")
                }
                return user
            })
            let invite = OrganizationInviteService(database).create(admin, Some("仓颉本地联调"), Some(20), Some(30))
            println("Local administrator ready. Login account: cj-local-admin")
            println("Organization: cloudbrain-shanghai")
            println("Invitation response: " + invite)
            return 0
        } catch (e: Exception) {
            println("Local setup failed: " + e.message)
            return 1
        }
    }
}
