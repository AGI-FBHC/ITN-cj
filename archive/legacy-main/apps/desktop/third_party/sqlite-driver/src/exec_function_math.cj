package sqlite_driver

import std.collection.*
import std.math.*

/*
 * 数学函数与 concat / unhex 一族。
 *
 * 与 exec_function.cj 里的算术**取值规则不同**, 这是本文件单独成篇的理由:
 * 算术运算把无法转换的文本按 0 处理，而数学函数对同样的输入返回 NULL，因此数学函数统一通过
 * mathArgument() 取参，不能复用 coerceNumeric。
 *
 * 除 floor、ceil 和 trunc 的整数输入外，数学函数返回 REAL；例如 mod 的结果类型为 REAL。
 */

/** 声明在使用之前: 仓颉的顶层 const 在同一文件里必须先声明后引用。 */
const MATH_PI: Float64 = 3.141592653589793

/**
 * 数学函数的取参: 非数值一律 None (调用方转成 NULL)。
 *
 * NULL / BLOB / 不能整体解析成数的文本都算非数值。文本的界与 textToNumber 一致 ——
 * `'4abc'` 不是数, 与 SQLite 的 `sqrt('4abc')` = NULL 相符。
 */
func mathArgument(v: SqliteValue): Option<Float64> {
    match (v) {
        case SNull => None
        case SInt(i) => Some(Float64(i))
        case SReal(d) => Some(d)
        case SBlob(_) => None
        case SText(s) => match (textToNumber(s)) {
            case Some(num) => Some(valueToFloat(num))
            case None => None
        }
    }
}

/** 单参数学函数的公共外壳: 取参、非数值返 NULL、NaN 结果返 NULL。 */
func mathUnary(f: FuncExpr, args: Array<SqliteValue>, compute: (Float64) -> Float64): SqliteValue {
    requireArgCount(f, args, 1, 1)
    match (mathArgument(args[0])) {
        case None => SqliteValue.SNull
        case Some(x) => nanToNull(compute(x))
    }
}

/**
 * NaN 转 NULL, 但**无穷保留**。
 *
 * `sqrt(-1)` 产生 NaN 并转换为 NULL，`exp(1000)`、`cosh(1000)` 和 `atanh(1)` 产生 Inf。
 * Inf 是有效浮点结果，不能与 NaN 一起转换为 NULL。
 *
 * NaN 不能放过是因为 SQLite 的文件格式没有 NaN 的表示 —— 写库时会被当成 NULL, 于是
 * "内存里是 NaN、落盘后是 NULL"两处不一致。Inf 在格式里是正常的 8 字节浮点, 不受此限。
 */
func nanToNull(x: Float64): SqliteValue {
    if (x.isNaN()) {
        return SqliteValue.SNull
    }
    SqliteValue.SReal(x)
}

/** 分派数学函数; 返回 None 表示名字不属于本组, 由调用方继续找。 */
func evalMathFunction(f: FuncExpr, args: Array<SqliteValue>, lower: String): Option<SqliteValue> {
    match (lower) {
        case "sqrt" => Some(mathUnary(f, args, {x => sqrtOrNaN(x)}))
        case "floor" => Some(mathRoundToward(f, args, {x => floor(x)}))
        case "ceil" | "ceiling" => Some(mathRoundToward(f, args, {x => ceil(x)}))
        case "trunc" => Some(mathRoundToward(f, args, {x => trunc(x)}))
        case "exp" => Some(mathUnary(f, args, {x => exp(x)}))
        case "ln" => Some(mathUnary(f, args, {x => logOrNaN(x)}))
        case "log10" => Some(mathUnary(f, args, {x => log10OrNaN(x)}))
        case "log2" => Some(mathUnary(f, args, {x => log2OrNaN(x)}))
        case "log" => Some(scalarLog(f, args))
        case "pow" | "power" => Some(mathBinary(f, args, {x, y => pow(x, y)}))
        case "mod" => Some(scalarMod(f, args))
        case "atan2" => Some(mathBinary(f, args, {x, y => atan2(x, y)}))
        case "pi" => Some(scalarPi(f, args))
        case "sin" => Some(mathUnary(f, args, {x => sin(x)}))
        case "cos" => Some(mathUnary(f, args, {x => cos(x)}))
        case "tan" => Some(mathUnary(f, args, {x => tan(x)}))
        case "asin" => Some(mathUnary(f, args, {x => arcInUnitRange(x, true)}))
        case "acos" => Some(mathUnary(f, args, {x => arcInUnitRange(x, false)}))
        case "atan" => Some(mathUnary(f, args, {x => atan(x)}))
        case "sinh" => Some(mathUnary(f, args, {x => sinh(x)}))
        case "cosh" => Some(mathUnary(f, args, {x => cosh(x)}))
        case "tanh" => Some(mathUnary(f, args, {x => tanh(x)}))
        case "asinh" => Some(mathUnary(f, args, {x => asinh(x)}))
        case "acosh" => Some(mathUnary(f, args, {x => acoshOrNaN(x)}))
        case "atanh" => Some(mathUnary(f, args, {x => atanhOrInf(x)}))
        case "degrees" => Some(mathUnary(f, args, {x => x * 180.0 / MATH_PI}))
        case "radians" => Some(mathUnary(f, args, {x => x * MATH_PI / 180.0}))
        case _ => None
    }
}

