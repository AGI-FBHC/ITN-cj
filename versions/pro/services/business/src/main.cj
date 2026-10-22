package web

import soulsoft_web_http.*
import soulsoft_web_routing.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*
import std.convert.*
import stdx.encoding.hex.toHexString
import web.config.*
import web.database.*
import web.diagnostics.PasswordLoginCheck
import web.diagnostics.LocalAdminSetup
import web.controllers.AuthController
import web.controllers.VerificationController
import web.controllers.GuestDemoController
import web.controllers.AccountAccessController
import web.controllers.ProfileGoalsController
import web.controllers.LearningActivityController
import web.controllers.KnowledgePathController
import web.controllers.GrowthReportController
import web.controllers.AdminOverviewController
import web.controllers.AdminAccountStatusController
import web.controllers.AdminLearnerResetController
import web.controllers.AdminKnowledgeController
import web.controllers.AdminResourceGroupController
import web.controllers.AdminResourceReviewController
import web.controllers.OrganizationBrandingController
import stdx.encoding.json.JsonString
import web.domain.DemoPersona
import web.security.*
import web.repository.GuestDemoRepository
import web.service.AuthService

main(args: Array<String>): Int64 {
    let databaseConfig = DatabaseConfig.fromEnvironment()
    for (arg in args) {
        if (arg == "--prepare-local-admin") { return LocalAdminSetup.run(databaseConfig) }
        if (arg == "--check-password") {
            return PasswordLoginCheck.run(databaseConfig)
        }
        if (arg.startsWith("--check-login-session=")) {
            return checkLoginSession(databaseConfig, arg.split("=")[1])
        }
        if (arg == "--list-demo-codes") { return listDemoCodes(databaseConfig) }
        if (arg == "--prepare-local-demo-fixture") {
            return prepareLocalDemoFixture(databaseConfig, AuthConfig.fromEnvironment())
        }
        if (arg.startsWith("--check-guest-profile=")) {
            return checkGuestProfile(databaseConfig, arg.split("=")[1])
        }
    }
    let authConfig = AuthConfig.fromEnvironment()
    let controller = AuthController(AuthService(databaseConfig, authConfig))
    let verificationController = VerificationController(databaseConfig, authConfig)
    let guestDemoController = GuestDemoController(databaseConfig, authConfig)
    println("MySQL client library: " + MySqlClient.version())
    println("Database connected. User count: ${MySqlConnection.countUsers(databaseConfig)}")
    let accessController = AccountAccessController(databaseConfig, authConfig)
    let profileController = ProfileGoalsController(databaseConfig, authConfig)
    let learningController = LearningActivityController(databaseConfig, authConfig)
    let knowledgeController = KnowledgePathController(databaseConfig, authConfig)
    let growthReportController = GrowthReportController(databaseConfig, authConfig)
    let adminOverviewController = AdminOverviewController(databaseConfig, authConfig)
    let adminAccountStatusController = AdminAccountStatusController(databaseConfig, authConfig)
    let adminLearnerResetController = AdminLearnerResetController(databaseConfig, authConfig)
    let adminKnowledgeController = AdminKnowledgeController(databaseConfig, authConfig)
    let adminResourceGroupController = AdminResourceGroupController(databaseConfig, authConfig)
    let adminResourceReviewController = AdminResourceReviewController(databaseConfig, authConfig)
    let organizationBrandingController = OrganizationBrandingController(databaseConfig, authConfig)
    let builder = WebHost.createBuilder(args)
    builder.services.addRouting()
    let host = builder.build()
    host.useRouting()
    host.mapGet("hello") {
        context => context.response.write("hello cangjie.")
    }
    host.mapPost("api/v1/auth/login") {
        context => controller.login(context)
    }
    host.mapPost("api/v1/auth/send-code") {
        context => verificationController.sendCode(context)
    }
    host.mapPost("api/v1/auth/register") {
        context => verificationController.register(context)
    }
    host.mapPost("api/v1/auth/register-enterprise") { context => verificationController.registerEnterprise(context) }
    host.mapPost("api/v1/auth/email-code-login") {
        context => verificationController.emailCodeLogin(context)
    }
    host.mapPost("api/v1/auth/guest-login") { context => guestDemoController.guestLogin(context) }
    host.mapPost("api/v1/auth/guest-reset") { context => guestDemoController.guestReset(context) }
    host.mapPost("api/v1/auth/demo-login") { context => guestDemoController.demoLogin(context) }
    host.mapGet("api/v1/auth/me") { context => accessController.me(context) }
    host.mapPost("api/v1/auth/logout") { context => accessController.logout(context) }
    host.mapPost("api/v1/auth/admin-login") { context => accessController.login(context, true) }
    host.mapPost("api/v1/auth/identity-login") { context => accessController.login(context, false) }
    host.mapPost("api/v1/auth/reset-password") { context => accessController.resetPassword(context) }
    host.mapGet("api/v1/admin/organization") { context => accessController.branding(context, true) }
    host.mapGet("api/v1/organization/branding") { context => accessController.branding(context, false) }
    host.mapGet("api/v1/learners") { context => profileController.learnerList(context) }
    host.mapGet("api/v1/learners/{learnerId}") { context => profileController.learnerGet(context) }
    host.mapPost("api/v1/learners") { context => profileController.learnerSave(context, true) }
    host.mapPut("api/v1/learners/{learnerId}") { context => profileController.learnerSave(context, false) }
    host.mapGet("api/v1/profile") { context => profileController.profileGet(context) }
    host.mapPut("api/v1/profile") { context => profileController.profileSave(context) }
    host.mapGet("api/v1/learning-goals") { context => profileController.goalList(context) }
    host.mapGet("api/v1/learning-goals/{goalId}") { context => profileController.goalGet(context) }
    host.mapPost("api/v1/learning-goals") { context => profileController.goalSave(context, true) }
    host.mapPut("api/v1/learning-goals/{goalId}") { context => profileController.goalSave(context, false) }
    host.mapDelete("api/v1/learning-goals/{goalId}") { context => profileController.goalDelete(context) }
    host.mapPost("api/v1/learning-goals/domain/{domainId}/ensure") { context => profileController.goalEnsure(context) }
    host.mapPut("api/v1/learning-goals/{goalId}/current") { context => profileController.goalCurrent(context) }
    host.mapDelete("api/v1/learning-goals/current") { context => profileController.goalClear(context) }
    host.mapGet("api/v1/onboarding/meta") { context => profileController.catalog(context, "meta") }
    host.mapGet("api/v1/onboarding/target-categories") { context => profileController.catalog(context, "categories") }
    host.mapGet("api/v1/onboarding/targets") { context => profileController.catalog(context, "targets") }
    host.mapGet("api/v1/onboarding/jobs") { context => profileController.catalog(context, "targets") }
    host.mapGet("api/v1/job-targets") { context => profileController.catalog(context, "jobTargets") }
    host.mapGet("api/v1/learner-profile/growth") { context => learningController.growth(context) }
    host.mapPost("api/v1/learner-profile/growth-events") { context => learningController.growthEvent(context) }
    host.mapPost("api/v1/learner-profile/growth/nourish") { context => learningController.nourish(context) }
    host.mapGet("api/v1/review-states") { context => learningController.reviewList(context) }
    host.mapPost("api/v1/review-states/{code}/complete") { context => learningController.reviewComplete(context) }
    host.mapGet("api/v1/learner-profile") { context => learningController.analytics(context) }
    host.mapPost("api/v1/learner-profile/events") { context => learningController.learningEvent(context) }
    host.mapPost("api/v1/learner-profile/quiz") { context => learningController.quiz(context) }
    host.mapGet("api/v1/rag/domains") { context => learningController.domains(context) }
    host.mapGet("api/v1/rag/category-index") { context => learningController.categoryIndex(context) }
    host.mapGet("api/v1/rag/tree/{code}") { context => learningController.tree(context) }
    host.mapGet("api/v1/rag/domains/{code}/cover") { context => learningController.domainCover(context) }
    host.mapGet("api/v1/knowledge-points") { context => learningController.points(context, false) }
    host.mapGet("api/v1/knowledge-points/{code}") { context => learningController.points(context, true) }
    host.mapGet("api/v1/learning-template-resources") { context => learningController.templateList(context) }
    host.mapGet("api/v1/learning-path") { context => knowledgeController.path(context) }
    host.mapGet("api/v1/knowledge-graph") { context => knowledgeController.graph(context) }
    host.mapGet("api/v1/search") { context => knowledgeController.search(context) }
    host.mapGet("api/v1/rag/categories/{categoryId}") { context => knowledgeController.category(context) }
    host.mapGet("api/v1/rag/categories/{categoryId}/chunks") { context => knowledgeController.chunks(context, true) }
    host.mapGet("api/v1/rag/chunks/search") { context => knowledgeController.chunks(context, false) }
    host.mapGet("api/v1/rag/chunks/ragflow/{ragflowChunkId}") { context => knowledgeController.chunk(context, true) }
    host.mapGet("api/v1/rag/chunks/{chunkId}") { context => knowledgeController.chunk(context, false) }
    host.mapGet("api/v1/rag/figures") { context => knowledgeController.figure(context, false) }
    host.mapGet("api/v1/rag/figures/{figureId}/image") { context => knowledgeController.image(context) }
    host.mapGet("api/v1/rag/figures/{figureId}") { context => knowledgeController.figure(context, true) }
    host.mapGet("api/v1/rag/assets/remote") { context => knowledgeController.remote(context) }
    host.mapGet("api/v1/rag/documents/{documentId}") { context => knowledgeController.document(context, false) }
    host.mapGet("api/v1/rag/documents") { context => knowledgeController.document(context, true) }
    host.mapGet("api/v1/learner-profile/journal") { context => growthReportController.journal(context, false) }
    host.mapPost("api/v1/learner-profile/journal/summary") { context => growthReportController.journal(context, true) }
    host.mapGet("api/v1/learner-profile/report") { context => growthReportController.report(context) }
    host.mapGet("api/v1/admin/users") { context => adminOverviewController.users(context) }
    host.mapGet("api/v1/admin/users/{id}") { context => adminOverviewController.user(context) }
    host.mapGet("api/v1/admin/resources/stats") { context => adminOverviewController.stats(context) }
    host.mapPut("api/v1/admin/organization") { context => organizationBrandingController.update(context) }
    host.mapPost("api/v1/admin/organization/logo") { context => organizationBrandingController.upload(context) }
    host.mapDelete("api/v1/admin/organization/logo") { context => organizationBrandingController.delete(context) }
    host.mapGet("api/v1/organization/branding/logo") { context => organizationBrandingController.logo(context) }
    host.mapPost("api/v1/admin/users/{id}/enable") { context => adminAccountStatusController.setEnabled(context, true) }
    host.mapPost("api/v1/admin/users/{id}/disable") { context => adminAccountStatusController.setEnabled(context, false) }
    host.mapPost("api/v1/admin/users/{id}/reset") { context => adminLearnerResetController.reset(context) }
    host.map("api/v1/admin/knowledge-core/{**path}") { context => adminKnowledgeController.forward(context) }
    host.mapGet("api/v1/admin/resources") { context => adminResourceGroupController.list(context) }
    host.mapGet("api/v1/admin/resources/{id}") { context => adminResourceGroupController.detail(context) }
    host.mapPost("api/v1/admin/resources/{id}/template") { context => adminResourceGroupController.template(context) }
    host.mapPost("api/v1/admin/resources/{id}/restore") { context => adminResourceReviewController.restore(context) }
    host.mapPost("api/v1/admin/resources/{id}/candidate") { context => adminResourceReviewController.candidate(context) }
    host.mapPost("api/v1/admin/resources/{id}/review") { context => adminResourceReviewController.review(context) }
    host.mapPost("api/v1/admin/resources/{id}/archive") { context => adminResourceReviewController.archive(context) }
    host.mapDelete("api/v1/admin/resources/{id}") { context => adminResourceReviewController.deletePermanently(context) }
    host.mapDelete("api/v1/admin/resources/archived") { context => adminResourceReviewController.purgeArchived(context) }
    host.mapDelete("api/v1/admin/resources/groups") { context => adminResourceGroupController.deleteGroup(context) }
    host.run()
    return 0
}

