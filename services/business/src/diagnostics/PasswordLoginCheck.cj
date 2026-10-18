package web.diagnostics

import std.env.getStdIn
import web.config.DatabaseConfig
import web.dto.LoginRequest
import web.exception.BusinessException
import web.repository.UserRepository
import web.service.PasswordLoginService

// Explicit command-line check; normal web startup does not read credentials.
public class PasswordLoginCheck {
    private init() {}
    public static func run(config: DatabaseConfig): Int64 {
        let email = getStdIn().readln()
        let password = getStdIn().readln()
        if (email.isNone() || password.isNone()) {
            println("Password check input missing")
            return 2
        }
        try {
            let service = PasswordLoginService(UserRepository(config))
            let user = service.authenticate(LoginRequest(email.getOrThrow(), password.getOrThrow()))
            println("Password authentication passed")
            println("User: ${user.getEmail()}")
            println("Active: ${user.isActive()}")
            return 0
        } catch (e: BusinessException) {
            println("Password authentication rejected")
            println("Code: ${e.code}; HTTP status: ${e.status}")
            println(e.message)
            return 1
        }
    }
}
