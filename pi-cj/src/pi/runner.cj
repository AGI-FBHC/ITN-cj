package pi_cj.pi

import std.collection.*
import stdx.encoding.json.*

/** 一轮运行的输入。 */
public class RunConfig {
    /** 系统提示词（由宿主拼好；PiSession 会往里补工具协议说明） */
    public var system: String = ""
    public var turnId: String = "t1"
    /** 最大模型轮数（护栏）：模型反复调工具时靠它兜底。多件工具串起来用，6 轮很紧，给 8。 */
    public var maxSteps: Int64 = 8
}

/** 一轮运行的结果。 */
public class RunOutcome {
    public var ok: Bool = true
    public var text: String = ""
    public var steps: Int64 = 0
    /** end / max-steps / abort / error / empty */
    public var stopReason: String = "end"
    public var error: String = ""
    public let toolResults = ArrayList<JsonObject>()
    public let warnings = ArrayList<String>()

    public func addWarning(w: String): Unit {
        warnings.add(w)
    }

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("ok", JsonBool(ok))
        o.put("text", JsonString(text))
        o.put("steps", JsonInt(steps))
        o.put("stopReason", JsonString(stopReason))
        if (error.size > 0) {
            o.put("error", JsonString(error))
        }
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

/**
 * 主循环（把 Pi 的 turn/step 生命周期落成一段可读代码）：
 *
 *   turn/start
 *     step/start
 *       ctx = 冻结的历史 + 本模式的工具清单
 *       provider.respond -> 边流边推 text/delta、tool/call_* 事件
 *       有工具调用：执行 -> tool/result -> 结果写回历史（下一轮能看到）
 *       没工具调用：这就是最终回答
 *     step/end
 *   turn/end
 *
 * 三条护栏：最大轮数（maxSteps）、可中止（stream.abort()）、工具白名单+可用性（registry.execute）。
 * 出错一律转成 out.ok=false + stopReason，不往宿主外面抛异常——宿主只需要看结果对象和事件流。
 */
public class PiRunner {
    public let registry: ToolRegistry
    public let history: History
    private let provider: ChatProvider

    public init(registry: ToolRegistry, history: History, provider: ChatProvider) {
        this.registry = registry
        this.history = history
        this.provider = provider
    }

    public func run(userText: String, mode: Mode, cfg: RunConfig, stream: EventStream): RunOutcome {
        let out = RunOutcome()
        stream.emit(TurnStart, cfg.turnId, 0, userText)
        history.add("user", userText)
        var steps: Int64 = 0
        var finalText = ""
        var gotFinal = false
        var webSources: Int64 = 0
        while (steps < cfg.maxSteps) {
            if (stream.aborted()) {
                out.ok = false
                out.stopReason = "abort"
                out.error = "已取消"
                break
            }
            steps = steps + 1
            stream.emit(StepStart, cfg.turnId, steps, "")
            let ctx = StepContext(mode)
            ctx.system = cfg.system
            ctx.messages = history.freeze()
            ctx.tools = toolProtocolText(registry, mode)
            ctx.toolSpecs = registry.specsOf(mode)
            ctx.turnId = cfg.turnId
            ctx.step = steps
            var reply = ModelReply()
            try {
                reply = provider.respond(ctx, stream)
            } catch (e: Exception) {
                history.thaw()
                out.ok = false
                out.stopReason = "error"
                out.error = "模型调用失败：" + e.message
                stream.emit(StepEnd, cfg.turnId, steps, "")
                break
            }
            if (reply.requests.size == 0) {
                finalText = reply.text
                gotFinal = true
                history.add("assistant", finalText)
                stream.emit(StepEnd, cfg.turnId, steps, "")
                history.thaw()
            } else {
                // 先把"这一步要调的工具"整体记一条（原生协议要求全写在同一条 assistant 消息里），
                // 再逐个执行、逐个回灌结果并广播事件。
                history.addToolCalls(reply.requests)
                for (req in reply.requests) {
                    let res = registry.execute(mode, req.name, req.args)
                    history.addToolResult(req.id, req.name, res.modelText())
                    let rp = JsonObject()
                    rp.put("tool", JsonString(req.name))
                    if (req.id.size > 0) {
                        rp.put("callId", JsonString(req.id))
                    }
                    rp.put("ok", JsonBool(res.ok))
                    rp.put("summary", JsonString(res.summary))
                    out.toolResults.add(rp)
                    let re = PiEvent(PiEventKind.ToolResult)
                    re.turnId = cfg.turnId
                    re.step = steps
                    re.tool = req.name
                    re.callId = req.id
                    re.text = res.summary
                    re.ok = res.ok
                    stream.push(re)
                    if (!res.ok) {
                        out.addWarning("工具 " + req.name + " 没有成功：" + res.summary)
                    }
                    if (registry.isExternal(req.name) && res.ok) {
                        webSources = webSources + sourceCount(res)
                    }
                }
                stream.emit(StepEnd, cfg.turnId, steps, "")
                history.thaw()
            }
            if (gotFinal) {
                break
            }
        }
        if (!gotFinal) {
            if (out.stopReason == "end") {
                out.ok = false
                out.stopReason = "max-steps"
                out.error = "达到最大模型轮数（" + cfg.maxSteps.toString() + "）仍没有给出最终回答"
            }
        } else if (finalText.size == 0) {
            out.ok = false
            out.stopReason = "empty"
            out.error = "模型这一轮没有返回任何内容"
        } else {
            let warn = citationWarning(finalText, webSources)
            if (warn.size > 0) {
                out.addWarning(warn)
            }
        }
        out.text = finalText
        out.steps = steps
        let te = PiEvent(TurnEnd)
        te.turnId = cfg.turnId
        te.step = steps
        te.text = finalText
        te.ok = out.ok
        te.value = out.stopReason
        stream.push(te)
        if (out.ok) {
            stream.finish(finalText)
        } else {
            stream.fail(out.error)
        }
        return out
    }
}

/** 外部工具返回了几条来源（联网检索用；返回的不是数组就按 1 条算）。 */
func sourceCount(res: ToolResult): Int64 {
    match (arrOf(res.data)) {
        case Some(a) => return a.size()
        case None => return if (res.ok) { 1 } else { 0 }
    }
}

/**
 * 引用自检：回答里出现的 [W1]、[W2]… 必须真的有对应数量的联网来源。
 *
 * 只查网页编号（[Wn]），因为本机资料的 [n] 编号由切片数量决定，运行时看不到那份映射；
 * 联网来源是运行时自己数出来的，所以这一条能查准。查出来只给警告，不改写回答——
 * 改写是宿主的事（内核那边会把它变成前端的黄条提示）。
 */
public func citationWarning(answer: String, webSources: Int64): String {
    var maxN: Int64 = 0
    let b = answer.toArray()
    var i: Int64 = 0
    while (i + 2 < b.size) {
        if (b[i] == 91 && (b[i + 1] == 87 || b[i + 1] == 119)) {
            var j = i + 2
            var n: Int64 = 0
            var digits = false
            while (j < b.size && b[j] >= 48 && b[j] <= 57) {
                n = n * 10 + (Int64(b[j]) - 48)
                digits = true
                j = j + 1
            }
            if (digits && j < b.size && b[j] == 93 && n > maxN) {
                maxN = n
            }
        }
        i = i + 1
    }
    if (maxN > webSources) {
        return "回答里引用了 [W" + maxN.toString() + "]，但这一轮只拿到 " + webSources.toString() + " 条联网来源"
    }
    return ""
}
