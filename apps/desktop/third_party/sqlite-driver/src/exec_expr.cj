package sqlite_driver

import std.collection.*
import std.convert.*

/*
 * 表达式求值。
 *
 * 两条贯穿全文件的规则:
 *   1. 三值逻辑。任一操作数为 NULL 时, 比较与算术的结果都是 NULL 而不是假。WHERE 只在
 *      结果为"真"时选中行 —— NULL 与假在这里同效, 但 `NOT NULL_result` 仍是 NULL 而不是真。
 *      把 NULL 折成假会让 `WHERE NOT (a = 1)` 把 a IS NULL 的行选出来。
 *   2. 比较前按列亲和性转换。`WHERE n = '42'` 在 n 是 INTEGER 列时应命中 —— 文本要先转数值。
 *      没有列参与的比较 (两个字面量) 不转换, 于是 `'1' = 1` 为假, 与 SQLite 一致。
 */
func evalExpr(ctx: EvalContext, e: Expr): SqliteValue {
    checkStatementControl(ctx.db)
    if (e is LiteralExpr) {
        return (e as LiteralExpr).getOrThrow().value
    }
    if (e is RaiseExpr) {
        return evalRaise(ctx, (e as RaiseExpr).getOrThrow())
    }
    if (e is ParamExpr) {
        return evalParam(ctx, (e as ParamExpr).getOrThrow())
    }
    if (e is ColumnExpr) {
        return evalColumn(ctx, (e as ColumnExpr).getOrThrow())
    }
    if (e is UnaryExpr) {
        return evalUnary(ctx, (e as UnaryExpr).getOrThrow())
    }
    if (e is BinaryExpr) {
        return evalBinary(ctx, (e as BinaryExpr).getOrThrow())
    }
    if (e is NullTestExpr) {
        let n = (e as NullTestExpr).getOrThrow()
        let v = evalExpr(ctx, n.operand)
        let isNull = match (v) {
            case SNull => true
            case _ => false
        }
        return boolToValue(if (n.negated) {
            !isNull
        } else {
            isNull
        })
    }
    if (e is LikeExpr) {
        return evalLike(ctx, (e as LikeExpr).getOrThrow())
    }
    if (e is BetweenExpr) {
        return evalBetween(ctx, (e as BetweenExpr).getOrThrow())
    }
    if (e is InExpr) {
        return evalIn(ctx, (e as InExpr).getOrThrow())
    }
    if (e is CaseExpr) {
        return evalCase(ctx, (e as CaseExpr).getOrThrow())
    }
    if (e is CastExpr) {
        let c = (e as CastExpr).getOrThrow()
        return castValue(evalExpr(ctx, c.operand), c.typeName)
    }
    if (e is CollateExpr) {
        // COLLATE 只影响比较, 不改值本身。比较时由 collationForExpr 取回来。
        return evalExpr(ctx, (e as CollateExpr).getOrThrow().operand)
    }
    if (e is WindowExpr) {
        let w = (e as WindowExpr).getOrThrow()
        if (let Some(results) <- ctx.windowResults) {
            if (let Some(value) <- results.get(w.serial)) {
                return value
            }
        }
        throw SqliteRuntimeException("sql", "misuse of window function ${w.funcExpr.name}()")
    }
    if (e is FuncExpr) {
        return evalFunction(ctx, (e as FuncExpr).getOrThrow())
    }
    if (e is SubqueryExpr) {
        return evalScalarSubquery(ctx, (e as SubqueryExpr).getOrThrow().select)
    }
    if (e is ExistsExpr) {
        let x = (e as ExistsExpr).getOrThrow()
        let rows = runSubquery(ctx, x.select)
        let exists = rows.size > 0
        return boolToValue(if (x.negated) {
            !exists
        } else {
            exists
        })
    }
    if (e is StarExpr) {
        throw SqliteRuntimeException("sql", "'*' is not valid in this context")
    }
    throw SqliteRuntimeException("sql", "unsupported expression form")
}

func evalParam(ctx: EvalContext, p: ParamExpr): SqliteValue {
    if (p.ordinal < 1 || p.ordinal > ctx.params.size) {
        let label = if (p.name.isEmpty()) {
            "?${p.ordinal}"
        } else {
            p.name
        }
        throw SqliteRuntimeException("bind",
            "no value bound for parameter ${label} (${ctx.params.size} value(s) supplied)")
    }
    ctx.params[p.ordinal - 1]
}

