package web.service

import std.unicode.*
import web.domain.*
import web.dto.LoginRequest
import web.exception.*
import web.repository.UserRepository
import web.security.BCryptPasswordEncoder

public class PasswordLoginService {
    private let users: UserRepository
    private let passwords = BCryptPasswordEncoder()

    public init(users: UserRepository) {
        this.users = users
    }

    // Authenticate credentials; token/session creation is handled separately.
    public func authenticate(request: LoginRequest): User {
        let email = normalizeEmail(request.email)
        let user = match (users.findByEmail(email)) {
            case Some(found) => found
            case None => throw invalidCredentials()
        }
        match (user.getAccountType()) {
            case AccountType.LEARNER => ()
            case _ => throw invalidCredentials()
        }
        if (!passwords.matches(request.password, user.getPasswordHash())) {
            throw invalidCredentials()
        }
        if (!user.isActive()) {
            throw BusinessException(ErrorCode.ACCOUNT_DISABLED, 403, "账户已停用")
        }
        return user
    }

    // Java String.trim() removes leading/trailing code points <= U+0020.
    private static func normalizeEmail(email: String): String {
        let bytes = email.toArray()
        var start = 0
        var end = bytes.size
        while (start < end && bytes[start] <= 32) { start += 1 }
        while (end > start && bytes[end - 1] <= 32) { end -= 1 }
        return String.fromUtf8(bytes.slice(start, end - start)).toLower(CasingOption.Other)
    }

    private static func invalidCredentials(): BusinessException {
        return BusinessException(ErrorCode.INVALID_CREDENTIALS, 401, "身份或密码错误")
    }
}
