package sqlite_driver_advanced_sql

import std.database.sql.*
import sqlite_driver.*

main(): Int64 {
    try {
        let checks = Checks()
        let connection = openSqlite(SqliteDSN())
        try {
            checkDropColumn(checks, connection)
            checkOrderedDml(checks, connection)
            checkCollationAndPartialIndex(checks, connection)
            checkJson(checks, connection)
            checkNamedWindow(checks, connection)
            checkWithoutRowid(checks, connection)
            checkCteDml(checks, connection)
            checkDeferredForeignKey(checks, connection)
            checkRecursiveTrigger(checks, connection)
            checkTriggerRaise(checks, connection)
            checkQueryPlan(checks, connection)
            checkFunctions(checks, connection)
            checkErrors(checks, connection)
        } finally {
            connection.close()
        }
        checkTimeout(checks)
        println("PASS: advanced SQL example (${checks.count} checks)")
        return 0
    } catch (e: Exception) {
        eprintln("FAIL: ${e.message}")
        return 1
    }
}

func checkDropColumn(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE drop_demo (id INTEGER PRIMARY KEY, obsolete TEXT, value TEXT)")
    connection.execString("INSERT INTO drop_demo VALUES (1, 'remove', 'kept')")
    connection.execString("ALTER TABLE drop_demo DROP COLUMN obsolete")
    checks.expect("ALTER TABLE DROP COLUMN",
        renderRows(connection.queryString("SELECT id, value FROM drop_demo")) == "1|kept")
}

func checkOrderedDml(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE ordered_dml (id INTEGER PRIMARY KEY, score INT, marker TEXT)")
    connection.execString(
        "INSERT INTO ordered_dml VALUES " + "(1,30,'no'),(2,10,'no'),(3,50,'no'),(4,20,'no'),(5,40,'no')")
    let updated = connection.execString("UPDATE ordered_dml SET marker='yes' ORDER BY score LIMIT 2")
    checks.expect("UPDATE ORDER BY LIMIT row count", updated == 2)
    checks.expect("UPDATE ORDER BY LIMIT rows",
        renderRows(connection.queryString("SELECT id FROM ordered_dml WHERE marker='yes' ORDER BY id")) == "2;4")
    let deleted = connection.execString("DELETE FROM ordered_dml ORDER BY score DESC LIMIT 1")
    checks.expect("DELETE ORDER BY LIMIT row count", deleted == 1)
    checks.expect("DELETE ORDER BY LIMIT rows",
        renderRows(connection.queryString("SELECT id FROM ordered_dml ORDER BY id")) == "1;2;4;5")
}

func checkCollationAndPartialIndex(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE collated_value (name TEXT COLLATE NOCASE, active INT)")
    connection.execString(
        "CREATE UNIQUE INDEX ux_collated_active ON collated_value(name) WHERE active = 1")
    connection.execString("INSERT INTO collated_value VALUES ('Alpha',1),('alpha',0)")
    checks.expect("column collation",
        renderRows(connection.queryString("SELECT count(*) FROM collated_value WHERE name='ALPHA'")) == "2")

    var duplicateCaught = false
    try {
        connection.execString("INSERT INTO collated_value VALUES ('ALPHA',1)")
    } catch (_: SqliteConstraintException) {
        duplicateCaught = true
    }
    checks.expect("partial unique index", duplicateCaught)
}

func checkJson(checks: Checks, connection: SqliteConn): Unit {
    let result = connection.queryString(
        "SELECT json_extract('{\"items\":[10,20]}', '$.items[1]'), " +
            "'{\"state\":\"ready\"}' ->> '$.state', json_type(json_array(1,2), '$')")
    checks.expect("JSON functions and operators", renderRows(result) == "20|ready|array")
}

func checkNamedWindow(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE window_demo (id INT, group_name TEXT, value INT)")
    connection.execString("INSERT INTO window_demo VALUES (1,'a',10),(2,'a',10),(3,'a',20)")
    let rows = connection.queryString(
        "SELECT id, sum(value) OVER running FROM window_demo " +
            "WINDOW running AS (PARTITION BY group_name ORDER BY value " +
            "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE TIES) ORDER BY id")
    checks.expect("named window with EXCLUDE", renderRows(rows) == "1|10;2|10;3|40")
}

func checkWithoutRowid(checks: Checks, connection: SqliteConn): Unit {
    connection.execString(
        "CREATE TABLE key_value (scope TEXT, id INT, value TEXT, " + "PRIMARY KEY(scope,id)) WITHOUT ROWID")
    connection.execString("CREATE INDEX ix_key_value_value ON key_value(value)")
    connection.execString("INSERT INTO key_value VALUES ('b',2,'two'),('a',1,'one'),('b',1,'first')")
    checks.expect("WITHOUT ROWID primary-key order",
        renderRows(connection.queryString("SELECT scope,id,value FROM key_value")) == "a|1|one;b|1|first;b|2|two")
    connection.execString("UPDATE key_value SET id=3,value='moved' WHERE scope='b' AND id=2")
    checks.expect("WITHOUT ROWID update and secondary index",
        renderRows(connection.queryString("SELECT scope,id FROM key_value WHERE value='moved'")) == "b|3")
}

func checkCteDml(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE generated_number (value INT)")
    connection.execString(
        "WITH RECURSIVE number(value) AS (" + "VALUES(1) UNION ALL SELECT value+1 FROM number WHERE value<5) " +
            "INSERT INTO generated_number SELECT value FROM number")
    checks.expect("recursive CTE with INSERT",
        renderRows(connection.queryString("SELECT count(*), sum(value) FROM generated_number")) == "5|15")
}

