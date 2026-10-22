package itn_spire

import std.core.*
import std.collection.*
import std.convert.*

/*
 * P2 read side: 「画像/成长」 learner rows out of MySQL.
 *
 * Mirrors src/backend/.../service/LearnForgeSupportService.java so the same
 * frontend call keeps the same JSON. The two behaviours that are easy to get
 * wrong live in toLearnerResponse (LearnForgeSupportService.java:258-276):
 *
 *   1. scores_json is parsed as Map<String, Integer>. A blank value OR a
 *      parse failure yields an EMPTY map — it is never an error.
 *   2. When that map is empty, every ENABLED knowledge point's code is filled
 *      in with 50 (putIfAbsent, iterating knowledge_point ordered by
 *      sort_order ASC, id ASC).
 *
 * overallMastery is the arithmetic mean of the resulting map's values,
 * rounded HALF_UP to one decimal place, or 0 when the map is empty.
 *
 * Java does not filter learners by `status` on the list path
 * (findByUser_IdOrderByCreatedAtAsc has no status predicate), so neither do we.
 */
public class LearnForgeStore {
    private let conn: MyConnection
    /* Session offset, so timestamp(6) columns come back as UTC. See
     * shiftTimestampText — createdAt/updatedAt are java.time.Instant and
     * ISO_INSTANT prints UTC, while MySQL renders them in the session zone. */
    private let utcOff: Int64

    public init(conn: MyConnection) {
        this.conn = conn
        this.utcOff = dbUtcOffsetMicros(conn)
    }

    /* -------- knowledge points (the default-score keys) -------- */

