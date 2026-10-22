package zhixun_learning

import std.collection.*
import std.core.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*

func orgOnboardingTestRepeat(value: String, count: Int64): String {
    let out = StringBuilder()
    var index: Int64 = 0
    while (index < count) {
        out.append(value)
        index += 1
    }
    out.toString()
}

func orgOnboardingTestOption(value: String, label: String): String {
    let out = JsonWriter()
    out.putStr("value", value)
    out.putStr("label", label)
    out.toJson()
}

func orgOnboardingTestQuestion(id: String, kind: String, title: String,
                               options: Array<String>): String {
    let optionItems = JsonArrWriter()
    for (option in options) { optionItems.addRaw(option) }
    let out = JsonWriter()
    out.putStr("id", id)
    out.putStr("title", title)
    out.putStr("subtitle", "请选择最符合你的情况")
    out.putStr("type", kind)
    out.putBool("required", true)
    out.putRaw("options", optionItems.toJson())
    out.toJson()
}

func orgOnboardingTestQuestions(count: Int64, optionCount: Int64): String {
    let items = JsonArrWriter()
    var index: Int64 = 0
    while (index < count) {
        let options = ArrayList<String>()
        var optionIndex: Int64 = 0
        while (optionIndex < optionCount) {
            options.add(orgOnboardingTestOption(
                "value-" + index.toString() + "-" + optionIndex.toString(),
                "选项" + optionIndex.toString()))
            optionIndex += 1
        }
        let kind = if (index == 0) { "multi" } else { "single" }
        items.addRaw(orgOnboardingTestQuestion("question-" + index.toString(), kind,
            "问题" + index.toString(), options.toArray()))
        index += 1
    }
    items.toJson()
}

func orgOnboardingTestModelResult(questionCount: Int64): String {
    let items = JsonArrWriter()
    var index: Int64 = 0
    while (index < questionCount) {
        let id = if (index == 2) { "subjects" } else { "question-" + index.toString() }
        let kind = if (index == 2) { "multi" } else { "single" }
        let options = [
            orgOnboardingTestOption("hallucinated-a", "虚构课程A"),
            orgOnboardingTestOption("hallucinated-b", "虚构课程B")
        ]
        items.addRaw(orgOnboardingTestQuestion(id, kind, "问题" + index.toString(), options))
        index += 1
    }
    let root = JsonWriter()
    root.putRaw("questions", items.toJson())
    root.toJson()
}

@Test
class OrgOnboardingTests {
    @TestCase
    func websiteValidationAcceptsOnlyHttpAndHttps(): Unit {
        kbPrimitiveCheck(orgWebsiteValid(""), "An empty website must be allowed")
        kbPrimitiveCheck(orgWebsiteValid("https://example.com/about?from=admin"),
            "HTTPS URLs with paths and queries must be allowed")
        kbPrimitiveCheck(orgWebsiteValid("http://例子.测试"),
            "HTTP URLs with an internationalized host must be allowed")
        kbPrimitiveCheck(!orgWebsiteValid("ftp://example.com"), "FTP must be rejected")
        kbPrimitiveCheck(!orgWebsiteValid("javascript:alert(1)"), "Script URLs must be rejected")
        kbPrimitiveCheck(!orgWebsiteValid("https://"), "A URL without a host must be rejected")
        kbPrimitiveCheck(!orgWebsiteValid("https://user:pass@example.com"),
            "URL userinfo must be rejected")
        kbPrimitiveCheck(!orgWebsiteValid(" https://example.com/\nnext"),
            "Control characters must be rejected")
        let oversized = "https://example.com/" + orgOnboardingTestRepeat("a", 500)
        kbPrimitiveCheck(!orgWebsiteValid(oversized), "Website URLs must be limited to 512 characters")
    }

    @TestCase
    func questionSchemaNormalizesEscapesAndLimits(): Unit {
        let raw = "[" + orgOnboardingTestQuestion("goal", "single", "你的\"学习目标\"",
            [orgOnboardingTestOption("skill", "提升技能")]) + "]"
        let normalized = orgAdminOnboardingQuestionsJson(raw)
        let questions = orgOnboardingQuestionsFromJson(normalized, 1, 12)
        kbPrimitiveCheck(questions.size == 1 && questions[0].id == "goal",
            "A valid question must round-trip")
        kbPrimitiveCheck(normalized.contains("你的\\\"学习目标\\\""),
            "User-provided text must be JSON-escaped")
        kbPrimitiveRejects({ => let _value = orgAdminOnboardingQuestionsJson(
            "[" + orgOnboardingTestQuestion("bad id", "single", "标题",
                [orgOnboardingTestOption("one", "选项")]) + "]") })
        kbPrimitiveRejects({ => let _value = orgAdminOnboardingQuestionsJson(
            "[" + orgOnboardingTestQuestion("goal", "checkbox", "标题",
                [orgOnboardingTestOption("one", "选项")]) + "]") })
        kbPrimitiveRejects({ => let _value = orgAdminOnboardingQuestionsJson(
            "[" + orgOnboardingTestQuestion("goal", "single", "",
                [orgOnboardingTestOption("one", "选项")]) + "]") })
        kbPrimitiveRejects({ => let _value = orgAdminOnboardingQuestionsJson(
            orgOnboardingTestQuestions(13, 1)) })
        kbPrimitiveRejects({ => let _value = orgAdminOnboardingQuestionsJson(
            orgOnboardingTestQuestions(1, 13)) })
    }

