package web.service

import web.config.*
import web.database.DbTransaction
import web.domain.AccountType
import web.dto.*
import web.exception.*
import web.repository.*
import web.security.*

public class EmailCodeLoginService {
    private let database: DatabaseConfig
    private let auth: AuthConfig
    private let codes: VerificationCodeService
    public init(database: DatabaseConfig, auth: AuthConfig, codes: VerificationCodeService) {
        this.database = database
        this.auth = auth
        this.codes = codes
    }
    public func login(request: EmailCodeLoginRequest, ip: Option<String>, agent: Option<String>): LoginResponse {
        let user = match (UserRepository(database).findByEmail(AuthUtilities.normalizeEmail(request.email))) {
            case Some(value) => value
            case None => throw BusinessException(ErrorCode.INVALID_CREDENTIALS, 401, "身份或密码错误")
        }
        match (user.getAccountType()) {
            case AccountType.LEARNER => ()
            case _ => throw BusinessException(ErrorCode.INVALID_CREDENTIALS, 401, "身份或密码错误")
        }
        let context = LoginContextRepository(database).load(user)
        return DbTransaction.run<LoginResponse>(database, { tx =>
            codes.verifyAndConsume(tx, request.email, "LOGIN", request.verificationCode)
            if (!user.isActive()) { throw BusinessException(ErrorCode.ACCOUNT_DISABLED, 403, "账户已停用") }
            let token = JwtService(auth).generate(user)
            let text = { value: String => AuthUtilities.text(value) }
            let ipValue = match (ip) {
                case Some(value) => if (value.toArray().size <= 45) { text(value) } else { "NULL" }
                case None => "NULL"
            }
            // Use the same safe truncation as password login.
            let agentValue = UserSessionRepository.userAgentSql(agent)
            let count = tx.execute("INSERT INTO user_sessions " +
                "(token_hash, user_id, created_at, expires_at, revoked_at, ip_address, user_agent) VALUES (" +
                text(HashingSupport.sha256(token.value)) + ", " + AuthUtilities.uuidSql(user.getId()) +
                ", UTC_TIMESTAMP(6), FROM_UNIXTIME(${token.expiresAtSeconds}), NULL, " +
                ipValue + ", " + agentValue + ")")
            if (count != 1) { throw Exception("Login session was not saved") }
            return LoginResponse(token.value, "Bearer", auth.accessTokenTtlSeconds, UserResponse.from(user),
                context.learnerId, false, context.organizationCode, context.organizationName, None, ["learner"])
        })
    }
}
