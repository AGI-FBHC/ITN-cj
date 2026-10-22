package sqlite_driver

import std.collection.*

/*
 * 公共表表达式 (WITH / WITH RECURSIVE)。
 *
 * CTE 落成"具名的已物化行集": 注册进 EvalContext 后, FROM 里出现该名字时当成一个行源,
 * 与子查询源走同一条迭代路径。选择物化而不是每次引用重跑, 有三个理由:
 *
 *   1. 同一个 CTE 可以在一条语句里被引用多次 (`FROM s, s AS s2`), 重跑会让代价翻倍, 且
 *      带 random() 之类非确定函数时两次引用的值还会不一样;
 *   2. 递归求解本身就要把已产出的行留住 —— 那是下一轮的输入;
 *   3. CTE 可以引用声明列表中靠后的 CTE，因此求解顺序不能只按声明顺序，必须按需触发。
 *
 * 递归求解采用逐行队列：
 *   - 递归项一次只看**一行** (队列语义)。两个递归项时输出序为 1,2,11,3,12 —— 逐轮批处理
 *     会给 1,2,11,3,12 之外的顺序 (先把整轮的 2、11 算完再算 3、12 也是这个序, 但三项以上
 *     或产出多行时就分叉了);
 *   - `UNION` 去重针对**全部已产出行**而不是当前迭代；
 *   - 递归项里只允许**一处**自引用, 多处 SQLite 直接报错;
 *   - CTE 自带的 LIMIT/OFFSET 是停止条件，累计到 offset+limit 行后停止递归。
 */

/**
 * 无界递归的兜底上限 (行数)。
 *
 * 上限用于阻止无界递归耗尽进程内存。超过上限时报告错误而不是截断，避免调用方继续使用
 * 不完整的结果。
 */
const CTE_MAX_ROWS: Int64 = 1000000

/**
 * 一个已注册的 CTE。
 *
 * rows 在第一次被引用时算出并留住。visibleOverride 只在递归求解期间非 None: 那时自引用
 * 看到的是队列里当前那一行, 而不是全部已产出的行。
 */
class MaterializedCte {
    let def: CteDef
    /** 声明它的那一层上下文, 求解 body 时要用它当外层 —— 兄弟 CTE 也在那一层。 */
    let declaredIn: EvalContext
    var columnNames: Array<String> = Array<String>()
    var rows: Option<ArrayList<Array<SqliteValue>>> = None
    /** 正在求解: 非递归 CTE 再次进来说明它间接引用了自己。 */
    var solving: Bool = false
    /** 递归求解期间自引用可见的那一行; 非 None 时优先于 rows。 */
    var visibleOverride: Option<ArrayList<Array<SqliteValue>>> = None
    /** 递归求解期间自引用的次数, 用来拦"多处自引用"。 */
    var selfRefsThisTerm: Int64 = 0

    init(def: CteDef, declaredIn: EvalContext) {
        this.def = def
        this.declaredIn = declaredIn
    }

    /** 当前对外可见的行。 */
    func visibleRows(): ArrayList<Array<SqliteValue>> {
        match (visibleOverride) {
            case Some(r) => r
            case None => match (rows) {
                case Some(r) => r
                case None => ArrayList<Array<SqliteValue>>()
            }
        }
    }
}

/**
 * 把一条语句的 WITH 子句注册进上下文。不求解 —— 求解按需触发。
 *
 * 已经注册过**同一个** CteDef 时跳过: 语句级的 WITH 由 executeStatement 先注册好并经
 * EvalContext 的构造传下来, runSelectInto 再注册一遍会造出第二个 MaterializedCte, 于是
 * 同一个 CTE 被物化两次 —— body 里有 random() 时两次引用给出不同的行。
 *
 * 按 CteDef 的**对象身份**比而不是按名字: 子查询里重新声明的同名 CTE 是另一个定义, 必须
 * 遮蔽外层那个而不是被当成"已注册"跳过。
 */
func registerCtes(ctx: EvalContext, defs: ArrayList<CteDef>): Unit {
    for (def in defs) {
        let key = def.name.toAsciiLower()
        if (let Some(existing) <- ctx.ctes.get(key)) {
            if (existing.def.serial == def.serial) {
                continue
            }
        }
        ctx.ctes[key] = MaterializedCte(def, ctx)
    }
}

