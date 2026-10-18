package web.service

import std.env.getVariables
import std.collection.HashMap
import std.convert.*
import std.time.DateTime
import web.config.*
import web.database.DbTransaction
import web.dto.SendVerificationCodeResponse
import web.exception.*
import web.repository.*
import web.security.*

public class VerificationCodeService {
    private let database: DatabaseConfig
    private let auth: AuthConfig
    private let mailer: VerificationMailer
    private let users: UserRepository
    private let codes = EmailVerificationCodeRepository()
    public let ttlSeconds: Int64
    public let resendSeconds: Int64
    public init(database: DatabaseConfig, auth: AuthConfig, mailer: VerificationMailer) {
        this.database = database
        this.auth = auth
        this.mailer = mailer
        this.users = UserRepository(database)
        let env = HashMap<String, String>()
        for ((key, value) in getVariables()) { env[key] = value }
        this.ttlSeconds = Int64.parse(env.get("VERIFICATION_CODE_TTL_SECONDS").getOrDefault({ => "300" }))
        this.resendSeconds = Int64.parse(env.get("VERIFICATION_CODE_RESEND_SECONDS").getOrDefault({ => "60" }))
        if (ttlSeconds <= 0 || resendSeconds <= 0) { throw IllegalArgumentException("Invalid verification timing") }
    }
    public func send(rawEmail: String, purpose: String): SendVerificationCodeResponse {
        checkPurpose(purpose)
        let email = AuthUtilities.normalizeEmail(rawEmail)
        let exists = users.existsByEmail(email)
        if (purpose == "REGISTER" && exists) {
            throw BusinessException(ErrorCode.EMAIL_ALREADY_REGISTERED, 409, "该邮箱已注册，请直接登录")
        }
        if (purpose != "REGISTER" && !exists) {
            throw BusinessException(ErrorCode.EMAIL_NOT_FOUND, 400, "该邮箱尚未注册")
        }
        return DbTransaction.run<SendVerificationCodeResponse>(database, { tx =>
            // Serialize same-email/purpose sends across processes. Connection close releases the lock.
            let lock = HashingSupport.sha256(email + ":" + purpose)
            let locked = tx.query("SELECT GET_LOCK(" + AuthUtilities.text(lock) + ", 10)")
            if (locked[0][0].getOrThrow() != "1") {
                throw BusinessException(ErrorCode.VERIFICATION_CODE_RATE_LIMITED, 429, "请求过于频繁，请稍后重试")
            }
            let now = DateTime.nowUTC().toUnixTimeStamp().toSeconds()
            if (let Some(latest) <- codes.latest(tx, email, purpose, false)) {
                let elapsed = now - latest.createdAt
                if (elapsed < resendSeconds) {
                    let retry = resendSeconds - elapsed + 1
                    throw BusinessException(ErrorCode.VERIFICATION_CODE_RATE_LIMITED, 429,
                        "请求过于频繁，请在 ${retry} 秒后重试")
                }
            }
            let code = AuthUtilities.numericCode()
            try { mailer.send(email, code, purpose, ttlSeconds) }
            catch (e: Exception) {
                println("SMTP delivery failed: " + e.message)
                throw BusinessException(ErrorCode.EMAIL_SEND_FAILED, 502, "验证码邮件发送失败，请检查本地 SMTP 配置")
            }
            codes.save(tx, email, purpose, hash(email, purpose, code), now + ttlSeconds)
            return SendVerificationCodeResponse(email, ttlSeconds, resendSeconds)
        })
    }
    public func verifyAndConsume(tx: DbTransaction, rawEmail: String, purpose: String, code: String): Unit {
        checkPurpose(purpose)
        let email = AuthUtilities.normalizeEmail(rawEmail)
        let latest = match (codes.latest(tx, email, purpose, true)) {
            case Some(value) => value
            case None => throw invalidCode()
        }
        if (!latest.valid || !AuthUtilities.equal(latest.hash, hash(email, purpose, code)) ||
            !codes.consume(tx, latest.id)) { throw invalidCode() }
    }
    private func hash(email: String, purpose: String, code: String): String {
        return HashingSupport.sha256(email + ":" + purpose + ":" + code + ":" + auth.getJwtSecret())
    }
    private static func checkPurpose(purpose: String): Unit {
        if (purpose != "REGISTER" && purpose != "LOGIN" && purpose != "PASSWORD_RESET") {
            throw BusinessException(ErrorCode.VALIDATION_FAILED, 400, "验证码用途不合法")
        }
    }
    private static func invalidCode(): BusinessException {
        return BusinessException(ErrorCode.VERIFICATION_CODE_INVALID, 400, "验证码错误或已失效")
    }
}
