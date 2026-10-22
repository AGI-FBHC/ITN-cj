package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*

/*
 * Notes + note-category persistence for learning_notes /
 * learning_note_categories. Ported from
 * src/agents/app/storage/notes.py NoteStore, including ownership checks
 * (every statement filters on user_id) and category-delete unlinking.
 */
public class NotesStore {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    /* -------- notes -------- */

    public func listNotes(userId: Array<Byte>): Array<String> {
        let sql = "SELECT id,title,content,status,source_type,source_ref,source_context," +
            "learner_id,kp_id,source_kind,kb_refs_json,category_id," +
            "knowledge_category_id,knowledge_category_name,knowledge_match_confidence," +
            "knowledge_match_locked,created_at,updated_at " +
            "FROM learning_notes WHERE user_id=" + sqlBinary(userId) +
            " ORDER BY updated_at DESC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<String>(0, repeat: "")
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<String>()
                for (row in rs.rows) {
                    out.add(serializeNote(row))
                }
                return out.toArray()
        }
    }

    public func getNote(userId: Array<Byte>, noteId: Array<Byte>): ?String {
        let sql = "SELECT id,title,content,status,source_type,source_ref,source_context," +
            "learner_id,kp_id,source_kind,kb_refs_json,category_id," +
            "knowledge_category_id,knowledge_category_name,knowledge_match_confidence," +
            "knowledge_match_locked,created_at,updated_at " +
            "FROM learning_notes WHERE id=" + sqlBinary(noteId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(serializeNote(rs.rows[0]))
        }
    }

    /*
     * create mirrors NoteStore.create: when knowledge_category_id is omitted
     * the deterministic matcher fills knowledge fields; an explicit
     * knowledgeCategoryId locks the match.
     */
    public func createNote(userId: Array<Byte>, req: NoteCreate): ?String {
        let noteId = uuidV4()
        let now = nowUtcParts()
        var autoMatch: ?KnowledgeMatch = None
        if (!req.hasKnowledgeId) {
            /* Knowledge match is enrichment: never fail the note insert over it. */
            try {
                let matcher = KnowledgeMatcher(conn)
                let text = req.title + " " + req.content + " " + (req.sourceContext ?? "")
                autoMatch = matcher.findMatch(text)
            } catch (_: Exception) {
                autoMatch = None
            }
        }
        var knowledgeId: ?Int64 = None
        var knowledgeName: ?String = None
        var confidence: ?Float64 = None
        if (req.hasKnowledgeId) {
            knowledgeId = req.knowledgeCategoryId
            knowledgeName = req.knowledgeCategoryName
            confidence = None
        } else {
            match (autoMatch) {
                case Some(m) =>
                    knowledgeId = Some(m.id)
                    knowledgeName = Some(m.name)
                    confidence = Some(m.confidence)
                case None => ()
            }
        }
        let locked = if (req.hasKnowledgeId) { 1 } else { 0 }
        let sql = "INSERT INTO learning_notes " +
            "(id,user_id,learner_id,kp_id,category_id,knowledge_category_id," +
            "knowledge_category_name,knowledge_match_confidence,knowledge_match_locked," +
            "title,content,status,source_type,source_kind,source_ref,source_context," +
            "kb_refs_json,created_at,updated_at) VALUES (" +
            sqlBinary(noteId) + "," +
            sqlBinary(userId) + "," +
            sqlOptBinary(req.learnerId) + "," +
            sqlOptString(req.kpId) + "," +
            sqlOptBinary(req.categoryId) + "," +
            sqlOptInt(knowledgeId) + "," +
            sqlOptString(knowledgeName) + "," +
            matchFloat(confidence) + "," +
            locked.toString() + "," +
            sqlQuote(req.title) + "," +
            sqlQuote(req.content) + "," +
            sqlQuote(req.status) + "," +
            sqlQuote(req.sourceType) + "," +
            sqlOptString(req.sourceKind) + "," +
            sqlOptString(req.sourceRef) + "," +
            sqlOptString(req.sourceContext) + "," +
            sqlQuote(jsonStringArray(req.kbRefs)) + "," +
            sqlQuote(mysqlDatetime(now)) + "," +
            sqlQuote(mysqlDatetime(now)) + ")"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return getNote(userId, noteId)
            case QueryOutcome.ResultSet(_) => return getNote(userId, noteId)
        }
    }

    public func updateNote(userId: Array<Byte>, noteId: Array<Byte>, req: NoteUpdate): ?String {
        /* Ownership: only rows matching both ids are visible. */
        var currentText = ""
        match (getNote(userId, noteId)) {
            case Some(n) => currentText = n
            case None => return None
        }
        var current: JsonObject = jobj()
        match (jsonParse(currentText)) {
            case Some(v) =>
                match (v.kind()) {
                    case JsonKind.JsObject => current = v.asObject()
                    case _ => ()
                }
            case None => ()
        }
        var sets = ArrayList<String>()
        if (req.hasTitle) {
            sets.add("title=" + sqlQuote(req.title ?? ""))
        }
        if (req.hasContent) {
            sets.add("content=" + sqlQuote(req.content ?? ""))
        }
        if (req.hasStatus) {
            sets.add("status=" + sqlQuote(req.status ?? "approved"))
        }
        if (req.hasCategoryId) {
            sets.add("category_id=" + sqlOptBinary(req.categoryId))
        }
        if (req.hasLearnerId) {
            sets.add("learner_id=" + sqlOptBinary(req.learnerId))
        }
        if (req.hasKpId) {
            sets.add("kp_id=" + sqlOptString(req.kpId))
        }
        if (req.hasSourceKind) {
            sets.add("source_kind=" + sqlOptString(req.sourceKind))
        }
        if (req.hasKbRefs) {
            sets.add("kb_refs_json=" + sqlQuote(jsonStringArray(req.kbRefs)))
        }
        if (req.hasKnowledgeId) {
            sets.add("knowledge_category_id=" + sqlOptInt(req.knowledgeCategoryId))
            sets.add("knowledge_category_name=" + sqlOptString(req.knowledgeCategoryName))
            sets.add("knowledge_match_confidence=NULL")
            sets.add("knowledge_match_locked=1")
        } else if (req.hasTitle || req.hasContent) {
            let locked = jsonOptInt(current, "knowledgeMatchLocked") ?? 0
            if (locked == 0) {
                let title = req.title ?? (jsonGetString(current, "title") ?? "")
                let content = req.content ?? (jsonGetString(current, "content") ?? "")
                var m: ?KnowledgeMatch = None
                try {
                    m = KnowledgeMatcher(conn).findMatch(title + " " + content)
                } catch (_: Exception) {
                    m = None
                }
                match (m) {
                    case Some(k) =>
                        sets.add("knowledge_category_id=" + sqlInt(k.id))
                        sets.add("knowledge_category_name=" + sqlQuote(k.name))
                        sets.add("knowledge_match_confidence=" + k.confidence.toString())
                    case None =>
                        sets.add("knowledge_category_id=NULL")
                        sets.add("knowledge_category_name=NULL")
                        sets.add("knowledge_match_confidence=NULL")
                }
            }
        }
        if (sets.isEmpty()) {
            return getNote(userId, noteId)
        }
        sets.add("updated_at=" + sqlQuote(mysqlDatetime(nowUtcParts())))
        var sql = "UPDATE learning_notes SET "
        var first = true
        for (s in sets.toArray()) {
            if (!first) {
                sql = sql + ", "
            }
            first = false
            sql = sql + s
        }
        sql = sql + " WHERE id=" + sqlBinary(noteId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(ok) =>
                if (ok.affectedRows <= 0) {
                    /* still return the record when nothing changed */
                    return getNote(userId, noteId)
                }
                return getNote(userId, noteId)
            case QueryOutcome.ResultSet(_) => return getNote(userId, noteId)
        }
    }

    public func deleteNote(userId: Array<Byte>, noteId: Array<Byte>): Bool {
        let sql = "DELETE FROM learning_notes WHERE id=" + sqlBinary(noteId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(ok) => return ok.affectedRows > 0
            case QueryOutcome.ResultSet(_) => return false
        }
    }

    /* -------- categories -------- */

    public func listCategories(userId: Array<Byte>): Array<String> {
        let sql = "SELECT id,name,color,created_at,updated_at FROM learning_note_categories " +
            "WHERE user_id=" + sqlBinary(userId) + " ORDER BY name"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<String>(0, repeat: "")
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<String>()
                for (row in rs.rows) {
                    out.add(serializeCategory(row))
                }
                return out.toArray()
        }
    }

    public func getCategory(userId: Array<Byte>, categoryId: Array<Byte>): ?String {
        let sql = "SELECT id,name,color,created_at,updated_at FROM learning_note_categories " +
            "WHERE id=" + sqlBinary(categoryId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(serializeCategory(rs.rows[0]))
        }
    }

    public func createCategory(userId: Array<Byte>, name: String, color: String): CreateCategoryResult {
        let categoryId = uuidV4()
        let now = nowUtcParts()
        let sql = "INSERT INTO learning_note_categories(id,user_id,name,color,created_at,updated_at) " +
            "VALUES(" + sqlBinary(categoryId) + "," + sqlBinary(userId) + "," +
            sqlQuote(name) + "," + sqlQuote(color) + "," +
            sqlQuote(mysqlDatetime(now)) + "," + sqlQuote(mysqlDatetime(now)) + ")"
        try {
            match (conn.query(sql)) {
                case QueryOutcome.Ok(_) =>
                    return CreateCategoryResult.created(getCategory(userId, categoryId))
                case QueryOutcome.ResultSet(_) =>
                    return CreateCategoryResult.created(getCategory(userId, categoryId))
            }
        } catch (e: MySqlError) {
            /* uk_note_category_user_name */
            if (e.code == 1062 || e.messageText.contains("Duplicate")) {
                return CreateCategoryResult.isDuplicate()
            }
            throw e
        }
    }

    public func updateCategory(userId: Array<Byte>, categoryId: Array<Byte>,
                               req: CategoryUpdate): ?String {
        if (!req.hasName && !req.hasColor) {
            return getCategory(userId, categoryId)
        }
        var sets = ArrayList<String>()
        if (req.hasName) {
            sets.add("name=" + sqlQuote(req.name ?? ""))
        }
        if (req.hasColor) {
            sets.add("color=" + sqlQuote(req.color ?? "#5b7f68"))
        }
        sets.add("updated_at=" + sqlQuote(mysqlDatetime(nowUtcParts())))
        var sql = "UPDATE learning_note_categories SET "
        var first = true
        for (s in sets.toArray()) {
            if (!first) {
                sql = sql + ", "
            }
            first = false
            sql = sql + s
        }
        sql = sql + " WHERE id=" + sqlBinary(categoryId) + " AND user_id=" + sqlBinary(userId)
        try {
            match (conn.query(sql)) {
                case QueryOutcome.Ok(ok) =>
                    if (ok.affectedRows <= 0) {
                        return getCategory(userId, categoryId)
                    }
                    return getCategory(userId, categoryId)
                case QueryOutcome.ResultSet(_) => return getCategory(userId, categoryId)
            }
        } catch (e: MySqlError) {
            if (e.code == 1062) {
                throw e
            }
            throw e
        }
    }

    /* Matches NoteStore.delete_category: unlink notes first, then delete. */
    public func deleteCategory(userId: Array<Byte>, categoryId: Array<Byte>): Bool {
        let unlink = "UPDATE learning_notes SET category_id=NULL WHERE user_id=" +
            sqlBinary(userId) + " AND category_id=" + sqlBinary(categoryId)
        match (conn.query(unlink)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        let sql = "DELETE FROM learning_note_categories WHERE id=" + sqlBinary(categoryId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(ok) => return ok.affectedRows > 0
            case QueryOutcome.ResultSet(_) => return false
        }
    }
}