/**
 * 列引用求值。
 *
 * `rowid` / `_rowid_` / `oid` 是每张有 rowid 的表的隐式列, 只在没有同名真实列时生效 ——
 * 顺序反了会让声明了 rowid 列的表读到内部 rowid。
 */
func evalColumn(ctx: EvalContext, c: ColumnExpr): SqliteValue {
    if (!c.table.isEmpty()) {
        match (ctx.findSource(c.table)) {
            case Some(src) => return readColumnFromSource(src, c.name, c.table)
            case None => match (ctx.outer) {
                case Some(o) => return evalColumn(o, c)
                case None => throw SqliteRuntimeException("sql", "no such table in this query: ${c.table}")
            }
        }
    }
    // USING / NATURAL 合并掉的公共列: 未限定名指的是合并后的那一个值, 取组里第一个非 NULL。
    // 这一支必须排在歧义判定之前 —— 组里每个源都有这个列, 否则 `SELECT id FROM a JOIN b
    // USING(id)` 会被判成 ambiguous, 而 SQLite 认为它合法。
    if (let Some(group) <- ctx.mergeGroups.get(c.name.toAsciiLower())) {
        if (!group.isEmpty()) {
            return coalesceMergeGroup(ctx, group)
        }
    }
    var found: Option<RowSource> = None
    var matches = 0
    for (src in ctx.sources) {
        // 伪表 (excluded / OLD / NEW) 只认限定名: 它们的列名与目标表完全重合, 参与未限定
        // 解析会让 `SET v = v` 变成 ambiguous, 而 SQLite 解析成目标表的列。
        if (src.qualifiedOnly) {
            continue
        }
        if (src.columnIndexOf(c.name) >= 0) {
            matches += 1
            if (matches == 1) {
                found = Some(src)
            }
        }
    }
    if (matches > 1) {
        throw SqliteRuntimeException("sql", "ambiguous column name: ${c.name}")
    }
    if (let Some(src) <- found) {
        return readColumnFromSource(src, c.name, "")
    }
    // 隐式 rowid 列。
    if (isRowidKeyword(c.name)) {
        for (src in ctx.sources) {
            if (let Some(table) <- src.table) {
                if (table.withoutRowid) {
                    continue
                }
                if (src.isNullRow) {
                    return SqliteValue.SNull
                }
                return SqliteValue.SInt(src.rowid)
            }
        }
    }
    match (ctx.outer) {
        case Some(o) => evalColumn(o, c)
        case None => throw SqliteRuntimeException("sql", "no such column: ${c.name}")
    }
}

func isRowidKeyword(name: String): Bool {
    match (name.toAsciiLower()) {
        case "rowid" | "_rowid_" | "oid" => true
        case _ => false
    }
}

func readColumnFromSource(src: RowSource, colName: String, qualifier: String): SqliteValue {
    let idx = src.columnIndexOf(colName)
    if (idx >= 0) {
        return src.values[idx]
    }
    if (isRowidKeyword(colName)) {
        if (let Some(table) <- src.table) {
            if (table.withoutRowid) {
                let scope = if (qualifier.isEmpty()) { "" } else { " in ${qualifier}" }
                throw SqliteRuntimeException("sql", "no such column${scope}: ${colName}")
            }
            if (src.isNullRow) {
                return SqliteValue.SNull
            }
            return SqliteValue.SInt(src.rowid)
        }
    }
    let scope = if (qualifier.isEmpty()) {
        ""
    } else {
        " in ${qualifier}"
    }
    throw SqliteRuntimeException("sql", "no such column${scope}: ${colName}")
}

func boolToValue(b: Bool): SqliteValue {
    SqliteValue.SInt(if (b) {
        1
    } else {
        0
    })
}

/** 三值逻辑的结果转值: None 表示 NULL。 */
func tristateToValue(t: Option<Bool>): SqliteValue {
    match (t) {
        case None => SqliteValue.SNull
        case Some(b) => boolToValue(b)
    }
}

/** 把值读成三值逻辑: NULL → None。 */
func valueToTristate(v: SqliteValue): Option<Bool> {
    match (v) {
        case SNull => None
        case _ => Some(valueIsTrue(v))
    }
}

