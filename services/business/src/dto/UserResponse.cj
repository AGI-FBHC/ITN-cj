package web.dto
import web.domain.User
public class UserResponse {
    public let id: String
    public let email: String
    public let nickname: Option<String>
    public let active: Bool
    public let createdAt: String
    public init(
        id: String,
        email: String,
        nickname: Option<String>,
        active: Bool,
        createdAt: String
    ) {
        this.id = id
        this.email = email
        this.nickname = nickname
        this.active = active
        this.createdAt = createdAt
    }
    public init(id: String, email: String, nickname: String, active: Bool, createdAt: String) {
        this(id, email, Some(nickname), active, createdAt)
    }
    public static func from(user: User): UserResponse {
        return UserResponse(
            user.getId(),
            user.getEmail(),
            user.getNickname(),
            user.isActive(),
            user.getCreatedAt()
        )
    }
}
