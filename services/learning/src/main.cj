package zhixun_learning

import std.collection.*
import std.convert.*
import std.core.*
import std.env.*
import std.fs.*
import std.sync.*
import stdx.encoding.json.*
import soulsoft_web_http.*
import soulsoft_web_hosting.*
import soulsoft_extensions_injection.*
import soulsoft_web_routing.*

struct Config {
    let host: String
    let port: UInt16
    let user: String
    let password: String
    let database: String
    let listen: String
    let authSecret: String
    let smtpHost: String
    let smtpPort: UInt16
    let smtpUser: String
    let smtpPassword: String
    let emailFrom: String
    let emailFromName: String
    let subjectPrefix: String

    init(host: String, port: UInt16, user: String, password: String, database: String, listen: String,
         authSecret: String, smtpHost: String, smtpPort: UInt16, smtpUser: String,
         smtpPassword: String, emailFrom: String, emailFromName: String, subjectPrefix: String) {
        this.host = host
        this.port = port
        this.user = user
        this.password = password
        this.database = database
        this.listen = listen
        this.authSecret = authSecret
        this.smtpHost = smtpHost
        this.smtpPort = smtpPort
        this.smtpUser = smtpUser
        this.smtpPassword = smtpPassword
        this.emailFrom = emailFrom
        this.emailFromName = emailFromName
        this.subjectPrefix = subjectPrefix
    }
}

func envOr(name: String, fallback: String): String {
    match (getVariable(name)) {
        case Some(value) => if (value.trimAscii().size > 0) { value } else { fallback }
        case None => fallback
    }
}

func loadConfig(): Config {
    let database = envOr("ZHIXUN_DB_NAME", "")
    if (database != "itn_learning_v2_dev") {
        throw Exception("Refusing to start outside the isolated itn_learning_v2_dev database")
    }
    Config(
        envOr("ZHIXUN_DB_HOST", "127.0.0.1"),
        UInt16(Int64.parse(envOr("ZHIXUN_DB_PORT", "3306"))),
        envOr("ZHIXUN_DB_USER", ""),
        envOr("ZHIXUN_DB_PASSWORD", ""),
        database,
        envOr("ZHIXUN_API_LISTEN", "http://127.0.0.1:8312"),
        envOr("ZHIXUN_AUTH_SECRET", ""),
        envOr("SMTP_HOST", ""),
        UInt16(Int64.parse(envOr("SMTP_PORT", "465"))),
        envOr("SMTP_USERNAME", ""),
        envOr("SMTP_PASSWORD", ""),
        envOr("EMAIL_FROM", envOr("SMTP_USERNAME", "")),
        envOr("MAIL_FROM_NAME", "智训云枢"),
        envOr("MAIL_SUBJECT_PREFIX", "[ITN]")
    )
}

func connect(cfg: Config): MyConnection {
    MyConnection.connect(cfg.host, cfg.port, cfg.user, cfg.password, cfg.database)
}

let databaseLock = Mutex()
var sharedDatabase: ?MyConnection = None

func openShared(cfg: Config): MyConnection {
    match (sharedDatabase) {
        case Some(connection) => connection
        case None =>
            let connection = connect(cfg)
            sharedDatabase = Some(connection)
            connection
    }
}

func discardShared(): Unit {
    match (sharedDatabase) {
        case Some(connection) =>
            try { connection.close() } catch (_: Exception) {}
            sharedDatabase = None
        case None => ()
    }
}

class Row {
    let cells: Array<MyCell>
    let indexes: HashMap<String, Int64>

    init(columns: Array<String>, cells: Array<MyCell>) {
        this.cells = cells
        this.indexes = HashMap<String, Int64>()
        var i: Int64 = 0
        while (i < columns.size) {
            indexes[columns[i]] = i
            i += 1
        }
    }

    func text(name: String): String {
        match (indexes.get(name)) {
            case Some(index) => if (cells[index].isNull) { "" } else { cells[index].text() }
            case None => ""
        }
    }

    func int(name: String): Int64 {
        Int64.tryParse(text(name)) ?? 0
    }

    func isNull(name: String): Bool {
        match (indexes.get(name)) {
            case Some(index) => cells[index].isNull
            case None => true
        }
    }
}

func rowsOf(outcome: QueryOutcome): Array<Row> {
    match (outcome) {
        case Ok(_) => ArrayList<Row>().toArray()
        case ResultSet(rs) =>
            let out = ArrayList<Row>()
            for (cells in rs.rows) { out.add(Row(rs.columns, cells)) }
            out.toArray()
    }
}

func query(cfg: Config, sql: String): Array<Row> {
    databaseLock.lock()
    try {
        try {
            rowsOf(openShared(cfg).query(sql))
        } catch (error: Exception) {
            discardShared()
            rowsOf(openShared(cfg).query(sql))
        }
    } finally { databaseLock.unlock() }
}

/** Bulk source reads must not hold the connection used by login and small requests. */
func queryIndependent(cfg: Config, sql: String): Array<Row> {
    let connection = connect(cfg)
    try { rowsOf(connection.query(sql)) } finally { connection.close() }
}

func ignoreOk(outcome: QueryOutcome): Unit {
    match (outcome) {
        case Ok(_) => ()
        case ResultSet(_) => throw Exception("Expected a write statement")
    }
}

func execute(cfg: Config, sql: String): Unit {
    databaseLock.lock()
    try {
        try {
            ignoreOk(openShared(cfg).query(sql))
        } catch (error: Exception) {
            discardShared()
            ignoreOk(openShared(cfg).query(sql))
        }
    } finally { databaseLock.unlock() }
}

func transaction(cfg: Config, statements: Array<String>): Unit {
    databaseLock.lock()
    try {
        let conn = openShared(cfg)
        ignoreOk(conn.query("START TRANSACTION"))
        try {
            for (sql in statements) { ignoreOk(conn.query(sql)) }
            ignoreOk(conn.query("COMMIT"))
        } catch (error: Exception) {
            try { ignoreOk(conn.query("ROLLBACK")) } catch (_: Exception) {}
            discardShared()
            throw error
        }
    } finally { databaseLock.unlock() }
}

func writeError(response: HttpResponse, status: UInt16, message: String): Unit {
    let out = JsonWriter()
    out.putStr("message", message)
    writeJson(response, status, out.toJson())
}

func parseObject(request: HttpRequest): ?JsonObject {
    let text = readBodyText(request)
    if (text.trimAscii().size == 0) { return Some(JsonObject()) }
    match (jsonParse(text)) {
        case Some(value) =>
            match (value.kind()) {
                case JsonKind.JsObject => Some(value.asObject())
                case _ => None
            }
        case None => None
    }
}

func routeText(ctx: HttpContext, name: String): String {
    match (ctx.request.routeValues.get(name)) {
        case Some(value) => value
        case None => ""
    }
}

func tokenHash(token: String): String {
    bytesToHex(sha256Bytes(token.toArray()))
}

func authenticate(ctx: HttpContext, cfg: Config): ?String {
    let authorization = match (ctx.request.headers.get("Authorization")) {
        case Some(value) => value
        case None => ""
    }
    if (!authorization.startsWith("Bearer ")) {
        writeError(ctx.response, 401, "请先建立学习会话")
        return None
    }
    let token = authorization[7..authorization.size].trimAscii()
    if (token.size < 20 || token.size > 200) {
        writeError(ctx.response, 401, "学习会话无效")
        return None
    }
    let rows = query(cfg,
        "SELECT s.user_id FROM user_sessions s WHERE s.token_hash=" +
        sqlQuote(tokenHash(token)) + " AND s.expires_at>NOW(6) LIMIT 1")
    if (rows.size == 0) {
        writeError(ctx.response, 401, "学习会话已失效，请重试")
        return None
    }
    Some(rows[0].text("user_id"))
}

func progressMap(cfg: Config, userId: String, courseId: ?String): HashMap<String, Bool> {
    let result = HashMap<String, Bool>()
    var filterSql = " WHERE user_id=" + sqlQuote(userId)
    if (courseId != None) { filterSql = filterSql + " AND course_id=" + sqlQuote(courseId.getOrThrow()) }
    let progressRows = query(cfg, "SELECT course_id,lesson_index,completed FROM lesson_progress" + filterSql)
    for (row in progressRows) {
        result[row.text("course_id") + ":" + row.int("lesson_index").toString()] = row.int("completed") == 1
    }
    result
}

func courseJson(row: Row, progress: HashMap<String, Bool>): String {
    let out = JsonWriter()
    out.putStr("id", row.text("id"))
    out.putStr("name", row.text("name"))
    out.putStr("icon", row.text("icon"))
    out.putStr("description", row.text("description"))
    out.putStr("level", row.text("level"))
    out.putInt("duration", row.int("duration"))
    out.putStr("sourceLabel", row.text("source_label"))
    let chapters = JsonArrWriter()
    match (jsonParse(row.text("chapters_json"))) {
        case Some(value) =>
            match (value.kind()) {
                case JsonKind.JsArray =>
                    let arr = value.asArray()
                    var i: Int64 = 0
                    while (i < arr.size()) {
                        match (arr[i].kind()) {
                            case JsonKind.JsObject =>
                                let chapter = arr[i].asObject()
                                let chapterOut = JsonWriter()
                                chapterOut.putStr("title", jsonGetString(chapter, "title") ?? "未命名课时")
                                chapterOut.putInt("index", i)
                                chapterOut.putBool("done", progress.get(row.text("id") + ":" + i.toString()) ?? false)
                                chapters.addRaw(chapterOut.toJson())
                            case _ => ()
                        }
                        i += 1
                    }
                case _ => ()
            }
        case None => ()
    }
    out.putRaw("chapters", chapters.toJson())
    out.toJson()
}

func courseArrayBody(cfg: Config, userId: String): String {
    let progress = progressMap(cfg, userId, None)
    let courseRows = query(cfg,
        "SELECT id,name,icon,description,level,duration,chapters_json,source_label FROM courses " +
        "WHERE status='published' ORDER BY sort_order,name")
    let arr = JsonArrWriter()
    for (row in courseRows) { arr.addRaw(courseJson(row, progress)) }
    arr.toJson()
}

func coursesBody(cfg: Config, userId: String): String {
    let out = JsonWriter()
    out.putRaw("courses", courseArrayBody(cfg, userId))
    out.toJson()
}

func stateBody(cfg: Config, userId: String): (String, String) {
    let stateRows = query(cfg,
        "SELECT favorites_json,bookmarks_json FROM user_state WHERE user_id=" + sqlQuote(userId))
    if (stateRows.size == 0) { return ("[]", "[]") }
    let favorites = if (stateRows[0].text("favorites_json").size > 0) { stateRows[0].text("favorites_json") } else { "[]" }
    let bookmarks = if (stateRows[0].text("bookmarks_json").size > 0) { stateRows[0].text("bookmarks_json") } else { "[]" }
    (favorites, bookmarks)
}

func profileBody(cfg: Config, userId: String): String {
    let profileRows = query(cfg, "SELECT profile_json FROM users WHERE id=" + sqlQuote(userId))
    if (profileRows.size == 0 || profileRows[0].isNull("profile_json")) { return "null" }
    let value = profileRows[0].text("profile_json")
    if (value.size == 0) { "null" } else { value }
}

func statsBody(cfg: Config, userId: String): String {
    let done = query(cfg,
        "SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END),0) complete_count, " +
        "COALESCE(SUM(CASE WHEN score IS NOT NULL THEN score ELSE 0 END),0) total_score " +
        "FROM lesson_progress WHERE user_id=" + sqlQuote(userId))
    let total = query(cfg, "SELECT COUNT(*) n FROM lessons")
    let out = JsonWriter()
    out.putInt("learningDays", if (done.size > 0 && done[0].int("n") > 0) { 1 } else { 0 })
    out.putInt("completedTasks", if (done.size > 0) { done[0].int("complete_count") } else { 0 })
    out.putInt("totalLessons", if (total.size > 0) { total[0].int("n") } else { 0 })
    out.putInt("totalScore", if (done.size > 0) { done[0].int("total_score") } else { 0 })
    out.toJson()
}

func recentBody(cfg: Config, userId: String): String {
    let recentRows = query(cfg,
        "SELECT p.course_id,p.lesson_index,p.updated_at,l.title " +
        "FROM lesson_progress p JOIN lessons l ON l.course_id=p.course_id AND l.lesson_index=p.lesson_index " +
        "WHERE p.user_id=" + sqlQuote(userId) + " ORDER BY p.updated_at DESC LIMIT 5")
    let arr = JsonArrWriter()
    for (row in recentRows) {
        let out = JsonWriter()
        out.putStr("courseId", row.text("course_id"))
        out.putInt("lessonIndex", row.int("lesson_index"))
        out.putStr("title", row.text("title"))
        out.putStr("time", row.text("updated_at"))
        arr.addRaw(out.toJson())
    }
    arr.toJson()
}

func lessonQuestions(raw: String): JsonArray {
    match (jsonParse(raw)) {
        case Some(value) =>
            match (value.kind()) {
                case JsonKind.JsArray => value.asArray()
                case _ => JsonArray()
            }
        case None => JsonArray()
    }
}

func publicQuestion(raw: JsonValue): String {
    let out = JsonWriter()
    match (raw.kind()) {
        case JsonKind.JsObject =>
            let question = raw.asObject()
            out.putStr("id", jsonGetString(question, "id") ?? "")
            out.putStr("question", jsonGetString(question, "question") ?? "")
            out.putRaw("options", jsonGetArray(question, "options")?.toJsonString() ?? "[]")
            out.putStr("theoryTitle", jsonGetString(question, "theoryTitle") ?? "核心概念")
        case _ => ()
    }
    out.toJson()
}

func courseLesson(cfg: Config, courseId: String, index: Int64): ?Row {
    let lessonRows = query(cfg,
        "SELECT l.course_id,l.lesson_index,l.title,l.content_json,l.quiz_json,l.sources_json FROM lessons l " +
        "JOIN courses c ON c.id=l.course_id WHERE l.course_id=" +
        sqlQuote(courseId) + " AND l.lesson_index=" + index.toString() + " AND c.status='published'")
    if (lessonRows.size == 0) { return None }
    Some(lessonRows[0])
}

func progressJson(cfg: Config, userId: String, courseId: String, index: Int64): String {
    let progressRows = query(cfg,
        "SELECT is_read,score,completed,updated_at FROM lesson_progress WHERE user_id=" + sqlQuote(userId) +
        " AND course_id=" + sqlQuote(courseId) + " AND lesson_index=" + index.toString())
    let out = JsonWriter()
    if (progressRows.size == 0) {
        out.putBool("read", false)
        out.putOptInt("score", None)
        out.putBool("completed", false)
    } else {
        out.putBool("read", progressRows[0].int("is_read") == 1)
        out.putOptInt("score", if (progressRows[0].isNull("score")) { None } else { Some(progressRows[0].int("score")) })
        out.putBool("completed", progressRows[0].int("completed") == 1)
        out.putStr("updatedAt", progressRows[0].text("updated_at"))
    }
    out.toJson()
}

func questionById(raw: JsonArray, id: String): ?JsonObject {
    var i: Int64 = 0
    while (i < raw.size()) {
        let question = raw[i]
        match (question.kind()) {
            case JsonKind.JsObject =>
                let object = question.asObject()
                if ((jsonGetString(object, "id") ?? "") == id) { return Some(object) }
            case _ => ()
        }
        i += 1
    }
    None
}

func passwordDigest(salt: String, password: String): String {
    bytesToHex(sha256Bytes((salt + ":" + password).toArray()))
}

func codeDigest(cfg: Config, email: String, purpose: String, code: String): String {
    bytesToHex(sha256Bytes((email + ":" + purpose + ":" + code + ":" + cfg.authSecret).toArray()))
}

func issueSession(cfg: Config, userId: String, displayName: String, profile: String): String {
    let token = uuidFormat(uuidV4())
    execute(cfg,
        "INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES(" +
        sqlQuote(tokenHash(token)) + "," + sqlQuote(userId) + ",DATE_ADD(NOW(6),INTERVAL 30 DAY))")
    let out = JsonWriter()
    out.putStr("token", token)
    out.putStr("userId", userId)
    out.putStr("displayName", displayName)
    out.putRaw("profile", profile)
    out.toJson()
}

