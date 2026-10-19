package itn_desktop_core.lumin_cli

import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*

/*
 * 权限档位（照 Codex 那三档）：
 *
 *   ask   请求批准     —— 读整机；写只在本工作区（越界先问你）；跑命令要显式开 --allow-exec；联网要 research 档
 *   auto  帮我批准     —— 写也不再限制在工作区内：**写工作区外/跑命令前问一次**（检测到的风险操作才问）
 *   full  完全访问权限  —— 不受限制地读写这台电脑上的文件、跑命令（截图里那一档）
 *
 * full 里我们仍留**一条硬红线**：不把模型自己在用的那个 API Key 交出去
 * （配置里读到的 .env.local / 数据目录里的东西）。理由很实在：泄了就是别人花你的额度。
 * 这条在界面上会写出来，别的都放开。
 *
 * 档位会记在 <dataDir>/settings.json，下次启动沿用；命令行 --permissions 覆盖它。
 */

public class PermissionMode {
    public var name: String = ""
    public var title: String = ""
    public var description: String = ""

    public init(name: String, title: String, description: String) {
        this.name = name
        this.title = title
        this.description = description
    }
}

public func builtinPermissionModes(): ArrayList<PermissionMode> {
    let out = ArrayList<PermissionMode>()
    out.add(PermissionMode("ask", "请求批准", "编辑外部文件和使用互联网时始终询问"))
    out.add(PermissionMode("auto", "帮我批准", "仅对检测到的风险操作请求批准"))
    out.add(PermissionMode("full", "完全访问权限", "可不受限制地访问互联网和你电脑上的任何文件"))
    return out
}

public func findPermissionMode(name: String): ?PermissionMode {
    for (m in builtinPermissionModes()) {
        if (m.name == name) {
            return Some(m)
        }
    }
    return None
}

public func permissionModeText(name: String): String {
    match (findPermissionMode(name)) {
        case Some(m) => return m.title + "（" + name + "）：" + m.description
        case None => return name + "（未知档位）"
    }
}

/** 这一档要不要限制在工作区内。 */
public func sandboxedBy(name: String): Bool {
    return name == "ask"
}

/* ---------- 持久化：<dataDir>/settings.json ---------- */

func settingsFile(dataDir: String): String {
    return dataDir + "/settings.json"
}

public func loadPermissionSetting(dataDir: String): String {
    var text = ""
    try {
        text = safeUtf8(File.readFrom(settingsFile(dataDir)), 0, 1024 * 1024)
    } catch (e: Exception) {
        return ""
    }
    let t = trimStr(text)
    if (t.size == 0) {
        return ""
    }
    try {
        match (JsonValue.fromStr(t)) {
            case o: JsonObject =>
                match (o.get("permissions")) {
                    case Some(v) =>
                        match (v) {
                            case s: JsonString => return s.getValue()
                            case _ => return ""
                        }
                    case None => return ""
                }
            case _ => return ""
        }
    } catch (e: Exception) {
        return ""
    }
}

public func savePermissionSetting(dataDir: String, name: String): Unit {
    let root = JsonObject()
    root.put("permissions", JsonString(name))
    if (!exists(dataDir)) {
        try {
            Directory.create(dataDir, recursive: true)
        } catch (e: Exception) {
            return
        }
    }
    try {
        File.writeTo(settingsFile(dataDir), root.toString().toArray())
    } catch (e: Exception) {
        ()
    }
}
