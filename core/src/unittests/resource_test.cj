package itn_desktop_core.unittests

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.resource.*
import itn_desktop_core.util.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 四种资源（讲义 / 实操 / 分阶测试 / 演示稿）：契约、质检、渲染。
 *
 * 这一组是纯函数测试，不联网、不落盘：
 *   - 质检必须"好的放行、坏的报出来"，否则返修循环要么白跑、要么把好内容判死；
 *   - 渲染必须稳定（结构进、Markdown 出），否则产物与人看到的对不上；
 *   - 从模型输出里抠 JSON 要能扛住围栏、前后废话、字符串里的括号。
 */

func joinIssues(issues: ArrayList<String>): String {
    var s = ""
    for (x in issues) {
        s = s + x + "|"
    }
    return s
}

func parseObj(text: String): JsonObject {
    match (jsonObjectFromModel(text)) {
        case Some(o) => return o
        case None => return JsonObject()
    }
}

func oneSource(): JsonArray {
    let arr = JsonArray()
    let o = JsonObject()
    o.put("docTitle", JsonString("讲义来源"))
    o.put("docPath", JsonString("a.md"))
    o.put("headingPath", JsonString("第一章"))
    arr.add(o)
    return arr
}

func longBody(): String {
    return "以「输入与输出」为例：先写清输入是什么、期望输出是什么，再按步骤执行，最后逐条验证结果。[1]\n\n" +
        "输入是一组能重现的最小样例，输出是能直接对照的结论；做法分三步，每步都留下中间结果，出问题时能定位到具体一步。\n\n" +
        "常见错误是把过程当黑盒，一旦结果不对只能整体重来；边界样例要单独跑一遍，确认限制与失败表现。[1]\n\n" +
        "验证方法：换一个人按这份说明从空目录再做一遍，不用口头提示也能得到同样结果。"
}

func bigLectureJson(): String {
    let body = longBody()
    let sb = StringBuilder()
    sb.append("{\"title\":\"动手做一遍\",\"objective\":\"读完能独立完成一次任务。\",\"chapters\":[")
    sb.append("{\"title\":\"第一部分 认识\",\"sections\":[")
    sb.append("{\"title\":\"基本概念\",\"content\":\"" + body + "\"},")
    sb.append("{\"title\":\"输入与输出\",\"content\":\"" + body + "\"},")
    sb.append("{\"title\":\"按步骤执行\",\"content\":\"" + body + "\"}]},")
    sb.append("{\"title\":\"第二部分 验证\",\"sections\":[")
    sb.append("{\"title\":\"中间状态\",\"content\":\"" + body + "\"},")
    sb.append("{\"title\":\"边界样例\",\"content\":\"" + body + "\"},")
    sb.append("{\"title\":\"验证复盘\",\"content\":\"" + body + "\"}]}]}")
    return sb.toString()
}

func practiceJson(): String {
    let step = "{\"title\":\"准备输入\",\"instruction\":\"新建练习目录并在 README.md 里写下输入、步骤、预期输出和验收标准，然后复制一份原始输入作为备份并确认副本存在。\",\"code\":\"\",\"expectedOutput\":\"README.md 能看清输入与完成标准。\",\"safety\":\"safe\",\"warning\":\"\"}"
    return "{\"title\":\"实操\",\"objective\":\"走通一次流程\",\"steps\":[" + step + "," + step + "," + step + "]," +
        "\"acceptanceCriteria\":[\"记录完整\",\"边界有结论\"],\"troubleshooting\":[{\"problem\":\"不一致\",\"solution\":\"逐项比对\"}]}"
}

func quizJson(): String {
    return "{\"title\":\"测试\",\"knowledgePoints\":[{\"id\":\"kp-1\",\"name\":\"甲\"}]," +
        "\"questions\":[{\"id\":\"q-1\",\"knowledgePointId\":\"kp-1\",\"difficulty\":\"easy\",\"stem\":\"在这种场景下哪种做法最稳妥？\"," +
        "\"options\":[\"甲做法\",\"乙做法\",\"丙做法\",\"丁做法\"],\"correctIndex\":1,\"explanation\":\"因为甲做法同时保留了输入、过程与验收依据，所以别人能复现，出错也能定位。\"}]}"
}