/*
 * std.math 的定义域外行为分两派, 必须逐个挡在调用之前:
 *
 *   - sqrt / asin / acos / acosh / atanh 抛 IllegalArgumentException;
 *   - log 一族与 pow 返回 NaN / Inf。
 *
 * 抛出来的那一派若不挡, `SELECT sqrt(-1)` 会让整条语句失败, 而 SQLite 只是返回 NULL。
 * 这不是"结果不同", 是"能用与不能用"的差别。
 */
func sqrtOrNaN(x: Float64): Float64 {
    if (x < 0.0) {
        return Float64.NaN
    }
    sqrt(x)
}

/** asin / acos 的定义域是 [-1, 1]; 越界时 SQLite 返 NULL, 故给 NaN。 */
func arcInUnitRange(x: Float64, isAsin: Bool): Float64 {
    if (x < -1.0 || x > 1.0) {
        return Float64.NaN
    }
    if (isAsin) {
        asin(x)
    } else {
        acos(x)
    }
}

func acoshOrNaN(x: Float64): Float64 {
    if (x < 1.0) {
        return Float64.NaN
    }
    acosh(x)
}

/**
 * atanh 的两个边界值给无穷而不是 NULL。
 *
 * atanh(1) 和 atanh(-1) 分别返回正负无穷；绝对值大于 1 时返回 NULL。
 */
func atanhOrInf(x: Float64): Float64 {
    if (x == 1.0) {
        return Float64.Inf
    }
    if (x == -1.0) {
        return -Float64.Inf
    }
    if (x < -1.0 || x > 1.0) {
        return Float64.NaN
    }
    atanh(x)
}

/**
 * floor / ceil / trunc 对整数输入是恒等的, 且**保持 INTEGER 类型**。
 *
 * 整数输入保持 INTEGER，浮点输入返回 REAL；可解析为整数的文本也返回 INTEGER。
 */
func mathRoundToward(f: FuncExpr, args: Array<SqliteValue>, compute: (Float64) -> Float64): SqliteValue {
    requireArgCount(f, args, 1, 1)
    match (args[0]) {
        case SNull => return SqliteValue.SNull
        case _ => ()
    }
    // 先看归一后的存储类: 整数 (含 '2' 这类整数文本) 原样返回。
    let numeric = match (args[0]) {
        case SInt(_) => args[0]
        case SReal(_) => args[0]
        case SText(s) => match (textToNumber(s)) {
            case Some(n) => n
            case None => return SqliteValue.SNull
        }
        case SBlob(_) => return SqliteValue.SNull
        case SNull => return SqliteValue.SNull
    }
    match (numeric) {
        case SInt(i) => SqliteValue.SInt(i)
        case SReal(d) => nanToNull(compute(d))
        case _ => SqliteValue.SNull
    }
}

/*
 * log 一族的定义域: x <= 0 时 SQLite 返 NULL。
 *
 * std.math 的 log(0.0) 给 -Inf, 而 nanToNull **保留** Inf —— 所以这里必须显式判定,
 * 不判就会返回 -inf 而 SQLite 返回 NULL。log(-1.0) 给 NaN, 那条恰好自动正确,
 * 但两个入口写成一致更省心。
 */
func logOrNaN(x: Float64): Float64 {
    if (x <= 0.0) {
        return Float64.NaN
    }
    log(x)
}

func log10OrNaN(x: Float64): Float64 {
    if (x <= 0.0) {
        return Float64.NaN
    }
    log10(x)
}

func log2OrNaN(x: Float64): Float64 {
    if (x <= 0.0) {
        return Float64.NaN
    }
    log2(x)
}

func mathBinary(f: FuncExpr, args: Array<SqliteValue>, compute: (Float64, Float64) -> Float64): SqliteValue {
    requireArgCount(f, args, 2, 2)
    match ((mathArgument(args[0]), mathArgument(args[1]))) {
        case (Some(x), Some(y)) => nanToNull(compute(x, y))
        case _ => SqliteValue.SNull
    }
}

/**
 * `log(X)` 是**十进制**对数, `log(B, X)` 才是任意底 —— 不是自然对数。
 *
 * 自然对数叫 ln()。若把 log() 误作自然对数，`log(100)` 会返回 4.6 而不是 2，且不会报错。
 */
