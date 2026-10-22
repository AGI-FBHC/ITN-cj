package sqlite_driver.unittests

import std.unittest.*
import std.unittest.testmacro.*

/*
 * 主键唯一性的执行 (rowid 表)。
 *
 * 这一组守的是一条容易被漏掉的形态: **单列非 INTEGER 主键**。它不是 rowid 的别名, 所以
 * 表树的键管不到它; 唯一性只能靠一个自动索引 (sqlite_autoindex_…) 来保证。没有那个索引时
 * 重复主键会被静默接受 —— 表能读能写, 只是主键不再唯一, 而这要到有人按主键查出两行时才发现。
 *
 * 三条"允许"的用例与三条"拒绝"的用例必须成对存在: 主键在 rowid 表里的空值规则与
 * WITHOUT ROWID 相反 —— 这里 NULL 是**允许**的, 而且允许多行 NULL (NULL 不等于 NULL,
 * 所以它们不参与唯一判定)。只写拒绝用例的话, 把主键实现成隐式 NOT NULL 这个错没有判据能拦。
 */
let PK_TABLE: Array<String> = ["CREATE TABLE t(a TEXT PRIMARY KEY, b INT)"]

@Test
class PrimaryKeyUniquenessTest {
    @TestCase
    func aSingleColumnTextPrimaryKeyRejectsDuplicates(): Unit {
        expectBothReject(PK_TABLE, "INSERT INTO t VALUES ('k',1),('k',2)",
            "two rows with the same single-column TEXT primary key")
    }

    @TestCase
    func aSingleColumnIntPrimaryKeyRejectsDuplicates(): Unit {
        // 声明类型是 INT 而不是 INTEGER, 所以它**不是** rowid 别名 —— 这一条与上一条的
        // 区别只有类型名, 而 SQLite 恰好只把 INTEGER 当别名。
        expectBothReject(["CREATE TABLE t(a INT PRIMARY KEY, b INT)"], "INSERT INTO t VALUES (1,1),(1,2)",
            "two rows with the same single-column INT primary key")
    }

    @TestCase
    func aTableLevelSingleColumnPrimaryKeyRejectsDuplicates(): Unit {
        expectBothReject(["CREATE TABLE t(a TEXT, b INT, PRIMARY KEY(a))"], "INSERT INTO t VALUES ('k',1),('k',2)",
            "two rows with the same table-level single-column primary key")
    }

    @TestCase
    func aCompositePrimaryKeyRejectsDuplicates(): Unit {
        expectBothReject(["CREATE TABLE t(a INT, b INT, PRIMARY KEY(a,b))"], "INSERT INTO t VALUES (1,2),(1,2)",
            "two rows with the same composite primary key")
    }

    @TestCase
    func aNonIntegerPrimaryKeyStillAcceptsNull(): Unit {
        expectSameAsSqlite(["CREATE TABLE t(a TEXT PRIMARY KEY, b INT)", "INSERT INTO t VALUES (NULL,1)"],
            "SELECT a, b FROM t", "a NULL in a non-integer primary key")
    }

    @TestCase
    func severalNullsFitInANonIntegerPrimaryKey(): Unit {
        // NULL 不等于 NULL, 所以多行 NULL 主键合法。把主键实现成隐式 NOT NULL 会在这里变红。
        expectSameAsSqlite(["CREATE TABLE t(a TEXT PRIMARY KEY, b INT)", "INSERT INTO t VALUES (NULL,1),(NULL,2)"],
            "SELECT count(*), count(a) FROM t", "several NULLs in a non-integer primary key")
    }

    @TestCase
    func aNullInOneCompositeKeyColumnExemptsTheRow(): Unit {
        expectSameAsSqlite(["CREATE TABLE t(a INT, b INT, PRIMARY KEY(a,b))", "INSERT INTO t VALUES (1,NULL),(1,NULL)"],
            "SELECT count(*) FROM t", "two rows whose composite key shares a NULL")
    }

    @TestCase
    func anIntegerPrimaryKeyAssignsARowidForNull(): Unit {
        expectSameAsSqlite(["CREATE TABLE t(a INTEGER PRIMARY KEY, b INT)", "INSERT INTO t VALUES (NULL,1)"],
            "SELECT a, b FROM t", "a NULL in an INTEGER primary key")
    }