/**
 * 确保一个 CTE 已求解, 返回它的行。
 *
 * 求解在**声明它的那一层上下文**的子上下文里进行, 而不是在引用点的上下文里: body 里能看到
 * 的是它的兄弟 CTE 与更外层的东西, 看不到引用点所在查询的数据源。用引用点的上下文会让
 * `SELECT * FROM t, s` 里的 s 意外看到 t 的列 —— 那是关联子查询的语义, CTE 不是。
 */
func solveCte(cte: MaterializedCte, requester: EvalContext): ArrayList<Array<SqliteValue>> {
    if (let Some(r) <- cte.rows) {
        return r
    }
    if (cte.solving) {
        // 非递归路径上再次进来: body 直接或间接引用了自己而又不是 UNION 形态的递归。
        throw SqliteRuntimeException("sql", "circular reference: ${cte.def.name}")
    }
    let body = match (cte.def.body) {
        case Some(b) => b
        case None => throw SqliteRuntimeException("sql", "common table expression ${cte.def.name} has no body")
    }
    cte.solving = true
    try {
        let terms = splitUnionChain(body)
        let recursiveTerms = ArrayList<SelectStmt>()
        let seedTerms = ArrayList<SelectStmt>()
        for (term in terms.terms) {
            if (selectReferencesName(term, cte.def.name)) {
                recursiveTerms.add(term)
            } else {
                seedTerms.add(term)
            }
        }
        if (recursiveTerms.isEmpty()) {
            solveNonRecursiveCte(cte, body)
        } else {
            solveRecursiveCte(cte, requester, body, terms, seedTerms, recursiveTerms)
        }
    } finally {
        cte.solving = false
    }
    match (cte.rows) {
        case Some(r) => r
        case None => ArrayList<Array<SqliteValue>>()
    }
}

/** 普通 CTE: 就是跑一遍那条查询。 */
private func solveNonRecursiveCte(cte: MaterializedCte, body: SelectStmt): Unit {
    let child = cte.declaredIn.childContext()
    let rs = runSelectInto(child, body)
    cte.columnNames = cteColumnNames(cte, rs.columnNames)
    cte.rows = Some(rs.rows)
}

/**
 * 一条 UNION 链拆成各项。
 *
 * `a UNION ALL b UNION ALL c` 在 AST 里是右嵌套的 setOp 链。递归 CTE 要按项分类 (哪些是
 * 种子、哪些自引用), 所以先摊平。同时记下链上用的是 UNION 还是 UNION ALL —— 前者要去重。
 *
 * 最外层的 ORDER BY / LIMIT / OFFSET 属于整个 CTE 而不是某一项, 单独留在 body 上。
 */
class UnionChain {
    let terms = ArrayList<SelectStmt>()
    /** 链上出现过去重形态的 UNION 吗。 */
    var distinctUnion: Bool = false
    /** 链上是否只有 UNION / UNION ALL —— 其他集合运算不能做递归。 */
    var onlyUnions: Bool = true

    init() {}
}

func splitUnionChain(body: SelectStmt): UnionChain {
    let chain = UnionChain()
    var current: Option<SelectStmt> = Some(body)
    while (let Some(stmt) <- current) {
        // 每一项只带自己的 core: 把 setOp 摘掉, 免得递归求解时又把右侧算一遍。
        chain.terms.add(stmt)
        match (stmt.setOp) {
            case None => current = None
            case Some(op) =>
                match (op) {
                    case SetUnionAll => ()
                    case SetUnion => chain.distinctUnion = true
                    case _ => chain.onlyUnions = false
                }
                current = stmt.setRight
        }
    }
    chain
}

/**
 * 递归 CTE 的求解: 逐行队列。
 *
 * 算法保持逐行队列的输出顺序：
 *   1. 全部种子项各跑一遍, 结果按顺序进输出与队列;
 *   2. 从队首取一行, 让自引用只看见这一行, 依次跑每个递归项;
 *   3. 新产出的行 (UNION 时先去重) 追加到输出与队尾;
 *   4. 队列空了就结束。
 *
 * 每次取一行并执行全部递归项，再处理下一行；不能把队列中的全部行作为一轮批量执行。
 */
