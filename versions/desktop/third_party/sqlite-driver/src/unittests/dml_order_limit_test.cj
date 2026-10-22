package sqlite_driver.unittests

import sqlite_driver.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * UPDATE / DELETE 的 ORDER BY + LIMIT。
 *
 * 判据取自 SQLite，但两侧写法不同，详见 expectSameEffectAsSqlite：
 * 该语法依赖可选编译能力，因此独立判据执行等价重写
 * `… WHERE rowid IN (SELECT rowid … ORDER BY … LIMIT …)`。
 *
 * 最容易写反的是"先排后裁"与"先裁后排"。这两种实现在**无 ORDER BY** 时结果相同,
 * 所以每条带 LIMIT 的用例都必须配 ORDER BY 才有分辨力 —— 而"配了 ORDER BY"还不够,
 * 见 dmlSchema 的说明。
 */

/**
 * 五行, x 排序与收集顺序在**两个方向上都不一致**: 按 x 升序是 id 2,4,1,5,3,
 * 降序是 3,5,1,4,2, 都不等于 rowid 序 1,2,3,4,5。
 *
 * 这组数避免 x 与 id 同序或严格反序，确保去掉排序后结果一定变化，使每条判据都能区分
 * "先排后裁"与"先裁后排"。
 */
private let dmlSchema: Array<String> = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, x INT, v INT)",
    "INSERT INTO t VALUES(1,30,0),(2,10,0),(3,50,0),(4,20,0),(5,40,0)"
]
private const dmlVerify: String = "SELECT id, x, v FROM t ORDER BY id"

@Test
class DmlOrderLimitTest {
    @TestCase
    func deleteWithOrderByLimitPicksTheOrderedPrefix(): Unit {
        expectSameEffectAsSqlite(dmlSchema, "DELETE FROM t ORDER BY x LIMIT 2",
            "DELETE FROM t WHERE rowid IN (SELECT rowid FROM t ORDER BY x LIMIT 2)", dmlVerify,
            "DELETE ORDER BY x LIMIT 2")
    }

    @TestCase
    func deleteWithDescOrderPicksTheOtherEnd(): Unit {
        expectSameEffectAsSqlite(dmlSchema, "DELETE FROM t ORDER BY x DESC LIMIT 2",
            "DELETE FROM t WHERE rowid IN (SELECT rowid FROM t ORDER BY x DESC LIMIT 2)", dmlVerify,
            "DELETE ORDER BY x DESC LIMIT 2")
    }
    @TestCase
    func deleteWithOffsetSkipsInsideTheOrdering(): Unit {
        expectSameEffectAsSqlite(dmlSchema, "DELETE FROM t ORDER BY x LIMIT 2 OFFSET 1",
            "DELETE FROM t WHERE rowid IN (SELECT rowid FROM t ORDER BY x LIMIT 2 OFFSET 1)", dmlVerify,
            "DELETE ORDER BY x LIMIT 2 OFFSET 1")
    }

    @TestCase
    func deleteWithWhereAndLimitAppliesBothFilters(): Unit {
        expectSameEffectAsSqlite(dmlSchema, "DELETE FROM t WHERE x > 15 ORDER BY x LIMIT 2",
            "DELETE FROM t WHERE rowid IN (SELECT rowid FROM t WHERE x > 15 ORDER BY x LIMIT 2)", dmlVerify,
            "DELETE WHERE + ORDER BY + LIMIT")
    }

    @TestCase
    func updateWithOrderByLimitTouchesOnlyTheOrderedPrefix(): Unit {
        expectSameEffectAsSqlite(dmlSchema, "UPDATE t SET v = 9 ORDER BY x LIMIT 2",
            "UPDATE t SET v = 9 WHERE rowid IN (SELECT rowid FROM t ORDER BY x LIMIT 2)", dmlVerify,
            "UPDATE ORDER BY x LIMIT 2")
    }

    @TestCase
    func updateWithDescOrderAndOffsetMatchesSqlite(): Unit {
        expectSameEffectAsSqlite(dmlSchema, "UPDATE t SET v = 9 ORDER BY x DESC LIMIT 2 OFFSET 2",
            "UPDATE t SET v = 9 WHERE rowid IN (SELECT rowid FROM t ORDER BY x DESC LIMIT 2 OFFSET 2)", dmlVerify,
            "UPDATE ORDER BY x DESC LIMIT 2 OFFSET 2")
    }

    /** 无 ORDER BY 时按 rowid 序裁剪; 这一条锁住"挑哪些行"而不是留成不确定。 */
    @TestCase
    func limitWithoutOrderByTakesTheRowidPrefix(): Unit {
        expectSameEffectAsSqlite(dmlSchema, "DELETE FROM t LIMIT 2",
            "DELETE FROM t WHERE rowid IN (SELECT rowid FROM t ORDER BY rowid LIMIT 2)", dmlVerify,
            "DELETE LIMIT 2 without ORDER BY")
    }

