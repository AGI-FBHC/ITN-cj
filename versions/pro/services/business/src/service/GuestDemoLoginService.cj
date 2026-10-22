package web.service

import std.unicode.*
import web.config.*
import web.database.DbTransaction
import web.domain.*
import web.dto.*
import web.exception.*
import web.repository.*
import web.security.*

public class GuestDemoLoginService {
    private let database: DatabaseConfig
    private let auth: AuthConfig
    private let repository = GuestDemoRepository()
    public init(database: DatabaseConfig, auth: AuthConfig) {
        this.database = database
        this.auth = auth
    }
    public func guestLogin(persona: String, device: Option<String>, ip: Option<String>, agent: Option<String>): LoginResponse {
        let base = DemoPersona.select(persona)
        /* 每台电脑一个独立游客账号：别的电脑用同一画像进来，也看不到这台电脑的体验数据 */
        let preset = withDevice(base, persona, device)
        return DbTransaction.run<LoginResponse>(database, { tx =>
            repository.lockGuest(tx, preset.email)
            let organization = repository.guestOrganization(tx)
            let user = repository.guestUser(tx, preset, organization,
                { => BCryptPasswordEncoder().encode(AuthUtilities.uuid()) })
            /* 每次进入游客体验都是全新状态：先清掉上一次留在该账号下的讲义、养分、会话等记录 */
            AdminLearnerResetService(database).purgeUsage(tx, user.getId())
            let learnerId = repository.guestLearner(tx, user, preset)
            return issue(tx, user, true, learnerId, Some(organization), ip, agent)
        })
    }
    private static func personaKey(persona: String): String {
        if (persona == "beginner") { return "beginner" }
        if (persona == "practitioner" || persona == "advanced") { return "practitioner" }
        return "research"
    }
    /** 把预设画像复制一份，只把账号换成「guest-画像-设备号@itn.local」 */
    private static func withDevice(base: DemoPersona, persona: String, device: Option<String>): DemoPersona {
        var email = base.email
        if (let Some(raw) <- device) {
            let clean = raw.trim().toLower(CasingOption.Other)
            var valid = clean.size >= 8 && clean.size <= 40
            if (valid) {
                for (byte in clean.toArray()) {
                    if (!((byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || byte == 45)) { valid = false }
                }
            }
            if (valid) { email = "guest-" + personaKey(persona) + "-" + clean + "@itn.local" }
        }
        return DemoPersona(email, base.name, base.avatar, base.role, base.education, base.targetJob,
            base.weeklyHours, base.learningStyles, base.scores, base.goal, base.blindSpots, base.diagnosis)
    }
    /** 游客退出登录时清空自己的学习记录（游客账号是公用的，不清会带到下一次体验） */
    public func resetGuest(user: User): Unit {
        let email = user.getEmail().trim().toLower(CasingOption.Other)
        if (!email.startsWith("guest")) {
            throw BusinessException(ErrorCode.INVALID_CREDENTIALS, 403, "只有游客账号可以清空体验数据")
        }
        AdminLearnerResetService(database).resetSelf(user)
    }
    public func demoLogin(request: DemoLoginRequest, ip: Option<String>, agent: Option<String>): LoginResponse {
        let learnerCode = AuthUtilities.normalizeEmail(request.learnerCode)
        return DbTransaction.run<LoginResponse>(database, { tx =>
            let user = repository.demoUser(tx, learnerCode)
            if (!user.isActive()) { throw BusinessException(ErrorCode.ACCOUNT_DISABLED, 403, "账户已停用") }
            match (user.getAccountType()) {
                case AccountType.LEARNER => ()
                case _ => throw BusinessException(ErrorCode.INVALID_CREDENTIALS, 401, "身份或密码错误")
            }
            // The legacy API intentionally returns the demo identity code here, not a UUID.
            return issue(tx, user, false, learnerCode, repository.organizationForUser(tx, user), ip, agent)
        })
    }
    private func issue(tx: DbTransaction, user: User, guest: Bool, learnerId: String,
        organization: Option<DemoOrganization>, ip: Option<String>, agent: Option<String>): LoginResponse {
        let token = JwtService(auth).generate(user)
        var organizationCode: Option<String> = None
        var organizationName: Option<String> = None
        if (let Some(value) <- organization) {
            organizationCode = Some(value.code)
            organizationName = Some(value.name)
        }
        let result = LoginResponse(token.value, "Bearer", auth.accessTokenTtlSeconds, UserResponse.from(user),
            Some(learnerId), guest, organizationCode, organizationName, None,
            if (guest) { ["guest"] } else { ["learner"] })
        UserSessionRepository(database).save(tx, user, token, ip, agent)
        return result
    }
}
