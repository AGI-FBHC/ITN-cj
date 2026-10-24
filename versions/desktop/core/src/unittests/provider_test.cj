package itn_desktop_core.unittests

import std.collection.*
import std.convert.*
import std.sync.*
import std.net.*
import std.time.*
import stdx.net.http.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*
import itn_desktop_core.model_provider.*
import itn_desktop_core.store.*
import itn_desktop_core.runtime_host.LuminAgent
import itn_desktop_core.runtime_host.sessionHub
import itn_desktop_core.session.SessionStore
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
    // A real Cangjie TCP peer sends frames, then closes before the terminal HTTP chunk.
    // Leaving the request body unread produces a TCP reset on Windows (10054).
    func resetPeer(frames: Array<String>, truncated!: Bool = true, lingerMs!: Int64 = 180): (TcpServerSocket, ArrayList<Int64>) {
        let server = TcpServerSocket(bindAt: IPSocketAddress("127.0.0.1", 0))
        server.bind()
        let count = ArrayList<Int64>(); count.add(0)
        spawn {
            for (body in frames) {
                try {
                    let socket = server.accept()
                    let header = StringBuilder()
                    let byte = Array<UInt8>(1, repeat: 0)
                    while (header.size < 32768 && !header.toString().contains("\r\n\r\n")) {
                        if (socket.read(byte) <= 0) { break }
                        header.append(String.fromUtf8(byte))
                    }
                    count[0] += 1
                    if (truncated) {
                        // A complete HTTP chunk followed by a missing terminal chunk models a reset.
                        let bytes = Array<UInt8>(8192, repeat: 32)
                        let text = body.toArray()
                        for (i in 0..text.size) { bytes[i] = text[i] }
                        socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2000\r\n".toArray())
                        socket.write(bytes)
                        socket.write("\r\n".toArray())
                    } else {
                        socket.write(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: " + body.size.toString() + "\r\nConnection: close\r\n\r\n" + body).toArray())
                    }
                    sleep(Duration.millisecond * lingerMs)
                    socket.close()
                } catch (e: Exception) { println("RESET_FIXTURE error: " + e.message); break }
            }
        }
        return (server, count)
    }

    func resetConfig(server: TcpServerSocket): ModelConfig {
        return modelCfg(Int64.parse(server.localAddress.toString().split(":")[1]))
    }

    func roleFrame(): String { return line("{\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}") }
    func textFrame(): String { return line("{\"choices\":[{\"delta\":{\"content\":\"已收到的回答\"}}]}") }
    func endFrame(): String { return line("{\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}") }

    @TestCase
    func resetAfterRoleFrameRetriesBeforeVisibleOutput(): Unit {
        let (server, count) = resetPeer([roleFrame(), textFrame() + endFrame() + "data: [DONE]\n\n"])
        try {
            let provider = OpenAiChatProvider(resetConfig(server))
            let audits = ArrayList<JsonObject>()
            provider.onAudit = Some({ name, p => if (name == "model/retry") { audits.add(p) } })
            let reply = provider.respond(StepContext(), EventStream())
            @Expect(count[0], 2); @Expect(reply.stopReason, "stop"); @Expect(reply.text, "已收到的回答")
            @Expect(audits.size, 1); @Expect(strOf(audits[0], "reason"), "network_retry"); @Expect(intOf(audits[0], "attempt"), 2)
        } finally { server.close() }
    }

    @TestCase
    func resetDuringAnswerPreservesPartialWithoutRetrying(): Unit {
        let (server, count) = resetPeer([roleFrame() + textFrame()])
        try {
            let provider = OpenAiChatProvider(resetConfig(server))
            let reply = provider.respond(StepContext(), EventStream())
            @Expect(count[0], 1); @Expect(reply.stopReason, "error"); @Expect(reply.text, "已收到的回答")
            @Expect(reply.errorMessage.contains("模型连接中断"), true); @Expect(reply.toolCalls.size, 0)
        } finally { server.close() }
    }

    @TestCase
    func completedStreamDoesNotWaitForPeerClose(): Unit {
        let (server, count) = resetPeer([textFrame() + endFrame() + "data: [DONE]\n\n"], truncated: true, lingerMs: 2500)
        try {
            let started = DateTime.now()
            let reply = OpenAiChatProvider(resetConfig(server)).respond(StepContext(), EventStream())
            @Expect(reply.stopReason, "stop"); @Expect(reply.text, "已收到的回答"); @Expect(count[0], 1)
            @Expect((DateTime.now() - started).toMilliseconds() < 1800, true)
        } finally { server.close() }
    }

    @TestCase
    func resetAfterFinishReasonKeepsSuccessfulAnswer(): Unit {
        let (server, count) = resetPeer([textFrame() + endFrame()])
        try {
            let reply = OpenAiChatProvider(resetConfig(server)).respond(StepContext(), EventStream())
            @Expect(reply.stopReason, "stop"); @Expect(reply.text, "已收到的回答"); @Expect(count[0], 1)
        } finally { server.close() }
    }

    @TestCase
    func eofWithoutFinishCannotExecuteCompleteLookingToolArgs(): Unit {
        let body = line("{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"incomplete-request\",\"function\":{\"name\":\"write\",\"arguments\":\"{}\"}}]}}]}")
        let (server, count) = resetPeer([body], truncated: false)
        try {
            let reply = OpenAiChatProvider(resetConfig(server)).respond(StepContext(), EventStream())
            @Expect(reply.stopReason, "error"); @Expect(reply.toolCalls.size, 0); @Expect(count[0], 1)
        } finally { server.close() }
    }

    @TestCase
    func failedAnswerContextRetainsCompletedToolAndPartialText(): Unit {
        let calc = line("{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"calc-before-reset\",\"function\":{\"name\":\"calc\",\"arguments\":\"{\\\"expr\\\":\\\"7*8\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}") + "data: [DONE]\n\n"
        let (server, count) = resetPeer([calc, textFrame()])
        try {
            let dir = freshDir("reset-preserved-context")
            let host = LuminAgent(Store(dir))
            let result = host.askWithProvider(OpenAiChatProvider(resetConfig(server)), "", "算出结果再解释", "reset-context", "off", "")
            @Expect(boolOf(result, "ok", true), false); @Expect(count[0], 2)
            let capture = CaptureContext()
            host.askWithProvider(capture, "", "继续剩余回答，沿用已有结果", "reset-context", "off", "")
            var partial = 0; var tools = 0
            for (m in capture.seen) {
                if (m.role == AssistantMsg && m.text == "已收到的回答") { partial += 1 }
                if (m.role == ToolResultMsg && m.text.contains("56")) { tools += 1 }
            }
            @Expect(partial, 1); @Expect(tools, 1)
            var calls = 0
            for (e in SessionStore(dir).events("reset-context")) { if (strOf(e, "type") == "tool/call") { calls += 1 } }
            @Expect(calls, 1)
        } finally { server.close() }
    }

    @TestCase
    func mimoReasoningByteBudgetStopsBeforeExhaustingOutput(): Unit {
        let requests=ArrayList<JsonObject>()
        let server=ServerBuilder().addr("127.0.0.1").port(0).build()
        server.distributor.register("/v1/chat/completions", { ctx: HttpContext =>
            requests.add(objOf(JsonValue.fromStr(readAllString(ctx.request.body))).getOrThrow())
            let body=if (requests.size == 1) { line("{\"choices\":[{\"delta\":{\"reasoning_content\":\"more than configured reasoning bytes\"}}]}") }
                else { toolScript("{\"path\":\"a.html\",\"content\":\"<svg></svg>\"}","tool_calls") }
            ctx.responseBuilder.status(200);ctx.responseBuilder.header("Content-Type","text/event-stream");ctx.responseBuilder.body(body.toArray())
        })
        spawn { server.serve() };sleep(Duration.millisecond * 150)
        let cfg=modelCfg(Int64(server.port));cfg.model="mimo-v2.6-flash"
        let provider=OpenAiChatProvider(cfg);provider.maxReasoningBytes=8
        let reply=provider.respond(StepContext(),EventStream())
        @Expect(requests.size,2);@Expect(reply.stopReason,"toolUse");@Expect(reply.toolCalls.size,1)
        @Expect(strOf(objOf(requests[1].get("thinking").getOrThrow()).getOrThrow(),"type"),"disabled")
        server.close()
    }

    @TestCase
    func mimoReasoningOnlyLengthRecoversWithoutMoreThinking(): Unit {
        let requests=ArrayList<JsonObject>()
        let server=ServerBuilder().addr("127.0.0.1").port(0).build()
        server.distributor.register("/v1/chat/completions", { ctx: HttpContext =>
            requests.add(objOf(JsonValue.fromStr(readAllString(ctx.request.body))).getOrThrow())
            let body=if (requests.size == 1) { line("{\"choices\":[{\"delta\":{\"reasoning_content\":\"long thinking\"},\"finish_reason\":\"length\"}]}") }
                else { toolScript("{\"path\":\"a.html\",\"content\":\"<svg></svg>\"}","tool_calls") }
            ctx.responseBuilder.status(200);ctx.responseBuilder.header("Content-Type","text/event-stream");ctx.responseBuilder.body(body.toArray())
        })
        spawn { server.serve() };sleep(Duration.millisecond * 150)
        let cfg=modelCfg(Int64(server.port));cfg.model="mimo-v2.6-flash"
        let reply=OpenAiChatProvider(cfg).respond(StepContext(),EventStream())
        @Expect(requests.size,2)
        @Expect(strOf(objOf(requests[1].get("thinking").getOrThrow()).getOrThrow(),"type"),"disabled")
        @Expect(reply.stopReason,"toolUse");@Expect(reply.toolCalls.size,1)
        server.close()
    }

    func toolScript(args: String, finish: String): String {
        return line("{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"write-1\",\"function\":{\"name\":\"write\",\"arguments\":" + JsonString(args).toString() + "}}]}}]}") +
            line("{\"choices\":[{\"finish_reason\":\"" + finish + "\"}]}") + "data: [DONE]\n\n"
    }

    @TestCase
    func truncatedToolInputRetriesOnceBeforeExecution(): Unit {
        let requests = ArrayList<Int64>()
        let server = ServerBuilder().addr("127.0.0.1").port(0).build()
        server.distributor.register("/v1/chat/completions", { ctx: HttpContext =>
            let request = objOf(JsonValue.fromStr(readAllString(ctx.request.body))).getOrThrow()
            requests.add(intOf(request,"max_tokens"))
            let body = if (requests.size == 1) { toolScript("{\"path\":\"a.html\",\"content\":\"<svg", "length") }
                else { toolScript("{\"path\":\"a.html\",\"content\":\"<svg></svg>\"}", "tool_calls") }
            ctx.responseBuilder.status(200); ctx.responseBuilder.header("Content-Type","text/event-stream"); ctx.responseBuilder.body(body.toArray())
        })
        spawn { server.serve() }; sleep(Duration.millisecond * 150)
        let provider = OpenAiChatProvider(modelCfg(Int64(server.port)))
        let reply = provider.respond(StepContext(),EventStream())
        @Expect(requests.size,2); @Expect(requests[0],8192); @Expect(requests[1],32768)
        @Expect(reply.stopReason,"toolUse"); @Expect(reply.toolCalls.size,1)
        @Expect(strOf(reply.toolCalls[0].args(),"path"),"a.html")
        @Expect(strOf(reply.toolCalls[0].args(),"content"),"<svg></svg>")
        server.close()
    }

    @TestCase
    func repeatedTruncationNeverReturnsExecutableTools(): Unit {
        let counter=ArrayList<Int64>(); counter.add(0)
        let server=startServer(toolScript("{\"path\":\"a.html\",\"content\":\"unfinished", "length"),200,counter,false)
        let reply=OpenAiChatProvider(modelCfg(Int64(server.port))).respond(StepContext(),EventStream())
        @Expect(counter[0],2); @Expect(reply.stopReason,"error"); @Expect(reply.toolCalls.size,0)
        @Expect(reply.errorMessage.contains("截断"),true)
        server.close()
    }

    @TestCase
    func malformedFinishedArgumentsAreNotRepairedToEmptyObject(): Unit {
        let counter=ArrayList<Int64>();counter.add(0)
        let server=startServer(toolScript("{\"path\":\"a.html\",\"content\":\"unfinished", "tool_calls"),200,counter,false)
        let reply=OpenAiChatProvider(modelCfg(Int64(server.port))).respond(StepContext(),EventStream())
        @Expect(counter[0],2); @Expect(reply.stopReason,"error"); @Expect(reply.toolCalls.size,0)
        @Expect(reply.errorMessage.contains("JSON"),true)
        server.close()
    }

    func nativeToolFrame(index: Int64, id: String, name: String, args: String): String {
        let fn = JsonObject(); fn.put("name", JsonString(name)); fn.put("arguments", JsonString(args))
        let call = JsonObject(); call.put("index", JsonInt(index)); call.put("id", JsonString(id)); call.put("function", fn)
        let calls = JsonArray(); calls.add(call)
        let delta = JsonObject(); delta.put("tool_calls", calls)
        let choice = JsonObject(); choice.put("delta", delta)
        let choices = JsonArray(); choices.add(choice)
        let obj = JsonObject(); obj.put("choices", choices)
        return line(obj.toString())
    }

    func toolFinishFrame(): String {
        return line("{\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}") + "data: [DONE]\n\n"
    }

    func scriptedRequests(scripts: Array<String>, requests: ArrayList<JsonObject>): Server {
        let server = ServerBuilder().addr("127.0.0.1").port(0).build()
        server.distributor.register("/v1/chat/completions", { ctx: HttpContext =>
            requests.add(objOf(JsonValue.fromStr(readAllString(ctx.request.body))).getOrThrow())
            let index = if (requests.size <= scripts.size) { requests.size - 1 } else { scripts.size - 1 }
            ctx.responseBuilder.status(200)
            ctx.responseBuilder.header("Content-Type", "text/event-stream")
            ctx.responseBuilder.body(scripts[index].toArray())
        })
        spawn { server.serve() }; sleep(Duration.millisecond * 150)
        return server
    }

    @TestCase
    func interleavedNativeArgumentsPreserveUnicodeAndSplitJsonEscapes(): Unit {
        let fragments = ["{\"title\":\"异常", "输入\",\"definition\":\"引用", "\\", "\"abc\\\"与", "\\u4e", "2d、🙂\"}"]
        let script = StringBuilder(); let expected = StringBuilder()
        for (i in 0..fragments.size) {
            expected.append(fragments[i])
            script.append(nativeToolFrame(0, "record-1", "record_knowledge_point", fragments[i]))
            if (i == 1) { script.append(nativeToolFrame(1, "calc-1", "calc", "{\"expr\":")) }
            if (i == 3) { script.append(nativeToolFrame(1, "calc-1", "calc", "\"2+3\"}")) }
        }
        script.append(toolFinishFrame())
        let requests = ArrayList<JsonObject>()
        let server = scriptedRequests([script.toString()], requests)
        try {
            let reply = OpenAiChatProvider(modelCfg(Int64(server.port))).respond(StepContext(), EventStream())
            @Expect(requests.size, 1); @Expect(reply.stopReason, "toolUse"); @Expect(reply.toolCalls.size, 2)
            @Expect(reply.toolCalls[0].argsJson, expected.toString())
            @Expect(strOf(reply.toolCalls[0].args(), "definition"), "引用\"abc\"与中、🙂")
            @Expect(strOf(reply.toolCalls[1].args(), "expr"), "2+3")
        } finally { server.close() }
    }

    @TestCase
    func malformedToolOnlyResponseRecoversTheSameStepOnceWithoutRepair(): Unit {
        // Legal outer SSE JSON containing illegal inner JSON: unescaped quote from a model.
        let invalid = "{\"title\":\"异常输入\",\"definition\":\"不能把\"abc\"按0处理\"}"
        let valid = "{\"title\":\"异常输入\",\"definition\":\"必须拒绝异常输入\"}"
        let first = nativeToolFrame(0, "bad-record", "record_knowledge_point", invalid) +
            line("{\"usage\":{\"prompt_tokens\":10155,\"completion_tokens\":309,\"completion_tokens_details\":{\"reasoning_tokens\":80}}}") + toolFinishFrame()
        let second = nativeToolFrame(0, "good-record", "record_knowledge_point", valid) +
            line("{\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":12,\"completion_tokens_details\":{\"reasoning_tokens\":3}}}") + toolFinishFrame()
        let requests = ArrayList<JsonObject>(); let audits = ArrayList<JsonObject>()
        let server = scriptedRequests([first, second], requests)
        try {
            let provider = OpenAiChatProvider(modelCfg(Int64(server.port)))
            provider.onAudit = Some({ kind, data => if (kind == "model/retry" || kind == "model/tool_arguments_invalid") { audits.add(data) } })
            let ctx = StepContext()
            let user = Message(UserMsg); user.text = "异常输入能默认按0计算吗？"; ctx.messages.add(user)
            let reply = provider.respond(ctx, EventStream())
            @Expect(requests.size, 2); @Expect(requests[0].toString(), requests[1].toString())
            @Expect(reply.stopReason, "toolUse"); @Expect(reply.toolCalls.size, 1)
            @Expect(reply.toolCalls[0].id, "good-record"); @Expect(reply.toolCalls[0].argsJson, valid)
            @Expect(reply.usageIn, 10165); @Expect(reply.usageOut, 321); @Expect(reply.usageReasoning, 83)
            @Expect(audits.size, 2); @Expect(strOf(audits[1], "reason"), "invalid_tool_arguments")
            @Expect(intOf(audits[0], "argumentBytes"), invalid.size)
            @Expect(audits[0].toString().contains("不能把"), false)
        } finally { server.close() }
    }

    @TestCase
    func invalidMultiCallBatchDoesNotPublishItsEarlierValidCall(): Unit {
        let first = nativeToolFrame(0, "discarded-write", "write", "{\"path\":\"must-not-run.txt\",\"content\":\"private\"}") +
            nativeToolFrame(1, "invalid-record", "record_knowledge_point", "{\"title\":") + toolFinishFrame()
        let second = nativeToolFrame(0, "recovered-record", "record_knowledge_point", "{\"title\":\"异常输入\"}") + toolFinishFrame()
        let requests = ArrayList<JsonObject>(); let server = scriptedRequests([first, second], requests)
        try {
            let reply = OpenAiChatProvider(modelCfg(Int64(server.port))).respond(StepContext(), EventStream())
            @Expect(requests.size, 2); @Expect(reply.stopReason, "toolUse"); @Expect(reply.toolCalls.size, 1)
            @Expect(reply.toolCalls[0].id, "recovered-record")
            @Expect(reply.toolCalls[0].name, "record_knowledge_point")
        } finally { server.close() }
    }

    @TestCase
    func malformedArgumentsWithVisibleTextAreNotRetried(): Unit {
        let requests = ArrayList<JsonObject>()
        let first = textFrame() + nativeToolFrame(0, "invalid-record", "record_knowledge_point", "{\"title\":") + toolFinishFrame()
        let server = scriptedRequests([first], requests)
        try {
            let reply = OpenAiChatProvider(modelCfg(Int64(server.port))).respond(StepContext(), EventStream())
            @Expect(requests.size, 1); @Expect(reply.stopReason, "error"); @Expect(reply.toolCalls.size, 0)
            @Expect(reply.text, "已收到的回答"); @Expect(reply.errorMessage.contains("JSON"), true)
        } finally { server.close() }
    }

    @TestCase
    func repeatedInvalidNonObjectArgumentsCannotBecomeExecutable(): Unit {
        let invalid = ArrayList<String>()
        for (args in ["{\"title\":", "[]", "null", "\"{}\"", "{} trailing", "{}{}", "{\"x\":1,}", "{\"x\":01}"]) { invalid.add(args) }
        // The stdx decoder accepts unescaped LF. Cover every raw control byte,
        // including after an escaped backslash/quote, rather than weakening JSON.
        for (byte in 0..32) {
            let control = String.fromUtf8([UInt8(byte)])
            invalid.add("{\"title\":\"bad" + control + "value\"}")
        }
        invalid.add("{\"title\":\"escaped\\\\" + "\n" + "value\"}")
        invalid.add("{\"title\":\"escaped\\\"" + "\n" + "value\"}")
        for (args in invalid) {
            let requests = ArrayList<JsonObject>()
            let script = nativeToolFrame(0, "invalid-record", "record_knowledge_point", args) + toolFinishFrame()
            let server = scriptedRequests([script], requests)
            try {
                let reply = OpenAiChatProvider(modelCfg(Int64(server.port))).respond(StepContext(), EventStream())
                @Expect(requests.size, 2); @Expect(reply.stopReason, "error"); @Expect(reply.toolCalls.size, 0)
                @Expect(reply.errorMessage.contains("JSON"), true)
            } finally { server.close() }
        }
    }

    @TestCase
    func escapedControlsAndLegalJsonWhitespaceRemainUnchanged(): Unit {
        let args = " \n\t{\"text\":\"line\\nnext\\r\\t\\b\\f\\u0000\\u001f\\\\\\\"\",\"nested\":[true,false,null,-1.2e+3]}\r\n "
        let requests = ArrayList<JsonObject>()
        let server = scriptedRequests([nativeToolFrame(0, "valid-escapes", "write", args) + toolFinishFrame()], requests)
        try {
            let reply = OpenAiChatProvider(modelCfg(Int64(server.port))).respond(StepContext(), EventStream())
            @Expect(requests.size, 1); @Expect(reply.stopReason, "toolUse"); @Expect(reply.toolCalls.size, 1)
            @Expect(reply.toolCalls[0].argsJson, trimStr(args))
            @Expect(strOf(reply.toolCalls[0].args(), "text").contains("line\nnext\r\t"), true)
        } finally { server.close() }
    }

    @TestCase
    func recoveryDoesNotReplayPreviouslyCompletedToolActions(): Unit {
        let calc = nativeToolFrame(0, "calc-completed", "calc", "{\"expr\":\"17*19\"}") + toolFinishFrame()
        let invalid = nativeToolFrame(0, "bad-record", "record_knowledge_point", "{\"title\":\"异常输入") + toolFinishFrame()
        let saved = nativeToolFrame(0, "note-recovered", "save_note", "{\"title\":\"安全恢复\",\"text\":\"异常输入不得按0处理\"}") + toolFinishFrame()
        let requests = ArrayList<JsonObject>()
        let server = scriptedRequests([calc, invalid, saved, textFrame() + endFrame() + "data: [DONE]\n\n"], requests)
        try {
            let dir = freshDir("invalid-tool-recovery")
            let result = LuminAgent(Store(dir)).askWithProvider(OpenAiChatProvider(modelCfg(Int64(server.port))), "", "计算并保存笔记", "invalid-json-step", "off", "")
            @Expect(boolOf(result, "ok", false), true); @Expect(requests.size, 4)
            @Expect(requests[1].toString(), requests[2].toString())
            var calcCalls = 0; var noteCalls = 0; var invalidCalls = 0
            for (event in SessionStore(dir).events("invalid-json-step")) {
                if (strOf(event, "type") != "tool/call") { continue }
                let payload = objOf(event.get("payload").getOrThrow()).getOrThrow()
                let name = strOf(payload, "tool")
                if (name == "calc") { calcCalls += 1 }
                if (name == "save_note") { noteCalls += 1 }
                if (name == "record_knowledge_point") { invalidCalls += 1 }
            }
            @Expect(calcCalls, 1); @Expect(noteCalls, 1); @Expect(invalidCalls, 0)
            @Expect(requests[2].toString().contains("323"), true)
        } finally { server.close() }
    }

    @TestCase
    func automaticallyAllocatedSessionCanStopItsSilentModel(): Unit {
        let server = silentServer()
        let dir = freshDir("cancel-auto-session")
        let provider = OpenAiChatProvider(modelCfg(Int64(server.port)))
        let canceller = spawn {
            var tries = 0
            while (tries < 100) {
                let sessions = SessionStore(dir).list()
                if (sessions.size > 0) { sessionHub().abort(strOf(sessions[0], "sessionId")); break }
                sleep(Duration.millisecond * 20)
                tries = tries + 1
            }
        }
        let started = DateTime.now()
        let result = LuminAgent(Store(dir)).askWithProvider(provider, "", "hello", "", "off", "")
        canceller.get()
        @Expect(boolOf(result, "ok", true), false)
        @Expect(strOf(result, "message").contains("取消"), true)
        @Expect((DateTime.now() - started).toMilliseconds() < 2000, true)
        server.close()
    }

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
        let cancelled = provider.respond(StepContext(), EventStream())
        @Expect(cancelled.stopReason, "aborted")
        @Expect(cancelled.errorMessage.contains("取消"), true)
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

    @TestCase
    func auditRetainsTaskAndServiceIdentityWithoutCredentials(): Unit {
        let counter = ArrayList<Int64>(); counter.add(0)
        let server = startServer(line("{\"id\":\"response-1\",\"model\":\"service-model\",\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}") + "data: [DONE]\n\n", 200, counter, false)
        let provider = OpenAiChatProvider(modelCfg(Int64(server.port)))
        let audits = ArrayList<JsonObject>()
        provider.onAudit = Some({ kind: String, payload: JsonObject => audits.add(payload) })
        let ctx = StepContext()
        let user = Message(UserMsg); user.text = "分析 CSV"; ctx.messages.add(user)
        let tool = Message(ToolResultMsg); tool.text = "private-tool-output"; tool.toolCallId = "id"; ctx.messages.add(tool)
        provider.respond(ctx, EventStream())
        @Expect(audits.size, 2)
        @Expect(strOf(audits[0], "latestUser"), "分析 CSV")
        @Expect(intOf(audits[0], "toolResultCount"), 1)
        @Expect(strOf(audits[1], "responseModel"), "service-model")
        @Expect(strOf(audits[1], "responseId"), "response-1")
        @Expect(audits[0].toString().contains("test-key"), false)
        @Expect(audits[0].toString().contains("private-tool-output"), false)
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