    @TestCase
    func questionAndOptionIdsMustBeUnique(): Unit {
        let duplicateQuestions = "[" +
            orgOnboardingTestQuestion("same", "single", "第一题",
                [orgOnboardingTestOption("one", "选项一")]) + "," +
            orgOnboardingTestQuestion("same", "multi", "第二题",
                [orgOnboardingTestOption("two", "选项二")]) + "]"
        kbPrimitiveRejects({ => let _value = orgAdminOnboardingQuestionsJson(duplicateQuestions) })
        let duplicateOptions = "[" +
            orgOnboardingTestQuestion("goal", "single", "目标",
                [orgOnboardingTestOption("same", "选项一"),
                 orgOnboardingTestOption("same", "选项二")]) + "]"
        kbPrimitiveRejects({ => let _value = orgAdminOnboardingQuestionsJson(duplicateOptions) })
    }

    @TestCase
    func updateSqlEscapesWebsiteAndQuestionJson(): Unit {
        let questions = "[{\"id\":\"goal\",\"title\":\"O'Reilly\"}]"
        let sql = orgOnboardingUpdateSql("org'1", "A'B", "简称", "INVITE_1",
            "https://example.com/a?q='x'", questions)
        kbPrimitiveCheck(sql.contains("website_url='https://example.com/a?q=\\'x\\''"),
            "Website values must be SQL-escaped")
        kbPrimitiveCheck(sql.contains("onboarding_questions_json='[{\\\"id\\\":\\\"goal\\\""),
            "Question JSON must be SQL-escaped as one value")
        kbPrimitiveCheck(sql.contains("WHERE id='org\\'1'"),
            "Organization IDs must remain scoped and escaped")
    }

    @TestCase
    func promptIncludesPublishedCourseNamesAndDescriptions(): Unit {
        let courses = [
            OrgOnboardingCourse("ds", "数据结构", "学习栈、队列、树与算法复杂度"),
            OrgOnboardingCourse("ml", "机器学习", "从回归到模型评估")
        ]
        let prompt = orgOnboardingPrompt(courses)
        kbPrimitiveCheck(prompt.contains("数据结构") && prompt.contains("学习栈、队列、树与算法复杂度"),
            "The prompt must contain published course names and descriptions")
        kbPrimitiveCheck(prompt.contains("id必须严格为subjects") && prompt.contains("type必须为multi"),
            "The prompt must require a multi-select subjects question")
        kbPrimitiveCheck(prompt.contains("\"id\":\"ds\""),
            "The prompt must expose stable course IDs for option values")
    }

    @TestCase
    func generatedResponseUsesRealCoursesAndKeepsContract(): Unit {
        let courses = [
            OrgOnboardingCourse("ds", "数据结构", "栈和队列"),
            OrgOnboardingCourse("ml", "机器学习", "模型评估")
        ]
        let questions = orgGeneratedQuestionsFromModel(
            orgOnboardingTestModelResult(5), courses)
        let body = orgOnboardingGeneratedBody(questions)
        let root = match (jsonParse(body)) {
            case Some(value) => value
            case None => throw Exception("Generated response must be valid JSON")
        }
        kbPrimitiveCheck(isJsObject(root), "Generated response must be an object")
        let object = root.asObject()
        let returned = jsonGetArray(object, "questions") ?? throw Exception("questions is required")
        kbPrimitiveCheck(returned.size() == 5, "Generation must return five to seven questions")
        var subjects: ?JsonObject = None
        var index: Int64 = 0
        while (index < returned.size()) {
            let item = returned[index].asObject()
            if ((jsonGetString(item, "id") ?? "") == "subjects") {
                subjects = Some(item)
            }
            index += 1
        }
        let subjectQuestion = subjects ?? throw Exception("subjects question is required")
        kbPrimitiveCheck((jsonGetString(subjectQuestion, "type") ?? "") == "multi",
            "subjects must remain multi-select")
        let options = jsonGetArray(subjectQuestion, "options") ?? throw Exception("options are required")
        kbPrimitiveCheck(options.size() == 2, "subjects options must come from the published catalog")
        kbPrimitiveCheck((jsonGetString(options[0].asObject(), "value") ?? "") == "ds" &&
            (jsonGetString(options[1].asObject(), "value") ?? "") == "ml",
            "Hallucinated subjects options must be replaced with real published course IDs")
    }

    @TestCase
    func adminBrandResponseIncludesWebsiteAndParsedQuestions(): Unit {
        let rawQuestions = "[" + orgOnboardingTestQuestion("goal", "single", "学习目标",
            [orgOnboardingTestOption("skill", "提升技能")]) + "]"
        let columns = [
            "id", "name", "short_name", "invite_code", "logo_mime", "updated_at",
            "website_url", "onboarding_questions_json"
        ]
        let cells = [
            MyCell.of("org-1".toArray()),
            MyCell.of("测试机构".toArray()),
            MyCell.of("测试".toArray()),
            MyCell.of("INVITE_1".toArray()),
            MyCell.of("".toArray()),
            MyCell.of("2026-10-22 10:00:00".toArray()),
            MyCell.of("https://example.com".toArray()),
            MyCell.of(rawQuestions.toArray())
        ]
        let row = Row(columns, cells)
        let cfg = Config("", UInt16(0), "", "", "", "", "", "",
            UInt16(0), "", "", "", "", "")
        let response = orgBrandRowJson(cfg, row, true)
        let root = jsonParse(response) ?? throw Exception("Brand response must be valid JSON")
        if (!isJsObject(root)) { throw Exception("Brand response must be an object") }
        let object = root.asObject()
        kbPrimitiveCheck((jsonGetString(object, "websiteUrl") ?? "") == "https://example.com",
            "Admin brand responses must expose websiteUrl")
        let questions = jsonGetArray(object, "onboardingQuestions") ??
            throw Exception("Admin brand responses must expose onboardingQuestions")
        kbPrimitiveCheck(questions.size() == 1, "Stored onboarding JSON must be returned as an array")
    }
}
