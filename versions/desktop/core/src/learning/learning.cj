package itn_desktop_core.learning

import std.collection.*
import std.convert.*
import std.random.*
import std.sync.*
import std.fs.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.study.StudyStore
import itn_desktop_core.kb.stamp
import itn_desktop_core.util.*

let resourceLock = Mutex()
let legacyLock = Mutex()
let memoryLock = Mutex()

func uid(prefix: String): String { return prefix + Random().nextUInt64().toString() }
func parsed(raw: String): JsonObject { return objOf(JsonValue.fromStr(raw)).getOrThrow() }

public class LearningStore {
    public let dataDir: String
    public init(dataDir: String) { this.dataDir = dataDir; importLegacy() }
    private func db(): Db { return DbHub.open(dataDir) }

    private func importLegacy(): Unit {
        synchronized(legacyLock) {
            if (db().getKv("meta", "learning_legacy_registered", "") == "1") { return }
            let dir = dataDir + Path.Separator + "artifacts"
            let names = ArrayList<String>()
            if (exists(dir)) {
                Directory.walk(Path(dir), { fi: FileInfo =>
                    if (!fi.isDirectory() && Path(fi.name).extensionName == "md") { names.add(fi.name) }
                    false
                })
            }
            let known = HashSet<String>()
            for (r in db().querySql("SELECT body FROM learning_resource_versions")) { known.add(strOf(parsed(r.text(0)), "artifactName")) }
            for (name in names) {
                if (known.contains(name)) { continue }
                let path = dir + Path.Separator + name
                let text = readTextOr(path, "")
                if (text.size == 0) { continue }
                let body = JsonObject()
                body.put("kind", JsonString("legacy"))
                body.put("title", JsonString(name))
                body.put("markdown", JsonString(text))
                body.put("content", JsonNull())
                body.put("citations", JsonArray())
                body.put("profileSnapshot", JsonNull())
                body.put("artifactName", JsonString(name))
                body.put("artifactPath", JsonString(path))
                body.put("origin", JsonString("legacy-file"))
                let issues = JsonArray()
                issues.add(JsonString("历史文件未执行结构质检"))
                let quality = JsonObject()
                quality.put("issues", issues)
                body.put("quality", quality)
                let warnings = JsonArray()
                warnings.add(JsonString("保留原文件与迁移时原文；未补造出处、题目结构或生成画像。"))
                body.put("warnings", warnings)
                saveResource(body, "", "", "", "", 0)
            }
            db().putKv("meta", "learning_legacy_registered", "1")
            db().putKv("meta", "schema_learning_workbench", "1")
        }
    }

    public func resources(kbId: String): JsonArray {
        let a = JsonArray()
        for (r in db().querySql("SELECT id, kind, title, kb_id, latest_version, updated_at FROM learning_resources ORDER BY updated_at DESC")) {
            if (kbId.size > 0 && r.text(3) != kbId) { continue }
            let o = JsonObject()
            o.put("id", JsonString(r.text(0)))
            o.put("kind", JsonString(r.text(1)))
            o.put("title", JsonString(r.text(2)))
            o.put("kbId", JsonString(r.text(3)))
            o.put("version", JsonInt(r.int(4)))
            o.put("updatedAt", JsonString(r.text(5)))
            a.add(o)
        }
        return a
    }

