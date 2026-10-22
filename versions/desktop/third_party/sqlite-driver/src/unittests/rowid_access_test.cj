package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * rowid 访问路径的正确性。
 *
 * 这条路径把 `WHERE rowid = ?` 与 `WHERE id = ?` (id 是 INTEGER PRIMARY KEY) 从全表扫
 * 换成 O(log n) 定位。换路径的风险不是"慢"而是**静默漏行**，所以判据一律通过
 * expectSameAsSqlite 与 SQLite 逐行比较。
 *
 * 重点覆盖值折算: rowid 是 Int64, 而约束值可能是 REAL 或 TEXT。`rowid = 1.5` 恒空,
 * `rowid > 1.5` 等价于 `rowid >= 2`, `rowid = '2'` 在 SQLite 里**不**匹配 rowid 2
 * (比较不做文本到整数的隐式转换)。这三条各错一次都只表现为多行或少行。
 */

/** 建一张 INTEGER PRIMARY KEY 表并填 8 行, 供各判据共用。 */
let ROWID_SETUP: Array<String> = [
    "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)",
    "INSERT INTO t(id, v) VALUES (1,'a'),(2,'b'),(3,'c'),(5,'e'),(8,'h'),(13,'m'),(21,'u'),(34,'z')"
]

/** 无 INTEGER PRIMARY KEY 的表: rowid 是隐式的。 */
let IMPLICIT_SETUP: Array<String> = [
    "CREATE TABLE p (name TEXT, qty INTEGER)",
    "INSERT INTO p(name, qty) VALUES ('x',10),('y',20),('z',30)"
]

