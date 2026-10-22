package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * RETURNING 子句。
 *
 * 三条语义各自单独立例, 因为它们最容易写成同一条:
 *
 *   - INSERT / UPDATE 返回写入**后**的值, DELETE 返回删除**前**的值。UPDATE 若错记成
 *     旧值, 只有"SET 真的改了那一列"的用例才分辨得出 —— 故用例里 SET 的列必须出现在
 *     RETURNING 里且值确实变了;
 *   - upsert 的 DO UPDATE 返回的是**被更新的那一行**, rowid 与本次插入的值都不同。
 *     事后按插入值回查会取错行, 而普通 INSERT 全绿;
 *   - 未命中任何行时是空结果集, 不是错误, 也不是一行 NULL。
 *
 * 判据走差分比对: 期望值由 SQLite 给出。多行返回的顺序 SQLite 未定义, 故一律带
 * ORDER BY 之外的手段无法排序时改用单行样本, 避免用例依赖未定义的顺序。
 */

/** 差分比对一条 DML 的 RETURNING 结果。setup 两侧都跑。 */
func expectReturningSameAsSqlite(setup: Array<String>, dml: String, what: String): Unit {
    expectSameAsSqlite(setup, dml, what)
}

let RET_SETUP: Array<String> = [
    "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INT DEFAULT 7)",
    "INSERT INTO t (v) VALUES ('a'), ('b'), ('c')"
]

@Test
class ReturningInsertTest {
    @TestCase
    func returnsAllColumnsForAStarClause(): Unit {
        expectReturningSameAsSqlite(["CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INT DEFAULT 7)"],
            "INSERT INTO t (v) VALUES ('a') RETURNING *", "INSERT RETURNING *")
    }

    /** 默认值与自动分配的 rowid 都要出现在返回行里 —— 它们不在 VALUES 里。 */
    @TestCase
    func returnsGeneratedRowidAndColumnDefaults(): Unit {
        expectReturningSameAsSqlite(["CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INT DEFAULT 7)"],
            "INSERT INTO t (v) VALUES ('x') RETURNING id, n", "INSERT RETURNING 默认值")
    }

    @TestCase
    func evaluatesExpressionsAndAliases(): Unit {
        expectReturningSameAsSqlite(["CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INT DEFAULT 7)"],
            "INSERT INTO t (v) VALUES ('c') RETURNING id, upper(v) AS uv, n + 1, 'lit'", "INSERT RETURNING 表达式")
    }

    /** rowid 关键字要能引用, 即使表没有 INTEGER PRIMARY KEY 列。 */
    @TestCase
    func returnsRowidForATableWithoutAnAlias(): Unit {
        expectReturningSameAsSqlite(["CREATE TABLE p (v TEXT)"], "INSERT INTO p VALUES ('only') RETURNING rowid, v",
            "INSERT RETURNING rowid")
    }

    @TestCase
    func returnsOneRowPerInsertedRow(): Unit {
        expectReturningSameAsSqlite(["CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)"],
            "INSERT INTO t (v) VALUES ('a'), ('b'), ('c') RETURNING id, v", "多行 INSERT RETURNING")
    }

    /** INSERT … SELECT 也要返回行。 */
    @TestCase
    func returnsRowsInsertedFromASelect(): Unit {
        expectReturningSameAsSqlite(
            ["CREATE TABLE src (v TEXT)", "INSERT INTO src VALUES ('p'), ('q')",
                "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)"],
            "INSERT INTO t (v) SELECT v FROM src ORDER BY v RETURNING id, v", "INSERT SELECT RETURNING")
    }

    /**
     * OR REPLACE 走的是另一条写入出口。
     *
     * 只在普通 INSERT 上接采集器时本例返回空结果集, 而受影响行数照样是 1 —— 那种缺陷
     * 在只看 changes 的用例上不可见。
     */
    @TestCase
    func returnsTheReplacedRowForOrReplace(): Unit {
        expectReturningSameAsSqlite(
            ["CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO t VALUES (1, 'old')"],
            "INSERT OR REPLACE INTO t VALUES (1, 'new') RETURNING id, v", "OR REPLACE RETURNING")
    }

    /** OR IGNORE 跳过的行不该出现在返回里。 */
    @TestCase
    func skipsIgnoredRows(): Unit {
        expectReturningSameAsSqlite(
            ["CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO t VALUES (1, 'keep')"],
            "INSERT OR IGNORE INTO t VALUES (1, 'dropped') RETURNING id, v", "OR IGNORE RETURNING")
    }
}

