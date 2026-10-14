package pi_cj.unittests

import std.collection.*
import stdx.encoding.json.*
import pi_cj.pi.*
import std.unittest.*
import std.unittest.testmacro.*

/* 边界与类型：解析出来的参数要能直接当 JSON 用（数组/布尔/数字/null 都得还原成原类型）。 */
@Test
class PartialJsonEdgeTest {
    @TestCase
    func scalarArgumentsKeepTheirJsonTypes(): Unit {
        let p = PartialJsonParser()
        p.push("{\"tool\":\"save_note\",\"args\":{\"ids\":[1,2,3],\"flag\":true,\"ratio\":1.5,\"empty\":null,\"n\":3}}")
        let args = p.view().argsJson()
        @Expect(arrOf(args.get("ids").getOrThrow()).getOrThrow().size(), 3)
        @Expect(boolOf(args, "flag"), true)
        @Expect(intOf(args, "n"), 3)
        @Expect(p.view().valueOf("ids"), "[1,2,3]")
        @Expect(p.view().valueOf("flag"), "true")
        @Expect(p.isComplete(), true)
    }

    @TestCase
    func aStringArgumentWithEscapedQuotesRoundTripsThroughJson(): Unit {
        let p = PartialJsonParser()
        p.push("{\"tool\":\"save_note\",\"args\":{\"title\":\"他说\\\"你好\\\"\"}}")
        @Expect(p.view().valueOf("title"), "他说\"你好\"")
        @Expect(strOf(p.view().argsJson(), "title"), "他说\"你好\"")
    }

    @TestCase
    func aNestedObjectArgumentRoundTripsThroughJson(): Unit {
        let p = PartialJsonParser()
        p.push("{\"tool\":\"x\",\"args\":{\"meta\":{\"tags\":[\"a\"],\"n\":2}}}")
        let meta = objOf(p.view().argsJson().get("meta").getOrThrow()).getOrThrow()
        @Expect(intOf(meta, "n"), 2)
        @Expect(arrOf(meta.get("tags").getOrThrow()).getOrThrow().size(), 1)
    }

    @TestCase
    func safeUtf8SurvivesHostileRanges(): Unit {
        let b = "提示词".toArray()
        @Expect(safeUtf8(b, 0, 0), "")
        @Expect(safeUtf8(b, 5, 2), "")
        @Expect(safeUtf8(b, -3, 2), "")
        @Expect(safeUtf8(b, 0, 3), "提")
        @Expect(safeUtf8(b, 0, 999), "提示词")
        @Expect(safeUtf8(b, 100, 200), "")
    }

    @TestCase
    func theProtocolTextIsTheSameOneTheHostUses(): Unit {
        @Assert(piVersion().contains("pi-cj"))
        let reg = ToolRegistry()
        addFake(reg, "kb_search", "read")
        let t = toolProtocolText(reg, modeStandard())
        @Assert(t.contains("kb_search"))
        @Assert(t.contains("只输出一行 JSON"))
        @Assert(t.contains("{\"tool\":\"工具名\",\"args\":{...}}"))
        // 模式不给工具时，协议段里只剩调用格式说明，没有工具清单
        @Expect(toolProtocolText(reg, modePlain()).contains("kb_search"), false)
    }

    @TestCase
    func booleanFalseAndZeroAreNotTreatedAsMissingValues(): Unit {
        let p = PartialJsonParser()
        p.push("{\"tool\":\"x\",\"args\":{\"flag\":false,\"n\":0,\"s\":\"\"}}")
        @Expect(p.view().valueOf("flag"), "false")
        @Expect(p.view().valueOf("n"), "0")
        @Expect(p.view().valueOf("s"), "")
        @Expect(p.view().hasKey("s"), true)
        @Expect(p.view().hasKey("nope"), false)
        @Expect(p.view().argsJson().size(), 3)
    }
}
