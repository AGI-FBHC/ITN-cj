package sqlite_driver

import std.collection.*

/*
 * SELECT 执行。
 *
 * 执行时会将当前结果行收进 ArrayList，再交给后续处理。处理顺序为 FROM、WHERE、
 * GROUP BY/聚合、HAVING、DISTINCT、集合运算、ORDER BY 与 LIMIT。
 *
 * 这种处理的代价是内存与行数成正比，换来三项直接可保证的行为：
 *   1. ORDER BY 与 DISTINCT 本来就需要看到全部行;
 *   2. 关联子查询可以直接递归调用本执行器, 不必把外层迭代器状态穿进去;
 *   3. UPDATE/DELETE 必须先把要改的 rowid 全部定下来再动手 —— 边扫边改会让 B-tree
 *      游标失效, 或者让同一行被改两次 (改完 rowid 后行移到游标前方, 再次被扫到)。
 *
 * 表扫描已接索引: WHERE 里形如 `col = ?` / `col > ?` / `col BETWEEN`, 且 col 上有索引时
 * 走索引区间, 否则全表扫。选择逻辑在 planTableAccess。
 */

/** 一次查询的结果: 列名 + 行。 */
class ResultSet {
    let columnNames: Array<String>
    let rows: ArrayList<Array<SqliteValue>>

    init(columnNames: Array<String>, rows: ArrayList<Array<SqliteValue>>) {
        this.columnNames = columnNames
        this.rows = rows
    }
}

/** 执行一条 SELECT, 返回列名与全部行。 */
func executeSelect(db: SqliteDatabase, stmt: SelectStmt, params: Array<SqliteValue>): ResultSet {
    let ctx = EvalContext(db, params)
    runSelectInto(ctx, stmt)
}

/**
 * 子查询执行: 只要行, 不要列名。
 *
 * 子上下文的 outer 指向当前上下文, 于是关联子查询里的外层列引用能解析到 —— evalColumn
 * 在本层找不到列时会沿 outer 往上找。
 */
func runSubquery(ctx: EvalContext, select: SelectStmt): ArrayList<Array<SqliteValue>> {
    let child = ctx.childContext()
    runSelectInto(child, select).rows
}

/** SELECT 的主流程。 */
func runSelectInto(ctx: EvalContext, stmt: SelectStmt): ResultSet {
    // WITH 子句先注册 (不求解): 作用域是整条语句, 而求解按需触发, 于是前后引用都成立。
    if (!stmt.withCtes.isEmpty()) {
        registerCtes(ctx, stmt.withCtes)
    }
    let (first, plan) = runSetTerm(ctx, stmt)
    var result = first
    // AST 是书写顺序的右向链。逐项合并才能得到 SQLite 的左结合语义:
    // `a UNION b EXCEPT c` 必须算成 `(a UNION b) EXCEPT c`。
    var current = stmt
    while (let Some(op) <- current.setOp) {
        let rightStmt = match (current.setRight) {
            case Some(r) => r
            case None => throw SqliteRuntimeException("sql", "set operation is missing its right-hand SELECT")
        }
        let (right, _) = runSetTerm(ctx.childContext(), rightStmt)
        result = combineResultSets(result, right, op)
        current = rightStmt
    }
    // ORDER BY 与 LIMIT 作用在集合运算之后 —— 它们属于最外层查询。
    result = applyOrderBy(ctx, stmt, result, plan)
    result = applyLimitOffset(ctx, stmt, result)
    // 排序用的隐藏列到此为止: 子查询与标量子查询都从这里拿结果, 不该看见它们。
    trimHiddenColumns(result, plan.visibleCount)
}

/** 执行集合链上的一个 core, 不跟随它的 setRight, 也不施加最外层 ORDER BY/LIMIT。 */
private func runSetTerm(ctx: EvalContext, stmt: SelectStmt): (ResultSet, OrderPlan) {
    if (!stmt.withCtes.isEmpty()) {
        registerCtes(ctx, stmt.withCtes)
    }
    if (!stmt.valuesRows.isEmpty()) {
        let result = runValuesRows(ctx, stmt)
        return (result, OrderPlan(Array<Int64>(), result.columnNames.size))
    }
    runSelectCore(ctx, stmt)
}

/** VALUES 的单个 core, 不执行集合链、ORDER BY 或 LIMIT。 */
private func runValuesRows(ctx: EvalContext, stmt: SelectStmt): ResultSet {
    let rows = ArrayList<Array<SqliteValue>>()
    var width = 0
    for (rowExprs in stmt.valuesRows) {
        if (width == 0) {
            width = rowExprs.size
        } else if (rowExprs.size != width) {
            throw SqliteRuntimeException("sql",
                "all VALUES rows must have the same number of columns (${width} expected, got ${rowExprs.size})")
        }
        let row = Array<SqliteValue>(rowExprs.size, repeat: SqliteValue.SNull)
        for (i in 0..rowExprs.size) {
            row[i] = evalExpr(ctx, rowExprs[i])
        }
        rows.add(row)
    }
    let names = Array<String>(width, repeat: "")
    for (i in 0..width) {
        names[i] = "column${i + 1}"
    }
    ResultSet(names, rows)
}

/**
 * 一个 SELECT 核心 (不含集合运算与最外层 ORDER BY/LIMIT)。
 *
 * 一并返回排序计划: ORDER BY 引用的非结果列表达式在这里被追加成隐藏列并算出值, 调用方
 * 排完序后按 plan.visibleCount 裁掉。
 */
