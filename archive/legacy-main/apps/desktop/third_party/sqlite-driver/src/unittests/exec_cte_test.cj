package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 公共表表达式 (WITH / WITH RECURSIVE)。
 *
 * 判据一律走 expectSameAsSqlite，由 SQLite 计算期望值。递归 CTE 的逐行队列与
 * 批量迭代在多数样本上会给出相同集合但不同顺序，因此结果必须逐行比较。
 *
 * 重点覆盖四条规则：
 *   1. `RECURSIVE` 关键字**可省** —— 省了照样递归, 所以"要不要递归求解"只能按 body 里
 *      有没有自引用来判, 不能看关键字;
 *   2. 递归项一次只看**一行** (队列语义), 不是"看全部已产出的行";
 *   3. 递归项里只允许**一处**自引用, 两处 SQLite 直接报错;
 *   4. CTE 自带的 LIMIT 是**停止条件**而不是事后裁剪 —— 无界递归靠它终止。
 */

/** 两表两列的公共样本。列值刻意不对称, 免得顺序错了也看不出来。 */
let CTE_SETUP: Array<String> = [
    "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT, n INT)",
    "INSERT INTO t VALUES (1,'a',10),(2,'b',20),(3,'c',30),(4,'d',40)",
    "CREATE TABLE u(id INTEGER PRIMARY KEY, tid INT, w TEXT)",
    "INSERT INTO u VALUES (1,1,'x'),(2,1,'y'),(3,3,'z')"
]

@Test
class CteBasicTest {
    @TestCase
    func aPlainCteBecomesANamedRowSource(): Unit {
        expectSameAsSqlite(CTE_SETUP, "WITH s AS (SELECT id, v FROM t WHERE n >= 20) SELECT * FROM s ORDER BY id",
            "a plain non-recursive CTE")
    }

    @TestCase
    func aColumnAliasListRenamesTheResultColumns(): Unit {
        // 别名清单改的是**引用时**的列名。查询里按新名字取, 用旧名字应当找不到 ——
        // 后一半由 rejectsUnknownColumnAfterAliasing 守。
        expectSameAsSqlite(CTE_SETUP, "WITH s(a,b) AS (SELECT id, v FROM t) SELECT b, a FROM s ORDER BY a",
            "CTE with a column alias list")
    }

    @TestCase
    func aCteMayHaveNoFromClause(): Unit {
        expectSameAsSqlite(CTE_SETUP, "WITH s AS (SELECT 1 AS x) SELECT x + 1 FROM s", "CTE whose body has no FROM")
    }

    @TestCase
    func aCteMayBeAValuesList(): Unit {
        expectSameAsSqlite(CTE_SETUP, "WITH s AS (VALUES (3),(1),(2)) SELECT * FROM s", "CTE built from VALUES")
    }

    @TestCase
    func aCteMayReferenceAnEarlierCte(): Unit {
        expectSameAsSqlite(CTE_SETUP, "WITH a AS (SELECT 1 AS x), b AS (SELECT x + 1 AS y FROM a) SELECT y FROM b",
            "CTE referencing an earlier sibling")
    }

    @TestCase
    func aCteMayReferenceALaterCte(): Unit {
        /*
         * 前向引用是合法的。这一例要求实现**按需求解**而不是按声明
         * 顺序求解 —— 按顺序求解时 b 会在 a 还不存在时被算, 报"没有这张表"。
         */
        expectSameAsSqlite(CTE_SETUP, "WITH b AS (SELECT x + 1 AS y FROM a), a AS (SELECT 1 AS x) SELECT y FROM b",
            "CTE referencing a later sibling")
    }

    @TestCase
    func aCteShadowsARealTableOfTheSameName(): Unit {
        // 遮蔽必须成立: 反过来 (真表优先) 会让 CTE 在同名表存在时静默失效, 查询照样返回行,
        // 只是来自错误的源。
        expectSameAsSqlite(CTE_SETUP, "WITH t AS (SELECT 99 AS id) SELECT * FROM t", "a CTE shadows a real table")
    }

    @TestCase
    func aCteWorksInsideAJoin(): Unit {
        expectSameAsSqlite(CTE_SETUP,
            "WITH s AS (SELECT id, n FROM t WHERE n > 15) " +
                "SELECT s.id, u.w FROM s JOIN u ON u.tid = s.id ORDER BY s.id, u.w", "CTE as a join operand")
    }

