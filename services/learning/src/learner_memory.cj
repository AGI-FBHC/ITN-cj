package zhixun_learning

import std.collection.*
import std.core.*
import stdx.encoding.json.*

let LEARNER_MEMORY_SUMMARY_BYTES: Int64 = 1800
let LEARNER_MEMORY_JSON_BYTES: Int64 = 6000
let LEARNER_MEMORY_PROMPT_BYTES: Int64 = 4096
let LEARNER_MEMORY_PROMPT_FIELD_BYTES: Int64 = 420

class LearnerMemory {
    let userId: String
    let memoryVersion: Int64
    let profileSummary: String
    let learningGoalsJson: String
    let knowledgeLevelJson: String
    let preferencesJson: String
    let strengthsJson: String
    let weaknessesJson: String
    let activeTopicsJson: String
    let tutorNotesJson: String
    let recentSignalsJson: String
    let createdAt: String
    let updatedAt: String

    init(userId: String, memoryVersion: Int64, profileSummary: String, learningGoalsJson: String,
         knowledgeLevelJson: String, preferencesJson: String, strengthsJson: String,
         weaknessesJson: String, activeTopicsJson: String, tutorNotesJson: String,
         recentSignalsJson: String, createdAt: String, updatedAt: String) {
        this.userId = userId
        this.memoryVersion = if (memoryVersion > 0) { memoryVersion } else { 1 }
        this.profileSummary = learnerMemoryLimitOneLine(profileSummary, LEARNER_MEMORY_SUMMARY_BYTES)
        this.learningGoalsJson = learnerMemoryArrayJson(learningGoalsJson)
        this.knowledgeLevelJson = learnerMemoryObjectJson(knowledgeLevelJson)
        this.preferencesJson = learnerMemoryObjectJson(preferencesJson)
        this.strengthsJson = learnerMemoryArrayJson(strengthsJson)
        this.weaknessesJson = learnerMemoryArrayJson(weaknessesJson)
        this.activeTopicsJson = learnerMemoryArrayJson(activeTopicsJson)
        this.tutorNotesJson = learnerMemoryObjectJson(tutorNotesJson)
        this.recentSignalsJson = learnerMemoryArrayJson(recentSignalsJson)
        this.createdAt = createdAt
        this.updatedAt = updatedAt
    }
}

/** Byte-bounded truncation that keeps UTF-8 valid and cannot exceed the limit. */
func learnerMemoryLimit(text: String, maxBytes: Int64): String {
    let value = text.trimAscii()
    if (value.size <= maxBytes) { return value }
    if (maxBytes <= 3) { return "" }
    kbTruncate(value, maxBytes - 3)
}

func learnerMemoryLimitOneLine(text: String, maxBytes: Int64): String {
    learnerMemoryLimit(text.replace("\r", " ").replace("\n", " "), maxBytes)
}

func learnerMemoryArrayJson(raw: String): String {
    let text = raw.trimAscii()
    if (text.size == 0 || text.size > LEARNER_MEMORY_JSON_BYTES) { return "[]" }
    match (jsonParse(text)) {
        case Some(value) => if (isJsArray(value)) { text } else { "[]" }
        case None => "[]"
    }
}

func learnerMemoryObjectJson(raw: String): String {
    let text = raw.trimAscii()
    if (text.size == 0 || text.size > LEARNER_MEMORY_JSON_BYTES) { return "{}" }
    match (jsonParse(text)) {
        case Some(value) => if (isJsObject(value)) { text } else { "{}" }
        case None => "{}"
    }
}

func learnerProfileText(profile: JsonObject, keys: Array<String>): String {
    for (key in keys) {
        match (jsonGetString(profile, key)) {
            case Some(value) => if (value.trimAscii().size > 0) { return value.trimAscii() }
            case None => ()
        }
    }
    ""
}

func learnerProfileTopics(profile: JsonObject): ArrayList<String> {
    let result = ArrayList<String>()
    let seen = HashSet<String>()
    let topics = jsonGetArray(profile, "subjectValues") ?? JsonArray()
    var index: Int64 = 0
    while (index < topics.size() && result.size < 16) {
        let item = topics[index]
        var value = ""
        if (isJsString(item)) {
            value = item.asString().getValue().trimAscii()
        } else if (isJsObject(item)) {
            let object = item.asObject()
            value = jsonGetString(object, "label") ?? jsonGetString(object, "value") ?? ""
            value = value.trimAscii()
        }
        if (value.size > 0 && !seen.contains(value)) {
            seen.add(value)
            result.add(learnerMemoryLimitOneLine(value, 160))
        }
        index += 1
    }
    result
}

