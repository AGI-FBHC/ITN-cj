package web.service

import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.security.AuthUtilities
import web.exception.*

// Read-only prerequisite used by the existing learning-progress page.
public class LearningKnowledgeReadService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func domains(): String {
        return DbTransaction.run<String>(database, { tx =>
            let result = JsonArray()
            for (row in tx.query("SELECT id FROM knowledge_domain WHERE status = 1 ORDER BY id")) {
                result.add(domain(tx, Int64.parse(row[0].getOrThrow())))
            }
            return result.toString()
        })
    }
    public func tree(code: String): String {
        return DbTransaction.run<String>(database, { tx =>
            let domains = tx.query("SELECT id FROM knowledge_domain WHERE code = " + AuthUtilities.text(code) + " COLLATE utf8mb4_unicode_ci LIMIT 1")
            if (domains.isEmpty()) { throw BusinessException(ErrorCode.KNOWLEDGE_ARTICLE_NOT_FOUND, 404, "knowledge domain not found: " + code) }
            let id = Int64.parse(domains[0][0].getOrThrow())
            let rows = tx.query("SELECT id, parent_id, node_code, name, level, node_type, sort_order FROM knowledge_category " +
                "WHERE domain_id = ${id} AND status = 1 ORDER BY level ASC, sort_order ASC, id ASC")
            let nodes = HashMap<String, JsonObject>()
            let children = HashMap<String, ArrayList<String>>()
            var points = 0i64
            for (row in rows) {
                let node = JsonValue.fromStr(ProfileJson.row(["id", "parentId", "nodeCode", "name", "level", "nodeType", "sortOrder"], row, [0, 1, 4, 6])).asObject()
                node.put("description", JsonValue.fromStr("null"))
                node.put("children", JsonArray())
                nodes[row[0].getOrThrow()] = node
                if (row[4].getOrDefault({ => "0" }) == "3") { points += 1 }
                if (let Some(parent) <- row[1]) {
                    if (!children.contains(parent)) { children[parent] = ArrayList<String>() }
                    children[parent].add(row[0].getOrThrow())
                }
            }
            let roots = JsonArray()
            for (row in rows) {
                let key = row[0].getOrThrow()
                let ids = HashSet<String>()
                collect(key, children, ids)
                var inList = ""
                for (descendant in ids) { if (!inList.isEmpty()) { inList += "," }; inList += "${Int64.parse(descendant)}" }
                let counts = tx.query("SELECT COUNT(*) FROM knowledge_chunk_category WHERE category_id IN (" + inList + ")")[0][0].getOrThrow()
                nodes[key].put("chunkCount", JsonValue.fromStr(counts))
                if (let Some(parent) <- row[1]) {
                    if (nodes.contains(parent)) { nodes[parent].get("children").getOrThrow().asArray().add(nodes[key]) }
                    else { roots.add(nodes[key]) }
                } else { roots.add(nodes[key]) }
            }
            for ((_, node) in nodes) { node.put("leaf", JsonValue.fromStr(if (node.get("children").getOrThrow().asArray().getItems().isEmpty()) { "true" } else { "false" })) }
            let result = JsonObject()
            let info = domain(tx, id)
            result.put("domain", info); result.put("nodes", roots)
            let edges = JsonArray()
            if (!rows.isEmpty()) {
                for (row in tx.query("SELECT prereq.node_code, target.node_code, e.edge_type, e.rationale FROM knowledge_category_prerequisite e " +
                    "JOIN knowledge_category target ON target.id = e.category_id JOIN knowledge_category prereq ON prereq.id = e.prereq_category_id " +
                    "WHERE e.domain_id = ${id} AND e.status = 'active' AND target.status = 1 AND prereq.status = 1 ORDER BY e.id")) {
                    edges.add(JsonValue.fromStr(ProfileJson.row(["from", "to", "kind", "note"], row, [])))
                }
            }
            result.put("edges", edges); result.put("totalKnowledgePoints", JsonValue.fromStr("${points}"))
            result.put("totalChunks", if (rows.isEmpty()) { JsonValue.fromStr("0") } else { info.get("chunkCount").getOrThrow() })
            return result.toString()
        })
    }
    public func points(code: Option<String>): String {
        return DbTransaction.run<String>(database, { tx =>
            let filter = match (code) { case Some(value) => " AND p.code = " + AuthUtilities.text(value) + " COLLATE utf8mb4_unicode_ci"; case None => "" }
            let rows = tx.query("SELECT p.id, p.code, p.name, p.en_name, p.weight, p.target_level, p.coverage, p.description, " +
                "p.core_topics_json, p.prerequisites_json, d.code, d.name FROM knowledge_point p LEFT JOIN knowledge_domain d ON d.id = p.domain_id " +
                "WHERE p.status = 1" + filter + " ORDER BY p.sort_order ASC, p.id ASC")
            if (code.isSome() && rows.isEmpty()) { throw BusinessException(ErrorCode.KNOWLEDGE_POINT_NOT_FOUND, 404, "知识点不存在") }
            let result = JsonArray()
            for (row in rows) {
                row[8] = Some(ProfileJson.safeJson(row[8], "[]", true)); row[9] = Some(ProfileJson.safeJson(row[9], "[]", true))
                result.add(JsonValue.fromStr(ProfileJson.row(["id", "code", "name", "enName", "weight", "targetLevel", "coverage", "description",
                    "coreTopics", "prerequisites", "domainCode", "domainName"], row, [0, 4, 5, 6, 8, 9])))
            }
            return if (code.isSome()) { result.getItems()[0].toString() } else { result.toString() }
        })
    }
    private static func collect(id: String, children: HashMap<String, ArrayList<String>>, found: HashSet<String>): Unit {
        if (found.contains(id)) { throw Exception("Knowledge tree contains a cycle") }
        found.add(id)
        if (let Some(items) <- children.get(id)) { for (child in items) { collect(child, children, found) } }
    }
    private static func domain(tx: DbTransaction, id: Int64): JsonObject {
        let row = tx.query("SELECT d.id, d.code, d.name, d.description, d.icon, " +
            "(SELECT COUNT(*) FROM knowledge_category c WHERE c.domain_id = d.id), " +
            "(SELECT COUNT(*) FROM knowledge_category c WHERE c.domain_id = d.id AND c.level = 3), " +
            "(SELECT COUNT(DISTINCT ch.document_id) FROM knowledge_chunk ch JOIN knowledge_chunk_category cc ON cc.chunk_id = ch.id " +
            "JOIN knowledge_category c ON c.id = cc.category_id WHERE c.domain_id = d.id), " +
            "(SELECT COUNT(DISTINCT cc.chunk_id) FROM knowledge_chunk_category cc JOIN knowledge_category c ON c.id = cc.category_id WHERE c.domain_id = d.id), " +
            "(SELECT COUNT(*) FROM knowledge_figures f WHERE f.document_id IN (SELECT DISTINCT ch.document_id FROM knowledge_chunk ch " +
            "JOIN knowledge_chunk_category cc ON cc.chunk_id = ch.id JOIN knowledge_category c ON c.id = cc.category_id WHERE c.domain_id = d.id)) " +
            "FROM knowledge_domain d WHERE d.id = ${id}")[0]
        return JsonValue.fromStr(ProfileJson.row(["id", "code", "name", "description", "icon", "categoryCount", "knowledgePointCount", "documentCount", "chunkCount", "figureCount"],
            row, [0, 5, 6, 7, 8, 9])).asObject()
    }
}
