package web.dto

public class LoginRequest {
    public let email: String
    public let password: String

    public init(email: String, password: String) {
        this.email = email
        this.password = password
    }
}