package itn_desktop_core.unittests

import std.collection.*
import std.fs.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*
import itn_desktop_core.workspace_tools.*

/* 测试公用夹具。 */

func orEmpty(o: ?String): String {
    match (o) {
        case Some(x) => return x
        case None => return ""
    }
}

/** 事件序列 -> 类型名列表（断言顺序用）。 */
func kindsOf(events: ArrayList<AgentEvent>): ArrayList<String> {
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

/** 子序列判定：保序不要求相邻。 */
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

func strObj(k: String, v: String): JsonObject {
    let o = JsonObject()
    o.put(k, JsonString(v))
    return o
}

func twoObj(k1: String, v1: String, k2: String, v2: String): JsonObject {
    let o = JsonObject()
    o.put(k1, JsonString(v1))
    o.put(k2, JsonString(v2))
    return o
}

/** 注册表里某个名字的工具是否在这一档的清单里。 */
func exposes(reg: ToolRegistry, mode: Mode, name: String): Bool {
    for (s in reg.specsOf(mode)) {
        if (s.name == name) {
            return true
        }
    }
    return false
}

/** 每个用例一个全新目录（跑在 target/ 下，已被 gitignore）。 */
var dirSeq: Int64 = 0

func freshDir(name: String): String {
    dirSeq = dirSeq + 1
    // 毫秒 + 计数：同一次运行内唯一，重复运行也不会撞上上次留下的目录
    let d = "target/ut/" + name + "-" + (nowMillis() % 1000000).toString() + "-" + dirSeq.toString()
    if (!exists(d)) {
        Directory.create(d, recursive: true)
    }
    return d
}

/** 直接写文件（绕过工作区工具，用来铺测试数据）。 */
func fsWrite(path: String, text: String): Unit {
    File.writeTo(path, text.toArray())
}

/** 读整个文本文件（测试里读会话文件用）。 */
func slurp(path: String): String {
    try {
        return String.fromUtf8(File.readFrom(path))
    } catch (e: Exception) {
        return ""
    }
}

/** 收集一次流里的事件，供断言用。 */
func collect(run: (EventStream) -> Unit): ArrayList<AgentEvent> {
    let s = EventStream()
    run(s)
    return s.drain()
}

/** 一个总是失败的工具（测错误路径）。 */
public class BoomTool <: Tool {
    public func spec(): ToolSpec {
        return ToolSpec("boom", "会炸的工具", "Always fails", "无论如何都失败。",
            "{\"type\":\"object\",\"properties\":{}}", "read")
    }

    public func run(callId: String, args: JsonObject): ToolResult {
        return ToolResult.err("boom 按计划失败了")
    }
}

/** 只给一个自定义工具的工具集。 */
func onlyMode(name: String): Mode {
    let m = Mode("only-" + name, "只给一个", "测试用")
    m.allow([name])
    return m
}

/** 一步里回**两条**工具调用的提供方（实测 MiMo 会这么干；漏接第二条会引发重试风暴）。 */
public class TwoCallProvider <: ChatProvider {
    private var step: Int64 = 0

    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        step = step + 1
        let r = ModelReply()
        if (step == 1) {
            r.toolCalls.add(ToolCallBlock("call_a", "twice", "{\"text\":\"a\"}"))
            r.toolCalls.add(ToolCallBlock("call_b", "twice", "{\"text\":\"b\"}"))
            r.stopReason = "toolUse"
            let partial = Message(AssistantMsg)
            for (tc in r.toolCalls) {
                partial.toolCalls.add(tc)
            }
            stream.push(evMessageUpdate(deltaToolCallStart(), "", partial))
            return r
        }
        r.text = "两件都做了"
        return r
    }
}
