package web.controllers

import std.regex.Regex
import std.unicode.*
import std.time.DateTime
import stdx.encoding.json.*
import soulsoft_web_http.*
import web.config.*
import web.dto.*
import web.exception.*
import web.service.*

public class VerificationController {
    private let codes: VerificationCodeService
    private let registrations: RegistrationService
    private let logins: EmailCodeLoginService
    private let enterprises: EnterpriseRegistrationService
    public init(database: DatabaseConfig, auth: AuthConfig) {
        this.codes = VerificationCodeService(database, auth, VerificationMailService(MailConfig.fromEnvironment()))
        this.registrations = RegistrationService(database, codes)
        this.logins = EmailCodeLoginService(database, auth, codes)
        this.enterprises = EnterpriseRegistrationService(database, auth, codes)
    }
    public func sendCode(context: HttpContext): Unit {
        handle(context, 200, { object =>
            let result = codes.send(emailField(object), stringField(object, "purpose"))
            return wrap("验证码已发送", "{\"email\":" + quoted(result.email) +
                ",\"expiresInSeconds\":${result.expiresInSeconds},\"retryAfterSeconds\":${result.retryAfterSeconds}}")
        })
    }
    public func register(context: HttpContext): Unit {
        handle(context, 201, { object =>
            let result = registrations.register(parseRegister(object))
            return wrap("注册成功", AuthController.userJson(result))
        })
    }
    public func registerEnterprise(context: HttpContext): Unit {
        handle(context, 201, { object =>
            let request = parseRegister(object)
            let result = enterprises.register(request, AuthController.clientIp(context.request.remoteAddr),
                context.request.headers["User-Agent"].first)
            let loginData = JsonValue.fromStr(AuthController.successJson(result.login)).asObject()
                .get("data").getOrThrow().toString()
            return wrap("机构成员注册成功", "{\"login\":" + loginData +
                ",\"employeeNo\":" + quoted(result.employeeNo) +
                ",\"organizationName\":" + quoted(result.organizationName) + "}")
        })
    }
    public func emailCodeLogin(context: HttpContext): Unit {
        handle(context, 200, { object =>
            let request = EmailCodeLoginRequest(emailField(object), codeField(object))
            let response = logins.login(request, AuthController.clientIp(context.request.remoteAddr),
                context.request.headers["User-Agent"].first)
            return AuthController.successJson(response)
        })
    }
    public static func parseRegister(object: JsonObject): RegisterRequest {
        let email = emailField(object)
        let password = stringField(object, "password")
        var hasLetter = false
        var hasDigit = false
        for (byte in password.toArray()) {
            if ((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) { hasLetter = true }
            if (byte >= 48 && byte <= 57) { hasDigit = true }
        }
        let length = utf16Length(password)
        if (length < 8 || length > 64 || !hasLetter || !hasDigit || password.contains("\n") || password.contains("\r")) {
            throw invalid("密码须为 8–64 位，且同时包含字母和数字")
        }
        var nickname: Option<String> = None
        if (let Some(value) <- object.get("nickname")) {
            if (value.toString() != "null") {
                try { nickname = Some(value.asString().getValue()) }
                catch (_: Exception) { throw invalid("昵称必须为文本") }
            }
        }
        if (let Some(value) <- nickname) {
            if (utf16Length(value) > 64) { throw invalid("昵称最多 64 位") }
        }
        return RegisterRequest(email, password, nickname, codeField(object))
    }
    private static func handle(context: HttpContext, status: UInt16, work: (JsonObject) -> String): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try {
            let contentType = context.request.contentType.getOrDefault({ => "" })
                .split(";")[0].trim().toLower(CasingOption.Other)
            if (contentType != "application/json") {
                throw BusinessException(ErrorCode.VALIDATION_FAILED, 415, "Content-Type must be application/json")
            }
            let body = AuthController.readBody(context)
            let object = try { JsonValue.fromStr(body).asObject() }
                catch (_: Exception) { throw invalid("请求必须是 JSON 对象") }
            let response = work(object)
            context.response.statusCode = status
            context.response.write(response)
        } catch (e: BusinessException) {
            context.response.statusCode = UInt16(e.status)
            context.response.write(AuthController.errorJson(e.code, e.message))
        } catch (_: Exception) {
            context.response.statusCode = 500
            context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
            println("Verification/register request failed with an internal error")
        }
    }
    private static func stringField(object: JsonObject, name: String): String {
        try { return object.get(name).getOrThrow().asString().getValue() }
        catch (_: Exception) { throw invalid("缺少有效字段：${name}") }
    }
    private static func emailField(object: JsonObject): String {
        let value = stringField(object, "email")
        if (utf16Length(value) > 255 || !Regex("^[^\\s@]+@[^\\s@]+$").matches(value)) {
            throw invalid("请填写有效的邮箱")
        }
        return value
    }
    private static func codeField(object: JsonObject): String {
        let value = stringField(object, "verificationCode")
        if (!Regex("^[0-9]{6}$").matches(value)) { throw invalid("验证码必须为 6 位数字") }
        return value
    }
    private static func utf16Length(value: String): Int64 {
        var units = 0
        for (byte in value.toArray()) {
            if (byte < 128 || byte >= 192) { units += if (byte >= 240) { 2 } else { 1 } }
        }
        return units
    }
    private static func quoted(value: String): String { return JsonString(value).toString() }
    private static func wrap(message: String, data: String): String {
        return "{\"code\":0,\"message\":" + quoted(message) + ",\"data\":" + data +
            ",\"timestamp\":" + quoted(DateTime.nowUTC().toString()) + "}"
    }
    private static func invalid(message: String): BusinessException {
        return BusinessException(ErrorCode.VALIDATION_FAILED, 400, message)
    }
}
