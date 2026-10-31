package itn_desktop_core.unittests

import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 录制/回放：只固定模型侧，工具不在这一层执行。
 * 断言三件事：记录落盘、回放的事件与 reply 一致、素材不匹配/耗尽时明确失败。
 */
@Test
class RecordReplayTest {
    func context(turn: Int64, text: String): StepContext {
        let ctx = StepContext()
        ctx.model = "scripted"
        ctx.turn = turn
        ctx.tools.add(ToolSpec("echo", "回显", "Echo", "回显文本。",
            "{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}}}", "read"))
        let m = Message(UserMsg)
        m.text = text
        ctx.messages.add(m)
        return ctx
    }

    func textDeltas(stream: EventStream): String {
        let sb = StringBuilder()
        for (e in stream.drain()) {
            if (kindText(e.kind) == "message_update" && e.deltaType() == "text_delta") {
                sb.append(e.delta())
            }
        }
        return sb.toString()
    }

    @TestCase
    func recordingCanBeReplayedWithTheSameToolCallAndText(): Unit {
        let d = freshDir("record-replay")
        let path = d + "/fixture.jsonl"
        let inner = ScriptedProvider([
            scriptTool("echo", "{\"text\":\"你好\"}"),
            scriptText("工具说完了。")
        ])
        let recorder = RecordingProvider(inner, path)
        let s1 = EventStream()
        let r1 = recorder.respond(context(1, "帮我回显"), s1)
        @Expect(r1.toolCalls.size, 1)
        @Expect(r1.toolCalls[0].name, "echo")
        let s2 = EventStream()
        let r2 = recorder.respond(context(2, "继续"), s2)
        @Expect(r2.text, "工具说完了。")
        @Expect(exists(path), true)

        let replay = ReplayProvider(path, true)
        @Expect(replay.available(), 2)
        let rs1 = EventStream()
        let rr1 = replay.respond(context(1, "帮我回显"), rs1)
        @Expect(rr1.toolCalls.size, 1)
        @Expect(rr1.toolCalls[0].name, "echo")
        @Expect(rr1.toolCalls[0].argsJson, "{\"text\":\"你好\"}")
        @Expect(rs1.count > 0, true)
        let rs2 = EventStream()
        let rr2 = replay.respond(context(2, "继续"), rs2)
        @Expect(rr2.text, "工具说完了。")
        @Expect(textDeltas(rs2).contains("工具说完了。"), true)
    }

    @TestCase
    func strictReplayRejectsAMismatchedTurn(): Unit {
        let d = freshDir("record-replay-mismatch")
        let path = d + "/fixture.jsonl"
        let recorder = RecordingProvider(ScriptedProvider([scriptText("第一段")]), path)
        recorder.respond(context(1, "问题"), EventStream())
        let replay = ReplayProvider(path, true)
        let reply = replay.respond(context(9, "另一个问题"), EventStream())
        @Expect(reply.stopReason, "error")
        @Expect(reply.errorMessage.contains("轮次不匹配"), true)
    }

    @TestCase
    func exhaustedReplayFailsLoudly(): Unit {
        let d = freshDir("record-replay-empty")
        let path = d + "/fixture.jsonl"
        let replay = ReplayProvider(path, false)
        let reply = replay.respond(context(1, "问题"), EventStream())
        @Expect(reply.stopReason, "error")
        @Expect(reply.errorMessage.contains("回放素材不完整"), true)
    }

    @TestCase
    func eventJsonRoundTripsForReplay(): Unit {
        let am = Message(AssistantMsg)
        am.text = "半句"
        let e = evMessageUpdate(deltaTextDelta(), "半句", am)
        let back = eventFromJson(e.toJson())
        @Expect(back.isSome(), true)
        match (back) {
            case Some(x) =>
                @Expect(kindText(x.kind), "message_update")
                @Expect(x.deltaType(), "text_delta")
                @Expect(x.delta(), "半句")
            case None => ()
        }
    }
}
