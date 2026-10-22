package sqlite_driver_error_handling

import std.collection.*
import std.database.sql.*
import std.env.*
import std.fs.*
import std.sync.*
import sqlite_driver.*

main(): Int64 {
    try {
        let checks = Checks()
        runExample(checks)
        println("PASS: error handling example (${checks.count} checks)")
        return 0
    } catch (e: Exception) {
        eprintln("FAIL: ${e.message}")
        return 1
    }
}

func runExample(checks: Checks): Unit {
    let connection = openSqlite(SqliteDSN())
    try {
        checkSyntaxOffsets(checks, connection)
        checkRejectedSyntax(checks, connection)
        checkConstraints(checks, connection)
        checkTriggerRaise(checks, connection)
        checkLookupErrors(checks, connection)
        checkTransactionState(checks, connection)
        checkSqlExceptionFallback(checks, connection)
    } finally {
        connection.close()
    }
    checkClosedResources(checks)
    checkDsnErrors(checks)
    checkBindErrors(checks)
    checkInterruption(checks)

    // 文件库场景集中在一个临时目录里，退出前整个删掉。
    let workDir = Directory.createTemp(getTempDirectory())
    try {
        checkJournalMode(checks, workDir)
        checkWriteContention(checks, workDir)
        checkCorruptFile(checks, workDir)
    } finally {
        remove(workDir, recursive: true)
    }
    checks.expect("temporary files removed", !exists(workDir))
}

/*
 * SqliteSyntaxException: position 指向出错处在原 SQL 中的字节偏移。
 */

func checkSyntaxOffsets(checks: Checks, connection: SqliteConn): Unit {
    expectFailure(checks, "unknown statement reports offset 0",
        {=> let _ = connection.execString("SELCT 1")}, syntaxErrorAt(0, "unrecognized statement 'SELCT'"))
    expectFailure(checks, "missing parenthesis reports the end of the text",
        {=> let _ = connection.execString("SELECT (1 + 2")}, syntaxErrorAt(13, "expected ')'"))
    expectFailure(checks, "parameter ordinal must start at 1",
        {=> let _ = connection.execString("SELECT ?0")}, syntaxErrorAt(7, "parameter index must be at least 1"))
}

func checkRejectedSyntax(checks: Checks, connection: SqliteConn): Unit {
    let cases: Array<(String, String, String)> = [
        ("ATTACH", "ATTACH DATABASE 'other.db' AS other", "ATTACH is not supported"),
        ("bare EXPLAIN", "EXPLAIN SELECT 1", "use EXPLAIN QUERY PLAN"),
        ("CREATE VIRTUAL TABLE", "CREATE VIRTUAL TABLE search USING fts5(body)",
            "CREATE VIRTUAL TABLE is not supported"),
        ("CREATE TEMP TABLE", "CREATE TEMP TABLE scratch (id INT)", "temporary tables are not supported"),
        ("generated column", "CREATE TABLE derived (base INT, doubled INT GENERATED ALWAYS AS (base * 2))",
            "generated columns are not supported"),
        ("VACUUM INTO", "VACUUM INTO 'backup.db'", "VACUUM INTO is not supported"),
        ("INSERT OR FAIL", "INSERT OR FAIL INTO guarded VALUES (1, 'x')", "OR FAIL is not supported"),
        ("INSERT OR ROLLBACK", "INSERT OR ROLLBACK INTO guarded VALUES (1, 'x')", "OR ROLLBACK is not supported"),
        ("MATCH FULL foreign key", "CREATE TABLE matched (pid INT REFERENCES parent(id) MATCH FULL)",
            "only MATCH SIMPLE is supported"),
        ("MATCH PARTIAL foreign key", "CREATE TABLE matched (pid INT REFERENCES parent(id) MATCH PARTIAL)",
            "only MATCH SIMPLE is supported"),
        ("DROP COLUMN IF EXISTS", "ALTER TABLE guarded DROP COLUMN IF EXISTS value", "does not accept IF EXISTS")
    ]
    for ((label, sql, fragment) in cases) {
        expectFailure(checks, "rejected syntax: ${label}", {=> let _ = connection.execString(sql)},
            syntaxErrorContaining(fragment))
    }
}

