package sqlite_driver.unittests

import sqlite_driver.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 验证同一个 Stmt 使用不同参数多次执行时不会相互污染。该行为也保证 AST 节点在执行期间
 * 保持只读。
 */
@Test
class StmtReuseProbeTest {
    @TestCase
    func sameStmtWithDifferentParamsProducesCorrectResults() {
        let db = openDatabase(":memory:", 4096, SqliteSyncMode.SyncFull, 5000)
        executeSql(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)", Array<SqliteValue>())
        executeSql(db, "INSERT INTO t (id, val) VALUES (1, 'first'), (2, 'second'), (3, 'third')", Array<SqliteValue>())

        // 解析一次
        let parser = Parser("SELECT val FROM t WHERE id = ?")
        let stmt = parser.parseStatement()

        // 第一次执行: id=1
        let result1 = executeStatement(db, stmt, [SqliteValue.SInt(1)])
        let rows1 = result1.rows.getOrThrow().rows
        @Assert(rows1.size, 1)
        match (rows1[0][0]) {
            case SText(s) => @Assert(s, "first")
            case _ => @Fail("first execution did not return TEXT")
        }

        // 第二次执行: id=2 (不同参数)
        let result2 = executeStatement(db, stmt, [SqliteValue.SInt(2)])
        let rows2 = result2.rows.getOrThrow().rows
        @Assert(rows2.size, 1)
        match (rows2[0][0]) {
            case SText(s) => @Assert(s, "second")
            case _ => @Fail("second execution did not return TEXT")
        }

        // 第三次执行: id=3 (再次不同参数)
        let result3 = executeStatement(db, stmt, [SqliteValue.SInt(3)])
        let rows3 = result3.rows.getOrThrow().rows
        @Assert(rows3.size, 1)
        match (rows3[0][0]) {
            case SText(s) => @Assert(s, "third")
            case _ => @Fail("third execution did not return TEXT")
        }

        db.close()
    }

    @TestCase
    func updateStatementReuseAlsoWorks() {
        let db = openDatabase(":memory:", 4096, SqliteSyncMode.SyncFull, 5000)
        executeSql(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, counter INTEGER)", Array<SqliteValue>())
        executeSql(db, "INSERT INTO t (id, counter) VALUES (1, 0), (2, 0)", Array<SqliteValue>())

        // 解析一次 UPDATE 语句
        let parser = Parser("UPDATE t SET counter = counter + ? WHERE id = ?")
        let stmt = parser.parseStatement()

        // 第一次: id=1, +10
        executeStatement(db, stmt, [SqliteValue.SInt(10), SqliteValue.SInt(1)])
        let check1 = executeSql(db, "SELECT counter FROM t WHERE id = 1", Array<SqliteValue>())
        match (check1.rows.getOrThrow().rows[0][0]) {
            case SInt(n) => @Assert(n, 10)
            case _ => @Fail("id=1 did not return INTEGER")
        }

        // 第二次: id=2, +20
        executeStatement(db, stmt, [SqliteValue.SInt(20), SqliteValue.SInt(2)])
        let check2 = executeSql(db, "SELECT counter FROM t WHERE id = 2", Array<SqliteValue>())
        match (check2.rows.getOrThrow().rows[0][0]) {
            case SInt(n) => @Assert(n, 20)
            case _ => @Fail("id=2 did not return INTEGER")
        }

        // 验证 id=1 没被污染
        let recheck1 = executeSql(db, "SELECT counter FROM t WHERE id = 1", Array<SqliteValue>())
        match (recheck1.rows.getOrThrow().rows[0][0]) {
            case SInt(n) => @Assert(n, 10)
            case _ => @Fail("id=1 did not return INTEGER after statement reuse")
        }

        db.close()
    }
}
