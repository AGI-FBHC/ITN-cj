package sqlite_driver

import std.collection.*

/*
 * 连接树: FROM 子句的执行结构。
 *
 * 解析层把括号分组展平成连续的 JoinClause (首个记 groupSpan), 执行层在这里还原成左深树。
 * 必须还原成树，不能简单逐层套循环：
 *
 *   1. RIGHT / FULL 要在左侧整体上补 NULL；左侧可能包含多层，逐层处理只能补最近的一层；
 *   2. 括号分组的连接条件要在跨度**末层**求值, 未匹配时整个跨度一起补 NULL。按层级各自
 *      处理会让条件在还没绑定完的层上求值 (那时分组里后面的表还是上一轮的值)。
 *
 * 树只描述结构, 行数据仍留在 ctx.sources 里按层号索引 —— 于是列引用求值一行都不用改。
 */

/** 一个数据源里某一列的位置。 */
class ColumnRef {
    let srcIndex: Int64
    let colIndex: Int64

    init(srcIndex: Int64, colIndex: Int64) {
        this.srcIndex = srcIndex
        this.colIndex = colIndex
    }
}

/** 连接树的节点: 叶子是一层数据源, 分支是一次连接。 */
class JoinNode {
    /** 叶子的层号; 分支为 -1。 */
    let level: Int64
    /** 叶子对应的 FROM 子句 —— 子查询源要靠它取 SELECT。 */
    let clause: Option<JoinClause>
    let left: Option<JoinNode>
    let right: Option<JoinNode>
    let kind: JoinKind
    let on: Option<Expr>
    /** 公共列: USING 写明的, 或 NATURAL 按列名交集算出的。 */
    let using: Array<String>
    /** 本子树覆盖的层号区间 [lo, hi)。 */
    let lo: Int64
    let hi: Int64

    init(level: Int64, clause: Option<JoinClause>, left: Option<JoinNode>, right: Option<JoinNode>, kind: JoinKind,
        on: Option<Expr>, using: Array<String>, lo: Int64, hi: Int64) {
        this.level = level
        this.clause = clause
        this.left = left
        this.right = right
        this.kind = kind
        this.on = on
        this.using = using
        this.lo = lo
        this.hi = hi
    }

    prop isLeaf: Bool {
        get() {
            level >= 0
        }
    }
}

func joinLeafNode(level: Int64, clause: JoinClause): JoinNode {
    JoinNode(level, Some(clause), None, None, JoinKind.JoinCross, None, Array<String>(), level, level + 1)
}

func joinBranchNode(left: JoinNode, right: JoinNode, kind: JoinKind, on: Option<Expr>, using: Array<String>): JoinNode {
    JoinNode(-1, None, Some(left), Some(right), kind, on, using, left.lo, right.hi)
}

/*
 * 建树。
 */

/**
 * 按 FROM 子句建连接树, 并登记 USING / NATURAL 的列合并。
 *
 * 顶层直接走 buildJoinOperand: 第一个操作数即使是括号分组也不必特殊对待, 因为
 * `(a JOIN b) JOIN c` 与 `a JOIN b JOIN c` 的左深树完全相同 —— groupSpan 只在分组作为
 * **右**操作数时才改变结构。
 */
func buildJoinTree(ctx: EvalContext, stmt: SelectStmt): JoinNode {
    buildJoinOperand(ctx, stmt, 0, stmt.from.size, ArrayList<ColumnRef>())
}

/**
 * 建 [from, to) 这一段的左深子树。
 *
 * visible 收集本段中未被合并的列，供 NATURAL 计算交集和登记合并关系。列按从左到右的顺序
 * 累积，因此公共列保持左侧数据源的列序。
 */
