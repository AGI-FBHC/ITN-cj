package sqlite_driver

import std.collection.*

/*
 * FROM 子句的迭代: 嵌套循环连接。
 *
 * 结构由 exec_join_tree.cj 的连接树描述, 本文件负责"取一个数据源的行"这一层: 全表扫描、
 * 索引区间扫描, 以及子查询与 sqlite_schema 这两种非表数据源。
 *
 * 只实现嵌套循环, 不做哈希连接: 小结果集下两者差别不大, 而正确性上嵌套循环能自然表达
 * 外连接的补 NULL 语义与 ON 条件的求值时机。
 */

/**
 * 遍历 FROM 产生的所有行组合, 每组过 WHERE 后调 emit。
 *
 * emit 返回 false 表示"不要更多行了", 用于 LIMIT 提前收尾与 EXISTS 短路。
 */
func iterateJoinedRows(ctx: EvalContext, stmt: SelectStmt, emit: () -> Bool): Unit {
    if (stmt.from.isEmpty()) {
        // 无 FROM: 只有一"行" (常量行)。WHERE 仍然生效: `SELECT 1 WHERE 0` 是空集。
        if (passesWhere(ctx, stmt)) {
            let _ = emit()
        }
        return
    }
    // 树由 runSelectCore 建好 (列合并的登记要在展开 `*` 之前完成); 直接调本函数的路径
    // 现建一棵。
    let tree = match (ctx.joinTree) {
        case Some(t) => t
        case None => buildJoinTree(ctx, stmt)
    }
    let _ = iterateJoinTree(ctx, tree) {
        => if (passesWhere(ctx, stmt)) {
            emit()
        } else {
            true
        }
    }
}

/**
 * 连接迭代的可变状态。
 *
 * 状态放在对象里而不是局部 var: 仓颉不允许 lambda 捕获可变局部变量 (除非该 lambda 立即
 * 调用), 而这两个状态必须在回调里改、回调返回后读。
 */
class JoinLevelState {
    var anyMatch: Bool = false
    var keepGoing: Bool = true

    init() {}
}

func passesWhere(ctx: EvalContext, stmt: SelectStmt): Bool {
    match (stmt.whereExpr) {
        case None => true
        case Some(w) => match (valueToTristate(evalExpr(ctx, w))) {
            case Some(true) => true
            case _ => false
        }
    }
}

/**
 * 遍历一个数据源的所有行, 每行填进 src 后调 body。
 *
 * 子查询源先物化 —— 它在嵌套循环的内层会被重复遍历, 每次重跑代价太高。物化的行数由子
 * 查询自己决定, 与外层行数无关。
 */
func forEachSourceRow(ctx: EvalContext, clause: JoinClause, src: RowSource, level: Int64, body: () -> Bool): Unit {
    checkStatementControl(ctx.db)
    if (let Some(sub) <- clause.source.subquery) {
        let rows = runSubquery(ctx, sub)
        for (row in rows) {
            for (i in 0..src.values.size) {
                src.values[i] = if (i < row.size) {
                    row[i]
                } else {
                    SqliteValue.SNull
                }
            }
            src.isNullRow = false
            if (!body()) {
                return
            }
        }
        return
    }
    // sqlite_schema 是虚拟视图, 单独走一条路径。
    //
    // 这一支必须排在解 src.table 之前: 模式表自己不在模式里, buildOneSource 给它造的
    // RowSource 的 table 恒为 None。放在后面则永不可达, 而"没有模式信息"那条异常会把
    // 整个内省路径 (SELECT ... FROM sqlite_schema) 变成恒抛。
    if (isSchemaTableName(clause.source.name)) {
        iterateSchemaTable(ctx, src, body)
        return
    }
    // CTE: 已物化, 逐行喂。递归求解期间 visibleRows 给的是队列里当前那一行。
    if (let Some(cte) <- ctx.findCte(clause.source.name)) {
        iterateMaterializedRows(src, cte.visibleRows(), body)
        return
    }
    // 视图: 每次引用重跑它的 SELECT。物化一份会让"视图看到最新数据"这条语义失效 ——
    // 同一条语句里先改后读时必须看到改后的值。
    if (let Some(view) <- ctx.db.currentSchema().findView(clause.source.name)) {
        iterateMaterializedRows(src, runViewBody(ctx, view), body)
        return
    }
    let table = match (src.table) {
        case Some(t) => t
        case None => throw SqliteRuntimeException("sql", "table ${clause.source.name} has no schema information")
    }
    // rowid 路径优先于二级索引: 它直接定位到行, 不需要回表取数据。同一个 WHERE 里
    // 既有 `id = ?` 又有别的索引列约束时, 走 rowid 恒不劣。
    match (planRowidAccess(ctx, table, level)) {
        case Some(rp) =>
            iterateViaRowid(ctx, src, table, rp, body)
            return
        case None => ()
    }
    match (planPrimaryKeyAccess(ctx, table, level)) {
        case Some(pp) =>
            iterateViaPrimaryKey(ctx, src, table, pp, body)
            return
        case None => ()
    }
    match (planTableAccess(ctx, table, level)) {
        case Some(p) => iterateViaIndex(ctx, src, table, p, body)
        case None => iterateFullScan(ctx, src, table, body)
    }
}

