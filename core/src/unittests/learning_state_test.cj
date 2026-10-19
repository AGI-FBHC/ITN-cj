package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.store.*
import itn_desktop_core.learning.*
import itn_desktop_core.agent.learningTools
import itn_desktop_core.pi.ScriptedProvider
import itn_desktop_core.pi.scriptText
import itn_desktop_core.pi_app.PiAgent
import itn_desktop_core.util.*

@Test
func structuredStateSeparatesFirstEvidenceFromLatestAnswerAndReading(): Unit {
    let dir = freshDir("state-evidence")
    let ls = LearningStore(dir)
    let quiz = savedQuiz(ls)
    let id = strOf(quiz, "id")
    ls.answer(id, 1, "q-1", 0, "state-first")
    ls.answer(id, 1, "q-1", 1, "state-retry")
    let db = DbHub.open(dir)
    db.run("INSERT INTO progress VALUES (?,'chunk',?,?)", va([tv("kb"), tv("chapter-2#1"), tv("2026-10-20T09:00:00+08:00")]))
    db.run("INSERT INTO progress VALUES (?,'section',?,?)", va([tv("other"), tv("private-course"), tv("2026-10-20T09:00:00+08:00")]))
    db.run("INSERT INTO learning_events VALUES (?,'guided-checkpoint',?, ?,1,'checkpoint','工具调用',0,1,'{}',?)",
        va([tv("guided-state-1"),tv("kb"),tv(id),tv("2026-10-20T09:01:00+08:00")]))
    db.run("INSERT INTO learning_events VALUES (?,'guided-checkpoint',?, ?,1,'checkpoint','工具调用',0,1,'{}',?)",
        va([tv("guided-state-2"),tv("kb"),tv(id),tv("2026-10-20T09:02:00+08:00")]))
    let context = ls.context("kb")
    @Expect(intOf(context, "quizAttempts"), 2)
    @Expect(intOf(context, "quizCorrect"), 0)
    let state = objOf(context.get("learningState").getOrThrow()).getOrThrow()
    @Expect(intOf(objOf(state.get("progress").getOrThrow()).getOrThrow(), "readChunks"), 1)
    @Expect(intOf(objOf(state.get("progress").getOrThrow()).getOrThrow(), "completedSections"), 0)
    @Expect(arrOf(state, "needsPractice").size(), 1)
    @Expect(strOf(objOf(arrOf(state, "needsPractice")[0]).getOrThrow(), "itemId"), "checkpoint")
    @Expect(arrOf(state, "recentReading").toString().contains("private-course"), false)
    @Expect(context.get("mastery").getOrThrow().toString(), "null")
}

@Test
func completionStateUsesCurrentMarksAndCurrentMapOnly(): Unit {
    let dir = freshDir("state-completion")
    let ls = LearningStore(dir)
    let body = JsonValue.fromStr("{\"kind\":\"lecture\",\"title\":\"调用工具\"}")
    let lecture = ls.saveResource(objOf(body).getOrThrow(), "kb", "s", "t", "", 0)
    let id = strOf(lecture, "id")
    ls.progress(id, 1, "section-1", true)
    ls.progress(id, 1, "section-1", true)
    ls.progress(id, 1, "section-1", false)
    ls.progress(id, 1, "section-2", true)
    let state = structuredLearningState(dir, "kb")
    let resource = objOf(arrOf(state, "recentResources")[0]).getOrThrow()
    @Expect(intOf(resource, "completedItemCount"), 1)
    @Expect(arrOf(resource, "completedItems").toString(), "[\"section-2\"]")
    @Expect(arrOf(state, "recentChecks").size(), 0)
    @Expect(intOf(ls.context("kb"), "quizAttempts"), 0)
    let db = DbHub.open(dir)
    db.run("INSERT INTO knowledge_bases(id,name) VALUES ('kb','当前课程')", va([]))
    db.run("INSERT INTO course_maps VALUES ('map-1','kb','current',?, 'now')", va([tv("{\"nodes\":[{\"id\":\"node-1\",\"depth\":2,\"title\":\"函数\"}]}")]))
    db.run("INSERT INTO course_maps VALUES ('map-old','kb','archived',?, 'now')", va([tv("{\"nodes\":[{\"id\":\"old\",\"depth\":2,\"title\":\"旧阶段\"}]}")]))
    db.putKv("meta", "course-head:kb", "map-1")
    db.putKv("meta", "course-node-progress:node-1", "{\"done\":true}")
    db.putKv("meta", "course-node-progress:old", "{\"done\":true}")
    let courses = arrOf(structuredLearningState(dir,"kb"), "currentCourses")
    @Expect(courses.size(), 1)
    @Expect(intOf(objOf(courses[0]).getOrThrow(),"completedNodes"), 1)
    @Expect(courses.toString().contains("旧阶段"), false)
}