func buildJoinOperand(ctx: EvalContext, stmt: SelectStmt, from: Int64, to: Int64, visible: ArrayList<ColumnRef>): JoinNode {
    var node = joinLeafNode(from, stmt.from[from])
    addSourceColumnRefs(ctx, from, visible)
    var i = from + 1
    while (i < to) {
        let clause = stmt.from[i]
        let span = if (clause.groupSpan < 1) {
            1
        } else {
            clause.groupSpan
        }
        var end = i + span
        if (end > to) {
            end = to
        }
        // 右操作数的列单独收一份: NATURAL 要拿它与左侧求交集, 合并登记也要知道哪些在右侧。
        let rightVisible = ArrayList<ColumnRef>()
        let operand = buildJoinOperand(ctx, stmt, i, end, rightVisible)
        let common = resolveJoinCommonColumns(ctx, clause, visible, rightVisible)
        registerJoinMerges(ctx, common, visible, rightVisible)
        node = joinBranchNode(node, operand, clause.kind, clause.on, common)
        for (ref in rightVisible) {
            if (!ctx.sources[ref.srcIndex].mergedAway.contains(ref.colIndex)) {
                visible.add(ref)
            }
        }
        i = end
    }
    node
}

func addSourceColumnRefs(ctx: EvalContext, level: Int64, into: ArrayList<ColumnRef>): Unit {
    let src = ctx.sources[level]
    for (i in 0..src.columnNames.size) {
        into.add(ColumnRef(level, i))
    }
}

func columnNameOfRef(ctx: EvalContext, ref: ColumnRef): String {
    ctx.sources[ref.srcIndex].columnNames[ref.colIndex]
}

/**
 * 一次连接的公共列名。
 *
 * USING 写明时用它写明的 (两侧都必须真有这个列, 否则报错 —— 拼错的列名若被忽略, 表现是
 * 连接条件少了一条, 结果行数变多而不报错)。NATURAL 时按列名交集算, 顺序取左侧。
 * 两者都没有时返回空 —— 那是 CROSS / 逗号连接或纯 ON 连接。
 */
func resolveJoinCommonColumns(ctx: EvalContext, clause: JoinClause, leftVisible: ArrayList<ColumnRef>,
    rightVisible: ArrayList<ColumnRef>): Array<String> {
    if (!clause.using.isEmpty()) {
        for (name in clause.using) {
            if (!refsContainName(ctx, leftVisible, name)) {
                throw SqliteRuntimeException("sql",
                    "cannot join using column ${name} - column not present in the left-hand tables")
            }
            if (!refsContainName(ctx, rightVisible, name)) {
                throw SqliteRuntimeException("sql",
                    "cannot join using column ${name} - column not present in both tables")
            }
        }
        return clause.using.toArray()
    }
    if (!clause.natural) {
        return Array<String>()
    }
    // NATURAL 没有公共列时退化为笛卡尔积，空清单由 joinPairMatches 按恒真条件处理。
    let out = ArrayList<String>()
    let seen = HashSet<String>()
    for (ref in leftVisible) {
        let name = columnNameOfRef(ctx, ref)
        let lower = name.toAsciiLower()
        if (seen.contains(lower)) {
            continue
        }
        if (refsContainName(ctx, rightVisible, name)) {
            seen.add(lower)
            out.add(name)
        }
    }
    out.toArray()
}

func refsContainName(ctx: EvalContext, refs: ArrayList<ColumnRef>, name: String): Bool {
    let lower = name.toAsciiLower()
    for (ref in refs) {
        if (columnNameOfRef(ctx, ref).toAsciiLower() == lower) {
            return true
        }
    }
    false
}

/**
 * 登记列合并: 公共列在结果里只出现一次, 未限定引用取 COALESCE。
 *
 * `SELECT * FROM a JOIN b USING(id)` 只输出一个 id，未限定名使用 COALESCE(左侧, 右侧)，
 * 因此右连接的未匹配行会取得右侧值。
 *
 * 合并位置沿用左侧列序，右侧列标记为 mergedAway，`*` 展开时跳过。
 */
func registerJoinMerges(ctx: EvalContext, common: Array<String>, leftVisible: ArrayList<ColumnRef>,
    rightVisible: ArrayList<ColumnRef>): Unit {
    for (name in common) {
        let lower = name.toAsciiLower()
        // 已有同名组时追加成员，使多路 USING 连接的 COALESCE 覆盖整条连接链。
        let group = match (ctx.mergeGroups.get(lower)) {
            case Some(g) => g
            case None =>
                let g = ArrayList<ColumnRef>()
                for (ref in leftVisible) {
                    if (columnNameOfRef(ctx, ref).toAsciiLower() == lower) {
                        g.add(ref)
                    }
                }
                ctx.mergeGroups[lower] = g
                g
        }
        for (ref in rightVisible) {
            if (columnNameOfRef(ctx, ref).toAsciiLower() == lower) {
                group.add(ref)
                ctx.sources[ref.srcIndex].mergedAway.add(ref.colIndex)
                // 右侧同名列只合并第一处 —— 后面的仍是独立列 (只能用限定名引用)。
                break
            }
        }
    }
}

