package pi_cj.unittests

import std.collection.*
import std.time.*
import stdx.encoding.json.*
import pi_cj.pi.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 主循环：事件序列、工具执行与回灌、队列、护栏。
 * 断言三件一起看：事件序列 + 会话内容 + 结果对象。
 */
@Test
class AgentLoopTest {
    @TestCase
    func oneToolCallThenAnswerProducesThePiEventSequence(): Unit {
        let d = freshDir("loop-basic")
        let s = newSession(d, "cwd", "", "")
        let reg = ToolRegistry()
        let spec = ToolSpec("echo", "回显", "Echo", "回显文本。",
            "{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}},\"required\":[\"text\"]}", "read")
        reg.add(FuncTool(spec, { callId: String, args: JsonObject =>
            let t = strOf(args, "text")
            ToolResult.ok("回显 " + t, "工具正文：" + t, JsonNull())
        }))
        let provider = ScriptedProvider([
            scriptTool("echo", "{\"text\":\"你好\"}"),
            scriptText("工具说完了。")
        ])
        let opts = AgentOptions()
        opts.model = "scripted"
        let agent = Agent(provider, s, reg, onlyMode("echo"), opts)
        agent.preamble = "你是测试助手。"
        let stream = EventStream()
        let out = agent.prompt("帮我回显", stream)
        @Expect(out.ok, true)
        @Expect(out.stopReason, "stop")
        @Expect(out.turns, 2)
        @Expect(out.toolResults.size, 1)

        let kinds = kindsOf(stream.drain())
        @Expect(kinds[0], "agent_start")
        @Expect(kinds[kinds.size - 1], "agent_end")
        @Expect(countOf(kinds, "turn_start"), 2)
        @Expect(countOf(kinds, "turn_end"), 2)
        @Expect(countOf(kinds, "tool_execution_start"), 1)
        @Expect(countOf(kinds, "tool_execution_end"), 1)
        @Expect(countOf(kinds, "message_update") > 0, true)
        @Assert(hasSubseq(kinds, ["agent_start", "turn_start", "message_start", "message_end",
            "message_update", "message_end", "tool_execution_start", "tool_execution_end",
            "message_start", "message_end", "turn_end", "turn_start", "message_start",
            "message_update", "message_end", "agent_end"]))

        // 会话：user / assistant(带 toolCall) / toolResult / assistant
        let msgs = s.messagesForModel()
        @Expect(msgs.size, 4)
        @Expect(roleName(msgs[0].role), "user")
        @Expect(roleName(msgs[1].role), "assistant")
        @Expect(msgs[1].toolCalls.size, 1)
        @Expect(msgs[1].toolCalls[0].name, "echo")
        @Expect(roleName(msgs[2].role), "toolResult")
        @Expect(msgs[2].toolCallId, msgs[1].toolCalls[0].id)
        @Expect(roleName(msgs[3].role), "assistant")
        @Expect(msgs[3].text, "工具说完了。")
        // 回灌的是正文，不是那一行摘要
        @Expect(msgs[2].text, "工具正文：你好")
        // 提供方每轮看到的系统提示词里有工具清单
        @Expect(containsSub(provider.seenSystems[0], "<tools>"), true)
        @Expect(containsSub(provider.seenSystems[0], "echo"), true)
        @Expect(provider.seenMessageCounts[0], 1)
    }

