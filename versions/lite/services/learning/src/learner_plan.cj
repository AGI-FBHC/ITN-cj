package zhixun_learning

import std.collection.*
import std.core.*
import stdx.encoding.json.*

let LEARNER_PLAN_JSON_BYTES: Int64 = 40000
let LEARNER_PLAN_CATALOG_BYTES: Int64 = 12000
let LEARNER_PLAN_PROMPT_BYTES: Int64 = 20000

func learnerPlanTrim(text: String, maxBytes: Int64): String {
    let value = text.trimAscii()
    if (value.size <= maxBytes) { value } else { kbTruncate(value, maxBytes) }
}

func learnerPlanText(obj: JsonObject, key: String, maxBytes: Int64): String {
    match (jsonGetString(obj, key)) {
        case Some(value) => learnerMemoryLimitOneLine(value, maxBytes)
        case None => ""
    }
}

func learnerPlanBlockText(obj: JsonObject, key: String, maxBytes: Int64): String {
    match (jsonGetString(obj, key)) {
        case Some(value) => learnerMemoryLimit(value, maxBytes)
        case None => ""
    }
}

func learnerPlanNumber(obj: JsonObject, key: String, fallback: Int64, low: Int64, high: Int64): Int64 {
    var value = match (jsonGetInt(obj, key)) {
        case Some(parsed) => parsed
        case None => fallback
    }
    if (value < low) { value = low }
    if (value > high) { value = high }
    value
}

/** 数组字段统一收敛成纯字符串数组：对象只取 title/label/name。 */
func learnerPlanStrings(items: ?JsonArray, itemBytes: Int64, maxItems: Int64): ArrayList<String> {
    let result = ArrayList<String>()
    match (items) {
        case Some(array) =>
            var index: Int64 = 0
            while (index < array.size() && result.size < maxItems) {
                let item = array[index]
                var value = ""
                if (isJsString(item)) {
                    value = item.asString().getValue()
                } else if (isJsObject(item)) {
                    let obj = item.asObject()
                    value = jsonGetString(obj, "title") ?? jsonGetString(obj, "label") ?? jsonGetString(obj, "name") ?? ""
                }
                let text = learnerMemoryLimitOneLine(value, itemBytes)
                if (text.size > 0) { result.add(text) }
                index += 1
            }
        case None => ()
    }
    result
}

func learnerPlanStringsJson(items: ?JsonArray, itemBytes: Int64, maxItems: Int64): String {
    learnerStringArrayJson(learnerPlanStrings(items, itemBytes, maxItems))
}

func learnerPlanGoalsJson(items: ?JsonArray): String {
    let out = JsonArrWriter()
    match (items) {
        case Some(array) =>
            var index: Int64 = 0
            while (index < array.size() && index < 6) {
                let item = array[index]
                var title = ""
                var metric = ""
                if (isJsObject(item)) {
                    title = learnerPlanText(item.asObject(), "title", 180)
                    metric = learnerPlanText(item.asObject(), "metric", 220)
                } else if (isJsString(item)) {
                    title = learnerMemoryLimitOneLine(item.asString().getValue(), 180)
                }
                if (title.size > 0) {
                    let row = JsonWriter()
                    row.putStr("title", title)
                    row.putStr("metric", metric)
                    out.addRaw(row.toJson())
                }
                index += 1
            }
        case None => ()
    }
    out.toJson()
}

func learnerPlanStagesJson(items: ?JsonArray): String {
    let out = JsonArrWriter()
    match (items) {
        case Some(array) =>
            var index: Int64 = 0
            while (index < array.size() && index < 6) {
                let item = array[index]
                if (isJsObject(item)) {
                    let obj = item.asObject()
                    let title = learnerPlanText(obj, "title", 180)
                    if (title.size > 0) {
                        let row = JsonWriter()
                        row.putInt("order", learnerPlanNumber(obj, "order", index + 1, 1, 12))
                        row.putStr("title", title)
                        row.putInt("weeks", learnerPlanNumber(obj, "weeks", 2, 1, 26))
                        row.putStr("focus", learnerPlanBlockText(obj, "focus", 700))
                        row.putRaw("courses", learnerPlanStringsJson(jsonGetArray(obj, "courses"), 200, 8))
                        row.putRaw("deliverables", learnerPlanStringsJson(jsonGetArray(obj, "deliverables"), 240, 6))
                        out.addRaw(row.toJson())
                    }
                }
                index += 1
            }
        case None => ()
    }
    out.toJson()
}