func isSchemaTableName(name: String): Bool {
    let lower = name.toAsciiLower()
    lower == SCHEMA_TABLE_NAME || lower == SCHEMA_TABLE_LEGACY_NAME
}

/**
 * 把一批已算好的行逐行喂给 body。CTE 与视图共用。
 *
 * rowid 置 0 而不是行号: 这些源没有 rowid, 给一个假的会让 `SELECT rowid FROM cte` 返回
 * 看着合理却无意义的值。SQLite 对同类源报"no such column: rowid"。
 */
func iterateMaterializedRows(src: RowSource, rows: ArrayList<Array<SqliteValue>>, body: () -> Bool): Unit {
    for (row in rows) {
        for (i in 0..src.values.size) {
            src.values[i] = if (i < row.size) {
                row[i]
            } else {
                SqliteValue.SNull
            }
        }
        src.rowid = 0
        src.isNullRow = false
        if (!body()) {
            return
        }
    }
}

/** 全表扫描。 */
func iterateFullScan(ctx: EvalContext, src: RowSource, table: TableInfo, body: () -> Bool): Unit {
    let cursor = tableCursor(ctx.db.pager, table)
    var ok = cursor.first()
    while (ok) {
        checkStatementControl(ctx.db)
        let locator = currentRowLocator(table, cursor)
        src.values = decodeTableRow(table, cursor)
        src.rowid = locator.rowid
        src.isNullRow = false
        if (!body()) {
            return
        }
        ok = cursor.next()
    }
}

/** sqlite_schema 的行: 由内存里的模式反出来, 与 SQLite 的列顺序一致。 */
func iterateSchemaTable(ctx: EvalContext, src: RowSource, body: () -> Bool): Unit {
    for (row in readSchemaRows(ctx.db.pager)) {
        src.values = [
            SqliteValue.SText(row.objType),
            SqliteValue.SText(row.name),
            SqliteValue.SText(row.tblName),
            SqliteValue.SInt(row.rootPage),
            if (row.sql.isEmpty()) {
                SqliteValue.SNull
            } else {
                SqliteValue.SText(row.sql)
            }
        ]
        src.rowid = row.rowid
        src.isNullRow = false
        if (!body()) {
            return
        }
    }
}

/*
 * 访问路径选择。
 */

/** 一个可用的索引访问计划。 */
class IndexPlan {
    let index: IndexInfo
    /** 相等前缀的键值。 */
    let equalityKey: Array<SqliteValue>
    /** 相等前缀之后的范围下界/上界 (可选)。 */
    let lowerBound: Option<SqliteValue>
    let lowerInclusive: Bool
    let upperBound: Option<SqliteValue>
    let upperInclusive: Bool

    init(index: IndexInfo, equalityKey: Array<SqliteValue>, lowerBound: Option<SqliteValue>, lowerInclusive: Bool,
        upperBound: Option<SqliteValue>, upperInclusive: Bool) {
        this.index = index
        this.equalityKey = equalityKey
        this.lowerBound = lowerBound
        this.lowerInclusive = lowerInclusive
        this.upperBound = upperBound
        this.upperInclusive = upperInclusive
    }
}

