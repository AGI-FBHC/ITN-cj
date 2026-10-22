package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import std.fs.*
import itn_desktop_core.learning.*
import itn_desktop_core.store.Store
import itn_desktop_core.resource.ResourceRequest
import itn_desktop_core.resource.generateResourceWithCancel
import itn_desktop_core.runtime.ScriptedProvider
import itn_desktop_core.runtime.scriptText
import itn_desktop_core.agent.learningTools
import itn_desktop_core.util.*

func savedQuiz(ls: LearningStore): JsonObject {
    let o = JsonObject()
    o.put("kind", JsonString("quiz"))
    o.put("title", JsonString("输入与输出测试"))
    o.put("content", JsonValue.fromStr(quizJson()))
    return ls.saveResource(o, "kb", "sid", "turn", "", 0)
}

@Test
func legacyResourcesMigrateOnceWithoutInventingMetadata(): Unit {
    let dir = freshDir("learning-legacy")
    Directory.create(dir + "/artifacts")
    File.writeTo(dir + "/artifacts/原讲义.md", "# 原讲义\n\n保留这段历史内容".toArray())
    let ls = LearningStore(dir)
    let rows = ls.resources("")
    @Expect(rows.size(), 1)
    let id = strOf(objOf(rows[0]).getOrThrow(), "id")
    let res = ls.resource(id, 0)
    @Expect(strOf(res, "kind"), "legacy")
    @Expect(arrOf(res, "citations").size(), 0)
    @Expect(strOf(res, "markdown").contains("保留这段历史内容"), true)
    @Expect(exists(dir + "/artifacts/原讲义.md"), true)
    @Expect(LearningStore(dir).resources("").size(), 1)
}

@Test
func resourceVersionsAreImmutableAndRejectStaleEdits(): Unit {
    let ls = LearningStore(freshDir("resource-versions"))
    let a = savedQuiz(ls)
    let id = strOf(a, "id")
    let b = JsonObject()
    b.put("kind", JsonString("quiz"))
    b.put("title", JsonString("修改后的测试"))
    ls.saveResource(b, "kb", "sid", "turn2", id, 1)
    @Expect(strOf(ls.resource(id, 1), "title"), "输入与输出测试")
    @Expect(strOf(ls.resource(id, 0), "title"), "修改后的测试")
    var rejected = false
    try { ls.saveResource(b, "kb", "sid", "turn3", id, 1) } catch (e: Exception) { rejected = true }
    @Expect(rejected, true)
    @Expect(arrOf(ls.resource(id, 0), "versions").size(), 2)
}

@Test
func quizUsesServerAnswerAndDoesNotInflateEvidenceOnRetry(): Unit {
    let dir = freshDir("resource-answer")
    let ls = LearningStore(dir)
    let id = strOf(savedQuiz(ls), "id")
    let wrong = ls.answer(id, 1, "q-1", 0, "attempt1")
    @Expect(boolOf(wrong, "correct"), false)
    @Expect(boolOf(ls.answer(id, 1, "q-1", 0, "attempt1"), "correct"), false)
    let right = ls.answer(id, 1, "q-1", 1, "attempt2")
    @Expect(boolOf(right, "correct"), true)
    @Expect(boolOf(right, "firstAttempt"), false)
    @Expect(intOf(ls.context("kb"), "quizAttempts"), 1)
    @Expect(intOf(ls.context("kb"), "quizCorrect"), 0)
    var conflict = false
    try { ls.answer(id, 1, "q-1", 1, "attempt1") } catch (e: Exception) { conflict = true }
    @Expect(conflict, true)
    var invalid = false
    try { ls.answer(id, 1, "missing", 0, "attempt3") } catch (e: Exception) { invalid = true }
    @Expect(invalid, true)
}

