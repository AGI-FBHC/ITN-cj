package itn_desktop_core.knowledge

import std.collection.*
import std.random.*
import std.time.*
import std.sync.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.project.ProjectStore
import itn_desktop_core.personal.PersonalStore
import itn_desktop_core.util.*

let knowledgeLock=Mutex()
func canonical(text: String): String{return trimStr(text).toAsciiLower().replace(" ","").replace("　","").replace("\n","")}
func isHexColor(s: String): Bool{
    let b=s.toArray()
    if(b.size!=7||b[0]!=35){return false}
    for(i in 1..7){let c=b[i];if(!((c>=48&&c<=57)||(c>=97&&c<=102)||(c>=65&&c<=70))){return false}}
    return true
}
func aliasesOf(body: JsonObject): JsonArray{match(body.get("aliases")){case Some(v)=>match(v){case a: JsonArray=>return a;case _=>()};case None=>()};return JsonArray()}
public class KnowledgeStore {
    let dataDir: String
    public init(dataDir: String){this.dataDir=dataDir}
    func db(): Db{return DbHub.open(dataDir)}
    func nodeJson(row: DbRow): JsonObject{
        let o=JsonObject();o.put("id",JsonString(row.text(0)));o.put("title",JsonString(row.text(1)));o.put("definition",JsonString(row.text(2)))
        try{o.put("aliases",JsonValue.fromStr(row.text(3)))}catch(e: Exception){o.put("aliases",JsonArray())}
        o.put("userEdited",JsonBool(row.int(4)>0));o.put("createdAt",JsonString(row.text(5)));o.put("updatedAt",JsonString(row.text(6)));o.put("color",JsonString(row.text(7)))
        o.put("recordCount",JsonInt(db().scalarInt("SELECT COUNT(*) FROM knowledge_records WHERE node_id=?",va([tv(row.text(0))]))));return o
    }
    public func graph(): JsonObject{
        let out=JsonObject();let nodes=JsonArray();let links=JsonArray()
        for(r in db().querySql("SELECT id,title,definition,aliases,user_edited,created_at,updated_at,color FROM knowledge_nodes ORDER BY created_at,id")){nodes.add(nodeJson(r))}
        for(r in db().querySql("SELECT from_id,to_id,label FROM knowledge_links")){let l=JsonObject();l.put("from",JsonString(r.text(0)));l.put("to",JsonString(r.text(1)));l.put("label",JsonString(r.text(2)));links.add(l)}
        out.put("nodes",nodes);out.put("links",links);return out
    }
    public func read(id: String): JsonObject{
        let rows=db().query("SELECT id,title,definition,aliases,user_edited,created_at,updated_at,color FROM knowledge_nodes WHERE id=?",va([tv(id)]))
        if(rows.size==0){throw Exception("找不到这个知识点")};let out=nodeJson(rows[0]);let records=JsonArray();let notes=JsonArray()
        for(r in db().query("SELECT id,session_id,turn_id,project_id,workspace_name,workspace_root,question,note,at FROM knowledge_records WHERE node_id=? ORDER BY at DESC",va([tv(id)]))){
            let o=JsonObject();let keys=["id","sessionId","turnId","projectId","workspaceName","workspaceRoot","question","note","at"]
            for(i in 0..keys.size){o.put(keys[i],JsonString(r.text(i)))};records.add(o)
        }
        for(r in db().query("SELECT n.id,n.title,n.text,n.created_at FROM notes n JOIN knowledge_notes l ON l.note_id=n.id WHERE l.node_id=? ORDER BY n.created_at DESC",va([tv(id)]))){let o=JsonObject();o.put("id",JsonString(r.text(0)));o.put("title",JsonString(r.text(1)));o.put("text",JsonString(r.text(2)));o.put("at",JsonString(r.text(3)));notes.add(o)}
        out.put("records",records);out.put("notes",notes);return out
    }
    public func indexNode(id: String): Unit{
        let node=read(id);var text=strOf(node,"definition")
        match(node.get("records")){case Some(a: JsonArray)=>var i=0;while(i<a.size()){let r=objOf(a[i]).getOrThrow();i+=1;text+="\n"+strOf(r,"question")+"\n"+strOf(r,"note")};case _=>()}
        match(node.get("notes")){case Some(a: JsonArray)=>var i=0;while(i<a.size()){let n=objOf(a[i]).getOrThrow();i+=1;text+="\n"+strOf(n,"text")};case _=>()}
        PersonalStore(dataDir).index("knowledge",id,strOf(node,"title"),text,"","")
    }
    public func save(body: JsonObject,manual: Bool,sid: String,tid: String,question: String,workspace: String): JsonObject{
        let title=trimStr(byteSafePrefix(strOf(body,"title"),150));let key=canonical(title)
        if(key.size==0){throw Exception("请填写知识点名称")}
        if(!manual){
            let sourceQuote=strOf(body,"quote")
            if(sourceQuote.size==0||!question.contains(sourceQuote)){throw Exception("知识记录需要本轮用户原话依据")}
            if(["你好","在吗","谢谢","好的"].contains(trimStr(question))){throw Exception("闲聊不自动记为知识点")}
            if((question.contains("创建")||question.contains("制作")||question.contains("生成"))&&(question.toAsciiLower().contains("html")||question.contains("文件")||question.toAsciiLower().contains("ppt")||question.contains("讲义")||question.contains("练习册"))&&!question.contains("解释")&&!question.contains("原理")&&!question.contains("讲解")){throw Exception("一次性制作指令不自动记为知识点")}
        }
        let hasColorField=match(body.get("color")){case Some(_)=>true;case None=>false}
        var colorIn=""
        if(hasColorField){let raw=trimStr(strOf(body,"color"));if(raw.size>0){let normalized=if(raw.startsWith("#")){raw}else{"#"+raw};if(!isHexColor(normalized)){throw Exception("节点颜色要用 #RRGGBB 格式")};colorIn=normalized.toAsciiUpper()}}
        synchronized(knowledgeLock){
            var id=strOf(body,"id");var existing: ?JsonObject=None
            if(id.size>0){existing=read(id)}else{
                let rows=db().query("SELECT id FROM knowledge_nodes WHERE canonical=?",va([tv(key)]))
                if(rows.size>0){id=rows[0].text(0);existing=read(id)}else{
                    for(row in db().querySql("SELECT id,aliases FROM knowledge_nodes")){
                        let aliases=objOf(JsonValue.fromStr("{\"aliases\":"+row.text(1)+"}")).getOrThrow();let a=aliasesOf(aliases);var i=0
                        while(i<a.size()){if(canonical(strValue(a[i]))==key){id=row.text(0);existing=read(id);break};i+=1}
                        if(id.size>0){break}
                    }
                }
            }
            let now=DateTime.now().toString();var created=now;var finalTitle=title;var definition=byteSafePrefix(strOf(body,"definition"),3000);var edited=manual;var finalColor=colorIn;let aliases=JsonArray();let seen=HashSet<String>()
            func addAliases(a: JsonArray): Unit{var i=0;while(i<a.size()){let value=trimStr(strValue(a[i]));i+=1;if(value.size>0&&!seen.contains(canonical(value))){seen.add(canonical(value));aliases.add(JsonString(value))}}}
            match(existing){
                case Some(old)=>
                    created=strOf(old,"createdAt");edited=manual||boolOf(old,"userEdited");addAliases(aliasesOf(old))
                    if(!manual){finalTitle=strOf(old,"title");definition=strOf(old,"definition")}
                    else if(title!=strOf(old,"title")){let previous=JsonArray();previous.add(JsonString(strOf(old,"title")));addAliases(previous)}
                    if(!manual||!hasColorField){finalColor=strOf(old,"color")}
                case None=>id="kp-"+Random().nextUInt64().toString()
            }
            addAliases(aliasesOf(body))
            if(db().scalarInt("SELECT COUNT(*) FROM knowledge_nodes WHERE canonical=? AND id<>?",va([tv(canonical(finalTitle)),tv(id)]))>0){throw Exception("已有同名知识点，请选择该节点或使用不同名称")}
            db().run("INSERT OR REPLACE INTO knowledge_nodes VALUES (?,?,?,?,?,?,?,?,?)",va([tv(id),tv(canonical(finalTitle)),tv(finalTitle),tv(definition),tv(aliases.toString()),nv(if(edited){1}else{0}),tv(created),tv(now),tv(finalColor)]))
            if(!manual){
                let pid=db().getKv("sessions_meta","project:"+sid,"");var name="普通对话";var root=workspace
                for(p in ProjectStore(dataDir).list()){if(p.id==pid){name=p.name;root=p.root}}
                db().run("INSERT OR IGNORE INTO knowledge_records VALUES (?,?,?,?,?,?,?,?,?,?)",va([tv("kr-"+Random().nextUInt64().toString()),tv(id),tv(sid),tv(tid),tv(pid),tv(name),tv(root),tv(question),tv(byteSafePrefix(strOf(body,"note"),4000)),tv(now)]))
            }
            indexNode(id);return read(id)
        }
    }
    public func addNote(id: String,text: String): JsonObject{
        let node=read(id);if(trimStr(text).size==0){throw Exception("请写下笔记内容")}
        let noteId="kn-"+Random().nextUInt64().toString();let now=DateTime.now().toString();let ops=ArrayList<DbOp>()
        ops.add(DbOp("INSERT INTO notes VALUES (?,'',?,?,?,?)",va([tv(noteId),tv(strOf(node,"title")),tv(strOf(node,"title")+" · 我的笔记"),tv(text),tv(now)])))
        ops.add(DbOp("INSERT INTO knowledge_notes VALUES (?,?)",va([tv(id),tv(noteId)])));db().batch(ops);PersonalStore(dataDir).refreshStudyIndex();indexNode(id);return read(id)
    }
    public func link(a: String,b: String,label: String,remove: Bool): Unit{
        if(a==b||a.size==0||b.size==0){throw Exception("请选择两个不同知识点")};read(a);read(b)
        let first=if(a<b){a}else{b};let second=if(a<b){b}else{a}
        if(remove){db().run("DELETE FROM knowledge_links WHERE from_id=? AND to_id=?",va([tv(first),tv(second)]))}
        else{db().run("INSERT OR REPLACE INTO knowledge_links VALUES (?,?,?,?)",va([tv(first),tv(second),tv(if(label.size>0){byteSafePrefix(label,100)}else{"关联"}),tv(DateTime.now().toString())]))}
    }
    public func delete(id: String): Unit{
        let ops=ArrayList<DbOp>()
        for(table in ["knowledge_records","knowledge_notes"]){ops.add(DbOp("DELETE FROM "+table+" WHERE node_id=?",va([tv(id)])))}
        ops.add(DbOp("DELETE FROM knowledge_links WHERE from_id=? OR to_id=?",va([tv(id),tv(id)])))
        ops.add(DbOp("DELETE FROM knowledge_nodes WHERE id=?",va([tv(id)])))
        ops.add(DbOp("DELETE FROM content_index WHERE type='knowledge' AND id=?",va([tv(id)])));db().batch(ops)
    }
}
