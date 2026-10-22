package sqlite_driver

import std.collection.*
import std.database.sql.*

/*
 * std.database.sql 连接实现。每个连接持有一个 SqliteConn。
 */
public class SqliteConnection <: Connection {
    private let conn: SqliteConn
    private var currentState: ConnectionState = ConnectionState.Connecting
    private var activeTransaction: ?SqliteTransaction = None

    init(conn: SqliteConn) {
        this.conn = conn
        this.currentState = ConnectionState.Connected
    }

    public prop state: ConnectionState {
        get() {
            currentState
        }
    }

    public func createTransaction(): Transaction {
        requireOpen()
        if (activeTransaction.isSome()) {
            throw SqlException("sqlite: a transaction is already active on this connection")
        }
        let tx = SqliteTransaction(this)
        activeTransaction = Some(tx)
        tx
    }

    public func getMetaData(): Map<String, String> {
        requireOpen()
        let meta = HashMap<String, String>()
        meta["driver"] = "sqlite"
        meta["version"] = "0.1.0"
        meta["databaseProductName"] = "SQLite"
        meta["databaseProductVersion"] = "3"
        meta["url"] = conn.engine().path
        meta
    }

    public func prepareStatement(sql: String): Statement {
        requireOpen()
        SqliteStatement(this, sql)
    }

    public func close(): Unit {
        if (currentState == ConnectionState.Closed) {
            return
        }
        match (activeTransaction) {
            case Some(tx) => tx.forceAbort()
            case None => ()
        }
        conn.close()
        currentState = ConnectionState.Closed
    }

    public func isClosed(): Bool {
        currentState == ConnectionState.Closed
    }

    func rawConn(): SqliteConn {
        conn
    }

    func requireOpen(): Unit {
        if (currentState == ConnectionState.Closed) {
            throw SqliteRuntimeException("connection", "connection is closed")
        }
    }

    func clearTransaction(tx: SqliteTransaction): Unit {
        match (activeTransaction) {
            case Some(current) where refEq(current, tx) => activeTransaction = None
            case _ => ()
        }
    }
}
