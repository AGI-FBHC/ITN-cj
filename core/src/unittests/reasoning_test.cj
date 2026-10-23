package itn_desktop_core.unittests

import std.collection.*
import std.time.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.net.http.*
import stdx.encoding.json.*
import itn_desktop_core.reasoning.*
import itn_desktop_core.store.*
import itn_desktop_core.runtime.*
import itn_desktop_core.model_provider.OpenAiChatProvider
import itn_desktop_core.llm.LlmClient
import itn_desktop_core.util.readAllString

@Test
class ReasoningTest {
    func config(profile: String, model!: String = "deepseek-flash"): ModelConfig {
        let cfg = ModelConfig(); cfg.id = "reasoning"; cfg.baseUrl = "https://gateway.example/v1"; cfg.model = model; cfg.reasoningProfile = profile
        return cfg
    }

    @TestCase
    func autoRequiresKnownEndpointNotJustModelAlias(): Unit {
        let cfg = config("auto")
        @Expect(reasoningProfile(cfg), "none")
        @Expect(supportsReasoningMode(cfg, "high"), false)
        cfg.baseUrl = "https://api.deepseek.com.evil.example/v1"
        @Expect(reasoningProfile(cfg), "none")
        cfg.baseUrl = "https://api.deepseek.com/v1"
        @Expect(reasoningProfile(cfg), "deepseek")
        @Expect(supportsReasoningMode(cfg, "max"), true)
    }

    @TestCase
    func defaultAndUnsupportedModeNeverSendAnInventedEffort(): Unit {
        let cfg = config("auto"); let payload = JsonObject()
        applyReasoningParameters(payload, cfg, "high", 8192)
        @Expect(payload.get("thinking").isNone(), true)
        @Expect(payload.get("reasoning_effort").isNone(), true)
        @Expect(payload.get("stream_options").isNone(), true)
        @Expect(intOf(payload, "max_tokens"), 8192)
    }

    @TestCase
    func mimoOnlyExposesItsActualSwitch(): Unit {
        let cfg = config("mimo", model: "mimo-v2.6-flash")
        @Expect(supportsReasoningMode(cfg, "on"), true)
        @Expect(supportsReasoningMode(cfg, "high"), false)
        @Expect(supportsReasoningMode(cfg, "low"), false)
        let state = reasoningState(cfg, "high")
        @Expect(strOf(state, "effectiveMode"), "default")
        let payload = JsonObject(); applyReasoningParameters(payload, cfg, "on", 8192)
        @Expect(strOf(objOf(payload.get("thinking").getOrThrow()).getOrThrow(), "type"), "enabled")
        @Expect(payload.get("reasoning_effort").isNone(), true)
    }

    @TestCase
    func deepseekEffortIsDistinctFromOutputAndSampling(): Unit {
        let cfg = config("deepseek"); let payload = JsonObject()
        applyReasoningParameters(payload, cfg, "max", 8192)
        @Expect(strOf(payload, "reasoning_effort"), "max")
        @Expect(intOf(payload, "max_tokens"), 65536)
        @Expect(payload.get("temperature").isNone(), true)
        @Expect(supportsReasoningMode(cfg, "medium"), false)
    }

    @TestCase
    func qwenBudgetLeavesRoomForAnswerAndCannotDisableThinkingOnly(): Unit {
        let cfg = config("qwen-budget", model: "qwen3.5-plus"); let payload = JsonObject()
        applyReasoningParameters(payload, cfg, "high", 8192)
        @Expect(intOf(payload, "thinking_budget"), 16384)
        @Expect(intOf(payload, "max_tokens"), 32768)
        cfg.model = "qwen3.8-2.4t-a95b"
        @Expect(supportsReasoningMode(cfg, "off"), false)
    }

    @TestCase
    func openaiUsesCompletionBudgetAndModelSpecificLevels(): Unit {
        let cfg = config("openai", model: "gpt-5.2"); let payload = JsonObject()
        applyReasoningParameters(payload, cfg, "max", 8192)
        @Expect(strOf(payload, "reasoning_effort"), "xhigh")
        @Expect(payload.get("max_tokens").isNone(), true)
        @Expect(payload.get("max_completion_tokens").isSome(), true)
        cfg.model = "gpt-6-astra"
        @Expect(supportsReasoningMode(cfg, "high"), false)
        @Expect(supportsReasoningMode(cfg, "off"), false)
        cfg.model = "gpt-5-pro"
        @Expect(supportsReasoningMode(cfg, "high"), true)
        @Expect(supportsReasoningMode(cfg, "low"), false)
    }