/** WHERE 里能用于索引的一个约束。 */
class IndexConstraint {
    let columnIndex: Int64
    /** "=" | ">" | ">=" | "<" | "<=" */
    let op: String
    let value: SqliteValue

    init(columnIndex: Int64, op: String, value: SqliteValue) {
        this.columnIndex = columnIndex
        this.op = op
        this.value = value
    }
}

/** WITHOUT ROWID 表的主键树也复用 IndexPlan 的约束与区间表达。 */
func primaryKeyIndexInfo(table: TableInfo): IndexInfo {
    let spec = table.requireRowKey()
    let names = Array<String>(spec.keyArity, repeat: "")
    for (i in 0..spec.keyArity) {
        names[i] = table.columns[spec.keyColumns[i]].name
    }
    IndexInfo("PRIMARY KEY", table.name, table.rootPage, true, spec.keyColumns, names, spec.keyCollations, spec.keyDescs,
        None, true)
}

/** 主键约束直接定位 WITHOUT ROWID 的表树，不经过二级索引回表。 */
func planPrimaryKeyAccess(ctx: EvalContext, table: TableInfo, level: Int64): Option<IndexPlan> {
    if (!table.withoutRowid || ctx.materializing) {
        return None
    }
    let conditions = collectAccessConditions(ctx, level)
    let constraints = ArrayList<IndexConstraint>()
    for (cond in conditions) {
        collectIndexConstraints(ctx, cond, table, level, constraints)
    }
    if (constraints.isEmpty()) {
        return None
    }
    buildPlanFor(primaryKeyIndexInfo(table), constraints)
}

/**
 * 为一个表源挑索引。
 *
 * 只考虑 WHERE 顶层由 AND 连接的、形如 `col op 常量表达式` 的项, 其中"常量"指不引用本层
 * 及更内层数据源的表达式 (可以引用外层与参数 —— 那在本层循环开始时已确定)。
 *
 * 挑选规则: 相等前缀最长的索引胜出; 平手时取列数少的 (选择性通常更高)。没有可用约束时
 * 返回 None 走全表扫。
 *
 * 部分索引 (带 WHERE 的) 只在其条件被查询条件蕴含时才可用 —— 判定蕴含需要定理证明,
 * 这里保守地完全不用部分索引。用了会漏行, 而漏行是静默的。
 */
func planTableAccess(ctx: EvalContext, table: TableInfo, level: Int64): Option<IndexPlan> {
    if (table.indexes.isEmpty()) {
        return None
    }
    if (ctx.materializing) {
        // 物化发生在外层循环之外, 那时外层源里是上一轮的残值。"外层常量"的判定在这里不成立,
        // 拿残值去限定扫描区间会静默漏行, 所以整个索引选择停掉走全表扫。
        return None
    }
    let conditions = collectAccessConditions(ctx, level)
    if (conditions.isEmpty()) {
        return None
    }
    let constraints = ArrayList<IndexConstraint>()
    for (cond in conditions) {
        collectIndexConstraints(ctx, cond, table, level, constraints)
    }
    if (constraints.isEmpty()) {
        return None
    }
    var best: Option<IndexPlan> = None
    var bestScore = 0
    for (index in table.indexes) {
        if (let Some(_) <- index.whereExpr) {
            continue
        }
        match (buildPlanFor(index, constraints)) {
            case None => ()
            case Some(plan) =>
                let score = planScore(plan)
                if (score > bestScore || (score == bestScore && isNarrowerPlan(plan, best))) {
                    bestScore = score
                    best = Some(plan)
                }
        }
    }
    best
}

/**
 * 收集可用于限定本层扫描范围的条件。
 *
 * WHERE 的顶层 AND 项恒可用; 本层的 ON 条件也可用, 但**外连接的 ON 不行** ——
 * 它不筛掉行, 只决定这一行是否与外层匹配, 拿它限定扫描会把该产出 NULL 行的情形整行丢掉。
 *
 * rowid 路径与索引路径共用这一份: 两者的"哪些条件能用"规则完全相同, 分开写会让其中一份
 * 在将来漏掉这里的外连接判断。
 */