private func solveRecursiveCte(cte: MaterializedCte, requester: EvalContext, body: SelectStmt, chain: UnionChain,
    seedTerms: ArrayList<SelectStmt>, recursiveTerms: ArrayList<SelectStmt>): Unit {
    if (!chain.onlyUnions) {
        throw SqliteRuntimeException("sql",
            "recursive common table expression ${cte.def.name} may only use UNION or UNION ALL")
    }
    if (seedTerms.isEmpty()) {
        // 没有不自引用的项: 递归永远没有起点。SQLite 报的也是 circular reference。
        throw SqliteRuntimeException("sql", "circular reference: ${cte.def.name}")
    }
    let output = ArrayList<Array<SqliteValue>>()
    let queue = ArrayList<Array<SqliteValue>>()
    let seen = HashSet<String>()
    // 列名先按种子项定下 —— 递归项引用自身时要靠它解析列。
    var named = false
    // CTE 自带的 LIMIT/OFFSET 达到所需行数后停止，可用于终止没有 WHERE 条件的递归。
    let (bodyStopAfter, outputOffset) = recursionBounds(cte, body)
    let outerStopAfter = if (bodyStopAfter < 0) {
        outerRecursionStopCount(cte, requester)
    } else {
        -1
    }
    let stopAfter = if (bodyStopAfter >= 0) {
        bodyStopAfter
    } else {
        outerStopAfter
    }
    // rows 先置成空: 递归项引用自身时会走 visibleRows, 那时还没有 rows。
    cte.rows = Some(output)
    for (term in seedTerms) {
        let child = cte.declaredIn.childContext()
        let rs = runSelectCoreOnly(child, term)
        if (!named) {
            cte.columnNames = cteColumnNames(cte, rs.columnNames)
            named = true
        }
        for (row in rs.rows) {
            if (stopAfter >= 0 && output.size >= stopAfter) {
                break
            }
            if (!admitRecursiveRow(chain, seen, row)) {
                continue
            }
            output.add(row)
            queue.add(row)
            if (stopAfter >= 0 && output.size >= stopAfter) {
                break
            }
        }
        if (stopAfter >= 0 && output.size >= stopAfter) {
            break
        }
    }
    var head = 0
    while (head < queue.size) {
        if (stopAfter >= 0 && output.size >= stopAfter) {
            break
        }
        let current = queue[head]
        head += 1
        for (term in recursiveTerms) {
            let onlyThisRow = ArrayList<Array<SqliteValue>>()
            onlyThisRow.add(current)
            cte.visibleOverride = Some(onlyThisRow)
            cte.selfRefsThisTerm = 0
            let produced = try {
                let child = cte.declaredIn.childContext()
                runSelectCoreOnly(child, term).rows
            } finally {
                cte.visibleOverride = None
            }
            if (cte.selfRefsThisTerm > 1) {
                throw SqliteRuntimeException("sql", "multiple references to recursive table: ${cte.def.name}")
            }
            for (row in produced) {
                if (stopAfter >= 0 && output.size >= stopAfter) {
                    break
                }
                if (!admitRecursiveRow(chain, seen, row)) {
                    continue
                }
                output.add(row)
                queue.add(row)
                if (output.size > CTE_MAX_ROWS) {
                    throw SqliteRuntimeException("sql",
                        "recursive common table expression ${cte.def.name} produced more than " +
                            "${CTE_MAX_ROWS} rows; add a WHERE or LIMIT to bound it")
                }
                if (stopAfter >= 0 && output.size >= stopAfter) {
                    break
                }
            }
            if (stopAfter >= 0 && output.size >= stopAfter) {
                break
            }
        }
    }
    if (!named) {
        cte.columnNames = cteColumnNames(cte, Array<String>())
    }
    // CTE 自己的 OFFSET 参与递归停止, 但不对调用方可见。外层 LIMIT 的 offset 仍由外层执行器裁。
    if (bodyStopAfter >= 0 && outputOffset > 0) {
        let visible = ArrayList<Array<SqliteValue>>()
        for (i in outputOffset..output.size) {
            visible.add(output[i])
        }
        cte.rows = Some(visible)
    }
}

