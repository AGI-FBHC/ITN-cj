package sqlite_driver

import std.collection.*
import std.convert.*

/*
 * rowid 访问路径。
 *
 * 表 B-tree 本身就是按 rowid 排序的, 所以 `WHERE rowid = ?` 与 `WHERE id = ?`
 * (id 是 INTEGER PRIMARY KEY) 只需一次 O(log n) 定位, 不必扫全表, 也不必回表 ——
 * 行数据就在命中的那个 cell 里。
 *
 * 这条路径必须与索引选择分开处理, 原因是 INTEGER PRIMARY KEY **按 SQLite 的设计不进
 * table.indexes**: 它就是 rowid 的别名, 不需要独立的索引树。于是 planTableAccess 里
 * "没有索引就全表扫"这一步会把最常见的主键点查也判成全表扫。
 *
 * 值的转换是这里唯一微妙的地方。rowid 是 Int64, 而约束值可能是 REAL 或 TEXT。SQLite 的
 * 规则是: 只有能无损表示成整数的值才可能等于某个 rowid, 别的值一律不匹配任何行。
 * 所以 `rowid = 1.5` 恒空, 而 `rowid > 1.5` 等价于 `rowid >= 2`。转换错的后果是静默漏行,
 * 因此凡是拿不准的形态 (TEXT、BLOB、超出 Int64 的 REAL) 一律返回 None 退回全表扫 ——
 * 慢, 但不会错。
 */

/** rowid 的三个伪列名。 */
func isRowidColumnName(name: String): Bool {
    match (name.toAsciiLower()) {
        case "rowid" | "_rowid_" | "oid" => true
        case _ => false
    }
}

/** 一个 rowid 访问计划: 等值点查, 或带边界的区间扫描。 */
class RowidPlan {
    /** 等值命中的 rowid; Some 时忽略上下界。 */
    let exact: Option<Int64>
    /** 区间下界 (含)。 */
    let lower: Option<Int64>
    /** 区间上界 (含)。 */
    let upper: Option<Int64>
    /** 区间恒空 (例如 rowid > 5 AND rowid < 3), 直接不产出任何行。 */
    let empty: Bool

    init(exact: Option<Int64>, lower: Option<Int64>, upper: Option<Int64>, empty: Bool) {
        this.exact = exact
        this.lower = lower
        this.upper = upper
        this.empty = empty
    }
}

/**
 * 把一个约束值折算成 rowid 边界。
 *
 * 返回 (整数值, 是否可用)。BLOB / NULL 与超出 Int64 的 REAL 都判不可用。
 * TEXT 会尝试解析为数字（按 SQLite 的类型亲和性规则）。
 * REAL 按 mode 取整: `lowerGE` 表示"用作 >= 的下界"(向上取整), `lowerGT` 表示"用作 > 的下界",
 * `upperLE` 表示"用作 <= 的上界"(向下取整), `upperLT` 表示"用作 < 的上界",
 * `exact` 表示必须恰好是整数才算命中。
 */
func rowidBoundOf(v: SqliteValue, mode: String): (Int64, Bool) {
    match (v) {
        case SInt(i) => (i, true)
        case SReal(f) =>
            // Int64 边界外的 REAL 折不回整数; 交给全表扫。
            if (f.isNaN() || f > 9.2233720368547738e18 || f < -9.2233720368547738e18) {
                return (0, false)
            }
            let truncated = Int64(f)
            let isWhole = Float64(truncated) == f
            match (mode) {
                case "exact" => (truncated, isWhole)
                // >= : 向上取整。4.5 → 5, 5.0 → 5, -2.5 → -2。
                case "lowerGE" =>
                    if (isWhole) {
                        (truncated, true)
                    } else if (f > 0.0) {
                        (truncated + 1, true)
                    } else {
                        (truncated, true)
                    }
                // > : 找第一个严格大于的整数。4.5 → 5, 5.0 → 6, -2.5 → -2, -2.0 → -1。
                case "lowerGT" =>
                    if (isWhole) {
                        (truncated + 1, true)
                    } else if (f > 0.0) {
                        (truncated + 1, true)
                    } else {
                        (truncated, true)
                    }
                // <= : 向下取整。8.5 → 8, 8.0 → 8, -2.5 → -3。
                case "upperLE" =>
                    if (isWhole) {
                        (truncated, true)
                    } else if (f > 0.0) {
                        (truncated, true)
                    } else {
                        (truncated - 1, true)
                    }
                // < : 找最后一个严格小于的整数。8.5 → 8, 8.0 → 7, -2.5 → -3, -2.0 → -3。
                case _ =>
                    if (isWhole) {
                        (truncated - 1, true)
                    } else if (f > 0.0) {
                        (truncated, true)
                    } else {
                        (truncated - 1, true)
                    }
            }
        case SText(s) =>
            // TEXT 按 SQLite 规则尝试转整数或浮点数。
            // 规则: 跳过前导空格, 尝试解析数字, 成功则递归用 REAL/INT 路径。
            let trimmed = s.trimAscii()
            if (trimmed.isEmpty()) {
                return (0, false)
            }
            // 尝试解析为整数。
            try {
                let parsed = Int64.parse(trimmed)
                return rowidBoundOf(SInt(parsed), mode)
            } catch (_: Exception) {
                ()
            }
            // 尝试解析为浮点数。
            try {
                let parsed = Float64.parse(trimmed)
                return rowidBoundOf(SReal(parsed), mode)
            } catch (_: Exception) {
                ()
            }
            // 解析失败: TEXT 不能转为数字, 交给全表扫。
            return (0, false)
        // BLOB 与 rowid 比较时, SQLite 的类型序把它们排在所有整数之后 ——
        // 结果与"没有匹配行"不同 (范围比较会全中或全不中), 交给通用求值更稳。
        case _ => (0, false)
    }
}

