package sqlite_driver.unittests

import std.unittest.*
import std.unittest.testmacro.*

/*
 * WINDOW 子句 (命名窗口、基窗口继承) 与帧 EXCLUDE 的判据。
 *
 * 判据一律走 expectSameAsSqlite / expectBothReject，由 SQLite 确认基窗口帧、
 * 未知基名和其他不直观的边界语义。
 *
 * 数据形态: sum(t) 里 t 取 2 的幂, 于是和值就是"帧里有哪几行"的位图 —— 多算或少算
 * 任何一行都得到不同的数, 这是本组分辨力的来源。v 上刻意留了 peer 组 (a 分区 10,10 与
 * 20,20 各一组, b 分区 10,10 一组), 因为 EXCLUDE GROUP/TIES 只有在 peer 组大于一行时
 * 才与 CURRENT ROW 有区别 —— 全是单点 peer 的数据会让三态看起来一样, 判据随之空转。
 *
 * 一条必须守住的取舍: 带 peer 组的用例里取值函数一律取窗口 ORDER BY 的键列 v, 不取逐行
 * 不同的 t。peer 组内部的行序在 SQL 里是未定义的，取 t 会让判据依赖某一种具体排序行为；
 * 取 v（组内恒等）则与组内顺序无关。需要逐行不同的值时改用
 * 全序 ORDER BY v,id —— 那时没有 peer 组, 位置是定死的。同理, 位置型的 row_number /
 * ntile / lag / lead 也一律配全序。
 */
let EXCLUDE_SETUP: Array<String> = [
    "CREATE TABLE e (id INTEGER PRIMARY KEY, g TEXT, v INTEGER, t INTEGER, s TEXT)",
    "INSERT INTO e VALUES (1,'a',10,1,'p'),(2,'a',10,2,'q'),(3,'a',20,4,'r')," +
        "(4,'a',20,8,'s'),(5,'a',30,16,'t'),(6,'b',10,32,'u'),(7,'b',10,64,'v'),(8,'b',20,128,'w')"
]

/** 覆盖整个分区的帧。行集合与 peer 组内部序无关, 于是四态的差别只来自剔除规则本身。 */
let WHOLE_FRAME: String = "BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING"

