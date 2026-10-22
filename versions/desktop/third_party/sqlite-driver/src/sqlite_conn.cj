package sqlite_driver

import std.collection.*
import std.sync.*

/*
 * 纯驱动连接: 引擎的薄封装, 用 SqliteValue 收发。
 *
 * 每个连接一把锁。SQLite 是单写者, 但同一个 SqliteConn 被多个线程用时, 引擎的页缓存与
 * 事务状态都不是线程安全的 —— 没有锁会让两个线程的 B-tree 写交错, 产出结构损坏的库。
 */
public class SqliteConn {
    private let db: SqliteDatabase
    private let lock = Mutex()
    private var closed = false

    init(db: SqliteDatabase) {
        this.db = db
    }

    /** 执行一条语句, 返回受影响行数。SELECT 走这里会丢结果, 用 query。 */
    public func exec(sql: String, params: Array<SqliteValue>): Int64 {
        synchronized(lock) {
            requireOpen("exec")
            executeSql(db, sql, params).changes
        }
    }

    /** 执行已经解析好的 AST，避免每次绑定后重复词法与语法分析。 */
    func execPrepared(stmt: Stmt, params: Array<SqliteValue>, control: StatementControl): Int64 {
        synchronized(lock) {
            requireOpen("exec")
            executeControlledStatement(db, stmt, params, control).changes
        }
    }

    /** 无参语句。 */
    public func execString(sql: String): Int64 {
        exec(sql, Array<SqliteValue>())
    }

    /** 执行查询, 返回结果集。 */
    public func query(sql: String, params: Array<SqliteValue>): SqliteResultSet {
        synchronized(lock) {
            requireOpen("query")
            let result = executeSql(db, sql, params)
            match (result.rows) {
                case Some(rs) => SqliteResultSet(rs.columnNames, rs.rows)
                // 非查询语句返回空结果集而不是报错: `query("PRAGMA x = 1")` 这类用法很常见。
                case None => SqliteResultSet(Array<String>(), ArrayList<Array<SqliteValue>>())
            }
        }
    }

    /** 查询已经解析好的 AST。执行上下文仍按次创建，AST 本身只读复用。 */
    func queryPrepared(stmt: Stmt, params: Array<SqliteValue>, control: StatementControl): SqliteResultSet {
        synchronized(lock) {
            requireOpen("query")
            let result = executeControlledStatement(db, stmt, params, control)
            match (result.rows) {
                case Some(rs) => SqliteResultSet(rs.columnNames, rs.rows)
                case None => SqliteResultSet(Array<String>(), ArrayList<Array<SqliteValue>>())
            }
        }
    }

    public func queryString(sql: String): SqliteResultSet {
        query(sql, Array<SqliteValue>())
    }

    /** 最近一次 INSERT 分配的 rowid。 */
    public prop lastInsertRowid: Int64 {
        get() {
            synchronized(lock) {
                db.lastInsertRowid
            }
        }
    }

    /** 最近一条 DML 的受影响行数。 */
    public prop changes: Int64 {
        get() {
            synchronized(lock) {
                db.lastChanges
            }
        }
    }

    public prop totalChanges: Int64 {
        get() {
            synchronized(lock) {
                db.totalChanges
            }
        }
    }

    public prop inTransaction: Bool {
        get() {
            synchronized(lock) {
                db.inTransaction
            }
        }
    }

    public prop isAlive: Bool {
        get() {
            synchronized(lock) {
                !closed
            }
        }
    }

    /**
     * 关闭连接。
     *
     * 未提交的事务回滚而不是提交: 关闭不是"确认写入"的信号。
     */
    public func close(): Unit {
        synchronized(lock) {
            if (closed) {
                return
            }
            if (db.inTransaction) {
                try {
                    db.rollback()
                } catch (_: Exception) {
                    ()
                }
            }
            db.close()
            closed = true
        }
    }

    /** 供包内路径直接拿引擎, 避免二次加锁。 */
    func engine(): SqliteDatabase {
        db
    }

    func requireOpen(operation: String): Unit {
        if (closed) {
            throw SqliteRuntimeException(operation, "connection is closed")
        }
    }
}

/** 打开一条连接。 */
public func openSqlite(dsn: SqliteDSN): SqliteConn {
    let path = if (dsn.isMemory) {
        ":memory:"
    } else {
        dsn.path
    }
    let db = openDatabase(path, dsn.pageSize, dsn.syncMode, dsn.busyTimeoutMs)
    // 内存后端没有打开期锁，也要保留连接级 busy_timeout 配置。
    db.busyTimeoutMs = dsn.busyTimeoutMs
    db.foreignKeysEnabled = dsn.foreignKeys
    SqliteConn(db)
}
