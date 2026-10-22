package web.controllers

import soulsoft_web_http.*
import web.config.*
import web.domain.User
import web.exception.*
import web.service.*

public class AdminResourceGroupController {
    private let access: AccountAccessService
    private let catalog: AdminResourceCatalogService
    private let groups: AdminResourceGroupService
    public init(database: DatabaseConfig, auth: AuthConfig) {
        access = AccountAccessService(database, auth)
        catalog = AdminResourceCatalogService(database)
        groups = AdminResourceGroupService(database)
    }
    public func list(context: HttpContext): Unit {
        handle(context, "success", { user => Some(catalog.list(user, context.request.query.get("view").getOrDefault({ => "library" }),
            context.request.query.get("type"), context.request.query.get("keyword"), context.request.query.get("domainCode"), context.request.query.get("nodeCode"))) })
    }
    public func detail(context: HttpContext): Unit { handle(context, "success", { user => Some(catalog.detail(user, id(context))) }) }
    public func template(context: HttpContext): Unit {
        handle(context, "已设为母版", { user => groups.template(user, id(context)); return None })
    }
    public func deleteGroup(context: HttpContext): Unit {
        handle(context, "分组已彻底删除", { user =>
            groups.deleteGroup(user, query(context, "domainCode"), query(context, "nodeCode"), query(context, "groupName")); return None
        })
    }
    private func handle(context: HttpContext, message: String, work: (User) -> Option<String>): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try {
            let user = access.authenticate(AccountAccessController.bearer(context))
            AccountAccessService.requireAdmin(user)
            context.response.write(ProfileJson.wrap(message, work(user)))
        } catch (e: BusinessException) {
            context.response.statusCode = UInt16(e.status)
            context.response.write(AuthController.errorJson(e.code, e.message))
        } catch (e: Exception) {
            context.response.statusCode = 500
            context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
            println("Admin resource group request failed: " + e.message)
        }
    }
    private static func id(context: HttpContext): String { return context.request.routeValues.get("id").getOrDefault({ => throw ProfileJson.invalid("缺少资源id") }) }
    private static func query(context: HttpContext, key: String): String { return context.request.query.get(key).getOrDefault({ => throw ProfileJson.invalid("缺少查询参数: " + key) }) }
}
