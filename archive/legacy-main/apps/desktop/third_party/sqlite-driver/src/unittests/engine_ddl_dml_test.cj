package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * DDL 与基础 DML。
 *
 * 用对外 API (SqliteConn) 而不是引擎内部对象: 引擎类型是包私有的, 测试放在子包里拿不到。
 * 这也让测试覆盖到"参数绑定 + 语句分发"这一层, 而不只是引擎语义。
 */

/** 取单行单列的整数值, 简化断言。 */
func scalarInt(conn: SqliteConn, sql: String): Int64 {
    let rs = conn.queryString(sql)
    if (rs.rowCount != 1) {
        throw Exception("expected exactly one row from '${sql}', got ${rs.rowCount}")
    }
    match (rs.rows[0][0]) {
        case SInt(i) => i
        case v => throw Exception("expected an integer from '${sql}', got ${v}")
    }
}

func scalarText(conn: SqliteConn, sql: String): String {
    let rs = conn.queryString(sql)
    if (rs.rowCount != 1) {
        throw Exception("expected exactly one row from '${sql}', got ${rs.rowCount}")
    }
    match (rs.rows[0][0]) {
        case SText(s) => s
        case SNull => "<null>"
        case v => throw Exception("expected text from '${sql}', got ${v}")
    }
}

@Test
class EngineDdlTest {
    @TestCase
    func createTableThenQueryEmpty(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
        let rs = conn.queryString("SELECT id, name FROM users")
        @Expect(rs.rowCount, 0)
        @Expect(rs.columnNames.size, 2)
        @Expect(rs.columnNames[0], "id")
        @Expect(rs.columnNames[1], "name")
        conn.close()
    }

    @TestCase
    func createTableIfNotExistsIsIdempotent(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (a INT)")
        let _ = conn.execString("CREATE TABLE IF NOT EXISTS t (a INT)")
        // 第二次不报错, 且表仍只有一张。
        @Expect(scalarInt(conn, "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='t'"), 1)
        conn.close()
    }

    @TestCase
    func createTableTwiceWithoutIfNotExistsFails(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (a INT)")
        try {
            let _ = conn.execString("CREATE TABLE t (a INT)")
            @Fail("creating the same table twice should be rejected")
        } catch (e: SqliteRuntimeException) {
            @Expect(e.message.contains("already exists"), true)
        }
        conn.close()
    }

    @TestCase
    func dropTableRemovesItFromSchema(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (a INT)")
        let _ = conn.execString("DROP TABLE t")
        @Expect(scalarInt(conn, "SELECT count(*) FROM sqlite_schema WHERE name='t'"), 0)
        try {
            let _ = conn.queryString("SELECT * FROM t")
            @Fail("querying a dropped table should fail")
        } catch (e: SqliteRuntimeException) {
            @Expect(e.message.contains("no such table"), true)
        }
        conn.close()
    }

    @TestCase
    func dropTableIfExistsOnMissingTableSucceeds(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("DROP TABLE IF EXISTS nothing_here")
        conn.close()
    }

    @TestCase
    func schemaSurvivesReloadWithinConnection(): Unit {
        // 模式缓存靠 schema_cookie 判定失效; 建表后立刻查应看到新表。
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE a (x INT)")
        let _ = conn.execString("CREATE TABLE b (y TEXT)")
        @Expect(scalarInt(conn, "SELECT count(*) FROM sqlite_schema WHERE type='table'"), 2)
        conn.close()
    }

    @TestCase
    func alterTableRenameKeepsData(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE old_name (id INTEGER PRIMARY KEY, v TEXT)")
        let _ = conn.execString("INSERT INTO old_name(v) VALUES ('kept')")
        let _ = conn.execString("ALTER TABLE old_name RENAME TO new_name")
        @Expect(scalarText(conn, "SELECT v FROM new_name"), "kept")
        conn.close()
    }

