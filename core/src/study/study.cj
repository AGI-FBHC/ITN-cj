package itn_desktop_core.study

import std.collection.*
import std.convert.*
import std.fs.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.kb.*
import itn_desktop_core.db.*
import itn_desktop_core.util.*

// ==================== 学习者档案 ====================
// 单人本地使用，档案只存在本机。没有账号体系，也不需要。

public class LearnerProfile {
    public var nickname: String = ""
    public var goal: String = ""
    public var weeklyHours: Int64 = 8
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

    public init() {}

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("id", JsonString(id))
        o.put("kbId", JsonString(kbId))
        o.put("chapter", JsonString(chapter))
        o.put("title", JsonString(title))
        o.put("text", JsonString(text))
        o.put("createdAt", JsonString(createdAt))
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

    public func load(): StudyData {
        ensureDir(dataDir)
        migrateFromJson()
        let d = StudyData()
        let p = d.profile
        p.nickname = db().getKv("profile", "nickname", "")
        p.goal = db().getKv("profile", "goal", "")
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

    public func save(d: StudyData): Unit {
        ensureDir(dataDir)
        let ops = ArrayList<DbOp>()
        ops.add(DbOp("DELETE FROM profile", ArrayList<DbValue>()))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("nickname"), tv(d.profile.nickname)])))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("goal"), tv(d.profile.goal)])))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("weeklyHours"), tv(d.profile.weeklyHours.toString())])))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("updatedAt"), tv(d.profile.updatedAt)])))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("formats"), tv(joinList(d.profile.preferredFormats))])))
        ops.add(DbOp("INSERT INTO profile (k, v) VALUES (?, ?)", va([tv("selfScores"), tv(selfScoresJson(d.profile))])))

        ops.add(DbOp("DELETE FROM progress", ArrayList<DbValue>()))
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
