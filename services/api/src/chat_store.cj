package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*

/*
 * Persistence for chat_sessions / chat_messages / chat_attachments.
 * Ported from src/agents/app/storage/chat_store.py ChatSessionStore:
 *   create_session / list_sessions / get_session / set_archived /
 *   delete_session / list_messages / rename_session
 *
 * Spire never runs the Python runtime migrations (_ensure_archive_column /
 * _ensure_tools_column); it only reads and writes the columns those create.
 *
 * delete_session is a HARD delete of the session row alone — unlike the agent
 * session store it does NOT cascade to chat_messages.
 */

/*
 * chat_sessions columns selected by chatSessionColumns():
 *   0 id, 1 title, 2 archived, 3 created_at, 4 updated_at
 * Python reads them by dict key, so the explicit order only fixes positions.
 */
private func chatSessionColumns(): String {
    "id,title,archived,created_at,updated_at"
}

/* DEFAULT_SESSION_TITLE / SESSION_TITLE_MAX_LENGTH (chat_store.py:9-10). */
private func chatDefaultTitle(): String {
    "新对话"
}

private func chatTitleMaxLength(): Int64 {
    64
}

public class ChatSessionsStore {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    /*
     * create_session: INSERT then return the in-memory row — Python never
     * re-reads, and archived takes the column default FALSE.
     */
    public func createSession(userId: Array<Byte>): String {
        let sid = uuidV4()
        let now = nowUtcParts()
        let nowLiteral = sqlQuote(mysqlDatetime(now))
        let sql = "INSERT INTO chat_sessions(id,user_id,title,created_at,updated_at) VALUES(" +
            sqlBinary(sid) + "," + sqlBinary(userId) + "," +
            sqlQuote(chatDefaultTitle()) + "," + nowLiteral + "," + nowLiteral + ")"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        let w = JsonWriter()
        w.putStr("id", uuidFormat(sid))
        w.putStr("title", chatDefaultTitle())
        w.putBool("archived", false)
        w.putStr("created_at", isoNaiveFromDb(mysqlDatetime(now)))
        w.putStr("updated_at", isoNaiveFromDb(mysqlDatetime(now)))
        return w.toJson()
    }

    /* list_sessions: archived is a Python bool, so pymysql binds 0/1. */
    public func listSessions(userId: Array<Byte>, archived: Bool): Array<String> {
        let flag = if (archived) { "1" } else { "0" }
        let sql = "SELECT " + chatSessionColumns() + " FROM chat_sessions WHERE user_id=" +
            sqlBinary(userId) + " AND archived=" + flag + " ORDER BY updated_at DESC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<String>(0, repeat: "")
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<String>()
                for (row in rs.rows) {
                    out.add(serializeChatSession(row))
                }
                return out.toArray()
        }
    }

    public func getSession(userId: Array<Byte>, sessionId: Array<Byte>): ?String {
        let sql = "SELECT " + chatSessionColumns() + " FROM chat_sessions WHERE id=" +
            sqlBinary(sessionId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(serializeChatSession(rs.rows[0]))
        }
    }

    /* set_archived: affectedRows == 0 -> None (route answers 404). */
    public func setArchived(userId: Array<Byte>, sessionId: Array<Byte>,
                            archived: Bool): ?String {
        let flag = if (archived) { "1" } else { "0" }
        let sql = "UPDATE chat_sessions SET archived=" + flag +
            ",updated_at=" + sqlNowLiteral() +
            " WHERE id=" + sqlBinary(sessionId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(ok) =>
                if (ok.affectedRows <= 0) {
                    return None
                }
            case QueryOutcome.ResultSet(_) => return None
        }
        return getSession(userId, sessionId)
    }

    /* delete_session: session row only, no message cascade. */
    public func deleteSession(userId: Array<Byte>, sessionId: Array<Byte>): Bool {
        let sql = "DELETE FROM chat_sessions WHERE id=" + sqlBinary(sessionId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(ok) => return ok.affectedRows > 0
            case QueryOutcome.ResultSet(_) => return false
        }
    }

    /* rename_session: affectedRows == 0 -> None (route answers 404). */
    public func renameSession(userId: Array<Byte>, sessionId: Array<Byte>,
                              title: String): ?String {
        let sql = "UPDATE chat_sessions SET title=" + sqlQuote(chatCleanTitle(title)) +
            ",updated_at=" + sqlNowLiteral() +
            " WHERE id=" + sqlBinary(sessionId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(ok) =>
                if (ok.affectedRows <= 0) {
                    return None
                }
            case QueryOutcome.ResultSet(_) => return None
        }
        return getSession(userId, sessionId)
    }

    /* -------- messages -------- */

    /*
     * list_messages: messages ordered by seq, then the attachments of those
     * messages ordered by created_at, keyed by message id. Python attaches the
     * key only when the group is non-empty (`if items`).
     */
    public func listMessages(sessionId: Array<Byte>): String {
        let sql = "SELECT id,seq,role,content,reasoning,tools_json,created_at" +
            " FROM chat_messages WHERE session_id=" + sqlBinary(sessionId) + " ORDER BY seq"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return "[]"
            case QueryOutcome.ResultSet(rs) =>
                let ids = ArrayList<Array<Byte>>()
                for (row in rs.rows) {
                    if (row[0].isBinary16()) {
                        ids.add(row[0].bytes)
                    }
                }
                let grouped = loadAttachments(ids.toArray())
                let arr = JsonArrWriter()
                for (row in rs.rows) {
                    let key = uuidText(row, 0) ?? ""
                    var items: ?ArrayList<String> = None
                    match (grouped.get(key)) {
                        case Some(list) => items = Some(list)
                        case None => ()
                    }
                    arr.addRaw(serializeChatMessage(row, items))
                }
                return arr.toJson()
        }
    }

    /*
     * _attachments_for_messages (chat_store.py:157-179): an empty id list
     * short-circuits to {} before any query runs.
     */
    private func loadAttachments(messageIds: Array<Array<Byte>>): HashMap<String, ArrayList<String>> {
        let grouped = HashMap<String, ArrayList<String>>()
        if (!messageIds.isEmpty()) {
            let parts = ArrayList<String>()
            for (mid in messageIds) {
                parts.add(sqlBinary(mid))
            }
            let sql = "SELECT id,message_id,filename,mime_type,size_bytes" +
                " FROM chat_attachments WHERE message_id IN (" + joinComma(parts.toArray()) +
                ") ORDER BY created_at"
            match (conn.query(sql)) {
                case QueryOutcome.Ok(_) => ()
                case QueryOutcome.ResultSet(rs) =>
                    for (row in rs.rows) {
                        let key = uuidText(row, 1) ?? ""
                        let item = JsonWriter()
                        item.putStr("id", uuidText(row, 0) ?? "")
                        item.putStr("name", cellText(row, 2))
                        item.putStr("mimeType", cellText(row, 3))
                        item.putOptInt("size", optCellInt(row, 4))
                        match (grouped.get(key)) {
                            case Some(list) => list.add(item.toJson())
                            case None =>
                                let list = ArrayList<String>()
                                list.add(item.toJson())
                                grouped.add(key, list)
                        }
                    }
            }
        }
        return grouped
    }
}

