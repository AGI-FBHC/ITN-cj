package pi_cj.unittests

import std.collection.*
import stdx.encoding.json.*
import pi_cj.pi.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 主循环：turn/step 生命周期、冻结视图、回灌、护栏。
 * 断言都是"看事件序列 + 看结果对象 + 看历史"三件一起验，单看任何一件都容易漏。
 */
@Test
class RunnerTest {
    @TestCase
    func oneToolCallThenFinalAnswerProducesTheWholeEventSequence(): Unit {
        let reg = ToolRegistry()
        let kb = KbSearchTool()
        reg.add(kb)
        let hist = History()
        let provider = ScriptedProvider([
            scriptTool("kb_search", "{\"query\":\"提示词的三要素\"}"),
            scriptText("三要素是角色、任务、格式。")
        ])
        let stream = EventStream()
        let runner = PiRunner(reg, hist, provider)
        let cfg = RunConfig()
        cfg.turnId = "t1"
        cfg.maxSteps = 4
        let out = runner.run("提示词的三要素是什么？", modeStandard(), cfg, stream)

        @Expect(out.ok, true)
        @Expect(out.text, "三要素是角色、任务、格式。")
        @Expect(out.steps, 2)
        @Expect(out.stopReason, "end")
        @Expect(out.toolResults.size, 1)
        @Expect(out.warnings.size, 0)
        @Expect(boolOf(out.toolResults[0], "ok"), true)

        // 历史：user / assistant(调用记录) / tool(结果) / assistant(最终回答)
        @Expect(hist.size(), 4)
        @Expect(hist.roleAt(0), "user")
        @Expect(hist.roleAt(1), "assistant")
        @Expect(hist.roleAt(2), "tool")
        @Expect(hist.roleAt(3), "assistant")
        @Expect(kb.queries.size, 1)
        @Expect(kb.queries[0], "提示词的三要素")

        // 冻结视图：第一步只看得见那条 user；第二步看得见 user + 调用记录 + 工具结果
        @Expect(provider.seenMessageCounts[0], 1)
        @Expect(provider.seenMessageCounts[1], 3)

        let kinds = kindsOf(stream.drain())
        @Expect(kinds[0], "turn/start")
        @Expect(kinds[kinds.size - 1], "turn/end")
        @Expect(countOf(kinds, "step/start"), 2)
        @Expect(countOf(kinds, "step/end"), 2)
        @Expect(countOf(kinds, "tool/call_start"), 1)
        @Expect(countOf(kinds, "tool/call_end"), 1)
        @Expect(countOf(kinds, "tool/result"), 1)
        @Expect(countOf(kinds, "text/delta") > 0, true)
        @Assert(hasSubseq(kinds, ["turn/start", "step/start", "tool/call_start", "tool/call_end",
            "tool/result", "step/end", "step/start", "text/delta", "step/end", "turn/end"]))
        @Expect(orEmpty(stream.result()), "三要素是角色、任务、格式。")
        @Expect(orEmpty(stream.error()), "")
    }

    @TestCase
    func theModelSeesOnlyTheToolsTheModeAllows(): Unit {
        let reg = ToolRegistry()
        reg.add(KbSearchTool())
        reg.add(WebSearchTool())

        let p1 = ScriptedProvider([scriptText("好")])
        let s1 = EventStream()
        let r1 = PiRunner(reg, History(), p1)
        let c1 = RunConfig()
        c1.maxSteps = 2
        r1.run("你好", modeStandard(), c1, s1)
        @Expect(p1.seenTools[0].contains("kb_search"), true)
        @Expect(p1.seenTools[0].contains("web_search"), false)

        let p2 = ScriptedProvider([scriptText("好")])
        let s2 = EventStream()
        let r2 = PiRunner(reg, History(), p2)
        let c2 = RunConfig()
        c2.maxSteps = 2
        r2.run("你好", modeResearch(), c2, s2)
        @Expect(p2.seenTools[0].contains("web_search"), true)
        @Expect(p2.seenTools[0].contains("kb_search"), true)
    }

