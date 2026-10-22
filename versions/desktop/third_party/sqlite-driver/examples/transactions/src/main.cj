package sqlite_driver_transactions

import std.database.sql.*
import sqlite_driver.*

main(): Int64 {
    try {
        let checks = Checks()
        runStandardTransactionChecks(checks)
        runSqlTransactionChecks(checks)
        println("PASS: transactions example (${checks.count} checks)")
        return 0
    } catch (e: Exception) {
        eprintln("FAIL: ${e.message}")
        return 1
    }
}

/*
 * A. std.database.sql 的 Transaction。
 */
func runStandardTransactionChecks(checks: Checks): Unit {
    registerSqliteDriver()
    let datasource = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", [])
    try {
        let connection = datasource.connect()
        try {
            checkTransactionLifecycle(checks, connection)
            checkAcceptedModes(checks, connection)
            checkRejectedModes(checks, connection)
            checkNestedSavepoints(checks, connection)
            checkOneTransactionPerConnection(checks, connection)
        } finally {
            connection.close()
        }
    } finally {
        datasource.close()
    }
}

func checkTransactionLifecycle(checks: Checks, connection: Connection): Unit {
    executeUpdate(connection, "CREATE TABLE ledger (id INTEGER PRIMARY KEY, note TEXT)")

    let committed = connection.createTransaction()
    committed.begin()
    executeUpdate(connection, "INSERT INTO ledger VALUES (1, 'committed')")
    committed.commit()
    checks.expect("transaction commit", intList(connection, "SELECT id FROM ledger ORDER BY id") == "1")

    let discarded = connection.createTransaction()
    discarded.begin()
    executeUpdate(connection, "INSERT INTO ledger VALUES (2, 'discarded')")
    discarded.rollback()
    checks.expect("transaction rollback", intList(connection, "SELECT id FROM ledger ORDER BY id") == "1")

    checks.expect("commit on a finished transaction rejected", rejects("transaction") {=> discarded.commit()})
    checks.expect("restart of a finished transaction rejected", rejects("transaction") {=> discarded.begin()})
}

func checkAcceptedModes(checks: Checks, connection: Connection): Unit {
    let transaction = connection.createTransaction()
    checks.expect("default access mode", transaction.accessMode == TransactionAccessMode.Unspecified)
    checks.expect("default deferrable mode", transaction.deferrableMode == TransactionDeferrableMode.Unspecified)
    checks.expect("default isolation level", transaction.isoLevel == TransactionIsoLevel.Unspecified)

    transaction.accessMode = TransactionAccessMode.ReadWrite
    transaction.deferrableMode = TransactionDeferrableMode.NotDeferrable
    transaction.isoLevel = TransactionIsoLevel.Serializable
    checks.expect("read-write access mode", transaction.accessMode == TransactionAccessMode.ReadWrite)
    checks.expect("not-deferrable mode", transaction.deferrableMode == TransactionDeferrableMode.NotDeferrable)
    checks.expect("serializable isolation level", transaction.isoLevel == TransactionIsoLevel.Serializable)

    transaction.begin()
    executeUpdate(connection, "INSERT INTO ledger VALUES (3, 'serializable')")
    transaction.commit()
    checks.expect("accepted modes commit", intList(connection, "SELECT id FROM ledger ORDER BY id") == "1;3")
}

func checkRejectedModes(checks: Checks, connection: Connection): Unit {
    let transaction = connection.createTransaction()

    transaction.accessMode = TransactionAccessMode.ReadOnly
    checks.expect("read-only access mode rejected", rejects("transaction") {=> transaction.begin()})
    transaction.accessMode = TransactionAccessMode.Unspecified

    transaction.deferrableMode = TransactionDeferrableMode.Deferrable
    checks.expect("deferrable mode rejected", rejects("transaction") {=> transaction.begin()})
    transaction.deferrableMode = TransactionDeferrableMode.Unspecified

    transaction.isoLevel = TransactionIsoLevel.ReadCommitted
    checks.expect("read-committed level rejected", rejects("transaction") {=> transaction.begin()})
    transaction.isoLevel = TransactionIsoLevel.Snapshot
    checks.expect("snapshot level rejected", rejects("transaction") {=> transaction.begin()})

    // 被拒绝的 begin() 不留下活动事务, 改成可接受的取值后同一个对象仍可使用。
    transaction.isoLevel = TransactionIsoLevel.Serializable
    transaction.begin()
    executeUpdate(connection, "INSERT INTO ledger VALUES (4, 'accepted')")
    transaction.commit()
    checks.expect("begin after mode correction", intList(connection, "SELECT id FROM ledger ORDER BY id") == "1;3;4")
}

