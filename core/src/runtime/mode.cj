package itn_desktop_core.runtime

import std.collection.*

/*
 * 工具集预设（DeepSeek Harness 那套"模式 = 工具集的组合"；Pi 本身没有 mode 概念，
 * 它是"装了哪些扩展/工具就用哪些"）。这里保留四档是因为桌面端界面需要一个显式的风险旋钮：
 *
 *   chat      纯对话        —— 不给工具
 *   standard  标准（默认）  —— 读 + 写，工作区内
 *   research  研究          —— 标准 + 联网（对外发请求）
 *   agent     代理          —— 标准 + 执行本机命令
 *
 * 模式只做白名单过滤，不做存在性校验：宿主注册了哪些工具，模式允许哪些，就这样。
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

    /** 追加允许的工具名（with 是仓颉关键字，所以叫 allow）。 */
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

/** 标准档的工具清单：就是 Pi 那套文件工具。 */
func fileToolNames(): Array<String> {
    return ["read", "write", "edit", "ls", "find", "grep"]
}

public func modeChat(): Mode {
    return Mode("chat", "纯对话", "不给任何工具")
}

public func modeStandard(): Mode {
    let m = Mode("standard", "标准", "在工作区里读写文件，不对外发请求")
    m.allow(fileToolNames())
    return m
}

public func modeResearch(): Mode {
    let m = Mode("research", "研究", "标准 + 联网检索（对外发请求）")
    m.allow(fileToolNames())
    m.allow(["web_search", "web_fetch"])
    return m
}

public func modeAgent(): Mode {
    let m = Mode("agent", "代理", "标准 + 执行本机命令（能改动这台电脑）")
    m.allow(fileToolNames())
    m.allow(["powershell"])
    return m
}

/**
 * 「完全访问权限」档用：把所有**已注册**的工具都给模型（不看原来的档位）。
 * 为什么需要它：full 档不该"把 research 换成 agent"那样换来换去 —— 换一次就丢一类工具
 * （实测：切到 agent 后 web_search 不在白名单里，模型只好绕道去跑外部 CLI，白烧 token）。
 */
public func modeEverything(reg: ToolRegistry): Mode {
    let m = Mode("full", "全部工具", "完全访问权限：所有已注册的工具都可用")
    for (s in reg.allSpecs()) {
        m.allow([s.name])
    }
    return m
}

public func builtinModes(): ArrayList<Mode> {
    let out = ArrayList<Mode>()
    out.add(modeChat())
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
