package web.controllers

import soulsoft_web_http.*
import web.config.*
import web.exception.*
import web.domain.User
import web.service.*

public class GrowthReportController {
    private let access: AccountAccessService
    private let journals: LearningJournalService
    private let reports: GrowthReportService
    public init(database: DatabaseConfig, auth: AuthConfig) {
        access = AccountAccessService(database, auth)
        journals = LearningJournalService(database)
        reports = GrowthReportService(database)
    }
    public func journal(context: HttpContext, generate: Bool): Unit {
        handle(context, if (generate) { "当日总结已生成" } else { "success" }, { user =>
            let date = context.request.query.get("date")
            return if (generate) { journals.generate(user, date) } else { journals.get(user, date) }
        })
    }
    public func report(context: HttpContext): Unit {
        handle(context, "success", { user => reports.get(user, context.request.query.get("learnerId")) })
    }
    private func handle(context: HttpContext, message: String, work: (User) -> String): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try {
            let user = access.authenticate(AccountAccessController.bearer(context))
            context.response.write(ProfileJson.wrap(message, Some(work(user))))
        } catch (e: BusinessException) {
            context.response.statusCode = UInt16(e.status)
            context.response.write(AuthController.errorJson(e.code, e.message))
        } catch (e: Exception) {
            context.response.statusCode = 500
            context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
            println("Growth report request failed: " + e.message)
        }
    }
}
