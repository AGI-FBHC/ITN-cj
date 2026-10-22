package itn_desktop_core.unittests

import std.collection.*
import std.time.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import stdx.net.http.*
import itn_desktop_core.runtime.*
import itn_desktop_core.runtime_host.restoreContext
import itn_desktop_core.model_provider.OpenAiChatProvider
import itn_desktop_core.store.ModelConfig
import itn_desktop_core.db.DbHub
import itn_desktop_core.util.readAllString

@Test
class ToolContextTest {
    func ordered(messages: ArrayList<Message>): Bool {
        let pending = HashSet<String>()
        for (m in messages) {
            if (m.role == ToolResultMsg) {
                if (!pending.contains(m.toolCallId)) { return false }
                pending.remove(m.toolCallId)
            } else {
                if (pending.size > 0) { return false }
                for (c in m.toolCalls) { pending.add(c.id) }
            }
        }
        return pending.size == 0
    }

    func result(id: String, text: String): Message {
        let m = Message(ToolResultMsg)
        m.toolCallId = id; m.toolName = "calc"; m.text = text
        return m
    }

    func persist(dir: String, messages: ArrayList<Message>): String {
        let a = JsonArray()
        for (m in messages) { a.add(m.toJson()) }
        let raw = a.toString()
        DbHub.open(dir).putKv("sessions_meta", "context:test", raw)
        return raw
    }

    @TestCase
    func compactionKeepsTheEntireParallelToolExchange(): Unit {
        for (count in [2i64, 3i64]) {
            let dir = freshDir("parallel-compact-" + count.toString())
            let session = newSession(dir, dir, "native", "")
            let user = Message(UserMsg); user.text = "old task"
            session.appendMessage(user)
            let call = Message(AssistantMsg)
            for (i in 0..count) { call.toolCalls.add(ToolCallBlock("call-" + i.toString(), "calc", "{}")) }
            session.appendMessage(call)
            for (i in 0..count) { session.appendMessage(result("call-" + i.toString(), "result-" + i.toString())) }
            let provider = ScriptedProvider([scriptText("task summary"), scriptText("updated summary")])
            let agent = Agent(provider, session, ToolRegistry(), modeChat(), AgentOptions())
            @Expect(agent.compact(2, EventStream()), true)
            let messages = session.messagesForModel()
            @Expect(ordered(messages), true)
            var results = 0
            for (m in messages) { if (m.role == ToolResultMsg) { results += 1 } }
            @Expect(results, count)
            // Repeated compaction must not move the cut into the retained exchange.
            agent.compact(2, EventStream())
            @Expect(ordered(session.messagesForModel()), true)
        }
    }

    @TestCase
    func legacyOrphanResultsRemainReadableWithoutInvalidToolRoles(): Unit {
        let dir = freshDir("orphan-checkpoint")
        let messages = ArrayList<Message>()
        let summary = Message(UserMsg); summary.text = "earlier task summary"
        messages.add(summary)
        messages.add(result("lost-parent-a", "retained result 56"))
        messages.add(result("lost-parent-b", "retained result 13"))
        let before = persist(dir, messages)
        let restored = restoreContext(dir, "test", "")
        @Expect(ordered(restored), true)
        var retained = 0
        for (m in restored) { if (m.text.contains("retained result")) { retained += 1 } }
        @Expect(retained, 2)
        @Expect(DbHub.open(dir).getKv("sessions_meta", "context:test", ""), before)
    }

    @TestCase
    func interruptedToolResultIsInsertedBeforeTheFollowingUser(): Unit {
        let dir = freshDir("interrupted-tool-order")
        let messages = ArrayList<Message>()
        let call = Message(AssistantMsg); call.toolCalls.add(ToolCallBlock("interrupted", "calc", "{}"))
        let next = Message(UserMsg); next.text = "continue"
        messages.add(call); messages.add(next)
        persist(dir, messages)
        let restored = restoreContext(dir, "test", "")
        @Expect(ordered(restored), true)
        @Expect(restored.size, 3)
        @Expect(restored[1].toolCallId, "interrupted")
        @Expect(restored[1].isError, true)
        @Expect(restored[2].text, "continue")
    }

