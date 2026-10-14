package pi_cj.unittests

import std.collection.*
import pi_cj.pi.*
import pi_cj.tools.*
import stdx.encoding.json.*

/*
 * 测试公用夹具。
 *
 * 约定：断言里凡是直接调用库 API 的地方都走公共接口（测试包看不到 pi_cj.pi 的包内函数），
 * 这样测试同时也是"接口够不够用"的体检。
 */

/** ?String 取值（不用 Option.getOrThrow，避免不同版本 API 差异）。 */
func orEmpty(o: ?String): String {
    match (o) {
        case Some(x) => return x
        case None => return ""
    }
}

func kindsOf(events: ArrayList<PiEvent>): ArrayList<String> {
    let out = ArrayList<String>()
    for (e in events) {
        out.add(kindText(e.kind))
    }
    return out
}

func countOf(kinds: ArrayList<String>, name: String): Int64 {
    var n: Int64 = 0
    for (k in kinds) {
        if (k == name) {
            n = n + 1
        }
    }
    return n
}

/** 一轮结束的标志：事件序列里出现过 turn/end。 */
func producedTurnEnd(kinds: ArrayList<String>): Bool {
    return countOf(kinds, "turn/end") > 0
}

/** 子序列判定：要求保序，不要求相邻。 */
func hasSubseq(kinds: ArrayList<String>, seq: Array<String>): Bool {
    var i: Int64 = 0
    var j: Int64 = 0
    while (i < kinds.size && j < seq.size) {
        if (kinds[i] == seq[j]) {
            j = j + 1
        }
        i = i + 1
    }
    return j == seq.size
}

func isPrefix(prefix: String, full: String): Bool {
    let p = prefix.toArray()
    let f = full.toArray()
    if (p.size > f.size) {
        return false
    }
    var i: Int64 = 0
    while (i < p.size) {
        if (p[i] != f[i]) {
            return false
        }
        i = i + 1
    }
    return true
}

/** 把一个字符串切成"不切断字符"的片段，模拟网络分片（chunk 是字节数）。 */
func fragments(raw: String, chunk: Int64): ArrayList<String> {
    let b = raw.toArray()
    let out = ArrayList<String>()
    var i: Int64 = 0
    while (i < b.size) {
        var j = i + chunk
        if (j > b.size) {
            j = b.size
        }
        while (j < b.size && (b[j] & 192) == 128) {
            j = j + 1
        }
        out.add(String.fromUtf8(b[i..j]))
        i = j
    }
    return out
}

func hasKey(o: JsonObject, k: String): Bool {
    match (o.get(k)) {
        case Some(_) => return true
        case None => return false
    }
}

func boolOf(o: JsonObject, k: String): Bool {
    match (o.get(k)) {
        case Some(v) =>
            match (v) {
                case b: JsonBool => return b.getValue()
                case _ => return false
            }
        case None => return false
    }
}

/** 往注册表里塞一个好用的假工具。 */
func addFake(reg: ToolRegistry, name: String, risk: String): Unit {
    reg.add(FuncTool(ToolSpec(name, name, "{\"k\":\"v\"}", "测试工具 " + name, risk),
        { a: JsonObject => ToolResult.good("ok:" + name, JsonNull()) }))
}

/** 只允许一个自定义工具的模式（顺便验证"模式只做白名单过滤，不校存在性"）。 */
func onlyMode(name: String): Mode {
    let m = Mode("only-" + name, "只给一个工具", "测试用")
    m.allow([name])
    return m
}

/** 故意抛异常的工具：注册表要把它转成 ok=false，而不是让异常穿出去。 */
public class BoomTool <: Tool {
    public func spec(): ToolSpec {
        return ToolSpec("boom", "会炸的工具", "{}", "无论如何都抛异常", "read")
    }

    public func run(args: JsonObject): ToolResult {
        throw PiException("boom 抛出来的异常")
    }
}

/** 一调用就失败的模型：运行时要把模型错误转成 RunOutcome.ok = false。 */
public class FailingProvider <: ChatProvider {
    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        throw PiException("模型接口返回 404 Not Found")
    }
}

/** 假"列目录"工具：data 是字符串数组（真实工具也是这样回结构化载荷的）。 */
public class FakeListTool <: Tool {
    public func spec(): ToolSpec {
        return ToolSpec("list_files", "列出文件", "{}", "列出工作区里的文件与子目录", "read")
    }

    public func run(args: JsonObject): ToolResult {
        let arr = JsonArray()
        arr.add(JsonString("note.md  171 字节"))
        arr.add(JsonString("src/"))
        return ToolResult.good("工作区根目录 下共 2 项", arr)
    }
}

/** 模拟"原生 function calling"的模型：工具调用带 id（call_xxx），第二步才给最终回答。 */
public class NativeToolProvider <: ChatProvider {
    private var step: Int64 = 0
    private let toolName: String
    private let toolArgs: String
    public let seenToolsText = ArrayList<String>()
    public let seenSpecCounts = ArrayList<Int64>()

    public init(toolName: String, toolArgs: String) {
        this.toolName = toolName
        this.toolArgs = toolArgs
    }

    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        step = step + 1
        seenToolsText.add(ctx.tools)
        seenSpecCounts.add(ctx.toolSpecs.size)
        let r = ModelReply()
        if (step == 1) {
            let e = PiEvent(ToolCallStart)
            e.turnId = ctx.turnId
            e.step = ctx.step
            e.tool = toolName
            e.callId = "call_test01"
            stream.push(e)
            let req = ToolRequest()
            req.id = "call_test01"
            req.name = toolName
            req.args = objOf(JsonValue.fromStr(toolArgs)).getOrThrow()
            r.requests.add(req)
            r.stopReason = "tool_call"
            return r
        }
        r.text = "做完了"
        return r
    }
}

/** 造一个 {"k": "v"} 的参数对象（测试里省点字）。 */
func strObj(k: String, v: String): JsonObject {
    let o = JsonObject()
    o.put(k, JsonString(v))
    return o
}

/** 造一个 {"k1": "v1", "k2": "v2"} 的参数对象。 */
func twoObj(k1: String, v1: String, k2: String, v2: String): JsonObject {
    let o = JsonObject()
    o.put(k1, JsonString(v1))
    o.put(k2, JsonString(v2))
    return o
}

/** 一步里**并行**调两个工具的模型（实测 MiMo 就会这么干，第一版只接了第一条，第二条被丢掉）。 */
public class NativeTwoCallProvider <: ChatProvider {
    private var step: Int64 = 0

    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        step = step + 1
        let r = ModelReply()
        if (step == 1) {
            let a = ToolRequest()
            a.id = "call_a"
            a.name = "list_files"
            a.args = JsonObject()
            let b = ToolRequest()
            b.id = "call_b"
            b.name = "calc"
            b.args = strObj("expr", "1+1")
            r.requests.add(a)
            r.requests.add(b)
            r.stopReason = "tool_call"
            return r
        }
        r.text = "两件事都做了"
        return r
    }
}