func evalUnary(ctx: EvalContext, u: UnaryExpr): SqliteValue {
    let v = evalExpr(ctx, u.operand)
    if (u.op == "NOT") {
        return match (valueToTristate(v)) {
            case None => SqliteValue.SNull
            case Some(b) => boolToValue(!b)
        }
    }
    match (v) {
        case SNull => SqliteValue.SNull
        case _ => match (u.op) {
            case "+" => v
            case "-" => negateValue(v)
            case "~" => SqliteValue.SInt(bitwiseNot(valueToInt(v)))
            case _ => throw SqliteRuntimeException("sql", "unsupported unary operator ${u.op}")
        }
    }
}

func negateValue(v: SqliteValue): SqliteValue {
    match (v) {
        case SInt(i) =>
            // -Int64.Min 溢出: SQLite 在这里转浮点。
            if (i == Int64.Min) {
                SqliteValue.SReal(-Float64(i))
            } else {
                SqliteValue.SInt(-i)
            }
        case SReal(f) => SqliteValue.SReal(-f)
        case _ => match (textToNumber(valueToText(v))) {
            case Some(num) => negateValue(num)
            case None => SqliteValue.SInt(0)
        }
    }
}

@OverflowWrapping
func bitwiseNot(v: Int64): Int64 {
    !v
}

func evalBinary(ctx: EvalContext, b: BinaryExpr): SqliteValue {
    // AND / OR 要短路, 且遵循 SQL 的三值逻辑: `false AND NULL` 是 false 而不是 NULL。
    if (b.op == "AND") {
        let l = valueToTristate(evalExpr(ctx, b.left))
        if (let Some(false) <- l) {
            return boolToValue(false)
        }
        let r = valueToTristate(evalExpr(ctx, b.right))
        if (let Some(false) <- r) {
            return boolToValue(false)
        }
        return match ((l, r)) {
            case (Some(true), Some(true)) => boolToValue(true)
            case _ => SqliteValue.SNull
        }
    }
    if (b.op == "OR") {
        let l = valueToTristate(evalExpr(ctx, b.left))
        if (let Some(true) <- l) {
            return boolToValue(true)
        }
        let r = valueToTristate(evalExpr(ctx, b.right))
        if (let Some(true) <- r) {
            return boolToValue(true)
        }
        return match ((l, r)) {
            case (Some(false), Some(false)) => boolToValue(false)
            case _ => SqliteValue.SNull
        }
    }
    let lv = evalExpr(ctx, b.left)
    let rv = evalExpr(ctx, b.right)
    if (b.op == "->" || b.op == "->>") {
        return evalJsonArrow(lv, rv, b.op == "->>")
    }
    // IS / IS NOT 是 NULL 安全的相等, 不走三值逻辑。
    if (b.op == "IS" || b.op == "IS NOT") {
        let coll = comparisonCollation(ctx, b.left, b.right)
        let same = compareValues(applyBinaryAffinity(ctx, lv, b.left, b.right),
            applyBinaryAffinity(ctx, rv, b.right, b.left), coll) == CMP_EQ
        return boolToValue(if (b.op == "IS") {
            same
        } else {
            !same
        })
    }
    if (b.op == "||") {
        // 拼接: 任一侧 NULL 则整体 NULL。
        return match ((lv, rv)) {
            case (SNull, _) => SqliteValue.SNull
            case (_, SNull) => SqliteValue.SNull
            case _ => SqliteValue.SText("${valueToText(lv)}${valueToText(rv)}")
        }
    }
    if (isComparisonOp(b.op)) {
        return evalComparison(ctx, b, lv, rv)
    }
    // 算术与位运算: NULL 传染。
    match ((lv, rv)) {
        case (SNull, _) => return SqliteValue.SNull
        case (_, SNull) => return SqliteValue.SNull
        case _ => ()
    }
    match (b.op) {
        case "+" => arithmetic(lv, rv, "+")
        case "-" => arithmetic(lv, rv, "-")
        case "*" => arithmetic(lv, rv, "*")
        case "/" => divide(lv, rv)
        case "%" => modulo(lv, rv)
        case "&" => SqliteValue.SInt(valueToInt(lv) & valueToInt(rv))
        case "|" => SqliteValue.SInt(valueToInt(lv) | valueToInt(rv))
        case "<<" => SqliteValue.SInt(shiftLeft(valueToInt(lv), valueToInt(rv)))
        case ">>" => SqliteValue.SInt(shiftRight(valueToInt(lv), valueToInt(rv)))
        case _ => throw SqliteRuntimeException("sql", "unsupported operator ${b.op}")
    }
}

