package web.controllers

import std.convert.*
import std.unicode.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import web.config.*
import web.domain.User
import web.exception.*
import web.service.*

public class ProfileGoalsController {
    private let access: AccountAccessService
    private let learners: LearnerProfileService
    private let profiles: PersonalProfileService
    private let goals: LearningGoalService
    private let catalogs: ProfileCatalogService
    public init(database: DatabaseConfig, auth: AuthConfig) {
        this.access = AccountAccessService(database, auth)
        this.learners = LearnerProfileService(database)
        this.profiles = PersonalProfileService(database)
        this.goals = LearningGoalService(database)
        this.catalogs = ProfileCatalogService(database)
    }
    public func learnerList(context: HttpContext): Unit {
        handle(context, 200, "success", { user => Some(learners.list(user)) })
    }
    public func learnerGet(context: HttpContext): Unit {
        handle(context, 200, "success", { user => Some(learners.get(user, parameter(context, "learnerId"))) })
    }
    public func learnerSave(context: HttpContext, create: Bool): Unit {
        handle(context, 200, if (create) { "学习者创建成功" } else { "学习者更新成功" }, { user =>
            Some(learners.save(user, if (create) { None } else { Some(parameter(context, "learnerId")) }, body(context)))
        })
    }
    public func profileGet(context: HttpContext): Unit { handle(context, 200, "success", { user => Some(profiles.get(user)) }) }
    public func profileSave(context: HttpContext): Unit { handle(context, 200, "用户画像保存成功", { user => Some(profiles.save(user, body(context))) }) }
    public func goalList(context: HttpContext): Unit { handle(context, 200, "success", { user => Some(goals.list(user)) }) }
    public func goalGet(context: HttpContext): Unit { handle(context, 200, "success", { user => Some(goals.get(user, parameter(context, "goalId"))) }) }
    public func goalSave(context: HttpContext, create: Bool): Unit {
        handle(context, if (create) { 201 } else { 200 }, if (create) { "学习目标创建成功" } else { "学习目标更新成功" }, { user =>
            Some(goals.save(user, if (create) { None } else { Some(parameter(context, "goalId")) }, body(context)))
        })
    }
    public func goalEnsure(context: HttpContext): Unit {
        handle(context, 200, "success", { user =>
            let id = try { Int64.parse(parameter(context, "domainId")) } catch (_: Exception) { throw ProfileJson.invalid("领域编号必须为整数") }
            return Some(goals.ensureDomain(user, id))
        })
    }
    public func goalCurrent(context: HttpContext): Unit {
        handle(context, 200, "当前学习目标切换成功", { user => Some(goals.setCurrent(user, parameter(context, "goalId"))) })
    }
    public func goalDelete(context: HttpContext): Unit {
        handle(context, 200, "学习目标删除成功", { user => goals.delete(user, parameter(context, "goalId")); return None })
    }
    public func goalClear(context: HttpContext): Unit {
        handle(context, 200, "当前学习目标已清除", { user => goals.clearCurrent(user); return None })
    }
    public func catalog(context: HttpContext, kind: String): Unit {
        handle(context, 200, "success", { _ =>
            return Some(match (kind) {
                case "meta" => catalogs.meta()
                case "categories" => catalogs.categories()
                case "jobTargets" => catalogs.jobTargets(context.request.query.get("job"))
                case _ => catalogs.targets()
            })
        })
    }
    private func handle(context: HttpContext, status: UInt16, message: String, work: (User) -> Option<String>): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try {
            let user = access.authenticate(AccountAccessController.bearer(context))
            let data = work(user)
            context.response.statusCode = status
            context.response.write(ProfileJson.wrap(message, data))
        } catch (e: BusinessException) {
            context.response.statusCode = UInt16(e.status)
            context.response.write(AuthController.errorJson(e.code, e.message))
        } catch (e: Exception) {
            context.response.statusCode = 500
            context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
            println("Profile/goals request failed: " + e.message)
        }
    }
    private static func parameter(context: HttpContext, key: String): String {
        return context.request.routeValues.get(key).getOrDefault({ => throw ProfileJson.invalid("缺少路由参数：${key}") })
    }
    private static func body(context: HttpContext): JsonObject {
        if (context.request.contentType.getOrDefault({ => "" }).split(";")[0].trim().toLower(CasingOption.Other) != "application/json") {
            throw BusinessException(ErrorCode.VALIDATION_FAILED, 415, "Content-Type must be application/json")
        }
        let content = AuthController.readBody(context)
        try { return JsonValue.fromStr(content).asObject() } catch (_: Exception) { throw ProfileJson.invalid("请求必须是 JSON 对象") }
    }
}
