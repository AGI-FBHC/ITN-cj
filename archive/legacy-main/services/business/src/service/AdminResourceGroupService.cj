package web.service

import std.unicode.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.security.AuthUtilities

public class AdminResourceGroupService {
    private let database: DatabaseConfig
    private let agent: AdminTaskGroupClient
    public init(database: DatabaseConfig) { this.database = database; agent = AdminTaskGroupClient() }
    public func template(admin: User, requested: String): Unit {
        AccountAccessService.requireAdmin(admin)
        let id = ProfileJson.uuid(requested)
        DbTransaction.run<Unit>(database, { tx =>
            let org = lockOrganization(tx, admin)
            let target = " WHERE id = " + AuthUtilities.uuidSql(id) + " AND organization_id = " + org +
                " AND resource_scope = 'ORGANIZATION' AND archived_at IS NULL FOR UPDATE"
            let columns = "SELECT domain_code, category_node_code, COALESCE(resource_group,'默认分组') FROM "
            let resources = tx.query(columns + "generated_learning_resources" + target)
            let fromPpt = resources.isEmpty()
            let rows = if (fromPpt) { tx.query(columns + "presentation_tasks" + target) } else { resources }
            if (rows.isEmpty()) { throw AdminResourceCatalogService.missing() }
            let domain = rows[0][0].getOrDefault({ => "" }); let node = rows[0][1].getOrDefault({ => "" })
            bound(domain, node)
            let group = rows[0][2].getOrThrow()
            let point = " WHERE organization_id = " + org + " AND domain_code = " + AdminResourceCatalogService.literal(domain) +
                " AND category_node_code = " + AdminResourceCatalogService.literal(node) + " AND resource_scope = 'ORGANIZATION' AND archived_at IS NULL"
            for (table in ["generated_learning_resources", "presentation_tasks"]) {
                tx.execute("UPDATE " + table + " SET is_template = 0, updated_at = UTC_TIMESTAMP(6)" + point)
            }
            for (table in ["generated_learning_resources", "presentation_tasks"]) {
                tx.execute("UPDATE " + table + " SET is_template = 1, updated_at = UTC_TIMESTAMP(6)" + point +
                    " AND COALESCE(resource_group,'默认分组') = " + AdminResourceCatalogService.literal(group))
            }
            let reviewTable = if (fromPpt) { "presentation_review_events" } else { "learning_resource_review_events" }
            let reviewId = if (fromPpt) { "presentation_id" } else { "resource_id" }
            tx.execute("INSERT INTO " + reviewTable + " (" + reviewId + ", organization_id, actor_user_id, action, from_status, to_status, comment) VALUES (" +
                AuthUtilities.uuidSql(id) + ", " + org + ", " + AuthUtilities.uuidSql(admin.getId()) + ", 'SET_TEMPLATE', NULL, NULL, " +
                AuthUtilities.text("设为当前知识点与分组的唯一母版") + ")")
        })
    }
    public func deleteGroup(admin: User, domain: String, node: String, requestedGroup: String): Unit {
        AccountAccessService.requireAdmin(admin)
        bound(domain, node)
        let group = requestedGroup.trim()
        if (group.isEmpty()) { throw ProfileJson.invalid("分组名称不能为空") }
        if (group == "默认分组") { throw ProfileJson.invalid("默认分组不允许彻底删除，可先清空该分组下资源") }
        // Complete external cleanup before taking a database lock; Agent uses its own transaction.
        try { agent.deleteTasks(admin, domain.trim(), node.trim(), group) }
        catch (_: Exception) { println("Task-group Agent cleanup unavailable; using database fallback") }
        DbTransaction.run<Unit>(database, { tx =>
            let org = lockOrganization(tx, admin)
            let filter = " WHERE organization_id = " + org + " AND resource_scope = 'ORGANIZATION' AND domain_code = " +
                AdminResourceCatalogService.literal(domain.trim()) + " AND category_node_code = " + AdminResourceCatalogService.literal(node.trim())
            let groupLiteral = AdminResourceCatalogService.literal(group)
            let resourceFilter = filter + " AND BINARY COALESCE(resource_group,JSON_UNQUOTE(JSON_EXTRACT(context_json,'\$.resourceGroup')),'默认分组') = BINARY " + groupLiteral
            let pptFilter = filter + " AND BINARY COALESCE(resource_group,JSON_UNQUOTE(JSON_EXTRACT(request_json,'\$.generationContext.groupName')),'默认分组') = BINARY " + groupLiteral
            tx.execute("DELETE FROM learning_resource_review_events WHERE resource_id IN (SELECT id FROM generated_learning_resources" + resourceFilter + ")")
            tx.execute("DELETE FROM generated_learning_resources" + resourceFilter)
            tx.execute("DELETE FROM presentation_review_events WHERE presentation_id IN (SELECT id FROM presentation_tasks" + pptFilter + ")")
            tx.execute("DELETE FROM presentation_task_user_state WHERE task_id IN (SELECT id FROM presentation_tasks" + pptFilter + ")")
            tx.execute("DELETE FROM presentation_tasks" + pptFilter)
            // Old SQL compared HEX(user_id) to a hyphenated UUID and missed matching tasks.
            tx.execute("DELETE FROM learning_resource_generation_tasks WHERE user_id = " + AuthUtilities.uuidSql(admin.getId()) +
                " AND JSON_UNQUOTE(JSON_EXTRACT(request_json,'\$.generation_context.domainCode')) = " + AdminResourceCatalogService.literal(domain.trim()) +
                " AND JSON_UNQUOTE(JSON_EXTRACT(request_json,'\$.generation_context.nodeCode')) = " + AdminResourceCatalogService.literal(node.trim()) +
                " AND BINARY JSON_UNQUOTE(JSON_EXTRACT(request_json,'\$.generation_context.groupName')) = BINARY " + groupLiteral)
        })
    }
    private static func lockOrganization(tx: DbTransaction, admin: User): String {
        let org = AuthUtilities.uuidSql(admin.getOrganizationId().getOrThrow())
        if (tx.query("SELECT 1 FROM organizations WHERE id = " + org + " FOR UPDATE").isEmpty()) { throw AdminResourceCatalogService.missing() }
        return org
    }
    private static func bound(domain: String, node: String): Unit {
        if (domain.trim().isEmpty() || node.trim().isEmpty()) { throw ProfileJson.invalid("未绑定知识点的资源不能设为母版") }
    }
}