    @TestCase
    func alterTableAddColumnFillsNullForExistingRows(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)")
        let _ = conn.execString("INSERT INTO t(a) VALUES ('before')")
        let _ = conn.execString("ALTER TABLE t ADD COLUMN b TEXT")
        // 已有行的新列是 NULL —— 新列没有历史值可填。
        let rs = conn.queryString("SELECT a, b FROM t")
        @Expect(rs.rowCount, 1)
        match (rs.rows[0][1]) {
            case SNull => ()
            case v => @Fail("the added column should be NULL for pre-existing rows, got ${v}")
        }
        conn.close()
    }

    @TestCase
    func alterTableRenameColumnUpdatesQueries(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, old_col TEXT)")
        let _ = conn.execString("INSERT INTO t(old_col) VALUES ('v')")
        let _ = conn.execString("ALTER TABLE t RENAME COLUMN old_col TO new_col")
        @Expect(scalarText(conn, "SELECT new_col FROM t"), "v")
        conn.close()
    }

    @TestCase
    func pragmaTableInfoDescribesColumns(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL DEFAULT 1.5)")
        let rs = conn.queryString("PRAGMA table_info(t)")
        @Expect(rs.rowCount, 3)
        // 列: cid, name, type, notnull, dflt_value, pk
        @Expect(rs.value(0, "name"), SqliteValue.SText("id"))
        @Expect(rs.value(0, "pk"), SqliteValue.SInt(1))
        @Expect(rs.value(1, "notnull"), SqliteValue.SInt(1))
        @Expect(rs.value(2, "type"), SqliteValue.SText("REAL"))
        conn.close()
    }

    @TestCase
    func pragmaTableInfoOnMissingTableIsEmpty(): Unit {
        // 空集而不是报错: 上层用它做存在性探测。
        let conn = newMemConn()
        let rs = conn.queryString("PRAGMA table_info(no_such_table)")
        @Expect(rs.rowCount, 0)
        conn.close()
    }

    @TestCase
    func unknownPragmaIsIgnored(): Unit {
        // 上层的连接初始化会发一批 pragma, 报错会让连接建不起来。
        let conn = newMemConn()
        let _ = conn.execString("PRAGMA cache_size = -8000")
        let _ = conn.execString("PRAGMA synchronous = FULL")
        conn.close()
    }

    @TestCase
    func userVersionRoundTrips(): Unit {
        let conn = newMemConn()
        @Expect(scalarInt(conn, "PRAGMA user_version"), 0)
        let _ = conn.execString("PRAGMA user_version = 42")
        @Expect(scalarInt(conn, "PRAGMA user_version"), 42)
        conn.close()
    }
}

@Test
class EngineInsertTest {
    @TestCase
    func insertAssignsSequentialRowids(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        let _ = conn.execString("INSERT INTO t(v) VALUES ('a')")
        let _ = conn.execString("INSERT INTO t(v) VALUES ('b')")
        let rs = conn.queryString("SELECT id, v FROM t ORDER BY id")
        @Expect(rs.rowCount, 2)
        @Expect(rs.rows[0][0], SqliteValue.SInt(1))
        @Expect(rs.rows[1][0], SqliteValue.SInt(2))
        conn.close()
    }

    @TestCase
    func integerPrimaryKeyReadsBackAsRowidNotNull(): Unit {
        // rowid 别名列在 record 里存 NULL, 解码时必须填回 rowid。不填则该列全是 NULL。
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        let _ = conn.execString("INSERT INTO t(id, v) VALUES (7, 'x')")
        @Expect(scalarInt(conn, "SELECT id FROM t"), 7)
        conn.close()
    }

    @TestCase
    func insertMultipleRowsInOneStatement(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (a INT, b INT)")
        let affected = conn.execString("INSERT INTO t(a, b) VALUES (1, 2), (3, 4), (5, 6)")
        @Expect(affected, 3)
        @Expect(scalarInt(conn, "SELECT count(*) FROM t"), 3)
        @Expect(scalarInt(conn, "SELECT sum(a + b) FROM t"), 21)
        conn.close()
    }