func choiceOf(question: JsonObject): Int64 {
    jsonGetInt(question, "correct") ?? 0
}

func optionsCount(question: JsonObject): Int64 {
    match (jsonGetArray(question, "options")) {
        case Some(options) => options.size()
        case None => 0
    }
}

func gradeAnswer(question: JsonObject, choice: Int64): String {
    let correctIndex = choiceOf(question)
    let out = JsonWriter()
    out.putBool("correct", choice == correctIndex)
    out.putInt("correctIndex", correctIndex)
    out.putStr("explanation", jsonGetString(question, "explanation") ?? "请结合讲义中的定义与场景判断。")
    out.toJson()
}

func quizResult(raw: JsonArray, answers: JsonArray): (Int64, Int64) {
    var correct: Int64 = 0
    var i: Int64 = 0
    while (i < answers.size()) {
        let answer = answers[i]
        match (answer.kind()) {
            case JsonKind.JsObject =>
                let object = answer.asObject()
                let id = jsonGetString(object, "questionId") ?? ""
                let choice = jsonGetInt(object, "choice") ?? -1
                match (questionById(raw, id)) {
                    case Some(question) => if (choice == choiceOf(question)) { correct += 1 }
                    case None => ()
                }
            case _ => ()
        }
        i += 1
    }
    (correct, raw.size())
}

func saveProgress(cfg: Config, userId: String, courseId: String, index: Int64, score: ?Int64, completed: Bool): Unit {
    let scoreSql = match (score) {
        case Some(value) => value.toString()
        case None => "NULL"
    }
    execute(cfg,
        "INSERT INTO lesson_progress(user_id,course_id,lesson_index,is_read,score,completed,updated_at) VALUES(" +
        sqlQuote(userId) + "," + sqlQuote(courseId) + "," + index.toString() + ",1," + scoreSql + "," +
        (if (completed) { "1" } else { "0" }) + ",NOW(6)) ON DUPLICATE KEY UPDATE " +
        "is_read=1,score=" + (if (score == None) { "score" } else { "VALUES(score)" }) +
        ",completed=GREATEST(completed,VALUES(completed)),updated_at=NOW(6)")
}

func maxInt(a: Int64, b: Int64): Int64 {
    if (a > b) { a } else { b }
}

func jsonArrayFromText(text: String): JsonArray {
    match (jsonParse(text)) {
        case Some(value) =>
            match (value.kind()) {
                case JsonKind.JsArray => value.asArray()
                case _ => JsonArray()
            }
        case None => JsonArray()
    }
}

/* ---------- admin console ---------- */

func adminUserId(ctx: HttpContext, cfg: Config): ?String {
    let authorization = match (ctx.request.headers.get("Authorization")) {
        case Some(value) => value
        case None => ""
    }
    if (!authorization.startsWith("Bearer ")) {
        writeError(ctx.response, 401, "请先登录管理端")
        return None
    }
    let token = authorization[7..authorization.size].trimAscii()
    if (token.size < 20 || token.size > 200) {
        writeError(ctx.response, 401, "管理会话无效")
        return None
    }
    let rows = query(cfg,
        "SELECT s.user_id,u.role FROM user_sessions s JOIN users u ON u.id=s.user_id " +
        "WHERE s.token_hash=" + sqlQuote(tokenHash(token)) + " AND s.expires_at>NOW(6) LIMIT 1")
    if (rows.size == 0) {
        writeError(ctx.response, 401, "管理会话已失效，请重新登录")
        return None
    }
    if (rows[0].text("role") != "admin") {
        writeError(ctx.response, 403, "该账号没有管理权限")
        return None
    }
    Some(rows[0].text("user_id"))
}

