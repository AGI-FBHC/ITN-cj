package itn_desktop_core.unittests

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 宿主可观测性：压缩不能静默。成功与失败都要回调前后大小和原因。
 */
@Test
class AgentObservabilityTest {
    func sessionWithHistory(name: String): Session {
        let d = freshDir(name)
        let s = newSession(d, "cwd", "", "")
        let u1 = Message(UserMsg); u1.text = "第一问：什么是 RAG？"; s.appendMessage(u1)
        let a1 = Message(AssistantMsg); a1.text = "第一答：检索增强生成。"; s.appendMessage(a1)
        let u2 = Message(UserMsg); u2.text = "第二问：它有什么局限？"; s.appendMessage(u2)
        let a2 = Message(AssistantMsg); a2.text = "第二答：召回质量决定上限。"; s.appendMessage(a2)
        return s
    }

    @TestCase
    func successfulCompactionReportsBeforeAndAfter(): Unit {
        let s = sessionWithHistory("compact-report")
        let reports = ArrayList<JsonObject>()
        let opts = AgentOptions()
        opts.onCompact = Some({ p: JsonObject => reports.add(p) })
        let agent = Agent(ScriptedProvider([scriptText("这是摘要")]), s, ToolRegistry(), onlyMode("none"), opts)
        let ok = agent.compact(2, EventStream())
        @Expect(ok, true)
        @Expect(reports.size, 1)
        @Expect(boolOf(reports[0], "ok", false), true)
        @Expect(intOf(reports[0], "beforeBytes") > 0, true)
        @Expect(strOf(reports[0], "note").contains("已压缩"), true)
        @Expect(agent.compactCount, 1)
    }

    @TestCase
    func failedCompactionIsReportedNotSwallowed(): Unit {
        let s = sessionWithHistory("compact-fail-report")
        let reports = ArrayList<JsonObject>()
        let opts = AgentOptions()
        opts.onCompact = Some({ p: JsonObject => reports.add(p) })
        let bad = ScriptStep("")
        bad.failWith = "模拟压缩失败"
        let agent = Agent(ScriptedProvider([bad]), s, ToolRegistry(), onlyMode("none"), opts)
        let ok = agent.compact(2, EventStream())
        @Expect(ok, false)
        @Expect(reports.size, 1)
        @Expect(boolOf(reports[0], "ok", true), false)
        @Expect(strOf(reports[0], "note").contains("压缩失败"), true)
    }
}