    @TestCase
    func validParallelResultsKeepTheirOrderAndContents(): Unit {
        let dir = freshDir("valid-tool-pairs")
        let messages = ArrayList<Message>()
        let call = Message(AssistantMsg)
        call.toolCalls.add(ToolCallBlock("a", "calc", "{}"))
        call.toolCalls.add(ToolCallBlock("b", "calc", "{}"))
        messages.add(call); messages.add(result("b", "13")); messages.add(result("a", "56"))
        persist(dir, messages)
        let restored = restoreContext(dir, "test", "")
        @Expect(ordered(restored), true); @Expect(restored.size, messages.size)
        for (i in 0..messages.size) { @Expect(restored[i].toJson().toString(), messages[i].toJson().toString()) }
    }

    @TestCase
    func duplicateResultIsRetainedAsHistoryInsteadOfAnInvalidSecondResponse(): Unit {
        let dir = freshDir("duplicate-tool-result")
        let messages = ArrayList<Message>()
        let call = Message(AssistantMsg); call.toolCalls.add(ToolCallBlock("a", "calc", "{}"))
        messages.add(call); messages.add(result("a", "first result")); messages.add(result("a", "extra record"))
        persist(dir, messages)
        let restored = restoreContext(dir, "test", "")
        @Expect(ordered(restored), true); @Expect(restored.size, 3)
        @Expect(restored[1].role == ToolResultMsg, true)
        @Expect(restored[2].role == AssistantMsg, true)
        @Expect(restored[2].text.contains("extra record"), true)
    }

    @TestCase
    func outgoingPayloadNeverContainsAnOrphanToolMessage(): Unit {
        let server = ServerBuilder().addr("127.0.0.1").port(0).build()
        let valid = [false]
        server.distributor.register("/v1/chat/completions", { ctx: HttpContext =>
            let request = objOf(JsonValue.fromStr(readAllString(ctx.request.body))).getOrThrow()
            let pending = HashSet<String>()
            var ok = true
            match (request.get("messages")) {
                case Some(a: JsonArray) =>
                    var i: Int64 = 0
                    while (i < a.size()) {
                        let m = objOf(a[i]).getOrThrow(); i += 1
                        if (strOf(m, "role") == "tool") {
                            let id = strOf(m, "tool_call_id")
                            if (!pending.contains(id)) { ok = false }
                            pending.remove(id)
                        } else {
                            if (pending.size > 0) { ok = false }
                            match (m.get("tool_calls")) {
                                case Some(calls: JsonArray) =>
                                    var j: Int64 = 0
                                    while (j < calls.size()) { pending.add(strOf(objOf(calls[j]).getOrThrow(), "id")); j += 1 }
                                case _ => ()
                            }
                        }
                    }
                case _ => ok = false
            }
            valid[0] = ok && pending.size == 0
            if (!valid[0]) { ctx.responseBuilder.status(400); ctx.responseBuilder.body("orphan tool message".toArray()); return }
            ctx.responseBuilder.status(200)
            ctx.responseBuilder.header("Content-Type", "text/event-stream")
            ctx.responseBuilder.body("data: {\"choices\":[{\"delta\":{\"content\":\"recovered\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".toArray())
        })
        spawn { server.serve() }; sleep(Duration.millisecond * 100)
        try {
            let cfg = ModelConfig(); cfg.baseUrl = "http://127.0.0.1:" + server.port.toString() + "/v1"; cfg.model = "test"
            let context = StepContext(); context.messages.add(result("missing-parent", "previous result"))
            let reply = OpenAiChatProvider(cfg).respond(context, EventStream())
            @Expect(valid[0], true); @Expect(reply.stopReason, "stop"); @Expect(reply.text, "recovered")
        } finally { server.close() }
    }
}
