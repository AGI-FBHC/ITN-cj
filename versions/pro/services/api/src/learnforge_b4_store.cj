package itn_spire

import std.core.*
import std.collection.*
import std.convert.*

/*
 * P2 batch 4 store: knowledge_points, review_schedule, learning_goals,
 * knowledge_domain, job_targets.
 *
 * Mirrors LearnForgeService + LearningGoalService + JobTargetService queries.
 */
public class LearnForgeB4Store {
    private let conn: MyConnection
    private let utcOff: Int64

    public init(conn: MyConnection) {
        this.conn = conn
        this.utcOff = dbUtcOffsetMicros(conn)
    }

    /* -------- knowledge_point (list / get by code) -------- */

    public func listKnowledgePointsFull(): Array<RawKpFull> {
        let sql = "SELECT kp.id, kp.code, kp.name, kp.en_name, kp.weight," +
            " kp.target_level, kp.coverage, kp.description," +
            " kp.core_topics_json, kp.prerequisites_json," +
            " d.code, d.name" +
            " FROM knowledge_point kp" +
            " LEFT JOIN knowledge_domain d ON d.id = kp.domain_id" +
            " WHERE kp.status=1 ORDER BY kp.sort_order ASC, kp.id ASC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<RawKpFull>(0, repeat: RawKpFull())
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<RawKpFull>()
                for (row in rs.rows) {
                    out.add(RawKpFull(
                        cellText(row, 0), cellText(row, 1), cellText(row, 2),
                        optCellText(row, 3), optCellText(row, 4),
                        optCellInt(row, 5) ?? 0, optCellInt(row, 6) ?? 0,
                        optCellText(row, 7), optCellText(row, 8), optCellText(row, 9),
                        optCellText(row, 10), optCellText(row, 11)))
                }
                return out.toArray()
        }
    }

    public func getKnowledgePointByCode(code: String): ?RawKpFull {
        let sql = "SELECT kp.id, kp.code, kp.name, kp.en_name, kp.weight," +
            " kp.target_level, kp.coverage, kp.description," +
            " kp.core_topics_json, kp.prerequisites_json," +
            " d.code, d.name" +
            " FROM knowledge_point kp" +
            " LEFT JOIN knowledge_domain d ON d.id = kp.domain_id" +
            " WHERE kp.code=" + sqlQuote(code) + " AND kp.status=1 LIMIT 1"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) { return None }
                let row = rs.rows[0]
                return Some(RawKpFull(
                    cellText(row, 0), cellText(row, 1), cellText(row, 2),
                    optCellText(row, 3), optCellText(row, 4),
                    optCellInt(row, 5) ?? 0, optCellInt(row, 6) ?? 0,
                    optCellText(row, 7), optCellText(row, 8), optCellText(row, 9),
                    optCellText(row, 10), optCellText(row, 11)))
        }
    }

    /* -------- review_schedules (table name is plural) -------- */

    public func listReviewSchedules(userId: Array<Byte>): Array<RawReviewSchedule> {
        let sql = "SELECT kp.code, rs.last_at, rs.reps, rs.mastery, rs.due_at" +
            " FROM review_schedules rs" +
            " JOIN knowledge_point kp ON kp.id = rs.knowledge_point_id" +
            " WHERE rs.user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<RawReviewSchedule>(0, repeat: RawReviewSchedule())
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<RawReviewSchedule>()
                for (row in rs.rows) {
                    var lastAt: ?String = None
                    match (optCellText(row, 1)) {
                        case Some(t) => lastAt = Some(shiftTimestampText(t, utcOff))
                        case None => ()
                    }
                    out.add(RawReviewSchedule(
                        cellText(row, 0),
                        lastAt,
                        optCellInt(row, 2) ?? 0,
                        cellText(row, 3),
                        shiftTimestampText(cellText(row, 4), utcOff)))
                }
                return out.toArray()
        }
    }

    /* -------- learning_goals -------- */

    public func listGoals(userId: Array<Byte>): Array<RawGoalB4> {
        let sql = "SELECT g.id, g.knowledge_domain_id, d.code, d.name," +
            " g.goal_type, g.title, g.description, g.expected_level," +
            " g.initial_level, g.assessment_method, g.status, g.target_date," +
            " g.created_at, g.updated_at" +
            " FROM learning_goals g" +
            " LEFT JOIN knowledge_domain d ON d.id = g.knowledge_domain_id" +
            " WHERE g.user_id=" + sqlBinary(userId) +
            " ORDER BY g.updated_at DESC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<RawGoalB4>(0, repeat: RawGoalB4())
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<RawGoalB4>()
                for (row in rs.rows) {
                    out.add(parseGoalB4Row(row, utcOff))
                }
                return out.toArray()
        }
    }

    public func getGoal(userId: Array<Byte>, goalId: Array<Byte>): ?RawGoalB4 {
        let sql = "SELECT g.id, g.knowledge_domain_id, d.code, d.name," +
            " g.goal_type, g.title, g.description, g.expected_level," +
            " g.initial_level, g.assessment_method, g.status, g.target_date," +
            " g.created_at, g.updated_at" +
            " FROM learning_goals g" +
            " LEFT JOIN knowledge_domain d ON d.id = g.knowledge_domain_id" +
            " WHERE g.id=" + sqlBinary(goalId) +
            " AND g.user_id=" + sqlBinary(userId) + " LIMIT 1"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) { return None }
                return Some(parseGoalB4Row(rs.rows[0], utcOff))
        }
    }

    /* currentGoalId from user_profiles */
    public func currentGoalId(userId: Array<Byte>): ?Array<Byte> {
        let sql = "SELECT current_goal_id FROM user_profiles WHERE user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) { return None }
                let cell = rs.rows[0][0]
                if (cell.isNull) { return None }
                let b = cell.bytes
                if (b.size == 16) { return Some(b) }
                return None
        }
    }

    /* -------- job_targets -------- */

    public func listJobTargets(jobCode: ?String): Array<RawJobTarget> {
        /* JobTargetLevel entity columns — Jackson serialises the entity in
         * field order: id, jobCode, nodeCode, nodeName, targetMastery,
         * priority, sortOrder, createdAt, updatedAt. */
        var sql = "SELECT id, job_code, node_code, node_name, target_mastery," +
            " priority, sort_order, created_at, updated_at FROM job_target_levels"
        match (jobCode) {
            case Some(code) =>
                sql = sql + " WHERE job_code=" + sqlQuote(code.trimAscii()) +
                    " ORDER BY sort_order ASC, id ASC"
            case None =>
                sql = sql + " ORDER BY id ASC"
        }
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<RawJobTarget>(0, repeat: RawJobTarget())
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<RawJobTarget>()
                for (row in rs.rows) {
                    out.add(RawJobTarget(
                        cellText(row, 0), cellText(row, 1), cellText(row, 2),
                        optCellText(row, 3), optCellInt(row, 4) ?? 0,
                        optCellInt(row, 5) ?? 1, optCellInt(row, 6) ?? 0,
                        shiftTimestampText(cellText(row, 7), utcOff),
                        shiftTimestampText(cellText(row, 8), utcOff)))
                }
                return out.toArray()
        }
    }

    /* -------- knowledge_domain (requireActiveDomain) -------- */

    public func getGoalById(domainId: Int64): ?String {
        let sql = "SELECT name FROM knowledge_domain WHERE id=" + domainId.toString() +
            " AND status=1 LIMIT 1"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) { return None }
                return Some(cellText(rs.rows[0], 0))
        }
    }

    /* Returns domain name + description for ensureForDomain's default goal. */
    public func getDomainById(domainId: Int64): ?(String, ?String) {
        let sql = "SELECT name, description FROM knowledge_domain WHERE id=" + domainId.toString() +
            " AND status=1 LIMIT 1"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) { return None }
                return Some((cellText(rs.rows[0], 0), optCellText(rs.rows[0], 1)))
        }
    }

    /* -------- learning_goals writes -------- */

    public func insertGoal(userId: Array<Byte>, goalId: Array<Byte>, domainId: Int64,
                            goalType: String, title: String, description: ?String,
                            expectedLevel: String, initialLevel: ?String,
                            assessmentMethod: ?String, status: String,
                            targetDate: ?String): Unit {
        var desc = "NULL"
        match (description) {
            case Some(d) => desc = sqlQuote(d)
            case None => ()
        }
        var il = "NULL"
        match (initialLevel) {
            case Some(v) => il = sqlQuote(v)
            case None => ()
        }
        var am = "NULL"
        match (assessmentMethod) {
            case Some(v) => am = sqlQuote(v)
            case None => ()
        }
        var td = "NULL"
        match (targetDate) {
            case Some(v) => td = sqlQuote(v)
            case None => ()
        }
        let sql = "INSERT INTO learning_goals (id, user_id, knowledge_domain_id," +
            " goal_type, title, description, expected_level, initial_level," +
            " assessment_method, status, target_date, created_at, updated_at) VALUES (" +
            sqlBinary(goalId) + "," + sqlBinary(userId) + "," + domainId.toString() + "," +
            sqlQuote(goalType) + "," + sqlQuote(title) + "," + desc + "," +
            sqlQuote(expectedLevel) + "," + il + "," + am + "," +
            sqlQuote(status) + "," + td + ",NOW(6),NOW(6))"
        match (conn.query(sql)) { case _ => () }
    }

    public func findGoalByDomain(userId: Array<Byte>, domainId: Int64): ?RawGoalB4 {
        let sql = "SELECT g.id, g.knowledge_domain_id, d.code, d.name," +
            " g.goal_type, g.title, g.description, g.expected_level," +
            " g.initial_level, g.assessment_method, g.status, g.target_date," +
            " g.created_at, g.updated_at" +
            " FROM learning_goals g" +
            " LEFT JOIN knowledge_domain d ON d.id = g.knowledge_domain_id" +
            " WHERE g.user_id=" + sqlBinary(userId) +
            " AND g.knowledge_domain_id=" + domainId.toString() +
            " ORDER BY g.updated_at DESC LIMIT 1"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) { return None }
                return Some(parseGoalB4Row(rs.rows[0], utcOff))
        }
    }

    public func updateGoal(goalId: Array<Byte>, userId: Array<Byte>, domainId: Int64,
                            goalType: String, title: String, description: ?String,
                            expectedLevel: String, initialLevel: ?String,
                            assessmentMethod: ?String, status: String,
                            targetDate: ?String): Unit {
        var desc = "NULL"
        match (description) {
            case Some(d) => desc = sqlQuote(d)
            case None => ()
        }
        var il = "NULL"
        match (initialLevel) {
            case Some(v) => il = sqlQuote(v)
            case None => ()
        }
        var am = "NULL"
        match (assessmentMethod) {
            case Some(v) => am = sqlQuote(v)
            case None => ()
        }
        var td = "NULL"
        match (targetDate) {
            case Some(v) => td = sqlQuote(v)
            case None => ()
        }
        let sql = "UPDATE learning_goals SET knowledge_domain_id=" + domainId.toString() +
            ", goal_type=" + sqlQuote(goalType) +
            ", title=" + sqlQuote(title) +
            ", description=" + desc +
            ", expected_level=" + sqlQuote(expectedLevel) +
            ", initial_level=" + il +
            ", assessment_method=" + am +
            ", status=" + sqlQuote(status) +
            ", target_date=" + td +
            ", updated_at=NOW(6) WHERE id=" + sqlBinary(goalId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) { case _ => () }
    }

    public func deleteGoal(goalId: Array<Byte>, userId: Array<Byte>): Unit {
        let sql = "DELETE FROM learning_goals WHERE id=" + sqlBinary(goalId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) { case _ => () }
    }

    public func clearCurrentIfMatches(userId: Array<Byte>, goalId: Array<Byte>): Unit {
        let sql = "UPDATE user_profiles SET current_goal_id=NULL" +
            " WHERE user_id=" + sqlBinary(userId) +
            " AND current_goal_id=" + sqlBinary(goalId)
        match (conn.query(sql)) { case _ => () }
    }

    public func setCurrentGoal(userId: Array<Byte>, goalId: Array<Byte>): Unit {
        /* upsert: update if row exists, insert if not */
        var exists = false
        let sel = "SELECT 1 FROM user_profiles WHERE user_id=" + sqlBinary(userId)
        match (conn.query(sel)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                if (!rs.rows.isEmpty()) { exists = true }
        }
        if (exists) {
            let upd = "UPDATE user_profiles SET current_goal_id=" + sqlBinary(goalId) +
                ", updated_at=NOW(6) WHERE user_id=" + sqlBinary(userId)
            match (conn.query(upd)) { case _ => () }
        } else {
            let ins = "INSERT INTO user_profiles (user_id, current_goal_id," +
                " profile_completed, tts_voice, tts_speed, created_at, updated_at)" +
                " VALUES (" + sqlBinary(userId) + "," + sqlBinary(goalId) +
                ",0,'苏打','normal',NOW(6),NOW(6))"
            match (conn.query(ins)) { case _ => () }
        }
    }

    public func clearCurrentGoal(userId: Array<Byte>): Unit {
        let sql = "UPDATE user_profiles SET current_goal_id=NULL" +
            " WHERE user_id=" + sqlBinary(userId)
        match (conn.query(sql)) { case _ => () }
    }

    /* -------- review_schedules -------- */

    public func getReviewSchedule(userId: Array<Byte>, kpCode: String): ?RawReviewSchedule {
        let sql = "SELECT kp.code, rs.last_at, rs.reps, rs.mastery, rs.due_at" +
            " FROM review_schedules rs" +
            " JOIN knowledge_point kp ON kp.id = rs.knowledge_point_id" +
            " WHERE rs.user_id=" + sqlBinary(userId) +
            " AND kp.code=" + sqlQuote(kpCode) + " LIMIT 1"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) { return None }
                let row = rs.rows[0]
                var lastAt: ?String = None
                match (optCellText(row, 1)) {
                    case Some(t) => lastAt = Some(shiftTimestampText(t, utcOff))
                    case None => ()
                }
                return Some(RawReviewSchedule(
                    cellText(row, 0), lastAt,
                    optCellInt(row, 2) ?? 0,
                    cellText(row, 3),
                    shiftTimestampText(cellText(row, 4), utcOff)))
        }
    }

    public func insertReviewSchedule(userId: Array<Byte>, kpCode: String, score: Int64): Unit {
        /* get knowledge_point id */
        var kpId: Int64 = 0
        let sel = "SELECT id FROM knowledge_point WHERE code=" + sqlQuote(kpCode) + " LIMIT 1"
        match (conn.query(sel)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(rs) =>
                if (!rs.rows.isEmpty()) { kpId = optCellInt(rs.rows[0], 0) ?? 0 }
        }
        /* mastery = clamp(score/100.0, 0.05, 0.96).setScale(4, HALF_UP) */
        var m = Float64(score) / 100.0
        if (m < 0.05) { m = 0.05 }
        if (m > 0.96) { m = 0.96 }
        let mStr = formatScale4(m)
        /* dueAt = now + 1*86400 (reps==0 → intervalDays=1) */
        let sql = "INSERT INTO review_schedules (user_id, knowledge_point_id," +
            " last_at, reps, mastery, due_at, created_at, updated_at) VALUES (" +
            sqlBinary(userId) + "," + kpId.toString() + ",NOW(6),1," + mStr +
            ", DATE_ADD(NOW(6), INTERVAL 86400 SECOND),NOW(6),NOW(6))"
        match (conn.query(sql)) { case _ => () }
    }

    public func completeReview(userId: Array<Byte>, kpCode: String, score: Int64,
                                intervalDays: Int64): Unit {
        var m = Float64(score) / 100.0
        if (m < 0.05) { m = 0.05 }
        if (m > 0.96) { m = 0.96 }
        let mStr = formatScale4(m)
        let sql = "UPDATE review_schedules rs" +
            " JOIN knowledge_point kp ON kp.id = rs.knowledge_point_id" +
            " SET rs.last_at=NOW(6), rs.reps=rs.reps+1, rs.mastery=" + mStr +
            ", rs.due_at=DATE_ADD(NOW(6), INTERVAL " + (intervalDays * 86400).toString() + " SECOND)" +
            ", rs.updated_at=NOW(6)" +
            " WHERE rs.user_id=" + sqlBinary(userId) +
            " AND kp.code=" + sqlQuote(kpCode)
        match (conn.query(sql)) { case _ => () }
    }
}