@Test
class WindowExcludeFrameTest {
    @TestCase
    func theFourStatesRemoveDifferentRowSetsFromARowsFrame(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (PARTITION BY g ORDER BY v ROWS ${WHOLE_FRAME} EXCLUDE NO OTHERS), " +
                "sum(t) OVER (PARTITION BY g ORDER BY v ROWS ${WHOLE_FRAME} EXCLUDE CURRENT ROW), " +
                "sum(t) OVER (PARTITION BY g ORDER BY v ROWS ${WHOLE_FRAME} EXCLUDE GROUP), " +
                "sum(t) OVER (PARTITION BY g ORDER BY v ROWS ${WHOLE_FRAME} EXCLUDE TIES) FROM e ORDER BY id",
            "the four EXCLUDE states over a ROWS frame")
    }

    @TestCase
    func rangeAndGroupsFramesExcludeTheSameRowsAsRows(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (PARTITION BY g ORDER BY v RANGE ${WHOLE_FRAME} EXCLUDE GROUP), " +
                "sum(t) OVER (PARTITION BY g ORDER BY v RANGE ${WHOLE_FRAME} EXCLUDE TIES), " +
                "sum(t) OVER (PARTITION BY g ORDER BY v GROUPS ${WHOLE_FRAME} EXCLUDE GROUP), " +
                "sum(t) OVER (PARTITION BY g ORDER BY v GROUPS ${WHOLE_FRAME} EXCLUDE TIES), " +
                "sum(t) OVER (PARTITION BY g ORDER BY v GROUPS ${WHOLE_FRAME} EXCLUDE CURRENT ROW) " +
                "FROM e ORDER BY id", "EXCLUDE over RANGE and GROUPS frames")
    }
    @TestCase
    func peerAlignedRangeFramesCollapseToTheCurrentPeerGroup(): Unit {
        // RANGE CURRENT ROW..CURRENT ROW 的帧恰好就是当前 peer 组, 于是 GROUP 把它清空
        // (sum 得 NULL), 而 TIES 只留下当前行 —— 两态在这里的差别最大。
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (ORDER BY v RANGE BETWEEN CURRENT ROW AND CURRENT ROW EXCLUDE TIES), " +
                "sum(t) OVER (ORDER BY v RANGE BETWEEN CURRENT ROW AND CURRENT ROW EXCLUDE GROUP) FROM e ORDER BY id",
            "EXCLUDE over a peer-aligned RANGE frame")
    }

    @TestCase
    func groupsOffsetFramesExcludeInsideTheOffsetWindow(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (ORDER BY v GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE GROUP), " +
                "sum(t) OVER (ORDER BY v GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE TIES) FROM e ORDER BY id",
            "EXCLUDE inside a GROUPS offset frame")
    }

    @TestCase
    func rangeOffsetFramesExcludeInsideTheValueWindow(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (ORDER BY v RANGE BETWEEN 10 PRECEDING AND 10 FOLLOWING EXCLUDE GROUP), " +
                "sum(t) OVER (ORDER BY v RANGE BETWEEN 10 PRECEDING AND 10 FOLLOWING EXCLUDE TIES) FROM e ORDER BY id",
            "EXCLUDE inside a RANGE offset frame")
    }

    @TestCase
    func aTotalOrderMakesGroupBehaveLikeCurrentRow(): Unit {
        // 全序下每行自成一个 peer 组, 于是 GROUP 退化成 CURRENT ROW、TIES 退化成 NO OTHERS。
        // 这一条守的是"peer 组是按窗口 ORDER BY 算的"而不是按某个固定列。
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (ORDER BY v,id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE NO OTHERS), " +
                "sum(t) OVER (ORDER BY v,id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE CURRENT ROW), " +
                "sum(t) OVER (ORDER BY v,id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE GROUP), " +
                "sum(t) OVER (ORDER BY v,id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE TIES) FROM e ORDER BY id",
            "the four EXCLUDE states under a total window order")
    }

    @TestCase
    func aOneSidedFrameAlsoAcceptsExclude(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (ORDER BY v,id ROWS 2 PRECEDING EXCLUDE CURRENT ROW) FROM e ORDER BY id",
            "EXCLUDE after a one-sided frame")
    }

    @TestCase
    func excludeGroupEmptiesTheFrameWithoutAnOrderBy(): Unit {
        // 无窗口 ORDER BY 时整个分区互为 peer, 于是 GROUP 剔掉全部行: sum 得 NULL 而 count 得 0。
        // 这两个不同的空帧表现要一起断言 —— 只看 sum 的话"帧空了"与"和恰好是 NULL"分辨不开。
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (PARTITION BY g ROWS ${WHOLE_FRAME} EXCLUDE GROUP), " +
                "count(t) OVER (PARTITION BY g ROWS ${WHOLE_FRAME} EXCLUDE GROUP), " +
                "count(*) OVER (PARTITION BY g ROWS ${WHOLE_FRAME} EXCLUDE GROUP) FROM e ORDER BY id",
            "EXCLUDE GROUP empties the frame when the window has no ORDER BY")
    }

    @TestCase
    func excludeTiesLeavesOnlyTheCurrentRowWithoutAnOrderBy(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (PARTITION BY g ROWS ${WHOLE_FRAME} EXCLUDE TIES), " +
                "sum(t) OVER (PARTITION BY g ROWS ${WHOLE_FRAME} EXCLUDE CURRENT ROW) FROM e ORDER BY id",
            "EXCLUDE TIES and CURRENT ROW when the window has no ORDER BY")
    }

    @TestCase
    func excludeKeywordsAreCaseInsensitive(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (ORDER BY v ROWS UNBOUNDED PRECEDING exclude no others), " +
                "sum(t) OVER (ORDER BY v rows unbounded preceding Exclude Current Row) FROM e ORDER BY id",
            "EXCLUDE spelled in lower case")
    }

    @TestCase
    func excludeAppliesAfterFilter(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) FILTER (WHERE v >= 20) OVER " +
                "(PARTITION BY g ORDER BY v ROWS ${WHOLE_FRAME} EXCLUDE GROUP) FROM e ORDER BY id",
            "EXCLUDE combined with FILTER")
    }
}