    @TestCase
    func twoToolCallsInOneAssistantMessageAreBothExecuted(): Unit {
        let d = freshDir("loop-parallel")
        let s = newSession(d, "cwd", "", "")
        let reg = ToolRegistry()
        let spec = ToolSpec("twice", "两下", "Twice", "回显。",
            "{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\"}}}", "read")
        reg.add(FuncTool(spec, { callId: String, args: JsonObject =>
            ToolResult.ok("回显 " + strOf(args, "text"), "正文 " + strOf(args, "text"), JsonNull())
        }))
        let agent = Agent(TwoCallProvider(), s, reg, onlyMode("twice"), AgentOptions())
        let stream = EventStream()
        let out = agent.prompt("做两件事", stream)
        @Expect(out.ok, true)
        @Expect(out.toolResults.size, 2)
        @Expect(boolOf(out.toolResults[0], "ok", false), true)
        @Expect(boolOf(out.toolResults[1], "ok", false), true)
        let kinds = kindsOf(stream.drain())
        @Expect(countOf(kinds, "tool_execution_start"), 2)
        @Expect(countOf(kinds, "tool_execution_end"), 2)
        // 一轮里跑完两条工具（这就证明"一步多调用"被整体接住了）
        @Expect(countOf(kinds, "turn_end"), 2)
        // 两条 toolCall 在同一条 assistant 消息里，两条 toolResult 各对应自己的 id
        let msgs = s.messagesForModel()
        @Expect(msgs.size, 5)
        @Expect(msgs[1].toolCalls.size, 2)
        @Expect(msgs[2].toolCallId, "call_a")
        @Expect(msgs[3].toolCallId, "call_b")
        @Expect(msgs[2].text, "正文 a")
        @Expect(msgs[3].text, "正文 b")
        @Expect(msgs[4].text, "两件都做了")
    }

    @TestCase
    func beforeToolCallCanBlockATool(): Unit {
        let d = freshDir("loop-block")
        let s = newSession(d, "cwd", "", "")
        let reg = ToolRegistry()
        reg.add(BoomTool())
        let provider = ScriptedProvider([scriptTool("boom", "{}"), scriptText("那我不用工具了")])
        let opts = AgentOptions()
        opts.beforeToolCall = Some({ callId: String, name: String, args: JsonObject => "审批没过：测试里一律不放行" })
        let agent = Agent(provider, s, reg, onlyMode("boom"), opts)
        let out = agent.prompt("跑一下", EventStream())
        @Expect(out.ok, true)
        @Expect(boolOf(out.toolResults[0], "ok", false), false)
        let msgs = s.messagesForModel()
        @Expect(containsSub(msgs[2].text, "审批没过"), true)
        @Expect(msgs[2].isError, true)
    }

    @TestCase
    func aToolThatFailsStillLetsTheModelContinue(): Unit {
        let d = freshDir("loop-toolfail")
        let s = newSession(d, "cwd", "", "")
        let reg = ToolRegistry()
        reg.add(BoomTool())
        let provider = ScriptedProvider([scriptTool("boom", "{}"), scriptText("工具挂了，我直接回答")])
        let opts = AgentOptions()
        let agent = Agent(provider, s, reg, onlyMode("boom"), opts)
        let out = agent.prompt("跑一下", EventStream())
        @Expect(out.ok, true)
        @Expect(out.toolResults.size, 1)
        @Expect(boolOf(out.toolResults[0], "ok", false), false)
        @Expect(out.warnings.size, 1)
        let msgs = s.messagesForModel()
        @Expect(msgs[2].isError, true)
    }

    @TestCase
    func aModelErrorEndsTheRunWithoutThrowing(): Unit {
        let d = freshDir("loop-err")
        let s = newSession(d, "cwd", "", "")
        let reg = ToolRegistry()
        let bad = ScriptStep("")
        bad.failWith = "模型接口返回 500"
        let provider = ScriptedProvider([bad])
        let agent = Agent(provider, s, reg, modeChat(), AgentOptions())
        let stream = EventStream()
        let out = agent.prompt("你好", stream)
        @Expect(out.ok, false)
        @Expect(out.stopReason, "error")
        @Expect(containsSub(out.error, "500"), true)
        let kinds = kindsOf(stream.drain())
        @Expect(kinds[kinds.size - 1], "agent_end")
        @Expect(orEmpty(stream.error()).size > 0, true)
    }

    @TestCase
    func maxTurnsStopsARunThatKeepsCallingTools(): Unit {
        let d = freshDir("loop-maxturns")
        let s = newSession(d, "cwd", "", "")
        let reg = ToolRegistry()
        reg.add(BoomTool())
        let provider = ScriptedProvider([scriptTool("boom", "{}"), scriptTool("boom", "{}"), scriptTool("boom", "{}")])
        let opts = AgentOptions()
        opts.maxTurns = 2
        let agent = Agent(provider, s, reg, onlyMode("boom"), opts)
        let out = agent.prompt("一直调", EventStream())
        @Expect(out.ok, false)
        @Expect(out.stopReason, "length")
        @Expect(out.turns, 2)
        @Expect(containsSub(out.error, "最大轮数"), true)
    }

