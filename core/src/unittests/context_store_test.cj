package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.pi.*
import itn_desktop_core.pi_app.*
import itn_desktop_core.session.SessionStore
import itn_desktop_core.store.Store

class CaptureContext <: ChatProvider {
    public let seen = ArrayList<Message>()
    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        for (m in ctx.messages) { seen.add(m) }
        let r = ModelReply()
        r.text = "继续回答"
        return r
    }
}

@Test
func hostRestoresToolsAndMoreThanFourTurnsWithoutDuplicatingQuestion(): Unit {
    let dir = freshDir("full-context")
    let host = PiAgent(Store(dir))
    host.askWithProvider(ScriptedProvider([scriptTool("calc", "{\"expr\":\"7*8\"}"), scriptText("56")]), "", "计算", "stable", "off", "")
    var i = 0
    while (i < 6) {
        host.askWithProvider(ScriptedProvider([scriptText("回答")]), "", "问题" + i.toString(), "stable", "off", "")
        i = i + 1
    }
    let p = CaptureContext()
    host.askWithProvider(p, "", "本轮唯一", "stable", "off", "")
    var current = 0
    var results = 0
    var earliest = false
    for (m in p.seen) {
        if (m.text == "本轮唯一") { current = current + 1 }
        if (m.role == ToolResultMsg) { results = results + 1; @Expect(m.text.contains("56"), true) }
        if (m.text == "计算") { earliest = true }
    }
    @Expect(current, 1)
    @Expect(results, 1)
    @Expect(earliest, true)
    @Expect(strOf(taskState(dir, "stable"), "status"), "completed")
    SessionStore(dir).remove("stable")
    @Expect(restoreContext(dir, "stable", "").size, 0)
}

@Test
func checkpointRepairsInterruptedToolsAndMarksRestartedTask(): Unit {
    let dir = freshDir("interrupted-context")
    let s = newSession(dir, dir, "native", "")
    let m = Message(AssistantMsg)
    m.toolCalls.add(ToolCallBlock("original-id", "calc", "{}"))
    s.appendMessage(m)
    checkpointContext(dir, "sid", s)
    let restored = restoreContext(dir, "sid", "")
    @Expect(restored.size, 2)
    @Expect(restored[1].toolCallId, "original-id")
    @Expect(restored[1].isError, true)
    setTaskState(dir, "sid", "old", "running")
    @Expect(strOf(taskState(dir, "sid"), "status"), "interrupted")
    @Expect(sessionHub().reserve("sid", "new"), true)
    @Expect(sessionHub().reserve("sid", "duplicate"), false)
    sessionHub().release("sid")
}
