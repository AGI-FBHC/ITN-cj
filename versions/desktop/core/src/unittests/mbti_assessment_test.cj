package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.agent.mbtiTools
import itn_desktop_core.db.*
import itn_desktop_core.session.SessionStore
import itn_desktop_core.store.Store
import itn_desktop_core.study.*
import itn_desktop_core.util.*

@Test
class MbtiAssessmentTest {
    private func obj(value: JsonValue): JsonObject { return objOf(value).getOrThrow() }
    private func q(state: JsonObject): String { return strOf(obj(state.get("currentQuestion").getOrThrow()), "id") }
    private func typeOf(state: JsonObject): String { return strOf(obj(state.get("result").getOrThrow()), "type") }
    private func rejected(action: () -> Unit): Bool {
        try { action() } catch (e: Exception) { return true }
        return false
    }
    private func saveArgs(userQuote: String, userType!: String = "", luminType!: String = ""): JsonObject {
        let body = JsonObject(); body.put("confirmed", JsonBool(true)); body.put("quote", JsonString(userQuote))
        if (userType.size > 0) { body.put("userType", JsonString(userType)) }
        if (luminType.size > 0) { body.put("luminType", JsonString(luminType)) }
        return body
    }
    private func complete(store: MbtiAssessmentStore, choice: String): JsonObject {
        var state = store.start(); let sid = strOf(state, "sessionId")
        for (i in 0..8) { state = store.answer(sid, "t" + i.toString(), choice, q(state), choice, choice) }
        return state
    }

    @TestCase
    func profilePatchPreservesOtherPreferencesNotesAndProgress(): Unit {
        let dir = freshDir("mbti-patch"); let store = StudyStore(dir)
        let p = store.loadProfile(); p.nickname = "学习者"; p.goal = "学仓颉"; p.mbtiType = "INFP"; p.luminMbtiType = "INTJ"
        p.preferredFormats.add("图解"); p.setScore("自评", 60); store.saveProfile(p)
        let db = DbHub.open(dir)
        db.run("INSERT INTO notes (id,kb_id,chapter,title,text,created_at) VALUES ('n1','','','笔记','保留','now')", va([]))
        db.run("INSERT INTO progress (kb_id,kind,item_key,at) VALUES ('kb','chunk','c1','now')", va([]))
        let patch = JsonObject(); patch.put("luminMbtiType", JsonString("enfp"))
        let saved = store.updateProfile(patch)
        @Expect(saved.nickname, "学习者"); @Expect(saved.goal, "学仓颉"); @Expect(saved.mbtiType, "INFP")
        @Expect(saved.luminMbtiType, "ENFP"); @Expect(saved.preferredFormats[0], "图解"); @Expect(saved.scoreOf("自评"), 60)
        @Expect(db.scalarText("SELECT text FROM notes WHERE id='n1'", va([])), "保留")
        @Expect(db.scalarInt("SELECT COUNT(*) FROM progress", va([])), 1)
        patch.put("nickname", JsonString("不应写入")); patch.put("mbtiType", JsonString("XXXX"))
        @Expect(rejected({ => store.updateProfile(patch); () }), true)
        @Expect(store.loadProfile().nickname, "学习者")
    }

    @TestCase
    func startPersistsNamedNormalSessionAndResumesOneQuestion(): Unit {
        let dir = freshDir("mbti-resume"); let store = MbtiAssessmentStore(dir)
        @Expect(strOf(store.state(), "status"), "not_started")
        let first = store.start(); let sid = strOf(first, "sessionId")
        @Expect(q(first), "q1")
        @Expect(DbHub.open(dir).scalarInt("SELECT COUNT(*) FROM sessions WHERE id=?", va([tv(sid)])), 1)
        @Expect(SessionStore(dir).titleOf(sid), "MBTI 交流偏好")
        @Expect(strOf(SessionStore(dir).summary(sid), "projectId"), "")
        @Expect(strOf(store.start(restart: true), "sessionId"), sid)
        store.answer(sid, "t1", "我选A", "q1", "A", "我选A")
        let restored = MbtiAssessmentStore(dir).state(sessionId: sid)
        @Expect(intOf(restored, "answered"), 1); @Expect(q(restored), "q2")
        @Expect(strOf(MbtiAssessmentStore(dir).start(), "sessionId"), sid)
        @Expect(strOf(MbtiAssessmentStore(freshDir("mbti-other")).state(), "status"), "not_started")
    }