/* ============ row shapes ============ */

public struct RawKpFull {
    public let id: String; public let code: String; public let name: String
    public let enName: ?String; public let weight: ?String
    public let targetLevel: Int64; public let coverage: Int64
    public let description: ?String; public let coreTopicsJson: ?String
    public let prerequisitesJson: ?String; public let domainCode: ?String
    public let domainName: ?String

    public init() {
        id = ""; code = ""; name = ""; enName = None; weight = None
        targetLevel = 0; coverage = 0; description = None
        coreTopicsJson = None; prerequisitesJson = None
        domainCode = None; domainName = None
    }

    public init(id: String, code: String, name: String, enName: ?String,
                weight: ?String, targetLevel: Int64, coverage: Int64,
                description: ?String, coreTopicsJson: ?String,
                prerequisitesJson: ?String, domainCode: ?String, domainName: ?String) {
        this.id = id; this.code = code; this.name = name; this.enName = enName
        this.weight = weight; this.targetLevel = targetLevel; this.coverage = coverage
        this.description = description; this.coreTopicsJson = coreTopicsJson
        this.prerequisitesJson = prerequisitesJson
        this.domainCode = domainCode; this.domainName = domainName
    }
}

public struct RawReviewSchedule {
    public let kpCode: String; public let lastAtUtc: ?String
    public let reps: Int64; public let mastery: String; public let dueAtUtc: String

