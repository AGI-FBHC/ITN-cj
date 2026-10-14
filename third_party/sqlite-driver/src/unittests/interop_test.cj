package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 与 SQLite 的双向文件兼容性。
 *
 * 正向（驱动写入、SQLite 读取）用于发现文件头字段陈旧等内部自检无法识别的缺陷。
 *
 * 反向（SQLite 写入、驱动读取）覆盖溢出链、索引树和各类 serial type 的解析路径。
 */
@Test
class InteropForwardTest {
    /**
     * 最小正向判据: 建表 + 单独一条 INSERT。
     *
     * 这两条语句走的是两个隐式事务。第二个事务只动数据页, 不动第 1 页 —— 于是它是否把
     * 文件头一起落盘，决定了独立读取器能否打开这个库。
     */
    @TestCase
    func driverWrittenDatabaseOpensInPython(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
            let _ = conn.execString("INSERT INTO t(v) VALUES ('alpha')")
            conn.close()
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT id, v FROM t", "[(1, 'alpha')]") +
                    pythonDone(), "python could not read a database written by the driver")
        } finally {
            tmp.cleanup()
        }
    }

    /**
     * 多页表: 行数足以让 B-tree 分裂出内节点。
     *
     * 页数增长全部发生在只动数据页的事务里, 所以头里的 db_size 必须跟着走。头停在旧值时
     * 独立读取器会沿内节点子页号读到文件末尾之外，并判定为 malformed。
     */
    @TestCase
    func multiPageTableRemainsReadableByPython(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE big (id INTEGER PRIMARY KEY, pad TEXT)")
            let _ = conn.execString("BEGIN")
            for (i in 1..401) {
                let _ = conn.exec("INSERT INTO big(id, pad) VALUES (?, ?)",
                    [SqliteValue.SInt(i), SqliteValue.SText(repeatText("x", 200))])
            }
            let _ = conn.execString("COMMIT")
            conn.close()
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT count(*) FROM big", "[(400,)]") +
                    pythonExpect("SELECT id FROM big ORDER BY id LIMIT 1", "[(1,)]") + pythonExpect(
                    "SELECT id FROM big ORDER BY id DESC LIMIT 1", "[(400,)]") + pythonExpect(
                    "SELECT length(pad) FROM big WHERE id = 200", "[(200,)]") + pythonDone(),
                "python could not read a multi-page table written by the driver")
        } finally {
            tmp.cleanup()
        }
    }

    /** 溢出行: 单个值远超一页, 走溢出页链。 */
    @TestCase
    func overflowRowRemainsReadableByPython(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT)")
            let big = repeatText("abcdefghij", 1600)
            let _ = conn.exec("INSERT INTO docs(body) VALUES (?)", [SqliteValue.SText(big)])
            conn.close()
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT length(body) FROM docs",
                    "[(16000,)]") + pythonExpect("SELECT substr(body, 1, 10) FROM docs", "[('abcdefghij',)]") +
                    pythonExpect("SELECT substr(body, 15991, 10) FROM docs", "[('abcdefghij',)]") + pythonDone(),
                "python could not read an overflow row written by the driver")
        } finally {
            tmp.cleanup()
        }
    }

    /** 索引树：独立完整性检查会校验索引与表的一致性。 */
    @TestCase
    func indexedTableRemainsReadableByPython(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, age INT)")
            let _ = conn.execString("CREATE INDEX idx_people_name ON people(name)")
            let _ = conn.execString("CREATE UNIQUE INDEX idx_people_age ON people(age)")
            let _ = conn.execString("INSERT INTO people(name, age) VALUES ('carol', 31)")
            let _ = conn.execString("INSERT INTO people(name, age) VALUES ('alice', 29)")
            let _ = conn.execString("INSERT INTO people(name, age) VALUES ('bob', 42)")
            conn.close()
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT name FROM people ORDER BY name",
                    "[('alice',), ('bob',), ('carol',)]") + pythonExpect("SELECT name FROM people WHERE age = 42",
                    "[('bob',)]") + pythonExpect("SELECT count(*) FROM sqlite_master WHERE type = 'index'", "[(2,)]") +
                    pythonDone(), "python could not read an indexed table written by the driver")
        } finally {
            tmp.cleanup()
        }
    }

    /**
     * 删行后再写: freelist 的头字段必须落盘。
     *
     * freelist_trunk / freelist_count 陈旧时, 被 DROP/DELETE 释放的页既不在链上也不在任何
     * 树里，独立完整性检查会把它报告为 "Page N is never used"。
     */
    @TestCase
    func deleteThenInsertKeepsFreelistConsistentForPython(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE churn (id INTEGER PRIMARY KEY, pad TEXT)")
            let _ = conn.execString("BEGIN")
            for (i in 1..201) {
                let _ = conn.exec("INSERT INTO churn(id, pad) VALUES (?, ?)",
                    [SqliteValue.SInt(i), SqliteValue.SText(repeatText("y", 300))])
            }
            let _ = conn.execString("COMMIT")
            let _ = conn.execString("DELETE FROM churn WHERE id <= 150")
            let _ = conn.exec("INSERT INTO churn(id, pad) VALUES (?, ?)",
                [SqliteValue.SInt(9001), SqliteValue.SText("after-delete")])
            conn.close()
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT count(*) FROM churn", "[(51,)]") +
                    pythonExpect("SELECT pad FROM churn WHERE id = 9001", "[('after-delete',)]") + pythonDone(),
                "python could not read a database after deletes and reuse")
        } finally {
            tmp.cleanup()
        }
    }

    /** DROP TABLE 释放的页同样要记进 freelist 并落盘。 */
    @TestCase
    func droppedTablePagesAreAccountedForPython(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE keep (id INTEGER PRIMARY KEY, v TEXT)")
            let _ = conn.execString("CREATE TABLE gone (id INTEGER PRIMARY KEY, pad TEXT)")
            let _ = conn.execString("BEGIN")
            for (i in 1..121) {
                let _ = conn.exec("INSERT INTO gone(id, pad) VALUES (?, ?)",
                    [SqliteValue.SInt(i), SqliteValue.SText(repeatText("z", 400))])
            }
            let _ = conn.execString("COMMIT")
            let _ = conn.execString("INSERT INTO keep(v) VALUES ('survivor')")
            let _ = conn.execString("DROP TABLE gone")
            conn.close()
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT v FROM keep", "[('survivor',)]") +
                    pythonExpect("SELECT count(*) FROM sqlite_master WHERE name = 'gone'", "[(0,)]") + pythonDone(),
                "python could not read a database after DROP TABLE")
        } finally {
            tmp.cleanup()
        }
    }

    /**
     * savepoint 回滚后再提交。
     *
     * 回滚会把头恢复成 savepoint 时的快照, 之后的提交必须写出**恢复后**的头, 而不是
     * 回滚前那个更大的 db_size。
     */
    @TestCase
    func savepointRollbackThenCommitStaysReadable(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE sp (id INTEGER PRIMARY KEY, v TEXT)")
            let _ = conn.execString("BEGIN")
            let _ = conn.execString("INSERT INTO sp(v) VALUES ('kept')")
            let _ = conn.execString("SAVEPOINT s1")
            for (i in 1..101) {
                let _ = conn.exec("INSERT INTO sp(v) VALUES (?)", [SqliteValue.SText(repeatText("w", 500))])
            }
            let _ = conn.execString("ROLLBACK TO s1")
            let _ = conn.execString("INSERT INTO sp(v) VALUES ('after-rollback')")
            let _ = conn.execString("COMMIT")
            conn.close()
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT v FROM sp ORDER BY id",
                    "[('kept',), ('after-rollback',)]") + pythonDone(),
                "python could not read a database after a savepoint rollback")
        } finally {
            tmp.cleanup()
        }
    }

    /** 空表也要能被独立读取器打开，因为建表本身会修改模式与文件头。 */
    @TestCase
    func emptyTableDatabaseOpensInPython(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE empty_one (a INT, b TEXT)")
            conn.close()
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT count(*) FROM empty_one",
                    "[(0,)]") + pythonExpect("SELECT name FROM sqlite_master WHERE type = 'table'", "[('empty_one',)]") +
                    pythonDone(), "python could not read a database holding only an empty table")
        } finally {
            tmp.cleanup()
        }
    }

    /** 五种存储类往返: 整数、浮点、文本、BLOB、NULL。 */
    @TestCase
    func allStorageClassesSurviveRoundTripToPython(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE mixed (i INTEGER, r REAL, t TEXT, b BLOB, n TEXT)")
            let _ = conn.exec("INSERT INTO mixed(i, r, t, b, n) VALUES (?, ?, ?, ?, ?)",
                [SqliteValue.SInt(-9007199254740993), SqliteValue.SReal(3.5), SqliteValue.SText("héllo"),
                    SqliteValue.SBlob([0u8, 1u8, 254u8, 255u8]), SqliteValue.SNull])
            conn.close()
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT i, r, t, n FROM mixed",
                    "[(-9007199254740993, 3.5, 'h\\u00e9llo', None)]") + pythonExpect("SELECT hex(b) FROM mixed",
                    "[('0001FEFF',)]") + pythonExpect(
                    "SELECT typeof(i), typeof(r), typeof(t), typeof(b), typeof(n) FROM mixed",
                    "[('integer', 'real', 'text', 'blob', 'null')]") + pythonDone(),
                "python did not see the same values the driver stored")
        } finally {
            tmp.cleanup()
        }
    }

    /** 文件头记录的页数必须与文件实际长度一致。 */
    @TestCase
    func headerPageCountMatchesFileLength(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("CREATE TABLE hdr (id INTEGER PRIMARY KEY, pad TEXT)")
            let _ = conn.execString("BEGIN")
            for (i in 1..151) {
                let _ = conn.exec("INSERT INTO hdr(id, pad) VALUES (?, ?)",
                    [SqliteValue.SInt(i), SqliteValue.SText(repeatText("q", 350))])
            }
            let _ = conn.execString("COMMIT")
            conn.close()
            // 直接读头部 28..31 的 db_size, 与文件长度/页大小比。
            expectPythonOk(
                "import os, struct, sys\n" + "raw = open('${tmp.dbPath}', 'rb').read(100)\n" +
                    "page_size = struct.unpack('>H', raw[16:18])[0] or 65536\n" +
                    "db_size = struct.unpack('>I', raw[28:32])[0]\n" +
                    "actual = os.path.getsize('${tmp.dbPath}') // page_size\n" +
                    "if db_size != actual: raise SystemExit('header db_size=%d but file holds %d pages' % (db_size, actual))\n" +
                    "sys.stdout.write('OK')\n", "the header page count does not match the file length")
        } finally {
            tmp.cleanup()
        }
    }
}

