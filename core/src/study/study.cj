package itn_desktop_core.study

import std.collection.*
import std.convert.*
import std.fs.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.kb.*
import itn_desktop_core.db.*
import itn_desktop_core.util.*
import itn_desktop_core.personal.PersonalStore

// ==================== 学习者档案 ====================
// 单人本地使用，档案只存在本机。没有账号体系，也不需要。

public class LearnerProfile {
    public var nickname: String = ""
    public var goal: String = ""
    public var weeklyHours: Int64 = 8
    public var mbtiType: String = ""
    public var luminMbtiType: String = "ENFJ"
    public var preferredFormats: ArrayList<String> = ArrayList<String>()
    // 自评能力，键为维度名，值为 0-100
    public var selfScores: ArrayList<String> = ArrayList<String>()
    public var selfScoreValues: ArrayList<Int64> = ArrayList<Int64>()
    public var updatedAt: String = ""

    public init() {}

    public func scoreOf(name: String): Int64 {
        var i = 0
        while (i < selfScores.size) {
            if (selfScores[i] == name) {
                return selfScoreValues[i]
            }
            i = i + 1
        }
        return 0
    }

    public func setScore(name: String, value: Int64): Unit {
        var i = 0
        while (i < selfScores.size) {
            if (selfScores[i] == name) {
                selfScoreValues[i] = value
                return
            }
            i = i + 1
        }
        selfScores.add(name)
        selfScoreValues.add(value)
    }

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("nickname", JsonString(nickname))
        o.put("goal", JsonString(goal))
        o.put("weeklyHours", JsonInt(weeklyHours))
        o.put("mbtiType", JsonString(mbtiType))
        o.put("luminMbtiType", JsonString(if (luminMbtiType.size == 0) { "ENFJ" } else { luminMbtiType }))
        o.put("updatedAt", JsonString(updatedAt))
        let fmts = JsonArray()
        for (f in preferredFormats) {
            fmts.add(JsonString(f))
        }
        o.put("preferredFormats", fmts)
        let scores = JsonObject()
        var i = 0
        while (i < selfScores.size) {
            scores.put(selfScores[i], JsonInt(selfScoreValues[i]))
            i = i + 1
        }
        o.put("selfScores", scores)
        return o
    }

    public static func fromJson(v: JsonValue): LearnerProfile {
        let p = LearnerProfile()
        match (objOf(v)) {
            case Some(o) =>
                p.nickname = strOf(o, "nickname")
                p.goal = strOf(o, "goal")
                p.weeklyHours = intOf(o, "weeklyHours")
                if (p.weeklyHours <= 0) {
                    p.weeklyHours = 8
                }
                p.updatedAt = strOf(o, "updatedAt")
                p.mbtiType = strOf(o, "mbtiType").toAsciiUpper()
                p.luminMbtiType = strOf(o, "luminMbtiType").toAsciiUpper()
                if (p.luminMbtiType.size == 0) {
                    p.luminMbtiType = "ENFJ"
                }
                p.preferredFormats = strArrayOf(o, "preferredFormats")
                match (o.get("selfScores")) {
                    case Some(sv) =>
                        match (objOf(sv)) {
                            case Some(so) =>
                                for ((k, val) in so.getFields()) {
                                    p.setScore(k, intValue(val))
                                }
                            case None => ()
                        }
                    case None => ()
                }
            case None => ()
        }
        return p
    }
}

public func isMbtiType(value: String): Bool {
    let code = value.toAsciiUpper()
    for (item in [
        "INTJ", "INTP", "ENTJ", "ENTP",
        "INFJ", "INFP", "ENFJ", "ENFP",
        "ISTJ", "ISFJ", "ESTJ", "ESFJ",
        "ISTP", "ISFP", "ESTP", "ESFP"
    ]) {
        if (code == item) { return true }
    }
    return false
}

/** Short style guidance used by the host prompt; MBTI never changes facts or permissions. */
public func mbtiStyleText(value: String): String {
    let code = value.toAsciiUpper()
    if (code == "ENFJ") { return "先接住用户此刻的目标和感受，再给清晰的方向与下一步；多用邀请式提问，语气温暖但不空泛。" }
    if (code == "ENFP") { return "先展开可能性与灵感，再主动收束成一个可执行下一步；语气有活力，避免只发散不落地。" }
    if (code == "INFJ") { return "先点出深层模式与意义，再给温和、可执行的路径；用少量有洞察力的问题引导。" }
    if (code == "INFP") { return "尊重用户的价值感与节奏，用具体例子和故事讲清概念，先理解再给建议。" }
    if (code == "ENTJ") { return "先给结论、目标和里程碑，再拆成有优先级的行动；表达直接、有决断感。" }
    if (code == "INTJ") { return "先给模型、依据和边界，再给精简的推进路线；少寒暄，多条件与因果。" }
    if (code == "ENTP") { return "先用反常识问题和多种方案打开思路，最后明确比较标准并收敛选择。" }
    if (code == "INTP") { return "先拆概念、变量和反例，再给可以继续探索的问题；保持精确与好奇。" }
    if (code == "ESFJ") { return "先确认共同目标与协作方式，再用清楚的步骤、反馈和关照推进。" }
    if (code == "ISFJ") { return "语气稳、细、可依赖；先复述已知事实，再按顺序给具体步骤和小提醒。" }
    if (code == "ESTJ") { return "先列目标、规则、验收和负责人，再给清单式行动；避免含糊表达。" }
    if (code == "ISTJ") { return "先给事实、规则、可复现流程和检查点；表达准确、克制、少跳跃。" }
    if (code == "ESFP") { return "先用鲜活体验和短例子拉近距离，再给马上能做的一步；节奏轻快。" }
    if (code == "ISFP") { return "语气柔和，先尊重用户自己的感受和选择，再用具体、可感知的练习推进。" }
    if (code == "ESTP") { return "先说现实场景和最快的验证办法，再边做边校准；表达简洁、行动优先。" }
    if (code == "ISTP") { return "先拆机制、工具和可操作步骤，再给一个最小实验；少铺陈，重视手感。" }
    return "先理解用户当下目标，再给出清楚、可执行的下一步；表达自然，不生搬人格标签。"
}

