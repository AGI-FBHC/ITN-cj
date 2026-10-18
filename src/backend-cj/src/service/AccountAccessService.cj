package web.service

import std.unicode.*
import stdx.encoding.json.*
import web.config.*
import web.database.*
import web.domain.*
import web.dto.*
import web.repository.*
import web.security.*
import web.exception.*

public class AccountAccessService {
    private let database: DatabaseConfig
    private let auth: AuthConfig
    public init(database: DatabaseConfig, auth: AuthConfig) { this.database = database; this.auth = auth }
    public func authenticate(token: String): User {
        let subject = try { JwtVerifier(auth).subject(token) } catch (_: Exception) { throw unauthorized() }
        let users = MySqlConnection.query(database, columns() +
            " FROM users u JOIN user_sessions s ON s.user_id = u.id WHERE s.token_hash = " +
            AuthUtilities.text(HashingSupport.sha256(token)) + " COLLATE utf8mb4_unicode_ci " +
            "AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(6) AND u.active = 1 " +
            "AND u.id = " + AuthUtilities.uuidSql(subject) + " LIMIT 1")
        if (users.isEmpty()) { throw unauthorized() }
        return UserRepository.fromRow(users[0])
    }
    public func logout(token: String): Unit {
        authenticate(token)
        MySqlConnection.execute(database, "UPDATE user_sessions SET revoked_at = UTC_TIMESTAMP(6) WHERE token_hash = " +
            AuthUtilities.text(HashingSupport.sha256(token)) + " COLLATE utf8mb4_unicode_ci AND revoked_at IS NULL")
    }
    public func login(identityType: String, value: String, password: Option<String>, verificationCode: Option<String>,
        organizationCode: Option<String>, admin: Bool, ip: Option<String>, agent: Option<String>): LoginResponse {
        let kind = identityType.trim().toUpper(CasingOption.Other)
        if (kind != "ENTERPRISE" && kind != "PHONE" && kind != "WECHAT" && kind != "DEMO") {
            throw BusinessException(ErrorCode.VALIDATION_FAILED, 400, "身份类型不合法")
        }
        if (admin && kind != "ENTERPRISE") { throw credentials() }
        let rows = MySqlConnection.query(database, columns() +
            " FROM users u JOIN user_identities i ON i.user_id = u.id WHERE i.identity_type = " +
            AuthUtilities.text(kind) + " COLLATE utf8mb4_unicode_ci AND i.identity_value = " +
            AuthUtilities.text(value.trim()) + " COLLATE utf8mb4_unicode_ci LIMIT 1")
        if (rows.isEmpty()) { throw credentials() }
        let user = UserRepository.fromRow(rows[0])
        if (!user.isActive()) { throw BusinessException(ErrorCode.ACCOUNT_DISABLED, 403, "账户已停用") }
        let correctType = match (user.getAccountType()) { case AccountType.ADMIN => admin; case _ => !admin }
        if (!correctType) { throw credentials() }
        if (kind == "ENTERPRISE") {
            if (password.isNone() || !BCryptPasswordEncoder().matches(password.getOrThrow(), user.getPasswordHash())) { throw credentials() }
        } else if (kind == "PHONE") {
            // Preserve the old Java local P0 adapter contract.
            if (verificationCode.getOrDefault({ => "" }) != "123456") { throw credentials() }
        } else if (verificationCode.getOrDefault({ => "" }).trim().isEmpty()) { throw credentials() }
        var context = LoginContextRepository(database).load(user)
        var scopedOrganization = user.getOrganizationId()
        if (!admin) {
            let extras = MySqlConnection.query(database, "SELECT identity_extra_json FROM user_identities WHERE " +
                "identity_type = " + AuthUtilities.text(kind) + " COLLATE utf8mb4_unicode_ci AND identity_value = " +
                AuthUtilities.text(value.trim()) + " COLLATE utf8mb4_unicode_ci LIMIT 1")
            if (!extras.isEmpty() && extras[0][0].isSome()) {
                var extraCode: Option<String> = None
                try {
                    extraCode = Some(JsonValue.fromStr(extras[0][0].getOrThrow()).asObject()
                        .get("organizationCode").getOrThrow().asString().getValue())
                } catch (_: Exception) { () }
                if (let Some(code) <- extraCode) {
                    let organizations = MySqlConnection.query(database, "SELECT LOWER(BIN_TO_UUID(id, 0)), code, name " +
                        "FROM organizations WHERE code = " + AuthUtilities.text(code) + " COLLATE utf8mb4_unicode_ci LIMIT 1")
                    if (!organizations.isEmpty()) {
                        scopedOrganization = organizations[0][0]
                        context = LoginContext(context.learnerId, organizations[0][1], organizations[0][2])
                    }
                }
            }
        }
        var department: Option<String> = None
        if (!admin && !organizationCode.getOrDefault({ => "" }).trim().isEmpty() && scopedOrganization.isSome()) {
            let departments = MySqlConnection.query(database, "SELECT name FROM departments WHERE organization_id = " +
                AuthUtilities.uuidSql(scopedOrganization.getOrThrow()) + " AND code = 'main' LIMIT 1")
            if (!departments.isEmpty()) { department = departments[0][0] }
        }
        let token = JwtService(auth).generate(user)
        UserSessionRepository(database).save(user, token, ip, agent)
        return LoginResponse(token.value, "Bearer", auth.accessTokenTtlSeconds, UserResponse.from(user),
            context.learnerId, false, context.organizationCode, context.organizationName, department,
            if (admin) { ["admin"] } else { ["learner"] })
    }
    public static func requireAdmin(user: User): Unit {
        let admin = match (user.getAccountType()) { case AccountType.ADMIN => true; case _ => false }
        if (!admin || user.getOrganizationId().isNone()) {
            throw BusinessException(ErrorCode.UNAUTHORIZED, 403, "仅机构管理员可以执行此操作")
        }
    }
    public static func columns(): String {
        return "SELECT LOWER(BIN_TO_UUID(u.id, 0)), u.email, u.password_hash, u.nickname, u.active, u.account_type, " +
            "LOWER(BIN_TO_UUID(u.organization_id, 0)), u.admin_scope, " +
            "DATE_FORMAT(u.created_at, '%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(u.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ')"
    }
    private static func credentials(): BusinessException { return BusinessException(ErrorCode.INVALID_CREDENTIALS, 401, "身份或密码错误") }
    public static func unauthorized(): BusinessException { return BusinessException(ErrorCode.UNAUTHORIZED, 401, "请先登录") }
}
