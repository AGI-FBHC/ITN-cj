package sqlite_driver

import std.collection.*
import std.math.*
import std.time.*

/*
 * 内置函数。
 *
 * 分派按"聚合优先": count/sum/avg/min/max/group_concat/total 这几个名字在聚合上下文里
 * 走累加器, 不在聚合上下文里则报错 —— 而不是退化成标量。退化会让
 * `SELECT count(x) FROM t` 在漏建累加器时返回每行一个 1, 结果看起来合理但全错。
 *
 * min/max 是唯一两个"同名但既是标量又是聚合"的函数: 带 2+ 个参数时是标量 (逐参数取极值),
 * 带 1 个参数时是聚合。这是 SQLite 的规则, 按参数个数分辨。
 */

/** 聚合函数名判定。min/max 只有单参形态才算。 */
func isAggregateName(name: String, argCount: Int64): Bool {
    match (name.toAsciiLower()) {
        case "count" | "sum" | "total" | "avg" | "group_concat" => true
        case "min" | "max" => argCount == 1
        case _ => false
    }
}

func evalFunction(ctx: EvalContext, f: FuncExpr): SqliteValue {
    let lower = f.name.toAsciiLower()
    if (isAggregateName(lower, f.args.size)) {
        return evalAggregateReference(ctx, f)
    }
    evalScalarFunction(ctx, f, lower)
}

/**
 * 聚合表达式在求值时的取值。
 *
 * 聚合分两遍: 第一遍扫行累加 (accumulateAggregates), 第二遍算结果表达式时从
 * aggregateResults 取已算好的值。这里只负责第二遍的读取 —— 第一遍由 SELECT 执行器驱动。
 *
 * 键是聚合在语句里的序号 (aggregateKeyOf), 不是函数名: `sum(a) - sum(b)` 里两个 sum
 * 必须分开累加, 按名字会共用一个累加器。
 */
func evalAggregateReference(ctx: EvalContext, f: FuncExpr): SqliteValue {
    let key = aggregateKeyOf(ctx, f)
    if (let Some(results) <- ctx.aggregateResults) {
        match (results.get(key)) {
            case Some(v) => return v
            case None => ()
        }
    }
    if (let Some(states) <- ctx.aggregates) {
        // 聚合行处理期间返回 NULL 占位，最终值在 finalize 时计算。
        if (states.contains(key)) {
            return SqliteValue.SNull
        }
    }
    throw SqliteRuntimeException("sql", "misuse of aggregate function ${f.name}()")
}

/*
 * 标量函数。
 */
