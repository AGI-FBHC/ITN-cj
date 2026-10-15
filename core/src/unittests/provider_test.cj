package itn_desktop_core.unittests

import std.collection.*
import std.sync.*
import std.time.*
import stdx.net.http.*
import stdx.encoding.json.*
import itn_desktop_core.pi.*
import itn_desktop_core.pi_provider.*
import itn_desktop_core.store.*
import itn_desktop_core.util.readAllString
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 模型通信层（OpenAiChatProvider）的自测。
 *
 * 用一个**进程内的 SSE 假服务**当模型：不起 python、不联网，测的是"契约"——
 * 正文/思考的增量、原生 tool_calls 的增量拼装、stopReason、usage、以及
 * 429 只在"还没推过事件"时重试、500 直接把错误原文带回去。
 */
@Test
class ProviderTest {

    func silentServer(): Server {
        let server = ServerBuilder().addr("127.0.0.1").port(0).build()
        server.distributor.register("/v1/chat/completions", { ctx: HttpContext =>
            readAllString(ctx.request.body)
            sleep(Duration.second * 3)
            ctx.responseBuilder.status(200)
            ctx.responseBuilder.header("Content-Type", "text/event-stream")
            ctx.responseBuilder.body("data: [DONE]\n\n".toArray())
        })
        spawn { server.serve() }
        sleep(Duration.millisecond * 150)
        return server
    }

    @TestCase
    func cancellationInterruptsACompletelySilentModel(): Unit {
        let server = silentServer()
        let provider = OpenAiChatProvider(modelCfg(Int64(server.port)))
        let started = DateTime.now()
        provider.shouldAbort = Some({ => (DateTime.now() - started).toMilliseconds() >= 250 })
        provider.respond(StepContext(), EventStream())
        @Expect((DateTime.now() - started).toMilliseconds() < 2000, true)
        server.close()
    }

    @TestCase
    func idleTimeoutDoesNotRetryASilentRequest(): Unit {
        let server = silentServer()
        let provider = OpenAiChatProvider(modelCfg(Int64(server.port)))
        provider.idleTimeoutMillis = 250
        let started = DateTime.now()
        let reply = provider.respond(StepContext(), EventStream())
        @Expect(reply.stopReason, "error")
        @Expect(reply.errorMessage.contains("长时间未返回"), true)
        @Expect((DateTime.now() - started).toMilliseconds() < 2000, true)
        server.close()
    }

    @TestCase
    func emptyCompletionIsReportedAsFailure(): Unit {
        let counter = ArrayList<Int64>()
        counter.add(0)
        let server = startServer("data: [DONE]\n\n", 200, counter, false)
        let provider = OpenAiChatProvider(modelCfg(Int64(server.port)))
        let reply = provider.respond(StepContext(), EventStream())
        @Expect(reply.stopReason, "error")
        @Expect(reply.errorMessage.contains("未返回可用正文"), true)
        @Expect(counter[0], 1)
        server.close()
    }

    func modelCfg(port: Int64): ModelConfig {
        let cfg = ModelConfig()
        cfg.id = "mock"
        cfg.name = "mock"
        cfg.baseUrl = "http://127.0.0.1:" + port.toString() + "/v1"
        cfg.apiKey = "test-key"
        cfg.model = "mock-model"
        return cfg
    }

    func line(obj: String): String {
        return "data: " + obj + "\n\n"
    }

    /** 一段"正文两片 + 一条工具调用（分两片参数）"的脚本。 */
    func scriptText(): String {
        let sb = StringBuilder()
        sb.append(line("{\"choices\":[{\"delta\":{\"content\":\"你\"}}]}"))
        sb.append(line("{\"choices\":[{\"delta\":{\"reasoning_content\":\"想一下\"}}]}"))
        sb.append(line("{\"choices\":[{\"delta\":{\"content\":\"好\"}}]}"))
        sb.append(line("{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}"))
        sb.append(line("{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}}]}}]}"))
        sb.append(line("{\"choices\":[{\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":7}}"))
        sb.append("data: [DONE]\n\n")
        return sb.toString()
    }

