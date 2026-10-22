package itn_desktop_core.dev

import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.course.activityDateAdd
import itn_desktop_core.util.*

func seedLearningEvent(db: Db, id: String, kind: String, date: String, resourceId: String, version: Int64,
    itemKey: String, topic: String, correct: Int64, firstAttempt: Int64, payload: JsonObject): Unit {
    db.run("INSERT INTO learning_events (id,kind,kb_id,resource_id,version,item_key,topic,correct,first_attempt,payload,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        va([tv(id), tv(kind), tv("course-alpha"), tv(resourceId), nv(version), tv(itemKey), tv(topic), nv(correct),
            nv(firstAttempt), tv(payload.toString()), tv(date + "T09:40:00+08:00")]))
}

/** 确定性活跃度夹具：供成长页和 Lumin 工具检查使用，只在显式开发开关下运行。 */
public func seedGrowthActivity(dir: String): Unit {
    let db = DbHub.open(dir)
    let now = DateTime.now().toString()
    let today = String.fromUtf8(now.toArray()[0..10])
    let d1 = activityDateAdd(today, -1)
    let d2 = activityDateAdd(today, -2)
    let d5 = activityDateAdd(today, -5)
    let d30 = activityDateAdd(today, -30)
    let d60 = activityDateAdd(today, -60)
    let d200 = activityDateAdd(today, -200)
    let d400 = activityDateAdd(today, -400)
    let done = JsonObject();done.put("done", JsonBool(true))
    let undone = JsonObject();undone.put("done", JsonBool(false))

    // 今天：3 次作答 + 1 个有效条目完成 + 1 个有效节点完成；false 和重复事件不应重复计数。
    for (i in 0..3) { seedLearningEvent(db, "growth-q-today-" + i.toString(), "quiz", today, "quiz-demo", 1, "q-" + i.toString(), "工具调用", 1, 1, JsonObject()) }
    seedLearningEvent(db, "growth-c-today-1", "completion", today, "lecture-demo", 1, "section-1", "工具调用讲义", 0, 0, done)
    seedLearningEvent(db, "growth-c-today-2", "completion", today, "lecture-demo", 1, "section-1", "工具调用讲义", 0, 0, done)
    seedLearningEvent(db, "growth-c-today-undo", "completion", today, "lecture-demo", 1, "section-2", "工具调用讲义", 0, 0, undone)
    let nodeBody = JsonObject();nodeBody.put("kind", JsonString("node-complete"));nodeBody.put("done", JsonBool(true));nodeBody.put("title", JsonString("工具调用"))
    db.run("INSERT INTO course_events VALUES (?,?,?,?,?)", va([tv("growth-node-today"), tv("course-alpha"), tv("node-tools"), tv(nodeBody.toString()), tv(today + "T09:32:00+08:00")]))
    let nodeDup = JsonObject();nodeDup.put("kind", JsonString("node-complete"));nodeDup.put("done", JsonBool(true));nodeDup.put("title", JsonString("工具调用"))
    db.run("INSERT INTO course_events VALUES (?,?,?,?,?)", va([tv("growth-node-today-dup"), tv("course-alpha"), tv("node-tools"), tv(nodeDup.toString()), tv(today + "T09:33:00+08:00")]))
    let nodeUndo = JsonObject();nodeUndo.put("kind", JsonString("node-complete"));nodeUndo.put("done", JsonBool(false));nodeUndo.put("title", JsonString("工具调用"))
    db.run("INSERT INTO course_events VALUES (?,?,?,?,?)", va([tv("growth-node-today-undo"), tv("course-alpha"), tv("node-tools"), tv(nodeUndo.toString()), tv(today + "T09:34:00+08:00")]))

    for (i in 0..2) { seedLearningEvent(db, "growth-q-y-" + i.toString(), "quiz", d1, "quiz-demo", 1, "q-y-" + i.toString(), "观察与验证", 1, 1, JsonObject()) }
    seedLearningEvent(db, "growth-q-d2", "quiz", d2, "quiz-demo", 1, "q-d2", "观察与验证", 1, 1, JsonObject())
    seedLearningEvent(db, "growth-c-d2", "completion", d2, "practice-demo", 1, "step-1", "实操指南", 0, 0, done)
    for (i in 0..4) { seedLearningEvent(db, "growth-q-d5-" + i.toString(), "quiz", d5, "quiz-demo", 1, "q-d5-" + i.toString(), "工具调用", 1, 1, JsonObject()) }
    for (i in 0..2) { seedLearningEvent(db, "growth-q-d30-" + i.toString(), "quiz", d30, "quiz-demo", 1, "q-d30-" + i.toString(), "工具调用", 1, 1, JsonObject()) }
    let node30 = JsonObject();node30.put("kind", JsonString("node-complete"));node30.put("done", JsonBool(true));node30.put("title", JsonString("观察与验证"))
    db.run("INSERT INTO course_events VALUES (?,?,?,?,?)", va([tv("growth-node-d30"), tv("course-alpha"), tv("node-observe"), tv(node30.toString()), tv(d30 + "T09:31:00+08:00")]))
    seedLearningEvent(db, "growth-c-d60", "completion", d60, "practice-demo", 1, "step-2", "实操指南", 0, 0, done)
    for (i in 0..6) { seedLearningEvent(db, "growth-q-d200-" + i.toString(), "quiz", d200, "quiz-demo", 1, "q-d200-" + i.toString(), "工具调用", 1, 1, JsonObject()) }
    // 超出 53 周窗口，不能进入当前网格。
    for (i in 0..5) { seedLearningEvent(db, "growth-q-d400-" + i.toString(), "quiz", d400, "quiz-demo", 1, "q-d400-" + i.toString(), "工具调用", 1, 1, JsonObject()) }
}