func scalarLog(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, 2)
    if (args.size == 1) {
        return match (mathArgument(args[0])) {
            case None => SqliteValue.SNull
            case Some(x) => nanToNull(log10OrNaN(x))
        }
    }
    match ((mathArgument(args[0]), mathArgument(args[1]))) {
        case (Some(b), Some(x)) =>
            if (b <= 0.0 || b == 1.0 || x <= 0.0) {
                return SqliteValue.SNull
            }
            nanToNull(log(x) / log(b))
        case _ => SqliteValue.SNull
    }
}

/**
 * `mod(X, Y)`: 取余，符号随被除数，Y = 0 返回 NULL。
 *
 * 例如 mod(-7, 3) = -1.0，mod(7, -3) = 1.0。
 */
func scalarMod(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 2, 2)
    match ((mathArgument(args[0]), mathArgument(args[1]))) {
        case (Some(x), Some(y)) =>
            if (y == 0.0) {
                return SqliteValue.SNull
            }
            nanToNull(x - y * trunc(x / y))
        case _ => SqliteValue.SNull
    }
}

func scalarPi(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 0, 0)
    SqliteValue.SReal(MATH_PI)
}

/*
 * 字符串一族。
 */

/**
 * `concat(...)`: 拼接并**跳过** NULL, 结果恒为 TEXT。
 *
 * 与 `||` 运算符相反 —— 后者遇 NULL 整个表达式为 NULL。两者形似而语义相反,
 * 故不能把 concat 实现成一串 `||`。至少要一个参数。
 */
func scalarConcat(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, -1)
    let sb = StringBuilder()
    for (a in args) {
        match (a) {
            case SNull => ()
            case _ => sb.append(valueToText(a))
        }
    }
    SqliteValue.SText(sb.toString())
}

/**
 * `concat_ws(sep, ...)`: 用 sep 连接其余参数, 跳过 NULL 参数。
 *
 * sep 自身为 NULL 时整体返 NULL (与跳过 NULL 参数是两回事)。分隔符只加在
 * **实际输出**的项之间, 故 `concat_ws('-','a',NULL,'b')` 是 `a-b` 而不是 `a--b`。
 */
func scalarConcatWs(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 2, -1)
    match (args[0]) {
        case SNull => return SqliteValue.SNull
        case _ => ()
    }
    let sep = valueToText(args[0])
    let sb = StringBuilder()
    var wrote = false
    for (i in 1..args.size) {
        match (args[i]) {
            case SNull => ()
            case v =>
                if (wrote) {
                    sb.append(sep)
                }
                sb.append(valueToText(v))
                wrote = true
        }
    }
    SqliteValue.SText(sb.toString())
}

/**
 * `unhex(X [, ignoredChars])`: 十六进制文本转 BLOB, 非法输入返 NULL。
 *
 * 非法含: 奇数个有效十六进制位、出现既非十六进制位也不在 ignoredChars 里的字符。
 * 不复用 sql_lexer 的 hexToBytes —— 那个对非法位抛 SqliteSyntaxException,
 * 而这里要的是返回 NULL。
 */
func scalarUnhex(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, 2)
    match (args[0]) {
        case SNull => return SqliteValue.SNull
        case _ => ()
    }
    var ignored = Array<Byte>()
    if (args.size == 2) {
        match (args[1]) {
            case SNull => return SqliteValue.SNull
            case v => ignored = valueToText(v).toArray()
        }
    }
    let bs = valueToText(args[0]).toArray()
    let digits = ArrayList<Int64>()
    for (b in bs) {
        let d = hexDigitOrNegative(Int64(b))
        if (d >= 0) {
            digits.add(d)
        } else if (!byteIsIn(b, ignored)) {
            return SqliteValue.SNull
        }
    }
    if (digits.size % 2 != 0) {
        return SqliteValue.SNull
    }
    let out = Array<Byte>(digits.size / 2, repeat: 0)
    for (i in 0..out.size) {
        out[i] = UInt8(digits[i * 2] * 16 + digits[i * 2 + 1])
    }
    SqliteValue.SBlob(out)
}

/** 十六进制位的值; 非十六进制位返 -1 而不是抛异常。 */
func hexDigitOrNegative(c: Int64): Int64 {
    if (c >= 48 && c <= 57) {
        return c - 48
    }
    if (c >= 97 && c <= 102) {
        return c - 97 + 10
    }
    if (c >= 65 && c <= 70) {
        return c - 65 + 10
    }
    -1
}

func byteIsIn(b: Byte, set: Array<Byte>): Bool {
    for (x in set) {
        if (x == b) {
            return true
        }
    }
    false
}
