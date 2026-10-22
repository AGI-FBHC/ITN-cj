package sqlite_driver

import std.collection.*

/*
 * 查询结果。列名 + 行, 行内值按列序。
 *
 * 这是纯驱动门面的内部数据容器。需要标准 std.database.sql 结果集时,
 * 请使用 SqliteStatement.query() 返回的 SqliteQueryResult。
 */
public class SqliteResultSet {
    public let columnNames: Array<String>
    public let rows: ArrayList<Array<SqliteValue>>

    init(columnNames: Array<String>, rows: ArrayList<Array<SqliteValue>>) {
        this.columnNames = columnNames
        this.rows = rows
    }

    public prop rowCount: Int64 {
        get() {
            rows.size
        }
    }

    /** 列名对应的下标; 找不到返回 -1。大小写不敏感, 与 SQL 的列名规则一致。 */
    public func columnIndexOf(name: String): Int64 {
        let lower = name.toAsciiLower()
        for (i in 0..columnNames.size) {
            if (columnNames[i].toAsciiLower() == lower) {
                return i
            }
        }
        -1
    }

    /** 按列名取值。列不存在时抛 —— 返回 NULL 会与"该列确实是 NULL"混淆。 */
    public func value(row: Int64, columnName: String): SqliteValue {
        let idx = columnIndexOf(columnName)
        if (idx < 0) {
            throw SqliteRuntimeException("result", "no such column in result set: ${columnName}")
        }
        if (row < 0 || row >= rows.size) {
            throw SqliteRuntimeException("result", "row index ${row} is out of range 0..${rows.size - 1}")
        }
        rows[row][idx]
    }
}