/*
 * SqliteConstraintException: constraint 区分冲突种类, table 给出冲突所在的表。
 */

func checkConstraints(checks: Checks, connection: SqliteConn): Unit {
    connection.execString(
        "CREATE TABLE constrained (id INTEGER PRIMARY KEY, code TEXT UNIQUE, label TEXT NOT NULL, " +
            "amount INT CHECK (amount >= 0))")
    connection.execString("INSERT INTO constrained VALUES (1, 'first', 'kept', 10)")

    expectFailure(checks, "UNIQUE constraint",
        {=> let _ = connection.execString("INSERT INTO constrained VALUES (2, 'first', 'duplicate code', 1)")},
        constraintError("unique", "constrained", "UNIQUE constraint failed"))
    expectFailure(checks, "NOT NULL constraint",
        {=> let _ = connection.execString("INSERT INTO constrained VALUES (3, 'third', NULL, 1)")},
        constraintError("notnull", "constrained", "NOT NULL constraint failed: constrained.label"))
    expectFailure(checks, "CHECK constraint",
        {=> let _ = connection.execString("INSERT INTO constrained VALUES (4, 'fourth', 'kept', -1)")},
        constraintError("check", "constrained", "CHECK constraint failed"))
    expectFailure(checks, "PRIMARY KEY constraint",
        {=> let _ = connection.execString("INSERT INTO constrained VALUES (1, 'fifth', 'kept', 1)")},
        constraintError("primarykey", "constrained", "UNIQUE constraint failed: constrained.id"))
    expectFailure(checks, "INTEGER PRIMARY KEY datatype",
        {=> let _ = connection.execString("INSERT INTO constrained VALUES ('sixth', 'sixth', 'kept', 1)")},
        constraintError("datatype", "constrained", "datatype mismatch"))
    checks.expect("rejected rows are absent", scalarInt(connection, "SELECT count(*) FROM constrained") == 1)

    connection.execString("PRAGMA foreign_keys=ON")
    connection.execString("CREATE TABLE fk_parent (id INTEGER PRIMARY KEY)")
    connection.execString("CREATE TABLE fk_child (id INTEGER PRIMARY KEY, parent_id INT REFERENCES fk_parent(id))")
    expectFailure(checks, "FOREIGN KEY constraint",
        {=> let _ = connection.execString("INSERT INTO fk_child VALUES (1, 99)")},
        constraintError("foreignkey", "fk_child", "FOREIGN KEY constraint failed"))
}

func checkTriggerRaise(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE guarded (id INTEGER PRIMARY KEY, value TEXT)")
    connection.execString(
        "CREATE TRIGGER guarded_abort BEFORE INSERT ON guarded WHEN NEW.id = 2 " +
            "BEGIN SELECT RAISE(ABORT, 'id 2 is reserved'); END")
    connection.execString(
        "CREATE TRIGGER guarded_fail BEFORE INSERT ON guarded WHEN NEW.id = 3 " +
            "BEGIN SELECT RAISE(FAIL, 'id 3 is rejected'); END")

    expectFailure(checks, "trigger RAISE(ABORT)",
        {=> let _ = connection.execString("INSERT INTO guarded VALUES (2, 'blocked')")},
        constraintError("trigger", "", "id 2 is reserved"))
    expectFailure(checks, "trigger RAISE(FAIL)",
        {=> let _ = connection.execString("INSERT INTO guarded VALUES (3, 'blocked')")},
        constraintError("trigger", "", "id 3 is rejected"))
    checks.expect("rows stopped by a trigger are absent", scalarInt(connection, "SELECT count(*) FROM guarded") == 0)
}

/*
 * SqliteRuntimeException: kind 说明是哪一类运行期错误。
 */

func checkLookupErrors(checks: Checks, connection: SqliteConn): Unit {
    expectFailure(checks, "unknown function",
        {=> let _ = connection.queryString("SELECT no_such_function(1)")}, runtimeError("sql", "no such function"))
    expectFailure(checks, "unknown column",
        {=> let _ = connection.queryString("SELECT missing_column FROM constrained")},
        runtimeError("sql", "no such column"))
    expectFailure(checks, "unknown table",
        {=> let _ = connection.queryString("SELECT * FROM missing_table")}, runtimeError("sql", "no such table"))
    expectFailure(checks, "unknown collation sequence",
        {=> let _ = connection.queryString("SELECT label FROM constrained ORDER BY label COLLATE no_such_collation")},
        runtimeError("collation", "no such collation sequence"))
    expectFailure(checks, "unsupported ALTER TABLE action",
        {=> let _ = connection.execString("ALTER TABLE constrained ADD COLUMN extra TEXT UNIQUE")},
        runtimeError("schema", "cannot add a UNIQUE column"))
}