public func intValue(v: JsonValue): Int64 {
    match (v) {
        case j: JsonInt => j.getValue()
        case _ => 0
    }
}

// ==================== 学习进度 ====================
// 键统一用 "kbId|chunkId" 或 "kbId|章节名"，避免多个知识库互相串。

public class StudyProgress {
    public var readChunks: ArrayList<String> = ArrayList<String>()
    public var readAt: ArrayList<String> = ArrayList<String>()
    public var completedChapters: ArrayList<String> = ArrayList<String>()

    public init() {}

    public func markRead(key: String, at: String): Unit {
        var i = 0
        while (i < readChunks.size) {
            if (readChunks[i] == key) {
                readAt[i] = at
                return
            }
            i = i + 1
        }
        readChunks.add(key)
        readAt.add(at)
    }

    public func isRead(key: String): Bool {
        for (k in readChunks) {
            if (k == key) {
                return true
            }
        }
        return false
    }

    public func markChapterDone(key: String): Unit {
        if (completedChapters.contains(key)) {
            return
        }
        completedChapters.add(key)
    }

    public func toJson(): JsonObject {
        let o = JsonObject()
        let r = JsonArray()
        for (k in readChunks) {
            r.add(JsonString(k))
        }
        o.put("readChunks", r)
        let t = JsonArray()
        for (k in readAt) {
            t.add(JsonString(k))
        }
        o.put("readAt", t)
        let c = JsonArray()
        for (k in completedChapters) {
            c.add(JsonString(k))
        }
        o.put("completedChapters", c)
        return o
    }

    public static func fromJson(v: JsonValue): StudyProgress {
        let p = StudyProgress()
        match (objOf(v)) {
            case Some(o) =>
                p.readChunks = strArrayOf(o, "readChunks")
                p.readAt = strArrayOf(o, "readAt")
                p.completedChapters = strArrayOf(o, "completedChapters")
            case None => ()
        }
        return p
    }
}

// ==================== 笔记 ====================

public class StudyNote {
    public var id: String = ""
    public var kbId: String = ""
    public var chapter: String = ""
    public var title: String = ""
    public var text: String = ""
    public var createdAt: String = ""
    /** 以下字段是学习资源/导学来源元数据；正文表结构不变，兼容旧数据库。 */
    public var updatedAt: String = ""
    public var resourceId: String = ""
    public var resourceVersion: Int64 = 0
    public var page: Int64 = 0
    public var slideTitle: String = ""
    public var sourceQuote: String = ""

    public init() {}

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("id", JsonString(id))
        o.put("kbId", JsonString(kbId))
        o.put("chapter", JsonString(chapter))
        o.put("title", JsonString(title))
        o.put("text", JsonString(text))
        o.put("createdAt", JsonString(createdAt))
        o.put("updatedAt", JsonString(updatedAt))
        o.put("resourceId", JsonString(resourceId))
        o.put("resourceVersion", JsonInt(resourceVersion))
        o.put("page", JsonInt(page))
        o.put("slideTitle", JsonString(slideTitle))
        o.put("sourceQuote", JsonString(sourceQuote))
        return o
    }

    public static func fromJson(v: JsonValue): StudyNote {
        let n = StudyNote()
        match (objOf(v)) {
            case Some(o) =>
                n.id = strOf(o, "id")
                n.kbId = strOf(o, "kbId")
                n.chapter = strOf(o, "chapter")
                n.title = strOf(o, "title")
                n.text = strOf(o, "text")
                n.createdAt = strOf(o, "createdAt")
                n.updatedAt = strOf(o, "updatedAt")
                n.resourceId = strOf(o, "resourceId")
                n.resourceVersion = intOf(o, "resourceVersion")
                n.page = intOf(o, "page")
                n.slideTitle = strOf(o, "slideTitle")
                n.sourceQuote = strOf(o, "sourceQuote")
            case None => ()
        }
        return n
    }
}

// ==================== 答题与错题 ====================

public class QuizRecord {
    public var id: String = ""
    public var kbId: String = ""
    public var chapter: String = ""
    public var question: String = ""
    public var myAnswer: String = ""
    public var reference: String = ""
    public var correct: Bool = false
    public var createdAt: String = ""

