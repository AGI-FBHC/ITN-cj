package itn_desktop_core.unittests

import std.collection.*
import std.time.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import stdx.net.http.*
import itn_desktop_core.api.buildServer
import itn_desktop_core.agent.DomainTool
import itn_desktop_core.agent.reasoningTools
import itn_desktop_core.agent.sessionReasoningState
import itn_desktop_core.agent.setSessionReasoningMode
import itn_desktop_core.agent.reasoningModeForTurn
import itn_desktop_core.model_provider.OpenAiChatProvider
import itn_desktop_core.runtime.ChatProvider
import itn_desktop_core.runtime.StepContext
import itn_desktop_core.runtime.EventStream
import itn_desktop_core.runtime.ModelReply
import itn_desktop_core.runtime_host.LuminAgent
import itn_desktop_core.runtime_host.WorkContext
import itn_desktop_core.session.SessionStore
import itn_desktop_core.session.SessionEvent
import itn_desktop_core.store.*
import itn_desktop_core.db.DbHub
import itn_desktop_core.util.*

/** 每条测试只用 freshDir 的临时库和回环 HTTP，不读取真实用户配置。 */
@Test
class ReasoningSessionTest {
    func fixture(dir: String, baseUrl!: String = "http://127.0.0.1:1/v1"): Store {
        let cfg = ModelConfig()
        cfg.id = "reasoning-model"; cfg.model = "deepseek-flash"
        cfg.baseUrl = baseUrl; cfg.reasoningProfile = "deepseek"
        let settings = Settings(); settings.models.add(cfg); settings.chatModelId = cfg.id
        let store = Store(dir); store.save(settings)
        return store
    }

    func tool(store: Store, sid: String, question: String, name: String): DomainTool {
        for (t in reasoningTools(store, sid, question, runningMode: "low")) {
            if (t.name == name) { return t }
        }
        throw Exception("缺少思考模式工具：" + name)
    }

    func args(mode: String, confirmed!: Bool = true): JsonObject {
        let body = JsonObject(); body.put("mode", JsonString(mode)); body.put("confirmed", JsonBool(confirmed))
        return body
    }

    func post(server: Server, path: String, body: String): (UInt16, JsonObject) {
        let client = ClientBuilder().readTimeout(Duration.second * 15).build()
        try {
            let req = HttpRequestBuilder().method("POST")
                .url("http://127.0.0.1:" + server.port.toString() + path)
                .header("Content-Type", "application/json").body(body.toArray()).build()
            let response = client.send(req)
            let value = objOf(JsonValue.fromStr(readAllString(response.body))).getOrThrow()
            return (response.status, value)
        } finally { client.close() }
    }

    func objectAt(body: JsonObject, key: String): JsonObject {
        return objOf(body.get(key).getOrThrow()).getOrThrow()
    }

    @TestCase
    func modePersistsAcrossStoresBranchesAndRemovalWithoutTouchingCheckpoints(): Unit {
        let dir = freshDir("reasoning-session-lifecycle")
        let sessions = SessionStore(dir); let sid = sessions.newId()
        @Expect(sessions.reasoningMode(sid), "default")
        let event = SessionEvent(); event.sessionId = sid; event.turnId = "first"
        event.kind = "user/message"; sessions.append(event)
        sessions.setReasoningMode(sid, "high")
        DbHub.open(dir).putKv("sessions_meta", "state:" + sid, "checkpoint")
        DbHub.open(dir).putKv("sessions_meta", "context:" + sid, "context")
        @Expect(SessionStore(dir).reasoningMode(sid), "high")
        let partial = sessions.branch(sid, "first"); let whole = sessions.branchAll(sid)
        @Expect(sessions.reasoningMode(partial), "high")
        @Expect(sessions.reasoningMode(whole), "high")
        sessions.setReasoningMode(partial, "low")
        @Expect(sessions.reasoningMode(sid), "high")
        @Expect(DbHub.open(dir).getKv("sessions_meta", "state:" + sid, ""), "checkpoint")
        @Expect(DbHub.open(dir).getKv("sessions_meta", "context:" + sid, ""), "context")
        sessions.remove(sid)
        @Expect(sessions.reasoningMode(sid), "default")
        @Expect(DbHub.open(dir).getKv("sessions_meta", "reasoning:" + sid, "missing"), "missing")
        @Expect(sessions.reasoningMode(partial), "low")
        @Expect(sessions.reasoningMode(whole), "high")
    }

