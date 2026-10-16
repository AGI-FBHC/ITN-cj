package itn_desktop_core.agent

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.Store
import itn_desktop_core.personal.PersonalStore
import itn_desktop_core.session.SessionStore
import itn_desktop_core.util.*

public func personalTools(store: Store,sid: String,tid: String,userText: String): ArrayList<DomainTool>{
    let ps=PersonalStore(store.dataDir);let out=ArrayList<DomainTool>()
    out.add(makeTool("search_personal_resources","搜索个人内容","查已确认资源、笔记、错题与知识点",
        "跨会话检索用户确认存入的个性资源正文、笔记、错题和知识点。query 为空时返回各类内容的总数与最近条目——回答“我的知识网络/笔记/错题里有什么”这类问题必须用这种用法（或配合 type 列举），空命中不等于没有内容；type 可只查一类：knowledge=知识网络知识点、resource=个性资源、note=笔记、wrong=错题。带 query 时按关键词全文检索。未确认草稿不在这里。返回type/id/title/snippet，可用read_personal_resource继续读取原文。",
        "{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"},\"type\":{\"type\":\"string\",\"enum\":[\"knowledge\",\"resource\",\"note\",\"wrong\"]}}}","read",{args: JsonObject =>
            let kind=strOf(args,"type")
            if(kind.size>0&&!["knowledge","resource","note","wrong"].contains(kind)){throw Exception("type 只支持 knowledge/resource/note/wrong")}
            let q=trimStr(strOf(args,"query"));let o=JsonObject()
            if(q.size==0){o.put("counts",ps.counts());o.put("hits",ps.recent(kind,30));return learningResult(o,"已给出个人内容总览与最近条目")}
            o.put("hits",ps.searchIn(kind,q,12));return learningResult(o,"已检索个人内容")}))
    out.add(makeTool("read_personal_resource","读取个人内容","按搜索结果读取正文与出处",
        "type和id必须来自search_personal_resources。支持resource/note/wrong/knowledge。引用资源的已确认副本，不能把未确认版本当最终成果。",
        "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"type\":{\"type\":\"string\"}},\"required\":[\"id\"]}","read",{args: JsonObject =>return learningResult(ps.readIndexed(strOf(args,"type"),strOf(args,"id")),"已读取索引正文")}))
    out.add(makeTool("save_personal_resource","存入个性资源","仅在用户确认后保存指定版本的副本",
        "用户明确说存入/保存到个性资源后才可调用，满意并不自动代表保存授权。path必须是本会话生成的候选文件或用户在本轮明确指定的路径。保存前不要反复入库未满意草稿；源文件保留，先前确认版本不覆盖。",
        "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"}},\"required\":[\"path\"]}","write",{args: JsonObject =>
            if(!userText.contains("个性资源")||(!userText.contains("存入")&&!userText.contains("保存到")&&!userText.contains("存到")&&!userText.contains("放入"))){throw Exception("本轮用户尚未要求存入个性资源，请先询问确认")}
            let path=strOf(args,"path");var known=userText.contains(path)&&path.size>0
            for(e in SessionStore(store.dataDir).events(sid)){
                let p=objOf(e.get("payload").getOrDefault({=>JsonObject()})).getOrDefault({=>JsonObject()})
                if(strOf(e,"type")=="artifact/created"&&strOf(p,"path")==path){known=true}
                if(strOf(e,"type")=="resource/saved"&&strOf(p,"artifactPath")==path){known=true;args.put("learningId",JsonString(strOf(p,"id")));args.put("learningVersion",JsonInt(intOf(p,"version")))}
                if(strOf(e,"type")=="tool/result"&&boolOf(p,"ok")){let d=objOf(p.get("details").getOrDefault({=>JsonObject()})).getOrDefault({=>JsonObject()});if(strOf(d,"absPath")==path){known=true}}
            }
            if(!known){throw Exception("只能保存本会话产生的候选文件，或本轮明确指定的文件路径")}
            args.put("confirmed",JsonBool(true));args.put("sessionId",JsonString(sid));args.put("turnId",JsonString(tid))
            return learningResult(ps.save(args),"已把确认版本的副本存入个性资源并建立索引")
        }))
    return out
}
