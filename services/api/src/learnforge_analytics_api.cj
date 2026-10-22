package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*

/*
 * P2 batch 2: the two aggregate reads behind
 *   GET /api/v1/learner-profile
 *   GET /api/v1/learner-profile/journal
 *
 * Contract source (all of it):
 *   web/LearnerProfileController.java
 *   service/LearningAnalyticsService.java:126-312
 *   web/dto/LearnerProfileResponse.java, web/dto/LearningJournalResponse.java
 *   web/GlobalExceptionHandler.java
 *
 * The envelope is the same ApiResponse as batch 1 (learnforge_api.cj). Every
 * inner record has NO @JsonInclude, so null scalars are emitted, and the field
 * order is always the record component order.
 *
 * Three behaviours live in the service rather than the repository and are the
 * easy things to lose here:
 *
 *   1. Two different "today". StudyStatsInfo and calculateGoalProgress ask for
 *      LocalDate.now(ZoneOffset.UTC); getJournal asks for
 *      LocalDate.now(ZoneId.of("Asia/Shanghai")) when no ?date is given, and
 *      the journal window is that day's [00:00, next 00:00) in +08:00. The
 *      eventDistribution window is a third shape again: UTC midnight of
 *      today-30 through Instant.now().
 *
 *   2. calculateStreak: if the newest session is not today, the walk starts at
 *      yesterday, so a streak is "yesterday-or-earlier continuing into today"
 *      and a gap of one day still yields 0 if today has no session.
 *
 *   3. The journal timeline is not a single query. Events (DESC) skip
 *      QUIZ_SUBMIT and are laid down first, quizzes (ASC) are appended, then
 *      the whole list is stable-sorted by occurredAt ascending — so an event
 *      and a quiz at the same instant keep the event first, and ties inside
 *      each source keep that query's own order.
 */

public func registerLearnerProfileRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("api/v1/learner-profile") {
        ctx => handleGetLearnerProfile(ctx, cfg)
    }
    app.mapGet("api/v1/learner-profile/journal") {
        ctx => handleGetLearnerProfileJournal(ctx, cfg)
    }
}

/* ===================================================================
 * GET /api/v1/learner-profile
 * =================================================================== */

