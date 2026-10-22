package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.fs.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * VACUUM 与 CREATE TABLE ... AS SELECT。
 *
 * VACUUM 的判据必须同时看两件事: 文件真的变小了, 且变小之后**SQLite 仍能读**。
 * 只看文件大小则一个把库写坏的实现也算通过 (截断本身就让文件变小); 只看能读则一个什么都
 * 不做的空实现也算通过。两条一起才有分辨力。
 */

/** 库文件的字节数。 */
func dbFileSize(path: String): Int64 {
    let f = File(path, OpenMode.Read)
    let n = f.length
    f.close()
    n
}

/** 灌一批行, 每行带一段够长的文本, 让页数明显增长。 */
func fillRows(conn: SqliteConn, count: Int64): Unit {
    let _ = conn.execString("BEGIN")
    for (i in 1..(count + 1)) {
        let _ = conn.execString("INSERT INTO bulk VALUES (${i}, '${padding(i)}')")
    }
    let _ = conn.execString("COMMIT")
}

/** 200 字节左右的可辨识内容, 于是 500 行就要几十页。 */
func padding(i: Int64): String {
    let sb = StringBuilder()
    for (_ in 0..20) {
        sb.append("row${i}-")
    }
    sb.toString()
}

@Test
class VacuumTest {
    @TestCase
    func vacuumShrinksTheFileAndKeepsItReadableByRealSqlite(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE bulk (id INTEGER PRIMARY KEY, payload TEXT)")
            fillRows(conn, 500)
            let grown = dbFileSize(tmp.dbPath)
            // 删掉九成行。页进 freelist, 但文件不缩 —— 这正是 VACUUM 要解决的。
            let _ = conn.execString("DELETE FROM bulk WHERE id > 50")
            let afterDelete = dbFileSize(tmp.dbPath)
            @Expect(afterDelete, grown)
            let _ = conn.execString("VACUUM")
            let afterVacuum = dbFileSize(tmp.dbPath)
            conn.close()
            // 文件确实变小了。
            @Expect(afterVacuum < grown, true)
            // 且 SQLite 仍读得出来, 内容一行不差。
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT count(*) FROM bulk", "[(50,)]") +
                    pythonExpect("SELECT id FROM bulk ORDER BY id LIMIT 3", "[(1,), (2,), (3,)]") + pythonDone(),
                "python could not read the vacuumed database")
        } finally {
            tmp.cleanup()
        }
    }

    @TestCase
    func vacuumPreservesIndexesAndTheirLookups(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, tag TEXT)")
            let _ = conn.execString("CREATE INDEX idx_name ON t (name)")
            let _ = conn.execString("CREATE UNIQUE INDEX idx_tag ON t (tag)")
            let _ = conn.execString("INSERT INTO t VALUES (1, 'alice', 'a'), (2, 'bob', 'b'), (3, 'carol', 'c')")
            let _ = conn.execString("DELETE FROM t WHERE id = 2")
            let _ = conn.execString("VACUUM")
            // 索引仍能用来查, 且唯一性仍在实施。
            @Expect(scalarInt(conn, "SELECT id FROM t WHERE name = 'carol'"), 3)
            try {
                let _ = conn.execString("INSERT INTO t VALUES (4, 'dave', 'a')")
                @Fail("the unique index must still be enforced after VACUUM")
            } catch (e: SqliteConstraintException) {
                @Expect(e.constraint, "unique")
            }
            conn.close()
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT name FROM t ORDER BY name",
                    "[('alice',), ('carol',)]") + pythonDone(), "python found the vacuumed database inconsistent")
        } finally {
            tmp.cleanup()
        }
    }

    @TestCase
    func vacuumKeepsAutoincrementFromReusingRowids(): Unit {
        // sqlite_sequence 必须一起搬。不搬则重建后从头发号, 与已删除的历史行重号 ——
        // AUTOINCREMENT 承诺的正是不重用, 所以这一条是正确性而不是优化。
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE s (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)")
            let _ = conn.execString("INSERT INTO s (v) VALUES ('a'), ('b'), ('c')")
            let _ = conn.execString("DELETE FROM s")
            let _ = conn.execString("VACUUM")
            let _ = conn.execString("INSERT INTO s (v) VALUES ('d')")
            // 前三行用掉 1..3, 所以下一个必须是 4。
            @Expect(scalarInt(conn, "SELECT id FROM s"), 4)
            conn.close()
        } finally {
            tmp.cleanup()
        }
    }

    @TestCase
    func vacuumPreservesUserVersion(): Unit {
        // user_version 是库的身份, VACUUM 不该动它。整头照搬新库则它被清成 0。
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE t (a INT)")
            let _ = conn.execString("PRAGMA user_version = 42")
            let _ = conn.execString("VACUUM")
            @Expect(scalarInt(conn, "PRAGMA user_version"), 42)
            conn.close()
        } finally {
            tmp.cleanup()
        }
    }

    @TestCase
    func vacuumInsideATransactionIsRejected(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (a INT)")
        let _ = conn.execString("BEGIN")
        try {
            let _ = conn.execString("VACUUM")
            @Fail("VACUUM inside a transaction should be rejected")
        } catch (e: SqliteRuntimeException) {
            @Expect(e.message.contains("within a transaction"), true)
        }
        let _ = conn.execString("ROLLBACK")
        conn.close()
    }

    @TestCase
    func vacuumOnMemoryDatabaseKeepsDataIntact(): Unit {
        // 内存库没有文件可缩, 但重建路径本身仍要跑通 —— 它与磁盘库共用同一份代码。
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        let _ = conn.execString("INSERT INTO t VALUES (1, 'x'), (2, 'y'), (3, 'z')")
        let _ = conn.execString("DELETE FROM t WHERE id = 2")
        let _ = conn.execString("VACUUM")
        @Expect(scalarInt(conn, "SELECT count(*) FROM t"), 2)
        @Expect(scalarText(conn, "SELECT v FROM t WHERE id = 3"), "z")
        conn.close()
    }

    @TestCase
    func vacuumIntoIsRejectedRatherThanIgnored(): Unit {
        // 忽略 INTO 会让调用方以为备份已经写出去了, 而实际上没有任何文件生成。
        let conn = newMemConn()
        try {
            let _ = conn.execString("VACUUM INTO 'backup.db'")
            @Fail("VACUUM INTO should be rejected, not silently ignored")
        } catch (e: SqliteSyntaxException) {
            @Expect(e.message.contains("VACUUM INTO"), true)
        }
        conn.close()
    }
}

