package sqlite_driver

import std.collection.*

/*
 * 触发器的触发。
 *
 * 触发点在三条 DML 的行级循环里: BEFORE 在写之前、AFTER 在写之后、INSTEAD OF 取代写本身。
 * body 里的语句走 executeStatement 递归回引擎, 于是嵌套的 DML 又能触发别的触发器。
 *
 * OLD / NEW 是两张伪表, 复用 upsert 的 `excluded` 那套机制 (RowSource.qualifiedOnly): 它们与
 * 目标表的列名完全重合, 未限定的列名必须解析到别处, 否则 `SET v = v` 会被判成歧义。
 *
 * 触发器执行需要保持以下语义：
 *
 *   1. BEFORE 在行写入前执行，AFTER 在行写入后执行，因此两者读取目标表时看到的状态不同；
 *   2. BEFORE 触发器对目标行的改动必须保留，主写入需要在触发后重新读取该行；
 *   3. `PRAGMA recursive_triggers` 默认关闭，同一个触发器不能重入；启用后可继续递归到 WHEN
 *      条件为假或达到深度上限。
 */

/** SQLite 的触发器递归深度上限。 */
const TRIGGER_MAX_DEPTH: Int64 = 1000

/**
 * `RAISE(IGNORE)` 的信号。
 *
 * 做成异常而不是返回值: 它要从 body 里某条语句的深处一路穿回 DML 的行级循环, 而中间隔着
 * executeStatement / 表达式求值好几层。用返回值就得让每一层都转发它, 漏一层就变成"静默
 * 当成功", 那正是 IGNORE 与 ABORT 最容易混掉的地方。
 *
 * 不继承通用异常基类: 它不是错误, 调用方 catch (e: Exception) 的常规写法不该吞掉它 ——
 * 恰恰相反, DML 循环必须显式认出它。这里仍继承 Exception (仓颉要求可抛类型), 但类型名
 * 独立, 于是 catch 的目标很明确。
 */
class TriggerIgnoreSignal <: Exception {
    init() {
        super("RAISE(IGNORE)")
    }
}

/**
 * `RAISE(ROLLBACK)` 的信号。
 *
 * 与 ABORT 的区别是它要回滚**整个事务**而不只是当前语句。带着原消息往上抛, 由语句边界处
 * 的收尾把事务回滚掉。
 */
class TriggerRollbackSignal <: Exception {
    let reason: String

    init(reason: String) {
        super(reason)
        this.reason = reason
    }
}

/**
 * 一次触发的行上下文。
 *
 * oldValues / newValues 任一为 None 表示那张伪表在本事件里不存在 (INSERT 没有 OLD,
 * DELETE 没有 NEW)。引用不存在的那一张要报错而不是给 NULL —— 给 NULL 会让
 * `AFTER INSERT … OLD.id` 静默算出 NULL 而不是指出写错了。
 */
class TriggerRowContext {
    let table: TableInfo
    let oldValues: Option<Array<SqliteValue>>
    let oldRowid: Int64
    let newValues: Option<Array<SqliteValue>>
    let newRowid: Int64

    init(table: TableInfo, oldValues: Option<Array<SqliteValue>>, oldRowid: Int64,
        newValues: Option<Array<SqliteValue>>, newRowid: Int64) {
        this.table = table
        this.oldValues = oldValues
        this.oldRowid = oldRowid
        this.newValues = newValues
        this.newRowid = newRowid
    }
}

/**
 * 触发某个时机与事件上的全部触发器。
 *
 * 返回 false 表示 `RAISE(IGNORE)` 要求跳过这一行 —— 调用方据此决定不写 (BEFORE) 或
 * 不算进受影响行数。
 *
 * updated 是本次 UPDATE 改到的列名 (小写), 供 `UPDATE OF` 过滤; 其他事件传空集合。
 */
func fireTriggers(db: SqliteDatabase, target: String, timing: String, event: String, updated: HashSet<String>,
    row: TriggerRowContext, params: Array<SqliteValue>): Bool {
    let triggers = db.currentSchema().triggersFor(target, timing, event, updated)
    if (triggers.isEmpty()) {
        return true
    }
    for (tr in triggers) {
        if (!runOneTrigger(db, tr, row, params)) {
            return false
        }
    }
    true
}