func isComparisonOp(op: String): Bool {
    match (op) {
        case "=" | "<>" | "<" | "<=" | ">" | ">=" => true
        case _ => false
    }
}

func evalComparison(ctx: EvalContext, b: BinaryExpr, lv: SqliteValue, rv: SqliteValue): SqliteValue {
    match ((lv, rv)) {
        case (SNull, _) => return SqliteValue.SNull
        case (_, SNull) => return SqliteValue.SNull
        case _ => ()
    }
    let coll = comparisonCollation(ctx, b.left, b.right)
    let l = applyBinaryAffinity(ctx, lv, b.left, b.right)
    let r = applyBinaryAffinity(ctx, rv, b.right, b.left)
    let c = compareValues(l, r, coll)
    let result = match (b.op) {
        case "=" => c == CMP_EQ
        case "<>" => c != CMP_EQ
        case "<" => c == CMP_LT
        case "<=" => c != CMP_GT
        case ">" => c == CMP_GT
        case ">=" => c != CMP_LT
        case _ => throw SqliteRuntimeException("sql", "unsupported comparison ${b.op}")
    }
    boolToValue(result)
}

/**
 * 比较用的 collation: 显式 COLLATE 优先, 否则取左侧列的 collation, 再否则取右侧列的。
 *
 * 顺序照 SQLite 的规则。取错会让 NOCASE 列的比较退化成区分大小写, 且不报错。
 */
func comparisonCollation(ctx: EvalContext, left: Expr, right: Expr): SqliteCollation {
    if (let Some(c) <- explicitCollation(left)) {
        return c
    }
    if (let Some(c) <- explicitCollation(right)) {
        return c
    }
    if (let Some(c) <- columnCollation(ctx, left)) {
        return c
    }
    if (let Some(c) <- columnCollation(ctx, right)) {
        return c
    }
    SqliteCollation.CollBinary
}

func explicitCollation(e: Expr): Option<SqliteCollation> {
    if (e is CollateExpr) {
        return Some(collationByName((e as CollateExpr).getOrThrow().collation))
    }
    None
}

func columnCollation(ctx: EvalContext, e: Expr): Option<SqliteCollation> {
    match (columnInfoFor(ctx, e)) {
        case Some(ci) => Some(ci.collation)
        case None => None
    }
}

/** 表达式若是列引用, 取它的列信息 (供亲和性与 collation 用)。 */
func columnInfoFor(ctx: EvalContext, e: Expr): Option<ColumnInfo> {
    if (e is CollateExpr) {
        return columnInfoFor(ctx, (e as CollateExpr).getOrThrow().operand)
    }
    if (!(e is ColumnExpr)) {
        return None
    }
    let c = (e as ColumnExpr).getOrThrow()
    for (src in ctx.sources) {
        if (!c.table.isEmpty() && src.name.toAsciiLower() != c.table.toAsciiLower()) {
            continue
        }
        if (let Some(t) <- src.table) {
            if (let Some(ci) <- t.columnByName(c.name)) {
                return Some(ci)
            }
        }
    }
    if (!c.table.isEmpty()) {
        for (src in ctx.pseudoSources) {
            if (src.name.toAsciiLower() != c.table.toAsciiLower()) {
                continue
            }
            if (let Some(t) <- src.table) {
                if (let Some(ci) <- t.columnByName(c.name)) {
                    return Some(ci)
                }
            }
        }
    }
    None
}

/**
 * 比较前的亲和性转换。
 *
 * 只有一侧是列、另一侧不是时才转 —— 转的是**非列的那一侧**, 向列的亲和性靠。
 * 这正是 `WHERE n = '42'` 能命中的原因。
 */
func applyBinaryAffinity(ctx: EvalContext, v: SqliteValue, own: Expr, other: Expr): SqliteValue {
    let ownCol = columnInfoFor(ctx, own)
    let otherCol = columnInfoFor(ctx, other)
    match ((ownCol, otherCol)) {
        case (None, Some(oc)) => applyComparisonAffinity(v, Some(oc.affinity))
        case _ => v
    }
}

/**
 * 算术: 双方都是整数则用整数, 否则用浮点。整数溢出转浮点 (与 SQLite 一致)。
 *
 * 仓颉的 Int64 加减乘溢出会**抛异常**而不是回绕, 所以必须先探测。用 checked 风格的判断
 * 而不是 @OverflowWrapping: 回绕会给出错误结果 (如 Int64.Max + 1 变成负数), 而 SQLite
 * 给的是浮点结果。
 */
