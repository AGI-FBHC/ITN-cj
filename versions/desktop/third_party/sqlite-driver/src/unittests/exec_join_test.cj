package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * JOIN 变体: CROSS / NATURAL / RIGHT / FULL、USING 的列合并、括号分组。
 *
 * 全部走差分判据 (expectSameAsSqlite)，重点验证 NATURAL 无公共列时退化为笛卡尔积、合并列
 * 位置跟随左表，以及 RIGHT JOIN 的右侧独有行排在末尾等不直观语义。
 *
 * 样本刻意做成**不对称**的: 左表独有 id=1, 右表独有 id=4。对称样本上 "RIGHT 写成 LEFT 的
 * 镜像" 会给出同一答案, 那样这一组用例就没有分辨力。
 */

/** 两表各有独有行的基础样本。 */
let JOIN_SETUP: Array<String> = [
    "CREATE TABLE a(id INTEGER, x TEXT)",
    "CREATE TABLE b(id INTEGER, y TEXT)",
    "INSERT INTO a VALUES (1,'a1'),(2,'a2'),(3,'a3')",
    "INSERT INTO b VALUES (2,'b2'),(3,'b3'),(4,'b4')"
]

/** 两个公共列 (id, k), 且"只有一个列相等"的行存在 —— 单列判定会多出行。 */
let TWO_KEY_SETUP: Array<String> = [
    "CREATE TABLE m1(id INTEGER, k TEXT, v1 TEXT)",
    "CREATE TABLE m2(id INTEGER, k TEXT, v2 TEXT)",
    "INSERT INTO m1 VALUES (1,'p','a'),(2,'q','b'),(2,'z','c')",
    "INSERT INTO m2 VALUES (2,'q','B'),(2,'w','C'),(5,'p','D')"
]

/** 无公共列的两张表, 供 NATURAL 退化判定用。 */
let NO_COMMON_SETUP: Array<String> = [
    "CREATE TABLE p(k INTEGER, v TEXT)",
    "CREATE TABLE r(m INTEGER, w TEXT)",
    "INSERT INTO p VALUES (1,'p1'),(2,'p2')",
    "INSERT INTO r VALUES (7,'r7'),(8,'r8')"
]

/** 三张表, gc 的连接列叫 bid —— 于是分组的条件能单独引用 gc。 */
let GROUP_SETUP: Array<String> = [
    "CREATE TABLE ga(id INTEGER, x TEXT)",
    "CREATE TABLE gb(id INTEGER, y TEXT)",
    "CREATE TABLE gc(bid INTEGER, z TEXT)",
    "INSERT INTO ga VALUES (1,'a1'),(2,'a2'),(3,'a3')",
    "INSERT INTO gb VALUES (1,'b1'),(2,'b2'),(3,'b3')",
    "INSERT INTO gc VALUES (2,'c2'),(3,'c3')"
]
/** 三表链, 供 USING 的多跳合并用。 */
let CHAIN_SETUP: Array<String> = [
    "CREATE TABLE t1(id INTEGER, v1 TEXT)",
    "CREATE TABLE t2(id INTEGER, v2 TEXT)",
    "CREATE TABLE t3(id INTEGER, v3 TEXT)",
    "INSERT INTO t1 VALUES (1,'x1'),(2,'x2')",
    "INSERT INTO t2 VALUES (2,'y2'),(3,'y3')",
    "INSERT INTO t3 VALUES (2,'z2'),(3,'z3')"
]

@Test
class CrossJoinTest {
    @TestCase
    func crossJoinIsAnUnconditionalProduct(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT count(*) FROM a CROSS JOIN b", "CROSS JOIN row count")
    }

    @TestCase
    func commaJoinBehavesLikeCrossJoin(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT a.x, b.y FROM a, b ORDER BY a.x, b.y", "comma join is a product")
    }

    @TestCase
    func crossJoinStillAcceptsAnOnClause(): Unit {
        // SQLite 接受 `CROSS JOIN … ON`: CROSS 只是禁止重排的提示, 不是"无条件"。
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a CROSS JOIN b ON a.id=b.id", "CROSS JOIN with ON")
    }
}