/**
 * 递归的停止行数; -1 表示无。
 *
 * LIMIT 与 OFFSET 都要算进去: OFFSET 那些行也得先产出来才能跳过。参数与表达式在这里求值,
 * 用的是声明层的上下文 —— LIMIT 里写参数占位符是合法的。
 */
private func recursionBounds(cte: MaterializedCte, body: SelectStmt): (Int64, Int64) {
    let limitExpr = match (body.limit) {
        case Some(e) => e
        case None => return (-1, 0)
    }
    let ctx = cte.declaredIn
    let limitValue = evalExpr(ctx, limitExpr)
    let limit = match (limitValue) {
        case SNull => return (-1, 0)
        case _ => valueToInt(coerceNumeric(limitValue))
    }
    if (limit < 0) {
        return (-1, 0)
    }
    var offset = 0
    if (let Some(offsetExpr) <- body.offset) {
        let ov = evalExpr(ctx, offsetExpr)
        offset = match (ov) {
            case SNull => 0
            case _ => valueToInt(coerceNumeric(ov))
        }
        if (offset < 0) {
            offset = 0
        }
    }
    (limit + offset, offset)
}

/**
 * 把外层 LIMIT 下传给一个无界递归 CTE。
 *
 * 只接受“单一 CTE 源、无过滤/聚合/排序/去重、结果列不含子查询”的直读形态。这些条件下前 N
 * 个 CTE 行就是外层所需的全部输入; 任一条件放宽都可能让提前停止改变结果, 宁可回到行数保护报错。
 */
private func outerRecursionStopCount(cte: MaterializedCte, requester: EvalContext): Int64 {
    let stmt = match (requester.currentStatement) {
        case Some(s) => s
        case None => return -1
    }
    if (stmt.from.size != 1 || stmt.distinct || !stmt.groupBy.isEmpty() || !stmt.orderBy.isEmpty()) {
        return -1
    }
    if (let Some(_) <- stmt.whereExpr) {
        return -1
    }
    if (let Some(_) <- stmt.having) {
        return -1
    }
    if (let Some(_) <- stmt.setOp) {
        return -1
    }
    let source = stmt.from[0].source
    if (source.name.toAsciiLower() != cte.def.name.toAsciiLower()) {
        return -1
    }
    if (let Some(_) <- source.subquery) {
        return -1
    }
    if (!collectAggregates(stmt).isEmpty()) {
        return -1
    }
    for (column in stmt.columns) {
        if (exprContainsSubquery(column.expr)) {
            return -1
        }
    }
    let limitExpr = match (stmt.limit) {
        case Some(e) => e
        case None => return -1
    }
    let limitValue = evalExpr(requester, limitExpr)
    let limit = match (limitValue) {
        case SNull => return -1
        case _ => valueToInt(coerceNumeric(limitValue))
    }
    if (limit < 0) {
        return -1
    }
    var offset = 0
    if (let Some(offsetExpr) <- stmt.offset) {
        let offsetValue = evalExpr(requester, offsetExpr)
        offset = match (offsetValue) {
            case SNull => 0
            case _ => valueToInt(coerceNumeric(offsetValue))
        }
        if (offset < 0) {
            offset = 0
        }
    }
    limit + offset
}

private func exprContainsSubquery(expr: Expr): Bool {
    if (expr is SubqueryExpr || expr is ExistsExpr) {
        return true
    }
    if (expr is InExpr) {
        let inExpr = (expr as InExpr).getOrThrow()
        if (let Some(_) <- inExpr.subquery) {
            return true
        }
    }
    for (child in childExpressions(expr)) {
        if (exprContainsSubquery(child)) {
            return true
        }
    }
    false
}

/** UNION 形态要去重; UNION ALL 全收。 */
private func admitRecursiveRow(chain: UnionChain, seen: HashSet<String>, row: Array<SqliteValue>): Bool {
    if (!chain.distinctUnion) {
        return true
    }
    let key = groupKeyString(row)
    if (seen.contains(key)) {
        return false
    }
    seen.add(key)
    true
}