func pptJson(): String {
    return "{\"title\":\"演示\",\"slides\":[" +
        "{\"title\":\"第一页\",\"bullets\":[\"要点一\",\"要点二\"],\"speakerNote\":\"这一页讲清背景与目标。\"}," +
        "{\"title\":\"第二页\",\"bullets\":[\"要点三\"],\"speakerNote\":\"这一页给一个最小例子。\"}," +
        "{\"title\":\"第三页\",\"bullets\":[\"要点四\"],\"speakerNote\":\"这一页收尾并布置练习。\"}]}"
}

@Test
class ResourceTest {

    @TestCase
    func kindsCoverFourResources(): Unit {
        let kinds = resourceKinds()
        @Expect(kinds.size, 4)
        var ids = ""
        for (k in kinds) {
            ids = ids + k.id + "|"
        }
        @Expect(ids.contains("lecture"), true)
        @Expect(ids.contains("practice"), true)
        @Expect(ids.contains("quiz"), true)
        @Expect(ids.contains("ppt"), true)
        @Expect(isResourceKind("lecture"), true)
        @Expect(isResourceKind("nope"), false)
        // 题量向上取到 3 的倍数（三档难度各来一道），并夹在 3~20 之间
        @Expect(normalizeCount("quiz", 4), 4)
        @Expect(normalizeCount("quiz", 0), 6)
        @Expect(normalizeCount("quiz", 100), 20)
        @Expect(normalizeCount("ppt", 0), 8)
    }

    @TestCase
    func jsonExtractionSurvivesNoise(): Unit {
        let fenced = "这里是说明：\n```json\n{\"title\":\"甲\",\"chapters\":[{\"title\":\"乙\"}]}\n```\n结束。"
        let o = parseObj(fenced)
        @Expect(strOf(o, "title"), "甲")
        // 字符串里带花括号也不能把配对准搞错
        let tricky = parseObj("{\"a\":\"}\",\"b\":{\"c\":1}}")
        @Expect(strOf(tricky, "a"), "}")
        @Expect(jsonArrayFromModel("没有 JSON 的纯文本").isNone(), true)
    }

    @TestCase
    func lectureQualityCatchesThinDrafts(): Unit {
        let thin = parseObj("{\"chapters\":[{\"title\":\"只有一章\",\"sections\":[{\"title\":\"一节\",\"content\":\"太短了。\"}]}]}")
        let joined = joinIssues(lectureIssues(thin, "balanced"))
        @Expect(joined.contains("章节不足"), true)
        @Expect(joined.contains("正文过短"), true)
        // 够厚的一份必须放行（否则返修会一直被触发，白烧模型）
        @Expect(lectureIssues(parseObj(bigLectureJson()), "balanced").size, 0)
    }

    @TestCase
    func practiceQualityRequiresActionableSteps(): Unit {
        let bad = parseObj("{\"steps\":[{\"title\":\"一步\",\"instruction\":\"随便写写\",\"expectedOutput\":\"\"}],\"acceptanceCriteria\":[],\"troubleshooting\":[]}")
        let joined = joinIssues(practiceIssues(bad))
        @Expect(joined.contains("步骤不足"), true)
        @Expect(joined.contains("验收标准"), true)
        @Expect(joined.contains("故障排查"), true)
        @Expect(joined.contains("风险等级"), true)
        @Expect(practiceIssues(parseObj(practiceJson())).size, 0)
    }

    @TestCase
    func quizQualityChecksOptionsDifficultyAndAnswerSpread(): Unit {
        let bad = parseObj("{\"knowledgePoints\":[{\"id\":\"kp-1\",\"name\":\"甲\"}],\"questions\":[" +
            "{\"id\":\"q-1\",\"knowledgePointId\":\"kp-9\",\"difficulty\":\"easy\",\"stem\":\"短\",\"options\":[\"A\",\"A\",\"B\"],\"correctIndex\":7,\"explanation\":\"太短\"}," +
            "{\"id\":\"q-2\",\"knowledgePointId\":\"kp-9\",\"difficulty\":\"easy\",\"stem\":\"短\",\"options\":[\"A\",\"A\",\"B\"],\"correctIndex\":7,\"explanation\":\"太短\"}]}")
        let joined = joinIssues(quizIssues(bad, 6))
        @Expect(joined.contains("题量不正确"), true)
        @Expect(joined.contains("难度覆盖不完整"), true)
        @Expect(joined.contains("没有关联有效知识点"), true)
        @Expect(joined.contains("互不重复的选项"), true)
        @Expect(joined.contains("无效正确答案索引"), true)
        @Expect(quizIssues(parseObj(quizJson()), 1).size, 0)
    }