func runSelectCore(ctx: EvalContext, stmt: SelectStmt): (ResultSet, OrderPlan) {
    // CTE 在 buildSources 中按需缓存。先登记当前语句，才能把安全的外层 LIMIT 作为递归预算。
    ctx.currentStatement = Some(stmt)
    let sources = buildSources(ctx, stmt)
    for (s in sources) {
        ctx.addSource(s)
    }
    validateWithoutRowidRowidReferences(ctx, stmt)
    // 连接树必须在展开 `*` 之前建好: 建树的过程同时登记 USING / NATURAL 的列合并, 而
    // `*` 展开要靠它决定哪些列不再单独出现。
    if (!stmt.from.isEmpty()) {
        ctx.joinTree = Some(buildJoinTree(ctx, stmt))
    }
    let columns = expandResultColumns(ctx, stmt)
    // 集合运算的两侧列数必须相等, 那条路径上不能追加隐藏列。
    var plan = OrderPlan(Array<Int64>(), columns.size)
    match (stmt.setOp) {
        case Some(_) => ()
        case None => plan = planOrderColumns(stmt, columns)
    }
    // 收集所有聚合表达式: 有聚合或有 GROUP BY 时走分组路径。
    let aggregates = collectAggregates(stmt)
    rejectAggregateOnlyInOrderBy(stmt, aggregates)
    let grouped = !stmt.groupBy.isEmpty() || !aggregates.isEmpty()
    let rows = if (grouped) {
        runGroupedSelect(ctx, stmt, columns, aggregates)
    } else {
        runPlainSelect(ctx, stmt, columns)
    }
    var result = ResultSet(resultColumnNames(columns), rows)
    if (stmt.distinct) {
        result = ResultSet(result.columnNames, distinctRows(result.rows, plan.visibleCount))
    }
    (result, plan)
}

/** rowid 伪列在 WITHOUT ROWID 表上不存在，即使空表也要在执行前报错。 */
func validateWithoutRowidRowidReferences(ctx: EvalContext, stmt: SelectStmt): Unit {
    let expressions = ArrayList<Expr>()
    for (column in stmt.columns) {
        expressions.add(column.expr)
    }
    if (let Some(w) <- stmt.whereExpr) {
        expressions.add(w)
    }
    for (g in stmt.groupBy) {
        expressions.add(g)
    }
    if (let Some(h) <- stmt.having) {
        expressions.add(h)
    }
    for (term in stmt.orderBy) {
        expressions.add(term.expr)
    }
    for (expr in expressions) {
        validateWithoutRowidRowidExpr(ctx, expr)
    }
}

func validateWithoutRowidRowidExpr(ctx: EvalContext, expr: Expr): Unit {
    if (expr is ColumnExpr) {
        let c = (expr as ColumnExpr).getOrThrow()
        if (isRowidColumnName(c.name)) {
            if (!c.table.isEmpty()) {
                for (src in ctx.sources) {
                    if (src.name.toAsciiLower() == c.table.toAsciiLower()) {
                        if (let Some(table) <- src.table) {
                            if (table.withoutRowid && table.columnIndexOf(c.name) < 0) {
                                throw SqliteRuntimeException("sql", "no such column: ${c.name}")
                            }
                        }
                        break
                    }
                }
            } else {
                var hasRealColumn = false
                var hasRowidSource = false
                var hasWithoutRowidSource = false
                for (src in ctx.sources) {
                    if (let Some(table) <- src.table) {
                        if (src.columnIndexOf(c.name) >= 0) {
                            hasRealColumn = true
                        } else if (table.withoutRowid) {
                            hasWithoutRowidSource = true
                        } else {
                            hasRowidSource = true
                        }
                    }
                }
                if (!hasRealColumn && !hasRowidSource && hasWithoutRowidSource) {
                    throw SqliteRuntimeException("sql", "no such column: ${c.name}")
                }
            }
        }
    }
    for (child in childExpressions(expr)) {
        validateWithoutRowidRowidExpr(ctx, child)
    }
}

/**
 * ORDER BY 里的聚合只在查询本就是聚合查询时才合法。
 *
 * `SELECT v FROM t ORDER BY max(id)` 在 SQLite 里报 misuse of aggregate: 没有 GROUP BY
 * 也没有聚合结果列时, 整个查询是逐行的, 单个"最大值"无处安放。这条守卫不可省 —— 隐藏列
 * 机制会老老实实把 max(id) 算成一个单桶值然后静默返回一行, 与 SQLite 分歧且不报错。
 */
func rejectAggregateOnlyInOrderBy(stmt: SelectStmt, aggregates: ArrayList<FuncExpr>): Unit {
    if (aggregates.isEmpty() || !stmt.groupBy.isEmpty() || stmt.orderBy.isEmpty()) {
        return
    }
    let outsideOrderBy = HashSet<String>()
    for (c in stmt.columns) {
        for (f in aggregatesIn(c.expr)) {
            outsideOrderBy.add(exprSignature(f))
        }
    }
    if (let Some(h) <- stmt.having) {
        for (f in aggregatesIn(h)) {
            outsideOrderBy.add(exprSignature(f))
        }
    }
    if (!outsideOrderBy.isEmpty()) {
        return
    }
    for (term in stmt.orderBy) {
        let found = aggregatesIn(term.expr)
        if (!found.isEmpty()) {
            throw SqliteRuntimeException("sql", "misuse of aggregate: ${found[0].name.toAsciiLower()}()")
        }
    }
}

/** 一个表达式里的聚合调用。 */
func aggregatesIn(e: Expr): ArrayList<FuncExpr> {
    let out = ArrayList<FuncExpr>()
    collectAggregatesIn(e, out, HashSet<String>())
    out
}