    public func resource(id: String,versionIn: Int64): JsonObject{return resource(id,versionIn,false)}
    public func resource(id: String, versionIn: Int64,allowRemoved: Bool): JsonObject {
        var version = versionIn
        if (version <= 0) { version = db().scalarInt("SELECT latest_version FROM learning_resources WHERE id = ?", va([tv(id)])) }
        if(!allowRemoved){var removed=false;var live=false;for(r in db().querySql("SELECT status,body FROM course_assets")){let a=parsed(r.text(1));if(strOf(a,"learningId")==id&&intOf(a,"learningVersion")==version){if(r.text(0)=="trash"||r.text(0)=="purged"){removed=true}else{live=true}}};if(removed&&!live){throw Exception("这份确认版本已删除，请从回收站明确预览或恢复")}}
        let raw = db().scalarText("SELECT body FROM learning_resource_versions WHERE resource_id = ? AND version = ?", va([tv(id), nv(version)]))
        if (raw.size == 0) { throw Exception("资源或版本不存在") }
        let out = parsed(raw)
        let target=db().scalarText("SELECT body FROM course_targets WHERE session_id=?",va([tv(strOf(out,"sessionId"))]));if(target.size>0){out.put("courseTarget",parsed(target))}
        let versions = JsonArray()
        for (r in db().query("SELECT version FROM learning_resource_versions WHERE resource_id = ? ORDER BY version DESC", va([tv(id)]))) { versions.add(JsonInt(r.int(0))) }
        out.put("versions", versions)
        let answers = JsonObject()
        for (r in db().query("SELECT item_key, payload FROM learning_events WHERE resource_id = ? AND version = ? AND kind = 'quiz' ORDER BY at", va([tv(id), nv(version)]))) {
            answers.put(r.text(0), parsed(r.text(1)))
        }
        out.put("answers", answers)
        out.put("progressItems", progressItems(id, version))
        return out
    }
    /** Drafts are visible to their producing session, approved copies to other sessions. */
    public func resourcesForSession(kbId: String,sid: String): JsonArray {
        let out=JsonArray();let all=resources(kbId);var i=0
        while(i<all.size()){
            let r=objOf(all[i]).getOrThrow();i+=1;let id=strOf(r,"id")
            var approved=false;var approvedVersion: Int64=0;var latestHidden=false
            let root=db().getKv("settings","personal_resource_dir",dataDir+Path.Separator+"artifacts")+Path.Separator
            for(copy in db().query("SELECT path,id,learning_id FROM personal_resources WHERE learning_id=? OR instr(learning_id,?)=1",va([tv(id),tv(id+":v")]))){let status=db().scalarText("SELECT status FROM course_assets WHERE id=?",va([tv(copy.text(1))]));let parts=copy.text(2).split(":v");var v: Int64=1;if(parts.size>1){try{v=Int64.parse(parts[1])}catch(e: Exception){()}};if(v==intOf(r,"version")&&status.size>0&&status!="current"){latestHidden=true};if((status.size==0||status=="current")&&hasPrefix(copy.text(0),root)&&exists(copy.text(0))){approved=true;if(v>approvedVersion){approvedVersion=v}}}
            if(!latestHidden&&strOf(resource(id,0),"sessionId")==sid){out.add(r)}else if(approved){r.put("version",JsonInt(approvedVersion));out.add(r)}
        }
        return out
    }