/*
 * 取值函数与排名函数在 EXCLUDE 下的分工。
 *
 * 取值三函数 (first_value / last_value / nth_value) 取的是"剔除后还剩下的第几个",
 * 不是帧端点 —— 把它们实现成读端点时, 端点那一行恰好被剔掉的形态会露出来。
 * 排名与 lag/lead 则完全不看帧: 排名看 peer 组、lag/lead 按行偏移。
 */
@Test
class WindowExcludeFunctionTest {
    @TestCase
    func valueFunctionsReadWhatIsLeftAfterExcludingThePeerGroup(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, first_value(v) OVER w, last_value(v) OVER w, nth_value(v,2) OVER w FROM e " +
                "WINDOW w AS (PARTITION BY g ORDER BY v ROWS ${WHOLE_FRAME} EXCLUDE GROUP) ORDER BY id",
            "value functions under EXCLUDE GROUP")
    }

    @TestCase
    func excludeTiesLeavesTheCurrentRowVisibleToValueFunctions(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, first_value(v) OVER w, last_value(v) OVER w, nth_value(v,2) OVER w FROM e " +
                "WINDOW w AS (PARTITION BY g ORDER BY v ROWS ${WHOLE_FRAME} EXCLUDE TIES) ORDER BY id",
            "value functions under EXCLUDE TIES")
    }

    @TestCase
    func excludeCurrentRowHidesOnlyTheCurrentRowFromValueFunctions(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, first_value(v) OVER w, last_value(v) OVER w, nth_value(v,2) OVER w FROM e " +
                "WINDOW w AS (PARTITION BY g ORDER BY v ROWS ${WHOLE_FRAME} EXCLUDE CURRENT ROW) ORDER BY id",
            "value functions under EXCLUDE CURRENT ROW")
    }

    @TestCase
    func nthValueRunsOffTheEndWhenExclusionShortensTheList(): Unit {
        // b 分区剔掉 peer 组后只剩一行, 于是 nth_value(v,2) 必须是 NULL 而不是端点值。
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, nth_value(v,2) OVER w, nth_value(v,3) OVER w FROM e " +
                "WINDOW w AS (PARTITION BY g ORDER BY v ROWS ${WHOLE_FRAME} EXCLUDE GROUP) ORDER BY id",
            "nth_value past the end of the excluded list")
    }

    @TestCase
    func valueFunctionsUnderATotalOrderSeeRowSpecificValues(): Unit {
        // 全序下位置定死, 于是可以断言逐行不同的 t: 这一条能抓住"取端点而不是取剩下的第几个",
        // 而键列 v 在 peer 组内恒等, 单靠上面那几条抓不住按位置错一格的实现。
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, first_value(t) OVER w, last_value(t) OVER w, nth_value(t,2) OVER w FROM e " +
                "WINDOW w AS (ORDER BY v,id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE CURRENT ROW) " +
                "ORDER BY id", "value functions on a total order with EXCLUDE CURRENT ROW")
    }

    @TestCase
    func peerBasedRankingIgnoresExclude(): Unit {
        // rank / dense_rank / percent_rank / cume_dist 只看 peer 组, 与帧无关, 所以带 ties 的
        // 窗口序对它们是确定的 —— 不需要全序。
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, rank() OVER w, dense_rank() OVER w, percent_rank() OVER w, cume_dist() OVER w FROM e " +
                "WINDOW w AS (ORDER BY v ROWS ${WHOLE_FRAME} EXCLUDE GROUP) ORDER BY id",
            "peer-based ranking is unaffected by EXCLUDE")
    }

    @TestCase
    func positionBasedRankingIgnoresExclude(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, row_number() OVER w, ntile(3) OVER w FROM e " +
                "WINDOW w AS (ORDER BY v,id ROWS ${WHOLE_FRAME} EXCLUDE GROUP) ORDER BY id",
            "position-based ranking is unaffected by EXCLUDE")
    }

    @TestCase
    func lagAndLeadIgnoreExclude(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, lag(t) OVER w, lead(t) OVER w, lag(t,2,-1) OVER w, lead(t,2,-1) OVER w FROM e " +
                "WINDOW w AS (ORDER BY v,id ROWS ${WHOLE_FRAME} EXCLUDE GROUP) ORDER BY id",
            "lag and lead are unaffected by EXCLUDE")
    }

    @TestCase
    func groupConcatOverAnExcludedFrameSkipsThePeerGroup(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, group_concat(s,'-') OVER w FROM e " +
                "WINDOW w AS (ORDER BY v,id ROWS ${WHOLE_FRAME} EXCLUDE CURRENT ROW) ORDER BY id",
            "group_concat over an excluded frame")
    }

    @TestCase
    func minMaxAndAvgReadTheExcludedFrame(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, min(t) OVER w, max(t) OVER w, avg(t) OVER w, total(t) OVER w FROM e " +
                "WINDOW w AS (PARTITION BY g ORDER BY v ROWS ${WHOLE_FRAME} EXCLUDE GROUP) ORDER BY id",
            "min, max, avg and total over an excluded frame")
    }
}