func listDemoCodes(config: DatabaseConfig): Int64 {
    let rows = MySqlConnection.query(config,
        "SELECT i.identity_value FROM user_identities i JOIN users u ON u.id = i.user_id " +
        "WHERE i.identity_type = 'DEMO' AND u.active = 1 AND u.account_type = 'LEARNER' ORDER BY i.identity_value")
    var result = "["
    for (i in 0..rows.size) {
        if (i > 0) { result += "," }
        result += JsonString(rows[i][0].getOrThrow()).toString()
    }
    println(result + "]")
    return 0
}

// Explicit local test-data command; normal server startup never seeds demo identities.
func prepareLocalDemoFixture(config: DatabaseConfig, _: AuthConfig): Int64 {
    let code = DbTransaction.run<String>(config, { tx =>
        let repository = GuestDemoRepository()
        let preset = DemoPersona.select("research")
        repository.lockGuest(tx, preset.email)
        let organization = repository.guestOrganization(tx)
        let user = repository.guestUser(tx, preset, organization,
            { => BCryptPasswordEncoder().encode(AuthUtilities.uuid()) })
        let learnerId = repository.guestLearner(tx, user, preset)
        let existing = tx.query("SELECT 1 FROM user_identities WHERE identity_type = 'DEMO' " +
            "AND identity_value = " + AuthUtilities.text(learnerId) + " COLLATE utf8mb4_unicode_ci LIMIT 1")
        if (existing.isEmpty()) {
            let saved = tx.execute("INSERT INTO user_identities " +
                "(id, user_id, identity_type, identity_value, identity_extra_json, created_at, updated_at) VALUES (" +
                AuthUtilities.uuidSql(AuthUtilities.uuid()) + ", " + AuthUtilities.uuidSql(user.getId()) +
                ", 'DEMO', " + AuthUtilities.text(learnerId) + ", NULL, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))")
            if (saved != 1) { throw Exception("Local demo fixture was not saved") }
        }
        return learnerId
    })
    println(JsonString(code).toString())
    return 0
}

