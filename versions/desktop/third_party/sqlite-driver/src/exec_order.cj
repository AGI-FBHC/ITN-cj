package sqlite_driver

import std.collection.*

/*
 * ORDER BY 与 LIMIT/OFFSET。
 *
 * ORDER BY 在结果集**已物化**之后做, 排序键按三种形态解析:
 *   1. 整数字面量 → 结果列序号 (1 起);
 *   2. 与某个结果列别名/名字相同的标识符 → 该结果列;
 *   3. 其余 → 表达式。
 *
 * 第三种引用的表达式常常不在结果列里 (`SELECT v FROM t ORDER BY id`)。这类项由
 * planOrderColumns 在求值之前**追加成隐藏结果列**, 于是排序键与行一起被算出来, 随后
 * 按 OrderPlan.visibleCount 裁掉 (trimHiddenColumns)。
 *
 * 集合运算与 VALUES 走不了这条路: 前者的两侧列数必须相等且合并后源行已不在, 后者没有
 * 源行可言。那两条路径上 ORDER BY 只允许形态 1 与 2 —— 与 SQLite 的限制一致。
 */

/**
 * 一趟 SELECT 的排序计划。
 *
 * keyIndexes[i] 是 orderBy[i] 取值用的结果列下标; visibleCount 之后的列都是隐藏排序键。
 * keyIndexes 为空表示没有计划 (集合运算与 VALUES 路径), 此时改按结果列名字/序号解析。
 */
class OrderPlan {
    let keyIndexes: Array<Int64>
    let visibleCount: Int64

    init(keyIndexes: Array<Int64>, visibleCount: Int64) {
        this.keyIndexes = keyIndexes
        this.visibleCount = visibleCount
    }
}

/**
 * 规划 ORDER BY 的取值来源, 必要时往 columns 尾部追加隐藏列。
 *
 * 就地改 columns: 调用方随后按它逐行求值, 隐藏列于是自动跟着算出来, 不需要第二趟扫描,
 * 也不需要在集合运算之后保留源行。
 */
func planOrderColumns(stmt: SelectStmt, columns: ArrayList<ResultColumn>): OrderPlan {
    let visibleCount = columns.size
    if (stmt.orderBy.isEmpty()) {
        return OrderPlan(Array<Int64>(), visibleCount)
    }
    let names = resultColumnNames(columns)
    let keyIndexes = Array<Int64>(stmt.orderBy.size, repeat: -1)
    for (i in 0..stmt.orderBy.size) {
        let term = stmt.orderBy[i]
        var idx = matchOrderTermToColumn(term, columns, names, visibleCount)
        if (idx < 0) {
            // 同一表达式出现在多个排序项里时复用同一隐藏列, 不重复求值。
            let sig = exprSignature(term.expr)
            var j = visibleCount
            while (j < columns.size) {
                if (exprSignature(columns[j].expr) == sig) {
                    idx = j
                    break
                }
                j += 1
            }
        }
        if (idx < 0) {
            columns.add(ResultColumn(term.expr, ""))
            idx = columns.size - 1
        }
        keyIndexes[i] = idx
    }
    OrderPlan(keyIndexes, visibleCount)
}

/**
 * 把一个 ORDER BY 项匹配到已有结果列, 匹配不上返回 -1。
 *
 * limit 是可以匹配的列数上限 —— 隐藏列由调用方单独处理, 序号形态也只能落在可见列上。
 */
func matchOrderTermToColumn(term: OrderTerm, columns: ArrayList<ResultColumn>, names: Array<String>, limit: Int64): Int64 {
    // 形态 1: 整数序号。
    if (term.expr is LiteralExpr) {
        let v = (term.expr as LiteralExpr).getOrThrow().value
        match (v) {
            case SInt(n) =>
                if (n < 1 || n > limit) {
                    throw SqliteRuntimeException("sql", "ORDER BY term out of range - should be between 1 and ${limit}")
                }
                return n - 1
            case _ => ()
        }
    }
    // 形态 2: 结果列名或别名。
    if (term.expr is ColumnExpr) {
        let c = (term.expr as ColumnExpr).getOrThrow()
        if (c.table.isEmpty()) {
            let lower = c.name.toAsciiLower()
            for (i in 0..limit) {
                if (i < names.size && names[i].toAsciiLower() == lower) {
                    return i
                }
            }
        }
    }
    // 形态 3: 表达式签名相同的结果列 —— `ORDER BY a+b` 复用 `SELECT a+b` 算好的值。
    let sig = exprSignature(term.expr)
    for (i in 0..limit) {
        if (i < columns.size && exprSignature(columns[i].expr) == sig) {
            return i
        }
    }
    -1
}