/** 合并组的取值: 按登记顺序取第一个非 NULL。 */
func coalesceMergeGroup(ctx: EvalContext, group: ArrayList<ColumnRef>): SqliteValue {
    for (ref in group) {
        let src = ctx.sources[ref.srcIndex]
        if (ref.colIndex < src.values.size) {
            match (src.values[ref.colIndex]) {
                case SNull => ()
                case v => return v
            }
        }
    }
    SqliteValue.SNull
}

/*
 * 迭代。
 */

/**
 * 遍历一棵连接树的所有行组合, 每组调 emit。返回 false 表示调用方应停止 (LIMIT / EXISTS)。
 *
 * 分支节点分两条路:
 *   - INNER / CROSS / LEFT: 右侧流式迭代, 不物化;
 *   - RIGHT / FULL: 右侧必须先物化 —— "这一行从没匹配过"要跨整个外层循环累积, 流式迭代
 *     每轮重新开始就记不住。
 */
func iterateJoinTree(ctx: EvalContext, node: JoinNode, emit: () -> Bool): Bool {
    if (node.isLeaf) {
        let src = ctx.sources[node.level]
        let state = JoinLevelState()
        forEachSourceRow(ctx, node.clause.getOrThrow(), src, node.level) {
            =>
                state.keepGoing = emit()
                state.keepGoing
        }
        return state.keepGoing
    }
    let left = node.left.getOrThrow()
    let right = node.right.getOrThrow()
    let preserveLeft = match (node.kind) {
        case JoinLeft => true
        case JoinFull => true
        case _ => false
    }
    let preserveRight = match (node.kind) {
        case JoinRight => true
        case JoinFull => true
        case _ => false
    }
    if (!preserveRight) {
        return iterateStreamingJoin(ctx, node, left, right, preserveLeft, emit)
    }
    iterateRightPreservingJoin(ctx, node, left, right, preserveLeft, emit)
}

/** INNER / CROSS / LEFT: 嵌套循环, 右侧不物化。 */
func iterateStreamingJoin(ctx: EvalContext, node: JoinNode, left: JoinNode, right: JoinNode, preserveLeft: Bool,
    emit: () -> Bool): Bool {
    iterateJoinTree(ctx, left) {
        =>
            // 每个左行一份状态: anyMatch 是"本左行匹配过吗", 必须逐行重置。
            let inner = JoinLevelState()
            inner.keepGoing = iterateJoinTree(ctx, right) {
                =>
                    if (!joinPairMatches(ctx, node)) {
                        return true
                    }
                    inner.anyMatch = true
                    inner.keepGoing = emit()
                    inner.keepGoing
            }
            if (!inner.keepGoing) {
                return false
            }
            if (preserveLeft && !inner.anyMatch) {
                setSubtreeNull(ctx, right)
                inner.keepGoing = emit()
                clearSubtreeNull(ctx, right)
            }
            inner.keepGoing
    }
}

/**
 * RIGHT / FULL: 右侧物化, 主循环跑完后补从未匹配的右行。
 *
 * 先按左侧顺序输出匹配行和 FULL 的左侧独有行，再在末尾输出右侧独有行。
 */
