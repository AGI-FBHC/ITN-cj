package sqlite_driver.unittests

import sqlite_driver.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 显式事务里的语句级回滚。
 *
 * 每条写语句都是一个隐含的子事务: 失败时撤销本语句的全部改动, 外层事务保持活动。
 * 判据与 SQLite 比对; 设置脚本里带有预期失败的语句, 两侧都吞掉该次异常后继续。
 */
@Test
class StatementRollbackTest {
    @TestCase
    func multiRowInsertFailureRollsBackTheWholeStatement(): Unit {
        expectSameAsSqliteAllowingFailures(
            [
                "CREATE TABLE u(id INTEGER PRIMARY KEY)",
                "INSERT INTO u VALUES(1)",
                "BEGIN",
                "INSERT INTO u VALUES(2)",
                "INSERT INTO u VALUES(3),(1)",
                "COMMIT"
            ],
            "SELECT id FROM u ORDER BY id",
            "failed multi-row insert inside an explicit transaction")
    }

    @TestCase
    func uniqueUpdateFailureLeavesPriorRowsUntouched(): Unit {
        expectSameAsSqliteAllowingFailures(
            [
                "CREATE TABLE t(id INTEGER PRIMARY KEY, code TEXT UNIQUE)",
                "INSERT INTO t VALUES(1,'a'),(2,'b'),(3,'c')",
                "BEGIN",
                "UPDATE t SET code='a' WHERE id=3",
                "UPDATE t SET code='kept' WHERE id=2",
                "COMMIT"
            ],
            "SELECT id, code FROM t ORDER BY id",
            "failed update inside an explicit transaction")
    }

    @TestCase
    func abortingDeleteUndoesEarlierDeletesInTheSameStatement(): Unit {
        expectSameAsSqliteAllowingFailures(
            [
                "CREATE TABLE t(id INTEGER PRIMARY KEY, n INT)",
                "INSERT INTO t VALUES(1,1),(2,2),(3,3)",
                "CREATE TRIGGER stop_two BEFORE DELETE ON t WHEN OLD.id=2 BEGIN SELECT RAISE(ABORT,'stop'); END",
                "BEGIN",
                "DELETE FROM t WHERE id IN (1,2,3)",
                "COMMIT"
            ],
            "SELECT id FROM t ORDER BY id",
            "failed delete with a mid-statement abort")
    }

    @TestCase
    func secondaryIndexTracksTheRolledBackStatement(): Unit {
        expectSameAsSqliteAllowingFailures(
            [
                "CREATE TABLE t(id INTEGER PRIMARY KEY, code TEXT)",
                "CREATE UNIQUE INDEX ux_t_code ON t(code)",
                "INSERT INTO t VALUES(1,'a')",
                "BEGIN",
                "INSERT INTO t VALUES(2,'b'),(3,'a')",
                "COMMIT"
            ],
            "SELECT id, code FROM t WHERE code='b' ORDER BY id",
            "secondary index after a rolled-back statement")
    }

    @TestCase
    func triggerSideEffectsAreUndoneWithTheFailedStatement(): Unit {
        expectSameAsSqliteAllowingFailures(
            [
                "CREATE TABLE src(id INTEGER PRIMARY KEY)",
                "CREATE TABLE audit(id INTEGER PRIMARY KEY, note TEXT)",
                "CREATE TRIGGER log_src AFTER INSERT ON src BEGIN INSERT INTO audit(note) VALUES('hit'); END",
                "BEGIN",
                "INSERT INTO src VALUES(1)",
                "INSERT INTO src VALUES(2),(1)",
                "COMMIT"
            ],
            "SELECT id, note FROM audit ORDER BY id",
            "trigger side effects of a failed statement")
    }

    @TestCase
    func userSavepointsSurviveAFailedStatement(): Unit {
        expectSameAsSqliteAllowingFailures(
            [
                "CREATE TABLE t(id INTEGER PRIMARY KEY)",
                "BEGIN",
                "INSERT INTO t VALUES(1)",
                "SAVEPOINT sp1",
                "INSERT INTO t VALUES(2)",
                "INSERT INTO t VALUES(3),(1)",
                "ROLLBACK TO sp1",
                "RELEASE sp1",
                "COMMIT"
            ],
            "SELECT id FROM t ORDER BY id",
            "user savepoint after a failed statement")
    }