    @TestCase
    func updatingIntoADuplicatePrimaryKeyIsRejected(): Unit {
        expectBothReject(["CREATE TABLE t(a TEXT PRIMARY KEY, b INT)", "INSERT INTO t VALUES ('k1',1),('k2',2)"],
            "UPDATE t SET a='k1' WHERE a='k2'", "an UPDATE that makes two primary keys equal")
    }

    @TestCase
    func realSqliteCanOpenAFileWithANonIntegerPrimaryKey(): Unit {
        // 这一条才是本组的重点。缺了 sqlite_autoindex 行时"重复主键被接受"只是表面症状:
        // SQLite 打开这个库后, integrity_check、主键点查与任何 INSERT 全报
        // database disk image is malformed，只有全表 SELECT 还能读取 ——
        // 所以单靠驱动自己的查询是发现不了的, 必须让 SQLite 来读。
        let dir = TempDbDir()
        try {
            let conn = openFileConn(dir.dbPath)
            try {
                conn.execString("CREATE TABLE t(a TEXT PRIMARY KEY, b INT)")
                conn.execString("INSERT INTO t VALUES ('k1',1),('k2',2)")
            } finally {
                conn.close()
            }
            expectPythonOk(
                pythonOpen(dir.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT a,b FROM t WHERE a='k2'",
                    "[('k2', 2)]") + "cur.execute(\"INSERT INTO t VALUES ('k3',3)\")\n" + pythonExpect(
                    "SELECT count(*) FROM t", "[(3,)]") + pythonDone(),
                "real sqlite reads a file whose table has a single-column TEXT primary key")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func theAutomaticIndexNumberingFollowsTheDeclarationOrder(): Unit {
        // 编号错误不影响本驱动自行读写，因此需要独立读取器校验索引约束。这里 UNIQUE 写在
        // 表级主键之前，所以它必须使用 _1，主键使用 _2。
        let dir = TempDbDir()
        try {
            let conn = openFileConn(dir.dbPath)
            try {
                conn.execString("CREATE TABLE t(a INT, b INT, c INT UNIQUE, PRIMARY KEY(b,a))")
                conn.execString("INSERT INTO t VALUES (1,7,100),(2,8,200)")
            } finally {
                conn.close()
            }
            expectPythonOk(
                pythonOpen(dir.dbPath) + pythonIntegrityCheck() + pythonExpect(
                    "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
                    "[('sqlite_autoindex_t_1',), ('sqlite_autoindex_t_2',)]") +
                    "info = cur.execute('PRAGMA index_info(sqlite_autoindex_t_1)').fetchall()\n" +
                    "if [r[2] for r in info] != ['c']: raise SystemExit('autoindex _1 covers %r' % (info,))\n" +
                    "info2 = cur.execute('PRAGMA index_info(sqlite_autoindex_t_2)').fetchall()\n" +
                    "if [r[2] for r in info2] != ['b','a']: raise SystemExit('autoindex _2 covers %r' % (info2,))\n" +
                    pythonDone(), "automatic index numbering matches the declaration order")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func aDescendingPrimaryKeyIndexKeepsItsDirection(): Unit {
        expectSameAsSqlite(
            ["CREATE TABLE t(a INT, b INT, PRIMARY KEY(b DESC, a))", "INSERT INTO t VALUES (1,7),(2,8),(3,7)"],
            "SELECT b,a FROM t ORDER BY b DESC, a", "a primary key declared DESC")
    }

    @TestCase
    func aPrimaryKeyIndexIsVisibleToTheQueryPlanner(): Unit {
        // 自动索引不只是约束 —— 建对了它同时是一条访问路径。这一条与上面几条的区别是它在
        // 索引**存在**时才有意义, 所以它守住"索引被建成了非唯一的"这类半对实现。
        expectSameAsSqlite(
            ["CREATE TABLE t(a TEXT PRIMARY KEY, b INT)", "INSERT INTO t VALUES ('k1',1),('k2',2),('k3',3)"],
            "SELECT b FROM t WHERE a = 'k2'", "a point query on a non-integer primary key")
    }
}