@Test
class JoinUsingMergeTest {
    @TestCase
    func commonColumnAppearsOnlyOnce(): Unit {
        // 行宽是判据: 未合并时每行多一个 id, 逐值比对立刻不符。
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a JOIN b USING(id)", "USING merges the common column")
    }

    @TestCase
    func mergedColumnKeepsItsNameAndPosition(): Unit {
        expectSameColumnNamesAsSqlite(JOIN_SETUP, "SELECT * FROM a JOIN b USING(id)", "merged column name list")
    }

    @TestCase
    func unqualifiedCommonColumnIsNotAmbiguous(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT id FROM a JOIN b USING(id) ORDER BY id", "bare common column resolves")
    }

    @TestCase
    func qualifiedNamesStillReachBothSides(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT a.id, b.id FROM a JOIN b USING(id) ORDER BY a.id",
            "qualified names bypass the merge")
    }

    @TestCase
    func qualifiedStarStillGivesEveryColumn(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT b.* FROM a JOIN b USING(id) ORDER BY b.id",
            "b.* is not affected by the merge")
    }
}

@Test
class JoinUsingMultiColumnTest {
    @TestCase
    func everyUsingColumnMustMatch(): Unit {
        // 样本里有"id 相等但 k 不等"的行 (m1 的 (2,'z') 与 m2 的 (2,'w')): 只判第一列的
        // 实现会多出行。
        expectSameAsSqlite(TWO_KEY_SETUP, "SELECT * FROM m1 JOIN m2 USING(id,k)", "USING with two columns")
    }

    @TestCase
    func mergedColumnOrderFollowsTheLeftTableNotTheUsingClause(): Unit {
        // USING(k,id) 与 USING(id,k) 的输出列序都跟随左表，不能按 USING 的书写顺序排列。
        expectSameAsSqlite(TWO_KEY_SETUP, "SELECT * FROM m1 JOIN m2 USING(k,id)",
            "USING column order follows the left table")
    }

    @TestCase
    func usingColumnMustExistOnBothSides(): Unit {
        expectBothReject(JOIN_SETUP, "SELECT * FROM a JOIN b USING(nosuch)", "USING names an unknown column")
    }

    @TestCase
    func usingColumnPresentOnlyOnTheLeftIsRejected(): Unit {
        expectBothReject(JOIN_SETUP, "SELECT * FROM a JOIN b USING(x)", "USING names a left-only column")
    }

    @TestCase
    func mergeSpansAWholeChainOfJoins(): Unit {
        // 三跳链上 id 是一个三成员的合并组, 未匹配行要取第一个非 NULL。
        expectSameAsSqlite(CHAIN_SETUP,
            "SELECT id, v1, v2, v3 FROM t1 LEFT JOIN t2 USING(id) LEFT JOIN t3 USING(id) ORDER BY id",
            "merge group spans three tables")
    }

    @TestCase
    func chainedMergeKeepsASingleColumnInStar(): Unit {
        expectSameAsSqlite(CHAIN_SETUP, "SELECT * FROM t1 JOIN t2 USING(id) JOIN t3 USING(id)",
            "chained USING keeps one id column")
    }

    @TestCase
    func mergedColumnUsesTheLeftColumnCollation(): Unit {
        // ca.k 是 NOCASE, cb.k 是 BINARY: 合并列的比较取**左**列的 collation, 于是
        // 'Abc' 与 'abc' 相等; 反向写则一行都不匹配。
        let setup: Array<String> = [
            "CREATE TABLE ca(k TEXT COLLATE NOCASE, v TEXT)",
            "CREATE TABLE cb(k TEXT, w TEXT)",
            "INSERT INTO ca VALUES ('Abc','v1'),('xyz','v2')",
            "INSERT INTO cb VALUES ('abc','w1'),('XYZ','w2')"
        ]
        expectSameAsSqlite(setup, "SELECT * FROM ca JOIN cb USING(k) ORDER BY v",
            "USING takes the left column collation")
        expectSameAsSqlite(setup, "SELECT count(*) FROM cb JOIN ca USING(k)", "reversed sides give the binary collation")
    }
}