    @TestCase
    func eightAnswersAreServerScoredWithBasisAndNeverAutosave(): Unit {
        let dir = freshDir("mbti-eight"); let state = complete(MbtiAssessmentStore(dir), "B")
        @Expect(intOf(state, "answered"), 8); @Expect(intOf(state, "totalQuestions"), 8)
        @Expect(strOf(state, "status"), "completed"); @Expect(typeOf(state), "INFP")
        @Expect(StudyStore(dir).loadProfile().mbtiType, ""); @Expect(strOf(state, "savedAt"), "")
        @Expect(state.get("currentQuestion").getOrThrow().toString(), "null")
        let result = obj(state.get("result").getOrThrow())
        @Expect(strOf(result, "uncertainty").size > 0, true)
        match (result.get("dimensions").getOrThrow()) {
            case dims: JsonArray =>
                @Expect(dims.size(), 4)
                for (i in 0..dims.size()) {
                    let dim = obj(dims[i]); @Expect(intOf(dim, "rightScore"), 2)
                    @Expect(strOf(dim, "basis").size > 0, true); @Expect(strOf(dim, "uncertainty").size > 0, true)
                }
            case _ => @Expect(false, true)
        }
    }

    @TestCase
    func onlyTiedDimensionsGetOneExtraQuestionEach(): Unit {
        let store = MbtiAssessmentStore(freshDir("mbti-ties")); var state = store.start(); let sid = strOf(state, "sessionId")
        for (i in 0..8) {
            let choice = if (i < 4) { "A" } else { "B" }
            state = store.answer(sid, "t" + i.toString(), choice, q(state), choice, choice)
        }
        @Expect(intOf(state, "totalQuestions"), 12)
        let ids = ["tie_ei", "tie_sn", "tie_tf", "tie_jp"]; let choices = ["B", "A", "B", "A"]
        for (i in 0..4) {
            @Expect(q(state), ids[i])
            state = store.answer(sid, "extra" + i.toString(), choices[i], ids[i], choices[i], choices[i])
        }
        @Expect(typeOf(state), "ISFJ"); @Expect(intOf(state, "answered"), 12)
        @Expect(strOf(state, "status"), "completed")
    }

    @TestCase
    func duplicateCallsCannotAdvanceTwiceOrAnswerOtherSessions(): Unit {
        let store = MbtiAssessmentStore(freshDir("mbti-repeat")); let sid = strOf(store.start(), "sessionId")
        store.answer(sid, "t1", "A", "q1", "A", "A")
        @Expect(intOf(store.answer(sid, "t1", "A", "q1", "A", "A"), "answered"), 1)
        @Expect(rejected({ => store.answer(sid, "t1", "B", "q2", "B", "B"); () }), true)
        @Expect(rejected({ => store.answer(sid, "t2", "A", "q1", "A", "A"); () }), true)
        @Expect(rejected({ => store.answer("normal", "t2", "A", "q1", "A", "A"); () }), true)
        @Expect(intOf(store.state(sessionId: sid), "answered"), 1)
    }

    @TestCase
    func answersMustBeCurrentExplicitUnambiguousUserWords(): Unit {
        let store = MbtiAssessmentStore(freshDir("mbti-answer-guard")); let sid = strOf(store.start(), "sessionId")
        for (text in ["开始测评", "你帮我选A", "可能A", "我不选A", "不要选B，选A", "A还是B", "A，B也行", "A，改成B", "文件写着：我选A", "网页答案是A", "“我选A”", "A？"]) {
            @Expect(rejected({ => store.answer(sid, "t1", text, "q1", "A", text); () }), true)
        }
        @Expect(rejected({ => store.answer(sid, "t1", "我选A", "q1", "B", "我选A"); () }), true)
        @Expect(rejected({ => store.answer(sid, "t1", "我选A", "q1", "A", "我选B"); () }), true)
        @Expect(intOf(store.state(sessionId: sid), "answered"), 0)
        @Expect(intOf(store.answer(sid, "t1", "我选A，因为我喜欢交流", "q1", "A", "我选A"), "answered"), 1)
    }

