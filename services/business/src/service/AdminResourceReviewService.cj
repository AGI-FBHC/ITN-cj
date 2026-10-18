package web.service

import std.unicode.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.security.AuthUtilities

public class AdminResourceReviewService {
    private let database: DatabaseConfig
    private let agent = AdminPresentationCleanupClient()
    public init(database: DatabaseConfig) { this.database = database }
    private static func filter(admin: User, id: String): String {
        AccountAccessService.requireAdmin(admin)
        return " WHERE id=" + AuthUtilities.uuidSql(ProfileJson.uuid(id)) + " AND organization_id=" + AuthUtilities.uuidSql(admin.getOrganizationId().getOrThrow())
    }
    private static func event(tx: DbTransaction, admin: User, id: String, ppt: Bool, action: String, before: Option<String>, after: Option<String>, comment: Option<String>): Unit {
        let table = if (ppt) { "presentation_review_events" } else { "learning_resource_review_events" }
        let column = if (ppt) { "presentation_id" } else { "resource_id" }
        tx.execute("INSERT INTO " + table + "(" + column + ",organization_id,actor_user_id,action,from_status,to_status,comment) VALUES(" +
            AuthUtilities.uuidSql(id) + "," + AuthUtilities.uuidSql(admin.getOrganizationId().getOrThrow()) + "," + AuthUtilities.uuidSql(admin.getId()) + "," + AuthUtilities.text(action) + "," + ProfileJson.textSql(before) + "," + ProfileJson.textSql(after) + "," + ProfileJson.textSql(comment) + ")")
    }
    public func review(admin: User, requested: String, action: String, comment: Option<String>): Unit {
        let condition = filter(admin, requested) + " AND resource_scope='ORGANIZATION' AND archived_at IS NULL"
        let next = match (action) {
            case "submit" => "PENDING"
            case "approve" => "APPROVED"
            case "reject" => "REJECTED"
            case "publish" => "PUBLISHED"
            case "deprecate" => "DEPRECATED"
            case _ => throw ProfileJson.invalid("审核操作无效")
        }
        DbTransaction.run<Unit>(database, { tx =>
            let resources = tx.query("SELECT review_status FROM generated_learning_resources" + condition + " FOR UPDATE")
            let ppt = resources.isEmpty()
            let rows = if (ppt) { tx.query("SELECT review_status FROM presentation_tasks" + condition + " FOR UPDATE") } else { resources }
            if (rows.isEmpty()) { throw AdminResourceCatalogService.missing() }
            let current = rows[0][0].getOrDefault({ => "" })
            let allowed = match (action) {
                case "submit" => current == "DRAFT" || current == "REJECTED"
                case "approve" | "reject" => current == "PENDING"
                case "publish" => current == "APPROVED"
                case "deprecate" => current == "PUBLISHED"
                case _ => false
            }
            if (!allowed) { throw ProfileJson.invalid("当前审核状态不允许执行该操作") }
            tx.execute("UPDATE " + if (ppt) { "presentation_tasks" } else { "generated_learning_resources" } +
                " SET review_status=" + AuthUtilities.text(next) + ",is_public=0,updated_at=UTC_TIMESTAMP(6)" + condition)
            event(tx, admin, requested, ppt, action.toUpper(CasingOption.Other), Some(current), Some(next), comment)
        })
    }
    public func restore(admin: User, requested: String): Unit {
        let condition = filter(admin, requested) + " AND archived_at IS NOT NULL"
        DbTransaction.run<Unit>(database, { tx =>
            let common = " SET user_id=" + AuthUtilities.uuidSql(admin.getId()) + ",archived_at=NULL,archived_by=NULL,archive_reason=NULL,resource_scope='ORGANIZATION',review_status='DRAFT',is_public=0,updated_at=UTC_TIMESTAMP(6)"
            let changed = tx.execute("UPDATE generated_learning_resources" + common + ",learner_id=NULL,learning_goal_id=NULL,course_id=NULL,chapter_id=NULL,state_json=JSON_OBJECT()" + condition)
            let ppt = changed != 1
            if (ppt && tx.execute("UPDATE presentation_tasks" + common + ",learned_json=JSON_OBJECT()" + condition) != 1) { throw AdminResourceCatalogService.missing() }
            event(tx, admin, requested, ppt, "RESTORE", None, Some("DRAFT"), Some("恢复到机构资源库，不绑定学习者"))
        })
    }
    public func archive(admin: User, requested: String, reason: Option<String>): Unit {
        let condition = filter(admin, requested) + " AND archived_at IS NULL"
        let supplied = reason.getOrDefault({ => "" }).trim()
        let stored = if (supplied.isEmpty()) { "管理员归档" } else { supplied }
        DbTransaction.run<Unit>(database, { tx =>
            let changes = " SET archived_at=UTC_TIMESTAMP(6),archived_by=" + AuthUtilities.uuidSql(admin.getId()) + ",archive_reason=" + AuthUtilities.text(stored) + ",is_template=0,is_public=0,updated_at=UTC_TIMESTAMP(6)"
            let changed = tx.execute("UPDATE generated_learning_resources" + changes + condition)
            let ppt = changed != 1
            if (ppt && tx.execute("UPDATE presentation_tasks" + changes + condition) != 1) { throw AdminResourceCatalogService.missing() }
            event(tx, admin, requested, ppt, "ARCHIVE", None, None, reason)
        })
    }
    public func candidate(admin: User, requested: String): String {
        let condition = filter(admin, requested) + " AND archived_at IS NOT NULL"
        let next = AuthUtilities.uuid()
        return DbTransaction.run<String>(database, { tx =>
            let ids = AuthUtilities.uuidSql(next) + "," + AuthUtilities.uuidSql(admin.getId())
            let changed = tx.execute("INSERT INTO generated_learning_resources(id,user_id,organization_id,domain_code,category_node_code,resource_scope,review_status,base_resource_id,revision,resource_type,title,topic,learning_goal_id,course_id,chapter_id,content_json,sources_json,state_json,context_json,decision_json,created_at,updated_at,learner_id,kp_id,form,level,version,quiz_ids_json,kb_refs_json,is_public) SELECT " + ids + ",organization_id,domain_code,category_node_code,'ORGANIZATION','DRAFT',id,1,resource_type,title,topic,NULL,NULL,NULL,content_json,sources_json,JSON_OBJECT(),context_json,decision_json,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),NULL,kp_id,form,level,version,quiz_ids_json,kb_refs_json,0 FROM generated_learning_resources" + condition)
            let ppt = changed != 1
            if (ppt) {
                let copied = tx.execute("INSERT INTO presentation_tasks(id,user_id,organization_id,domain_code,category_node_code,resource_scope,review_status,base_presentation_id,revision,title,status,progress,stage_message,request_json,outline_json,events_json,learned_json,output_path,error_message,created_at,updated_at,is_public) SELECT " + ids + ",organization_id,domain_code,category_node_code,'ORGANIZATION','DRAFT',id,1,title,status,progress,stage_message,request_json,outline_json,events_json,JSON_OBJECT(),output_path,error_message,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),0 FROM presentation_tasks" + condition)
                if (copied != 1) { throw AdminResourceCatalogService.missing() }
            }
            event(tx, admin, next, ppt, "CREATE_CANDIDATE", None, Some("DRAFT"), Some(if (ppt) { "由历史交互课件复制" } else { "由历史资源复制，不改变原资源" }))
            return next
        })
    }
    public func deletePermanently(admin: User, requested: String): Unit {
        let condition = filter(admin, requested) + " AND archived_at IS NOT NULL"
        let resourceDeleted = DbTransaction.run<Bool>(database, { tx =>
            let rows = tx.query("SELECT LOWER(BIN_TO_UUID(id)) FROM generated_learning_resources" + condition + " FOR UPDATE")
            if (rows.isEmpty()) { return false }
            tx.execute("DELETE FROM learning_resource_review_events WHERE resource_id=" + AuthUtilities.uuidSql(requested))
            tx.execute("DELETE FROM generated_learning_resources" + condition)
            return true
        })
        if (resourceDeleted) { return }
        let exists = DbTransaction.run<Bool>(database, { tx => !tx.query("SELECT LOWER(BIN_TO_UUID(id)) FROM presentation_tasks" + condition).isEmpty() })
        if (!exists) { throw AdminResourceCatalogService.missing() }
        agent.purge(admin, ProfileJson.uuid(requested))
    }
    public func purgeArchived(admin: User): Int64 {
        AccountAccessService.requireAdmin(admin)
        let condition = " WHERE organization_id=" + AuthUtilities.uuidSql(admin.getOrganizationId().getOrThrow()) + " AND archived_at IS NOT NULL"
        let ppts = DbTransaction.run<Array<Array<Option<String>>>>(database, { tx => tx.query("SELECT LOWER(BIN_TO_UUID(id)) FROM presentation_tasks" + condition) })
        for (row in ppts) {
            try { agent.purge(admin, row[0].getOrThrow()) }
            catch (_: Exception) { println("Archived PPT Agent cleanup unavailable; using legacy database fallback") }
        }
        return DbTransaction.run<Int64>(database, { tx =>
            tx.execute("DELETE FROM learning_resource_review_events WHERE resource_id IN (SELECT id FROM generated_learning_resources" + condition + ")")
            let resources = tx.execute("DELETE FROM generated_learning_resources" + condition)
            tx.execute("DELETE FROM presentation_review_events WHERE presentation_id IN (SELECT id FROM presentation_tasks" + condition + ")")
            tx.execute("DELETE FROM presentation_task_user_state WHERE task_id IN (SELECT id FROM presentation_tasks" + condition + ")")
            tx.execute("DELETE FROM presentation_tasks" + condition)
            return resources + ppts.size
        })
    }
}