func checkNestedSavepoints(checks: Checks, connection: Connection): Unit {
    executeUpdate(connection, "CREATE TABLE savepoint_demo (id INTEGER PRIMARY KEY, label TEXT)")
    let transaction = connection.createTransaction()
    transaction.begin()
    executeUpdate(connection, "INSERT INTO savepoint_demo VALUES (1, 'transaction')")
    transaction.save("level_one")
    executeUpdate(connection, "INSERT INTO savepoint_demo VALUES (2, 'level one')")
    transaction.save("level_two")
    executeUpdate(connection, "INSERT INTO savepoint_demo VALUES (3, 'level two')")
    checks.expect("rows before partial rollback",
        intList(connection, "SELECT id FROM savepoint_demo ORDER BY id") == "1;2;3")

    transaction.rollback("level_two")
    checks.expect("inner savepoint rollback", intList(connection, "SELECT id FROM savepoint_demo ORDER BY id") == "1;2")
    transaction.rollback("level_one")
    checks.expect("outer savepoint rollback", intList(connection, "SELECT id FROM savepoint_demo ORDER BY id") == "1")

    transaction.release("level_one")
    checks.expect("released savepoint is unreachable", rejects("savepoint") {=> transaction.release("level_two")})

    executeUpdate(connection, "INSERT INTO savepoint_demo VALUES (4, 'kept')")
    transaction.commit()
    checks.expect("commit keeps the surviving rows",
        intList(connection, "SELECT id FROM savepoint_demo ORDER BY id") == "1;4")
}

func checkOneTransactionPerConnection(checks: Checks, connection: Connection): Unit {
    let first = connection.createTransaction()
    first.begin()
    var rejected = false
    try {
        let _ = connection.createTransaction()
    } catch (_: SqlException) {
        rejected = true
    }
    checks.expect("one transaction per connection", rejected)
    first.rollback()

    let second = connection.createTransaction()
    second.begin()
    executeUpdate(connection, "INSERT INTO savepoint_demo VALUES (5, 'next transaction')")
    second.commit()
    checks.expect("next transaction after the previous one ends",
        intList(connection, "SELECT id FROM savepoint_demo ORDER BY id") == "1;4;5")
}

/*
 * B–E. SQL 层的事务语句、隐式事务、约束与 DDL。
 */
func runSqlTransactionChecks(checks: Checks): Unit {
    let connection = openSqlite(SqliteDSN())
    try {
        checkBeginForms(checks, connection)
        checkCommitKeywords(checks, connection)
        checkRollbackKeywords(checks, connection)
        checkSavepointStatements(checks, connection)
        checkSavepointWithoutBegin(checks, connection)
        checkTransactionStatementErrors(checks, connection)
        checkConnectionCounters(checks, connection)
        checkImplicitTransaction(checks, connection)
        checkFailedStatementRollback(checks, connection)
        checkFailureInsideTransaction(checks, connection)
        checkDeferredForeignKeys(checks, connection)
        checkForeignKeyPragmaInTransaction(checks, connection)
        checkDdlInTransaction(checks, connection)
    } finally {
        connection.close()
    }
}

func checkBeginForms(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE begin_form (id INTEGER PRIMARY KEY, form TEXT)")
    let forms: Array<String> = ["BEGIN", "BEGIN TRANSACTION", "BEGIN DEFERRED", "BEGIN DEFERRED TRANSACTION",
        "BEGIN IMMEDIATE", "BEGIN IMMEDIATE TRANSACTION", "BEGIN EXCLUSIVE", "BEGIN EXCLUSIVE TRANSACTION"]
    for (index in 0..forms.size) {
        let form = forms[index]
        connection.execString(form)
        connection.exec("INSERT INTO begin_form VALUES (?, ?)", [SInt(index + 1), SText(form)])
        connection.execString("COMMIT")
        checks.expect("${form} commits",
            !connection.inTransaction &&
                scalarInt(connection, "SELECT count(*) FROM begin_form WHERE form = '${form}'") == 1)
    }
}

