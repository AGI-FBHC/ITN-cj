package sqlite_driver

import std.collection.*
import std.database.sql.*

/*
 * std.database.sql 数据源。每次 connect() 都创建一条独立连接。
 */
public class SqliteDatasource <: Datasource {
    private let pathPart: String
    private let baseQuery: String
    private let extraOpts = ArrayList<(String, String)>()
    private var closed = false

    init(connectionString: String, opts: Array<(String, String)>) {
        let qmark = connectionString.indexOf("?")
        var path = connectionString
        var query = ""
        if (let Some(i) <- qmark) {
            path = connectionString[0..i]
            query = connectionString[(i + 1)..connectionString.size]
        }
        if (path.isEmpty()) {
            path = ":memory:"
        }
        this.pathPart = path
        this.baseQuery = query
        for (opt in opts) {
            extraOpts.add(opt)
        }
        // Driver.open 就要暴露非法选项，而不是拖到首次 connect()。
        let _ = parseSqliteDsn(buildConnectionString())
    }

    public func connect(): Connection {
        requireOpen()
        let dsn = parseSqliteDsn(buildConnectionString())
        SqliteConnection(openSqlite(dsn))
    }

    public func setOption(key: String, value: String): Unit {
        requireOpen()
        var found = false
        for (i in 0..extraOpts.size) {
            if (extraOpts[i][0] == key) {
                extraOpts[i] = (key, value)
                found = true
                break
            }
        }
        if (!found) {
            extraOpts.add((key, value))
        }
        // 立即验证, 让未知键在配置时暴露而不是拖到首次 connect()。
        let _ = parseSqliteDsn(buildConnectionString())
    }

    public func close(): Unit {
        closed = true
    }

    public func isClosed(): Bool {
        closed
    }

    private func requireOpen(): Unit {
        if (closed) {
            throw SqliteRuntimeException("datasource", "datasource is closed")
        }
    }

    private func buildConnectionString(): String {
        let sb = StringBuilder()
        sb.append(pathPart)
        var first = true
        if (!baseQuery.isEmpty()) {
            sb.append("?")
            sb.append(baseQuery)
            first = false
        }
        for ((key, value) in extraOpts) {
            sb.append(if (first) {
                "?"
            } else {
                "&"
            })
            sb.append(key)
            sb.append("=")
            sb.append(value)
            first = false
        }
        sb.toString()
    }
}
