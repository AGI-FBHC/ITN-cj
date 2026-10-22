package sqlite_driver_concurrency

import std.database.sql.*
import std.sync.*

import sqlite_driver.*

main(args: Array<String>): Int64 {
    if (args.size != 1) {
        eprintln("usage: sqlite_driver_concurrency <database-path>")
        return 2
    }
    try {
        let checks = Checks()
        checkWalSnapshotsAndWriteContention(checks, args[0])
        checkStatementCancellation(checks)
        println("PASS: concurrency example (${checks.count} checks)")
        return 0
    } catch (e: Exception) {
        eprintln("FAIL: ${e.message}")
        return 1
    }
}

func checkWalSnapshotsAndWriteContention(checks: Checks, path: String): Unit {
    let setup = openSqlite(SqliteDSN(path: path))
    try {
        checks.expect("WAL mode enabled", scalarText(setup, "PRAGMA journal_mode=WAL") == "wal")
        setup.execString("CREATE TABLE shared_value (id INTEGER PRIMARY KEY, value TEXT)")
        setup.execString("INSERT INTO shared_value VALUES (1, 'original')")
    } finally {
        setup.close()
    }

    let reader = openSqlite(SqliteDSN(path: path))
    let writer = openSqlite(SqliteDSN(path: path))
    let contender = openSqlite(SqliteDSN(path: path, busyTimeoutMs: 25))
    try {
        reader.execString("BEGIN")
        checks.expect("reader sees initial value",
            scalarText(reader, "SELECT value FROM shared_value WHERE id=1") == "original")

        writer.execString("UPDATE shared_value SET value='committed' WHERE id=1")
        checks.expect("writer sees committed value",
            scalarText(writer, "SELECT value FROM shared_value WHERE id=1") == "committed")
        checks.expect("reader keeps WAL snapshot",
            scalarText(reader, "SELECT value FROM shared_value WHERE id=1") == "original")

        reader.execString("COMMIT")
        checks.expect("reader refreshes after commit",
            scalarText(reader, "SELECT value FROM shared_value WHERE id=1") == "committed")

        writer.execString("BEGIN IMMEDIATE")
        writer.execString("UPDATE shared_value SET value='uncommitted' WHERE id=1")
        var busyCaught = false
        try {
            contender.execString("UPDATE shared_value SET value='blocked' WHERE id=1")
        } catch (_: SqliteBusyException) {
            busyCaught = true
        }
        checks.expect("busy timeout reports write contention", busyCaught)
        writer.execString("ROLLBACK")
        checks.expect("rollback preserves committed value",
            scalarText(contender, "SELECT value FROM shared_value WHERE id=1") == "committed")

        contender.execString("UPDATE shared_value SET value='after-lock' WHERE id=1")
        checks.expect("write succeeds after lock release",
            scalarText(reader, "SELECT value FROM shared_value WHERE id=1") == "after-lock")
    } finally {
        contender.close()
        writer.close()
        reader.close()
    }
}

func checkStatementCancellation(checks: Checks): Unit {
    registerSqliteDriver()
    let datasource = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", [])
    try {
        let connection = datasource.connect()
        try {
            executeUpdate(connection, "CREATE TABLE number_value (value INTEGER)")
            executeUpdate(connection,
                "WITH RECURSIVE number(value) AS (" +
                "VALUES(1) UNION ALL SELECT value+1 FROM number WHERE value<5000) " +
                "INSERT INTO number_value SELECT value FROM number")

            let statement = (connection.prepareStatement(
                "SELECT count(*) FROM number_value AS left_value, number_value AS right_value") as
                SqliteStatement).getOrThrow()
            try {
                let started = AtomicBool(false)
                let task = spawn {
                    started.store(true)
                    try {
                        let result = statement.query()
                        result.close()
                        false
                    } catch (_: SqliteInterruptedException) {
                        true
                    }
                }

                while (!started.load()) {
                    sleep(Duration.millisecond)
                }
                var attempts = 0
                while (task.tryGet().isNone() && attempts < 200) {
                    statement.cancel()
                    attempts += 1
                    sleep(Duration.millisecond)
                }
                checks.expect("running statement can be canceled", task.get())
            } finally {
                statement.close()
            }
        } finally {
            connection.close()
        }
    } finally {
        datasource.close()
    }
}

func executeUpdate(connection: Connection, sql: String): Unit {
    let statement = connection.prepareStatement(sql)
    try {
        let _ = statement.update()
    } finally {
        statement.close()
    }
}

func scalarText(connection: SqliteConn, sql: String): String {
    match (connection.queryString(sql).rows[0][0]) {
        case SText(value) => value
        case value => throw Exception("expected text from '${sql}', got ${value}")
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
