package web.repository

import std.time.DateTime
import web.domain.*
import web.database.DbTransaction
import web.exception.*
import web.security.AuthUtilities
import web.security.HashingSupport

public class DemoOrganization {
    public let id: String
    public let code: String
    public let name: String
    public init(id: String, code: String, name: String) {
        this.id = id
        this.code = code
        this.name = name
    }
}

public class GuestDemoRepository {
    public init() {}
    public func guestOrganization(tx: DbTransaction): DemoOrganization {
        let rows = tx.query("SELECT LOWER(BIN_TO_UUID(id, 0)), code, name FROM organizations " +
            "WHERE code = " + AuthUtilities.text("cloudbrain-shanghai") + " COLLATE utf8mb4_unicode_ci LIMIT 1")
        if (rows.isEmpty()) { throw Exception("Required guest organization cloudbrain-shanghai is missing") }
        return organization(rows[0])
    }
    public func organizationForUser(tx: DbTransaction, user: User): Option<DemoOrganization> {
        if (let Some(id) <- user.getOrganizationId()) {
            let rows = tx.query("SELECT LOWER(BIN_TO_UUID(id, 0)), code, name FROM organizations WHERE id = " +
                AuthUtilities.uuidSql(id) + " LIMIT 1")
            if (!rows.isEmpty()) { return Some(organization(rows[0])) }
        }
        return None
    }
    private static func organization(row: Array<Option<String>>): DemoOrganization {
        return DemoOrganization(row[0].getOrThrow(), row[1].getOrThrow(), row[2].getOrThrow())
    }
    public func lockGuest(tx: DbTransaction, email: String): Unit {
        let lock = HashingSupport.sha256("guest-login:" + email)
        let rows = tx.query("SELECT GET_LOCK(" + AuthUtilities.text(lock) + ", 10)")
        if (rows[0][0].getOrThrow() != "1") { throw Exception("Guest login is busy; retry later") }
    }
    public func guestUser(tx: DbTransaction, preset: DemoPersona, org: DemoOrganization,
        passwordHash: () -> String): User {
        let rows = tx.query(userSelect() + " WHERE u.email = " + AuthUtilities.text(preset.email) +
            " COLLATE utf8mb4_unicode_ci LIMIT 1 FOR UPDATE")
        if (!rows.isEmpty()) {
            let user = UserRepository.fromRow(rows[0])
            if (user.getOrganizationId().isNone() || user.getOrganizationId().getOrThrow() != org.id) {
                tx.execute("UPDATE users SET organization_id = " + AuthUtilities.uuidSql(org.id) +
                    ", updated_at = UTC_TIMESTAMP(6) WHERE id = " + AuthUtilities.uuidSql(user.getId()))
                user.assignOrganization(Some(org.id))
            }
            return user
        }
        let id = AuthUtilities.uuid()
        let hash = passwordHash()
        let count = tx.execute("INSERT INTO users SET id = " + AuthUtilities.uuidSql(id) +
            ", email = " + AuthUtilities.text(preset.email) + ", password_hash = " + AuthUtilities.text(hash) +
            ", nickname = " + AuthUtilities.text(preset.name) + ", active = 1, account_type = 'LEARNER', " +
            "organization_id = " + AuthUtilities.uuidSql(org.id) +
            ", created_at = UTC_TIMESTAMP(6), updated_at = UTC_TIMESTAMP(6)")
        if (count != 1) { throw Exception("Guest account was not saved") }
        let now = DateTime.nowUTC().toString()
        return User(id, preset.email, hash, Some(preset.name), true, AccountType.LEARNER,
            Some(org.id), None, now, now)
    }
    public func guestLearner(tx: DbTransaction, user: User, preset: DemoPersona): String {
        let rows = tx.query("SELECT LOWER(BIN_TO_UUID(id, 0)) FROM learners WHERE user_id = " +
            AuthUtilities.uuidSql(user.getId()) + " AND code = 'default' COLLATE utf8mb4_unicode_ci LIMIT 1 FOR UPDATE")
        let fields = "name = " + AuthUtilities.text(preset.name) + ", avatar = " + AuthUtilities.text(preset.avatar) +
            ", role = " + AuthUtilities.text(preset.role) + ", education = " + AuthUtilities.text(preset.education) +
            ", target_job = " + AuthUtilities.text(preset.targetJob) + ", weekly_hours = ${preset.weeklyHours}" +
            ", learning_style_json = " + AuthUtilities.text(preset.learningStyles) +
            ", scores_json = " + AuthUtilities.text(preset.scores) + ", goal = " + AuthUtilities.text(preset.goal) +
            ", blind_spots_json = " + AuthUtilities.text(preset.blindSpots) +
            ", preferred_format = " + AuthUtilities.text("按画像自适应") +
            ", diagnosis_summary = " + AuthUtilities.text(preset.diagnosis) +
            ", confidence_method = 'preset', confidence_value = 85, updated_at = UTC_TIMESTAMP(6)"
        if (!rows.isEmpty()) {
            let id = rows[0][0].getOrThrow()
            tx.execute("UPDATE learners SET " + fields + " WHERE id = " + AuthUtilities.uuidSql(id))
            return id
        }
        let id = AuthUtilities.uuid()
        let count = tx.execute("INSERT INTO learners SET id = " + AuthUtilities.uuidSql(id) +
            ", user_id = " + AuthUtilities.uuidSql(user.getId()) + ", code = 'default', status = 1, " +
            "created_at = UTC_TIMESTAMP(6), " + fields)
        if (count != 1) { throw Exception("Guest learner was not saved") }
        return id
    }
    public func demoUser(tx: DbTransaction, learnerCode: String): User {
        let identities = tx.query("SELECT LOWER(BIN_TO_UUID(user_id, 0)) FROM user_identities WHERE " +
            "identity_type = 'DEMO' AND identity_value = " + AuthUtilities.text(learnerCode) +
            " COLLATE utf8mb4_unicode_ci LIMIT 1")
        if (identities.isEmpty()) { throw BusinessException(ErrorCode.LEARNER_NOT_FOUND, 404, "演示画像不存在") }
        let rows = tx.query(userSelect() + " WHERE u.id = " +
            AuthUtilities.uuidSql(identities[0][0].getOrThrow()) + " LIMIT 1 FOR UPDATE")
        if (rows.isEmpty()) { throw BusinessException(ErrorCode.LEARNER_NOT_FOUND, 404, "演示画像不存在") }
        return UserRepository.fromRow(rows[0])
    }
    private static func userSelect(): String {
        return "SELECT LOWER(BIN_TO_UUID(u.id, 0)), u.email, u.password_hash, u.nickname, " +
            "u.active, u.account_type, LOWER(BIN_TO_UUID(u.organization_id, 0)), u.admin_scope, " +
            "DATE_FORMAT(u.created_at, '%Y-%m-%dT%H:%i:%s.%fZ'), " +
            "DATE_FORMAT(u.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') FROM users u"
    }
}
