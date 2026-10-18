package sqlite_driver_standard_api

import std.database.sql.*
import std.io.*
import std.math.numeric.*
import std.time.*
import sqlite_driver.*

main(): Int64 {
    try {
        let checks = Checks()
        runExample(checks)
        println("PASS: standard API example (${checks.count} checks)")
        return 0
    } catch (e: Exception) {
        eprintln("FAIL: ${e.message}")
        return 1
    }
}

func runExample(checks: Checks): Unit {
    registerSqliteDriver()
    let driver = DriverManager.getDriver("sqlite").getOrThrow()
    checks.expect("driver name", driver.name == "sqlite")
    checks.expect("driver version", driver.version == "0.1.0")
    checks.expect("pooling preference", !driver.preferredPooling)
    checkPublicTypeBridge(checks)

    let datasource = driver.open(":memory:", [("foreign_keys", "on")])
    datasource.setOption("busy_timeout", "2500")
    checks.expect("datasource starts open", !datasource.isClosed())
    try {
        let connection = datasource.connect()
        try {
            checkMetadata(checks, connection)
            checkTypedValues(checks, connection)
            checkStatementReuse(checks, connection)
            checkCompatibilityOverloads(checks, connection)
            checkTransactions(checks, connection)
        } finally {
            connection.close()
        }
        checks.expect("connection closes", connection.isClosed())
        checks.expect("connection state", connection.state == ConnectionState.Closed)
    } finally {
        datasource.close()
    }
    checks.expect("datasource closes", datasource.isClosed())
}

func checkMetadata(checks: Checks, connection: Connection): Unit {
    checks.expect("connection starts open", !connection.isClosed())
    checks.expect("connection state", connection.state == ConnectionState.Connected)
    let metadata = connection.getMetaData()
    checks.expect("metadata driver", metadata.get("driver").getOrThrow() == "sqlite")
    checks.expect("metadata product", metadata.get("databaseProductName").getOrThrow() == "SQLite")
    checks.expect("metadata version", metadata.get("version").getOrThrow() == "0.1.0")
    checks.expect("metadata URL", metadata.get("url").getOrThrow() == ":memory:")
    checks.expect("foreign key option", scalarInt(connection, "PRAGMA foreign_keys") == 1)
    let busyTimeout = scalarInt(connection, "PRAGMA busy_timeout")
    checks.expect("busy timeout option (${busyTimeout})", busyTimeout == 2500)
}

