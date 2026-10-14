package itn_desktop_core.pi_app

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.Store
import itn_desktop_core.pi.strOf
import itn_desktop_core.pi.intOf
import itn_desktop_core.pi_tools.Workspace
import itn_desktop_core.pi_tools.registerWorkspaceTools
import itn_desktop_core.pi.ToolRegistry
import itn_desktop_core.pi.ToolSpec

/*
 * 工具清单（给"工具与技能"面板看）。
 *
 * 与 /api/tools/list 的分工：那个接口列的是"领域工具"（检索/联网/笔记/产物），
 * 这里补上"工作区工具"（read/write/edit/ls/find/grep[/powershell]）——但它们**只在指定了工作目录之后**才会真的发给模型，
 * 所以这份清单也照着这个条件给：没指定就一个都不列。
 * 两份合起来才是"这一轮模型真正能用的东西"，面板上按分组显示，不让用户猜。
 */

func specJson(s: ToolSpec): JsonObject {
    let o = JsonObject()
    o.put("name", JsonString(s.name))
    o.put("label", JsonString(s.label))
    o.put("snippet", JsonString(s.snippet))
    o.put("desc", JsonString(s.description))
    o.put("risk", JsonString(s.risk))
    o.put("available", JsonBool(true))
    o.put("group", JsonString("本机文件"))
    return o
}

/** 工作目录下这一轮会给模型的工具；没指定工作目录就返回空数组。 */
public func workspaceToolList(dataDir: String, workDir: String, allowExec: Bool, perm: String): JsonArray {
    let arr = JsonArray()
    if (workDir.size == 0) {
        return arr
    }
    let denyRoots = ArrayList<String>()
    denyRoots.add(dataDir)
    let denyFiles = ArrayList<String>()
    denyFiles.add(".env")
    denyFiles.add(".env.local")
    let ws = Workspace(workDir, denyRoots, denyFiles, perm)
    let reg = ToolRegistry()
    registerWorkspaceTools(reg, ws, allowExec && perm != "ask")
    for (s in reg.allSpecs()) {
        arr.add(specJson(s))
    }
    return arr
}