/** 无聚合路径: 逐行过 WHERE, 命中就算结果列。 */
func runPlainSelect(ctx: EvalContext, stmt: SelectStmt, columns: ArrayList<ResultColumn>): ArrayList<Array<SqliteValue>> {
    if (hasWindowExpressions(columns, stmt.orderBy)) {
        return runPlainSelectWithWindows(ctx, stmt, columns)
    }
    let out = ArrayList<Array<SqliteValue>>()
    let scanBudget = plainSelectScanBudget(ctx, stmt)
    if (scanBudget == 0) {
        return out
    }
    iterateJoinedRows(ctx, stmt) {
        =>
            let row = Array<SqliteValue>(columns.size, repeat: SqliteValue.SNull)
            for (i in 0..columns.size) {
                row[i] = evalExpr(ctx, columns[i].expr)
            }
            out.add(row)
            scanBudget < 0 || out.size < scanBudget
    }
    out
}

/**
 * 返回普通 SELECT 扫描时最多需要保留的行数；-1 表示不得或无需提前停止。
 *
 * OFFSET 仍由末尾的 applyLimitOffset 切掉，因此这里的预算是 offset + limit。凡是需要看到
 * 全集才能确定结果的处理步骤都禁用下推；LIMIT/OFFSET 引用本查询列或含非确定表达式时也保守
 * 禁用，避免把求值时机从扫描后挪到扫描前。
 */
func plainSelectScanBudget(ctx: EvalContext, stmt: SelectStmt): Int64 {
    if (!stmt.orderBy.isEmpty() || !stmt.groupBy.isEmpty() || stmt.having.isSome() || stmt.distinct ||
        stmt.setOp.isSome()) {
        return -1
    }
    let limitExpr = match (stmt.limit) {
        case Some(e) => e
        case None => return -1
    }
    if (!isOuterConstant(ctx, limitExpr, 0)) {
        return -1
    }
    let limitValue = evalExpr(ctx, limitExpr)
    let limit = match (limitValue) {
        case SNull => return -1
        case _ => valueToInt(coerceNumeric(limitValue))
    }
    if (limit < 0) {
        return -1
    }
    var offset = 0
    if (let Some(offsetExpr) <- stmt.offset) {
        if (!isOuterConstant(ctx, offsetExpr, 0)) {
            return -1
        }
        let offsetValue = evalExpr(ctx, offsetExpr)
        offset = match (offsetValue) {
            case SNull => 0
            case _ => valueToInt(coerceNumeric(offsetValue))
        }
        if (offset < 0) {
            offset = 0
        }
    }
    // 溢出意味着预算实际上不可达，等价于不下推。
    if (offset > Int64.Max - limit) {
        return -1
    }
    offset + limit
}

/**
 * 聚合路径。
 *
 * 两遍求值: 第一遍按分组键把行分桶并累加, 第二遍对每个桶算结果表达式。第二遍必须保留
 * 桶里**某一行**的列值作为上下文 —— `SELECT dept, count(*) … GROUP BY dept` 的 dept
 * 要从行里取。SQLite 取的是该组最后见到的行, 这里保持一致。
 *
 * 无 GROUP BY 且有聚合时只有一个桶, 且**即使没有行也要输出一行** (count 返回 0)。
 * 这条不能漏: `SELECT count(*) FROM empty` 必须给 0 而不是空集。
 */
func runGroupedSelect(ctx: EvalContext, stmt: SelectStmt, columns: ArrayList<ResultColumn>,
    aggregates: ArrayList<FuncExpr>): ArrayList<Array<SqliteValue>> {
    if (hasWindowExpressions(columns, stmt.orderBy)) {
        return runGroupedSelectWithWindows(ctx, stmt, columns, aggregates)
    }
    let buckets = ArrayList<GroupBucket>()
    let byKey = HashMap<String, Int64>()
    iterateJoinedRows(ctx, stmt) {
        =>
            let keyValues = Array<SqliteValue>(stmt.groupBy.size, repeat: SqliteValue.SNull)
            for (i in 0..stmt.groupBy.size) {
                keyValues[i] = evalExpr(ctx, stmt.groupBy[i])
            }
            let key = groupKeyString(keyValues)
            let idx = match (byKey.get(key)) {
                case Some(i) => i
                case None =>
                    let bucket = GroupBucket(keyValues)
                    for (agg in aggregates) {
                        bucket.states[aggregateKeyOf(ctx, agg)] = AggregateState(agg.name.toAsciiLower(), agg.distinct)
                    }
                    buckets.add(bucket)
                    byKey[key] = buckets.size - 1
                    buckets.size - 1
            }
            let bucket = buckets[idx]
            // 记下本组的一行快照, 第二遍求非聚合列时要用。
            bucket.snapshot = snapshotSources(ctx)
            accumulateInto(ctx, bucket, aggregates)
            true
    }
    if (buckets.isEmpty() && stmt.groupBy.isEmpty()) {
        // 空表 + 无 GROUP BY: 造一个空桶, 让 count 输出 0、sum 输出 NULL。
        let bucket = GroupBucket(Array<SqliteValue>())
        for (agg in aggregates) {
            bucket.states[aggregateKeyOf(ctx, agg)] = AggregateState(agg.name.toAsciiLower(), agg.distinct)
        }
        bucket.snapshot = snapshotSources(ctx)
        buckets.add(bucket)
    }
    let out = ArrayList<Array<SqliteValue>>()
    for (bucket in buckets) {
        restoreSources(ctx, bucket.snapshot)
        let results = HashMap<Int64, SqliteValue>()
        for ((key, state) in bucket.states) {
            results[key] = finalizeAggregate(state)
        }
        ctx.aggregateResults = Some(results)
        ctx.aggregates = None
        // HAVING 在聚合结果算好之后过滤, 且它自己可以引用聚合。
        if (let Some(having) <- stmt.having) {
            match (valueToTristate(evalExpr(ctx, having))) {
                case Some(true) => ()
                case _ =>
                    ctx.aggregateResults = None
                    continue
            }
        }
        let row = Array<SqliteValue>(columns.size, repeat: SqliteValue.SNull)
        for (i in 0..columns.size) {
            row[i] = evalExpr(ctx, columns[i].expr)
        }
        ctx.aggregateResults = None
        out.add(row)
    }
    out
}

