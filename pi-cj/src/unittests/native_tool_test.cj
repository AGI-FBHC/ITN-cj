package pi_cj.unittests

import std.collection.*
import stdx.encoding.json.*
import pi_cj.pi.*
import pi_cj.tools.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 原生 function calling 的接线。
 *
 * 这一组守的是"工具结果到底有没有送到模型眼前"这件事 —— 第一版只回灌了一行 summary，
 * 模型看到"共 2 项"却看不到是哪 2 项，于是反复瞎试到撞上限（实测 6 轮没答出来）。
 */
@Test
class NativeToolCallTest {
    @TestCase
    func parallelToolCallsInOneStepAreAllExecutedAndAnswered(): Unit {
        let ws = Workspace("target/test-ws-parallel")
        @Assert(ws.writeText("note.md", "一段内容"))
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        let hist = History()
        let stream = EventStream()
        let runner = PiRunner(reg, hist, NativeTwoCallProvider())
        let cfg = RunConfig()
        cfg.maxSteps = 4
        let out = runner.run("看看有什么并算个 1+1", modeStandard(), cfg, stream)
        @Expect(out.ok, true)
        @Expect(out.text, "两件事都做了")
        @Expect(out.toolResults.size, 2)
        @Expect(out.steps, 2)
        // user / assistant(一条消息里两个 tool_calls) / tool / tool / assistant
        @Expect(hist.size(), 5)
        let m1 = objOf(hist.view()[1]).getOrThrow()
        let calls = arrOf(m1.get("tool_calls").getOrThrow()).getOrThrow()
        @Expect(calls.size(), 2)
        @Expect(strOf(objOf(calls[0]).getOrThrow(), "id"), "call_a")
        @Expect(strOf(objOf(calls[1]).getOrThrow(), "id"), "call_b")
        @Expect(strOf(objOf(hist.view()[2]).getOrThrow(), "tool_call_id"), "call_a")
        @Expect(strOf(objOf(hist.view()[3]).getOrThrow(), "tool_call_id"), "call_b")
        // 第一条结果带文件列表，第二条带算式结果 —— 两条都得有内容
        @Assert(strOf(objOf(hist.view()[2]).getOrThrow(), "content").contains("note.md"))
        @Assert(strOf(objOf(hist.view()[3]).getOrThrow(), "content").contains("2.000000"))
        let kinds = kindsOf(stream.drain())
        @Expect(countOf(kinds, "tool/result"), 2)
        @Expect(countOf(kinds, "step/start"), 2)
        @Expect(countOf(kinds, "step/end"), 2)
    }

    @TestCase
    func toolCallIdsGoBackToTheServerInOpenAiShape(): Unit {
        let reg = ToolRegistry()
        reg.add(FakeListTool())
        let hist = History()
        let stream = EventStream()
        let provider = NativeToolProvider("list_files", "{\"path\": \"\"}")
        let runner = PiRunner(reg, hist, provider)
        let cfg = RunConfig()
        cfg.maxSteps = 4
        let out = runner.run("看看有什么", modeStandard(), cfg, stream)
        @Expect(out.ok, true)
        @Expect(out.text, "做完了")
        // user / assistant(tool_calls) / tool(tool_call_id) / assistant(最终)
        @Expect(hist.size(), 4)

        let msgs = hist.view()
        let m1 = objOf(msgs[1]).getOrThrow()
        @Expect(strOf(m1, "role"), "assistant")
        let calls = arrOf(m1.get("tool_calls").getOrThrow()).getOrThrow()
        @Expect(calls.size(), 1)
        let c0 = objOf(calls[0]).getOrThrow()
        @Expect(strOf(c0, "id"), "call_test01")
        @Expect(strOf(c0, "type"), "function")
        let fn = objOf(c0.get("function").getOrThrow()).getOrThrow()
        @Expect(strOf(fn, "name"), "list_files")
        @Expect(strOf(fn, "arguments"), "{\"path\":\"\"}")

        let m2 = objOf(msgs[2]).getOrThrow()
        @Expect(strOf(m2, "role"), "tool")
        @Expect(strOf(m2, "tool_call_id"), "call_test01")
    }