func learnerStringArrayJson(values: ArrayList<String>): String {
    let result = JsonArrWriter()
    for (value in values) {
        result.addRaw(jsonQuote(learnerMemoryLimitOneLine(value, 320)))
    }
    result.toJson()
}

/** Build a deterministic first memory from users.profile_json; no mastery is inferred. */
func learnerMemoryDefault(userId: String, profileJson: String): LearnerMemory {
    let profile = match (jsonParse(if (profileJson.trimAscii().size == 0) { "{}" } else { profileJson })) {
        case Some(value) => if (isJsObject(value)) { value.asObject() } else { JsonObject() }
        case None => JsonObject()
    }
    let name = learnerProfileText(profile, ["name", "displayName", "nickname"])
    let level = learnerProfileText(profile, ["roleLabel", "education", "level"])
    let goal = learnerProfileText(profile, ["goalLabel", "goal", "learningGoal"])
    let topics = learnerProfileTopics(profile)

    let summaryParts = ArrayList<String>()
    if (name.size > 0) { summaryParts.add("称呼：" + learnerMemoryLimitOneLine(name, 120)) }
    if (level.size > 0) { summaryParts.add("当前阶段：" + learnerMemoryLimitOneLine(level, 160)) }
    if (goal.size > 0) { summaryParts.add("学习目标：" + learnerMemoryLimitOneLine(goal, 240)) }
    if (topics.size > 0) {
        let topicText = StringBuilder()
        var topicIndex: Int64 = 0
        for (topic in topics) {
            if (topicIndex >= 8) { break }
            if (topicIndex > 0) { topicText.append("、") }
            topicText.append(topic)
            topicIndex += 1
        }
        summaryParts.add("关注主题：" + topicText.toString())
    }
    let summary = if (summaryParts.size == 0) {
        "尚未填写学习画像；先按通用学习助手方式提供支持，待积累真实学习证据。"
    } else {
        "用户学习画像：" + learnerMemoryJoin(summaryParts, "；") + "。"
    }

    let goals = ArrayList<String>()
    if (goal.size > 0) { goals.add(goal) }

    let knowledge = JsonWriter()
    knowledge.putStr("selfReportedLevel", learnerMemoryLimitOneLine(level, 160))
    knowledge.putStr("basis", "来自用户资料，未经过测评")

    let preferences = JsonWriter()
    preferences.putStr("language", "zh-CN")
    preferences.putStr("responseStyle", "先结论后展开")
    preferences.putStr("basis", "系统默认，等待用户更新")

    let notes = JsonWriter()
    notes.putStr("source", "users.profile_json")
    notes.putStr("note", "初始记忆由用户画像生成；掌握程度和强弱项在获得真实学习证据前保持未知。")

    LearnerMemory(userId, 1, summary, learnerStringArrayJson(goals), knowledge.toJson(),
        preferences.toJson(), "[]", "[]", learnerStringArrayJson(topics), notes.toJson(), "[]", "", "")
}

func learnerMemoryJoin(values: ArrayList<String>, separator: String): String {
    let result = StringBuilder()
    var index: Int64 = 0
    for (value in values) {
        if (index > 0) { result.append(separator) }
        result.append(value)
        index += 1
    }
    result.toString()
}

func learnerMemorySelectSql(userId: String): String {
    "SELECT memory_version,profile_summary,learning_goals_json,knowledge_level_json," +
    "preferences_json,strengths_json,weaknesses_json,active_topics_json,tutor_notes_json," +
    "recent_signals_json,COALESCE(DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f'),'') created_at," +
    "COALESCE(DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s.%f'),'') updated_at " +
    "FROM user_learning_memory WHERE user_id=" + sqlQuote(userId) + " LIMIT 1"
}

func learnerMemoryFromRow(userId: String, row: Row): LearnerMemory {
    LearnerMemory(userId, row.int("memory_version"), row.text("profile_summary"),
        row.text("learning_goals_json"), row.text("knowledge_level_json"), row.text("preferences_json"),
        row.text("strengths_json"), row.text("weaknesses_json"), row.text("active_topics_json"),
        row.text("tutor_notes_json"), row.text("recent_signals_json"), row.text("created_at"), row.text("updated_at"))
}

