package sqlite_driver_data_types

import std.database.sql.*
import std.io.*
import std.math.numeric.*
import std.time.*
import sqlite_driver.*

main(): Int64 {
    try {
        let checks = Checks()
        runStandardApiChecks(checks)
        runNativeChecks(checks)
        checkValueBridge(checks)
        println("PASS: data types example (${checks.count} checks)")
        return 0
    } catch (e: Exception) {
        eprintln("FAIL: ${e.message}")
        return 1
    }
}

/** 走 std.database.sql 门面的检查: 参数绑定、结果读取与列元数据。 */
func runStandardApiChecks(checks: Checks): Unit {
    registerSqliteDriver()
    let datasource = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", [])
    try {
        let connection = datasource.connect()
        try {
            checkValueRoundTrip(checks, connection)
            checkNullBinding(checks, connection)
            checkIntegerRanges(checks, connection)
            checkParameterPlaceholders(checks, connection)
            checkColumnMetadata(checks, connection)
            checkRejectedConversions(checks, connection)
        } finally {
            connection.close()
        }
    } finally {
        datasource.close()
    }
}

/** 走纯驱动门面的检查: 存储类、亲和性、CAST、排序规则与原生值。 */
func runNativeChecks(checks: Checks): Unit {
    let connection = openSqlite(SqliteDSN())
    try {
        checkStorageClasses(checks, connection)
        checkColumnAffinity(checks, connection)
        checkCastExpressions(checks, connection)
        checkCollations(checks, connection)
        checkNativeValueBinding(checks, connection)
    } finally {
        connection.close()
    }
    checkValueSemantics(checks)
}

/** 每种受支持的仓颉类型绑定进去再读回来, 值不变。 */
func checkValueRoundTrip(checks: Checks, connection: Connection): Unit {
    executeUpdate(connection,
        "CREATE TABLE typed_value (flag INTEGER, tiny INTEGER, small INTEGER, medium INTEGER, big INTEGER, " +
            "ratio REAL, precise REAL, label TEXT, payload BLOB, amount TEXT, created_at TEXT, document BLOB)")

    let payload: Array<Byte> = [0u8, 1u8, 254u8, 255u8]
    let document: Array<Byte> = [72u8, 101u8, 108u8, 108u8, 111u8]
    let amount = Decimal.parse("12345.6789")
    let createdAt = DateTime.parse("2026-08-15 09:30:45", "yyyy-MM-dd HH:mm:ss")
    let label = "类型映射"

    let insert = connection.prepareStatement("INSERT INTO typed_value VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    try {
        checks.expect("round trip parameter count", insert.parameterColumnInfos.size == 12)
        insert.set<Bool>(0, true)
        insert.set<Int8>(1, 120i8)
        insert.set<Int16>(2, 30000i16)
        insert.set<Int32>(3, 2000000000i32)
        insert.set<Int64>(4, 9007199254740993)
        insert.set<Float32>(5, 1.5f32)
        insert.set<Float64>(6, 3.141592653589793)
        insert.set<String>(7, label)
        insert.set<Array<Byte>>(8, payload)
        insert.set<Decimal>(9, amount)
        insert.set<DateTime>(10, createdAt)
        insert.set<InputStream>(11, ByteBuffer(document))
        checks.expect("round trip insert", insert.update().rowCount == 1)
    } finally {
        insert.close()
    }

    let query = connection.prepareStatement(
        "SELECT flag, tiny, small, medium, big, ratio, precise, label, payload, amount, created_at, document " +
            "FROM typed_value")
    try {
        let rows = query.query()
        try {
            checks.expect("round trip row", rows.next())
            checks.expect("Bool round trip", rows.get<Bool>(0))
            checks.expect("Int8 round trip", rows.get<Int8>(1) == 120i8)
            checks.expect("Int16 round trip", rows.get<Int16>(2) == 30000i16)
            checks.expect("Int32 round trip", rows.get<Int32>(3) == 2000000000i32)
            checks.expect("Int64 round trip", rows.get<Int64>(4) == 9007199254740993)
            checks.expect("Float32 round trip", rows.get<Float32>(5) == 1.5f32)
            checks.expect("Float64 round trip", rows.get<Float64>(6) == 3.141592653589793)
            checks.expect("String round trip", rows.get<String>(7) == label)
            checks.expect("Array<Byte> round trip", bytesEqual(rows.get<Array<Byte>>(8), payload))
            checks.expect("Decimal round trip", rows.get<Decimal>(9) == amount)
            checks.expect("DateTime round trip", rows.get<DateTime>(10) == createdAt)
            checks.expect("InputStream round trip", bytesEqual(readStreamFully(rows.get<InputStream>(11)), document))
            // 流式读取对 TEXT 列也成立: 文本按 UTF-8 编码后给出。
            checks.expect("TEXT column read as a UTF-8 stream",
                String.fromUtf8(readStreamFully(rows.get<InputStream>(7))) == label)
        } finally {
            rows.close()
        }
    } finally {
        query.close()
    }
}