    @TestCase
    func pptQualityChecksPagesAndBullets(): Unit {
        let bad = parseObj("{\"slides\":[{\"title\":\"同一页\",\"bullets\":[],\"speakerNote\":\"\"},{\"title\":\"同一页\",\"bullets\":[\"一\",\"二\",\"三\",\"四\",\"五\",\"六\",\"七\"],\"speakerNote\":\"\"}]}")
        let joined = joinIssues(pptIssues(bad, 4))
        @Expect(joined.contains("页数不正确"), true)
        @Expect(joined.contains("标题重复"), true)
        @Expect(joined.contains("没有要点"), true)
        @Expect(joined.contains("要点超过 6 条"), true)
        @Expect(pptIssues(parseObj(pptJson()), 3).size, 0)
    }

    @TestCase
    func citationScanOnlyCountsLocalBrackets(): Unit {
        let marks = scanCitationNumbers("这段话有 [1] 和 [12]，但没有 [W3]，也没有 [abc]。")
        @Expect(marks.size, 2)
        @Expect(marks[0], 1)
        @Expect(marks[1], 12)
        // 越界引用要被抓出来（编造出处的直接证据）
        let joined = joinIssues(citationIssues("第一段引用不存在的资料 [9]。\n\n第二段也有 [10]。", 3))
        @Expect(joined.contains("引用了不存在"), true)
        @Expect(citationIssues("正常引用 [1] 和 [2]。\n\n另一段 [1]。", 2).size, 0)
    }

    @TestCase
    func renderersProduceReadableMarkdown(): Unit {
        let sources = oneSource()
        let lecture = renderLecture(parseObj(bigLectureJson()), sources)
        @Expect(lecture.contains("# 动手做一遍"), true)
        @Expect(lecture.contains("### 基本概念"), true)
        @Expect(lecture.contains("## 资料来源"), true)
        @Expect(lecture.contains("- [1] 《讲义来源》"), true)

        let quiz = renderQuiz(parseObj(quizJson()), sources)
        @Expect(quiz.contains("### 第 1 题（易）"), true)
        @Expect(quiz.contains("**答案：**B"), true)
        @Expect(quiz.contains("**解析：**"), true)

        // 播放器按二级标题分页：演示稿的页数必须等于 slides 数
        let ppt = renderPpt(parseObj(pptJson()), sources)
        var pages: Int64 = 0
        for (line in ppt.split("\n")) {
            let b = line.toArray()
            if (b.size > 3 && b[0] == 35 && b[1] == 35 && b[2] == 32) {
                pages = pages + 1
            }
        }
        @Expect(pages, 3)
        // 放映类产物：出处用加粗小标题，免得"资料来源"被播放器当成一页
        @Expect(ppt.contains("**资料来源**"), true)
        var pptHeadings: Int64 = 0
        for (line in ppt.split("\n")) {
            if (line.contains("## 资料来源")) {
                pptHeadings = pptHeadings + 1
            }
        }
        @Expect(pptHeadings, 0)
        @Expect(renderPractice(parseObj(practiceJson()), sources).contains("## 验收标准"), true)
    }

    @TestCase
    func fallbackPracticeIsUsableAndHonest(): Unit {
        // 兜底骨架也要能过质检（否则"模型不给东西"时给出来的东西自己就不合格）
        @Expect(practiceIssues(practiceFallback("提示词工程")).size, 0)
        let text = renderPractice(practiceFallback("提示词工程"), JsonArray())
        @Expect(text.contains("（本次没有可引用的本机资料"), true)
    }
}