@Test
class ReturningUpsertTest {
    /**
     * upsert 的 DO UPDATE 返回被更新的那一行。
     *
     * 样本刻意让"插入的值"与"更新后的值"不同 (v 拼接了后缀), 否则按插入值回查也能给出
     * 同一答案, 用例就没有分辨力。
     */
    @TestCase
    func returnsTheUpdatedRowForDoUpdate(): Unit {
        expectReturningSameAsSqlite(
            ["CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INT)", "INSERT INTO t VALUES (1, 'old', 10)"],
            "INSERT INTO t VALUES (1, 'incoming', 99) ON CONFLICT (id) DO UPDATE SET " +
                "v = v || '-merged', n = n + excluded.n RETURNING id, v, n", "upsert DO UPDATE RETURNING")
    }

    /** 没有冲突时走的是普通插入分支, 返回的是插入的那一行。 */
    @TestCase
    func returnsTheInsertedRowWhenNoConflictOccurs(): Unit {
        expectReturningSameAsSqlite(
            ["CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INT)", "INSERT INTO t VALUES (1, 'existing', 10)"],
            "INSERT INTO t VALUES (2, 'fresh', 20) ON CONFLICT (id) DO UPDATE SET n = 0 RETURNING id, v, n",
            "upsert 无冲突 RETURNING")
    }

    /**
     * DO UPDATE SET 里的未限定列名解析到**目标表的旧值**, 不是 excluded。
     *
     * 两个源的列名完全重合, 未限定解析若把 excluded 也算进候选就报 ambiguous ——
     * 而这条 SQL 在 SQLite 上合法且常见。样本让旧值与插入值不同, 于是解析错了看得出来。
     */
    @TestCase
    func resolvesUnqualifiedNamesToTheTargetRow(): Unit {
        expectReturningSameAsSqlite(
            ["CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INT)", "INSERT INTO t VALUES (1, 'old', 10)"],
            "INSERT INTO t VALUES (1, 'incoming', 99) ON CONFLICT (id) DO UPDATE SET " +
                "v = v || '-kept', n = n + 1 RETURNING id, v, n", "upsert 未限定列名")
    }

    /** 限定名两种形态都要能用: `t.v` 取旧值、`excluded.v` 取新值。 */
    @TestCase
    func distinguishesTargetAndExcludedByQualifier(): Unit {
        expectReturningSameAsSqlite(
            ["CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INT)", "INSERT INTO t VALUES (1, 'old', 10)"],
            "INSERT INTO t VALUES (1, 'incoming', 99) ON CONFLICT (id) DO UPDATE SET " +
                "v = t.v || '/' || excluded.v, n = excluded.n RETURNING id, v, n", "upsert 限定列名")
    }

    /** DO NOTHING 不写行, 故没有返回行。 */
    @TestCase
    func returnsNothingForDoNothing(): Unit {
        expectReturningSameAsSqlite(
            ["CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)", "INSERT INTO t VALUES (1, 'kept')"],
            "INSERT INTO t VALUES (1, 'skipped') ON CONFLICT (id) DO NOTHING RETURNING id, v", "DO NOTHING RETURNING")
    }
}

@Test
class ReturningUpdateDeleteTest {
    /**
     * UPDATE 返回**新**值。
     *
     * SET 改的列必须出现在 RETURNING 里且新旧值不同, 否则记成旧值也全绿。
     */
    @TestCase
    func returnsPostUpdateValues(): Unit {
        expectReturningSameAsSqlite(RET_SETUP, "UPDATE t SET n = n * 2, v = v || '!' WHERE id <= 2 RETURNING id, v, n",
            "UPDATE RETURNING 新值")
    }

    @TestCase
    func returnsStarForUpdatedRows(): Unit {
        expectReturningSameAsSqlite(RET_SETUP, "UPDATE t SET n = 100 WHERE id = 2 RETURNING *", "UPDATE RETURNING *")
    }

    /** 改了 rowid 别名列时返回的必须是新 rowid。 */
    @TestCase
    func returnsTheNewRowidAfterChangingThePrimaryKey(): Unit {
        expectReturningSameAsSqlite(RET_SETUP, "UPDATE t SET id = id + 100 WHERE id = 3 RETURNING id, rowid, v",
            "UPDATE RETURNING 新 rowid")
    }