    /*
     * codes of knowledge_point where status = 1, ordered sort_order ASC, id ASC.
     * Exactly findAllByStatusOrderBySortOrderAscIdAsc(ENABLED=1).
     */
    public func enabledKnowledgePointCodes(): Array<String> {
        let sql = "SELECT code FROM knowledge_point WHERE status=1" +
            " ORDER BY sort_order ASC, id ASC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<String>(0, repeat: "")
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<String>()
                for (row in rs.rows) {
                    out.add(cellText(row, 0))
                }
                return out.toArray()
        }
    }

    /* -------- learners -------- */

    /* findByUser_IdOrderByCreatedAtAsc */
    public func listByUser(userId: Array<Byte>): Array<RawLearner> {
        let sql = "SELECT " + learnerColumns() +
            " FROM learners WHERE user_id=" + sqlBinary(userId) +
            " ORDER BY created_at ASC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<RawLearner>(0, repeat: RawLearner())
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<RawLearner>()
                for (row in rs.rows) {
                    out.add(parseLearnerRow(row, utcOff))
                }
                return out.toArray()
        }
    }

    /* findByUser_IdOrderByCreatedAtAsc — first row only (for resolveLearner). */
    public func firstLearnerId(userId: Array<Byte>): ?Array<Byte> {
        let sql = "SELECT id FROM learners WHERE user_id=" + sqlBinary(userId) +
            " ORDER BY created_at ASC LIMIT 1"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) { return None }
                return Some(rs.rows[0][0].bytes)
        }
    }

    /* ensureFromProfile seed — INSERT a minimal learner row. */
    public func insertLearnerDefault(learnerId: Array<Byte>, userId: Array<Byte>,
                                      name: String, scoresJson: String): Unit {
        let sql = "INSERT INTO learners (id, user_id, code, name, scores_json, status," +
            " created_at, updated_at) VALUES (" +
            sqlBinary(learnerId) + "," + sqlBinary(userId) + "," +
            sqlQuote("default") + "," + sqlQuote(name) + "," +
            sqlQuote(scoresJson) + ",1,NOW(6),NOW(6))"
        match (conn.query(sql)) {
            case _ => ()
        }
    }

    /* insertLearner — POST /learners create. */
    public func insertLearner(learnerId: Array<Byte>, userId: Array<Byte>,
                               code: String, name: String): Unit {
        let sql = "INSERT INTO learners (id, user_id, code, name, status," +
            " created_at, updated_at) VALUES (" +
            sqlBinary(learnerId) + "," + sqlBinary(userId) + "," +
            sqlQuote(code) + "," + sqlQuote(name) + ",1,NOW(6),NOW(6))"
        match (conn.query(sql)) { case _ => () }
    }

    /* updateLearnerFields — applyRequest: null fields don't overwrite. */
    public func updateLearnerFields(learnerId: Array<Byte>, userId: Array<Byte>,
                                     name: ?String, avatar: ?String, role: ?String,
                                     education: ?String, targetJob: ?String,
                                     weeklyHours: ?Int64, learningStyle: ?String,
                                     scores: ?String, goal: ?String,
                                     blindSpots: ?String, preferredFormat: ?String,
                                     diagnosisSummary: ?String,
                                     confidenceMethod: ?String,
                                     confidenceValue: ?Int64): Unit {
        var sets = ArrayList<String>()
        match (name) {
            case Some(v) => sets.add("name=" + sqlQuote(v))
            case None => ()
        }
        match (avatar) {
            case Some(v) => sets.add("avatar=" + sqlQuote(v))
            case None => ()
        }
        match (role) {
            case Some(v) => sets.add("role=" + sqlQuote(v))
            case None => ()
        }
        match (education) {
            case Some(v) => sets.add("education=" + sqlQuote(v))
            case None => ()
        }
        match (targetJob) {
            case Some(v) => sets.add("target_job=" + sqlQuote(v))
            case None => ()
        }
        match (weeklyHours) {
            case Some(v) => sets.add("weekly_hours=" + v.toString())
            case None => ()
        }
        match (learningStyle) {
            case Some(v) => sets.add("learning_style_json=" + sqlQuote(v))
            case None => ()
        }
        match (scores) {
            case Some(v) => sets.add("scores_json=" + sqlQuote(v))
            case None => ()
        }
        match (goal) {
            case Some(v) => sets.add("goal=" + sqlQuote(v))
            case None => ()
        }
        match (blindSpots) {
            case Some(v) => sets.add("blind_spots_json=" + sqlQuote(v))
            case None => ()
        }
        match (preferredFormat) {
            case Some(v) => sets.add("preferred_format=" + sqlQuote(v))
            case None => ()
        }
        match (diagnosisSummary) {
            case Some(v) => sets.add("diagnosis_summary=" + sqlQuote(v))
            case None => ()
        }
        match (confidenceMethod) {
            case Some(v) => sets.add("confidence_method=" + sqlQuote(v))
            case None => ()
        }
        match (confidenceValue) {
            case Some(v) => sets.add("confidence_value=" + v.toString())
            case None => ()
        }
        if (sets.size > 0) {
            var sql = "UPDATE learners SET "
            var first = true
            for (s in sets) {
                if (!first) { sql = sql + ", " }
                sql = sql + s
                first = false
            }
            sql = sql + ", updated_at=NOW(6) WHERE id=" + sqlBinary(learnerId) +
                " AND user_id=" + sqlBinary(userId)
            match (conn.query(sql)) { case _ => () }
        }
    }

    /* upsertProfile — PUT /profile. */
    public func upsertProfile(userId: Array<Byte>, edu: ?String, major: ?String,
                               tech: ?String, pref: ?String, profileCompleted: Bool,
                               voice: String, speed: String, name: ?String,
                               avatar: ?String, role: ?String, jobTitle: ?String,
                               orgId: ?String, deptId: ?String, weeklyHours: ?Int64,
                               learningStyle: ?String, goal: ?String,
                               preferredFormat: ?String, selfAssessment: ?String,
                               diagnosisSummary: ?String): Unit {
        /* check existing */
        var exists = false
        let sel = "SELECT 1 FROM user_profiles WHERE user_id=" + sqlBinary(userId)
        match (conn.query(sel)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                if (!rs.rows.isEmpty()) { exists = true }
        }
        let prefStr = match (pref) { case Some(p) => sqlQuote(p) case None => "NULL" }
        let orgStr = match (orgId) {
            case Some(o) =>
                match (uuidParse(o)) {
                    case Some(b) => sqlBinary(b)
                    case None => "NULL"
                }
            case None => "NULL"
        }
        let deptStr = match (deptId) {
            case Some(d) =>
                match (uuidParse(d)) {
                    case Some(b) => sqlBinary(b)
                    case None => "NULL"
                }
            case None => "NULL"
        }
        let weeklyStr = match (weeklyHours) { case Some(w) => w.toString() case None => "NULL" }
        let lsStr = match (learningStyle) { case Some(l) => sqlQuote(l) case None => "NULL" }
        let goalStr = match (goal) { case Some(g) => sqlQuote(g) case None => "NULL" }
        let pfStr = match (preferredFormat) { case Some(p) => sqlQuote(p) case None => "NULL" }
        let saStr = match (selfAssessment) { case Some(s) => sqlQuote(s) case None => "NULL" }
        let dsStr = match (diagnosisSummary) { case Some(d) => sqlQuote(d) case None => "NULL" }
        let pcStr = if (profileCompleted) { "1" } else { "0" }

        if (exists) {
            let sql = "UPDATE user_profiles SET education_level=" + optSqlStr(edu) +
                ", major=" + optSqlStr(major) +
                ", technical_foundation=" + optSqlStr(tech) +
                ", learning_preference=" + prefStr +
                ", profile_completed=" + pcStr +
                ", tts_voice=" + sqlQuote(voice) +
                ", tts_speed=" + sqlQuote(speed) +
                ", name=" + optSqlStr(name) +
                ", avatar=" + optSqlStr(avatar) +
                ", role=" + optSqlStr(role) +
                ", job_title=" + optSqlStr(jobTitle) +
                ", organization_id=" + orgStr +
                ", department_id=" + deptStr +
                ", weekly_hours=" + weeklyStr +
                ", learning_style_json=" + lsStr +
                ", goal=" + goalStr +
                ", preferred_format=" + pfStr +
                ", self_assessment_json=" + saStr +
                ", diagnosis_summary_json=" + dsStr +
                ", updated_at=NOW(6) WHERE user_id=" + sqlBinary(userId)
            match (conn.query(sql)) { case _ => () }
        } else {
            let sql = "INSERT INTO user_profiles (user_id, education_level, major," +
                " technical_foundation, learning_preference, profile_completed," +
                " tts_voice, tts_speed, name, avatar, role, job_title," +
                " organization_id, department_id, weekly_hours, learning_style_json," +
                " goal, preferred_format, self_assessment_json, diagnosis_summary_json," +
                " created_at, updated_at) VALUES (" +
                sqlBinary(userId) + "," + optSqlStr(edu) + "," + optSqlStr(major) + "," +
                optSqlStr(tech) + "," + prefStr + "," + pcStr + "," +
                sqlQuote(voice) + "," + sqlQuote(speed) + "," +
                optSqlStr(name) + "," + optSqlStr(avatar) + "," + optSqlStr(role) + "," +
                optSqlStr(jobTitle) + "," + orgStr + "," + deptStr + "," +
                weeklyStr + "," + lsStr + "," + goalStr + "," + pfStr + "," +
                saStr + "," + dsStr + ",NOW(6),NOW(6))"
            match (conn.query(sql)) { case _ => () }
        }
    }

    /* findByIdAndUser_Id */
    public func getByUser(userId: Array<Byte>, learnerId: Array<Byte>): ?RawLearner {
        let sql = "SELECT " + learnerColumns() +
            " FROM learners WHERE id=" + sqlBinary(learnerId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(parseLearnerRow(rs.rows[0], utcOff))
        }
    }

    /* -------- user profile (ProfileService.get) -------- */

    /*
     * profileRepository.findById(user.getId()) — the profile row keyed by the
     * user's own id. None means "no row", which the caller must treat as a
     * synthesised empty profile, NOT as a 404.
     */
    public func getProfileByUser(userId: Array<Byte>): ?RawProfile {
        let sql = "SELECT " + profileColumns() +
            " FROM user_profiles WHERE user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(parseProfileRow(rs.rows[0], utcOff))
        }
    }
}