func collectAccessConditions(ctx: EvalContext, level: Int64): ArrayList<Expr> {
    let stmt = ctx.currentStatement
    let conditions = ArrayList<Expr>()
    match (stmt) {
        case Some(s) =>
            if (let Some(w) <- s.whereExpr) {
                flattenAndTerms(w, conditions)
            }
            if (level < s.from.size) {
                let clause = s.from[level]
                let isOuter = match (clause.kind) {
                    case JoinLeft => true
                    case JoinRight => true
                    case JoinFull => true
                    case _ => false
                }
                if (!isOuter) {
                    if (let Some(on) <- clause.on) {
                        flattenAndTerms(on, conditions)
                    }
                }
            }
        case None => ()
    }
    conditions
}

/** 计划的强度: 相等列数 ×2, 有范围界再 +1。 */
func planScore(plan: IndexPlan): Int64 {
    var score = plan.equalityKey.size * 2
    let hasRange = match (plan.lowerBound) {
        case Some(_) => true
        case None => match (plan.upperBound) {
            case Some(_) => true
            case None => false
        }
    }
    if (hasRange) {
        score += 1
    }
    score
}

func isNarrowerPlan(candidate: IndexPlan, current: Option<IndexPlan>): Bool {
    match (current) {
        case None => true
        case Some(c) => candidate.index.columnIndexes.size < c.index.columnIndexes.size
    }
}

/** 把 AND 链拆成扁平的条件列表。OR 不拆 —— 它不能拆成独立可用的约束。 */
func flattenAndTerms(e: Expr, into: ArrayList<Expr>): Unit {
    if (e is BinaryExpr) {
        let b = (e as BinaryExpr).getOrThrow()
        if (b.op == "AND") {
            flattenAndTerms(b.left, into)
            flattenAndTerms(b.right, into)
            return
        }
    }
    into.add(e)
}

/**
 * 从一个条件里抽取索引约束。
 *
 * 支持 `col op value` 与 `value op col` (后者要把比较符反向), 以及 BETWEEN。
 * value 必须在本层循环开始前就可求值 —— 靠 isOuterConstant 判定。
 */
func collectIndexConstraints(ctx: EvalContext, cond: Expr, table: TableInfo, level: Int64,
    into: ArrayList<IndexConstraint>): Unit {
    if (cond is BetweenExpr) {
        let b = (cond as BetweenExpr).getOrThrow()
        if (b.negated) {
            return
        }
        let colIdx = tableColumnIndexOf(ctx, b.target, table, level)
        if (colIdx < 0 || !isOuterConstant(ctx, b.low, level) || !isOuterConstant(ctx, b.high, level)) {
            return
        }
        let aff = table.columns[colIdx].affinity
        into.add(IndexConstraint(colIdx, ">=", applyComparisonAffinity(evalExpr(ctx, b.low), Some(aff))))
        into.add(IndexConstraint(colIdx, "<=", applyComparisonAffinity(evalExpr(ctx, b.high), Some(aff))))
        return
    }
    if (!(cond is BinaryExpr)) {
        return
    }
    let b = (cond as BinaryExpr).getOrThrow()
    if (!isComparisonOp(b.op)) {
        return
    }
    if (b.op == "<>") {
        // 不等式选择性通常很差, 且索引上要扫两个区间。走全表扫更简单也不会更慢。
        return
    }
    var colIdx = tableColumnIndexOf(ctx, b.left, table, level)
    var valueExpr = b.right
    var op = b.op
    if (colIdx < 0) {
        colIdx = tableColumnIndexOf(ctx, b.right, table, level)
        valueExpr = b.left
        op = reverseComparison(b.op)
    }
    if (colIdx < 0 || !isOuterConstant(ctx, valueExpr, level)) {
        return
    }
    let v = evalExpr(ctx, valueExpr)
    match (v) {
        // NULL 比较恒为 NULL, 不选中任何行; 交给通用求值处理。
        case SNull => return
        case _ => ()
    }
    let aff = table.columns[colIdx].affinity
    into.add(IndexConstraint(colIdx, op, applyComparisonAffinity(v, Some(aff))))
}

