package itn_desktop_core.runtime_host_thinking_tests

import std.unittest.*
import std.unittest.testmacro.*
import std.collection.*
import std.fs.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*
import itn_desktop_core.runtime_host.LuminAgent
import itn_desktop_core.runtime_host.sessionHub
import itn_desktop_core.store.Store
import itn_desktop_core.session.SessionStore

func jsonObjOf(v: ?JsonValue): JsonObject {
    match (v) {
        case Some(value) => match (value) {
            case o: JsonObject => return o
            case _ => return JsonObject()
        }
        case None => return JsonObject()
    }
}

var thinkingDirSeq: Int64 = 0

func freshDir(name: String): String {
    thinkingDirSeq += 1
    let dir = "target/ut/" + name + "-" + DateTime.now().toUnixTimeStamp().toMilliseconds().toString() +
        "-" + thinkingDirSeq.toString()
    Directory.create(dir, recursive: true)
    return dir
}

func hasSubseq(kinds: ArrayList<String>, sequence: Array<String>): Bool {
    var i: Int64 = 0
    for (kind in kinds) {
        if (i < sequence.size && kind == sequence[i]) { i += 1 }
    }
    return i == sequence.size
}

func hostThinkingEvents(dir: String, sid: String, kind: String): ArrayList<JsonObject> {
    let found = ArrayList<JsonObject>()
    for (e in SessionStore(dir).events(sid)) {
        if (strOf(e, "type") == kind) { found.add(jsonObjOf(e.get("payload"))) }
    }
    return found
}

func hostThinkingText(events: ArrayList<JsonObject>): String {
    let text = StringBuilder()
    for (e in events) { text.append(strOf(e, "text")) }
    return text.toString()
}

/** Read persisted events inside respond(), before the provider returns or emits any answer. */
class HostThinkingProbe <: ChatProvider {
    let dir: String
    let sid: String
    let mode: String
    public var firstLive = ""
    public var laterLive = ""
    public var earlyFinalCount: Int64 = -1
    public var expected = ""
    public var elapsed: Int64 = 0

    public init(dir: String, sid: String, mode: String) {
        this.dir = dir; this.sid = sid; this.mode = mode
    }

    func emit(stream: EventStream, text: String): Unit {
        expected += text
        stream.push(evMessageUpdate(deltaThinkingDelta(), text, Message(AssistantMsg)))
    }

    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        let reply = ModelReply()
        let started = DateTime.now()
        emit(stream, "先理解问题🧠。")
        firstLive = hostThinkingText(hostThinkingEvents(dir, sid, "assistant/thinking_delta"))
        earlyFinalCount = hostThinkingEvents(dir, sid, "assistant/thinking").size
        if (mode == "timed") {
            sleep(Duration.millisecond * 180)
            emit(stream, "再核对中文与边界。")
            laterLive = hostThinkingText(hostThinkingEvents(dir, sid, "assistant/thinking_delta"))
        } else if (mode == "long") {
            for (_ in 0..2000) { emit(stream, "中文🙂") }
        } else if (mode == "boundaries") {
            stream.push(evMessageUpdate(deltaThinkingEnd(), "", Message(AssistantMsg)))
            stream.push(evMessageUpdate(deltaThinkingEnd(), "", Message(AssistantMsg)))
            emit(stream, "第二段独立思考。")
            stream.push(evMessageUpdate(deltaTextDelta(), "过渡正文。", Message(AssistantMsg)))
            emit(stream, "正文之后再次思考。")
        } else {
            emit(stream, "仍在缓冲的最后片段。")
        }
        reply.thinking = expected
        elapsed = (DateTime.now() - started).toMilliseconds()
        if (mode == "throw" || mode == "cancel") {
            if (mode == "cancel") { sessionHub().abort(sid) }
            throw Exception(if (mode == "cancel") { "已取消" } else { "测试流意外断开" })
        }
        if (mode == "error") {
            reply.stopReason = "error"
            reply.errorMessage = "测试上游中途报错"
            return reply
        }
        if (mode != "thinking-only") {
            reply.text = "最终回答。"
            stream.push(evMessageUpdate(deltaTextDelta(), reply.text, Message(AssistantMsg)))
        }
        return reply
    }
}

