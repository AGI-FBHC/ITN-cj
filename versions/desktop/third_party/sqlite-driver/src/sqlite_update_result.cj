package sqlite_driver

import std.database.sql.*

/** std.database.sql 更新结果。 */
public class SqliteUpdateResult <: UpdateResult {
    private let rowCountValue: Int64
    private let lastInsertIdValue: Int64

    public prop rowCount: Int64 {
        get() {
            rowCountValue
        }
    }

    public prop lastInsertId: Int64 {
        get() {
            lastInsertIdValue
        }
    }

    public init(rowCount: Int64, lastInsertId: Int64) {
        this.rowCountValue = rowCount
        this.lastInsertIdValue = lastInsertId
    }
}
