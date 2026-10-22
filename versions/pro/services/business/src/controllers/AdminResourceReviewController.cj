package web.controllers

import soulsoft_web_http.*
import stdx.encoding.json.*
import web.config.*
import web.domain.User
import web.exception.*
import web.service.*

public class AdminResourceReviewController {
    private let access: AccountAccessService
    private let resources: AdminResourceReviewService
    public init(database: DatabaseConfig, auth: AuthConfig) {
        access = AccountAccessService(database, auth)
        resources = AdminResourceReviewService(database)
    }
    public func restore(context: HttpContext): Unit {
        handle(context, { user => resources.restore(user, id(context)); return ProfileJson.wrap("资源已恢复到机构资源库草稿", None) })
    }
    public func candidate(context: HttpContext): Unit {
        handle(context, { user =>
            let next = resources.candidate(user, id(context))
            return ProfileJson.wrap("已复制为通用资源草稿", Some(ProfileJson.row(["id"], [Some(next)], Array<Int64>())))
        })
    }
    public func review(context: HttpContext): Unit {
        handle(context, { user =>
            let object = body(context, false)
            resources.review(user, id(context), ProfileJson.text(object, "action", 2147483647).getOrDefault({ => "" }), ProfileJson.text(object, "comment", 2147483647))
            return ProfileJson.wrap("审核状态已更新", None)
        })
    }
    public func archive(context: HttpContext): Unit {
        handle(context, { user => resources.archive(user, id(context), ProfileJson.text(body(context, true), "reason", 2147483647)); return ProfileJson.wrap("资源已归档", None) })
    }
    public func deletePermanently(context: HttpContext): Unit {
        handle(context, { user => resources.deletePermanently(user, id(context)); return ProfileJson.wrap("资源已彻底删除", None) })
    }
    public func purgeArchived(context: HttpContext): Unit {
        handle(context, { user => let count = resources.purgeArchived(user); return ProfileJson.wrap("已彻底清理 " + count.toString() + " 条归档内容", None) })
    }
    private func handle(context: HttpContext, work: (User) -> String): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try {
            let user = access.authenticate(AccountAccessController.bearer(context))
            AccountAccessService.requireAdmin(user)
            context.response.write(work(user))
        } catch (e: BusinessException) {
            context.response.statusCode = UInt16(e.status)
            context.response.write(AuthController.errorJson(e.code, e.message))
        } catch (e: Exception) {
            context.response.statusCode = 500
            context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
            println("Admin resource review request failed: " + e.message)
        }
    }
    private static func id(context: HttpContext): String { return context.request.routeValues.get("id").getOrDefault({ => throw ProfileJson.invalid("缺少资源id") }) }
    private static func body(context: HttpContext, optional: Bool): JsonObject {
        let text = AuthController.readBody(context)
        if (optional && (text.isEmpty() || text == "null")) { return JsonValue.fromStr("{}").asObject() }
        try { return JsonValue.fromStr(text).asObject() } catch (_: Exception) { throw ProfileJson.invalid("请求必须是 JSON 对象") }
    }
}
