package itn_desktop_core.lumin_cli

import std.collection.*
import std.fs.*
import std.posix.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*

/*
 * 工作区登记表：<dataDir>/workspaces.json
 *
 * 一个"工作区"就是一个目录（沙箱根）：模型**写**只写这里（读不设界）、命令也在这里跑。
 * 顺手登记之后就能用**名字**打开：启动参数 --workspace ws2，或者对话里 /workspace open ws2。
 *
 * 会话本来就是按工作区分的（session.cj 用 --<路径>-- 当子目录），所以换工作区 = 换一份历史。
 *
 * 说明：Pi 那边是"cd 到项目里再启 pi + project trust + 项目级设置(.pi/)"，没有登记表；
 * 这个登记表是我们给 CLI 加的便利层，沙箱与设置仍然是"按目录"的。
 */

public class WorkspaceEntry {
    public var name: String = ""
    public var path: String = ""
    public var lastUsed: Int64 = 0
}

public func workspacesFile(dataDir: String): String {
    return dataDir + "/workspaces.json"
}

/** 相对路径补成绝对路径（基于进程当前目录）。 */
public func absPath(p: String): String {
    var t = trimStr(p)
    // 归一化掉末尾分隔符与 "."（"."、"./"、"x/."），免得提示里出现 "D:\...\lumin/."
    // 保留 2 字符以上：别把盘根 "D:/" 削成 "D:" 之外的东西
    while (t.size > 1 && (hasSuffix(t, "/") || hasSuffix(t, "\\"))) {
        // "D:/" 这种盘根保留（否则会削成 "D:"）
        if (t.size == 3 && t.toArray()[1] == 58) {
            break
        }
        t = safeUtf8(t.toArray(), 0, t.size - 1)
    }
    while (t.size >= 2 && hasSuffix(t, "/.")) {
        t = safeUtf8(t.toArray(), 0, t.size - 2)
    }
    if (t == "." || t.size == 0) {
        return getcwd().toString()
    }
    let b = t.toArray()
    // 盘符（D:\...）或已经是绝对路径就直接用
    if (b.size >= 2 && b[1] == 58) {
        return t
    }
    if (b[0] == 47 || b[0] == 92) {
        return t
    }
    return getcwd().toString() + "/" + t
}

/** 拼绝对路径（相对路径挂到 root 下；已绝对的直接用）。 */
public func joinPath(root: String, rel: String): String {
    let b = rel.toArray()
    if (b.size >= 2 && b[1] == 58) {
        return rel
    }
    if (b.size > 0 && (b[0] == 47 || b[0] == 92)) {
        return rel
    }
    if (root.size == 0) {
        return rel
    }
    return root + "/" + rel
}

/** 用目录名当默认的工作区名。 */
public func defaultWorkspaceName(path: String): String {
    let b = path.toArray()
    var end = b.size
    while (end > 0 && (b[end - 1] == 47 || b[end - 1] == 92)) {
        end = end - 1
    }
    var start = end
    while (start > 0 && b[start - 1] != 47 && b[start - 1] != 92) {
        start = start - 1
    }
    let nm = safeUtf8(b, start, end)
    if (nm.size == 0) {
        return "workspace"
    }
    return nm
}

public func loadWorkspaces(dataDir: String): ArrayList<WorkspaceEntry> {
    let out = ArrayList<WorkspaceEntry>()
    var text = ""
    try {
        text = safeUtf8(File.readFrom(workspacesFile(dataDir)), 0, 1024 * 1024)
    } catch (e: Exception) {
        return out
    }
    let t = trimStr(text)
    if (t.size == 0) {
        return out
    }
    try {
        match (JsonValue.fromStr(t)) {
            case root: JsonObject =>
                match (root.get("workspaces")) {
                    case Some(v) =>
                        match (v) {
                            case arr: JsonArray =>
                                var i: Int64 = 0
                                while (i < arr.size()) {
                                    match (arr[i]) {
                                        case e: JsonObject =>
                                            let w = WorkspaceEntry()
                                            w.name = strOf(e, "name")
                                            w.path = strOf(e, "path")
                                            w.lastUsed = intOf(e, "lastUsed")
                                            if (w.name.size > 0 && w.path.size > 0) {
                                                out.add(w)
                                            }
                                        case _ => ()
                                    }
                                    i = i + 1
                                }
                            case _ => ()
                        }
                    case None => ()
                }
            case _ => ()
        }
    } catch (e: Exception) {
        ()
    }
    return out
}