@Test
class RightJoinTest {
    @TestCase
    func unmatchedRightRowsGetANullLeftSide(): Unit {
        // 不对称样本: 右独有 id=4 必须出现且左侧两列都是 NULL。写成 LEFT 的镜像会给出
        // 左独有的 id=1 那行, 与 SQLite 不符。
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a RIGHT JOIN b ON a.id=b.id",
            "RIGHT JOIN keeps unmatched right rows")
    }

    @TestCase
    func rightOnlyRowsComeLast(): Unit {
        // 行序不是"按右表顺序"也不是"原位": 匹配行先出, 右独有行全部排在最后。
        expectSameAsSqlite(JOIN_SETUP, "SELECT b.id, a.x FROM a RIGHT JOIN b ON a.id=b.id",
            "right-only rows are appended")
    }

    @TestCase
    func mergedColumnTakesTheRightValueWhenTheLeftIsNull(): Unit {
        // USING 形态的关键: 未匹配行里合并列取自右侧 (COALESCE 语义), 取左侧会给 NULL。
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a RIGHT JOIN b USING(id)",
            "RIGHT JOIN USING merges from the right")
    }

    @TestCase
    func theWholeLeftSubtreeIsNulled(): Unit {
        // 左侧是两层: 未匹配的右行里 ra 与 rb **都**要是 NULL。只给最近一层补 NULL 的
        // 实现会在 rb 上留着上一轮的值。
        let setup: Array<String> = [
            "CREATE TABLE ra(id INTEGER, x TEXT)",
            "CREATE TABLE rb(id INTEGER, y TEXT)",
            "CREATE TABLE rc(id INTEGER, z TEXT)",
            "INSERT INTO ra VALUES (1,'a1'),(2,'a2')",
            "INSERT INTO rb VALUES (2,'b2'),(3,'b3')",
            "INSERT INTO rc VALUES (3,'c3'),(4,'c4')"
        ]
        expectSameAsSqlite(setup, "SELECT * FROM ra LEFT JOIN rb ON ra.id=rb.id RIGHT JOIN rc ON rc.id=rb.id",
            "RIGHT JOIN nulls the entire left subtree")
    }

    @TestCase
    func aFalseConditionKeepsEveryRightRow(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a RIGHT JOIN b ON 0", "RIGHT JOIN with a never-true condition")
    }

    @TestCase
    func whereFiltersAfterThePadding(): Unit {
        // WHERE 作用在补完 NULL 之后: `ra.id IS NULL` 恰好只留下右独有行。
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a RIGHT JOIN b ON a.id=b.id WHERE a.id IS NULL",
            "WHERE runs after right-side padding")
    }

    @TestCase
    func limitCountsPaddedRows(): Unit {
        // 上限必须**大于**匹配行数 (这里匹配 2 行, 补 1 行): 写 LIMIT 2 时恰好只取到两条
        // 匹配行, 于是"根本不补未匹配行"的实现也给同一答案 —— 那样这一例就没有分辨力。
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a RIGHT JOIN b ON a.id=b.id LIMIT 3", "LIMIT includes padded rows")
        // 上限小于匹配行数时提前收尾, 不该把补出来的行也算进去。
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a RIGHT JOIN b ON a.id=b.id LIMIT 1",
            "LIMIT stops before the padded rows")
    }

    @TestCase
    func aggregatesCountPaddedRowsButNotNullColumns(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT count(*), count(a.id), count(b.id) FROM a RIGHT JOIN b ON a.id=b.id",
            "aggregates over padded rows")
    }

    @TestCase
    func rightOperandMayNotReferenceTheLeftSide(): Unit {
        // SQLite 也拒绝 (报 no such column): 右操作数不在左侧的作用域里。
        expectBothReject(GROUP_SETUP, "SELECT * FROM ga RIGHT JOIN (gb JOIN gc ON gc.bid=ga.id) ON 1",
            "correlated right operand")
    }
}

@Test
class FullJoinTest {
    @TestCase
    func bothSidesKeepTheirUnmatchedRows(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a FULL JOIN b ON a.id=b.id", "FULL JOIN keeps both sides")
    }