    public init() {}

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("id", JsonString(id))
        o.put("kbId", JsonString(kbId))
        o.put("chapter", JsonString(chapter))
        o.put("question", JsonString(question))
        o.put("myAnswer", JsonString(myAnswer))
        o.put("reference", JsonString(reference))
        o.put("correct", JsonBool(correct))
        o.put("createdAt", JsonString(createdAt))
        return o
    }

    public static func fromJson(v: JsonValue): QuizRecord {
        let r = QuizRecord()
        match (objOf(v)) {
            case Some(o) =>
                r.id = strOf(o, "id")
                r.kbId = strOf(o, "kbId")
                r.chapter = strOf(o, "chapter")
                r.question = strOf(o, "question")
                r.myAnswer = strOf(o, "myAnswer")
                r.reference = strOf(o, "reference")
                r.correct = boolOf(o, "correct")
                r.createdAt = strOf(o, "createdAt")
            case None => ()
        }
        return r
    }
}

/* ==================== 错题的间隔复习 ====================
 * 曲线与"某条错题现在什么状态"都放在这一层：HTTP 层和学习图都直接用它，
 * 不再各写一份（之前 api.cj 里私有版本只有它能用，图那边只能干瞪眼）。
 * 状态存在 meta 键值表的 "quiz-review:<id>" 里，形如 "重做次数|上次时间|是否已掌握"。
 */
public func reviewIntervalMs(reviews: Int64): Int64 {
    let day: Int64 = 24 * 60 * 60 * 1000
    if (reviews <= 0) {
        return 0
    }
    if (reviews == 1) {
        return day
    }
    if (reviews == 2) {
        return 3 * day
    }
    if (reviews == 3) {
        return 7 * day
    }
    if (reviews == 4) {
        return 16 * day
    }
    return 35 * day
}

/** 把一条错题记录附上复习状态（不动表结构，老数据目录也能直接用）。 */
public func attachReviewState(db: Db, o: JsonObject, id: String, nowMs: Int64): Unit {
    let parts = db.getKv("meta", "quiz-review:" + id, "").split("|")
    let reviews = kvInt(parts, 0)
    let lastMs = kvInt(parts, 1)
    let mastered = kvInt(parts, 2) == 1
    let due = !mastered && (reviews == 0 || nowMs >= lastMs + reviewIntervalMs(reviews))
    o.put("reviews", JsonInt(reviews))
    o.put("lastMs", JsonInt(lastMs))
    o.put("mastered", JsonBool(mastered))
    o.put("due", JsonBool(due))
    o.put("dueMs", JsonInt(lastMs + reviewIntervalMs(reviews)))
    // 原始题目（选项/正确项/解析）也一起回传，这样"重做"给的是一模一样的题
    let q = db.getKv("meta", "quiz-q:" + id, "")
    o.put("hasOptions", JsonBool(q.size > 0))
    if (q.size > 0) {
        try {
            o.put("origin", JsonValue.fromStr(q))
        } catch (e: Exception) {
            ()
        }
    }
}

/* ==================== 六维能力：自评 + 实测参考 ====================
 * 网页版那张雷达图是"六维 = 画像基线 + 学习证据"，但它的证据来自一张手工维护的
 * 章节→维度权重表（CHAPTER_ABILITY_WEIGHTS）。桌面版的章节来自**用户自己的资料**，
 * 不存在那张表，所以这里换成"每种维度配一个能真实拿到的信号"，并把依据一并回给界面——
 * 界面必须写清"这一格是怎么算出来的"，否则就是编。
 *
 * 规矩继承「不够就不给」：练习少于 4 题就不给"逻辑推理"的参考分（拿噪声当依据更糟）。
 */
public class AbilityEvidence {
    public var key: String = ""
    public var evidence: Int64 = -1     // -1 = 数据不够，不给参考
    public var basis: String = ""
}

func clampScore(v: Int64): Int64 {
    if (v < 0) { return 0 }
    if (v > 100) { return 100 }
    return v
}

/** 六维的实测参考：每一维都配一个真实信号，并说明依据。 */
public func abilityEvidence(dataDir: String, kbId: String, quizTotal: Int64, quizRight: Int64,
    readChunks: Int64, completedChapters: Int64, noteCount: Int64, artifactCount: Int64): ArrayList<AbilityEvidence> {
    let out = ArrayList<AbilityEvidence>()
    let idx = loadIndexCached(dataDir, kbId)
    var totalChunks: Int64 = Int64(idx.chunks.size)
    var chapterCount: Int64 = 0
    let seen = HashSet<String>()
    for (c in idx.chunks) {
        let name = chapterOf(c.headingPath, c.docTitle)
        if (!seen.contains(name)) {
            seen.add(name)
        }
    }
    chapterCount = Int64(seen.size)

    let a = AbilityEvidence()
    a.key = "概念理解"
    if (totalChunks > 0) {
        a.basis = "阅读记录，不代表概念掌握：已读切片 " + readChunks.toString() + "/" + totalChunks.toString()
    } else {
        a.basis = "还没有索引，读得怎么样无从判断"
    }
    out.add(a)

    let b = AbilityEvidence()
    b.key = "逻辑推理"
    if (quizTotal >= 4) {
        b.basis = "练习记录，不单独推断逻辑能力（" + quizTotal.toString() + " 题）"
    } else {
        b.basis = "练习不足 4 题，先不给参考"
    }
    out.add(b)

    let c2 = AbilityEvidence()
    c2.key = "工程实践"
    if (chapterCount > 0) {
        c2.basis = "章节完成记录，不代表工程能力：" + completedChapters.toString() + "/" + chapterCount.toString()
    } else {
        c2.basis = "还没有章节"
    }
    out.add(c2)

    let d = AbilityEvidence()
    d.key = "问题诊断"
    // 用错题的"重做后就掌握"来衡量：答错过的题里，有多少已经靠重做推过去了
    var wrongTotal: Int64 = 0
    var rescued: Int64 = 0
    let st = StudyStore(dataDir).load()
    let db = DbHub.open(dataDir)
    for (r in st.quizRecords) {
        if (r.correct) {
            continue
        }
        wrongTotal = wrongTotal + 1
        let parts = db.getKv("meta", "quiz-review:" + r.id, "").split("|")
        let rev = kvInt(parts, 0)
        let mas = kvInt(parts, 2) == 1
        if (mas || rev >= 2) {
            rescued = rescued + 1
        }
    }
    if (wrongTotal >= 2) {
        d.basis = "手动复习记录，不代表诊断能力：" + rescued.toString() + "/" + wrongTotal.toString()
    } else {
        d.basis = "错题样本太少，先不给参考"
    }
    out.add(d)

    let e = AbilityEvidence()
    e.key = "系统设计"
    if (chapterCount > 0) {
        e.basis = "资源生成记录，不代表设计能力：" + artifactCount.toString() + " 份 / 章节 " + chapterCount.toString() + " 章"
    } else {
        e.basis = "还没有章节"
    }
    out.add(e)

    let f = AbilityEvidence()
    f.key = "学习迁移"
    if (chapterCount > 0) {
        f.basis = "笔记数量，不代表迁移能力：" + noteCount.toString() + " 条 / 章节 " + chapterCount.toString() + " 章"
    } else {
        f.basis = "还没有章节"
    }
    out.add(f)
    return out
}