/** 一个分组桶。 */
class GroupBucket {
    let keyValues: Array<SqliteValue>
    let states = HashMap<Int64, AggregateState>()
    /** 该组中一行的数据源快照, 供第二遍求非聚合列用。 */
    var snapshot = ArrayList<SourceSnapshot>()

    init(keyValues: Array<SqliteValue>) {
        this.keyValues = keyValues
    }
}

/** 数据源在某一行上的取值快照。 */
class SourceSnapshot {
    let values: Array<SqliteValue>
    let rowid: Int64
    let isNullRow: Bool

    init(values: Array<SqliteValue>, rowid: Int64, isNullRow: Bool) {
        this.values = values
        this.rowid = rowid
        this.isNullRow = isNullRow
    }
}

func snapshotSources(ctx: EvalContext): ArrayList<SourceSnapshot> {
    let out = ArrayList<SourceSnapshot>()
    for (src in ctx.sources) {
        let copy = Array<SqliteValue>(src.values.size, repeat: SqliteValue.SNull)
        for (i in 0..src.values.size) {
            copy[i] = src.values[i]
        }
        out.add(SourceSnapshot(copy, src.rowid, src.isNullRow))
    }
    out
}

func restoreSources(ctx: EvalContext, snap: ArrayList<SourceSnapshot>): Unit {
    for (i in 0..ctx.sources.size) {
        if (i >= snap.size) {
            break
        }
        let src = ctx.sources[i]
        let s = snap[i]
        for (j in 0..src.values.size) {
            if (j < s.values.size) {
                src.values[j] = s.values[j]
            }
        }
        src.rowid = s.rowid
        src.isNullRow = s.isNullRow
    }
}

/**
 * 聚合表达式的标识键。
 *
 * 用"表达式对象的身份"而不是文本: 同一条语句里 `sum(a)` 出现两次 (如 SELECT 与 HAVING
 * 各一次) 时, 它们是不同的 AST 节点但语义相同, 应共用一个累加器。这里按结构化文本归一
 * 后取哈希 —— 文本相同即视为同一个聚合。
 */
func aggregateKeyOf(ctx: EvalContext, f: FuncExpr): Int64 {
    let _ = ctx
    let sb = StringBuilder()
    sb.append(f.name.toAsciiLower())
    sb.append("(")
    if (f.distinct) {
        sb.append("DISTINCT ")
    }
    if (f.starArg) {
        sb.append("*")
    }
    for (a in f.args) {
        sb.append(exprSignature(a))
        sb.append(",")
    }
    sb.append(")")
    stableStringHash(sb.toString())
}

/** 稳定的字符串哈希, 供聚合键用。不用 String.hashCode: 它跨版本可变。 */
func stableStringHash(s: String): Int64 {
    var h = 1125899906842597
    for (b in s.toArray()) {
        h = wrappingHashStep(h, Int64(b))
    }
    // 只保留正数, 便于调试时阅读。
    if (h < 0) {
        -h
    } else {
        h
    }
}

@OverflowWrapping
func wrappingHashStep(h: Int64, b: Int64): Int64 {
    h * 31 + b
}

/** 收集语句里全部聚合调用 (SELECT 列、HAVING、ORDER BY 都算)。 */
func collectAggregates(stmt: SelectStmt): ArrayList<FuncExpr> {
    let out = ArrayList<FuncExpr>()
    let seen = HashSet<String>()
    for (c in stmt.columns) {
        collectAggregatesIn(c.expr, out, seen)
    }
    if (let Some(h) <- stmt.having) {
        collectAggregatesIn(h, out, seen)
    }
    for (o in stmt.orderBy) {
        collectAggregatesIn(o.expr, out, seen)
    }
    out
}

func collectAggregatesIn(e: Expr, out: ArrayList<FuncExpr>, seen: HashSet<String>): Unit {
    if (e is WindowExpr) {
        let w = (e as WindowExpr).getOrThrow()
        // 窗口函数自身不是 GROUP BY 聚合，但参数/分区键/排序键里可以引用已经分组完成的聚合，
        // 例如 `sum(sum(v)) OVER ()` 或 `rank() OVER (ORDER BY sum(v))`。
        for (a in w.funcExpr.args) {
            collectAggregatesIn(a, out, seen)
        }
        if (let Some(filter) <- w.filter) {
            collectAggregatesIn(filter, out, seen)
        }
        for (p in w.spec.partitionBy) {
            collectAggregatesIn(p, out, seen)
        }
        for (o in w.spec.orderBy) {
            collectAggregatesIn(o.expr, out, seen)
        }
        return
    }
    if (e is FuncExpr) {
        let f = (e as FuncExpr).getOrThrow()
        if (isAggregateName(f.name, f.args.size)) {
            let sig = exprSignature(e)
            if (!seen.contains(sig)) {
                seen.add(sig)
                out.add(f)
            }
            // 聚合的参数里不允许再嵌聚合, 不继续下降。
            return
        }
        for (a in f.args) {
            collectAggregatesIn(a, out, seen)
        }
        return
    }
    for (child in childExpressions(e)) {
        collectAggregatesIn(child, out, seen)
    }
}

