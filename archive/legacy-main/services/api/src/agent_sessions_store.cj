package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*

/*
 * Persistence for agent_sessions / agent_messages / agent_decisions.
 * Ported from src/agents/app/storage/agent_activity.py
 *   create_session / get_session / list_sessions
 *   append_message / append_decision / delete / complete_session / update_title
 *
 * Deliberate divergence: Python INSERTs the message/decision row even when the
 * session is missing or owned by another user, then get_session() returns None
 * (HTTP 404) and leaves an orphan row behind. Spire checks ownership first and
 * answers 404 without writing.
 */

/*
 * agent_sessions columns (INSERT order from ensure_schema):
 *  0 id, 1 user_id, 2 learner_id, 3 session_type, 4 title,
 *  5 status, 6 created_at, 7 updated_at
 */
private func agentSessionColumns(): String {
    "id,user_id,learner_id,session_type,title,status,created_at,updated_at"
}

public class AgentSessionsStore {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    /* -------- sessions -------- */

    public func create(userId: Array<Byte>, learnerId: ?Array<Byte>,
                       sessionType: String, title: ?String): ?String {
        let sid = uuidV4()
        let now = sqlNowLiteral()
        let sql = "INSERT INTO agent_sessions(id,user_id,learner_id,session_type,title," +
            "status,created_at,updated_at) VALUES(" + sqlBinary(sid) + "," +
            sqlBinary(userId) + "," + sqlOptBinary(learnerId) + "," +
            sqlQuote(sessionType) + "," + sqlOptString(title) +
            ",'running'," + now + "," + now + ")"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        return get(userId, sid)
    }

    public func get(userId: Array<Byte>, sessionId: Array<Byte>): ?String {
        let sql = "SELECT " + agentSessionColumns() +
            " FROM agent_sessions WHERE id=" + sqlBinary(sessionId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                let row = rs.rows[0]
                return Some(serializeSession(row, loadMessages(sessionId), loadDecisions(sessionId)))
        }
    }

    /* Python list_sessions: SELECT id ... LIMIT 100 then get_session per row. */
    public func list(userId: Array<Byte>): Array<String> {
        let sql = "SELECT id FROM agent_sessions WHERE user_id=" + sqlBinary(userId) +
            " ORDER BY updated_at DESC LIMIT 100"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<String>(0, repeat: "")
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<String>()
                for (row in rs.rows) {
                    match (uuidText(row, 0)) {
                        case None => ()
                        case Some(idText) =>
                            match (uuidParse(idText)) {
                                case None => ()
                                case Some(sid) =>
                                    match (get(userId, sid)) {
                                        case None => ()
                                        case Some(raw) => out.add(raw)
                                    }
                            }
                    }
                }
                return out.toArray()
        }
    }

    public func complete(userId: Array<Byte>, sessionId: Array<Byte>): ?String {
        let sql = "UPDATE agent_sessions SET status='completed',updated_at=" + sqlNowLiteral() +
            " WHERE id=" + sqlBinary(sessionId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        return get(userId, sessionId)
    }

    /*
     * Python update_title:
     *   clean = " ".join(str(title or "").split()).strip()[:255]
     *   if not clean: return get_session(...)   # no write, 200 if owned
     *   UPDATE ... ; return get_session(...) if affected else None
     */
    public func updateTitle(userId: Array<Byte>, sessionId: Array<Byte>,
                            title: String): ?String {
        let clean = collapseWs(title)
        if (clean.size == 0) {
            return get(userId, sessionId)
        }
        let sql = "UPDATE agent_sessions SET title=" + sqlQuote(clean) +
            ",updated_at=" + sqlNowLiteral() +
            " WHERE id=" + sqlBinary(sessionId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(ok) =>
                if (ok.affectedRows <= 0) {
                    return None
                }
            case QueryOutcome.ResultSet(_) => return None
        }
        return get(userId, sessionId)
    }

    /* DELETE decisions + messages (by session+user) then the session; true if the session row went away. */
    public func delete(userId: Array<Byte>, sessionId: Array<Byte>): Bool {
        match (conn.query("DELETE FROM agent_decisions WHERE session_id=" + sqlBinary(sessionId) +
            " AND user_id=" + sqlBinary(userId))) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        match (conn.query("DELETE FROM agent_messages WHERE session_id=" + sqlBinary(sessionId) +
            " AND user_id=" + sqlBinary(userId))) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        match (conn.query("DELETE FROM agent_sessions WHERE id=" + sqlBinary(sessionId) +
            " AND user_id=" + sqlBinary(userId))) {
            case QueryOutcome.Ok(ok) => return ok.affectedRows > 0
            case QueryOutcome.ResultSet(_) => return false
        }
    }

    /* -------- messages / decisions -------- */

    /* Fail closed: refuse to write when the session is missing or foreign-owned. */
    public func appendMessage(userId: Array<Byte>, sessionId: Array<Byte>,
                              agentId: ?String, kind: String, content: String): ?String {
        match (get(userId, sessionId)) {
            case None => return None
            case Some(_) => ()
        }
        let mid = uuidV4()
        let now = sqlNowLiteral()
        let insert = "INSERT INTO agent_messages(id,session_id,user_id,agent_id,kind,content,created_at) VALUES(" +
            sqlBinary(mid) + "," + sqlBinary(sessionId) + "," + sqlBinary(userId) + "," +
            sqlOptString(agentId) + "," + sqlQuote(kind) + "," + sqlQuote(content) + "," + now + ")"
        match (conn.query(insert)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        match (conn.query("UPDATE agent_sessions SET updated_at=" + now +
            " WHERE id=" + sqlBinary(sessionId) + " AND user_id=" + sqlBinary(userId))) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        return get(userId, sessionId)
    }

    /* Router always passes learnerId = None (public.py append_agent_decision). */
    public func appendDecision(userId: Array<Byte>, sessionId: Array<Byte>,
                               learnerId: ?Array<Byte>, stage: String, text: String): ?String {
        match (get(userId, sessionId)) {
            case None => return None
            case Some(_) => ()
        }
        let did = uuidV4()
        let now = sqlNowLiteral()
        let insert = "INSERT INTO agent_decisions(id,session_id,user_id,learner_id,stage,text,created_at) VALUES(" +
            sqlBinary(did) + "," + sqlBinary(sessionId) + "," + sqlBinary(userId) + "," +
            sqlOptBinary(learnerId) + "," + sqlQuote(stage) + "," + sqlQuote(text) + "," + now + ")"
        match (conn.query(insert)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        match (conn.query("UPDATE agent_sessions SET updated_at=" + now +
            " WHERE id=" + sqlBinary(sessionId) + " AND user_id=" + sqlBinary(userId))) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        return get(userId, sessionId)
    }

    private func loadMessages(sessionId: Array<Byte>): String {
        let sql = "SELECT id,agent_id,kind,content,created_at FROM agent_messages WHERE session_id=" +
            sqlBinary(sessionId) + " ORDER BY created_at"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return "[]"
            case QueryOutcome.ResultSet(rs) =>
                let arr = JsonArrWriter()
                for (row in rs.rows) {
                    arr.addRaw(serializeMessage(row))
                }
                return arr.toJson()
        }
    }

    private func loadDecisions(sessionId: Array<Byte>): String {
        let sql = "SELECT id,stage,text,created_at FROM agent_decisions WHERE session_id=" +
            sqlBinary(sessionId) + " ORDER BY created_at"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return "[]"
            case QueryOutcome.ResultSet(rs) =>
                let arr = JsonArrWriter()
                for (row in rs.rows) {
                    arr.addRaw(serializeDecision(row))
                }
                return arr.toJson()
        }
    }
}

