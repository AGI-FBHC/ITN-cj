package pi_cj.unittests

import std.collection.*
import stdx.encoding.json.*
import pi_cj.pi.*
import std.unittest.*
import std.unittest.testmacro.*

/* 模式 = 工具集的白名单；注册表负责"能不能调、调得起来吗"。 */
@Test
class ModeAndToolTest {
    @TestCase
    func plainModeShowsNothingAndExecutesNothing(): Unit {
        let reg = ToolRegistry()
        addFake(reg, "kb_search", "read")
        @Expect(modePlain().toolCount(), 0)
        @Expect(reg.promptText(modePlain()), "")
        @Expect(reg.specsOf(modePlain()).size, 0)
        let r = reg.execute(modePlain(), "kb_search", JsonObject())
        @Expect(r.ok, false)
        @Assert(r.summary.contains("极简"))
    }

    @TestCase
    func standardHidesExternalToolsAndResearchShowsThem(): Unit {
        let reg = ToolRegistry()
        addFake(reg, "kb_search", "read")
        addFake(reg, "save_note", "write")
        addFake(reg, "web_search", "external")
        @Expect(reg.promptText(modeStandard()).contains("kb_search"), true)
        @Expect(reg.promptText(modeStandard()).contains("save_note"), true)
        @Expect(reg.promptText(modeStandard()).contains("web_search"), false)
        @Expect(reg.promptText(modeResearch()).contains("web_search"), true)
        @Expect(reg.isExternal("web_search"), true)
        @Expect(reg.isExternal("kb_search"), false)
        @Expect(reg.size(), 3)
        @Expect(reg.names().size, 3)
    }

    @TestCase
    func researchModeExecutesTheExternalToolOnceItIsAllowed(): Unit {
        let reg = ToolRegistry()
        addFake(reg, "web_search", "external")
        @Expect(reg.execute(modeResearch(), "web_search", JsonObject()).ok, true)
        @Expect(reg.execute(modeStandard(), "web_search", JsonObject()).ok, false)
    }

    @TestCase
    func anUnavailableToolIsNeitherAdvertisedNorRunnable(): Unit {
        let reg = ToolRegistry()
        addFake(reg, "web_search", "external")
        reg.markUnavailable("web_search", "没有配置 Tavily 密钥")
        @Expect(reg.available("web_search"), false)
        @Expect(reg.promptText(modeResearch()).contains("web_search"), false)
        let r = reg.execute(modeResearch(), "web_search", JsonObject())
        @Expect(r.ok, false)
        @Assert(r.summary.contains("Tavily"))
        // 重新"可用"的逻辑不存在（宿主每次重建注册表），但要保证别的工具不受影响
        @Expect(reg.available("kb_search"), true)
    }

    @TestCase
    func anUnknownToolIsAFailedResultNotAnException(): Unit {
        let reg = ToolRegistry()
        addFake(reg, "kb_search", "read")
        let r = reg.execute(modeStandard(), "nope", JsonObject())
        @Expect(r.ok, false)
        @Assert(r.summary.contains("nope"))
    }

    @TestCase
    func aToolThatThrowsBecomesAFailedResult(): Unit {
        let reg = ToolRegistry()
        reg.add(BoomTool())
        let r = reg.execute(onlyMode("boom"), "boom", JsonObject())
        @Expect(r.ok, false)
        @Assert(r.summary.contains("boom"))
    }

    @TestCase
    func aModeOnlyFiltersNamesItDoesNotCheckExistence(): Unit {
        let m = onlyMode("not_registered_yet")
        @Expect(m.allows("not_registered_yet"), true)
        @Expect(m.toolCount(), 1)
        @Expect(findMode("research").getOrThrow().allows("web_search"), true)
        @Expect(findMode("plain").getOrThrow().allows("web_search"), false)
    }

    @TestCase
    func builtinModesAreTheThreeTheUiExpects(): Unit {
        let ms = builtinModes()
        @Expect(ms.size, 3)
        @Expect(ms[0].name, "plain")
        @Expect(ms[1].name, "standard")
        @Expect(ms[2].name, "research")
        @Expect(findMode("standard").getOrThrow().title, "标准")
        match (findMode("nope")) {
            case Some(_) => @Fail("不该找到 nope 这个模式")
            case None => ()
        }
    }

    @TestCase
    func toolSpecSerializesWhatTheUiNeeds(): Unit {
        let s = ToolSpec("kb_search", "检索知识库", "{\"query\":\"x\"}", "按关键词检索", "read")
        @Expect(s.promptLine(), "- kb_search：按关键词检索 参数示例 {\"query\":\"x\"}")
        let j = s.toJson()
        @Expect(strOf(j, "name"), "kb_search")
        @Expect(strOf(j, "risk"), "read")
        @Expect(strOf(j, "title"), "检索知识库")
    }
}
