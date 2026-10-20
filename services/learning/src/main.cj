package zhixun_learning

import std.collection.*
import std.convert.*
import std.core.*
import std.env.*
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
        "ORDER BY FIELD(id,'ds','co','os','cn','agent')")
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
        "SELECT course_id,lesson_index,title,content_json,quiz_json,sources_json FROM lessons WHERE course_id=" +
        sqlQuote(courseId) + " AND lesson_index=" + index.toString())
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

main(): Int64 {
    let cfg = loadConfig()
    let initial = connect(cfg)
    sharedDatabase = Some(initial)
    let builder = WebHost.createBuilder([])
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

    app.run(cfg.listen)
    return 0
}
