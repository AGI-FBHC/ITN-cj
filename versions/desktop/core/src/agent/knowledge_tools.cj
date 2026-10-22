package itn_desktop_core.agent

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.Store
import itn_desktop_core.knowledge.KnowledgeStore
import itn_desktop_core.knowledge.suggestKnowledgeLinks
import itn_desktop_core.util.*

public func knowledgeTools(store: Store,sid: String,tid: String,userText: String,workspace: String,emit: (String,JsonObject)->Unit): ArrayList<DomainTool>{
    let ks=KnowledgeStore(store.dataDir);let out=ArrayList<DomainTool>()
    out.add(makeTool("record_knowledge_point","记录知识点","保留对话中的可复用概念与来源",
        "当用户围绕概念、方法或原理展开讨论（解释、讲解、什么是、为什么等），在给出回答时必须调用本工具记录一个主知识点；记录只是附带动作，记录后必须继续用正文直接回答用户问题，不能只回复“已记录”。闲聊、一次性制文件、纯操作指令不记录。title是精炼概念，definition是简明定义，note记录本次讨论要点，quote必须逐字来自本轮用户问题。aliases只用确切别称，不能把相关但不同概念强行合并。已存在概念会合并记录，不推断连线或掌握程度。",
        "{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"},\"definition\":{\"type\":\"string\"},\"quote\":{\"type\":\"string\"},\"note\":{\"type\":\"string\"},\"aliases\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}}},\"required\":[\"title\",\"definition\",\"quote\",\"note\"]}","write",{args: JsonObject=>
            let node=ks.save(args,false,sid,tid,userText,workspace);let brief=JsonObject()
            for(key in ["id","title","definition","recordCount"]){brief.put(key,node.get(key).getOrDefault({=>JsonNull()}))}
            emit("knowledge/recorded",brief);return learningResult(brief,"知识点已记录，含原始问题、AI记录、时间与来源工作区")
        }))
    out.add(makeTool("read_knowledge_point","读取知识记录","知识点详情、来源会话与笔记",
        "id来自search_personal_resources中type=knowledge的结果。读取概念、每次提问与AI记录、时间、会话/工作区和本人笔记。不要把自动记录当作掌握度证明。",
        "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"}},\"required\":[\"id\"]}","read",{args: JsonObject=>return learningResult(ks.read(strOf(args,"id")),"已读取知识点及来源记录")}))
    out.add(makeTool("suggest_knowledge_links","建议知识点连线","分析知识网络并提出可解释的关系建议",
        "当用户需要整理知识网络、发现概念关系或主动要求连线建议时使用。只返回建议，不直接建边；已有边会用 exists=true 标出，必须由用户确认后另行创建。",
        "{\"type\":\"object\",\"properties\":{}}","read",{args: JsonObject=>return learningResult(suggestKnowledgeLinks(store),"已生成连线建议，等待用户确认")}))
    return out
}
