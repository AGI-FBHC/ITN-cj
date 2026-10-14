package pi_cj.pi

import std.collection.*
import stdx.encoding.json.*

/**
 * 工具。
 *
 * 运行时**不知道**具体工具怎么实现（Pi 的三层分离）：它只认识这个接口，
 * 谁把工具注册进来、工具内部读知识库还是读文件，运行时一概不管。
 * 这样"业务能力"和"Agent 循环"才拆得开，才能把运行时整体搬进别的产品。
 *
 * 字段名与内核 tools/registry.cj 的 ToolSpec 保持一致（name/title/usage/desc），
 * 只多一个 risk —— 合并进 ITN-Desktop 时两边可以合成一个类型，不用改调用点。
 *
 * 每个工具还要声明**风险等级**，这是"审批门"的挂点：
 *   read     只读（检索、取时间、算数）
 *   write    写本机（写笔记、写产物文件）
 *   external 对外发请求（联网检索）
 */
public class ToolSpec {
    public var name: String = ""
    public var title: String = ""
    public var usage: String = ""
    public var desc: String = ""
    public var risk: String = "read"

    public init(name: String, title: String, usage: String, desc: String, risk: String) {
        this.name = name
        this.title = title
        this.usage = usage
        this.desc = desc
        this.risk = risk
    }

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("name", JsonString(name))
        o.put("title", JsonString(title))
        o.put("usage", JsonString(usage))
        o.put("desc", JsonString(desc))
        o.put("risk", JsonString(risk))
        return o
    }

    /** 给模型的提示词一行：名字 + 说明 + 参数示例（与内核 toolPrompt 同一口径）。 */
    public func promptLine(): String {
        return "- " + name + "：" + desc + " 参数示例 " + usage
    }

    public func isExternal(): Bool {
        return risk == "external"
    }
}

public class ToolResult {
    public var ok: Bool = true
    public var summary: String = ""
    public var data: JsonValue = JsonNull()

    public static func good(summary: String, data: JsonValue): ToolResult {
        let r = ToolResult()
        r.ok = true
        r.summary = summary
        r.data = data
        return r
    }

    public static func bad(summary: String): ToolResult {
        let r = ToolResult()
        r.ok = false
        r.summary = summary
        return r
    }

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("ok", JsonBool(ok))
        o.put("summary", JsonString(summary))
        return o
    }
}

public interface Tool {
    func spec(): ToolSpec
    func run(args: JsonObject): ToolResult
}

/**
 * 把"一段函数"包成工具。
 *
 * 宿主注册自己的工具时最省事的一种写法（测试里也用它）：
 *   reg.add(FuncTool(ToolSpec("calc", "计算", "{...}", "四则运算", "read"),
 *                    { a: JsonObject => ToolResult.good("= 12", JsonFloat(12.0)) }))
 */
public class FuncTool <: Tool {
    private let s: ToolSpec
    private let fn: (JsonObject) -> ToolResult

    public init(s: ToolSpec, fn: (JsonObject) -> ToolResult) {
        this.s = s
        this.fn = fn
    }

    public func spec(): ToolSpec {
        return s
    }

    public func run(args: JsonObject): ToolResult {
        return fn(args)
    }
}

/** 工具不可用（没配密钥、开关关着）时的统一表达：让它出现在清单里但不给模型。 */
public class ToolAvailability {
    public var name: String = ""
    public var available: Bool = false
    public var reason: String = ""

    public init(name: String, available: Bool, reason: String) {
        this.name = name
        this.available = available
        this.reason = reason
    }
}

public class ToolRegistry {
    private let tools = ArrayList<Tool>()
    private let unavail = ArrayList<ToolAvailability>()

    public init() {}

    public func add(t: Tool): Unit {
        tools.add(t)
    }

    /** 标记某个工具当前不可用（例如没配 Tavily 密钥）：提示词里就不列它，调用也直接拒绝。 */
    public func markUnavailable(name: String, reason: String): Unit {
        unavail.add(ToolAvailability(name, false, reason))
    }

    public func available(name: String): Bool {
        for (u in unavail) {
            if (u.name == name) {
                return u.available
            }
        }
        return true
    }

    public func unavailableReason(name: String): String {
        for (u in unavail) {
            if (u.name == name) {
                return u.reason
            }
        }
        return ""
    }

    /** 这个工具是不是"对外发请求"（审批门的判据）。 */
    public func isExternal(name: String): Bool {
        match (find(name)) {
            case Some(t) => return t.spec().isExternal()
            case None => return false
        }
    }

    public func size(): Int64 {
        return tools.size
    }

    public func names(): ArrayList<String> {
        let out = ArrayList<String>()
        for (t in tools) {
            out.add(t.spec().name)
        }
        return out
    }

    public func specs(): ArrayList<ToolSpec> {
        let out = ArrayList<ToolSpec>()
        for (t in tools) {
            out.add(t.spec())
        }
        return out
    }

    public func find(name: String): ?Tool {
        for (t in tools) {
            if (t.spec().name == name) {
                return Some(t)
            }
        }
        return None
    }

    /** 按模式过滤，并剔掉"当前不可用"的：提示词里列了却调不起来，模型会反复重试同一个死工具。 */
    public func specsOf(mode: Mode): ArrayList<ToolSpec> {
        let out = ArrayList<ToolSpec>()
        for (t in tools) {
            let s = t.spec()
            if (mode.allows(s.name) && available(s.name)) {
                out.add(s)
            }
        }
        return out
    }

    /** 执行；模式不允许 / 工具不存在 / 工具不可用都返回 ok=false，而不是抛异常——运行时据此回灌给模型。 */
    public func execute(mode: Mode, name: String, args: JsonObject): ToolResult {
        if (!mode.allows(name)) {
            return ToolResult.bad("当前模式「" + mode.title + "」不允许使用工具 " + name)
        }
        if (!available(name)) {
            return ToolResult.bad("工具 " + name + " 当前不可用：" + unavailableReason(name))
        }
        match (find(name)) {
            case Some(t) =>
                try {
                    return t.run(args)
                } catch (e: Exception) {
                    return ToolResult.bad("工具执行失败：" + e.message)
                }
            case None =>
                return ToolResult.bad("没有这个工具：" + name)
        }
    }

    /** 给提示词用的工具清单。 */
    public func promptText(mode: Mode): String {
        let sb = StringBuilder()
        for (s in specsOf(mode)) {
            sb.append(s.promptLine())
            sb.append("\n")
        }
        return sb.toString()
    }
}