/** setNull 与 getOrNull 的配合: SQL NULL 与 None 互相对应。 */
func checkNullBinding(checks: Checks, connection: Connection): Unit {
    executeUpdate(connection, "CREATE TABLE nullable_value (label TEXT, number INTEGER)")

    let insert = connection.prepareStatement("INSERT INTO nullable_value VALUES (?, ?)")
    try {
        insert.setNull(0)
        insert.set<Int64>(1, 5)
        checks.expect("null binding insert", insert.update().rowCount == 1)
    } finally {
        insert.close()
    }

    let query = connection.prepareStatement("SELECT label, number, typeof(label) FROM nullable_value")
    try {
        let rows = query.query()
        try {
            checks.expect("null binding row", rows.next())
            checks.expect("setNull stores SQL NULL", rows.getOrNull<String>(0).isNone())
            checks.expect("NULL storage class", rows.get<String>(2) == "null")
            checks.expect("getOrNull on a present value", rows.getOrNull<Int64>(1).getOrThrow() == 5)
        } finally {
            rows.close()
        }
    } finally {
        query.close()
    }
}

/** 窄化读取的边界, 以及 Int64 极值的原样往返。 */
func checkIntegerRanges(checks: Checks, connection: Connection): Unit {
    executeUpdate(connection, "CREATE TABLE integer_range (value INTEGER)")

    let insert = connection.prepareStatement("INSERT INTO integer_range VALUES (?)")
    try {
        insert.set<Int64>(0, 300)
        let _ = insert.update()
        insert.set<Int64>(0, Int64.Max)
        let _ = insert.update()
        insert.set<Int64>(0, Int64.Min)
        let _ = insert.update()
    } finally {
        insert.close()
    }

    let query = connection.prepareStatement("SELECT value FROM integer_range ORDER BY rowid")
    try {
        let rows = query.query()
        try {
            checks.expect("integer range first row", rows.next())
            checks.expect("Int16 narrowing inside the range", rows.get<Int16>(0) == 300i16)
            checks.expect("Int32 narrowing inside the range", rows.get<Int32>(0) == 300i32)
            expectRuntimeError(checks, "Int8 narrowing outside the range") {=> let _ = rows.get<Int8>(0)}
            checks.expect("integer range second row", rows.next())
            checks.expect("Int64 maximum round trip", rows.get<Int64>(0) == Int64.Max)
            expectRuntimeError(checks, "Int32 narrowing of the Int64 maximum") {=> let _ = rows.get<Int32>(0)}
            checks.expect("integer range third row", rows.next())
            checks.expect("Int64 minimum round trip", rows.get<Int64>(0) == Int64.Min)
        } finally {
            rows.close()
        }
    } finally {
        query.close()
    }
}

/**
 * 五种参数占位符写法。
 *
 * 序号规则: `?` 按出现顺序编号, `?N` 直接用 N, 具名参数首次出现时分配下一个序号且重复
 * 出现共享同一个序号; `set` 的下标是 0 起, 序号 N 对应下标 N-1。
 */