func checkCommitKeywords(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE commit_keyword (id INTEGER PRIMARY KEY, keyword TEXT)")
    let keywords: Array<String> = ["COMMIT", "COMMIT TRANSACTION", "END", "END TRANSACTION"]
    for (index in 0..keywords.size) {
        let keyword = keywords[index]
        connection.execString("BEGIN")
        connection.exec("INSERT INTO commit_keyword VALUES (?, ?)", [SInt(index + 1), SText(keyword)])
        connection.execString(keyword)
        checks.expect("${keyword} persists the transaction",
            !connection.inTransaction &&
                scalarInt(connection, "SELECT count(*) FROM commit_keyword WHERE keyword = '${keyword}'") == 1)
    }
}

func checkRollbackKeywords(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE rollback_keyword (id INTEGER PRIMARY KEY)")
    let keywords: Array<String> = ["ROLLBACK", "ROLLBACK TRANSACTION"]
    for (index in 0..keywords.size) {
        connection.execString("BEGIN")
        connection.exec("INSERT INTO rollback_keyword VALUES (?)", [SInt(index + 1)])
        connection.execString(keywords[index])
        checks.expect("${keywords[index]} discards the transaction",
            !connection.inTransaction && scalarInt(connection, "SELECT count(*) FROM rollback_keyword") == 0)
    }
}

func checkSavepointStatements(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE savepoint_sql (id INTEGER PRIMARY KEY, label TEXT)")
    connection.execString("BEGIN")
    connection.execString("INSERT INTO savepoint_sql VALUES (1, 'transaction')")
    connection.execString("SAVEPOINT outer_work")
    connection.execString("INSERT INTO savepoint_sql VALUES (2, 'outer work')")
    connection.execString("SAVEPOINT inner_work")
    connection.execString("INSERT INTO savepoint_sql VALUES (3, 'inner work')")

    connection.execString("ROLLBACK TO inner_work")
    checks.expect("ROLLBACK TO without the SAVEPOINT keyword",
        rowIds(connection, "SELECT id FROM savepoint_sql ORDER BY id") == "1;2")

    // ROLLBACK TO 保留 savepoint 本身, 因此同一个名字可以再次回滚。
    connection.execString("INSERT INTO savepoint_sql VALUES (4, 'retried')")
    connection.execString("ROLLBACK TO SAVEPOINT inner_work")
    checks.expect("ROLLBACK TO SAVEPOINT reuses the savepoint",
        rowIds(connection, "SELECT id FROM savepoint_sql ORDER BY id") == "1;2")

    connection.execString("RELEASE inner_work")
    checks.expect("RELEASE drops the savepoint",
        rejects("savepoint") {=> connection.execString("ROLLBACK TO SAVEPOINT inner_work")})

    connection.execString("INSERT INTO savepoint_sql VALUES (5, 'after release')")
    connection.execString("ROLLBACK TO SAVEPOINT outer_work")
    let survivors = rowIds(connection, "SELECT id FROM savepoint_sql ORDER BY id")
    checks.expect("rollback to the outer savepoint", survivors == "1")

    connection.execString("RELEASE SAVEPOINT outer_work")
    connection.execString("COMMIT")
    checks.expect("savepoint transaction commits",
        !connection.inTransaction && rowIds(connection, "SELECT id FROM savepoint_sql ORDER BY id") == "1")
}

func checkSavepointWithoutBegin(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE standalone_savepoint (id INTEGER PRIMARY KEY)")
    checks.expect("no transaction before SAVEPOINT", !connection.inTransaction)
    connection.execString("SAVEPOINT standalone")
    checks.expect("SAVEPOINT opens a transaction", connection.inTransaction)
    connection.execString("INSERT INTO standalone_savepoint VALUES (1)")
    connection.execString("RELEASE standalone")
    // RELEASE 只丢掉标记, 事务边界仍归 COMMIT / ROLLBACK 管。
    checks.expect("transaction outlives its last savepoint", connection.inTransaction)
    connection.execString("COMMIT")
    checks.expect("standalone savepoint work persists",
        !connection.inTransaction && scalarInt(connection, "SELECT count(*) FROM standalone_savepoint") == 1)
}

func checkTransactionStatementErrors(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("BEGIN")
    checks.expect("nested BEGIN rejected", rejects("state") {=> connection.execString("BEGIN")})
    checks.expect("rejected BEGIN keeps the transaction", connection.inTransaction)
    connection.execString("ROLLBACK")
    checks.expect("COMMIT without a transaction rejected", rejects("state") {=> connection.execString("COMMIT")})
    checks.expect("ROLLBACK without a transaction rejected", rejects("state") {=> connection.execString("ROLLBACK")})
}