@Test
class InteropReverseTest {
    /** SQLite 建库后由驱动读取。 */
    @TestCase
    func pythonWrittenDatabaseOpensInDriver(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            expectPythonOk(
                pythonOpen(tmp.dbPath) + "cur.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')\n" +
                    "cur.execute(\"INSERT INTO t(v) VALUES ('from-python')\")\n" +
                    "cur.execute(\"INSERT INTO t(v) VALUES ('second')\")\n" + pythonDone(),
                "python could not create the fixture database")
            let conn = openFileConn(tmp.dbPath)
            let rs = conn.queryString("SELECT id, v FROM t ORDER BY id")
            @Expect(rs.rowCount, 2)
            @Expect(textOf(rs.rows[0][1]), "from-python")
            @Expect(textOf(rs.rows[1][1]), "second")
            @Expect(scalarText(conn, "SELECT group_concat(v, '|') FROM t"), "from-python|second")
            conn.close()
        } finally {
            tmp.cleanup()
        }
    }

    /** 驱动应能读取 SQLite 写入的溢出行与索引。 */
    @TestCase
    func pythonOverflowAndIndexReadableByDriver(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            expectPythonOk(
                pythonOpen(tmp.dbPath) +
                    "cur.execute('CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT, tag TEXT)')\n" +
                    "cur.execute('CREATE INDEX idx_docs_tag ON docs(tag)')\n" +
                    "cur.execute('INSERT INTO docs(body, tag) VALUES (?, ?)', ('m' * 20000, 'big'))\n" +
                    "cur.execute('INSERT INTO docs(body, tag) VALUES (?, ?)', ('small', 'tiny'))\n" + pythonDone(),
                "python could not create the overflow fixture")
            let conn = openFileConn(tmp.dbPath)
            @Expect(scalarInt(conn, "SELECT length(body) FROM docs WHERE tag = 'big'"), 20000)
            @Expect(scalarText(conn, "SELECT body FROM docs WHERE tag = 'tiny'"), "small")
            @Expect(scalarInt(conn, "SELECT count(*) FROM docs"), 2)
            @Expect(scalarText(conn, "PRAGMA integrity_check"), "ok")
            conn.close()
        } finally {
            tmp.cleanup()
        }
    }

    /** 驱动应能完整扫描 SQLite 写入的多页表及其内节点。 */
    @TestCase
    func pythonMultiPageTableReadableByDriver(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            expectPythonOk(
                pythonOpen(tmp.dbPath) + "cur.execute('CREATE TABLE big (id INTEGER PRIMARY KEY, pad TEXT)')\n" +
                    "cur.executemany('INSERT INTO big(id, pad) VALUES (?, ?)', " +
                    "[(i, 'p' * 250) for i in range(1, 501)])\n" + pythonDone(),
                "python could not create the multi-page fixture")
            let conn = openFileConn(tmp.dbPath)
            @Expect(scalarInt(conn, "SELECT count(*) FROM big"), 500)
            @Expect(scalarInt(conn, "SELECT sum(id) FROM big"), 125250)
            @Expect(scalarInt(conn, "SELECT id FROM big ORDER BY id DESC LIMIT 1"), 500)
            @Expect(scalarText(conn, "PRAGMA integrity_check"), "ok")
            conn.close()
        } finally {
            tmp.cleanup()
        }
    }

    /** 各 serial type 的解码: 1/2/3/4/6/8 字节整数、浮点、0 与 1 的特例。 */
    @TestCase
    func pythonSerialTypesDecodeInDriver(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            expectPythonOk(
                pythonOpen(tmp.dbPath) + "cur.execute('CREATE TABLE st (k TEXT, v)')\n" +
                    "vals = [('zero', 0), ('one', 1), ('i8', 100), ('i16', 30000), " +
                    "('i24', 8000000), ('i32', 2000000000), ('i48', 100000000000), " +
                    "('i64', 4000000000000000000), ('neg', -4000000000000000000), " +
                    "('real', 2.718281828459045), ('text', 'plain'), ('empty', '')]\n" +
                    "cur.executemany('INSERT INTO st(k, v) VALUES (?, ?)', vals)\n" +
                    "cur.execute('INSERT INTO st(k, v) VALUES (?, ?)', ('blob', memoryview(b'\\\\x00\\\\xff')))\n" +
                    "cur.execute('INSERT INTO st(k, v) VALUES (?, ?)', ('null', None))\n" + pythonDone(),
                "python could not create the serial-type fixture")
            let conn = openFileConn(tmp.dbPath)
            @Expect(scalarInt(conn, "SELECT v FROM st WHERE k = 'zero'"), 0)
            @Expect(scalarInt(conn, "SELECT v FROM st WHERE k = 'one'"), 1)
            @Expect(scalarInt(conn, "SELECT v FROM st WHERE k = 'i8'"), 100)
            @Expect(scalarInt(conn, "SELECT v FROM st WHERE k = 'i16'"), 30000)
            @Expect(scalarInt(conn, "SELECT v FROM st WHERE k = 'i24'"), 8000000)
            @Expect(scalarInt(conn, "SELECT v FROM st WHERE k = 'i32'"), 2000000000)
            @Expect(scalarInt(conn, "SELECT v FROM st WHERE k = 'i48'"), 100000000000)
            @Expect(scalarInt(conn, "SELECT v FROM st WHERE k = 'i64'"), 4000000000000000000)
            @Expect(scalarInt(conn, "SELECT v FROM st WHERE k = 'neg'"), -4000000000000000000)
            @Expect(scalarText(conn, "SELECT typeof(v) FROM st WHERE k = 'real'"), "real")
            @Expect(scalarText(conn, "SELECT v FROM st WHERE k = 'text'"), "plain")
            @Expect(scalarText(conn, "SELECT v FROM st WHERE k = 'empty'"), "")
            @Expect(scalarText(conn, "SELECT typeof(v) FROM st WHERE k = 'blob'"), "blob")
            @Expect(scalarText(conn, "SELECT typeof(v) FROM st WHERE k = 'null'"), "null")
            conn.close()
        } finally {
            tmp.cleanup()
        }
    }

    /** 驱动修改 SQLite 创建的数据库后，文件仍应可被再次读取。 */
    @TestCase
    func driverModifiesPythonDatabaseThenPythonReadsBack(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            expectPythonOk(
                pythonOpen(tmp.dbPath) +
                    "cur.execute('CREATE TABLE shared (id INTEGER PRIMARY KEY, owner TEXT, n INT)')\n" +
                    "cur.execute(\"INSERT INTO shared(owner, n) VALUES ('python', 1)\")\n" + pythonDone(),
                "python could not create the shared fixture")
            let conn = openFileConn(tmp.dbPath)
            let _ = conn.execString("INSERT INTO shared(owner, n) VALUES ('driver', 2)")
            let _ = conn.execString("UPDATE shared SET n = n * 10 WHERE owner = 'python'")
            let _ = conn.execString("CREATE INDEX idx_shared_owner ON shared(owner)")
            conn.close()
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect(
                    "SELECT owner, n FROM shared ORDER BY id", "[('python', 10), ('driver', 2)]") + pythonExpect(
                    "SELECT count(*) FROM sqlite_master WHERE name = 'idx_shared_owner'", "[(1,)]") + pythonDone(),
                "python could not read back its own database after the driver modified it")
        } finally {
            tmp.cleanup()
        }
    }
}

/** 重复一段文本 n 次。 */
func repeatText(unit: String, times: Int64): String {
    let sb = StringBuilder()
    for (_ in 0..times) {
        sb.append(unit)
    }
    sb.toString()
}

/** 取文本值; 非文本时抛, 让断言消息指向真正的问题。 */
func textOf(v: SqliteValue): String {
    match (v) {
        case SText(s) => s
        case other => throw Exception("expected a text value, got ${other}")
    }
}