/* -------- serialisation -------- */

/* _session_row (chat_store.py:60-68). */
private func serializeChatSession(row: Array<MyCell>): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putStr("title", cellText(row, 1))
    w.putBool("archived", (optCellInt(row, 2) ?? 0) != 0)
    w.putStr("created_at", isoNaiveFromDb(cellText(row, 3)))
    w.putStr("updated_at", isoNaiveFromDb(cellText(row, 4)))
    return w.toJson()
}

private func serializeChatMessage(row: Array<MyCell>, items: ?ArrayList<String>): String {
    let w = JsonWriter()
    w.putStr("id", uuidText(row, 0) ?? "")
    w.putInt("seq", optCellInt(row, 1) ?? 0)
    w.putStr("role", cellText(row, 2))
    w.putStr("content", cellText(row, 3))
    w.putRaw("reasoning", chatReasoningRaw(row, 4))
    w.putRaw("tools", chatToolsRaw(optCellText(row, 5)))
    w.putStr("created_at", isoNaiveFromDb(cellText(row, 6)))
    match (items) {
        case Some(list) =>
            let arr = JsonArrWriter()
            for (raw in list) {
                arr.addRaw(raw)
            }
            w.putRaw("attachments", arr.toJson())
        case None => ()
    }
    return w.toJson()
}

/* Python reasoning is `str | None`, so a SQL NULL stays JSON null. */
private func chatReasoningRaw(row: Array<MyCell>, idx: Int64): String {
    match (optCellText(row, idx)) {
        case Some(t) => return jsonQuote(t)
        case None => return "null"
    }
}

/*
 * _decode_tools (chat_store.py:181-190): falsy -> None; str/bytes ->
 * json.loads; an unparseable value -> None. The decoded value is re-emitted
 * in place, so it stays a raw JSON literal.
 */
private func chatToolsRaw(text: ?String): String {
    match (text) {
        case None => return "null"
        case Some(t) =>
            if (t.isEmpty()) {
                return "null"
            }
            match (jsonParse(t)) {
                case None => return "null"
                case Some(v) => return valueToRaw(v)
            }
    }
}

/*
 * Python rename_session: title.strip().replace("\n", " ")[:64] or
 * DEFAULT_SESSION_TITLE. Cangjie String.replace is replace-first only, so it
 * is applied until the string stops changing to emulate Python's replace-all.
 */
private func chatCleanTitle(title: String): String {
    var replaced = pyStrip(title)
    while (true) {
        let next = replaced.replace("\n", " ")
        if (next == replaced) {
            break
        }
        replaced = next
    }
    let sliced = runeSlice(replaced, chatTitleMaxLength())
    if (sliced.isEmpty()) {
        return chatDefaultTitle()
    }
    return sliced
}
