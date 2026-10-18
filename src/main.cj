package itn_spire

import std.core.*
import std.env.*
import soulsoft_web_http.*
import soulsoft_web_routing.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * Spire entrypoint for the migrated notes + categories module.
 *
 * Listen URL defaults to http://127.0.0.1:8100 so the existing Vite proxy
 * (`/v1` -> localhost:8100) can keep pointing at this service during the
 * migration. Override with SPIRE_HTTP_URL.
 */
main(): Int64 {
    let cfg = AppConfig()
    let builder = WebHost.createBuilder(getCommandLine())
    builder.services.addRouting()
    let app = builder.build()

    app.mapGet("health") {
        ctx =>
            ctx.response.contentType = "text/plain; charset=utf-8"
            ctx.response.write("ok")
    }

    registerNotesRoutes(app, cfg)
    registerWrongAnswerRoutes(app, cfg)
    registerResourceRoutes(app, cfg)
    registerCourseRoutes(app, cfg)
    registerAgentSessionRoutes(app, cfg)
    registerPresentationRoutes(app, cfg)
    registerResourceTaskRoutes(app, cfg)
    registerCustomizeTaskRoutes(app, cfg)
    registerTutoringRoutes(app, cfg)
    /* C-a/b/c 数据搬迁：记忆 CRUD、chat / presentation-chat 会话 CRUD、管理端纯查询。
       都是 literal 路由，必须在下面的 catch-all 之前注册。 */
    registerMemoryRoutes(app, cfg)
    registerChatRoutes(app, cfg)
    registerPresentationChatRoutes(app, cfg)
    registerAdminQueryRoutes(app, cfg)
    registerLearnForgeRoutes(app, cfg)
    /* P2 batch 2 — literal routes, so still before the catch-all. */
    registerLearnerProfileRoutes(app, cfg)
    /* P2 batch 3 — growth / report / knowledge-graph. */
    registerGrowthRoutes(app, cfg)
    /* P2 batch 4 — knowledge-points / learning-path / review-states / goals / job-targets. */
    registerLearnForgeB4Routes(app, cfg)
    /* P2 batch 5 — onboarding reads. */
    registerOnboardingRoutes(app, cfg)
    /* P2 batch 6 — learner-profile write side (events/quiz/journal-summary). */
    registerWriteRoutes(app, cfg)
    /* P2 batch 8 — growth writes + goals CRUD + review complete. */
    registerBatch8Routes(app, cfg)
    /* P2 batch 9 — onboarding pure-compute POSTs. */
    registerBatch9Routes(app, cfg)
    /* P2 scores_json single-writer step 1 — PUT /v1/learners/scores LOCAL. */
    registerLearnerScoresRoutes(app, cfg)
    /* P4-2 管理员资源中心 — literal /api/v1 routes before the catch-all. */
    registerAdminResourceRoutes(app, cfg)
    /* P4-F1 管理员知识服务代理 — literal catch-all，同样必须早于 gateway。 */
    registerAdminKnowledgeProxyRoutes(app, cfg)
    /* P3/P2 catch-all forwarders — MUST be last so literal routes win. */
    registerGatewayRoutes(app, cfg)

    let listen = cfg.httpUrl
    app.run(listen)
    return 0
}