/** 表达式的直接子表达式。子查询内部不下降 —— 那是独立作用域。 */
func childExpressions(e: Expr): ArrayList<Expr> {
    let out = ArrayList<Expr>()
    if (e is UnaryExpr) {
        out.add((e as UnaryExpr).getOrThrow().operand)
    } else if (e is BinaryExpr) {
        let b = (e as BinaryExpr).getOrThrow()
        out.add(b.left)
        out.add(b.right)
    } else if (e is NullTestExpr) {
        out.add((e as NullTestExpr).getOrThrow().operand)
    } else if (e is LikeExpr) {
        let l = (e as LikeExpr).getOrThrow()
        out.add(l.target)
        out.add(l.pattern)
        if (let Some(esc) <- l.escape) {
            out.add(esc)
        }
    } else if (e is BetweenExpr) {
        let b = (e as BetweenExpr).getOrThrow()
        out.add(b.target)
        out.add(b.low)
        out.add(b.high)
    } else if (e is InExpr) {
        let i = (e as InExpr).getOrThrow()
        out.add(i.target)
        for (v in i.values) {
            out.add(v)
        }
    } else if (e is CaseExpr) {
        let c = (e as CaseExpr).getOrThrow()
        if (let Some(op) <- c.operand) {
            out.add(op)
        }
        for ((cond, res) in c.whens) {
            out.add(cond)
            out.add(res)
        }
        if (let Some(el) <- c.elseExpr) {
            out.add(el)
        }
    } else if (e is CastExpr) {
        out.add((e as CastExpr).getOrThrow().operand)
    } else if (e is CollateExpr) {
        out.add((e as CollateExpr).getOrThrow().operand)
    } else if (e is WindowExpr) {
        let w = (e as WindowExpr).getOrThrow()
        for (a in w.funcExpr.args) {
            out.add(a)
        }
        if (let Some(filter) <- w.filter) {
            out.add(filter)
        }
        for (p in w.spec.partitionBy) {
            out.add(p)
        }
        for (o in w.spec.orderBy) {
            out.add(o.expr)
        }
        if (let Some(offset) <- w.spec.frameStart.offset) {
            out.add(offset)
        }
        if (let Some(offset) <- w.spec.frameEnd.offset) {
            out.add(offset)
        }
    } else if (e is FuncExpr) {
        for (a in (e as FuncExpr).getOrThrow().args) {
            out.add(a)
        }
    }
    out
}

/**
 * 表达式的结构化签名, 用于判定"是同一个表达式"。
 *
 * 只需要区分不同表达式, 不需要能反解回 SQL。子查询用对象身份的替代物 (递归签名) ——
 * 两个文本相同的子查询会被视为同一个, 这对聚合去重是正确的。
 */
func exprSignature(e: Expr): String {
    if (e is LiteralExpr) {
        return "L:${renderLiteral((e as LiteralExpr).getOrThrow().value)}"
    }
    if (e is ColumnExpr) {
        let c = (e as ColumnExpr).getOrThrow()
        return "C:${c.table.toAsciiLower()}.${c.name.toAsciiLower()}"
    }
    if (e is StarExpr) {
        return "S:${(e as StarExpr).getOrThrow().table.toAsciiLower()}"
    }
    if (e is ParamExpr) {
        return "P:${(e as ParamExpr).getOrThrow().ordinal}"
    }
    if (e is UnaryExpr) {
        let u = (e as UnaryExpr).getOrThrow()
        return "U:${u.op}(${exprSignature(u.operand)})"
    }
    if (e is BinaryExpr) {
        let b = (e as BinaryExpr).getOrThrow()
        return "B:${b.op}(${exprSignature(b.left)},${exprSignature(b.right)})"
    }
    if (e is NullTestExpr) {
        let n = (e as NullTestExpr).getOrThrow()
        return "N:${n.negated}(${exprSignature(n.operand)})"
    }
    if (e is LikeExpr) {
        let l = (e as LikeExpr).getOrThrow()
        return "K:${l.glob}${l.negated}(${exprSignature(l.target)},${exprSignature(l.pattern)})"
    }
    if (e is BetweenExpr) {
        let b = (e as BetweenExpr).getOrThrow()
        return "T:${b.negated}(${exprSignature(b.target)},${exprSignature(b.low)},${exprSignature(b.high)})"
    }
    if (e is InExpr) {
        let i = (e as InExpr).getOrThrow()
        let sb = StringBuilder()
        sb.append("I:${i.negated}(${exprSignature(i.target)}")
        for (v in i.values) {
            sb.append(",")
            sb.append(exprSignature(v))
        }
        if (let Some(sub) <- i.subquery) {
            sb.append(",sub:${selectSignature(sub)}")
        }
        sb.append(")")
        return sb.toString()
    }
    if (e is SubqueryExpr) {
        return "Q:(${selectSignature((e as SubqueryExpr).getOrThrow().select)})"
    }
    if (e is ExistsExpr) {
        let x = (e as ExistsExpr).getOrThrow()
        return "X:${x.negated}(${selectSignature(x.select)})"
    }
    if (e is CaseExpr) {
        let c = (e as CaseExpr).getOrThrow()
        let sb = StringBuilder()
        sb.append("W:(")
        if (let Some(op) <- c.operand) {
            sb.append(exprSignature(op))
        }
        for ((cond, res) in c.whens) {
            sb.append(";${exprSignature(cond)}=>${exprSignature(res)}")
        }
        if (let Some(el) <- c.elseExpr) {
            sb.append(";else=>${exprSignature(el)}")
        }
        sb.append(")")
        return sb.toString()
    }
    if (e is CastExpr) {
        let c = (e as CastExpr).getOrThrow()
        return "A:${c.typeName.toAsciiUpper()}(${exprSignature(c.operand)})"
    }
    if (e is CollateExpr) {
        let c = (e as CollateExpr).getOrThrow()
        return "O:${c.collation.toAsciiUpper()}(${exprSignature(c.operand)})"
    }
    if (e is WindowExpr) {
        let w = (e as WindowExpr).getOrThrow()
        let sb = StringBuilder()
        sb.append("WF:${w.funcExpr.name.toAsciiLower()}:${w.funcExpr.distinct}:${w.funcExpr.starArg}(")
        for (a in w.funcExpr.args) {
            sb.append(exprSignature(a))
            sb.append(",")
        }
        sb.append(")")
        if (let Some(filter) <- w.filter) {
            sb.append(" FILTER(")
            sb.append(exprSignature(filter))
            sb.append(")")
        }
        sb.append(" OVER(")
        for (p in w.spec.partitionBy) {
            sb.append("P:${exprSignature(p)}|")
        }
        for (o in w.spec.orderBy) {
            sb.append("O:${exprSignature(o.expr)}:${o.desc}:${o.nullsFirst}:${o.collation}|")
        }
        sb.append("F:${windowFrameTypeSignature(w.spec.frameType)}:")
        sb.append(windowBoundSignature(w.spec.frameStart))
        sb.append(":")
        sb.append(windowBoundSignature(w.spec.frameEnd))
        sb.append(")")
        return sb.toString()
    }
    if (e is FuncExpr) {
        let f = (e as FuncExpr).getOrThrow()
        let sb = StringBuilder()
        sb.append("F:${f.name.toAsciiLower()}:${f.distinct}:${f.starArg}(")
        for (a in f.args) {
            sb.append(exprSignature(a))
            sb.append(",")
        }
        sb.append(")")
        return sb.toString()
    }
    "?"
}

