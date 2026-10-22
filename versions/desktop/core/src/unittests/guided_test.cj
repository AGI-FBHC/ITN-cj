package itn_desktop_core.unittests

import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.agent.guidedTools
import itn_desktop_core.agent.DomainTool
import itn_desktop_core.db.*
import itn_desktop_core.guided.GuidedStore
import itn_desktop_core.learning.*
import itn_desktop_core.resource.normalizePptTeachingMoments
import itn_desktop_core.session.SessionStore
import itn_desktop_core.store.Store
import itn_desktop_core.study.StudyStore
import itn_desktop_core.util.*

func guidedFixtureContent(): JsonObject {
    let content = JsonObject()
    content.put("title", JsonString("工具调用演示"))
    let slides = JsonArray()
    var i = 0
    while (i < 4) {
        let slide = JsonObject()
        slide.put("title", JsonString(["明确输入输出", "执行并观察", "验证与复盘", "独立实践"][i]))
        let bullets = JsonArray()
        bullets.add(JsonString("保留真实输出并核对输入。[1]"))
        bullets.add(JsonString("记录边界样例与验收结果。[1]"))
        slide.put("bullets", bullets)
        slide.put("speakerNote", JsonString("先展示预期，再逐项核对真实输出。"))
        let moments = JsonArray()
        if (i == 2) {
            let quiz = JsonObject()
            quiz.put("momentId", JsonString("s3-quiz-1"))
            quiz.put("type", JsonString("quiz"))
            quiz.put("title", JsonString("检查理解"))
            quiz.put("prompt", JsonString("输出与预期不一致时，第一步做什么？"))
            let options = JsonArray()
            for (x in ["保留观察记录并核对", "跳过核对直接重试", "修改输出迎合预期", "只记录成功结果"]) {
                options.add(JsonString(x))
            }
            quiz.put("options", options)
            quiz.put("answerIndex", JsonInt(0))
            quiz.put("explanation", JsonString("先保留真实输出并核对输入，才能判断问题来自参数、权限还是执行过程。"))
            quiz.put("anchorText", JsonString("保留真实输出并核对输入。[1]"))
            moments.add(quiz)
        }
        if (i == 3) {
            let summary = JsonObject()
            summary.put("momentId", JsonString("s4-summary-1"))
            summary.put("type", JsonString("summary"))
            summary.put("title", JsonString("本页小结"))
            let points = JsonArray()
            points.add(JsonString("输入和预期要可复现"))
            points.add(JsonString("真实输出要保留并核对"))
            summary.put("points", points)
            summary.put("notePrompt", JsonString("写下你会怎样验证一次工具调用。"))
            summary.put("anchorText", JsonString("保留真实输出并核对输入。[1]"))
            moments.add(summary)
        }
        slide.put("teachingMoments", moments)
        slides.add(slide)
        i += 1
    }
    content.put("slides", slides)
    return content
}

func savedGuidedPpt(dir: String): JsonObject {
    let body = JsonObject()
    body.put("kind", JsonString("ppt"))
    body.put("title", JsonString("工具调用演示"))
    body.put("content", guidedFixtureContent())
    body.put("markdown", JsonString(""))
    body.put("citations", JsonArray())
    return LearningStore(dir).saveResource(body, "course-kb", "fixture", "fixture", "", 0)
}

