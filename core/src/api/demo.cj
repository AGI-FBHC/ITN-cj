package itn_desktop_core.api

import std.collection.*
import std.fs.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.store.*
import itn_desktop_core.db.DbHub
import itn_desktop_core.util.*

/*
 * 演示模式（LUMIN_DEMO=1）专用：准备一个可写、可审批、可复现的本地工作区。
 *
 * 这些接口在普通启动下返回 404，不改变任何默认行为。
 */

/**
 * 演示工作区必须**放在数据目录之外**：数据目录本身是 Workspace 的保护根，
 * 放在里面会被沙箱当成“模型配置/会话目录”拒绝，看起来就像所有文件都读不了。
 */
public func demoWorkDir(dataDir: String): String {
    // 注意不能用 dataDir + "-demo"：沙箱的保护判断是路径前缀，
    // 前缀相同的兄弟目录仍会被当成“数据目录内部”，表现为所有文件都读不了。
    let parent = Path(dataDir).parent.toString()
    let name = Path(dataDir).fileName.toString()
    return parent + "/lumin-demo-workspace-" + name
}

func approvalRuleCount(dataDir: String): Int64 {
    let path = dataDir + "/approvals.json"
    if (!exists(path)) {
        return 0
    }
    try {
        match (JsonValue.fromStr(String.fromUtf8(File.readFrom(path)))) {
            case root: JsonObject =>
                match (root.get("rules")) {
                    case Some(v) =>
                        match (v) {
                            case arr: JsonArray => return arr.size()
                            case _ => return 0
                        }
                    case None => return 0
                }
            case _ => return 0
        }
    } catch (e: Exception) {
        return 0
    }
}

func clearApprovalRules(dataDir: String): Unit {
    let path = dataDir + "/approvals.json"
    let empty = JsonObject()
    empty.put("rules", JsonArray())
    try {
        File.writeTo(path, empty.toString().toArray())
    } catch (e: Exception) {
        ()
    }
}

func writeDemoFile(path: String, content: String): Unit {
    // 演示准备是可重复的：每次点“准备演示环境”都把样张恢复原样，
    // 否则上一场改过的文件会让下一场无法复现。
    try {
        File.writeTo(path, content.toArray())
    } catch (e: Exception) {
        ()
    }
}

func seedDemoWorkspace(root: String): Unit {
    if (!exists(root)) {
        try { Directory.create(root, recursive: true) } catch (e: Exception) { () }
    }
    let notes = root + "/notes"
    if (!exists(notes)) {
        try { Directory.create(notes, recursive: true) } catch (e: Exception) { () }
    }
    writeDemoFile(root + "/README.md",
        "# Lumin 演示工作区\n\n这是演示专用的本地目录。\n\n" +
        "- 所有读写都发生在这里；\n" +
        "- 越界写、跑命令会先征求你的同意；\n" +
        "- 演示结束后可以直接删除整个目录。\n")
    writeDemoFile(notes + "/RAG-学习笔记.md",
        "# RAG 学习笔记\n\n## 它解决什么问题\n\n" +
        "大模型的知识停在训练截止日，也不了解你的私有资料。检索增强生成（RAG）" +
        "先从你的资料里找出相关片段，再让模型基于这些片段回答。\n\n" +
        "## 三个关键环节\n\n" +
        "1. 切片：把长文档拆成可检索的小段；\n" +
        "2. 召回：按语义或关键词找出最相关的几段；\n" +
        "3. 生成：把片段放进上下文，要求模型标注出处。\n\n" +
        "## 常见误区\n\n" +
        "- 切片越大越好：错，噪声会挤占上下文；\n" +
        "- 召回越多越好：错，无关片段会干扰判断。\n")
    writeDemoFile(notes + "/检索实验记录.md",
        "# 检索实验记录\n\n| 查询 | 召回数 | 命中 |\n|---|---|---|\n" +
        "| RAG 的局限 | 6 | 4 |\n| 切片大小 | 6 | 5 |\n| 引用标注 | 6 | 6 |\n\n" +
        "## 观察\n\n" +
        "查询越具体，命中越稳定；只写一个宽泛的词，召回里会混进无关章节。\n")
}

public func demoStatusJson(store: Store): JsonObject {
    let db = DbHub.open(store.dataDir)
    let settings = store.load()
    let configuredDir = db.getKv("settings", "agent_work_dir", "")
    let target = demoWorkDir(store.dataDir)
    let o = JsonObject()
    o.put("demo", JsonBool(demoModeEnabled()))
    o.put("workDir", JsonString(configuredDir))
    o.put("demoWorkDir", JsonString(target))
    o.put("demoWorkDirExists", JsonBool(exists(target)))
    o.put("workDirIsDemo", JsonBool(configuredDir == target))
    match (chatModelOf(store)) {
        case Some(cfg) =>
            o.put("modelConfigured", JsonBool(true))
            o.put("model", JsonString(cfg.model))
            o.put("modelId", JsonString(cfg.id))
        case None =>
            o.put("modelConfigured", JsonBool(false))
            o.put("model", JsonString(""))
            o.put("modelId", JsonString(""))
    }
    var chunks: Int64 = 0
    for (kb in settings.knowledgeBases) {
        chunks = chunks + kb.chunkCount
    }
    o.put("kbCount", JsonInt(settings.knowledgeBases.size))
    o.put("kbChunkCount", JsonInt(chunks))
    o.put("agentPerm", JsonString(db.getKv("settings", "agent_perm", "auto")))
    o.put("agentExec", JsonString(db.getKv("settings", "agent_exec", "1")))
    o.put("agentFileApproval", JsonString(db.getKv("settings", "agent_file_approval", "off")))
    o.put("approvalRules", JsonInt(approvalRuleCount(store.dataDir)))
    return o
}

public func demoPrepareJson(store: Store): JsonObject {
    let db = DbHub.open(store.dataDir)
    let target = demoWorkDir(store.dataDir)
    seedDemoWorkspace(target)
    db.putKv("settings", "agent_work_dir", target)
    db.putKv("settings", "agent_perm", "ask")
    db.putKv("settings", "agent_exec", "1")
    db.putKv("settings", "agent_file_approval", "off")
    clearApprovalRules(store.dataDir)
    return demoStatusJson(store)
}
