package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * ORDER BY 的取值来源。
 *
 * 重点是**排序键不在结果列里**的形态 (`SELECT v FROM t ORDER BY id`): 这类项被追加成隐藏
 * 结果列参与求值, 排完序再裁掉。三处边界最容易写错, 每处都单独立例:
 *
 *   - DISTINCT: 隐藏键若参与判重, 同一可见值会因隐藏键不同而留下多行 (2 行变 3 行);
 *   - 子查询: 隐藏列没裁干净时会多出一列, 表现为 `SELECT *` 列数变多、标量子查询取错值;
 *   - 集合运算: 两侧列数必须相等, 追加隐藏列会让 UNION 的宽度校验失败。
 *
 * 判据一律用 SQLite 差分比对, 而不是手写期望值 —— 手写时若我对语义的理解本身就错, 用例
 * 会稳定地绿在错误答案上。DISTINCT 那组的样本刻意让"隐藏键顺序"与"首次出现顺序"冲突,
 * 否则两种实现都给同一答案, 用例就没有分辨力。
 */

/** 隐藏键顺序 (b=1 < a=2) 与字母序 (a < b) 相反, 于是排错了看得出来。 */
let ORDER_SETUP: Array<String> = [
    "CREATE TABLE t (id INT, v TEXT)",
    "INSERT INTO t VALUES (1, 'b'), (2, 'a'), (3, 'b')"
]

@Test
class OrderByHiddenKeyTest {
    @TestCase
    func ordersByAColumnMissingFromTheResult(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT v FROM t ORDER BY id", "ORDER BY 非结果列")
    }

    @TestCase
    func ordersDescendingByAColumnMissingFromTheResult(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT v FROM t ORDER BY id DESC", "ORDER BY 非结果列 DESC")
    }

    @TestCase
    func ordersByAnExpressionMissingFromTheResult(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT v FROM t ORDER BY -id", "ORDER BY 表达式")
    }

    @TestCase
    func ordersByTwoHiddenKeys(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT v FROM t ORDER BY v DESC, id DESC", "两个排序键")
    }

    /** 同一表达式出现在两个排序项里时只该追加一次隐藏列, 结果不受影响。 */
    @TestCase
    func reusesOneHiddenColumnForARepeatedExpression(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT v FROM t ORDER BY id, id DESC", "重复排序键")
    }

    @TestCase
    func appliesLimitAfterOrderingByAHiddenKey(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT v FROM t ORDER BY id DESC LIMIT 2", "隐藏键 + LIMIT")
    }

    @TestCase
    func keepsNullsOrderedByTheHiddenKey(): Unit {
        expectSameAsSqlite(["CREATE TABLE n (id INT, v TEXT)", "INSERT INTO n VALUES (2,'x'), (NULL,'y'), (1,'z')"],
            "SELECT v FROM n ORDER BY id", "隐藏键含 NULL")
    }
}

@Test
class OrderByHiddenKeyWithDistinctTest {
    /**
     * 隐藏键不参与 DISTINCT 判重。
     *
     * 'b' 有两行 (id=1 与 id=3)。隐藏键若算进判重, 结果是 3 行; SQLite 给 2 行, 且保留
     * 首次出现那行的键 —— 于是排序结果是 b(1), a(2) 而不是 a, b。
     */
    @TestCase
    func dedupesOnVisibleColumnsOnly(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT DISTINCT v FROM t ORDER BY id", "DISTINCT + 隐藏键")
    }

    /** 降序: 若保留的是每组最后一行的键, 答案会与 SQLite 相反。 */
    @TestCase
    func keepsTheFirstRowKeyPerGroupWhenDescending(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT DISTINCT v FROM t ORDER BY id DESC", "DISTINCT + 隐藏键 DESC")
    }

    @TestCase
    func dedupesOnVisibleColumnsWithAVisibleKey(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT DISTINCT v FROM t ORDER BY v", "DISTINCT + 可见键")
    }
}

@Test
class OrderByHiddenKeyWithGroupingTest {
    let groupSetup: Array<String> = [
        "CREATE TABLE g (grp TEXT, n INT)",
        "INSERT INTO g VALUES ('x', 10), ('x', 1), ('y', 5)"
    ]

    @TestCase
    func ordersGroupsByAnAggregateMissingFromTheResult(): Unit {
        expectSameAsSqlite(groupSetup, "SELECT grp FROM g GROUP BY grp ORDER BY count(*) DESC", "GROUP BY + 聚合排序键")
    }

    @TestCase
    func ordersGroupsByTheGroupingKey(): Unit {
        expectSameAsSqlite(groupSetup, "SELECT count(*) FROM g GROUP BY grp ORDER BY grp", "GROUP BY + 分组键排序")
    }