/* One learner row, field-by-field as the table stores it. */
public struct RawLearner {
    public let id: Array<Byte>
    public let code: ?String
    public let name: String
    public let avatar: ?String
    public let role: ?String
    public let education: ?String
    public let targetJob: ?String
    public let weeklyHours: ?Int64
    public let learningStyleJson: ?String
    public let scoresJson: ?String
    public let goal: ?String
    public let blindSpotsJson: ?String
    public let preferredFormat: ?String
    public let diagnosisSummary: ?String
    public let confidenceMethod: ?String
    public let confidenceValue: ?Int64
    public let createdAt: String
    public let updatedAt: String

    public init() {
        id = Array<Byte>(0, repeat: 0)
        code = None; name = ""; avatar = None; role = None
        education = None; targetJob = None; weeklyHours = None
        learningStyleJson = None; scoresJson = None; goal = None
        blindSpotsJson = None; preferredFormat = None; diagnosisSummary = None
        confidenceMethod = None; confidenceValue = None
        createdAt = ""; updatedAt = ""
    }

    public init(id: Array<Byte>, code: ?String, name: String, avatar: ?String, role: ?String,
                education: ?String, targetJob: ?String, weeklyHours: ?Int64,
                learningStyleJson: ?String, scoresJson: ?String, goal: ?String,
                blindSpotsJson: ?String, preferredFormat: ?String, diagnosisSummary: ?String,
                confidenceMethod: ?String, confidenceValue: ?Int64,
                createdAt: String, updatedAt: String) {
        this.id = id
        this.code = code
        this.name = name
        this.avatar = avatar
        this.role = role
        this.education = education
        this.targetJob = targetJob
        this.weeklyHours = weeklyHours
        this.learningStyleJson = learningStyleJson
        this.scoresJson = scoresJson
        this.goal = goal
        this.blindSpotsJson = blindSpotsJson
        this.preferredFormat = preferredFormat
        this.diagnosisSummary = diagnosisSummary
        this.confidenceMethod = confidenceMethod
        this.confidenceValue = confidenceValue
        this.createdAt = createdAt
        this.updatedAt = updatedAt
    }
}