/* -------- serialisation -------- */

private func serializeSession(row: Array<MyCell>, messagesJson: String, decisionsJson: String): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putOptStr("learnerId", uuidText(row, 2))
    w.putStr("sessionType", cellText(row, 3))
    w.putOptStr("title", optCellText(row, 4))
    w.putStr("status", cellText(row, 5))
    w.putRaw("messages", messagesJson)
    w.putRaw("decisions", decisionsJson)
    w.putStr("createdAt", isoNaiveFromDb(cellText(row, 6)))
    w.putStr("updatedAt", isoNaiveFromDb(cellText(row, 7)))
    return w.toJson()
}

private func serializeMessage(row: Array<MyCell>): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putOptStr("agentId", optCellText(row, 1))
    w.putStr("kind", cellText(row, 2))
    w.putStr("content", cellText(row, 3))
    w.putStr("createdAt", isoNaiveFromDb(cellText(row, 4)))
    return w.toJson()
}

private func serializeDecision(row: Array<MyCell>): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putStr("stage", cellText(row, 1))
    w.putStr("text", cellText(row, 2))
    w.putStr("createdAt", isoNaiveFromDb(cellText(row, 3)))
    return w.toJson()
}

/*
 * Python " ".join(str(title or "").split()).strip()[:255].
 * Cangjie String.split() is literal-separator only, so walk runes and treat
 * Python str.isspace() characters (ASCII whitespace + NBSP + ideographic space)
 * as separators. Already-joined output has no leading/trailing space, so the
 * trailing Python .strip() is a no-op except on all-whitespace input.
 */
func collapseWs(title: String): String {
    let parts = ArrayList<String>()
    var current = ""
    var has = false
    for (ch in title.runes()) {
        if (isWsRune(ch)) {
            if (has) {
                parts.add(current)
                current = ""
                has = false
            }
        } else {
            current = current + ch.toString()
            has = true
        }
    }
    if (has) {
        parts.add(current)
    }
    var out = ""
    var first = true
    for (p in parts) {
        if (!first) {
            out = out + " "
        }
        first = false
        out = out + p
    }
    return runeSlice(out, 255)
}

private func isWsRune(ch: Rune): Bool {
    let s = ch.toString()
    if (s.trimAscii().size == 0) {
        return true
    }
    /* Python str.isspace() also covers NBSP and the ideographic space. */
    return s == "\u{00A0}" || s == "\u{3000}"
}
