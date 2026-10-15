package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.learning.*
import itn_desktop_core.store.Store
import itn_desktop_core.resource.ResourceRequest
import itn_desktop_core.resource.generateResourceWithCancel
import itn_desktop_core.pi.ScriptedProvider
import itn_desktop_core.pi.scriptText
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