func reverseComparison(op: String): String {
    match (op) {
        case "<" => ">"
        case "<=" => ">="
        case ">" => "<"
        case ">=" => "<="
        case _ => op
    }
}

/** 表达式是否是本表 (第 level 层源) 的列引用; 是则返回列序号, 否则 -1。 */
func tableColumnIndexOf(ctx: EvalContext, e: Expr, table: TableInfo, level: Int64): Int64 {
    if (!(e is ColumnExpr)) {
        return -1
    }
    if (level >= ctx.sources.size) {
        return -1
    }
    let src = ctx.sources[level]
    let c = (e as ColumnExpr).getOrThrow()
    if (!c.table.isEmpty() && c.table.toAsciiLower() != src.name.toAsciiLower()) {
        return -1
    }
    if (c.table.isEmpty()) {
        // 未限定的列名: 只有在**仅本源**有这个列时才能确定它指本表。
        var matches = 0
        for (s in ctx.sources) {
            if (s.columnIndexOf(c.name) >= 0) {
                matches += 1
            }
        }
        if (matches != 1 || src.columnIndexOf(c.name) < 0) {
            return -1
        }
    }
    table.columnIndexOf(c.name)
}

/**
 * 表达式能否在进入本层循环前求值。
 *
 * 判据是"不引用第 level 层及之后的数据源"。参数与字面量恒可; 外层列引用可 (外层行已定);
 * 子查询一律不可 (关联子查询可能引用本层)。
 */
func isOuterConstant(ctx: EvalContext, e: Expr, level: Int64): Bool {
    if (e is LiteralExpr || e is ParamExpr) {
        return true
    }
    if (e is SubqueryExpr || e is ExistsExpr || e is StarExpr) {
        return false
    }
    if (e is ColumnExpr) {
        let c = (e as ColumnExpr).getOrThrow()
        // 引用了本层或更内层的源 → 不是常量。
        for (i in level..ctx.sources.size) {
            let s = ctx.sources[i]
            if (!c.table.isEmpty()) {
                if (s.name.toAsciiLower() == c.table.toAsciiLower()) {
                    return false
                }
            } else if (s.columnIndexOf(c.name) >= 0) {
                return false
            }
        }
        // 未限定且在本查询的任何源里都找不到 → 是外层列, 可用。
        return true
    }
    if (e is InExpr) {
        let i = (e as InExpr).getOrThrow()
        if (let Some(_) <- i.subquery) {
            return false
        }
    }
    if (e is FuncExpr) {
        let f = (e as FuncExpr).getOrThrow()
        // 非确定性函数不能提到循环外: random() 每行都该给新值。
        if (isNondeterministicFunction(f.name)) {
            return false
        }
        if (isAggregateName(f.name, f.args.size)) {
            return false
        }
    }
    for (child in childExpressions(e)) {
        if (!isOuterConstant(ctx, child, level)) {
            return false
        }
    }
    true
}

func isNondeterministicFunction(name: String): Bool {
    match (name.toAsciiLower()) {
        case "random" | "randomblob" | "last_insert_rowid" | "changes" | "total_changes" => true
        // 无参的日期函数取当前时间, 每次调用可能不同。
        case "date" | "time" | "datetime" | "julianday" | "unixepoch" | "strftime" => true
        case _ => false
    }
}

/**
 * 用一批约束为某个索引造计划。
 *
 * 索引列必须从第一列开始连续被相等约束覆盖; 第一个未被相等覆盖的列可以吃范围约束。
 * 这是 B-tree 索引的固有限制: 跳过前缀列后, 键在树里不再连续。
 */