/** The userId must already come from authenticate(); never accept it from request data. */
func learnerMemoryLoadOrCreate(cfg: Config, authenticatedUserId: String): LearnerMemory {
    let userId = authenticatedUserId.trimAscii()
    if (userId.size == 0 || userId.size > 128) { throw Exception("学习记忆归属无效") }
    let existing = query(cfg, learnerMemorySelectSql(userId))
    if (existing.size > 0) { return learnerMemoryFromRow(userId, existing[0]) }

    let users = query(cfg, "SELECT profile_json FROM users WHERE id=" + sqlQuote(userId) + " LIMIT 1")
    if (users.size == 0) { throw Exception("学习记忆所属用户不存在") }
    let profileJson = if (users[0].isNull("profile_json")) { "" } else { users[0].text("profile_json") }
    let memory = learnerMemoryDefault(userId, profileJson)
    execute(cfg,
        "INSERT IGNORE INTO user_learning_memory(user_id,memory_version,profile_summary," +
        "learning_goals_json,knowledge_level_json,preferences_json,strengths_json,weaknesses_json," +
        "active_topics_json,tutor_notes_json,recent_signals_json) VALUES(" +
        sqlQuote(memory.userId) + "," + memory.memoryVersion.toString() + "," +
        sqlQuote(memory.profileSummary) + "," + sqlQuote(memory.learningGoalsJson) + "," +
        sqlQuote(memory.knowledgeLevelJson) + "," + sqlQuote(memory.preferencesJson) + "," +
        sqlQuote(memory.strengthsJson) + "," + sqlQuote(memory.weaknessesJson) + "," +
        sqlQuote(memory.activeTopicsJson) + "," + sqlQuote(memory.tutorNotesJson) + "," +
        sqlQuote(memory.recentSignalsJson) + ")")

    let created = query(cfg, learnerMemorySelectSql(userId))
    if (created.size == 0) { throw Exception("学习记忆初始化失败") }
    learnerMemoryFromRow(userId, created[0])
}

/** Compact, explicitly labelled data block for the model system prompt. */
func learnerMemoryPromptSnapshot(memory: LearnerMemory): String {
    let text = "画像摘要：" + learnerMemoryLimitOneLine(memory.profileSummary, 700) + "\n" +
        "学习目标：" + learnerMemoryLimit(memory.learningGoalsJson, LEARNER_MEMORY_PROMPT_FIELD_BYTES) + "\n" +
        "知识基础：" + learnerMemoryLimit(memory.knowledgeLevelJson, LEARNER_MEMORY_PROMPT_FIELD_BYTES) + "\n" +
        "学习偏好：" + learnerMemoryLimit(memory.preferencesJson, LEARNER_MEMORY_PROMPT_FIELD_BYTES) + "\n" +
        "优势：" + learnerMemoryLimit(memory.strengthsJson, LEARNER_MEMORY_PROMPT_FIELD_BYTES) + "\n" +
        "薄弱点：" + learnerMemoryLimit(memory.weaknessesJson, LEARNER_MEMORY_PROMPT_FIELD_BYTES) + "\n" +
        "当前主题：" + learnerMemoryLimit(memory.activeTopicsJson, LEARNER_MEMORY_PROMPT_FIELD_BYTES) + "\n" +
        "导师笔记：" + learnerMemoryLimit(memory.tutorNotesJson, LEARNER_MEMORY_PROMPT_FIELD_BYTES) + "\n" +
        "近期信号：" + learnerMemoryLimit(memory.recentSignalsJson, LEARNER_MEMORY_PROMPT_FIELD_BYTES)
    learnerMemoryLimit(text, LEARNER_MEMORY_PROMPT_BYTES)
}

/** Stable camelCase contract for GET /api/learner/memory. */
func learnerMemoryResponseBody(memory: LearnerMemory): String {
    let out = JsonWriter()
    out.putStr("userId", memory.userId)
    out.putInt("memoryVersion", memory.memoryVersion)
    out.putStr("profileSummary", memory.profileSummary)
    out.putRaw("learningGoals", memory.learningGoalsJson)
    out.putRaw("knowledgeLevel", memory.knowledgeLevelJson)
    out.putRaw("preferences", memory.preferencesJson)
    out.putRaw("strengths", memory.strengthsJson)
    out.putRaw("weaknesses", memory.weaknessesJson)
    out.putRaw("activeTopics", memory.activeTopicsJson)
    out.putRaw("tutorNotes", memory.tutorNotesJson)
    out.putRaw("recentSignals", memory.recentSignalsJson)
    out.putStr("createdAt", memory.createdAt)
    out.putStr("updatedAt", memory.updatedAt)
    out.toJson()
}
