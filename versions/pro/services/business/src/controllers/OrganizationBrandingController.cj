package web.controllers

import std.collection.*
import std.unicode.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import web.config.*
import web.domain.User
import web.exception.*
import web.service.*

public class OrganizationBrandingController {
    private let access: AccountAccessService
    private let branding: OrganizationBrandingService
    public init(database: DatabaseConfig, auth: AuthConfig) {
        access = AccountAccessService(database, auth)
        branding = OrganizationBrandingService(database)
    }
    public func update(context: HttpContext): Unit {
        handle(context, "机构信息已更新", { user =>
            if (context.request.contentType.getOrDefault({ => "" }).split(";")[0].trim().toLower(CasingOption.Other) != "application/json") {
                throw BusinessException(ErrorCode.VALIDATION_FAILED, 415, "Content-Type must be application/json")
            }
            let body = try { JsonValue.fromStr(AuthController.readBody(context)).asObject() }
                catch (_: Exception) { throw ProfileJson.invalid("请求必须是 JSON 对象") }
            return branding.update(user, body, requestId(context))
        })
    }
    public func upload(context: HttpContext): Unit {
        handle(context, "机构 Logo 已更新", { user =>
            if (!context.request.contentType.getOrDefault({ => "" }).toLower(CasingOption.Other).startsWith("multipart/form-data")) {
                throw BusinessException(ErrorCode.VALIDATION_FAILED, 415, "Content-Type must be multipart/form-data")
            }
            if (context.request.contentLength.getOrDefault({ => 0 }) > 3145728) { throw ProfileJson.invalid("Logo 文件不能为空且不能超过 2MB") }
            let file = context.request.form.files.get("file").getOrDefault({ => throw ProfileJson.invalid("缺少 file 上传字段") })
            if (file.length == 0 || file.length > 2097152) { throw ProfileJson.invalid("Logo 文件不能为空且不能超过 2MB") }
            let stream = file.openReadStream()
            let bytes = ArrayList<UInt8>(); let buffer = Array<UInt8>(65536, repeat: 0)
            while (true) {
                let count = stream.read(buffer)
                if (count == 0) { break }
                if (bytes.size + count > 2097152) { throw ProfileJson.invalid("Logo 文件不能为空且不能超过 2MB") }
                for (i in 0..count) { bytes.add(buffer[i]) }
            }
            return branding.upload(user, bytes.toArray(), requestId(context))
        })
    }
    public func delete(context: HttpContext): Unit {
        handle(context, "机构 Logo 已恢复默认", { user => branding.delete(user, requestId(context)) })
    }
    public func logo(context: HttpContext): Unit {
        try {
            let (bytes, mime) = match (context.request.query.get("org")) {
                case Some(raw) =>
                    let code = raw.trim()
                    if (code.isEmpty()) { throw ProfileJson.invalid("缺少机构编码") }
                    branding.logoByCode(code)
                case None =>
                    let user = access.authenticate(AccountAccessController.bearer(context))
                    branding.logo(user)
            }
            context.response.contentType = mime
            context.response.contentLength = Some(bytes.size)
            context.response.headers["Cache-Control"] = ["private, max-age=3600"]
            context.response.write(bytes)
        } catch (e: BusinessException) { fail(context, e) }
        catch (e: Exception) { internal(context, e) }
    }
    private func handle(context: HttpContext, message: String, work: (User) -> String): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try {
            let user = access.authenticate(AccountAccessController.bearer(context))
            AccountAccessService.requireAdmin(user)
            context.response.write(ProfileJson.wrap(message, Some(work(user))))
        } catch (e: BusinessException) { fail(context, e) }
        catch (e: Exception) { internal(context, e) }
    }
    private static func requestId(context: HttpContext): Option<String> { return context.request.headers["X-Request-Id"].first }
    private static func fail(context: HttpContext, error: BusinessException): Unit {
        context.response.statusCode = UInt16(error.status)
        context.response.contentType = "application/json; charset=utf-8"
        context.response.write(AuthController.errorJson(error.code, error.message))
    }
    private static func internal(context: HttpContext, error: Exception): Unit {
        println("Organization branding request failed: " + error.message)
        if (context.response.hasStarted) { return }
        context.response.statusCode = 500
        context.response.contentType = "application/json; charset=utf-8"
        context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
    }
}