    public init() {
        kpCode = ""; lastAtUtc = None; reps = 0; mastery = "0"; dueAtUtc = ""
    }

    public init(kpCode: String, lastAtUtc: ?String, reps: Int64,
                mastery: String, dueAtUtc: String) {
        this.kpCode = kpCode; this.lastAtUtc = lastAtUtc
        this.reps = reps; this.mastery = mastery; this.dueAtUtc = dueAtUtc
    }
}

public struct RawGoalB4 {
    public let id: Array<Byte>; public let domainId: ?Int64
    public let domainCode: ?String; public let domainName: ?String
    public let goalType: String; public let title: String
    public let description: ?String; public let expectedLevel: String
    public let initialLevel: ?String; public let assessmentMethod: ?String
    public let status: String; public let targetDate: ?String
    public let createdAtUtc: String; public let updatedAtUtc: String

    public init() {
        id = Array<Byte>(0, repeat: 0); domainId = None; domainCode = None
        domainName = None; goalType = ""; title = ""; description = None
        expectedLevel = ""; initialLevel = None; assessmentMethod = None
        status = ""; targetDate = None; createdAtUtc = ""; updatedAtUtc = ""
    }

    public init(id: Array<Byte>, domainId: ?Int64, domainCode: ?String,
                domainName: ?String, goalType: String, title: String,
                description: ?String, expectedLevel: String, initialLevel: ?String,
                assessmentMethod: ?String, status: String, targetDate: ?String,
                createdAtUtc: String, updatedAtUtc: String) {
        this.id = id; this.domainId = domainId; this.domainCode = domainCode
        this.domainName = domainName; this.goalType = goalType; this.title = title
        this.description = description; this.expectedLevel = expectedLevel
        this.initialLevel = initialLevel; this.assessmentMethod = assessmentMethod
        this.status = status; this.targetDate = targetDate
        this.createdAtUtc = createdAtUtc; this.updatedAtUtc = updatedAtUtc
    }
}

