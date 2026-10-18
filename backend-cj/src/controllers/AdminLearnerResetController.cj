package web.controllers

import soulsoft_web_http.*
import web.config.*
import web.exception.*
import web.service.*

public class AdminLearnerResetController {
    private let access: AccountAccessService
    private let resetter: AdminLearnerResetService
    public init(database: DatabaseConfig, auth: AuthConfig) {
        access = AccountAccessService(database, auth)
        resetter = AdminLearnerResetService(database)
    }
    public func reset(context: HttpContext): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try {
            let admin = access.authenticate(AccountAccessController.bearer(context))
            let id = context.request.routeValues.get("id").getOrDefault({ => throw ProfileJson.invalid("缺少账号id") })
            let data = resetter.reset(admin, id, context.request.headers["X-Request-Id"].first)
            context.response.write(ProfileJson.wrap("使用记录已重置，该账号将重新进入画像建档", Some(data)))
        } catch (e: BusinessException) {
            context.response.statusCode = UInt16(e.status)
            context.response.write(AuthController.errorJson(e.code, e.message))
        } catch (e: Exception) {
            context.response.statusCode = 500
            context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
            println("Learner reset request failed: " + e.message)
        }
    }
}