func arithmetic(lv: SqliteValue, rv: SqliteValue, op: String): SqliteValue {
    let ln = coerceNumeric(lv)
    let rn = coerceNumeric(rv)
    match ((ln, rn)) {
        case (SInt(a), SInt(b)) => match (checkedIntArithmetic(a, b, op)) {
            case Some(r) => SqliteValue.SInt(r)
            case None => SqliteValue.SReal(floatArithmetic(Float64(a), Float64(b), op))
        }
        case _ => SqliteValue.SReal(floatArithmetic(valueToFloat(ln), valueToFloat(rn), op))
    }
}

/** 把值转成数值存储类; 文本转不动时按 0 计 (SQLite 的算术规则)。 */
func coerceNumeric(v: SqliteValue): SqliteValue {
    match (v) {
        case SInt(_) => v
        case SReal(_) => v
        case SText(s) => match (textToNumber(s)) {
            case Some(num) => num
            case None => SqliteValue.SInt(0)
        }
        case SBlob(_) => SqliteValue.SInt(0)
        case SNull => SqliteValue.SInt(0)
    }
}

/** 整数四则运算, 溢出返回 None。 */
func checkedIntArithmetic(a: Int64, b: Int64, op: String): Option<Int64> {
    match (op) {
        case "+" =>
            if ((b > 0 && a > Int64.Max - b) || (b < 0 && a < Int64.Min - b)) {
                None
            } else {
                Some(a + b)
            }
        case "-" =>
            if ((b < 0 && a > Int64.Max + b) || (b > 0 && a < Int64.Min + b)) {
                None
            } else {
                Some(a - b)
            }
        case "*" => checkedMultiply(a, b)
        case _ => None
    }
}

func checkedMultiply(a: Int64, b: Int64): Option<Int64> {
    if (a == 0 || b == 0) {
        return Some(0)
    }
    // Int64.Min 的绝对值无法表示, 单独排除。
    if (a == Int64.Min || b == Int64.Min) {
        return None
    }
    let absA = if (a < 0) {
        -a
    } else {
        a
    }
    let absB = if (b < 0) {
        -b
    } else {
        b
    }
    if (absA > Int64.Max / absB) {
        return None
    }
    Some(a * b)
}

func floatArithmetic(a: Float64, b: Float64, op: String): Float64 {
    match (op) {
        case "+" => a + b
        case "-" => a - b
        case "*" => a * b
        case _ => throw SqliteRuntimeException("sql", "unsupported arithmetic operator ${op}")
    }
}

/** 除法: 除数为 0 返回 NULL (SQLite 不报错), 整数除整数取整。 */
func divide(lv: SqliteValue, rv: SqliteValue): SqliteValue {
    let ln = coerceNumeric(lv)
    let rn = coerceNumeric(rv)
    match ((ln, rn)) {
        case (SInt(a), SInt(b)) =>
            if (b == 0) {
                SqliteValue.SNull
            } else if (a == Int64.Min && b == -1) {
                // 唯一会溢出的整数除法。
                SqliteValue.SReal(-Float64(a))
            } else {
                SqliteValue.SInt(a / b)
            }
        case _ =>
            let d = valueToFloat(rn)
            if (d == 0.0) {
                SqliteValue.SNull
            } else {
                SqliteValue.SReal(valueToFloat(ln) / d)
            }
    }
}

/** 取模: 双方按整数算, 除数为 0 返回 NULL。 */
func modulo(lv: SqliteValue, rv: SqliteValue): SqliteValue {
    let a = valueToInt(coerceNumeric(lv))
    let b = valueToInt(coerceNumeric(rv))
    if (b == 0) {
        return SqliteValue.SNull
    }
    if (a == Int64.Min && b == -1) {
        return SqliteValue.SInt(0)
    }
    SqliteValue.SInt(a % b)
}

/** 移位量超过 63 位时结果为 0 (或 -1), 与 SQLite 一致; 仓颉对超范围移位行为未定义。 */
func shiftLeft(v: Int64, n: Int64): Int64 {
    if (n < 0) {
        return shiftRight(v, -n)
    }
    if (n >= 64) {
        return 0
    }
    wrappingShiftLeft(v, n)
}

@OverflowWrapping
func wrappingShiftLeft(v: Int64, n: Int64): Int64 {
    v << n
}

