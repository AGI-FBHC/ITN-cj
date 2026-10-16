package itn_desktop_core.agent

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.Store
import itn_desktop_core.presentation.DesktopJobs
import itn_desktop_core.util.*

public func presentationTools(store: Store, sid: String, tid: String, userText: String, shouldAbort: () -> Bool, emit: (String,JsonObject) -> Unit): ArrayList<DomainTool> {
    let out=ArrayList<DomainTool>()
    out.add(makeTool("create_presentation","制作PowerPoint","根据已确认需求设计并生成可编辑PPTX",
        "需要真正的.pptx文件时使用。先问受众、用途、页数、风格，等待用户确认；用户明确无需确认/细节由你决定则直接制作。由你设计逐页标题、版式、图文内容和讲者备注，不能只复制Markdown。layout取cover/bullets/comparison/process/metrics，columns为[{title,body}]，metrics为[{value,label}]，每页最多5条短要点。返回候选文件路径，满意后才询问是否存入个性资源，不能擅自入库。",
        "{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"},\"audience\":{\"type\":\"string\"},\"purpose\":{\"type\":\"string\"},\"style\":{\"type\":\"string\"},\"slides\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"},\"layout\":{\"type\":\"string\",\"enum\":[\"cover\",\"bullets\",\"comparison\",\"process\",\"metrics\"]},\"bullets\":{\"type\":\"array\",\"items\":{\"type\":\"string\"}},\"columns\":{\"type\":\"array\",\"items\":{\"type\":\"object\"}},\"metrics\":{\"type\":\"array\",\"items\":{\"type\":\"object\"}},\"notes\":{\"type\":\"string\"}},\"required\":[\"title\",\"layout\"]}}},\"required\":[\"title\",\"audience\",\"purpose\",\"style\",\"slides\"]}","write",{args: JsonObject =>
            let waived=userText.contains("无需确认")||userText.contains("不需要确认")||userText.contains("不用确认")||userText.contains("直接开工")||userText.contains("直接做")||userText.contains("直接制作")||userText.contains("细节由你")
            let confirmed=userText.contains("已确认PPT细节")||userText.contains("确认制作")
            if(!waived && !confirmed){
                var complete=true
                for(key in ["audience","purpose","style"]){let value=strOf(args,key);if(value.size==0||!userText.contains(value)){complete=false}}
                if(!complete){throw Exception("尚未确认PPT细节，请先询问受众、用途、页数和风格；用户明确免确认才可直接制作")}
            }
            let file=DesktopJobs(store.dataDir).buildPresentation(args,sid,tid,shouldAbort)
            emit("artifact/created",file)
            return learningResult(file,"PPTX已制作完成，候选文件可预览；尚未存入个性资源")
        }))
    return out
}
