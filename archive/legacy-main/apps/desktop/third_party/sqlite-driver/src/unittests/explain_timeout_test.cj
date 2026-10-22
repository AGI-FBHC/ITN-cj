package sqlite_driver.unittests

import sqlite_driver.*
import std.database.sql.*
import std.unittest.*
import std.unittest.testmacro.*

@Test
class ExplainTimeoutTest {
    @TestCase
    func explainReportsRowidIndexAndScanPaths(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, k INTEGER)")
        let _ = conn.execString("CREATE INDEX ix_t_k ON t(k)")
        let rowid = conn.queryString("EXPLAIN QUERY PLAN SELECT v FROM t WHERE id = 1")
        let index = conn.queryString("EXPLAIN QUERY PLAN SELECT v FROM t WHERE k = 1")
        let scan = conn.queryString("EXPLAIN QUERY PLAN SELECT v FROM t")
        match (rowid.rows[0][3]) { case SText(s) => @Expect(s.contains("INTEGER PRIMARY KEY"), true); case _ => @Fail("missing rowid plan") }
        match (index.rows[0][3]) { case SText(s) => @Expect(s.contains("ix_t_k"), true); case _ => @Fail("missing index plan") }
        match (scan.rows[0][3]) { case SText(s) => @Expect(s, "SCAN t"); case _ => @Fail("missing scan plan") }
        try {
            let _ = conn.queryString("EXPLAIN SELECT 1")
            @Fail("bare EXPLAIN should be rejected")
        } catch (e: SqliteSyntaxException) {
            @Expect(e.message.contains("EXPLAIN QUERY PLAN"), true)
        }
        conn.close()
    }

    @TestCase
    func statementTimeoutInterruptsLongScan(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        for (i in 1..1001) {
            let _ = conn.exec("INSERT INTO t(id, v) VALUES (?, ?)", [SqliteValue.SInt(i), SqliteValue.SText("x")])
        }
        let c = SqliteConnection(conn)
        let prepared = (c.prepareStatement("SELECT count(*) FROM t a, t b") as SqliteStatement).getOrThrow()
        prepared.setOption("timeout_ms", "1")
        try {
            let _ = prepared.query()
            @Fail("large cross join should exceed timeout")
        } catch (e: SqliteInterruptedException) {
            @Expect(e.message.contains("timeout"), true)
        }
        c.close()
    }
}