    @TestCase
    func incompatibleSavedModeFallsBackWithoutOverwritingIt(): Unit {
        let dir = freshDir("reasoning-fallback"); let store = fixture(dir)
        let sessions = SessionStore(dir); sessions.setReasoningMode("original", "max")
        let settings = store.load(); settings.models[0].reasoningProfile = "mimo"; store.save(settings)
        let cfg = store.load().models[0]
        let state = sessionReasoningState(store, "original")
        @Expect(strOf(state, "mode"), "max")
        @Expect(strOf(state, "effectiveMode"), "default")
        @Expect(reasoningModeForTurn(store, cfg, "original", ""), "default")
        @Expect(sessions.reasoningMode("original"), "max")
        var rejected = false
        try { reasoningModeForTurn(store, cfg, "original", "max") }
        catch (e: Exception) { rejected = e.message.contains("不支持") }
        @Expect(rejected, true)
        @Expect(sessions.reasoningMode("original"), "max")
    }

    @TestCase
    func toolWritesRequireExplicitCurrentIntentAndConfirmation(): Unit {
        let dir = freshDir("reasoning-tool-consent"); let store = fixture(dir)
        let sessions = SessionStore(dir); sessions.setReasoningMode("test", "low")
        for (question in ["请深入思考并回答这道题", "如何设置思考模式？", "不要切换思考模式", "请介绍开启思考模式的原理"]) {
            var rejected = false
            try { tool(store, "test", question, "set_reasoning_mode").run(args("high")) }
            catch (e: Exception) { rejected = e.message.contains("明确要求") }
            @Expect(rejected, true)
            @Expect(sessions.reasoningMode("test"), "low")
        }
        // 模型自报 confirmed 也不能把用户的“关闭”授权升级成 max。
        var wrongTargetRejected = false
        try { tool(store, "test", "请关闭思考模式", "set_reasoning_mode").run(args("max")) }
        catch (e: Exception) { wrongTargetRejected = e.message.contains("目标档位") }
        @Expect(wrongTargetRejected, true)
        @Expect(sessions.reasoningMode("test"), "low")
        tool(store, "test", "请关闭思考模式", "set_reasoning_mode").run(args("off"))
        @Expect(sessions.reasoningMode("test"), "off")
        tool(store, "test", "请开启深度思考，不要执行其他操作", "set_reasoning_mode").run(args("high"))
        @Expect(sessions.reasoningMode("test"), "high")
        sessions.setReasoningMode("test", "low")
        // 泛词“思考深度”及多个候选档位都不能让模型自行选择 high/max。
        for ((question, mode) in [("请调整思考深度", "high"), ("请设置思考深度", "high"),
            ("请将思考模式设置为 low 或 max", "max"), ("请把思考模式设置为 higher", "high")]) {
            var rejected = false
            try { tool(store, "test", question, "set_reasoning_mode").run(args(mode)) }
            catch (e: Exception) { rejected = e.message.contains("目标档位") }
            @Expect(rejected, true)
            @Expect(sessions.reasoningMode("test"), "low")
        }
        let setter = tool(store, "test", "请把思考模式切换为深度", "set_reasoning_mode")
        @Expect(setter.risk, "write")
        var unconfirmed = false
        try { setter.run(args("high", confirmed: false)) } catch (e: Exception) { unconfirmed = true }
        @Expect(unconfirmed, true)
        let result = setter.run(args("high")); let state = objOf(result.details).getOrThrow()
        @Expect(sessions.reasoningMode("test"), "high")
        @Expect(strOf(state, "currentMode"), "low")
        @Expect(strOf(state, "effectiveMode"), "high")
        @Expect(strOf(state, "appliesTo"), "nextTurn")
        @Expect(result.summary.contains("下一轮"), true)
        let reader = tool(store, "test", "请查看模式", "get_reasoning_mode")
        @Expect(reader.risk, "read")
        reader.run(JsonObject())
        @Expect(sessions.reasoningMode("test"), "high")
    }

