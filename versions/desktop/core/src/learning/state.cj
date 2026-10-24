package itn_desktop_core.learning

import std.collection.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.kb.stamp
import itn_desktop_core.study.attachReviewState
import itn_desktop_core.util.*

/** 直接聚合已有事实；不另存一份会过期的画像，不发起模型调用。 */
public func structuredLearningState(dataDir: String, kbId: String): JsonObject {
    let db = DbHub.open(dataDir)
    let scope = va([tv(kbId), tv(kbId)])
    let out = JsonObject()
    out.put("asOf", JsonString(stamp()))
    out.put("kbId", JsonString(kbId))
    out.put("basis", JsonString("阅读和完成来自操作记录；首次测验是独立证据，不能由阅读量推断掌握度"))
    let progress = JsonObject()
    progress.put("readChunks", JsonInt(db.scalarInt("SELECT COUNT(*) FROM progress WHERE kind='chunk' AND (?='' OR kb_id=?)", scope)))
    progress.put("completedSections", JsonInt(db.scalarInt("SELECT COUNT(*) FROM progress WHERE kind='section' AND (?='' OR kb_id=?)", scope)))
    progress.put("completedChapters", JsonInt(db.scalarInt("SELECT COUNT(*) FROM chapter_done WHERE (?='' OR kb_id=?)", scope)))
    progress.put("notes", JsonInt(db.scalarInt("SELECT COUNT(*) FROM notes WHERE (?='' OR kb_id=?)", scope)))
    out.put("progress", progress)

    let reading = JsonArray()
    // 先取最近 6 条进度再按唯一索引逐条补文档信息：LEFT JOIN 在真实库上会退化成 chunks 全表扫描（EXPLAIN 为 SCAN p; SCAN c，6 行结果耗 6 秒以上）。
    let recent = db.query("SELECT kb_id,item_key,kind,at FROM progress WHERE (?='' OR kb_id=?) ORDER BY datetime(at) DESC,rowid DESC LIMIT 6", scope)
    for (p in recent) {
        var doc = ""
        var section = ""
        if (p.text(2) == "chunk") {
            for (c in db.query("SELECT COALESCE(doc_title,''),COALESCE(heading_path,'') FROM chunks WHERE kb_id=? AND chunk_key=?", va([tv(p.text(0)), tv(p.text(1))]))) {
                doc = c.text(0)
                section = c.text(1)
            }
        }
        let item = JsonObject()
        item.put("kbId", JsonString(p.text(0)))
        item.put("itemId", JsonString(p.text(1)))
        item.put("kind", JsonString(p.text(2)))
        item.put("at", JsonString(p.text(3)))
        item.put("document", JsonString(byteSafePrefix(doc, 180)))
        item.put("section", JsonString(byteSafePrefix(section, 240)))
        reading.add(item)
    }
    out.put("recentReading", reading)

    let courses = JsonArray()
    for (r in db.query("SELECT c.kb_id,k.name,c.body FROM course_maps c JOIN knowledge_bases k ON k.id=c.kb_id JOIN meta h ON h.k='course-head:'||c.kb_id AND h.v=c.id WHERE c.status='current' AND (?='' OR c.kb_id=?) ORDER BY datetime(c.updated_at) DESC LIMIT 6", scope)) {
        let course = JsonObject()
        course.put("kbId", JsonString(r.text(0)))
        course.put("name", JsonString(byteSafePrefix(r.text(1), 180)))
        let nodes = arrOf(parsed(r.text(2)), "nodes")
        let completed = JsonArray()
        var count: Int64 = 0
        var total: Int64 = 0
        var i = 0
        while (i < nodes.size()) {
            let node = objOf(nodes[i]).getOrThrow()
            i += 1
            if (intOf(node, "depth") <= 1) { continue }
            total += 1
            let mark = parsed(db.getKv("meta", "course-node-progress:" + strOf(node, "id"), "{}"))
            if (boolOf(mark, "done")) {
                count += 1
                if (completed.size() < 4) { completed.add(JsonString(byteSafePrefix(strOf(node, "title"), 150))) }
            }
        }
        course.put("totalNodes", JsonInt(total))
        course.put("completedNodes", JsonInt(count))
        course.put("completedTopics", completed)
        course.put("basis", JsonString("当前导图的用户完成标记，归档图不计入当前进度"))
        courses.add(course)
    }
    out.put("currentCourses", courses)

    let resources = JsonArray()
    // 只列有真实完成操作的当前版本，生成草稿不表示用户学过。
    for (r in db.query("SELECT e.resource_id,e.kb_id,r.title,r.kind,r.latest_version,MAX(e.at) FROM learning_events e JOIN learning_resources r ON r.id=e.resource_id AND r.latest_version=e.version WHERE e.kind='completion' AND (?='' OR e.kb_id=?) GROUP BY e.resource_id ORDER BY datetime(MAX(e.at)) DESC LIMIT 6", scope)) {
        let item = JsonObject()
        item.put("id", JsonString(r.text(0)))
        item.put("kbId", JsonString(r.text(1)))
        item.put("title", JsonString(byteSafePrefix(r.text(2), 180)))
        item.put("kind", JsonString(r.text(3)))
        item.put("version", JsonInt(r.int(4)))
        item.put("lastActivityAt", JsonString(r.text(5)))
        let keys = JsonArray()
        var total: Int64 = 0
        let prefix = "learning-progress:" + r.text(0) + ":" + r.int(4).toString() + ":"
        for (mark in db.query("SELECT k,v FROM meta WHERE instr(k,?)=1", va([tv(prefix)]))) {
            let saved = parsed(mark.text(1))
            if (boolOf(saved, "done")) {
                total += 1
                if (keys.size() < 8) { keys.add(JsonString(String.fromUtf8(mark.text(0).toArray()[prefix.size..]))) }
            }
        }
        item.put("completedItems", keys)
        item.put("completedItemCount", JsonInt(total))
        item.put("basis", JsonString("用户手动标记，不代表掌握度"))
        resources.add(item)
    }
    out.put("recentResources", resources)

    let checks = JsonArray()
    for (r in db.query("SELECT kb_id,resource_id,version,item_key,topic,kind,correct,first_attempt,at FROM learning_events WHERE kind IN ('quiz','guided-checkpoint') AND (?='' OR kb_id=?) ORDER BY datetime(at) DESC,rowid DESC LIMIT 8", scope)) {
        let item = JsonObject()
        item.put("kbId", JsonString(r.text(0)))
        item.put("resourceId", JsonString(r.text(1)))
        item.put("version", JsonInt(r.int(2)))
        item.put("itemId", JsonString(r.text(3)))
        item.put("topic", JsonString(byteSafePrefix(r.text(4), 200)))
        item.put("kind", JsonString(r.text(5)))
        item.put("correct", JsonBool(r.bool(6)))
        item.put("firstAttempt", JsonBool(r.bool(7)))
        item.put("at", JsonString(r.text(8)))
        checks.add(item)
    }
    out.put("recentChecks", checks)

    let practice = JsonArray()
    // 最新作答已正确时退出本列表；首次错误仍保留在 quizTopics 中。
    for (r in db.query("SELECT e.kb_id,e.resource_id,e.version,e.item_key,e.topic,e.at FROM learning_events e WHERE e.kind IN ('quiz','guided-checkpoint') AND e.correct=0 AND (?='' OR e.kb_id=?) AND NOT EXISTS (SELECT 1 FROM learning_events n WHERE n.resource_id=e.resource_id AND n.version=e.version AND n.item_key=e.item_key AND n.kind=e.kind AND n.rowid>e.rowid) ORDER BY datetime(e.at) DESC,e.rowid DESC LIMIT 6", scope)) {
        let item = JsonObject()
        item.put("kbId", JsonString(r.text(0)))
        item.put("resourceId", JsonString(r.text(1)))
        item.put("version", JsonInt(r.int(2)))
        item.put("itemId", JsonString(r.text(3)))
        item.put("topic", JsonString(byteSafePrefix(r.text(4), 200)))
        item.put("at", JsonString(r.text(5)))
        item.put("basis", JsonString("该题最近一次作答错误，建议巩固；不是能力诊断"))
        practice.add(item)
    }
    out.put("needsPractice", practice)

    let review = JsonArray()
    var due: Int64 = 0
    let now = DateTime.now().toUnixTimeStamp().toMilliseconds()
    for (r in db.query("SELECT id,kb_id,chapter,question,created_at FROM quiz_records WHERE correct=0 AND (?='' OR kb_id=?) ORDER BY datetime(created_at) DESC,rowid DESC", scope)) {
        let state = JsonObject()
        attachReviewState(db, state, r.text(0), now)
        if (!boolOf(state, "due")) { continue }
        due += 1
        if (review.size() >= 6) { continue }
        let item = JsonObject()
        item.put("id", JsonString(r.text(0)))
        item.put("kbId", JsonString(r.text(1)))
        item.put("topic", JsonString(byteSafePrefix(r.text(2), 180)))
        item.put("question", JsonString(byteSafePrefix(r.text(3), 300)))
        item.put("at", JsonString(r.text(4)))
        item.put("basis", JsonString("错题复习计划到期，用户可重做或调整"))
        review.add(item)
    }
    out.put("reviewDueCount", JsonInt(due))
    out.put("reviewQueue", review)
    return out
}
