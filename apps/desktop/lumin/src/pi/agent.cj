package lumin.pi

import std.collection.*
import std.sync.*
import stdx.encoding.json.*

/*
 * Agent 主循环，结构照 Pi 的 agent-loop：
 *
 *   agent_start
 *     ┌ 外层：把排队的 follow-up / steering 消息插进来，继续跑
 *     │  turn_start                       turn = 一次模型请求 + 它触发的工具
 *     │    message_start/end(user)        初始输入或排队消息
 *     │    模型请求 → message_update* → message_end(assistant)
 *     │    每个工具：tool_execution_start → (update*) → tool_execution_end
 *     │              再补一条 toolResult 消息的 message_start/end
 *     │  turn_end
 *     │  还有工具结果 → 继续内层；否则看队列 → 有就继续外层
 *     └
 *   agent_end
 *
 * 与 Pi 的差别（刻意保留的简化）：
 *   - 工具**顺序**执行（Pi 支持 parallel）；
 *   - 只有 steering / follow-up 两个队列的注入点，没有 Pi 的 prepareNextTurn/压缩钩子（压缩用手动命令）。
 */

/** 并行执行工具时的结果槽（子线程写、主线程 join 完之后读，读到的一定是写好的值）。 */
class ToolSlot {
    var res: ?ToolResult = None
    var durationMs: Int64 = 0
}

public class RunOutcome {
    public var ok: Bool = true
    public var stopReason: String = "stop"
    public var turns: Int64 = 0
    public var error: String = ""
    public var usageIn: Int64 = 0
    public var usageOut: Int64 = 0
    public let toolResults = ArrayList<JsonObject>()
    public let warnings = ArrayList<String>()

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("ok", JsonBool(ok))
        o.put("stopReason", JsonString(stopReason))
        o.put("turns", JsonInt(turns))
        if (error.size > 0) {
            o.put("error", JsonString(error))
        }
        o.put("usageIn", JsonInt(usageIn))
        o.put("usageOut", JsonInt(usageOut))
        let ws = JsonArray()
        for (w in warnings) {
            ws.add(JsonString(w))
        }
        o.put("warnings", ws)
        let rs = JsonArray()
        for (r in toolResults) {
            rs.add(r)
        }
        o.put("toolResults", rs)
        return o
    }
}

public class AgentOptions {
    public var model: String = ""
    /** 保护性上限：模型反复调工具时兜底 */
    public var maxTurns: Int64 = 40
    /** 返回非空 = 阻止这次工具调用，返回的文本作为错误结果给模型（Pi 的 beforeToolCall） */
    public var beforeToolCall: ?(String, String, JsonObject) -> String = None
    /** 模型跑着的时候用户又输了几条（Pi 的 getSteeringMessages） */
    public var getSteering: ?() -> ArrayList<String> = None
    /** 上下文估算超过这么多字节就自动压缩（0 = 关）。Pi 用 prepareNextTurn 钩子做，位置一样（每轮请求前）。 */
    public var autoCompactBytes: Int64 = 120000
    /** 压缩时最近几条消息不参与摘要 */
    public var compactKeepRecent: Int64 = 2
    /** "sequential"（默认，可复现）或 "parallel"（一步并发跑多个工具） */
    public var toolExecution: String = "sequential"
}

public class Agent {
    public var session: Session
    public var registry: ToolRegistry
    public var mode: Mode
    public let options: AgentOptions
    /** 角色设定（系统提示词的第一段） */
    public var preamble: String = ""
    /** skills 播报文本（由宿主扫描后注入） */
    public var skillsText: String = ""
    /** 当前工作区根（宿主设置；审批层用它判断"写到了工作区外"） */
    public var workspaceRoot: String = ""
    private let provider: ChatProvider
    private var abortedFlag = false
    private var lastSystemText = ""
    /** 最近一次压缩的结果说明 */
    public var lastCompactNote: String = ""
    public var compactCount: Int64 = 0
    private var steeringQueue = ArrayList<String>()
    private var followUpQueue = ArrayList<String>()