// ==================== 本地存储 ====================
// 单人本地使用，所有学习数据放一个文件，够用且好备份。

public class StudyData {
    public var profile: LearnerProfile = LearnerProfile()
    public var progress: StudyProgress = StudyProgress()
    public var notes: ArrayList<StudyNote> = ArrayList<StudyNote>()
    public var quizRecords: ArrayList<QuizRecord> = ArrayList<QuizRecord>()

    public init() {}

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("profile", profile.toJson())
        o.put("progress", progress.toJson())
        let ns = JsonArray()
        for (n in notes) {
            ns.add(n.toJson())
        }
        o.put("notes", ns)
        let qs = JsonArray()
        for (r in quizRecords) {
            qs.add(r.toJson())
        }
        o.put("quizRecords", qs)
        return o
    }

    public static func fromJson(v: JsonValue): StudyData {
        let d = StudyData()
        match (objOf(v)) {
            case Some(o) =>
                match (o.get("profile")) {
                    case Some(pv) => d.profile = LearnerProfile.fromJson(pv)
                    case None => ()
                }
                match (o.get("progress")) {
                    case Some(pv) => d.progress = StudyProgress.fromJson(pv)
                    case None => ()
                }
                match (o.get("notes")) {
                    case Some(nv) =>
                        match (nv) {
                            case arr: JsonArray =>
                                var i = 0
                                while (i < arr.size()) {
                                    d.notes.add(StudyNote.fromJson(arr[i]))
                                    i = i + 1
                                }
                            case _ => ()
                        }
                    case None => ()
                }
                match (o.get("quizRecords")) {
                    case Some(qv) =>
                        match (qv) {
                            case arr: JsonArray =>
                                var i = 0
                                while (i < arr.size()) {
                                    d.quizRecords.add(QuizRecord.fromJson(arr[i]))
                                    i = i + 1
                                }
                            case _ => ()
                        }
                    case None => ()
                }
            case None => ()
        }
        return d
    }
}

/*
 * 学习数据仓库：档案、进度、笔记、答题记录。
 *
 * 表按实体拆开，读写都是行级操作，不再像 JSON 那样每次整份重写。
 * 对外仍是 load()/save()：api.cj 的调用方式保持不变，save 在一个事务里整体替换。
 */
public class StudyStore {
    public let dataDir: String

    public init(dataDir: String) {
        this.dataDir = dataDir
    }

    private func db(): Db {
        return DbHub.open(dataDir)
    }

    public func loadProfile(): LearnerProfile {
        ensureDir(dataDir)
        migrateFromJson()
        let p = LearnerProfile()
        p.nickname = db().getKv("profile", "nickname", "")
        p.goal = db().getKv("profile", "goal", "")
        p.mbtiType = db().getKv("profile", "mbtiType", "").toAsciiUpper()
        p.luminMbtiType = db().getKv("profile", "luminMbtiType", "ENFJ").toAsciiUpper()
        if (p.luminMbtiType.size == 0) { p.luminMbtiType = "ENFJ" }
        p.updatedAt = db().getKv("profile", "updatedAt", "")
        let hours = db().getKv("profile", "weeklyHours", "")
        if (hours.size > 0) {
            try {
                p.weeklyHours = Int64.parse(hours)
            } catch (e: Exception) {
                ()
            }
        }
        if (p.weeklyHours <= 0) {
            p.weeklyHours = 8
        }
        for (f in splitCsv(db().getKv("profile", "formats", ""))) {
            p.preferredFormats.add(f)
        }
        let scores = db().getKv("profile", "selfScores", "")
        if (scores.size > 0) {
            try {
                match (objOf(JsonValue.fromStr(scores))) {
                    case Some(o) =>
                        for ((k, val) in o.getFields()) {
                            p.setScore(k, intValue(val))
                        }
                    case None => ()
                }
            } catch (e: Exception) {
                ()
            }
        }
        return p
    }