/** A genuine tool round trip must retain provider reasoning in the next request. */
class HostThinkingToolProbe <: ChatProvider {
    public var calls: Int64 = 0
    public var reasoningReturned = ""

    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        calls += 1
        let reply = ModelReply()
        reply.thinking = if (calls == 1) { "先算出结果。" } else { "核对工具返回。" }
        stream.push(evMessageUpdate(deltaThinkingDelta(), reply.thinking, Message(AssistantMsg)))
        if (calls == 1) {
            let call = ToolCallBlock("thinking-calc", "calc", "{\"expr\":\"7*8\"}")
            reply.toolCalls.add(call)
            reply.stopReason = "toolUse"
            let partial = Message(AssistantMsg)
            partial.toolCalls.add(call)
            stream.push(evMessageUpdate(deltaToolCallStart(), "", partial))
            stream.push(evMessageUpdate(deltaToolCallDelta(), call.argsJson, partial))
        } else {
            for (m in ctx.messages) {
                if (m.role == AssistantMsg && m.hasToolCalls()) { reasoningReturned = m.thinking }
            }
            reply.text = "56"
            stream.push(evMessageUpdate(deltaTextDelta(), reply.text, Message(AssistantMsg)))
        }
        return reply
    }
}

@Test
class ThinkingStreamTest {
    func runProbe(mode: String): (String, String, HostThinkingProbe, JsonObject) {
        let dir = freshDir("host-thinking-" + mode)
        let sid = "thinking-" + mode + "-" + SessionStore(dir).newId()
        let provider = HostThinkingProbe(dir, sid, mode)
        let result = LuminAgent(Store(dir)).askWithProvider(provider, "", "请分析", sid, "off", "")
        return (dir, sid, provider, result)
    }

    func expectComplete(dir: String, sid: String, expected: String): Unit {
        let deltas = hostThinkingEvents(dir, sid, "assistant/thinking_delta")
        let finals = hostThinkingEvents(dir, sid, "assistant/thinking")
        @Expect(deltas.size > 0, true)
        @Expect(finals.size, 1)
        // Compare as Bool: the SDK's long-string diff printer can itself split UTF-8 on a failure.
        @Expect(hostThinkingText(deltas) == expected, true)
        @Expect(hostThinkingText(finals) == expected, true)
        var segmentId = ""
        var previousMs: Int64 = 0
        for (e in deltas) {
            let id = strOf(e, "segmentId")
            @Expect(id.size > 0, true)
            if (segmentId.size == 0) { segmentId = id }
            @Expect(id, segmentId)
            @Expect(intOf(e, "ms") >= previousMs, true)
            previousMs = intOf(e, "ms")
            let text = strOf(e, "text")
            @Expect(text.size > 0, true)
            @Expect(String.fromUtf8(text.toArray()), text)
        }
        for (e in finals) {
            @Expect(strOf(e, "segmentId"), segmentId)
            @Expect(intOf(e, "ms") >= previousMs, true)
        }
        let kinds = ArrayList<String>()
        for (e in SessionStore(dir).events(sid)) { kinds.add(strOf(e, "type")) }
        @Expect(hasSubseq(kinds, ["assistant/thinking_delta", "assistant/thinking", "turn/end"]), true)
        @Expect(sessionHub().activeTurn(sid), "")
    }

    @TestCase
    func textIsPersistedWhileProviderIsStillThinking(): Unit {
        let (dir, sid, provider, result) = runProbe("timed")
        @Expect(boolOf(result, "ok", false), true)
        @Expect(provider.firstLive, "先理解问题🧠。")
        @Expect(provider.earlyFinalCount, 0)
        @Expect(provider.laterLive, provider.expected)
        expectComplete(dir, sid, provider.expected)
        for (e in hostThinkingEvents(dir, sid, "assistant/thinking")) {
            @Expect(intOf(e, "ms") >= 150, true)
            @Expect(intOf(e, "ms") < provider.elapsed + 250, true)
        }
    }

    @TestCase
    func tinyChineseChunksAreBatchedWithoutTruncatingLongThinking(): Unit {
        let (dir, sid, provider, result) = runProbe("long")
        @Expect(boolOf(result, "ok", false), true)
        @Expect(provider.expected.size > 6000, true)
        expectComplete(dir, sid, provider.expected)
        // 2001 provider deltas must not create 2001 SQLite event writes.
        @Expect(hostThinkingEvents(dir, sid, "assistant/thinking_delta").size < 120, true)
    }

