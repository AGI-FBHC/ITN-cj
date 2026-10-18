package itn_desktop_core.presentation

import std.collection.*
import std.random.*
import std.time.*
import std.fs.*
import std.process.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.util.*
import itn_desktop_core.kb.stamp

/** 由 main 设置，指向随包的 renderer 目录（开发态是 shell/renderer）。 */
public var PRESENTATION_UI_DIR: String = ""
public func setPresentationUiDir(dir: String): Unit { PRESENTATION_UI_DIR = dir }

public class DesktopJobs {
    let dataDir: String
    public init(dataDir: String) { this.dataDir = dataDir }
    func db(): Db { return DbHub.open(dataDir) }
    /** 正在排队或执行中的桌面任务（任务中心）。 */
    public func active(): JsonArray {
        let out = JsonArray()
        for (r in db().querySql("SELECT id,kind,status,body FROM desktop_jobs WHERE status IN ('pending','running') ORDER BY created_at DESC")) {
            let o = JsonObject()
            o.put("id", JsonString(r.text(0)))
            o.put("kind", JsonString(r.text(1)))
            o.put("status", JsonString(r.text(2)))
            try { o.put("body", JsonValue.fromStr(r.text(3))) } catch (e: Exception) { o.put("body", JsonObject()) }
            out.add(o)
        }
        return out
    }
    /** 最近结束的桌面任务。 */
    public func recent(limitIn: Int64): JsonArray {
        let limit = if (limitIn > 0 && limitIn < 20) { limitIn } else { 5 }
        let out = JsonArray()
        for (r in db().query("SELECT id,kind,status,body,created_at FROM desktop_jobs WHERE status IN ('completed','failed','cancelled') ORDER BY created_at DESC LIMIT ?", va([nv(limit)]))) {
            let o = JsonObject()
            o.put("id", JsonString(r.text(0)))
            o.put("kind", JsonString(r.text(1)))
            o.put("status", JsonString(r.text(2)))
            try { o.put("body", JsonValue.fromStr(r.text(3))) } catch (e: Exception) { o.put("body", JsonObject()) }
            o.put("createdAt", JsonString(r.text(4)))
            out.add(o)
        }
        return out
    }
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
    public func queueExtract(path: String,resourceId: String): String {
        let id="extract-"+Random().nextUInt64().toString();let body=JsonObject();body.put("inputPath",JsonString(path))
        body.put("resourceId",JsonString(resourceId))
        db().run("INSERT INTO desktop_jobs(id,kind,status,body,result,error,created_at) VALUES (?,'extract','pending',?,'','',?)",va([tv(id),tv(body.toString()),tv(stamp())]))
        return id
    }
    public func extractFile(path: String): JsonObject {
        let id=queueExtract(path,"")
        var ticks=0
        while(ticks<200){
            let rows=db().query("SELECT status,result,error FROM desktop_jobs WHERE id=?",va([tv(id)]))
            if(rows.size>0){if(rows[0].text(0)=="completed"){return objOf(JsonValue.fromStr(rows[0].text(1))).getOrThrow()};if(rows[0].text(0)=="failed"){throw Exception(rows[0].text(2))}}
            sleep(Duration.millisecond*100);ticks+=1
        }
        db().run("UPDATE desktop_jobs SET status='failed',error='内容提取超时' WHERE id=?",va([tv(id)]));throw Exception("内容索引提取服务尚未就绪")
    }
    public func buildPresentation(spec: JsonObject, sid: String, tid: String, shouldAbort: () -> Bool): JsonObject {
        let id="ppt-"+Random().nextUInt64().toString()
        let dir=dataDir+Path.Separator+"drafts";ensureDir(dir)
        let path=dir+Path.Separator+id+".pptx"
        let body=JsonObject();body.put("id",JsonString(id));body.put("kind",JsonString("presentation"));body.put("spec",spec);body.put("outputPath",JsonString(path));body.put("sessionId",JsonString(sid));body.put("turnId",JsonString(tid))
        db().run("INSERT INTO desktop_jobs(id,kind,status,body,result,error,created_at) VALUES (?,'presentation','pending',?,'','',?)",va([tv(id),tv(body.toString()),tv(stamp())]))
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
    /** 用随包 python-pptx 兼容渲染器把已验证提纲写成真实 PPTX。 */
    public func renderPresentationWithPython(request: JsonObject, outline: JsonObject, sid: String, tid: String): JsonObject {
        let rendererDir = PRESENTATION_UI_DIR + Path.Separator + "ppt-renderer"
        let script = rendererDir + Path.Separator + "render_ppt.py"
        if (!exists(script)) {
            throw Exception("找不到PPT渲染器：" + script)
        }
        let id = "ppt-" + Random().nextUInt64().toString()
        let dir = dataDir + Path.Separator + "drafts"
        ensureDir(dir)
        let inputPath = dir + Path.Separator + id + ".request.json"
        let outputPath = dir + Path.Separator + id + ".pptx"
        let packet = JsonObject()
        packet.put("request", request)
        packet.put("outline", outline)
        writeText(inputPath, packet.toString())
        let localPython = rendererDir + Path.Separator + "python" + Path.Separator + "python.exe"
        let python = if (exists(localPython)) { localPython } else { "python" }
        try {
            let (code, out, err) = executeWithOutput(python, ["-X", "utf8", script, inputPath, outputPath], workingDirectory: Some(Path(rendererDir)))
            if (code != 0 || !exists(outputPath)) {
                let reason = if (err.size > 0) { String.fromUtf8(err) } else { String.fromUtf8(out) }
                throw Exception("PPT渲染失败：" + byteSafePrefix(reason, 1600))
            }
            let lines = String.fromUtf8(out).split("\n")
            var last = ""
            var i = lines.size - 1
            while (i >= 0) {
                if (trimStr(lines[i]).size > 0) { last = trimStr(lines[i]); break }
                i = i - 1
            }
            if (last.size == 0) { throw Exception("PPT渲染器没有返回结果") }
            let result = match (JsonValue.fromStr(last)) {
                case o: JsonObject => o
                case _ => throw Exception("PPT渲染器返回结果不是JSON")
            }
            result.put("path", JsonString(outputPath))
            result.put("sid", JsonString(sid))
            result.put("tid", JsonString(tid))
            return result
        } finally {
            try { remove(inputPath) } catch (e: Exception) {}
        }
    }
}