func evalScalarFunction(ctx: EvalContext, f: FuncExpr, lower: String): SqliteValue {
    // 参数先全部求值: SQLite 的标量函数没有短路语义 (ifnull/coalesce 除外, 单列在下面)。
    match (lower) {
        case "coalesce" | "ifnull" | "iif" | "if" => return evalShortCircuitFunction(ctx, f, lower)
        case "json_array" | "json_object" => return evalJsonConstructor(ctx, f, lower)
        case _ => ()
    }
    let args = Array<SqliteValue>(f.args.size, repeat: SqliteValue.SNull)
    for (i in 0..f.args.size) {
        args[i] = evalExpr(ctx, f.args[i])
    }
    match (lower) {
        case "abs" => scalarAbs(f, args)
        case "length" => scalarLength(f, args)
        case "lower" => scalarCaseConvert(f, args, false)
        case "upper" => scalarCaseConvert(f, args, true)
        case "substr" | "substring" => scalarSubstr(f, args)
        case "trim" => scalarTrim(f, args, true, true)
        case "ltrim" => scalarTrim(f, args, true, false)
        case "rtrim" => scalarTrim(f, args, false, true)
        case "replace" => scalarReplace(f, args)
        case "instr" => scalarInstr(f, args)
        case "hex" => scalarHex(f, args)
        case "quote" => scalarQuote(f, args)
        case "char" => scalarChar(args)
        case "unicode" => scalarUnicode(f, args)
        case "round" => scalarRound(f, args)
        case "nullif" => scalarNullif(ctx, f, args)
        case "typeof" => scalarTypeof(f, args)
        case "min" => scalarMinMax(ctx, f, args, false)
        case "max" => scalarMinMax(ctx, f, args, true)
        case "random" => scalarRandom(f)
        case "randomblob" => scalarRandomBlob(f, args)
        case "zeroblob" => scalarZeroBlob(f, args)
        case "last_insert_rowid" => scalarLastInsertRowid(ctx, f)
        case "changes" => scalarChanges(ctx, f)
        case "total_changes" => scalarTotalChanges(ctx, f)
        case "sqlite_version" => scalarSqliteVersion(f)
        case "sqlite_source_id" => scalarSourceId(f)
        case "like" => scalarLike(ctx, f, args)
        case "glob" => scalarGlob(f, args)
        case "printf" | "format" => scalarPrintf(f, args)
        case "sign" => scalarSign(f, args)
        case "date" | "time" | "datetime" | "julianday" | "unixepoch" | "strftime" => evalDateFunction(f, args, lower)
        case "concat" => scalarConcat(f, args)
        case "concat_ws" => scalarConcatWs(f, args)
        case "unhex" => scalarUnhex(f, args)
        case "likely" | "unlikely" | "likelihood" => scalarLikelihoodHint(f, args, lower)
        case "json" | "json_valid" | "json_extract" | "json_type" => evalJsonFunction(f, args, lower)
        case _ =>
            // 数学函数一族放最后: 它们的取值规则与上面的标量函数不同 (非数值返 NULL
            // 而不是按 0 计), 单独一组便于保持这条区别, 见 exec_function_math.cj。
            match (evalMathFunction(f, args, lower)) {
            case Some(v) => v
            case None => throw SqliteRuntimeException("sql", "no such function: ${f.name}")
        }
    }
}

/** 参数个数检查。名字与个数一起报, 光报"参数错误"定位不到是哪个函数。 */
func requireArgCount(f: FuncExpr, args: Array<SqliteValue>, min: Int64, max: Int64): Unit {
    if (args.size < min || (max >= 0 && args.size > max)) {
        let expect = if (max < 0) {
            "at least ${min}"
        } else if (min == max) {
            "${min}"
        } else {
            "${min} to ${max}"
        }
        throw SqliteRuntimeException("sql",
            "wrong number of arguments to function ${f.name}(): expected ${expect}, got ${args.size}")
    }
}

/** coalesce / ifnull / iif: 要按需求值, 不能先把所有参数算完 —— 后面的参数可能报错。 */
func evalShortCircuitFunction(ctx: EvalContext, f: FuncExpr, lower: String): SqliteValue {
    if (lower == "iif" || lower == "if") {
        if (f.args.size != 3) {
            throw SqliteRuntimeException("sql",
                "wrong number of arguments to function ${f.name}(): expected 3, got ${f.args.size}")
        }
        return match (valueToTristate(evalExpr(ctx, f.args[0]))) {
            case Some(true) => evalExpr(ctx, f.args[1])
            case _ => evalExpr(ctx, f.args[2])
        }
    }
    if (f.args.size < 2) {
        throw SqliteRuntimeException("sql",
            "wrong number of arguments to function ${f.name}(): expected at least 2, got ${f.args.size}")
    }
    if (lower == "ifnull" && f.args.size != 2) {
        throw SqliteRuntimeException("sql",
            "wrong number of arguments to function ifnull(): expected 2, got ${f.args.size}")
    }
    for (a in f.args) {
        let v = evalExpr(ctx, a)
        match (v) {
            case SNull => ()
            case _ => return v
        }
    }
    SqliteValue.SNull
}

func scalarAbs(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, 1)
    match (args[0]) {
        case SNull => SqliteValue.SNull
        case SInt(i) =>
            // abs(Int64.Min) 无法用 Int64 表示, SQLite 在这里报错而不是给错值。
            if (i == Int64.Min) {
                throw SqliteRuntimeException("sql", "integer overflow in abs()")
            } else if (i < 0) {
                SqliteValue.SInt(-i)
            } else {
                SqliteValue.SInt(i)
            }
        case SReal(d) => SqliteValue.SReal(if (d < 0.0) {
            -d
        } else {
            d
        })
        case _ =>
            let n = coerceNumeric(args[0])
            match (n) {
                case SInt(i) => SqliteValue.SInt(if (i < 0) {
                    -i
                } else {
                    i
                })
                case SReal(d) => SqliteValue.SReal(if (d < 0.0) {
                    -d
                } else {
                    d
                })
                case _ => SqliteValue.SInt(0)
            }
    }
}