/**
 * 跑一个触发器: 判 WHEN, 然后依次执行 body。
 *
 * 深度管理放在这里而不是 fireTriggers: 同一时机上的多个触发器是**并列**的, 不该各自加深
 * 一层。深度只在"body 里的语句又触发了别的触发器"时增长。
 */
private func runOneTrigger(db: SqliteDatabase, tr: TriggerInfo, row: TriggerRowContext, params: Array<SqliteValue>): Bool {
    // 递归关闭时仍允许第一层触发器执行，但阻止执行栈中的同名触发器再次进入。
    if (!db.recursiveTriggers && db.activeTriggers.contains(tr.name.toAsciiLower())) {
        return true
    }
    if (db.triggerDepth >= TRIGGER_MAX_DEPTH) {
        throw SqliteRuntimeException("sql",
            "too many levels of trigger recursion (limit ${TRIGGER_MAX_DEPTH}); " +
                "trigger ${tr.name} on ${tr.tableName}")
    }
    let ctx = triggerContext(db, tr, row, params)
    if (let Some(w) <- tr.whenExpr) {
        match (valueToTristate(evalExpr(ctx, w))) {
            case Some(true) => ()
            case _ => return true
        }
    }
    db.triggerDepth += 1
    db.activeTriggers.add(tr.name.toAsciiLower())
    try {
        for (stmt in tr.body) {
            if (!runTriggerBodyStatement(db, stmt, row, params)) {
                return false
            }
        }
    } finally {
        db.triggerDepth -= 1
        db.activeTriggers.remove(tr.name.toAsciiLower())
    }
    true
}

/**
 * 执行 body 里的一条语句。
 *
 * 返回 false 表示 `RAISE(IGNORE)`。SELECT 的结果集丢掉 —— body 里的 SELECT 唯一的用处是
 * `SELECT RAISE(…)`。
 *
 * OLD / NEW 经 db.triggerRow 传给 body 里的语句: body 的语句各自新建 EvalContext (它们走的是
 * 正常的 executeStatement 路径), 而 OLD/NEW 必须在那些上下文里也可见。与语句级 CTE 同一个
 * 办法 —— 挂在 db 上, 由 EvalContext 的构造取。
 */
private func runTriggerBodyStatement(db: SqliteDatabase, stmt: Stmt, row: TriggerRowContext, params: Array<SqliteValue>): Bool {
    let saved = db.triggerRow
    db.triggerRow = Some(row)
    try {
        let _ = executeStatement(db, stmt, params)
    } catch (_: TriggerIgnoreSignal) {
        // body 里的 RAISE(IGNORE): 跳过外层那一行, 但 body 剩下的语句也不再执行。
        return false
    } finally {
        db.triggerRow = saved
    }
    true
}

/**
 * 往上下文里加 OLD / NEW 两张伪表。
 *
 * 两张伪表都标记为 qualifiedOnly，因为它们与目标表的列名完全重合。未限定的列名不能解析到
 * OLD 或 NEW，否则 body 中的 `SET v = v` 会被错误地判为歧义。
 *
 * 抽成函数供两处调用: WHEN 的求值上下文 (triggerContext) 与 body 里各语句自建的上下文
 * (EvalContext 的构造)。两处各写一遍时, 漏掉 qualifiedOnly 的那一处会让歧义只在某些语句上
 * 出现, 极难对上原因。
 */
func addTriggerPseudoSources(ctx: EvalContext, row: TriggerRowContext): Unit {
    let names = Array<String>(row.table.columns.size, repeat: "")
    for (i in 0..row.table.columns.size) {
        names[i] = row.table.columns[i].name
    }
    if (let Some(vals) <- row.oldValues) {
        let src = RowSource("old", names, Some(row.table))
        src.values = vals
        src.rowid = row.oldRowid
        src.qualifiedOnly = true
        ctx.addPseudoSource(src)
    }
    if (let Some(vals) <- row.newValues) {
        let src = RowSource("new", names, Some(row.table))
        src.values = vals
        src.rowid = row.newRowid
        src.qualifiedOnly = true
        ctx.addPseudoSource(src)
    }
}