/**
 * 无计划路径 (集合运算与 VALUES): 排序键只能是结果列的名字或序号。
 *
 * 合并之后源行已经不在, 表达式无法重新求值; 拿不到值就静默排成 NULL 键的话, 表现是
 * "排序没生效", 所以这里直接报错。SQLite 对同类查询报的也是"不匹配任何结果列"。
 */
func resolveOrderTermsAgainstResult(stmt: SelectStmt, result: ResultSet): Array<Int64> {
    let out = Array<Int64>(stmt.orderBy.size, repeat: -1)
    // 空列表让形态 3 的签名匹配自然跳过 —— 这条路径上没有 ResultColumn 可比。
    let noColumns = ArrayList<ResultColumn>()
    for (i in 0..stmt.orderBy.size) {
        let idx = matchOrderTermToColumn(stmt.orderBy[i], noColumns, result.columnNames, result.columnNames.size)
        if (idx < 0) {
            throw SqliteRuntimeException("sql", "ORDER BY term ${i + 1} does not match any column in the result set")
        }
        out[i] = idx
    }
    out
}

/** 裁掉排序用的隐藏列, 只留调用方要的那些。 */
func trimHiddenColumns(result: ResultSet, visibleCount: Int64): ResultSet {
    if (visibleCount < 0 || visibleCount >= result.columnNames.size) {
        return result
    }
    let names = Array<String>(visibleCount, repeat: "")
    for (i in 0..visibleCount) {
        names[i] = result.columnNames[i]
    }
    let rows = ArrayList<Array<SqliteValue>>()
    for (row in result.rows) {
        let trimmed = Array<SqliteValue>(visibleCount, repeat: SqliteValue.SNull)
        for (i in 0..visibleCount) {
            if (i < row.size) {
                trimmed[i] = row[i]
            }
        }
        rows.add(trimmed)
    }
    ResultSet(names, rows)
}

/** 排序: 就地重排 result.rows。 */
func applyOrderBy(ctx: EvalContext, stmt: SelectStmt, result: ResultSet, plan: OrderPlan): ResultSet {
    if (stmt.orderBy.isEmpty()) {
        return result
    }
    let keyIndexes = if (plan.keyIndexes.size == stmt.orderBy.size) {
        plan.keyIndexes
    } else {
        resolveOrderTermsAgainstResult(stmt, result)
    }
    // 预计算所有排序键: 排序过程中重复求值会让代价从 n·log n 次比较变成 n·log n 次求值。
    let keys = ArrayList<Array<SqliteValue>>()
    let colls = Array<SqliteCollation>(stmt.orderBy.size, repeat: SqliteCollation.CollBinary)
    for (i in 0..stmt.orderBy.size) {
        colls[i] = orderTermCollation(ctx, stmt.orderBy[i], keyIndexes[i], result)
    }
    for (rowIdx in 0..result.rows.size) {
        let row = result.rows[rowIdx]
        let key = Array<SqliteValue>(stmt.orderBy.size, repeat: SqliteValue.SNull)
        for (i in 0..stmt.orderBy.size) {
            let idx = keyIndexes[i]
            key[i] = if (idx >= 0 && idx < row.size) {
                row[idx]
            } else {
                SqliteValue.SNull
            }
        }
        keys.add(key)
    }
    let order = sortedIndexes(keys, stmt.orderBy, colls)
    let sorted = ArrayList<Array<SqliteValue>>()
    for (idx in order) {
        sorted.add(result.rows[idx])
    }
    result.rows.clear()
    for (r in sorted) {
        result.rows.add(r)
    }
    result
}

/** 排序项的 collation: 显式 COLLATE 优先, 否则取结果列对应的列 collation。 */
func orderTermCollation(ctx: EvalContext, term: OrderTerm, columnIndex: Int64, result: ResultSet): SqliteCollation {
    let _ = columnIndex
    let _ = result
    if (!term.collation.isEmpty()) {
        return collationByName(term.collation)
    }
    if (let Some(c) <- explicitCollation(term.expr)) {
        return c
    }
    match (columnCollation(ctx, term.expr)) {
        case Some(c) => c
        case None => SqliteCollation.CollBinary
    }
}

/**
 * 稳定排序, 返回排好的下标。
 *
 * 自己实现归并排序而不用 ArrayList.sort: 需要**稳定**性 (等键行保持原顺序 —— SQLite 的
 * ORDER BY 在等键时的顺序虽未规定, 但稳定排序让同一查询的结果可复现), 且比较器要能访问
 * 多列键与每列独立的升降序。
 */