func buildPlanFor(index: IndexInfo, constraints: ArrayList<IndexConstraint>): Option<IndexPlan> {
    let equality = ArrayList<SqliteValue>()
    var pos = 0
    while (pos < index.columnIndexes.size) {
        let col = index.columnIndexes[pos]
        var found: Option<SqliteValue> = None
        for (c in constraints) {
            if (c.columnIndex == col && c.op == "=") {
                found = Some(c.value)
                break
            }
        }
        match (found) {
            case Some(v) =>
                equality.add(v)
                pos += 1
            case None => break
        }
    }
    var lower: Option<SqliteValue> = None
    var lowerInc = false
    var upper: Option<SqliteValue> = None
    var upperInc = false
    if (pos < index.columnIndexes.size) {
        let col = index.columnIndexes[pos]
        for (c in constraints) {
            if (c.columnIndex != col) {
                continue
            }
            match (c.op) {
                case ">" | ">=" =>
                    let better = match (lower) {
                        case None => true
                        // 多个下界取最紧的。
                        case Some(cur) => compareValues(c.value, cur, index.collations[pos]) > 0
                    }
                    if (better) {
                        lower = Some(c.value)
                        lowerInc = c.op == ">="
                    }
                case "<" | "<=" =>
                    let better = match (upper) {
                        case None => true
                        case Some(cur) => compareValues(c.value, cur, index.collations[pos]) < 0
                    }
                    if (better) {
                        upper = Some(c.value)
                        upperInc = c.op == "<="
                    }
                case _ => ()
            }
        }
    }
    if (equality.isEmpty()) {
        match ((lower, upper)) {
            case (None, None) => return None
            case _ => ()
        }
    }
    Some(IndexPlan(index, equality.toArray(), lower, lowerInc, upper, upperInc))
}

/**
 * 沿索引扫描, 逐行取回表数据。
 *
 * 索引键的最后一项是 rowid (建索引时附加的), 用它回表。DESC 索引的键序是反的, 但
 * compareIndexKeys 已按 descs 取反, 所以扫描方向仍是"从小到大"的逻辑序。
 */
func iterateViaIndex(ctx: EvalContext, src: RowSource, table: TableInfo, plan: IndexPlan, body: () -> Bool): Unit {
    let index = plan.index
    let pager = ctx.db.pager
    let cursor = BtreeCursor(pager, index.rootPage, false)
    // 起点键: 相等前缀 + 下界 (若有)。
    let startKey = ArrayList<SqliteValue>()
    for (v in plan.equalityKey) {
        startKey.add(v)
    }
    if (let Some(lo) <- plan.lowerBound) {
        startKey.add(lo)
    }
    let keyColumnCount = indexStoredColumnCount(table, index)
    let (colls, descs) = indexKeyMeta(table, index)
    var positioned = if (startKey.isEmpty()) {
        cursor.first()
    } else {
        let _ = cursor.seekIndex(startKey.toArray(), colls, descs)
        cursor.isValid
    }
    while (positioned) {
        checkStatementControl(ctx.db)
        let key = decodeRecord(cursor.currentPayload(), keyColumnCount)
        if (!indexKeyStillInRange(key, plan, colls)) {
            return
        }
        if (!indexKeyPassesLowerBound(key, plan, colls)) {
            // 下界是排他的 (`>`) 且这一条正好等于下界: 跳过, 继续下一条。
            positioned = cursor.next()
            continue
        }
        let locator = locatorFromIndexKey(table, index, key)
        let entryCursor = tableCursor(pager, table)
        if (!seekTableRow(entryCursor, table, locator)) {
            // 索引指向不存在的行: 索引与表不一致。报错而不是跳过 —— 跳过会让查询静默漏行。
            throw SqliteFormatException("index '${index.name}' references a missing row in table '${table.name}'")
        }
        src.values = decodeTableRow(table, entryCursor)
        src.rowid = locator.rowid
        src.isNullRow = false
        if (!body()) {
            return
        }
        positioned = cursor.next()
    }
}