@Test
class RowidAccessTest {
    /** 等值: 别名列与三个伪列名, 命中与未命中。 */
    @TestCase
    func equalityOnAliasAndPseudoColumns(): Unit {
        expectSameAsSqlite(ROWID_SETUP, "SELECT id, v FROM t WHERE id = 5", "alias column equality")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id, v FROM t WHERE rowid = 5", "rowid pseudo-column equality")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id, v FROM t WHERE _rowid_ = 8", "_rowid_ equality")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id, v FROM t WHERE oid = 13", "oid equality")
        // 未命中: 空集而不是漏判成全表。
        expectSameAsSqlite(ROWID_SETUP, "SELECT id, v FROM t WHERE id = 4", "equality miss")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id, v FROM t WHERE id = 999", "equality beyond the last rowid")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id, v FROM t WHERE id = -1", "negative equality")
        // 反向写法: 常量在左。
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE 21 = id", "constant on the left")
    }

    /** 区间: 四个比较符、BETWEEN、以及多个界取最紧。 */
    @TestCase
    func rangeScansHonourBounds(): Unit {
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id > 5", "greater than")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id >= 5", "greater or equal")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id < 8", "less than")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id <= 8", "less or equal")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id > 2 AND id < 21", "two-sided range")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id BETWEEN 3 AND 13", "between")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id NOT BETWEEN 3 AND 13", "not between")
        // 多个同向界: 应取最紧的那个。只取第一个会多出行。
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id > 1 AND id > 8", "tightest lower bound wins")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id < 34 AND id < 13", "tightest upper bound wins")
        // 空区间。
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id > 21 AND id < 8", "empty range")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id >= 5 AND id <= 5", "single-row range")
    }

    /*
     * 值折算。
     *
     * 这四条是最容易静默错的: REAL 边界要取整、非整数 REAL 等值恒空、TEXT 不隐式转整数。
     */
    @TestCase
    func nonIntegerConstantsMatchSqlite(): Unit {
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id = 5.0", "real equality that is a whole number")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id = 5.5", "real equality that is not whole")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id > 4.5", "real lower bound rounds up")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id < 8.5", "real upper bound rounds down")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id > -2.5", "negative real lower bound")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id = '5'", "text coerces to integer when parseable")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id > '5'", "text range coerces then compares")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id = NULL", "null equality")
        expectSameAsSqlite(ROWID_SETUP, "SELECT id FROM t WHERE id IS NULL", "is null on an alias column")
    }

    /** 隐式 rowid 的表。 */
    @TestCase
    func implicitRowidTable(): Unit {
        expectSameAsSqlite(IMPLICIT_SETUP, "SELECT rowid, name FROM p WHERE rowid = 2", "implicit rowid equality")
        expectSameAsSqlite(IMPLICIT_SETUP, "SELECT rowid, name FROM p WHERE rowid >= 2", "implicit rowid range")
        expectSameAsSqlite(IMPLICIT_SETUP, "SELECT rowid FROM p WHERE rowid < 3 AND qty > 5", "rowid plus a filter")
    }

    /*
     * 遮蔽与歧义: 这两种形态下 rowid 路径必须让位。
     */
    @TestCase
    func shadowedAndAmbiguousNamesFallBack(): Unit {
        // 真实列名叫 rowid 时, `rowid` 指那一列, 不是行号。走 rowid 路径会读错值。
        let shadowed: Array<String> = [
            "CREATE TABLE s (rowid TEXT, v INTEGER)",
            "INSERT INTO s(rowid, v) VALUES ('one',1),('two',2)"
        ]
        expectSameAsSqlite(shadowed, "SELECT rowid, v FROM s WHERE rowid = 'two'", "a real column named rowid wins")
        // 两个源都有 id: 未限定的 id 不能被当成某一个表的 rowid。
        let joined: Array<String> = [
            "CREATE TABLE a (id INTEGER PRIMARY KEY, x TEXT)",
            "CREATE TABLE b (id INTEGER PRIMARY KEY, y TEXT)",
            "INSERT INTO a(id, x) VALUES (1,'a1'),(2,'a2')",
            "INSERT INTO b(id, y) VALUES (1,'b1'),(2,'b2')"
        ]
        expectSameAsSqlite(joined, "SELECT a.id, b.id FROM a, b WHERE a.id = 1 AND b.id = 2", "qualified rowids")
        expectSameAsSqlite(joined, "SELECT a.id, x, y FROM a JOIN b ON a.id = b.id ORDER BY a.id", "join on rowids")
    }

    /*
     * 与二级索引共存。
     *
     * rowid 路径优先, 但结果必须与"只有索引可用"时一致。这一条防的是"选了 rowid 路径就
     * 忘了施加其余条件"。
     */
    @TestCase
    func coexistsWithSecondaryIndexes(): Unit {
        let indexed: Array<String> = [
            "CREATE TABLE m (id INTEGER PRIMARY KEY, k TEXT, n INTEGER)",
            "CREATE INDEX ix_m_k ON m(k)",
            "CREATE INDEX ix_m_n ON m(n)",
            "INSERT INTO m(id, k, n) VALUES (1,'a',10),(2,'b',20),(3,'a',30),(4,'c',20),(5,'a',50)"
        ]
        expectSameAsSqlite(indexed, "SELECT id FROM m WHERE id = 3 AND k = 'a'", "rowid plus an indexed column")
        expectSameAsSqlite(indexed, "SELECT id FROM m WHERE id = 3 AND k = 'zzz'", "rowid hit but filter rejects")
        expectSameAsSqlite(indexed, "SELECT id FROM m WHERE id > 2 AND n = 20", "rowid range plus an indexed equality")
        expectSameAsSqlite(indexed, "SELECT id FROM m WHERE k = 'a' ORDER BY id", "index path still available")
    }

    /*
     * DML 与聚合也走同一条访问路径。
     */
    @TestCase
    func dmlAndAggregatesUseTheSamePath(): Unit {
        expectSameAsSqlite(ROWID_SETUP, "SELECT count(*) FROM t WHERE id > 5", "count over a rowid range")
        expectSameAsSqlite(ROWID_SETUP, "SELECT sum(id) FROM t WHERE id BETWEEN 2 AND 13", "sum over a rowid range")
        let conn = newMemConn()
        try {
            for (sql in ROWID_SETUP) {
                let _ = conn.execString(sql)
            }
            @Assert(conn.execString("UPDATE t SET v = 'X' WHERE id = 8"), 1)
            @Assert(conn.execString("DELETE FROM t WHERE id > 20"), 2)
            @Assert(scalarInt(conn, "SELECT count(*) FROM t"), 6)
            @Assert(textOf(conn.queryString("SELECT v FROM t WHERE id = 8").rows[0][0]), "X")
        } finally {
            conn.close()
        }
    }

    /*
     * 关联子查询: 内层引用外层列时, 值在进入内层前已定, rowid 路径可用。
     * 但内层引用**本层**列时不可用 —— 那时值还没定。
     */
    @TestCase
    func correlatedSubqueriesStayCorrect(): Unit {
        let two: Array<String> = [
            "CREATE TABLE ord (id INTEGER PRIMARY KEY, cust INTEGER)",
            "CREATE TABLE cust (id INTEGER PRIMARY KEY, nm TEXT)",
            "INSERT INTO cust(id, nm) VALUES (1,'ann'),(2,'bob'),(3,'cid')",
            "INSERT INTO ord(id, cust) VALUES (10,1),(11,2),(12,2),(13,3)"
        ]
        expectSameAsSqlite(two, "SELECT id, (SELECT nm FROM cust WHERE cust.id = ord.cust) FROM ord ORDER BY id",
            "correlated scalar subquery on rowid")
        expectSameAsSqlite(two, "SELECT nm FROM cust WHERE id IN (SELECT cust FROM ord WHERE id > 11) ORDER BY nm",
            "rowid range inside IN")
        expectSameAsSqlite(two, "SELECT nm FROM cust WHERE EXISTS (SELECT 1 FROM ord WHERE ord.cust = cust.id)",
            "exists with a correlated rowid comparison")
    }
}
