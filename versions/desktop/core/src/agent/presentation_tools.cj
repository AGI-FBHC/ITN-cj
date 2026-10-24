package itn_desktop_core.agent

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.Store
import itn_desktop_core.store.ModelConfig
import itn_desktop_core.presentation.DesktopJobs
import itn_desktop_core.util.*

public func presentationTools(store: Store, sid: String, tid: String, userText: String, shouldAbort: () -> Bool, emit: (String,JsonObject) -> Unit, runtimeModel!: ?ModelConfig = None): ArrayList<DomainTool> {
    let out=ArrayList<DomainTool>()
    out.add(makeTool("create_presentation","制作PowerPoint","按固定流水线生成可编辑交互课件PPTX",
        "需要真正的.pptx文件时使用。先问受众、用途、页数、风格，等待用户确认；用户明确无需确认/细节由你决定则直接制作。传 requirement（用户需求）、title、audience、purpose、style、backgroundStyle、slideCount、detailLevel、includeSpeakerNotes=true。子Agent会先生成结构化提纲，再逐页生成内容，最后调用旧网页版兼容渲染器生成真实PPTX。返回的 path/previewPath 已可直接打开；不要再复制、移动文件或调用 powershell，也不要擅自存入个性资源。不能只复制Markdown。",
        "{\"type\":\"object\",\"properties\":{\"requirement\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"},\"audience\":{\"type\":\"string\"},\"purpose\":{\"type\":\"string\"},\"style\":{\"type\":\"string\"},\"backgroundStyle\":{\"type\":\"string\"},\"language\":{\"type\":\"string\"},\"slideCount\":{\"type\":\"integer\"},\"aspectRatio\":{\"type\":\"string\"},\"detailLevel\":{\"type\":\"string\"},\"includeSpeakerNotes\":{\"type\":\"boolean\"},\"modelProvider\":{\"type\":\"string\"},\"generationMode\":{\"type\":\"string\"},\"kbId\":{\"type\":\"string\"},\"slides\":{\"type\":\"array\",\"items\":{\"type\":\"object\"}}},\"required\":[\"title\"]}","write",{args: JsonObject =>
            let waived=userText.contains("无需确认")||userText.contains("不需要确认")||userText.contains("不用确认")||userText.contains("直接开工")||userText.contains("直接做")||userText.contains("直接制作")||userText.contains("细节由你")
            let confirmed=userText.contains("已确认PPT细节")||userText.contains("确认制作")
            if(!waived && !confirmed){
                var complete=true
                for(key in ["audience","purpose","style","slideCount"]){let value=presentationText(args,key);if(value.size==0||!userText.contains(value)){complete=false}}
                if(!complete){throw Exception("尚未确认PPT细节，请先询问受众、用途、页数和风格；用户明确免确认才可直接制作")}
            }
            let hasSimpleSlides=presentationArray(args,"slides").size()>0&&presentationText(args,"requirement").size==0
            let file=if(hasSimpleSlides){
                DesktopJobs(store.dataDir).buildPresentation(args,sid,tid,shouldAbort)
            }else{
                PresentationAgent(store,runtimeModel: runtimeModel).generate(args,userText,sid,tid,shouldAbort)
            }
            emit("artifact/created",file)
            return learningResult(file,if(hasSimpleSlides){"PPTX已制作完成，候选文件可预览；尚未存入个性资源"}else{"交互课件已按固定流水线生成，候选PPTX可预览；章节页由渲染器自动补入，尚未存入个性资源"})
        }))
    return out
}