    /** Update profile-facing keys without rewriting study progress, notes or quiz records. */
    public func saveProfile(p: LearnerProfile): Unit {
        ensureDir(dataDir)
        let ops = ArrayList<DbOp>()
        for ((key, value) in [
            ("nickname", p.nickname), ("goal", p.goal), ("weeklyHours", p.weeklyHours.toString()),
            ("updatedAt", if (p.updatedAt.size > 0) { p.updatedAt } else { nowStamp() }),
            ("formats", joinList(p.preferredFormats)), ("selfScores", selfScoresJson(p)),
            ("mbtiType", if (isMbtiType(p.mbtiType)) { p.mbtiType.toAsciiUpper() } else { "" }),
            ("luminMbtiType", if (isMbtiType(p.luminMbtiType)) { p.luminMbtiType.toAsciiUpper() } else { "ENFJ" })
        ]) {
            ops.add(DbOp("INSERT OR REPLACE INTO profile (k, v) VALUES (?, ?)", va([tv(key), tv(value)])))
        }
        db().batch(ops)
    }

    /** A patch only writes provided keys; unrelated learning rows and preferences survive. */
    public func updateProfile(patch: JsonObject): LearnerProfile {
        // Complete the legacy migration before applying a first profile-only update.
        let current = loadProfile()
        let ops = ArrayList<DbOp>()
        for (key in ["nickname", "goal", "mbtiType", "luminMbtiType"]) {
            if (patch.get(key).isNone()) { continue }
            match (patch.get(key).getOrThrow()) {
                case value: JsonString => ()
                case _ => throw Exception("档案字段 " + key + " 必须是字符串")
            }
            var value = strOf(patch, key)
            if (key == "mbtiType" || key == "luminMbtiType") {
                value = trimStr(value).toAsciiUpper()
                if (value.size > 0 && !isMbtiType(value)) { throw Exception("MBTI 类型不在标准 16 型中") }
                if (key == "luminMbtiType" && value.size == 0) { value = "ENFJ" }
            }
            ops.add(DbOp("INSERT OR REPLACE INTO profile (k, v) VALUES (?, ?)", va([tv(key), tv(value)])))
        }
        if (patch.get("weeklyHours").isSome()) {
            let hours = intOf(patch, "weeklyHours")
            if (hours <= 0) { throw Exception("每周学习时长必须大于 0") }
            ops.add(DbOp("INSERT OR REPLACE INTO profile (k, v) VALUES ('weeklyHours', ?)", va([tv(hours.toString())])))
        }
        if (patch.get("preferredFormats").isSome()) {
            ops.add(DbOp("INSERT OR REPLACE INTO profile (k, v) VALUES ('formats', ?)", va([tv(joinList(strArrayOf(patch, "preferredFormats")))])))
        }
        if (patch.get("selfScores").isSome()) {
            match (patch.get("selfScores").getOrThrow()) {
                case scores: JsonObject =>
                    for ((key, value) in scores.getFields()) { current.setScore(key, intValue(value)) }
                case _ => throw Exception("selfScores 必须是对象")
            }
            ops.add(DbOp("INSERT OR REPLACE INTO profile (k, v) VALUES ('selfScores', ?)", va([tv(selfScoresJson(current))])))
        }
        if (ops.size > 0) {
            ops.add(DbOp("INSERT OR REPLACE INTO profile (k, v) VALUES ('updatedAt', ?)", va([tv(nowStamp())])))
            db().batch(ops)
        }
        return loadProfile()
    }

    public func load(): StudyData {
        let d = StudyData()
        d.profile = loadProfile()
        for (r in db().querySql("SELECT kb_id, item_key, at FROM progress WHERE kind = 'chunk' ORDER BY kb_id, item_key")) {
            d.progress.markRead(r.text(0) + "|" + r.text(1), r.text(2))
        }
        for (r in db().querySql("SELECT kb_id, chapter FROM chapter_done ORDER BY kb_id, chapter")) {
            d.progress.markChapterDone(r.text(0) + "|" + r.text(1))
        }
        for (r in db().querySql("SELECT id, kb_id, chapter, title, text, created_at FROM notes ORDER BY created_at, id")) {
            let n = StudyNote()
            n.id = r.text(0)
            n.kbId = r.text(1)
            n.chapter = r.text(2)
            n.title = r.text(3)
            n.text = r.text(4)
            n.createdAt = r.text(5)
            loadNoteMeta(n)
            d.notes.add(n)
        }
        for (r in db().querySql("SELECT id, kb_id, chapter, question, my_answer, reference, correct, created_at " +
            "FROM quiz_records ORDER BY ord, created_at")) {
            let q = QuizRecord()
            q.id = r.text(0)
            q.kbId = r.text(1)
            q.chapter = r.text(2)
            q.question = r.text(3)
            q.myAnswer = r.text(4)
            q.reference = r.text(5)
            q.correct = r.bool(6)
            q.createdAt = r.text(7)
            d.quizRecords.add(q)
        }
        return d
    }

    /** 笔记来源元数据不新增表列，老数据库直接可用；只按 note id 读回。 */
    private func loadNoteMeta(n: StudyNote): Unit {
        let raw = db().getKv("meta", "study-note-meta:" + n.id, "")
        if (raw.size == 0) {
            return
        }
        try {
            let o = objOf(JsonValue.fromStr(raw)).getOrDefault({ => JsonObject() })
            n.updatedAt = strOf(o, "updatedAt")
            n.resourceId = strOf(o, "resourceId")
            n.resourceVersion = intOf(o, "resourceVersion")
            n.page = intOf(o, "page")
            n.slideTitle = strOf(o, "slideTitle")
            n.sourceQuote = strOf(o, "sourceQuote")
        } catch (e: Exception) {
            ()
        }
    }