public func saveWorkspaces(dataDir: String, list: ArrayList<WorkspaceEntry>): Unit {
    let arr = JsonArray()
    for (w in list) {
        let o = JsonObject()
        o.put("name", JsonString(w.name))
        o.put("path", JsonString(w.path))
        o.put("lastUsed", JsonInt(w.lastUsed))
        arr.add(o)
    }
    let root = JsonObject()
    root.put("workspaces", arr)
    if (!exists(dataDir)) {
        try {
            Directory.create(dataDir, recursive: true)
        } catch (e: Exception) {
            return
        }
    }
    try {
        File.writeTo(workspacesFile(dataDir), root.toString().toArray())
    } catch (e: Exception) {
        ()
    }
}

/** 登记或更新（按绝对路径去重；重名会被后来的顶掉）。返回登记后的名字。 */
public func registerWorkspace(dataDir: String, path: String, name: String): String {
    let full = absPath(path)
    let list = loadWorkspaces(dataDir)
    let nm = if (name.size > 0) { trimStr(name) } else { defaultWorkspaceName(full) }
    var found = false
    for (w in list) {
        if (w.path == full) {
            // 已登记过：只在显式给了新名字时才改名（空名字表示"沿用原来的"）
            if (name.size > 0) {
                w.name = nm
            }
            w.lastUsed = nowMillis()
            found = true
        } else if (name.size > 0 && w.name == nm) {
            // 名字被别的目录占了：让新来的换一个，避免 /workspace open 有歧义
            w.name = nm + "-" + (w.path.size).toString()
        }
    }
    if (!found) {
        let w = WorkspaceEntry()
        w.name = nm
        w.path = full
        w.lastUsed = nowMillis()
        list.add(w)
    }
    saveWorkspaces(dataDir, list)
    return nm
}

public func findWorkspace(dataDir: String, nameOrPath: String): ?WorkspaceEntry {
    let q = trimStr(nameOrPath)
    let list = loadWorkspaces(dataDir)
    for (w in list) {
        if (w.name == q) {
            return Some(w)
        }
    }
    let full = absPath(q)
    for (w in list) {
        if (w.path == full) {
            return Some(w)
        }
    }
    return None
}

/** 解析 --workspace：先当登记名找，找不到就当路径，并顺手登记。返回绝对路径。 */
public func resolveWorkspace(dataDir: String, nameOrPath: String): String {
    match (findWorkspace(dataDir, nameOrPath)) {
        case Some(w) => return w.path
        case None => ()
    }
    let full = absPath(nameOrPath)
    registerWorkspace(dataDir, full, "")
    return full
}

/** 取消登记（不删目录）。 */
public func removeWorkspace(dataDir: String, name: String): Bool {
    let list = loadWorkspaces(dataDir)
    let keep = ArrayList<WorkspaceEntry>()
    var removed = false
    for (w in list) {
        if (w.name == trimStr(name)) {
            removed = true
        } else {
            keep.add(w)
        }
    }
    if (removed) {
        saveWorkspaces(dataDir, keep)
    }
    return removed
}

/** 这个工作区登记了多少个会话文件（列表里显示用）。 */
public func sessionCountOf(dataDir: String, path: String): Int64 {
    return listSessionFiles(dataDir, path).size
}