func iterateRightPreservingJoin(ctx: EvalContext, node: JoinNode, left: JoinNode, right: JoinNode, preserveLeft: Bool,
    emit: () -> Bool): Bool {
    rejectCorrelatedRightOperand(ctx, node, right)
    let rightRows = materializeSubtree(ctx, right)
    let matched = Array<Bool>(rightRows.size, repeat: false)
    let outer = JoinLevelState()
    outer.keepGoing = iterateJoinTree(ctx, left) {
        =>
            let inner = JoinLevelState()
            for (i in 0..rightRows.size) {
                loadSubtreeRow(ctx, right, rightRows[i])
                if (!joinPairMatches(ctx, node)) {
                    continue
                }
                // 匹配过的标记跨外层循环保留 —— 这是物化的唯一理由。
                matched[i] = true
                inner.anyMatch = true
                if (!emit()) {
                    inner.keepGoing = false
                    break
                }
            }
            if (!inner.keepGoing) {
                return false
            }
            if (preserveLeft && !inner.anyMatch) {
                setSubtreeNull(ctx, right)
                inner.keepGoing = emit()
                clearSubtreeNull(ctx, right)
            }
            inner.keepGoing
    }
    if (!outer.keepGoing) {
        return false
    }
    // 补右侧未匹配行: 左侧**整体**为 NULL, 不只是最近的一层。
    setSubtreeNull(ctx, left)
    let tail = JoinLevelState()
    for (i in 0..rightRows.size) {
        if (matched[i]) {
            continue
        }
        loadSubtreeRow(ctx, right, rightRows[i])
        if (!emit()) {
            tail.keepGoing = false
            break
        }
    }
    clearSubtreeNull(ctx, left)
    tail.keepGoing
}

/**
 * 连接条件判定: ON 表达式, 或 USING / NATURAL 的公共列相等。
 *
 * 公共列的左值取合并组里**左子树那部分**的 COALESCE, 而不是"左边最后一个有该列的源":
 * 三路链 `t1 RIGHT JOIN t2 USING(id) RIGHT JOIN t3 USING(id)` 里第二个 USING 要拿 t3.id
 * 与 COALESCE(t1.id, t2.id) 比 —— t1.id 为 NULL 的那些行靠 t2.id 才能匹配上。
 *
 * NULL 不相等，与 `ON x = y` 一致；两个 NULL 不会构成 USING 匹配。
 */
func joinPairMatches(ctx: EvalContext, node: JoinNode): Bool {
    if (let Some(on) <- node.on) {
        return match (valueToTristate(evalExpr(ctx, on))) {
            case Some(true) => true
            case _ => false
        }
    }
    if (node.using.isEmpty()) {
        return true
    }
    let left = node.left.getOrThrow()
    let right = node.right.getOrThrow()
    for (name in node.using) {
        let group = match (ctx.mergeGroups.get(name.toAsciiLower())) {
            case Some(g) => g
            case None => throw SqliteRuntimeException("sql", "internal: join column ${name} has no merge group")
        }
        var leftValue = SqliteValue.SNull
        var rightValue = SqliteValue.SNull
        var haveRight = false
        for (ref in group) {
            let src = ctx.sources[ref.srcIndex]
            let v = src.values[ref.colIndex]
            if (ref.srcIndex >= left.lo && ref.srcIndex < left.hi) {
                if (!haveLeftValue(leftValue)) {
                    leftValue = v
                }
            } else if (ref.srcIndex >= right.lo && ref.srcIndex < right.hi && !haveRight) {
                rightValue = v
                haveRight = true
            }
        }
        let coll = mergeColumnCollation(ctx, group, name)
        match (nullAwareEquals(leftValue, rightValue, coll)) {
            case Some(true) => ()
            case _ => return false
        }
    }
    true
}

func haveLeftValue(v: SqliteValue): Bool {
    match (v) {
        case SNull => false
        case _ => true
    }
}

/** 公共列比较的 collation: 取组里第一个声明了 collation 的列, 左侧优先。 */
func mergeColumnCollation(ctx: EvalContext, group: ArrayList<ColumnRef>, name: String): SqliteCollation {
    for (ref in group) {
        if (let Some(t) <- ctx.sources[ref.srcIndex].table) {
            if (let Some(ci) <- t.columnByName(name)) {
                return ci.collation
            }
        }
    }
    SqliteCollation.CollBinary
}

/*
 * 子树的物化与整体补 NULL。
 */

/** 一个子树在某一行组合上的取值 (覆盖它的每一层)。 */
class SubtreeRow {
    let values: Array<Array<SqliteValue>>
    let rowids: Array<Int64>
    let nullFlags: Array<Bool>