    public func saveNoteMeta(n: StudyNote): Unit {
        let o = JsonObject()
        o.put("updatedAt", JsonString(if (n.updatedAt.size > 0) { n.updatedAt } else { nowStamp() }))
        o.put("resourceId", JsonString(n.resourceId))
        o.put("resourceVersion", JsonInt(n.resourceVersion))
        o.put("page", JsonInt(n.page))
        o.put("slideTitle", JsonString(n.slideTitle))
        o.put("sourceQuote", JsonString(n.sourceQuote))
        db().putKv("meta", "study-note-meta:" + n.id, o.toString())
    }

    public func deleteNoteMeta(id: String): Unit {
        db().delKv("meta", "study-note-meta:" + id)
    }

    public func save(d: StudyData): Unit {
        ensureDir(dataDir)
        let ops = ArrayList<DbOp>()
        ops.add(DbOp("DELETE FROM profile", ArrayList<DbValue>()))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("nickname"), tv(d.profile.nickname)])))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("goal"), tv(d.profile.goal)])))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("weeklyHours"), tv(d.profile.weeklyHours.toString())])))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("mbtiType"), tv(d.profile.mbtiType)])))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("luminMbtiType"), tv(if (d.profile.luminMbtiType.size == 0) { "ENFJ" } else { d.profile.luminMbtiType })])))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("updatedAt"), tv(d.profile.updatedAt)])))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("formats"), tv(joinList(d.profile.preferredFormats))])))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("selfScores"), tv(selfScoresJson(d.profile))])))

        ops.add(DbOp("DELETE FROM progress WHERE kind = 'chunk'", ArrayList<DbValue>()))
        var i = 0
        while (i < d.progress.readChunks.size) {
            let key = d.progress.readChunks[i]
            let at = if (i < d.progress.readAt.size) { d.progress.readAt[i] } else { "" }
            let parts = splitOnce(key)
            ops.add(DbOp("INSERT OR REPLACE INTO progress (kb_id, kind, item_key, at) VALUES (?, ?, ?, ?)",
                va([tv(parts[0]), tv("chunk"), tv(parts[1]), tv(at)])))
            i += 1
        }
        ops.add(DbOp("DELETE FROM chapter_done", ArrayList<DbValue>()))
        for (key in d.progress.completedChapters) {
            let parts = splitOnce(key)
            ops.add(DbOp("INSERT OR REPLACE INTO chapter_done (kb_id, chapter, at) VALUES (?, ?, ?)",
                va([tv(parts[0]), tv(parts[1]), tv(nowStamp())])))
        }
        ops.add(DbOp("DELETE FROM notes", ArrayList<DbValue>()))
        for (n in d.notes) {
            ops.add(DbOp("INSERT OR REPLACE INTO notes (id, kb_id, chapter, title, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                va([tv(n.id), tv(n.kbId), tv(n.chapter), tv(n.title), tv(n.text), tv(n.createdAt)])))
        }
        ops.add(DbOp("DELETE FROM quiz_records", ArrayList<DbValue>()))
        var ord: Int64 = 0
        for (q in d.quizRecords) {
            ops.add(DbOp("INSERT OR REPLACE INTO quiz_records (id, kb_id, chapter, question, my_answer, reference, correct, created_at, ord) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                va([tv(q.id), tv(q.kbId), tv(q.chapter), tv(q.question), tv(q.myAnswer), tv(q.reference),
                    boolValue(q.correct), tv(q.createdAt), nv(ord)])))
            ord += 1
        }
        db().batch(ops)
        PersonalStore(dataDir).refreshStudyIndex()
    }

    private func splitOnce(key: String): Array<String> {
        // 键统一是 "kbId|chunkId" / "kbId|章节名"，按第一个分隔符切
        let b = key.toArray()
        var i = 0
        while (i < b.size) {
            if (b[i] == 124) {
                return [String.fromUtf8(b[0..i]), String.fromUtf8(b[(i + 1)..b.size])]
            }
            i += 1
        }
        return [key, ""]
    }

    private func selfScoresJson(p: LearnerProfile): String {
        let o = JsonObject()
        var i = 0
        while (i < p.selfScores.size) {
            o.put(p.selfScores[i], JsonInt(p.selfScoreValues[i]))
            i += 1
        }
        return o.toString()
    }

    private func splitCsv(text: String): ArrayList<String> {
        let out = ArrayList<String>()
        for (part in text.split(",")) {
            if (part.size > 0) {
                out.add(part)
            }
        }
        return out
    }

    private func joinList(items: ArrayList<String>): String {
        let sb = StringBuilder()
        var first = true
        for (it in items) {
            if (!first) {
                sb.append(",")
            }
            sb.append(it)
            first = false
        }
        return sb.toString()
    }

    /** 一次性把 study.json 导进数据库，只导一次。 */
    private func migrateFromJson(): Unit {
        if (migrationDone(db(), "study")) {
            return
        }
        let path = dataDir + Path.Separator + "study.json"
        if (exists(path)) {
            let raw = readTextOr(path, "")
            if (raw.size > 0) {
                try {
                    save(StudyData.fromJson(JsonValue.fromStr(raw)))
                } catch (e: Exception) {
                    ()
                }
            }
            archiveLegacy(path)
        }
        markMigrationDone(db(), "study")
    }
}