func shiftRight(v: Int64, n: Int64): Int64 {
    if (n < 0) {
        return shiftLeft(v, -n)
    }
    if (n >= 64) {
        return if (v < 0) {
            -1
        } else {
            0
        }
    }
    v >> n
}

func evalBetween(ctx: EvalContext, b: BetweenExpr): SqliteValue {
    let target = evalExpr(ctx, b.target)
    let low = evalExpr(ctx, b.low)
    let high = evalExpr(ctx, b.high)
    match (target) {
        case SNull => return SqliteValue.SNull
        case _ => ()
    }
    let coll = comparisonCollation(ctx, b.target, b.low)
    let lowCmp = match (low) {
        case SNull => None<Bool>
        case _ => Some(
            compareValues(applyBinaryAffinity(ctx, target, b.target, b.low), applyBinaryAffinity(ctx, low, b.low,
                b.target), coll) != CMP_LT)
    }
    let highCmp = match (high) {
        case SNull => None<Bool>
        case _ => Some(
            compareValues(applyBinaryAffinity(ctx, target, b.target, b.high),
                applyBinaryAffinity(ctx, high, b.high, b.target), coll) != CMP_GT)
    }
    // BETWEEN 等价于 `>= low AND <= high`, 三值逻辑照 AND 的规则。
    let inRange = match ((lowCmp, highCmp)) {
        case (Some(false), _) => Some(false)
        case (_, Some(false)) => Some(false)
        case (Some(true), Some(true)) => Some(true)
        case _ => None<Bool>
    }
    match (inRange) {
        case None => SqliteValue.SNull
        case Some(v) => boolToValue(if (b.negated) {
            !v
        } else {
            v
        })
    }
}

func evalIn(ctx: EvalContext, e: InExpr): SqliteValue {
    let target = evalExpr(ctx, e.target)
    let candidates = ArrayList<SqliteValue>()
    if (let Some(sub) <- e.subquery) {
        let rows = runSubquery(ctx, sub)
        for (row in rows) {
            if (row.size < 1) {
                continue
            }
            candidates.add(row[0])
        }
    } else {
        for (v in e.values) {
            candidates.add(evalExpr(ctx, v))
        }
    }
    if (candidates.isEmpty()) {
        // 空集合: `x IN ()` 恒假, `x NOT IN ()` 恒真 —— 即使 x 是 NULL。
        return boolToValue(e.negated)
    }
    match (target) {
        case SNull => return SqliteValue.SNull
        case _ => ()
    }
    let coll = comparisonCollation(ctx, e.target, e.target)
    let aff = match (columnInfoFor(ctx, e.target)) {
        case Some(ci) => Some(ci.affinity)
        case None => None<SqliteAffinity>
    }
    var sawNull = false
    for (c in candidates) {
        match (c) {
            case SNull => sawNull = true
            case _ =>
                if (compareValues(target, applyComparisonAffinity(c, aff), coll) == CMP_EQ) {
                    return boolToValue(!e.negated)
                }
        }
    }
    // 没命中且候选里有 NULL: 结果未知。`NOT IN` 同理 —— 这是 NOT IN 最常被误解的地方。
    if (sawNull) {
        return SqliteValue.SNull
    }
    boolToValue(e.negated)
}

func evalCase(ctx: EvalContext, c: CaseExpr): SqliteValue {
    match (c.operand) {
        case Some(subject) =>
            let sv = evalExpr(ctx, subject)
            for ((cond, result) in c.whens) {
                let cv = evalExpr(ctx, cond)
                match ((sv, cv)) {
                    case (SNull, _) => ()
                    case (_, SNull) => ()
                    case _ =>
                        if (compareValues(sv, cv, SqliteCollation.CollBinary) == CMP_EQ) {
                            return evalExpr(ctx, result)
                        }
                }
            }
        case None => for ((cond, result) in c.whens) {
            if (let Some(true) <- valueToTristate(evalExpr(ctx, cond))) {
                return evalExpr(ctx, result)
            }
        }
    }
    match (c.elseExpr) {
        case Some(e) => evalExpr(ctx, e)
        case None => SqliteValue.SNull
    }
}