    @TestCase
    func maxStepsStopsARunThatKeepsCallingTools(): Unit {
        let reg = ToolRegistry()
        reg.add(KbSearchTool())
        let provider = ScriptedProvider([
            scriptTool("kb_search", "{\"query\":\"a\"}"),
            scriptTool("kb_search", "{\"query\":\"b\"}")
        ])
        let stream = EventStream()
        let runner = PiRunner(reg, History(), provider)
        let cfg = RunConfig()
        cfg.maxSteps = 2
        let out = runner.run("一直查", modeStandard(), cfg, stream)
        @Expect(out.ok, false)
        @Expect(out.stopReason, "max-steps")
        @Expect(out.steps, 2)
        @Expect(out.toolResults.size, 2)
        @Assert(out.error.contains("最大模型轮数"))
        @Assert(orEmpty(stream.error()).size > 0)
        @Expect(orEmpty(stream.result()), "")
    }

    @TestCase
    func abortAfterAToolResultStopsBeforeTheNextModelCall(): Unit {
        let reg = ToolRegistry()
        reg.add(KbSearchTool())
        let stream = EventStream()
        stream.on({ e: PiEvent =>
            if (kindText(e.kind) == "tool/result") {
                stream.abort()
            }
        })
        let provider = ScriptedProvider([
            scriptTool("kb_search", "{\"query\":\"a\"}"),
            scriptText("这句不该被用到")
        ])
        let runner = PiRunner(reg, History(), provider)
        let cfg = RunConfig()
        cfg.maxSteps = 4
        let out = runner.run("试试中止", modeStandard(), cfg, stream)
        @Expect(out.ok, false)
        @Expect(out.stopReason, "abort")
        @Expect(out.steps, 1)
        @Expect(provider.remaining(), 1)
    }

    @TestCase
    func aFailingModelBecomesAFailedOutcomeInsteadOfAnException(): Unit {
        let reg = ToolRegistry()
        reg.add(KbSearchTool())
        let stream = EventStream()
        let runner = PiRunner(reg, History(), FailingProvider())
        let cfg = RunConfig()
        let out = runner.run("x", modeStandard(), cfg, stream)
        @Expect(out.ok, false)
        @Expect(out.stopReason, "error")
        @Assert(out.error.contains("404"))
        @Assert(orEmpty(stream.error()).size > 0)
        @Expect(producedTurnEnd(kindsOf(stream.drain())), true)
    }

    @TestCase
    func aToolTheModeForbidsIsFedBackToTheModelAsAFailure(): Unit {
        let reg = ToolRegistry()
        reg.add(KbSearchTool())
        let provider = ScriptedProvider([
            scriptTool("kb_search", "{\"query\":\"x\"}"),
            scriptText("那我直接回答。")
        ])
        let stream = EventStream()
        let runner = PiRunner(reg, History(), provider)
        let cfg = RunConfig()
        cfg.maxSteps = 3
        let out = runner.run("你好", modePlain(), cfg, stream)
        @Expect(out.ok, true)
        @Expect(out.text, "那我直接回答。")
        @Expect(out.toolResults.size, 1)
        @Expect(boolOf(out.toolResults[0], "ok"), false)
        @Expect(out.warnings.size, 1)
    }

    @TestCase
    func anEmptyFinalAnswerIsAFailureNotASilentSuccess(): Unit {
        let reg = ToolRegistry()
        reg.add(KbSearchTool())
        let provider = ScriptedProvider([scriptTool("kb_search", "{\"query\":\"a\"}"), scriptText("")])
        let stream = EventStream()
        let runner = PiRunner(reg, History(), provider)
        let cfg = RunConfig()
        cfg.maxSteps = 3
        let out = runner.run("问", modeStandard(), cfg, stream)
        @Expect(out.ok, false)
        @Expect(out.stopReason, "empty")
    }