func validCourseSlug(value: String): Bool {
    if (value.size < 2 || value.size > 40) { return false }
    let bytes = value.toArray()
    var i: Int64 = 0
    while (i < bytes.size) {
        let code = Int64(bytes[i])
        let allowed = (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code == 45 || code == 95
        if (!allowed) { return false }
        i += 1
    }
    true
}

func adminStatusOk(value: String): Bool {
    if (value == "published") { return true }
    value == "draft"
}

func adminCourseSelect(): String {
    "SELECT c.id,c.name,c.icon,c.description,c.level,c.duration,c.source_label,c.status,c.sort_order," +
    "COALESCE(DATE_FORMAT(c.updated_at,'%Y-%m-%d %H:%i'),'') updated_at," +
    "(SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id) lesson_count," +
    "(SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id AND JSON_LENGTH(l.quiz_json)>0) quiz_lesson_count " +
    "FROM courses c "
}

func adminCourseJson(row: Row): String {
    let out = JsonWriter()
    out.putStr("id", row.text("id"))
    out.putStr("name", row.text("name"))
    out.putStr("icon", row.text("icon"))
    out.putStr("description", row.text("description"))
    out.putStr("level", row.text("level"))
    out.putInt("duration", row.int("duration"))
    out.putStr("sourceLabel", row.text("source_label"))
    out.putStr("status", row.text("status"))
    out.putInt("sortOrder", row.int("sort_order"))
    out.putInt("lessonCount", row.int("lesson_count"))
    out.putInt("quizLessonCount", row.int("quiz_lesson_count"))
    out.putStr("updatedAt", row.text("updated_at"))
    out.toJson()
}

func adminCoursesBody(cfg: Config): String {
    let rows = query(cfg, adminCourseSelect() + "ORDER BY c.sort_order,c.name")
    let arr = JsonArrWriter()
    for (row in rows) { arr.addRaw(adminCourseJson(row)) }
    arr.toJson()
}

func adminCourseBody(cfg: Config, courseId: String): ?String {
    let rows = query(cfg, adminCourseSelect() + "WHERE c.id=" + sqlQuote(courseId) + " LIMIT 1")
    if (rows.size == 0) { return None }
    let lessons = query(cfg,
        "SELECT lesson_index,title,JSON_LENGTH(quiz_json) question_count," +
        "JSON_LENGTH(content_json,'$.sections') section_count," +
        "COALESCE(DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i'),'') updated_at " +
        "FROM lessons WHERE course_id=" + sqlQuote(courseId) + " ORDER BY lesson_index")
    let lessonArr = JsonArrWriter()
    for (row in lessons) {
        let item = JsonWriter()
        item.putInt("index", row.int("lesson_index"))
        item.putStr("title", row.text("title"))
        item.putInt("questionCount", row.int("question_count"))
        item.putInt("sectionCount", row.int("section_count"))
        item.putStr("updatedAt", row.text("updated_at"))
        lessonArr.addRaw(item.toJson())
    }
    let out = JsonWriter()
    out.putRaw("course", adminCourseJson(rows[0]))
    out.putRaw("lessons", lessonArr.toJson())
    out.toJson()
}

func adminLessonBody(cfg: Config, courseId: String, index: Int64): ?String {
    let rows = query(cfg,
        "SELECT title,content_json,quiz_json,sources_json," +
        "COALESCE(DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i'),'') updated_at " +
        "FROM lessons WHERE course_id=" + sqlQuote(courseId) + " AND lesson_index=" + index.toString())
    if (rows.size == 0) { return None }
    let out = JsonWriter()
    out.putStr("courseId", courseId)
    out.putInt("lessonIndex", index)
    out.putStr("title", rows[0].text("title"))
    out.putStr("contentJson", rows[0].text("content_json"))
    out.putStr("quizJson", rows[0].text("quiz_json"))
    out.putStr("sourcesJson", rows[0].text("sources_json"))
    out.putStr("updatedAt", rows[0].text("updated_at"))
    out.toJson()
}

func adminOverviewBody(cfg: Config): String {
    let users = query(cfg,
        "SELECT COUNT(*) total," +
        "COALESCE(SUM(CASE WHEN profile_json IS NULL THEN 0 ELSE 1 END),0) profiled," +
        "COALESCE(SUM(CASE WHEN created_at>DATE_SUB(NOW(6),INTERVAL 7 DAY) THEN 1 ELSE 0 END),0) recent " +
        "FROM users WHERE role<>'admin'")
    let courses = query(cfg,
        "SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status='published' THEN 1 ELSE 0 END),0) published FROM courses")
    let lessons = query(cfg, "SELECT COUNT(*) total FROM lessons")
    let attempts = query(cfg,
        "SELECT COUNT(*) total,COALESCE(ROUND(AVG(score)),0) average," +
        "COALESCE(SUM(CASE WHEN created_at>DATE_SUB(NOW(6),INTERVAL 7 DAY) THEN 1 ELSE 0 END),0) recent " +
        "FROM quiz_attempts")
    let learning = query(cfg,
        "SELECT COALESCE(SUM(CASE WHEN completed=1 THEN 1 ELSE 0 END),0) completed," +
        "COUNT(DISTINCT CASE WHEN updated_at>DATE_SUB(NOW(6),INTERVAL 7 DAY) THEN user_id END) active_users " +
        "FROM lesson_progress")
    let userOut = JsonWriter()
    userOut.putInt("total", if (users.size > 0) { users[0].int("total") } else { 0 })
    userOut.putInt("profiled", if (users.size > 0) { users[0].int("profiled") } else { 0 })
    userOut.putInt("recent", if (users.size > 0) { users[0].int("recent") } else { 0 })
    let courseOut = JsonWriter()
    courseOut.putInt("total", if (courses.size > 0) { courses[0].int("total") } else { 0 })
    courseOut.putInt("published", if (courses.size > 0) { courses[0].int("published") } else { 0 })
    let lessonOut = JsonWriter()
    lessonOut.putInt("total", if (lessons.size > 0) { lessons[0].int("total") } else { 0 })
    let attemptOut = JsonWriter()
    attemptOut.putInt("total", if (attempts.size > 0) { attempts[0].int("total") } else { 0 })
    attemptOut.putInt("averageScore", if (attempts.size > 0) { attempts[0].int("average") } else { 0 })
    attemptOut.putInt("recent", if (attempts.size > 0) { attempts[0].int("recent") } else { 0 })
    let learningOut = JsonWriter()
    learningOut.putInt("completed", if (learning.size > 0) { learning[0].int("completed") } else { 0 })
    learningOut.putInt("activeUsers", if (learning.size > 0) { learning[0].int("active_users") } else { 0 })
    let out = JsonWriter()
    out.putRaw("users", userOut.toJson())
    out.putRaw("courses", courseOut.toJson())
    out.putRaw("lessons", lessonOut.toJson())
    out.putRaw("quiz", attemptOut.toJson())
    out.putRaw("learning", learningOut.toJson())
    out.toJson()
}

func adminUsersBody(cfg: Config): String {
    let rows = query(cfg,
        "SELECT u.id,u.login_key,u.display_name,u.created_at," +
        "CASE WHEN u.profile_json IS NULL THEN 0 ELSE 1 END has_profile," +
        "COUNT(p.lesson_index) progress_count," +
        "COALESCE(SUM(CASE WHEN p.completed=1 THEN 1 ELSE 0 END),0) completed_count," +
        "COALESCE(ROUND(AVG(p.score)),0) average_score," +
        "COALESCE(DATE_FORMAT(MAX(p.updated_at),'%Y-%m-%d %H:%i'),'') last_active " +
        "FROM users u LEFT JOIN lesson_progress p ON p.user_id=u.id " +
        "WHERE u.role<>'admin' GROUP BY u.id,u.login_key,u.display_name,u.created_at,u.profile_json " +
        "ORDER BY u.created_at DESC LIMIT 200")
    let arr = JsonArrWriter()
    for (row in rows) {
        let item = JsonWriter()
        item.putStr("id", row.text("id"))
        item.putStr("account", row.text("login_key"))
        item.putStr("displayName", row.text("display_name"))
        item.putBool("profiled", row.int("has_profile") == 1)
        item.putInt("progressCount", row.int("progress_count"))
        item.putInt("completedCount", row.int("completed_count"))
        item.putInt("averageScore", row.int("average_score"))
        item.putStr("lastActive", row.text("last_active"))
        item.putStr("createdAt", row.text("created_at"))
        arr.addRaw(item.toJson())
    }
    arr.toJson()
}

func chaptersArray(cfg: Config, courseId: String): JsonArray {
    let rows = query(cfg, "SELECT chapters_json FROM courses WHERE id=" + sqlQuote(courseId))
    if (rows.size == 0) { return JsonArray() }
    match (jsonParse(rows[0].text("chapters_json"))) {
        case Some(value) =>
            match (value.kind()) {
                case JsonKind.JsArray => return value.asArray()
                case _ => return JsonArray()
            }
        case None => return JsonArray()
    }
}

func chapterTitles(cfg: Config, courseId: String): Array<String> {
    let chapters = chaptersArray(cfg, courseId)
    let titles = ArrayList<String>()
    var i: Int64 = 0
    while (i < chapters.size()) {
        let item = chapters[i]
        var title = "未命名课时"
        match (item.kind()) {
            case JsonKind.JsObject =>
                match (jsonGetString(item.asObject(), "title")) {
                    case Some(value) => title = value
                    case None => ()
                }
            case _ => ()
        }
        titles.add(title)
        i += 1
    }
    titles.toArray()
}

func chaptersJsonText(titles: Array<String>): String {
    let arr = JsonArrWriter()
    for (title in titles) {
        let item = JsonWriter()
        item.putStr("title", title)
        arr.addRaw(item.toJson())
    }
    arr.toJson()
}

func writeChapters(cfg: Config, courseId: String, titles: Array<String>): Unit {
    execute(cfg, "UPDATE courses SET chapters_json=" + sqlQuote(chaptersJsonText(titles)) +
        ",updated_at=NOW(6) WHERE id=" + sqlQuote(courseId))
}

func chapterTitlesRenamed(cfg: Config, courseId: String, index: Int64, title: String): Array<String> {
    let current = chapterTitles(cfg, courseId)
    let out = ArrayList<String>()
    var i: Int64 = 0
    while (i < current.size) {
        var value = current[i]
        if (i == index) { value = title }
        out.add(value)
        i += 1
    }
    if (index >= current.size) { out.add(title) }
    out.toArray()
}

func chapterTitlesAppended(cfg: Config, courseId: String, title: String): Array<String> {
    let current = chapterTitles(cfg, courseId)
    let out = ArrayList<String>()
    for (value in current) { out.add(value) }
    out.add(title)
    out.toArray()
}

func chapterTitlesWithoutLast(cfg: Config, courseId: String): Array<String> {
    let current = chapterTitles(cfg, courseId)
    let out = ArrayList<String>()
    var i: Int64 = 0
    while (i + 1 < current.size) {
        out.add(current[i])
        i += 1
    }
    out.toArray()
}

func validateLessonContent(raw: String): ?String {
    if (raw.size > 512000) { return Some("讲义内容过长，请拆分为多个课时") }
    match (jsonParse(raw)) {
        case None => return Some("讲义内容不是合法的 JSON")
        case Some(value) =>
            match (value.kind()) {
                case JsonKind.JsObject => return None
                case _ => return Some("讲义内容必须是 JSON 对象")
            }
    }
}

func validateLessonQuiz(raw: String): ?String {
    if (raw.size > 256000) { return Some("测验内容过长") }
    match (jsonParse(raw)) {
        case None => return Some("测验内容不是合法的 JSON")
        case Some(value) =>
            match (value.kind()) {
                case JsonKind.JsArray => ()
                case _ => return Some("测验内容必须是题目数组")
            }
            let quiz = value.asArray()
            var i: Int64 = 0
            while (i < quiz.size()) {
                let label = "第 " + (i + 1).toString() + " 题"
                match (quiz[i].kind()) {
                    case JsonKind.JsObject => ()
                    case _ => return Some(label + "格式不正确")
                }
                let question = quiz[i].asObject()
                if ((jsonGetString(question, "question") ?? "").trimAscii().size == 0) {
                    return Some(label + "缺少题干")
                }
                var options = JsonArray()
                match (jsonGetArray(question, "options")) {
                    case Some(list) => options = list
                    case None => return Some(label + "缺少选项")
                }
                if (options.size() < 2) { return Some(label + "至少需要两个选项") }
                var o: Int64 = 0
                while (o < options.size()) {
                    match (options[o].kind()) {
                        case JsonKind.JsString => ()
                        case _ => return Some(label + "的选项必须是文字")
                    }
                    o += 1
                }
                var correct: Int64 = 0
                match (jsonGetInt(question, "correct")) {
                    case Some(number) => correct = number
                    case None => return Some(label + "未设置正确答案")
                }
                if (correct < 0 || correct >= options.size()) {
                    return Some(label + "的正确答案超出选项范围")
                }
                i += 1
            }
            return None
    }
}

func validateLessonSources(raw: String): ?String {
    if (raw.size > 128000) { return Some("来源标注过长") }
    match (jsonParse(raw)) {
        case None => return Some("来源标注不是合法的 JSON")
        case Some(value) =>
            match (value.kind()) {
                case JsonKind.JsArray => return None
                case _ => return Some("来源标注必须是数组")
            }
    }
}

func emptyLessonContent(): String {
    let out = JsonWriter()
    out.putRaw("sections", "[]")
    out.putRaw("slides", "[]")
    out.putStr("sourceLabel", "管理员创建")
    out.toJson()
}

/* ---------- knowledge base JSON ---------- */

/* ---------- 资料包（zip + Agent 整理） ---------- */

func kbUrlDecode(raw: String): String {
    if (raw.size == 0) { return "" }
    let bytes = raw.toArray()
    let out = ArrayList<Byte>()
    var i: Int64 = 0
    while (i < bytes.size) {
        if (Int64(bytes[i]) == 37 && i + 2 < bytes.size) {
            let high = kbHexDigit(raw[i + 1..i + 2])
            let low = kbHexDigit(raw[i + 2..i + 3])
            out.add(UInt8((high << 4) | low))
            i += 3
        } else if (Int64(bytes[i]) == 43) {
            out.add(UInt8(32))
            i += 1
        } else {
            out.add(bytes[i])
            i += 1
        }
    }
    String.fromUtf8(out.toArray())
}

func kbBundleSelect(): String {
    "SELECT b.id,b.name,b.bytes,b.status,b.steps,b.model,b.title,b.error_message,COALESCE(b.warnings_json,'[]') warnings_json," +
    "b.source_saved,COALESCE(b.course_id,'') course_id,COALESCE(bc.status,'') course_status," +
    "b.logo_status,COALESCE(b.logo_svg,'') logo_svg,b.logo_error,COALESCE(b.logo_generation_id,'') logo_generation_id," +
    "COALESCE(lg.variants_json,'[]') logo_variants,COALESCE(lg.selected_variant_id,'') selected_variant_id," +
    "COALESCE(DATE_FORMAT(b.created_at,'%Y-%m-%d %H:%i'),'') created_at," +
    "COALESCE(DATE_FORMAT(b.updated_at,'%Y-%m-%d %H:%i'),'') updated_at," +
    "(SELECT COUNT(*) FROM kb_bundle_docs d WHERE d.bundle_id=b.id) doc_count," +
    "(SELECT COUNT(*) FROM kb_bundle_assets a WHERE a.bundle_id=b.id) asset_count," +
    "COALESCE(p.process_docs,0) process_docs,COALESCE(p.ready_docs,0) ready_docs,COALESCE(p.failed_docs,0) failed_docs," +
    "COALESCE(p.running_docs,0) running_docs,COALESCE(p.queued_docs,0) queued_docs,COALESCE(p.total_chunks,0) total_chunks," +
    "COALESCE(p.summary_chunks,0) summary_chunks,COALESCE(p.embedded_chunks,0) embedded_chunks,COALESCE(p.failed_chunks,0) failed_chunks," +
    "COALESCE(p.chunking_jobs,0) chunking_jobs,COALESCE(p.job_error,'') job_error " +
    "FROM kb_bundles b LEFT JOIN courses bc ON bc.id=b.course_id LEFT JOIN logo_generations lg ON lg.id=b.logo_generation_id " +
    "LEFT JOIN (SELECT d.bundle_id,COUNT(DISTINCT d.id) process_docs," +
    "COUNT(DISTINCT CASE WHEN j.status='ready' THEN d.id END) ready_docs," +
    "COUNT(DISTINCT CASE WHEN j.status='failed' THEN d.id END) failed_docs," +
    "COUNT(DISTINCT CASE WHEN j.status='running' THEN d.id END) running_docs," +
    "COUNT(DISTINCT CASE WHEN j.status='queued' THEN d.id END) queued_docs," +
    "COUNT(c.id) total_chunks,SUM(c.summary_status='ready') summary_chunks,COUNT(e.chunk_id) embedded_chunks," +
    "SUM(c.summary_status='failed' OR (j.status='failed' AND e.chunk_id IS NULL)) failed_chunks," +
    "SUM(j.phase='chunking') chunking_jobs,MAX(j.error_message) job_error " +
    "FROM kb_documents d LEFT JOIN kb_ingest_jobs j ON j.id=IF(d.pending_build_id<>'',d.pending_build_id,d.active_build_id) " +
    "LEFT JOIN kb_chunks c ON c.document_id=d.id AND c.build_id=IF(d.pending_build_id<>'',d.pending_build_id,d.active_build_id) " +
    "LEFT JOIN kb_embeddings e ON e.chunk_id=c.id GROUP BY d.bundle_id) p ON p.bundle_id=b.id "
}

func kbBundleJson(row: Row): String {
    let out = JsonWriter()
    out.putStr("id", row.text("id"))
    out.putStr("name", row.text("name"))
    out.putInt("bytes", row.int("bytes"))
    out.putStr("status", row.text("status"))
    out.putInt("steps", row.int("steps"))
    out.putStr("model", row.text("model"))
    out.putStr("title", row.text("title"))
    out.putStr("errorMessage", row.text("error_message"))
    out.putStr("createdAt", row.text("created_at"))
    out.putStr("updatedAt", row.text("updated_at"))
    out.putInt("docCount", row.int("doc_count"))
    out.putInt("assetCount", row.int("asset_count"))
    out.putBool("sourceSaved", row.int("source_saved") == 1)
    out.putStr("courseId", row.text("course_id"))
    out.putStr("courseStatus", row.text("course_status"))
    out.putRaw("pipeline", kbBundlePipelineJson(row))
    let logo = JsonWriter()
    logo.putStr("status", row.text("logo_status"))
    logo.putStr("svg", row.text("logo_svg"))
    logo.putStr("errorMessage", row.text("logo_error"))
    logo.putStr("generationId", row.text("logo_generation_id"))
    logo.putRaw("variants", row.text("logo_variants"))
    logo.putStr("selectedVariantId", row.text("selected_variant_id"))
    out.putRaw("logo", logo.toJson())
    out.toJson()
}

func kbBundlesBody(cfg: Config): String {
    let rows = query(cfg, kbBundleSelect() + "ORDER BY b.created_at DESC LIMIT 50")
    let arr = JsonArrWriter()
    for (row in rows) { arr.addRaw(kbBundleJson(row)) }
    let out = JsonWriter()
    out.putRaw("bundles", arr.toJson())
    out.toJson()
}

func kbBundleDetailBody(cfg: Config, bundleId: String): ?String {
    kbBundleDetailBody(cfg, bundleId, true)
}

func kbBundleSourceJson(row: Row, includeContent: Bool): String {
    let item = JsonWriter()
    item.putStr("id", row.text("id"))
    item.putStr("documentId", row.text("document_id"))
    item.putInt("order", row.int("order_index") + 1)
    item.putStr("title", row.text("title"))
    item.putInt("charCount", row.int("char_count"))
    if (includeContent) { item.putStr("content", row.text("content")) }
    item.putStr("sourcePath", row.text("source_path"))
    item.toJson()
}

func kbBundleDetailBody(cfg: Config, bundleId: String, includeContent: Bool): ?String {
    let rows = query(cfg, kbBundleSelect() + "WHERE b.id=" + sqlQuote(bundleId) + " LIMIT 1")
    if (rows.size == 0) { return None }
    let docsSql = "SELECT id,COALESCE(document_id,'') document_id,order_index,title,char_count," +
        (if (includeContent) { "content," } else { "" }) + "COALESCE(source_path,'') source_path FROM kb_bundle_docs WHERE bundle_id=" +
        sqlQuote(bundleId) + " ORDER BY order_index"
    let docs = if (includeContent) { queryIndependent(cfg, docsSql) } else { query(cfg, docsSql) }
    let arr = JsonArrWriter()
    for (row in docs) { arr.addRaw(kbBundleSourceJson(row, includeContent)) }
    let logRows = query(cfg, "SELECT COALESCE(log_text,'') log_text FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
    let out = JsonWriter()
    out.putRaw("bundle", kbBundleJson(rows[0]))
    out.putRaw("docs", arr.toJson())
    let log = if (logRows.size > 0) { logRows[0].text("log_text") } else { "" }
    out.putStr("log", log)
    out.putRaw("warnings", rows[0].text("warnings_json"))
    out.toJson()
}

/* ---------- 机构配置 ---------- */

func orgLogoDir(): String {
    let dir = "data/org"
    if (!exists(Path(dir))) { Directory.create(Path(dir), recursive: true) }
    dir
}

func orgLogoPath(): String {
    orgLogoDir() + "/logo.bin"
}

func orgRow(cfg: Config): Row {
    let rows = query(cfg, "SELECT name,short_name,logo_mime FROM org_settings WHERE id=1")
    if (rows.size > 0) { return rows[0] }
    query(cfg, "SELECT '智训云枢' name,'智训云枢' short_name,'' logo_mime")[0]
}

func orgLogoUrl(cfg: Config): String {
    let row = orgRow(cfg)
    let mime = row.text("logo_mime")
    if (mime.size == 0) { return "" }
    "/api/org/logo?v=" + kbHashText(mime + row.text("name") + row.text("short_name"))[0..8]
}

func orgBrandJson(cfg: Config, withAdminFields: Bool): String {
    let row = orgRow(cfg)
    let logo = orgLogoUrl(cfg)
    let out = JsonWriter()
    out.putStr("name", row.text("name"))
    out.putStr("shortName", row.text("short_name"))
    out.putStr("logoUrl", logo)
    out.putBool("hasLogo", logo.size > 0)
    out.toJson()
}

func kbHashText(text: String): String {
    bytesToHex(sha256Bytes(text.toArray()))
}

func orgLogoMime(data: Array<Byte>): String {
    if (data.size > 8) {
        if (Int64(data[0]) == 0x89 && Int64(data[1]) == 0x50) { return "image/png" }
        if (Int64(data[0]) == 0xFF && Int64(data[1]) == 0xD8) { return "image/jpeg" }
        if (Int64(data[0]) == 0x52 && Int64(data[1]) == 0x49 && Int64(data[8]) == 0x57) { return "image/webp" }
        if (Int64(data[0]) == 0x47 && Int64(data[1]) == 0x49) { return "image/gif" }
    }
    let head = String.fromUtf8(data.slice(0, if (data.size > 200) { 200 } else { data.size })).trimAscii()
    if (head.startsWith("<svg") || head.startsWith("<?xml")) { return "image/svg+xml" }
    ""
}

func orgWriteLogo(response: HttpResponse, cfg: Config): Unit {
    let row = orgRow(cfg)
    let mime = row.text("logo_mime")
    if (mime.size == 0) {
        writeError(response, 404, "还没有设置机构 Logo")
        return
    }
    let path = orgLogoPath()
    if (!exists(Path(path))) {
        writeError(response, 404, "机构 Logo 文件已丢失，请重新上传")
        return
    }
    let data = File.readFrom(Path(path))
    response.statusCode = 200
    response.contentType = mime
    response.contentLength = data.size
    response.headers.add("X-Content-Type-Options", "nosniff")
    response.headers.add("Cache-Control", "public, max-age=600")
    response.write(data)
}


/* ---------- 课件（生成 / 列表 / 发布） ---------- */

func cwSelect(): String {
    "SELECT c.id,c.bundle_id,c.doc_id,c.kind,c.title,c.status,c.published,c.model,c.error_message," +
    "COALESCE(DATE_FORMAT(c.updated_at,'%Y-%m-%d %H:%i'),'') updated_at," +
    "COALESCE(d.title,'') doc_title,COALESCE(b.title,b.name,'') bundle_title " +
    "FROM kb_courseware c LEFT JOIN kb_bundle_docs d ON d.id=c.doc_id " +
    "LEFT JOIN kb_bundles b ON b.id=c.bundle_id "
}

func cwRowJson(row: Row): String {
    let out = JsonWriter()
    out.putStr("id", row.text("id"))
    out.putStr("bundleId", row.text("bundle_id"))
    out.putStr("docId", row.text("doc_id"))
    out.putStr("kind", row.text("kind"))
    out.putStr("kindLabel", cwLabel(row.text("kind")))
    out.putStr("title", row.text("title"))
    out.putStr("status", row.text("status"))
    out.putBool("published", row.int("published") == 1)
    out.putStr("docTitle", row.text("doc_title"))
    out.putStr("bundleTitle", row.text("bundle_title"))
    out.putStr("model", row.text("model"))
    out.putStr("errorMessage", row.text("error_message"))
    out.putStr("updatedAt", row.text("updated_at"))
    out.toJson()
}

func cwListBody(cfg: Config, bundleId: String): String {
    var filter = ""
    if (bundleId.size > 0) { filter = "WHERE c.bundle_id=" + sqlQuote(bundleId) + " " }
    let rows = query(cfg, cwSelect() + filter + "ORDER BY c.created_at DESC LIMIT 100")
    let arr = JsonArrWriter()
    for (row in rows) { arr.addRaw(cwRowJson(row)) }
    let out = JsonWriter()
    out.putRaw("items", arr.toJson())
    out.toJson()
}

func cwDetailBody(cfg: Config, id: String): ?String {
    let rows = query(cfg, cwSelect() + "WHERE c.id=" + sqlQuote(id) + " LIMIT 1")
    if (rows.size == 0) { return None }
    let content = query(cfg, "SELECT COALESCE(content_json,'') content_json,COALESCE(steps_json,'[]') steps_json FROM kb_courseware WHERE id=" + sqlQuote(id))
    let out = JsonWriter()
    out.putRaw("item", cwRowJson(rows[0]))
    out.putRaw("steps", if (content.size > 0 && content[0].text("steps_json").size > 0) {
        content[0].text("steps_json")
    } else {
        "[]"
    })
    out.putRaw("content", if (content.size > 0 && content[0].text("content_json").size > 0) {
        content[0].text("content_json")
    } else {
        "null"
    })
    out.toJson()
}


func kbDocumentJson(row: Row): String {
    let out = JsonWriter()
    out.putStr("id", row.text("id"))
    out.putStr("title", row.text("title"))
    out.putStr("sourceName", row.text("source_name"))
    out.putStr("sourceType", row.text("source_type"))
    out.putInt("charCount", row.int("char_count"))
    out.putInt("byteSize", row.int("byte_size"))
    out.putStr("status", row.text("status"))
    out.putInt("chunkCount", row.int("chunk_count"))
    out.putInt("embeddedCount", row.int("embedded_count"))
    out.putStr("embeddingModel", row.text("embedding_model"))
    out.putStr("errorMessage", row.text("error_message"))
    out.putStr("updatedAt", row.text("updated_at"))
    out.putStr("courseId", row.text("course_id"))
    out.putStr("courseStatus", row.text("course_status"))
    out.toJson()
}

func kbDocumentSelect(): String {
    "SELECT d.id,d.title,d.source_name,d.source_type,d.byte_size,d.char_count,d.status,d.chunk_count," +
    "d.embedded_count,d.embedding_model,d.error_message,d.course_id," +
    "COALESCE(DATE_FORMAT(d.updated_at,'%Y-%m-%d %H:%i'),'') updated_at," +
    "COALESCE((SELECT c.status FROM courses c WHERE c.id=d.course_id),'') course_status " +
    "FROM kb_documents d "
}

/* ---------- 管理端模型配置 ---------- */

func kbKeyCipherValue(cfg: Config, apiKey: String, clear: Bool, current: String): String {
    if (clear) { return "NULL" }
    if (apiKey.size > 0) { return sqlQuote(encryptSecret(cfg.authSecret, apiKey)) }
    if (current.size > 0) { return sqlQuote(current) }
    "NULL"
}

func kbKeyHintValue(apiKey: String, clear: Bool, current: String): String {
    if (clear) { return "" }
    if (apiKey.size > 0) {
        if (apiKey.size <= 4) { return "已保存" }
        return "尾号 " + apiKey[apiKey.size - 4..apiKey.size]
    }
    current
}

func slotSettingsJson(slot: ModelSlot, keyReady: Bool): String {
    let out = JsonWriter()
    out.putStr("baseUrl", slot.baseUrl)
    out.putStr("model", slot.model)
    out.putStr("keyHint", slot.hint)
    out.putBool("keyConfigured", keyReady)
    out.putBool("configured", slot.configured())
    out.toJson()
}

func kbSettingsJson(cfg: Config, settings: KbSettings): String {
    let out = JsonWriter()
    out.putRaw("embedding", slotSettingsJson(settings.embedding, resolveKey(cfg, settings.embedding).size > 0))
    out.putRaw("chat", slotSettingsJson(settings.chat, resolveKey(cfg, settings.chat).size > 0))
    out.putRaw("tts", slotSettingsJson(settings.tts, resolveKey(cfg, settings.tts).size > 0))
    out.putStr("ttsVoice", settings.ttsVoice)
    out.putStr("ttsPath", settings.ttsPath)
    out.putInt("embeddingDim", settings.embeddingDim)
    out.putInt("batchSize", settings.batchSize)
    out.putInt("chunkSize", settings.chunkSize)
    out.putInt("chunkOverlap", settings.chunkOverlap)
    out.putInt("topK", settings.topK)
    let anyAdmin = settings.embedding.cipher.size > 0 || settings.chat.cipher.size > 0 || settings.tts.cipher.size > 0
    out.putStr("keySource", if (anyAdmin) { "admin" } else if (legacyEnvKey().size > 0) { "env" } else { "" })
    out.toJson()
}

func kbOverviewBody(cfg: Config): String {
    let settings = loadKbSettings(cfg)
    let rows = query(cfg, kbDocumentSelect() + "WHERE d.bundle_id IS NULL ORDER BY d.created_at DESC LIMIT 200")
    let docs = JsonArrWriter()
    for (row in rows) { docs.addRaw(kbDocumentJson(row)) }
    let totals = query(cfg,
        "SELECT COUNT(*) docs,COALESCE(SUM(chunk_count),0) chunks,COALESCE(SUM(embedded_count),0) embedded FROM kb_documents")
    let stats = JsonWriter()
    stats.putInt("documents", if (totals.size > 0) { totals[0].int("docs") } else { 0 })
    stats.putInt("chunks", if (totals.size > 0) { totals[0].int("chunks") } else { 0 })
    stats.putInt("embedded", if (totals.size > 0) { totals[0].int("embedded") } else { 0 })
    let out = JsonWriter()
    out.putRaw("documents", docs.toJson())
    out.putRaw("settings", kbSettingsJson(cfg, settings))
    out.putRaw("stats", stats.toJson())
    out.toJson()
}

func kbDocumentDetailBody(cfg: Config, docId: String): ?String {
    let rows = query(cfg, kbDocumentSelect() + "WHERE d.id=" + sqlQuote(docId) + " LIMIT 1")
    if (rows.size == 0) { return None }
    let chunks = query(cfg,
        "SELECT c.id,c.chunk_index,c.heading_path,c.text,c.char_count,c.summary,c.keywords_json,c.summary_status,c.source_start,c.source_end," +
        "CASE WHEN e.chunk_id IS NULL THEN 0 ELSE 1 END has_vector " +
        "FROM kb_chunks c JOIN kb_documents d ON d.id=c.document_id LEFT JOIN kb_embeddings e ON e.chunk_id=c.id " +
        "WHERE c.document_id=" + sqlQuote(docId) + " AND c.build_id=IF(d.pending_build_id<>'',d.pending_build_id,d.active_build_id) ORDER BY c.chunk_index LIMIT 200")
    let arr = JsonArrWriter()
    for (row in chunks) {
        let item = JsonWriter()
        item.putStr("id", row.text("id"))
        item.putInt("index", row.int("chunk_index"))
        item.putStr("headingPath", row.text("heading_path"))
        item.putStr("text", row.text("text"))
        item.putInt("charCount", row.int("char_count"))
        item.putBool("hasVector", row.int("has_vector") == 1)
        item.putStr("summary", row.text("summary"))
        item.putRaw("keywords", if (row.isNull("keywords_json")) { "[]" } else { row.text("keywords_json") })
        item.putStr("summaryStatus", row.text("summary_status"))
        item.putInt("startOffset", row.int("source_start"))
        item.putInt("endOffset", row.int("source_end"))
        arr.addRaw(item.toJson())
    }
    let out = JsonWriter()
    out.putRaw("document", kbDocumentJson(rows[0]))
    out.putRaw("chunks", arr.toJson())
    out.toJson()
}

func kbSearchBody(cfg: Config, settings: KbSettings, queryText: String, topK: Int64): String {
    let result = kbSearch(cfg, settings, queryText, topK)
    let arr = JsonArrWriter()
    for (hit in result.hits) {
        let item = JsonWriter()
        item.putStr("chunkId", hit.chunkId)
        item.putStr("documentId", hit.documentId)
        item.putStr("documentTitle", hit.docTitle)
        item.putStr("headingPath", hit.headingPath)
        item.putStr("text", hit.text)
        item.putFloat("score", hit.score)
        arr.addRaw(item.toJson())
    }
    let out = JsonWriter()
    out.putRaw("hits", arr.toJson())
    out.putStr("mode", result.mode)
    out.putBool("degraded", result.degraded)
    out.putStr("note", result.note)
    out.toJson()
}

func kbIngestResponse(cfg: Config, docId: String, result: KbIngestResult): String {
    let rows = query(cfg, kbDocumentSelect() + "WHERE d.id=" + sqlQuote(docId) + " LIMIT 1")
    let out = JsonWriter()
    if (rows.size > 0) {
        out.putRaw("document", kbDocumentJson(rows[0]))
    } else {
        out.putRaw("document", "null")
    }
    out.putInt("chunkCount", result.chunkCount)
    out.putInt("embeddedCount", result.embeddedCount)
    out.putStr("note", result.note)
    out.toJson()
}

/* ---------- AI tutor ---------- */

func tutorSystemPrompt(): String {
    "你是「智训云枢」的人工智能学习导师，服务对象是正在学习计算机课程的学生。\n" +
    "要求：\n" +
    "1. 用简体中文回答，先用一句话给结论，再展开解释；总长度控制在 400 字以内。\n" +
    "2. 优先依据【参考资料】和【当前课时】回答，用到资料时在句末标注编号，例如 [1][2]。\n" +
    "3. 资料没有覆盖的问题，可以基于通用知识回答，但必须说明「课程资料里没有直接讲到」。\n" +
    "4. 不确定就说不确定，不要编造概念、数字或引用。\n" +
    "5. 不要输出与问题无关的开场白。"
}

func tutorCitationsJson(hits: ArrayList<KbHit>): String {
    let arr = JsonArrWriter()
    var i: Int64 = 0
    while (i < hits.size) {
        let hit = hits[i]
        let item = JsonWriter()
        item.putInt("index", i + 1)
        item.putStr("documentId", hit.documentId)
        item.putStr("documentTitle", hit.docTitle)
        item.putStr("headingPath", hit.headingPath)
        item.putStr("text", hit.text)
        item.putFloat("score", hit.score)
        arr.addRaw(item.toJson())
        i += 1
    }
    arr.toJson()
}

func tutorQuestionText(hits: ArrayList<KbHit>, quoted: String, courseLabel: String, lessonTitle: String, message: String): String {
    var text = "【当前课时】" + (if (courseLabel.size > 0) { courseLabel } else { "未指定课程" })
    if (lessonTitle.size > 0) { text += " · " + lessonTitle }
    text += "\n"
    if (hits.size > 0) {
        text += "【参考资料】\n"
        var i: Int64 = 0
        while (i < hits.size) {
            let hit = hits[i]
            text += "[" + (i + 1).toString() + "] 《" + hit.docTitle + "》"
            if (hit.headingPath.size > 0) { text += " · " + hit.headingPath }
            text += "\n" + hit.text + "\n\n"
            i += 1
        }
    } else {
        text += "【参考资料】知识库里没有检索到相关内容。\n"
    }
    if (quoted.size > 0) {
        text += "【学习者引用的原文】\n" + quoted + "\n"
    }
    text += "【问题】\n" + message
    text
}

func saveTutorMessage(cfg: Config, userId: String, role: String, content: String, citations: String,
                      courseId: String, lessonIndex: Int64): Unit {
    try {
        execute(cfg,
            "INSERT INTO tutor_messages(id,user_id,role,content,citations_json,mode,course_id,lesson_index) VALUES(" +
            sqlQuote(uuidFormat(uuidV4())) + "," + sqlQuote(userId) + "," + sqlQuote(role) + "," +
            sqlQuote(content) + "," + sqlQuote(if (citations.size == 0) { "null" } else { citations }) +
            ",'lesson'," + sqlQuote(courseId) + "," + lessonIndex.toString() + ")")
    } catch (_: Exception) {
        // 记录失败不影响本次回答。
    }
}

main(): Int64 {
    let cfg = loadConfig()
    let initial = connect(cfg)
    sharedDatabase = Some(initial)
    // 服务重启后，上次没跑完的课件任务不会再被推进，直接标记失败，避免一直显示「生成中」。
    try {
        execute(cfg, "UPDATE kb_courseware SET status='failed',error_message='服务重启，生成中断',updated_at=NOW(6) WHERE status='generating'")
    } catch (_: Exception) {}

    let builder = WebHost.createBuilder([])
    builder.configureServer { server => server.maxRequestBodySize(256 * 1024 * 1024) }
    builder.services.addRouting()
    let app = builder.build()

    app.mapGet("api/health") { ctx =>
        let out = JsonWriter()
        out.putStr("status", "ok")
        out.putStr("runtime", "Cangjie 1.2.0 + Spire")
        out.putStr("database", cfg.database)
        writeJson(ctx.response, 200, out.toJson())
    }

    app.mapPost("api/session") { ctx =>
        let userId = uuidFormat(uuidV4())
        let token = uuidFormat(uuidV4())
        transaction(cfg, [
            "INSERT INTO users(id,created_at) VALUES(" + sqlQuote(userId) + ",NOW(6))",
            "INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES(" +
                sqlQuote(tokenHash(token)) + "," + sqlQuote(userId) + ",DATE_ADD(NOW(6),INTERVAL 30 DAY))"
        ])
        let out = JsonWriter()
        out.putStr("token", token)
        out.putStr("userId", userId)
        out.putRaw("profile", "null")
        writeJson(ctx.response, 200, out.toJson())
    }

    app.mapPost("api/auth/guest") { ctx =>
        let userId = uuidFormat(uuidV4())
        transaction(cfg, [
            "INSERT INTO users(id,display_name,created_at) VALUES(" +
                sqlQuote(userId) + ", '游客', NOW(6))"
        ])
        writeJson(ctx.response, 200, issueSession(cfg, userId, "游客", "null"))
    }

    app.mapPost("api/auth/register") { ctx =>
        match (parseObject(ctx.request)) {
            case None => writeError(ctx.response, 400, "注册信息格式不正确")
            case Some(body) =>
                let account = (jsonGetString(body, "account") ?? "").trimAscii()
                let password = jsonGetString(body, "password") ?? ""
                let displayName = (jsonGetString(body, "displayName") ?? "").trimAscii()
                if (account.size < 3 || account.size > 200) {
                    writeError(ctx.response, 400, "学习账号需要 3—200 个字符")
                } else if (password.size < 8) {
                    writeError(ctx.response, 400, "密码至少需要 8 位")
                } else {
                    let loginKey = account.toAsciiLower()
                    let existing = query(cfg, "SELECT id FROM users WHERE login_key=" + sqlQuote(loginKey))
                    if (existing.size > 0) {
                        writeError(ctx.response, 409, "该账号已存在，请直接登录")
                    } else {
                        let userId = uuidFormat(uuidV4())
                        let salt = bytesToHex(uuidV4())
                        let name = if (displayName.size == 0) { account } else { displayName }
                        execute(cfg,
                            "INSERT INTO users(id,login_key,password_salt,password_hash,display_name,created_at) VALUES(" +
                            sqlQuote(userId) + "," + sqlQuote(loginKey) + "," + sqlQuote(salt) + "," +
                            sqlQuote(passwordDigest(salt, password)) + "," + sqlQuote(name) + ",NOW(6))")
                        writeJson(ctx.response, 200,
                            issueSession(cfg, userId, name, "null"))
                    }
                }
        }
    }

    app.mapPost("api/auth/login") { ctx =>
        match (parseObject(ctx.request)) {
            case None => writeError(ctx.response, 400, "登录信息格式不正确")
            case Some(body) =>
                let account = (jsonGetString(body, "account") ?? "").trimAscii()
                let password = jsonGetString(body, "password") ?? ""
                let found = query(cfg,
                    "SELECT id,password_salt,password_hash,display_name,profile_json FROM users WHERE login_key=" +
                    sqlQuote(account.toAsciiLower()) + " LIMIT 1")
                if (found.size == 0 || found[0].isNull("password_hash")) {
                    writeError(ctx.response, 401, "账号或密码不正确")
                } else {
                    let expected = passwordDigest(found[0].text("password_salt"), password)
                    if (expected != found[0].text("password_hash")) {
                        writeError(ctx.response, 401, "账号或密码不正确")
                    } else {
                        let profile = if (found[0].isNull("profile_json")) { "null" } else { found[0].text("profile_json") }
                        writeJson(ctx.response, 200,
                            issueSession(cfg, found[0].text("id"), found[0].text("display_name"), profile))
                    }
                }
        }
    }

    app.mapPost("api/auth/send-code") { ctx =>
        match (parseObject(ctx.request)) {
            case None => writeError(ctx.response, 400, "邮箱信息格式不正确")
            case Some(body) =>
                let email = normalizeEmail(jsonGetString(body, "email") ?? "")
                if (!validEmail(email)) {
                    writeError(ctx.response, 400, "请填写有效的邮箱")
                } else {
                    let recent = query(cfg,
                        "SELECT COALESCE(TIMESTAMPDIFF(SECOND,created_at,NOW(6)),9999) elapsed " +
                        "FROM email_verification_codes WHERE email=" + sqlQuote(email) +
                        " AND purpose='LOGIN' ORDER BY created_at DESC LIMIT 1")
                    if (recent.size > 0 && recent[0].int("elapsed") < 60) {
                        writeError(ctx.response, 429, "请求过于频繁，请稍后重试")
                    } else {
                        let code = verificationCode()
                        try {
                            sendVerificationEmail(cfg, email, code, 300)
                        } catch (_: Exception) {
                            writeError(ctx.response, 502, "验证码邮件发送失败，请检查 SMTP 配置")
                            return
                        }
                        execute(cfg,
                            "INSERT INTO email_verification_codes(id,email,purpose,code_hash,created_at,expires_at) VALUES(" +
                            sqlQuote(uuidFormat(uuidV4())) + "," + sqlQuote(email) +
                            ",'LOGIN'," + sqlQuote(codeDigest(cfg, email, "LOGIN", code)) +
                            ",NOW(6),DATE_ADD(NOW(6),INTERVAL 5 MINUTE))")
                        let out = JsonWriter()
                        out.putStr("email", email)
                        out.putInt("expiresInSeconds", 300)
                        out.putInt("retryAfterSeconds", 60)
                        writeJson(ctx.response, 200, out.toJson())
                    }
                }
        }
    }

    app.mapPost("api/auth/email-login") { ctx =>
        match (parseObject(ctx.request)) {
            case None => writeError(ctx.response, 400, "验证码信息格式不正确")
            case Some(body) =>
                let email = normalizeEmail(jsonGetString(body, "email") ?? "")
                let code = (jsonGetString(body, "verificationCode") ?? "").trimAscii()
                if (!validEmail(email) || code.size != 6) {
                    writeError(ctx.response, 400, "请填写有效的邮箱和 6 位验证码")
                } else {
                    let codes = query(cfg,
                        "SELECT id,code_hash FROM email_verification_codes WHERE email=" + sqlQuote(email) +
                        " AND purpose='LOGIN' AND consumed_at IS NULL AND expires_at>NOW(6) " +
                        "ORDER BY created_at DESC LIMIT 1")
                    if (codes.size == 0 || codes[0].text("code_hash") != codeDigest(cfg, email, "LOGIN", code)) {
                        writeError(ctx.response, 400, "验证码错误或已失效")
                    } else {
                        execute(cfg,
                            "UPDATE email_verification_codes SET consumed_at=NOW(6) WHERE id=" +
                            sqlQuote(codes[0].text("id")) + " AND consumed_at IS NULL")
                        let users = query(cfg,
                            "SELECT id,display_name,profile_json FROM users WHERE login_key=" + sqlQuote(email) + " LIMIT 1")
                        let userId: String
                        let displayName: String
                        var profile = "null"
                        if (users.size > 0) {
                            userId = users[0].text("id")
                            displayName = users[0].text("display_name")
                            if (!users[0].isNull("profile_json") && users[0].text("profile_json").size > 0) {
                                profile = users[0].text("profile_json")
                            }
                        } else {
                            userId = uuidFormat(uuidV4())
                            let at = email.indexOf("@")
                            let candidate = match (at) { case Some(position) => email[0..position]; case None => "学习者" }
                            displayName = if (candidate.size > 0) { candidate } else { "学习者" }
                            execute(cfg,
                                "INSERT INTO users(id,login_key,display_name,created_at) VALUES(" +
                                sqlQuote(userId) + "," + sqlQuote(email) + "," + sqlQuote(displayName) + ",NOW(6))")
                        }
                        writeJson(ctx.response, 200,
                            issueSession(cfg, userId, displayName, profile))
                    }
                }
        }
    }

    app.mapGet("api/bootstrap") { ctx =>
        match (authenticate(ctx, cfg)) {
            case None => ()
            case Some(userId) =>
                let (favorites, bookmarks) = stateBody(cfg, userId)
                let out = JsonWriter()
                out.putRaw("profile", profileBody(cfg, userId))
                out.putRaw("courses", courseArrayBody(cfg, userId))
                out.putRaw("favorites", favorites)
                out.putRaw("bookmarks", bookmarks)
                out.putRaw("stats", statsBody(cfg, userId))
                out.putRaw("recent", recentBody(cfg, userId))
                writeJson(ctx.response, 200, out.toJson())
        }
    }

    app.mapPut("api/profile") { ctx =>
        match (authenticate(ctx, cfg)) {
            case None => ()
            case Some(userId) =>
                match (parseObject(ctx.request)) {
                    case None => writeError(ctx.response, 400, "个人资料格式不正确")
                    case Some(profile) =>
                        let raw = profile.toJsonString()
                        if (raw.size > 65536) {
                            writeError(ctx.response, 413, "个人资料内容过长")
                        } else {
                            execute(cfg, "UPDATE users SET profile_json=" + sqlQuote(raw) + " WHERE id=" + sqlQuote(userId))
                            let out = JsonWriter()
                            out.putRaw("profile", raw)
                            writeJson(ctx.response, 200, out.toJson())
                        }
                }
        }
    }

    app.mapGet("api/courses") { ctx =>
        match (authenticate(ctx, cfg)) {
            case None => ()
            case Some(userId) => writeJson(ctx.response, 200, coursesBody(cfg, userId))
        }
    }

    app.mapGet("api/courses/{course_id}/lessons/{lesson_index}") { ctx =>
        match (authenticate(ctx, cfg)) {
            case None => ()
            case Some(userId) =>
                let courseId = routeText(ctx, "course_id")
                let index = Int64.tryParse(routeText(ctx, "lesson_index")) ?? -1
                if (index < 0) {
                    writeError(ctx.response, 400, "课时编号不正确")
                } else {
                    match (courseLesson(cfg, courseId, index)) {
                        case None => writeError(ctx.response, 404, "没有找到这个课时")
                        case Some(row) =>
                            let out = JsonWriter()
                            out.putStr("courseId", courseId)
                            out.putInt("lessonIndex", index)
                            out.putStr("title", row.text("title"))
                            out.putRaw("content", row.text("content_json"))
                            let questions = JsonArrWriter()
                            let quiz = lessonQuestions(row.text("quiz_json"))
                            var questionIndex: Int64 = 0
                            while (questionIndex < quiz.size()) {
                                let question = quiz[questionIndex]
                                let value = publicQuestion(question)
                                if (value.size > 2) { questions.addRaw(value) }
                                questionIndex += 1
                            }
                            out.putRaw("questions", questions.toJson())
                            out.putRaw("sources", row.text("sources_json"))
                            out.putRaw("progress", progressJson(cfg, userId, courseId, index))
                            writeJson(ctx.response, 200, out.toJson())
                    }
                }
        }
    }

    app.mapPut("api/courses/{course_id}/lessons/{lesson_index}/progress") { ctx =>
        match (authenticate(ctx, cfg)) {
            case None => ()
            case Some(userId) =>
                let courseId = routeText(ctx, "course_id")
                let index = Int64.tryParse(routeText(ctx, "lesson_index")) ?? -1
                match (courseLesson(cfg, courseId, index)) {
                    case None => writeError(ctx.response, 404, "没有找到这个课时")
                    case Some(row) =>
                        saveProgress(cfg, userId, courseId, index, None, false)
                        writeJson(ctx.response, 200, progressJson(cfg, userId, courseId, index))
                }
        }
    }

    app.mapPost("api/courses/{course_id}/lessons/{lesson_index}/answer") { ctx =>
        match (authenticate(ctx, cfg)) {
            case None => ()
            case Some(userId) =>
                let courseId = routeText(ctx, "course_id")
                let index = Int64.tryParse(routeText(ctx, "lesson_index")) ?? -1
                match (courseLesson(cfg, courseId, index)) {
                    case None => writeError(ctx.response, 404, "没有找到这个课时")
                    case Some(row) =>
                        match (parseObject(ctx.request)) {
                            case None => writeError(ctx.response, 400, "答案格式不正确")
                            case Some(body) =>
                                let questionId = jsonGetString(body, "questionId") ?? ""
                                match (jsonGetInt(body, "choice")) {
                                    case None => writeError(ctx.response, 400, "请选择一个答案")
                                    case Some(choice) =>
                                        match (questionById(lessonQuestions(row.text("quiz_json")), questionId)) {
                                            case None => writeError(ctx.response, 404, "没有找到这个题目")
                                            case Some(question) =>
                                                if (choice < 0 || choice >= optionsCount(question)) {
                                                    writeError(ctx.response, 400, "答案索引不正确")
                                                } else {
                                                    writeJson(ctx.response, 200, gradeAnswer(question, choice))
                                                }
                                        }
                                }
                        }
                }
        }
    }

    app.mapPost("api/courses/{course_id}/lessons/{lesson_index}/quiz") { ctx =>
        match (authenticate(ctx, cfg)) {
            case None => ()
            case Some(userId) =>
                let courseId = routeText(ctx, "course_id")
                let index = Int64.tryParse(routeText(ctx, "lesson_index")) ?? -1
                match (courseLesson(cfg, courseId, index)) {
                    case None => writeError(ctx.response, 404, "没有找到这个课时")
                    case Some(row) =>
                        match (parseObject(ctx.request)) {
                            case None => writeError(ctx.response, 400, "测验内容格式不正确")
                            case Some(body) =>
                                let attemptId = jsonGetString(body, "attemptId") ?? ""
                                if (attemptId.size < 8 || attemptId.size > 64) {
                                    writeError(ctx.response, 400, "测验提交编号不正确")
                                } else {
                                    let existing = query(cfg,
                                        "SELECT answers_json FROM quiz_attempts WHERE user_id=" + sqlQuote(userId) +
                                        " AND id=" + sqlQuote(attemptId))
                                    var answers = jsonGetArray(body, "answers") ?? JsonArray()
                                    if (existing.size > 0) {
                                        answers = jsonArrayFromText(existing[0].text("answers_json"))
                                    }
                                    let quiz = lessonQuestions(row.text("quiz_json"))
                                    let (correct, total) = quizResult(quiz, answers)
                                    let score = if (total == 0) { 0 } else { correct * 100 / total }
                                    let completed = score >= 60
                                    if (existing.size == 0) {
                                        let duration = jsonGetInt(body, "durationSeconds") ?? 0
                                        execute(cfg,
                                            "INSERT IGNORE INTO quiz_attempts(id,user_id,course_id,lesson_index,answers_json,score,duration_seconds,created_at) VALUES(" +
                                            sqlQuote(attemptId) + "," + sqlQuote(userId) + "," + sqlQuote(courseId) + "," +
                                            index.toString() + "," + sqlQuote(answers.toJsonString()) + "," + score.toString() + "," +
                                            maxInt(0, duration).toString() + ",NOW(6))")
                                    }
                                    saveProgress(cfg, userId, courseId, index, Some(score), completed)
                                    let out = JsonWriter()
                                    out.putInt("score", score)
                                    out.putInt("correctCount", correct)
                                    out.putInt("total", total)
                                    out.putBool("completed", completed)
                                    writeJson(ctx.response, 200, out.toJson())
                                }
                        }
                }
        }
    }

    app.mapPut("api/state") { ctx =>
        match (authenticate(ctx, cfg)) {
            case None => ()
            case Some(userId) =>
                match (parseObject(ctx.request)) {
                    case None => writeError(ctx.response, 400, "收藏或书签格式不正确")
                    case Some(body) =>
                        let favorites = jsonGetArray(body, "favorites")?.toJsonString() ?? "[]"
                        let bookmarks = jsonGetArray(body, "bookmarks")?.toJsonString() ?? "[]"
                        execute(cfg,
                            "INSERT INTO user_state(user_id,favorites_json,bookmarks_json,updated_at) VALUES(" +
                            sqlQuote(userId) + "," + sqlQuote(favorites) + "," + sqlQuote(bookmarks) +
                            ",NOW(6)) ON DUPLICATE KEY UPDATE favorites_json=VALUES(favorites_json)," +
                            "bookmarks_json=VALUES(bookmarks_json),updated_at=NOW(6)")
                        let out = JsonWriter()
                        out.putRaw("favorites", favorites)
                        out.putRaw("bookmarks", bookmarks)
                        writeJson(ctx.response, 200, out.toJson())
                }
        }
    }

    app.mapPost("api/admin/login") { ctx =>
        match (parseObject(ctx.request)) {
            case None => writeError(ctx.response, 400, "登录信息格式不正确")
            case Some(body) =>
                let account = (jsonGetString(body, "account") ?? "").trimAscii()
                let password = jsonGetString(body, "password") ?? ""
                if (account.size == 0 || password.size == 0) {
                    writeError(ctx.response, 400, "请填写管理员账号和密码")
                } else {
                    let found = query(cfg,
                        "SELECT id,password_salt,password_hash,display_name,role FROM users WHERE login_key=" +
                        sqlQuote(account.toAsciiLower()) + " LIMIT 1")
                    if (found.size == 0 || found[0].isNull("password_hash")) {
                        writeError(ctx.response, 401, "账号或密码不正确")
                    } else if (passwordDigest(found[0].text("password_salt"), password) != found[0].text("password_hash")) {
                        writeError(ctx.response, 401, "账号或密码不正确")
                    } else if (found[0].text("role") != "admin") {
                        writeError(ctx.response, 403, "该账号没有管理权限")
                    } else {
                        let token = uuidFormat(uuidV4())
                        execute(cfg, "INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES(" +
                            sqlQuote(tokenHash(token)) + "," + sqlQuote(found[0].text("id")) +
                            ",DATE_ADD(NOW(6),INTERVAL 12 HOUR))")
                        let out = JsonWriter()
                        out.putStr("token", token)
                        out.putStr("displayName", found[0].text("display_name"))
                        out.putStr("role", "admin")
                        writeJson(ctx.response, 200, out.toJson())
                    }
                }
        }
    }

    app.mapGet("api/admin/overview") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) => writeJson(ctx.response, 200, adminOverviewBody(cfg))
        }
    }

    app.mapGet("api/admin/courses") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let out = JsonWriter()
                out.putRaw("courses", adminCoursesBody(cfg))
                writeJson(ctx.response, 200, out.toJson())
        }
    }

    app.mapPost("api/admin/courses") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                match (parseObject(ctx.request)) {
                    case None => writeError(ctx.response, 400, "课程信息格式不正确")
                    case Some(body) =>
                        let id = (jsonGetString(body, "id") ?? "").trimAscii()
                        let name = (jsonGetString(body, "name") ?? "").trimAscii()
                        let description = jsonGetString(body, "description") ?? ""
                        let level = (jsonGetString(body, "level") ?? "").trimAscii()
                        let icon = (jsonGetString(body, "icon") ?? "").trimAscii()
                        let sourceLabel = (jsonGetString(body, "sourceLabel") ?? "").trimAscii()
                        let duration = jsonGetInt(body, "duration") ?? 0
                        if (!validCourseSlug(id)) {
                            writeError(ctx.response, 400, "课程编号只能用 2–40 位小写字母、数字、横线或下划线")
                        } else if (name.size == 0 || name.size > 160) {
                            writeError(ctx.response, 400, "课程名称需要 1–160 个字符")
                        } else if (description.size > 4000) {
                            writeError(ctx.response, 400, "课程简介过长")
                        } else if (level.size > 40) {
                            writeError(ctx.response, 400, "难度标签过长")
                        } else {
                            let existing = query(cfg, "SELECT id FROM courses WHERE id=" + sqlQuote(id))
                            if (existing.size > 0) {
                                writeError(ctx.response, 409, "这个课程编号已经存在")
                            } else {
                                execute(cfg,
                                    "INSERT INTO courses(id,name,icon,description,level,duration,chapters_json,source_label,status,sort_order) VALUES(" +
                                    sqlQuote(id) + "," + sqlQuote(name) + "," + sqlQuote(icon) + "," + sqlQuote(description) + "," +
                                    sqlQuote(if (level.size == 0) { "入门" } else { level }) + "," +
                                    maxInt(0, duration).toString() + ",'[]'," +
                                    sqlQuote(if (sourceLabel.size == 0) { "管理员创建" } else { sourceLabel }) +
                                    ",'draft',100)")
                                match (adminCourseBody(cfg, id)) {
                                    case Some(body2) => writeJson(ctx.response, 200, body2)
                                    case None => writeError(ctx.response, 500, "课程已保存，但读取失败，请刷新列表")
                                }
                            }
                        }
                }
        }
    }

    app.mapPut("api/admin/courses/{course_id}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let courseId = routeText(ctx, "course_id")
                match (parseObject(ctx.request)) {
                    case None => writeError(ctx.response, 400, "课程信息格式不正确")
                    case Some(body) =>
                        let name = (jsonGetString(body, "name") ?? "").trimAscii()
                        let description = jsonGetString(body, "description") ?? ""
                        let level = (jsonGetString(body, "level") ?? "").trimAscii()
                        let icon = (jsonGetString(body, "icon") ?? "").trimAscii()
                        let sourceLabel = (jsonGetString(body, "sourceLabel") ?? "").trimAscii()
                        let duration = jsonGetInt(body, "duration") ?? 0
                        let existing = query(cfg, "SELECT id FROM courses WHERE id=" + sqlQuote(courseId))
                        if (existing.size == 0) {
                            writeError(ctx.response, 404, "没有找到这门课程")
                        } else if (name.size == 0 || name.size > 160) {
                            writeError(ctx.response, 400, "课程名称需要 1–160 个字符")
                        } else if (description.size > 4000) {
                            writeError(ctx.response, 400, "课程简介过长")
                        } else if (level.size > 40) {
                            writeError(ctx.response, 400, "难度标签过长")
                        } else {
                            execute(cfg,
                                "UPDATE courses SET name=" + sqlQuote(name) + ",icon=" + sqlQuote(icon) +
                                ",description=" + sqlQuote(description) +
                                ",level=" + sqlQuote(if (level.size == 0) { "入门" } else { level }) +
                                ",duration=" + maxInt(0, duration).toString() +
                                ",source_label=" + sqlQuote(if (sourceLabel.size == 0) { "管理员创建" } else { sourceLabel }) +
                                ",updated_at=NOW(6) WHERE id=" + sqlQuote(courseId))
                            match (adminCourseBody(cfg, courseId)) {
                                case Some(body2) => writeJson(ctx.response, 200, body2)
                                case None => writeError(ctx.response, 500, "课程已保存，但读取失败，请刷新列表")
                            }
                        }
                }
        }
    }

    app.mapPost("api/admin/courses/{course_id}/status") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let courseId = routeText(ctx, "course_id")
                match (parseObject(ctx.request)) {
                    case None => writeError(ctx.response, 400, "状态信息格式不正确")
                    case Some(body) =>
                        let status = (jsonGetString(body, "status") ?? "").trimAscii()
                        if (!adminStatusOk(status)) {
                            writeError(ctx.response, 400, "状态只能是 published 或 draft")
                        } else {
                            let existing = query(cfg, "SELECT id FROM courses WHERE id=" + sqlQuote(courseId))
                            if (existing.size == 0) {
                                writeError(ctx.response, 404, "没有找到这门课程")
                            } else {
                                execute(cfg, "UPDATE courses SET status=" + sqlQuote(status) +
                                    ",updated_at=NOW(6) WHERE id=" + sqlQuote(courseId))
                                match (adminCourseBody(cfg, courseId)) {
                                    case Some(body2) => writeJson(ctx.response, 200, body2)
                                    case None => writeError(ctx.response, 500, "状态已保存，但读取失败，请刷新列表")
                                }
                            }
                        }
                }
        }
    }

    app.mapGet("api/admin/courses/{course_id}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                match (adminCourseBody(cfg, routeText(ctx, "course_id"))) {
                    case Some(body) => writeJson(ctx.response, 200, body)
                    case None => writeError(ctx.response, 404, "没有找到这门课程")
                }
        }
    }

    app.mapPost("api/admin/courses/{course_id}/lessons") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let courseId = routeText(ctx, "course_id")
                let courses = query(cfg, "SELECT id FROM courses WHERE id=" + sqlQuote(courseId))
                if (courses.size == 0) {
                    writeError(ctx.response, 404, "没有找到这门课程")
                } else {
                    let maxRows = query(cfg,
                        "SELECT COALESCE(MAX(lesson_index),-1) max_index FROM lessons WHERE course_id=" + sqlQuote(courseId))
                    let nextIndex = if (maxRows.size > 0) { maxRows[0].int("max_index") + 1 } else { 0 }
                    let title = "新课时 " + (nextIndex + 1).toString()
                    transaction(cfg, [
                        "INSERT INTO lessons(course_id,lesson_index,title,content_json,quiz_json,sources_json) VALUES(" +
                        sqlQuote(courseId) + "," + nextIndex.toString() + "," + sqlQuote(title) + "," +
                        sqlQuote(emptyLessonContent()) + ",'[]','[]')"
                    ])
                    writeChapters(cfg, courseId, chapterTitlesAppended(cfg, courseId, title))
                    let out = JsonWriter()
                    out.putInt("index", nextIndex)
                    out.putStr("title", title)
                    writeJson(ctx.response, 200, out.toJson())
                }
        }
    }

    app.mapGet("api/admin/courses/{course_id}/lessons/{lesson_index}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let index = Int64.tryParse(routeText(ctx, "lesson_index")) ?? -1
                if (index < 0) {
                    writeError(ctx.response, 400, "课时编号不正确")
                } else {
                    match (adminLessonBody(cfg, routeText(ctx, "course_id"), index)) {
                        case Some(body) => writeJson(ctx.response, 200, body)
                        case None => writeError(ctx.response, 404, "没有找到这个课时")
                    }
                }
        }
    }

    app.mapPut("api/admin/courses/{course_id}/lessons/{lesson_index}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let courseId = routeText(ctx, "course_id")
                let index = Int64.tryParse(routeText(ctx, "lesson_index")) ?? -1
                if (index < 0) {
                    writeError(ctx.response, 400, "课时编号不正确")
                } else {
                    let existing = query(cfg,
                        "SELECT title FROM lessons WHERE course_id=" + sqlQuote(courseId) +
                        " AND lesson_index=" + index.toString())
                    if (existing.size == 0) {
                        writeError(ctx.response, 404, "没有找到这个课时")
                    } else {
                        match (parseObject(ctx.request)) {
                            case None => writeError(ctx.response, 400, "课时内容格式不正确")
                            case Some(body) =>
                                let title = (jsonGetString(body, "title") ?? "").trimAscii()
                                let contentJson = jsonGetString(body, "contentJson") ?? ""
                                let quizJson = jsonGetString(body, "quizJson") ?? "[]"
                                let sourcesJson = jsonGetString(body, "sourcesJson") ?? "[]"
                                var problem = ""
                                if (title.size == 0 || title.size > 200) {
                                    problem = "课时标题需要 1–200 个字符"
                                } else {
                                    match (validateLessonContent(contentJson)) {
                                        case Some(message) => problem = message
                                        case None => ()
                                    }
                                    if (problem.size == 0) {
                                        match (validateLessonQuiz(quizJson)) {
                                            case Some(message) => problem = message
                                            case None => ()
                                        }
                                    }
                                    if (problem.size == 0) {
                                        match (validateLessonSources(sourcesJson)) {
                                            case Some(message) => problem = message
                                            case None => ()
                                        }
                                    }
                                }
                                if (problem.size > 0) {
                                    writeError(ctx.response, 400, problem)
                                } else {
                                    let chapters = chaptersJsonText(chapterTitlesRenamed(cfg, courseId, index, title))
                                    transaction(cfg, [
                                        "UPDATE lessons SET title=" + sqlQuote(title) +
                                        ",content_json=" + sqlQuote(contentJson) +
                                        ",quiz_json=" + sqlQuote(quizJson) +
                                        ",sources_json=" + sqlQuote(sourcesJson) +
                                        " WHERE course_id=" + sqlQuote(courseId) + " AND lesson_index=" + index.toString(),
                                        "UPDATE courses SET chapters_json=" + sqlQuote(chapters) +
                                        ",updated_at=NOW(6) WHERE id=" + sqlQuote(courseId)
                                    ])
                                    match (adminLessonBody(cfg, courseId, index)) {
                                        case Some(body2) => writeJson(ctx.response, 200, body2)
                                        case None => writeError(ctx.response, 500, "课时已保存，但读取失败，请刷新")
                                    }
                                }
                        }
                    }
                }
        }
    }

    app.mapDelete("api/admin/courses/{course_id}/lessons/{lesson_index}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let courseId = routeText(ctx, "course_id")
                let index = Int64.tryParse(routeText(ctx, "lesson_index")) ?? -1
                let maxRows = query(cfg,
                    "SELECT COALESCE(MAX(lesson_index),-1) max_index FROM lessons WHERE course_id=" + sqlQuote(courseId))
                let maxIndex = if (maxRows.size > 0) { maxRows[0].int("max_index") } else { -1 }
                if (index < 0 || maxIndex < 0) {
                    writeError(ctx.response, 404, "没有找到这个课时")
                } else if (index != maxIndex) {
                    writeError(ctx.response, 409, "只能删除最后一节课时，避免打乱已发布课时编号")
                } else {
                    transaction(cfg, [
                        "DELETE FROM quiz_attempts WHERE course_id=" + sqlQuote(courseId) +
                        " AND lesson_index=" + index.toString(),
                        "DELETE FROM lesson_progress WHERE course_id=" + sqlQuote(courseId) +
                        " AND lesson_index=" + index.toString(),
                        "DELETE FROM lessons WHERE course_id=" + sqlQuote(courseId) +
                        " AND lesson_index=" + index.toString()
                    ])
                    writeChapters(cfg, courseId, chapterTitlesWithoutLast(cfg, courseId))
                    let out = JsonWriter()
                    out.putBool("deleted", true)
                    out.putInt("index", index)
                    writeJson(ctx.response, 200, out.toJson())
                }
        }
    }

    app.mapDelete("api/admin/courses/{course_id}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let courseId = routeText(ctx, "course_id")
                let existing = query(cfg, "SELECT id FROM courses WHERE id=" + sqlQuote(courseId))
                if (existing.size == 0) {
                    writeError(ctx.response, 404, "没有找到这门课程")
                } else {
                    let progress = query(cfg,
                        "SELECT COUNT(*) n FROM lesson_progress WHERE course_id=" + sqlQuote(courseId))
                    let attempts = query(cfg,
                        "SELECT COUNT(*) n FROM quiz_attempts WHERE course_id=" + sqlQuote(courseId))
                    let used = (if (progress.size > 0) { progress[0].int("n") } else { 0 }) +
                        (if (attempts.size > 0) { attempts[0].int("n") } else { 0 })
                    if (used > 0) {
                        writeError(ctx.response, 409, "这门课程已经有学习记录，请改用下架，不要删除")
                    } else {
                        transaction(cfg, [
                            "DELETE FROM lessons WHERE course_id=" + sqlQuote(courseId),
                            "DELETE FROM courses WHERE id=" + sqlQuote(courseId)
                        ])
                        let out = JsonWriter()
                        out.putBool("deleted", true)
                        out.putStr("id", courseId)
                        writeJson(ctx.response, 200, out.toJson())
                    }
                }
        }
    }

    app.mapGet("api/admin/users") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let out = JsonWriter()
                out.putRaw("users", adminUsersBody(cfg))
                writeJson(ctx.response, 200, out.toJson())
        }
    }

    app.mapGet("api/admin/kb") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) => writeJson(ctx.response, 200, kbOverviewBody(cfg))
        }
    }

    app.mapPost("api/admin/kb/documents") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                match (parseObject(ctx.request)) {
                    case None => writeError(ctx.response, 400, "文档内容格式不正确")
                    case Some(body) =>
                        let title = (jsonGetString(body, "title") ?? "").trimAscii()
                        let content = jsonGetString(body, "content") ?? ""
                        let sourceName = (jsonGetString(body, "sourceName") ?? "").trimAscii()
                        let sourceType = (jsonGetString(body, "sourceType") ?? "paste").trimAscii()
                        let bytes = content.toArray()
                        if (title.size == 0 || title.size > 200) {
                            writeError(ctx.response, 400, "标题需要 1–200 个字符")
                        } else if (content.trimAscii().size == 0) {
                            writeError(ctx.response, 400, "文档内容不能为空")
                        } else if (bytes.size > 512000) {
                            writeError(ctx.response, 413, "单个文档不要超过 500KB，请拆分后再上传")
                        } else {
                            let id = uuidFormat(uuidV4())
                            execute(cfg,
                                "INSERT INTO kb_documents(id,title,source_name,source_type,mime,byte_size,char_count,content,status) VALUES(" +
                                sqlQuote(id) + "," + sqlQuote(title) + "," + sqlQuote(sourceName) + "," +
                                sqlQuote(if (sourceType.size == 0) { "paste" } else { sourceType }) +
                                ",'text/markdown'," + bytes.size.toString() + "," +
                                kbCharsBetween(bytes, 0, bytes.size).toString() + "," + sqlQuote(content) + ",'pending')")
                            let settings = loadKbSettings(cfg)
                            let jobId = kbQueueDocumentBuild(cfg, id, settings)
                            writeJson(ctx.response, 202, kbQueuedIngestBody(cfg, id, jobId))
                        }
                }
        }
    }

    app.mapGet("api/admin/kb/documents/{document_id}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                match (kbDocumentDetailBody(cfg, routeText(ctx, "document_id"))) {
                    case Some(body) => writeJson(ctx.response, 200, body)
                    case None => writeError(ctx.response, 404, "没有找到这个文档")
                }
        }
    }

    app.mapPost("api/admin/kb/documents/{document_id}/reindex") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let docId = routeText(ctx, "document_id")
                let rows = query(cfg, "SELECT title,content FROM kb_documents WHERE id=" + sqlQuote(docId))
                if (rows.size == 0) {
                    writeError(ctx.response, 404, "没有找到这个文档")
                } else {
                    let settings = loadKbSettings(cfg)
                    let jobId = kbQueueDocumentBuild(cfg, docId, settings)
                    writeJson(ctx.response, 202, kbQueuedIngestBody(cfg, docId, jobId))
                }
        }
    }

    app.mapPost("api/admin/kb/documents/{document_id}/publish") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let docId = routeText(ctx, "document_id")
                let body = match (parseObject(ctx.request)) {
                    case Some(value) => value
                    case None => JsonObject()
                }
                let name = (jsonGetString(body, "name") ?? "").trimAscii()
                let level = (jsonGetString(body, "level") ?? "").trimAscii()
                let description = jsonGetString(body, "description") ?? ""
                let duration = jsonGetInt(body, "duration") ?? 0
                match (kbPublishCourse(cfg, docId, name, level, duration, description)) {
                    case None => writeError(ctx.response, 400, "这个文档还没有切片，请先建立索引再发布")
                    case Some(result) =>
                        let out = JsonWriter()
                        out.putStr("courseId", result.courseId)
                        out.putInt("lessonCount", result.lessonCount)
                        out.putBool("created", result.created)
                        match (kbDocumentDetailBody(cfg, docId)) {
                            case Some(detail) => out.putRaw("document", detail)
                            case None => out.putRaw("document", "null")
                        }
                        writeJson(ctx.response, 200, out.toJson())
                }
        }
    }

    app.mapPost("api/admin/kb/documents/{document_id}/unpublish") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let docId = routeText(ctx, "document_id")
                if (kbSetCourseStatus(cfg, docId, "draft")) {
                    let out = JsonWriter()
                    out.putBool("ok", true)
                    out.putStr("courseStatus", "draft")
                    writeJson(ctx.response, 200, out.toJson())
                } else {
                    writeError(ctx.response, 404, "这个文档还没有发布过课程")
                }
        }
    }

    app.mapDelete("api/admin/kb/documents/{document_id}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let docId = routeText(ctx, "document_id")
                let rows = query(cfg, "SELECT id FROM kb_documents WHERE id=" + sqlQuote(docId))
                if (rows.size == 0) {
                    writeError(ctx.response, 404, "没有找到这个文档")
                } else {
                    let courseNote = kbDropDocumentCourse(cfg, docId)
                    execute(cfg, "DELETE FROM kb_documents WHERE id=" + sqlQuote(docId))
                    kbBumpVersion()
                    let out = JsonWriter()
                    out.putBool("deleted", true)
                    out.putStr("courseNote", courseNote)
                    writeJson(ctx.response, 200, out.toJson())
                }
        }
    }

    app.mapPost("api/admin/kb/search") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                match (parseObject(ctx.request)) {
                    case None => writeError(ctx.response, 400, "检索条件格式不正确")
                    case Some(body) =>
                        let queryText = (jsonGetString(body, "query") ?? "").trimAscii()
                        let settings = loadKbSettings(cfg)
                        let requested = jsonGetInt(body, "topK") ?? settings.topK
                        let topK = if (requested < 1) { settings.topK } else if (requested > 20) { 20 } else { requested }
                        if (queryText.size == 0) {
                            writeError(ctx.response, 400, "请填写检索内容")
                        } else {
                            writeJson(ctx.response, 200, kbSearchBody(cfg, settings, queryText, topK))
                        }
                }
        }
    }

    app.mapPut("api/admin/kb/settings") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                match (parseObject(ctx.request)) {
                    case None => writeError(ctx.response, 400, "配置格式不正确")
                    case Some(body) =>
                        let current = loadKbSettings(cfg)
                        let chunkSize = jsonGetInt(body, "chunkSize") ?? current.chunkSize
                        let overlap = jsonGetInt(body, "chunkOverlap") ?? current.chunkOverlap
                        let batch = jsonGetInt(body, "batchSize") ?? current.batchSize
                        let topK = jsonGetInt(body, "topK") ?? current.topK
                        let dim = jsonGetInt(body, "embeddingDim") ?? current.embeddingDim
                        let embeddingBase = (jsonGetString(body, "embeddingBaseUrl") ?? "").trimAscii()
                        let embeddingModel = (jsonGetString(body, "embeddingModel") ?? "").trimAscii()
                        let embeddingKey = (jsonGetString(body, "embeddingApiKey") ?? "").trimAscii()
                        let embeddingClear = jsonGetBool(body, "embeddingClearKey") ?? false
                        let chatBase = (jsonGetString(body, "chatBaseUrl") ?? "").trimAscii()
                        let chatModel = (jsonGetString(body, "chatModel") ?? "").trimAscii()
                        let chatKey = (jsonGetString(body, "chatApiKey") ?? "").trimAscii()
                        let chatClear = jsonGetBool(body, "chatClearKey") ?? false
                        let ttsBase = (jsonGetString(body, "ttsBaseUrl") ?? "").trimAscii()
                        let ttsModel = (jsonGetString(body, "ttsModel") ?? "").trimAscii()
                        let ttsVoice = (jsonGetString(body, "ttsVoice") ?? "").trimAscii()
                        let ttsPath = (jsonGetString(body, "ttsPath") ?? "").trimAscii()
                        let ttsKey = (jsonGetString(body, "ttsApiKey") ?? "").trimAscii()
                        let ttsClear = jsonGetBool(body, "ttsClearKey") ?? false
                        var problem = ""
                        for (url in [embeddingBase, chatBase, ttsBase]) {
                            if (url.size > 0 && !url.startsWith("http")) { problem = "接口地址需要以 http:// 或 https:// 开头" }
                            if (url.size > 300) { problem = "接口地址过长" }
                        }
                        if (problem.size == 0 && (embeddingModel.size > 160 || chatModel.size > 160 || ttsModel.size > 160)) {
                            problem = "模型名过长"
                        }
                        if (problem.size == 0 && ttsVoice.size > 80) { problem = "音色名过长" }
                        if (problem.size == 0 && (embeddingKey.size > 400 || chatKey.size > 400 || ttsKey.size > 400)) {
                            problem = "密钥过长"
                        }
                        if (problem.size == 0 && (embeddingKey.size > 0 || chatKey.size > 0 || ttsKey.size > 0)
                            && cfg.authSecret.size == 0) {
                            problem = "服务端缺少 ZHIXUN_AUTH_SECRET，无法加密保存密钥"
                        }
                        if (problem.size == 0 && (chunkSize < 200 || chunkSize > 4000)) {
                            problem = "切片长度需要在 200–4000 字之间"
                        }
                        if (problem.size == 0 && (overlap < 0 || overlap * 2 >= chunkSize)) {
                            problem = "重叠长度要小于切片长度的一半"
                        }
                        if (problem.size == 0 && (batch < 1 || batch > 64)) { problem = "批量条数需要在 1–64 之间" }
                        if (problem.size == 0 && (topK < 1 || topK > 20)) { problem = "默认召回条数需要在 1–20 之间" }
                        if (problem.size > 0) {
                            writeError(ctx.response, 400, problem)
                        } else {
                            let embeddingCipher = kbKeyCipherValue(cfg, embeddingKey, embeddingClear, current.embedding.cipher)
                            let embeddingHint = kbKeyHintValue(embeddingKey, embeddingClear, current.embedding.hint)
                            let chatCipher = kbKeyCipherValue(cfg, chatKey, chatClear, current.chat.cipher)
                            let chatHint = kbKeyHintValue(chatKey, chatClear, current.chat.hint)
                            let ttsCipher = kbKeyCipherValue(cfg, ttsKey, ttsClear, current.tts.cipher)
                            let ttsHint = kbKeyHintValue(ttsKey, ttsClear, current.tts.hint)
                            execute(cfg,
                                "UPDATE kb_settings SET embedding_base_url=" + sqlQuote(embeddingBase) +
                                ",embedding_model=" + sqlQuote(embeddingModel) +
                                ",embedding_api_key_cipher=" + embeddingCipher +
                                ",embedding_api_key_hint=" + sqlQuote(embeddingHint) +
                                ",chat_base_url=" + sqlQuote(chatBase) +
                                ",chat_model=" + sqlQuote(chatModel) +
                                ",chat_api_key_cipher=" + chatCipher +
                                ",chat_api_key_hint=" + sqlQuote(chatHint) +
                                ",tts_base_url=" + sqlQuote(ttsBase) +
                                ",tts_model=" + sqlQuote(ttsModel) +
                                ",tts_voice=" + sqlQuote(ttsVoice) +
                                ",tts_path=" + sqlQuote(if (ttsPath.size == 0) { "/audio/speech" } else { ttsPath }) +
                                ",tts_api_key_cipher=" + ttsCipher +
                                ",tts_api_key_hint=" + sqlQuote(ttsHint) +
                                ",embedding_dim=" + maxInt(0, dim).toString() +
                                ",batch_size=" + batch.toString() +
                                ",chunk_size=" + chunkSize.toString() +
                                ",chunk_overlap=" + overlap.toString() +
                                ",top_k=" + topK.toString() + " WHERE id=1")
                            let out = JsonWriter()
                            out.putRaw("settings", kbSettingsJson(cfg, loadKbSettings(cfg)))
                            writeJson(ctx.response, 200, out.toJson())
                        }
                }
        }
    }

    app.mapPost("api/admin/kb/test") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let settings = loadKbSettings(cfg)
                let body = match (parseObject(ctx.request)) {
                    case Some(value) => value
                    case None => JsonObject()
                }
                let target = (jsonGetString(body, "target") ?? "embedding").trimAscii()
                let saved = if (target == "chat") { settings.chat } else if (target == "tts") { settings.tts } else { settings.embedding }
                let label = if (target == "chat") { "对话模型" } else if (target == "tts") { "语音合成" } else { "向量模型" }
                // 优先用页面上刚填、还没保存的值进行测试。
                let inputBase = (jsonGetString(body, "baseUrl") ?? "").trimAscii()
                let inputModel = (jsonGetString(body, "model") ?? "").trimAscii()
                let inputKey = (jsonGetString(body, "apiKey") ?? "").trimAscii()
                let inputVoice = (jsonGetString(body, "voice") ?? "").trimAscii()
                let slot = ModelSlot(
                    if (inputBase.size > 0) { inputBase } else { saved.baseUrl },
                    if (inputModel.size > 0) { inputModel } else { saved.model },
                    saved.cipher,
                    saved.hint
                )
                let key = if (inputKey.size > 0) { inputKey } else { resolveKey(cfg, saved) }
                let endpoint = ModelEndpoint(slot.baseUrl, key, slot.model, slot.model)
                let voice = if (inputVoice.size > 0) { inputVoice } else { settings.ttsVoice }
                if (!slot.configured()) {
                    writeError(ctx.response, 400, "还没有配置" + label + "：需要接口地址和模型名")
                } else if (key.size == 0) {
                    writeError(ctx.response, 400, "还没有配置" + label + "的密钥")
                } else if (target == "chat") {
                    try {
                        let messages = JsonArrWriter()
                        let systemPart = JsonWriter()
                        systemPart.putStr("role", "system")
                        systemPart.putStr("content", "只回复：ok")
                        messages.addRaw(systemPart.toJson())
                        let userPart = JsonWriter()
                        userPart.putStr("role", "user")
                        userPart.putStr("content", "连接测试")
                        messages.addRaw(userPart.toJson())
                        let answer = chatStreamText(endpoint, messages.toJson(), 0.0, { piece: String => () })
                        let out = JsonWriter()
                        out.putBool("ok", true)
                        out.putStr("model", slot.model)
                        out.putInt("replyLength", answer.size)
                        writeJson(ctx.response, 200, out.toJson())
                    } catch (error: Exception) {
                        writeError(ctx.response, 502, "对话模型连接失败：" + error.message)
                    }
                } else if (target == "tts") {
                    try {
                        let speechPath = (jsonGetString(body, "ttsPath") ?? "").trimAscii()
                let effectivePath = if (speechPath.size > 0) { speechPath } else { settings.ttsPath }
                        let status = ttsCheck(endpoint, voice, "连接测试", effectivePath)
                        if (status == 200) {
                            let out = JsonWriter()
                            out.putBool("ok", true)
                            out.putStr("model", slot.model)
                            out.putStr("voice", voice)
                            writeJson(ctx.response, 200, out.toJson())
                        } else {
                            writeError(ctx.response, 502, "语音合成接口返回 " + status.toString())
                        }
                    } catch (error: Exception) {
                        writeError(ctx.response, 502, "语音合成连接失败：" + error.message)
                    }
                } else {
                    try {
                        let vectors = embedTexts(endpoint, ["知识库连接测试"])
                        let out = JsonWriter()
                        out.putBool("ok", true)
                        out.putStr("model", slot.model)
                        out.putInt("dim", vectors[0].size)
                        writeJson(ctx.response, 200, out.toJson())
                    } catch (error: Exception) {
                        writeError(ctx.response, 502, "向量模型连接失败：" + error.message)
                    }
                }
        }
    }

    app.mapPost("api/tutor/chat") { ctx =>
        match (authenticate(ctx, cfg)) {
            case None => ()
            case Some(userId) =>
                match (parseObject(ctx.request)) {
                    case None => writeError(ctx.response, 400, "提问格式不正确")
                    case Some(body) =>
                        let message = (jsonGetString(body, "message") ?? "").trimAscii()
                        let quoted = (jsonGetString(body, "quote") ?? "").trimAscii()
                        let courseId = (jsonGetString(body, "courseId") ?? "").trimAscii()
                        let lessonTitle = (jsonGetString(body, "lessonTitle") ?? "").trimAscii()
                        let lessonIndex = jsonGetInt(body, "lessonIndex") ?? -1
                        if (message.size == 0) {
                            writeError(ctx.response, 400, "请先输入问题")
                        } else if (message.size > 2000) {
                            writeError(ctx.response, 413, "问题请精简到 2000 字以内")
                        } else {
                            let settings = loadKbSettings(cfg)
                            let chatSlot = settings.chat
                            let endpoint = slotEndpoint(cfg, chatSlot)
                            if (!chatSlot.configured() || !endpoint.hasChat()) {
                                writeError(ctx.response, 503,
                                    "AI 导师还没有接入对话模型：请管理员在「设置」里填写对话模型的接口地址、模型名和密钥")
                            } else {
                                let searchQuery = if (quoted.size > 0) { quoted + "\n" + message } else { message }
                                let result = kbSearch(cfg, settings, searchQuery, settings.topK, courseId, true)
                                let messages = JsonArrWriter()
                                let systemPart = JsonWriter()
                                systemPart.putStr("role", "system")
                                systemPart.putStr("content", tutorSystemPrompt())
                                messages.addRaw(systemPart.toJson())
                                let userPart = JsonWriter()
                                userPart.putStr("role", "user")
                                userPart.putStr("content", tutorQuestionText(result.hits, quoted, courseId, lessonTitle, message))
                                messages.addRaw(userPart.toJson())
                                try {
                                    let answer = chatStreamText(endpoint, messages.toJson(), 0.3, { piece: String => () })
                                    let citations = tutorCitationsJson(result.hits)
                                    saveTutorMessage(cfg, userId, "user", message, "", courseId, lessonIndex)
                                    saveTutorMessage(cfg, userId, "assistant", answer, citations, courseId, lessonIndex)
                                    let out = JsonWriter()
                                    out.putStr("answer", answer)
                                    out.putRaw("citations", citations)
                                    out.putStr("mode", result.mode)
                                    out.putStr("note", result.note)
                                    writeJson(ctx.response, 200, out.toJson())
                                } catch (error: Exception) {
                                    writeError(ctx.response, 502, "模型调用失败：" + error.message)
                                }
                            }
                        }
                }
        }
    }

    app.mapGet("api/tutor/history") { ctx =>
        match (authenticate(ctx, cfg)) {
            case None => ()
            case Some(userId) =>
                let rows = query(cfg,
                    "SELECT role,content,citations_json,COALESCE(DATE_FORMAT(created_at,'%Y-%m-%d %H:%i'),'') created_at " +
                    "FROM tutor_messages WHERE user_id=" + sqlQuote(userId) +
                    " ORDER BY created_at DESC LIMIT 20")
                let arr = JsonArrWriter()
                var i = rows.size
                while (i > 0) {
                    i -= 1
                    let row = rows[i]
                    let item = JsonWriter()
                    item.putStr("role", row.text("role"))
                    item.putStr("content", row.text("content"))
                    item.putRaw("citations", if (row.isNull("citations_json")) { "null" } else { row.text("citations_json") })
                    item.putStr("createdAt", row.text("created_at"))
                    arr.addRaw(item.toJson())
                }
                let out = JsonWriter()
                out.putRaw("messages", arr.toJson())
                writeJson(ctx.response, 200, out.toJson())
        }
    }

    app.mapPost("api/admin/kb/bundles") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(ownerId) =>
                let nameHeader = match (ctx.request.headers.get("X-Bundle-Name")) {
                    case Some(value) => value
                    case None => ""
                }
                let name = kbUrlDecode(nameHeader)
                let bundleId = uuidFormat(uuidV4())
                let received = try { kbReceiveBundleUpload(ctx.request, bundleId) }
                catch (error: Exception) {
                    kbRemoveBundleZip(cfg, bundleId)
                    writeError(ctx.response, if (error.message.contains("256MB")) { 413 } else { 400 }, error.message)
                    return
                }
                let settings = loadKbSettings(cfg)
                if (received.size < 100) {
                    kbRemoveBundleZip(cfg, bundleId)
                    writeError(ctx.response, 400, "压缩包为空或不是有效的 zip")
                } else {
                    let existing = query(cfg, "SELECT id,status FROM kb_bundles WHERE upload_hash=" + sqlQuote(received.hash) + " LIMIT 1")
                    if (existing.size > 0) {
                        kbRemoveBundleZip(cfg, bundleId)
                        let out = JsonWriter()
                        out.putStr("id", existing[0].text("id"))
                        out.putStr("status", existing[0].text("status"))
                        out.putBool("reused", true)
                        writeJson(ctx.response, 200, out.toJson())
                        return
                    }
                    let safeName = if (name.size == 0) { "资料包.zip" } else { kbTruncate(name, 230) }
                    try {
                        execute(cfg,
                            "INSERT INTO kb_bundles(id,name,bytes,status,model,owner_id,upload_hash,created_at) VALUES(" +
                            sqlQuote(bundleId) + "," + sqlQuote(safeName) + "," + received.size.toString() +
                            ",'queued'," + sqlQuote(settings.chat.model) + "," + sqlQuote(ownerId) + "," + sqlQuote(received.hash) + ",NOW(6))")
                    } catch (error: Exception) {
                        kbRemoveBundleZip(cfg, bundleId)
                        let duplicate = query(cfg, "SELECT id,status FROM kb_bundles WHERE upload_hash=" + sqlQuote(received.hash) + " LIMIT 1")
                        if (duplicate.size > 0) {
                            let out = JsonWriter()
                            out.putStr("id", duplicate[0].text("id"))
                            out.putStr("status", duplicate[0].text("status"))
                            out.putBool("reused", true)
                            writeJson(ctx.response, 200, out.toJson())
                            return
                        }
                        writeError(ctx.response, 500, "保存资料包失败：" + error.message)
                        return
                    }
                    kbLaunchBundle(cfg, bundleId)
                    let out = JsonWriter()
                    out.putStr("id", bundleId)
                    out.putStr("status", "queued")
                    out.putBool("reused", false)
                    writeJson(ctx.response, 202, out.toJson())
                }
        }
    }

    app.mapGet("api/admin/kb/bundles") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) => writeJson(ctx.response, 200, kbBundlesBody(cfg))
        }
    }

    app.mapGet("api/admin/kb/bundles/{bundle_id}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                match (kbBundleDetailBody(cfg, routeText(ctx, "bundle_id"), (ctx.request.query.get("metadata") ?? "") != "1")) {
                    case Some(body) => writeJson(ctx.response, 200, body)
                    case None => writeError(ctx.response, 404, "没有找到这个资料包")
                }
        }
    }

    app.mapGet("api/admin/kb/bundles/{bundle_id}/docs/{doc_id}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let docs = queryIndependent(cfg, "SELECT id,COALESCE(document_id,'') document_id,order_index,title,char_count,content," +
                    "COALESCE(source_path,'') source_path FROM kb_bundle_docs WHERE bundle_id=" + sqlQuote(routeText(ctx, "bundle_id")) +
                    " AND id=" + sqlQuote(routeText(ctx, "doc_id")) + " LIMIT 1")
                if (docs.size == 0) { writeError(ctx.response, 404, "没有找到这个章节") }
                else {
                    let out = JsonWriter()
                    out.putRaw("doc", kbBundleSourceJson(docs[0], true))
                    writeJson(ctx.response, 200, out.toJson())
                }
        }
    }

    app.mapGet("api/admin/kb/bundles/{bundle_id}/status") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let rows = query(cfg, kbBundleSelect() + "WHERE b.id=" + sqlQuote(routeText(ctx, "bundle_id")) + " LIMIT 1")
                if (rows.size == 0) { writeError(ctx.response, 404, "没有找到这个资料包") }
                else {
                    let out = JsonWriter()
                    out.putRaw("bundle", kbBundleJson(rows[0]))
                    writeJson(ctx.response, 200, out.toJson())
                }
        }
    }

    app.mapGet("api/admin/kb/bundles/{bundle_id}/assets/{asset_id}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) => kbWriteBundleAsset(ctx.response, cfg, routeText(ctx, "bundle_id"), routeText(ctx, "asset_id"))
        }
    }

    app.mapGet("api/admin/kb/bundles/{bundle_id}/chunks") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let offsetRaw = Int64.tryParse(ctx.request.query.get("offset") ?? "0") ?? 0
                let limitRaw = Int64.tryParse(ctx.request.query.get("limit") ?? "30") ?? 30
                let offset = if (offsetRaw < 0) { 0 } else { offsetRaw }
                let limit = if (limitRaw < 1) { 30 } else if (limitRaw > 100) { 100 } else { limitRaw }
                match (kbBundleChunksBody(cfg, routeText(ctx, "bundle_id"), offset, limit)) {
                    case Some(body) => writeJson(ctx.response, 200, body)
                    case None => writeError(ctx.response, 404, "没有找到这个资料包")
                }
        }
    }

    app.mapPost("api/admin/kb/bundles/{bundle_id}/retry") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let body = parseObject(ctx.request)
                let stage = match (body) { case Some(value) => jsonGetString(value, "stage") ?? "all"; case None => "all" }
                if (stage != "all" && stage != "summaries" && stage != "embeddings" && stage != "logo") {
                    writeError(ctx.response, 400, "重试阶段不正确")
                } else if (kbRetryBundle(cfg, routeText(ctx, "bundle_id"), stage)) {
                    match (kbBundleDetailBody(cfg, routeText(ctx, "bundle_id"), (ctx.request.query.get("metadata") ?? "") != "1")) {
                        case Some(result) => writeJson(ctx.response, 202, result)
                        case None => writeError(ctx.response, 404, "没有找到这个资料包")
                    }
                } else { writeError(ctx.response, 404, "没有找到这个资料包") }
        }
    }

    app.mapPost("api/admin/kb/bundles/{bundle_id}/publish") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                match (kbPublishBundle(cfg, routeText(ctx, "bundle_id"))) {
                    case Some(result) =>
                        let out = JsonWriter()
                        out.putStr("courseId", result.courseId)
                        out.putInt("lessonCount", result.lessonCount)
                        out.putBool("created", result.created)
                        writeJson(ctx.response, 200, out.toJson())
                    case None => writeError(ctx.response, 409, "原文尚未保存或资料包不存在，暂时无法发布")
                }
        }
    }

    app.mapPost("api/admin/kb/bundles/{bundle_id}/unpublish") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                if (kbSetBundleCourseStatus(cfg, routeText(ctx, "bundle_id"), "draft")) { writeJson(ctx.response, 200, "{\"unpublished\":true}") }
                else { writeError(ctx.response, 404, "这个资料包还没有发布课程") }
        }
    }

    app.mapPost("api/admin/logos/generate") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(ownerId) =>
                match (parseObject(ctx.request)) {
                    case None => writeError(ctx.response, 400, "Logo生成参数不正确")
                    case Some(body) =>
                        let title = (jsonGetString(body, "title") ?? "").trimAscii()
                        let resourceType = jsonGetString(body, "resourceType") ?? ""
                        let resourceId = jsonGetString(body, "resourceId") ?? ""
                        if (title.size == 0 || kbCharsBetween(title.toArray(), 0, title.size) > 240) { writeError(ctx.response, 400, "请输入不超过240字的资源标题") }
                        else if (resourceType == "kb_bundle" && query(cfg, "SELECT id FROM kb_bundles WHERE id=" + sqlQuote(resourceId)).size == 0) {
                            writeError(ctx.response, 404, "没有找到关联的资料包")
                        } else {
                            let id = kbQueueLogoGeneration(cfg, title, ownerId, resourceType, resourceId)
                            let out = JsonWriter()
                            out.putStr("generationId", id)
                            out.putStr("status", "queued")
                            writeJson(ctx.response, 202, out.toJson())
                        }
                }
        }
    }

    app.mapGet("api/admin/logos/{generation_id}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                match (kbLogoGenerationBody(cfg, routeText(ctx, "generation_id"))) {
                    case Some(body) => writeJson(ctx.response, 200, body)
                    case None => writeError(ctx.response, 404, "没有找到这次Logo生成记录")
                }
        }
    }

    app.mapPost("api/admin/logos/{generation_id}/select") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                match (parseObject(ctx.request)) {
                    case None => writeError(ctx.response, 400, "请选择一个Logo")
                    case Some(body) =>
                        let id = routeText(ctx, "generation_id")
                        let variant = jsonGetString(body, "variantId") ?? ""
                        if (kbSelectLogoVariant(cfg, id, variant)) {
                            match (kbLogoGenerationBody(cfg, id)) {
                                case Some(result) => writeJson(ctx.response, 200, result)
                                case None => writeError(ctx.response, 404, "没有找到这次Logo生成记录")
                            }
                        } else { writeError(ctx.response, 404, "Logo尚未完成或所选样式不存在") }
                }
        }
    }

    app.mapDelete("api/admin/kb/bundles/{bundle_id}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let bundleId = routeText(ctx, "bundle_id")
                let rows = query(cfg, "SELECT id,status FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
                if (rows.size == 0) {
                    writeError(ctx.response, 404, "没有找到这个资料包")
                } else if (rows[0].text("status") == "queued" || rows[0].text("status") == "running") {
                    writeError(ctx.response, 409, "资料包正在处理中，请完成后再删除")
                } else {
                    kbDeleteBundleContent(cfg, bundleId)
                    let out = JsonWriter()
                    out.putBool("deleted", true)
                    writeJson(ctx.response, 200, out.toJson())
                }
        }
    }

    app.mapGet("api/kb/bundles/{bundle_id}/assets/{asset_id}") { ctx =>
        match (authenticate(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let id = routeText(ctx, "bundle_id")
                if (kbBundlePublished(cfg, id)) { kbWriteBundleAsset(ctx.response, cfg, id, routeText(ctx, "asset_id")) }
                else { writeError(ctx.response, 404, "这份课程资料尚未发布") }
        }
    }
    app.mapGet("api/kb/bundles/{bundle_id}/logo") { ctx =>
        let id = routeText(ctx, "bundle_id")
        if (kbBundlePublished(cfg, id)) { kbWriteBundleLogo(ctx.response, cfg, id) }
        else { writeError(ctx.response, 404, "这份课程资料尚未发布") }
    }

    kbStartIngestWorkers(cfg)
    kbStartLogoWorker(cfg)
    kbRestoreBundleJobs(cfg)
    app.mapPost("api/admin/kb/courseware") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                match (parseObject(ctx.request)) {
                    case None => writeError(ctx.response, 400, "课件参数格式不正确")
                    case Some(body) =>
                        let bundleId = (jsonGetString(body, "bundleId") ?? "").trimAscii()
                        let docId = (jsonGetString(body, "docId") ?? "").trimAscii()
                        let kinds = jsonGetArray(body, "kinds") ?? JsonArray()
                        let docs = query(cfg,
                            "SELECT id,title FROM kb_bundle_docs WHERE id=" + sqlQuote(docId) +
                            " AND bundle_id=" + sqlQuote(bundleId))
                        if (docs.size == 0) {
                            writeError(ctx.response, 404, "这个章节不属于所选知识库")
                        } else if (kinds.size() == 0) {
                            writeError(ctx.response, 400, "请选择要生成的资源")
                        } else {
                            let settings = loadKbSettings(cfg)
                            if (!slotEndpoint(cfg, settings.chat).hasChat()) {
                                writeError(ctx.response, 400, "还没有配置对话模型")
                            } else {
                                let created = ArrayList<String>()
                                let items = JsonArrWriter()
                                var i: Int64 = 0
                                while (i < kinds.size()) {
                                    let kind = match (kinds[i].kind()) {
                                        case JsonKind.JsString => kinds[i].asString().getValue()
                                        case _ => ""
                                    }
                                    if (cwValidKind(kind)) {
                                        let id = uuidFormat(uuidV4())
                                        execute(cfg,
                                            "INSERT INTO kb_courseware(id,bundle_id,doc_id,kind,title,status,model,created_at) VALUES(" +
                                            sqlQuote(id) + "," + sqlQuote(bundleId) + "," + sqlQuote(docId) + "," +
                                            sqlQuote(kind) + ",''," + sqlQuote("generating") + "," +
                                            sqlQuote(settings.chat.model) + ",NOW(6))")
                                        created.add(id)
                                        let item = JsonWriter()
                                        item.putStr("id", id)
                                        item.putStr("kind", kind)
                                        item.putStr("status", "generating")
                                        items.addRaw(item.toJson())
                                    }
                                    i += 1
                                }
                                if (created.size == 0) {
                                    writeError(ctx.response, 400, "没有可生成的资源类型")
                                } else {
                                    cwLaunch(cfg, created.toArray())
                                    let out = JsonWriter()
                                    out.putRaw("items", items.toJson())
                                    writeJson(ctx.response, 200, out.toJson())
                                }
                            }
                        }
                }
        }
    }

    app.mapGet("api/admin/kb/courseware") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let bundleId = (ctx.request.query.get("bundleId") ?? "").trimAscii()
                writeJson(ctx.response, 200, cwListBody(cfg, bundleId))
        }
    }

    app.mapGet("api/admin/kb/courseware/{courseware_id}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                match (cwDetailBody(cfg, routeText(ctx, "courseware_id"))) {
                    case Some(body) => writeJson(ctx.response, 200, body)
                    case None => writeError(ctx.response, 404, "没有找到这份课件")
                }
        }
    }

    app.mapPost("api/admin/kb/courseware/{courseware_id}/publish") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let id = routeText(ctx, "courseware_id")
                let rows = query(cfg, "SELECT status FROM kb_courseware WHERE id=" + sqlQuote(id))
                if (rows.size == 0) {
                    writeError(ctx.response, 404, "没有找到这份课件")
                } else if (rows[0].text("status") != "ready") {
                    writeError(ctx.response, 409, "只有生成完成的课件可以发布")
                } else {
                    execute(cfg, "UPDATE kb_courseware SET published=1,updated_at=NOW(6) WHERE id=" + sqlQuote(id))
                    let out = JsonWriter()
                    out.putBool("published", true)
                    writeJson(ctx.response, 200, out.toJson())
                }
        }
    }

    app.mapPost("api/admin/kb/courseware/{courseware_id}/unpublish") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let id = routeText(ctx, "courseware_id")
                execute(cfg, "UPDATE kb_courseware SET published=0,updated_at=NOW(6) WHERE id=" + sqlQuote(id))
                let out = JsonWriter()
                out.putBool("published", false)
                writeJson(ctx.response, 200, out.toJson())
        }
    }

    app.mapDelete("api/admin/kb/courseware/{courseware_id}") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let id = routeText(ctx, "courseware_id")
                let rows = query(cfg, "SELECT id FROM kb_courseware WHERE id=" + sqlQuote(id))
                if (rows.size == 0) {
                    writeError(ctx.response, 404, "没有找到这份课件")
                } else {
                    execute(cfg, "DELETE FROM kb_courseware WHERE id=" + sqlQuote(id))
                    let out = JsonWriter()
                    out.putBool("deleted", true)
                    writeJson(ctx.response, 200, out.toJson())
                }
        }
    }

    app.mapGet("api/admin/org") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) => writeJson(ctx.response, 200, orgBrandJson(cfg, true))
        }
    }

    app.mapPut("api/admin/org") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                match (parseObject(ctx.request)) {
                    case None => writeError(ctx.response, 400, "机构信息格式不正确")
                    case Some(body) =>
                        let name = (jsonGetString(body, "name") ?? "").trimAscii()
                        let shortName = (jsonGetString(body, "shortName") ?? "").trimAscii()
                        if (name.size == 0 || name.size > 128) {
                            writeError(ctx.response, 400, "机构全称需要 1–128 个字符")
                        } else if (shortName.size == 0 || shortName.size > 64) {
                            writeError(ctx.response, 400, "机构简称需要 1–64 个字符")
                        } else {
                            execute(cfg, "UPDATE org_settings SET name=" + sqlQuote(name) +
                                ",short_name=" + sqlQuote(shortName) + ",updated_at=NOW(6) WHERE id=1")
                            writeJson(ctx.response, 200, orgBrandJson(cfg, true))
                        }
                }
        }
    }

    app.mapPost("api/admin/org/logo") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                let data = readBodyBytes(ctx.request)
                if (data.size < 32) {
                    writeError(ctx.response, 400, "图片内容为空")
                } else if (data.size > 4 * 1024 * 1024) {
                    writeError(ctx.response, 413, "Logo 图片不要超过 4MB")
                } else {
                    let mime = orgLogoMime(data)
                    if (mime.size == 0) {
                        writeError(ctx.response, 415, "只支持 PNG / JPEG / WebP / GIF / SVG")
                    } else {
                        orgLogoDir()
                        kbWriteFileDeep(orgLogoPath(), data)
                        execute(cfg, "UPDATE org_settings SET logo_mime=" + sqlQuote(mime) +
                            ",updated_at=NOW(6) WHERE id=1")
                        writeJson(ctx.response, 200, orgBrandJson(cfg, true))
                    }
                }
        }
    }

    app.mapDelete("api/admin/org/logo") { ctx =>
        match (adminUserId(ctx, cfg)) {
            case None => ()
            case Some(_) =>
                execute(cfg, "UPDATE org_settings SET logo_mime='',updated_at=NOW(6) WHERE id=1")
                try { if (exists(Path(orgLogoPath()))) { remove(Path(orgLogoPath())) } } catch (_: Exception) {}
                writeJson(ctx.response, 200, orgBrandJson(cfg, true))
        }
    }

    app.mapGet("api/org") { ctx =>
        writeJson(ctx.response, 200, orgBrandJson(cfg, false))
    }

    app.mapGet("api/org/logo") { ctx =>
        orgWriteLogo(ctx.response, cfg)
    }

    app.run(cfg.listen)
    return 0
}
