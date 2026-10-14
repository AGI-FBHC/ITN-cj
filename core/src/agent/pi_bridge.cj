package itn_desktop_core.agent

import std.collection.*
import std.sync.*
import stdx.encoding.json.*
import itn_desktop_core.pi.*

/*
 * 中立定义层 → lumin（pi 运行时）之间的桥。
 *
 * 为什么单独一个文件：pi 那个包和内核的 tools 包**同名类型太多**（ToolSpec / ToolResult / Tool / ToolRegistry），
 * 仓颉里同一个文件同时通配导入两边会歧义、写全限定名又不认。所以：
 *   pi_tools_spec.cj  只认识内核工具，把 10 个领域工具摘成同包内的 DomainTool；
 *   这个文件          只认识 pi，把 DomainTool 包成 pi 的 FuncTool。
 * 两边只通过 DomainTool / ToolRecord 这两个普通类对话，谁也不用看见对方的同名类型。
 */

/**
 * 一次工具调用的记录。
 *
 * 为什么要留这个：pi 的事件只带一行 summary（给人看），而"引用自检"需要工具结果里的
 * **结构化载荷**（例如 kb_search 命中了哪些切片）。所以桥接的时候顺手记一份，
 * 由调用方拿去算 citations / 写事件——不让运行时为了界面去了解领域细节。
 */
public class ToolRecord {
    public var name: String = ""
    public var callId: String = ""
    public var ok: Bool = true
    public var summary: String = ""
    public var details: JsonValue = JsonNull()

    public init() {}
}

/**
 * 工具记录表的锁。
 *
 * 工具在 parallel 模式下是**多个线程一起跑**的，而 ToolRecord 表是一个普通 ArrayList ——
 * 并发 add 会丢记录（实测丢过一次 save_artifact：文件明明写出来了，产物路径却没取回来，
 * 界面于是以为模型没落盘）。加一把锁，代价可以忽略。
 */
let recordLock = Mutex()

/** 把中立工具包成 pi 的工具：失败走 isError，不抛（pi 的约定）。 */
public func piToolFromDomain(d: DomainTool, sink: ArrayList<ToolRecord>): Tool {
    let spec = ToolSpec(d.name, d.label, d.snippet, d.description, d.schema, d.risk)
    return FuncTool(spec, { callId: String, args: JsonObject =>
        let r = d.run(args)
        let rec = ToolRecord()
        rec.name = d.name
        rec.callId = callId
        rec.ok = r.ok
        rec.summary = r.summary
        rec.details = r.details
        recordLock.lock()
        sink.add(rec)
        recordLock.unlock()
        if (r.ok) {
            ToolResult.ok(r.summary, r.content, r.details)
        } else {
            ToolResult.err(if (r.summary.size > 0) { r.summary } else { r.content })
        }
    })
}

/** 这一轮的领域工具全部注册进 pi 的注册表，并顺手记录每次调用。 */
public func piRegistryOf(defs: ArrayList<DomainTool>, sink: ArrayList<ToolRecord>): ToolRegistry {
    let reg = ToolRegistry()
    for (d in defs) {
        reg.add(piToolFromDomain(d, sink))
    }
    return reg
}

/**
 * 这一轮允许用哪些工具。
 *
 * pi 的 Mode 就是一个工具名白名单；我们不用它那四档（chat/standard/research/agent）去替用户决定
 * "该不该联网"——联网与否写在工具集里（allowWeb=false 时压根不生成联网工具），
 * 这里只是把注册表里的工具名照抄进白名单。
 */
public func piModeOf(defs: ArrayList<DomainTool>, name: String): Mode {
    let m = Mode(name, name, name)
    for (d in defs) {
        m.allow([d.name])
    }
    return m
}
