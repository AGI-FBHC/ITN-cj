package itn_spire

import std.core.*
import std.convert.*
import stdx.encoding.json.*

/*
 * Persistence for tutoring_sessions.
 * Ported from src/agents/app/services/tutoring.py:TutoringStore
 *   ensure_schema / create / get / save
 *
 * Column order matches the Python DDL so SELECT *-style indexing stays
 * obvious: 0 id, 1 user_id, 2 learner_code, 3 kp_id, 4 script_title,
 * 5 status, 6 current_node_id, 7 level, 8 messages_json, 9 answers_json,
 * 10 decisions_json, 11 score_before, 12 score_after, 13 created_at,
 * 14 updated_at.
 *
 * messages_json / answers_json / decisions_json are stored as JSON text and
 * passed through on read (parseJsonArrayText), never re-encoded via
 * JsonValue.toJsonString().
 */

private func tutoringColumns(): String {
    "id,user_id,learner_code,kp_id,script_title,status,current_node_id," +
    "level,messages_json,answers_json,decisions_json,score_before,score_after," +
    "created_at,updated_at"
}

public class TutoringStore {
    private let conn: MyConnection
    private var schemaReady: Bool

    public init(conn: MyConnection) {
        this.conn = conn
        this.schemaReady = false
    }

    public func ensureSchema(): Unit {
        if (schemaReady) {
            return
        }
        let sql = "CREATE TABLE IF NOT EXISTS tutoring_sessions (" +
            "id BINARY(16) PRIMARY KEY," +
            "user_id BINARY(16) NOT NULL," +
            "learner_code VARCHAR(64) NOT NULL," +
            "kp_id VARCHAR(64) NULL," +
            "script_title VARCHAR(255) NULL," +
            "status VARCHAR(32) NOT NULL DEFAULT 'running'," +
            "current_node_id VARCHAR(64) NULL," +
            "level INT NOT NULL DEFAULT 2," +
            "messages_json TEXT NULL," +
            "answers_json TEXT NULL," +
            "decisions_json TEXT NULL," +
            "score_before INT NOT NULL DEFAULT 50," +
            "score_after INT NULL," +
            "created_at TIMESTAMP(6) NOT NULL," +
            "updated_at TIMESTAMP(6) NOT NULL," +
            "INDEX idx_tutoring_session_user (user_id, updated_at)" +
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        schemaReady = true
    }

    /*
     * Python create(): INSERT with status='running', level=2,
     * answers_json='[]', decisions_json='[]'. kp_id / script_title are the
     * caller's `or ""` values (empty string, not NULL).
     */
    public func create(userId: Array<Byte>, learnerCode: String, kpId: String,
                       title: String, currentNodeId: ?String, messagesJson: String,
                       scoreBefore: Int64): ?String {
        ensureSchema()
        let sid = uuidV4()
        let now = sqlNowLiteral()
        let sql = "INSERT INTO tutoring_sessions(" + tutoringColumns() + ") VALUES(" +
            sqlBinary(sid) + "," +
            sqlBinary(userId) + "," +
            sqlQuote(learnerCode) + "," +
            sqlQuote(kpId) + "," +
            sqlQuote(title) + "," +
            "'running'," +
            sqlOptString(currentNodeId) + "," +
            "2," +
            sqlQuote(messagesJson) + "," +
            "'[]'," +
            "'[]'," +
            sqlInt(scoreBefore) + "," +
            sqlNull() + "," +
            now + "," + now + ")"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        return get(userId, sid)
    }

    public func get(userId: Array<Byte>, sessionId: Array<Byte>): ?String {
        ensureSchema()
        let sql = "SELECT " + tutoringColumns() +
            " FROM tutoring_sessions WHERE id=" + sqlBinary(sessionId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(serializeTutoringSession(rs.rows[0]))
        }
    }

    public func save(userId: Array<Byte>, sessionId: Array<Byte>,
                     currentNodeId: ?String, status: String, level: Int64,
                     messagesJson: String, answersJson: String,
                     decisionsJson: String, scoreAfter: ?Int64): ?String {
        ensureSchema()
        let sql = "UPDATE tutoring_sessions SET current_node_id=" + sqlOptString(currentNodeId) +
            ",status=" + sqlQuote(status) +
            ",level=" + sqlInt(level) +
            ",messages_json=" + sqlQuote(messagesJson) +
            ",answers_json=" + sqlQuote(answersJson) +
            ",decisions_json=" + sqlQuote(decisionsJson) +
            ",score_after=" + sqlOptInt(scoreAfter) +
            ",updated_at=" + sqlNowLiteral() +
            " WHERE id=" + sqlBinary(sessionId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        return get(userId, sessionId)
    }
}

/*
 * Python store.get() dict shape. currentNode / topics / resourceId are added
 * later by TutoringService._enrichSession.
 */
private func serializeTutoringSession(row: Array<MyCell>): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putStr("learnerCode", cellText(row, 2))
    w.putOptStr("kpId", optCellText(row, 3))
    w.putOptStr("scriptTitle", optCellText(row, 4))
    w.putStr("status", cellText(row, 5))
    w.putOptStr("currentNodeId", optCellText(row, 6))
    w.putInt("level", optCellInt(row, 7) ?? 2)
    w.putRaw("messages", parseJsonArrayText(cellText(row, 8)))
    w.putRaw("answers", parseJsonArrayText(cellText(row, 9)))
    w.putRaw("decisions", parseJsonArrayText(cellText(row, 10)))
    w.putInt("scoreBefore", optCellInt(row, 11) ?? 50)
    w.putOptInt("scoreAfter", optCellInt(row, 12))
    w.putStr("createdAt", isoNaiveFromDb(cellText(row, 13)))
    w.putStr("updatedAt", isoNaiveFromDb(cellText(row, 14)))
    return w.toJson()
}