    /**
     * 无 ORDER BY 时的 rowid 序承诺在**走索引**时也要成立。
     *
     * 上一条用不到索引, 收集顺序天然就是 rowid 序, 所以它证不了这件事。这里 WHERE 命中
     * `ix_t_x`, 收集顺序变成 x 升序 (id 4,1,5,3) —— 若直接裁剪收集顺序, 删掉的是 id 4 与 1,
     * 而承诺的 rowid 前缀是 id 1 与 3。
     */
    @TestCase
    func theRowidPrefixHoldsEvenWhenTheScanUsesAnIndex(): Unit {
        let schema: Array<String> = [
            "CREATE TABLE t(id INTEGER PRIMARY KEY, x INT, v INT)",
            "CREATE INDEX ix_t_x ON t(x)",
            "INSERT INTO t VALUES(1,30,0),(2,10,0),(3,50,0),(4,20,0),(5,40,0)"
        ]
        expectSameEffectAsSqlite(schema, "DELETE FROM t WHERE x >= 20 LIMIT 2",
            "DELETE FROM t WHERE rowid IN (SELECT rowid FROM t WHERE x >= 20 ORDER BY rowid LIMIT 2)", dmlVerify,
            "DELETE LIMIT 2 without ORDER BY on an indexed scan")
    }

    /** LIMIT 大于匹配行数时不报错, 改/删全部匹配行。 */
    @TestCase
    func limitLargerThanTheMatchSetAffectsEveryMatch(): Unit {
        expectSameEffectAsSqlite(dmlSchema, "DELETE FROM t WHERE x < 35 ORDER BY x LIMIT 99",
            "DELETE FROM t WHERE x < 35", dmlVerify, "DELETE with LIMIT past the end")
    }

    /** LIMIT 0 一行都不动; 与"LIMIT 缺省"必须分辨开。 */
    @TestCase
    func limitZeroAffectsNothing(): Unit {
        let conn = newMemConn()
        for (sql in dmlSchema) {
            conn.execString(sql)
        }
        @Expect(conn.execString("DELETE FROM t ORDER BY x LIMIT 0"), 0)
        @Expect(conn.queryString("SELECT count(*) FROM t").rows[0][0], SqliteValue.SInt(5))
        // 负 LIMIT 是"不限", 与 SELECT 一致。
        @Expect(conn.execString("DELETE FROM t ORDER BY x LIMIT -1"), 5)
        conn.close()
    }

    /** 受影响行数要如实反映裁剪结果, 而不是匹配行数。 */
    @TestCase
    func changesCountReflectsTheLimitNotTheMatchCount(): Unit {
        let conn = newMemConn()
        for (sql in dmlSchema) {
            conn.execString(sql)
        }
        @Expect(conn.execString("UPDATE t SET v = 1 ORDER BY x LIMIT 3"), 3)
        @Expect(conn.changes, 3)
        @Expect(conn.execString("DELETE FROM t ORDER BY id LIMIT 1 OFFSET 2"), 1)
        @Expect(conn.changes, 1)
        conn.close()
    }

    /** 参数化的 LIMIT/OFFSET 与常量形态必须等效。 */
    @TestCase
    func boundParametersWorkInLimitAndOffset(): Unit {
        let conn = newMemConn()
        for (sql in dmlSchema) {
            conn.execString(sql)
        }
        let affected = conn.exec("DELETE FROM t ORDER BY x LIMIT ? OFFSET ?", [SqliteValue.SInt(2), SqliteValue.SInt(1)])
        @Expect(affected, 2)
        // 按 x 升序是 id 2,4,1,5,3; 跳 1 取 2 删掉 id 4 与 1, 剩 2,3,5。
        let rs = conn.queryString("SELECT id FROM t ORDER BY id")
        @Expect(rs.rows.size, 3)
        @Expect(rs.rows[0][0], SqliteValue.SInt(2))
        @Expect(rs.rows[1][0], SqliteValue.SInt(3))
        @Expect(rs.rows[2][0], SqliteValue.SInt(5))
        conn.close()
    }

    /** ORDER BY 不配 LIMIT 时报错, 而不是静默忽略 —— 忽略等于悄悄删全表。 */
    @TestCase
    func orderByWithoutLimitIsRejected(): Unit {
        let conn = newMemConn()
        for (sql in dmlSchema) {
            conn.execString(sql)
        }
        for (sql in ["DELETE FROM t ORDER BY x", "UPDATE t SET v = 1 ORDER BY x"]) {
            try {
                let _ = conn.execString(sql)
                @Fail("`${sql}` should be rejected")
            } catch (e: SqliteSyntaxException) {
                @Expect(e.message.contains("requires LIMIT"), true)
            }
        }
        // 报错后表必须没动。
        @Expect(conn.queryString("SELECT count(*) FROM t").rows[0][0], SqliteValue.SInt(5))
        conn.close()
    }

