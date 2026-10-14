package pi_cj.pi

import std.collection.*
import stdx.encoding.json.*

/**
 * 细粒度事件。
 *
 * 为什么要有它：模型的响应不是一个字符串，而是"正文增量 / 思考增量 / 工具调用增量 / 工具结果 / 结束"
 * 这样一串事件。界面想看实时的，会话日志想看持久的，两边消费同一串事件——
 * 这就是从 Pi Agent 借的「事件流」：生产者推，消费者按序取，末尾还能拿到完整结果。
 *
 * 仓颉 1.2 没有 async/await，所以这里用「同步推送 + 顺序消费」等价实现（语义一致：按序、可中止、可拿最终结果）。
 */
public enum PiEventKind {
    | TurnStart      // 一轮开始
    | StepStart      // 一步开始（模型调用 / 工具执行）
    | StepEnd
    | TextDelta      // 正文增量
    | ThinkDelta     // 思考增量（部分供应商会把 reasoning 单独回）
    | ToolCallStart  // 工具名已知（参数还在流式到达）
    | ToolCallArg    // 某个参数键值已完整（或字符串值的一小段）
    | ToolCallEnd    // 参数收齐，可以执行了
    | ToolResult     // 工具执行结果
    | TurnEnd        // 一轮结束（ok / message / 最终正文）
}

public class PiEvent {
    public let kind: PiEventKind
    /** 事件归属：轮 id / 步序号，便于消费者按轮分组 */
    public var turnId: String = ""
    public var step: Int64 = 0
    /** 正文/思考增量、工具名、参数键……按 kind 解释 */
    public var text: String = ""
    /** 工具名或工具结果里的工具名 */
    public var tool: String = ""
    /** 工具调用 id（原生 function calling 才有；用来把"调用"和"结果"对上） */
    public var callId: String = ""
    /** 参数键 */
    public var key: String = ""
    /** 参数值（已能解析出来的部分） */
    public var value: String = ""
    /** 参数是否已完整（false = 这是流式到达的一部分） */
    public var complete: Bool = true
    /** 工具是否成功 */
    public var ok: Bool = true
    public var at: String = ""

    public init(kind: PiEventKind) {
        this.kind = kind
    }

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("kind", JsonString(kindText(kind)))
        if (turnId.size > 0) { o.put("turnId", JsonString(turnId)) }
        if (step > 0) { o.put("step", JsonInt(step)) }
        if (text.size > 0) { o.put("text", JsonString(text)) }
        if (tool.size > 0) { o.put("tool", JsonString(tool)) }
        if (callId.size > 0) { o.put("callId", JsonString(callId)) }
        if (key.size > 0) { o.put("key", JsonString(key)) }
        if (value.size > 0) { o.put("value", JsonString(value)) }
        if (!complete) { o.put("complete", JsonBool(false)) }
        if (!ok) { o.put("ok", JsonBool(false)) }
        if (at.size > 0) { o.put("at", JsonString(at)) }
        return o
    }
}

public func kindText(k: PiEventKind): String {
    match (k) {
        case TurnStart => return "turn/start"
        case StepStart => return "step/start"
        case StepEnd => return "step/end"
        case TextDelta => return "text/delta"
        case ThinkDelta => return "think/delta"
        case ToolCallStart => return "tool/call_start"
        case ToolCallArg => return "tool/call_arg"
        case ToolCallEnd => return "tool/call_end"
        case ToolResult => return "tool/result"
        case TurnEnd => return "turn/end"
    }
}