package pi_cj.pi

import std.collection.*
import stdx.encoding.json.*

/** 一次模型调用的输入。构造后按**只读**用（对应"同一 step 内上下文不可变"）。 */
public class StepContext {
    public let mode: Mode
    public var system: String = ""
    public var messages: JsonArray = JsonArray()
    /**
     * 本步的工具提示词段：可用工具清单 + "只输出一行 JSON" 的调用协议。
     * 提供方自己决定怎么用（放进 system，还是塞进 tools 字段，还是转成原生 function 定义）。
     */
    public var tools: String = ""
    public var turnId: String = ""
    public var step: Int64 = 0

    public init(mode: Mode) {
        this.mode = mode
    }
}

/** 模型请求的一次工具调用（参数已经收齐）。 */
public class ToolRequest {
    public var name: String = ""
    public var args: JsonObject = JsonObject()

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("tool", JsonString(name))
        o.put("args", args)
        return o
    }
}

public class ModelReply {
    /** 本步正文（最终回答，或"我要调工具"那句说明） */
    public var text: String = ""
    public var reasoning: String = ""
    /** 本步请求的工具调用；None = 这就是最终回答 */
    public var tool: ?ToolRequest = None
    public var stopReason: String = "stop"
    /** 原始返回（诊断用） */
    public var raw: String = ""
}

/**
 * 模型通信层（Pi 的 LLM 层，最小化版）。
 *
 * 边界约定（很重要，写实现的人要守住）：
 *   1. 提供方**自己**负责把增量事件推进 stream：text/delta、think/delta、
 *      tool/call_start、tool/call_arg、tool/call_end。工具调用的三个事件必须由
 *      提供方在流式解析时发出，运行时不再补发（否则事件重复）。
 *   2. 提供方**不碰**历史：上下文由 ctx 给全，写历史是运行时的事。
 *   3. 提供方不知道工具怎么执行，它只报"模型要调什么"。
 *
 * 这样 HTTP 细节（内核 llm.cj 的 SNI 客户端、SSE 解析）都在宿主侧，运行时保持零网络依赖，
 * 换供应商只换一个实现，循环一行都不用改。
 */
public interface ChatProvider {
    func respond(ctx: StepContext, stream: EventStream): ModelReply
}

/* ------------------------------------------------------------------ */
/* 脚本提供方：不联网，按事先写好的脚本"播放"一次模型调用。测试与离线演示用。 */
/* ------------------------------------------------------------------ */

/** 脚本里的一步：吐一段正文，或发起一次工具调用。 */
public class ScriptStep {
    public var text: String = ""
    public var reasoning: String = ""
    public var toolName: String = ""
    public var toolArgs: String = "{}"
    /** 每次喂给流式解析器的字节数（模拟网络分片，会落在汉字中间） */
    public var fragmentBytes: Int64 = 5
    /** 用 OpenAI 原生形态（arguments 是一段字符串）而不是扁平形态 */
    public var native: Bool = false

    public init(text: String) {
        this.text = text
    }
}

public func scriptText(text: String): ScriptStep {
    return ScriptStep(text)
}

public func scriptTool(name: String, argsJson: String): ScriptStep {
    let s = ScriptStep("")
    s.toolName = name
    s.toolArgs = argsJson
    return s
}

public class ScriptedProvider <: ChatProvider {
    private let steps: ArrayList<ScriptStep>
    private var cursor: Int64 = 0
    /** 每次调用看到的工具清单（断言用：验证模式过滤真的生效） */
    public let seenTools = ArrayList<String>()
    /** 每次调用看到的历史条数（断言用：验证冻结视图没被同一步里的写入污染） */
    public let seenMessageCounts = ArrayList<Int64>()
    /** 正文按几字节一片往外吐 */
    public var textChunk: Int64 = 4

    public init(steps: Array<ScriptStep>) {
        this.steps = ArrayList<ScriptStep>()
        for (s in steps) {
            this.steps.add(s)
        }
    }

    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        seenTools.add(ctx.tools)
        seenMessageCounts.add(ctx.messages.size())
        let reply = ModelReply()
        if (cursor >= steps.size) {
            reply.stopReason = "exhausted"
            return reply
        }
        let s = steps[cursor]
        cursor = cursor + 1
        if (s.reasoning.size > 0) {
            emitText(stream, ctx, ThinkDelta, s.reasoning, textChunk)
            reply.reasoning = s.reasoning
        }
        if (s.toolName.size > 0) {
            let raw = renderCall(s)
            reply.raw = raw
            let parser = PartialJsonParser()
            feedFragments(stream, ctx, parser, raw, s.fragmentBytes)
            let req = ToolRequest()
            req.name = parser.view().name
            req.args = parser.view().argsJson()
            reply.tool = Some(req)
            reply.stopReason = "tool_call"
            return reply
        }
        emitText(stream, ctx, TextDelta, s.text, textChunk)
        reply.text = s.text
        reply.raw = s.text
        return reply
    }

    public func remaining(): Int64 {
        return steps.size - cursor
    }

    /* ---------- 内部：把一段字符串切成"不切断字符"的片段吐出去 ---------- */

    private func emitText(stream: EventStream, ctx: StepContext, kind: PiEventKind, text: String, chunk: Int64): Unit {
        let b = text.toArray()
        var i: Int64 = 0
        while (i < b.size) {
            var j = i + chunk
            if (j > b.size) {
                j = b.size
            }
            // 若切点落在字符内部，往后挪到字符边界（输入一定是合法 UTF-8，所以挪到末尾也合法）
            while (j < b.size && (b[j] & 192) == 128) {
                j = j + 1
            }
            let e = PiEvent(kind)
            e.turnId = ctx.turnId
            e.step = ctx.step
            e.text = String.fromUtf8(b[i..j])
            stream.push(e)
            i = j
        }
    }

    private func feedFragments(stream: EventStream, ctx: StepContext, parser: PartialJsonParser, raw: String, chunk: Int64): Unit {
        let b = raw.toArray()
        var i: Int64 = 0
        while (i < b.size) {
            var j = i + chunk
            if (j > b.size) {
                j = b.size
            }
            while (j < b.size && (b[j] & 192) == 128) {
                j = j + 1
            }
            for (e in parser.push(String.fromUtf8(b[i..j]))) {
                e.turnId = ctx.turnId
                e.step = ctx.step
                stream.push(e)
            }
            i = j
        }
    }

    /** 扁平形态用内核的工具协议（{"tool":..,"args":..}）；原生形态包一层 function.arguments 字符串。 */
    private func renderCall(s: ScriptStep): String {
        if (s.native) {
            return "{\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"" + s.toolName +
                "\",\"arguments\":\"" + escapeJson(s.toolArgs) + "\"}}"
        }
        return "{\"tool\":\"" + s.toolName + "\",\"args\":" + s.toolArgs + "}"
    }
}