/**
 * length(): 文本按**字符**数, BLOB 按字节数。
 *
 * 两种口径不同是规范定的。都按字节会让 length('中文') 返回 6。
 */
func scalarLength(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, 1)
    match (args[0]) {
        case SNull => SqliteValue.SNull
        case SBlob(bs) => SqliteValue.SInt(bs.size)
        case SText(s) => SqliteValue.SInt(toRuneArray(s).size)
        case _ => SqliteValue.SInt(toRuneArray(valueToText(args[0])).size)
    }
}

/** lower/upper 只处理 ASCII —— 与不带 ICU 的 SQLite 行为一致。 */
func scalarCaseConvert(f: FuncExpr, args: Array<SqliteValue>, upper: Bool): SqliteValue {
    requireArgCount(f, args, 1, 1)
    match (args[0]) {
        case SNull => SqliteValue.SNull
        case _ =>
            let s = valueToText(args[0])
            SqliteValue.SText(if (upper) {
                s.toAsciiUpper()
            } else {
                s.toAsciiLower()
            })
    }
}

/**
 * substr(x, start, len): start 从 1 起, 负数表示从尾部数。
 *
 * 边界规则容易写错的两处: start = 0 等价于 1 之前 (即 substr(s, 0, 2) 只取 1 个字符);
 * 负 len 表示向左取。两者都按 SQLite 语义实现。
 */
func scalarSubstr(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 2, 3)
    match (args[0]) {
        case SNull => return SqliteValue.SNull
        case _ => ()
    }
    // BLOB 上 substr 按字节切, 文本按字符切。
    match (args[0]) {
        case SBlob(bs) => return substrBlob(bs, args)
        case _ => ()
    }
    let runes = toRuneArray(valueToText(args[0]))
    let n = runes.size
    var start = valueToInt(coerceNumeric(args[1]))
    var takeLen = if (args.size >= 3) {
        match (args[2]) {
            case SNull => return SqliteValue.SNull
            case _ => valueToInt(coerceNumeric(args[2]))
        }
    } else {
        n
    }
    if (start < 0) {
        start = n + start + 1
        if (start < 1) {
            // 从尾部数出界: 起点回到 1, 但长度要扣掉出界的部分。
            takeLen += start - 1
            start = 1
        }
    } else if (start == 0) {
        start = 1
        if (args.size >= 3) {
            takeLen -= 1
        }
    }
    if (takeLen < 0) {
        // 负长度: 向左取 |len| 个字符。
        let newStart = start + takeLen
        takeLen = -takeLen
        start = if (newStart < 1) {
            1
        } else {
            newStart
        }
        if (newStart < 1) {
            takeLen += newStart - 1
        }
    }
    if (takeLen <= 0 || start > n) {
        return SqliteValue.SText("")
    }
    let from = start - 1
    var to = from + takeLen
    if (to > n) {
        to = n
    }
    let sb = StringBuilder()
    for (i in from..to) {
        sb.append(runes[i])
    }
    SqliteValue.SText(sb.toString())
}

func substrBlob(bs: Array<Byte>, args: Array<SqliteValue>): SqliteValue {
    let n = bs.size
    var start = valueToInt(coerceNumeric(args[1]))
    var takeLen = if (args.size >= 3) {
        valueToInt(coerceNumeric(args[2]))
    } else {
        n
    }
    if (start < 0) {
        start = n + start + 1
        if (start < 1) {
            takeLen += start - 1
            start = 1
        }
    } else if (start == 0) {
        start = 1
        if (args.size >= 3) {
            takeLen -= 1
        }
    }
    if (takeLen < 0) {
        let newStart = start + takeLen
        takeLen = -takeLen
        start = if (newStart < 1) {
            1
        } else {
            newStart
        }
        if (newStart < 1) {
            takeLen += newStart - 1
        }
    }
    if (takeLen <= 0 || start > n) {
        return SqliteValue.SBlob(Array<Byte>())
    }
    let from = start - 1
    var to = from + takeLen
    if (to > n) {
        to = n
    }
    let out = Array<Byte>(to - from, repeat: 0)
    for (i in from..to) {
        out[i - from] = bs[i]
    }
    SqliteValue.SBlob(out)
}