// ==================== 知识网络 ====================
// 直接由知识库的标题路径推导章节结构，不额外调模型，快且稳定。

public func chapterOf(headingPath: String, fallback: String): String {
    if (headingPath.size == 0) {
        return fallback
    }
    let parts = headingPath.split(" > ")
    if (parts.size > 0 && parts[0].size > 0) {
        return parts[0]
    }
    return fallback
}

public class ChapterInfo {
    public var name: String = ""
    public var chunkCount: Int64 = 0
    public var sectionSet: HashSet<String> = HashSet<String>()
    public var docSet: HashSet<String> = HashSet<String>()
}

public func buildChapterTree(index: KbIndex, progress: StudyProgress, kbId: String): JsonArray {
    let order = ArrayList<String>()
    let map = HashMap<String, ChapterInfo>()
    for (c in index.chunks) {
        let name = chapterOf(c.headingPath, c.docTitle)
        if (!map.contains(name)) {
            let fresh = ChapterInfo()
            fresh.name = name
            map[name] = fresh
            order.add(name)
        }
        match (map.get(name)) {
            case Some(info) =>
                info.chunkCount = info.chunkCount + 1
                if (c.headingPath.size > 0) {
                    info.sectionSet.add(c.headingPath)
                }
                info.docSet.add(c.docPath)
            case None => ()
        }
    }
    let out = JsonArray()
    for (name in order) {
        var chunkCount: Int64 = 0
        var sectionCount: Int64 = 0
        var docCount: Int64 = 0
        match (map.get(name)) {
            case Some(info) =>
                chunkCount = info.chunkCount
                sectionCount = info.sectionSet.size
                docCount = info.docSet.size
            case None => ()
        }
        var readCount: Int64 = 0
        for (c in index.chunks) {
            if (chapterOf(c.headingPath, c.docTitle) == name && progress.isRead(kbId + "|" + c.id)) {
                readCount = readCount + 1
            }
        }
        let o = JsonObject()
        o.put("name", JsonString(name))
        o.put("chunkCount", JsonInt(chunkCount))
        o.put("sectionCount", JsonInt(sectionCount))
        o.put("docCount", JsonInt(docCount))
        o.put("readCount", JsonInt(readCount))
        o.put("done", JsonBool(chunkCount > 0 && readCount >= chunkCount))
        out.add(o)
    }
    return out
}
public func chunksOfChapter(index: KbIndex, progress: StudyProgress, kbId: String, chapter: String): JsonArray {
    let out = JsonArray()
    for (c in index.chunks) {
        if (chapterOf(c.headingPath, c.docTitle) != chapter) {
            continue
        }
        let o = JsonObject()
        o.put("id", JsonString(c.id))
        o.put("docTitle", JsonString(c.docTitle))
        o.put("docPath", JsonString(c.docPath))
        o.put("headingPath", JsonString(c.headingPath))
        o.put("text", JsonString(c.text))
        o.put("caption", JsonString(c.caption))
        let imgs = JsonArray()
        for (i in c.images) {
            imgs.add(JsonString(i))
        }
        o.put("images", imgs)
        o.put("read", JsonBool(progress.isRead(kbId + "|" + c.id)))
        out.add(o)
    }
    return out
}

/**
 * 按天汇总学习活动（给成长页那张"最近两周"的趋势图）。
 *
 * 数据源全是库里**已经存着时间戳**的列：`progress.at`（读了哪片）、`chapter_done.at`、
 * `notes.created_at`、`quiz_records.created_at`、`session_events.ts`（只数 turn/start）。
 * 日期串直接取时间戳的前 10 位（内核写进去的就是本地时间），**故意不做日历运算**：
 * "最近 14 天有哪几天"这种活交给前端（JS 里一行就是本地日期），内核只按已有数据分桶。
 */
/**
 * 有学习活动的日期（升序，最多最近 180 天）——给"学习日历 / 连续打卡"用。
 *
 * 与 trendByDay 同一批数据源（进度 / 章节完成 / 笔记 / 答题 / 会话），
 * 但这里只要日期：**连续多少天、这个月哪几天学过** 这类日历运算交给前端做
 * （JS 里一行就是本地日期，内核这边硬算时区只会算错）。
 */
public func studyDates(dataDir: String): ArrayList<String> {
    let db = DbHub.open(dataDir)
    let seen = HashSet<String>()
    let order = ArrayList<String>()
    func mark(day: String): Unit {
        if (day.size < 10) {
            return
        }
        let d = String.fromUtf8(day.toArray()[0..10])
        if (!seen.contains(d)) {
            seen.add(d)
            order.add(d)
        }
    }
    for (r in db.query("SELECT at FROM progress", ArrayList<DbValue>())) {
        mark(r.text(0))
    }
    for (r in db.query("SELECT at FROM chapter_done", ArrayList<DbValue>())) {
        mark(r.text(0))
    }
    for (r in db.query("SELECT created_at FROM notes", ArrayList<DbValue>())) {
        mark(r.text(0))
    }
    for (r in db.query("SELECT created_at FROM quiz_records", ArrayList<DbValue>())) {
        mark(r.text(0))
    }
    for (r in db.query("SELECT ts FROM session_events WHERE kind = 'turn/start'", ArrayList<DbValue>())) {
        mark(r.text(0))
    }
    // 升序（字符串比较 = 日期比较），只留最近 180 天
    let all = ArrayList<String>()
    for (d in order) {
        all.add(d)
    }
    var i = 0
    while (i < all.size) {
        var j = i + 1
        while (j < all.size) {
            if (all[j] < all[i]) {
                let t = all[i]
                all[i] = all[j]
                all[j] = t
            }
            j = j + 1
        }
        i = i + 1
    }
    let out = ArrayList<String>()
    var start = all.size - 180
    if (start < 0) {
        start = 0
    }
    var k = start
    while (k < all.size) {
        out.add(all[k])
        k = k + 1
    }
    return out
}

