package itn_desktop_core.course

import std.collection.*
import std.fs.*
import std.random.*
import std.sync.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.store.*
import itn_desktop_core.session.*
import itn_desktop_core.project.ProjectStore
import itn_desktop_core.learning.LearningStore
import itn_desktop_core.learning.arrOf
import itn_desktop_core.personal.PersonalStore
import itn_desktop_core.kb.stamp
import itn_desktop_core.kb.baseNameOf
import itn_desktop_core.util.*

let courseLock=Mutex()
public func courseId(prefix: String): String{return prefix+Random().nextUInt64().toString()}
public func courseJson(raw: String): JsonObject{return objOf(JsonValue.fromStr(raw)).getOrThrow()}
public func courseKind(kind: String): Bool{return ["lecture","practice","quiz","ppt"].contains(kind)}
public func courseMarkBusy(dir: String,sid: String,busy: Bool): Unit{let d=DbHub.open(dir);d.putKv("meta","course-busy:"+sid,if(busy){owner}else{""});if(busy){d.putKv("meta","course-target-pending:"+sid,"")}}
func va2(values: Array<DbOp>): ArrayList<DbOp>{let out=ArrayList<DbOp>();for(v in values){out.add(v)};return out}

/** Stable map/node identities and confirmed resource versions. No model owns these relationships. */
public class CourseStore {
    public let dataDir: String
    public init(dataDir: String){this.dataDir=dataDir}
    private func db(): Db{return DbHub.open(dataDir)}
    public func head(kb: String): String{return db().getKv("meta","course-head:"+kb,"")}
    public func map(id: String): JsonObject{
        let raw=db().scalarText("SELECT body FROM course_maps WHERE id=?",va([tv(id)]))
        if(raw.size==0){throw Exception("思维导图不存在")};return courseJson(raw)
    }
    public func node(kb: String,id: String): JsonObject{
        let current=head(kb);if(current.size==0){throw Exception("这个知识库还没有当前思维导图")}
        let ns=arrOf(map(current),"nodes");var i=0
        while(i<ns.size()){let n=objOf(ns[i]).getOrThrow();i+=1;if(strOf(n,"id")==id){return n}}
        throw Exception("节点已移除或属于旧导图，请重新选择")
    }
    public func slot(nodeId: String,kind: String): String{return db().scalarText("SELECT resource_id FROM course_slots WHERE node_id=? AND kind=?",va([tv(nodeId),tv(kind)]))}
    private func assetBody(id: String): JsonObject{
        let raw=db().scalarText("SELECT body FROM course_assets WHERE id=?",va([tv(id)]))
        if(raw.size==0){throw Exception("资源关联不存在")};return courseJson(raw)
    }
    public func resource(id: String,includeTrash: Bool): JsonObject{return resource(id,includeTrash,true)}
    public func resource(id: String,includeTrash: Bool,withText: Bool): JsonObject{
        recoverFiles();let out=assetBody(id)
        let status=db().scalarText("SELECT status FROM course_assets WHERE id=?",va([tv(id)]))
        if(status=="purged"||(!includeTrash&&status=="trash")){throw Exception("这份资源已删除，请到回收站明确恢复或预览")}
        out.put("status",JsonString(status))
        let p=db().scalarText("SELECT path FROM personal_resources WHERE id=?",va([tv(id)]))
        out.put("path",JsonString(p));out.put("missing",JsonBool(!exists(p)))
        if(withText){out.put("text",JsonString(db().scalarText("SELECT body FROM content_index WHERE type='resource' AND id=?",va([tv(id)]))));let lid=strOf(out,"learningId");if(lid.size>0){out.put("learning",LearningStore(dataDir).resource(lid,intOf(out,"learningVersion"),includeTrash))}}
        out.put("sourceSessionDeleted",JsonBool(strOf(out,"sessionId").size>0&&db().scalarInt("SELECT COUNT(*) FROM sessions WHERE id=?",va([tv(strOf(out,"sessionId"))]))==0))
        return out
    }
    public func resources(kb: String,status: String): JsonArray{
        recoverFiles();let out=JsonArray()
        for(r in db().query("SELECT id,kb_id,status FROM course_assets ORDER BY updated_at DESC",ArrayList<DbValue>())){
            if((kb.size==0||r.text(1)==kb)&&(status.size==0||r.text(2)==status)&&r.text(2)!="purged"){out.add(resource(r.text(0),true,false))}
        };return out
    }
    public func history(kb: String): JsonArray{
        let out=JsonArray();for(r in db().query("SELECT body,status FROM course_maps WHERE kb_id=? ORDER BY updated_at DESC",va([tv(kb)]))){let o=courseJson(r.text(0));o.put("status",JsonString(r.text(1)));out.add(o)};return out
    }
    public func unlinked(): JsonArray{let out=JsonArray();let all=PersonalStore(dataDir).list();var i=0;while(i<all.size()){let a=objOf(all[i]).getOrThrow();i+=1;if(db().scalarInt("SELECT COUNT(*) FROM course_assets WHERE id=?",va([tv(strOf(a,"id"))]))==0){out.add(a)}};return out}
    public func state(kb: String): JsonObject{
        recoverFiles();let out=JsonObject();let id=head(kb)
        out.put("map",if(id.size>0){map(id)}else{JsonNull()});out.put("resources",resources(kb,"current"))
        out.put("archiveCount",JsonInt(resources(kb,"archive").size()));out.put("trashCount",JsonInt(resources(kb,"trash").size()))
        let cfg=Store(dataDir).load().findKb(kb)
        out.put("sourceChanged",JsonBool(match(cfg){case Some(c)=>id.size>0&&strOf(map(id),"sourceVersion")!=c.builtAt;case None=>id.size>0}))
        let jobs=db().query("SELECT id,body,status FROM course_jobs WHERE kb_id=? ORDER BY created_at DESC LIMIT 1",va([tv(kb)]))
        if(jobs.size>0){let j=courseJson(jobs[0].text(1));j.put("status",JsonString(jobs[0].text(2)));out.put("job",j)}
        return out
    }
    public func saveDraft(kb: String,body: JsonObject,base: String): JsonObject{
        let id=courseId("map-");body.put("id",JsonString(id));body.put("kbId",JsonString(kb));body.put("baseMapId",JsonString(base));body.put("createdAt",JsonString(stamp()))
        db().run("INSERT INTO course_maps VALUES (?,?, 'draft',?,?)",va([tv(id),tv(kb),tv(body.toString()),tv(stamp())]));return body
    }
    private func saveMap(body: JsonObject): Unit{db().run("UPDATE course_maps SET body=?,updated_at=? WHERE id=?",va([tv(body.toString()),tv(stamp()),tv(strOf(body,"id"))]))}
    public func publish(id: String,expected: String,confirmed: Bool): JsonObject{
        if(!confirmed){throw Exception("请先确认是否切换这张思维导图")}
        synchronized(courseLock){
            let body=map(id);let kb=strOf(body,"kbId");let old=head(kb)
            if(old==id){return state(kb)}
            if(old!=expected||strOf(body,"baseMapId")!=expected){throw Exception("当前导图已变化，请重新预览新版")}
            if(Store(dataDir).load().findKb(kb).isNone()){throw Exception("知识库已删除，不能发布导图")}
            if(strOf(body,"sourceVersion")!=Store(dataDir).load().findKb(kb).getOrThrow().builtAt){throw Exception("生成期间资料已更新，请重新生成导图")}
            if(db().scalarText("SELECT status FROM course_maps WHERE id=?",va([tv(id)]))!="draft"){throw Exception("只能发布待确认导图")}
            let ops=ArrayList<DbOp>()
            if(old.size>0){
                let current=resources(kb,"current");var i=0
                while(i<current.size()){let a=objOf(current[i]).getOrThrow();i+=1;statusOps(a,"archive","重建思维导图",ops)}
            }
            if(old.size>0){ops.add(DbOp("UPDATE course_maps SET status='archive' WHERE id=?",va([tv(old)])))}
            ops.add(DbOp("UPDATE course_maps SET status='current' WHERE id=?",va([tv(id)])))
            ops.add(DbOp("INSERT OR REPLACE INTO meta(k,v) VALUES (?,?)",va([tv("course-head:"+kb),tv(id)])))
            db().batch(ops);return state(kb)
        }
    }
    public func target(sid: String): JsonObject{
        let raw=db().scalarText("SELECT body FROM course_targets WHERE session_id=?",va([tv(sid)]))
        if(raw.size==0){return JsonObject()};let out=courseJson(raw)
        var valid=head(strOf(out,"kbId"))==strOf(out,"mapId")
        if(valid){try{node(strOf(out,"kbId"),strOf(out,"nodeId"))}catch(e: Exception){valid=false}}
        out.put("valid",JsonBool(valid));return out
    }
    public func start(kb: String,nid: String,kind: String,project: String,regenerate: Bool): JsonObject{
        if(!courseKind(kind)){throw Exception("请选择四类学习资源之一")}
        synchronized(courseLock){
            let n=node(kb,nid)
            if(project.size>0&&ProjectStore(dataDir).find(project).isNone()){throw Exception("工作区已删除，请明确重新选择")}
            for(r in db().query("SELECT session_id,body FROM course_targets WHERE kb_id=?",va([tv(kb)]))){
                let t=courseJson(r.text(1));if(strOf(t,"mapId")==head(kb)&&strOf(t,"nodeId")==nid&&strOf(t,"kind")==kind&&db().scalarInt("SELECT COUNT(*) FROM sessions WHERE id=?",va([tv(r.text(0))]))>0){
                    if(!regenerate||db().getKv("meta","course-busy:"+r.text(0),"")==owner||db().getKv("meta","course-target-pending:"+r.text(0),"")=="1"){t.put("sessionId",JsonString(r.text(0)));t.put("existing",JsonBool(true));return t}
                }
            }
            let sid=SessionStore(dataDir).newId();if(project.size>0){ProjectStore(dataDir).bind(sid,project)}
            SessionStore(dataDir).rename(sid,strOf(n,"title")+" · "+kind)
            let t=JsonObject();t.put("sessionId",JsonString(sid));t.put("kbId",JsonString(kb));t.put("mapId",JsonString(head(kb)));t.put("nodeId",JsonString(nid));t.put("kind",JsonString(kind));t.put("title",JsonString(strOf(n,"title")));t.put("node",n);t.put("projectId",JsonString(project));t.put("expectedResourceId",JsonString(slot(nid,kind)))
            db().run("INSERT INTO course_targets VALUES (?,?,?)",va([tv(sid),tv(kb),tv(t.toString())]));db().putKv("meta","course-target-pending:"+sid,"1");return t
        }
    }
    public func commit(body: JsonObject): JsonObject{
        if(!boolOf(body,"confirmed")){throw Exception("预览满意后请确认收录，生成完成不代表确认")}
        synchronized(courseLock){
            let sid=strOf(body,"sessionId");let t=target(sid);if(strOf(t,"nodeId").size==0){throw Exception("这个会话没有节点资源目标")}
            let kb=strOf(t,"kbId");let nid=if(strOf(body,"targetNodeId").size>0){strOf(body,"targetNodeId")}else{strOf(t,"nodeId")}
            if(!boolOf(t,"valid")&&strOf(body,"targetNodeId").size==0){throw Exception("导图或节点已变化，请明确选择新节点后收录")}
            let n=node(kb,nid);let kind=strOf(t,"kind");let old=slot(nid,kind)
            let source=strOf(body,"path");var known=false;let ss=SessionStore(dataDir)
            for(ev in ss.events(sid)){
                let p=objOf(ev.get("payload").getOrDefault({=>JsonObject()})).getOrDefault({=>JsonObject()})
                if(strOf(ev,"type")=="resource/saved"&&strOf(p,"artifactPath")==source){known=true;body.put("learningId",JsonString(strOf(p,"id")));body.put("learningVersion",JsonInt(intOf(p,"version")))}
                if(strOf(ev,"type")=="artifact/created"&&strOf(p,"path")==source){known=true}
            }
            if(!known){throw Exception("只能收录该节点会话真正生成并留下记录的候选文件")}
            let lid=strOf(body,"learningId");let lv=intOf(body,"learningVersion")
            if(old!=strOf(body,"expectedResourceId")){
                if(old.size>0){let previous=assetBody(old);let copy=db().scalarText("SELECT path FROM personal_resources WHERE id=?",va([tv(old)]));if(strOf(previous,"sessionId")==sid&&strOf(previous,"sourcePath")==source&&strOf(previous,"learningId")==lid&&intOf(previous,"learningVersion")==lv&&sameBytes(source,copy)){return resource(old,false)}}
                throw Exception("这类资源已被另一会话更新，请核对当前版本再保存")
            }
            if(lid.size>0){let r=LearningStore(dataDir).resource(lid,lv);if(strOf(r,"sessionId")!=sid||strOf(r,"kind")!=kind){throw Exception("候选版本的会话或资源类型不匹配")}}
            body.put("sessionId",JsonString(sid));let personal=PersonalStore(dataDir).save(body);let saved=assetMetadata(personal);let id=strOf(saved,"id")
            if(old==id){return resource(id,false)}
            if(db().scalarInt("SELECT COUNT(*) FROM course_assets WHERE id=?",va([tv(id)]))>0){throw Exception("这份副本已经有节点归属，请通过归档关联操作处理")}
            saved.put("learningId",JsonString(lid));saved.put("learningVersion",JsonInt(lv));saved.put("kbId",JsonString(kb));saved.put("mapId",JsonString(head(kb)));saved.put("nodeId",JsonString(nid));saved.put("nodeTitle",JsonString(strOf(n,"title")));saved.put("kind",JsonString(kind));saved.put("ownedRoot",JsonString(PersonalStore(dataDir).directory()));saved.put("status",JsonString("current"))
            let ops=ArrayList<DbOp>();if(old.size>0){statusOps(assetBody(old),"archive","用户确认替换",ops)}
            ops.add(DbOp("INSERT INTO course_assets VALUES (?,?,?,?,?,'current',?,?)",va([tv(id),tv(kb),tv(head(kb)),tv(nid),tv(kind),tv(saved.toString()),tv(stamp())])))
            ops.add(DbOp("INSERT OR REPLACE INTO course_slots VALUES (?,?,?)",va([tv(nid),tv(kind),tv(id)])))
            db().batch(ops)
            t.put("expectedResourceId",JsonString(id));t.put("nodeId",JsonString(nid));t.put("mapId",JsonString(head(kb)));t.put("node",n);t.put("title",JsonString(strOf(n,"title")));db().run("UPDATE course_targets SET body=? WHERE session_id=?",va([tv(t.toString()),tv(sid)]));return resource(id,false)
        }
    }
    private func assetMetadata(personal: JsonObject): JsonObject{let out=JsonObject();for(key in ["id","title","path","sourcePath","version","sessionId","turnId","createdAt"]){out.put(key,personal.get(key).getOrDefault({=>JsonNull()}))};let path=strOf(personal,"path");out.put("copySignature",JsonString(fileSignature(path)));let companions=JsonObject();for(suffix in [".json",".preview.html"]){if(exists(path+suffix)){companions.put(suffix,JsonString(fileSignature(path+suffix)))}};out.put("companionSignatures",companions);return out}
    private func fileSignature(path: String): String{let bytes=File.readFrom(path);var hash: UInt64=0;for(b in bytes){hash=(hash*131+UInt64(b))%1000000007};return bytes.size.toString()+":"+hash.toString()}
    private func sameBytes(a: String,b: String): Bool{if(!exists(a)||!exists(b)){return false};let x=File.readFrom(a);let y=File.readFrom(b);if(x.size!=y.size){return false};var i=0;while(i<x.size){if(x[i]!=y[i]){return false};i+=1};return true}
    public func adopt(body: JsonObject): JsonObject{
        if(!boolOf(body,"confirmed")){throw Exception("请确认关联这份已有资源")}
        synchronized(courseLock){let kb=strOf(body,"kbId");let nid=strOf(body,"nodeId");let n=node(kb,nid);let kind=strOf(body,"kind");let id=strOf(body,"personalId");if(!courseKind(kind)){throw Exception("请选择四类资源之一")};if(db().scalarInt("SELECT COUNT(*) FROM course_assets WHERE id=?",va([tv(id)]))>0){throw Exception("资源已有节点归属，请从归档或当前节点管理")};let old=slot(nid,kind);if(old!=strOf(body,"expectedResourceId")){throw Exception("当前位置已变化，请重新核对")}
            let p=PersonalStore(dataDir).read(id);let lid=strOf(p,"learningId");let lv=intOf(p,"learningVersion");if(lid.size>0&&strOf(LearningStore(dataDir).resource(lid,lv),"kind")!=kind){throw Exception("已有学习资源类型不匹配，不能伪装成另一类")}
            let a=assetMetadata(p);a.put("kbId",JsonString(kb));a.put("nodeId",JsonString(nid));a.put("nodeTitle",JsonString(strOf(n,"title")));a.put("mapId",JsonString(head(kb)));a.put("kind",JsonString(kind));a.put("learningId",JsonString(lid));a.put("learningVersion",JsonInt(lv));a.put("ownedRoot",JsonString(PersonalStore(dataDir).directory()));a.put("status",JsonString("current"));let ops=ArrayList<DbOp>();if(old.size>0){statusOps(assetBody(old),"archive","用户关联已有资源",ops)};ops.add(DbOp("INSERT INTO course_assets VALUES (?,?,?,?,?,'current',?,?)",va([tv(id),tv(kb),tv(head(kb)),tv(nid),tv(kind),tv(a.toString()),tv(stamp())])));ops.add(DbOp("INSERT OR REPLACE INTO course_slots VALUES (?,?,?)",va([tv(nid),tv(kind),tv(id)])));db().batch(ops);return resource(id,false)
        }
    }
    public func relocate(id: String,source: String,confirmed: Bool): JsonObject{
        if(!confirmed){throw Exception("请确认重新定位这份文件")}
        synchronized(courseLock){let a=assetBody(id);let status=db().scalarText("SELECT status FROM course_assets WHERE id=?",va([tv(id)]));if(status=="purged"){throw Exception("资源已永久删除，不能恢复")};let destination=db().scalarText("SELECT path FROM personal_resources WHERE id=?",va([tv(id)]));if(!safeOwned(destination,strOf(a,"ownedRoot"))){throw Exception("副本位置已变化，拒绝写入登记目录之外")};if(exists(destination)){throw Exception("副本仍在原位置，不需要覆盖")};if(!exists(source)||strOf(a,"copySignature").size==0||fileSignature(source)!=strOf(a,"copySignature")){throw Exception("选择的不是原来确认的同一份文件；若要换内容，请作为新版本收录")};ensureDir(Path(destination).parent.toString());File.writeTo(destination,File.readFrom(source));let signatures=objOf(a.get("companionSignatures").getOrDefault({=>JsonObject()})).getOrDefault({=>JsonObject()});for(suffix in [".json",".preview.html"]){if(exists(source+suffix)&&strOf(signatures,suffix).size>0&&fileSignature(source+suffix)==strOf(signatures,suffix)){File.writeTo(destination+suffix,File.readFrom(source+suffix))}};return resource(id,true)
        }
    }
    private func safeOwned(path: String,root: String): Bool{
        let p=path.replace("\\","/").toAsciiLower();let r=root.replace("\\","/").toAsciiLower()
        return r.size>3&&hasPrefix(p,r+"/")&&!p.contains("/../")
    }
    /** Journal is committed with path changes; replay completes a move after a crash. */
    public func recoverFiles(): Unit{
        for(r in db().querySql("SELECT id,from_path,to_path FROM course_files WHERE status='pending'")){
            try{
                if(!exists(r.text(2))&&exists(r.text(1))){ensureDir(Path(r.text(2)).parent.toString());File.writeTo(r.text(2),File.readFrom(r.text(1)))}
                if(exists(r.text(2))){if(exists(r.text(1))&&r.text(1)!=r.text(2)){remove(r.text(1))};db().run("UPDATE course_files SET status='done' WHERE id=?",va([tv(r.text(0))]))}
            }catch(e: Exception){()}
        }
    }
    private func statusOps(a: JsonObject,status: String,reason: String,ops: ArrayList<DbOp>): Unit{
        let id=strOf(a,"id");let root=strOf(a,"ownedRoot");let from=db().scalarText("SELECT path FROM personal_resources WHERE id=?",va([tv(id)]))
        let folder=if(status=="current"){"学习资源"}else if(status=="archive"){"归档"}else{"回收站"}
        let destination=root+Path.Separator+folder+Path.Separator+strOf(a,"kbId")+Path.Separator+id+"-"+baseNameOf(strOf(a,"sourcePath"))
        if(!safeOwned(from,root)||!safeOwned(destination,root)){throw Exception("资源不在已登记的副本目录，拒绝移动原始资料")}
        a.put("status",JsonString(status));a.put("archiveReason",JsonString(reason));a.put("updatedAt",JsonString(stamp()))
        ops.add(DbOp("UPDATE course_assets SET status=?,node_id=?,map_id=?,body=?,updated_at=? WHERE id=?",va([tv(status),tv(strOf(a,"nodeId")),tv(strOf(a,"mapId")),tv(a.toString()),tv(stamp()),tv(id)])))
        if(status!="current"){ops.add(DbOp("DELETE FROM course_slots WHERE resource_id=?",va([tv(id)])))}
        if(from!=destination){for(suffix in ["",".json",".preview.html"]){if(exists(from+suffix)){ops.add(DbOp("INSERT INTO course_files VALUES (?,?,?,'pending')",va([tv(courseId("move-")),tv(from+suffix),tv(destination+suffix)])))}}}
        ops.add(DbOp("UPDATE personal_resources SET path=? WHERE id=?",va([tv(destination),tv(id)])))
        ops.add(DbOp("UPDATE content_index SET path=? WHERE type='resource' AND id=?",va([tv(destination),tv(id)])))
    }
    private func changeStatus(id: String,status: String,reason: String): Unit{
        let ops=ArrayList<DbOp>();statusOps(assetBody(id),status,reason,ops);db().batch(ops);recoverFiles()
    }
    public func action(id: String,action: String,kbIn: String,nodeIn: String,expected: String,confirmed: Bool): JsonObject{
        if(!confirmed){throw Exception("请确认这项资源操作")}
        synchronized(courseLock){
            let a=assetBody(id);let status=db().scalarText("SELECT status FROM course_assets WHERE id=?",va([tv(id)]))
            if(status=="purged"){throw Exception("资源已永久删除")}
            if(action=="archive"||action=="trash"){changeStatus(id,action,if(action=="trash"){"用户移入回收站"}else{"用户归档"});return resource(id,true)}
            if(action=="restore"||action=="attach"){
                let kb=if(kbIn.size>0){kbIn}else{strOf(a,"kbId")};let nid=if(nodeIn.size>0){nodeIn}else{strOf(a,"nodeId")};let n=node(kb,nid)
                if(kb!=strOf(a,"kbId")){throw Exception("请先在原知识库中关联资源，不自动跨库移动")}
                let kind=strOf(a,"kind");let old=slot(nid,kind)
                if(old!=expected){throw Exception("当前位置已有新版本，请先核对替换对象")}
                if(old==id){return resource(id,false)}
                let ops=ArrayList<DbOp>();if(old.size>0){statusOps(assetBody(old),"archive","恢复或关联另一份资源",ops)}
                a.put("nodeId",JsonString(nid));a.put("nodeTitle",JsonString(strOf(n,"title")));a.put("mapId",JsonString(head(kb)))
                statusOps(a,"current","用户恢复/关联",ops)
                ops.add(DbOp("DELETE FROM course_slots WHERE resource_id=?",va([tv(id)])))
                ops.add(DbOp("INSERT OR REPLACE INTO course_slots VALUES (?,?,?)",va([tv(nid),tv(kind),tv(id)])));db().batch(ops);return resource(id,false)
            }
            if(action=="purge"){
                if(status!="trash"){throw Exception("先移入回收站，再单独确认永久删除")}
                let path=db().scalarText("SELECT path FROM personal_resources WHERE id=?",va([tv(id)]));if(!safeOwned(path,strOf(a,"ownedRoot"))){throw Exception("拒绝删除登记目录以外的文件")}
                for(suffix in ["",".json",".preview.html"]){if(exists(path+suffix)){remove(path+suffix)}}
                db().batch(va2([DbOp("UPDATE course_assets SET status='purged' WHERE id=?",va([tv(id)])),DbOp("DELETE FROM personal_resources WHERE id=?",va([tv(id)])),DbOp("DELETE FROM content_index WHERE type='resource' AND id=?",va([tv(id)]))]));let o=JsonObject();o.put("purged",JsonBool(true));return o
            }
            throw Exception("资源操作不支持")
        }
    }
    public func editNode(kb: String,nid: String,body: JsonObject): JsonObject{
        synchronized(courseLock){
            let current=map(head(kb));let original=node(kb,nid);let ns=arrOf(current,"nodes");let out=JsonArray();let removing=boolOf(body,"remove")
            if(removing&&!boolOf(body,"confirmed")){throw Exception("请先确认删除节点及资源归档范围")}
            if(removing&&strOf(original,"parentId").size==0){throw Exception("根节点代表知识库，请通过导图或知识库管理操作")}
            let removed=HashSet<String>();if(removing){removed.add(nid)}
            if(removing&&boolOf(body,"subtree")){var changed=true;while(changed){changed=false;var i=0;while(i<ns.size()){let n=objOf(ns[i]).getOrThrow();i+=1;if(removed.contains(strOf(n,"parentId"))&&!removed.contains(strOf(n,"id"))){removed.add(strOf(n,"id"));changed=true}}}}
            var i=0;let byId=HashMap<String,JsonObject>()
            while(i<ns.size()){let n=objOf(ns[i]).getOrThrow();i+=1;let id=strOf(n,"id");if(removed.contains(id)){continue}
                if(removing&&strOf(n,"parentId")==nid){n.put("parentId",JsonString(strOf(original,"parentId")))}
                if(id==nid){if(strOf(body,"title").size>0){n.put("title",JsonString(trimStr(byteSafePrefix(strOf(body,"title"),180))))};if(body.get("description").isSome()){n.put("description",JsonString(byteSafePrefix(strOf(body,"description"),1800)))};if(body.get("parentId").isSome()){if(strOf(original,"parentId").size==0){throw Exception("根节点不能改挂到其他节点")};if(strOf(body,"parentId").size==0){throw Exception("不能创建第二个根节点")};n.put("parentId",JsonString(strOf(body,"parentId")))}}
                byId[id]=n;out.add(n)
            }
            let names=HashSet<String>();i=0
            while(i<out.size()){let n=objOf(out[i]).getOrThrow();i+=1;var parent=strOf(n,"parentId");var depth: Int64=1;let seen=HashSet<String>();seen.add(strOf(n,"id"));while(parent.size>0){if(seen.contains(parent)||!byId.contains(parent)){throw Exception("移动会形成循环或引用已删除节点")};seen.add(parent);depth+=1;if(depth>4){throw Exception("移动后超过四级，请调整层级")};parent=strOf(byId[parent],"parentId")};n.put("depth",JsonInt(depth));let key=strOf(n,"parentId")+"\n"+strOf(n,"title").toAsciiLower();if(names.contains(key)){throw Exception("同级节点名称重复")};names.add(key)}
            let ops=ArrayList<DbOp>();let assets=resources(kb,"current");i=0
            while(i<assets.size()){let a=objOf(assets[i]).getOrThrow();i+=1;if(removed.contains(strOf(a,"nodeId"))){statusOps(a,"archive","原节点被删除",ops)}}
            current.put("nodes",out);ops.add(DbOp("UPDATE course_maps SET body=?,updated_at=? WHERE id=?",va([tv(current.toString()),tv(stamp()),tv(head(kb))])));db().batch(ops)
            if(body.get("done").isSome()&&!removing){let previous=courseJson(db().getKv("meta","course-node-progress:"+nid,"{\"done\":false}"));let progress=JsonObject();progress.put("done",JsonBool(boolOf(body,"done")));progress.put("at",JsonString(stamp()));db().putKv("meta","course-node-progress:"+nid,progress.toString());if(boolOf(previous,"done")!=boolOf(progress,"done")){progress.put("kind",JsonString("node-complete"));progress.put("title",JsonString(strOf(original,"title")));db().run("INSERT INTO course_events VALUES (?,?,?,?,?)",va([tv(courseId("evidence-")),tv(kb),tv(nid),tv(progress.toString()),tv(stamp())]))}}
            return state(kb)
        }
    }
    public func report(kb: String): JsonObject{
        let out=state(kb);let id=head(kb);let rows=JsonArray();var done: Int64=0;var total: Int64=0
        if(id.size>0){let ns=arrOf(map(id),"nodes");let assets=arrOf(out,"resources");var i=0
            while(i<ns.size()){let n=objOf(ns[i]).getOrThrow();i+=1;let nid=strOf(n,"id");let p=courseJson(db().getKv("meta","course-node-progress:"+nid,"{\"done\":false}"));n.put("done",JsonBool(boolOf(p,"done")));if(intOf(n,"depth")>1){total+=1;if(boolOf(p,"done")){done+=1}}
                let rs=JsonArray();var j=0;var attempts: Int64=0;var correct: Int64=0
                while(j<assets.size()){let a=objOf(assets[j]).getOrThrow();j+=1;if(strOf(a,"nodeId")!=nid){continue};rs.add(a);let lid=strOf(a,"learningId");let version=intOf(a,"learningVersion")
                    if(lid.size>0){for(r in db().query("SELECT correct,first_attempt FROM learning_events WHERE resource_id=? AND version=? AND kind='quiz'",va([tv(lid),nv(version)]))){if(r.int(1)==1){attempts+=1;correct+=r.int(0)}}}
                }
                n.put("resources",rs);n.put("quizAttempts",JsonInt(attempts));n.put("quizCorrect",JsonInt(correct));rows.add(n)
            }
        }
        let history=JsonArray();var quizTotal: Int64=0;var quizRight: Int64=0
        for(r in db().query("SELECT id,kind,resource_id,version,payload,at,correct,first_attempt,topic FROM learning_events WHERE kb_id=? ORDER BY at DESC",va([tv(kb)]))){let e=courseJson(r.text(4));e.put("eventId",JsonString(r.text(0)));e.put("kind",JsonString(r.text(1)));e.put("at",JsonString(r.text(5)));e.put("title",JsonString(r.text(8)));e.put("correct",JsonBool(r.int(6)!=0));e.put("firstAttempt",JsonBool(r.int(7)!=0));history.add(e);if(r.text(1)=="quiz"&&r.int(7)==1){quizTotal+=1;quizRight+=r.int(6)}}
        for(r in db().query("SELECT id,body,at FROM course_events WHERE kb_id=? ORDER BY at DESC",va([tv(kb)]))){let e=courseJson(r.text(1));e.put("eventId",JsonString(r.text(0)));e.put("at",JsonString(r.text(2)));history.add(e)}
        out.put("nodes",rows);out.put("completedNodes",JsonInt(done));out.put("totalNodes",JsonInt(total));out.put("history",history);out.put("quizAttempts",JsonInt(quizTotal));out.put("quizCorrect",JsonInt(quizRight));out.put("activity",courseActivity(dataDir,kb));out.put("basis",JsonString("学完是本人标记；测验使用首次作答证据，归档不清除历史。资源份数和阅读量不换算为掌握度。"));return out
    }
    /** 学习活跃度聚合；与 report、Lumin 工具共用同一份计算。 */
    public func activity(kb: String): JsonObject{return courseActivity(dataDir,kb)}
    public func removeKb(kb: String): Unit{
        synchronized(courseLock){
            let settings=Store(dataDir).load();let library=settings.findKb(kb).getOrThrow();let snapshot=library.toJson();snapshot.put("mapId",JsonString(head(kb)))
            db().putKv("meta","course-deleted-kb:"+kb,snapshot.toString());let ops=ArrayList<DbOp>();let assets=resources(kb,"current");var i=0
            while(i<assets.size()){let a=objOf(assets[i]).getOrThrow();i+=1;statusOps(a,"archive","知识库被移除",ops)}
            if(head(kb).size>0){ops.add(DbOp("UPDATE course_maps SET status='trash' WHERE id=?",va([tv(head(kb))])))}
            ops.add(DbOp("DELETE FROM meta WHERE k=?",va([tv("course-head:"+kb)])));db().batch(ops)
            let kept=ArrayList<KnowledgeBase>();for(l in settings.knowledgeBases){if(l.id!=kb){kept.add(l)}};settings.knowledgeBases=kept;Store(dataDir).save(settings);recoverFiles()
        }
    }
    public func deletedKbs(): JsonArray{let out=JsonArray();for(r in db().querySql("SELECT v FROM meta WHERE instr(k,'course-deleted-kb:')=1")){out.add(courseJson(r.text(0)))};return out}
    public func restoreKb(kb: String,confirmed: Bool): JsonObject{
        if(!confirmed){throw Exception("请确认恢复知识库")}
        synchronized(courseLock){let raw=db().getKv("meta","course-deleted-kb:"+kb,"");if(raw.size==0){throw Exception("找不到已移除的知识库")};let snapshot=courseJson(raw);let s=Store(dataDir).load();if(s.findKb(kb).isSome()){throw Exception("同一知识库已经存在，不能覆盖")};s.knowledgeBases.add(KnowledgeBase.fromJson(snapshot));Store(dataDir).save(s)
            let id=strOf(snapshot,"mapId");if(id.size>0){db().run("UPDATE course_maps SET status='current' WHERE id=?",va([tv(id)]));db().putKv("meta","course-head:"+kb,id)};db().run("DELETE FROM meta WHERE k=?",va([tv("course-deleted-kb:"+kb)]));return state(kb)
        }
    }
}