/** trim(x) / trim(x, chars): 第二参给定时按字符集合去除, 否则去空格。 */
func scalarTrim(f: FuncExpr, args: Array<SqliteValue>, left: Bool, right: Bool): SqliteValue {
    requireArgCount(f, args, 1, 2)
    match (args[0]) {
        case SNull => return SqliteValue.SNull
        case _ => ()
    }
    let runes = toRuneArray(valueToText(args[0]))
    let cutSet = if (args.size >= 2) {
        match (args[1]) {
            case SNull => return SqliteValue.SNull
            case _ => toRuneArray(valueToText(args[1]))
        }
    } else {
        [r' ']
    }
    var from = 0
    var to = runes.size
    if (left) {
        while (from < to && runeArrayContains(cutSet, runes[from])) {
            from += 1
        }
    }
    if (right) {
        while (to > from && runeArrayContains(cutSet, runes[to - 1])) {
            to -= 1
        }
    }
    let sb = StringBuilder()
    for (i in from..to) {
        sb.append(runes[i])
    }
    SqliteValue.SText(sb.toString())
}

func runeArrayContains(set: Array<Rune>, c: Rune): Bool {
    for (x in set) {
        if (x == c) {
            return true
        }
    }
    false
}

func scalarReplace(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 3, 3)
    match ((args[0], args[1], args[2])) {
        case (SNull, _, _) => return SqliteValue.SNull
        case (_, SNull, _) => return SqliteValue.SNull
        case (_, _, SNull) => return SqliteValue.SNull
        case _ => ()
    }
    let subject = valueToText(args[0])
    let target = valueToText(args[1])
    if (target.isEmpty()) {
        // 空目标: SQLite 原样返回, 不进无限循环。
        return SqliteValue.SText(subject)
    }
    SqliteValue.SText(subject.replace(target, valueToText(args[2])))
}

/** instr(haystack, needle): 1 起的字符位置, 未找到为 0。BLOB 按字节。 */
func scalarInstr(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 2, 2)
    match ((args[0], args[1])) {
        case (SNull, _) => return SqliteValue.SNull
        case (_, SNull) => return SqliteValue.SNull
        case _ => ()
    }
    match ((args[0], args[1])) {
        case (SBlob(hay), SBlob(needle)) => return SqliteValue.SInt(bytesIndexOf(hay, needle))
        case _ => ()
    }
    let hay = toRuneArray(valueToText(args[0]))
    let needle = toRuneArray(valueToText(args[1]))
    if (needle.size == 0) {
        return SqliteValue.SInt(1)
    }
    if (needle.size > hay.size) {
        return SqliteValue.SInt(0)
    }
    for (i in 0..(hay.size - needle.size + 1)) {
        var same = true
        for (j in 0..needle.size) {
            if (hay[i + j] != needle[j]) {
                same = false
                break
            }
        }
        if (same) {
            return SqliteValue.SInt(i + 1)
        }
    }
    SqliteValue.SInt(0)
}

func bytesIndexOf(hay: Array<Byte>, needle: Array<Byte>): Int64 {
    if (needle.size == 0) {
        return 1
    }
    if (needle.size > hay.size) {
        return 0
    }
    for (i in 0..(hay.size - needle.size + 1)) {
        var same = true
        for (j in 0..needle.size) {
            if (hay[i + j] != needle[j]) {
                same = false
                break
            }
        }
        if (same) {
            return i + 1
        }
    }
    0
}

func scalarHex(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, 1)
    match (args[0]) {
        case SNull => SqliteValue.SText("")
        case SBlob(bs) => SqliteValue.SText(bytesToHex(bs))
        case _ => SqliteValue.SText(bytesToHex(valueToText(args[0]).toArray()))
    }
}

