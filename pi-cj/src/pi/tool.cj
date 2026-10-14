package pi_cj.pi

import std.collection.*
import stdx.encoding.json.*

/*
 * 工具：形状照 Pi 的 AgentTool。
 *
 *   name / label / description / parameters(JSON Schema) / execute(callId, params)
 *
 * 参数 schema 是**显式**的 JSON Schema（Pi 用 TypeBox），直接放进请求的 tools 字段发给服务端，
 * 不再靠"参数示例"去猜类型。工具结果里 content 是给模型的正文、details 是给我们自己看的结构化载荷
 * —— 这两者的分工是 Pi 定死的，混起来就会出现"模型看不到数据"（我们踩过）。
 */

public class ToolSpec {
    public var name: String = ""
    /** 界面上显示的名字（Pi 的 label） */
    public var label: String = ""
    /** 系统提示词里那一行短说明（Pi 的 snippet） */
    public var snippet: String = ""
    public var description: String = ""
    /** 使用要点，会以要点列表的形式进系统提示词（Pi 的 guidelines） */
    public var guidelines: Array<String> = []
    /** 参数 JSON Schema 文本，例如 {"type":"object","properties":{...}} */
    public var parameters: String = "{\"type\":\"object\",\"properties\":{}}"
    /** 风险档：read / write / external（我们自己的审批挂点） */
    public var risk: String = "read"

    public init(name: String, label: String, snippet: String, description: String, parameters: String, risk: String) {
        this.name = name
        this.label = label
        this.snippet = snippet
        this.description = description
        this.parameters = parameters
        this.risk = risk
    }

    public func parametersJson(): JsonObject {
        try {
            match (JsonValue.fromStr(parameters)) {
                case o: JsonObject => return o
                case _ => return JsonObject()
            }
        } catch (e: Exception) {
            return JsonObject()
        }
    }

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("name", JsonString(name))
        o.put("label", JsonString(label))
        o.put("description", JsonString(description))
        o.put("parameters", parametersJson())
        o.put("risk", JsonString(risk))
        return o
    }

    public func isExternal(): Bool {
        return risk == "external"
    }
}

public class ToolResult {
    /** true 表示这次调用失败（Pi 的 isError）：模型看到的 content 是错误说明 */
    public var isError: Bool = false
    /** 回灌给模型的正文 */
    public var content: String = ""
    /** 结构化载荷，给界面/程序用，不进模型上下文 */
    public var details: JsonValue = JsonNull()
    /** 一行给人看的摘要 */
    public var summary: String = ""

    public static func ok(summary: String, content: String, details: JsonValue): ToolResult {
        let r = ToolResult()
        r.summary = summary
        r.content = content
        r.details = details
        return r
    }

    public static func err(message: String): ToolResult {
        let r = ToolResult()
        r.isError = true
        r.summary = message
        r.content = message
        return r
    }

    /** 回灌给模型的文本（缺 content 时退回 summary），按字节截断。 */
    public func modelText(): String {
        var t = content
        if (t.size == 0) {
            t = flattenJson(details)
        }
        if (t.size == 0) {
            t = summary
        }
        return byteSafePrefix(t, 50000)
    }
}

/** 把 JSON 摊成纯文本：字符串原样、数组逐项换行。 */
public func flattenJson(v: JsonValue): String {
    match (v) {
        case s: JsonString => return s.getValue()
        case a: JsonArray =>
            var out = ""
            var i = 0
            while (i < a.size()) {
                let piece = flattenJson(a[i])
                if (piece.size > 0) {
                    if (out.size > 0) {
                        out = out + "\n"
                    }
                    out = out + piece
                }
                i = i + 1
            }
            return out
        case _ => return ""
    }
}

public interface Tool {
    func spec(): ToolSpec
    /** callId 是服务端给的调用 id；返回错误要放在 ToolResult.isError 里，不要抛。 */
    func run(callId: String, args: JsonObject): ToolResult
}

/** 把一段函数包成工具（Pi 的 createTool 那种写法，最省事）。 */
public class FuncTool <: Tool {
    private let s: ToolSpec
    private let fn: (String, JsonObject) -> ToolResult

    public init(s: ToolSpec, fn: (String, JsonObject) -> ToolResult) {
        this.s = s
        this.fn = fn
    }

    public func spec(): ToolSpec {
        return s
    }

    public func run(callId: String, args: JsonObject): ToolResult {
        return fn(callId, args)
    }
}

/** 工具当前不可用（没配密钥、开关关着）：出现在清单里但不发给模型。 */
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

    public func size(): Int64 {
        return tools.size
    }

    public func find(name: String): ?Tool {
        for (t in tools) {
            if (t.spec().name == name) {
                return Some(t)
            }
        }
        return None
    }

    public func allSpecs(): ArrayList<ToolSpec> {
        let out = ArrayList<ToolSpec>()
        for (t in tools) {
            out.add(t.spec())
        }
        return out
    }

    /** 模式（工具集白名单）+ 可用性双重过滤后，真正发给模型的那些。 */
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

    public func isExternal(name: String): Bool {
        match (find(name)) {
            case Some(t) => return t.spec().isExternal()
            case None => return false
        }
    }

    /** 执行；模式不允许 / 不存在 / 不可用都返回 isError，不抛。 */
    public func execute(mode: Mode, callId: String, name: String, args: JsonObject): ToolResult {
        if (!mode.allows(name)) {
            return ToolResult.err("当前工具集不允许使用工具 " + name)
        }
        if (!available(name)) {
            return ToolResult.err("工具 " + name + " 当前不可用：" + unavailableReason(name))
        }
        match (find(name)) {
            case Some(t) =>
                try {
                    return t.run(callId, args)
                } catch (e: Exception) {
                    return ToolResult.err("工具执行失败：" + e.message)
                }
            case None =>
                return ToolResult.err("没有这个工具：" + name)
        }
    }
}