@Test
class CreateTableAsSelectTest {
    @TestCase
    func copiesRowsAndColumnNames(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE src (id INTEGER PRIMARY KEY, name TEXT)")
        let _ = conn.execString("INSERT INTO src VALUES (1, 'a'), (2, 'b')")
        let _ = conn.execString("CREATE TABLE copy AS SELECT id, name FROM src")
        let rs = conn.queryString("SELECT id, name FROM copy ORDER BY id")
        @Expect(rs.rowCount, 2)
        @Expect(rs.columnNames[0], "id")
        @Expect(rs.columnNames[1], "name")
        @Expect(scalarText(conn, "SELECT name FROM copy WHERE id = 2"), "b")
        conn.close()
    }

    @TestCase
    func appliesTheWhereClauseOfTheSelect(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE src (id INTEGER PRIMARY KEY, n INT)")
        let _ = conn.execString("INSERT INTO src VALUES (1, 10), (2, 20), (3, 30)")
        let _ = conn.execString("CREATE TABLE big AS SELECT id, n FROM src WHERE n >= 20")
        @Expect(scalarInt(conn, "SELECT count(*) FROM big"), 2)
        conn.close()
    }

    @TestCase
    func doesNotInheritConstraintsFromTheSource(): Unit {
        // SQLite 明确不继承约束。继承了则这条 INSERT 会因 NOT NULL 或主键冲突被拒。
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE src (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
        let _ = conn.execString("INSERT INTO src VALUES (1, 'a')")
        let _ = conn.execString("CREATE TABLE copy AS SELECT id, name FROM src")
        let _ = conn.execString("INSERT INTO copy VALUES (1, NULL)")
        let _ = conn.execString("INSERT INTO copy VALUES (1, NULL)")
        // 重复的 id 与 NULL 的 name 都被接受 —— 新表没有那些约束。
        @Expect(scalarInt(conn, "SELECT count(*) FROM copy"), 3)
        conn.close()
    }

    @TestCase
    func inheritsDeclaredTypeOfPlainColumnReferences(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE src (id INTEGER PRIMARY KEY, amount REAL)")
        let _ = conn.execString("INSERT INTO src VALUES (1, 2.5)")
        let _ = conn.execString("CREATE TABLE copy AS SELECT amount FROM src")
        let rs = conn.queryString("PRAGMA table_info(copy)")
        @Expect(rs.rowCount, 1)
        // 声明类型继承过来, 于是亲和性也一致。
        match (rs.rows[0][2]) {
            case SText(s) => @Expect(s.toAsciiUpper(), "REAL")
            case v => @Fail("expected the inherited declared type, got ${v}")
        }
        conn.close()
    }

    @TestCase
    func expressionColumnsAreUntyped(): Unit {
        // 表达式列无声明类型。误把源列类型抄给表达式列则这里读到 INT。
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE src (n INT)")
        let _ = conn.execString("INSERT INTO src VALUES (3)")
        let _ = conn.execString("CREATE TABLE derived AS SELECT n * 2 AS doubled FROM src")
        let rs = conn.queryString("PRAGMA table_info(derived)")
        @Expect(rs.rowCount, 1)
        match (rs.rows[0][1]) {
            case SText(s) => @Expect(s, "doubled")
            case v => @Fail("expected the alias as the column name, got ${v}")
        }
        match (rs.rows[0][2]) {
            case SText(s) => @Expect(s, "")
            case SNull => ()
            case v => @Fail("an expression column must have no declared type, got ${v}")
        }
        @Expect(scalarInt(conn, "SELECT doubled FROM derived"), 6)
        conn.close()
    }

    @TestCase
    func emptyResultStillCreatesTheTable(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE src (id INTEGER PRIMARY KEY, v TEXT)")
        let _ = conn.execString("CREATE TABLE empty_copy AS SELECT id, v FROM src")
        @Expect(scalarInt(conn, "SELECT count(*) FROM empty_copy"), 0)
        // 表在模式里, 列数也对。
        @Expect(conn.queryString("PRAGMA table_info(empty_copy)").rowCount, 2)
        conn.close()
    }

    @TestCase
    func rowidsStartAtOneRegardlessOfSourceRowids(): Unit {
        // 新表没有 INTEGER PRIMARY KEY, rowid 从 1 顺序发 —— 不该沿用源表的 rowid。
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE src (id INTEGER PRIMARY KEY, v TEXT)")
        let _ = conn.execString("INSERT INTO src VALUES (100, 'a'), (200, 'b')")
        let _ = conn.execString("CREATE TABLE copy AS SELECT v FROM src ORDER BY id")
        let rs = conn.queryString("SELECT rowid, v FROM copy ORDER BY rowid")
        @Expect(rs.rowCount, 2)
        match ((rs.rows[0][0], rs.rows[1][0])) {
            case (SInt(a), SInt(b)) =>
                @Expect(a, 1)
                @Expect(b, 2)
            case _ => @Fail("expected rowids 1 and 2")
        }
        conn.close()
    }

    @TestCase
    func aggregateResultBecomesASingleRowTable(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE src (n INT)")
        let _ = conn.execString("INSERT INTO src VALUES (1), (2), (3)")
        let _ = conn.execString("CREATE TABLE summed AS SELECT sum(n) AS total FROM src")
        @Expect(scalarInt(conn, "SELECT total FROM summed"), 6)
        conn.close()
    }

    @TestCase
    func rejectsAnExistingTableNameUnlessIfNotExists(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE src (n INT)")
        let _ = conn.execString("INSERT INTO src VALUES (1)")
        let _ = conn.execString("CREATE TABLE dup AS SELECT n FROM src")
        try {
            let _ = conn.execString("CREATE TABLE dup AS SELECT n FROM src")
            @Fail("creating an existing table again should fail")
        } catch (e: SqliteRuntimeException) {
            @Expect(e.message.contains("already exists"), true)
        }
        // IF NOT EXISTS 则静默跳过, 且不重复灌数据。
        let _ = conn.execString("CREATE TABLE IF NOT EXISTS dup AS SELECT n FROM src")
        @Expect(scalarInt(conn, "SELECT count(*) FROM dup"), 1)
        conn.close()
    }

    @TestCase
    func schemaStoresTheExpandedCreateTableNotTheSelect(): Unit {
        // 存 AS SELECT 原文则重开库要重跑 SELECT, 源表变了列定义就跟着变。
        // 存展开后的形态才让库的形态稳定。
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE src (id INTEGER PRIMARY KEY, v TEXT)")
        let _ = conn.execString("CREATE TABLE copy AS SELECT v FROM src")
        let sql = scalarText(conn, "SELECT sql FROM sqlite_schema WHERE name = 'copy'")
        @Expect(sql.toAsciiUpper().contains("SELECT"), false)
        @Expect(sql.toAsciiUpper().startsWith("CREATE TABLE"), true)
        conn.close()
    }

    @TestCase
    func survivesReopenBecauseTheStoredSqlReparses(): Unit {
        // 上一例断言存的是展开形态; 这一例确认那段文本真的能重新解析出同样的表。
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE src (id INTEGER PRIMARY KEY, v TEXT)")
            let _ = conn.execString("INSERT INTO src VALUES (1, 'kept')")
            let _ = conn.execString("CREATE TABLE copy AS SELECT v FROM src")
            conn.close()
            let again = openFileConn(tmp.dbPath)
            @Expect(scalarText(again, "SELECT v FROM copy"), "kept")
            again.close()
        } finally {
            tmp.cleanup()
        }
    }
}