    @TestCase
    func insertWithParameterBinding(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL)")
        let params: Array<SqliteValue> = [SqliteValue.SText("alice"), SqliteValue.SReal(93.5)]
        let _ = conn.exec("INSERT INTO t(name, score) VALUES (?, ?)", params)
        @Expect(scalarText(conn, "SELECT name FROM t"), "alice")
        let rs = conn.queryString("SELECT score FROM t")
        @Expect(rs.rows[0][0], SqliteValue.SReal(93.5))
        conn.close()
    }

    @TestCase
    func insertSelectCopiesRows(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE src (a INT)")
        let _ = conn.execString("CREATE TABLE dst (a INT)")
        let _ = conn.execString("INSERT INTO src(a) VALUES (1), (2), (3)")
        let affected = conn.execString("INSERT INTO dst(a) SELECT a FROM src WHERE a > 1")
        @Expect(affected, 2)
        @Expect(scalarInt(conn, "SELECT sum(a) FROM dst"), 5)
        conn.close()
    }

    @TestCase
    func insertDefaultValuesUsesColumnDefaults(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, n INT DEFAULT 9, s TEXT DEFAULT 'd')")
        let _ = conn.execString("INSERT INTO t DEFAULT VALUES")
        @Expect(scalarInt(conn, "SELECT n FROM t"), 9)
        @Expect(scalarText(conn, "SELECT s FROM t"), "d")
        conn.close()
    }

    @TestCase
    func omittedColumnsGetDefaults(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (a INT, b INT DEFAULT 5)")
        let _ = conn.execString("INSERT INTO t(a) VALUES (1)")
        @Expect(scalarInt(conn, "SELECT b FROM t"), 5)
        conn.close()
    }

    @TestCase
    func lastInsertRowidTracksMostRecentInsert(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, v INT)")
        let _ = conn.execString("INSERT INTO t(v) VALUES (10)")
        @Expect(conn.lastInsertRowid, 1)
        let _ = conn.execString("INSERT INTO t(id, v) VALUES (100, 20)")
        @Expect(conn.lastInsertRowid, 100)
        conn.close()
    }

    @TestCase
    func insertColumnCountMismatchIsRejected(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (a INT, b INT)")
        try {
            let _ = conn.execString("INSERT INTO t(a, b) VALUES (1)")
            @Fail("a value-count mismatch should be rejected")
        } catch (e: SqliteRuntimeException) {
            @Expect(e.message.contains("column"), true)
        }
        conn.close()
    }

    @TestCase
    func insertIntoUnknownColumnIsRejected(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (a INT)")
        try {
            let _ = conn.execString("INSERT INTO t(nope) VALUES (1)")
            @Fail("inserting into a nonexistent column should be rejected")
        } catch (e: SqliteRuntimeException) {
            @Expect(e.message.contains("no column named"), true)
        }
        conn.close()
    }

    @TestCase
    func autoincrementDoesNotReuseDeletedRowids(): Unit {
        // 这是 AUTOINCREMENT 与普通 rowid 的唯一区别: 删掉最大行后, 普通表会复用那个号。
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v INT)")
        let _ = conn.execString("INSERT INTO t(v) VALUES (1)")
        let _ = conn.execString("INSERT INTO t(v) VALUES (2)")
        let _ = conn.execString("DELETE FROM t WHERE id = 2")
        let _ = conn.execString("INSERT INTO t(v) VALUES (3)")
        @Expect(scalarInt(conn, "SELECT id FROM t WHERE v = 3"), 3)
        conn.close()
    }

    @TestCase
    func plainRowidReusesDeletedMaximum(): Unit {
        // 对照组: 无 AUTOINCREMENT 时确实复用。没有这一条, 上一条测不出区别。
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, v INT)")
        let _ = conn.execString("INSERT INTO t(v) VALUES (1)")
        let _ = conn.execString("INSERT INTO t(v) VALUES (2)")
        let _ = conn.execString("DELETE FROM t WHERE id = 2")
        let _ = conn.execString("INSERT INTO t(v) VALUES (3)")
        @Expect(scalarInt(conn, "SELECT id FROM t WHERE v = 3"), 2)
        conn.close()
    }

    @TestCase
    func textInIntegerPrimaryKeyIsRejected(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, v INT)")
        try {
            let _ = conn.execString("INSERT INTO t(id, v) VALUES ('abc', 1)")
            @Fail("text in an INTEGER PRIMARY KEY should be rejected")
        } catch (e: SqliteConstraintException) {
            @Expect(e.constraint, "datatype")
        }
        conn.close()
    }
}