private func learnerColumns(): String {
    "id, code, name, avatar, role, education, target_job, weekly_hours," +
        " learning_style_json, scores_json, goal, blind_spots_json, preferred_format," +
        " diagnosis_summary, confidence_method, confidence_value, created_at, updated_at"
}

private func parseLearnerRow(row: Array<MyCell>, utcOff: Int64): RawLearner {
    RawLearner(
        row[0].bytes,
        optCellText(row, 1),
        cellText(row, 2),
        optCellText(row, 3),
        optCellText(row, 4),
        optCellText(row, 5),
        optCellText(row, 6),
        optCellInt(row, 7),
        optCellText(row, 8),
        optCellText(row, 9),
        optCellText(row, 10),
        optCellText(row, 11),
        optCellText(row, 12),
        optCellText(row, 13),
        optCellText(row, 14),
        optCellInt(row, 15),
        shiftTimestampText(cellText(row, 16), utcOff),
        shiftTimestampText(cellText(row, 17), utcOff)
    )
}

/* ============ user_profiles (GET /api/v1/profile) ============ */

/*
 * One user_profiles row, exactly as the table stores it. Nullability mirrors
 * the DDL: only profile_completed / tts_voice / tts_speed / created_at /
 * updated_at are NOT NULL, and the row is keyed by user_id (= users.id).
 */