    @TestCase
    func theModelGetsTheToolContentNotJustTheOneLineSummary(): Unit {
        let reg = ToolRegistry()
        reg.add(FakeListTool())
        let hist = History()
        let provider = NativeToolProvider("list_files", "{\"path\": \"\"}")
        let runner = PiRunner(reg, hist, provider)
        let cfg = RunConfig()
        cfg.maxSteps = 4
        runner.run("看看有什么", modeStandard(), cfg, EventStream())
        let fed = strOf(objOf(hist.view()[2]).getOrThrow(), "content")
        @Assert(fed.contains("note.md"))
        @Assert(fed.contains("src/"))
    }

    @TestCase
    func theToolResultEventCarriesTheCallId(): Unit {
        let reg = ToolRegistry()
        reg.add(FakeListTool())
        let stream = EventStream()
        let provider = NativeToolProvider("list_files", "{\"path\": \"\"}")
        let runner = PiRunner(reg, History(), provider)
        let cfg = RunConfig()
        cfg.maxSteps = 4
        let out = runner.run("看看有什么", modeStandard(), cfg, stream)
        @Expect(strOf(out.toolResults[0], "callId"), "call_test01")
        var found = false
        for (e in stream.drain()) {
            if (kindText(e.kind) == "tool/result" && e.callId == "call_test01") {
                found = true
            }
        }
        @Expect(found, true)
    }

    @TestCase
    func modelTextPrefersContentThenFlattensDataThenFallsBackToSummary(): Unit {
        @Expect(ToolResult.goodWith("一行说明", "真正的正文", JsonNull()).modelText(), "真正的正文")
        let arr = JsonArray()
        arr.add(JsonString("第一行"))
        arr.add(JsonString("第二行"))
        @Expect(ToolResult.good("一行说明", arr).modelText(), "第一行\n第二行")
        @Expect(ToolResult.good("只有一行说明", JsonNull()).modelText(), "只有一行说明")
        @Expect(ToolResult.bad("失败了：缺少参数").modelText(), "失败了：缺少参数")
        // 数组里混着对象/数字时不瞎摊，只摊字符串
        let mixed = JsonArray()
        mixed.add(JsonString("文本"))
        mixed.add(JsonInt(3))
        @Expect(flattenJson(mixed), "文本")
    }

    @TestCase
    func aHugeToolResultIsCappedByBytesWithoutSplittingACharacter(): Unit {
        let sb = StringBuilder()
        var i = 0
        while (i < 4000) {
            sb.append("中文一行内容\n")
            i = i + 1
        }
        let r = ToolResult.goodWith("一行", sb.toString(), JsonNull())
        let fed = r.modelText()
        @Assert(fed.size <= 8000)
        @Assert(fed.size > 7000)
        // 不能切出半个汉字：字节安全截断后再解码必须还是原串的前缀
        @Assert(isPrefix(fed, sb.toString()))
    }

    @TestCase
    func theProviderAlsoSeesTheStructuredToolSpecs(): Unit {
        let reg = ToolRegistry()
        reg.add(FakeListTool())
        let provider = NativeToolProvider("list_files", "{\"path\": \"\"}")
        let runner = PiRunner(reg, History(), provider)
        let cfg = RunConfig()
        cfg.maxSteps = 3
        runner.run("看看", modeStandard(), cfg, EventStream())
        @Expect(provider.seenSpecCounts[0], 1)
        @Expect(provider.seenSpecCounts[1], 1)
        // 提示词协议那份文本照样给（服务端不支持原生工具时要用它）
        @Assert(provider.seenToolsText[0].contains("只输出一行 JSON"))
    }

    @TestCase
    func aModeCanForbidTheToolTheModelAsksFor(): Unit {
        let reg = ToolRegistry()
        reg.add(FakeListTool())
        let hist = History()
        let provider = NativeToolProvider("list_files", "{\"path\": \"\"}")
        let runner = PiRunner(reg, hist, provider)
        let cfg = RunConfig()
        cfg.maxSteps = 4
        let out = runner.run("看看", modePlain(), cfg, EventStream())
        @Expect(out.ok, true)
        @Expect(boolOf(out.toolResults[0], "ok"), false)
        @Assert(strOf(objOf(hist.view()[2]).getOrThrow(), "content").contains("极简"))
    }
}