/** 造一个带 OLD / NEW 的求值上下文, 供 WHEN 求值。 */
func triggerContext(db: SqliteDatabase, tr: TriggerInfo, row: TriggerRowContext, params: Array<SqliteValue>): EvalContext {
    let _ = tr
    // 递归触发时 db.triggerRow 仍是上一层的行。构造上下文前临时换成本层, 否则 WHEN 会
    // 落后一层读取 OLD/NEW, 使停止条件多执行一次。
    let saved = db.triggerRow
    db.triggerRow = Some(row)
    try {
        EvalContext(db, params)
    } finally {
        db.triggerRow = saved
    }
}

/**
 * `RAISE(…)` 的求值。
 *
 * 四种处置分三条路:
 *   - ABORT / FAIL: 抛约束异常。两者在 SQLite 里的区别是 ABORT 撤销本语句已做的改动而
 *     FAIL 不撤销; 本驱动的语句级回滚对两者一致 (隐式事务出错整条回滚), 所以落地相同,
 *     但异常消息保留各自的措辞;
 *   - IGNORE: 抛 TriggerIgnoreSignal, 由 DML 的行级循环认出来并跳过该行;
 *   - ROLLBACK: 抛 TriggerRollbackSignal, 由语句边界回滚整个事务。
 */
func evalRaise(ctx: EvalContext, e: RaiseExpr): SqliteValue {
    let _ = ctx
    // 用 if 链而不是 match: 仓颉的 `case SOME_CONST` 是**变量绑定模式**而不是值比较, 于是
    // 第一个 case 会吞掉一切分支 —— 那会让每个 RAISE 都变成 IGNORE, 而 ABORT 的用例照样
    // "通过"(行确实没插进去), 只是原因完全不对。
    if (e.action == RAISE_IGNORE) {
        throw TriggerIgnoreSignal()
    }
    if (e.action == RAISE_ROLLBACK) {
        throw TriggerRollbackSignal(e.message)
    }
    throw SqliteConstraintException("trigger", "", e.message)
}

/*
 * 视图的 INSTEAD OF 写入。
 */

/**
 * 用 INSTEAD OF 触发器代替对视图的写。
 *
 * 返回值是触发 INSTEAD OF 的行数，而不是 body 中语句修改的行数。`changes()` 采用相同口径。
 *
 * INSERT 只有 NEW; UPDATE / DELETE 要先跑视图的 SELECT 拿到 OLD 行 —— 视图没有 rowid,
 * 所以 OLD 的每一列都来自那一趟查询的结果。
 */
func execInsteadOfWrite(db: SqliteDatabase, view: ViewInfo, event: String, stmt: Stmt, params: Array<SqliteValue>): Int64 {
    let pseudo = viewPseudoTable(db, view, params)
    // if 链而不是 match: 见 evalRaise 的注释 —— `case CONST` 是绑定模式, 不是值比较。
    if (event == TRIGGER_EVENT_INSERT) {
        return insteadOfInsert(db, view, pseudo, stmt, params)
    }
    if (event == TRIGGER_EVENT_UPDATE) {
        return insteadOfUpdate(db, view, pseudo, stmt, params)
    }
    insteadOfDelete(db, view, pseudo, stmt, params)
}

/**
 * 给视图造一份"伪 TableInfo"。
 *
 * OLD / NEW 是按列名索引的行源, 而 RowSource 要一份 TableInfo 才能做亲和性与 rowid 关键字。
 * 视图没有真表信息, 所以按它的列名造一份全无约束的 —— 亲和性取 BLOB (即"不转换"), 于是
 * 值原样穿过, 与 SQLite 对视图列不施加亲和性一致。
 */