@Test
func guidedSessionRestoresAndKeepsAgentContextAnswerSafe(): Unit {
    let dir = freshDir("guided-session")
    let saved = savedGuidedPpt(dir)
    let resourceId = strOf(saved, "id")
    let guided = GuidedStore(dir)

    let first = guided.resolve(resourceId, 1)
    let firstSid = strOf(first, "sessionId")
    @Expect(boolOf(first, "created"), true)
    @Expect(strOf(first, "resourceId"), resourceId)
    @Expect(intOf(first, "slide"), 1)
    let second = guided.resolve(resourceId, 1)
    @Expect(boolOf(second, "created"), false)
    @Expect(strOf(second, "sessionId"), firstSid)

    // 导学会话不藏在独立空间：普通列表能看到它，并带资源标签。
    var listedResource = false
    for (item in SessionStore(dir).list()) {
        if (strOf(item, "sessionId") == firstSid) {
            let tag = objOf(item.get("resource").getOrThrow()).getOrDefault({ => JsonObject() })
            listedResource = strOf(tag, "resourceId") == resourceId
        }
    }
    @Expect(listedResource, true)

    // 同一份 PPT 可以有多条导学会话；最近选择跨实例（应用重启）恢复。
    let extra = guided.createSession(resourceId, 1, 3)
    let extraSid = strOf(extra, "sessionId")
    @Expect(extraSid != firstSid, true)
    @Expect(intOf(extra, "slide"), 3)
    @Expect(guided.sessions(resourceId, 1).size(), 2)
    @Expect(strOf(guided.select(resourceId, 1, firstSid), "sessionId"), firstSid)
    @Expect(strOf(guided.resolve(resourceId, 1), "sessionId"), firstSid)
    @Expect(strOf(guided.select(resourceId, 1, extraSid), "sessionId"), extraSid)
    let reopened = GuidedStore(dir).resolve(resourceId, 1)
    @Expect(strOf(reopened, "sessionId"), extraSid)
    @Expect(intOf(reopened, "slide"), 3)
    @Expect(strOf(guided.select(resourceId, 1, firstSid), "sessionId"), firstSid)

    let context = guided.focus(firstSid, 3)
    @Expect(intOf(context, "currentSlide"), 3)
    @Expect(arrOf(context, "visitedSlides").size(), 2)
    @Expect(arrOf(context, "teachingMoments").size(), 2)
    let safe = guided.agentContext(firstSid)
    @Expect(arrOf(safe, "visitedSlides").size(), 2)
    @Expect(safe.toString().contains("\"answerIndex\""), false)
    @Expect(safe.toString().contains("\"explanation\""), false)
    @Expect(safe.toString().contains("s3-quiz-1"), true)

    let wrong = guided.checkpoint(firstSid, "s3-quiz-1", 1)
    @Expect(boolOf(wrong, "correct"), false)
    @Expect(intOf(wrong, "correctIndex"), 0)
    let repeated = guided.checkpoint(firstSid, "s3-quiz-1", 0)
    @Expect(boolOf(repeated, "repeated"), true)
    @Expect(intOf(repeated, "answerIndex"), 1)
    let eventCount = DbHub.open(dir).scalarInt(
        "SELECT COUNT(*) FROM learning_events WHERE resource_id = ? AND version = ? AND kind = ?",
        va([tv(resourceId), nv(1), tv("guided-checkpoint")]))
    @Expect(eventCount, 1)

    let note = guided.saveNote(firstSid, "", "核对输入、预期和真实输出。", "保留真实输出并核对输入。[1]")
    @Expect(strOf(note, "resourceId"), resourceId)
    @Expect(intOf(note, "resourceVersion"), 1)
    @Expect(intOf(note, "page"), 3)
    @Expect(strOf(note, "slideTitle"), "验证与复盘")
    @Expect(strOf(note, "sourceQuote"), "保留真实输出并核对输入。[1]")
    let notes = StudyStore(dir).load().notes
    @Expect(notes.size, 1)
    @Expect(notes[0].resourceId, resourceId)
    @Expect(notes[0].page, 3)

    let normalTools = guidedTools(Store(dir), SessionStore(dir).newId(), "请记笔记")
    @Expect(normalTools.size, 0)
    let tools = guidedTools(Store(dir), firstSid, "请记笔记")
    @Expect(tools.size, 4)
    let names = HashSet<String>()
    for (tool in tools) { names.add(tool.name) }
    @Expect(names.contains("read_guided_lesson"), true)
    @Expect(names.contains("submit_guided_checkpoint"), true)
    @Expect(names.contains("save_guided_note"), true)
    @Expect(names.contains("open_guided_lesson"), true)
}

