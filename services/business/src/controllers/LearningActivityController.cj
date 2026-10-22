package web.controllers

import std.unicode.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import web.config.*
import web.domain.User
import web.exception.*
import web.service.*

public class LearningActivityController {
    private let access: AccountAccessService
    private let garden: GardenService
    private let reviews: ReviewService
    private let progress: LearningProgressService
    private let knowledge: LearningKnowledgeReadService
    private let templates: LearningTemplateReadService
    public init(database: DatabaseConfig, auth: AuthConfig) {
        this.access = AccountAccessService(database, auth)
        this.garden = GardenService(database)
        this.reviews = ReviewService(database)
        this.progress = LearningProgressService(database)
        this.knowledge = LearningKnowledgeReadService(database)
        this.templates = LearningTemplateReadService(database)
    }
    public func growth(context: HttpContext): Unit {
        handle(context, 200, "success", true, { user => Some(garden.get(user.getOrThrow(), context.request.query.get("learnerId"))) })
    }
    public func growthEvent(context: HttpContext): Unit {
        handle(context, 200, "成长事件记录成功", true, { user => Some(garden.record(user.getOrThrow(), body(context))) })
    }
    public func nourish(context: HttpContext): Unit {
        handle(context, 200, "园子滋养成功", true, { user => Some(garden.nourish(user.getOrThrow(), context.request.query.get("learnerId"))) })
    }
    public func reviewList(context: HttpContext): Unit { handle(context, 200, "success", true, { user => Some(reviews.list(user.getOrThrow())) }) }
    public func reviewComplete(context: HttpContext): Unit {
        handle(context, 200, "success", true, { user => Some(reviews.complete(user.getOrThrow(), parameter(context, "code"), body(context))) })
    }
    public func analytics(context: HttpContext): Unit { handle(context, 200, "success", true, { user => Some(progress.profile(user.getOrThrow())) }) }
    public func learningEvent(context: HttpContext): Unit {
        handle(context, 201, "事件记录成功", true, { user => progress.event(user.getOrThrow(), body(context)); return None })
    }
    public func quiz(context: HttpContext): Unit {
        handle(context, 201, "测评结果记录成功", true, { user => progress.quiz(user.getOrThrow(), body(context)); return None })
    }
    public func domains(context: HttpContext): Unit { handle(context, 200, "success", false, { _ => Some(knowledge.domains()) }) }
    public func categoryIndex(context: HttpContext): Unit { handle(context, 200, "success", false, { _ => Some(knowledge.categoryIndex()) }) }
    public func tree(context: HttpContext): Unit { handle(context, 200, "success", false, { _ => Some(knowledge.tree(parameter(context, "code"))) }) }
    public func domainCover(context: HttpContext): Unit { handle(context, 200, "success", false, { _ => Some(knowledge.domainCover(parameter(context, "code"))) }) }
    public func points(context: HttpContext, single: Bool): Unit {
        handle(context, 200, "success", true, { _ => Some(knowledge.points(if (single) { Some(parameter(context, "code")) } else { None })) })
    }
    public func templateList(context: HttpContext): Unit {
        handle(context, 200, "success", true, { user => Some(templates.list(user.getOrThrow(), context.request.query.get("domainCode"))) })
    }
    private func handle(context: HttpContext, status: UInt16, message: String, authenticated: Bool,
        work: (Option<User>) -> Option<String>): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try {
            let user: Option<User> = if (authenticated) { Some(access.authenticate(AccountAccessController.bearer(context))) } else { None }
            let data = work(user)
            context.response.statusCode = status
            context.response.write(ProfileJson.wrap(message, data))
        } catch (e: BusinessException) {
            context.response.statusCode = UInt16(e.status)
            context.response.write(AuthController.errorJson(e.code, e.message))
        } catch (e: Exception) {
            context.response.statusCode = 500
            context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
            println("Learning activity request failed: " + e.message)
        }
    }
    private static func body(context: HttpContext): JsonObject {
        if (context.request.contentType.getOrDefault({ => "" }).split(";")[0].trim().toLower(CasingOption.Other) != "application/json") {
            throw BusinessException(ErrorCode.VALIDATION_FAILED, 415, "Content-Type must be application/json")
        }
        let content = AuthController.readBody(context)
        try { return JsonValue.fromStr(content).asObject() } catch (_: Exception) { throw ProfileJson.invalid("请求必须是 JSON 对象") }
    }
    private static func parameter(context: HttpContext, key: String): String {
        return context.request.routeValues.get(key).getOrDefault({ => throw ProfileJson.invalid("缺少路由参数") })
    }
}
