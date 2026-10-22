package itn_desktop_core.runtime_host

import std.collection.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.store.Store
import itn_desktop_core.session.SessionStore
import itn_desktop_core.agent.requestCancel
import itn_desktop_core.course.CourseJobs
import itn_desktop_core.presentation.DesktopJobs
import itn_desktop_core.util.*

func nowMs(): Int64{return DateTime.now().toUnixTimeStamp().toMilliseconds()}
func baseNameOf(path: String): String{
    let parts=path.replace("\\","/").split("/")
    if(parts.size==0){return path}
    return parts[parts.size-1]
}
func toolLabel(name: String): String{
    let map=[("generate_learning_resource","生成学习资源"),("revise_learning_resource","修改学习资源"),("kb_search","检索知识库"),("web_search","联网搜索"),("web_fetch","读取网页"),("save_note","写笔记"),("save_artifact","写文件"),("create_presentation","制作演示文稿"),("read_learning_resource","读取学习资源")]
    for((k,v) in map){if(k==name){return v}}
    return name
}
func linkOf(page: String,sessionId: String,kbId: String): JsonObject{
    let l=JsonObject();l.put("page",JsonString(page));if(sessionId.size>0){l.put("sessionId",JsonString(sessionId))};if(kbId.size>0){l.put("kbId",JsonString(kbId))};return l
}
func okOut(): JsonObject{let o=JsonObject();o.put("ok",JsonBool(true));return o}

/**
 * 任务中心的只读聚合器：不另建状态，只把现有三处真实来源汇总成统一任务行。
 *   - 对话轮次：sessionHub（内存）+ sessions_meta state:<sid>（running/cancelling）+ 最近 turn/end 事件
 *   - 导图任务：course_jobs（progress/tokens/阶段）
 *   - 桌面任务：desktop_jobs（PPT 制作 / 内容提取）
 * 取消一律转发到原有取消路径（agent cancel / course cancel），避免双真相。
 */