@Test
func dueReviewUsesUserReviewScheduleAndBoundedContextKeepsLongTermGoals(): Unit {
    let dir = freshDir("state-review-bounds")
    let ls = LearningStore(dir)
    let quiz = savedQuiz(ls)
    ls.answer(strOf(quiz,"id"),1,"q-1",0,"due-first")
    @Expect(intOf(structuredLearningState(dir,"kb"),"reviewDueCount"),1)
    DbHub.open(dir).putKv("meta", "quiz-review:resource:due-first", "1|0|1")
    @Expect(intOf(structuredLearningState(dir,"kb"),"reviewDueCount"),0)
    ls.remember("","","goal","长期目标保留","","","","user")
    for(i in 0..24){ls.remember("","kb","fact","例子"+i.toString(),"","","","user")}
    let compact = ls.agentContext("kb")
    @Expect(compact.toString().contains("长期目标保留"),true)
    @Expect(arrOf(compact,"memories").size() <= 16,true)
    @Expect(intOf(compact,"memoryTotal"),25)
    @Expect(objOf(JsonValue.fromStr(compact.toString())).isSome(),true)
}

@Test
func structuredMemoriesUpdateByTopicPersistAndRespectScopeAndForget(): Unit {
    let dir = freshDir("state-memories")
    let ls = LearningStore(dir)
    let global = ls.remember("", "", "preference", "先讲例子", "先讲例子", "s1", "t1", "agent", "讲解方式")
    let updated = ls.remember("", "", "preference", "先讲原理", "先讲原理", "s2", "t2", "agent", "讲解方式")
    @Expect(strOf(global, "id"), strOf(updated, "id"))
    let status = ls.remember("", "kb", "status", "我学到第二章", "我学到第二章", "s2", "t2", "agent", "阶段")
    let repeated = ls.remember("", "kb", "status", "我学到第二章", "我学到第二章", "s2", "t3", "agent", "阶段")
    @Expect(strOf(status, "id"), strOf(repeated, "id"))
    @Expect(LearningStore(dir).memories("kb").size(), 2)
    @Expect(ls.memories("other").size(), 1)
    @Expect(ls.agentContext("kb").toString().contains("先讲例子"), false)
    @Expect(ls.agentContext("kb").toString().contains("我学到第二章"), true)
    ls.forget(strOf(global, "id"))
    @Expect(ls.agentContext("kb").toString().contains("先讲原理"), false)
    @Expect(ls.agentContext("other").toString().contains("我学到第二章"), false)
}

@Test
func newSessionsReceiveCurrentLearningStateWithoutCallingMemoryTool(): Unit {
    let dir = freshDir("state-new-session")
    let store = Store(dir)
    let ls = LearningStore(dir)
    let memory = ls.remember("", "", "preference", "例子暗号松鼠", "", "", "", "user")
    let first = ScriptedProvider([scriptText("已参考学习偏好")])
    PiAgent(store).runFull(first, "", "解释函数", "", "off", "", None, "", "")
    @Expect(first.seenSystems[0].contains("例子暗号松鼠"), true)
    @Expect(first.seenSystems[0].contains("learningState"), true)
    ls.forget(strOf(memory, "id"))
    let next = ScriptedProvider([scriptText("已按当前档案回答")])
    PiAgent(store).runFull(next, "", "解释函数", "", "off", "", None, "", "")
    @Expect(next.seenSystems[0].contains("例子暗号松鼠"), false)
}

@Test
func knowledgeRenameToolRequiresExplicitTargetAndKeepsIndexAndProgress(): Unit {
    let dir = freshDir("kb-rename-state")
    let store = Store(dir)
    let settings = store.load()
    let kb = KnowledgeBase()
    kb.id = "rename-kb"
    kb.name = "原课程"
    kb.rootDir = "D:/unchanged"
    kb.sourcePath = "D:/original"
    kb.chunkCount = 29
    kb.builtAt = "2026-10-20T09:00:00+08:00"
    settings.knowledgeBases.add(kb)
    store.save(settings)
    DbHub.open(dir).run("INSERT INTO progress VALUES (?,'section','section-1','now')", va([tv(kb.id)]))
    var blocked = false
    let args = objOf(JsonValue.fromStr("{\"id\":\"rename-kb\",\"name\":\"新课程\"}")).getOrThrow()
    for (tool in learningTools(store, "", { => false }, "s", "t", "介绍原课程", { k: String, p: JsonObject => () })) {
        if (tool.name == "rename_knowledge_base") { try { tool.run(args) } catch (e: Exception) { blocked = true } }
    }
    @Expect(blocked, true)
    for (tool in learningTools(store, "", { => false }, "s", "t", "把原课程改名为新课程", { k: String, p: JsonObject => () })) {
        if (tool.name == "rename_knowledge_base") { @Expect(tool.run(args).ok, true) }
    }
    let after = store.load().findKb(kb.id).getOrThrow()
    @Expect(after.name, "新课程")
    @Expect(after.rootDir, kb.rootDir)
    @Expect(after.sourcePath, kb.sourcePath)
    @Expect(after.chunkCount, 29)
    @Expect(after.builtAt, kb.builtAt)
    @Expect(intOf(objOf(structuredLearningState(dir,kb.id).get("progress").getOrThrow()).getOrThrow(),"completedSections"),1)
    var emptyBlocked = false
    try { store.renameKb(kb.id, "  ") } catch (e: Exception) { emptyBlocked = true }
    @Expect(emptyBlocked, true)
}
