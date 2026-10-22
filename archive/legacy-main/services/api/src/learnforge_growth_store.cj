package itn_spire

import std.core.*
import std.collection.*
import std.convert.*

/*
 * P2 batch 3: growth state + events behind
 *   GET /api/v1/learner-profile/growth
 *   GET /api/v1/learner-profile/report
 *
 * Mirrors LearnForgeSupportService.growth/report + GrowthState/GrowthEvent
 * entities. growth() auto-creates a GrowthState row when absent (and may
 * auto-create a learner via ensureFromProfile — see resolveLearner).
 */
public class LearnForgeGrowthStore {
    private let conn: MyConnection
    private let utcOff: Int64

    public init(conn: MyConnection) {
        this.conn = conn
        this.utcOff = dbUtcOffsetMicros(conn)
    }

    /* -------- growth_states -------- */

    public func getGrowthState(userId: Array<Byte>, learnerId: Array<Byte>): ?RawGrowthState {
        let sql = "SELECT id, orb, watered, stage, updated_at FROM growth_states" +
            " WHERE user_id=" + sqlBinary(userId) +
            " AND learner_id=" + sqlBinary(learnerId) + " LIMIT 1"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) { return None }
                let row = rs.rows[0]
                return Some(RawGrowthState(
                    row[0].bytes,
                    optCellInt(row, 1) ?? 0,
                    optCellInt(row, 2) ?? 0,
                    optCellText(row, 3),
                    shiftTimestampText(cellText(row, 4), utcOff)))
        }
    }

    public func insertGrowthState(userId: Array<Byte>, learnerId: Array<Byte>): Array<Byte> {
        let id = uuidV4()
        let sql = "INSERT INTO growth_states (id, user_id, learner_id, orb, watered, stage, updated_at)" +
            " VALUES (" + sqlBinary(id) + "," + sqlBinary(userId) + "," + sqlBinary(learnerId) +
            ",0,0,'seed',NOW(6))"
        match (conn.query(sql)) {
            case _ => return id
        }
    }

    /* -------- growth_events -------- */

    public func listGrowthEvents(userId: Array<Byte>, learnerId: Array<Byte>,
                                  limit: Int64): Array<RawGrowthEvent> {
        let sql = "SELECT event_type, title, amount, created_at FROM growth_events" +
            " WHERE user_id=" + sqlBinary(userId) +
            " AND learner_id=" + sqlBinary(learnerId) +
            " ORDER BY created_at DESC LIMIT " + limit.toString()
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<RawGrowthEvent>(0, repeat: RawGrowthEvent())
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<RawGrowthEvent>()
                for (row in rs.rows) {
                    out.add(RawGrowthEvent(
                        cellText(row, 0),
                        cellText(row, 1),
                        optCellInt(row, 2) ?? 0,
                        shiftTimestampText(cellText(row, 3), utcOff)))
                }
                return out.toArray()
        }
    }

    /* -------- growth writes -------- */

    public func updateGrowthOrb(userId: Array<Byte>, learnerId: Array<Byte>,
                                 newOrb: Int64): Unit {
        let sql = "UPDATE growth_states SET orb=" + newOrb.toString() +
            ", updated_at=NOW(6) WHERE user_id=" + sqlBinary(userId) +
            " AND learner_id=" + sqlBinary(learnerId)
        match (conn.query(sql)) { case _ => () }
    }

    public func updateGrowthWater(userId: Array<Byte>, learnerId: Array<Byte>,
                                   spent: Int64, newWatered: Int64, newStage: String): Unit {
        let sql = "UPDATE growth_states SET orb=0, watered=" + newWatered.toString() +
            ", stage=" + sqlQuote(newStage) +
            ", updated_at=NOW(6) WHERE user_id=" + sqlBinary(userId) +
            " AND learner_id=" + sqlBinary(learnerId)
        match (conn.query(sql)) { case _ => () }
    }

    public func insertGrowthEvent(userId: Array<Byte>, learnerId: Array<Byte>,
                                   eventType: String, title: String, amount: Int64,
                                   metadata: ?String): Unit {
        var meta = "NULL"
        match (metadata) {
            case Some(m) => meta = sqlQuote(m)
            case None => ()
        }
        let sql = "INSERT INTO growth_events (id, user_id, learner_id," +
            " event_type, title, amount, metadata_json, created_at) VALUES (" +
            sqlBinary(uuidV4()) + "," + sqlBinary(userId) + "," + sqlBinary(learnerId) + "," +
            sqlQuote(eventType) + "," + sqlQuote(title) + "," + amount.toString() + "," +
            meta + ",NOW(6))"
        match (conn.query(sql)) { case _ => () }
    }

    /* -------- knowledge_point (for knowledgeGraph) -------- */

    public func listKnowledgePoints(): Array<RawKnowledgePoint> {
        let sql = "SELECT code, name, en_name, target_level, coverage, weight, prerequisites_json" +
            " FROM knowledge_point WHERE status=1 ORDER BY sort_order ASC, id ASC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<RawKnowledgePoint>(0, repeat: RawKnowledgePoint())
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<RawKnowledgePoint>()
                for (row in rs.rows) {
                    out.add(RawKnowledgePoint(
                        cellText(row, 0),
                        cellText(row, 1),
                        optCellText(row, 2),
                        optCellInt(row, 3) ?? 0,
                        optCellInt(row, 4) ?? 0,
                        optCellText(row, 5),
                        optCellText(row, 6)))
                }
                return out.toArray()
        }
    }
}

/* ============ row shapes ============ */

public struct RawGrowthState {
    public let id: Array<Byte>
    public let orb: Int64
    public let watered: Int64
    public let stage: ?String
    public let updatedAtUtc: String

    public init() {
        id = Array<Byte>(0, repeat: 0); orb = 0; watered = 0
        stage = None; updatedAtUtc = ""
    }

    public init(id: Array<Byte>, orb: Int64, watered: Int64,
                stage: ?String, updatedAtUtc: String) {
        this.id = id; this.orb = orb; this.watered = watered
        this.stage = stage; this.updatedAtUtc = updatedAtUtc
    }
}

public struct RawGrowthEvent {
    public let eventType: String
    public let title: String
    public let amount: Int64
    public let createdAtUtc: String

    public init() {
        eventType = ""; title = ""; amount = 0; createdAtUtc = ""
    }

    public init(eventType: String, title: String, amount: Int64, createdAtUtc: String) {
        this.eventType = eventType; this.title = title
        this.amount = amount; this.createdAtUtc = createdAtUtc
    }
}

public struct RawKnowledgePoint {
    public let code: String
    public let name: String
    public let enName: ?String
    public let targetLevel: Int64
    public let coverage: Int64
    public let weight: ?String
    public let prerequisitesJson: ?String

    public init() {
        code = ""; name = ""; enName = None; targetLevel = 0
        coverage = 0; weight = None; prerequisitesJson = None
    }

    public init(code: String, name: String, enName: ?String, targetLevel: Int64,
                coverage: Int64, weight: ?String, prerequisitesJson: ?String) {
        this.code = code; this.name = name; this.enName = enName
        this.targetLevel = targetLevel; this.coverage = coverage
        this.weight = weight; this.prerequisitesJson = prerequisitesJson
    }
}