private func windowFrameTypeSignature(frameType: WindowFrameType): String {
    match (frameType) {
        case FrameRows => "ROWS"
        case FrameRange => "RANGE"
        case FrameGroups => "GROUPS"
    }
}

private func windowBoundSignature(bound: WindowFrameBound): String {
    let prefix = match (bound.kind) {
        case BoundUnboundedPreceding => "UP"
        case BoundPreceding => "P"
        case BoundCurrentRow => "C"
        case BoundFollowing => "F"
        case BoundUnboundedFollowing => "UF"
    }
    match (bound.offset) {
        case Some(offset) => "${prefix}:${exprSignature(offset)}"
        case None => prefix
    }
}

/** SELECT 的签名, 只用于表达式去重, 不求完备。 */
func selectSignature(s: SelectStmt): String {
    let sb = StringBuilder()
    sb.append("sel:${s.distinct}:")
    for (c in s.columns) {
        sb.append(exprSignature(c.expr))
        sb.append("|")
    }
    for (j in s.from) {
        sb.append("from:${j.source.name.toAsciiLower()}:${j.source.alias.toAsciiLower()}|")
        if (let Some(sub) <- j.source.subquery) {
            sb.append(selectSignature(sub))
        }
        if (let Some(on) <- j.on) {
            sb.append("on:${exprSignature(on)}|")
        }
    }
    if (let Some(w) <- s.whereExpr) {
        sb.append("where:${exprSignature(w)}|")
    }
    for (g in s.groupBy) {
        sb.append("grp:${exprSignature(g)}|")
    }
    sb.toString()
}

/** 分组键的字符串形式。存储类要进键 —— 1 与 '1' 不是同一组。 */
func groupKeyString(values: Array<SqliteValue>): String {
    valuePrefixKey(values, values.size)
}

/** 前 width 个值的规范键。DISTINCT 用它跳过隐藏排序键。 */
func valuePrefixKey(values: Array<SqliteValue>, width: Int64): String {
    let sb = StringBuilder()
    for (i in 0..width) {
        sb.append(valueSortKey(values[i]))
        sb.append("\u{1}")
    }
    sb.toString()
}

/** 值的规范键: 类型标记 + 内容。用于分组与 DISTINCT 判重。 */
func valueSortKey(v: SqliteValue): String {
    match (v) {
        case SNull => "0"
        // 整数与浮点在 SQL 里是同一类, 12 与 12.0 属同一分组; 都归一到浮点文本。
        case SInt(i) => "1:${formatReal(Float64(i))}"
        case SReal(f) => "1:${formatReal(f)}"
        case SText(s) => "2:${s}"
        case SBlob(bs) => "3:${bytesToHex(bs)}"
    }
}

/** 按整行判重去掉重复行。保持首次出现的顺序。 */
func distinctRows(rows: ArrayList<Array<SqliteValue>>, visibleCount: Int64): ArrayList<Array<SqliteValue>> {
    let out = ArrayList<Array<SqliteValue>>()
    let seen = HashSet<String>()
    for (row in rows) {
        // 隐藏排序键不参与判重: 算进去会让 `SELECT DISTINCT v … ORDER BY id` 因 id 不同
        // 而留下重复的 v。保留每组第一行, 它带的隐藏键就是该组的排序键 —— 与 SQLite 一致。
        let width = if (visibleCount >= 0 && visibleCount < row.size) {
            visibleCount
        } else {
            row.size
        }
        let key = valuePrefixKey(row, width)
        if (seen.contains(key)) {
            continue
        }
        seen.add(key)
        out.add(row)
    }
    out
}

/*
 * 聚合累加与收尾。
 */
func accumulateInto(ctx: EvalContext, bucket: GroupBucket, aggregates: ArrayList<FuncExpr>): Unit {
    for (agg in aggregates) {
        let key = aggregateKeyOf(ctx, agg)
        match (bucket.states.get(key)) {
            case Some(state) => accumulateOne(ctx, state, agg)
            case None => ()
        }
    }
}

/**
 * 累加一个聚合的一行。
 *
 * count(*) 不求参数 (它对 NULL 也计数), count(x) 跳过 NULL —— 这是两者唯一的区别,
 * 混用会让 count(nullable_col) 变成行数。
 */