    @TestCase
    func reasoningApiReadIsReadOnlyAndWritesValidateTheContract(): Unit {
        let dir = freshDir("reasoning-api-contract"); fixture(dir)
        let sessions = SessionStore(dir)
        let server = buildServer(dir, dir + "/ui"); spawn { server.serve() }
        sleep(Duration.millisecond * 150)
        try {
            let read = post(server, "/api/agent/reasoning", "{}")
            @Expect(read[0], 200)
            let state = objectAt(read[1], "data")
            @Expect(strOf(state, "modelId"), "reasoning-model")
            @Expect(strOf(state, "profile"), "deepseek")
            @Expect(strOf(state, "mode"), "default")
            @Expect(strOf(state, "effectiveMode"), "default")
            @Expect(boolOf(state, "supported"), true)
            @Expect(boolOf(state, "requiresConfiguration"), false)
            match (state.get("options").getOrThrow()) {
                case options: JsonArray =>
                    @Expect(options.size() > 1, true)
                    var i: Int64 = 0
                    while (i < options.size()) {
                        let item = objOf(options[i]).getOrThrow()
                        @Expect(strOf(item, "id").size > 0, true)
                        @Expect(strOf(item, "label").size > 0, true)
                        i += 1
                    }
                case _ => @Expect(false, true)
            }
            @Expect(DbHub.open(dir).querySql("SELECT k FROM sessions_meta WHERE k LIKE 'reasoning:%'").size, 0)
            let written = post(server, "/api/sessions/reasoning", "{\"sessionId\":\"test\",\"mode\":\"high\"}")
            @Expect(written[0], 200)
            @Expect(strOf(objectAt(written[1], "data"), "mode"), "high")
            for (body in ["{}", "{\"mode\":\"high\"}", "{\"sessionId\":\"test\",\"mode\":\"invented\"}", "{\"sessionId\":\"test\",\"mode\":false}"]) {
                @Expect(post(server, "/api/sessions/reasoning", body)[0], 400)
                @Expect(sessions.reasoningMode("test"), "high")
            }
            let before = DbHub.open(dir).querySql("SELECT k FROM sessions_meta").size
            @Expect(post(server, "/api/agent/reasoning", "{\"sessionId\":\"test\",\"mode\":\"low\"}")[0], 200)
            @Expect(DbHub.open(dir).querySql("SELECT k FROM sessions_meta").size, before)
            @Expect(sessions.reasoningMode("test"), "high")
            let tools = objectAt(post(server, "/api/tools/list", "{}")[1], "data")
            @Expect(tools.toString().contains("get_reasoning_mode"), true)
            @Expect(tools.toString().contains("set_reasoning_mode"), true)
        } finally { server.close() }
    }

    @TestCase
    func modelSavePreservesOmittedProfileAndRejectsInvalidExplicitProfiles(): Unit {
        let dir = freshDir("reasoning-model-save"); let store = fixture(dir)
        let server = buildServer(dir, dir + "/ui"); spawn { server.serve() }
        sleep(Duration.millisecond * 150)
        try {
            let legacy = "{\"id\":\"reasoning-model\",\"model\":\"deepseek-flash\",\"baseUrl\":\"http://127.0.0.1:1/v1\"}"
            @Expect(post(server, "/api/models/save", legacy)[0], 200)
            @Expect(store.load().models[0].reasoningProfile, "deepseek")
            for (value in ["\"invented\"", "\"\"", "false", "null"]) {
                let invalid = "{\"id\":\"reasoning-model\",\"reasoningProfile\":" + value + "}"
                @Expect(post(server, "/api/models/save", invalid)[0], 400)
                @Expect(store.load().models[0].reasoningProfile, "deepseek")
            }
            @Expect(post(server, "/api/models/save", "{\"id\":\"reasoning-model\",\"reasoningProfile\":\"auto\"}")[0], 200)
            @Expect(store.load().models[0].reasoningProfile, "auto")
            @Expect(post(server, "/api/models/save", "{\"id\":\"new\",\"model\":\"test\"}")[0], 200)
            @Expect(store.load().findModel("new").getOrThrow().reasoningProfile, "auto")
        } finally { server.close() }
    }

    func textResponse(): String {
        return "data: {\"choices\":[{\"delta\":{\"content\":\"已完成\"},\"finish_reason\":\"stop\"}]}\n\n" +
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":12,\"completion_tokens_details\":{\"reasoning_tokens\":5}}}\n\ndata: [DONE]\n\n"
    }

    @TestCase
    func hostFreezesModeAcrossToolCallsAndNextTurnUsesTheSavedChange(): Unit {
        let dir = freshDir("reasoning-frozen-provider")
        let requests = ArrayList<JsonObject>()
        let upstream = ServerBuilder().addr("127.0.0.1").port(0).build()
        upstream.distributor.register("/v1/chat/completions", { ctx: HttpContext =>
            requests.add(objOf(JsonValue.fromStr(readAllString(ctx.request.body))).getOrThrow())
            ctx.responseBuilder.status(200); ctx.responseBuilder.header("Content-Type", "text/event-stream")
            let response = if (requests.size == 1) {
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"mode-write\",\"type\":\"function\",\"function\":{\"name\":\"set_reasoning_mode\",\"arguments\":\"{\\\"mode\\\":\\\"high\\\",\\\"confirmed\\\":true}\"}}]}}]}\n\n" +
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":12,\"completion_tokens_details\":{\"reasoning_tokens\":5}}}\n\ndata: [DONE]\n\n"
            } else { textResponse() }
            ctx.responseBuilder.body(response.toArray())
        })
        spawn { upstream.serve() }; sleep(Duration.millisecond * 150)
        try {
            let store = fixture(dir, baseUrl: "http://127.0.0.1:" + upstream.port.toString() + "/v1")
            let sessions = SessionStore(dir); sessions.setReasoningMode("frozen", "low")
            let provider = OpenAiChatProvider(store.load().models[0])
            let result = LuminAgent(store).askFull(provider, "", "请把思考模式切换为深度", "frozen", "off", "", None)
            @Expect(boolOf(result, "ok"), true)
            @Expect(requests.size, 2)
            @Expect(strOf(requests[0], "reasoning_effort"), "low")
            @Expect(strOf(requests[1], "reasoning_effort"), "low")
            @Expect(provider.reasoningMode, "low")
            @Expect(provider.reasoningConfig.reasoningMode, "low")
            @Expect(sessions.reasoningMode("frozen"), "high")
            let tokens = objectAt(result, "tokens")
            @Expect(intOf(tokens, "out"), 24)
            @Expect(intOf(tokens, "reasoning"), 10)
            var usageSeen = false
            for (event in sessions.events("frozen")) {
                if (strOf(event, "type") == "turn/usage") {
                    usageSeen = true
                    @Expect(intOf(objectAt(event, "payload"), "reasoning"), 10)
                }
            }
            @Expect(usageSeen, true)
            LuminAgent(store).askTask("", "继续", "frozen", "off", "", None)
            @Expect(requests.size, 3)
            @Expect(strOf(requests[2], "reasoning_effort"), "high")
        } finally { upstream.close() }
    }

