package web.service
import std.unicode.*

import std.time.DateTime
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.*
import web.dto.*
import web.exception.*
import web.repository.UserRepository
import web.security.*

public class RegistrationService {
    private let database: DatabaseConfig
    private let codes: VerificationCodeService
    public init(database: DatabaseConfig, codes: VerificationCodeService) {
        this.database = database
        this.codes = codes
    }
    public func register(request: RegisterRequest): UserResponse {
        let email = AuthUtilities.normalizeEmail(request.email)
        if (UserRepository(database).existsByEmail(email)) {
            throw BusinessException(ErrorCode.EMAIL_ALREADY_REGISTERED, 409, "该邮箱已注册，请直接登录")
        }
        let nickname = match (request.nickname) {
            case None => email.split("@")[0]
            case Some(value) => if (value.trim().isEmpty()) { email.split("@")[0] } else { value.trim() }
        }
        // BCrypt is deliberately computed before acquiring the code's row lock.
        let passwordHash = BCryptPasswordEncoder().encode(request.password)
        let id = AuthUtilities.uuid()
        let timestamp = DateTime.nowUTC().toString()
        let user = User(id, email, passwordHash, Some(nickname), true, AccountType.LEARNER,
            None, None, timestamp, timestamp)
        try {
            return DbTransaction.run<UserResponse>(database, { tx =>
                codes.verifyAndConsume(tx, email, "REGISTER", request.verificationCode)
                let count = tx.execute("INSERT INTO users (id, email, password_hash, nickname, active, " +
                    "account_type, created_at, updated_at) VALUES (" + AuthUtilities.uuidSql(id) +
                    ", " + AuthUtilities.text(email) + ", " + AuthUtilities.text(passwordHash) +
                    ", " + AuthUtilities.text(nickname) + ", 1, 'LEARNER', UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))")
                if (count != 1) { throw Exception("Registered user was not saved") }
                return UserResponse.from(user)
            })
        } catch (e: BusinessException) { throw e }
        catch (e: Exception) {
            if (e.message.contains("Duplicate entry")) {
                throw BusinessException(ErrorCode.EMAIL_ALREADY_REGISTERED, 409, "该邮箱已注册，请直接登录")
            }
            throw e
        }
    }
}
