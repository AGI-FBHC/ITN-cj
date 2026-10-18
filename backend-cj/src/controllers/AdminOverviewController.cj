package web.controllers

import std.convert.*
import soulsoft_web_http.*
import web.config.*
import web.domain.User
import web.exception.*
import web.service.*

public class AdminOverviewController {
    private let access: AccountAccessService
    private let overview: AdminOverviewService
    public init(database: DatabaseConfig, auth: AuthConfig) {
        access = AccountAccessService(database, auth)
        overview = AdminOverviewService(database)
    }
    public func users(context: HttpContext): Unit {
        handle(context, { user => overview.users(user, integer(context, "page", 0), integer(context, "size", 20)) })
    }
    public func user(context: HttpContext): Unit {
        handle(context, { user => overview.user(user, context.request.routeValues.get("id").getOrDefault({ => throw ProfileJson.invalid("缺少账号id") })) })
    }
    public func stats(context: HttpContext): Unit { handle(context, { user => overview.resourceStats(user) }) }
    private func handle(context: HttpContext, work: (User) -> String): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try {
            let user = access.authenticate(AccountAccessController.bearer(context))
            AccountAccessService.requireAdmin(user)
            context.response.write(ProfileJson.wrap("success", Some(work(user))))
        } catch (e: BusinessException) {
            context.response.statusCode = UInt16(e.status)
            context.response.write(AuthController.errorJson(e.code, e.message))
        } catch (e: Exception) {
            context.response.statusCode = 500
            context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
            println("Admin overview request failed: " + e.message)
        }
    }
    private static func integer(context: HttpContext, key: String, fallback: Int64): Int64 {
        if (let Some(text) <- context.request.query.get(key)) {
            try {
                let value = Int64.parse(text)
                if (value < -2147483648 || value > 2147483647) { throw Exception("out of range") }
                return value
            } catch (_: Exception) { throw ProfileJson.invalid(key + " 必须为有效整数") }
        }
        return fallback
    }
}