public struct NoteCreate {
    public let title: String
    public let content: String
    public let status: String
    public let sourceType: String
    public let learnerId: ?Array<Byte>
    public let kpId: ?String
    public let sourceKind: ?String
    public let kbRefs: Array<String>
    public let sourceRef: ?String
    public let sourceContext: ?String
    public let categoryId: ?Array<Byte>
    public let hasKnowledgeId: Bool
    public let knowledgeCategoryId: ?Int64
    public let knowledgeCategoryName: ?String

    public init(title: String, content: String, status: String, sourceType: String,
                learnerId: ?Array<Byte>, kpId: ?String, sourceKind: ?String,
                kbRefs: Array<String>, sourceRef: ?String, sourceContext: ?String,
                categoryId: ?Array<Byte>, hasKnowledgeId: Bool,
                knowledgeCategoryId: ?Int64, knowledgeCategoryName: ?String) {
        this.title = title
        this.content = content
        this.status = status
        this.sourceType = sourceType
        this.learnerId = learnerId
        this.kpId = kpId
        this.sourceKind = sourceKind
        this.kbRefs = kbRefs
        this.sourceRef = sourceRef
        this.sourceContext = sourceContext
        this.categoryId = categoryId
        this.hasKnowledgeId = hasKnowledgeId
        this.knowledgeCategoryId = knowledgeCategoryId
        this.knowledgeCategoryName = knowledgeCategoryName
    }
}