    @TestCase
    func steeringMessagesAreInjectedBeforeTheModelRequest(): Unit {
        let d = freshDir("loop-steer")
        let s = newSession(d, "cwd", "", "")
        let reg = ToolRegistry()
        let provider = ScriptedProvider([scriptText("一起答了")])
        let agent = Agent(provider, s, reg, modeChat(), AgentOptions())
        // 模型还没跑就排队：它应该在同一轮被注入（Pi 的 steering drain 点在请求之前）
        agent.steer("等会儿，先补充一句")
        let out = agent.prompt("你好", EventStream())
        @Expect(out.ok, true)
        @Expect(out.turns, 1)
        let msgs = s.messagesForModel()
        @Expect(msgs.size, 3)
        @Expect(msgs[0].text, "你好")
        @Expect(msgs[1].text, "等会儿，先补充一句")
        // 模型在第一次请求里就看到了两条 user 消息
        @Expect(provider.seenMessageCounts[0], 2)
    }

    @TestCase
    func followUpMessagesRunAfterTheAgentWouldOtherwiseStop(): Unit {
        let d = freshDir("loop-followup")
        let s = newSession(d, "cwd", "", "")
        let provider = ScriptedProvider([scriptText("先说第一件事"), scriptText("再说第二件事")])
        let agent = Agent(provider, s, ToolRegistry(), modeChat(), AgentOptions())
        // follow-up 不抢在第一轮里注入：等模型答完、本该收工时才进来
        agent.followUp("顺便再说第二件事")
        let stream = EventStream()
        let out = agent.prompt("说说第一件事", EventStream())
        @Expect(out.ok, true)
        @Expect(out.turns, 2)
        let msgs = s.messagesForModel()
        @Expect(msgs.size, 4)
        @Expect(msgs[2].text, "顺便再说第二件事")
        // 第一轮的模型请求只看得到第一条
        @Expect(provider.seenMessageCounts[0], 1)
        @Expect(provider.seenMessageCounts[1], 3)
    }

    @TestCase
    func resumeRefusesWhenTheLastMessageIsAnAssistantAnswer(): Unit {
        let d = freshDir("loop-resume")
        let s = newSession(d, "cwd", "", "")
        let provider = ScriptedProvider([scriptText("回答"), scriptText("续跑的回答")])
        let agent = Agent(provider, s, ToolRegistry(), modeChat(), AgentOptions())
        agent.prompt("问题", EventStream())
        // 最后一条是 assistant 且没有工具调用 -> 不能续跑（Pi 也这么校验）
        let bad = agent.resume(EventStream())
        @Expect(bad.ok, false)
        @Expect(containsSub(bad.error, "assistant"), true)
        // 加一条 user 之后就能续跑
        let u = Message(UserMsg)
        u.text = "接着刚才说"
        s.appendMessage(u)
        let ok = agent.resume(EventStream())
        @Expect(ok.ok, true)
        @Expect(s.messagesForModel().size, 4)
    }

    @TestCase
    func autoCompactionKicksInWhenContextGrows(): Unit {
        let d = freshDir("loop-autocompact")
        let s = newSession(d, "cwd", "", "")
        // 先把历史堆到阈值以上
        var i: Int64 = 0
        while (i < 12) {
            let u = Message(UserMsg)
            u.text = "这是第 " + i.toString() + " 条历史消息，用来把上下文撑大。"
            s.appendMessage(u)
            let a = Message(AssistantMsg)
            a.text = "收到第 " + i.toString() + " 条。"
            s.appendMessage(a)
            i = i + 1
        }
        // 脚本：第一步是"压缩用的摘要"，第二步才是正式回答
        let provider = ScriptedProvider([scriptText("之前聊了 12 轮，结论是 A，未完成 B。"), scriptText("正式回答")])
        let opts = AgentOptions()
        opts.autoCompactBytes = 1000        // 人为压低阈值
        opts.compactKeepRecent = 2
        let agent = Agent(provider, s, ToolRegistry(), modeChat(), opts)
        @Assert(agent.contextBytes() > opts.autoCompactBytes)
        let out = agent.prompt("接着聊", EventStream())
        @Expect(out.ok, true)
        @Expect(agent.compactCount, 1)
        @Expect(containsSub(agent.lastCompactNote, "已压缩"), true)
        // 会话里落了 compaction entry，且组装上下文时用的是摘要
        var hasCompaction = false
        for (e in s.entries) {
            if (strOf(e, "type") == "compaction") {
                hasCompaction = true
                @Assert(strOf(e, "summary").size > 0)
                @Assert(strOf(e, "firstKeptEntryId").size > 0)
            }
        }
        @Expect(hasCompaction, true)
        let msgs = s.messagesForModel()
        @Expect(roleName(msgs[0].role), "user")
        @Expect(containsSub(msgs[0].text, "摘要"), true)
        @Expect(containsSub(msgs[0].text, "结论是 A"), true)
    }