public struct RawProfile {
    public let userId: Array<Byte>
    public let educationLevel: ?String
    public let major: ?String
    public let technicalFoundation: ?String
    public let learningPreference: ?String
    public let currentGoalId: ?Array<Byte>      /* BINARY(16) or absent */
    public let profileCompleted: Bool
    public let ttsVoice: String
    public let ttsSpeed: String
    public let name: ?String
    public let avatar: ?String
    public let role: ?String
    public let jobTitle: ?String
    public let organizationId: ?Array<Byte>
    public let departmentId: ?Array<Byte>
    public let weeklyHours: ?Int64
    public let learningStyleJson: ?String
    public let goal: ?String
    public let preferredFormat: ?String
    public let selfAssessmentJson: ?String
    public let diagnosisSummaryJson: ?String
    public let createdAt: ?String
    public let updatedAt: ?String

    /*
     * The "no row" shape ProfileService.get synthesises via `new
     * UserProfile(user)`: only userId is set, profileCompleted is false, and
     * the two non-null String columns fall back to their field initialisers.
     * createdAt/updatedAt stay null — @PrePersist never runs on a transient.
     */
    public init(synthUserId: Array<Byte>) {
        userId = synthUserId
        educationLevel = None; major = None; technicalFoundation = None
        learningPreference = None; currentGoalId = None
        profileCompleted = false
        ttsVoice = "苏打"; ttsSpeed = "normal"
        name = None; avatar = None; role = None; jobTitle = None
        organizationId = None; departmentId = None; weeklyHours = None
        learningStyleJson = None; goal = None; preferredFormat = None
        selfAssessmentJson = None; diagnosisSummaryJson = None
        createdAt = None; updatedAt = None
    }

    public init(userId: Array<Byte>, educationLevel: ?String, major: ?String,
                technicalFoundation: ?String, learningPreference: ?String,
                currentGoalId: ?Array<Byte>, profileCompleted: Bool,
                ttsVoice: String, ttsSpeed: String, name: ?String, avatar: ?String,
                role: ?String, jobTitle: ?String, organizationId: ?Array<Byte>,
                departmentId: ?Array<Byte>, weeklyHours: ?Int64,
                learningStyleJson: ?String, goal: ?String, preferredFormat: ?String,
                selfAssessmentJson: ?String, diagnosisSummaryJson: ?String,
                createdAt: ?String, updatedAt: ?String) {
        this.userId = userId
        this.educationLevel = educationLevel
        this.major = major
        this.technicalFoundation = technicalFoundation
        this.learningPreference = learningPreference
        this.currentGoalId = currentGoalId
        this.profileCompleted = profileCompleted
        this.ttsVoice = ttsVoice
        this.ttsSpeed = ttsSpeed
        this.name = name
        this.avatar = avatar
        this.role = role
        this.jobTitle = jobTitle
        this.organizationId = organizationId
        this.departmentId = departmentId
        this.weeklyHours = weeklyHours
        this.learningStyleJson = learningStyleJson
        this.goal = goal
        this.preferredFormat = preferredFormat
        this.selfAssessmentJson = selfAssessmentJson
        this.diagnosisSummaryJson = diagnosisSummaryJson
        this.createdAt = createdAt
        this.updatedAt = updatedAt
    }
}

/*
 * Column order is NOT the record order — current_goal_id joins learning_goals
 * and lives next to the FKs. parseProfileRow reads positionally, so any
 * change here must move both.
 */
private func profileColumns(): String {
    "user_id, education_level, major, technical_foundation, learning_preference," +
        " current_goal_id, profile_completed, tts_voice, tts_speed, name, avatar," +
        " role, job_title, organization_id, department_id, weekly_hours," +
        " learning_style_json, goal, preferred_format, self_assessment_json," +
        " diagnosis_summary_json, created_at, updated_at"
}

