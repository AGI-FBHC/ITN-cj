package itn_desktop_core.personal

import std.collection.*
import std.convert.*
import std.fs.*
import std.time.*
import std.random.*
import std.sync.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.kb.baseNameOf
import itn_desktop_core.util.*
import itn_desktop_core.presentation.DesktopJobs

let personalLock=Mutex()
/** Course archive/trash is hidden from default personal discovery, including Agent tools. */
public func personalResourceVisible(dataDir: String,id: String): Bool{
    let state=DbHub.open(dataDir).scalarText("SELECT status FROM course_assets WHERE id=?",va([tv(id)]))
    return state.size==0||state=="current"
}
public class PersonalStore {
    let dataDir: String
    public init(dataDir: String){this.dataDir=dataDir}
    func db(): Db{return DbHub.open(dataDir)}
    public func directory(): String{return db().getKv("settings","personal_resource_dir",dataDir+Path.Separator+"artifacts")}
    public func configure(dir: String): Unit{
        if(dir.size==0){return}
        if(!dir.contains(":\\") && !dir.contains(":/") && !hasPrefix(dir,"/") && !hasPrefix(dir,"\\\\")){throw Exception("请选择绝对目录")}
        ensureDir(dir);db().putKv("settings","personal_resource_dir",dir)
    }
    public func index(kind: String,id: String,title: String,text: String,path: String,learningId: String): Unit{
        db().run("INSERT OR REPLACE INTO content_index(type,id,title,body,path,learning_id,updated_at) VALUES (?,?,?,?,?,?,?)",va([tv(kind),tv(id),tv(title),tv(byteSafePrefix(text,1500000)),tv(path),tv(learningId),tv(DateTime.now().toString())]))
    }
    func kindOf(path: String): String{return Path(path).extensionName.toAsciiLower()}
    func allowed(kind: String): Bool{
        return ["md","markdown","txt","html","htm","svg","pptx","ppt","pptm","docx","doc","docm","pdf","png","jpg","jpeg","webp","gif","csv","json","js","css","xlsx","xls"].contains(kind)
    }
    func nativeText(path: String,kind: String): String{
        if(["md","markdown","txt","html","htm","svg","csv","json","js","css"].contains(kind)){
            try{return byteSafePrefix(readTextOr(path,""),1500000)}catch(e: Exception){return ""}
        }
        return ""
    }
    func rowJson(row: DbRow): JsonObject{
        let o=JsonObject();let names=["id","title","path","sourcePath","kind"]
        for(i in 0..5){o.put(names[i],JsonString(row.text(i)))}
        o.put("version",JsonInt(row.int(5)))
        let learning=row.text(6).split(":v");let learningId=if(learning.size>0){learning[0]}else{""};o.put("learningId",JsonString(learningId))
        if(learningId.size>0){o.put("learningKind",JsonString(db().scalarText("SELECT kind FROM learning_resources WHERE id=?",va([tv(learningId)]))))}
        if(learning.size>1){try{o.put("learningVersion",JsonInt(Int64.parse(learning[1])))}catch(e: Exception){()}}
        o.put("sessionId",JsonString(row.text(7)));o.put("turnId",JsonString(row.text(8)));o.put("createdAt",JsonString(row.text(9)));return o
    }
    public func scan(): Unit{
        let root=directory();ensureDir(root)
        Directory.walk(Path(root),{fi: FileInfo =>
            if(!fi.isDirectory()){
                let file=root+Path.Separator+fi.name;let kind=kindOf(file)
                if(allowed(kind)&&!hasSuffix(file,".preview.html")&&!hasSuffix(file,".pptx.json")&&db().scalarInt("SELECT COUNT(*) FROM course_files WHERE from_path=?",va([tv(file)]))==0&&db().scalarInt("SELECT COUNT(*) FROM personal_resources WHERE path=?",va([tv(file)]))==0){
                    let id="personal-"+Random().nextUInt64().toString();let title=baseNameOf(file)
                    db().run("INSERT INTO personal_resources VALUES (?,?,?,?,?,1,'','','',?)",va([tv(id),tv(title),tv(file),tv(file),tv(kind),tv(DateTime.now().toString())]))
                    index("resource",id,title,nativeText(file,kind),file,"")
                    if(["pptx","docx","pdf"].contains(kind)){DesktopJobs(dataDir).queueExtract(file,id)}
                }
            }
            false
        })
    }
    public func list(): JsonArray{
        scan();let out=JsonArray()
        for(row in db().querySql("SELECT id,title,path,source_path,kind,version,learning_id,session_id,turn_id,created_at FROM personal_resources ORDER BY created_at DESC")){if(personalResourceVisible(dataDir,row.text(0))&&exists(row.text(2))&&hasPrefix(row.text(2),directory()+Path.Separator)){out.add(rowJson(row))}}
        return out
    }
    public func read(id: String): JsonObject{
        if(!personalResourceVisible(dataDir,id)){throw Exception("资源已归档或移入回收站，请从对应管理入口明确读取")}
        let rows=db().query("SELECT id,title,path,source_path,kind,version,learning_id,session_id,turn_id,created_at FROM personal_resources WHERE id=?",va([tv(id)]))
        if(rows.size==0){throw Exception("找不到这份个性资源")}
        let o=rowJson(rows[0]);o.put("text",JsonString(db().scalarText("SELECT body FROM content_index WHERE type='resource' AND id=?",va([tv(id)]))));return o
    }
    public func readIndexed(kind: String,id: String): JsonObject{
        if(kind=="resource"||kind.size==0){return read(id)}
        let rows=db().query("SELECT title,body FROM content_index WHERE type=? AND id=?",va([tv(kind),tv(id)]))
        if(rows.size==0){throw Exception("找不到这条索引记录")};let o=JsonObject();o.put("type",JsonString(kind));o.put("id",JsonString(id));o.put("title",JsonString(rows[0].text(0)));o.put("text",JsonString(rows[0].text(1)));return o
    }
    public func reindex(id: String,text: String): Unit{
        let item=read(id)
        index("resource",id,strOf(item,"title"),text,strOf(item,"path"),strOf(item,"learningId"))
    }
    func identical(a: Array<UInt8>,b: Array<UInt8>): Bool{
        if(a.size!=b.size){return false};var i=0;while(i<a.size){if(a[i]!=b[i]){return false};i+=1};return true
    }
    public func save(body: JsonObject): JsonObject{
        if(!boolOf(body,"confirmed")){throw Exception("请先确认是否存入个性资源")}
        synchronized(personalLock){
            let source=strOf(body,"path");let kind=kindOf(source)
            if(source.size==0||!exists(source)||!allowed(kind)){throw Exception("文件不存在或不支持保存此格式")}
            let bytes=File.readFrom(source);if(bytes.size>32*1024*1024){throw Exception("个性资源文件不能超过32MiB")}
            let baseLearning=strOf(body,"learningId");let encodedLearning=baseLearning+(if(intOf(body,"learningVersion")>0){":v"+intOf(body,"learningVersion").toString()}else{""})
            var version: Int64=1
            for(row in db().query("SELECT id,path,version,learning_id FROM personal_resources WHERE source_path=? OR (session_id<>'' AND session_id=? AND title=?) OR (?<>'' AND (learning_id=? OR instr(learning_id,?)=1)) ORDER BY version DESC",va([tv(source),tv(strOf(body,"sessionId")),tv(strOf(body,"title")),tv(baseLearning),tv(baseLearning),tv(baseLearning+":v")]))){
                if(personalResourceVisible(dataDir,row.text(0))&&(baseLearning.size==0||row.text(3)==encodedLearning)&&hasPrefix(row.text(1),directory()+Path.Separator)&&exists(row.text(1))&&identical(bytes,File.readFrom(row.text(1)))){return read(row.text(0))}
                if(row.int(2)>=version){version=row.int(2)+1}
            }
            let id="personal-"+Random().nextUInt64().toString();let root=directory();ensureDir(root)
            let destination=root+Path.Separator+id+"-"+baseNameOf(source)
            File.writeTo(destination,bytes)
            for(suffix in [".json",".preview.html"]){if(exists(source+suffix)){File.writeTo(destination+suffix,File.readFrom(source+suffix))}}
            let title=if(strOf(body,"title").size>0){strOf(body,"title")}else{baseNameOf(source)}
            let learningId=encodedLearning
            db().run("INSERT INTO personal_resources VALUES (?,?,?,?,?,?,?,?,?,?)",va([tv(id),tv(title),tv(destination),tv(source),tv(kind),nv(version),tv(learningId),tv(strOf(body,"sessionId")),tv(strOf(body,"turnId")),tv(DateTime.now().toString())]))
            var text=if(strOf(body,"text").size>0){strOf(body,"text")}else{nativeText(source,kind)}
            if(text.size==0&&["pptx","docx","pdf"].contains(kind)){
                try{text=strOf(DesktopJobs(dataDir).extractFile(source),"text")}catch(e: Exception){text=""}
            }
            index("resource",id,title,text,destination,learningId)
            if(text.size==0&&["pptx","docx","pdf"].contains(kind)){DesktopJobs(dataDir).queueExtract(destination,id)}
            return read(id)
        }
    }
    public func refreshStudyIndex(): Unit{
        let ops=ArrayList<DbOp>()
        for(row in db().querySql("SELECT id,title,text,created_at FROM notes")){ops.add(DbOp("INSERT OR REPLACE INTO content_index VALUES ('note',?,?,?,'','',?)",va([tv(row.text(0)),tv(row.text(1)),tv(row.text(2)),tv(row.text(3))])))}
        for(row in db().querySql("SELECT id,question,my_answer,reference,created_at FROM quiz_records WHERE correct=0")){ops.add(DbOp("INSERT OR REPLACE INTO content_index VALUES ('wrong',?,?,?,'','',?)",va([tv(row.text(0)),tv(row.text(1)),tv(row.text(1)+"\n我的答案："+row.text(2)+"\n参考答案："+row.text(3)),tv(row.text(4))])))}
        ops.add(DbOp("DELETE FROM content_index WHERE type='note' AND id NOT IN (SELECT id FROM notes)",ArrayList<DbValue>()))
        ops.add(DbOp("DELETE FROM content_index WHERE type='wrong' AND id NOT IN (SELECT id FROM quiz_records WHERE correct=0)",ArrayList<DbValue>()))
        db().batch(ops)
        db().exec("UPDATE content_index SET title=(SELECT title FROM knowledge_nodes k WHERE k.id=content_index.id),body=(SELECT definition||char(10)||COALESCE((SELECT group_concat(question||char(10)||note,char(10)) FROM knowledge_records r WHERE r.node_id=k.id),'')||char(10)||COALESCE((SELECT group_concat(n.text,char(10)) FROM notes n JOIN knowledge_notes l ON l.note_id=n.id WHERE l.node_id=k.id),'') FROM knowledge_nodes k WHERE k.id=content_index.id) WHERE type='knowledge'")
    }
    func hitJson(row: DbRow,snippet: String): JsonObject{
        let o=JsonObject();o.put("type",JsonString(row.text(0)));o.put("id",JsonString(row.text(1)));o.put("title",JsonString(row.text(2)))
        o.put("path",JsonString(row.text(4)));o.put("learningId",JsonString(row.text(5)));o.put("snippet",JsonString(byteSafePrefix(snippet,240)))
        return o
    }
    /** 各类已索引内容的数量；resource 只统计仍在个性资源目录里的文件。回答"我有什么"类问题用它，不能拿空命中当"没有内容"。 */
    public func counts(): JsonObject{
        refreshStudyIndex();let o=JsonObject()
        for(k in ["knowledge","note","wrong"]){o.put(k,JsonInt(db().scalarInt("SELECT COUNT(*) FROM content_index WHERE type=?",va([tv(k)]))))}
        var live: Int64=0
        for(row in db().querySql("SELECT path,id FROM content_index WHERE type='resource'")){if(personalResourceVisible(dataDir,row.text(1))&&exists(row.text(0))&&hasPrefix(row.text(0),directory()+Path.Separator)){live=live+1}}
        o.put("resource",JsonInt(live))
        return o
    }
    /** 最近条目：按更新时间倒序，可按类型过滤；给"我的知识网络/笔记里有什么"这类问题兜底。 */
    public func recent(kind: String,limitIn: Int64): JsonArray{
        refreshStudyIndex();let out=JsonArray();let limit=if(limitIn>0&&limitIn<100){limitIn}else{30}
        let rows=if(kind.size>0){db().query("SELECT type,id,title,body,path,learning_id FROM content_index WHERE type=? ORDER BY updated_at DESC LIMIT ?",va([tv(kind),nv(limit)]))}
            else{db().query("SELECT type,id,title,body,path,learning_id FROM content_index ORDER BY updated_at DESC LIMIT ?",va([nv(limit)]))}
        for(row in rows){
            if(row.text(0)=="resource"&&(!personalResourceVisible(dataDir,row.text(1))||!exists(row.text(4))||!hasPrefix(row.text(4),directory()+Path.Separator))){continue}
            out.add(hitJson(row,row.text(3)))
        }
        return out
    }
    public func search(query: String,limitIn: Int64): JsonArray{return searchIn("",query,limitIn)}
    /** 带类型过滤的关键词检索；query 为空返回空数组（总览走 counts/recent）。 */
    public func searchIn(kind: String,query: String,limitIn: Int64): JsonArray{
        scan();refreshStudyIndex();let out=JsonArray();let q=trimStr(byteSafePrefix(query,300))
        if(q.size==0){return out};let limit=if(limitIn>0&&limitIn<50){limitIn}else{50}
        let sql=if(kind.size>0){"SELECT type,id,title,body,path,learning_id FROM content_index WHERE type=? AND instr(lower(title||' '||body),lower(?))>0 ORDER BY CASE WHEN instr(lower(title),lower(?))>0 THEN 0 ELSE 1 END,updated_at DESC LIMIT ?"}
            else{"SELECT type,id,title,body,path,learning_id FROM content_index WHERE instr(lower(title||' '||body),lower(?))>0 ORDER BY CASE WHEN instr(lower(title),lower(?))>0 THEN 0 ELSE 1 END,updated_at DESC LIMIT ?"}
        let rows=if(kind.size>0){db().query(sql,va([tv(kind),tv(q),tv(q),nv(limit)]))}else{db().query(sql,va([tv(q),tv(q),nv(limit)]))}
        for(row in rows){
            if(row.text(0)=="resource"&&(!personalResourceVisible(dataDir,row.text(1))||!exists(row.text(4))||!hasPrefix(row.text(4),directory()+Path.Separator))){continue}
            let text=row.text(3);let start=text.toAsciiLower().indexOf(q.toAsciiLower()).getOrDefault({=>0})
            out.add(hitJson(row,String.fromUtf8(text.toArray()[start..])))
        }
        return out
    }
}