    @TestCase
    func toolRoundTripKeepsSeparateIdsAndProviderReasoning(): Unit {
        let dir = freshDir("host-thinking-tools")
        let sid = "thinking-tools-" + SessionStore(dir).newId()
        let provider = HostThinkingToolProbe()
        let result = LuminAgent(Store(dir)).askWithProvider(provider, "", "计算7*8", sid, "off", "")
        @Expect(boolOf(result, "ok", false), true)
        @Expect(strOf(result, "answer"), "56")
        @Expect(provider.calls, 2)
        @Expect(provider.reasoningReturned, "先算出结果。")
        let finals = hostThinkingEvents(dir, sid, "assistant/thinking")
        @Expect(finals.size, 2)
        let ids = HashSet<String>()
        for (e in finals) { ids.add(strOf(e, "segmentId")) }
        @Expect(ids.size, 2)
        @Expect(ids.contains(""), false)
        let kinds = ArrayList<String>()
        for (e in SessionStore(dir).events(sid)) { kinds.add(strOf(e, "type")) }
        @Expect(hasSubseq(kinds, ["assistant/thinking_delta", "assistant/thinking", "tool/call",
            "tool/result", "assistant/thinking_delta", "assistant/thinking", "assistant/delta"]), true)
    }

    @TestCase
    func explicitEndAndBodyBoundariesCloseEachSegmentOnlyOnce(): Unit {
        let (dir, sid, _, result) = runProbe("boundaries")
        @Expect(boolOf(result, "ok", false), true)
        let finals = hostThinkingEvents(dir, sid, "assistant/thinking")
        @Expect(finals.size, 3)
        let ids = HashSet<String>()
        for (e in finals) { ids.add(strOf(e, "segmentId")) }
        @Expect(ids.size, 3)
        @Expect(ids.contains(""), false)
        @Expect(hostThinkingText(finals), "先理解问题🧠。第二段独立思考。正文之后再次思考。")
        for (final in finals) {
            let pieces = ArrayList<JsonObject>()
            for (e in hostThinkingEvents(dir, sid, "assistant/thinking_delta")) {
                if (strOf(e, "segmentId") == strOf(final, "segmentId")) { pieces.add(e) }
            }
            @Expect(hostThinkingText(pieces), strOf(final, "text"))
        }
    }

    @TestCase
    func returnedProviderErrorKeepsLastBufferedThinking(): Unit {
        let (dir, sid, provider, result) = runProbe("error")
        @Expect(boolOf(result, "ok", true), false)
        @Expect(strOf(result, "message"), "测试上游中途报错")
        expectComplete(dir, sid, provider.expected)
    }

    @TestCase
    func unexpectedProviderExceptionStillFinalizesThinking(): Unit {
        let (dir, sid, provider, result) = runProbe("throw")
        @Expect(boolOf(result, "ok", true), false)
        @Expect(strOf(result, "message"), "测试流意外断开")
        expectComplete(dir, sid, provider.expected)
    }

    @TestCase
    func cancellationKeepsLastBufferedThinkingBeforeTurnEnd(): Unit {
        let (dir, sid, provider, result) = runProbe("cancel")
        @Expect(boolOf(result, "ok", true), false)
        @Expect(strOf(result, "message"), "已取消")
        expectComplete(dir, sid, provider.expected)
    }

    @TestCase
    func thinkingOnlyReplyClosesAtMessageEnd(): Unit {
        let (dir, sid, provider, _) = runProbe("thinking-only")
        expectComplete(dir, sid, provider.expected)
    }

    @TestCase
    func legacyProviderWithoutThinkingHasNoNewThinkingEvents(): Unit {
        let dir = freshDir("host-thinking-legacy")
        let result = LuminAgent(Store(dir)).askWithProvider(ScriptedProvider([scriptText("普通回答")]),
            "", "你好", "", "off", "")
        let sid = strOf(result, "sessionId")
        @Expect(boolOf(result, "ok", false), true)
        @Expect(strOf(result, "answer"), "普通回答")
        @Expect(hostThinkingEvents(dir, sid, "assistant/thinking_delta").size, 0)
        @Expect(hostThinkingEvents(dir, sid, "assistant/thinking").size, 0)
    }
}