@Test
func guidedSessionIsBoundToExactResourceVersion(): Unit {
    let dir = freshDir("guided-version")
    let saved = savedGuidedPpt(dir)
    let resourceId = strOf(saved, "id")
    let secondBody = JsonObject()
    secondBody.put("kind", JsonString("ppt"))
    secondBody.put("title", JsonString("工具调用演示 v2"))
    secondBody.put("content", guidedFixtureContent())
    LearningStore(dir).saveResource(secondBody, "course-kb", "fixture", "fixture2", resourceId, 1)

    let guided = GuidedStore(dir)
    let v1 = guided.resolve(resourceId, 1)
    let v2 = guided.resolve(resourceId, 2)
    @Expect(strOf(v1, "sessionId") == strOf(v2, "sessionId"), false)
    @Expect(intOf(v1, "version"), 1)
    @Expect(intOf(v2, "version"), 2)
    @Expect(strOf(guided.open(strOf(v2, "sessionId")), "href"), "#/study/" + resourceId + "@2")
}

@Test
func pptTeachingMomentsAreNormalizedAndBackfilled(): Unit {
    let content = JsonObject()
    let slides = JsonArray()
    var i = 0
    while (i < 4) {
        let slide = JsonObject()
        slide.put("title", JsonString("第 " + (i + 1).toString() + " 页"))
        let bullets = JsonArray()
        bullets.add(JsonString("页面要点 " + (i + 1).toString()))
        bullets.add(JsonString("验证方法 " + (i + 1).toString()))
        slide.put("bullets", bullets)
        slides.add(slide)
        i += 1
    }
    content.put("slides", slides)
    let warnings = ArrayList<String>()
    normalizePptTeachingMoments(content, warnings)

    let cleaned = arrOf(content, "slides")
    var quizCount: Int64 = 0
    var lastSummary = false
    let ids = HashSet<String>()
    i = 0
    while (i < cleaned.size()) {
        let slide = objOf(cleaned[i]).getOrThrow()
        let moments = arrOf(slide, "teachingMoments")
        var j = 0
        while (j < moments.size()) {
            let moment = objOf(moments[j]).getOrThrow()
            let id = strOf(moment, "momentId")
            @Expect(id.size > 0, true)
            @Expect(ids.contains(id), false)
            ids.add(id)
            let typ = strOf(moment, "type")
            if (typ == "quiz") {
                quizCount += 1
                let options = arrOf(moment, "options")
                @Expect(options.size(), 4)
                let uniqueOptions = HashSet<String>()
                var oi = 0
                while (oi < options.size()) {
                    uniqueOptions.add(strValue(options[oi]))
                    oi += 1
                }
                @Expect(uniqueOptions.size, 4)
                let answer = intOf(moment, "answerIndex")
                @Expect(answer >= 0 && answer < 4, true)
                @Expect(strOf(moment, "prompt").size > 0, true)
                @Expect(strOf(moment, "anchorText").size > 0, true)
            }
            if (i == cleaned.size() - 1 && typ == "summary") { lastSummary = true }
            j += 1
        }
        i += 1
    }
    @Expect(quizCount >= 1, true)
    @Expect(lastSummary, true)
    @Expect(warnings.size >= 1, true)
}



func namedGuidedTool(tools: ArrayList<DomainTool>, name: String): DomainTool {
    for (tool in tools) {
        if (tool.name == name) {
            return tool
        }
    }
    throw Exception("缺少导学工具 " + name)
}