func checkParameterPlaceholders(checks: Checks, connection: Connection): Unit {
    let anonymousSql = "SELECT ?, ?"
    let numberedSql = "SELECT ?2, ?1"
    let repeatedSql = "SELECT ?1, ?1 + 1"
    let colonSql = "SELECT :low, :high, :low"
    let atSql = "SELECT @alpha, @beta"
    let dollarSql = "SELECT $only"

    checks.expect("anonymous placeholder count", parameterCountOf(connection, anonymousSql) == 2)
    checks.expect("anonymous placeholder binding", intsEqual(boundRow(connection, anonymousSql, [10, 20]), [10, 20]))
    checks.expect("numbered placeholder count", parameterCountOf(connection, numberedSql) == 2)
    checks.expect("numbered placeholder binding", intsEqual(boundRow(connection, numberedSql, [10, 20]), [20, 10]))
    checks.expect("repeated numbered placeholder count", parameterCountOf(connection, repeatedSql) == 1)
    checks.expect("repeated numbered placeholder binding", intsEqual(boundRow(connection, repeatedSql, [7]), [7, 8]))
    checks.expect("colon placeholder count", parameterCountOf(connection, colonSql) == 2)
    checks.expect("colon placeholder binding", intsEqual(boundRow(connection, colonSql, [1, 9]), [1, 9, 1]))
    checks.expect("at placeholder count", parameterCountOf(connection, atSql) == 2)
    checks.expect("at placeholder binding", intsEqual(boundRow(connection, atSql, [3, 4]), [3, 4]))
    checks.expect("dollar placeholder count", parameterCountOf(connection, dollarSql) == 1)
    checks.expect("dollar placeholder binding", intsEqual(boundRow(connection, dollarSql, [6]), [6]))
}

/** 结果列元数据: 列名与存储类型名。 */
func checkColumnMetadata(checks: Checks, connection: Connection): Unit {
    let query = connection.prepareStatement(
        "SELECT NULL AS nothing, 7 AS whole, 2.5 AS fraction, 'text' AS label, x'0a1b' AS payload")
    try {
        let rows = query.query()
        try {
            let infos = rows.columnInfos
            checks.expect("column metadata count", infos.size == 5)
            checks.expect("column metadata names",
                infos[0].name == "nothing" && infos[1].name == "whole" && infos[2].name == "fraction" &&
                    infos[3].name == "label" && infos[4].name == "payload")
            checks.expect("NULL column type name", infos[0].typeName == "NULL")
            checks.expect("INTEGER column type name", infos[1].typeName == "INTEGER")
            checks.expect("REAL column type name", infos[2].typeName == "REAL")
            checks.expect("TEXT column type name", infos[3].typeName == "TEXT")
            checks.expect("BLOB column type name", infos[4].typeName == "BLOB")
        } finally {
            rows.close()
        }
    } finally {
        query.close()
    }
}

/** 无法无歧义表达的绑定与读取一律报错, 而不是猜一种编码。 */
func checkRejectedConversions(checks: Checks, connection: Connection): Unit {
    executeUpdate(connection, "CREATE TABLE mixed_value (label TEXT, payload BLOB, missing TEXT)")

    let insert = connection.prepareStatement("INSERT INTO mixed_value VALUES (?, ?, ?)")
    try {
        insert.set<String>(0, "text value")
        insert.set<Array<Byte>>(1, [1u8, 2u8])
        insert.setNull(2)
        checks.expect("mixed value insert", insert.update().rowCount == 1)
        expectRuntimeError(checks, "binding an unsupported parameter type") {=> insert.set<UInt8>(0, 1u8)}
        expectRuntimeError(checks, "binding a Duration parameter") {=> insert.set<Duration>(0, Duration.second)}
        expectRuntimeError(checks, "binding outside the parameter range") {=> insert.set<Int64>(3, 1)}
    } finally {
        insert.close()
    }

    let query = connection.prepareStatement("SELECT label, payload, missing FROM mixed_value")
    try {
        let rows = query.query()
        try {
            checks.expect("mixed value row", rows.next())
            expectRuntimeError(checks, "reading an unsupported result type") {=> let _ = rows.get<UInt8>(0)}
            expectRuntimeError(checks, "reading a BLOB as String") {=> let _ = rows.get<String>(1)}
            expectRuntimeError(checks, "reading TEXT as Array<Byte>") {=> let _ = rows.get<Array<Byte>>(0)}
            expectRuntimeError(checks, "reading SQL NULL as Int64") {=> let _ = rows.get<Int64>(2)}
            expectRuntimeError(checks, "reading non-numeric TEXT as Int64") {=> let _ = rows.get<Int64>(0)}
        } finally {
            rows.close()
        }
    } finally {
        query.close()
    }
}