/** quote(): 产出可直接放回 SQL 的字面量形式。 */
func scalarQuote(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, 1)
    SqliteValue.SText(renderLiteral(args[0]))
}

/** char(n, …): 码点转字符串。非法码点跳过 (SQLite 的做法)。 */
func scalarChar(args: Array<SqliteValue>): SqliteValue {
    let sb = StringBuilder()
    for (a in args) {
        let code = valueToInt(coerceNumeric(a))
        if (code <= 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) {
            continue
        }
        sb.append(Rune(UInt32(code)))
    }
    SqliteValue.SText(sb.toString())
}

func scalarUnicode(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, 1)
    match (args[0]) {
        case SNull => return SqliteValue.SNull
        case _ => ()
    }
    let runes = toRuneArray(valueToText(args[0]))
    if (runes.size == 0) {
        return SqliteValue.SNull
    }
    SqliteValue.SInt(Int64(UInt32(runes[0])))
}

/**
 * round(x) / round(x, n): 半数远离零 (0.5 → 1, -0.5 → -1)。
 *
 * 仓颉的 round 也是这个规则, 但 n > 0 时要先放大再缩回, 中间有精度损失 —— 与 SQLite
 * 表现一致 (它也是这么做的), 所以不额外补偿。
 */
func scalarRound(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, 2)
    match (args[0]) {
        case SNull => return SqliteValue.SNull
        case _ => ()
    }
    var digits = 0
    if (args.size >= 2) {
        match (args[1]) {
            case SNull => return SqliteValue.SNull
            case _ => digits = valueToInt(coerceNumeric(args[1]))
        }
    }
    let x = valueToFloat(coerceNumeric(args[0]))
    if (digits <= 0) {
        return SqliteValue.SReal(round(x))
    }
    if (digits > 30) {
        return SqliteValue.SReal(x)
    }
    var scale = 1.0
    for (_ in 0..digits) {
        scale *= 10.0
    }
    SqliteValue.SReal(round(x * scale) / scale)
}

/** nullif(a, b): a = b 时 NULL, 否则 a。比较用 a 的 collation。 */
func scalarNullif(ctx: EvalContext, f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 2, 2)
    match ((args[0], args[1])) {
        case (SNull, _) => return SqliteValue.SNull
        case (_, SNull) => return args[0]
        case _ => ()
    }
    let coll = comparisonCollation(ctx, f.args[0], f.args[1])
    if (compareValues(args[0], args[1], coll) == CMP_EQ) {
        return SqliteValue.SNull
    }
    args[0]
}

func scalarTypeof(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, 1)
    SqliteValue.SText(match (args[0]) {
        case SNull => "null"
        case SInt(_) => "integer"
        case SReal(_) => "real"
        case SText(_) => "text"
        case SBlob(_) => "blob"
    })
}

/**
 * likely / unlikely / likelihood: 恒等函数, 只对优化器有意义。
 *
 * 本引擎的访问路径选择不读概率提示 (无代价模型, 见 docs 的 ANALYZE 一项), 所以这三个
 * 名字只需要透传第一个参数。仍然实现它们的理由是**语法兼容**: 既有 SQL
 * 里带 `unlikely(...)` 的 WHERE 不该报 "no such function"。
 *
 * likelihood 的第二个参数必须是 [0.0, 1.0] 的浮点字面量。整数和计算表达式不符合语法要求，
 * 因此检查 AST 节点而不是求值结果。
 */
func scalarLikelihoodHint(f: FuncExpr, args: Array<SqliteValue>, lower: String): SqliteValue {
    if (lower == "likelihood") {
        requireArgCount(f, args, 2, 2)
        let ok = match (f.args[1]) {
            case lit: LiteralExpr => match (lit.value) {
                case SReal(p) => p >= 0.0 && p <= 1.0
                case _ => false
            }
            case _ => false
        }
        if (!ok) {
            throw SqliteRuntimeException("sql", "second argument to likelihood() must be a constant between 0.0 and 1.0")
        }
    } else {
        requireArgCount(f, args, 1, 1)
    }
    args[0]
}