    @TestCase
    func emptySessionUsesTheActualIdAndExplicitInvalidModesNeverReachUpstream(): Unit {
        let dir = freshDir("reasoning-empty-session")
        let requests = ArrayList<JsonObject>()
        let upstream = ServerBuilder().addr("127.0.0.1").port(0).build()
        upstream.distributor.register("/v1/chat/completions", { ctx: HttpContext =>
            requests.add(objOf(JsonValue.fromStr(readAllString(ctx.request.body))).getOrThrow())
            ctx.responseBuilder.status(200); ctx.responseBuilder.header("Content-Type", "text/event-stream")
            ctx.responseBuilder.body(textResponse().toArray())
        })
        spawn { upstream.serve() }; sleep(Duration.millisecond * 150)
        let store = fixture(dir, baseUrl: "http://127.0.0.1:" + upstream.port.toString() + "/v1")
        let server = buildServer(dir, dir + "/ui"); spawn { server.serve() }
        sleep(Duration.millisecond * 150)
        try {
            for (value in ["\"invented\"", "\"on\"", "\"\"", "false", "null"]) {
                let ask = "{\"question\":\"你好\",\"web\":\"off\",\"reasoningMode\":" + value + "}"
                @Expect(post(server, "/api/agent/ask-pi", ask)[0], 400)
                let make = "{\"kind\":\"lecture\",\"topic\":\"测试\",\"web\":\"off\",\"reasoningMode\":" + value + "}"
                @Expect(post(server, "/api/agent/task-pi", make)[0], 400)
            }
            @Expect(requests.size, 0)
            let work = WorkContext(); work.reasoningMode = "high"
            let result = LuminAgent(store).askTask("", "测试", "", "off", "", Some(work))
            let sid = strOf(result, "sessionId")
            @Expect(boolOf(result, "ok"), true)
            @Expect(sid.size > 0, true)
            @Expect(SessionStore(dir).reasoningMode(sid), "high")
            @Expect(requests.size, 1)
            @Expect(strOf(requests[0], "reasoning_effort"), "high")
            @Expect(DbHub.open(dir).getKv("sessions_meta", "reasoning:", "missing"), "missing")
        } finally { server.close(); upstream.close() }
    }

    @TestCase
    func hostDoesNotInventReasoningUsageWhenTheProviderDidNotReportIt(): Unit {
        let dir = freshDir("reasoning-usage-missing")
        let result = LuminAgent(Store(dir)).askWithProvider(ReasoningUsageFixture(-1), "", "测试", "missing", "off", "")
        @Expect(objectAt(result, "tokens").get("reasoning").isNone(), true)
        for (event in SessionStore(dir).events("missing")) {
            if (strOf(event, "type") == "turn/usage") {
                @Expect(objectAt(event, "payload").get("reasoning").isNone(), true)
            }
        }
        let zero = LuminAgent(Store(dir)).askWithProvider(ReasoningUsageFixture(0), "", "测试", "zero", "off", "")
        @Expect(intOf(objectAt(zero, "tokens"), "reasoning"), 0)
    }
}

/** 区分缺省 -1 与供应商明确上报 0；不估计思考用量。 */
class ReasoningUsageFixture <: ChatProvider {
    let reasoning: Int64
    public init(reasoning: Int64) { this.reasoning = reasoning }
    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        let reply = ModelReply(); reply.text = "测试完成"
        reply.usageIn = 10; reply.usageOut = 12; reply.usageReasoning = reasoning
        return reply
    }
}
