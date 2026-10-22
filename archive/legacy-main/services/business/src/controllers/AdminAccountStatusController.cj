package web.controllers

import soulsoft_web_http.*
import web.config.*
import web.exception.*
import web.service.*

public class AdminAccountStatusController {
    private let access: AccountAccessService
    private let accounts: AdminAccountStatusService
    public init(database: DatabaseConfig, auth: AuthConfig) {
        access = AccountAccessService(database, auth)
        accounts = AdminAccountStatusService(database)
    }
    public func setEnabled(context: HttpContext, enabled: Bool): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try {
            let admin = access.authenticate(AccountAccessController.bearer(context))
            let id = context.request.routeValues.get("id").getOrDefault({ => throw ProfileJson.invalid("缺少账号id") })
            let data = accounts.setEnabled(admin, id, enabled, context.request.headers["X-Request-Id"].first)
            context.response.write(ProfileJson.wrap(if (enabled) { "账号已启用" } else { "账号已停用" }, Some(data)))
        } catch (e: BusinessException) {
            context.response.statusCode = UInt16(e.status)
            context.response.write(AuthController.errorJson(e.code, e.message))
        } catch (e: Exception) {
            context.response.statusCode = 500
            context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
            println("Admin account status request failed: " + e.message)
        }
    }
}