    @TestCase
    func leftOnlyRowsStayInPlaceAndRightOnlyRowsGoLast(): Unit {
        // 行序是"左主序 (左独有原位) + 右独有追加": 把两批都追加到末尾会与 SQLite 不符。
        expectSameAsSqlite(JOIN_SETUP, "SELECT a.id, b.id FROM a FULL JOIN b ON a.id=b.id", "FULL JOIN row order")
    }

    @TestCase
    func aNeverTrueConditionKeepsEveryRowFromBothSides(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a FULL JOIN b ON 0", "FULL JOIN with a never-true condition")
    }

    @TestCase
    func usingFormMergesAndPreservesBothSides(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a FULL JOIN b USING(id)", "FULL JOIN USING")
    }
}

@Test
class NaturalJoinTest {
    @TestCase
    func commonColumnsAreTakenFromTheNameIntersection(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a NATURAL JOIN b", "NATURAL JOIN uses the name intersection")
    }

    @TestCase
    func withoutCommonColumnsItDegeneratesToAProduct(): Unit {
        // 这一例与上一例配对才有分辨力: 单独看 "NATURAL 恒当 CROSS" 也能通过上一例的
        // 反面 —— 而两例并存时, 恒当 CROSS 会在有公共列时给出 9 行。
        expectSameAsSqlite(NO_COMMON_SETUP, "SELECT * FROM p NATURAL JOIN r ORDER BY k, m",
            "NATURAL JOIN without common columns")
    }

    @TestCase
    func outerFormWithoutCommonColumnsAlsoDegenerates(): Unit {
        expectSameAsSqlite(NO_COMMON_SETUP, "SELECT count(*) FROM p NATURAL LEFT JOIN r",
            "NATURAL LEFT JOIN without common columns")
    }

    @TestCase
    func leftFormKeepsUnmatchedLeftRows(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a NATURAL LEFT JOIN b", "NATURAL LEFT JOIN")
    }

    @TestCase
    func rightFormKeepsUnmatchedRightRows(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM a NATURAL RIGHT JOIN b", "NATURAL RIGHT JOIN")
    }

    @TestCase
    func fullFormKeepsBothSides(): Unit {
        expectSameAsSqlite(TWO_KEY_SETUP, "SELECT * FROM m1 NATURAL FULL JOIN m2",
            "NATURAL FULL JOIN with two common columns")
    }

    @TestCase
    func everyCommonColumnMustMatch(): Unit {
        expectSameAsSqlite(TWO_KEY_SETUP, "SELECT * FROM m1 NATURAL JOIN m2", "NATURAL JOIN with two common columns")
    }

    @TestCase
    func theIntersectionIsRecomputedForEachJoinInAChain(): Unit {
        // 第二个 NATURAL 的左侧是"已合并过"的结果: 公共列仍只算一次 id。
        expectSameAsSqlite(CHAIN_SETUP, "SELECT * FROM t1 NATURAL JOIN t2 NATURAL JOIN t3", "3-way NATURAL chain")
    }

    @TestCase
    func naturalMixesWithAnExplicitUsing(): Unit {
        expectSameAsSqlite(CHAIN_SETUP, "SELECT * FROM t1 JOIN t2 USING(id) NATURAL JOIN t3", "USING then NATURAL")
    }

    @TestCase
    func naturalMayNotCarryAnOnClause(): Unit {
        expectBothReject(JOIN_SETUP, "SELECT * FROM a NATURAL JOIN b ON a.id=b.id", "NATURAL with ON")
    }

    @TestCase
    func naturalMayNotCarryAUsingClause(): Unit {
        expectBothReject(JOIN_SETUP, "SELECT * FROM a NATURAL JOIN b USING(id)", "NATURAL with USING")
    }
}

@Test
class ParenthesizedFromGroupTest {
    @TestCase
    func groupConditionSeesTheInnermostTableOfTheSpan(): Unit {
        // 条件引用 gc —— 分组里**最后**绑定的那张表。按层级各自求值的实现会在 gb 的层上
        // 求这个条件, 那时 gc 还没绑定。
        expectSameAsSqlite(GROUP_SETUP, "SELECT * FROM ga LEFT JOIN (gb JOIN gc ON gc.bid=gb.id) ON gc.bid=ga.id",
            "group condition evaluated at the end of the span")
    }

