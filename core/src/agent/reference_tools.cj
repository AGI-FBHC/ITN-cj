package itn_desktop_core.agent

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.kb.resolveKnowledgeReference
import itn_desktop_core.store.Store
import itn_desktop_core.util.*

/** The host registers this with its domain tools; it never defaults to the session's kb. */
public func referenceTools(store: Store): ArrayList<DomainTool> {
    let out = ArrayList<DomainTool>()
    out.add(makeTool("resolve_knowledge_reference", "定位知识库引用", "精确查找引用文档和切片",
        "只读定位已登记知识库的引用，返回正文、库/文档/切片标识、分页位置和安全本地路径。至少提供 docPath 或 chunkId。" +
        "kbId 缺省时检查所有已登记库，同名来源返回 ambiguous 和候选，不能自行选择当前库。" +
        "明确 chunkId 失效时返回 missing，不能改用同名文档。源文件已删除但索引还在时仍可读取正文。",
        "{\"type\":\"object\",\"properties\":{\"kbId\":{\"type\":\"string\"},\"docPath\":{\"type\":\"string\"}," +
        "\"chunkId\":{\"type\":\"string\"},\"headingPath\":{\"type\":\"string\"}}," +
        "\"anyOf\":[{\"required\":[\"docPath\"]},{\"required\":[\"chunkId\"]}]}", "read", { args: JsonObject =>
            let body = resolveKnowledgeReference(store, args)
            let result = DomainToolRun()
            result.details = body
            result.content = body.toString()
            let status = strOf(body, "status")
            result.summary = if (status == "found") { "已定位知识库引用：" + strOf(body, "docTitle") }
                else if (status == "ambiguous") { "找到多个引用来源，请选择知识库或文档" }
                else { "引用暂不可定位：" + strOf(body, "reason") }
            return result
        }))
    return out
}