/** SQLite 的五种存储类。 */
func checkStorageClasses(checks: Checks, connection: SqliteConn): Unit {
    let types = connection.queryString(
        "SELECT typeof(NULL), typeof(7), typeof(2.5), typeof('text'), typeof(x'0a1b')")
    checks.expect("five storage classes", renderTexts(types) == "null|integer|real|text|blob")
}

/**
 * 列亲和性: 同一个值存进不同声明类型的列, 存储类会被转换。
 *
 * 亲和性要求整串都是数字, 所以 '12abc' 在任何列里都保持文本。
 */
func checkColumnAffinity(checks: Checks, connection: SqliteConn): Unit {
    connection.execString(
        "CREATE TABLE affinity_demo (int_column INTEGER, real_column REAL, numeric_column NUMERIC, " +
            "text_column TEXT, blob_column BLOB, untyped_column)")
    connection.execString("INSERT INTO affinity_demo VALUES ('42', '42', '42', '42', '42', '42')")
    connection.execString("INSERT INTO affinity_demo VALUES (3.0, 3.0, 3.0, 3.0, 3.0, 3.0)")
    connection.execString("INSERT INTO affinity_demo VALUES ('12abc', '12abc', '12abc', '12abc', '12abc', '12abc')")

    let types = connection.queryString(
        "SELECT typeof(int_column), typeof(real_column), typeof(numeric_column), typeof(text_column), " +
            "typeof(blob_column), typeof(untyped_column) FROM affinity_demo ORDER BY rowid")
    checks.expect("numeric text takes on the column affinity",
        rowOfTexts(types, 0) == "integer|real|integer|text|text|text")
    checks.expect("real value takes on the column affinity", rowOfTexts(types, 1) == "integer|real|integer|text|real|real")
    checks.expect("non-numeric text keeps its storage class", rowOfTexts(types, 2) == "text|text|text|text|text|text")

    let stored = connection.queryString(
        "SELECT int_column, real_column, text_column FROM affinity_demo WHERE rowid = 2")
    checks.expect("affinity rewrites the stored value", renderRows(stored) == "INTEGER(3)|REAL(3.0)|TEXT('3.0')")
}

/** CAST 取文本里最长的数字前缀, 与亲和性"整串都是数字"的要求不同。 */
func checkCastExpressions(checks: Checks, connection: SqliteConn): Unit {
    let values = connection.queryString(
        "SELECT CAST('12abc' AS INTEGER), CAST(3.9 AS INTEGER), CAST(42 AS TEXT), CAST('x' AS REAL), " +
            "CAST(65 AS BLOB), CAST('3.0' AS NUMERIC)")
    checks.expect("CAST values",
        renderRows(values) == "INTEGER(12)|INTEGER(3)|TEXT('42')|REAL(0.0)|BLOB(x'3635', 2 bytes)|INTEGER(3)")

    let types = connection.queryString(
        "SELECT typeof(CAST('12abc' AS INTEGER)), typeof(CAST(42 AS TEXT)), typeof(CAST('x' AS REAL)), " +
            "typeof(CAST(65 AS BLOB)), typeof(CAST(NULL AS INTEGER))")
    checks.expect("CAST storage classes", renderTexts(types) == "integer|text|real|blob|null")
}