/** 直接沿 WITHOUT ROWID 表的主键树扫描。 */
func iterateViaPrimaryKey(ctx: EvalContext, src: RowSource, table: TableInfo, plan: IndexPlan, body: () -> Bool): Unit {
    let spec = table.requireRowKey()
    let cursor = tableCursor(ctx.db.pager, table)
    let startKey = ArrayList<SqliteValue>()
    for (v in plan.equalityKey) {
        startKey.add(v)
    }
    if (let Some(lo) <- plan.lowerBound) {
        startKey.add(lo)
    }
    var positioned = if (startKey.isEmpty()) {
        cursor.first()
    } else {
        let _ = cursor.seekIndex(startKey.toArray(), spec.keyCollations, spec.keyDescs)
        cursor.isValid
    }
    while (positioned) {
        checkStatementControl(ctx.db)
        let key = decodeRecord(cursor.currentPayload(), spec.keyArity)
        if (!indexKeyStillInRange(key, plan, spec.keyCollations)) {
            return
        }
        if (!indexKeyPassesLowerBound(key, plan, spec.keyCollations)) {
            positioned = cursor.next()
            continue
        }
        src.values = decodeTableRow(table, cursor)
        src.rowid = 0
        src.isNullRow = false
        if (!body()) {
            return
        }
        positioned = cursor.next()
    }
}

/** 键是否仍在计划的区间内 (相等前缀未变且未越过上界)。 */
func indexKeyStillInRange(key: Array<SqliteValue>, plan: IndexPlan, colls: Array<SqliteCollation>): Bool {
    let eqCount = plan.equalityKey.size
    for (i in 0..eqCount) {
        if (i >= key.size) {
            return false
        }
        if (compareValues(key[i], plan.equalityKey[i], colls[i]) != CMP_EQ) {
            return false
        }
    }
    if (let Some(hi) <- plan.upperBound) {
        if (eqCount >= key.size) {
            return false
        }
        let c = compareValues(key[eqCount], hi, colls[eqCount])
        if (c > 0 || (c == 0 && !plan.upperInclusive)) {
            return false
        }
    }
    true
}

/** 排他下界的补充判定: seekIndex 停在 >= lo 的位置, `>` 需要再跳过等于 lo 的那些。 */
func indexKeyPassesLowerBound(key: Array<SqliteValue>, plan: IndexPlan, colls: Array<SqliteCollation>): Bool {
    if (plan.lowerInclusive) {
        return true
    }
    match (plan.lowerBound) {
        case None => true
        case Some(lo) =>
            let at = plan.equalityKey.size
            if (at >= key.size) {
                return true
            }
            compareValues(key[at], lo, colls[at]) != CMP_EQ
    }
}

/*
 * 数据源构造。
 */

/** 按 FROM 子句造数据源列表 (还没填值)。 */
func buildSources(ctx: EvalContext, stmt: SelectStmt): ArrayList<RowSource> {
    let out = ArrayList<RowSource>()
    for (clause in stmt.from) {
        out.add(buildOneSource(ctx, clause))
    }
    // 同名源检查: `FROM t, t` 会让所有列引用歧义。要求写别名。
    for (i in 0..out.size) {
        for (j in (i + 1)..out.size) {
            if (out[i].name.toAsciiLower() == out[j].name.toAsciiLower()) {
                throw SqliteRuntimeException("sql",
                    "table name '${out[i].name}' appears more than once in FROM; use an alias to tell them apart")
            }
        }
    }
    out
}

func buildOneSource(ctx: EvalContext, clause: JoinClause): RowSource {
    let ref = clause.source
    if (let Some(sub) <- ref.subquery) {
        // 别名可以不写: SQLite 接受 `SELECT * FROM (SELECT v FROM t)`。无别名时源名为空,
        // 于是它的列只能用未限定名引用 —— 与 SQLite 一致 (没有名字可限定)。
        let names = subqueryColumnNames(ctx, sub)
        return RowSource(ref.effectiveName, names, None)
    }
    if (isSchemaTableName(ref.name)) {
        let names: Array<String> = ["type", "name", "tbl_name", "rootpage", "sql"]
        return RowSource(ref.effectiveName, names, None)
    }
    // CTE 遮蔽同名真实表，因此名称解析先检查当前作用域中的 CTE。
    if (let Some(cte) <- ctx.findCte(ref.name)) {
        let _ = solveCte(cte, ctx)
        if (let Some(_) <- cte.visibleOverride) {
            // 递归求解期间的自引用: 计数供"多处自引用"判定用。
            cte.selfRefsThisTerm += 1
        }
        return RowSource(ref.effectiveName, cte.columnNames, None)
    }
    // 视图: 展开成子查询。rootpage 为 0, 没有自己的 B-tree, 所以不能走下面的表路径。
    if (let Some(view) <- ctx.db.currentSchema().findView(ref.name)) {
        return RowSource(ref.effectiveName, viewColumnNames(ctx, view), None)
    }
    let table = match (ctx.db.currentSchema().findTable(ref.name)) {
        case Some(t) => t
        case None => throw SqliteRuntimeException("sql", "no such table: ${ref.name}")
    }
    let names = Array<String>(table.columns.size, repeat: "")
    for (i in 0..table.columns.size) {
        names[i] = table.columns[i].name
    }
    RowSource(ref.effectiveName, names, Some(table))
}