public struct NoteUpdate {
    public let hasTitle: Bool
    public let title: ?String
    public let hasContent: Bool
    public let content: ?String
    public let hasStatus: Bool
    public let status: ?String
    public let hasCategoryId: Bool
    public let categoryId: ?Array<Byte>
    public let hasLearnerId: Bool
    public let learnerId: ?Array<Byte>
    public let hasKpId: Bool
    public let kpId: ?String
    public let hasSourceKind: Bool
    public let sourceKind: ?String
    public let hasKbRefs: Bool
    public let kbRefs: Array<String>
    public let hasKnowledgeId: Bool
    public let knowledgeCategoryId: ?Int64
    public let knowledgeCategoryName: ?String

    public init(hasTitle: Bool, title: ?String, hasContent: Bool, content: ?String,
                hasStatus: Bool, status: ?String, hasCategoryId: Bool, categoryId: ?Array<Byte>,
                hasLearnerId: Bool, learnerId: ?Array<Byte>, hasKpId: Bool, kpId: ?String,
                hasSourceKind: Bool, sourceKind: ?String, hasKbRefs: Bool, kbRefs: Array<String>,
                hasKnowledgeId: Bool, knowledgeCategoryId: ?Int64,
                knowledgeCategoryName: ?String) {
        this.hasTitle = hasTitle
        this.title = title
        this.hasContent = hasContent
        this.content = content
        this.hasStatus = hasStatus
        this.status = status
        this.hasCategoryId = hasCategoryId
        this.categoryId = categoryId
        this.hasLearnerId = hasLearnerId
        this.learnerId = learnerId
        this.hasKpId = hasKpId
        this.kpId = kpId
        this.hasSourceKind = hasSourceKind
        this.sourceKind = sourceKind
        this.hasKbRefs = hasKbRefs
        this.kbRefs = kbRefs
        this.hasKnowledgeId = hasKnowledgeId
        this.knowledgeCategoryId = knowledgeCategoryId
        this.knowledgeCategoryName = knowledgeCategoryName
    }
}