    @TestCase
    func twoToolCallsBeforeTheAnswerTakeThreeSteps(): Unit {
        let reg = ToolRegistry()
        reg.add(KbSearchTool())
        reg.add(SaveNoteTool())
        let provider = ScriptedProvider([
            scriptTool("kb_search", "{\"query\":\"a\"}"),
            scriptTool("save_note", "{\"title\":\"小结\"}"),
            scriptText("都做完了。")
        ])
        let hist = History()
        let stream = EventStream()
        let runner = PiRunner(reg, hist, provider)
        let cfg = RunConfig()
        cfg.maxSteps = 5
        let out = runner.run("查一下再记下来", modeStandard(), cfg, stream)
        @Expect(out.ok, true)
        @Expect(out.steps, 3)
        @Expect(out.toolResults.size, 2)
        @Expect(hist.size(), 6)
        // 冻结视图：每步只看得到"冻结那一刻"的历史 -> 1、3、5
        @Expect(provider.seenMessageCounts.size, 3)
        @Expect(provider.seenMessageCounts[0], 1)
        @Expect(provider.seenMessageCounts[1], 3)
        @Expect(provider.seenMessageCounts[2], 5)
        let kinds = kindsOf(stream.drain())
        @Expect(countOf(kinds, "tool/result"), 2)
        @Expect(countOf(kinds, "step/start"), 3)
        @Expect(countOf(kinds, "step/end"), 3)
        @Expect(countOf(kinds, "turn/start"), 1)
        @Expect(countOf(kinds, "turn/end"), 1)
    }

    @TestCase
    func reasoningDeltasAreEmittedAsThinkEvents(): Unit {
        let reg = ToolRegistry()
        let step = scriptText("答案是 42。")
        step.reasoning = "先算一下 6 乘 7"
        let provider = ScriptedProvider([step])
        let stream = EventStream()
        let runner = PiRunner(reg, History(), provider)
        let cfg = RunConfig()
        cfg.maxSteps = 2
        let out = runner.run("六乘七是多少", modePlain(), cfg, stream)
        @Expect(out.ok, true)
        @Expect(out.text, "答案是 42。")
        let kinds = kindsOf(stream.drain())
        @Expect(countOf(kinds, "think/delta") > 0, true)
        @Assert(hasSubseq(kinds, ["think/delta", "text/delta"]))
    }

    @TestCase
    func anExhaustedScriptWithoutAnyAnswerIsAnError(): Unit {
        // 脚本给不出最终回答时不能假装成功
        let reg = ToolRegistry()
        reg.add(KbSearchTool())
        let provider = ScriptedProvider(Array<ScriptStep>())
        let stream = EventStream()
        let runner = PiRunner(reg, History(), provider)
        let cfg = RunConfig()
        cfg.maxSteps = 3
        let out = runner.run("问", modeStandard(), cfg, stream)
        @Expect(out.ok, false)
        @Expect(out.stopReason, "empty")
        @Expect(out.steps, 1)
    }

    @TestCase
    func citationSelfCheckFlagsAWebNumberWithoutASource(): Unit {
        @Expect(citationWarning("没有引用", 0), "")
        @Expect(citationWarning("见 [W1] 与 [W2]", 2), "")
        @Expect(citationWarning("见 [W1]", 0).size > 0, true)
        @Assert(citationWarning("见 [W9] 与 [W2]", 2).contains("W9"))
        @Expect(citationWarning("见 [w1]", 1), "")
        // 小写 w 也认，但编号超了照样报
        @Expect(citationWarning("见 [w5]", 2).size > 0, true)
    }

    @TestCase
    func webCitationsAreCountedFromTheToolResultArray(): Unit {
        let reg = ToolRegistry()
        reg.add(WebSearchTool())
        let provider = ScriptedProvider([
            scriptTool("web_search", "{\"query\":\"x\"}"),
            scriptText("FakeWebSearchTool 固定返回 3 条，所以 [W3] 是边界，不该报。")
        ])
        let stream = EventStream()
        let runner = PiRunner(reg, History(), provider)
        let cfg = RunConfig()
        cfg.maxSteps = 3
        let out = runner.run("上网查", modeResearch(), cfg, stream)
        @Expect(out.ok, true)
        @Expect(out.warnings.size, 0)

        // 同一个回答里出现 [W4] 时必须报
        let bad = citationWarning("这是 [W4]", 3)
        @Assert(bad.contains("W4"))
    }
}