/**
 * 只跑一个 UNION 项的 core, 不跟着它的 setOp 往下走。
 *
 * 直接调 runSelectInto 会把整条链重跑一遍 —— 递归项本来就是从链上摘下来的, 再跟一次会
 * 无限套下去。
 */
private func runSelectCoreOnly(ctx: EvalContext, term: SelectStmt): ResultSet {
    if (!term.valuesRows.isEmpty()) {
        return runValuesRowsOnly(ctx, term)
    }
    let (core, plan) = runSelectCore(ctx, term)
    trimHiddenColumns(core, plan.visibleCount)
}

/** VALUES 项: 只算行, 不管 setOp 与最外层的 ORDER BY/LIMIT。 */
private func runValuesRowsOnly(ctx: EvalContext, term: SelectStmt): ResultSet {
    let rows = ArrayList<Array<SqliteValue>>()
    var width = 0
    for (rowExprs in term.valuesRows) {
        if (width == 0) {
            width = rowExprs.size
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
 * CTE 的列名: 写了别名清单就用它, 否则用 body 的结果列名。
 *
 * 别名个数必须与结果列数相等 —— SQLite 报 "table s has 1 values for 2 columns"。不报的话
 * 多出的列会静默变成 NULL, 少写的列则永远引用不到。
 */
private func cteColumnNames(cte: MaterializedCte, fromBody: Array<String>): Array<String> {
    if (cte.def.columnNames.isEmpty()) {
        return fromBody
    }
    if (cte.def.columnNames.size != fromBody.size) {
        throw SqliteRuntimeException("sql",
            "table ${cte.def.name} has ${fromBody.size} values for ${cte.def.columnNames.size} columns")
    }
    cte.def.columnNames.toArray()
}

/*
 * 自引用探测。
 */

/**
 * 一条查询 (含它的 setOp 链、子查询与表达式里的子查询) 引用了这个名字吗。
 *
 * 用于判断一项是种子项还是递归项。递归 CTE 可以省略 RECURSIVE 关键字，因此必须扫描 AST
 * 中的名称引用，不能只依赖关键字。
 */
func selectReferencesName(stmt: SelectStmt, name: String): Bool {
    let lower = name.toAsciiLower()
    // 内层重新声明了同名 CTE 时, 那一层的引用指向内层, 不算自引用。
    for (inner in stmt.withCtes) {
        if (inner.name.toAsciiLower() == lower) {
            return false
        }
    }
    for (clause in stmt.from) {
        if (clause.source.name.toAsciiLower() == lower) {
            return true
        }
        if (let Some(sub) <- clause.source.subquery) {
            if (selectReferencesName(sub, name)) {
                return true
            }
        }
    }
    for (c in stmt.columns) {
        if (exprReferencesName(c.expr, name)) {
            return true
        }
    }
    if (let Some(w) <- stmt.whereExpr) {
        if (exprReferencesName(w, name)) {
            return true
        }
    }
    for (g in stmt.groupBy) {
        if (exprReferencesName(g, name)) {
            return true
        }
    }
    if (let Some(h) <- stmt.having) {
        if (exprReferencesName(h, name)) {
            return true
        }
    }
    for (o in stmt.orderBy) {
        if (exprReferencesName(o.expr, name)) {
            return true
        }
    }
    for (clause in stmt.from) {
        if (let Some(on) <- clause.on) {
            if (exprReferencesName(on, name)) {
                return true
            }
        }
    }
    false
}

/** 表达式里的子查询是否引用了这个名字。 */
func exprReferencesName(e: Expr, name: String): Bool {
    if (e is SubqueryExpr) {
        return selectReferencesName((e as SubqueryExpr).getOrThrow().select, name)
    }
    if (e is ExistsExpr) {
        return selectReferencesName((e as ExistsExpr).getOrThrow().select, name)
    }
    if (e is InExpr) {
        let ie = (e as InExpr).getOrThrow()
        if (let Some(sub) <- ie.subquery) {
            if (selectReferencesName(sub, name)) {
                return true
            }
        }
    }
    for (child in childExpressions(e)) {
        if (exprReferencesName(child, name)) {
            return true
        }
    }
    false
}