/*
 * EXCLUDE 的语法边界。
 *
 * 这四条写错的方向都是**放宽**：本驱动若接受 SQLite 判定为语法错误的写法，会产生不兼容 SQL。
 * expectBothReject 会先确认 SQLite 确实拒绝，所以它同时
 * 守住"这条用例本身还是不是一个拒绝形态"。
 */
@Test
class WindowExcludeSyntaxTest {
    @TestCase
    func excludeRequiresAnExplicitFrame(): Unit {
        expectBothReject(EXCLUDE_SETUP, "SELECT id, sum(t) OVER (ORDER BY v EXCLUDE CURRENT ROW) FROM e",
            "EXCLUDE without a ROWS/RANGE/GROUPS frame")
    }

    @TestCase
    func excludeRequiresAFrameEvenWhenTheWindowIsNamed(): Unit {
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w FROM e WINDOW w AS (PARTITION BY g EXCLUDE GROUP) ORDER BY id",
            "EXCLUDE without a frame inside a WINDOW definition")
    }

    @TestCase
    func bareExcludeOthersIsNotAState(): Unit {
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (ORDER BY v ROWS UNBOUNDED PRECEDING EXCLUDE OTHERS) FROM e",
            "EXCLUDE OTHERS without NO")
    }

    @TestCase
    func excludeNoRequiresOthers(): Unit {
        expectBothReject(EXCLUDE_SETUP, "SELECT id, sum(t) OVER (ORDER BY v ROWS UNBOUNDED PRECEDING EXCLUDE NO) FROM e",
            "EXCLUDE NO without OTHERS")
    }

    @TestCase
    func excludeCurrentRequiresRow(): Unit {
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (ORDER BY v ROWS UNBOUNDED PRECEDING EXCLUDE CURRENT) FROM e",
            "EXCLUDE CURRENT without ROW")
    }

    @TestCase
    func excludeCannotBeAddedOnTopOfABaseWindow(): Unit {
        // EXCLUDE 与帧必须同处一个规格, 所以"基窗口给帧、派生只加 EXCLUDE"这条路不存在。
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w2 FROM e WINDOW w1 AS (ORDER BY v ROWS UNBOUNDED PRECEDING), " +
                "w2 AS (w1 EXCLUDE GROUP) ORDER BY id", "EXCLUDE added to a base window")
    }
}