/** 多参 min/max: 任一参数为 NULL 则结果 NULL。 */
func scalarMinMax(ctx: EvalContext, f: FuncExpr, args: Array<SqliteValue>, wantMax: Bool): SqliteValue {
    requireArgCount(f, args, 2, -1)
    for (a in args) {
        match (a) {
            case SNull => return SqliteValue.SNull
            case _ => ()
        }
    }
    let coll = comparisonCollation(ctx, f.args[0], f.args[0])
    var best = args[0]
    for (i in 1..args.size) {
        let c = compareValues(args[i], best, coll)
        if ((wantMax && c > 0) || (!wantMax && c < 0)) {
            best = args[i]
        }
    }
    best
}

func scalarRandom(f: FuncExpr): SqliteValue {
    requireArgCount(f, Array<SqliteValue>(), 0, 0)
    SqliteValue.SInt(nextRandomInt64())
}

func scalarRandomBlob(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, 1)
    var n = valueToInt(coerceNumeric(args[0]))
    if (n < 1) {
        n = 1
    }
    if (n > 1048576) {
        throw SqliteRuntimeException("sql", "randomblob() length ${n} exceeds the 1 MiB limit")
    }
    let out = Array<Byte>(n, repeat: 0)
    var i = 0
    while (i < n) {
        var bits = nextRandomInt64()
        var k = 0
        while (k < 8 && i < n) {
            out[i] = UInt8(bits & 0xFF)
            bits = bits >> 8
            k += 1
            i += 1
        }
    }
    SqliteValue.SBlob(out)
}

func scalarZeroBlob(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, 1)
    var n = valueToInt(coerceNumeric(args[0]))
    if (n < 0) {
        n = 0
    }
    if (n > 1048576) {
        throw SqliteRuntimeException("sql", "zeroblob() length ${n} exceeds the 1 MiB limit")
    }
    SqliteValue.SBlob(Array<Byte>(n, repeat: 0))
}

func scalarLastInsertRowid(ctx: EvalContext, f: FuncExpr): SqliteValue {
    requireArgCount(f, Array<SqliteValue>(), 0, 0)
    SqliteValue.SInt(ctx.db.lastInsertRowid)
}

func scalarChanges(ctx: EvalContext, f: FuncExpr): SqliteValue {
    requireArgCount(f, Array<SqliteValue>(), 0, 0)
    SqliteValue.SInt(ctx.db.lastChanges)
}

func scalarTotalChanges(ctx: EvalContext, f: FuncExpr): SqliteValue {
    requireArgCount(f, Array<SqliteValue>(), 0, 0)
    SqliteValue.SInt(ctx.db.totalChanges)
}

func scalarSqliteVersion(f: FuncExpr): SqliteValue {
    requireArgCount(f, Array<SqliteValue>(), 0, 0)
    SqliteValue.SText(SQLITE_VERSION_STRING)
}

func scalarSourceId(f: FuncExpr): SqliteValue {
    requireArgCount(f, Array<SqliteValue>(), 0, 0)
    SqliteValue.SText("sqlite-driver pure-cangjie engine")
}

/** like(pattern, subject[, escape]) 的函数形态。注意参数顺序与中缀 LIKE 相反。 */
func scalarLike(ctx: EvalContext, f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 2, 3)
    let escapeArg: Option<Expr> = if (f.args.size >= 3) {
        Some(f.args[2])
    } else {
        None
    }
    // 复用中缀实现: target 是第 2 参, pattern 是第 1 参。
    evalLike(ctx, LikeExpr(f.args[1], f.args[0], escapeArg, false, false))
}

func scalarGlob(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 2, 2)
    match ((args[0], args[1])) {
        case (SNull, _) => return SqliteValue.SNull
        case (_, SNull) => return SqliteValue.SNull
        case _ => ()
    }
    let pattern = toRuneArray(valueToText(args[0]))
    let subject = toRuneArray(valueToText(args[1]))
    boolToValue(globMatch(subject, 0, pattern, 0))
}

