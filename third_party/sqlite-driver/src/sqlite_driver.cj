package sqlite_driver

import std.database.sql.*
import std.sync.*

/*
 * std.database.sql Driver 实现。
 *
 * SQLite 是进程内文件数据库, 不推荐池化; preferredPooling 固定为 false。
 */
public class SqliteDriver <: Driver {
    public prop name: String {
        get() {
            "sqlite"
        }
    }

    public prop version: String {
        get() {
            "0.1.0"
        }
    }

    public prop preferredPooling: Bool {
        get() {
            false
        }
    }

    public func open(connectionString: String, opts: Array<(String, String)>): Datasource {
        SqliteDatasource(connectionString, opts)
    }
}

private let driverRegistrationLock = Mutex()

/** 并发幂等地把 sqlite 驱动注册到 DriverManager。 */
public func registerSqliteDriver(): Unit {
    synchronized(driverRegistrationLock) {
        if (DriverManager.getDriver("sqlite").isNone()) {
            DriverManager.register("sqlite", SqliteDriver())
        }
    }
}
