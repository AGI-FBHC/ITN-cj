package web.controllers

import std.collection.*
import soulsoft_web_http.*
import web.config.*
import web.exception.*
import web.service.*

public class AdminKnowledgeController {
    private let access: AccountAccessService
    private let gateway: AdminKnowledgeGateway
    public init(database: DatabaseConfig, auth: AuthConfig) {
        access = AccountAccessService(database, auth)
        gateway = AdminKnowledgeGateway()
    }
    public func forward(context: HttpContext): Unit {
        try {
            let user = access.authenticate(AccountAccessController.bearer(context))
            AccountAccessService.requireAdmin(user)
            let prefix = "/api/v1/admin/knowledge-core"
            let rawPath = context.request.path.value
            if (!rawPath.startsWith(prefix + "/")) { throw BusinessException(ErrorCode.UNAUTHORIZED, 403, "该内部服务路径未在平台白名单中开放") }
            let suffix = String.fromUtf8(rawPath.toArray().slice(prefix.toArray().size, rawPath.toArray().size - prefix.toArray().size))
            AdminKnowledgeGateway.allow(context.request.method, suffix)
            let body = ArrayList<UInt8>(); let buffer = Array<UInt8>(65536, repeat: 0)
            while (true) {
                let count = context.request.body.read(buffer)
                if (count == 0) { break }
                for (i in 0..count) { body.add(buffer[i]) }
            }
            let result = gateway.forward(user, context.request.method, suffix, context.request.queryString.toUriComponent(),
                context.request.contentType, context.request.headers["Accept"].first, body.toArray(), context.request.headers["X-Request-Id"].first)
            // This frontend uses direct(), not the Spring ApiResponse unwrapping request().
            context.response.statusCode = result.status
            context.response.contentType = result.mime
            if (let Some(value) <- result.requestId) { context.response.headers["X-Request-Id"] = [value] }
            if (!result.body.isEmpty() && result.status != 204 && result.status != 304) { context.response.write(result.body) }
        } catch (e: BusinessException) {
            context.response.statusCode = UInt16(e.status)
            context.response.contentType = "application/json; charset=utf-8"
            context.response.write(AuthController.errorJson(e.code, e.message))
        } catch (e: Exception) {
            context.response.statusCode = 500
            context.response.contentType = "application/json; charset=utf-8"
            context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
            println("Admin knowledge gateway request failed: " + e.message)
        }
    }
}
