package itn_desktop_core.unittests

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.pi.*
import std.unittest.*
import std.unittest.testmacro.*

@Test
class EventStreamTest {
    @TestCase
    func pushNotifiesListenersInOrderAndDrainTakesEachEventOnce(): Unit {
        let s = EventStream()
        let seen = ArrayList<String>()
        s.on({ e: PiEvent => seen.add(kindText(e.kind)) })
        s.push(evAgentStart())
        s.push(evTurnStart(1))
        s.push(evAgentEnd("stop", 1))
        @Expect(seen.size, 3)
        @Expect(seen[0], "agent_start")
        @Expect(seen[1], "turn_start")
        @Expect(seen[2], "agent_end")
        @Expect(s.pendingCount(), 3)
        @Expect(s.drain().size, 3)
        @Expect(s.pendingCount(), 0)
        @Expect(s.count, 3)
    }

    @TestCase
    func aListenerRegisteredLaterDoesNotGetOldEvents(): Unit {
        let s = EventStream()
        s.push(evAgentStart())
        let seen = ArrayList<String>()
        s.on({ e: PiEvent => seen.add(kindText(e.kind)) })
        @Expect(seen.size, 0)
        @Expect(s.drain().size, 1)
    }

    @TestCase
    func finishAndFailCarryTheTerminalState(): Unit {
        let ok = EventStream()
        ok.finish("stop")
        @Expect(ok.isFinished(), true)
        @Expect(orEmpty(ok.result()), "stop")
        @Expect(orEmpty(ok.error()), "")
        let bad = EventStream()
        bad.fail("炸了")
        @Expect(bad.isFinished(), true)
        @Expect(orEmpty(bad.error()), "炸了")
    }

    @TestCase
    func abortIsVisibleToTheProducer(): Unit {
        let s = EventStream()
        @Expect(s.aborted(), false)
        s.abort()
        @Expect(s.aborted(), true)
    }

    @TestCase
    func eventsSerializeWithTheSameFieldNamesAsPi(): Unit {
        let u = Message(UserMsg)
        u.text = "你好"
        let e = evMessageStart(u)
        @Expect(strOf(e.toJson(), "type"), "message_start")
        @Expect(strOf(objOf(e.toJson().get("message").getOrThrow()).getOrThrow(), "role"), "user")
        // message_update 里带 assistantEvent（Pi 的 AssistantMessageEvent）
        let am = Message(AssistantMsg)
        am.text = "半"
        let upd = evMessageUpdate(deltaTextDelta(), "半", am)
        @Expect(strOf(upd.toJson(), "type"), "message_update")
        @Expect(upd.deltaType(), "text_delta")
        @Expect(upd.delta(), "半")
        // 工具执行事件用 Pi 的字段名
        let ts = evToolStart("call_1", "read", "{\"path\":\"a\"}")
        @Expect(ts.toolCallId(), "call_1")
        @Expect(ts.toolName(), "read")
        @Expect(strOf(ts.toJson(), "type"), "tool_execution_start")
        let te = evToolEnd("call_1", "read", "读到 a", false, 12)
        @Expect(te.isError(), false)
        @Expect(te.num("durationMs"), 12)
    }

    @TestCase
    func messageJsonCarriesThePiShapeForNativeToolCalls(): Unit {
        let m = Message(AssistantMsg)
        m.text = "我来读一下"
        m.toolCalls.add(ToolCallBlock("call_9", "read", "{\"path\": \"note.md\"}"))
        m.stopReason = "toolUse"
        let chat = m.toChatJson()
        @Expect(strOf(chat, "role"), "assistant")
        let calls = arrOf(chat.get("tool_calls").getOrThrow()).getOrThrow()
        @Expect(calls.size(), 1)
        let c0 = objOf(calls[0]).getOrThrow()
        @Expect(strOf(c0, "id"), "call_9")
        @Expect(strOf(objOf(c0.get("function").getOrThrow()).getOrThrow(), "name"), "read")
        // 会话里存的是 content blocks 的形状
        let stored = m.toJson()
        let blocks = arrOf(stored.get("content").getOrThrow()).getOrThrow()
        @Expect(blocks.size(), 2)
        @Expect(strOf(objOf(blocks[1]).getOrThrow(), "type"), "toolCall")
        @Expect(strOf(stored, "stopReason"), "toolUse")
    }
}