/** CAST: 按目标类型的亲和性转换, 但比亲和性更强 —— 转不动也要转。 */
func castValue(v: SqliteValue, typeName: String): SqliteValue {
    let aff = affinityOf(typeName)
    match (aff) {
        case AffText => match (v) {
            case SNull => SqliteValue.SNull
            case _ => SqliteValue.SText(valueToText(v))
        }
        case AffBlob => match (v) {
            case SNull => SqliteValue.SNull
            case SBlob(_) => v
            case _ => SqliteValue.SBlob(valueToText(v).toArray())
        }
        case AffInteger => match (v) {
            case SNull => SqliteValue.SNull
            case _ => SqliteValue.SInt(castToInt(v))
        }
        case AffReal => match (v) {
            case SNull => SqliteValue.SNull
            case _ => SqliteValue.SReal(castToFloat(v))
        }
        case AffNumeric => match (v) {
            case SNull => SqliteValue.SNull
            case _ =>
                let f = castToFloat(v)
                let i = floatToInt(f)
                if (Float64(i) == f) {
                    SqliteValue.SInt(i)
                } else {
                    SqliteValue.SReal(f)
                }
        }
    }
}

/**
 * CAST 到整数: 文本取**最长的合法数字前缀** (与亲和性转换不同 —— 后者要求整串都是数字)。
 *
 * `CAST('12abc' AS INTEGER)` 是 12, 而 `'12abc'` 存进 INTEGER 列仍是文本。两处规则不同,
 * 混用会让其中一处静默给错值。
 */
func castToInt(v: SqliteValue): Int64 {
    match (v) {
        case SInt(i) => i
        case SReal(f) => floatToInt(f)
        case _ => floatToInt(numericPrefixOf(valueToText(v)))
    }
}

func castToFloat(v: SqliteValue): Float64 {
    match (v) {
        case SInt(i) => Float64(i)
        case SReal(f) => f
        case _ => numericPrefixOf(valueToText(v))
    }
}

/** 取字符串开头的数字前缀; 没有则 0。 */
func numericPrefixOf(s: String): Float64 {
    let t = s.trimAsciiStart()
    let bs = t.toArray()
    var end = 0
    if (end < bs.size && (bs[end] == UInt8(b'+') || bs[end] == UInt8(b'-'))) {
        end += 1
    }
    var digits = 0
    while (end < bs.size && bs[end] >= UInt8(b'0') && bs[end] <= UInt8(b'9')) {
        end += 1
        digits += 1
    }
    if (end < bs.size && bs[end] == UInt8(b'.')) {
        end += 1
        while (end < bs.size && bs[end] >= UInt8(b'0') && bs[end] <= UInt8(b'9')) {
            end += 1
            digits += 1
        }
    }
    if (digits == 0) {
        return 0.0
    }
    // 指数部分只在其后确有数字时才算进来。
    if (end < bs.size && (bs[end] == UInt8(b'e') || bs[end] == UInt8(b'E'))) {
        var probe = end + 1
        if (probe < bs.size && (bs[probe] == UInt8(b'+') || bs[probe] == UInt8(b'-'))) {
            probe += 1
        }
        var expDigits = 0
        while (probe < bs.size && bs[probe] >= UInt8(b'0') && bs[probe] <= UInt8(b'9')) {
            probe += 1
            expDigits += 1
        }
        if (expDigits > 0) {
            end = probe
        }
    }
    try {
        Float64.parse(String.fromUtf8(bs[0..end]))
    } catch (_: Exception) {
        0.0
    }
}

/** 标量子查询: 取第一行第一列; 无行则 NULL。 */
func evalScalarSubquery(ctx: EvalContext, select: SelectStmt): SqliteValue {
    let rows = runSubquery(ctx, select)
    if (rows.isEmpty()) {
        return SqliteValue.SNull
    }
    let first = rows[0]
    if (first.size < 1) {
        return SqliteValue.SNull
    }
    first[0]
}

/** 索引的部分条件求值 (CREATE INDEX … WHERE), 只涉及单表的列。 */
func evalIndexPredicate(db: SqliteDatabase, table: TableInfo, row: Array<SqliteValue>, cond: Expr): Bool {
    let ctx = EvalContext(db, Array<SqliteValue>())
    let names = Array<String>(table.columns.size, repeat: "")
    for (i in 0..table.columns.size) {
        names[i] = table.columns[i].name
    }
    let src = RowSource(table.name, names, Some(table))
    src.values = row
    ctx.addSource(src)
    match (valueToTristate(evalExpr(ctx, cond))) {
        case Some(true) => true
        case _ => false
    }
}
