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

public func modeStandard(): Mode {
    let m = Mode("standard", "标准", "只读工具 + 写本机工具，不对外发请求")
    m.allow(["kb_search", "list_documents", "read_chunk", "current_time", "calc", "save_note", "save_artifact"])
    return m
}

public func modeResearch(): Mode {
    let m = Mode("research", "研究", "标准工具 + 联网检索（对外发请求）")
    m.allow(["kb_search", "list_documents", "read_chunk", "current_time", "calc", "save_note", "save_artifact"])
    m.allow(["web_search", "web_fetch"])
    return m
}

/** 内置模式表：界面里选的就是它。 */
public func builtinModes(): ArrayList<Mode> {
    let out = ArrayList<Mode>()
    out.add(modePlain())
    out.add(modeStandard())
    out.add(modeResearch())
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