    public init(provider: ChatProvider, session: Session, registry: ToolRegistry, mode: Mode, options: AgentOptions) {
        this.provider = provider
        this.session = session
        this.registry = registry
        this.mode = mode
        this.options = options
    }

    /** 排队：模型跑着的时候插一句（Pi 的 steering）。 */
    public func steer(text: String): Unit {
        steeringQueue.add(text)
    }

    /** 排队：这一轮全部跑完之后再进来（Pi 的 follow-up）。 */
    public func followUp(text: String): Unit {
        followUpQueue.add(text)
    }

    public func abort(): Unit {
        abortedFlag = true
    }

    public func isAborted(): Bool {
        return abortedFlag
    }

    public func systemPromptNow(): String {
        return buildSystemPrompt(preamble, registry.specsOf(mode), skillsText, session.cwd)
    }

    /** 一轮：= Pi 的 agentLoop。 */
    public func prompt(text: String, stream: EventStream): RunOutcome {
        return run(true, text, stream)
    }

    /** 续跑：= Pi 的 agentLoopContinue（末尾必须是能接话的角色）。 */
    public func resume(stream: EventStream): RunOutcome {
        let msgs = session.messagesForModel()
        if (msgs.size == 0) {
            let out = RunOutcome()
            out.ok = false
            out.stopReason = "error"
            out.error = "会话里没有消息，无法续跑"
            return out
        }
        let last = msgs[msgs.size - 1]
        if (last.role == AssistantMsg && !last.hasToolCalls()) {
            let out = RunOutcome()
            out.ok = false
            out.stopReason = "error"
            out.error = "最后一条是 assistant 消息，续跑会让服务端拒绝（Pi 也是这么校验的）"
            return out
        }
        return run(false, "", stream)
    }

    private func run(withPrompt: Bool, text: String, stream: EventStream): RunOutcome {
        let out = RunOutcome()
        abortedFlag = false
        stream.push(evAgentStart())

        // 提示词变了就存一条 system 快照（Pi 也会把 section 变更写进会话）
        let sysText = systemPromptNow()
        if (sysText != lastSystemText) {
            session.appendSystemSections(promptSections(preamble, registry.specsOf(mode), skillsText, session.cwd))
            lastSystemText = sysText
        }

        var turns: Int64 = 0
        var running = true
        while (running) {
            if (abortedFlag) {
                out.ok = false
                out.stopReason = "aborted"
                out.error = "已取消"
                break
            }
            if (turns >= options.maxTurns) {
                out.ok = false
                out.stopReason = "length"
                out.error = "达到最大轮数（" + options.maxTurns.toString() + "），停下"
                break
            }
            turns = turns + 1
            stream.push(evTurnStart(turns))

            // 这一轮开头要注入的消息：第一轮是用户的输入，之后是排队的东西
            if (turns == 1 && withPrompt) {
                injectUser(text, stream)
            }
            drainSteering(stream)
            if (turns > 1) {
                drainFollowUps(stream)
            }

            // 上下文太大就先压缩（Pi 的 prepareNextTurn 钩子位置）
            if (options.autoCompactBytes > 0 && contextBytes() > options.autoCompactBytes) {
                compact(options.compactKeepRecent, EventStream())
            }

            let ctx = StepContext()
            ctx.model = options.model
            ctx.system = systemPromptNow()
            ctx.tools = registry.specsOf(mode)
            ctx.turn = turns
            ctx.cwd = session.cwd
            for (m in session.messagesForModel()) {
                ctx.messages.add(m)
            }

            let am = Message(AssistantMsg)
            am.model = options.model
            stream.push(evMessageStart(am))
            let reply = provider.respond(ctx, stream)
            am.text = reply.text
            am.thinking = reply.thinking
            am.stopReason = reply.stopReason
            for (tc in reply.toolCalls) {
                am.toolCalls.add(tc)
            }
            session.appendMessage(am)
            stream.push(evMessageEnd(am))
            out.usageIn = out.usageIn + reply.usageIn
            out.usageOut = out.usageOut + reply.usageOut

            if (reply.stopReason == "error") {
                out.ok = false
                out.stopReason = "error"
                out.error = reply.errorMessage
                break
            }
            if (abortedFlag) {
                out.ok = false
                out.stopReason = "aborted"
                out.error = "已取消"
                break
            }

            let summaries = executeToolCalls(am.toolCalls, stream, out)
            stream.push(evTurnEnd(am, summaries))

            if (!am.hasToolCalls()) {
                out.stopReason = "stop"
                // 模型不再要工具：还有排队的 follow-up 就再开一轮（Pi 的外层循环），否则收工
                if (followUpQueue.size > 0) {
                    continue
                }
                running = false
            }
            // 有工具结果 -> 内层继续，再问模型一轮
        }

        out.turns = turns
        stream.push(evAgentEnd(out.stopReason, turns))
        if (out.ok) {
            stream.finish(out.stopReason)
        } else {
            stream.fail(out.error)
        }
        return out
    }