func viewPseudoTable(db: SqliteDatabase, view: ViewInfo, params: Array<SqliteValue>): TableInfo {
    let ctx = EvalContext(db, params)
    let names = viewColumnNames(ctx, view)
    let cols = ArrayList<ColumnInfo>()
    for (i in 0..names.size) {
        // 声明类型留空: affinityOf("") 给的是 BLOB 亲和性, 即"不转换" —— 视图的列没有声明
        // 类型, 值应当原样穿过。ColumnInfo 自己按声明类型算亲和性, 所以不能直接传。
        cols.add(ColumnInfo(names[i], "", false, SqliteCollation.CollBinary, None, None, false, i, false))
    }
    TableInfo(view.name, 0, cols.toArray(), view.sql, -1, false, Array<Int64>(), Array<Expr>(), Array<ForeignKeyInfo>())
}

/** INSTEAD OF INSERT: NEW 由 VALUES / SELECT 求出, 每一行触发一次。 */
private func insteadOfInsert(db: SqliteDatabase, view: ViewInfo, pseudo: TableInfo, stmt: Stmt,
    params: Array<SqliteValue>): Int64 {
    let insert = match (stmt as InsertStmt) {
        case Some(s) => s
        case None => throw SqliteRuntimeException("sql", "expected an INSERT statement for a view")
    }
    let rows = insteadOfInsertRows(db, view, pseudo, insert, params)
    var affected = 0
    for (values in rows) {
        let row = TriggerRowContext(pseudo, None, 0, Some(values), 0)
        if (fireTriggers(db, view.name, TRIGGER_TIMING_INSTEAD_OF, TRIGGER_EVENT_INSERT, HashSet<String>(), row, params)) {
            affected += 1
        }
    }
    affected
}

/**
 * INSTEAD OF INSERT 的待插行。
 *
 * 列清单写明时按它铺到视图的全部列上, 没写时要求值的个数与视图列数相等 —— 与真表的
 * INSERT 同一规则。
 */
private func insteadOfInsertRows(db: SqliteDatabase, view: ViewInfo, pseudo: TableInfo, stmt: InsertStmt,
    params: Array<SqliteValue>): ArrayList<Array<SqliteValue>> {
    let out = ArrayList<Array<SqliteValue>>()
    let targets = ArrayList<Int64>()
    if (stmt.columns.isEmpty()) {
        for (i in 0..pseudo.columns.size) {
            targets.add(i)
        }
    } else {
        for (name in stmt.columns) {
            let idx = pseudo.columnIndexOf(name)
            if (idx < 0) {
                throw SqliteRuntimeException("sql", "view ${view.name} has no column named ${name}")
            }
            targets.add(idx)
        }
    }
    let supplied = ArrayList<Array<SqliteValue>>()
    if (let Some(sel) <- stmt.select) {
        for (r in executeSelect(db, sel, params).rows) {
            supplied.add(r)
        }
    } else {
        let ctx = EvalContext(db, params)
        for (rowExprs in stmt.rows) {
            let vals = Array<SqliteValue>(rowExprs.size, repeat: SqliteValue.SNull)
            for (i in 0..rowExprs.size) {
                vals[i] = evalExpr(ctx, rowExprs[i])
            }
            supplied.add(vals)
        }
    }
    for (vals in supplied) {
        if (vals.size != targets.size) {
            throw SqliteRuntimeException("sql",
                "view ${view.name} has ${targets.size} column(s) but ${vals.size} value(s) were supplied")
        }
        let full = Array<SqliteValue>(pseudo.columns.size, repeat: SqliteValue.SNull)
        for (i in 0..targets.size) {
            full[targets[i]] = vals[i]
        }
        out.add(full)
    }
    out
}

/**
 * INSTEAD OF UPDATE: 先跑视图的 SELECT 找出匹配行, 每行触发一次。
 *
 * OLD 是查出来的那一行, NEW 是把 SET 施加到 OLD 上的结果。SET 的求值上下文里要能引用视图的
 * 列 (`SET v = v || 'x'`), 所以先把 OLD 装成一个可未限定引用的源。
 */
