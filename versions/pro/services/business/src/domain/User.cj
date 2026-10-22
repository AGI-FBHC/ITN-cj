package web.domain
import std.time.DateTime
// Existing database rows are supplied by the repository constructor below.
// UUID strings must be converted to/from the legacy BINARY(16) columns there.
public class User {
    private let id: String
    private let email: String
    private var passwordHash: String
    private let nickname: Option<String>
    private var active: Bool
    private let accountType: AccountType
    private var organizationId: Option<String>
    private let adminScope: Option<AdminScope>
    private let createdAt: String
    private var updatedAt: String
    public init(
        id: String,
        email: String,
        passwordHash: String,
        nickname: Option<String>,
        active: Bool,
        accountType: AccountType,
        organizationId: Option<String>,
        adminScope: Option<AdminScope>,
        createdAt: String,
        updatedAt: String
    ) {
        this.id = id
        this.email = email
        this.passwordHash = passwordHash
        this.nickname = nickname
        this.active = active
        this.accountType = accountType
        this.organizationId = organizationId
        this.adminScope = adminScope
        this.createdAt = createdAt
        this.updatedAt = updatedAt
    }
    public func changePassword(passwordHash: String): Unit {
        this.passwordHash = passwordHash
        this.updatedAt = DateTime.nowUTC().toString()
    }
    public func setActive(active: Bool): Unit {
        this.active = active
        this.updatedAt = DateTime.nowUTC().toString()
    }
    public func assignOrganization(organizationId: Option<String>): Unit {
        this.organizationId = organizationId
        this.updatedAt = DateTime.nowUTC().toString()
    }
    public func getId(): String { return id }
    public func getEmail(): String { return email }
    public func getPasswordHash(): String { return passwordHash }
    public func getNickname(): Option<String> { return nickname }
    public func isActive(): Bool { return active }
    public func getAccountType(): AccountType { return accountType }
    public func getOrganizationId(): Option<String> { return organizationId }
    public func getAdminScope(): Option<AdminScope> { return adminScope }
    public func getCreatedAt(): String { return createdAt }
    public func getUpdatedAt(): String { return updatedAt }
}