    /** 当前分支的上下文大小估算（字节；中文大约 3 字节一个 token）。 */
    public func contextBytes(): Int64 {
        var n: Int64 = 64
        for (m in session.messagesForModel()) {
            n = n + m.text.size + 32
            for (tc in m.toolCalls) {
                n = n + tc.argsJson.size + 16
            }
        }
        return n
    }

    /**
     * 压缩：把较早的消息交给模型总结，然后写一条 compaction entry（原文保留、只是不再进上下文）。
     * Pi 在 prepareNextTurn 里自动做；这里既能自动（超过 autoCompactBytes）也能手动 /compact。
     */
    public func compact(keepRecent: Int64, quiet: EventStream): Bool {
        let ids = ArrayList<String>()
        for (e in session.branchEntries()) {
            if (strOf(e, "type") == "message") {
                match (e.get("message")) {
                    case Some(mv) =>
                        match (objOf(mv)) {
                            case Some(mo) =>
                                if (strOf(mo, "role") != "system") {
                                    ids.add(strOf(e, "id"))
                                }
                            case None => ()
                        }
                    case None => ()
                }
            }
        }
        if (ids.size <= keepRecent + 1) {
            lastCompactNote = "对话还短，不用压缩"
            return false
        }
        let firstKept = ids[ids.size - keepRecent]
        let all = session.messagesForModel()
        let sb = StringBuilder()
        var i: Int64 = 0
        while (i + keepRecent < all.size) {
            sb.append("[")
            sb.append(roleName(all[i].role))
            sb.append("] ")
            sb.append(all[i].text)
            sb.append("\n")
            i = i + 1
        }
        let ctx = StepContext()
        ctx.model = options.model
        ctx.system = compactPrompt()
        let um = Message(UserMsg)
        um.text = sb.toString()
        ctx.messages.add(um)
        let r = provider.respond(ctx, quiet)
        if (r.stopReason == "error") {
            lastCompactNote = "压缩失败：" + r.errorMessage
            return false
        }
        let summary = trimStr(r.text)
        if (summary.size == 0) {
            lastCompactNote = "压缩失败：模型没给摘要"
            return false
        }
        session.appendCompaction(summary, firstKept)
        compactCount = compactCount + 1
        lastCompactNote = "已压缩：" + sb.toString().size.toString() + " 字节对话 -> " +
            summary.size.toString() + " 字节摘要"
        return true
    }

