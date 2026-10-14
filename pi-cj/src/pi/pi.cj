package pi_cj.pi

import std.collection.*
import stdx.encoding.json.*

/**
 * 门面层：宿主（ITN-Desktop 内核，或别的产品）只认这一层。
 *
 * 一个会话 = 一套工具注册表 + 一份历史 + 一个当前模式。界面换模式就是换一组工具，
 * 换会话就是换一个 PiSession。
 */

public func piVersion(): String {
    return "pi-cj 0.1.0"
}

/** 给模型的工具协议说明。口径与内核 tools/registry.cj 的 toolPrompt 完全一致，合并时两处应合成一个函数。 */
public func toolProtocolText(reg: ToolRegistry, mode: Mode): String {
    let sb = StringBuilder()
    sb.append("你可以调用以下工具来获取事实（不要凭空猜）：\n")
    sb.append(reg.promptText(mode))
    sb.append("\n需要调用工具时，**只输出一行 JSON**（不要写别的文字、不要加代码围栏）：\n")
    sb.append("{\"tool\":\"工具名\",\"args\":{...}}\n")
    sb.append("拿到工具结果后，再基于结果给出最终回答。不需要调用工具时，直接回答问题。\n")
    return sb.toString()
}

public class PiSession {
    public let registry = ToolRegistry()
    public let history = History()
    public var mode: Mode = modeStandard()
    public var config = RunConfig()
    /** 宿主自己的系统提示词；为空则只用工具协议说明 */
    public var systemPrompt: String = ""
    private var turnSeq: Int64 = 0

    public init() {}

    public init(mode: Mode) {
        this.mode = mode
    }

    public func register(t: Tool): PiSession {
        registry.add(t)
        return this
    }

    public func switchMode(name: String): Bool {
        match (findMode(name)) {
            case Some(m) =>
                this.mode = m
                return true
            case None =>
                return false
        }
    }

    /**
     * 这一步的系统提示词 = 宿主自己的角色设定。
     *
     * 工具清单与调用协议**不放在这里**，而是由运行时通过 StepContext.tools 交给提供方：
     * 用提示词协议的提供方把它拼到 system 后面；支持原生 function calling 的提供方把它转成
     * tools 数组。分开之后，两边都不会重复写同一段文字。
     */
    public func systemText(): String {
        return systemPrompt
    }

    /** 当前模式下的工具提示词段（清单 + "只输出一行 JSON" 协议）。 */
    public func toolsText(): String {
        return toolProtocolText(registry, mode)
    }

    /**
     * 跑一轮。事件从 stream 实时取（界面用），结果对象给会话日志用（落 session_events）。
     * 调用方拿到 stream 后要先 on(...) 注册消费者。
     */
    public func ask(text: String, provider: ChatProvider, stream: EventStream): RunOutcome {
        turnSeq = turnSeq + 1
        config.turnId = "t" + turnSeq.toString()
        config.system = systemText()
        let runner = PiRunner(registry, history, provider)
        return runner.run(text, mode, config, stream)
    }

    public func turns(): Int64 {
        return turnSeq
    }
}
