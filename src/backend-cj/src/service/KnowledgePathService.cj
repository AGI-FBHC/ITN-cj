package web.service

import std.convert.*
import std.unicode.*
import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.security.AuthUtilities

public class KnowledgePathService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func path(user: User): String {
        return DbTransaction.run<String>(database, { tx =>
            let rows = tx.query("SELECT p.code, p.name, COALESCE(r.mastery, 0.5000), p.target_level, " +
                "ROUND(p.target_level/100.0, 4) - COALESCE(r.mastery, 0.5000), " +
                "CASE WHEN r.id IS NULL THEN 'not_started' WHEN r.mastery >= ROUND(p.target_level/100.0, 4) THEN 'ready' ELSE 'recommended' END, " +
                "p.prerequisites_json FROM knowledge_point p LEFT JOIN review_schedules r ON r.knowledge_point_id = p.id AND r.user_id = " +
                AuthUtilities.uuidSql(user.getId()) + " WHERE p.status = 1 ORDER BY COALESCE(r.mastery, 0.5000) ASC, p.sort_order ASC, p.id ASC")
            let result = JsonArray()
            for (i in 0..rows.size) {
                let row = rows[i]
                let data = JsonValue.fromStr(ProfileJson.row(["kpId", "name", "mastery", "targetLevel", "gap", "status"], row, [2, 3, 4])).asObject()
                data.put("sequence", JsonValue.fromStr("${i + 1}"))
                data.put("prerequisites", JsonValue.fromStr(ProfileJson.safeJson(row[6], "[]", true)))
                result.add(data)
            }
            return result.toString()
        })
    }
    public func graph(): String {
        return DbTransaction.run<String>(database, { tx =>
            let rows = tx.query("SELECT code, name, en_name, target_level, coverage, COALESCE(weight, 0), prerequisites_json " +
                "FROM knowledge_point WHERE status = 1 ORDER BY sort_order ASC, id ASC")
            let nodes = JsonArray(); let edges = JsonArray()
            for (row in rows) {
                nodes.add(JsonValue.fromStr(ProfileJson.row(["id", "name", "enName", "targetLevel", "coverage", "weight"], row, [3, 4, 5])))
                for (target in JsonValue.fromStr(ProfileJson.safeJson(row[6], "[]", true)).asArray().getItems()) {
                    let edge = JsonObject()
                    edge.put("source", JsonString(row[0].getOrThrow())); edge.put("target", target); edge.put("type", JsonString("requires"))
                    edges.add(edge)
                }
            }
            let data = JsonObject(); data.put("nodes", nodes); data.put("edges", edges)
            return data.toString()
        })
    }
    public func search(query: String): String {
        return DbTransaction.run<String>(database, { tx =>
            let items = JsonArray()
            if (!query.trim().isEmpty()) {
                let term = AuthUtilities.text(query.trim()) + " COLLATE utf8mb4_unicode_ci"
                let rows = tx.query("SELECT code, name, description FROM knowledge_point WHERE status = 1 AND (" +
                    "LOCATE(LOWER(" + term + "), LOWER(name)) > 0 OR LOCATE(LOWER(" + term + "), LOWER(code)) > 0 OR " +
                    "LOCATE(LOWER(" + term + "), LOWER(description)) > 0 OR LOCATE(LOWER(" + term + "), LOWER(core_topics_json)) > 0) " +
                    "ORDER BY sort_order ASC, id ASC LIMIT 20")
                for (row in rows) { items.add(searchItem("knowledge", row, "/learn/" + row[0].getOrThrow())) }
                if (items.getItems().size < 20) {
                    let remaining = 20 - items.getItems().size
                    for (row in tx.query("SELECT CAST(id AS CHAR), name, description FROM knowledge_category WHERE status = 1 AND " +
                        "(LOCATE(LOWER(" + term + "), LOWER(name)) > 0 OR LOCATE(LOWER(" + term + "), LOWER(full_path)) > 0) LIMIT ${remaining}")) {
                        items.add(searchItem("category", row, "/knowledge"))
                    }
                }
            }
            return "{\"total\":${items.getItems().size},\"items\":" + items.toString() + "}"
        })
    }
    private static func searchItem(kind: String, row: Array<Option<String>>, href: String): JsonObject {
        let result = JsonValue.fromStr(ProfileJson.row(["id", "title", "excerpt"], row, [])).asObject()
        result.put("type", JsonString(kind)); result.put("url", JsonString(href))
        return result
    }
}
