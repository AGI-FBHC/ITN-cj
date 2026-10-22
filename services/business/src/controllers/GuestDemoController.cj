package web.controllers

import std.unicode.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import web.config.*
import web.dto.DemoLoginRequest
import web.exception.*
import web.service.AccountAccessService
import web.service.GuestDemoLoginService
import web.service.ProfileJson

public class GuestDemoController {
    private let service: GuestDemoLoginService
    private let access: AccountAccessService
    public init(database: DatabaseConfig, auth: AuthConfig) {
        this.service = GuestDemoLoginService(database, auth)
        this.access = AccountAccessService(database, auth)
    }
    public func guestLogin(context: HttpContext): Unit {
        respond(context, { =>
            let persona = context.request.query.get("persona").getOrDefault({ => "default" })
            /* device：浏览器本地生成的设备标识，用来给每台电脑分配独立的游客账号 */
            let device = context.request.query.get("device")
            return AuthController.successJson(service.guestLogin(persona, device,
                AuthController.clientIp(context.request.remoteAddr), context.request.headers["User-Agent"].first), "游客登录成功")
        })
    }
    /** 游客退出登录：清空这个游客账号名下的讲义/实操/会话等使用记录，下次体验从零开始 */
    public func guestReset(context: HttpContext): Unit {
        respond(context, { =>
            let user = access.authenticate(AccountAccessController.bearer(context))
            service.resetGuest(user)
            return ProfileJson.wrap("游客体验数据已清空", None)
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
            context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
            println("Guest/demo login failed: " + e.message)
        }
    }
}