    @TestCase
    func deferredForeignKeyFromAFailedStatementDoesNotFireAtCommit(): Unit {
        // 失败语句也会登记延迟外键检查; 语句回滚必须把登记一起丢掉, 否则 COMMIT 会误报。
        expectSameAsSqliteAllowingFailures(
            [
                "PRAGMA foreign_keys=ON",
                "CREATE TABLE parent(id INTEGER PRIMARY KEY)",
                "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INT, " +
                    "FOREIGN KEY(parent_id) REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)",
                "BEGIN",
                "INSERT INTO child VALUES(1,99)",
                "INSERT INTO child VALUES(2,88),(1,88)",
                "INSERT INTO parent VALUES(99)",
                "COMMIT"
            ],
            "SELECT id, parent_id FROM child ORDER BY id",
            "deferred foreign keys after a failed statement")
    }

    @TestCase
    func implicitTransactionStillRollsBackTheWholeStatement(): Unit {
        expectSameAsSqliteAllowingFailures(
            [
                "CREATE TABLE t(id INTEGER PRIMARY KEY)",
                "INSERT INTO t VALUES(1)",
                "INSERT INTO t VALUES(2),(1)"
            ],
            "SELECT id FROM t ORDER BY id",
            "failed multi-row insert without an explicit transaction")
    }

    @TestCase
    func walModeKeepsIntegrityAfterARolledBackStatement(): Unit {
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            try {
                conn.execString("PRAGMA journal_mode=WAL")
                conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, code TEXT UNIQUE)")
                conn.execString("INSERT INTO t VALUES(1,'a')")
                conn.execString("BEGIN")
                conn.execString("INSERT INTO t VALUES(2,'b')")
                try {
                    conn.execString("INSERT INTO t VALUES(3,'c'),(4,'a')")
                    throw Exception("expected unique failure")
                } catch (_: SqliteConstraintException) {
                    ()
                }
                conn.execString("COMMIT")
                @Assert(renderRows(conn.queryString("SELECT id FROM t ORDER BY id")), "I:1\u{1E}I:2")
                @Assert(renderRows(conn.queryString("PRAGMA integrity_check")), "T:ok")
            } finally {
                conn.close()
            }
            expectPythonOk(pythonOpen(tmp.dbPath) + pythonIntegrityCheck() +
                pythonExpect("SELECT id FROM t ORDER BY id", "[(1,), (2,)]") + pythonDone(),
                "WAL file after statement rollback")
        } finally {
            tmp.cleanup()
        }
    }
}

/**
 * 与 expectSameAsSqlite 相同, 但设置脚本里允许个别语句失败。
 *
 * 两侧都吞掉失败后继续执行后续语句, 再比较最终查询结果。用于"显式事务中一条语句失败、
 * 事务继续"这类场景。
 */
func expectSameAsSqliteAllowingFailures(setup: Array<String>, query: String, what: String): Unit {
    requirePython()
    let conn = newMemConn()
    let rendered = try {
        for (sql in setup) {
            try {
                conn.execString(sql)
            } catch (_: Exception) {
                ()
            }
        }
        renderRows(conn.queryString(query))
    } finally {
        conn.close()
    }
    let script = "import sqlite3, sys\n" + pythonRenderHelpers() + "con = sqlite3.connect(':memory:')\n" +
        "con.isolation_level = None\n" + "cur = con.cursor()\n" + "for s in ${pythonStringList(setup)}:\n" +
        "    try:\n" + "        cur.execute(s)\n" + "    except Exception:\n" + "        pass\n" +
        "got = rr(cur.execute(${pythonQuoted(query)}).fetchall())\n" + "want = sys.argv[1]\n" + "if got != want:\n" +
        "    raise SystemExit('sqlite gave %r but the driver gave %r' % (got, want))\n" + "con.close()\n" +
        "sys.stdout.write('OK')\n"
    let r = runPythonWithArg(script, rendered)
    if (!r.ok || r.stdout.trimAscii() != "OK") {
        @Fail("${what}: driver and sqlite disagree on `${query}`: ${r.describe()}")
    }
}
