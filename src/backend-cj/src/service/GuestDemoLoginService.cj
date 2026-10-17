package web.service

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
    public func guestLogin(persona: String, ip: Option<String>, agent: Option<String>): LoginResponse {
        let preset = DemoPersona.select(persona)
        return DbTransaction.run<LoginResponse>(database, { tx =>
            repository.lockGuest(tx, preset.email)
            let organization = repository.guestOrganization(tx)
            let user = repository.guestUser(tx, preset, organization,
                { => BCryptPasswordEncoder().encode(AuthUtilities.uuid()) })
            let learnerId = repository.guestLearner(tx, user, preset)
            return issue(tx, user, true, learnerId, Some(organization), ip, agent)
        })
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