func handleGetLearnerProfile(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(userId) =>
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let store = LearnForgeStore(conn)
                        let analytics = LearnForgeAnalyticsStore(conn)
                        let data = buildProfileBody(store, analytics, userId)
                        conn.close()
                        writeJson(ctx.response, 200, apiOk(data))
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

func buildProfileBody(store: LearnForgeStore, analytics: LearnForgeAnalyticsStore,
                      userId: Array<Byte>): String {
    /* session_date 按 UTC+8 存储，统计窗口必须用同一时区，否则凌晨 0-8 点会漏掉今天 */
    let today = nowUtc8Date()
    let nowMicros = timePartsToEpochMicros(nowUtcParts())

    var profile: ?RawProfile = None
    match (store.getProfileByUser(userId)) {
        case Some(p) => profile = Some(p)
        case None => ()
    }

    /* getProfileInfo — never null; a missing row is an all-null ProfileInfo. */
    var edu: ?String = None
    var major: ?String = None
    var pref: ?String = None
    var tech: ?String = None
    match (profile) {
        case Some(p) =>
            edu = p.educationLevel
            major = p.major
            pref = p.learningPreference
            tech = p.technicalFoundation
        case None => ()
    }

    /* getCurrentGoalInfo — null when the row or the goal is absent. */
    var currentGoalJson = "null"
    match (profile) {
        case Some(p) =>
            match (p.currentGoalId) {
                case Some(goalId) =>
                    match (analytics.getGoalInfo(goalId)) {
                        case Some(g) => currentGoalJson = goalToJson(g, today)
                        case None => ()
                    }
                case None => ()
            }
        case None => ()
    }

    let w = JsonWriter()
    let pw = JsonWriter()
    pw.putOptStr("educationLevel", edu)
    pw.putOptStr("major", major)
    pw.putOptStr("learningPreference", pref)
    pw.putOptStr("technicalFoundation", tech)
    w.putRaw("profile", pw.toJson())
    w.putRaw("currentGoal", currentGoalJson)
    w.putRaw("stats", statsToJson(analytics, userId, today, nowMicros))
    w.putRaw("mastery", masteryToJson(analytics, userId))
    w.putRaw("recentQuizzes", recentQuizzesToJson(analytics, userId))
    return w.toJson()
}

/*
 * CurrentGoalInfo(title, goalType, expectedLevel, progress).
 *
 * title = knowledgeDomain == null ? goal.title : knowledgeDomain.getName().
 * domainId selects which branch: a NULL FK means use the title, a NULL name on
 * an existing domain is emitted as null.
 */
func goalToJson(g: RawGoalInfo, today: CivilDate): String {
    let w = JsonWriter()
    match (g.domainId) {
        case Some(_) => w.putOptStr("title", g.domainName)
        case None => w.putStr("title", g.title)
    }
    w.putStr("goalType", g.goalType)
    w.putStr("expectedLevel", g.expectedLevel)
    w.putRaw("progress", javaDoubleText(goalProgress(g, today)))
    return w.toJson()
}

/* calculateGoalProgress — all three early exits are exact. */
func goalProgress(g: RawGoalInfo, today: CivilDate): Float64 {
    if (g.status == "COMPLETED") {
        return 1.0
    }
    match (g.targetDate) {
        case None => return 0.0
        case Some(td) =>
            match (parseIsoLocalDate(td)) {
                case None => return 0.0
                case Some(target) =>
                    let created = isoInstantUtcDate(g.createdAtUtc)
                    let totalDays = daysBetween(created, target)
                    if (totalDays <= 0) {
                        return 0.0
                    }
                    let elapsed = daysBetween(created, today)
                    if (elapsed <= 0) {
                        return 0.0
                    }
                    let ratio = Float64(elapsed) / Float64(totalDays)
                    if (ratio >= 1.0) {
                        return 1.0
                    }
                    return ratio
            }
    }
}

/* goal.getCreatedAt().atZone(ZoneOffset.UTC).toLocalDate() */
func isoInstantUtcDate(text: String): CivilDate {
    let p = parseDbDatetime(text)
    CivilDate(p.year, p.month, p.day)
}

/*
 * StudyStatsInfo(totalStudyMinutes, totalDays, streakDays, weeklyMinutes,
 * studyDates, eventDistribution).
 *
 * today is LocalDate.now(ZoneOffset.UTC), not the user's zone — matching the
 * service. The 7-day and 60-day windows compare against session_date, a DATE
 * column, so no zone conversion happens on the way in.
 */
func statsToJson(analytics: LearnForgeAnalyticsStore,
                 userId: Array<Byte>, today: CivilDate, nowMicros: Int64): String {
    let totalDays = analytics.countSessions(userId)
    let totalSeconds = analytics.sumSessionSeconds(userId)
    /* 不足 1 分钟的零头按四舍五入计入，避免学了 30 秒仍显示 0 */
    let totalMinutes = (totalSeconds + 30) / 60
    let streak = calculateStreak(analytics, userId, today)

    /* weeklyMinutes: one bucket per day for today-6 .. today. */
    let weekSessions = analytics.listSessionsInRange(userId, addDays(today, -6), today)
    var weekMap = HashMap<String, Int64>()
    for (s in weekSessions) {
        weekMap.add(s.sessionDate, (s.totalDurationSeconds + 30) / 60)
    }
    let weekly = ArrayList<Int64>()
    var i: Int64 = 6
    while (i >= 0) {
        let d = dateIsoText(addDays(today, 0 - i))
        var v: Int64 = 0
        match (weekMap.get(d)) {
            case Some(x) => v = x
            case None => ()
        }
        weekly.add(v)
        i -= 1
    }

    /* studyDates: every session_date in [today-59, today], ASC, in order. */
    let calendarSessions = analytics.listSessionsInRange(userId, addDays(today, -59), today)
    let dates = JsonArrWriter()
    for (s in calendarSessions) {
        dates.addRaw(jsonQuote(s.sessionDate))
    }

    /* eventDistribution — LinkedHashMap insertion order, i.e. the query order. */
    let sources = analytics.listSourceCounts(userId, today, nowMicros)
    let dist = JsonWriter()
    for (c in sources) {
        dist.putInt(c.sourceType, c.count)
    }

    let w = JsonWriter()
    w.putInt("totalStudyMinutes", totalMinutes)
    w.putInt("totalDays", totalDays)
    w.putInt("streakDays", streak)
    w.putRaw("weeklyMinutes", weeklyArray(weekly))
    w.putRaw("studyDates", dates.toJson())
    w.putRaw("eventDistribution", dist.toJson())
    return w.toJson()
}

func weeklyArray(weekly: ArrayList<Int64>): String {
    let arr = JsonArrWriter()
    for (v in weekly) {
        arr.addRaw(v.toString())
    }
    arr.toJson()
}

/*
 * calculateStreak — walk the DESC-ordered session dates from the expected day.
 * A row later than `expected` is skipped without advancing it; a row earlier
 * than `expected` ends the walk, so a one-day gap stops the streak at 0 when
 * today has no session.
 */
func calculateStreak(analytics: LearnForgeAnalyticsStore, userId: Array<Byte>,
                     today: CivilDate): Int64 {
    let recent = analytics.listSessionDatesDesc(userId)
    if (recent.isEmpty()) {
        return 0
    }
    match (parseIsoLocalDate(recent[0])) {
        case None => return 0
        case Some(newest) =>
            var expected = today
            if (newest.year != today.year || newest.month != today.month || newest.day != today.day) {
                expected = addDays(today, 0 - 1)
            }
            var streak: Int64 = 0
            for (dText in recent) {
                match (parseIsoLocalDate(dText)) {
                    case None => break
                    case Some(d) =>
                        if (d.year == expected.year && d.month == expected.month && d.day == expected.day) {
                            streak += 1
                            expected = addDays(expected, 0 - 1)
                        } else if (daysBetween(d, expected) > 0) {
                            break
                        }
                }
            }
            return streak
    }
}

/*
 * MasteryInfo(overall, categories, strongPoints, weakPoints).
 *
 * overall = Math.round(average(score.doubleValue()) * 100) / 100.0, where the
 * average is a plain left-to-right double sum in row order (mastery_score DESC).
 * Empty → all zeros and empty lists.
 */
func masteryToJson(analytics: LearnForgeAnalyticsStore, userId: Array<Byte>): String {
    let rows = analytics.listMastery(userId)
    let w = JsonWriter()
    if (rows.isEmpty()) {
        w.putRaw("overall", "0.0")
        w.putRaw("categories", "[]")
        w.putRaw("strongPoints", "[]")
        w.putRaw("weakPoints", "[]")
        return w.toJson()
    }

    var sum: Float64 = 0.0
    var n: Int64 = 0
    for (r in rows) {
        match (javaDoubleFromText(r.scoreText)) {
            case Some(v) =>
                sum = sum + v
                n += 1
            case None => ()
        }
    }
    var avg: Float64 = 0.0
    if (n > 0) {
        avg = sum / Float64(n)
    }
    let overall = Float64(javaMathRound(avg * 100.0)) / 100.0

    let cats = JsonArrWriter()
    let strong = JsonArrWriter()
    let weak = JsonArrWriter()
    var strongCount: Int64 = 0
    var weakCount: Int64 = 0
    for (r in rows) {
        var score: Float64 = 0.0
        match (javaDoubleFromText(r.scoreText)) {
            case Some(v) => score = v
            case None => ()
        }
        let cw = JsonWriter()
        cw.putInt("id", r.categoryId)
        cw.putStr("name", r.categoryName)
        cw.putRaw("score", javaDoubleText(score))
        cw.putInt("attempts", r.attemptCount)
        cats.addRaw(cw.toJson())
        if (score >= 0.7 && strongCount < 5) {
            strong.addRaw(jsonQuote(r.categoryName))
            strongCount += 1
        }
        if (score < 0.4 && weakCount < 5) {
            weak.addRaw(jsonQuote(r.categoryName))
            weakCount += 1
        }
    }

    w.putRaw("overall", javaDoubleText(overall))
    w.putRaw("categories", cats.toJson())
    w.putRaw("strongPoints", strong.toJson())
    w.putRaw("weakPoints", weak.toJson())
    return w.toJson()
}

/*
 * recentQuizzes: top 10 by created_at DESC, each mapped to
 * QuizSummary(quizType, score.doubleValue() or null, categoryName or null,
 * createdAt.atZone(UTC).format(ISO_LOCAL_DATE_TIME)).
 */
func recentQuizzesToJson(analytics: LearnForgeAnalyticsStore, userId: Array<Byte>): String {
    let rows = analytics.listRecentQuizzes(userId)
    let arr = JsonArrWriter()
    for (r in rows) {
        let w = JsonWriter()
        w.putStr("id", r.idText)
        w.putStr("quizType", r.quizType)
        w.putInt("questionCount", r.questionCount)
        w.putInt("correctCount", r.correctCount)
        match (r.durationSeconds) {
            case Some(v) => w.putRaw("durationSeconds", v.toString())
            case None => w.putRaw("durationSeconds", "null")
        }
        w.putOptStr("difficultyLevel", r.difficultyLevel)
        w.putOptStr("details", r.details)
        match (r.scoreText) {
            case Some(t) =>
                match (javaDoubleFromText(t)) {
                    case Some(v) => w.putRaw("score", javaDoubleText(v))
                    case None => w.putRaw("score", "null")
                }
            case None => w.putRaw("score", "null")
        }
        w.putOptStr("categoryName", r.categoryName)
        /* created_at 由 MySQL 按会话时区（UTC+8）返回，和前端本地时区一致；
           这里输出无时区的本地时间，不能再补 Z，否则浏览器会再 +8 小时。 */
        w.putStr("createdAt", isoLocalDatetimeFromDb(r.createdAtUtc))
        arr.addRaw(w.toJson())
    }
    arr.toJson()
}

/* ===================================================================
 * GET /api/v1/learner-profile/journal
 * =================================================================== */

func handleGetLearnerProfileJournal(ctx: HttpContext, cfg: AppConfig): Unit {
    match (requireUserApi(ctx.request, ctx.response, cfg)) {
        case None => return
        case Some(userId) =>
            /*
             * @RequestParam(required = false) LocalDate date uses
             * DateTimeFormatter.ISO_LOCAL_DATE under STRICT resolution, so a
             * malformed value is a MethodArgumentTypeMismatchException and
             * GlobalExceptionHandler has no handler for it — the catch-all
             * Exception handler turns it into 500 / 1500 "服务器内部错误".
             */
            var target: CivilDate = nowUtc8Date()
            match (queryParam(ctx.request, "date")) {
                case None => ()
                case Some(raw) =>
                    match (parseIsoLocalDate(raw)) {
                        case None =>
                            writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                            return
                        case Some(d) => target = d
                    }
            }
            match (openDb(cfg)) {
                case None =>
                    writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                case Some(conn) =>
                    try {
                        let analytics = LearnForgeAnalyticsStore(conn)
                        let data = buildJournalBody(analytics, userId, target)
                        conn.close()
                        writeJson(ctx.response, 200, apiOk(data))
                    } catch (e: Exception) {
                        writeApiErr(ctx.response, 500, CODE_INTERNAL_ERROR, "服务器内部错误")
                    }
            }
    }
}

func buildJournalBody(analytics: LearnForgeAnalyticsStore, userId: Array<Byte>,
                      target: CivilDate): String {
    let events = analytics.listJournalEvents(userId, target)
    let quizzes = analytics.listJournalQuizzes(userId, target)

    /*
     * Build order matters: events DESC first (QUIZ_SUBMIT dropped), quizzes ASC
     * appended, then stable-sort by occurredAt ascending. Equal instants keep
     * the event before the quiz.
     */
    let items = ArrayList<TlItem>()
    for (e in events) {
        if (e.eventType != "QUIZ_SUBMIT") {
            let metadata = e.metadataJson
            let knowledgeName = metaText(metadata, "knowledgePoint")
            let kn: ?String = match (e.categoryName) {
                case Some(n) => Some(n)
                case None => knowledgeName
            }
            items.add(TlItem(
                uuidFormat(e.id),
                timePartsToEpochMicros(parseDbDatetime(e.createdAtUtc)),
                isoInstantFromDb(e.createdAtUtc),
                journalKind(e.eventType),
                eventTitle(e.eventType, metadata, kn),
                eventDescription(e.eventType, e.sourceType, e.durationSeconds, metadata),
                e.durationSeconds,
                kn,
                None,
                None))
        }
    }
    for (q in quizzes) {
        var wrong = q.questionCount - q.correctCount
        if (wrong < 0) {
            wrong = 0
        }
        let kn: ?String = q.categoryName
        let desc: ?String = match (q.difficultyLevel) {
            case Some(d) => Some("难度 · " + d)
            case None => Some("根据作答结果更新掌握情况")
        }
        items.add(TlItem(
            uuidFormat(q.id),
            timePartsToEpochMicros(parseDbDatetime(q.createdAtUtc)),
            isoInstantFromDb(q.createdAtUtc),
            "quiz",
            "完成一组分阶测试",
            desc,
            q.durationSeconds,
            kn,
            Some(q.correctCount),
            Some(wrong)))
    }

    let sorted = stableSortTl(items.toArray())

    /* JournalStats — computed over the raw rows, not the filtered timeline. */
    var focusSeconds: Int64 = 0
    var totalSeconds: Int64 = 0
    var resources: Int64 = 0
    for (e in events) {
        match (e.durationSeconds) {
            case Some(d) =>
                totalSeconds += d
                if (e.eventType == "STUDY_END") {
                    focusSeconds += d
                }
            case None => ()
        }
        if (e.eventType == "RESOURCE_VIEW") {
            resources += 1
        }
    }
    var questions: Int64 = 0
    var correct: Int64 = 0
    for (q in quizzes) {
        questions += q.questionCount
        correct += q.correctCount
    }
    var wrongTotal = questions - correct
    if (wrongTotal < 0) {
        wrongTotal = 0
    }

    /* knowledgeCount — distinct non-null knowledgeName over the TIMELINE. */
    var knowledge: Int64 = 0
    var seen = HashSet<String>()
    for (t in sorted) {
        match (t.knowledgeName) {
            case Some(n) =>
                if (!seen.contains(n)) {
                    seen.add(n)
                    knowledge += 1
                }
            case None => ()
        }
    }

    let timeline = JsonArrWriter()
    for (t in sorted) {
        let w = JsonWriter()
        w.putStr("id", t.id)
        w.putStr("occurredAt", t.occurredAtIso)
        w.putStr("kind", t.kind)
        w.putStr("title", t.title)
        w.putOptStr("description", t.description)
        w.putOptInt("durationSeconds", t.durationSeconds)
        w.putOptStr("knowledgeName", t.knowledgeName)
        w.putOptInt("correctCount", t.correctCount)
        w.putOptInt("wrongCount", t.wrongCount)
        timeline.addRaw(w.toJson())
    }

    var summaryJson = "null"
    match (analytics.getDailySummary(userId, target)) {
        case Some(s) =>
            let sw = JsonWriter()
            sw.putStr("content", s.content)
            sw.putStr("metricsJson", s.metricsJson)
            sw.putStr("generatedAt", isoInstantFromDb(s.generatedAtUtc))
            summaryJson = sw.toJson()
        case None => ()
    }

    let w = JsonWriter()
    w.putStr("date", dateIsoText(target))
    let stats = JsonWriter()
    stats.putInt("focusSeconds", focusSeconds)
    stats.putInt("totalDurationSeconds", totalSeconds)
    stats.putInt("resourceCount", resources)
    stats.putInt("knowledgeCount", knowledge)
    stats.putInt("questionCount", questions)
    stats.putInt("correctCount", correct)
    stats.putInt("wrongCount", wrongTotal)
    w.putRaw("stats", stats.toJson())
    w.putRaw("timeline", timeline.toJson())
    w.putRaw("summary", summaryJson)
    return w.toJson()
}

/* ---- timeline item + stable sort ---- */

/*
 * One timeline entry. `keyMicros` is the absolute instant of occurredAt, used
 * only for the sort; `occurredAtIso` is the already-formatted ISO_INSTANT.
 */
struct TlItem {
    let id: String
    let occurredAtIso: String
    let keyMicros: Int64
    let kind: String
    let title: String
    let description: ?String
    let durationSeconds: ?Int64
    let knowledgeName: ?String
    let correctCount: ?Int64
    let wrongCount: ?Int64

    init(id: String, keyMicros: Int64, occurredAtIso: String, kind: String,
         title: String, description: ?String, durationSeconds: ?Int64,
         knowledgeName: ?String, correctCount: ?Int64, wrongCount: ?Int64) {
        this.id = id
        this.occurredAtIso = occurredAtIso
        this.keyMicros = keyMicros
        this.kind = kind
        this.title = title
        this.description = description
        this.durationSeconds = durationSeconds
        this.knowledgeName = knowledgeName
        this.correctCount = correctCount
        this.wrongCount = wrongCount
    }
}

/*
 * Comparator.comparing(TimelineItem::occurredAt) is a stable ascending sort by
 * Instant. Java's List.sort is a TimSort; insertion sort with a strict
 * comparison has the same tie behaviour and is O(n^2) on what is at most one
 * day's timeline.
 */
func stableSortTl(items: Array<TlItem>): Array<TlItem> {
    let n = items.size
    var out = Array<TlItem>(n, repeat: TlItem("", 0, "", "", "", None, None, None, None, None))
    var i: Int64 = 0
    while (i < n) {
        out[i] = items[i]
        i += 1
    }
    var k: Int64 = 1
    while (k < n) {
        let cur = out[k]
        var j = k - 1
        while (j >= 0 && out[j].keyMicros > cur.keyMicros) {
            out[j + 1] = out[j]
            j -= 1
        }
        out[j + 1] = cur
        k += 1
    }
    return out
}

/* ---- metadata text, matching Jackson JsonNode ---- */

/*
 * text(metadata, field) — null when the key is missing or holds JSON null.
 *
 * Jackson's asText() maps a number to String.valueOf, a boolean to its
 * lower-case name, and an array or object to "" (the base JsonNode default).
 * Spire parses a JSON number as JsInt or JsFloat, so the float case goes
 * through javaDoubleText to reproduce Double.toString.
 */
func metaText(metadata: ?String, field: String): ?String {
    var raw = ""
    match (metadata) {
        case Some(t) => raw = t
        case None => return None
    }
    if (raw.trimAscii().size == 0) {
        return None
    }
    match (jsonParse(raw)) {
        case None => return None
        case Some(v) =>
            if (!isJsObject(v)) {
                /* ArrayNode/ValueNode.get(String) returns null. */
                return None
            }
            match (v.asObject().get(field)) {
                case None => return None
                case Some(fv) =>
                    match (fv.kind()) {
                        case JsonKind.JsNull => return None
                        case JsonKind.JsString => return Some(fv.asString().getValue())
                        case JsonKind.JsInt => return Some(fv.asInt().getValue().toString())
                        case JsonKind.JsFloat => return Some(javaDoubleText(fv.asFloat().getValue()))
                        case JsonKind.JsBool =>
                            return Some(if (fv.asBool().getValue()) { "true" } else { "false" })
                        case _ => return Some("")
                    }
            }
    }
}

/*
 * Optional.ofNullable(x).orElse(y) — y is only read when x is null, so a
 * present-but-blank "title" never falls through to "resourceTitle".
 */
func metaFallback(metadata: ?String, first: String, second: String): ?String {
    match (metaText(metadata, first)) {
        case Some(v) => return Some(v)
        case None => return metaText(metadata, second)
    }
}

func isBlankStr(s: String): Bool {
    s.trimAscii().size == 0
}

/* ---- event title / description / kind ---- */

func journalKind(eventType: String): String {
    if (eventType == "STUDY_START" || eventType == "STUDY_END") {
        return "focus"
    }
    if (eventType == "RESOURCE_VIEW") {
        return "resource"
    }
    if (eventType == "KP_MASTERY_CHECK") {
        return "knowledge"
    }
    if (eventType == "CHAT_INTERACTION") {
        return "chat"
    }
    return "quiz"
}

func eventTitle(eventType: String, metadata: ?String, knowledgeName: ?String): String {
    match (metaFallback(metadata, "title", "resourceTitle")) {
        case Some(s) =>
            if (!isBlankStr(s)) {
                return s
            }
        case None => ()
    }
    if (eventType == "STUDY_START") {
        return "开始专注"
    }
    if (eventType == "STUDY_END") {
        return "完成专注"
    }
    if (eventType == "RESOURCE_VIEW") {
        return "学习了一项资源"
    }
    if (eventType == "CHAT_INTERACTION") {
        return "进行交互导学"
    }
    if (eventType == "KP_MASTERY_CHECK") {
        match (knowledgeName) {
            case Some(n) => return "学习「" + n + "」"
            case None => return "复习知识点"
        }
    }
    return "完成测试"
}

func eventDescription(eventType: String, sourceType: String, duration: ?Int64,
                      metadata: ?String): ?String {
    match (metaFallback(metadata, "description", "action")) {
        case Some(s) =>
            if (!isBlankStr(s)) {
                return Some(s)
            }
        case None => ()
    }
    match (duration) {
        case Some(d) =>
            if (d > 0) {
                var mins = d / 60
                if (mins < 1) {
                    mins = 1
                }
                return Some("持续 " + mins.toString() + " 分钟")
            }
        case None => ()
    }
    if (sourceType == "CHAT") {
        return Some("围绕当前领域提问与交流")
    }
    if (sourceType == "RESOURCE") {
        return Some("打开并学习个性化资源")
    }
    if (sourceType == "KNOWLEDGE_BASE") {
        return Some("浏览知识库内容")
    }
    if (sourceType == "QUIZ") {
        return Some("完成题目并更新掌握情况")
    }
    return Some("完成一段学习流程")
}

/* ---- strict ISO_LOCAL_DATE parser ---- */

/*
 * DateTimeFormatter.ISO_LOCAL_DATE under STRICT resolution: exactly
 * "uuuu-MM-dd" with the pad widths enforced (4-digit year, 2-digit month, 2-digit
 * day) and the calendar day validated. Anything else — "notadate",
 * "2026-13-01", "2026-02-30", "2026-1-1", "2026-10-18T00:00:00", "" — fails
 * and the request becomes a 500.
 */
func parseIsoLocalDate(s: String): ?CivilDate {
    let rs = s.toRuneArray()
    if (rs.size != 10) {
        return None
    }
    if (rs[4].toString() != "-" || rs[7].toString() != "-") {
        return None
    }
    var i: Int64 = 0
    while (i < 10) {
        if (i != 4 && i != 7 && !isAsciiDigitRune(rs[i])) {
            return None
        }
        i += 1
    }
    let y = Int64.tryParse(runeString(rs, 0, 4)) ?? 0
    let m = Int64.tryParse(runeString(rs, 5, 2)) ?? 0
    let d = Int64.tryParse(runeString(rs, 8, 2)) ?? 0
    if (m < 1 || m > 12 || d < 1) {
        return None
    }
    if (d > daysInMonthLocal(y, m)) {
        return None
    }
    return Some(CivilDate(y, m, d))
}

func runeString(rs: Array<Rune>, start: Int64, len: Int64): String {
    var s = ""
    var i: Int64 = 0
    while (i < len) {
        s = s + rs[(start + i)].toString()
        i += 1
    }
    s
}

/* daysInMonth in time_util.cj is file-private; this is the same rule. */
func daysInMonthLocal(year: Int64, month: Int64): Int64 {
    if (month == 2) {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        return if (leap) { 29 } else { 28 }
    }
    if (month == 4 || month == 6 || month == 9 || month == 11) {
        return 30
    }
    return 31
}
