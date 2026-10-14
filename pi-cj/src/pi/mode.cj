package pi_cj.pi

import std.collection.*

/**
 * 模式 = 工具集的组合（从 DeepSeek Harness 借的第 4 条）。
 *
 * 同一套运行时，换一组工具就是另一种用法：
 *   极简   plain     —— 不给工具，纯对话（验证最小可用）
 *   标准   standard  —— 只读工具 + 写本机工具（默认）
 *   研究   research  —— 标准 + 对外发请求的工具（联网），需要用户显式开启
 *
 * 工具名不在任何模式里也没关系：模式只做**白名单过滤**，不做存在性校验，
 * 这样宿主注册新工具时不必回来改模式定义。
 *
 * 命名踩坑：方法不能叫 with —— with 是仓颉关键字，写成 x.with([...]) 会被当成限定名去解析，
 * 编译器报 "expected a member name after '.' in qualified name"；所以这里叫 allow，且不做链式调用。
 */
public class Mode {
    public var name: String = ""
    public var title: String = ""
    public var description: String = ""
    public let toolNames = ArrayList<String>()

    public init(name: String, title: String, description: String) {
        this.name = name
        this.title = title
        this.description = description
    }

    /** 追加允许的工具名；返回自身，宿主可以继续追加。 */
    public func allow(names: Array<String>): Mode {
        for (n in names) {
            toolNames.add(n)
        }
        return this
    }

    public func allows(toolName: String): Bool {
        for (n in toolNames) {
            if (n == toolName) {
                return true
            }
        }
        return false
    }

    public func toolCount(): Int64 {
        return toolNames.size
    }
}

public func modePlain(): Mode {
    return Mode("plain", "极简", "纯对话：不给任何工具")
}

/**
 * 「标准」模式的本机工具清单。
 *
 * 前半段（kb_search…save_artifact）是内核 tools/registry.cj 那 8 件，合并过去时名字能对上；
 * 后半段是 Pi 风格的"读-写-改-搜"文件工具（pi_cj.tools 里实现）。
 * 两种名字并存是刻意的：宿主注册了哪些工具，模式就允许哪些，模式只做白名单过滤。
 */
func localToolNames(): Array<String> {
    return ["kb_search", "list_documents", "read_chunk", "current_time", "calc", "save_note", "save_artifact",
        "read_file", "list_files", "search_text", "write_file", "edit_file"]
}

public func modeStandard(): Mode {
    let m = Mode("standard", "标准", "只读工具 + 写本机文件，不对外发请求")
    m.allow(localToolNames())
    return m
}

public func modeResearch(): Mode {
    let m = Mode("research", "研究", "标准 + 联网检索（对外发请求）")
    m.allow(localToolNames())
    m.allow(["web_search", "web_fetch"])
    return m
}

/** 「代理」：标准 + 跑本机命令。风险等级最高的一档，必须用户显式切过来。 */
public func modeAgent(): Mode {
    let m = Mode("agent", "代理", "标准 + 执行本机命令（能改动你的电脑）")
    m.allow(localToolNames())
    m.allow(["run_command"])
    return m
}

/** 内置模式表：界面里选的就是它。四档风险由低到高：极简 / 标准 / 研究 / 代理。 */
public func builtinModes(): ArrayList<Mode> {
    let out = ArrayList<Mode>()
    out.add(modePlain())
    out.add(modeStandard())
    out.add(modeResearch())
    out.add(modeAgent())
    return out
}

public func findMode(name: String): ?Mode {
    for (m in builtinModes()) {
        if (m.name == name) {
            return Some(m)
        }
    }
    return None
}