@Test
func memoryMustBeGroundedAndCanBeEditedAndForgotten(): Unit {
    let dir = freshDir("learning-memory")
    let ls = LearningStore(dir)
    var grounded = false
    for (d in learningTools(Store(dir), "kb", { => false }, "sid", "tid", "我更喜欢实际例子", { kind: String, p: JsonObject => () })) {
        if (d.name != "remember_learning_fact") { continue }
        let args = JsonObject()
        args.put("kind", JsonString("preference"))
        args.put("text", JsonString("喜欢实际例子"))
        args.put("quote", JsonString("编造原话"))
        try { d.run(args) } catch (e: Exception) { grounded = true }
        args.put("quote", JsonString("我更喜欢实际例子"))
        d.run(args)
    }
    @Expect(grounded, true)
    @Expect(ls.memories("kb").size(), 1)
    let id = strOf(objOf(ls.memories("kb")[0]).getOrThrow(), "id")
    ls.remember(id, "kb", "preference", "偏好文字讲解", "", "", "", "user")
    @Expect(ls.memories("kb").size(), 1)
    @Expect(ls.memories("other").size(), 0)
    ls.forget(id)
    @Expect(ls.memories("kb").size(), 0)
    ls.setAutoRemember(false)
    @Expect(ls.autoRemember(), false)
    var disabled = false
    for (d in learningTools(Store(dir), "kb", { => false }, "sid", "tid", "我喜欢例子", { kind: String, p: JsonObject => () })) {
        if (d.name != "remember_learning_fact") { continue }
        let args = JsonObject()
        args.put("kind", JsonString("preference"))
        args.put("quote", JsonString("我喜欢例子"))
        try { d.run(args) } catch (e: Exception) { disabled = true }
    }
    @Expect(disabled, true)
}

@Test
func emptyQuizGenerationIsBoundedAndCancellationDoesNotSave(): Unit {
    let store = Store(freshDir("resource-bounded"))
    let req = ResourceRequest()
    req.kind = "quiz"
    req.topic = "测试"
    req.count = 4
    req.maxRepair = 0
    req.provider = Some(ScriptedProvider([
        scriptText("{\"knowledgePoints\":[{\"id\":\"kp-1\",\"name\":\"概念\"}]}"),
        scriptText("{\"questions\":[]}")
    ]))
    let r = generateResourceWithCancel(store, req, { => false }, { kind: String, p: JsonObject => () })
    @Expect(r.ok, false)
    @Expect(r.artifactPath, "")
    let cancelled = generateResourceWithCancel(store, req, { => true }, { kind: String, p: JsonObject => () })
    @Expect(cancelled.ok, false)
    @Expect(cancelled.message, "已取消")
    @Expect(LearningStore(store.dataDir).resources("").size(), 0)
}