@Test
func guidedToolsExecuteStatefulOperationsWithConsentGuards(): Unit {
    let dir = freshDir("guided-tools-exec")
    let saved = savedGuidedPpt(dir)
    let resourceId = strOf(saved, "id")
    let store = Store(dir)
    let guided = GuidedStore(dir)
    let sid = strOf(guided.resolve(resourceId, 1), "sessionId")

    // 读取第 4 页会真实改变焦点，但给模型的上下文不能泄露选择题答案。
    let readArgs = JsonObject()
    readArgs.put("slide", JsonInt(4))
    let readRun = namedGuidedTool(guidedTools(store, sid, "读取第 4 页"), "read_guided_lesson").run(readArgs)
    @Expect(readRun.ok, true)
    let readData = objOf(readRun.details).getOrThrow()
    @Expect(intOf(readData, "currentSlide"), 4)
    @Expect(readRun.content.contains("独立实践"), true)
    @Expect(readRun.content.contains("\"answerIndex\""), false)
    @Expect(readRun.content.contains("\"explanation\""), false)

    // 用户明确说出字母和选项原文后，服务端才执行检查点并记录结果。
    guided.focus(sid, 3)
    let submitUser = "我选 B：跳过核对直接重试，请提交"
    let submitArgs = JsonObject()
    submitArgs.put("momentId", JsonString("s3-quiz-1"))
    submitArgs.put("answerIndex", JsonInt(1))
    submitArgs.put("quote", JsonString("我选 B"))
    let submitRun = namedGuidedTool(guidedTools(store, sid, submitUser), "submit_guided_checkpoint").run(submitArgs)
    let submitData = objOf(submitRun.details).getOrThrow()
    @Expect(boolOf(submitData, "correct"), false)
    @Expect(boolOf(submitData, "repeated"), false)
    @Expect(intOf(submitData, "answerIndex"), 1)

    let blurryUser = "帮我看看这题选什么"
    let blurryArgs = JsonObject()
    blurryArgs.put("momentId", JsonString("s3-quiz-1"))
    blurryArgs.put("answerIndex", JsonInt(0))
    blurryArgs.put("quote", JsonString(blurryUser))
    var submitBlocked = false
    try {
        namedGuidedTool(guidedTools(store, sid, blurryUser), "submit_guided_checkpoint").run(blurryArgs)
    } catch (e: Exception) {
        submitBlocked = e.message.contains("明确选择")
    }
    @Expect(submitBlocked, true)

    // 只有用户明确要求“记笔记”时才落库，并且来源自动绑定当前资源与页码。
    let noteUser = "请帮我记笔记：我会核对真实输出"
    let noteArgs = JsonObject()
    noteArgs.put("title", JsonString("检查点笔记"))
    noteArgs.put("text", JsonString("我会核对真实输出"))
    noteArgs.put("quote", JsonString("我会核对真实输出"))
    let noteRun = namedGuidedTool(guidedTools(store, sid, noteUser), "save_guided_note").run(noteArgs)
    let noteData = objOf(noteRun.details).getOrThrow()
    @Expect(strOf(noteData, "resourceId"), resourceId)
    @Expect(intOf(noteData, "resourceVersion"), 1)
    @Expect(intOf(noteData, "page"), 3)
    @Expect(StudyStore(dir).load().notes.size, 1)

    let noConsentArgs = JsonObject()
    noConsentArgs.put("text", JsonString("模型不该擅自保存这句"))
    var noteBlocked = false
    try {
        namedGuidedTool(guidedTools(store, sid, "解释一下这一页"), "save_guided_note").run(noConsentArgs)
    } catch (e: Exception) {
        noteBlocked = e.message.contains("明确要求记笔记")
    }
    @Expect(noteBlocked, true)
    @Expect(StudyStore(dir).load().notes.size, 1)

    let openRun = namedGuidedTool(guidedTools(store, sid, "打开导学页"), "open_guided_lesson").run(JsonObject())
    let openData = objOf(openRun.details).getOrThrow()
    @Expect(strOf(openData, "href"), "#/study/" + resourceId + "@1")

    let normalSid = SessionStore(dir).newId()
    @Expect(guidedTools(store, normalSid, "记笔记").size, 0)
}