func checkTypedValues(checks: Checks, connection: Connection): Unit {
    executeUpdate(connection,
        "CREATE TABLE typed_value (flag INTEGER, number INTEGER, ratio REAL, text_value TEXT, " +
            "payload BLOB, amount TEXT, created_at TEXT, optional_value TEXT)")

    let insert = connection.prepareStatement("INSERT INTO typed_value VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    let payload: Array<Byte> = [0u8, 1u8, 254u8, 255u8]
    let amount = Decimal.parse("12345.67")
    let createdAt = DateTime.parse("2026-08-15 09:30:45", "yyyy-MM-dd HH:mm:ss")
    try {
        checks.expect("parameter metadata", insert.parameterColumnInfos.size == 8)
        let parameterInfo = insert.parameterColumnInfos[0]
        checks.expect("parameter metadata values",
            parameterInfo.name == "" && parameterInfo.typeName == "NULL" && parameterInfo.length == 0 &&
                parameterInfo.scale == 0 && parameterInfo.nullable && parameterInfo.displaySize == 0)
        insert.set<Bool>(0, true)
        insert.set<Int64>(1, 42)
        insert.set<Float64>(2, 3.25)
        insert.set<String>(3, "typed text")
        insert.set<InputStream>(4, ByteBuffer(payload))
        insert.set<Decimal>(5, amount)
        insert.set<DateTime>(6, createdAt)
        insert.setNull(7)
        insert.setOption("timeout_ms", "5000")
        let nativeStatement = (insert as SqliteStatement).getOrThrow()
        nativeStatement.cancel()
        let result = insert.update()
        checks.expect("update row count", result.rowCount == 1)
        checks.expect("last insert id", result.lastInsertId == 1)
    } finally {
        insert.close()
    }
    checks.expect("statement closes", insert.isClosed())

    let query = connection.prepareStatement(
        "SELECT flag, number, ratio, text_value, payload, amount, created_at, optional_value FROM typed_value")
    try {
        let rows = query.query()
        try {
            checks.expect("column metadata count", rows.columnInfos.size == 8)
            checks.expect("column metadata name", rows.columnInfos[0].name == "flag")
            let columnInfo = rows.columnInfos[0]
            checks.expect("column metadata values",
                columnInfo.typeName == "INTEGER" && columnInfo.length == 0 && columnInfo.scale == 0 && columnInfo
                    .nullable && columnInfo.displaySize == 0)
            checks.expect("row exists", rows.next())
            checks.expect("Bool round trip", rows.get<Bool>(0))
            checks.expect("Int64 round trip", rows.get<Int64>(1) == 42)
            checks.expect("Float64 round trip", rows.get<Float64>(2) == 3.25)
            checks.expect("String round trip", rows.get<String>(3) == "typed text")
            checks.expect("BLOB round trip", bytesEqual(rows.get<Array<Byte>>(4), payload))
            checks.expect("BLOB stream round trip", bytesEqual(readStreamFully(rows.get<InputStream>(4)), payload))
            checks.expect("TEXT stream uses UTF-8",
                String.fromUtf8(readStreamFully(rows.get<InputStream>(3))) == "typed text")
            checks.expect("Decimal round trip", rows.get<Decimal>(5) == amount)
            checks.expect("DateTime round trip", rows.get<DateTime>(6) == createdAt)
            checks.expect("NULL round trip", rows.getOrNull<String>(7).isNone())
            checks.expect("single result row", !rows.next())
        } finally {
            rows.close()
        }
        checks.expect("result closes", rows.isClosed())
    } finally {
        query.close()
    }
}

func checkPublicTypeBridge(checks: Checks): Unit {
    match (coerceToSqliteValue<Int32>(7)) {
        case SInt(value) => checks.expect("public value binding bridge", value == 7)
        case _ => checks.expect("public value binding bridge", false)
    }
    checks.expect("public value reading bridge", valueFromSqliteString(SText("bridge")) == "bridge")
    checks.expect("public nullable value bridge", valueFromSqliteOrNullString(SNull).isNone())
    let value = DateTime.parse("2026-08-15 09:30:45", "yyyy-MM-dd HH:mm:ss")
    checks.expect("public datetime formatter", formatDateTimeForSqlite(value) == "2026-08-15 09:30:45")
    checks.expect("public affinity name", SqliteAffinity.AffInteger.toString() == "INTEGER")
    checks.expect("public collation name", SqliteCollation.CollNocase.toString() == "NOCASE")

    let info = SqliteColumnInfo("amount", "TEXT", 32, 2, false, 32)
    checks.expect("public column metadata type",
        info.name == "amount" && info.typeName == "TEXT" && info.length == 32 && info.scale == 2 && !info.nullable &&
            info.displaySize == 32)
    let update = SqliteUpdateResult(3, 9)
    checks.expect("public update result type", update.rowCount == 3 && update.lastInsertId == 9)
}

func checkStatementReuse(checks: Checks, connection: Connection): Unit {
    executeUpdate(connection, "CREATE TABLE reusable_value (id INTEGER PRIMARY KEY, value TEXT)")
    let insert = connection.prepareStatement("INSERT INTO reusable_value VALUES (?, ?)")
    try {
        insert.set<Int64>(0, 1)
        insert.set<String>(1, "first")
        checks.expect("first reused update", insert.update().rowCount == 1)
        insert.set<Int64>(0, 2)
        insert.set<String>(1, "second")
        checks.expect("second reused update", insert.update().rowCount == 1)
    } finally {
        insert.close()
    }

    let query = connection.prepareStatement("SELECT value FROM reusable_value WHERE id = ?")
    try {
        query.set<Int64>(0, 1)
        checks.expect("first reused query", singleText(query.query()) == "first")
        query.set<Int64>(0, 2)
        checks.expect("second reused query", singleText(query.query()) == "second")
    } finally {
        query.close()
    }
}

func checkCompatibilityOverloads(checks: Checks, connection: Connection): Unit {
    executeUpdate(connection,
        "CREATE TABLE compatibility_value (id INTEGER PRIMARY KEY, label TEXT, payload BLOB, note TEXT)")
    let payload: Array<Byte> = [5u8, 6u8, 7u8]
    let insert = connection.prepareStatement("INSERT INTO compatibility_value VALUES (?, ?, ?, ?)")
    try {
        let parameters: Array<SqlDbType> = [
            SqlBigInt(7),
            SqlVarchar("compatibility"),
            SqlBlob(ByteBuffer(payload)),
            SqlNullableVarchar(None)
        ]
        checks.expect("compatibility update overload", insert.update(parameters).rowCount == 1)
    } finally {
        insert.close()
    }

    let query = connection.prepareStatement("SELECT id, label, payload, note FROM compatibility_value WHERE id = ?")
    try {
        let parameters: Array<SqlDbType> = [SqlBigInt(7)]
        let rows = query.query(parameters)
        try {
            let id = SqlBigInt(0)
            let label = SqlVarchar("")
            let blob = SqlBlob(ByteBuffer())
            let note = SqlNullableVarchar(Some("placeholder"))
            let values: Array<SqlDbType> = [id, label, blob, note]
            checks.expect("compatibility result overload", rows.next(values))
            checks.expect("compatibility integer slot", id.value == 7)
            checks.expect("compatibility text slot", label.value == "compatibility")
            checks.expect("compatibility BLOB slot", bytesEqual(readStreamFully(blob.value), payload))
            checks.expect("compatibility nullable slot", note.value.isNone())
            checks.expect("compatibility result exhausted", !rows.next(values))
        } finally {
            rows.close()
        }
    } finally {
        query.close()
    }
}

func checkTransactions(checks: Checks, connection: Connection): Unit {
    executeUpdate(connection, "CREATE TABLE transaction_value (id INTEGER PRIMARY KEY, value TEXT)")

    let transaction = connection.createTransaction()
    transaction.accessMode = TransactionAccessMode.ReadWrite
    transaction.deferrableMode = TransactionDeferrableMode.NotDeferrable
    transaction.isoLevel = TransactionIsoLevel.Serializable
    transaction.begin()
    executeUpdate(connection, "INSERT INTO transaction_value VALUES (1, 'kept')")
    transaction.save("inner_work")
    executeUpdate(connection, "INSERT INTO transaction_value VALUES (2, 'discarded')")
    transaction.rollback("inner_work")
    transaction.release("inner_work")
    transaction.commit()
    checks.expect("savepoint rollback", scalarInt(connection, "SELECT count(*) FROM transaction_value") == 1)

    let rollbackTransaction = connection.createTransaction()
    rollbackTransaction.begin()
    executeUpdate(connection, "INSERT INTO transaction_value VALUES (3, 'discarded')")
    rollbackTransaction.rollback()
    checks.expect("transaction rollback", scalarInt(connection, "SELECT count(*) FROM transaction_value") == 1)
}

func singleText(rows: QueryResult): String {
    try {
        if (!rows.next()) {
            throw Exception("query returned no rows")
        }
        let value = rows.get<String>(0)
        if (rows.next()) {
            throw Exception("query returned more than one row")
        }
        value
    } finally {
        rows.close()
    }
}

func readStreamFully(stream: InputStream): Array<Byte> {
    let output = ByteBuffer()
    let buffer = Array<Byte>(64, repeat: 0)
    while (true) {
        let count = stream.read(buffer)
        if (count <= 0) {
            break
        }
        output.write(buffer[0..count])
    }
    output.bytes()
}

func executeUpdate(connection: Connection, sql: String): Unit {
    let statement = connection.prepareStatement(sql)
    try {
        let _ = statement.update()
    } finally {
        statement.close()
    }
}

func scalarInt(connection: Connection, sql: String): Int64 {
    let statement = connection.prepareStatement(sql)
    try {
        let rows = statement.query()
        try {
            if (!rows.next()) {
                throw Exception("query returned no rows: ${sql}")
            }
            return rows.get<Int64>(0)
        } finally {
            rows.close()
        }
    } finally {
        statement.close()
    }
}

func bytesEqual(left: Array<Byte>, right: Array<Byte>): Bool {
    if (left.size != right.size) {
        return false
    }
    for (index in 0..left.size) {
        if (left[index] != right[index]) {
            return false
        }
    }
    true
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