    @TestCase
    func aCteIsVisibleInsideAScalarSubquery(): Unit {
        expectSameAsSqlite(CTE_SETUP, "WITH s AS (SELECT id FROM t) SELECT (SELECT count(*) FROM s) AS c",
            "CTE visible inside a scalar subquery")
    }

    @TestCase
    func aCteIsVisibleInsideAnInSubquery(): Unit {
        expectSameAsSqlite(CTE_SETUP,
            "WITH s AS (SELECT id FROM t WHERE n >= 30) " + "SELECT v FROM t WHERE id IN (SELECT id FROM s) ORDER BY v",
            "CTE visible inside an IN subquery")
    }

    @TestCase
    func theSameCteMayBeJoinedToItselfUnderAnAlias(): Unit {
        expectSameAsSqlite(CTE_SETUP,
            "WITH s AS (SELECT id FROM t WHERE n <= 20) " +
                "SELECT a.id, b.id FROM s AS a JOIN s AS b ON b.id > a.id ORDER BY a.id, b.id",
            "the same CTE joined to itself")
    }

    @TestCase
    func anUnusedCteIsHarmless(): Unit {
        // 不引用的 CTE 不该被求解, 更不该报错。若实现按声明顺序预先求解, 一个 body 里
        // 引用了不存在的表的未用 CTE 就会让整条语句失败。
        expectSameAsSqlite(CTE_SETUP, "WITH s AS (SELECT 1) SELECT 42 AS answer", "an unused CTE")
    }

    @TestCase
    func aCteBodyMayItselfUseWith(): Unit {
        expectSameAsSqlite(CTE_SETUP,
            "WITH outer_cte AS (WITH inner_cte AS (SELECT 7 AS k) SELECT k * 2 AS kk FROM inner_cte) " +
                "SELECT kk FROM outer_cte", "nested WITH inside a CTE body")
    }

    @TestCase
    func aSubqueryMayDeclareItsOwnWith(): Unit {
        expectSameAsSqlite(CTE_SETUP, "SELECT * FROM (WITH s AS (SELECT id FROM t WHERE n = 30) SELECT id FROM s)",
            "WITH inside a FROM subquery")
    }

    @TestCase
    func aCteWithOrderByAndLimitInsideItsBody(): Unit {
        expectSameAsSqlite(CTE_SETUP,
            "WITH s AS (SELECT id, n FROM t ORDER BY n DESC LIMIT 2) SELECT * FROM s ORDER BY id",
            "CTE whose body has ORDER BY and LIMIT")
    }

    @TestCase
    func aCteMayAggregate(): Unit {
        expectSameAsSqlite(CTE_SETUP,
            "WITH s AS (SELECT n / 20 AS bucket, count(*) AS c FROM t GROUP BY n / 20) " +
                "SELECT bucket, c FROM s ORDER BY bucket", "aggregating CTE")
    }
}

@Test
class CteRecursiveTest {
    @TestCase
    func aCounterRecursesUntilTheWhereClauseStops(): Unit {
        expectSameAsSqlite(CTE_SETUP,
            "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 5) " + "SELECT * FROM cnt",
            "basic recursive counter")
    }

    @TestCase
    func theRecursiveKeywordIsOptional(): Unit {
        /*
         * 省掉 RECURSIVE 仍然可以递归。这一例要求实现按"body 里有没有自引用"
         * 判定 —— 只看关键字时这条查询会把自引用解析成"没有这张表"。
         */
        expectSameAsSqlite(CTE_SETUP,
            "WITH cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 4) SELECT * FROM cnt",
            "recursion without the RECURSIVE keyword")
    }

    @TestCase
    func aValuesSeedWorksTheSameAsASelectSeed(): Unit {
        expectSameAsSqlite(CTE_SETUP,
            "WITH RECURSIVE cnt(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM cnt WHERE x < 4) " + "SELECT * FROM cnt",
            "VALUES as the recursion seed")
    }

    @TestCase
    func unionDeduplicatesAgainstEverythingProducedSoFar(): Unit {
        /*
         * `UNION`（无 ALL）的去重不是"当前迭代内去重"，而是"对全部已产出行去重"。正因如此这条
         * 带环的递归才会终止: (x+1)%4 绕回 1 时被认出已见过。
         *
         * 只用不带环的样本时，"当前迭代去重"与"全集去重"会给出相同答案，无法区分实现差异。
         */
        expectSameAsSqlite(CTE_SETUP,
            "WITH RECURSIVE d(x) AS (SELECT 1 UNION SELECT (x + 1) % 4 FROM d) SELECT * FROM d",
            "UNION dedup terminates a cycle")
    }

