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

    let listen = cfg.httpUrl
    app.run(listen)
    return 0
}
