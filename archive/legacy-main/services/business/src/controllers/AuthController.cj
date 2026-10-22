package web.controllers

import std.collection.ArrayList
import std.regex.Regex
import std.time.DateTime
import std.unicode.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import web.dto.LoginRequest
import web.dto.LoginResponse
import web.dto.UserResponse
import web.exception.*
import web.service.AuthService

public class AuthController {
    private let service: AuthService

    public init(service: AuthService) {
        this.service = service
    }

    public func login(context: HttpContext): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try {
            let contentType = context.request.contentType.getOrDefault({ => "" })
                .split(";")[0].trim().toLower(CasingOption.Other)
            if (contentType != "application/json") {
                throw BusinessException(ErrorCode.VALIDATION_FAILED, 415,
                    "Content-Type must be application/json")
            }
            let request = parseRequest(readBody(context))
            let result = service.login(request, clientIp(context.request.remoteAddr),
                context.request.headers["User-Agent"].first)
            context.response.statusCode = 200
            context.response.write(successJson(result))
        } catch (e: BusinessException) {
            context.response.statusCode = UInt16(e.status)
            context.response.write(errorJson(e.code, e.message))
        } catch (_: Exception) {
            context.response.statusCode = 500
            context.response.write(errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
            println("Password login failed with an internal error")
        }
    }

    public static func parseRequest(body: String): LoginRequest {
        try {
            let object = JsonValue.fromStr(body).asObject()
            let email = object.get("email").getOrThrow().asString().getValue()
            let password = object.get("password").getOrThrow().asString().getValue()
            if (email.trim().isEmpty() || password.trim().isEmpty() ||
                !Regex("^[^\\s@]+@[^\\s@]+$").matches(email)) {
                throw IllegalArgumentException("Invalid login fields")
            }
            return LoginRequest(email, password)
        } catch (_: Exception) {
            throw BusinessException(ErrorCode.VALIDATION_FAILED, 400,
                "请提供有效的邮箱和非空密码")
        }
    }

    public static func successJson(result: LoginResponse): String {
        return successJson(result, "登录成功")
    }
    public static func successJson(result: LoginResponse, message: String): String {
        let user = result.user
        var roles = "["
        for (i in 0..result.roles.size) {
            if (i > 0) { roles += "," }
            roles += quoted(result.roles[i])
        }
        roles += "]"
        let data = "{\"accessToken\":" + quoted(result.accessToken) +
            ",\"tokenType\":" + quoted(result.tokenType) +
            ",\"expiresInSeconds\":${result.expiresInSeconds},\"user\":{" +
            "\"id\":" + quoted(user.id) + ",\"email\":" + quoted(user.email) +
            ",\"nickname\":" + nullable(user.nickname) +
            ",\"active\":${user.active},\"createdAt\":" + quoted(user.createdAt) + "}," +
            "\"learnerId\":" + nullable(result.learnerId) + ",\"guest\":${result.guest}," +
            "\"organizationCode\":" + nullable(result.organizationCode) +
            ",\"organizationName\":" + nullable(result.organizationName) +
            ",\"departmentName\":" + nullable(result.departmentName) +
            ",\"roles\":" + roles + "}"
        return "{\"code\":0,\"message\":" + quoted(message) +
            ",\"data\":" + data + ",\"timestamp\":" +
            quoted(DateTime.nowUTC().toString()) + "}"
    }

    public static func errorJson(code: Int32, message: String): String {
        // Legacy ApiResponse omits null data on errors.
        return "{\"code\":${code},\"message\":" + quoted(message) +
            ",\"timestamp\":" + quoted(DateTime.nowUTC().toString()) + "}"
    }

    private static func quoted(value: String): String {
        return JsonString(value).toString()
    }

    private static func nullable(value: Option<String>): String {
        match (value) {
            case None => return "null"
            case Some(text) => return quoted(text)
        }
    }

    public static func readBody(context: HttpContext): String {
        let bytes = ArrayList<UInt8>()
        let buffer = Array<UInt8>(4096, repeat: 0u8)
        while (true) {
            let count = context.request.body.read(buffer)
            if (count == 0) { break }
            if (bytes.size + count > 65536) {
                throw BusinessException(ErrorCode.VALIDATION_FAILED, 413, "登录请求过大")
            }
            for (i in 0..count) { bytes.add(buffer[i]) }
        }
        try {
            return String.fromUtf8(bytes.toArray())
        } catch (_: Exception) {
            throw BusinessException(ErrorCode.VALIDATION_FAILED, 400, "请求必须使用 UTF-8")
        }
    }

    public static func clientIp(address: String): Option<String> {
        if (address.isEmpty()) { return None }
        if (address.startsWith("[")) {
            let host = address.split("]")[0].toArray()
            return Some(String.fromUtf8(host.slice(1, host.size - 1)))
        }
        let parts = address.split(":")
        if (parts.size == 2 && address.contains(".")) { return Some(parts[0]) }
        return Some(address)
    }
    public static func userJson(user: UserResponse): String {
        return "{\"id\":" + quoted(user.id) + ",\"email\":" + quoted(user.email) +
            ",\"nickname\":" + nullable(user.nickname) + ",\"active\":${user.active}," +
            "\"createdAt\":" + quoted(user.createdAt) + "}"
    }
}