    @TestCase
    func storedProfileDoesNotPersistATurnsModeOrCredentialsInPublicJson(): Unit {
        let dir = freshDir("reasoning-config")
        let store = Store(dir); let settings = Settings(); let cfg = config("deepseek")
        cfg.apiKey = "fixture-not-a-real-secret"; cfg.reasoningMode = "high"; settings.models.add(cfg); store.save(settings)
        let reloaded = store.load().models[0]
        @Expect(reloaded.reasoningProfile, "deepseek")
        @Expect(reloaded.reasoningMode, "default")
        @Expect(strOf(reloaded.toPublicJson(), "apiKey"), "")
        let snapshot = copyReasoningConfig(reloaded, "low"); reloaded.reasoningProfile = "none"
        @Expect(snapshot.reasoningProfile, "deepseek"); @Expect(snapshot.reasoningMode, "low")
    }

    func peer(requests: ArrayList<JsonObject>): Server {
        let server = ServerBuilder().addr("127.0.0.1").port(0).build()
        server.distributor.register("/v1/chat/completions", { ctx: HttpContext =>
            requests.add(objOf(JsonValue.fromStr(readAllString(ctx.request.body))).getOrThrow())
            ctx.responseBuilder.status(200); ctx.responseBuilder.header("Content-Type", "text/event-stream")
            ctx.responseBuilder.body(("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"a deliberately long reasoning segment\"}}]}\n\n" +
                "data: {\"choices\":[{\"delta\":{\"content\":\"42\"},\"finish_reason\":\"stop\"}]}\n\n" +
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":12,\"completion_tokens_details\":{\"reasoning_tokens\":10}}}\n\ndata: [DONE]\n\n").toArray())
        })
        spawn { server.serve() }; sleep(Duration.millisecond * 100)
        return server
    }

    @TestCase
    func bothTransportPathsReallySendSameEffortAndParseUsage(): Unit {
        let requests = ArrayList<JsonObject>(); let server = peer(requests)
        try {
            let cfg = config("deepseek"); cfg.baseUrl = "http://127.0.0.1:" + server.port.toString() + "/v1"; cfg.reasoningMode = "low"
            let reply = OpenAiChatProvider(cfg).respond(StepContext(), EventStream())
            let text = LlmClient(cfg).chat("", "calculate")
            @Expect(reply.text, "42"); @Expect(text, "42"); @Expect(reply.usageReasoning, 10); @Expect(reply.usageOut, 12)
            @Expect(requests.size, 2)
            for (request in requests) { @Expect(strOf(request, "reasoning_effort"), "low"); @Expect(request.get("temperature").isNone(), true) }
        } finally { server.close() }
    }

    @TestCase
    func deepseekReturnsTextOnlyAssistantReasoningInToolHistory(): Unit {
        let requests = ArrayList<JsonObject>(); let server = peer(requests)
        try {
            let cfg = config("deepseek"); cfg.baseUrl = "http://127.0.0.1:" + server.port.toString() + "/v1"; cfg.reasoningMode = "high"
            let context = StepContext(); let previous = Message(AssistantMsg); previous.text = "earlier"; previous.thinking = "preserved thought"; context.messages.add(previous)
            OpenAiChatProvider(cfg).respond(context, EventStream())
            let messages = match (requests[0].get("messages").getOrThrow()) { case a: JsonArray => a; case _ => JsonArray() }
            @Expect(strOf(objOf(messages[0]).getOrThrow(), "reasoning_content"), "preserved thought")
        } finally { server.close() }
    }

    @TestCase
    func explicitMimoThinkingIsNeverDisabledByTheLegacyByteGuard(): Unit {
        let requests = ArrayList<JsonObject>(); let server = peer(requests)
        try {
            let cfg = config("mimo", model: "mimo-v2.6-flash"); cfg.baseUrl = "http://127.0.0.1:" + server.port.toString() + "/v1"; cfg.reasoningMode = "on"
            let provider = OpenAiChatProvider(cfg); provider.maxReasoningBytes = 8
            let reply = provider.respond(StepContext(), EventStream())
            @Expect(reply.stopReason, "stop"); @Expect(reply.text, "42"); @Expect(requests.size, 1)
            @Expect(strOf(objOf(requests[0].get("thinking").getOrThrow()).getOrThrow(), "type"), "enabled")
        } finally { server.close() }
    }

    @TestCase
    func concurrentSessionsCanCreateTheirSharedDirectory(): Unit {
        let dir = freshDir("reasoning-concurrent-native")
        let runs = Array(16, { i: Int64 => spawn { newSession(dir, "shared-workspace", "parallel-" + i.toString(), "").id } })
        for (i in 0..16) { @Expect(runs[i].get(), "parallel-" + i.toString()) }
    }
}
