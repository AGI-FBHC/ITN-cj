package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 数学函数与 concat / unhex 一族。
 *
 * 判据一律与 SQLite 差分比对，重点覆盖以下容易混淆的规则：
 *
 *   - `log(X)` 是十进制对数 (log(100) = 2), 自然对数叫 ln();
 *   - `mod` 的符号随被除数，例如 mod(-7,3) = -1；
 *   - 返回类型一律 real, 含 floor / ceil / trunc / mod —— typeof(mod(7,3)) 是 'real';
 *   - 非数值输入返 NULL (sqrt('abc') = NULL), 而算术运算符在同样输入上按 0 计。
 *
 * 无 FROM 的 `SELECT expr` 就够: 这些函数逐行独立, 套一张表只增加噪声。
 */
let NO_SETUP: Array<String> = Array<String>()

@Test
class MathFunctionValueTest {
    @TestCase
    func computesRootsPowersAndExponentials(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT sqrt(2), sqrt(4), sqrt(0), pow(2,10), power(2,0.5), exp(1), exp(0)",
            "根与幂")
    }

    /** log 一族: 一参是十进制、两参是任意底、ln 才是自然对数。 */
    @TestCase
    func distinguishesLogBases(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT log(100), log(1000), ln(1), log(2,8), log(10,100), log10(1000), log2(8)",
            "log 底数")
    }

    /** ln(e) 与 log(e) 必须给出不同的值, 否则两者写成同一个也全绿。 */
    @TestCase
    func naturalLogDiffersFromBase10Log(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT ln(2.718281828459045), log(2.718281828459045)", "ln 与 log 不同")
    }

    @TestCase
    func roundsTowardFloorCeilAndZero(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT floor(1.7), floor(-1.5), ceil(1.2), ceiling(-1.2), trunc(1.7), trunc(-1.7)",
            "取整三向")
    }

    /**
     * floor/ceil/trunc 对整数输入保持 integer, 对实数给 real; 其余函数一律 real。
     *
     * 数值比对看不出类型差别，因此同时用 typeof 验证返回类型。
     */
    @TestCase
    func keepsIntegerTypeWhenRoundingIntegers(): Unit {
        expectSameAsSqlite(NO_SETUP,
            "SELECT typeof(floor(1.0)), typeof(floor(1)), typeof(ceil(2)), typeof(ceil(2.0)), " +
                "typeof(trunc(3)), typeof(trunc(3.5)), typeof(floor('2'))", "取整的返回类型")
    }

    /** 其余数学函数一律 real, 含整数入参。 */
    @TestCase
    func returnsRealFromOtherMathFunctions(): Unit {
        expectSameAsSqlite(NO_SETUP,
            "SELECT typeof(sqrt(4)), typeof(exp(0)), typeof(ln(1)), typeof(mod(7,3)), " +
                "typeof(pi()), typeof(pow(2,3)), typeof(atan2(1,1)), typeof(degrees(0))", "其余返回类型")
    }

    /** 恒等值本身也要比: 只比类型时"返回 0 但类型对"也能绿。 */
    @TestCase
    func returnsTheIntegerUnchangedWhenRounding(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT floor(1), ceil(2), trunc(3), floor('2'), floor(-4), ceil(-5)",
            "整数取整的值")
    }

    /** mod 的符号随被除数; 四种符号组合都要比。 */
    @TestCase
    func takesModuloSignFromTheDividend(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT mod(7,3), mod(-7,3), mod(7,-3), mod(-7,-3), mod(7.5,2), mod(-7.5,2)",
            "mod 符号")
    }

    @TestCase
    func returnsNullForModuloByZero(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT mod(7,0), mod(0,0), mod(7.5,0)", "mod 除零")
    }

    @TestCase
    func computesTrigonometricFunctions(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT sin(0.5), cos(0.5), tan(0.5), asin(0.5), acos(0.5), atan(0.5), atan2(1,2)",
            "三角函数")
    }

    @TestCase
    func computesHyperbolicFunctions(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT sinh(0.5), cosh(0.5), tanh(0.5), asinh(1.5), acosh(1.5), atanh(0.5)",
            "双曲函数")
    }

    @TestCase
    func convertsBetweenDegreesAndRadians(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT degrees(pi()), radians(180), degrees(0), radians(0), pi()", "角度与弧度")
    }

    /**
     * 定义域外返 NULL。
     *
     * std.math 对 sqrt / asin / acos / acosh / atanh 的越界输入**抛异常**而不是返 NaN,
     * 不挡的话整条语句失败, 而 SQLite 只是返回 NULL —— 差别是"能用与不能用"。
     */
    @TestCase
    func returnsNullOutsideTheDomain(): Unit {
        expectSameAsSqlite(NO_SETUP,
            "SELECT sqrt(-1), ln(0), ln(-1), log(0), log(-5), log2(0), log10(-1), " +
                "acosh(0.5), atanh(2), atanh(-2), asin(2), acos(-2), pow(-1,0.5)", "定义域外")
    }

    /**
     * 无穷要**保留**而不是转成 NULL, 这与上一例是两档不同的结果。
     *
     * atanh(1)、exp(1000) 和 pow(0,-1) 都返回 inf。把 Inf 一并转换为 NULL 会在
     * 这几处静默给错值; 而 atanh 恰好三档都不同 (±1 给无穷、越界给 NULL、域内给正常值),
     * 写成"越界即 NULL"在 ±1 上就错。
     */
    @TestCase
    func keepsInfinityInsteadOfNulling(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT atanh(1), atanh(-1), exp(1000), cosh(1000), sinh(-1000), pow(0,-1)",
            "无穷保留")
    }

    /** 非数值输入返 NULL, 与算术运算符的"按 0 计"相反。 */
    @TestCase
    func returnsNullForNonNumericArguments(): Unit {
        expectSameAsSqlite(NO_SETUP,
            "SELECT sqrt('abc'), floor('abc'), ln('abc'), mod('abc',3), degrees(x'41'), sqrt('4abc')", "非数值输入")
    }

    /** 但能整体解析成数的文本要照常算 —— 否则上一例用"恒返 NULL"也能绿。 */
    @TestCase
    func parsesFullyNumericTextArguments(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT sqrt('4'), floor('2.7'), floor(' 2.7 '), mod('7','3'), pow('2','3')",
            "数值文本输入")
    }

    @TestCase
    func propagatesNullArguments(): Unit {
        expectSameAsSqlite(NO_SETUP,
            "SELECT sqrt(NULL), mod(NULL,3), mod(3,NULL), log(NULL,8), atan2(NULL,1), degrees(NULL)", "NULL 传播")
    }

    /** 参数个数错要报错, 两侧都拒。 */
    @TestCase
    func rejectsWrongArgumentCounts(): Unit {
        expectBothReject(NO_SETUP, "SELECT ln(1,2)", "ln 两参")
        expectBothReject(NO_SETUP, "SELECT mod(1)", "mod 单参")
        expectBothReject(NO_SETUP, "SELECT pi(1)", "pi 带参")
        expectBothReject(NO_SETUP, "SELECT sqrt()", "sqrt 无参")
    }

    @TestCase
    func rejectsUnknownFunctionNames(): Unit {
        expectBothReject(NO_SETUP, "SELECT no_such_math_fn(1)", "不存在的函数")
    }

    /** 数学函数要能用在列上并参与 WHERE, 不只在常量上。 */
    @TestCase
    func appliesMathFunctionsToColumns(): Unit {
        expectSameAsSqlite(["CREATE TABLE m (x REAL)", "INSERT INTO m VALUES (4.0), (2.25), (-1.0), (NULL)"],
            "SELECT x, sqrt(x) FROM m WHERE sqrt(x) IS NOT NULL ORDER BY x", "列上的数学函数")
    }
}