    /** RETURNING 与 LIMIT 共存时只返回真正被改的那些行。 */
    @TestCase
    func returningReportsOnlyTheLimitedRows(): Unit {
        let conn = newMemConn()
        for (sql in dmlSchema) {
            conn.execString(sql)
        }
        let rs = conn.queryString("DELETE FROM t ORDER BY x LIMIT 2 RETURNING id")
        @Expect(rs.rows.size, 2)
        // 按 x 升序删的是 id 2 (x=10) 与 id 4 (x=20), 且按该顺序返回。
        @Expect(rs.rows[0][0], SqliteValue.SInt(2))
        @Expect(rs.rows[1][0], SqliteValue.SInt(4))
        conn.close()
    }

    /** ORDER BY 里的排序键在**旧值**上求值: 改写不能影响"选中谁"。 */
    @TestCase
    func orderKeysAreEvaluatedOnTheOldRowValues(): Unit {
        expectSameEffectAsSqlite(dmlSchema, "UPDATE t SET x = x + 100 ORDER BY x LIMIT 2",
            "UPDATE t SET x = x + 100 WHERE rowid IN (SELECT rowid FROM t ORDER BY x LIMIT 2)", dmlVerify,
            "UPDATE whose SET changes the ORDER BY column")
    }

    /** 表达式排序键与 COLLATE 都要走同一条路径。 */
    @TestCase
    func expressionAndCollatedOrderKeysAreSupported(): Unit {
        // NOCASE 升序是 AA(2), bb(4), cc(1), DD(3), 前两名与 rowid 前缀不重合。
        let schema: Array<String> = [
            "CREATE TABLE s(id INTEGER PRIMARY KEY, name TEXT)",
            "INSERT INTO s VALUES(1,'cc'),(2,'AA'),(3,'DD'),(4,'bb')"
        ]
        expectSameEffectAsSqlite(schema, "DELETE FROM s ORDER BY name COLLATE NOCASE LIMIT 2",
            "DELETE FROM s WHERE rowid IN (SELECT rowid FROM s ORDER BY name COLLATE NOCASE LIMIT 2)",
            "SELECT id, name FROM s ORDER BY id", "DELETE ORDER BY name COLLATE NOCASE")
        // -x 升序是 id 3,5,1,4,2, 与 x 升序相反, 也与 rowid 序不同。
        expectSameEffectAsSqlite(dmlSchema, "DELETE FROM t ORDER BY -x LIMIT 2",
            "DELETE FROM t WHERE rowid IN (SELECT rowid FROM t ORDER BY -x LIMIT 2)", dmlVerify,
            "DELETE ORDER BY an expression")
    }

    /**
     * 索引存在时也要走同一条裁剪路径, 结果不因访问路径而变。
     *
     * 升序那一条对"摘掉排序"没有分辨力 —— 索引收集顺序本就是 x 升序, 两条路径同解。
     * 降序那一条才有: 它要求的前缀 (id 3,5) 与索引收集顺序的前缀 (id 4,1) 不同。
     */
    @TestCase
    func theResultIsIndependentOfTheAccessPath(): Unit {
        let schema: Array<String> = [
            "CREATE TABLE t(id INTEGER PRIMARY KEY, x INT, v INT)",
            "CREATE INDEX ix_t_x ON t(x)",
            "INSERT INTO t VALUES(1,30,0),(2,10,0),(3,50,0),(4,20,0),(5,40,0)"
        ]
        expectSameEffectAsSqlite(schema, "DELETE FROM t WHERE x >= 20 ORDER BY x LIMIT 2",
            "DELETE FROM t WHERE rowid IN (SELECT rowid FROM t WHERE x >= 20 ORDER BY x LIMIT 2)", dmlVerify,
            "DELETE with an index on the ordered column")
        expectSameEffectAsSqlite(schema, "DELETE FROM t WHERE x >= 20 ORDER BY x DESC LIMIT 2",
            "DELETE FROM t WHERE rowid IN (SELECT rowid FROM t WHERE x >= 20 ORDER BY x DESC LIMIT 2)", dmlVerify,
            "DELETE DESC with an index on the ordered column")
    }

    /** 触发器只对真正被改的行触发, 不对被 LIMIT 裁掉的行触发。 */
    @TestCase
    func triggersFireOnlyForRowsThatSurviveTheLimit(): Unit {
        let conn = newMemConn()
        for (sql in dmlSchema) {
            conn.execString(sql)
        }
        conn.execString("CREATE TABLE log(id INT)")
        conn.execString("CREATE TRIGGER tg AFTER DELETE ON t BEGIN INSERT INTO log VALUES(OLD.id); END")
        @Expect(conn.execString("DELETE FROM t ORDER BY x LIMIT 2"), 2)
        let rs = conn.queryString("SELECT id FROM log ORDER BY id")
        @Expect(rs.rows.size, 2)
        // x 最小的两行是 id 2 (x=10) 与 id 4 (x=20)。
        @Expect(rs.rows[0][0], SqliteValue.SInt(2))
        @Expect(rs.rows[1][0], SqliteValue.SInt(4))
        conn.close()
    }
}
