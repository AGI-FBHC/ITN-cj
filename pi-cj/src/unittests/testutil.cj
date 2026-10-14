package pi_cj.unittests

import std.collection.*
import pi_cj.pi.*
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