public class TaskFeed {
    let store: Store
    public init(store: Store){this.store=store}
    private func dataDir(): String{return store.dataDir}
    private func kbName(kb: String): String{
        match(store.load().findKb(kb)){case Some(k)=>return if(k.name.size>0){k.name}else{k.id};case None=>return kb}
    }
    private func chatTitle(sid: String): String{
        let t=SessionStore(dataDir()).titleOf(sid)
        return if(t.size>0){t}else{"新对话"}
    }
    private func chatStage(sid: String): String{
        for(r in DbHub.open(dataDir()).query("SELECT kind,payload FROM session_events WHERE session_id=? ORDER BY id DESC LIMIT 10",va([tv(sid)]))){
            let kind=r.text(0);let p=objOf(JsonValue.fromStr(r.text(1))).getOrDefault({=>JsonObject()})
            if(kind=="tool/call"){return "正在调用 "+toolLabel(strOf(p,"tool"))}
            if(kind=="resource/progress"){let label=strOf(p,"label");if(label.size>0){return label}}
            if(kind=="assistant/activity"){
                let phase=strOf(p,"phase")
                if(phase=="thinking"){return "思考中"}
                if(phase=="tool_input"){return "正在接收工具参数"}
                if(phase=="resource"){let label=strOf(p,"label");if(label.size>0){return label}}
            }
            if(kind=="assistant/delta"){return "正在回复"}
            if(kind=="turn/start"){return "已开始"}
        }
        return "进行中"
    }
    /** 应用重启后，把没有活动 Agent 的 running/cancelling 会话收口成 interrupted。
        taskState 会补一条 turn/end 并保留现场；这样任务中心无需先打开那个会话也能看到真实终态。 */
    private func reconcileInterrupted(): Unit{
        let ids=ArrayList<String>()
        for(r in DbHub.open(dataDir()).querySql("SELECT k FROM sessions_meta WHERE k LIKE 'state:%'")){
            let key=r.text(0);if(hasPrefix(key,"state:")){ids.add(key[6..key.size])}
        }
        for(sid in ids){taskState(dataDir(),sid)}
    }
    public func active(): JsonArray{
        reconcileInterrupted()
        let out=JsonArray()
        for(sid in sessionHub().activeSessionIds()){
            let st=taskState(dataDir(),sid);let status=strOf(st,"status")
            if(status!="running"&&status!="cancelling"){continue}
            let turnId=strOf(st,"turnId");let o=JsonObject()
            o.put("id",JsonString("turn:"+sid+":"+turnId))
            o.put("kind",JsonString("chat"))
            o.put("title",JsonString("对话："+chatTitle(sid)))
            o.put("status",JsonString(status))
            o.put("stage",JsonString(chatStage(sid)))
            let startedMs=intOf(st,"startedMs")
            if(startedMs>0){o.put("startedAt",JsonString(strOf(st,"startedAt")));o.put("elapsedSeconds",JsonInt((nowMs()-startedMs)/1000))}
            o.put("link",linkOf("chat",sid,""))
            o.put("cancelable",JsonBool(status=="running"))
            out.add(o)
        }
        let courseActive=CourseJobs(store).active();var cair: Int64=0
        while(cair<courseActive.size()){
            let j=objOf(courseActive[cair]).getOrThrow();cair+=1
            let o=JsonObject()
            o.put("id",JsonString("course:"+strOf(j,"id")))
            o.put("kind",JsonString("course-map"))
            o.put("title",JsonString("生成思维导图："+kbName(strOf(j,"kbId"))))
            o.put("status",JsonString("running"))
            o.put("stage",JsonString(strOf(j,"stage")))
            o.put("progress",j.get("progress").getOrDefault({=>JsonValue.fromStr("{}")}))
            o.put("tokens",j.get("tokens").getOrDefault({=>JsonValue.fromStr("{}")}))
            o.put("startedAt",JsonString(strOf(j,"createdAt")))
            o.put("link",linkOf("learn","",strOf(j,"kbId")))
            o.put("cancelable",JsonBool(true))
            out.add(o)
        }
        let deskActive=DesktopJobs(dataDir()).active();var dair: Int64=0
        while(dair<deskActive.size()){
            let d=objOf(deskActive[dair]).getOrThrow();dair+=1
            let body=objOf(d.get("body").getOrDefault({=>JsonValue.fromStr("{}")})).getOrDefault({=>JsonObject()})
            let kind=strOf(d,"kind");let o=JsonObject()
            o.put("id",JsonString("desktop:"+strOf(d,"id")))
            o.put("kind",JsonString(if(kind=="presentation"){"ppt"}else{"extract"}))
            let title=if(kind=="presentation"){let t=strOf(objOf(body.get("spec").getOrDefault({=>JsonValue.fromStr("{}")})).getOrDefault({=>JsonObject()}),"title");if(t.size>0){t}else{"演示文稿"}}else{"提取内容："+baseNameOf(strOf(body,"inputPath"))}
            o.put("title",JsonString(title))
            o.put("status",JsonString(if(strOf(d,"status")=="running"){"running"}else{"queued"}))
            o.put("stage",JsonString(if(strOf(d,"status")=="running"){"桌面任务执行中"}else{"等待桌面端领取"}))
            let sid=strOf(body,"sessionId")
            o.put("link",if(sid.size>0){linkOf("chat",sid,"")}else{linkOf("resources","","")})
            o.put("cancelable",JsonBool(kind=="presentation"&&sid.size>0))
            out.add(o)
        }
        return out
    }
    public func recent(): JsonArray{
        let rows=ArrayList<JsonObject>()
        for(r in DbHub.open(dataDir()).querySql("SELECT session_id, turn_id, ts, payload FROM session_events WHERE kind='turn/end' ORDER BY id DESC LIMIT 6")){
            let p=objOf(JsonValue.fromStr(r.text(3))).getOrDefault({=>JsonObject()})
            let o=JsonObject();let sid=r.text(0)
            o.put("id",JsonString("turn:"+sid+":"+r.text(1)))
            o.put("kind",JsonString("chat"))
            o.put("title",JsonString("对话："+chatTitle(sid)))
            let endMsg=strOf(p,"message")
            let cancelled=endMsg.contains("取消")||endMsg.contains("停止")||endMsg.contains("中止")
            let interrupted=endMsg.contains("中断")
            o.put("status",JsonString(if(boolOf(p,"ok")){"completed"}else if(interrupted){"interrupted"}else if(cancelled){"cancelled"}else{"failed"}))
            o.put("updatedAt",JsonString(r.text(2)))
            o.put("link",linkOf("chat",sid,""))
            o.put("cancelable",JsonBool(false))
            rows.add(o)
        }
        let courseRecent=CourseJobs(store).recent(4);var crir: Int64=0
        while(crir<courseRecent.size()){
            let j=objOf(courseRecent[crir]).getOrThrow();crir+=1
            let o=JsonObject()
            o.put("id",JsonString("course:"+strOf(j,"id")))
            o.put("kind",JsonString("course-map"))
            o.put("title",JsonString("生成思维导图："+kbName(strOf(j,"kbId"))))
            o.put("status",JsonString(strOf(j,"status")))
            o.put("progress",j.get("progress").getOrDefault({=>JsonValue.fromStr("{}")}))
            o.put("tokens",j.get("tokens").getOrDefault({=>JsonValue.fromStr("{}")}))
            o.put("updatedAt",JsonString(strOf(j,"createdAt")))
            o.put("link",linkOf("learn","",strOf(j,"kbId")))
            o.put("cancelable",JsonBool(false))
            rows.add(o)
        }
        let deskRecent=DesktopJobs(dataDir()).recent(4);var drir: Int64=0
        while(drir<deskRecent.size()){
            let d=objOf(deskRecent[drir]).getOrThrow();drir+=1
            let body=objOf(d.get("body").getOrDefault({=>JsonValue.fromStr("{}")})).getOrDefault({=>JsonObject()})
            let kind=strOf(d,"kind");let o=JsonObject()
            o.put("id",JsonString("desktop:"+strOf(d,"id")))
            o.put("kind",JsonString(if(kind=="presentation"){"ppt"}else{"extract"}))
            let title=if(kind=="presentation"){let t=strOf(objOf(body.get("spec").getOrDefault({=>JsonValue.fromStr("{}")})).getOrDefault({=>JsonObject()}),"title");if(t.size>0){t}else{"演示文稿"}}else{"提取内容："+baseNameOf(strOf(body,"inputPath"))}
            o.put("title",JsonString(title))
            o.put("status",JsonString(strOf(d,"status")))
            o.put("updatedAt",JsonString(strOf(d,"createdAt")))
            let sid=strOf(body,"sessionId")
            o.put("link",if(sid.size>0){linkOf("chat",sid,"")}else{linkOf("resources","","")})
            o.put("cancelable",JsonBool(false))
            rows.add(o)
        }
        // 按时间倒序（ISO 字符串可直接比较），最多 10 条
        var i: Int64=0
        while(i<rows.size){var j2: Int64=0;while(j2+1<rows.size-i){if(strOf(rows[j2],"updatedAt")<strOf(rows[j2+1],"updatedAt")){let t=rows[j2];rows[j2]=rows[j2+1];rows[j2+1]=t};j2+=1};i+=1}
        let out=JsonArray();var k: Int64=0;while(k<rows.size&&k<10){out.add(rows[k]);k+=1}
        return out
    }
    public func list(): JsonObject{
        let o=JsonObject();o.put("running",active());o.put("recent",recent());return o
    }
    public func cancel(id: String): JsonObject{
        let parts=id.split(":")
        if(hasPrefix(id,"turn:")&&parts.size>=3){
            let sid=parts[1];let turnId=parts[2]
            if(sessionHub().activeTurn(sid)!=turnId){throw Exception("这个任务已经结束")}
            setTaskState(dataDir(),sid,turnId,"cancelling");requestCancel(sid);sessionHub().abort(sid)
            return okOut()
        }
        if(hasPrefix(id,"course:")){CourseJobs(store).cancel(id[7..id.size]);return okOut()}
        if(hasPrefix(id,"desktop:")){
            let jobId=id[8..id.size];let rows=DbHub.open(dataDir()).query("SELECT kind,status,body FROM desktop_jobs WHERE id=?",va([tv(jobId)]))
            if(rows.size==0){throw Exception("任务不存在")}
            if(rows[0].text(1)=="completed"||rows[0].text(1)=="failed"||rows[0].text(1)=="cancelled"){throw Exception("这个任务已经结束")}
            if(rows[0].text(0)!="presentation"){throw Exception("这类桌面任务不支持单独取消")}
            let body=objOf(JsonValue.fromStr(rows[0].text(2))).getOrDefault({=>JsonObject()})
            let sid=strOf(body,"sessionId");let turnId=strOf(body,"turnId")
            if(sid.size>0&&sessionHub().activeTurn(sid).size>0){
                setTaskState(dataDir(),sid,turnId,"cancelling");requestCancel(sid);sessionHub().abort(sid)
                return okOut()
            }
            DbHub.open(dataDir()).run("UPDATE desktop_jobs SET status='cancelled' WHERE id=? AND status IN ('pending','running')",va([tv(jobId)]))
            return okOut()
        }
        throw Exception("未知任务")
    }
}