func learnerPlanWeeksJson(items: ?JsonArray): String {
    let out = JsonArrWriter()
    match (items) {
        case Some(array) =>
            var index: Int64 = 0
            while (index < array.size() && index < 12) {
                let item = array[index]
                if (isJsObject(item)) {
                    let obj = item.asObject()
                    let theme = learnerPlanText(obj, "theme", 200)
                    if (theme.size > 0) {
                        let row = JsonWriter()
                        row.putInt("week", learnerPlanNumber(obj, "week", index + 1, 1, 52))
                        row.putStr("theme", theme)
                        row.putInt("hours", learnerPlanNumber(obj, "hours", 4, 1, 40))
                        row.putRaw("tasks", learnerPlanStringsJson(jsonGetArray(obj, "tasks"), 240, 6))
                        out.addRaw(row.toJson())
                    }
                }
                index += 1
            }
        case None => ()
    }
    out.toJson()
}

func learnerPlanMilestonesJson(items: ?JsonArray): String {
    let out = JsonArrWriter()
    match (items) {
        case Some(array) =>
            var index: Int64 = 0
            while (index < array.size() && index < 6) {
                let item = array[index]
                if (isJsObject(item)) {
                    let obj = item.asObject()
                    let title = learnerPlanText(obj, "title", 180)
                    if (title.size > 0) {
                        let row = JsonWriter()
                        row.putInt("week", learnerPlanNumber(obj, "week", index + 1, 1, 52))
                        row.putStr("title", title)
                        row.putStr("check", learnerPlanText(obj, "check", 300))
                        out.addRaw(row.toJson())
                    }
                }
                index += 1
            }
        case None => ()
    }
    out.toJson()
}

/** 知识基础：模型返回 [{topic, level}]，落库时重建为对象，避免直接透传未知结构。 */
func learnerPlanKnowledgeJson(source: ?JsonObject): String {
    let out = JsonWriter()
    var count: Int64 = 0
    match (source) {
        case Some(obj) =>
            match (jsonGetArray(obj, "topics")) {
                case Some(items) =>
                    var index: Int64 = 0
                    while (index < items.size() && count < 10) {
                        let item = items[index]
                        if (isJsObject(item)) {
                            let topic = learnerPlanText(item.asObject(), "topic", 120)
                            let level = learnerPlanText(item.asObject(), "level", 160)
                            if (topic.size > 0 && level.size > 0) {
                                out.putStr(topic, level)
                                count += 1
                            }
                        }
                        index += 1
                    }
                case None => ()
            }
        case None => ()
    }
    out.toJson()
}

func learnerPlanPreferencesJson(source: ?JsonObject): String {
    let out = JsonWriter()
    match (source) {
        case Some(obj) =>
            out.putStr("pace", learnerPlanText(obj, "pace", 200))
            out.putStr("style", learnerPlanText(obj, "style", 200))
            out.putStr("sessionMinutes", learnerPlanText(obj, "sessionMinutes", 40))
            out.putStr("feedback", learnerPlanText(obj, "feedback", 200))
        case None => ()
    }
    out.toJson()
}

class LearnerPlanProfile {
    let summary: String
    let goalsJson: String
    let knowledgeJson: String
    let preferencesJson: String
    let strengthsJson: String
    let weaknessesJson: String
    let activeTopicsJson: String

    init(summary: String, goalsJson: String, knowledgeJson: String, preferencesJson: String,
         strengthsJson: String, weaknessesJson: String, activeTopicsJson: String) {
        this.summary = summary
        this.goalsJson = goalsJson
        this.knowledgeJson = knowledgeJson
        this.preferencesJson = preferencesJson
        this.strengthsJson = strengthsJson
        this.weaknessesJson = weaknessesJson
        this.activeTopicsJson = activeTopicsJson
    }
}

