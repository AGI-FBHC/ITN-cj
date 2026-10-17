package web.service

import std.unicode.*
import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.security.AuthUtilities

public class ProfileCatalogService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func categories(): String { return DbTransaction.run<String>(database, { tx => categoryRows(tx) }) }
    public func targets(): String { return DbTransaction.run<String>(database, { tx => targetRows(tx) }) }
    public func meta(): String {
        return DbTransaction.run<String>(database, { tx =>
            let points = tx.query("SELECT code, en_name, COALESCE(weight, 0), COALESCE(target_level, 80), " +
                "COALESCE(coverage, 90), description, core_topics_json FROM knowledge_point WHERE status = 1 ORDER BY sort_order ASC, id ASC")
            let knowledge = JsonArray()
            for (row in points) {
                let point = JsonObject()
                let code = row[0].getOrThrow()
                point.put("id", JsonString(code))
                let name = match (code) {
                    case "kp-ds" => "知识理解"
                    case "kp-co" => "逻辑推理"
                    case "kp-os" => "工程实践"
                    case "kp-network" => "问题诊断"
                    case "kp-db" => "系统设计"
                    case "kp-agent" => "学习迁移"
                    case _ => "综合能力"
                }
                point.put("name", JsonString(name))
                point.put("en", match (row[1]) { case Some(value) => JsonString(value); case None => JsonValue.fromStr("null") })
                point.put("weight", JsonValue.fromStr(row[2].getOrThrow()))
                point.put("targetLevel", JsonValue.fromStr(row[3].getOrThrow()))
                point.put("coverage", JsonValue.fromStr(row[4].getOrThrow()))
                point.put("description", match (row[5]) { case Some(value) => JsonString(value); case None => JsonValue.fromStr("null") })
                point.put("coreTopics", JsonValue.fromStr(ProfileJson.safeJson(row[6], "[]", true)))
                knowledge.add(point)
            }
            return "{\"knowledgePoints\":" + knowledge.toString() + ",\"tags\":" + OnboardingStaticData.tagsJson +
                ",\"edu\":" + OnboardingStaticData.eduJson + ",\"targetCategories\":" + categoryRows(tx) +
                ",\"targetOptions\":" + targetRows(tx) + ",\"styles\":" + OnboardingStaticData.stylesJson +
                ",\"selfLevels\":" + OnboardingStaticData.selfLevelsJson + ",\"questions\":" + OnboardingStaticData.questionsJson + "}"
        })
    }
    public func jobTargets(job: Option<String>): String {
        return DbTransaction.run<String>(database, { tx =>
            let value = job.getOrDefault({ => "" }).trim()
            let filter = if (value.isEmpty()) { "" } else {
                " WHERE job_code = " + AuthUtilities.text(value) + " COLLATE utf8mb4_unicode_ci ORDER BY sort_order ASC, id ASC"
            }
            let rows = tx.query("SELECT id, job_code, node_code, node_name, target_mastery, priority, sort_order " +
                "FROM job_target_levels" + filter)
            return rowsJson(["id", "jobCode", "nodeCode", "nodeName", "targetMastery", "priority", "sortOrder"], rows, [0, 4, 5, 6])
        })
    }
    private static func categoryRows(tx: DbTransaction): String {
        let rows = tx.query("SELECT id, code, name, description, COALESCE(sort_order, 0), 'true' FROM target_categories " +
            "WHERE status = 1 ORDER BY sort_order ASC, id ASC")
        return rowsJson(["id", "code", "name", "description", "sortOrder", "enabled"], rows, [0, 4, 5])
    }
    private static func targetRows(tx: DbTransaction): String {
        let rows = tx.query("SELECT id, code, category_code, name, description, COALESCE(sort_order, 0), 'true' FROM target_options " +
            "WHERE status = 1 ORDER BY sort_order ASC, id ASC")
        return rowsJson(["id", "code", "categoryCode", "name", "description", "sortOrder", "enabled"], rows, [0, 5, 6])
    }
    private static func rowsJson(names: Array<String>, rows: Array<Array<Option<String>>>, raw: Array<Int64>): String {
        var result = "["
        for (i in 0..rows.size) { if (i > 0) { result += "," }; result += ProfileJson.row(names, rows[i], raw) }
        return result + "]"
    }
}