/** WINDOW 子句本身: 定义、引用、重名、位置。 */
@Test
class NamedWindowTest {
    @TestCase
    func oneDefinitionServesSeveralFunctions(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w, count(*) OVER w, max(v) OVER w FROM e " +
                "WINDOW w AS (PARTITION BY g ORDER BY v) ORDER BY id", "one named window used by several functions")
    }

    @TestCase
    func windowNamesAreCaseInsensitive(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER W1 FROM e WINDOW w1 AS (PARTITION BY g ORDER BY v) ORDER BY id",
            "a window referenced with different letter case")
    }

    @TestCase
    func severalDefinitionsCoexist(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w1, sum(t) OVER w2 FROM e " +
                "WINDOW w1 AS (PARTITION BY g), w2 AS (ORDER BY v) ORDER BY id", "two named windows in one query")
    }

    @TestCase
    func aRepeatedNameResolvesToTheLastDefinition(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w1 FROM e WINDOW w1 AS (PARTITION BY g), w1 AS (PARTITION BY v) ORDER BY id",
            "a window name defined twice")
    }

    @TestCase
    func aNamedWindowWorksInsideOrderBy(): Unit {
        // ORDER BY 归最外层解析, 那时 WINDOW 子句的回填已经跑过一遍 —— 漏了第二遍回填时
        // 这一条会报 no such window。
        expectSameAsSqlite(EXCLUDE_SETUP, "SELECT id, v FROM e WINDOW w1 AS (ORDER BY v) ORDER BY sum(t) OVER w1, id",
            "a named window referenced from ORDER BY")
    }

    @TestCase
    func theWindowClauseSitsBetweenHavingAndOrderBy(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT g, sum(t) AS st, max(sum(t)) OVER w FROM e GROUP BY g HAVING sum(t) > 0 WINDOW w AS () " +
                "ORDER BY g", "the WINDOW clause after HAVING")
    }

    @TestCase
    func anEmptyDefinitionCoversTheWholeResult(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP, "SELECT id, sum(t) OVER w, sum(t) OVER () FROM e WINDOW w AS () ORDER BY id",
            "an empty window definition")
    }

    @TestCase
    func aDefinitionMayGoUnused(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP, "SELECT id FROM e WINDOW w AS (ORDER BY v) ORDER BY id",
            "an unused window definition")
    }

    @TestCase
    func aQuotedNameMatchesOnlyTheSameQuoting(): Unit {
        // 窗口名比的是 token 原文, 引号字符算在名字里面 —— 定义与引用的引号风格必须一致。
        // 这是本组最容易"顺手统一成去引号"的一处, 而那样做会让下面三条拒绝形态全被接受。
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER \"w1\" FROM e WINDOW \"w1\" AS (PARTITION BY g ORDER BY v) ORDER BY id",
            "a double-quoted window name used with the same quoting")
    }

    @TestCase
    func quotingStyleIsPartOfTheName(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER [w1], sum(t) OVER `w2` FROM e " +
                "WINDOW [w1] AS (PARTITION BY g), `w2` AS (ORDER BY v) ORDER BY id",
            "bracket and backtick quoted window names")
    }

    @TestCase
    func lettersInsideQuotesStillFoldCase(): Unit {
        // 原文比较是大小写无关的, 所以 "W1" 与 "w1" 仍是同一个名字 —— 别把"按原文比"实现成
        // "逐字节相等"。
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER \"W1\" FROM e WINDOW \"w1\" AS (ORDER BY v) ORDER BY id",
            "a quoted window name in different letter case")
    }

    @TestCase
    func aQuotedUseDoesNotFindABareDefinition(): Unit {
        expectBothReject(EXCLUDE_SETUP, "SELECT id, sum(t) OVER \"w1\" FROM e WINDOW w1 AS (ORDER BY v) ORDER BY id",
            "a quoted reference to a bare definition")
    }

    @TestCase
    func aBareUseDoesNotFindAQuotedDefinition(): Unit {
        expectBothReject(EXCLUDE_SETUP, "SELECT id, sum(t) OVER w1 FROM e WINDOW \"w1\" AS (ORDER BY v) ORDER BY id",
            "a bare reference to a quoted definition")
    }

    @TestCase
    func differentQuotingStylesAreDifferentNames(): Unit {
        expectBothReject(EXCLUDE_SETUP, "SELECT id, sum(t) OVER [w1] FROM e WINDOW \"w1\" AS (ORDER BY v) ORDER BY id",
            "a bracket reference to a double-quoted definition")
    }

    @TestCase
    func aNameMayBeSpelledWithSpacesInsideQuotes(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER \"w 1\" FROM e WINDOW \"w 1\" AS (ORDER BY v) ORDER BY id",
            "a quoted window name containing a space")
    }

    @TestCase
    func aQuotedClauseKeywordIsAName(): Unit {
        // 引号的作用是"这是名字, 别当关键字看"。按去引号后的文本判子句引导词会把这里的
        // "order" 读成 ORDER 子句, 于是一条合法 SQL 被拒 —— 方向与其余各条相反。
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (\"order\" ORDER BY v), sum(t) OVER (\"rows\" ORDER BY v) FROM e " +
                "WINDOW \"order\" AS (PARTITION BY g), \"rows\" AS (PARTITION BY v) ORDER BY id",
            "quoted clause keywords used as base window names")
    }

    @TestCase
    func bareExcludeIsALegalBaseWindowName(): Unit {
        // EXCLUDE 只能跟在帧后面, 所以出现在规格开头时只可能是名字。把它当引导词会让这条
        // 报"EXCLUDE 需要显式帧", 指向一个与实际问题无关的位置。
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (exclude ORDER BY v) FROM e WINDOW exclude AS (PARTITION BY g) ORDER BY id",
            "a window named exclude used as a base window")
    }

    @TestCase
    func bareClauseKeywordsAreNotBaseWindowNames(): Unit {
        // 反向: 裸的 ROWS 在规格开头一定是帧引导词, 于是它后面跟 ORDER BY 是语法错。
        // 这一条与上一条一起把引导词清单的边界钉住 —— 只放宽一侧会让另一侧静默失效。
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (rows ORDER BY v) FROM e WINDOW rows AS (PARTITION BY g) ORDER BY id",
            "a bare ROWS in the base-window position")
    }

    @TestCase
    func aWindowMayShareItsNameWithAColumn(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP, "SELECT id, sum(t) OVER v FROM e WINDOW v AS (ORDER BY v) ORDER BY id",
            "a window named like a column")
    }

    @TestCase
    func aNamedDefinitionCarriesItsExcludeToEveryUse(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w, first_value(v) OVER w, count(t) OVER w FROM e " +
                "WINDOW w AS (ORDER BY v ROWS ${WHOLE_FRAME} EXCLUDE GROUP) ORDER BY id",
            "EXCLUDE carried by a named window")
    }

    @TestCase
    func anUnknownWindowNameIsRejected(): Unit {
        expectBothReject(EXCLUDE_SETUP, "SELECT id, sum(t) OVER nope FROM e", "OVER with an undefined window name")
    }

    @TestCase
    func aWindowFunctionIsRejectedInWhere(): Unit {
        expectBothReject(EXCLUDE_SETUP, "SELECT id FROM e WHERE sum(t) OVER (ORDER BY v) > 1",
            "a window function in WHERE")
    }

    @TestCase
    func aWindowFunctionIsRejectedInHaving(): Unit {
        expectBothReject(EXCLUDE_SETUP, "SELECT g, sum(t) FROM e GROUP BY g HAVING sum(t) OVER (ORDER BY g) > 0",
            "a window function in HAVING")
    }
}

