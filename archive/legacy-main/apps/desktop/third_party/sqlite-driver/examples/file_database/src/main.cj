package sqlite_driver_file_database

import sqlite_driver.*

main(args: Array<String>): Int64 {
    if (args.size != 1) {
        eprintln("usage: sqlite_driver_file_database <database-path>")
        return 2
    }
    try {
        let checks = Checks()
        createDatabase(checks, args[0])
        reopenDatabase(checks, args[0])
        println("PASS: file database example (${checks.count} checks)")
        return 0
    } catch (e: Exception) {
        eprintln("FAIL: ${e.message}")
        return 1
    }
}

func createDatabase(checks: Checks, path: String): Unit {
    let dsn = parseSqliteDsn("${path}?page_size=8192&sync=normal&busy_timeout=1200&foreign_keys=on")
    checks.expect("file DSN", !dsn.isMemory)
    checks.expect("page size DSN", dsn.pageSize == 8192)
    checks.expect("busy timeout DSN", dsn.busyTimeoutMs == 1200)
    checks.expect("foreign key DSN", dsn.foreignKeys)
    match (dsn.syncMode) {
        case SqliteSyncMode.SyncNormal => checks.expect("sync mode DSN", true)
        case _ => checks.expect("sync mode DSN", false)
    }

    let connection = openSqlite(dsn)
    try {
        checks.expect("connection alive", connection.isAlive)
        checks.expect("page size", scalarInt(connection, "PRAGMA page_size") == 8192)
        checks.expect("busy timeout", scalarInt(connection, "PRAGMA busy_timeout") == 1200)
        checks.expect("foreign keys", scalarInt(connection, "PRAGMA foreign_keys") == 1)

        connection.execString("PRAGMA user_version=7")
        connection.execString("PRAGMA application_id=4242")
        connection.execString("PRAGMA cache_size=-800")
        checks.expect("user version", scalarInt(connection, "PRAGMA user_version") == 7)
        checks.expect("application id", scalarInt(connection, "PRAGMA application_id") == 4242)
        checks.expect("cache size", scalarInt(connection, "PRAGMA cache_size") == -800)

        connection.execString("CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT)")
        connection.execString(
            "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INT, value TEXT, " +
                "FOREIGN KEY(parent_id) REFERENCES parent(id))")
        connection.execString("INSERT INTO parent VALUES (1, 'root')")
        connection.execString("INSERT INTO child VALUES (1, 1, 'persisted')")

        checks.expect("last insert rowid", connection.lastInsertRowid == 1)
        checks.expect("last changes", connection.changes == 1)
        checks.expect("total changes", connection.totalChanges == 2)
        let boundRows = connection.query("SELECT id AS child_id, value FROM child WHERE id=?", [SInt(1)])
        checks.expect("bound native query", boundRows.rowCount == 1)
        checks.expect("native column lookup", boundRows.columnIndexOf("CHILD_ID") == 0)
        checks.expect("native named value", textAt(boundRows, 0, boundRows.columnIndexOf("value")) == "persisted")

        var foreignKeyCaught = false
        try {
            connection.execString("INSERT INTO child VALUES (2, 99, 'invalid')")
        } catch (_: SqliteConstraintException) {
            foreignKeyCaught = true
        }
        checks.expect("foreign key enforcement", foreignKeyCaught)

        checks.expect("WAL mode", scalarText(connection, "PRAGMA journal_mode=WAL") == "wal")
        connection.execString("PRAGMA wal_autocheckpoint=4")
        connection.execString("PRAGMA journal_size_limit=16384")
        checks.expect("WAL autocheckpoint", scalarInt(connection, "PRAGMA wal_autocheckpoint") == 4)
        checks.expect("journal size limit", scalarInt(connection, "PRAGMA journal_size_limit") == 16384)

        connection.execString("BEGIN")
        connection.execString("CREATE TABLE large_record (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
        for (id in 2..42) {
            connection.exec("INSERT INTO child(id, parent_id, value) VALUES (?, ?, ?)",
                [SInt(id), SInt(1), SText("value-${id}")])
        }
        for (id in 1..17) {
            connection.exec("INSERT INTO large_record VALUES (?, ?)", [SInt(id), SText(largePayload(id))])
        }
        connection.execString("SAVEPOINT partial")
        connection.execString("INSERT INTO child VALUES (99, 1, 'rolled back')")
        connection.execString("ROLLBACK TO partial")
        connection.execString("RELEASE partial")
        connection.execString("COMMIT")
        checks.expect("transaction state", !connection.inTransaction)
        checks.expect("persisted row count", scalarInt(connection, "SELECT count(*) FROM child") == 41)
        checks.expect("rolled-back savepoint", scalarInt(connection, "SELECT count(*) FROM child WHERE id=99") == 0)
        checks.expect("large records persisted", scalarInt(connection, "SELECT count(*) FROM large_record") == 16)
        checks.expect("overflow payload round trip",
            scalarText(connection, "SELECT payload FROM large_record WHERE id=16") == largePayload(16))
        checks.expect("overflow payload length",
            scalarInt(connection, "SELECT min(length(payload)) FROM large_record") > 16000)

        let pageCountBeforeReuse = scalarInt(connection, "PRAGMA page_count")
        connection.execString("DELETE FROM large_record WHERE id % 2 = 0")
        let freePagesAfterDelete = scalarInt(connection, "PRAGMA freelist_count")
        checks.expect("large record deletion frees pages", freePagesAfterDelete > 0)
        for (id in 101..109) {
            connection.exec("INSERT INTO large_record VALUES (?, ?)", [SInt(id), SText(largePayload(id))])
        }
        checks.expect("large record replacement count", scalarInt(connection, "SELECT count(*) FROM large_record") == 16)
        checks.expect("freelist pages are reused", scalarInt(connection, "PRAGMA page_count") <= pageCountBeforeReuse + 2)
        checks.expect("integrity check", scalarText(connection, "PRAGMA integrity_check") == "ok")

        let checkpoint = connection.queryString("PRAGMA wal_checkpoint(TRUNCATE)")
        checks.expect("WAL checkpoint result", checkpoint.rowCount == 1 && checkpoint.rows[0].size == 3)
        checks.expect("rollback journal mode", scalarText(connection, "PRAGMA journal_mode=DELETE") == "delete")
    } finally {
        connection.close()
    }
    checks.expect("connection closed", !connection.isAlive)
}

func reopenDatabase(checks: Checks, path: String): Unit {
    let connection = openSqlite(parseSqliteDsn("${path}?foreign_keys=on&busy_timeout=1200"))
    try {
        checks.expect("reopened row count", scalarInt(connection, "SELECT count(*) FROM child") == 41)
        checks.expect("reopened value", scalarText(connection, "SELECT value FROM child WHERE id=1") == "persisted")
        checks.expect("reopened user version", scalarInt(connection, "PRAGMA user_version") == 7)
        checks.expect("reopened application id", scalarInt(connection, "PRAGMA application_id") == 4242)
        checks.expect("foreign key check", connection.queryString("PRAGMA foreign_key_check").rowCount == 0)
        checks.expect("reopened large records", scalarInt(connection, "SELECT count(*) FROM large_record") == 16)
        checks.expect("reopened overflow payload",
            scalarText(connection, "SELECT payload FROM large_record WHERE id=101") == largePayload(101))
        connection.execString("DELETE FROM child WHERE id > 20")
        connection.execString("DELETE FROM large_record WHERE id <> 1")
        let pageCountBeforeVacuum = scalarInt(connection, "PRAGMA page_count")
        checks.expect("deleted overflow pages enter freelist", scalarInt(connection, "PRAGMA freelist_count") > 0)
        connection.execString("VACUUM")
        checks.expect("VACUUM keeps data", scalarInt(connection, "SELECT count(*) FROM child") == 20)
        checks.expect("VACUUM keeps remaining overflow record",
            scalarText(connection, "SELECT payload FROM large_record WHERE id=1") == largePayload(1))
        checks.expect("VACUUM reclaims free pages", scalarInt(connection, "PRAGMA page_count") < pageCountBeforeVacuum)
        checks.expect("integrity after VACUUM", scalarText(connection, "PRAGMA quick_check") == "ok")
        let databases = connection.queryString("PRAGMA database_list")
        checks.expect("database list", databases.rowCount == 1 && textAt(databases, 0, 1) == "main")
    } finally {
        connection.close()
    }
}

func largePayload(id: Int64): String {
    let output = StringBuilder("record-${id}|")
    for (_ in 0..1024) {
        output.append("0123456789abcdef")
    }
    output.append("|${id}")
    output.toString()
}

func scalarInt(connection: SqliteConn, sql: String): Int64 {
    match (connection.queryString(sql).rows[0][0]) {
        case SInt(value) => value
        case value => throw Exception("expected integer from '${sql}', got ${value}")
    }
}

func scalarText(connection: SqliteConn, sql: String): String {
    match (connection.queryString(sql).rows[0][0]) {
        case SText(value) => value
        case value => throw Exception("expected text from '${sql}', got ${value}")
    }
}

func textAt(rows: SqliteResultSet, row: Int64, column: Int64): String {
    match (rows.rows[row][column]) {
        case SText(value) => value
        case value => throw Exception("expected text, got ${value}")
    }
}

class Checks {
    private var passed: Int64 = 0

    prop count: Int64 {
        get() {
            passed
        }
    }

    func expect(label: String, condition: Bool): Unit {
        if (!condition) {
            throw Exception("check failed: ${label}")
        }
        passed += 1
        println("PASS: ${label}")
    }
}