private func optCellUuid(row: Array<MyCell>, idx: Int64): ?Array<Byte> {
    if (idx >= row.size || row[idx].isNull) {
        return None
    }
    let b = row[idx].bytes
    if (b.size != 16) {
        return None
    }
    return Some(b)
}

private func parseProfileRow(row: Array<MyCell>, utcOff: Int64): RawProfile {
    var completed = false
    match (optCellBool(row, 6)) {
        case Some(b) => completed = b
        case None => completed = false
    }
    var createdAt: ?String = None
    match (optCellText(row, 21)) {
        case Some(t) => createdAt = Some(shiftTimestampText(t, utcOff))
        case None => ()
    }
    var updatedAt: ?String = None
    match (optCellText(row, 22)) {
        case Some(t) => updatedAt = Some(shiftTimestampText(t, utcOff))
        case None => ()
    }
    RawProfile(
        row[0].bytes,
        optCellText(row, 1),
        optCellText(row, 2),
        optCellText(row, 3),
        optCellText(row, 4),
        optCellUuid(row, 5),
        completed,
        cellText(row, 7),
        cellText(row, 8),
        optCellText(row, 9),
        optCellText(row, 10),
        optCellText(row, 11),
        optCellText(row, 12),
        optCellUuid(row, 13),
        optCellUuid(row, 14),
        optCellInt(row, 15),
        optCellText(row, 16),
        optCellText(row, 17),
        optCellText(row, 18),
        optCellText(row, 19),
        optCellText(row, 20),
        createdAt,
        updatedAt
    )
}

/* ============ scores_json ============ */

private func emptyPairs(): Array<(String, Int64)> {
    Array<(String, Int64)>(0, repeat: ("", 0))
}

/*
 * parseScores (LearnForgeSupportService.java:298-302).
 *
 * Returns the pairs in document order. Blank or unparseable input returns an
 * empty list — matching `catch (Exception ignored) { return new LinkedHashMap<>(); }`.
 *
 * Value rules follow Jackson's Map<String, Integer> with ACCEPT_FLOAT_AS_INT
 * (the Spring default): an integer is taken as-is, a float is truncated toward
 * zero, a quoted integer is coerced. Anything else — an array, an object, a
 * boolean, a non-numeric string, trailing garbage — fails the whole parse and
 * yields empty.
 */
public func parseScoresJson(raw: ?String): Array<(String, Int64)> {
    match (raw) {
        case None => return emptyPairs()
        case Some(text) =>
            if (text.trimAscii().size == 0) {
                return emptyPairs()
            }
            return scanScorePairs(text)
    }
}

/* Cursor state for the flat-object scanner. A class so the helpers can advance it. */
private class ScanPos {
    var i: Int64
    public init(start: Int64) {
        i = start
    }
}

private func isWs(b: Byte): Bool {
    let n = Int64(b)
    return n == 32 || n == 9 || n == 10 || n == 13
}

private func isDigit(b: Byte): Bool {
    let n = Int64(b)
    return n >= 48 && n <= 57
}

private func skipWs(bytes: Array<Byte>, pos: ScanPos): Unit {
    while (pos.i < bytes.size && isWs(bytes[pos.i])) {
        pos.i += 1
    }
}