/*
 * 基窗口继承。
 *
 * 三条约束与"基名找不到怎么办"合起来是本组最容易实现错的地方, 而**四条规则彼此不对称**:
 *
 *   1. 派生规格写 PARTITION BY -> 一律拒 (不问基窗口有没有分区)。
 *   2. 派生规格写 ORDER BY     -> 只有基窗口也有 ORDER BY 时才拒。
 *   3. 基窗口带显式帧          -> 一律拒（不问派生侧写不写帧）。报错文本虽为
 *      "cannot override frame specification"，但不能据此放宽为"只有派生侧再写帧才拒"。
 *   4. WINDOW 定义里的基名: **最左那条**从不解析 (整条丢掉, 上面三条检查也全不跑),
 *      第 2 条起必须在它左边的定义里找得到, 否则报 no such window。
 *      而内联 `OVER (基名 …)` 与 `OVER 名字` 查的是整份清单, 找不到一律报错。
 *
 * 检查优先级: PARTITION -> ORDER BY -> frame。
 */
@Test
class NamedWindowBaseTest {
    @TestCase
    func aBaseWindowLendsItsPartitionToTheDerivedWindow(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w2 FROM e WINDOW w1 AS (PARTITION BY g), w2 AS (w1 ORDER BY v) ORDER BY id",
            "a derived window inheriting PARTITION BY")
    }

    @TestCase
    func anInlineSpecMayInheritFromANamedWindow(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (w1 ORDER BY v) FROM e WINDOW w1 AS (PARTITION BY g) ORDER BY id",
            "an inline spec inheriting from a named window")
    }

    @TestCase
    func theInheritedOrderByChangesTheDefaultFrame(): Unit {
        // 默认帧在无排序时覆盖整个分区, 有排序时只到当前行的 peer 末尾。基窗口的排序是在
        // 解析完规格之后才并进来的, 所以合并后必须再纠正一次默认帧 —— 漏了这一步时这条
        // 用例会给出"整个分区求和"而不是"累计到 peer 末尾"。
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (w1), sum(t) OVER w2 FROM e " +
                "WINDOW w1 AS (PARTITION BY g ORDER BY v), w2 AS (w1) ORDER BY id",
            "the frame default after inheriting an ORDER BY")
    }

    @TestCase
    func aDerivedWindowMayAddAFrameToABaseWithoutOne(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w2, sum(t) OVER (w1 ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM e " +
                "WINDOW w1 AS (PARTITION BY g), w2 AS (w1 ORDER BY v ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) " +
                "ORDER BY id", "a derived window adding a frame")
    }

    @TestCase
    func aChainOfBaseWindowsResolvesLeftToRight(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w3 FROM e " +
                "WINDOW w1 AS (PARTITION BY g), w2 AS (w1 ORDER BY v), w3 AS (w2) ORDER BY id",
            "a three-link chain of base windows")
    }

    @TestCase
    func theBaseLookupSeesDefinitionsWrittenLater(): Unit {
        // 内联形态查的是整份清单, 所以基名可以指向写在后面的定义 —— 与 WINDOW 定义自身
        // 只能向左看恰好相反。
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (w2 ORDER BY v) FROM e WINDOW w1 AS (), w2 AS (PARTITION BY g) ORDER BY id",
            "an inline base name pointing at a later definition")
    }

    @TestCase
    func aRepeatedBaseNameResolvesToTheLastOneWritten(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (w1 ORDER BY v) FROM e " +
                "WINDOW w1 AS (PARTITION BY g), w1 AS (PARTITION BY v) ORDER BY id",
            "an inline base name with two candidates")
    }

    @TestCase
    func theBaseNameOfTheFirstDefinitionIsDroppedWithoutAnyCheck(): Unit {
        // 不对称规则 4 的最强形态: 这里的基窗口 w2 带显式帧, 若基名真的被解析,
        // 规则 3 就该把整条查询拒掉。SQLite 接受它, 因为最左那条定义的基名从不解析。
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w1 FROM e " +
                "WINDOW w1 AS (w2 ROWS 1 PRECEDING), w2 AS (ORDER BY v ROWS UNBOUNDED PRECEDING) ORDER BY id",
            "the first definition ignores its base name entirely")
    }

    @TestCase
    func theFirstDefinitionMayNameItself(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP, "SELECT id, sum(t) OVER w1 FROM e WINDOW w1 AS (w1 ORDER BY v) ORDER BY id",
            "a self-referencing first definition")
    }

    @TestCase
    func theFirstDefinitionMayNameALaterOne(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w1 FROM e WINDOW w1 AS (w2 ORDER BY v), w2 AS (PARTITION BY g) ORDER BY id",
            "a forward-referencing first definition")
    }

    @TestCase
    func theFirstDefinitionMayNameSomethingThatDoesNotExist(): Unit {
        expectSameAsSqlite(EXCLUDE_SETUP, "SELECT id, sum(t) OVER w1 FROM e WINDOW w1 AS (zz ORDER BY v) ORDER BY id",
            "a first definition naming an undefined base")
    }

    @TestCase
    func aLaterDefinitionRejectsAnUnknownBaseName(): Unit {
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w1 FROM e WINDOW w0 AS (), w1 AS (zz ORDER BY v) ORDER BY id",
            "a second definition naming an undefined base")
    }

    @TestCase
    func aLaterDefinitionRejectsItself(): Unit {
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w1 FROM e WINDOW w0 AS (), w1 AS (w1 ORDER BY v) ORDER BY id",
            "a self-referencing second definition")
    }

    @TestCase
    func aLaterDefinitionRejectsAForwardReference(): Unit {
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w1 FROM e WINDOW w0 AS (), w1 AS (w2 ORDER BY v), w2 AS () ORDER BY id",
            "a forward-referencing second definition")
    }

    @TestCase
    func anUnusedLaterDefinitionIsStillChecked(): Unit {
        expectBothReject(EXCLUDE_SETUP, "SELECT id FROM e WINDOW w0 AS (), w1 AS (zz ORDER BY v) ORDER BY id",
            "an unused second definition with a bad base name")
    }

    @TestCase
    func anInlineBaseNameMustExist(): Unit {
        expectBothReject(EXCLUDE_SETUP, "SELECT id, sum(t) OVER (nope ORDER BY v) FROM e",
            "an inline base name that is not defined")
    }

    @TestCase
    func aBaseWindowWithAnExplicitFrameIsRejected(): Unit {
        // 规则 3。派生侧一个字都没多写, 依然拒 —— 报错文本里的 "override" 是误导。
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w2 FROM e WINDOW w1 AS (ORDER BY v ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING), " +
                "w2 AS (w1) ORDER BY id", "a base window that carries an explicit frame")
    }

    @TestCase
    func aBaseWindowWithAFrameIsRejectedForInlineUseToo(): Unit {
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER (w1 ORDER BY v) FROM e " +
                "WINDOW w1 AS (PARTITION BY g ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) ORDER BY id",
            "an inline use of a base window that carries a frame")
    }

    @TestCase
    func aBaseWindowWithAFrameIsRejectedMidChain(): Unit {
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w3 FROM e WINDOW w1 AS (PARTITION BY g), " +
                "w2 AS (w1 ORDER BY v ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING), w3 AS (w2) ORDER BY id",
            "a mid-chain base window that carries a frame")
    }

    @TestCase
    func aDerivedWindowMayNotAddPartitionBy(): Unit {
        // 规则 1。基窗口这里**没有**分区, 派生侧仍然不许写 —— 只在"两边都有"时才拒的实现
        // 会放过它。
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w2 FROM e WINDOW w1 AS (ORDER BY v), w2 AS (w1 PARTITION BY g) ORDER BY id",
            "a derived window adding PARTITION BY to a base without one")
    }

    @TestCase
    func aDerivedWindowMayNotAddPartitionByToAnEmptyBase(): Unit {
        expectBothReject(EXCLUDE_SETUP, "SELECT id, sum(t) OVER (w1 PARTITION BY g) FROM e WINDOW w1 AS () ORDER BY id",
            "an inline spec adding PARTITION BY to an empty base")
    }

    @TestCase
    func aDerivedWindowMayNotOverrideOrderBy(): Unit {
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w2 FROM e WINDOW w1 AS (ORDER BY g), w2 AS (w1 ORDER BY v) ORDER BY id",
            "a derived window overriding ORDER BY")
    }

    @TestCase
    func partitionIsCheckedBeforeOrderByAndFrame(): Unit {
        // 三条同时违反时报的是 PARTITION 那条。用 expectBothReject 只能证"都拒", 优先级
        // 靠下面这条单独违反 ORDER BY 的用例与它对照 —— 两条报错文本不同, 但差分判据只
        // 看拒不拒, 所以这里的价值是形态覆盖而不是文本比对。
        expectBothReject(EXCLUDE_SETUP,
            "SELECT id, sum(t) OVER w2 FROM e " + "WINDOW w1 AS (PARTITION BY g ORDER BY v ROWS UNBOUNDED PRECEDING), " +
                "w2 AS (w1 PARTITION BY v ORDER BY g ROWS 1 PRECEDING) ORDER BY id",
            "all three base-window constraints violated at once")
    }
}