/**
 * 推子查询的结果列名。
 *
 * 带 `*` 时要递归展开它自己的 FROM —— 否则外层引用不到列。这里只处理一层 `*`:
 * 嵌套子查询的 `*` 会递归到底。
 */
func subqueryColumnNames(ctx: EvalContext, sub: SelectStmt): Array<String> {
    if (!sub.valuesRows.isEmpty()) {
        let width = if (sub.valuesRows.isEmpty()) {
            0
        } else {
            sub.valuesRows[0].size
        }
        let names = Array<String>(width, repeat: "")
        for (i in 0..width) {
            names[i] = "column${i + 1}"
        }
        return names
    }
    let out = ArrayList<String>()
    for (i in 0..sub.columns.size) {
        let rc = sub.columns[i]
        if (rc.expr is StarExpr) {
            let star = (rc.expr as StarExpr).getOrThrow()
            if (star.table.isEmpty()) {
                // 未限定的 `*`: 要扣掉 USING / NATURAL 合并掉的列, 否则外层按列数建的
                // RowSource 会比子查询实际给出的行宽多几列。
                for (n in visibleFromColumnNames(ctx, sub.from)) {
                    out.add(n)
                }
                continue
            }
            for (clause in sub.from) {
                if (clause.source.effectiveName.toAsciiLower() != star.table.toAsciiLower()) {
                    continue
                }
                // 限定的 `t.*` 给出该源的全部列, 合并列也在内 —— 与 SQLite 一致
                // (`SELECT a.id, b.id FROM a JOIN b USING(id)` 两列都给)。
                for (n in sourceColumnNames(ctx, clause)) {
                    out.add(n)
                }
            }
            continue
        }
        out.add(if (!rc.alias.isEmpty()) {
            rc.alias
        } else if (rc.expr is ColumnExpr) {
            (rc.expr as ColumnExpr).getOrThrow().name
        } else {
            defaultColumnLabel(rc.expr, i)
        })
    }
    out.toArray()
}

func sourceColumnNames(ctx: EvalContext, clause: JoinClause): Array<String> {
    if (let Some(inner) <- clause.source.subquery) {
        return subqueryColumnNames(ctx, inner)
    }
    if (isSchemaTableName(clause.source.name)) {
        return ["type", "name", "tbl_name", "rootpage", "sql"]
    }
    // 与 buildOneSource 同序: CTE 遮蔽视图与表, 视图遮蔽不存在的表。两处顺序不一致会让
    // `*` 展开出的列名与实际取到的值来自不同的源。
    if (let Some(cte) <- ctx.findCte(clause.source.name)) {
        let _ = solveCte(cte, ctx)
        return cte.columnNames
    }
    if (let Some(view) <- ctx.db.currentSchema().findView(clause.source.name)) {
        return viewColumnNames(ctx, view)
    }
    match (ctx.db.currentSchema().findTable(clause.source.name)) {
        case Some(t) =>
            let names = Array<String>(t.columns.size, repeat: "")
            for (i in 0..t.columns.size) {
                names[i] = t.columns[i].name
            }
            names
        case None => throw SqliteRuntimeException("sql", "no such table: ${clause.source.name}")
    }
}