/* Read a JSON string starting at the quote. Returns None on any malformation. */
private func readJsonString(bytes: Array<Byte>, pos: ScanPos): ?String {
    if (pos.i >= bytes.size || Int64(bytes[pos.i]) != 34) {
        return None
    }
    pos.i += 1
    let out = ArrayList<Byte>()
    while (pos.i < bytes.size) {
        let c = bytes[pos.i]
        let ci = Int64(c)
        if (ci == 34) {
            pos.i += 1
            return Some(String.fromUtf8(out.toArray()))
        }
        if (ci == 92) {
            pos.i += 1
            if (pos.i >= bytes.size) {
                return None
            }
            let e = bytes[pos.i]
            let ei = Int64(e)
            if (ei == 34 || ei == 92 || ei == 47) {
                out.add(e)
                pos.i += 1
            } else if (ei == 110) {
                out.add(UInt8(10)); pos.i += 1
            } else if (ei == 116) {
                out.add(UInt8(9)); pos.i += 1
            } else if (ei == 114) {
                out.add(UInt8(13)); pos.i += 1
            } else if (ei == 98) {
                out.add(UInt8(8)); pos.i += 1
            } else if (ei == 102) {
                out.add(UInt8(12)); pos.i += 1
            } else if (ei == 117) {
                if (pos.i + 4 >= bytes.size) {
                    return None
                }
                var code: Int64 = 0
                var k: Int64 = 1
                while (k <= 4) {
                    let hb = bytes[pos.i + k]
                    let hi = Int64(hb)
                    var digit: Int64 = 0
                    if (hi >= 48 && hi <= 57) {
                        digit = hi - 48
                    } else if (hi >= 97 && hi <= 102) {
                        digit = hi - 87
                    } else if (hi >= 65 && hi <= 70) {
                        digit = hi - 55
                    } else {
                        return None
                    }
                    code = code * 16 + digit
                    k += 1
                }
                /* BMP only, emitted as UTF-8; enough for the key sets in play. */
                if (code < 128) {
                    out.add(UInt8(code))
                } else if (code < 2048) {
                    out.add(UInt8(192 + (code >> 6)))
                    out.add(UInt8(128 + (code & 63)))
                } else {
                    out.add(UInt8(224 + (code >> 12)))
                    out.add(UInt8(128 + ((code >> 6) & 63)))
                    out.add(UInt8(128 + (code & 63)))
                }
                pos.i += 5
            } else {
                return None
            }
            continue
        }
        out.add(c)
        pos.i += 1
    }
    return None
}

/*
 * JSON number -> Int64, truncating any fraction toward zero
 * (Jackson ACCEPT_FLOAT_AS_INT). None on anything that is not a number.
 */
private func readJsonInt(bytes: Array<Byte>, pos: ScanPos): ?Int64 {
    let start = pos.i
    var negative = false
    if (pos.i < bytes.size && Int64(bytes[pos.i]) == 45) {
        negative = true
        pos.i += 1
    }
    var value: Int64 = 0
    var digits = 0
    while (pos.i < bytes.size && isDigit(bytes[pos.i])) {
        value = value * 10 + (Int64(bytes[pos.i]) - 48)
        digits += 1
        pos.i += 1
    }
    if (digits == 0) {
        return None
    }
    if (pos.i < bytes.size && Int64(bytes[pos.i]) == 46) {
        pos.i += 1
        var frac = 0
        while (pos.i < bytes.size && isDigit(bytes[pos.i])) {
            frac += 1
            pos.i += 1
        }
        if (frac == 0) {
            return None
        }
    }
    if (pos.i < bytes.size && (Int64(bytes[pos.i]) == 101 || Int64(bytes[pos.i]) == 69)) {
        pos.i += 1
        if (pos.i < bytes.size && (Int64(bytes[pos.i]) == 43 || Int64(bytes[pos.i]) == 45)) {
            pos.i += 1
        }
        var expDigits = 0
        while (pos.i < bytes.size && isDigit(bytes[pos.i])) {
            expDigits += 1
            pos.i += 1
        }
        if (expDigits == 0) {
            return None
        }
    }
    if (pos.i == start) {
        return None
    }
    return Some(if (negative) { 0 - value } else { value })
}

/*
 * Structural scan of a flat JSON object of string -> number.
 * Any deviation from that shape returns empty, so the caller applies the same
 * "empty map" fallback Java does.
 */