    @TestCase
    func nothingIsCompactedWhenContextIsStillSmall(): Unit {
        let d = freshDir("loop-nocompact")
        let s = newSession(d, "cwd", "", "")
        let provider = ScriptedProvider([scriptText("回答")])
        let agent = Agent(provider, s, ToolRegistry(), modeChat(), AgentOptions())
        let out = agent.prompt("一个问题", EventStream())
        @Expect(out.ok, true)
        @Expect(agent.compactCount, 0)
        @Expect(provider.remaining(), 0)
    }

    @TestCase
    func parallelToolExecutionRunsThemConcurrently(): Unit {
        let d = freshDir("loop-parallel-exec")
        let s = newSession(d, "cwd", "", "")
        let reg = ToolRegistry()
        // 名字要与 TwoCallProvider 发的一致（twice）
        let spec = ToolSpec("twice", "慢工具", "Slow", "睡一会儿再返回。",
            "{\"type\":\"object\",\"properties\":{\"tag\":{\"type\":\"string\"}}}", "read")
        reg.add(FuncTool(spec, { callId: String, args: JsonObject =>
            sleep(Duration.millisecond * 300)
            ToolResult.ok("睡了 300ms", "正文 " + strOf(args, "tag") + " " + callId, JsonNull())
        }))
        let opts = AgentOptions()
        opts.toolExecution = "parallel"
        let agent = Agent(TwoCallProvider(), s, reg, onlyMode("twice"), opts)
        let stream = EventStream()
        let t0 = nowMillis()
        let out = agent.prompt("并发跑两个", stream)
        let wall = nowMillis() - t0
        @Expect(out.ok, true)
        @Expect(out.toolResults.size, 2)
        // 顺序执行要 600ms 以上；并发应当在 600ms 以内（留足余量，避免偶发抖动）
        @Assert(wall < 600)
        // 事件与结果仍按源顺序（并发只在工具内部）
        let msgs = s.messagesForModel()
        @Expect(msgs[2].toolCallId, "call_a")
        @Expect(msgs[3].toolCallId, "call_b")
        @Expect(containsSub(msgs[2].text, "call_a"), true)
        let kinds = kindsOf(stream.drain())
        @Expect(countOf(kinds, "tool_execution_start"), 2)
        @Expect(countOf(kinds, "tool_execution_end"), 2)
    }

    @TestCase
    func theSystemPromptSnapshotIsWrittenIntoTheSession(): Unit {
        let d = freshDir("loop-sys")
        let s = newSession(d, "cwd", "", "")
        let provider = ScriptedProvider([scriptText("好")])
        let agent = Agent(provider, s, ToolRegistry(), modeChat(), AgentOptions())
        agent.preamble = "你是助手。"
        agent.skillsText = "\n\n<available_skills>\n  <skill>\n    <name>x</name>\n  </skill>\n</available_skills>"
        agent.prompt("你好", EventStream())
        var hasSystem = false
        for (e in s.entries) {
            if (strOf(e, "type") == "message") {
                match (e.get("message")) {
                    case Some(mv) =>
                        match (objOf(mv)) {
                            case Some(mo) =>
                                if (strOf(mo, "role") == "system") {
                                    hasSystem = true
                                }
                            case None => ()
                        }
                    case None => ()
                }
            }
        }
        @Expect(hasSystem, true)
        // 系统提示词里既有 preamble 也有 skills 播报
        @Expect(containsSub(provider.seenSystems[0], "你是助手。"), true)
        @Expect(containsSub(provider.seenSystems[0], "available_skills"), true)
    }
}
