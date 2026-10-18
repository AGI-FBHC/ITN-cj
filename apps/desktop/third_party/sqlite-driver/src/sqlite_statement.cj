package sqlite_driver

import std.convert.*
import std.database.sql.ColumnInfo as StdColumnInfo
import std.database.sql.QueryResult
import std.database.sql.SqlDbType
import std.database.sql.Statement
import std.database.sql.UpdateResult

/*
 * std.database.sql 预执行语句。参数采用 0 基索引。
 */
public class SqliteStatement <: Statement {
    private let conn: SqliteConnection
    private let sql: String
    private let stmt: Stmt
    private let paramCount: Int64
    private let values: Array<SqliteValue>
    private let infos: Array<StdColumnInfo>
    private let control = StatementControl()
    private var closed = false

    init(conn: SqliteConnection, sql: String) {
        this.conn = conn
        this.sql = sql
        // 构造时只解析一次：参数占位符数量来自 parser，语法错误也在此处暴露。
        let parser = Parser(sql)
        this.stmt = parser.parseStatement()
        this.paramCount = parser.parameterCount
        this.values = Array<SqliteValue>(paramCount, repeat: SqliteValue.SNull)
        this.infos = Array<StdColumnInfo>(paramCount, repeat: SqliteColumnInfo("", "NULL", 0, 0, true, 0))
    }

    public prop parameterColumnInfos: Array<StdColumnInfo> {
        get() {
            infos
        }
    }

    public func set<T>(index: Int64, value: T): Unit {
        requireOpen()
        checkIndex(index)
        values[index] = coerceToSqliteValue(value)
    }

    public func setNull(index: Int64): Unit {
        requireOpen()
        checkIndex(index)
        values[index] = SqliteValue.SNull
    }

    public func setOption(key: String, value: String): Unit {
        requireOpen()
        if (key.toAsciiLower() != "timeout_ms") {
            throw SqliteRuntimeException("statement", "unsupported statement option '${key}'")
        }
        let timeout = try {
            Int64.parse(value)
        } catch (_: Exception) {
            throw SqliteRuntimeException("statement", "timeout_ms must be a non-negative integer")
        }
        control.setTimeoutMs(timeout)
    }

    /** 取消当前正在执行的 query()/update()；没有活动执行时不影响下一次调用。 */
    public func cancel(): Unit {
        requireOpen()
        control.cancel()
    }

    public func query(): QueryResult {
        requireOpen()
        conn.requireOpen()
        SqliteQueryResult(conn.rawConn().queryPrepared(stmt, values, control))
    }

    @Deprecated["Use query() with set<T>()/setNull() instead.", since: "0.1.0"]
    public func query(params: Array<SqlDbType>): QueryResult {
        requireOpen()
        bindLegacy(params)
        query()
    }

    public func update(): UpdateResult {
        requireOpen()
        conn.requireOpen()
        let raw = conn.rawConn()
        let affected = raw.execPrepared(stmt, values, control)
        SqliteUpdateResult(affected, raw.lastInsertRowid)
    }

    @Deprecated["Use update() with set<T>()/setNull() instead.", since: "0.1.0"]
    public func update(params: Array<SqlDbType>): UpdateResult {
        requireOpen()
        bindLegacy(params)
        update()
    }

    public func close(): Unit {
        closed = true
    }

    public func isClosed(): Bool {
        closed
    }

    private func bindLegacy(params: Array<SqlDbType>): Unit {
        if (params.size != paramCount) {
            throw SqliteRuntimeException("bind",
                "statement requires ${paramCount} parameter(s) but ${params.size} were supplied")
        }
        for (i in 0..params.size) {
            values[i] = sqlDbTypeToSqliteValue(params[i])
        }
    }

    private func checkIndex(index: Int64): Unit {
        if (index < 0 || index >= paramCount) {
            throw SqliteRuntimeException("bind", "parameter index ${index} is out of range 0..${paramCount - 1}")
        }
    }

    private func requireOpen(): Unit {
        if (closed) {
            throw SqliteRuntimeException("statement", "statement is closed")
        }
    }
}
