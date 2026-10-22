package itn_desktop_core.unittests

import std.collection.*
import std.sync.*
import std.time.*
import stdx.encoding.json.*
import std.unittest.*
import std.unittest.testmacro.*
import itn_desktop_core.runtime.*

class GateConcurrency {
    let lock = Mutex()
    var active: Int64 = 0
    var peak: Int64 = 0
    public func enter(): Unit { synchronized(lock) { active += 1; if (active > peak) { peak = active } } }
    public func leave(): Unit { synchronized(lock) { active -= 1 } }
}

@Test
func parallelToolsSerializePermissionAndAuditHooks(): Unit {
    let dir = freshDir("parallel-permission")
    let session = newSession(dir, dir, "audit", "")
    let reg = ToolRegistry()
    reg.add(FuncTool(ToolSpec("twice", "回显", "Echo", "Echo", "{}", "read"),
        { callId: String, args: JsonObject => ToolResult.ok(callId, callId, JsonNull()) }))
    let gate = GateConcurrency()
    let opts = AgentOptions()
    opts.toolExecution = "parallel"
    opts.beforeToolCall = Some({ callId: String, name: String, args: JsonObject =>
        gate.enter()
        sleep(Duration.millisecond * 50)
        session.appendCustom("approval", args)
        gate.leave()
        ""
    })
    let agent = Agent(TwoCallProvider(), session, reg, onlyMode("twice"), opts)
    let result = agent.prompt("分析这份 CSV", EventStream())
    @Expect(result.ok, true)
    @Expect(gate.peak, 1)
    let messages = session.messagesForModel()
    @Expect(messages.size, 5)
    @Expect(messages[0].text, "分析这份 CSV")
    @Expect(messages[2].toolCallId, "call_a")
    @Expect(messages[3].toolCallId, "call_b")
}
