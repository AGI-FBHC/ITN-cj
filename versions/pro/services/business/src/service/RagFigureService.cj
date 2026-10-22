package web.service

import std.unicode.*
import std.convert.*
import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.security.AuthUtilities

public class RagFigureService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func detail(id: Int64): String { return DbTransaction.run<String>(database, { tx => detailJson(tx, id).toString() }) }
    public func list(query: Option<String>, page: Int64, size: Int64): String {
        let safePage = if (page < 0) { 0 } else { page }
        let safeSize = if (size < 1) { 1 } else if (size > 50) { 50 } else { size }
        let text = query.getOrDefault({ => "" }).trim()
        let matchText = "LOWER(CONCAT('%', " + AuthUtilities.text(text) + " COLLATE utf8mb4_unicode_ci, '%'))"
        let filter = if (text.isEmpty()) { "" } else { " WHERE vlm_status = 'success' AND (LOWER(caption) LIKE " +
            matchText + " OR LOWER(vlm_description) LIKE " + matchText + " OR LOWER(section_path) LIKE " + matchText + ")" }
        return DbTransaction.run<String>(database, { tx =>
            let total = tx.query("SELECT COUNT(*) FROM knowledge_figures" + filter)[0][0].getOrThrow()
            let rows = tx.query("SELECT id FROM knowledge_figures" + filter +
                " ORDER BY COALESCE(document_id, 0) ASC, COALESCE(occurrence_no, 0) ASC LIMIT ${safeSize} OFFSET ${safePage * safeSize}")
            let names = ["id", "documentId", "documentTitle", "occurrenceNo", "figureLabel", "caption", "altText", "sectionPath", "imageType",
                "fileSize", "width", "height", "mimeType", "downloadStatus", "uploadStatus", "vlmStatus", "hasStorage", "imageUrl", "vlmDescription"]
            let items = JsonArray()
            for (row in rows) {
                let full = detailJson(tx, Int64.parse(row[0].getOrThrow()))
                let summary = JsonObject()
                for (name in names) { summary.put(name, full.get(name).getOrDefault({ => JsonValue.fromStr("null") })) }
                items.add(summary)
            }
            let statsRow = tx.query("SELECT COUNT(*), COALESCE(SUM(vlm_status = 'success'), 0), COALESCE(SUM(vlm_status = 'pending'), 0), " +
                "COALESCE(SUM(vlm_status = 'failed'), 0) FROM knowledge_figures")[0]
            let stats = ProfileJson.row(["total", "described", "pending", "failed"], statsRow, [0, 1, 2, 3])
            return "{\"total\":${total},\"page\":${safePage},\"size\":${safeSize},\"items\":" + items.toString() + ",\"stats\":" + stats + "}"
        })
    }
    public func imageInfo(id: Int64): Array<Option<String>> {
        return DbTransaction.run<Array<Option<String>>>(database, { tx =>
            let rows = tx.query("SELECT storage_key, mime_type FROM knowledge_figures WHERE id = ${id}")
            if (rows.isEmpty() || rows[0][0].getOrDefault({ => "" }).trim().isEmpty()) {
                throw RagContentService.missing("figure binary not found: ${id}")
            }
            return rows[0]
        })
    }
    private static func detailJson(tx: DbTransaction, id: Int64): JsonObject {
        let rows = tx.query("SELECT f.id, f.document_id, d.title, f.occurrence_no, f.figure_label, f.caption, f.alt_text, f.section_path, " +
            "f.source_url, f.storage_key, f.image_type, f.mime_type, f.file_extension, f.file_size, f.width, f.height, f.sha256, " +
            "f.download_status, f.upload_status, f.vlm_status, f.vlm_description, f.vlm_model, " +
            "DATE_FORMAT(f.downloaded_at, '%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(f.uploaded_at, '%Y-%m-%dT%H:%i:%s.%fZ'), " +
            "DATE_FORMAT(f.described_at, '%Y-%m-%dT%H:%i:%s.%fZ') FROM knowledge_figures f LEFT JOIN knowledge_document d ON d.id = f.document_id " +
            "WHERE f.id = ${id}")
        if (rows.isEmpty()) { throw RagContentService.missing("knowledge figure not found: ${id}") }
        let data = JsonValue.fromStr(ProfileJson.row(["id", "documentId", "documentTitle", "occurrenceNo", "figureLabel", "caption", "altText", "sectionPath",
            "sourceUrl", "storageKey", "imageType", "mimeType", "fileExtension", "fileSize", "width", "height", "sha256", "downloadStatus", "uploadStatus",
            "vlmStatus", "vlmDescription", "vlmModel", "downloadedAt", "uploadedAt", "describedAt"], rows[0], [0, 1, 3, 13, 14, 15])).asObject()
        let hasStorage = !rows[0][9].getOrDefault({ => "" }).trim().isEmpty()
        data.put("hasStorage", JsonValue.fromStr(if (hasStorage) { "true" } else { "false" }))
        data.put("imageUrl", if (hasStorage) { JsonString("/api/v1/rag/figures/${id}/image") } else { JsonValue.fromStr("null") })
        return data
    }
}