@Test
class EngineUpdateDeleteTest {
    @TestCase
    func updateChangesMatchingRowsOnly(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, v INT)")
        let _ = conn.execString("INSERT INTO t(v) VALUES (1), (2), (3)")
        let affected = conn.execString("UPDATE t SET v = v * 10 WHERE v >= 2")
        @Expect(affected, 2)
        @Expect(scalarInt(conn, "SELECT sum(v) FROM t"), 51)
        conn.close()
    }

    @TestCase
    func updateWithoutWhereTouchesEveryRow(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (v INT)")
        let _ = conn.execString("INSERT INTO t(v) VALUES (1), (2)")
        let affected = conn.execString("UPDATE t SET v = 7")
        @Expect(affected, 2)
        @Expect(scalarInt(conn, "SELECT sum(v) FROM t"), 14)
        conn.close()
    }

    @TestCase
    func updateSwapsColumnsUsingOldValues(): Unit {
        // SET 右侧看到的必须是旧值 —— 顺序求值会让两列都变成 b 的旧值。
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (a INT, b INT)")
        let _ = conn.execString("INSERT INTO t(a, b) VALUES (1, 2)")
        let _ = conn.execString("UPDATE t SET a = b, b = a")
        let rs = conn.queryString("SELECT a, b FROM t")
        @Expect(rs.rows[0][0], SqliteValue.SInt(2))
        @Expect(rs.rows[0][1], SqliteValue.SInt(1))
        conn.close()
    }

    @TestCase
    func updateShiftingRowidsDoesNotProcessRowTwice(): Unit {
        // 边扫边改会让改过 rowid 的行落到游标前方被二次处理, 表现为 id 全被推到末尾。
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY)")
        let _ = conn.execString("INSERT INTO t(id) VALUES (1), (2), (3)")
        let affected = conn.execString("UPDATE t SET id = id + 10")
        @Expect(affected, 3)
        let rs = conn.queryString("SELECT id FROM t ORDER BY id")
        @Expect(rs.rowCount, 3)
        @Expect(rs.rows[0][0], SqliteValue.SInt(11))
        @Expect(rs.rows[1][0], SqliteValue.SInt(12))
        @Expect(rs.rows[2][0], SqliteValue.SInt(13))
        conn.close()
    }

    @TestCase
    func deleteRemovesMatchingRows(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (v INT)")
        let _ = conn.execString("INSERT INTO t(v) VALUES (1), (2), (3), (4)")
        let affected = conn.execString("DELETE FROM t WHERE v % 2 = 0")
        @Expect(affected, 2)
        @Expect(scalarInt(conn, "SELECT sum(v) FROM t"), 4)
        conn.close()
    }

    @TestCase
    func deleteWithoutWhereEmptiesTable(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (v INT)")
        let _ = conn.execString("INSERT INTO t(v) VALUES (1), (2)")
        let affected = conn.execString("DELETE FROM t")
        @Expect(affected, 2)
        @Expect(scalarInt(conn, "SELECT count(*) FROM t"), 0)
        conn.close()
    }

    @TestCase
    func updateUnknownColumnFailsBeforeTouchingRows(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (a INT)")
        let _ = conn.execString("INSERT INTO t(a) VALUES (1)")
        try {
            let _ = conn.execString("UPDATE t SET nope = 2")
            @Fail("updating a nonexistent column should be rejected")
        } catch (e: SqliteRuntimeException) {
            @Expect(e.message.contains("no column named"), true)
        }
        // 原值未变。
        @Expect(scalarInt(conn, "SELECT a FROM t"), 1)
        conn.close()
    }

    @TestCase
    func changesReflectsLastStatement(): Unit {
        let conn = newMemConn()
        let _ = conn.execString("CREATE TABLE t (v INT)")
        let _ = conn.execString("INSERT INTO t(v) VALUES (1), (2), (3)")
        @Expect(conn.changes, 3)
        let _ = conn.execString("DELETE FROM t WHERE v = 1")
        @Expect(conn.changes, 1)
        conn.close()
    }
}