func checkGuestProfile(config: DatabaseConfig, argument: String): Int64 {
    let parts = argument.split(":")
    if (parts.size != 3) { throw IllegalArgumentException("Expected persona:userId:learnerId") }
    let preset = DemoPersona.select(parts[0])
    let rows = MySqlConnection.query(config,
        "SELECT u.email, l.name, l.avatar, l.role, l.education, l.target_job, " +
        "CAST(l.weekly_hours AS CHAR), l.learning_style_json, l.scores_json, l.goal, " +
        "l.blind_spots_json, l.diagnosis_summary, l.preferred_format, l.confidence_method, " +
        "CAST(l.confidence_value AS CHAR), o.code, l.code FROM learners l " +
        "JOIN users u ON u.id = l.user_id JOIN organizations o ON o.id = u.organization_id " +
        "WHERE u.id = " + AuthUtilities.uuidSql(parts[1]) + " AND l.id = " + AuthUtilities.uuidSql(parts[2]))
    let expected = [preset.email, preset.name, preset.avatar, preset.role, preset.education,
        preset.targetJob, preset.weeklyHours.toString(), preset.learningStyles, preset.scores,
        preset.goal, preset.blindSpots, preset.diagnosis, "按画像自适应", "preset", "85", "cloudbrain-shanghai", "default"]
    if (rows.size != 1 || rows[0].size != expected.size) { println("Guest profile not found"); return 1 }
    for (i in 0..expected.size) {
        if (rows[0][i].getOrThrow() != expected[i]) { println("Guest profile field mismatch: ${i}"); return 1 }
    }
    println("Guest preset saved in database: passed")
    return 0
}

// Local diagnostic: verify a returned token's hash without printing the token.
func checkLoginSession(config: DatabaseConfig, hash: String): Int64 {
    let bytes = hash.toArray()
    if (bytes.size != 64) { throw IllegalArgumentException("Invalid token hash") }
    for (value in bytes) {
        if (!((value >= 48 && value <= 57) || (value >= 97 && value <= 102))) {
            throw IllegalArgumentException("Invalid token hash")
        }
    }
    let rows = MySqlConnection.query(config,
        "SELECT COUNT(*) FROM user_sessions WHERE token_hash = CONVERT(X'" +
        toHexString(bytes) + "' USING utf8mb4) COLLATE utf8mb4_unicode_ci " +
        "AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP(6)")
    if (rows.size == 1 && Int64.parse(rows[0][0].getOrThrow()) == 1) {
        println("Login session saved and valid: passed")
        return 0
    }
    println("Login session could not be verified")
    return 1
}
