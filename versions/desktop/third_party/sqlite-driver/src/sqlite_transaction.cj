package sqlite_driver

import std.database.sql.*

/*
 * std.database.sql 事务实现。
 *
 * begin() 使用 BEGIN IMMEDIATE, 把写锁竞争提前到事务开始, 与底层 SqliteConn 的语义一致。
 * SQLite 不提供通用的隔离级别选择，因此只接受驱动能够表达的事务属性。
 */
public class SqliteTransaction <: Transaction {
    private let conn: SqliteConnection
    private var active = false
    private var done = false
    private var access: TransactionAccessMode = TransactionAccessMode.Unspecified
    private var deferrable: TransactionDeferrableMode = TransactionDeferrableMode.Unspecified
    private var iso: TransactionIsoLevel = TransactionIsoLevel.Unspecified

    init(conn: SqliteConnection) {
        this.conn = conn
    }

    public mut prop accessMode: TransactionAccessMode {
        get() {
            access
        }
        set(v) {
            access = v
        }
    }

    public mut prop deferrableMode: TransactionDeferrableMode {
        get() {
            deferrable
        }
        set(v) {
            deferrable = v
        }
    }

    public mut prop isoLevel: TransactionIsoLevel {
        get() {
            iso
        }
        set(v) {
            iso = v
        }
    }

    public func begin(): Unit {
        conn.requireOpen()
        if (done) {
            throw SqliteRuntimeException("transaction", "transaction has already completed")
        }
        if (active) {
            throw SqliteRuntimeException("transaction", "transaction is already active")
        }
        validateModes()
        let _ = conn.rawConn().execString("BEGIN IMMEDIATE")
        active = true
    }

    public func commit(): Unit {
        requireActive()
        let _ = conn.rawConn().execString("COMMIT")
        active = false
        done = true
        conn.clearTransaction(this)
    }

    public func rollback(): Unit {
        requireActive()
        let _ = conn.rawConn().execString("ROLLBACK")
        active = false
        done = true
        conn.clearTransaction(this)
    }

    public func save(savePointName: String): Unit {
        requireActive()
        let _ = conn.rawConn().execString("SAVEPOINT ${quoteIdentifier(savePointName)}")
    }

    public func rollback(savePointName: String): Unit {
        requireActive()
        let _ = conn.rawConn().execString("ROLLBACK TO SAVEPOINT ${quoteIdentifier(savePointName)}")
    }

    public func release(savePointName: String): Unit {
        requireActive()
        let _ = conn.rawConn().execString("RELEASE SAVEPOINT ${quoteIdentifier(savePointName)}")
    }

    private func requireActive(): Unit {
        conn.requireOpen()
        if (!active) {
            throw SqliteRuntimeException("transaction", "no active transaction")
        }
    }

    func forceAbort(): Unit {
        if (!done) {
            active = false
            done = true
            conn.clearTransaction(this)
        }
    }

    private func validateModes(): Unit {
        if (access != TransactionAccessMode.ReadWrite && access != TransactionAccessMode.Unspecified) {
            throw SqliteRuntimeException("transaction", "SQLite BEGIN IMMEDIATE only supports read-write access mode")
        }
        if (deferrable != TransactionDeferrableMode.NotDeferrable && deferrable != TransactionDeferrableMode.Unspecified) {
            throw SqliteRuntimeException("transaction",
                "SQLite BEGIN IMMEDIATE does not support deferrable transactions")
        }
        if (iso != TransactionIsoLevel.Serializable && iso != TransactionIsoLevel.Unspecified) {
            throw SqliteRuntimeException("transaction", "SQLite only exposes serializable write transactions here")
        }
    }
}
