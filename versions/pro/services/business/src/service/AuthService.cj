package web.service
import web.config.AuthConfig
import web.config.DatabaseConfig
import web.dto.LoginRequest
import web.dto.LoginResponse
import web.dto.UserResponse
import web.repository.UserRepository
import web.repository.UserSessionRepository
import web.repository.LoginContextRepository
import web.security.JwtService
// Migration of the legacy AuthService.login password-login flow.
public class AuthService {
    private let passwordLogin: PasswordLoginService
    private let jwt: JwtService
    private let sessions: UserSessionRepository
    private let loginContext: LoginContextRepository
    private let config: AuthConfig
    public init(databaseConfig: DatabaseConfig, authConfig: AuthConfig) {
        this.passwordLogin = PasswordLoginService(UserRepository(databaseConfig))
        this.jwt = JwtService(authConfig)
        this.sessions = UserSessionRepository(databaseConfig)
        this.loginContext = LoginContextRepository(databaseConfig)
        this.config = authConfig
    }
    public func login(request: LoginRequest, ipAddress: Option<String>,
        userAgent: Option<String>): LoginResponse {
        let user = passwordLogin.authenticate(request)
        // Complete the response lookups before saving a durable login session.
        let context = loginContext.load(user)
        let token = jwt.generate(user)
        let response = LoginResponse(
            token.value,
            "Bearer",
            config.accessTokenTtlSeconds,
            UserResponse.from(user),
            context.learnerId,
            false,
            context.organizationCode,
            context.organizationName,
            None,
            ["learner"]
        )
        sessions.save(user, token, ipAddress, userAgent)
        return response
    }
}