/**
 * 为一个表源挑 rowid 访问计划。
 *
 * 与 planTableAccess 里的索引选择共用约束抽取的思路, 但作用在 rowid 上而不是某个索引列。
 * 与索引选择相同的两条保护也照用：构建中间结果时不启用（外层源里是残值），非常量表达式不参与。
 */
func planRowidAccess(ctx: EvalContext, table: TableInfo, level: Int64): Option<RowidPlan> {
    if (table.withoutRowid || ctx.materializing) {
        return None
    }
    let conditions = collectAccessConditions(ctx, level)
    if (conditions.isEmpty()) {
        return None
    }
    var exact: Option<Int64> = None
    var lower: Option<Int64> = None
    var upper: Option<Int64> = None
    var empty = false
    for (cond in conditions) {
        for (c in rowidConstraintsOf(ctx, cond, table, level)) {
            match (c.op) {
                case "=" =>
                    let (v, usable) = rowidBoundOf(c.value, "exact")
                    if (!usable) {
                        // `rowid = 1.5` 与 `rowid = 'x'`: 不可能命中任何行。
                        empty = true
                    } else {
                        match (exact) {
                            // 两个不同的等值约束互斥。
                            case Some(prev) where prev != v => empty = true
                            case _ => exact = Some(v)
                        }
                    }
                case ">" | ">=" =>
                    let mode = if (c.op == ">") {
                        "lowerGT"
                    } else {
                        "lowerGE"
                    }
                    let (v, usable) = rowidBoundOf(c.value, mode)
                    if (usable) {
                        lower = Some(maxBound(lower, v))
                    }
                case "<" | "<=" =>
                    let mode = if (c.op == "<") {
                        "upperLT"
                    } else {
                        "upperLE"
                    }
                    let (v, usable) = rowidBoundOf(c.value, mode)
                    if (usable) {
                        upper = Some(minBound(upper, v))
                    }
                case _ => ()
            }
        }
    }
    if (empty) {
        return Some(RowidPlan(None, None, None, true))
    }
    match (exact) {
        case Some(v) => return Some(RowidPlan(Some(v), None, None, false))
        case None => ()
    }
    match ((lower, upper)) {
        // 无任何边界: 没有比全表扫更好的做法。
        case (None, None) => None
        case (Some(lo), Some(hi)) where lo > hi => Some(RowidPlan(None, None, None, true))
        case _ => Some(RowidPlan(None, lower, upper, false))
    }
}

func maxBound(current: Option<Int64>, candidate: Int64): Int64 {
    match (current) {
        case None => candidate
        case Some(v) =>
            if (candidate > v) {
                candidate
            } else {
                v
            }
    }
}

func minBound(current: Option<Int64>, candidate: Int64): Int64 {
    match (current) {
        case None => candidate
        case Some(v) =>
            if (candidate < v) {
                candidate
            } else {
                v
            }
    }
}

/**
 * 从一个条件里抽 rowid 约束。
 *
 * 认两种列写法: `rowid`/`_rowid_`/`oid` 伪列, 以及 INTEGER PRIMARY KEY 别名列。
 * 后者在表里有真实列号, 所以要与 table.rowidAliasColumn 比对而不是只看名字。
 */