func checkConnectionCounters(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE counter_demo (id INTEGER PRIMARY KEY, value TEXT)")
    let baseline = connection.totalChanges
    connection.execString("BEGIN")
    checks.expect("inTransaction inside a transaction", connection.inTransaction)
    connection.execString("INSERT INTO counter_demo VALUES (1,'a'),(2,'b'),(3,'c')")
    checks.expect("changes reports the last statement", connection.changes == 3)
    checks.expect("lastInsertRowid inside a transaction", connection.lastInsertRowid == 3)
    checks.expect("totalChanges grows inside a transaction", connection.totalChanges == baseline + 3)
    connection.execString("UPDATE counter_demo SET value='z' WHERE id > 1")
    checks.expect("changes after UPDATE", connection.changes == 2)
    connection.execString("COMMIT")
    checks.expect("inTransaction after COMMIT", !connection.inTransaction)

    // totalChanges 与 lastInsertRowid 统计的是执行过的语句, 回滚不会把它们减回去。
    let committed = connection.totalChanges
    connection.execString("BEGIN")
    connection.execString("INSERT INTO counter_demo VALUES (4,'d')")
    connection.execString("ROLLBACK")
    checks.expect("counters keep rolled-back statements",
        connection.totalChanges == committed + 1 && connection.lastInsertRowid == 4)
    checks.expect("rolled-back rows are gone", rowIds(connection, "SELECT id FROM counter_demo ORDER BY id") == "1;2;3")
}

func checkImplicitTransaction(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE implicit_demo (id INTEGER PRIMARY KEY, value TEXT)")
    checks.expect("no transaction around a single statement", !connection.inTransaction)
    connection.execString("INSERT INTO implicit_demo VALUES (1,'auto')")
    checks.expect("single statement commits itself",
        !connection.inTransaction && scalarInt(connection, "SELECT count(*) FROM implicit_demo") == 1)
}

func checkFailedStatementRollback(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE batch_demo (id INTEGER PRIMARY KEY, code TEXT UNIQUE)")
    connection.execString("INSERT INTO batch_demo VALUES (1,'first')")
    checks.expect("batch insert hits the unique constraint", rejectsConstraint("unique") {
        => connection.execString("INSERT INTO batch_demo VALUES (2,'second'),(3,'third'),(4,'first')")
    })
    checks.expect("failed statement writes nothing", rowIds(connection, "SELECT id FROM batch_demo ORDER BY id") == "1")
    checks.expect("failed statement leaves no transaction", !connection.inTransaction)
}

func checkFailureInsideTransaction(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE partial_demo (id INTEGER PRIMARY KEY, code TEXT UNIQUE)")
    connection.execString("INSERT INTO partial_demo VALUES (1,'first')")
    connection.execString("BEGIN")
    connection.execString("INSERT INTO partial_demo VALUES (2,'second')")
    checks.expect("conflict inside a transaction", rejectsConstraint("unique") {
        => connection.execString("INSERT INTO partial_demo VALUES (3,'third'),(4,'first')")
    })
    // 失败语句是隐含子事务: 它自己的改动整体撤销, 事务本身继续存在。
    checks.expect("transaction stays usable after a failed statement",
        connection.inTransaction && rowIds(connection, "SELECT id FROM partial_demo ORDER BY id") == "1;2")
    connection.execString("INSERT INTO partial_demo VALUES (5,'fifth')")
    connection.execString("COMMIT")
    checks.expect("commit after a failed statement",
        rowIds(connection, "SELECT id FROM partial_demo ORDER BY id") == "1;2;5")

    connection.execString("BEGIN")
    connection.execString("INSERT INTO partial_demo VALUES (6,'sixth')")
    checks.expect("second conflict inside a transaction", rejectsConstraint("unique") {
        => connection.execString("INSERT INTO partial_demo VALUES (7,'seventh'),(8,'first')")
    })
    connection.execString("ROLLBACK")
    checks.expect("rollback discards the whole transaction",
        rowIds(connection, "SELECT id FROM partial_demo ORDER BY id") == "1;2;5")
}