@Test
class ConcatAndUnhexTest {
    /** concat 跳过 NULL —— 与 `||` 相反, 后者遇 NULL 整体为 NULL。 */
    @TestCase
    func concatSkipsNullsUnlikeTheOperator(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT concat('a',NULL,'b'), 'a' || NULL || 'b', concat(1,2,3), typeof(concat(1))",
            "concat 跳 NULL")
    }

    @TestCase
    func concatWsJoinsWithASeparator(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT concat_ws('-',1,2,3), concat_ws('-','a',NULL,'b'), concat_ws('','a','b')",
            "concat_ws")
    }

    /** 分隔符只落在实际输出的项之间, 故中间的 NULL 不会留下双分隔符。 */
    @TestCase
    func concatWsDoesNotDoubleSeparatorsAroundNulls(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT concat_ws(',',NULL,'a',NULL,NULL,'b',NULL), concat_ws(',',NULL,NULL)",
            "分隔符不重复")
    }

    /** 分隔符自身为 NULL 时整体返 NULL, 与"跳过 NULL 参数"是两回事。 */
    @TestCase
    func concatWsReturnsNullForANullSeparator(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT concat_ws(NULL,'a','b')", "NULL 分隔符")
    }

    @TestCase
    func rejectsConcatWithoutArguments(): Unit {
        expectBothReject(NO_SETUP, "SELECT concat()", "concat 无参")
        expectBothReject(NO_SETUP, "SELECT concat_ws()", "concat_ws 无参")
        expectBothReject(NO_SETUP, "SELECT concat_ws('-')", "concat_ws 只有分隔符")
    }

    @TestCase
    func decodesHexIntoBlobs(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT unhex('4142'), typeof(unhex('4142')), unhex(''), hex(unhex('4142'))",
            "unhex 正常")
    }

    /** 奇数个位、非法字符都返 NULL 而不是抛异常。 */
    @TestCase
    func returnsNullForMalformedHex(): Unit {
        expectSameAsSqlite(NO_SETUP, "SELECT unhex('41424'), unhex('zz'), unhex('4g'), unhex(NULL)", "unhex 非法输入")
    }

    /** 第二参给出可忽略字符集, 不在集内的非十六进制字符仍返 NULL。 */
    @TestCase
    func honoursTheIgnoredCharacterSet(): Unit {
        expectSameAsSqlite(NO_SETUP,
            "SELECT unhex('41 42',' '), unhex('41-42','-'), unhex('41 42','-'), unhex('41:42',':')", "unhex 忽略字符")
    }
}