    init(values: Array<Array<SqliteValue>>, rowids: Array<Int64>, nullFlags: Array<Bool>) {
        this.values = values
        this.rowids = rowids
        this.nullFlags = nullFlags
    }
}

/**
 * 把一棵子树的全部行组合物化下来。
 *
 * 物化期间强制全表扫描 (materializing 标记): 索引选择会把 WHERE 里形如
 * `rb.id = ra.id` 的项当成"外层常量"提前求值, 而物化发生在外层循环**之外**, 那时 ra
 * 拿的是上一轮的残值 —— 用它去限定扫描区间会静默漏行。
 */
func materializeSubtree(ctx: EvalContext, node: JoinNode): ArrayList<SubtreeRow> {
    let out = ArrayList<SubtreeRow>()
    let saved = ctx.materializing
    ctx.materializing = true
    try {
        let _ = iterateJoinTree(ctx, node) {
            =>
                out.add(snapshotSubtree(ctx, node))
                true
        }
    } finally {
        ctx.materializing = saved
    }
    out
}

func snapshotSubtree(ctx: EvalContext, node: JoinNode): SubtreeRow {
    let span = node.hi - node.lo
    let values = Array<Array<SqliteValue>>(span, repeat: Array<SqliteValue>())
    let rowids = Array<Int64>(span, repeat: 0)
    let flags = Array<Bool>(span, repeat: false)
    for (i in 0..span) {
        let src = ctx.sources[node.lo + i]
        let copy = Array<SqliteValue>(src.values.size, repeat: SqliteValue.SNull)
        for (j in 0..src.values.size) {
            copy[j] = src.values[j]
        }
        values[i] = copy
        rowids[i] = src.rowid
        flags[i] = src.isNullRow
    }
    SubtreeRow(values, rowids, flags)
}

func loadSubtreeRow(ctx: EvalContext, node: JoinNode, row: SubtreeRow): Unit {
    for (i in 0..(node.hi - node.lo)) {
        let src = ctx.sources[node.lo + i]
        let saved = row.values[i]
        for (j in 0..src.values.size) {
            src.values[j] = if (j < saved.size) {
                saved[j]
            } else {
                SqliteValue.SNull
            }
        }
        src.rowid = row.rowids[i]
        src.isNullRow = row.nullFlags[i]
    }
}

/** 整个子树补 NULL: 外连接未匹配时它覆盖的每一层都要变 NULL。 */
func setSubtreeNull(ctx: EvalContext, node: JoinNode): Unit {
    for (level in node.lo..node.hi) {
        ctx.sources[level].setNullRow()
    }
}

func clearSubtreeNull(ctx: EvalContext, node: JoinNode): Unit {
    for (level in node.lo..node.hi) {
        ctx.sources[level].isNullRow = false
    }
}

/**
 * RIGHT / FULL 的右操作数不得引用左侧的列。
 *
 * 右操作数要在外层循环之外物化一次, 所以它产出的行必须与左侧当前行无关。引用了左侧的话
 * 物化时读到的是残值 —— 那是个静默给错答案的形态, 所以显式报错。
 *
 * 只有分组或子查询作右操作数时才可能出现: 单张表没有自己的连接条件。
 */
func rejectCorrelatedRightOperand(ctx: EvalContext, node: JoinNode, right: JoinNode): Unit {
    let _ = node
    if (right.isLeaf) {
        match (right.clause) {
            case Some(c) => match (c.source.subquery) {
                case Some(sub) => checkNoOutsideRefs(ctx, selectColumnRefs(sub), right, "subquery")
                case None => ()
            }
            case None => ()
        }
        return
    }
    let refs = ArrayList<ColumnExpr>()
    collectRightOperandRefs(ctx, right, refs)
    checkNoOutsideRefs(ctx, refs, right, "parenthesized group")
}

/** 子树内部各连接条件与子查询源里的列引用。 */
func collectRightOperandRefs(ctx: EvalContext, node: JoinNode, into: ArrayList<ColumnExpr>): Unit {
    if (node.isLeaf) {
        if (let Some(c) <- node.clause) {
            if (let Some(sub) <- c.source.subquery) {
                for (r in selectColumnRefs(sub)) {
                    into.add(r)
                }
            }
        }
        return
    }
    if (let Some(on) <- node.on) {
        collectColumnRefsDeep(on, into)
    }
    collectRightOperandRefs(ctx, node.left.getOrThrow(), into)
    collectRightOperandRefs(ctx, node.right.getOrThrow(), into)
}

