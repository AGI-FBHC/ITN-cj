package itn_desktop_core.agent

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.course.CourseStore
import itn_desktop_core.course.CourseJobs
import itn_desktop_core.store.Store
import itn_desktop_core.util.*

func courseConsent(text: String,words: Array<String>): Bool{
    if(text.contains("不要删除")||text.contains("不要替换")||text.contains("先别")||text.contains("先不要")){return false}
    for(w in words){if(text.contains(w)){return true}};return false
}
public func courseTools(store: Store,sid: String,userText: String): ArrayList<DomainTool>{
    let out=ArrayList<DomainTool>();let cs=CourseStore(store.dataDir)
    out.add(makeTool("read_course_map","读取思维导图","知识库导图、节点资源与生成任务",
        "读取选定知识库的学习思维导图（不是对话知识网络）、节点资源、归档数量。kbId来自知识库列表或get_learning_context.courseTarget。可用jobId读取生成阶段；mapId读取历史/候选图。不要凭界面猜测已有资源。",
        "{\"type\":\"object\",\"properties\":{\"kbId\":{\"type\":\"string\"},\"jobId\":{\"type\":\"string\"},\"mapId\":{\"type\":\"string\"}}}","read",{a: JsonObject=>
            let result=if(strOf(a,"jobId").size>0){CourseJobs(store).read(strOf(a,"jobId"))}else if(strOf(a,"mapId").size>0){cs.map(strOf(a,"mapId"))}else{cs.state(strOf(a,"kbId"))};return learningResult(result,"已读取思维导图及资源关系")}))
    out.add(makeTool("generate_course_map","生成思维导图","固定流水线读完整知识库并整理树形大纲",
        "只在用户要求生成/重建/整理思维导图时调用。后台分批阅读全库，LLM决定2-3级且最多4级。返回任务id，稍后read_course_map(jobId)读取阶段。重建只生成候选，不自动替换旧导图。",
        "{\"type\":\"object\",\"properties\":{\"kbId\":{\"type\":\"string\"}},\"required\":[\"kbId\"]}","write",{a: JsonObject=>
            if(!courseConsent(userText,["生成","重建","整理","创建"])){throw Exception("用户尚未要求生成思维导图")};let jobs=CourseJobs(store);let job=jobs.start(strOf(a,"kbId"));if(!boolOf(job,"existing")){let id=strOf(job,"id");spawn{jobs.run(id,None)}};return learningResult(job,"思维导图任务已启动，旧图保持可用")}))
    out.add(makeTool("publish_course_map","切换新版导图","确认后切换，旧资源归档",
        "只有用户看过新版并明确确认切换/重建时调用；expectedMapId是读取时的旧图id。发生并发变化就重新预览；不删除旧资源。",
        "{\"type\":\"object\",\"properties\":{\"mapId\":{\"type\":\"string\"},\"expectedMapId\":{\"type\":\"string\"}},\"required\":[\"mapId\",\"expectedMapId\"]}","write",{a: JsonObject=>
            if(!courseConsent(userText,["确认切换","确认重建","切换新版","直接重建"])){throw Exception("请先向用户预览新版及受影响资源，再确认切换")};return learningResult(cs.publish(strOf(a,"mapId"),strOf(a,"expectedMapId"),true),"新版导图已生效，旧资源已归档")}))
    out.add(makeTool("manage_course_node","管理导图节点","改名、移动、完成标记或删除",
        "nodeId来自read_course_map。改名/移动保持ID；删除默认子节点上移，subtree=true删除整支。删除前说明资源将归档，根不能删除；不把完成标记当掌握度。",
        "{\"type\":\"object\",\"properties\":{\"kbId\":{\"type\":\"string\"},\"nodeId\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"},\"parentId\":{\"type\":\"string\"},\"done\":{\"type\":\"boolean\"},\"remove\":{\"type\":\"boolean\"},\"subtree\":{\"type\":\"boolean\"}},\"required\":[\"kbId\",\"nodeId\"]}","write",{a: JsonObject=>
            if(!courseConsent(userText,["改名","修改","移动","学完","完成","删除","移除"])){throw Exception("用户没有提出节点修改要求")};a.put("confirmed",JsonBool(true));return learningResult(cs.editNode(strOf(a,"kbId"),strOf(a,"nodeId"),a),"节点状态已更新，关联资源按规则保留")}))
    out.add(makeTool("list_course_resources","列出节点学习资源","当前、归档与回收站分别列出",
        "status=current|archive|trash。默认只列当前；归档/回收站需用户有查看或恢复意图。保留原节点来源与精确资源版本。",
        "{\"type\":\"object\",\"properties\":{\"kbId\":{\"type\":\"string\"},\"status\":{\"type\":\"string\",\"enum\":[\"current\",\"archive\",\"trash\"]}}}","read",{a: JsonObject=>let result=JsonObject();result.put("resources",cs.resources(strOf(a,"kbId"),if(strOf(a,"status").size>0){strOf(a,"status")}else{"current"}));return learningResult(result,"已列出指定范围的节点资源")}))
    out.add(makeTool("read_course_resource","预览节点资源","按稳定编号读取确认版本及来源",
        "id来自list_course_resources。includeTrash仅当用户明确查看回收站时使用，正常读取不返回已删除内容。旧版资源的阅读与作答证据不重复计分。",
        "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"includeTrash\":{\"type\":\"boolean\"}},\"required\":[\"id\"]}","read",{a: JsonObject=>let r=cs.resource(strOf(a,"id"),boolOf(a,"includeTrash")&&userText.contains("回收站"));return learningResult(r,"已读取确认资源的精确版本与来源")}))
    out.add(makeTool("manage_course_resource","管理节点资源","归档、删除到回收站、恢复或关联",
        "id来自资源清单。action=archive|trash|restore|attach|purge。恢复/关联必须指定有效nodeId与expectedResourceId（空表示位置为空）；已有当前版本会归档。purge仅在用户明确永久删除时使用，不代表删除原对话文字/原始资料/外部备份。",
        "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"action\":{\"type\":\"string\",\"enum\":[\"archive\",\"trash\",\"restore\",\"attach\",\"purge\"]},\"kbId\":{\"type\":\"string\"},\"nodeId\":{\"type\":\"string\"},\"expectedResourceId\":{\"type\":\"string\"}},\"required\":[\"id\",\"action\"]}","write",{a: JsonObject=>
            if(!courseConsent(userText,["归档","删除","恢复","关联","挂到","放回"])){throw Exception("用户尚未授权这项资源操作")};if(strOf(a,"action")=="purge"&&!courseConsent(userText,["永久删除","彻底删除"])){throw Exception("永久删除需要单独明确授权")};return learningResult(cs.action(strOf(a,"id"),strOf(a,"action"),strOf(a,"kbId"),strOf(a,"nodeId"),strOf(a,"expectedResourceId"),true),"资源关系已更新，思维导图和学习记录未被删除")}))
    out.add(makeTool("get_course_progress","读取学习进展","节点完成标记和真实作答依据",
        "按知识库读取当前导图节点、学习资源、首次作答与历史证据。本人标记学完不等于掌握，资源份数不等于能力。",
        "{\"type\":\"object\",\"properties\":{\"kbId\":{\"type\":\"string\"}},\"required\":[\"kbId\"]}","read",{a: JsonObject=>return learningResult(cs.report(strOf(a,"kbId")),"已读取学习进展及依据")}))
    out.add(makeTool("save_course_resource","收录节点学习资源","用户确认后保存精确候选并绑定节点",
        "仅在本轮用户明确要求加入/收录/替换学习资源时调用。候选必须来自本节点会话真实生成事件；expectedResourceId从courseTarget或当前节点读取。旧图失效时先让用户明确选择targetNodeId；保存成功才归档旧版。",
        "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"},\"expectedResourceId\":{\"type\":\"string\"},\"targetNodeId\":{\"type\":\"string\"}},\"required\":[\"path\",\"expectedResourceId\"]}","write",{a: JsonObject=>
            if(!courseConsent(userText,["加入学习资源","加入我的学习资源","收录","确认存入","替换当前","保存到学习资源"])){throw Exception("用户还没有确认收录这份候选")};a.put("sessionId",JsonString(sid));a.put("confirmed",JsonBool(true));return learningResult(cs.commit(a),"已收录确认版本，旧正式版本如有已归档")}))
    out.add(makeTool("cancel_course_map","取消导图生成","停止后台任务，保留旧导图",
        "用户要求停止/取消思维导图生成时使用，jobId来自生成工具或任务状态。",
        "{\"type\":\"object\",\"properties\":{\"jobId\":{\"type\":\"string\"}},\"required\":[\"jobId\"]}","write",{a: JsonObject=>if(!courseConsent(userText,["停止","取消"])){throw Exception("用户未要求停止生成")};return learningResult(CourseJobs(store).cancel(strOf(a,"jobId")),"已请求取消导图任务，旧导图保留")}))
    out.add(makeTool("list_course_history","查看历史导图与已移除知识库","旧树快照和可恢复知识库清单",
        "读取历史思维导图与已移除知识库，仅读取，不恢复或覆盖。",
        "{\"type\":\"object\",\"properties\":{\"kbId\":{\"type\":\"string\"}}}","read",{a: JsonObject=>let r=JsonObject();r.put("maps",cs.history(strOf(a,"kbId")));r.put("removedLibraries",cs.deletedKbs());return learningResult(r,"已读取历史结构与可恢复知识库")}))
    out.add(makeTool("attach_existing_course_resource","关联已有学习资源","把未关联的已确认副本挂到节点",
        "无personalId时只列出未关联资源。用户明确要求关联/挂到节点时才写入；kind是lecture/practice/quiz/ppt，已有结构化类型不能伪装，普通文件只能预览，不能伪造评分。expectedResourceId必须读取当前节点后填写。",
        "{\"type\":\"object\",\"properties\":{\"personalId\":{\"type\":\"string\"},\"kbId\":{\"type\":\"string\"},\"nodeId\":{\"type\":\"string\"},\"kind\":{\"type\":\"string\"},\"expectedResourceId\":{\"type\":\"string\"}}}","write",{a: JsonObject=>if(strOf(a,"personalId").size==0){let r=JsonObject();r.put("resources",cs.unlinked());return learningResult(r,"已列出未关联的确认副本")};if(!courseConsent(userText,["关联","挂到","放到","接到"])){throw Exception("用户未要求关联已有资源")};a.put("confirmed",JsonBool(true));return learningResult(cs.adopt(a),"已关联已有资源，原当前版本如有已归档")}))
    out.add(makeTool("restore_course_library","恢复知识库和导图","恢复已移除库，旧资源仍在归档",
        "kbId来自list_course_history的removedLibraries。用户明确恢复时使用，不自动抢回已关联到其他节点的资源，不修改原始资料。",
        "{\"type\":\"object\",\"properties\":{\"kbId\":{\"type\":\"string\"}},\"required\":[\"kbId\"]}","write",{a: JsonObject=>if(!courseConsent(userText,["恢复","放回"])){throw Exception("用户未要求恢复知识库")};return learningResult(cs.restoreKb(strOf(a,"kbId"),true),"知识库与原导图已恢复，旧资源可从归档重新关联")}))
    return out
}