/** 三种排序规则: 表达式里显式指定、列声明上指定、ORDER BY 上指定。 */
func checkCollations(checks: Checks, connection: SqliteConn): Unit {
    let comparisons = connection.queryString(
        "SELECT 'a' = 'A' COLLATE NOCASE, 'a ' = 'a' COLLATE RTRIM, 'a' = 'A' COLLATE BINARY")
    checks.expect("collation in comparisons", renderRows(comparisons) == "INTEGER(1)|INTEGER(1)|INTEGER(0)")

    connection.execString("CREATE TABLE collated_name (name TEXT COLLATE NOCASE)")
    connection.execString("INSERT INTO collated_name VALUES ('cc'), ('AA'), ('DD'), ('bb')")
    checks.expect("ORDER BY with NOCASE",
        renderTexts(connection.queryString("SELECT name FROM collated_name ORDER BY name COLLATE NOCASE")) ==
            "AA;bb;cc;DD")
    checks.expect("ORDER BY with BINARY",
        renderTexts(connection.queryString("SELECT name FROM collated_name ORDER BY name COLLATE BINARY")) ==
            "AA;DD;bb;cc")
    checks.expect("column collation drives equality",
        renderRows(connection.queryString("SELECT count(*) FROM collated_name WHERE name = 'aa'")) == "INTEGER(1)")
    checks.expect("collation list",
        renderRows(connection.queryString("PRAGMA collation_list")) ==
            "INTEGER(0)|TEXT('BINARY');INTEGER(1)|TEXT('NOCASE');INTEGER(2)|TEXT('RTRIM')")
}

/** 用 SqliteValue 直接绑定与取值。 */
func checkNativeValueBinding(checks: Checks, connection: SqliteConn): Unit {
    let payload: Array<Byte> = [65u8, 66u8]
    connection.execString(
        "CREATE TABLE native_value (id INTEGER PRIMARY KEY, label TEXT, payload BLOB, ratio REAL, note TEXT)")

    let inserted = connection.exec("INSERT INTO native_value VALUES (?, ?, ?, ?, ?)",
        [
            SqliteValue.SInt(1),
            SqliteValue.SText("native"),
            SqliteValue.SBlob(payload),
            SqliteValue.SReal(0.5),
            SqliteValue.SNull
        ])
    checks.expect("native value insert", inserted == 1)

    let rows = connection.query("SELECT id, label, payload, ratio, note FROM native_value WHERE id = ?",
        [SqliteValue.SInt(1)])
    checks.expect("native row count", rows.rowCount == 1)
    checks.expect("native text value", rows.value(0, "label") == SqliteValue.SText("native"))
    checks.expect("column lookup ignores case", rows.value(0, "LABEL") == SqliteValue.SText("native"))
    checks.expect("column index lookup", rows.columnIndexOf("Ratio") == 3)
    checks.expect("missing column lookup", rows.columnIndexOf("absent") == -1)
    checks.expect("native blob value", rows.value(0, "payload") == SqliteValue.SBlob(payload))
    checks.expect("native null value", rows.value(0, "note") == SqliteValue.SNull)
}

/** SqliteValue 的相等语义与文本形态。 */
func checkValueSemantics(checks: Checks): Unit {
    checks.expect("value equality", SqliteValue.SInt(7) == SqliteValue.SInt(7))
    checks.expect("null equality", SqliteValue.SNull == SqliteValue.SNull)
    checks.expect("blob equality compares bytes", SqliteValue.SBlob([1u8, 2u8]) == SqliteValue.SBlob([1u8, 2u8]))
    // 相等按"存储类与值都相同"判定, 所以整数与浮点不相等。
    checks.expect("storage class takes part in equality", SqliteValue.SInt(1) != SqliteValue.SReal(1.0))
    checks.expect("value text forms",
        "${SqliteValue.SNull}|${SqliteValue.SInt(7)}|${SqliteValue.SReal(0.5)}|${SqliteValue.SText("x")}|" +
            "${SqliteValue.SBlob([255u8])}" == "NULL|INTEGER(7)|REAL(0.5)|TEXT('x')|BLOB(x'FF', 1 bytes)")
}

