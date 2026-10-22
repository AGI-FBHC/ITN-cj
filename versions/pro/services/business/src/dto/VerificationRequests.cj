package web.dto

public class RegisterRequest {
    public let email: String
    public let password: String
    public let nickname: Option<String>
    public let verificationCode: String
    public init(email: String, password: String, nickname: Option<String>, verificationCode: String) {
        this.email = email
        this.password = password
        this.nickname = nickname
        this.verificationCode = verificationCode
    }
}

public class EmailCodeLoginRequest {
    public let email: String
    public let verificationCode: String
    public init(email: String, verificationCode: String) {
        this.email = email
        this.verificationCode = verificationCode
    }
}

public class SendVerificationCodeResponse {
    public let email: String
    public let expiresInSeconds: Int64
    public let retryAfterSeconds: Int64
    public init(email: String, expiresInSeconds: Int64, retryAfterSeconds: Int64) {
        this.email = email
        this.expiresInSeconds = expiresInSeconds
        this.retryAfterSeconds = retryAfterSeconds
    }
}