/**
 * 引用落在子树之外就报错。
 *
 * 限定名按源名判定; 未限定名只在"子树里没有、而子树外有"时才算越界 —— 未限定名先在自己
 * 的作用域里解析, 所以这个判据不会误伤同名列。
 */
func checkNoOutsideRefs(ctx: EvalContext, refs: ArrayList<ColumnExpr>, subtree: JoinNode, what: String): Unit {
    for (c in refs) {
        if (!c.table.isEmpty()) {
            if (sourceLevelByName(ctx, c.table) >= 0 && !inSubtreeByName(ctx, subtree, c.table)) {
                throw SqliteRuntimeException("sql",
                    "the right operand of a RIGHT or FULL JOIN may not reference '${c.table}' " +
                        "from the left-hand side; rewrite that ${what} as a subquery over both tables")
            }
            continue
        }
        if (subtreeHasColumn(ctx, subtree, c.name)) {
            continue
        }
        if (outsideSubtreeHasColumn(ctx, subtree, c.name)) {
            throw SqliteRuntimeException("sql",
                "the right operand of a RIGHT or FULL JOIN may not reference the left-hand " +
                    "column '${c.name}'; rewrite that ${what} as a subquery over both tables")
        }
    }
}

func sourceLevelByName(ctx: EvalContext, name: String): Int64 {
    let lower = name.toAsciiLower()
    for (i in 0..ctx.sources.size) {
        if (ctx.sources[i].name.toAsciiLower() == lower) {
            return i
        }
    }
    -1
}

func inSubtreeByName(ctx: EvalContext, subtree: JoinNode, name: String): Bool {
    let level = sourceLevelByName(ctx, name)
    level >= subtree.lo && level < subtree.hi
}

func subtreeHasColumn(ctx: EvalContext, subtree: JoinNode, colName: String): Bool {
    for (level in subtree.lo..subtree.hi) {
        if (ctx.sources[level].columnIndexOf(colName) >= 0) {
            return true
        }
    }
    false
}

func outsideSubtreeHasColumn(ctx: EvalContext, subtree: JoinNode, colName: String): Bool {
    for (i in 0..ctx.sources.size) {
        if (i >= subtree.lo && i < subtree.hi) {
            continue
        }
        if (ctx.sources[i].columnIndexOf(colName) >= 0) {
            return true
        }
    }
    false
}

/**
 * 表达式里的列引用, **含**子查询内部。
 *
 * 与 childExpressions 的区别正在这里: 那个不下降进子查询 (它是独立作用域, 聚合收集不该
 * 穿过去), 而这里要找的恰恰是"子查询引用了外层" —— 不下降就检查不到。
 */
func collectColumnRefsDeep(e: Expr, into: ArrayList<ColumnExpr>): Unit {
    if (e is ColumnExpr) {
        into.add((e as ColumnExpr).getOrThrow())
        return
    }
    if (e is SubqueryExpr) {
        for (r in selectColumnRefs((e as SubqueryExpr).getOrThrow().select)) {
            into.add(r)
        }
        return
    }
    if (e is ExistsExpr) {
        for (r in selectColumnRefs((e as ExistsExpr).getOrThrow().select)) {
            into.add(r)
        }
        return
    }
    if (e is InExpr) {
        let i = (e as InExpr).getOrThrow()
        if (let Some(sub) <- i.subquery) {
            for (r in selectColumnRefs(sub)) {
                into.add(r)
            }
        }
    }
    for (child in childExpressions(e)) {
        collectColumnRefsDeep(child, into)
    }
}