private func scanScorePairs(text: String): Array<(String, Int64)> {
    let bytes = text.toArray()
    let pos = ScanPos(0)
    let pairs = ArrayList<(String, Int64)>()

    skipWs(bytes, pos)
    if (pos.i >= bytes.size || Int64(bytes[pos.i]) != 123) {
        return emptyPairs()
    }
    pos.i += 1
    skipWs(bytes, pos)
    if (pos.i < bytes.size && Int64(bytes[pos.i]) == 125) {
        return emptyPairs()
    }
    while (pos.i < bytes.size) {
        skipWs(bytes, pos)
        match (readJsonString(bytes, pos)) {
            case None => return emptyPairs()
            case Some(key) =>
                skipWs(bytes, pos)
                if (pos.i >= bytes.size || Int64(bytes[pos.i]) != 58) {
                    return emptyPairs()
                }
                pos.i += 1
                skipWs(bytes, pos)
                var value: ?Int64 = None
                if (pos.i < bytes.size && Int64(bytes[pos.i]) == 34) {
                    match (readJsonString(bytes, pos)) {
                        case None => return emptyPairs()
                        case Some(s) =>
                            let t = s.trimAscii()
                            if (t.size == 0) {
                                return emptyPairs()
                            }
                            value = Int64.tryParse(t)
                    }
                } else {
                    value = readJsonInt(bytes, pos)
                }
                match (value) {
                    case None => return emptyPairs()
                    case Some(v) => pairs.add((key, v))
                }
                skipWs(bytes, pos)
                if (pos.i >= bytes.size) {
                    return emptyPairs()
                }
                let ch = Int64(bytes[pos.i])
                if (ch == 44) {
                    pos.i += 1
                    continue
                }
                if (ch == 125) {
                    pos.i += 1
                    skipWs(bytes, pos)
                    /* trailing garbage is Jackson's "Extra data" -> whole parse fails */
                    if (pos.i != bytes.size) {
                        return emptyPairs()
                    }
                    return pairs.toArray()
                }
                return emptyPairs()
        }
    }
    return emptyPairs()
}

/*
 * The scores map Java would return: parse scores_json, and when that lands
 * empty, fill each enabled knowledge-point code with 50 (putIfAbsent order =
 * knowledge_point sort_order ASC, id ASC).
 */
public func resolveScores(rawScoresJson: ?String, kpCodes: Array<String>): Array<(String, Int64)> {
    let parsed = parseScoresJson(rawScoresJson)
    if (parsed.size > 0) {
        return parsed
    }
    let out = ArrayList<(String, Int64)>()
    for (code in kpCodes) {
        var seen = false
        for ((k, _) in out) {
            if (k == code) {
                seen = true
                break
            }
        }
        if (!seen) {
            out.add((code, 50))
        }
    }
    return out.toArray()
}

/*
 * overallMastery: mean of the score values, HALF_UP to one decimal, or 0 when
 * there are none (LearnForgeSupportService.java:265-267).
 */
public func overallMastery(scores: Array<(String, Int64)>): Float64 {
    if (scores.size == 0) {
        return 0.0
    }
    var sum: Int64 = 0
    for ((_, v) in scores) {
        sum += v
    }
    return roundHalfUp1(floatFromInt(sum) / floatFromInt(scores.size))
}

/*
 * HALF_UP at one decimal place — BigDecimal.setScale(1, RoundingMode.HALF_UP).
 * Implemented on the scaled integer so 2.25 -> 2.3 rather than the binary
 * double's 2.2.
 */
func roundHalfUp1(x: Float64): Float64 {
    let scaled = x * 10.0
    var n: Int64 = 0
    if (scaled >= 0.0) {
        n = truncateFloat(scaled + 0.5)
    } else {
        n = truncateFloat(scaled - 0.5)
    }
    return floatFromInt(n) / 10.0
}

/* ?String → SQL literal (quoted or NULL) */
func optSqlStr(v: ?String): String {
    match (v) {
        case Some(s) => return sqlQuote(s)
        case None => return "NULL"
    }
}