public func trendByDay(dataDir: String): JsonArray {
    let db = DbHub.open(dataDir)
    let readCount = HashMap<String, Int64>()
    let quizCount = HashMap<String, Int64>()
    let noteCount = HashMap<String, Int64>()
    let doneCount = HashMap<String, Int64>()
    let turnCount = HashMap<String, Int64>()
    let order = ArrayList<String>()
    let seen = HashSet<String>()

    func bump(map: HashMap<String, Int64>, day: String): Unit {
        if (day.size < 10) {
            return
        }
        let d = String.fromUtf8(day.toArray()[0..10])
        let cur = match (map.get(d)) {
            case Some(v) => v
            case None => 0
        }
        map[d] = cur + 1
    }

    func mark(day: String): Unit {
        if (day.size < 10) {
            return
        }
        let d = String.fromUtf8(day.toArray()[0..10])
        if (!seen.contains(d)) {
            seen.add(d)
            order.add(d)
        }
    }

    // 注意：已读切片在 progress 表里的 kind 是 'chunk'（不是 'read'），别照名字猜
    for (r in db.query("SELECT at FROM progress WHERE kind = 'chunk'", ArrayList<DbValue>())) {
        bump(readCount, r.text(0))
        mark(r.text(0))
    }
    for (r in db.query("SELECT at FROM chapter_done", ArrayList<DbValue>())) {
        bump(doneCount, r.text(0))
        mark(r.text(0))
    }
    for (r in db.query("SELECT created_at FROM notes", ArrayList<DbValue>())) {
        bump(noteCount, r.text(0))
        mark(r.text(0))
    }
    for (r in db.query("SELECT created_at FROM quiz_records", ArrayList<DbValue>())) {
        bump(quizCount, r.text(0))
        mark(r.text(0))
    }
    for (r in db.query("SELECT ts FROM session_events WHERE kind = 'turn/start'", ArrayList<DbValue>())) {
        bump(turnCount, r.text(0))
        mark(r.text(0))
    }

    // 日期升序；只回最近 60 天（够画图，也不至于把几十年数据一次性吐出去）
    var days = ArrayList<String>()
    for (d in order) {
        days.add(d)
    }
    var i = 0
    while (i < days.size) {
        var j = i + 1
        while (j < days.size) {
            if (days[j] < days[i]) {
                let t = days[i]
                days[i] = days[j]
                days[j] = t
            }
            j = j + 1
        }
        i = i + 1
    }
    let out = JsonArray()
    var start = 0
    if (days.size > 60) {
        start = days.size - 60
    }
    i = start
    while (i < days.size) {
        let d = days[i]
        let o = JsonObject()
        o.put("date", JsonString(d))
        o.put("read", JsonInt(match (readCount.get(d)) { case Some(v) => v; case None => 0 }))
        o.put("quiz", JsonInt(match (quizCount.get(d)) { case Some(v) => v; case None => 0 }))
        o.put("notes", JsonInt(match (noteCount.get(d)) { case Some(v) => v; case None => 0 }))
        o.put("done", JsonInt(match (doneCount.get(d)) { case Some(v) => v; case None => 0 }))
        o.put("turns", JsonInt(match (turnCount.get(d)) { case Some(v) => v; case None => 0 }))
        out.add(o)
        i = i + 1
    }
    return out
}

public func nowStamp(): String {
    return DateTime.now().toString()
}

/** 从模型输出里截出 JSON 数组：模型常常会加解释或代码围栏。 */
public func extractJsonArray(text: String): String {
    let b = text.toArray()
    var start = -1
    var end = -1
    var i = 0
    while (i < b.size) {
        if (b[i] == 91 && start < 0) {
            start = i
        }
        if (b[i] == 93 && start >= 0) {
            end = i
        }
        i = i + 1
    }
    if (start >= 0 && end > start) {
        return String.fromUtf8(b[start..(end + 1)])
    }
    return ""
}

/** 把章节切片拼成给模型看的资料文本，限制条数避免提示词过长。 */
public func contextFromChunks(chunks: JsonArray, max: Int64): String {
    let sb = StringBuilder()
    var i = 0
    while (i < chunks.size() && i < max) {
        match (objOf(chunks[i])) {
            case Some(c) =>
                let hp = strOf(c, "headingPath")
                if (hp.size > 0) {
                    sb.append("【")
                    sb.append(hp)
                    sb.append("】\n")
                }
                sb.append(strOf(c, "text"))
                let cap = strOf(c, "caption")
                if (cap.size > 0) {
                    sb.append("\n[图片描述] ")
                    sb.append(cap)
                }
                sb.append("\n\n")
            case None => ()
        }
        i = i + 1
    }
    return sb.toString()
}
