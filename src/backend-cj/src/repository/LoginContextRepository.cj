package web.repository
import stdx.encoding.hex.toHexString
import web.config.DatabaseConfig
import web.database.MySqlConnection
import web.domain.User
public class LoginContext {
    public let learnerId: Option<String>
    public let organizationCode: Option<String>
    public let organizationName: Option<String>
    public init(learnerId: Option<String>, organizationCode: Option<String>,
        organizationName: Option<String>) {
        this.learnerId = learnerId
        this.organizationCode = organizationCode
        this.organizationName = organizationName
    }
}
// Reads the learner/organization fields used by the legacy LoginResponse.
public class LoginContextRepository {
    private let config: DatabaseConfig
    public init(config: DatabaseConfig) {
        this.config = config
    }
    public func load(user: User): LoginContext {
        let learners = MySqlConnection.query(config,
            "SELECT LOWER(BIN_TO_UUID(id, 0)) FROM learners WHERE user_id = " +
            uuidLiteral(user.getId()) + " ORDER BY created_at ASC LIMIT 1")
        var learnerId: Option<String> = None
        if (!learners.isEmpty()) {
            if (learners[0].size != 1 || learners[0][0].isNone()) {
                throw Exception("Unexpected learner id result")
            }
            learnerId = learners[0][0]
        }
        var organizationCode: Option<String> = None
        var organizationName: Option<String> = None
        match (user.getOrganizationId()) {
            case None => ()
            case Some(id) =>
                let organizations = MySqlConnection.query(config,
                    "SELECT code, name FROM organizations WHERE id = " +
                    uuidLiteral(id) + " LIMIT 1")
                if (!organizations.isEmpty()) {
                    let row = organizations[0]
                    if (row.size != 2 || row[0].isNone() || row[1].isNone()) {
                        throw Exception("Unexpected organization result")
                    }
                    organizationCode = row[0]
                    organizationName = row[1]
                }
        }
        return LoginContext(learnerId, organizationCode, organizationName)
    }
    private static func uuidLiteral(value: String): String {
        let hex = toHexString(value.toArray())
        return "UUID_TO_BIN(CONVERT(X'${hex}' USING utf8mb4), 0)"
    }
}