func checkTransactionState(checks: Checks, connection: SqliteConn): Unit {
    expectFailure(checks, "COMMIT without a transaction", {=> let _ = connection.execString("COMMIT")},
        runtimeError("state", "no transaction is active"))

    connection.execString("BEGIN")
    expectFailure(checks, "PRAGMA foreign_keys inside a transaction",
        {=> let _ = connection.execString("PRAGMA foreign_keys=OFF")},
        runtimeError("state", "cannot be changed inside a transaction"))
    connection.execString("ROLLBACK")
    checks.expect("transaction ends after the rejected PRAGMA", !connection.inTransaction)
}

func checkClosedResources(checks: Checks): Unit {
    registerSqliteDriver()
    let datasource = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", [])
    let connection = datasource.connect()
    let statement = connection.prepareStatement("SELECT 1")
    statement.close()
    expectFailure(checks, "closed statement rejects execution", {=> let _ = statement.query()},
        runtimeError("statement", "statement is closed"))
    connection.close()
    expectFailure(checks, "closed connection rejects prepare", {=> let _ = connection.prepareStatement("SELECT 1")},
        runtimeError("connection", "connection is closed"))
    datasource.close()

    let native = openSqlite(SqliteDSN())
    native.close()
    expectFailure(checks, "closed driver connection rejects execution",
        {=> let _ = native.execString("SELECT 1")}, runtimeError("exec", "connection is closed"))
}

func checkDsnErrors(checks: Checks): Unit {
    expectFailure(checks, "unknown DSN parameter", {=> let _ = parseSqliteDsn(":memory:?nosuchkey=1")},
        runtimeError("dsn", "unknown sqlite dsn parameter 'nosuchkey'"))
    expectFailure(checks, "page size must be a power of two", {=> let _ = parseSqliteDsn(":memory:?page_size=1000")},
        runtimeError("dsn", "pageSize must be a power of two"))
    expectFailure(checks, "page size must stay within 512..65536",
        {=> let _ = parseSqliteDsn(":memory:?page_size=131072")}, runtimeError("dsn", "pageSize must be between"))
    expectFailure(checks, "busy timeout must not be negative", {=> let _ = parseSqliteDsn(":memory:?busy_timeout=-1")},
        runtimeError("dsn", "busyTimeoutMs must not be negative"))
}

func checkBindErrors(checks: Checks): Unit {
    let native = openSqlite(SqliteDSN())
    try {
        expectFailure(checks, "parameter count mismatch", {=> let _ = native.query("SELECT ?, ?", [SInt(1)])},
            runtimeError("bind", "statement requires 2 parameter(s) but 1 were supplied"))
    } finally {
        native.close()
    }

    registerSqliteDriver()
    let datasource = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", [])
    try {
        let connection = datasource.connect()
        try {
            executeUpdate(connection, "CREATE TABLE bind_demo (id INTEGER PRIMARY KEY, label TEXT)")
            executeUpdate(connection, "INSERT INTO bind_demo VALUES (1, 'value')")
            let statement = connection.prepareStatement("SELECT label FROM bind_demo WHERE id = ?")
            try {
                expectFailure(checks, "parameter index out of range", {=> statement.set<Int64>(3, 1)},
                    runtimeError("bind", "parameter index 3 is out of range 0..0"))
                expectFailure(checks, "unsupported parameter type", {=> statement.set<UInt64>(0, 1)},
                    runtimeError("bind", "unsupported parameter type"))
                expectFailure(checks, "unsupported statement option", {=> statement.setOption("cache_size", "1")},
                    runtimeError("statement", "unsupported statement option 'cache_size'"))
            } finally {
                statement.close()
            }
            checkResultErrors(checks, connection)
        } finally {
            connection.close()
        }
    } finally {
        datasource.close()
    }
}

