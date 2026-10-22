package web.service

import std.unicode.*
import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.exception.*
import web.security.AuthUtilities

public class AdminResourceCatalogService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func list(admin: User, view: String, kind: Option<String>, keyword: Option<String>, domain: Option<String>, node: Option<String>): String {
        AccountAccessService.requireAdmin(admin)
        if (view != "library" && view != "archive" && view != "recycle") { throw ProfileJson.invalid("资源视图无效") }
        let ppt = kind.getOrDefault({ => "" }) == "ppt"
        let alias = if (ppt) { "p" } else { "r" }
        let condition = if (view == "library") { alias + ".archived_at IS NULL AND " + alias + ".resource_scope = 'ORGANIZATION'" }
            else { alias + ".archived_at IS NOT NULL" }
        var filter = " WHERE " + alias + ".organization_id = " + AuthUtilities.uuidSql(admin.getOrganizationId().getOrThrow()) + " AND " + condition
        if (ppt) { filter += " AND p.status = 'completed'" }
        else if (let Some(value) <- kind) { if (!value.trim().isEmpty()) { filter += " AND r.resource_type = " + literal(value.trim()) } }
        filter += treeFilter(alias, domain, node)
        if (let Some(value) <- keyword) {
            if (!value.trim().isEmpty()) {
                let pattern = "CONCAT('%', " + literal(value.trim()) + ", '%')"
                filter += if (ppt) { " AND (p.title LIKE " + pattern + " OR JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'\$.requirement')) LIKE " + pattern + ")" }
                    else { " AND (r.title LIKE " + pattern + " OR r.topic LIKE " + pattern + " OR r.kp_id LIKE " + pattern + ")" }
            }
        }
        let sql = (if (ppt) { presentationList } else { resourceList }) + filter + " ORDER BY COALESCE(" + alias + ".archived_at," + alias + ".updated_at) DESC LIMIT 500"
        return DbTransaction.run<String>(database, { tx =>
            let items = JsonArray()
            let names = if (ppt) { presentationNames } else { resourceNames }
            for (row in tx.query(sql)) { items.add(JsonValue.fromStr(ProfileJson.row(names, row, if (ppt) { [7, 10] } else { [6, 9] }))) }
            return "{\"items\":" + items.toString() + ",\"total\":${items.getItems().size}}"
        })
    }
    public func detail(admin: User, requested: String): String {
        AccountAccessService.requireAdmin(admin)
        let id = ProfileJson.uuid(requested)
        return DbTransaction.run<String>(database, { tx =>
            let filter = " WHERE id = " + AuthUtilities.uuidSql(id) + " AND organization_id = " + AuthUtilities.uuidSql(admin.getOrganizationId().getOrThrow())
            let rows = tx.query(resourceDetail + filter)
            if (!rows.isEmpty()) { return ProfileJson.row(detailNames, rows[0], [6, 9]) }
            let presentations = tx.query(presentationDetail + filter)
            if (presentations.isEmpty()) { throw missing() }
            return ProfileJson.row(presentationDetailNames, presentations[0], [6, 9])
        })
    }
    public static func missing(): BusinessException { return BusinessException(ErrorCode.KNOWLEDGE_ASSET_NOT_FOUND, 404, "资源不存在或不属于当前机构") }
    public static func literal(value: String): String { return AuthUtilities.text(value) + " COLLATE utf8mb4_unicode_ci" }
    private static func treeFilter(alias: String, domain: Option<String>, node: Option<String>): String {
        if (domain.getOrDefault({ => "" }) == "__unassigned__") { return " AND " + alias + ".domain_code IS NULL" }
        var filter = ""
        if (let Some(value) <- domain) { if (!value.trim().isEmpty()) { filter += " AND " + alias + ".domain_code = " + literal(value.trim()) } }
        if (let Some(value) <- node) { if (!value.trim().isEmpty()) { filter += " AND " + alias + ".category_node_code = " + literal(value.trim()) } }
        return filter
    }
    private static let resourceNames = ["id", "type", "title", "topic", "scope", "reviewStatus", "revision", "domainCode", "nodeCode", "template", "groupName",
        "baseResourceId", "learnerId", "kpId", "createdAt", "updatedAt", "archivedAt", "archiveReason", "ownerAccount"]
    private static let presentationNames = ["id", "type", "status", "title", "topic", "scope", "reviewStatus", "revision", "domainCode", "nodeCode", "template", "groupName",
        "baseResourceId", "learnerId", "kpId", "createdAt", "updatedAt", "archivedAt", "archiveReason", "ownerAccount"]
    private static let detailNames = ["id", "type", "title", "topic", "scope", "reviewStatus", "revision", "domainCode", "nodeCode", "template", "kpId", "groupName",
        "content", "sources", "decision", "createdAt", "updatedAt", "archivedAt", "archiveReason"]
    private static let presentationDetailNames = ["id", "type", "title", "topic", "scope", "reviewStatus", "revision", "domainCode", "nodeCode", "template", "kpId",
        "content", "sources", "decision", "createdAt", "updatedAt", "archivedAt", "archiveReason"]
    private static let resourceList = "SELECT LOWER(BIN_TO_UUID(r.id,0)), r.resource_type, r.title, r.topic, r.resource_scope, r.review_status, r.revision, " +
        "r.domain_code, r.category_node_code, IF(r.is_template = 1,'true','false'), JSON_UNQUOTE(JSON_EXTRACT(r.context_json,'\$.resourceGroup')), " +
        "LOWER(BIN_TO_UUID(r.base_resource_id,0)), LOWER(BIN_TO_UUID(r.learner_id,0)), r.kp_id, " +
        "DATE_FORMAT(r.created_at,'%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(r.updated_at,'%Y-%m-%dT%H:%i:%s.%fZ'), " +
        "DATE_FORMAT(r.archived_at,'%Y-%m-%dT%H:%i:%s.%fZ'), r.archive_reason, u.email FROM generated_learning_resources r LEFT JOIN users u ON u.id = r.user_id"
    private static let presentationList = "SELECT LOWER(BIN_TO_UUID(p.id,0)), 'ppt', p.status, p.title, " +
        "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'\$.generationContext.topicName')),JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'\$.generationContext.current.topicName')), " +
        "JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'\$.requirement')),p.title), p.resource_scope, p.review_status, p.revision, p.domain_code, p.category_node_code, " +
        "IF(p.is_template = 1,'true','false'), COALESCE(p.resource_group,JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'\$.generationContext.groupName')),'默认分组'), " +
        "LOWER(BIN_TO_UUID(p.base_presentation_id,0)), NULL, JSON_UNQUOTE(JSON_EXTRACT(p.request_json,'\$.generationContext.kpId')), " +
        "DATE_FORMAT(p.created_at,'%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(p.updated_at,'%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(p.archived_at,'%Y-%m-%dT%H:%i:%s.%fZ'), " +
        "p.archive_reason, u.email FROM presentation_tasks p LEFT JOIN users u ON u.id = p.user_id"
    private static let resourceDetail = "SELECT LOWER(BIN_TO_UUID(id,0)), resource_type, title, topic, resource_scope, review_status, revision, domain_code, category_node_code, " +
        "IF(is_template = 1,'true','false'), kp_id, JSON_UNQUOTE(JSON_EXTRACT(context_json,'\$.resourceGroup')), content_json, sources_json, decision_json, " +
        "DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(updated_at,'%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(archived_at,'%Y-%m-%dT%H:%i:%s.%fZ'), " +
        "archive_reason FROM generated_learning_resources"
    private static let presentationDetail = "SELECT LOWER(BIN_TO_UUID(id,0)), 'ppt', title, " +
        "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(request_json,'\$.generationContext.topicName')),JSON_UNQUOTE(JSON_EXTRACT(request_json,'\$.generationContext.current.topicName')), " +
        "JSON_UNQUOTE(JSON_EXTRACT(request_json,'\$.requirement')),title), resource_scope, review_status, revision, domain_code, category_node_code, " +
        "IF(is_template = 1,'true','false'), JSON_UNQUOTE(JSON_EXTRACT(request_json,'\$.generationContext.kpId')), request_json, events_json, outline_json, " +
        "DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(updated_at,'%Y-%m-%dT%H:%i:%s.%fZ'), DATE_FORMAT(archived_at,'%Y-%m-%dT%H:%i:%s.%fZ'), " +
        "archive_reason FROM presentation_tasks"
}