/** 一条 SELECT 里出现的所有列引用 (递归进它自己的子查询)。 */
func selectColumnRefs(stmt: SelectStmt): ArrayList<ColumnExpr> {
    let out = ArrayList<ColumnExpr>()
    for (c in stmt.columns) {
        collectColumnRefsDeep(c.expr, out)
    }
    for (clause in stmt.from) {
        if (let Some(on) <- clause.on) {
            collectColumnRefsDeep(on, out)
        }
        if (let Some(sub) <- clause.source.subquery) {
            for (r in selectColumnRefs(sub)) {
                out.add(r)
            }
        }
    }
    if (let Some(w) <- stmt.whereExpr) {
        collectColumnRefsDeep(w, out)
    }
    for (g in stmt.groupBy) {
        collectColumnRefsDeep(g, out)
    }
    if (let Some(h) <- stmt.having) {
        collectColumnRefsDeep(h, out)
    }
    for (o in stmt.orderBy) {
        collectColumnRefsDeep(o.expr, out)
    }
    for (row in stmt.valuesRows) {
        for (e in row) {
            collectColumnRefsDeep(e, out)
        }
    }
    if (let Some(r) <- stmt.setRight) {
        for (ref in selectColumnRefs(r)) {
            out.add(ref)
        }
    }
    out
}

/*
 * `*` 展开用的静态列名。
 */

/**
 * 一个 FROM 列表展开 `*` 时可见的列名, 已扣掉 USING / NATURAL 合并掉的那些。
 *
 * 子查询的列名要在它执行**之前**定下 (外层靠它建 RowSource), 那时还没有运行期的合并登记,
 * 所以这里按同一规则在名字上重算一遍。公共列的判定复用 joinCommonColumnNames, 于是两条
 * 路径不会分叉。
 */
func visibleFromColumnNames(ctx: EvalContext, from: ArrayList<JoinClause>): ArrayList<String> {
    let visible = ArrayList<String>()
    var i = 0
    while (i < from.size) {
        let clause = from[i]
        let span = if (clause.groupSpan < 1) {
            1
        } else {
            clause.groupSpan
        }
        var end = i + span
        if (end > from.size) {
            end = from.size
        }
        // 操作数内部先各自展开 (分组里可以再有 USING / NATURAL)。
        let operandNames = ArrayList<String>()
        for (k in i..end) {
            let inner = from[k]
            let names = sourceColumnNames(ctx, inner)
            if (k == i) {
                for (n in names) {
                    operandNames.add(n)
                }
                continue
            }
            let common = joinCommonColumnNames(inner, operandNames, names)
            for (n in mergeNamesInto(operandNames, names, common)) {
                operandNames.add(n)
            }
        }
        if (i == 0) {
            for (n in operandNames) {
                visible.add(n)
            }
            i = end
            continue
        }
        let common = joinCommonColumnNames(clause, visible, operandNames.toArray())
        for (n in mergeNamesInto(visible, operandNames.toArray(), common)) {
            visible.add(n)
        }
        i = end
    }
    visible
}

/** 公共列名判定的纯名字版本, 与 resolveJoinCommonColumns 同规则。 */
func joinCommonColumnNames(clause: JoinClause, leftNames: ArrayList<String>, rightNames: Array<String>): Array<String> {
    if (!clause.using.isEmpty()) {
        return clause.using.toArray()
    }
    if (!clause.natural) {
        return Array<String>()
    }
    let out = ArrayList<String>()
    let seen = HashSet<String>()
    for (name in leftNames) {
        let lower = name.toAsciiLower()
        if (seen.contains(lower) || !namesContain(rightNames, name)) {
            continue
        }
        seen.add(lower)
        out.add(name)
    }
    out.toArray()
}

/** 右侧要追加的列名: 公共列的第一处被合并掉, 其余原样。 */
func mergeNamesInto(leftNames: ArrayList<String>, rightNames: Array<String>, common: Array<String>): ArrayList<String> {
    let _ = leftNames
    let dropped = HashSet<String>()
    let out = ArrayList<String>()
    for (name in rightNames) {
        let lower = name.toAsciiLower()
        if (namesContain(common, name) && !dropped.contains(lower)) {
            dropped.add(lower)
            continue
        }
        out.add(name)
    }
    out
}

func namesContain(names: Array<String>, wanted: String): Bool {
    let lower = wanted.toAsciiLower()
    for (n in names) {
        if (n.toAsciiLower() == lower) {
            return true
        }
    }
    false
}