private func insteadOfUpdate(db: SqliteDatabase, view: ViewInfo, pseudo: TableInfo, stmt: Stmt,
    params: Array<SqliteValue>): Int64 {
    let update = match (stmt as UpdateStmt) {
        case Some(s) => s
        case None => throw SqliteRuntimeException("sql", "expected an UPDATE statement for a view")
    }
    let assignments = ArrayList<(Int64, Expr)>()
    for ((colName, valueExpr) in update.sets) {
        let idx = pseudo.columnIndexOf(colName)
        if (idx < 0) {
            throw SqliteRuntimeException("sql", "view ${view.name} has no column named ${colName}")
        }
        assignments.add((idx, valueExpr))
    }
    let matched = viewRowsMatching(db, view, pseudo, update.whereExpr, params)
    var affected = 0
    for (oldValues in matched) {
        let newValues = Array<SqliteValue>(oldValues.size, repeat: SqliteValue.SNull)
        for (i in 0..oldValues.size) {
            newValues[i] = oldValues[i]
        }
        let ctx = viewRowContext(db, view, pseudo, oldValues, params)
        for ((idx, valueExpr) in assignments) {
            newValues[idx] = evalExpr(ctx, valueExpr)
        }
        let updatedNames = HashSet<String>()
        for ((idx, _) in assignments) {
            updatedNames.add(pseudo.columns[idx].name.toAsciiLower())
        }
        let row = TriggerRowContext(pseudo, Some(oldValues), 0, Some(newValues), 0)
        if (fireTriggers(db, view.name, TRIGGER_TIMING_INSTEAD_OF, TRIGGER_EVENT_UPDATE, updatedNames, row, params)) {
            affected += 1
        }
    }
    affected
}

/** INSTEAD OF DELETE: 匹配行的每一行触发一次, 只有 OLD。 */
private func insteadOfDelete(db: SqliteDatabase, view: ViewInfo, pseudo: TableInfo, stmt: Stmt,
    params: Array<SqliteValue>): Int64 {
    let del = match (stmt as DeleteStmt) {
        case Some(s) => s
        case None => throw SqliteRuntimeException("sql", "expected a DELETE statement for a view")
    }
    let matched = viewRowsMatching(db, view, pseudo, del.whereExpr, params)
    var affected = 0
    for (oldValues in matched) {
        let row = TriggerRowContext(pseudo, Some(oldValues), 0, None, 0)
        if (fireTriggers(db, view.name, TRIGGER_TIMING_INSTEAD_OF, TRIGGER_EVENT_DELETE, HashSet<String>(), row, params)) {
            affected += 1
        }
    }
    affected
}

/**
 * 视图里满足 WHERE 的行。
 *
 * 先整趟物化再过滤, 而不是边跑边过滤: WHERE 里可能引用视图的列, 而那要求先有一行才能求值。
 * 行数是视图的规模, 与 UPDATE / DELETE 的语义一致 (它们本来就要先定下要改哪些行)。
 */
private func viewRowsMatching(db: SqliteDatabase, view: ViewInfo, pseudo: TableInfo, whereExpr: Option<Expr>,
    params: Array<SqliteValue>): ArrayList<Array<SqliteValue>> {
    let ctx = EvalContext(db, params)
    let all = runViewBody(ctx, view)
    let out = ArrayList<Array<SqliteValue>>()
    for (values in all) {
        match (whereExpr) {
            case None => out.add(values)
            case Some(w) =>
                let rowCtx = viewRowContext(db, view, pseudo, values, params)
                match (valueToTristate(evalExpr(rowCtx, w))) {
                    case Some(true) => out.add(values)
                    case _ => ()
                }
        }
    }
    out
}

/** 一个能未限定引用视图列的上下文, 供 WHERE 与 SET 求值。 */
private func viewRowContext(db: SqliteDatabase, view: ViewInfo, pseudo: TableInfo, values: Array<SqliteValue>,
    params: Array<SqliteValue>): EvalContext {
    let ctx = EvalContext(db, params)
    let names = Array<String>(pseudo.columns.size, repeat: "")
    for (i in 0..pseudo.columns.size) {
        names[i] = pseudo.columns[i].name
    }
    let src = RowSource(view.name, names, None)
    src.values = values
    ctx.addSource(src)
    ctx
}