func checkResultErrors(checks: Checks, connection: Connection): Unit {
    let statement = connection.prepareStatement("SELECT label, NULL FROM bind_demo WHERE id = 1")
    try {
        let rows = statement.query()
        try {
            checks.expect("result row available", rows.next())
            expectFailure(checks, "unsupported requested type", {=> let _ = rows.get<UInt64>(0)},
                runtimeError("result", "unsupported requested type"))
            expectFailure(checks, "SQL NULL rejected by a non-optional read", {=> let _ = rows.get<Int64>(1)},
                runtimeError("result", "SQL NULL cannot be read as Int64"))
        } finally {
            rows.close()
        }
    } finally {
        statement.close()
    }
}

/*
 * SqliteInterruptedException: 超时与主动取消共用一条中断路径。
 */

func checkInterruption(checks: Checks): Unit {
    registerSqliteDriver()
    let datasource = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", [])
    try {
        let connection = datasource.connect()
        try {
            executeUpdate(connection, "CREATE TABLE number_value (value INTEGER)")
            executeUpdate(connection,
                "WITH RECURSIVE number(value) AS (" + "VALUES(1) UNION ALL SELECT value+1 FROM number WHERE value<5000) " +
                    "INSERT INTO number_value SELECT value FROM number")
            checkTimeout(checks, connection)
            checkCancel(checks, connection)
        } finally {
            connection.close()
        }
    } finally {
        datasource.close()
    }
}

func checkTimeout(checks: Checks, connection: Connection): Unit {
    let statement = connection.prepareStatement(crossJoinCount())
    try {
        statement.setOption("timeout_ms", "1")
        expectFailure(checks, "statement timeout", {=> let _ = statement.query()}, interruptedError())
    } finally {
        statement.close()
    }
}

func checkCancel(checks: Checks, connection: Connection): Unit {
    let statement = (connection.prepareStatement(crossJoinCount()) as SqliteStatement).getOrThrow()
    try {
        let started = AtomicBool(false)
        let task = spawn {
            started.store(true)
            try {
                let rows = statement.query()
                rows.close()
                ""
            } catch (e: SqliteInterruptedException) {
                e.message
            }
        }
        while (!started.load()) {
            sleep(Duration.millisecond)
        }
        var attempts = 0
        while (task.tryGet().isNone() && attempts < 1000) {
            statement.cancel()
            attempts += 1
            sleep(Duration.millisecond)
        }
        checks.expect("canceled statement reports interruption", task.get().startsWith("sqlite interrupted: "))
    } finally {
        statement.close()
    }
}

func crossJoinCount(): String {
    "SELECT count(*) FROM number_value AS left_value, number_value AS right_value"
}

/*
 * 需要磁盘库的场景。
 */

func checkJournalMode(checks: Checks, workDir: Path): Unit {
    let connection = openSqlite(SqliteDSN(path: workDir.join("journal.db").toString()))
    try {
        expectFailure(checks, "journal_mode=off rejected",
            {=> let _ = connection.execString("PRAGMA journal_mode=OFF")},
            runtimeError("pragma", "journal_mode=off is not supported"))
        expectFailure(checks, "journal_mode=memory rejected",
            {=> let _ = connection.execString("PRAGMA journal_mode=MEMORY")},
            runtimeError("pragma", "journal_mode=memory is not supported"))
    } finally {
        connection.close()
    }
}

func checkWriteContention(checks: Checks, workDir: Path): Unit {
    let path = workDir.join("contended.db").toString()
    let setup = openSqlite(SqliteDSN(path: path))
    try {
        setup.execString("CREATE TABLE shared_value (id INTEGER PRIMARY KEY, value TEXT)")
        setup.execString("INSERT INTO shared_value VALUES (1, 'original')")
    } finally {
        setup.close()
    }

    // 两条连接都要在写锁被持有之前打开：打开本身也要取一次锁。
    let holder = openSqlite(SqliteDSN(path: path))
    let contender = openSqlite(parseSqliteDsn("${path}?busy_timeout=20"))
    try {
        holder.execString("BEGIN IMMEDIATE")
        holder.execString("UPDATE shared_value SET value='held' WHERE id=1")
        expectFailure(checks, "write contention reports busy",
            {=> let _ = contender.execString("UPDATE shared_value SET value='blocked' WHERE id=1")}, busyError())
        holder.execString("ROLLBACK")
        checks.expect("value survives the rejected write",
            scalarText(contender, "SELECT value FROM shared_value WHERE id=1") == "original")
    } finally {
        contender.close()
        holder.close()
    }
}