func checkDeferredForeignKeys(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("PRAGMA foreign_keys=ON")
    connection.execString("CREATE TABLE fk_parent (id INTEGER PRIMARY KEY)")
    connection.execString(
        "CREATE TABLE fk_child (id INTEGER PRIMARY KEY, parent_id INT, " +
            "FOREIGN KEY(parent_id) REFERENCES fk_parent(id) DEFERRABLE INITIALLY DEFERRED)")

    // 延迟约束允许事务中间态违约, 子行可以先写。
    connection.execString("BEGIN")
    connection.execString("INSERT INTO fk_child VALUES (1, 10)")
    connection.execString("INSERT INTO fk_parent VALUES (10)")
    connection.execString("COMMIT")
    checks.expect("deferred foreign key satisfied at commit",
        rowIds(connection, "SELECT id FROM fk_child ORDER BY id") == "1")

    connection.execString("BEGIN")
    connection.execString("INSERT INTO fk_child VALUES (2, 20)")
    checks.expect("deferred foreign key checked at commit",
        rejectsConstraint("foreignkey") {=> connection.execString("COMMIT")})
    checks.expect("failed commit keeps the transaction open", connection.inTransaction)
    connection.execString("ROLLBACK")
    checks.expect("rollback restores consistency",
        !connection.inTransaction && rowIds(connection, "SELECT id FROM fk_child ORDER BY id") == "1")
}

func checkForeignKeyPragmaInTransaction(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("BEGIN")
    checks.expect("PRAGMA foreign_keys cannot change inside a transaction",
        rejects("state") {=> connection.execString("PRAGMA foreign_keys=OFF")})
    // 设成当前值不改变约束规则, 因此允许。
    connection.execString("PRAGMA foreign_keys=ON")
    checks.expect("PRAGMA foreign_keys accepts the current value", scalarInt(connection, "PRAGMA foreign_keys") == 1)
    connection.execString("ROLLBACK")
}

func checkDdlInTransaction(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("BEGIN")
    connection.execString("CREATE TABLE staged_table (id INTEGER PRIMARY KEY)")
    connection.execString("INSERT INTO staged_table VALUES (1)")
    checks.expect("DDL and rows are visible inside the transaction",
        rowIds(connection, "SELECT id FROM staged_table") == "1")
    connection.execString("ROLLBACK")
    checks.expect("rolled-back CREATE TABLE leaves no table",
        rejects("sql") {=> let _ = connection.queryString("SELECT id FROM staged_table")})

    connection.execString("BEGIN")
    connection.execString("CREATE TABLE kept_table (id INTEGER PRIMARY KEY)")
    connection.execString("INSERT INTO kept_table VALUES (1)")
    connection.execString("COMMIT")
    checks.expect("committed CREATE TABLE keeps its rows", rowIds(connection, "SELECT id FROM kept_table") == "1")
}

/*
 * 辅助函数。
 */

/** 执行 body, 判断它是否抛出指定种类的 SqliteRuntimeException。 */
func rejects(kind: String, body: () -> Unit): Bool {
    try {
        body()
        false
    } catch (e: SqliteRuntimeException) {
        e.kind == kind
    }
}

/** 执行 body, 判断它是否抛出指定约束的 SqliteConstraintException。 */
func rejectsConstraint(constraint: String, body: () -> Unit): Bool {
    try {
        body()
        false
    } catch (e: SqliteConstraintException) {
        e.constraint == constraint
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

/** 单列整数结果集拼成 "1;2;3"。 */
func intList(connection: Connection, sql: String): String {
    let statement = connection.prepareStatement(sql)
    try {
        let rows = statement.query()
        try {
            let output = StringBuilder()
            while (rows.next()) {
                if (output.size > 0) {
                    output.append(";")
                }
                output.append("${rows.get<Int64>(0)}")
            }
            output.toString()
        } finally {
            rows.close()
        }
    } finally {
        statement.close()
    }
}

/** 原生连接上的单列整数结果集, 形态与 intList 一致。 */
func rowIds(connection: SqliteConn, sql: String): String {
    let rows = connection.queryString(sql)
    let output = StringBuilder()
    for (row in rows.rows) {
        if (output.size > 0) {
            output.append(";")
        }
        match (row[0]) {
            case SInt(value) => output.append("${value}")
            case value => throw Exception("expected integer from '${sql}', got ${value}")
        }
    }
    output.toString()
}

func scalarInt(connection: SqliteConn, sql: String): Int64 {
    match (connection.queryString(sql).rows[0][0]) {
        case SInt(value) => value
        case value => throw Exception("expected integer from '${sql}', got ${value}")
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
