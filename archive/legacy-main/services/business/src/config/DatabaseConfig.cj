package web.config
import std.env.getVariables
import std.convert.*
public class DatabaseConfig {
    public let host: String
    public let port: UInt16
    public let database: String
    public let username: String
    private let password: String
    public init(host: String, port: UInt16, database: String, username: String, password: String) {
        if (host.isEmpty() || database.isEmpty() || username.isEmpty()) {
            throw IllegalArgumentException("DB_HOST, DB_NAME and DB_USER must not be empty")
        }
        if (port == 0) {
            throw IllegalArgumentException("DB_PORT must be between 1 and 65535")
        }
        if (password.isEmpty()) {
            throw IllegalArgumentException("DB_PASSWORD is required")
        }
        this.host = host
        this.port = port
        this.database = database
        this.username = username
        this.password = password
    }
    public func getPassword(): String {
        return password
    }
    public static func fromEnvironment(): DatabaseConfig {
        var host = "127.0.0.1"
        var portText = "3306"
        var database = "itn_platform_local"
        var username = "itn_cj"
        var password = ""
        for ((key, value) in getVariables()) {
            match (key) {
                case "DB_HOST" => host = value
                case "DB_PORT" => portText = value
                case "DB_NAME" => database = value
                case "DB_USER" => username = value
                case "DB_PASSWORD" => password = value
                case _ => ()
            }
        }
        let port = UInt16.parse(portText)
        return DatabaseConfig(host, port, database, username, password)
    }
}