func checkDeferredForeignKey(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("PRAGMA foreign_keys=ON")
    connection.execString("CREATE TABLE deferred_parent (id INTEGER PRIMARY KEY)")
    connection.execString(
        "CREATE TABLE deferred_child (id INTEGER PRIMARY KEY, parent_id INT, " +
            "FOREIGN KEY(parent_id) REFERENCES deferred_parent(id) DEFERRABLE INITIALLY DEFERRED)")
    connection.execString("BEGIN")
    connection.execString("INSERT INTO deferred_child VALUES (1,7)")
    connection.execString("INSERT INTO deferred_parent VALUES (7)")
    connection.execString("COMMIT")
    checks.expect("deferred foreign key",
        renderRows(connection.queryString(
            "SELECT child.id,parent.id FROM deferred_child child " +
                "JOIN deferred_parent parent ON parent.id=child.parent_id")) == "1|7")
}

func checkRecursiveTrigger(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("PRAGMA recursive_triggers=ON")
    connection.execString("CREATE TABLE recursive_value (id INT)")
    connection.execString(
        "CREATE TRIGGER add_next AFTER INSERT ON recursive_value WHEN NEW.id < 3 BEGIN " +
            "INSERT INTO recursive_value VALUES (NEW.id + 1); END")
    connection.execString("INSERT INTO recursive_value VALUES (1)")
    checks.expect("recursive trigger",
        renderRows(connection.queryString("SELECT id FROM recursive_value ORDER BY id")) == "1;2;3")
}

func checkTriggerRaise(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE guarded_value (id INT)")
    connection.execString(
        "CREATE TRIGGER skip_two BEFORE INSERT ON guarded_value WHEN NEW.id=2 " +
            "BEGIN SELECT RAISE(IGNORE); END")
    connection.execString("INSERT INTO guarded_value VALUES (1),(2),(3)")
    checks.expect("trigger RAISE IGNORE",
        renderRows(connection.queryString("SELECT id FROM guarded_value ORDER BY id")) == "1;3")

    connection.execString(
        "CREATE TRIGGER reject_negative BEFORE INSERT ON guarded_value WHEN NEW.id<0 " +
            "BEGIN SELECT RAISE(ABORT,'id must be non-negative'); END")
    var rejected = false
    try {
        connection.execString("INSERT INTO guarded_value VALUES (-1)")
    } catch (_: SqliteConstraintException) {
        rejected = true
    }
    checks.expect("trigger RAISE ABORT", rejected)
}

func checkQueryPlan(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE plan_demo (id INTEGER PRIMARY KEY, lookup_key INT, value TEXT)")
    connection.execString("CREATE INDEX ix_plan_demo_key ON plan_demo(lookup_key)")
    let plan = textAt(connection.queryString("EXPLAIN QUERY PLAN SELECT value FROM plan_demo WHERE lookup_key=7"), 0, 3)
    checks.expect("EXPLAIN QUERY PLAN index path", plan.contains("ix_plan_demo_key"))
}

func checkFunctions(checks: Checks, connection: SqliteConn): Unit {
    let rows = connection.queryString(
        "SELECT hex(unhex('4142')), quote('a''b'), unicode('A'), sign(-7), likely(9), format('x=%02d',7)")
    checks.expect("scalar function set", renderRows(rows) == "4142|'a''b'|65|-1|9|x=07")
}

func checkErrors(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE error_demo (id INTEGER PRIMARY KEY)")
    connection.execString("INSERT INTO error_demo VALUES (1)")
    var constraintCaught = false
    try {
        connection.execString("INSERT INTO error_demo VALUES (1)")
    } catch (_: SqliteConstraintException) {
        constraintCaught = true
    }
    checks.expect("constraint exception type", constraintCaught)

    var syntaxCaught = false
    try {
        connection.queryString("ATTACH DATABASE 'other.db' AS other")
    } catch (_: SqliteSyntaxException) {
        syntaxCaught = true
    }
    checks.expect("unsupported statement exception type", syntaxCaught)
}

func checkTimeout(checks: Checks): Unit {
    registerSqliteDriver()
    let datasource = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", [])
    try {
        let connection = datasource.connect()
        try {
            executeUpdate(connection, "CREATE TABLE timeout_value (id INT)")
            executeUpdate(connection,
                "WITH RECURSIVE number(value) AS (" + "VALUES(1) UNION ALL SELECT value+1 FROM number WHERE value<1000) " +
                    "INSERT INTO timeout_value SELECT value FROM number")
            let statement = connection.prepareStatement("SELECT count(*) FROM timeout_value a, timeout_value b")
            try {
                statement.setOption("timeout_ms", "1")
                var interrupted = false
                try {
                    let _ = statement.query()
                } catch (_: SqliteInterruptedException) {
                    interrupted = true
                }
                checks.expect("statement timeout", interrupted)
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

func textAt(rows: SqliteResultSet, row: Int64, column: Int64): String {
    match (rows.rows[row][column]) {
        case SText(value) => value
        case value => throw Exception("expected text, got ${value}")
    }
}

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
            output.append(renderValue(row[columnIndex]))
        }
    }
    output.toString()
}

func renderValue(value: SqliteValue): String {
    match (value) {
        case SNull => "NULL"
        case SInt(number) => "${number}"
        case SReal(number) => "${number}"
        case SText(text) => text
        case SBlob(bytes) => "blob:${bytes.size}"
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