func learnerPlanProfileOf(raw: JsonObject): LearnerPlanProfile {
    let profile = jsonGetObject(raw, "profile") ?? JsonObject()
    LearnerPlanProfile(
        learnerPlanBlockText(profile, "profileSummary", 1200),
        learnerPlanStringsJson(jsonGetArray(profile, "learningGoals"), 240, 8),
        learnerPlanKnowledgeJson(profile),
        learnerPlanPreferencesJson(jsonGetObject(profile, "preferences")),
        learnerPlanStringsJson(jsonGetArray(profile, "strengths"), 240, 8),
        learnerPlanStringsJson(jsonGetArray(profile, "weaknesses"), 240, 8),
        learnerPlanStringsJson(jsonGetArray(profile, "activeTopics"), 160, 10))
}

/** 真实可选范围：已发布且存在可见课时的课程与章节。 */
func learnerPlanCatalog(cfg: Config): String {
    let rows = query(cfg,
        "SELECT name,level,duration,chapters_json FROM courses " +
        "WHERE status='published' AND EXISTS(SELECT 1 FROM lessons l WHERE l.course_id=courses.id AND l.is_visible=1) " +
        "ORDER BY sort_order,name")
    let lines = ArrayList<String>()
    for (row in rows) {
        let chapters = ArrayList<String>()
        match (jsonParse(row.text("chapters_json"))) {
            case Some(value) =>
                if (isJsArray(value)) {
                    let array = value.asArray()
                    var index: Int64 = 0
                    while (index < array.size()) {
                        let item = array[index]
                        if (isJsObject(item)) {
                            let title = (jsonGetString(item.asObject(), "title") ?? "").trimAscii()
                            if (title.size > 0) { chapters.add(learnerMemoryLimitOneLine(title, 120)) }
                        }
                        index += 1
                    }
                }
            case None => ()
        }
        let level = row.text("level").trimAscii()
        lines.add("- 《" + row.text("name") + "》（难度 " + (if (level.size > 0) { level } else { "未标注" }) +
            "，约 " + row.int("duration").toString() + " 小时）：" +
            (if (chapters.size == 0) { "暂无章节" } else { learnerMemoryJoin(chapters, "、") }))
    }
    if (lines.size == 0) { return "（当前机构没有已上架课程，只能给出通用学习方法建议，禁止编造课程名）" }
    learnerPlanTrim(learnerMemoryJoin(lines, "\n"), LEARNER_PLAN_CATALOG_BYTES)
}

func learnerPlanSystemPrompt(): String {
    "你是“智训云枢”的学习规划智能体 Lumin，负责把新学员的注册问卷答案转成真实可执行的学习画像与学习计划。\n" +
    "硬性要求：\n" +
    "1. 只能引用“可选课程目录”中真实存在的课程名与章节名，禁止编造课程、章节、教材、链接或学时数据。\n" +
    "2. 画像只能依据问卷答案、用户自定义长期记忆和课程目录推断，不得臆造年龄、性别、单位、成绩等未提供的信息。\n" +
    "3. 计划必须可执行：2-4 个阶段，4-8 周，每周任务具体到章节或练习动作，并给出可检查的里程碑。\n" +
    "4. 所有文本使用简体中文，简洁具体，不要空话、不要营销语。"
}