    /**
     * 聚合只出现在 ORDER BY 且没有 GROUP BY 时两侧都必须拒绝。
     *
     * 这条是隐藏列机制带来的新风险: 机制会老老实实把 max(id) 算成一个单桶值然后返回一行,
     * 静默给出 SQLite 不认的答案。没有这一例, 那条守卫删掉也全绿。
     */
    @TestCase
    func rejectsAnAggregateUsedOnlyInOrderBy(): Unit {
        expectBothReject(ORDER_SETUP, "SELECT v FROM t ORDER BY max(id)", "裸聚合排序键")
    }

    /** 对照组: 结果列里已有聚合时, ORDER BY 里的聚合是合法的。 */
    @TestCase
    func acceptsAnAggregateInOrderByWhenTheQueryAlreadyAggregates(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT count(*) FROM t ORDER BY max(id)", "聚合查询 + 聚合排序键")
    }
}

@Test
class OrderByHiddenColumnVisibilityTest {
    /**
     * 隐藏列没裁掉时 `SELECT *` 会多出一列。
     *
     * 带 `AS s`: 本驱动要求 FROM 子查询有别名 (exec_join.cj:724), SQLite 不要求。那是
     * 另一条独立缺口, 不在本例范围内; 这里补上别名, 免得用例红在无关的一层。
     */
    @TestCase
    func hidesTheSortKeyFromASubquery(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT * FROM (SELECT v FROM t ORDER BY id DESC) AS s", "子查询裁隐藏列")
    }

    /** 标量子查询取 row[0]: 隐藏列若插在前面就会取错值。 */
    @TestCase
    func hidesTheSortKeyFromAScalarSubquery(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT (SELECT v FROM t ORDER BY id DESC LIMIT 1)", "标量子查询裁隐藏列")
    }

    /** 列数校验会在隐藏列漏裁时直接报错, 所以这一例同时守住宽度。 */
    @TestCase
    func hidesTheSortKeyFromAnInsertSelect(): Unit {
        expectSameAsSqlite(
            [ORDER_SETUP[0], ORDER_SETUP[1], "CREATE TABLE dst (v TEXT)",
                "INSERT INTO dst SELECT v FROM t ORDER BY id DESC"], "SELECT v FROM dst", "INSERT ... SELECT 裁隐藏列")
    }

    @TestCase
    func hidesTheSortKeyFromCreateTableAsSelect(): Unit {
        expectSameAsSqlite([ORDER_SETUP[0], ORDER_SETUP[1], "CREATE TABLE copied AS SELECT v FROM t ORDER BY id"],
            "SELECT rowid, v FROM copied ORDER BY rowid", "CTAS 裁隐藏列")
    }
}

@Test
class OrderByResultColumnFormsTest {
    @TestCase
    func ordersByAnOrdinal(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT v, id FROM t ORDER BY 2 DESC", "序号排序键")
    }

    @TestCase
    func ordersByAnAlias(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT v AS w FROM t ORDER BY w", "别名排序键")
    }

    /** `ORDER BY a+b` 该复用 `SELECT a+b` 已算好的列, 而不是追加第二列。 */
    @TestCase
    func reusesAMatchingResultExpression(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT id + 1 FROM t ORDER BY id + 1 DESC", "复用结果表达式")
    }

    @TestCase
    func rejectsAnOrdinalOutOfRange(): Unit {
        expectBothReject(ORDER_SETUP, "SELECT v FROM t ORDER BY 5", "序号越界")
    }

    @TestCase
    func rejectsAnUnknownColumn(): Unit {
        expectBothReject(ORDER_SETUP, "SELECT v FROM t ORDER BY nosuch", "未知列")
    }
}

@Test
class OrderByAfterSetOperationTest {
    /** 集合运算之后排序键必须是结果列: 两侧列数要相等, 没法追加隐藏列。 */
    @TestCase
    func ordersUnionResultsByAResultColumn(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT v FROM t UNION SELECT 'c' AS v ORDER BY v DESC", "UNION + 结果列排序")
    }

    @TestCase
    func ordersUnionResultsByAnOrdinal(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT v, id FROM t UNION ALL SELECT 'c', 9 ORDER BY 2 DESC",
            "UNION ALL + 序号排序")
    }

    @TestCase
    func rejectsANonResultColumnAfterUnion(): Unit {
        expectBothReject(ORDER_SETUP, "SELECT v FROM t UNION SELECT v FROM t ORDER BY id", "UNION 后的非结果列排序键")
    }

    /** UNION 去重按可见列做; 隐藏列若漏进来, 宽度校验会先报错。 */
    @TestCase
    func dedupesUnionRowsOnAllVisibleColumns(): Unit {
        expectSameAsSqlite(ORDER_SETUP, "SELECT v FROM t UNION SELECT v FROM t ORDER BY v", "UNION 去重")
    }
}