func accumulateOne(ctx: EvalContext, state: AggregateState, agg: FuncExpr): Unit {
    if (agg.starArg) {
        state.count += 1
        return
    }
    if (agg.args.isEmpty()) {
        throw SqliteRuntimeException("sql", "wrong number of arguments to function ${agg.name}()")
    }
    let v = evalExpr(ctx, agg.args[0])
    match (v) {
        case SNull => return
        case _ => ()
    }
    if (state.distinct) {
        let key = valueSortKey(v)
        if (state.seen.contains(key)) {
            return
        }
        state.seen.add(key)
    }
    state.count += 1
    match (state.name) {
        case "sum" | "total" | "avg" => accumulateNumeric(state, v)
        case "min" => accumulateExtreme(state, v, false)
        case "max" => accumulateExtreme(state, v, true)
        case "group_concat" =>
            state.texts.add(valueToText(v))
            // 第二参是分隔符, 每行都可以不同; SQLite 用最后一次见到的值。
            if (agg.args.size >= 2) {
                state.separator = valueToText(evalExpr(ctx, agg.args[1]))
            }
        case "count" => ()
        case _ => throw SqliteRuntimeException("sql", "unsupported aggregate function ${state.name}()")
    }
    state.hasValue = true
}

/**
 * sum/avg 的数值累加。
 *
 * 整数累加溢出时切换到浮点并保留已累加的值 —— SQLite 的 sum() 在整数溢出时报错,
 * 但 total() 恒返回浮点。这里统一转浮点继续: 报错会让一条本可给出近似结果的查询失败,
 * 而转浮点与 total() 的语义一致, 且 useFloat 标记会让最终结果类型如实反映这一点。
 */
func accumulateNumeric(state: AggregateState, v: SqliteValue): Unit {
    let n = coerceNumeric(v)
    match (n) {
        case SInt(i) =>
            if (state.useFloat) {
                state.floatSum += Float64(i)
                return
            }
            match (checkedIntArithmetic(state.intSum, i, "+")) {
                case Some(r) => state.intSum = r
                case None =>
                    state.useFloat = true
                    state.floatSum = Float64(state.intSum) + Float64(i)
            }
        case SReal(f) =>
            if (!state.useFloat) {
                state.useFloat = true
                state.floatSum = Float64(state.intSum)
            }
            state.floatSum += f
        case _ => ()
    }
}

/** min/max 的极值累加。跨存储类按 SQLite 的类型序比。 */
func accumulateExtreme(state: AggregateState, v: SqliteValue, wantMax: Bool): Unit {
    if (!state.hasValue) {
        state.minMax = v
        return
    }
    let c = compareValues(v, state.minMax, SqliteCollation.CollBinary)
    if ((wantMax && c > 0) || (!wantMax && c < 0)) {
        state.minMax = v
    }
}

/** 聚合收尾: 无行时 count 为 0, 其他为 NULL。 */
func finalizeAggregate(state: AggregateState): SqliteValue {
    match (state.name) {
        case "count" => SqliteValue.SInt(state.count)
        case "sum" =>
            if (!state.hasValue) {
                SqliteValue.SNull
            } else if (state.useFloat) {
                SqliteValue.SReal(state.floatSum)
            } else {
                SqliteValue.SInt(state.intSum)
            }
        case "total" =>
            // total() 恒返回浮点, 空集给 0.0 而不是 NULL —— 与 sum() 的区别就在这里。
            if (state.useFloat) {
                SqliteValue.SReal(state.floatSum)
            } else {
                SqliteValue.SReal(Float64(state.intSum))
            }
        case "avg" =>
            if (!state.hasValue || state.count == 0) {
                SqliteValue.SNull
            } else {
                let total = if (state.useFloat) {
                    state.floatSum
                } else {
                    Float64(state.intSum)
                }
                SqliteValue.SReal(total / Float64(state.count))
            }
        case "min" | "max" =>
            if (state.hasValue) {
                state.minMax
            } else {
                SqliteValue.SNull
            }
        case "group_concat" =>
            if (!state.hasValue) {
                SqliteValue.SNull
            } else {
                let sb = StringBuilder()
                for (i in 0..state.texts.size) {
                    if (i > 0) {
                        sb.append(state.separator)
                    }
                    sb.append(state.texts[i])
                }
                SqliteValue.SText(sb.toString())
            }
        case _ => SqliteValue.SNull
    }
}

/*
 * 结果列展开。
 */

/** 把 `*` 与 `t.*` 展开成具体列。 */
func expandResultColumns(ctx: EvalContext, stmt: SelectStmt): ArrayList<ResultColumn> {
    let out = ArrayList<ResultColumn>()
    for (rc in stmt.columns) {
        if (!(rc.expr is StarExpr)) {
            out.add(rc)
            continue
        }
        let star = (rc.expr as StarExpr).getOrThrow()
        if (ctx.sources.isEmpty()) {
            throw SqliteRuntimeException("sql", "no tables specified for '*'")
        }
        var matched = false
        for (src in ctx.sources) {
            if (!star.table.isEmpty() && src.name.toAsciiLower() != star.table.toAsciiLower()) {
                continue
            }
            // 伪表不进 `*`: excluded / OLD / NEW 的列会与目标表的重复一遍。
            if (src.qualifiedOnly) {
                continue
            }
            matched = true
            for (i in 0..src.columnNames.size) {
                let name = src.columnNames[i]
                if (star.table.isEmpty() && src.mergedAway.contains(i)) {
                    // USING / NATURAL 合并掉的那一份不进未限定的 `*`: 公共列只出现一次。
                    // 限定的 `t.*` 不受此限 —— SQLite 那条路径给出该表的全部列。
                    continue
                }
                // 限定名展开: 多表 join 时 `*` 展开出的列引用必须带表名, 否则同名列会歧义。
                // 但合并组的存活列要**留成未限定**, 否则读到的是本源的原值而不是 COALESCE ——
                // `a RIGHT JOIN b USING(id)` 的未匹配行里 a.id 是 NULL, 而 id 应当取自 b。
                let merged = ctx.mergeGroups.contains(name.toAsciiLower())
                let qualifier = if (ctx.sources.size > 1 && !merged) {
                    src.name
                } else {
                    ""
                }
                out.add(ResultColumn(ColumnExpr(qualifier, name), name))
            }
        }
        if (!star.table.isEmpty()) {
            for (src in ctx.pseudoSources) {
                if (src.name.toAsciiLower() != star.table.toAsciiLower()) {
                    continue
                }
                matched = true
                for (name in src.columnNames) {
                    out.add(ResultColumn(ColumnExpr(src.name, name), name))
                }
            }
        }
        if (!matched) {
            throw SqliteRuntimeException("sql", "no such table: ${star.table}")
        }
    }
    if (out.isEmpty()) {
        throw SqliteRuntimeException("sql", "a SELECT must have at least one result column")
    }
    out
}

