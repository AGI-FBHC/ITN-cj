package sqlite_driver.unittests

import std.unittest.*
import std.unittest.testmacro.*

/*
 * 优化器提示函数 likely / unlikely / likelihood。
 *
 * 三个函数在 SQLite 里都是**恒等**的 —— 它们只影响代价估算, 不改结果。所以"结果对不对"
 * 这一层用 expectSameAsSqlite 就够。真正需要判据的是 likelihood 的第二参校验:
 * 它校验的是**字面量本身**而不是求值结果, 于是 `0.5+0.1` 被拒而 `0.6` 通过 —— 求值后
 * 这两者已经无从分辨。整数 `0`/`1` 也被拒, 尽管它们在数值上落在 [0,1] 内。
 *
 * 每条被拒形态都通过 expectBothReject 与 SQLite 核对；SQLite 未拒绝时，
 * 用例会直接失败，从而同时检验拒绝前提。
 */
private let hintSetup: Array<String> = [
    "CREATE TABLE h(x INT, s TEXT)",
    "INSERT INTO h VALUES(7,'a'),(NULL,'b')"
]

@Test
class FunctionHintTest {
    /** 三个函数都是恒等: 原样返回第一个参数, NULL 也照传。 */
    @TestCase
    func hintFunctionsAreIdentity(): Unit {
        expectSameAsSqlite(hintSetup, "SELECT likely(x), unlikely(x), likelihood(x, 0.5) FROM h ORDER BY rowid",
            "likely/unlikely/likelihood pass the value through")
        expectSameAsSqlite(hintSetup, "SELECT likely(s), unlikely(s) FROM h ORDER BY rowid", "hints on a TEXT column")
        expectSameAsSqlite(hintSetup, "SELECT likely(NULL) IS NULL, unlikely(NULL) IS NULL FROM h LIMIT 1",
            "hints keep NULL as NULL")
    }

    /** 概率的两个端点都是合法字面量。 */
    @TestCase
    func likelihoodAcceptsTheClosedZeroToOneRange(): Unit {
        expectSameAsSqlite(hintSetup, "SELECT likelihood(x, 0.0), likelihood(x, 1.0) FROM h ORDER BY rowid",
            "likelihood at both ends of [0.0, 1.0]")
    }

    /**
     * 整数 0 / 1 被拒。
     *
     * 这一条最容易实现错: 数值上 0 与 1 都在 [0,1] 内, 若把第二参 coerce 成 Float64 再比较,
     * 它们就通过了 —— 而 SQLite 要求是 REAL **字面量**。
     */
    @TestCase
    func likelihoodRejectsIntegerLiterals(): Unit {
        expectBothReject(hintSetup, "SELECT likelihood(x, 0) FROM h", "likelihood with integer 0")
        expectBothReject(hintSetup, "SELECT likelihood(x, 1) FROM h", "likelihood with integer 1")
    }

    /** 越界的概率被拒, 两个方向都要覆盖。 */
    @TestCase
    func likelihoodRejectsProbabilitiesOutsideTheRange(): Unit {
        expectBothReject(hintSetup, "SELECT likelihood(x, 1.5) FROM h", "likelihood above 1.0")
        expectBothReject(hintSetup, "SELECT likelihood(x, -0.5) FROM h", "likelihood below 0.0")
    }

    /**
     * 表达式被拒, 即使它求值后落在范围内。
     *
     * `0.5+0.1` 与字面量 `0.6` 求值结果相同, 所以这一条是"校验的是字面量而不是值"的
     * 唯一判据: 实现若先求值再判范围, 这条会通过而其余全对。
     */
    @TestCase
    func likelihoodRejectsAnExpressionEvenWhenItEvaluatesInRange(): Unit {
        expectBothReject(hintSetup, "SELECT likelihood(x, 0.5+0.1) FROM h", "likelihood with an expression")
        expectSameAsSqlite(hintSetup, "SELECT likelihood(x, 0.6) FROM h ORDER BY rowid",
            "the same value written as a literal is accepted")
    }

    /** 参数个数错在三个函数上都要报。 */
    @TestCase
    func wrongArgumentCountsAreRejected(): Unit {
        expectBothReject(hintSetup, "SELECT likelihood(x) FROM h", "likelihood with one argument")
        expectBothReject(hintSetup, "SELECT likelihood(x, 0.5, 0.5) FROM h", "likelihood with three arguments")
        expectBothReject(hintSetup, "SELECT likely(x, 1) FROM h", "likely with two arguments")
        expectBothReject(hintSetup, "SELECT unlikely() FROM h", "unlikely with no argument")
    }
}
