package sqlite_driver.unittests

import sqlite_driver.*
import std.unittest.*
import std.unittest.testmacro.*

private func valueText(conn: SqliteConn, sql: String): String {
    let rs = conn.queryString(sql)
    match (rs.rows[0][0]) {
        case SText(s) => s
        case SInt(i) => "${i}"
        case SReal(f) => "${f}"
        case SNull => "NULL"
        case v => throw Exception("unexpected value, got ${v}")
    }
}

@Test
class JsonFunctionTest {
    @TestCase
    func extractsScalarsAndContainers(): Unit {
        let conn = newMemConn()
        @Expect(valueText(conn, "SELECT json_extract('{\"a\":1,\"s\":\"x\",\"n\":null,\"v\":[2]}', '$.a')"), "1")
        @Expect(valueText(conn, "SELECT json_extract('{\"a\":1,\"s\":\"x\",\"n\":null,\"v\":[2]}', '$.s')"), "x")
        @Expect(valueText(conn, "SELECT json_extract('{\"a\":1,\"s\":\"x\",\"n\":null,\"v\":[2]}', '$.v')"), "[2]")
        @Expect(valueText(conn, "SELECT json_extract('{\"a\":1,\"b\":2}', '$.a', '$.b')"), "[1,2]")
        @Expect(valueText(conn, "SELECT json_type('{\"a\":true,\"v\":[2]}', '$.a')"), "true")
        @Expect(valueText(conn, "SELECT json_type('{\"a\":true,\"v\":[2]}', '$.v')"), "array")
        conn.close()
    }

    @TestCase
    func constructorsAndArrowsFollowSqliteMapping(): Unit {
        let conn = newMemConn()
        @Expect(valueText(conn, "SELECT json('  {\"a\": 1 }  ')"), "{\"a\":1}")
        @Expect(valueText(conn, "SELECT json_array(NULL, 1, 'x', json('{\"a\":2}'))"), "[null,1,\"x\",{\"a\":2}]")
        @Expect(valueText(conn, "SELECT json_object('a', 1, 'b', json_array(2, 3))"), "{\"a\":1,\"b\":[2,3]}")
        @Expect(valueText(conn, "SELECT '{\"a\":\"x\",\"v\":[10,20]}' -> '$.a'"), "\"x\"")
        @Expect(valueText(conn, "SELECT '{\"a\":\"x\",\"v\":[10,20]}' ->> '$.a'"), "x")
        @Expect(valueText(conn, "SELECT '[10,20]' ->> 1"), "20")
        conn.close()
    }

    @TestCase
    func jsonValidAndMissingValuesAreNull(): Unit {
        let conn = newMemConn()
        let rs = conn.queryString("SELECT json_valid('{'), json_valid(NULL), json_extract('{}', '$.missing')")
        match (rs.rows[0][0]) { case SInt(v) => @Expect(v, 0); case _ => @Fail("json_valid invalid input") }
        match (rs.rows[0][1]) { case SNull => (); case _ => @Fail("json_valid(NULL) should be NULL") }
        match (rs.rows[0][2]) { case SNull => (); case _ => @Fail("missing path should be NULL") }
        conn.close()
    }
}