    /** Atomic append with optimistic version checking; previous content stays readable. */
    public func saveResource(body: JsonObject, kbId: String, sid: String, turnId: String,
        idIn: String, expectedVersion: Int64): JsonObject {
        synchronized(resourceLock) {
            let id = if (idIn.size > 0) { idIn } else { uid("res-") }
            let old = db().scalarInt("SELECT latest_version FROM learning_resources WHERE id = ?", va([tv(id)]))
            if (idIn.size > 0 && (old == 0 || old != expectedVersion)) { throw Exception("资源已被修改，请重新读取最新版本后修改") }
            let version = old + 1
            body.put("id", JsonString(id))
            body.put("version", JsonInt(version))
            body.put("kbId", JsonString(kbId))
            body.put("sessionId", JsonString(sid))
            body.put("turnId", JsonString(turnId))
            body.put("createdAt", JsonString(stamp()))
            if (body.get("profileSnapshot").isNone()) { body.put("profileSnapshot", context(kbId)) }
            let ops = ArrayList<DbOp>()
            ops.add(DbOp("INSERT INTO learning_resource_versions (resource_id, version, body) VALUES (?, ?, ?)", va([tv(id), nv(version), tv(body.toString())])))
            ops.add(DbOp("INSERT OR REPLACE INTO learning_resources (id, kind, title, kb_id, latest_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                va([tv(id), tv(strOf(body, "kind")), tv(strOf(body, "title")), tv(kbId), nv(version), tv(stamp())])))
            db().batch(ops)
            return body
        }
    }

    public func memories(kbId: String): JsonArray {
        let a = JsonArray()
        for (r in db().querySql("SELECT id, kb_id, body FROM learning_memories ORDER BY updated_at DESC")) {
            if (kbId.size > 0 && r.text(1).size > 0 && r.text(1) != kbId) { continue }
            a.add(parsed(r.text(2)))
        }
        return a
    }

    public func remember(idIn: String, kbId: String, kind: String, text: String, sourceQuote: String,
        sid: String, turnId: String, origin: String): JsonObject {
        return remember(idIn, kbId, kind, text, sourceQuote, sid, turnId, origin, "")
    }

    public func remember(idIn: String, kbId: String, kind: String, text: String, sourceQuote: String,
        sid: String, turnId: String, origin: String, topic: String): JsonObject {
        synchronized(memoryLock) {
        if (trimStr(text).size == 0 || text.size > 2000) { throw Exception("记忆内容不能为空且不能超过 2000 字节") }
        if (!["preference", "goal", "fact", "status"].contains(kind)) { throw Exception("记忆类型必须为 preference/goal/fact/status") }
        if (origin != "user" && (sourceQuote.size == 0 || sid.size == 0 || turnId.size == 0)) { throw Exception("自动记忆必须附带用户原话与会话来源") }
        if (topic.size > 160) { throw Exception("记忆主题过长") }
        var id = idIn
        var memoryTopic = trimStr(topic)
        if (id.size > 0 && memoryTopic.size == 0) {
            let old = db().scalarText("SELECT body FROM learning_memories WHERE id = ?", va([tv(id)]))
            if (old.size > 0) { memoryTopic = strOf(parsed(old), "topic") }
        }
        if (id.size > 0 && origin != "user") {
            let old = db().scalarText("SELECT body FROM learning_memories WHERE id = ? AND kb_id = ?", va([tv(id), tv(kbId)]))
            if (old.size == 0) { throw Exception("只能更新当前范围内已有的记忆") }
        }
        if (id.size == 0) {
            for (r in db().query("SELECT id, body FROM learning_memories WHERE kb_id = ? ORDER BY updated_at DESC", va([tv(kbId)]))) {
                let old = parsed(r.text(1))
                if (strOf(old, "kind") == kind && (trimStr(strOf(old, "text")) == trimStr(text) ||
                    (memoryTopic.size > 0 && strOf(old, "topic") == memoryTopic))) { id = r.text(0); break }
            }
        }
        if (id.size == 0) { id = uid("mem-") }
        let o = JsonObject()
        o.put("id", JsonString(id))
        o.put("kbId", JsonString(kbId))
        o.put("kind", JsonString(kind))
        o.put("text", JsonString(text))
        o.put("quote", JsonString(sourceQuote))
        o.put("sessionId", JsonString(sid))
        o.put("turnId", JsonString(turnId))
        o.put("origin", JsonString(origin))
        o.put("topic", JsonString(memoryTopic))
        o.put("scope", JsonString(if (kbId.size > 0) { "knowledge_base" } else { "global" }))
        o.put("basis", JsonString("用户自述，不代表实测掌握度"))
        o.put("updatedAt", JsonString(stamp()))
        db().run("INSERT OR REPLACE INTO learning_memories (id, kb_id, body, updated_at) VALUES (?, ?, ?, ?)", va([tv(id), tv(kbId), tv(o.toString()), tv(stamp())]))
        return o
        }
    }

    public func forget(id: String): Unit { db().run("DELETE FROM learning_memories WHERE id = ?", va([tv(id)])) }

    public func autoRemember(): Bool { return db().getKv("settings", "learning_auto_remember", "1") == "1" }

    public func setAutoRemember(enabled: Bool): Unit {
        db().putKv("settings", "learning_auto_remember", if (enabled) { "1" } else { "0" })
    }

    public func context(kbId: String): JsonObject {
        let o = JsonObject()
        o.put("schemaVersion", JsonInt(2))
        o.put("scope", JsonString(kbId))
        o.put("profile", StudyStore(dataDir).loadProfile().toJson())
        o.put("memories", memories(kbId))
        o.put("autoRemember", JsonBool(autoRemember()))
        let topics = JsonArray()
        var total: Int64 = 0
        var right: Int64 = 0
        for (r in db().querySql("SELECT e.kb_id, e.topic, COUNT(*), SUM(e.correct) FROM learning_events e WHERE e.kind IN ('quiz','guided-checkpoint') AND e.first_attempt = 1 AND NOT EXISTS (SELECT 1 FROM learning_events p WHERE p.resource_id=e.resource_id AND p.version=e.version AND p.item_key=e.item_key AND p.kind=e.kind AND p.first_attempt=1 AND p.rowid<e.rowid) GROUP BY e.kb_id, e.topic")) {
            if (kbId.size > 0 && r.text(0) != kbId) { continue }
            let x = JsonObject()
            x.put("kbId", JsonString(r.text(0)))
            x.put("topic", JsonString(r.text(1)))
            x.put("attempts", JsonInt(r.int(2)))
            x.put("correct", JsonInt(r.int(3)))
            x.put("basis", JsonString("测验与导学检查点首次作答；样本有限，不代表完整掌握度"))
            topics.add(x)
            total = total + r.int(2)
            right = right + r.int(3)
        }
        o.put("quizTopics", topics)
        o.put("quizAttempts", JsonInt(total))
        o.put("quizCorrect", JsonInt(right))
        o.put("mastery", JsonNull())
        o.put("learningState", structuredLearningState(dataDir, kbId))
        o.put("basis", JsonString("目标、偏好为本人提供；测验为服务端答案核验；阅读、生成和手动完成记录不换算成能力分数。无证据时掌握度未知。"))
        return o
    }

    /** 系统提示词使用完整、有界的 JSON，不能按字节截断 JSON 文档。 */
    public func agentContext(kbId: String): JsonObject {
        let o = context(kbId)
        let bounded = JsonArray()
        let all = arrOf(o, "memories")
        let quotas = HashMap<String, Int64>()
        quotas["goal"] = 4; quotas["preference"] = 4; quotas["status"] = 6; quotas["fact"] = 2
        var i = 0
        while (i < all.size()) {
            let m = objOf(all[i]).getOrThrow()
            i += 1
            let kind = strOf(m, "kind")
            let left = quotas.get(kind).getOrDefault({ => 0 })
            if (left <= 0) { continue }
            quotas[kind] = left - 1
            let item = JsonObject()
            for (key in ["id", "kbId", "kind", "scope", "topic", "updatedAt"]) {
                item.put(key, JsonString(strOf(m, key)))
            }
            item.put("text", JsonString(byteSafePrefix(strOf(m, "text"), 600)))
            bounded.add(item)
        }
        o.put("memories", bounded)
        o.put("memoryTotal", JsonInt(all.size()))
        let topics = arrOf(o, "quizTopics")
        let recent = JsonArray()
        i = 0
        while (i < topics.size() && i < 12) { recent.add(topics[i]); i += 1 }
        o.put("quizTopics", recent)
        return o
    }

    public func answer(id: String, version: Int64, questionId: String, choice: Int64, attemptId: String): JsonObject {
        synchronized(resourceLock) {
            if (attemptId.size == 0 || attemptId.size > 160) { throw Exception("缺少有效 attemptId") }
            let res = resource(id, version)
            if (strOf(res, "kind") != "quiz") { throw Exception("该资源不是测验") }
            let actual = intOf(res, "version")
            let old = db().scalarText("SELECT payload FROM learning_events WHERE id = ?", va([tv(attemptId)]))
            if (old.size > 0) {
                let saved = parsed(old)
                if (strOf(saved, "resourceId") != id || intOf(saved, "version") != actual || strOf(saved, "questionId") != questionId || intOf(saved, "choice") != choice) { throw Exception("attemptId 已用于另一份作答") }
                return saved
            }
            let content = objOf(res.get("content").getOrThrow()).getOrThrow()
            let qs = arrOf(content, "questions")
            var i = 0
            while (i < qs.size()) {
                let q = objOf(qs[i]).getOrThrow()
                if (strOf(q, "id") != questionId) { i = i + 1; continue }
                let options = arrOf(q, "options")
                let correctIndex = intOf(q, "correctIndex")
                if (choice < 0 || choice >= options.size() || correctIndex < 0 || correctIndex >= options.size()) { throw Exception("选项无效") }
                let correct = choice == correctIndex
                let first = db().scalarInt("SELECT COUNT(*) FROM learning_events WHERE resource_id = ? AND version = ? AND item_key = ? AND kind = 'quiz'", va([tv(id), nv(actual), tv(questionId)])) == 0
                let out = JsonObject()
                out.put("attemptId", JsonString(attemptId))
                out.put("resourceId", JsonString(id))
                out.put("version", JsonInt(actual))
                out.put("questionId", JsonString(questionId))
                out.put("choice", JsonInt(choice))
                out.put("correct", JsonBool(correct))
                out.put("correctIndex", JsonInt(correctIndex))
                out.put("explanation", JsonString(strOf(q, "explanation")))
                out.put("firstAttempt", JsonBool(first))
                var topic = strOf(res, "title")
                let points = arrOf(content, "knowledgePoints")
                var pi = 0
                while (pi < points.size()) {
                    let point = objOf(points[pi]).getOrThrow()
                    if (strOf(point, "id") == strOf(q, "knowledgePointId") && strOf(point, "name").size > 0) { topic = strOf(point, "name") }
                    pi = pi + 1
                }
                out.put("topic", JsonString(topic))
                out.put("knowledgePointId", JsonString(strOf(q, "knowledgePointId")))
                out.put("difficulty", JsonString(strOf(q, "difficulty")))
                let ops = ArrayList<DbOp>()
                ops.add(DbOp("INSERT INTO learning_events (id, kind, kb_id, resource_id, version, item_key, topic, correct, first_attempt, payload, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    va([tv(attemptId), tv("quiz"), tv(strOf(res, "kbId")), tv(id), nv(actual), tv(questionId), tv(topic), nv(if (correct) { 1 } else { 0 }), nv(if (first) { 1 } else { 0 }), tv(out.toString()), tv(stamp())])))
                if (first) {
                    ops.add(DbOp("INSERT INTO quiz_records (id, kb_id, chapter, question, my_answer, reference, correct, created_at, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        va([tv("resource:" + attemptId), tv(strOf(res, "kbId")), tv(topic), tv(strOf(q, "stem")), tv(strValue(options[choice])), tv(strValue(options[correctIndex]) + "；" + strOf(q, "explanation")), nv(if (correct) { 1 } else { 0 }), tv(stamp()), nv(i)])))
                }
                db().batch(ops)
                return out
            }
            throw Exception("题目不存在")
        }
    }

    /** 按条目的完成标记（讲义小节 / 实操步骤 / 验收清单），键只允许字母数字下划线与连字符。 */
    public func progress(id: String, version: Int64, item: String, done: Bool): JsonObject {
        if (item.size == 0 || item.size > 64) { throw Exception("标记名称无效") }
        for (b in item.toArray()) {
            let ok = (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b == 45 || b == 95
            if (!ok) { throw Exception("标记名称无效") }
        }
        let res = resource(id, version)
        let kind = strOf(res, "kind")
        if (kind != "lecture" && kind != "practice" && kind != "ppt" && kind != "legacy") { throw Exception("此资源不支持完成标记") }
        let key = "learning-progress:" + id + ":" + intOf(res, "version").toString() + ":" + item
        let o = JsonObject()
        o.put("done", JsonBool(done))
        o.put("basis", JsonString("用户手动标记，不代表掌握度"))
        o.put("updatedAt", JsonString(stamp()))
        let before=parsed(db().getKv("meta",key,"{\"done\":false}"));db().putKv("meta", key, o.toString())
        if(boolOf(before,"done")!=done){let event=JsonObject();event.put("done",JsonBool(done));event.put("resourceId",JsonString(id));event.put("version",JsonInt(intOf(res,"version")));db().run("INSERT INTO learning_events (id,kind,kb_id,resource_id,version,item_key,topic,correct,first_attempt,payload,at) VALUES (?,?,?,?,?,?,?,0,0,?,?)",va([tv(uid("completion-")),tv("completion"),tv(strOf(res,"kbId")),tv(id),nv(intOf(res,"version")),tv(item),tv(strOf(res,"title")),tv(event.toString()),tv(stamp())]))}
        return o
    }

    public func progressOf(id: String, version: Int64, item: String): JsonObject {
        return parsed(db().getKv("meta", "learning-progress:" + id + ":" + version.toString() + ":" + item, "{\"done\":false}"))
    }

    /** 这份资源当前版本上所有已完成的条目键，供单页阅读/实操页回显对勾。 */
    public func progressItems(id: String, version: Int64): JsonArray {
        let prefix = "learning-progress:" + id + ":" + version.toString() + ":"
        let out = JsonArray()
        for (r in db().query("SELECT k FROM meta WHERE instr(k, ?) = 1", va([tv(prefix)]))) {
            let key = r.text(0)
            let item = String.fromUtf8(key.toArray()[prefix.toArray().size..])
            if (item.size == 0) { continue }
            let mark = parsed(db().getKv("meta", key, "{\"done\":false}"))
            if (boolOf(mark, "done")) { out.add(JsonString(item)) }
        }
        return out
    }
}

public func arrOf(o: JsonObject, key: String): JsonArray {
    match (o.get(key)) { case Some(v) => match (v) { case a: JsonArray => return a; case _ => () }; case None => () }
    return JsonArray()
}
