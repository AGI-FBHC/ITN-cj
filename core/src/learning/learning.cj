package itn_desktop_core.learning

import std.collection.*
import std.random.*
import std.sync.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.study.StudyStore
import itn_desktop_core.kb.stamp
import itn_desktop_core.util.*

let resourceLock = Mutex()

func uid(prefix: String): String { return prefix + Random().nextUInt64().toString() }
func parsed(raw: String): JsonObject { return objOf(JsonValue.fromStr(raw)).getOrThrow() }

public class LearningStore {
    public let dataDir: String
    public init(dataDir: String) { this.dataDir = dataDir }
    private func db(): Db { return DbHub.open(dataDir) }

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

    public func resource(id: String, versionIn: Int64): JsonObject {
        var version = versionIn
        if (version <= 0) { version = db().scalarInt("SELECT latest_version FROM learning_resources WHERE id = ?", va([tv(id)])) }
        let raw = db().scalarText("SELECT body FROM learning_resource_versions WHERE resource_id = ? AND version = ?", va([tv(id), nv(version)]))
        if (raw.size == 0) { throw Exception("资源或版本不存在") }
        let out = parsed(raw)
        let versions = JsonArray()
        for (r in db().query("SELECT version FROM learning_resource_versions WHERE resource_id = ? ORDER BY version DESC", va([tv(id)]))) { versions.add(JsonInt(r.int(0))) }
        out.put("versions", versions)
        let answers = JsonObject()
        for (r in db().query("SELECT item_key, payload FROM learning_events WHERE resource_id = ? AND version = ? AND kind = 'quiz' ORDER BY at", va([tv(id), nv(version)]))) {
            answers.put(r.text(0), parsed(r.text(1)))
        }
        out.put("answers", answers)
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
        if (trimStr(text).size == 0 || text.size > 2000) { throw Exception("记忆内容不能为空且不能超过 2000 字节") }
        if (kind != "preference" && kind != "goal" && kind != "fact") { throw Exception("记忆类型必须为 preference/goal/fact") }
        if (origin != "user" && (sourceQuote.size == 0 || sid.size == 0 || turnId.size == 0)) { throw Exception("自动记忆必须附带用户原话与会话来源") }
        let id = if (idIn.size > 0) { idIn } else { uid("mem-") }
        let o = JsonObject()
        o.put("id", JsonString(id))
        o.put("kbId", JsonString(kbId))
        o.put("kind", JsonString(kind))
        o.put("text", JsonString(text))
        o.put("quote", JsonString(sourceQuote))
        o.put("sessionId", JsonString(sid))
        o.put("turnId", JsonString(turnId))
        o.put("origin", JsonString(origin))
        o.put("updatedAt", JsonString(stamp()))
        db().run("INSERT OR REPLACE INTO learning_memories (id, kb_id, body, updated_at) VALUES (?, ?, ?, ?)", va([tv(id), tv(kbId), tv(o.toString()), tv(stamp())]))
        return o
    }

    public func forget(id: String): Unit { db().run("DELETE FROM learning_memories WHERE id = ?", va([tv(id)])) }

    public func autoRemember(): Bool { return db().getKv("settings", "learning_auto_remember", "1") == "1" }

    public func setAutoRemember(enabled: Bool): Unit {
        db().putKv("settings", "learning_auto_remember", if (enabled) { "1" } else { "0" })
    }

    public func context(kbId: String): JsonObject {
        let o = JsonObject()
        o.put("profile", StudyStore(dataDir).load().profile.toJson())
        o.put("memories", memories(kbId))
        o.put("autoRemember", JsonBool(autoRemember()))
        let topics = JsonArray()
        var total: Int64 = 0
        var right: Int64 = 0
        for (r in db().querySql("SELECT kb_id, topic, COUNT(*), SUM(correct) FROM learning_events WHERE kind = 'quiz' AND first_attempt = 1 GROUP BY kb_id, topic")) {
            if (kbId.size > 0 && r.text(0) != kbId) { continue }
            let x = JsonObject()
            x.put("kbId", JsonString(r.text(0)))
            x.put("topic", JsonString(r.text(1)))
            x.put("attempts", JsonInt(r.int(2)))
            x.put("correct", JsonInt(r.int(3)))
            x.put("basis", JsonString("资源测验首次作答；样本有限，不代表完整掌握度"))
            topics.add(x)
            total = total + r.int(2)
            right = right + r.int(3)
        }
        o.put("quizTopics", topics)
        o.put("quizAttempts", JsonInt(total))
        o.put("quizCorrect", JsonInt(right))
        o.put("mastery", JsonNull())
        o.put("basis", JsonString("目标、偏好为本人提供；测验为服务端答案核验；阅读、生成和手动完成记录不换算成能力分数。无证据时掌握度未知。"))
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

    public func progress(id: String, version: Int64, item: String, done: Bool): JsonObject {
        let res = resource(id, version)
        let kind = strOf(res, "kind")
        if (kind != "lecture" && kind != "practice" && kind != "ppt") { throw Exception("此资源不支持完成标记") }
        let key = "learning-progress:" + id + ":" + intOf(res, "version").toString() + ":" + item
        let o = JsonObject()
        o.put("done", JsonBool(done))
        o.put("basis", JsonString("用户手动标记，不代表掌握度"))
        o.put("updatedAt", JsonString(stamp()))
        db().putKv("meta", key, o.toString())
        return o
    }

    public func progressOf(id: String, version: Int64, item: String): JsonObject {
        return parsed(db().getKv("meta", "learning-progress:" + id + ":" + version.toString() + ":" + item, "{\"done\":false}"))
    }
}

public func arrOf(o: JsonObject, key: String): JsonArray {
    match (o.get(key)) { case Some(v) => match (v) { case a: JsonArray => return a; case _ => () }; case None => () }
    return JsonArray()
}