func checkCorruptFile(checks: Checks, workDir: Path): Unit {
    let path = workDir.join("not_a_database.db")
    let text = "this file holds plain text instead of a database header, so opening it must fail loudly. " +
        "the first bytes decide whether the file is a database at all."
    File.writeTo(path, text.toArray())
    expectFailure(checks, "non-database file rejected", {=> let _ = openSqlite(SqliteDSN(path: path.toString()))},
        formatError("not a SQLite database"))
}

/*
 * 六种异常都继承 SqlException, 边界上可以只捕一次。
 */

func checkSqlExceptionFallback(checks: Checks, connection: SqliteConn): Unit {
    let statements = [
        "SELCT 1", "INSERT INTO constrained VALUES (1, 'again', 'kept', 1)", "SELECT no_such_function(1)"
    ]
    let messages = ArrayList<String>()
    for (sql in statements) {
        try {
            connection.execString(sql)
            throw Exception("check failed: '${sql}' was expected to fail")
        } catch (e: SqlException) {
            messages.add(e.message)
        }
    }
    checks.expect("SqlException catches every driver exception", messages.size == statements.size)
    checks.expect("syntax message prefix", messages[0].startsWith("sqlite syntax error at offset "))
    checks.expect("constraint message prefix", messages[1].startsWith("sqlite constraint failed [primarykey]: "))
    checks.expect("runtime message prefix", messages[2].startsWith("sqlite sql error: "))
}

/*
 * 断言工具。
 */

/** 执行 action, 要求它抛异常且异常满足 verify。 */
func expectFailure(checks: Checks, label: String, action: () -> Unit, verify: (Exception) -> Bool): Unit {
    var raised: ?Exception = None
    try {
        action()
    } catch (e: Exception) {
        raised = Some(e)
    }
    match (raised) {
        case Some(e) => checks.expect(label, verify(e))
        case None => throw Exception("check failed: ${label} raised nothing")
    }
}

func syntaxErrorAt(position: Int64, fragment: String): (Exception) -> Bool {
    {
        e: Exception => match (e) {
            case failure: SqliteSyntaxException => failure.position == position && hasSyntaxShape(failure, fragment)
            case _ => false
        }
    }
}

func syntaxErrorContaining(fragment: String): (Exception) -> Bool {
    {
        e: Exception => match (e) {
            case failure: SqliteSyntaxException => failure.position >= 0 && hasSyntaxShape(failure, fragment)
            case _ => false
        }
    }
}

func hasSyntaxShape(failure: SqliteSyntaxException, fragment: String): Bool {
    failure.message.startsWith("sqlite syntax error at offset ${failure.position}: ") &&
        failure.message.contains(fragment)
}

func constraintError(constraint: String, table: String, fragment: String): (Exception) -> Bool {
    {
        e: Exception => match (e) {
            case failure: SqliteConstraintException => failure.constraint == constraint && failure.table == table &&
                failure.message.startsWith("sqlite constraint failed [${constraint}]: ") &&
                failure.message.contains(fragment)
            case _ => false
        }
    }
}

func runtimeError(kind: String, fragment: String): (Exception) -> Bool {
    {
        e: Exception => match (e) {
            case failure: SqliteRuntimeException => failure.kind == kind &&
                failure.message.startsWith("sqlite ${kind} error: ") && failure.message.contains(fragment)
            case _ => false
        }
    }
}

func busyError(): (Exception) -> Bool {
    {
        e: Exception => e is SqliteBusyException && e.message.startsWith("sqlite busy: ")
    }
}

func interruptedError(): (Exception) -> Bool {
    {
        e: Exception => e is SqliteInterruptedException && e.message.startsWith("sqlite interrupted: ")
    }
}

func formatError(fragment: String): (Exception) -> Bool {
    {
        e: Exception => e is SqliteFormatException && e.message.startsWith("sqlite format error: ") &&
            e.message.contains(fragment)
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