    /**
     * 执行这一轮的（可能多条）工具调用。
     *
     * 事件与会话都在**主线程**按源顺序写：并行只在工具内部并发，
     * 这样既拿到并发收益，又不用给事件流/会话加锁，也就不会出现事件交错。
     */
    private func executeToolCalls(calls: ArrayList<ToolCallBlock>, stream: EventStream, out: RunOutcome): ArrayList<String> {
        let summaries = ArrayList<String>()
        if (calls.size == 0) {
            return summaries
        }
        for (tc in calls) {
            stream.push(evToolStart(tc.id, tc.name, tc.argsJson))
        }
        let slots = ArrayList<ToolSlot>()
        var k: Int64 = 0
        while (k < calls.size) {
            slots.add(ToolSlot())
            k = k + 1
        }
        if (options.toolExecution == "parallel" && calls.size > 1) {
            let futures = ArrayList<Future<Unit>>()
            var i: Int64 = 0
            while (i < calls.size) {
                // 通过带参函数发起：闭包捕获参数时每次调用绑定独立，不会两个线程共享同一个循环变量
                spawnToolRun(calls[i], slots[i], futures)
                i = i + 1
            }
            for (f in futures) {
                try {
                    f.get()
                } catch (e: Exception) {
                    ()
                }
            }
        } else {
            var i: Int64 = 0
            while (i < calls.size) {
                runOneTool(calls[i], slots[i])
                i = i + 1
            }
        }
        var i: Int64 = 0
        while (i < calls.size) {
            let tc = calls[i]
            let slot = slots[i]
            let res = match (slot.res) {
                case Some(r) => r
                case None => ToolResult.err("工具没有返回结果")
            }
            stream.push(evToolEnd(tc.id, tc.name, res.summary, res.isError, slot.durationMs))
            let trm = Message(ToolResultMsg)
            trm.toolCallId = tc.id
            trm.toolName = tc.name
            trm.text = res.modelText()
            trm.isError = res.isError
            session.appendMessage(trm)
            stream.push(evMessageStart(trm))
            stream.push(evMessageEnd(trm))
            summaries.add(res.summary)
            let rp = JsonObject()
            rp.put("tool", JsonString(tc.name))
            rp.put("callId", JsonString(tc.id))
            rp.put("ok", JsonBool(!res.isError))
            rp.put("summary", JsonString(res.summary))
            out.toolResults.add(rp)
            if (res.isError) {
                out.warnings.add("工具 " + tc.name + " 出错：" + res.summary)
            }
            i = i + 1
        }
        return summaries
    }

    private func spawnToolRun(tc: ToolCallBlock, slot: ToolSlot, futures: ArrayList<Future<Unit>>): Unit {
        futures.add(spawn { runOneTool(tc, slot) })
    }

    /** 跑一个工具（可能跑在子线程里：只碰工具自己的东西，不碰事件流与会话）。 */
    private func runOneTool(tc: ToolCallBlock, slot: ToolSlot): Unit {
        let startMs = nowMillis()
        let args = tc.args()
        var blocked = ""
        match (options.beforeToolCall) {
            case Some(f) => blocked = f(tc.id, tc.name, args)
            case None => ()
        }
        if (blocked.size > 0) {
            slot.res = Some(ToolResult.err(blocked))
        } else {
            slot.res = Some(registry.execute(mode, tc.id, tc.name, args))
        }
        slot.durationMs = nowMillis() - startMs
    }

    /** 把排队的 steering 消息写成 user 消息（Pi 的 steering drain 点）。 */
    private func drainSteering(stream: EventStream): Unit {
        let pending = ArrayList<String>()
        match (options.getSteering) {
            case Some(f) =>
                for (t in f()) {
                    pending.add(t)
                }
            case None => ()
        }
        for (t in steeringQueue) {
            pending.add(t)
        }
        steeringQueue = ArrayList<String>()
        for (t in pending) {
            injectUser(t, stream)
        }
    }

    private func drainFollowUps(stream: EventStream): Unit {
        let pending = followUpQueue
        followUpQueue = ArrayList<String>()
        for (t in pending) {
            injectUser(t, stream)
        }
    }

    private func injectUser(text: String, stream: EventStream): Unit {
        let m = Message(UserMsg)
        m.text = text
        session.appendMessage(m)
        stream.push(evMessageStart(m))
        stream.push(evMessageEnd(m))
    }
}
