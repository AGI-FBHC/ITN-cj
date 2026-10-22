package lumin.pi

import std.collection.*
import stdx.encoding.json.*

/*
 * 模型通信层（Pi 的 StreamFn / Models）。
 *
 * 契约（照 Pi 写）：
 *  - 提供方**自己**把 message_update 事件推进 stream（text_delta / thinking_delta / toolcall_delta）；
 *  - 失败不要抛异常，填 stopReason = "error" 与 errorMessage，由主循环转成一轮失败；
 *  - 工具参数是半截 JSON 流式到达，边到边解析（Pi 的 toolcall_delta），最终填进 ToolCallBlock.argsJson。
 */

/** 一次模型请求的输入。 */
public class StepContext {
    public var model: String = ""
    /** 系统提示词最终文本（由 sections 拼出来） */
    public var system: String = ""
    public let messages = ArrayList<Message>()
    public var tools = ArrayList<ToolSpec>()
    public var turn: Int64 = 0
    public var cwd: String = ""
}

public class ModelReply {
    public var text: String = ""
    public var thinking: String = ""
    public let toolCalls = ArrayList<ToolCallBlock>()
    /** stop / length / toolUse / aborted / error */
    public var stopReason: String = "stop"
    public var errorMessage: String = ""
    public var usageIn: Int64 = 0
    public var usageOut: Int64 = 0
}

public interface ChatProvider {
    func respond(ctx: StepContext, stream: EventStream): ModelReply
}