    @TestCase
    func twoRecursiveTermsInterleaveOneRowAtATime(): Unit {
        /*
         * **行序判据**。输出 1,2,11,3,12 表示"取一行、跑完所有递归项、再取下一行"的
         * 队列语义。若改成"每次把全部已产出行一起交给递归项"，集合相同
         * 而顺序不同, 而 expectSameAsSqlite 是逐值逐行比的, 所以这一例抓得住。
         */
        expectSameAsSqlite(CTE_SETUP,
            "WITH RECURSIVE d(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM d WHERE x < 3 " +
                "UNION ALL SELECT x + 10 FROM d WHERE x < 3) SELECT * FROM d", "two recursive terms interleave per row")
    }

    @TestCase
    func multipleSeedRowsAllEnterTheQueueFirst(): Unit {
        // 两个种子加一个递归项时，种子全部进入队列，然后才逐个展开。
        expectSameAsSqlite(CTE_SETUP,
            "WITH RECURSIVE d(x) AS (VALUES(1),(100) UNION ALL " +
                "SELECT x + 1 FROM d WHERE x < 3 OR (x > 100 AND x < 103)) SELECT * FROM d",
            "several seed rows queue before expansion")
    }

    @TestCase
    func recursionWalksAChainOfRowsFromARealTable(): Unit {
        expectSameAsSqlite(CTE_SETUP,
            "WITH RECURSIVE p(id, v) AS (SELECT id, v FROM t WHERE id = 1 " +
                "UNION ALL SELECT t.id, t.v FROM t JOIN p ON t.id = p.id + 1) SELECT * FROM p",
            "recursive walk over a real table")
    }

    @TestCase
    func aTreeWalkVisitsRowsInQueueOrder(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE e(a INT, b INT)",
                "INSERT INTO e VALUES (1,2),(1,3),(2,4),(3,5)"
            ],
            "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT b FROM e JOIN r ON e.a = r.n) " + "SELECT * FROM r",
            "tree walk order"
        )
    }

    @TestCase
    func anUnboundedRecursionIsStoppedByTheOuterLimit(): Unit {
        expectSameAsSqlite(CTE_SETUP,
            "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt) " + "SELECT * FROM cnt LIMIT 5",
            "unbounded recursion bounded by an outer LIMIT")
    }

    @TestCase
    func aLimitInsideTheCteActsAsTheStopCondition(): Unit {
        /*
         * CTE 自带的 LIMIT/OFFSET 是停止条件，不是事后裁剪；`LIMIT 4 OFFSET 2` 在
         * 无界递归上给 3,4,5,6 —— 攒够 offset+limit 行就停, 再跳掉前 offset 行。
         *
         * 写成"先无限递归再裁剪"会挂死; 写成"只算 limit 行"会给 1,2,3,4。两种错都被这一例抓住。
         */
        expectSameAsSqlite(CTE_SETUP,
            "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 100 " +
                "LIMIT 4 OFFSET 2) SELECT * FROM cnt", "LIMIT inside the CTE stops the recursion")
    }

    @TestCase
    func aRecursiveTermMayJoinAnotherTable(): Unit {
        expectSameAsSqlite(CTE_SETUP,
            "WITH RECURSIVE two(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM two, t WHERE x < 3) " +
                "SELECT count(*) FROM two", "recursive term joined with another table")
    }

    @TestCase
    func aRecursiveCteFeedsAnOuterAggregate(): Unit {
        expectSameAsSqlite(CTE_SETUP,
            "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 10) " +
                "SELECT sum(x), max(x), count(*) FROM cnt", "aggregate over a recursive CTE")
    }
}