/** 公开的类型桥接函数。 */
func checkValueBridge(checks: Checks): Unit {
    let moment = DateTime.parse("2026-08-15 09:30:45", "yyyy-MM-dd HH:mm:ss")
    checks.expect("Bool binds as INTEGER", coerceToSqliteValue<Bool>(true) == SqliteValue.SInt(1))
    checks.expect("Int32 binds as INTEGER", coerceToSqliteValue<Int32>(7i32) == SqliteValue.SInt(7))
    checks.expect("Float32 binds as REAL", coerceToSqliteValue<Float32>(0.5f32) == SqliteValue.SReal(0.5))
    checks.expect("Array<Byte> binds as BLOB", coerceToSqliteValue<Array<Byte>>([1u8]) == SqliteValue.SBlob([1u8]))
    checks.expect("Decimal binds as TEXT",
        coerceToSqliteValue<Decimal>(Decimal.parse("1.25")) == SqliteValue.SText("1.25"))
    checks.expect("DateTime binds as TEXT",
        coerceToSqliteValue<DateTime>(moment) == SqliteValue.SText("2026-08-15 09:30:45"))
    checks.expect("TEXT reads back as String", valueFromSqliteString(SqliteValue.SText("bridge")) == "bridge")
    checks.expect("numeric TEXT reads back as Int64", valueFromSqliteInt64(SqliteValue.SText(" 42 ")) == 42)
    checks.expect("INTEGER reads back as Bool", valueFromSqliteBool(SqliteValue.SInt(1)))
    checks.expect("SQL NULL reads back as None", valueFromSqliteOrNullString(SqliteValue.SNull).isNone())
    checks.expect("non-NULL reads back as Some", valueFromSqliteOrNullInt64(SqliteValue.SInt(3)).getOrThrow() == 3)
    checks.expect("datetime formatting", formatDateTimeForSqlite(moment) == "2026-08-15 09:30:45")
}

/** 语句的参数个数。 */
func parameterCountOf(connection: Connection, sql: String): Int64 {
    let statement = connection.prepareStatement(sql)
    try {
        statement.parameterColumnInfos.size
    } finally {
        statement.close()
    }
}

/** 按 0 起下标绑定整数参数, 取回第一行的所有列。 */
func boundRow(connection: Connection, sql: String, parameters: Array<Int64>): Array<Int64> {
    let statement = connection.prepareStatement(sql)
    try {
        for (index in 0..parameters.size) {
            statement.set<Int64>(index, parameters[index])
        }
        let rows = statement.query()
        try {
            if (!rows.next()) {
                throw Exception("query returned no rows: ${sql}")
            }
            let values = Array<Int64>(rows.columnInfos.size, repeat: 0)
            for (index in 0..values.size) {
                values[index] = rows.get<Int64>(index)
            }
            values
        } finally {
            rows.close()
        }
    } finally {
        statement.close()
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

/** 断言代码块抛出驱动的运行时异常。 */
func expectRuntimeError(checks: Checks, label: String, body: () -> Unit): Unit {
    var caught = false
    try {
        body()
    } catch (_: SqliteRuntimeException) {
        caught = true
    }
    checks.expect(label, caught)
}

/** 结果集渲染成 `行;行`, 每个值带存储类前缀。 */
func renderRows(rows: SqliteResultSet): String {
    let output = StringBuilder()
    for (rowIndex in 0..rows.rows.size) {
        if (rowIndex > 0) {
            output.append(";")
        }
        let row = rows.rows[rowIndex]
        for (columnIndex in 0..row.size) {
            if (columnIndex > 0) {
                output.append("|")
            }
            output.append(row[columnIndex].toString())
        }
    }
    output.toString()
}

/** 全文本结果集渲染成 `行;行`, 供 typeof() 这类只返回文本的查询使用。 */
func renderTexts(rows: SqliteResultSet): String {
    let output = StringBuilder()
    for (rowIndex in 0..rows.rows.size) {
        if (rowIndex > 0) {
            output.append(";")
        }
        output.append(rowOfTexts(rows, rowIndex))
    }
    output.toString()
}

/** 单行的文本值, 列间用 `|` 分隔。 */
func rowOfTexts(rows: SqliteResultSet, rowIndex: Int64): String {
    let output = StringBuilder()
    let row = rows.rows[rowIndex]
    for (columnIndex in 0..row.size) {
        if (columnIndex > 0) {
            output.append("|")
        }
        match (row[columnIndex]) {
            case SText(text) => output.append(text)
            case value => throw Exception("expected text, got ${value}")
        }
    }
    output.toString()
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

func intsEqual(left: Array<Int64>, right: Array<Int64>): Bool {
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