    /**
     * DELETE 返回删除**前**的行。
     *
     * 删完再取会拿到空值, 那种缺陷表现为"列都在但值全 NULL"—— 与"没实现"不同形, 单看
     * 行数分辨不出。
     */
    @TestCase
    func returnsPreDeleteValues(): Unit {
        expectReturningSameAsSqlite(RET_SETUP, "DELETE FROM t WHERE id = 1 RETURNING id, v, n", "DELETE RETURNING 旧值")
    }

    @TestCase
    func returnsStarForDeletedRows(): Unit {
        expectReturningSameAsSqlite(RET_SETUP, "DELETE FROM t WHERE id >= 2 RETURNING *", "DELETE RETURNING *")
    }

    /** 未命中任何行: 空结果集, 不是错误也不是一行 NULL。 */
    @TestCase
    func returnsAnEmptyResultWhenNothingMatches(): Unit {
        expectReturningSameAsSqlite(RET_SETUP, "DELETE FROM t WHERE id = 999 RETURNING *", "DELETE 未命中 RETURNING")
        expectReturningSameAsSqlite(RET_SETUP, "UPDATE t SET n = 0 WHERE id = 999 RETURNING id",
            "UPDATE 未命中 RETURNING")
    }

    /** 带参数的 DML 也要能返回。 */
    @TestCase
    func returnsRowsFromAParameterisedStatement(): Unit {
        let conn = newMemConn()
        try {
            for (sql in RET_SETUP) {
                conn.execString(sql)
            }
            let rs = conn.query("UPDATE t SET v = ? WHERE id = ? RETURNING id, v",
                [SqliteValue.SText("bound"), SqliteValue.SInt(2)])
            @Assert(rs.rows.size, 1)
            @Assert(renderValue(rs.rows[0][0]), "I:2")
            @Assert(renderValue(rs.rows[0][1]), "T:bound")
        } finally {
            conn.close()
        }
    }

    /** 列名要与 SELECT 的规则一致: 别名优先, 列引用用列名。 */
    @TestCase
    func namesColumnsLikeASelect(): Unit {
        let conn = newMemConn()
        try {
            for (sql in RET_SETUP) {
                conn.execString(sql)
            }
            let rs = conn.queryString("DELETE FROM t WHERE id = 1 RETURNING id, v AS label")
            @Assert(rs.columnNames.size, 2)
            @Assert(rs.columnNames[0], "id")
            @Assert(rs.columnNames[1], "label")
        } finally {
            conn.close()
        }
    }

    /**
     * 空结果集也必须带正确的列名。
     *
     * 列名在求值之前定下 —— 若靠"第一行的求值结果"推列名, 零行时列名会是空数组,
     * 而调用方按列名取值会失败。
     */
    @TestCase
    func keepsColumnNamesOnAnEmptyResult(): Unit {
        let conn = newMemConn()
        try {
            for (sql in RET_SETUP) {
                conn.execString(sql)
            }
            let rs = conn.queryString("DELETE FROM t WHERE id = 999 RETURNING id, v AS label")
            @Assert(rs.rows.size, 0)
            @Assert(rs.columnNames.size, 2)
            @Assert(rs.columnNames[1], "label")
        } finally {
            conn.close()
        }
    }

    /** 聚合两侧都拒。 */
    @TestCase
    func rejectsAggregatesInReturning(): Unit {
        expectBothReject(RET_SETUP, "DELETE FROM t WHERE id = 1 RETURNING count(*)", "RETURNING 聚合")
    }

    /** RETURNING 必须是最后一个子句, 后面接 WHERE 是语法错。 */
    @TestCase
    func rejectsClausesAfterReturning(): Unit {
        expectBothReject(RET_SETUP, "DELETE FROM t RETURNING * WHERE id > 0", "RETURNING 后接 WHERE")
    }

    /** 不写 RETURNING 时不该返回结果集 —— exec 路径必须仍然可用。 */
    @TestCase
    func keepsPlainDmlWithoutAResultSet(): Unit {
        let conn = newMemConn()
        try {
            for (sql in RET_SETUP) {
                conn.execString(sql)
            }
            @Assert(conn.execString("UPDATE t SET n = 1 WHERE id = 1"), 1)
            @Assert(conn.execString("DELETE FROM t WHERE id = 1"), 1)
        } finally {
            conn.close()
        }
    }
}