func learnerPlanUserPrompt(profileText: String, catalog: String, memorySnapshot: String): String {
    "【注册问卷与用户资料】\n" + profileText + "\n\n" +
        "【可选课程目录】\n" + catalog + "\n\n" +
        "【已有学习记忆】\n" + memorySnapshot + "\n\n" +
        "请输出如下结构的 JSON：{\"summary\":\"一句话计划概述\",\"horizonWeeks\":6,\"weeklyHours\":5," +
        "\"focusAreas\":[\"重点方向\"],\"goals\":[{\"title\":\"目标\",\"metric\":\"可验证标准\"}]," +
        "\"stages\":[{\"order\":1,\"title\":\"阶段名\",\"weeks\":2,\"focus\":\"阶段重点\"," +
        "\"courses\":[\"课程名 · 章节名\"],\"deliverables\":[\"阶段产出\"]}]," +
        "\"weeklyPlan\":[{\"week\":1,\"theme\":\"本周主题\",\"hours\":5,\"tasks\":[\"具体任务\"]}]," +
        "\"milestones\":[{\"week\":2,\"title\":\"里程碑\",\"check\":\"检查方式\"}]," +
        "\"risks\":[\"风险与应对\"]," +
        "\"profile\":{\"profileSummary\":\"画像摘要（2-3 句，包含身份、目标、基础、偏好）\"," +
        "\"learningGoals\":[\"学习目标\"],\"knowledgeLevel\":{\"topics\":[{\"topic\":\"知识主题\",\"level\":\"入门/熟悉/熟练\"}]}," +
        "\"preferences\":{\"pace\":\"学习节奏\",\"style\":\"学习方式\",\"sessionMinutes\":\"单次学习时长\",\"feedback\":\"反馈偏好\"}," +
        "\"strengths\":[\"优势\"],\"weaknesses\":[\"待加强\"],\"activeTopics\":[\"当前应关注的主题\"]}}"
}

func learnerPlanNormalize(raw: JsonObject, model: String): String {
    let out = JsonWriter()
    out.putStr("summary", learnerPlanBlockText(raw, "summary", 1200))
    out.putInt("horizonWeeks", learnerPlanNumber(raw, "horizonWeeks", 6, 1, 52))
    out.putInt("weeklyHours", learnerPlanNumber(raw, "weeklyHours", 5, 1, 60))
    out.putRaw("focusAreas", learnerPlanStringsJson(jsonGetArray(raw, "focusAreas"), 160, 8))
    out.putRaw("goals", learnerPlanGoalsJson(jsonGetArray(raw, "goals")))
    out.putRaw("stages", learnerPlanStagesJson(jsonGetArray(raw, "stages")))
    out.putRaw("weeklyPlan", learnerPlanWeeksJson(jsonGetArray(raw, "weeklyPlan")))
    out.putRaw("milestones", learnerPlanMilestonesJson(jsonGetArray(raw, "milestones")))
    out.putRaw("risks", learnerPlanStringsJson(jsonGetArray(raw, "risks"), 240, 5))
    out.putStr("model", learnerMemoryLimitOneLine(model, 160))
    out.toJson()
}

/** 生成并落库：画像字段与学习计划同时写入 user_learning_memory。 */
func learnerPlanGenerate(cfg: Config, authenticatedUserId: String): String {
    let settings = loadKbSettings(cfg)
    let endpoint = slotEndpoint(cfg, settings.chat)
    if (!endpoint.hasChat()) { throw Exception("还没有配置对话模型，请先在管理端完成模型配置") }
    let memory = learnerMemoryLoadOrCreate(cfg, authenticatedUserId)
    // 直接使用数据库中的原始 JSON 文本，避免经过 JsonValue 再序列化。
    let rawProfile = profileBody(cfg, memory.userId).trimAscii()
    let profileText = learnerPlanTrim(
        if (rawProfile.size == 0 || rawProfile == "null") { "{}" } else { rawProfile },
        LEARNER_PLAN_PROMPT_BYTES / 4)
    let user = learnerPlanUserPrompt(profileText, learnerPlanCatalog(cfg), learnerMemoryPromptSnapshot(memory))
    let raw = kbChatJson(endpoint, learnerPlanSystemPrompt(), learnerPlanTrim(user, LEARNER_PLAN_PROMPT_BYTES))
    let planJson = learnerPlanNormalize(raw, settings.chat.model)
    if (planJson.size > LEARNER_PLAN_JSON_BYTES) { throw Exception("学习计划内容超出长度限制") }
    let profile = learnerPlanProfileOf(raw)
    learnerMemorySavePlan(cfg, memory.userId, planJson, settings.chat.model, profile)
    planJson
}

func learnerPlanCurrentBody(memory: LearnerMemory): String {
    let out = JsonWriter()
    out.putRaw("plan", if (memory.learningPlanJson.size == 0) { "null" } else { memory.learningPlanJson })
    out.putStr("generatedAt", memory.planGeneratedAt)
    out.putStr("model", memory.planModel)
    out.toJson()
}