/* JobTargetLevel entity — Jackson field order: id, jobCode, nodeCode,
 * nodeName, targetMastery, priority, sortOrder, createdAt, updatedAt. */
public struct RawJobTarget {
    public let id: String; public let jobCode: String; public let nodeCode: String
    public let nodeName: ?String; public let targetMastery: Int64
    public let priority: Int64; public let sortOrder: Int64
    public let createdAtUtc: String; public let updatedAtUtc: String

    public init() {
        id = ""; jobCode = ""; nodeCode = ""; nodeName = None
        targetMastery = 0; priority = 1; sortOrder = 0
        createdAtUtc = ""; updatedAtUtc = ""
    }

    public init(id: String, jobCode: String, nodeCode: String, nodeName: ?String,
                targetMastery: Int64, priority: Int64, sortOrder: Int64,
                createdAtUtc: String, updatedAtUtc: String) {
        this.id = id; this.jobCode = jobCode; this.nodeCode = nodeCode
        this.nodeName = nodeName; this.targetMastery = targetMastery
        this.priority = priority; this.sortOrder = sortOrder
        this.createdAtUtc = createdAtUtc; this.updatedAtUtc = updatedAtUtc
    }
}

func parseGoalB4Row(row: Array<MyCell>, utcOff: Int64): RawGoalB4 {
    RawGoalB4(
        row[0].bytes,
        optCellInt(row, 1),
        optCellText(row, 2),
        optCellText(row, 3),
        cellText(row, 4),
        cellText(row, 5),
        optCellText(row, 6),
        cellText(row, 7),
        optCellText(row, 8),
        optCellText(row, 9),
        cellText(row, 10),
        optCellText(row, 11),
        shiftTimestampText(cellText(row, 12), utcOff),
        shiftTimestampText(cellText(row, 13), utcOff))
}