public struct CategoryUpdate {
    public let hasName: Bool
    public let name: ?String
    public let hasColor: Bool
    public let color: ?String

    public init(hasName: Bool, name: ?String, hasColor: Bool, color: ?String) {
        this.hasName = hasName
        this.name = name
        this.hasColor = hasColor
        this.color = color
    }
}

public class CreateCategoryResult {
    public let ok: Bool
    public let duplicate: Bool
    public let category: ?String

    public static func created(category: ?String): CreateCategoryResult {
        CreateCategoryResult(true, false, category)
    }

    public static func isDuplicate(): CreateCategoryResult {
        CreateCategoryResult(false, true, None)
    }

    public init(ok: Bool, duplicate: Bool, category: ?String) {
        this.ok = ok
        this.duplicate = duplicate
        this.category = category
    }
}

/* -------- row serializers (camelCase, matching NoteStore._serialize) -------- */

private func serializeNote(row: Array<MyCell>): String {
    let obj = JsonWriter()
    obj.putOptStr("id", uuidText(row, 0))
    obj.putStr("title", cellText(row, 1))
    obj.putStr("content", cellText(row, 2))
    obj.putStr("status", cellText(row, 3))
    obj.putStr("sourceType", cellText(row, 4))
    obj.putOptStr("sourceRef", optCellText(row, 5))
    obj.putOptStr("sourceContext", optCellText(row, 6))
    obj.putOptStr("learnerId", uuidText(row, 7))
    obj.putOptStr("kpId", optCellText(row, 8))
    obj.putOptStr("sourceKind", optCellText(row, 9))
    obj.putRaw("kbRefs", parseJsonArrayText(cellText(row, 10)))
    obj.putOptStr("categoryId", uuidText(row, 11))
    obj.putOptInt("knowledgeCategoryId", optCellInt(row, 12))
    obj.putOptStr("knowledgeCategoryName", optCellText(row, 13))
    obj.putOptFloat("knowledgeMatchConfidence", optCellFloat(row, 14))
    obj.putOptBool("knowledgeMatchLocked", optCellBool(row, 15))
    obj.putStr("createdAt", isoFromDb(cellText(row, 16)))
    obj.putStr("updatedAt", isoFromDb(cellText(row, 17)))
    return obj.toJson()
}

private func serializeCategory(row: Array<MyCell>): String {
    let obj = JsonWriter()
    obj.putOptStr("id", uuidText(row, 0))
    obj.putStr("name", cellText(row, 1))
    obj.putStr("color", cellText(row, 2))
    obj.putStr("createdAt", isoFromDb(cellText(row, 3)))
    obj.putStr("updatedAt", isoFromDb(cellText(row, 4)))
    return obj.toJson()
}

/* cellText / optCellText / uuidText / optCellInt / optCellFloat / optCellBool /
 * parseJsonArrayText / jsonStringArray / matchFloat live in row_util.cj. */

private func jsonOptInt(obj: JsonObject, key: String): ?Int64 {
    match (obj.get(key)) {
        case None => return None
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsInt => return Some(v.asInt().getValue())
                case JsonKind.JsBool => return Some(if (v.asBool().getValue()) { 1 } else { 0 })
                case JsonKind.JsString => return Int64.tryParse(v.asString().getValue())
                case _ => return None
            }
    }
}
