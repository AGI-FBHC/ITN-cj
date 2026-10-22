package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*

/*
 * Persistence for presentation_chat_sessions / presentation_chat_messages.
 * Ported from src/agents/app/storage/presentation_chat_store.py
 * PresentationChatStore: create / list / owned / messages / delete.
 *
 * ensure_schema is idempotent DDL and is NOT ported — Spire only reads and
 * writes. delete is a hard delete: it re-checks owned() first, then removes
 * the messages, then the session row.
 */

/*
 * presentation_chat_sessions columns in presentationChatSessionColumns():
 *   0 id, 1 presentation_task_id, 2 title, 3 model_provider, 4 created_at,
 *   5 updated_at — model_provider was added AFTER title by an ALTER.
 * Python uses SELECT * and reads by dict key, so the explicit order only
 * fixes positions.
 */
private func presentationChatSessionColumns(): String {
    "id,presentation_task_id,title,model_provider,created_at,updated_at"
}

/* DEFAULT_SESSION_TITLE (presentation_chat_store.py:28). */
private func presentationChatDefaultTitle(): String {
    "新演示对话"
}

/* DEFAULT_MODEL_PROVIDER fallback used by _session (presentation_chat_store.py:73). */
private func presentationChatDefaultProvider(): String {
    "mimo"
}

public class PresentationChatStore {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    /* create: INSERT then hand back the in-memory row, like Python. */
    public func create(userId: Array<Byte>, taskId: Array<Byte>,
                       modelProvider: String): String {
        let sid = uuidV4()
        let now = nowUtcParts()
        let nowLiteral = sqlQuote(mysqlDatetime(now))
        let sql = "INSERT INTO presentation_chat_sessions" +
            "(id,user_id,presentation_task_id,title,model_provider,created_at,updated_at) VALUES(" +
            sqlBinary(sid) + "," + sqlBinary(userId) + "," + sqlBinary(taskId) + "," +
            sqlQuote(presentationChatDefaultTitle()) + "," + sqlQuote(modelProvider) + "," +
            nowLiteral + "," + nowLiteral + ")"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        let w = JsonWriter()
        w.putStr("id", uuidFormat(sid))
        w.putStr("taskId", uuidFormat(taskId))
        w.putStr("title", presentationChatDefaultTitle())
        w.putStr("modelProvider", modelProvider)
        w.putStr("createdAt", isoNaiveFromDb(mysqlDatetime(now)))
        w.putStr("updatedAt", isoNaiveFromDb(mysqlDatetime(now)))
        return w.toJson()
    }

    /* list: WHERE presentation_task_id AND user_id, ORDER BY updated_at DESC. */
    public func list(userId: Array<Byte>, taskId: Array<Byte>): Array<String> {
        let sql = "SELECT " + presentationChatSessionColumns() +
            " FROM presentation_chat_sessions WHERE presentation_task_id=" + sqlBinary(taskId) +
            " AND user_id=" + sqlBinary(userId) + " ORDER BY updated_at DESC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<String>(0, repeat: "")
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<String>()
                for (row in rs.rows) {
                    out.add(serializePresentationChatSession(row))
                }
                return out.toArray()
        }
    }

    /*
     * owned: SELECT 1 ... — the routes call it with the three ids only, so the
     * optional model_provider filter of the Python helper is not carried over.
     */
    public func owned(userId: Array<Byte>, taskId: Array<Byte>, sessionId: Array<Byte>): Bool {
        let sql = "SELECT 1 FROM presentation_chat_sessions WHERE id=" + sqlBinary(sessionId) +
            " AND presentation_task_id=" + sqlBinary(taskId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return false
            case QueryOutcome.ResultSet(rs) => return !rs.rows.isEmpty()
        }
    }

    /* messages: ordered by seq. */
    public func messages(sessionId: Array<Byte>): String {
        let sql = "SELECT id,seq,role,content,input_type,attachment_id,created_at" +
            " FROM presentation_chat_messages WHERE session_id=" + sqlBinary(sessionId) +
            " ORDER BY seq"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return "[]"
            case QueryOutcome.ResultSet(rs) =>
                let arr = JsonArrWriter()
                for (row in rs.rows) {
                    arr.addRaw(serializePresentationChatMessage(row))
                }
                return arr.toJson()
        }
    }

    /* delete: owned -> messages -> session row; affectedRows == 0 -> false. */
    public func delete(userId: Array<Byte>, taskId: Array<Byte>, sessionId: Array<Byte>): Bool {
        if (!owned(userId, taskId, sessionId)) {
            return false
        }
        match (conn.query("DELETE FROM presentation_chat_messages WHERE session_id=" +
                          sqlBinary(sessionId))) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        match (conn.query("DELETE FROM presentation_chat_sessions WHERE id=" +
                          sqlBinary(sessionId))) {
            case QueryOutcome.Ok(ok) => return ok.affectedRows > 0
            case QueryOutcome.ResultSet(_) => return false
        }
    }
}

/* -------- serialisation -------- */

/* _session (presentation_chat_store.py:67-76). */
private func serializePresentationChatSession(row: Array<MyCell>): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putStr("taskId", uuidText(row, 1) ?? "")
    w.putStr("title", cellText(row, 2))
    /* Python row.get("model_provider") or "mimo" — NULL and "" both fall back. */
    match (optCellText(row, 3)) {
        case Some(p) =>
            if (p.isEmpty()) {
                w.putStr("modelProvider", presentationChatDefaultProvider())
            } else {
                w.putStr("modelProvider", p)
            }
        case None => w.putStr("modelProvider", presentationChatDefaultProvider())
    }
    w.putStr("createdAt", isoNaiveFromDb(cellText(row, 4)))
    w.putStr("updatedAt", isoNaiveFromDb(cellText(row, 5)))
    return w.toJson()
}

/*
 * messages row: id, seq, role, content, inputType, attachmentId, createdAt.
 * attachment_id is nullable, so uuidText keeps a NULL as JSON null.
 */
private func serializePresentationChatMessage(row: Array<MyCell>): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putInt("seq", optCellInt(row, 1) ?? 0)
    w.putStr("role", cellText(row, 2))
    w.putStr("content", cellText(row, 3))
    w.putStr("inputType", cellText(row, 4))
    w.putOptStr("attachmentId", uuidText(row, 5))
    w.putStr("createdAt", isoNaiveFromDb(cellText(row, 6)))
    return w.toJson()
}