func rowidConstraintsOf(ctx: EvalContext, cond: Expr, table: TableInfo, level: Int64): ArrayList<IndexConstraint> {
    let out = ArrayList<IndexConstraint>()
    if (cond is BetweenExpr) {
        let b = (cond as BetweenExpr).getOrThrow()
        if (b.negated || !isRowidRef(ctx, b.target, table, level)) {
            return out
        }
        if (!isOuterConstant(ctx, b.low, level) || !isOuterConstant(ctx, b.high, level)) {
            return out
        }
        out.add(IndexConstraint(-1, ">=", evalExpr(ctx, b.low)))
        out.add(IndexConstraint(-1, "<=", evalExpr(ctx, b.high)))
        return out
    }
    if (!(cond is BinaryExpr)) {
        return out
    }
    let b = (cond as BinaryExpr).getOrThrow()
    if (!isComparisonOp(b.op) || b.op == "<>") {
        return out
    }
    var valueExpr = b.right
    var op = b.op
    if (!isRowidRef(ctx, b.left, table, level)) {
        if (!isRowidRef(ctx, b.right, table, level)) {
            return out
        }
        valueExpr = b.left
        op = reverseComparison(b.op)
    }
    if (!isOuterConstant(ctx, valueExpr, level)) {
        return out
    }
    let v = evalExpr(ctx, valueExpr)
    match (v) {
        // NULL 比较恒为 NULL, 不选中任何行; 交给通用求值处理。
        case SNull => return out
        case _ => ()
    }
    out.add(IndexConstraint(-1, op, v))
    return out
}

/** 表达式是否指向本表的 rowid (伪列或 INTEGER PRIMARY KEY 别名列)。 */
func isRowidRef(ctx: EvalContext, e: Expr, table: TableInfo, level: Int64): Bool {
    if (!(e is ColumnExpr)) {
        return false
    }
    let c = (e as ColumnExpr).getOrThrow()
    if (level >= ctx.sources.size) {
        return false
    }
    let src = ctx.sources[level]
    if (!c.table.isEmpty() && c.table.toAsciiLower() != src.name.toAsciiLower()) {
        return false
    }
    if (isRowidColumnName(c.name)) {
        // 伪列名可以被真实列遮蔽: `CREATE TABLE t(rowid TEXT)` 里 rowid 指那一列。
        return table.columnIndexOf(c.name) < 0
    }
    if (table.rowidAliasColumn < 0) {
        return false
    }
    // 别名列: 未限定的列名要确认它在本层唯一, 否则可能指别的源。
    if (c.table.isEmpty()) {
        var matches = 0
        for (s in ctx.sources) {
            if (s.columnIndexOf(c.name) >= 0) {
                matches += 1
            }
        }
        if (matches != 1 || src.columnIndexOf(c.name) < 0) {
            return false
        }
    }
    table.columnIndexOf(c.name) == table.rowidAliasColumn
}

/**
 * 沿 rowid 计划取行。
 *
 * 等值形态只做一次 seekRowid; 区间形态从下界定位后顺序前进, 越过上界即停 ——
 * 表树按 rowid 有序, 所以"越界即停"不会漏掉后面的行。
 */
func iterateViaRowid(ctx: EvalContext, src: RowSource, table: TableInfo, plan: RowidPlan, body: () -> Bool): Unit {
    if (plan.empty) {
        return
    }
    let cursor = BtreeCursor(ctx.db.pager, table.rootPage, true)
    if (let Some(key) <- plan.exact) {
        if (!cursor.seekRowid(key)) {
            return
        }
        emitCursorRow(src, table, cursor)
        let _ = body()
        return
    }
    var ok = match (plan.lower) {
        case Some(lo) =>
            // 未精确命中时游标已停在第一个大于 lo 的记录上, 正是区间起点。
            let hit = cursor.seekRowid(lo)
            hit || cursor.isValid
        case None => cursor.first()
    }
    while (ok) {
        checkStatementControl(ctx.db)
        let rowid = cursor.currentRowid()
        if (let Some(hi) <- plan.upper) {
            if (rowid > hi) {
                return
            }
        }
        emitCursorRow(src, table, cursor)
        if (!body()) {
            return
        }
        ok = cursor.next()
    }
}

/** 把游标当前行装进数据源。 */
func emitCursorRow(src: RowSource, table: TableInfo, cursor: BtreeCursor): Unit {
    let rowid = cursor.currentRowid()
    src.values = decodeRowValues(table, rowid, cursor.currentPayload())
    src.rowid = rowid
    src.isNullRow = false
}