/** 结果列名: 有别名用别名, 列引用用列名, 其余用表达式文本。 */
func resultColumnNames(columns: ArrayList<ResultColumn>): Array<String> {
    let names = Array<String>(columns.size, repeat: "")
    for (i in 0..columns.size) {
        let rc = columns[i]
        names[i] = if (!rc.alias.isEmpty()) {
            rc.alias
        } else if (rc.expr is ColumnExpr) {
            (rc.expr as ColumnExpr).getOrThrow().name
        } else {
            defaultColumnLabel(rc.expr, i)
        }
    }
    names
}

/**
 * 无别名的表达式列的列名。
 *
 * SQLite 在这种情况下的列名"未定义" (取决于版本与是否开启 full_column_names)。这里给
 * 一个确定且可读的名字: 聚合与函数用 `name(args)` 形态, 其余用 `columnN`。
 * 关键是**确定**: 随机名字会让按列名取值的调用方随查询改写而失效。
 */
func defaultColumnLabel(e: Expr, index: Int64): String {
    if (e is WindowExpr) {
        return functionColumnLabel((e as WindowExpr).getOrThrow().funcExpr)
    }
    if (e is FuncExpr) {
        return functionColumnLabel((e as FuncExpr).getOrThrow())
    }
    if (e is LiteralExpr) {
        return renderLiteral((e as LiteralExpr).getOrThrow().value)
    }
    if (e is CastExpr) {
        let c = (e as CastExpr).getOrThrow()
        return "CAST(${shortExprLabel(c.operand)} AS ${c.typeName})"
    }
    "column${index + 1}"
}

private func functionColumnLabel(f: FuncExpr): String {
    let sb = StringBuilder()
    sb.append(f.name.toAsciiLower())
    sb.append("(")
    if (f.starArg) {
        sb.append("*")
    }
    for (i in 0..f.args.size) {
        if (i > 0) {
            sb.append(",")
        }
        sb.append(shortExprLabel(f.args[i]))
    }
    sb.append(")")
    sb.toString()
}

func shortExprLabel(e: Expr): String {
    if (e is ColumnExpr) {
        let c = (e as ColumnExpr).getOrThrow()
        return if (c.table.isEmpty()) {
            c.name
        } else {
            "${c.table}.${c.name}"
        }
    }
    if (e is LiteralExpr) {
        return renderLiteral((e as LiteralExpr).getOrThrow().value)
    }
    if (e is StarExpr) {
        return "*"
    }
    "expr"
}

/*
 * 集合运算。
 */

/**
 * UNION / UNION ALL / INTERSECT / EXCEPT。
 *
 * 列数必须一致; 列名取左侧的 (SQL 标准)。UNION 与 INTERSECT/EXCEPT 都去重, UNION ALL 不去重。
 */
func combineResultSets(left: ResultSet, right: ResultSet, op: SetOp): ResultSet {
    let leftWidth = if (left.rows.isEmpty()) {
        left.columnNames.size
    } else {
        left.rows[0].size
    }
    let rightWidth = if (right.rows.isEmpty()) {
        right.columnNames.size
    } else {
        right.rows[0].size
    }
    if (leftWidth != rightWidth) {
        throw SqliteRuntimeException("sql",
            "SELECTs to the left and right of ${setOpName(op)} do not have the same number of result columns (${leftWidth} vs ${rightWidth})")
    }
    let out = ArrayList<Array<SqliteValue>>()
    match (op) {
        case SetUnionAll =>
            for (r in left.rows) {
                out.add(r)
            }
            for (r in right.rows) {
                out.add(r)
            }
        case SetUnion =>
            for (r in left.rows) {
                out.add(r)
            }
            for (r in right.rows) {
                out.add(r)
            }
            return ResultSet(left.columnNames, distinctRows(out, leftWidth))
        case SetIntersect =>
            let rightKeys = HashSet<String>()
            for (r in right.rows) {
                rightKeys.add(groupKeyString(r))
            }
            for (r in left.rows) {
                if (rightKeys.contains(groupKeyString(r))) {
                    out.add(r)
                }
            }
            return ResultSet(left.columnNames, distinctRows(out, leftWidth))
        case SetExcept =>
            let rightKeys = HashSet<String>()
            for (r in right.rows) {
                rightKeys.add(groupKeyString(r))
            }
            for (r in left.rows) {
                if (!rightKeys.contains(groupKeyString(r))) {
                    out.add(r)
                }
            }
            return ResultSet(left.columnNames, distinctRows(out, leftWidth))
    }
    ResultSet(left.columnNames, out)
}

func setOpName(op: SetOp): String {
    match (op) {
        case SetUnion => "UNION"
        case SetUnionAll => "UNION ALL"
        case SetIntersect => "INTERSECT"
        case SetExcept => "EXCEPT"
    }
}