func sortedIndexes(keys: ArrayList<Array<SqliteValue>>, terms: ArrayList<OrderTerm>, colls: Array<SqliteCollation>): Array<Int64> {
    let n = keys.size
    var current = Array<Int64>(n, repeat: 0)
    for (i in 0..n) {
        current[i] = i
    }
    if (n < 2) {
        return current
    }
    var buffer = Array<Int64>(n, repeat: 0)
    var width = 1
    while (width < n) {
        var lo = 0
        while (lo < n) {
            let mid = if (lo + width < n) {
                lo + width
            } else {
                n
            }
            let hi = if (lo + 2 * width < n) {
                lo + 2 * width
            } else {
                n
            }
            mergeRuns(keys, terms, colls, current, buffer, lo, mid, hi)
            lo += 2 * width
        }
        let tmp = current
        current = buffer
        buffer = tmp
        width *= 2
    }
    current
}

func mergeRuns(keys: ArrayList<Array<SqliteValue>>, terms: ArrayList<OrderTerm>, colls: Array<SqliteCollation>,
    src: Array<Int64>, dst: Array<Int64>, lo: Int64, mid: Int64, hi: Int64): Unit {
    var i = lo
    var j = mid
    var k = lo
    while (i < mid && j < hi) {
        // <= 而不是 < : 等键时取左半的, 这是稳定性的来源。
        if (compareOrderKeys(keys[src[i]], keys[src[j]], terms, colls) <= 0) {
            dst[k] = src[i]
            i += 1
        } else {
            dst[k] = src[j]
            j += 1
        }
        k += 1
    }
    while (i < mid) {
        dst[k] = src[i]
        i += 1
        k += 1
    }
    while (j < hi) {
        dst[k] = src[j]
        j += 1
        k += 1
    }
}

/**
 * 多列排序键比较。
 *
 * NULL 的位置由 nullsFirst 决定: SQLite 默认 ASC 时 NULL 最小 (在前), DESC 时 NULL 最大
 * (仍在前, 因为整体取反)。显式 NULLS FIRST/LAST 覆盖默认。
 */
func compareOrderKeys(a: Array<SqliteValue>, b: Array<SqliteValue>, terms: ArrayList<OrderTerm>,
    colls: Array<SqliteCollation>): Int64 {
    for (i in 0..terms.size) {
        if (i >= a.size || i >= b.size) {
            break
        }
        let term = terms[i]
        let aNull = isNullValue(a[i])
        let bNull = isNullValue(b[i])
        if (aNull || bNull) {
            if (aNull && bNull) {
                continue
            }
            // NULL 相对非 NULL 的位置只看 nullsFirst, 不受 DESC 二次取反影响。
            let nullFirst = term.nullsFirst
            let c = if (aNull) {
                if (nullFirst) {
                    CMP_LT
                } else {
                    CMP_GT
                }
            } else {
                if (nullFirst) {
                    CMP_GT
                } else {
                    CMP_LT
                }
            }
            return c
        }
        var c = compareValues(a[i], b[i], colls[i])
        if (term.desc) {
            c = -c
        }
        if (c != CMP_EQ) {
            return c
        }
    }
    CMP_EQ
}

func isNullValue(v: SqliteValue): Bool {
    match (v) {
        case SNull => true
        case _ => false
    }
}

/**
 * LIMIT / OFFSET。
 *
 * 负 LIMIT 表示"无限制" (SQLite 语义), 负 OFFSET 当 0。LIMIT 为 NULL 时同样无限制。
 */
func applyLimitOffset(ctx: EvalContext, stmt: SelectStmt, result: ResultSet): ResultSet {
    let limitExpr = match (stmt.limit) {
        case Some(e) => e
        case None => return result
    }
    let limitValue = evalExpr(ctx, limitExpr)
    var limit = match (limitValue) {
        case SNull => -1
        case _ => valueToInt(coerceNumeric(limitValue))
    }
    var offset = 0
    if (let Some(offsetExpr) <- stmt.offset) {
        let ov = evalExpr(ctx, offsetExpr)
        offset = match (ov) {
            case SNull => 0
            case _ => valueToInt(coerceNumeric(ov))
        }
        if (offset < 0) {
            offset = 0
        }
    }
    if (limit < 0 && offset == 0) {
        return result
    }
    let kept = ArrayList<Array<SqliteValue>>()
    var taken = 0
    for (i in 0..result.rows.size) {
        if (i < offset) {
            continue
        }
        if (limit >= 0 && taken >= limit) {
            break
        }
        kept.add(result.rows[i])
        taken += 1
    }
    ResultSet(result.columnNames, kept)
}