func scalarSign(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, 1)
    match (args[0]) {
        case SNull => return SqliteValue.SNull
        case SText(s) => match (textToNumber(s)) {
            case None => return SqliteValue.SNull
            case Some(_) => ()
        }
        case SBlob(_) => return SqliteValue.SNull
        case _ => ()
    }
    let x = valueToFloat(coerceNumeric(args[0]))
    SqliteValue.SInt(if (x > 0.0) {
        1
    } else if (x < 0.0) {
        -1
    } else {
        0
    })
}

/**
 * printf() / format(): 支持 %d %i %s %f %e %g %x %X %o %c %% 与 %[-][width][.prec]。
 *
 * 不支持的转换符原样输出而不是报错 —— 与 SQLite 一致。
 */
func scalarPrintf(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    requireArgCount(f, args, 1, -1)
    match (args[0]) {
        case SNull => return SqliteValue.SNull
        case _ => ()
    }
    let fmt = toRuneArray(valueToText(args[0]))
    let sb = StringBuilder()
    var argIdx = 1
    var i = 0
    while (i < fmt.size) {
        if (fmt[i] != r'%') {
            sb.append(fmt[i])
            i += 1
            continue
        }
        i += 1
        if (i >= fmt.size) {
            break
        }
        if (fmt[i] == r'%') {
            sb.append(r'%')
            i += 1
            continue
        }
        // 标志、宽度、精度。
        var leftAlign = false
        var zeroPad = false
        var plusSign = false
        while (i < fmt.size && (fmt[i] == r'-' || fmt[i] == r'0' || fmt[i] == r'+' || fmt[i] == r' ')) {
            if (fmt[i] == r'-') {
                leftAlign = true
            }
            if (fmt[i] == r'0') {
                zeroPad = true
            }
            if (fmt[i] == r'+') {
                plusSign = true
            }
            i += 1
        }
        var width = 0
        while (i < fmt.size && fmt[i] >= r'0' && fmt[i] <= r'9') {
            width = width * 10 + Int64(UInt32(fmt[i]) - UInt32(r'0'))
            i += 1
        }
        var precision = -1
        if (i < fmt.size && fmt[i] == r'.') {
            i += 1
            precision = 0
            while (i < fmt.size && fmt[i] >= r'0' && fmt[i] <= r'9') {
                precision = precision * 10 + Int64(UInt32(fmt[i]) - UInt32(r'0'))
                i += 1
            }
        }
        if (i >= fmt.size) {
            break
        }
        let conv = fmt[i]
        i += 1
        let arg = if (argIdx < args.size) {
            let a = args[argIdx]
            argIdx += 1
            a
        } else {
            SqliteValue.SNull
        }
        let piece = formatOneConversion(conv, arg, precision, plusSign)
        sb.append(padTo(piece, width, leftAlign, zeroPad && !leftAlign))
    }
    SqliteValue.SText(sb.toString())
}

func formatOneConversion(conv: Rune, arg: SqliteValue, precision: Int64, plusSign: Bool): String {
    match (conv) {
        case r'd' | r'i' =>
            let v = valueToInt(coerceNumeric(arg))
            if (plusSign && v >= 0) {
                "+${v}"
            } else {
                "${v}"
            }
        case r'u' => "${valueToInt(coerceNumeric(arg))}"
        case r's' =>
            let s = match (arg) {
                case SNull => ""
                case _ => valueToText(arg)
            }
            if (precision >= 0 && precision < s.size) {
                s[0..precision]
            } else {
                s
            }
        case r'f' => formatFixed(valueToFloat(coerceNumeric(arg)), if (precision < 0) {
            6
        } else {
            precision
        })
        case r'e' | r'E' | r'g' | r'G' =>
            let t = formatReal(valueToFloat(coerceNumeric(arg)))
            if (conv == r'E' || conv == r'G') {
                t.toAsciiUpper()
            } else {
                t
            }
        case r'x' => toRadixString(valueToInt(coerceNumeric(arg)), 16, false)
        case r'X' => toRadixString(valueToInt(coerceNumeric(arg)), 16, true)
        case r'o' => toRadixString(valueToInt(coerceNumeric(arg)), 8, false)
        case r'c' =>
            let code = valueToInt(coerceNumeric(arg))
            if (code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF)) {
                "${Rune(UInt32(code))}"
            } else {
                ""
            }
        case r'q' => match (arg) {
            case SNull => ""
            case _ => valueToText(arg).replace("'", "''")
        }
        case r'Q' => renderLiteral(arg)
        case _ => "%${conv}"
    }
}