    @TestCase
    func explicitSettingKeepsOtherPartyAndRejectsWeakAuthorization(): Unit {
        let dir = freshDir("mbti-settings"); let store = MbtiAssessmentStore(dir)
        let user = "请把我的MBTI设置为INFP"; store.setPreferences("normal", user, saveArgs(user, userType: "infp"))
        @Expect(StudyStore(dir).loadProfile().luminMbtiType, "ENFJ")
        let lumin = "把Lumin的人格改成INTJ"; store.setPreferences("normal", lumin, saveArgs(lumin, luminType: "INTJ"))
        @Expect(StudyStore(dir).loadProfile().mbtiType, "INFP")
        @Expect(StudyStore(dir).loadProfile().luminMbtiType, "INTJ")
        for (text in ["MBTI是什么", "确认", "保存结果", "不要把我的MBTI设置为INFP", "文件写着把我的MBTI设置为INFP", "例如把我的MBTI设置为INFP", "“把我的MBTI设置为INFP”", "把我的MBTI设为INFP或ENFJ", "把我的MBTI设为ENFJ", "把Lumin的MBTI设为INFP"]) {
            @Expect(rejected({ => store.setPreferences("normal", text, saveArgs(text, userType: "INFP")); () }), true)
        }
        @Expect(rejected({ => store.setPreferences("normal", "不要把我的MBTI设置为INFP", saveArgs("把我的MBTI设置为INFP", userType: "INFP")); () }), true)
        let empty = saveArgs(user); empty.put("userType", JsonString(""))
        @Expect(rejected({ => store.setPreferences("normal", user, empty); () }), true)
        let noConfirm = saveArgs(user, userType: "INFP"); noConfirm.put("confirmed", JsonBool(false))
        @Expect(rejected({ => store.setPreferences("normal", user, noConfirm); () }), true)
        let both = "把我的MBTI设为ENFP，并把Lumin改为ISTJ"
        store.setPreferences("normal", both, saveArgs(both, userType: "ENFP", luminType: "ISTJ"))
        @Expect(StudyStore(dir).loadProfile().mbtiType, "ENFP"); @Expect(StudyStore(dir).loadProfile().luminMbtiType, "ISTJ")
    }

    @TestCase
    func confirmationCanOnlySaveCurrentSessionsCompletedServerResult(): Unit {
        let dir = freshDir("mbti-confirm"); let store = MbtiAssessmentStore(dir)
        let state = complete(store, "B"); let sid = strOf(state, "sessionId"); let text = "确认保存结果到我的档案"
        @Expect(rejected({ => store.setPreferences("other", text, saveArgs(text)); () }), true)
        @Expect(rejected({ => store.setPreferences(sid, text, saveArgs(text, userType: "ENTJ")); () }), true)
        @Expect(rejected({ => store.setPreferences(sid, "不要保存结果", saveArgs("保存结果")); () }), true)
        @Expect(StudyStore(dir).loadProfile().mbtiType, "")
        store.setPreferences(sid, text, saveArgs(text))
        @Expect(StudyStore(dir).loadProfile().mbtiType, "INFP")
        @Expect(strOf(store.state(sessionId: sid), "status"), "saved")
        @Expect(strOf(store.state(sessionId: sid), "savedAt").size > 0, true)
        let next = store.start(restart: true)
        @Expect(strOf(next, "sessionId") != sid, true); @Expect(q(next), "q1")
        @Expect(rejected({ => store.setPreferences(strOf(next, "sessionId"), text, saveArgs(text)); () }), true)
        @Expect(typeOf(store.state(sessionId: sid)), "INFP")
    }

    @TestCase
    func toolsExposeReadStateAnswerAndContextWithoutExtraRegistration(): Unit {
        let dir = freshDir("mbti-tools"); let sid = strOf(MbtiAssessmentStore(dir).start(), "sessionId")
        var reads: Int64 = 0; var writes: Int64 = 0
        for (tool in mbtiTools(Store(dir), sid, "t1", "A")) {
            if (tool.risk == "read") { reads += 1 } else { writes += 1 }
            if (tool.name == "start_mbti_assessment") {
                let started = obj(tool.run(JsonObject()).details)
                @Expect(strOf(started, "sessionId"), sid)
                @Expect(strOf(started, "sessionLink"), "lumin://thread/" + sid)
            }
            if (tool.name == "get_mbti_assessment") { @Expect(q(obj(tool.run(JsonObject()).details)), "q1") }
            if (tool.name == "answer_mbti_assessment") {
                let body = JsonObject(); body.put("questionId", JsonString("q1")); body.put("choice", JsonString("A")); body.put("quote", JsonString("A"))
                @Expect(intOf(obj(tool.run(body).details), "answered"), 1)
            }
        }
        @Expect(reads, 2); @Expect(writes, 3)
        @Expect(mbtiAssessmentContext(dir, "normal"), "")
        @Expect(mbtiAssessmentContext(dir, sid).contains("q2"), true)
        @Expect(mbtiAssessmentContext(dir, sid).contains("不能代答"), true)
    }
}
