package web.service

import std.unicode.*
import std.time.DateTime
import std.convert.*
import stdx.encoding.json.JsonString
import web.config.*
import web.database.DbTransaction
import web.domain.*
import web.dto.*
import web.exception.*
import web.repository.*
import web.security.*

public class EnterpriseRegistrationService {
    private let database: DatabaseConfig
    private let auth: AuthConfig
    private let codes: VerificationCodeService
    public init(database: DatabaseConfig, auth: AuthConfig, codes: VerificationCodeService) {
        this.database = database
        this.auth = auth
        this.codes = codes
    }
    public func register(request: RegisterRequest, invitationCode: String,
        ip: Option<String>, agent: Option<String>): EnterpriseRegisterResponse {
        let email = AuthUtilities.normalizeEmail(request.email)
        if (UserRepository(database).existsByEmail(email)) {
            throw duplicateEmail()
        }
        let nickname = match (request.nickname) {
            case Some(value) => if (value.trim().isEmpty()) { email.split("@")[0] } else { value.trim() }
            case None => email.split("@")[0]
        }
        let passwordHash = BCryptPasswordEncoder().encode(request.password)
        let id = AuthUtilities.uuid()
        let inviteHash = HashingSupport.sha256(invitationCode.replace("-", "").replace(" ", "").toUpper(CasingOption.Other))
        try {
            return DbTransaction.run<EnterpriseRegisterResponse>(database, { tx =>
                codes.verifyAndConsume(tx, email, "REGISTER", request.verificationCode)
                // Invitation and verification-code usage roll back with the whole registration.
                let organization = OrganizationInviteService.consume(tx, invitationCode)
                let organizationId = organization[0]
                let organizationCode = organization[1]
                let organizationName = organization[2]
                let saved = tx.execute("INSERT INTO users (id, email, password_hash, nickname, active, " +
                    "account_type, organization_id, created_at, updated_at) VALUES (" + AuthUtilities.uuidSql(id) +
                    ", " + AuthUtilities.text(email) + ", " + AuthUtilities.text(passwordHash) +
                    ", " + AuthUtilities.text(nickname) + ", 1, 'LEARNER', " + AuthUtilities.uuidSql(organizationId) +
                    ", UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))")
                if (saved != 1) { throw Exception("Enterprise user was not saved") }
                let employeeNo = nextEmployeeNumber(tx, organizationId)
                let extra = "{\"organizationCode\":" + JsonString(organizationCode).toString() + "}"
                let identitySaved = tx.execute("INSERT INTO user_identities " +
                    "(id, user_id, identity_type, identity_value, identity_extra_json, created_at, updated_at) VALUES (" +
                    AuthUtilities.uuidSql(AuthUtilities.uuid()) + ", " + AuthUtilities.uuidSql(id) +
                    ", 'ENTERPRISE', " + AuthUtilities.text(employeeNo) + ", " + AuthUtilities.text(extra) +
                    ", UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))")
                if (identitySaved != 1) { throw Exception("Enterprise identity was not saved") }
                let timestamp = DateTime.nowUTC().toString()
                let user = User(id, email, passwordHash, Some(nickname), true, AccountType.LEARNER,
                    Some(organizationId), None, timestamp, timestamp)
                let token = JwtService(auth).generate(user)
                UserSessionRepository(database).save(tx, user, token, ip, agent)
                let login = LoginResponse(token.value, "Bearer", auth.accessTokenTtlSeconds,
                    UserResponse.from(user), None, false, Some(organizationCode), Some(organizationName),
                    Some(organizationName), ["learner"])
                return EnterpriseRegisterResponse(login, employeeNo, organizationName)
            })
        } catch (e: BusinessException) { throw e }
        catch (e: Exception) {
            if (e.message.contains("Duplicate entry") && UserRepository(database).existsByEmail(email)) {
                throw duplicateEmail()
            }
            throw e
        }
    }
    private static func nextEmployeeNumber(tx: DbTransaction, organizationId: String): String {
        // Identity values are globally unique, even though sequences belong to organizations.
        // MySQL releases this connection-level lock when DbTransaction closes the connection.
        let lock = tx.query("SELECT GET_LOCK('itn-cj-enterprise-number', 10)")
        if (lock.isEmpty() || lock[0][0].getOrDefault({ => "0" }) != "1") {
            throw BusinessException(ErrorCode.INTERNAL_ERROR, 409, "工号分配繁忙，请稍后重试")
        }
        let org = AuthUtilities.uuidSql(organizationId)
        tx.execute("INSERT INTO employee_number_sequences (organization_id, next_value, updated_at) VALUES (" +
            org + ", 1, UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE organization_id = organization_id")
        let rows = tx.query("SELECT next_value FROM employee_number_sequences WHERE organization_id = " + org + " FOR UPDATE")
        var value = Int64.parse(rows[0][0].getOrThrow())
        for (_ in 0..1000) {
            if (value >= 999999999) {
                throw BusinessException(ErrorCode.INTERNAL_ERROR, 409, "工号已用尽，请联系管理员")
            }
            value += 1
            var number = value.toString()
            while (number.toArray().size < 9) { number = "0" + number }
            let identities = tx.query("SELECT 1 FROM user_identities WHERE identity_type = 'ENTERPRISE' " +
                "AND identity_value = " + AuthUtilities.text(number) + " COLLATE utf8mb4_unicode_ci LIMIT 1")
            if (identities.isEmpty()) {
                tx.execute("UPDATE employee_number_sequences SET next_value = ${value}, " +
                    "updated_at = UTC_TIMESTAMP(6) WHERE organization_id = " + org)
                return number
            }
        }
        throw BusinessException(ErrorCode.INTERNAL_ERROR, 409, "工号分配失败，请联系管理员")
    }
    private static func invalid(message: String): BusinessException {
        return BusinessException(ErrorCode.VALIDATION_FAILED, 400, message)
    }
    private static func duplicateEmail(): BusinessException {
        return BusinessException(ErrorCode.EMAIL_ALREADY_REGISTERED, 409, "该邮箱已注册，请直接登录")
    }
}