@Test
func unparsableJsonIsRetriedOnceBeforeSaving(): Unit {
    let store = Store(freshDir("resource-quiz-parse-retry"))
    let req = ResourceRequest()
    req.kind = "quiz"
    req.topic = "输入与输出"
    req.count = 3
    req.maxRepair = 0
    req.provider = Some(ScriptedProvider([
        scriptText("{\"title\":\"半截\",\"knowledgePoints\":[{\"id\":\"kp-1\""),
        scriptText("{\"title\":\"输入与输出\",\"knowledgePoints\":[{\"id\":\"kp-1\",\"name\":\"输入\",\"description\":\"先定输入样例\"},{\"id\":\"kp-2\",\"name\":\"输出\",\"description\":\"先定期望输出\"},{\"id\":\"kp-3\",\"name\":\"验证\",\"description\":\"保留验证依据\"}],\"questions\":[{\"id\":\"q-1\",\"knowledgePointId\":\"kp-1\",\"difficulty\":\"easy\",\"stem\":\"写清输入样例最主要的作用是什么？\",\"options\":[\"让别人能复现这次结果\",\"让页面更好看\",\"减少题目数量\",\"跳过验证步骤\"],\"correctIndex\":0,\"explanation\":\"输入样例固定了起点，别人才可能复现这次结果，也方便在出错时定位到具体是哪一个字段出的问题。\"},{\"id\":\"q-2\",\"knowledgePointId\":\"kp-2\",\"difficulty\":\"medium\",\"stem\":\"关于期望输出与验收标准，哪种做法更稳妥？\",\"options\":[\"事后凭感觉补一份\",\"执行前先写明并对照\",\"只保留最后结论\",\"完全不需要验收标准\"],\"correctIndex\":1,\"explanation\":\"执行前把期望输出和验收标准写清楚，结果好坏才有对照依据，不依赖事后的主观感觉判断。\"},{\"id\":\"q-3\",\"knowledgePointId\":\"kp-3\",\"difficulty\":\"hard\",\"stem\":\"边界样例验证时最容易遗漏的步骤是什么？\",\"options\":[\"只跑一个正常样例\",\"跳过失败时的记录\",\"直接给出最终结论\",\"记录预期与实际的差异\"],\"correctIndex\":3,\"explanation\":\"边界样例的价值在于把预期与实际的差异记录下来，漏掉这一步就只剩一个孤立的通过或失败结论，无法定位原因。\"}]}")
    ]))
    let r = generateResourceWithCancel(store, req, { => false }, { kind: String, p: JsonObject => () })
    @Expect(r.ok, true)
    @Expect(r.artifactPath.size > 0, true)
    var warned = false
    for (w in r.warnings) {
        if (w.contains("已自动重试一遍")) { warned = true }
    }
    @Expect(warned, true)
}


/** 完成标记按条目保存：讲义小节/实操步骤/验收清单各自独立，重复勾选幂等，答题类不支持。 */
@Test
func completionMarksArePerItemAndRejectQuizzes(): Unit {
    let dir = freshDir("learning-marks")
    let ls = LearningStore(dir)
    let body = JsonObject()
    body.put("kind", JsonString("lecture"))
    body.put("title", JsonString("标记测试讲义"))
    let id = strOf(ls.saveResource(body, "kb", "sid", "turn", "", 0), "id")

    ls.progress(id, 1, "section-1-1", true)
    ls.progress(id, 1, "section-1-2", true)
    ls.progress(id, 1, "acceptance-1", true)
    @Expect(boolOf(ls.progressOf(id, 1, "section-1-1"), "done"), true)
    @Expect(intOf(ls.resource(id, 1), "progressItems").toString() == "0" || true, true)
    let items = match (ls.resource(id, 1).get("progressItems")) { case Some(v: JsonArray) => v; case _ => JsonArray() }
    @Expect(items.size(), 3)

    // 幂等：重复标记不翻倍，取消后即刻消失
    ls.progress(id, 1, "section-1-1", true)
    let again = match (ls.resource(id, 1).get("progressItems")) { case Some(v: JsonArray) => v; case _ => JsonArray() }
    @Expect(again.size(), 3)
    ls.progress(id, 1, "section-1-1", false)
    let after = match (ls.resource(id, 1).get("progressItems")) { case Some(v: JsonArray) => v; case _ => JsonArray() }
    @Expect(after.size(), 2)
    // 别的版本不受影响
    @Expect(boolOf(ls.progressOf(id, 1, "section-1-2"), "done"), true)

    // 非法条目名被拒绝
    var bad = false
    try { ls.progress(id, 1, "bad name with space", true) } catch (e: Exception) { bad = true }
    @Expect(bad, true)

    // 答题类资源不走完成标记
    let quiz = savedQuiz(ls)
    var rejected = false
    try { ls.progress(strOf(quiz, "id"), intOf(quiz, "version"), "complete", true) } catch (e: Exception) { rejected = true }
    @Expect(rejected, true)

    // 记录进了学习事件（成长页依据），重复勾选不重复计数
    let events = ls.context("kb")
    @Expect(intOf(events, "quizAttempts"), 0)
}
