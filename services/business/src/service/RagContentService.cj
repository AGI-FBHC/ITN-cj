package web.service

import std.collection.*
import std.convert.*
import std.unicode.*
import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.security.AuthUtilities
import web.exception.*

public class RagContentService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func chunks(category: Option<Int64>, query: Option<String>, page: Int64, size: Int64): String {
        let safePage = if (page < 0) { 0 } else { page }
        let safeSize = if (size < 1) { 1 } else if (size > 50) { 50 } else { size }
        return DbTransaction.run<String>(database, { tx =>
            let filter = match (category) {
                case Some(id) => categoryFilter(id)
                case None => searchFilter(query.getOrDefault({ => "" }).trim())
            }
            let order = if (category.isSome()) { " ORDER BY ch.chunk_index ASC" } else { " ORDER BY ch.document_id ASC, ch.chunk_index ASC" }
            let total = tx.query("SELECT COUNT(*) FROM knowledge_chunk ch WHERE " + filter)[0][0].getOrThrow()
            let items = summaries(tx, filter, order, " LIMIT ${safeSize} OFFSET ${safePage * safeSize}")
            return "{\"total\":${total},\"page\":${safePage},\"size\":${safeSize},\"items\":" + items.toString() + "}"
        })
    }
    public func chunk(id: Int64): String { return DbTransaction.run<String>(database, { tx => detail(tx, id) }) }
    public func ragflow(value: String): String {
        return DbTransaction.run<String>(database, { tx =>
            let rows = tx.query("SELECT id FROM knowledge_chunk WHERE ragflow_chunk_id = " +
                AuthUtilities.text(value) + " COLLATE utf8mb4_unicode_ci LIMIT 1")
            if (!rows.isEmpty()) { return detail(tx, Int64.parse(rows[0][0].getOrThrow())) }
            let numeric: Option<Int64> = try { Some(Int64.parse(value)) } catch (_: Exception) { None }
            if (let Some(id) <- numeric) {
                if (!tx.query("SELECT 1 FROM knowledge_chunk WHERE id = ${id}").isEmpty()) { return detail(tx, id) }
            }
            throw missing("RAG Flow knowledge chunk not found: " + value)
        })
    }
    public func document(id: Option<Int64>, code: Option<String>): String {
        return DbTransaction.run<String>(database, { tx =>
            let filter = match (id) { case Some(value) => "id = ${value}"; case None => "document_code = " +
                AuthUtilities.text(code.getOrDefault({ => "" })) + " COLLATE utf8mb4_unicode_ci" }
            let rows = tx.query("SELECT id FROM knowledge_document WHERE " + filter + " LIMIT 1")
            if (rows.isEmpty()) { throw missing("knowledge document not found") }
            return documentJson(tx, Int64.parse(rows[0][0].getOrThrow())).toString()
        })
    }
    public func category(id: Int64): String {
        return DbTransaction.run<String>(database, { tx =>
            let rows = tx.query("SELECT id, parent_id, node_code, name, full_path, level, description, created_by, domain_id " +
                "FROM knowledge_category WHERE id = ${id}")
            if (rows.isEmpty()) { throw missing("knowledge category not found: ${id}") }
            let row = rows[0]
            let data = JsonValue.fromStr(ProfileJson.row(["id", "parentId", "nodeCode", "name", "fullPath", "level", "description", "createdBy"], row, [0, 1, 5])).asObject()
            let direct = tx.query("SELECT COUNT(*) FROM knowledge_chunk_category WHERE category_id = ${id}")[0][0].getOrThrow()
            let domain = Int64.parse(row[8].getOrThrow())
            let indirect = tx.query("WITH RECURSIVE descendants AS (SELECT id FROM knowledge_category WHERE id = ${id} UNION ALL " +
                "SELECT c.id FROM knowledge_category c JOIN descendants d ON c.parent_id = d.id WHERE c.domain_id = ${domain} AND c.status = 1) " +
                "SELECT COUNT(*) FROM knowledge_chunk_category cc JOIN descendants d ON d.id = cc.category_id")[0][0].getOrThrow()
            data.put("directChunkCount", JsonValue.fromStr(direct)); data.put("indirectChunkCount", JsonValue.fromStr(indirect))
            let parents = ArrayList<JsonValue>(); let visited = HashSet<Int64>(); var current = id
            while (current > 0) {
                if (visited.contains(current)) { throw Exception("Knowledge breadcrumb contains a cycle") }
                visited.add(current)
                let ancestor = tx.query("SELECT id, node_code, name, level, parent_id FROM knowledge_category WHERE id = ${current}")
                if (ancestor.isEmpty()) { break }
                parents.add(JsonValue.fromStr(ProfileJson.row(["id", "nodeCode", "name", "level"], ancestor[0], [0, 3])))
                current = match (ancestor[0][4]) { case Some(parent) => Int64.parse(parent); case None => 0 }
            }
            let breadcrumb = JsonArray()
            for (i in 0..parents.size) { breadcrumb.add(parents[parents.size - 1 - i]) }
            data.put("breadcrumb", breadcrumb)
            let children = JsonArray()
            for (child in tx.query("SELECT id, node_code, name, sort_order FROM knowledge_category WHERE domain_id = ${domain} AND parent_id = ${id} ORDER BY sort_order ASC, id ASC")) {
                children.add(JsonValue.fromStr(ProfileJson.row(["id", "nodeCode", "name", "sortOrder"], child, [0, 3])))
            }
            data.put("children", children)
            let recent = summaries(tx, categoryFilter(id), " ORDER BY ch.chunk_index ASC", " LIMIT 6")
            data.put("recentChunks", recent)
            // Related figures must come from the documents of the actual first six chunks.
            let first = tx.query("SELECT ch.document_id FROM knowledge_chunk ch WHERE " + categoryFilter(id) + " ORDER BY ch.chunk_index ASC LIMIT 6")
            var docList = ""
            let docIds = HashSet<String>()
            for (item in first) { if (let Some(value) <- item[0]) { docIds.add(value) } }
            for (value in docIds) { if (!docList.isEmpty()) { docList += "," }; docList += "${Int64.parse(value)}" }
            let figures = JsonArray()
            if (!docList.isEmpty()) {
                for (figure in tx.query("SELECT id, figure_label, caption, image_type, vlm_status, document_id FROM knowledge_figures " +
                    "WHERE document_id IN (" + docList + ") AND vlm_status = 'success' ORDER BY document_id ASC, occurrence_no ASC LIMIT 12")) {
                    figures.add(JsonValue.fromStr(ProfileJson.row(["id", "figureLabel", "caption", "imageType", "vlmStatus", "documentId"], figure, [0, 5])))
                }
            }
            data.put("relatedFigures", figures)
            return data.toString()
        })
    }
    public static func missing(message: String): BusinessException { return BusinessException(ErrorCode.KNOWLEDGE_ARTICLE_NOT_FOUND, 404, message) }
    private static func categoryFilter(id: Int64): String {
        return "ch.id IN (SELECT cc.chunk_id FROM knowledge_chunk_category cc WHERE cc.category_id IN (" +
            "SELECT c.id FROM knowledge_category c LEFT JOIN knowledge_category p ON p.id = c.parent_id " +
            "WHERE c.id = ${id} OR c.parent_id = ${id} OR p.parent_id = ${id}))"
    }
    private static func searchFilter(query: String): String {
        let pattern = "LOWER(CONCAT('%', " + AuthUtilities.text(query) + " COLLATE utf8mb4_unicode_ci, '%'))"
        return "(LOWER(ch.content) LIKE " + pattern + " OR LOWER(ch.summary) LIKE " + pattern +
            " OR LOWER(ch.section_title) LIKE " + pattern + " OR LOWER(ch.title_path) LIKE " + pattern + ")"
    }
    private static func summaries(tx: DbTransaction, filter: String, order: String, limit: String): JsonArray {
        let rows = tx.query("SELECT ch.id, ch.chunk_code, ch.chunk_index, ch.section_title, ch.title_path, ch.summary, ch.token_count, " +
            "ch.page_start, ch.page_end, ch.char_start, ch.char_end, d.document_code, d.title, d.source_name, d.document_type, " +
            "d.standard_number, d.publish_year, d.reliability_score FROM knowledge_chunk ch LEFT JOIN knowledge_document d ON d.id = ch.document_id " +
            "WHERE " + filter + order + limit)
        let result = JsonArray()
        for (row in rows) {
            let item = JsonValue.fromStr(ProfileJson.row(["id", "chunkCode", "chunkIndex", "sectionTitle", "titlePath", "summary", "tokenCount",
                "pageStart", "pageEnd", "charStart", "charEnd", "documentCode", "documentTitle", "documentSourceName", "documentType", "standardNumber", "publishYear", "reliabilityScore"],
                row, [0, 2, 6, 7, 8, 9, 10, 16, 17])).asObject()
            item.put("categories", tags(tx, Int64.parse(row[0].getOrThrow())))
            result.add(item)
        }
        return result
    }
    private static func tags(tx: DbTransaction, id: Int64): JsonArray {
        let result = JsonArray()
        for (row in tx.query("SELECT c.id, c.node_code, c.name, c.full_path FROM knowledge_chunk_category cc JOIN knowledge_category c " +
            "ON c.id = cc.category_id WHERE cc.chunk_id = ${id}")) {
            result.add(JsonValue.fromStr(ProfileJson.row(["id", "nodeCode", "name", "fullPath"], row, [0])))
        }
        return result
    }
    private static func detail(tx: DbTransaction, id: Int64): String {
        let rows = tx.query("SELECT id, chunk_code, chunk_index, section_title, title_path, content, token_count, page_start, page_end, char_start, char_end, " +
            "document_id FROM knowledge_chunk WHERE id = ${id}")
        if (rows.isEmpty()) { throw missing("knowledge chunk not found: ${id}") }
        let data = JsonValue.fromStr(ProfileJson.row(["id", "chunkCode", "chunkIndex", "sectionTitle", "titlePath", "content", "tokenCount", "pageStart", "pageEnd", "charStart", "charEnd"],
            rows[0], [0, 2, 6, 7, 8, 9, 10])).asObject()
        data.put("document", documentJson(tx, Int64.parse(rows[0][11].getOrThrow())))
        data.put("categories", tags(tx, id))
        return data.toString()
    }
    private static func documentJson(tx: DbTransaction, id: Int64): JsonValue {
        let rows = tx.query("SELECT d.id, d.document_code, d.title, d.document_type, d.source_type, d.source_name, d.publisher, d.standard_number, " +
            "d.publish_year, d.version, d.language, d.reliability_score, d.summary, d.keywords, d.status, " +
            "(SELECT COUNT(*) FROM knowledge_chunk ch WHERE ch.document_id = d.id), " +
            "(SELECT COUNT(*) FROM knowledge_figures f WHERE f.document_id = d.id), " +
            "(SELECT COUNT(*) FROM knowledge_figures f WHERE f.document_id = d.id AND f.vlm_status = 'success') FROM knowledge_document d WHERE d.id = ${id}")
        if (rows.isEmpty()) { return JsonValue.fromStr("null") }
        let row = rows[0]
        row[13] = Some(keywords(row[13].getOrDefault({ => "" })).toString())
        return JsonValue.fromStr(ProfileJson.row(["id", "documentCode", "title", "documentType", "sourceType", "sourceName", "publisher", "standardNumber",
            "publishYear", "version", "language", "reliabilityScore", "summary", "keywords", "status", "chunkCount", "figureCount", "describedFigureCount"],
            row, [0, 8, 11, 13, 15, 16, 17]))
    }
    private static func keywords(value: String): JsonArray {
        let result = JsonArray()
        let text = value.trim()
        if (text.isEmpty()) { return result }
        if (text.startsWith("[")) {
            let bytes = text.toArray(); var end = bytes.size - 1
            while (end >= 1 && bytes[end] != 93u8) { end -= 1 }
            if (end < 1) { return result }
            for (part in String.fromUtf8(bytes.slice(1, end - 1)).split(",")) {
                let item = stripQuotes(part.trim())
                if (!item.isEmpty()) { result.add(JsonString(item)) }
            }
        } else { result.add(JsonString(stripQuotes(text))) }
        return result
    }
    private static func stripQuotes(text: String): String {
        let bytes = text.toArray(); var start = 0; var end = bytes.size
        if (start < end && bytes[start] == 34u8) { start += 1 }
        if (end > start && bytes[end - 1] == 34u8) { end -= 1 }
        return String.fromUtf8(bytes.slice(start, end - start))
    }
}
