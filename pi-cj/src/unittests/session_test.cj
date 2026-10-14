package pi_cj.unittests

import std.collection.*
import stdx.encoding.json.*
import pi_cj.pi.*
import std.unittest.*
import std.unittest.testmacro.*

@Test
class PiSessionTest {
    @TestCase
    func switchingModeChangesWhichToolsTheModelSees(): Unit {
        let s = PiSession(modeStandard())
        s.register(KbSearchTool())
        s.register(WebSearchTool())
        let p1 = ScriptedProvider([scriptText("好")])
        let st1 = EventStream()
        let o1 = s.ask("你好", p1, st1)
        @Expect(o1.ok, true)
        @Expect(p1.seenTools[0].contains("kb_search"), true)
        @Expect(p1.seenTools[0].contains("web_search"), false)
        @Assert(p1.seenTools[0].contains("只输出一行 JSON"))
        @Expect(s.config.turnId, "t1")

        @Expect(s.switchMode("research"), true)
        let p2 = ScriptedProvider([scriptText("好")])
        let st2 = EventStream()
        s.ask("再查一下", p2, st2)
        @Expect(p2.seenTools[0].contains("web_search"), true)
        @Expect(p2.seenTools[0].contains("kb_search"), true)
        @Expect(s.turns(), 2)
        @Expect(s.config.turnId, "t2")
        // 两轮各留下 user + assistant
        @Expect(s.history.size(), 4)
    }

    @TestCase
    func anUnknownModeIsRejectedAndTheOldOneKeepsWorking(): Unit {
        let s = PiSession()
        @Expect(s.mode.name, "standard")
        @Expect(s.turns(), 0)
        @Expect(s.switchMode("nope"), false)
        @Expect(s.mode.name, "standard")
        @Expect(s.switchMode("plain"), true)
        @Expect(s.mode.name, "plain")
    }

    @TestCase
    func theHostPromptAndTheToolProtocolAreTwoSeparateThings(): Unit {
        let s = PiSession(modePlain())
        s.systemPrompt = "你是 ITN 桌面端的本地助教。"
        s.register(KbSearchTool())
        // 系统提示词只放宿主的角色设定
        @Expect(s.systemText(), "你是 ITN 桌面端的本地助教。")
        // 工具协议段单独一份，由运行时通过 ctx.tools 交给提供方
        @Assert(s.toolsText().contains("只输出一行 JSON"))
        // 极简模式不给工具：协议段里不该出现任何工具名
        @Expect(s.toolsText().contains("kb_search"), false)
    }

    @TestCase
    func anUnavailableToolIsNotInTheProtocolTextEither(): Unit {
        let s = PiSession(modeResearch())
        s.register(WebSearchTool())
        @Assert(s.toolsText().contains("web_search"))
        s.registry.markUnavailable("web_search", "没有配置 Tavily 密钥")
        @Expect(s.toolsText().contains("web_search"), false)
    }
}