@Test
class CteWithDmlTest {
    @TestCase
    func withPrecedesInsertSelect(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT, n INT)",
                "INSERT INTO t VALUES (1,'a',10),(2,'b',20),(3,'c',30),(4,'d',40)",
                "CREATE TABLE dst(id INT, v TEXT)",
                "WITH s AS (SELECT id, v FROM t WHERE n > 20) INSERT INTO dst SELECT id, v FROM s"
            ],
            "SELECT id, v FROM dst ORDER BY id",
            "WITH before INSERT"
        )
    }

    @TestCase
    func withPrecedesUpdate(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INTEGER PRIMARY KEY, n INT)",
                "INSERT INTO t VALUES (1,10),(2,20),(3,30)",
                "CREATE TABLE dst(id INT, v TEXT)",
                "INSERT INTO dst VALUES (1,'one'),(2,'two'),(3,'three')",
                "WITH s AS (SELECT id FROM t WHERE n >= 20) UPDATE dst SET v = 'hit' " + "WHERE id IN (SELECT id FROM s)"
            ],
            "SELECT id, v FROM dst ORDER BY id",
            "WITH before UPDATE"
        )
    }

    @TestCase
    func withPrecedesDelete(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INTEGER PRIMARY KEY, n INT)",
                "INSERT INTO t VALUES (1,10),(2,20),(3,30)",
                "CREATE TABLE dst(id INT, v TEXT)",
                "INSERT INTO dst VALUES (1,'one'),(2,'two'),(3,'three')",
                "WITH s AS (SELECT id FROM t WHERE n = 20) DELETE FROM dst WHERE id IN (SELECT id FROM s)"
            ],
            "SELECT id, v FROM dst ORDER BY id",
            "WITH before DELETE"
        )
    }

    @TestCase
    func withMayFollowInsertInto(): Unit {
        // `INSERT INTO dst WITH s AS (…) SELECT …` 也是合法语法。前缀与这个位置是两条
        // 不同的解析路径, 各测一条。
        expectSameAsSqlite(
            [
                "CREATE TABLE dst(id INT, v TEXT)",
                "INSERT INTO dst WITH s AS (SELECT 7 AS a, 'w' AS b) SELECT a, b FROM s"
            ],
            "SELECT id, v FROM dst",
            "WITH after INSERT INTO"
        )
    }

    @TestCase
    func aRecursiveCteCanGenerateRowsToInsert(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE dst(n INT)",
                "WITH RECURSIVE g(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM g WHERE x < 6) " +
                    "INSERT INTO dst SELECT x FROM g"
            ],
            "SELECT n FROM dst ORDER BY n",
            "recursive CTE feeding an INSERT"
        )
    }
}

@Test
class CteRejectionTest {
    @TestCase
    func rejectsAnAliasCountMismatch(): Unit {
        // 不报的话多出的列静默变成 NULL, 少写的列永远引用不到。
        expectBothReject(CTE_SETUP, "WITH s(a,b) AS (SELECT 1) SELECT * FROM s", "CTE alias count mismatch")
    }

    @TestCase
    func rejectsUnknownColumnAfterAliasing(): Unit {
        expectBothReject(CTE_SETUP, "WITH s(a) AS (SELECT id FROM t) SELECT id FROM s",
            "the original column name is gone after aliasing")
    }

    @TestCase
    func rejectsDmlInsideACteBody(): Unit {
        expectBothReject(CTE_SETUP, "WITH s AS (DELETE FROM t) SELECT * FROM s", "DML inside a CTE body")
    }

    @TestCase
    func rejectsADuplicateCteName(): Unit {
        expectBothReject(CTE_SETUP, "WITH s AS (SELECT 1), s AS (SELECT 2) SELECT * FROM s", "duplicate WITH table name")
    }

    @TestCase
    func rejectsARecursionWithNoSeedTerm(): Unit {
        expectBothReject(CTE_SETUP, "WITH RECURSIVE bad(x) AS (SELECT x FROM bad) SELECT * FROM bad",
            "recursive CTE with no seed term")
    }

    @TestCase
    func rejectsTwoSelfReferencesInOneRecursiveTerm(): Unit {
        // 多处自引用必须报告 "multiple references to recursive table"。若放行，队列语义下
        // 两处自引用会各看到"当前那一行", 结果是个说不清的笛卡尔积。
        expectBothReject(CTE_SETUP,
            "WITH RECURSIVE d(x) AS (SELECT 1 UNION ALL " +
                "SELECT a.x + 1 FROM d a, d b WHERE a.x < 3 AND b.x = a.x) SELECT * FROM d",
            "two self-references in one recursive term")
    }

    @TestCase
    func rejectsAWithClauseBeforeADdlStatement(): Unit {
        expectBothReject(CTE_SETUP, "WITH s AS (SELECT 1) CREATE TABLE z(a INT)", "WITH before a DDL statement")
    }

    @TestCase
    func rejectsAnUnknownTableEvenWhenACteIsPresent(): Unit {
        // 对照: CTE 在场时"没有这张表"仍要报。不报会让拼错的表名静默解析成空行集。
        expectBothReject(CTE_SETUP, "WITH s AS (SELECT 1) SELECT * FROM nosuchtable", "unknown table alongside a CTE")
    }
}