    @TestCase
    func anUnmatchedGroupNullsEveryTableInIt(): Unit {
        // 与下一例配对: 同样的三张表写成扁平链时 ga.id=1 那行的 gb 是有值的, 而分组形态下
        // 整个跨度一起补 NULL。两例给出不同答案, 于是"把分组当扁平链"会被抓住。
        expectSameAsSqlite(GROUP_SETUP, "SELECT * FROM ga LEFT JOIN (gb JOIN gc ON gc.bid=gb.id) ON gb.id=ga.id",
            "unmatched group nulls the whole span")
    }

    @TestCase
    func theFlatChainOfTheSameThreeTablesDiffers(): Unit {
        expectSameAsSqlite(GROUP_SETUP, "SELECT * FROM ga LEFT JOIN gb ON gb.id=ga.id LEFT JOIN gc ON gc.bid=gb.id",
            "flat chain over the same tables")
    }

    @TestCase
    func groupTablesRemainVisibleOutsideTheParentheses(): Unit {
        expectSameAsSqlite(GROUP_SETUP, "SELECT gb.y, gc.z FROM ga JOIN (gb JOIN gc ON gc.bid=gb.id) ON gb.id=ga.id",
            "group tables are in the outer name scope")
    }

    @TestCase
    func aGroupAsFirstOperandIsAPlainLeftDeepChain(): Unit {
        expectSameAsSqlite(GROUP_SETUP, "SELECT * FROM (ga JOIN gb ON ga.id=gb.id) JOIN gc ON gc.bid=gb.id",
            "group as the first operand")
    }

    @TestCase
    func anOuterJoinInsideAGroupIsSupported(): Unit {
        // 连接树可以表达嵌套外连接，且 SQLite 接受该语句，因此这里必须正常执行。
        expectSameAsSqlite(GROUP_SETUP, "SELECT * FROM ga LEFT JOIN (gb LEFT JOIN gc ON gc.bid=gb.id) ON gb.id=ga.id",
            "LEFT JOIN over a group containing a LEFT JOIN")
    }

    @TestCase
    func aRightJoinInsideAGroupIsSupported(): Unit {
        expectSameAsSqlite(GROUP_SETUP, "SELECT * FROM ga LEFT JOIN (gb RIGHT JOIN gc ON gc.bid=gb.id) ON gb.id=ga.id",
            "LEFT JOIN over a group containing a RIGHT JOIN")
    }

    @TestCase
    func aGroupMayBeTheRightOperandOfARightJoin(): Unit {
        expectSameAsSqlite(GROUP_SETUP, "SELECT * FROM ga RIGHT JOIN (gb JOIN gc ON gc.bid=gb.id) ON gb.id=ga.id",
            "group as the right operand of a RIGHT JOIN")
    }

    @TestCase
    func anEmptyGroupIsASyntaxError(): Unit {
        expectBothReject(GROUP_SETUP, "SELECT * FROM ga JOIN () ON 1", "empty group")
    }
}

@Test
class JoinSubquerySourceTest {
    @TestCase
    func aFromSubqueryNeedsNoAlias(): Unit {
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM (SELECT x FROM a) ORDER BY x", "FROM subquery without an alias")
    }

    @TestCase
    func starOverAMergedJoinInsideASubqueryKeepsTheMergedWidth(): Unit {
        // 外层要靠子查询的列数建数据源: 算漏了合并会让行宽对不上。
        expectSameAsSqlite(JOIN_SETUP, "SELECT * FROM (SELECT * FROM a RIGHT JOIN b USING(id)) t",
            "merge inside a subquery")
    }

    @TestCase
    func joiningASubqueryToATableStillMerges(): Unit {
        expectSameAsSqlite(CHAIN_SETUP, "SELECT * FROM (SELECT id, v1 FROM t1) s JOIN t2 USING(id)",
            "subquery source on the left of USING")
    }
}
