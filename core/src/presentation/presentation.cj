package itn_desktop_core.presentation

import std.collection.*
import std.random.*
import std.time.*
import std.fs.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.util.*

public class DesktopJobs {
    let dataDir: String
    public init(dataDir: String) { this.dataDir = dataDir }
    func db(): Db { return DbHub.open(dataDir) }
    public func pending(): JsonArray {
        let out=JsonArray()
        for (r in db().querySql("SELECT id,kind FROM desktop_jobs WHERE status='pending' ORDER BY created_at LIMIT 8")) {
            let o=JsonObject();o.put("id",JsonString(r.text(0)));o.put("kind",JsonString(r.text(1)));out.add(o)
        }
        return out
    }
    public func claim(id: String): JsonObject {
        let rows=db().query("UPDATE desktop_jobs SET status='running' WHERE id=? AND status='pending' RETURNING body",va([tv(id)]))
        let out=JsonObject();out.put("claimed",JsonBool(rows.size>0))
        if(rows.size>0){out.put("body",JsonValue.fromStr(rows[0].text(0)))}
        return out
    }
    public func finish(id: String, result: JsonObject): Unit {
        db().run("UPDATE desktop_jobs SET status=?,result=?,error=? WHERE id=? AND status='running'",va([tv(if(boolOf(result,"ok")){"completed"}else{"failed"}),tv(result.toString()),tv(strOf(result,"error")),tv(id)]))
    }
    public func buildPresentation(spec: JsonObject, sid: String, tid: String, shouldAbort: () -> Bool): JsonObject {
        let id="ppt-"+Random().nextUInt64().toString()
        let dir=dataDir+Path.Separator+"drafts";ensureDir(dir)
        let path=dir+Path.Separator+id+".pptx"
        let body=JsonObject();body.put("id",JsonString(id));body.put("kind",JsonString("presentation"));body.put("spec",spec);body.put("outputPath",JsonString(path));body.put("sessionId",JsonString(sid));body.put("turnId",JsonString(tid))
        db().run("INSERT INTO desktop_jobs(id,kind,status,body,result,error,created_at) VALUES (?,'presentation','pending',?,'','','')",va([tv(id),tv(body.toString())]))
        var ticks=0
        while(ticks<600){
            if(shouldAbort()){db().run("UPDATE desktop_jobs SET status='cancelled' WHERE id=?",va([tv(id)]));throw Exception("已取消PPT制作")}
            let rows=db().query("SELECT status,result,error FROM desktop_jobs WHERE id=?",va([tv(id)]))
            if(rows.size>0){
                if(rows[0].text(0)=="completed"){
                    if(!exists(path)){throw Exception("桌面返回完成，但PPTX文件不存在")}
                    let out=objOf(JsonValue.fromStr(rows[0].text(1))).getOrThrow();out.put("title",JsonString(strOf(spec,"title")));out.put("kind",JsonString("pptx"));out.put("path",JsonString(path));return out
                }
                if(rows[0].text(0)=="failed"){throw Exception(rows[0].text(2))}
            }
            sleep(Duration.millisecond*100);ticks+=1
        }
        db().run("UPDATE desktop_jobs SET status='failed',error='桌面制作服务超时' WHERE id=? AND status IN ('pending','running')",va([tv(id)]))
        throw Exception("桌面PPT制作服务未就绪或超时，请在Lumin桌面窗口中重试")
    }
}