    func startServer(body: String, status: UInt16, counter: ArrayList<Int64>, failFirst: Bool): Server {
        let server = ServerBuilder().addr("127.0.0.1").port(0).build()
        server.distributor.register("/v1/chat/completions", { ctx: HttpContext =>
            counter[0] = counter[0] + 1
            let body2 = readAllString(ctx.request.body)
            if (body2.size == 0) {
                ctx.responseBuilder.status(400)
                ctx.responseBuilder.body("bad request".toArray())
                return
            }
            if (failFirst && counter[0] == 1) {
                ctx.responseBuilder.status(429)
                ctx.responseBuilder.body("{\"error\":\"rate limited\"}".toArray())
                return
            }
            ctx.responseBuilder.status(status)
            ctx.responseBuilder.header("Content-Type", "text/event-stream")
            ctx.responseBuilder.body(body.toArray())
        })
        spawn { server.serve() }
        sleep(Duration.millisecond * 300)
        return server
    }

    @TestCase
    func parsesDeltasAndNativeToolCalls(): Unit {
        let counter = ArrayList<Int64>()
        counter.add(0)
        let server = startServer(scriptText(), 200, counter, false)
        let provider = OpenAiChatProvider(modelCfg(Int64(server.port)))
        let stream = EventStream()
        let ctx = StepContext()
        ctx.system = "你是助手"
        let um = Message(MsgRole.UserMsg)
        um.text = "读一下 a.txt"
        ctx.messages.add(um)

        let reply = provider.respond(ctx, stream)
        @Expect(reply.stopReason, "toolUse")
        @Expect(reply.text, "你好")
        @Expect(reply.thinking, "想一下")
        @Expect(reply.toolCalls.size, 1)
        @Expect(reply.toolCalls[0].name, "read")
        @Expect(reply.toolCalls[0].id, "call_1")
        @Expect(reply.toolCalls[0].argsJson.contains("a.txt"), true)
        @Expect(reply.usageIn, 100)
        @Expect(reply.usageOut, 7)

        // 事件流：正文两片 + 思考一片 + 工具参数两片（可被消费一次）
        let events = stream.drain()
        var text = 0
        var think = 0
        var toolDelta = 0
        for (e in events) {
            if (kindText(e.kind) != "message_update") {
                continue
            }
            match (objOf(match (e.payload.get("assistantEvent")) { case Some(v) => v; case None => JsonNull() })) {
                case Some(ae) =>
                    let t = strOf(ae, "type")
                    if (t == "text_delta") { text = text + 1 }
                    if (t == "thinking_delta") { think = think + 1 }
                    if (t == "toolcall_delta") { toolDelta = toolDelta + 1 }
                case None => ()
            }
        }
        @Expect(text, 2)
        @Expect(think, 1)
        @Expect(toolDelta >= 1, true)
        @Expect(stream.drain().size, 0)
    }

    @TestCase
    func retriesRateLimitOnlyBeforeEmitting(): Unit {
        let counter = ArrayList<Int64>()
        counter.add(0)
        let server = startServer(scriptText(), 200, counter, true)
        let provider = OpenAiChatProvider(modelCfg(Int64(server.port)))
        provider.maxAttempts = 3
        let stream = EventStream()
        let ctx = StepContext()
        let um = Message(MsgRole.UserMsg)
        um.text = "hi"
        ctx.messages.add(um)

        let reply = provider.respond(ctx, stream)
        @Expect(reply.stopReason, "toolUse")
        @Expect(reply.text, "你好")
        @Expect(counter[0], 2)
    }

    @TestCase
    func serverErrorIsReportedNotThrown(): Unit {
        let counter = ArrayList<Int64>()
        counter.add(0)
        let server = startServer("boom", 500, counter, false)
        let provider = OpenAiChatProvider(modelCfg(Int64(server.port)))
        provider.maxAttempts = 2
        let stream = EventStream()
        let ctx = StepContext()
        let um = Message(MsgRole.UserMsg)
        um.text = "hi"
        ctx.messages.add(um)

        let reply = provider.respond(ctx, stream)
        @Expect(reply.stopReason, "error")
        @Expect(reply.errorMessage.contains("500"), true)
        @Expect(reply.text, "")
    }
}
