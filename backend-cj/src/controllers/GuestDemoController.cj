package web.controllers

import std.unicode.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import web.config.*
import web.dto.DemoLoginRequest
import web.exception.*
import web.service.GuestDemoLoginService

public class GuestDemoController {
    private let service: GuestDemoLoginService
    public init(database: DatabaseConfig, auth: AuthConfig) {
        this.service = GuestDemoLoginService(database, auth)
    }
    public func guestLogin(context: HttpContext): Unit {
        respond(context, { =>
            let persona = context.request.query.get("persona").getOrDefault({ => "default" })
            return AuthController.successJson(service.guestLogin(persona,
                AuthController.clientIp(context.request.remoteAddr), context.request.headers["User-Agent"].first), "游客登录成功")
        })
    }
    public func demoLogin(context: HttpContext): Unit {
        respond(context, { =>
            let contentType = context.request.contentType.getOrDefault({ => "" })
                .split(";")[0].trim().toLower(CasingOption.Other)
            if (contentType != "application/json") {
                throw BusinessException(ErrorCode.VALIDATION_FAILED, 415, "Content-Type must be application/json")
            }
            let request = parseDemoRequest(AuthController.readBody(context))
            return AuthController.successJson(service.demoLogin(request,
                AuthController.clientIp(context.request.remoteAddr), context.request.headers["User-Agent"].first), "演示画像登录成功")
        })
    }
    public static func parseDemoRequest(body: String): DemoLoginRequest {
        try {
            let code = JsonValue.fromStr(body).asObject().get("learnerCode").getOrThrow().asString().getValue()
            var units = 0
            for (byte in code.toArray()) {
                if (byte < 128 || byte >= 192) { units += if (byte >= 240) { 2 } else { 1 } }
            }
            if (code.trim().isEmpty() || units > 64) { throw IllegalArgumentException("Invalid demo code") }
            return DemoLoginRequest(code)
        } catch (_: Exception) {
            throw BusinessException(ErrorCode.VALIDATION_FAILED, 400, "请提供 1–64 位的演示画像编号")
        }
    }
    private static func respond(context: HttpContext, work: () -> String): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try {
            let result = work()
            context.response.statusCode = 200
            context.response.write(result)
        } catch (e: BusinessException) {
            context.response.statusCode = UInt16(e.status)
            context.response.write(AuthController.errorJson(e.code, e.message))
        } catch (e: Exception) {
            context.response.statusCode = 500
            context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误: " + e.message))
            println("Guest/demo login failed: " + e.message)
        }
    }
}
