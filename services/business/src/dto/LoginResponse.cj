package web.dto
public class LoginResponse {
    public let accessToken: String
    public let tokenType: String
    public let expiresInSeconds: Int64
    public let user: UserResponse
    public let learnerId: Option<String>
    public let guest: Bool
    public let organizationCode: Option<String>
    public let organizationName: Option<String>
    public let departmentName: Option<String>
    public let roles: Array<String>
    public init(
        accessToken: String,
        tokenType: String,
        expiresInSeconds: Int64,
        user: UserResponse,
        learnerId: Option<String>,
        guest: Bool,
        organizationCode: Option<String>,
        organizationName: Option<String>,
        departmentName: Option<String>,
        roles: Array<String>
    ) {
        this.accessToken = accessToken
        this.tokenType = tokenType
        this.expiresInSeconds = expiresInSeconds
        this.user = user
        this.learnerId = learnerId
        this.guest = guest
        this.organizationCode = organizationCode
        this.organizationName = organizationName
        this.departmentName = departmentName
        this.roles = roles
    }
    public init(
        accessToken: String,
        tokenType: String,
        expiresInSeconds: Int64,
        user: UserResponse
    ) {
        this.accessToken = accessToken
        this.tokenType = tokenType
        this.expiresInSeconds = expiresInSeconds
        this.user = user
        this.learnerId = None
        this.guest = false
        this.organizationCode = None
        this.organizationName = None
        this.departmentName = None
        this.roles = []
    }
}
