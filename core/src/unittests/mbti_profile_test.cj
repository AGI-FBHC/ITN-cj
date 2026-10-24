package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.agent.learningTools
import itn_desktop_core.learning.LearningStore
import itn_desktop_core.store.Store
import itn_desktop_core.study.StudyStore
import itn_desktop_core.util.*

@Test
func mbtiProfileDefaultsPersistsAndToolRequiresConfirmation(): Unit {
    let dir = freshDir("mbti-profile")
    let ss = StudyStore(dir)
    let initial = ss.loadProfile()
    @Expect(initial.luminMbtiType, "ENFJ")
    @Expect(initial.mbtiType, "")

    initial.nickname = "测试学习者"
    initial.goal = "理解 MBTI 交流偏好"
    initial.mbtiType = "infp"
    initial.luminMbtiType = "enfj"
    ss.saveProfile(initial)
    let saved = ss.loadProfile()
    @Expect(saved.mbtiType, "INFP")
    @Expect(saved.luminMbtiType, "ENFJ")
    @Expect(saved.nickname, "测试学习者")
    @Expect(saved.goal, "理解 MBTI 交流偏好")

    let toolStore = Store(dir)
    var rejected = false
    for (tool in learningTools(toolStore, "", { => false }, "mbti-session", "mbti-turn",
        "请把 MBTI 设置为 INFP", { kind: String, payload: JsonObject => () })) {
        if (tool.name != "set_mbti_preference") { continue }
        let args = JsonObject()
        args.put("userType", JsonString("INFP"))
        args.put("luminType", JsonString("ENFJ"))
        args.put("confirmed", JsonBool(false))
        args.put("quote", JsonString("请把 MBTI 设置为 INFP"))
        try { tool.run(args) } catch (e: Exception) { rejected = true }
    }
    @Expect(rejected, true)

    var accepted = false
    for (tool in learningTools(toolStore, "", { => false }, "mbti-session", "mbti-turn",
        "请把 MBTI 设置为 INFP，并确认保存", { kind: String, payload: JsonObject => () })) {
        if (tool.name != "set_mbti_preference") { continue }
        let args = JsonObject()
        args.put("userType", JsonString("INFP"))
        args.put("luminType", JsonString("ENFJ"))
        args.put("confirmed", JsonBool(true))
        args.put("quote", JsonString("请把 MBTI 设置为 INFP，并确认保存"))
        let result = tool.run(args)
        accepted = result.ok
    }
    @Expect(accepted, true)
    let afterTool = StudyStore(dir).loadProfile()
    @Expect(afterTool.mbtiType, "INFP")
    @Expect(afterTool.luminMbtiType, "ENFJ")
}