/** 定点格式化。仓颉没有直接的 printf, 自己按精度四舍五入后拼。 */
func formatFixed(x: Float64, digits: Int64): String {
    if (x.isNaN()) {
        return "NaN"
    }
    let negative = x < 0.0
    var v = if (negative) {
        -x
    } else {
        x
    }
    var scale = 1.0
    for (_ in 0..digits) {
        scale *= 10.0
    }
    let scaled = round(v * scale)
    // 用整数拼小数点, 避免二进制浮点在末位给出 "0.30000000000000004" 这类形态。
    if (scaled < 9.2e18) {
        let asInt = Int64(scaled)
        let intPart = asInt / powInt10(digits)
        let fracPart = asInt % powInt10(digits)
        let sign = if (negative) {
            "-"
        } else {
            ""
        }
        if (digits == 0) {
            return "${sign}${intPart}"
        }
        return "${sign}${intPart}.${padLeftZeros(fracPart, digits)}"
    }
    v = if (negative) {
        -v
    } else {
        v
    }
    "${v}"
}

func powInt10(n: Int64): Int64 {
    var r = 1
    for (_ in 0..n) {
        r *= 10
    }
    r
}

func padLeftZeros(v: Int64, width: Int64): String {
    let s = "${v}"
    if (s.size >= width) {
        return s
    }
    let sb = StringBuilder()
    for (_ in 0..(width - s.size)) {
        sb.append("0")
    }
    sb.append(s)
    sb.toString()
}

func toRadixString(v: Int64, radix: Int64, upper: Bool): String {
    if (v == 0) {
        return "0"
    }
    let digits = if (upper) {
        "0123456789ABCDEF"
    } else {
        "0123456789abcdef"
    }
    let digitBytes = digits.toArray()
    // 负数按无符号 64 位处理，符合 %x 的格式化规则。
    var u = bitsToU64(v)
    let ru = UInt64(radix)
    let buf = ArrayList<Byte>()
    while (u > 0) {
        buf.add(digitBytes[Int64(u % ru)])
        u = u / ru
    }
    let out = Array<Byte>(buf.size, repeat: 0)
    for (i in 0..buf.size) {
        out[i] = buf[buf.size - 1 - i]
    }
    String.fromUtf8(out)
}

func padTo(s: String, width: Int64, leftAlign: Bool, zeroPad: Bool): String {
    let len = toRuneArray(s).size
    if (len >= width) {
        return s
    }
    let fill = if (zeroPad) {
        "0"
    } else {
        " "
    }
    let sb = StringBuilder()
    if (leftAlign) {
        sb.append(s)
        for (_ in 0..(width - len)) {
            sb.append(fill)
        }
        return sb.toString()
    }
    // 零填充要在符号之后: "-0042" 而不是 "00-42"。
    if (zeroPad && s.startsWith("-")) {
        sb.append("-")
        for (_ in 0..(width - len)) {
            sb.append(fill)
        }
        sb.append(s[1..s.size])
        return sb.toString()
    }
    for (_ in 0..(width - len)) {
        sb.append(fill)
    }
    sb.append(s)
    sb.toString()
}

/*
 * 伪随机数。
 *
 * 用 xorshift64* 而不是 std 的随机源: 需要一个进程内共享、无需初始化的序列, 且
 * random() 的质量要求只是"看起来随机"。种子取当前时间的纳秒位与一个固定奇数混合。
 */
var randomState: UInt64 = 0

func nextRandomInt64(): Int64 {
    if (randomState == 0) {
        let seed = UInt64(DateTime.now().toUnixTimeStamp().toNanoseconds()) | 1
        randomState = seed ^ 0x9E3779B97F4A7C15
    }
    var x = randomState
    x ^= x >> 12
    x ^= x << 25
    x ^= x >> 27
    randomState = x
    bitsToI64(x * 0x2545F4914F6CDD1D)
}
