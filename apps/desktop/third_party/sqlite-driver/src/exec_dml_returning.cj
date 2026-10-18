package sqlite_driver

import std.collection.*

/*
 * RETURNING 子句。
 *
 * 语义如下：
 *
 *   - INSERT / UPDATE 返回**写入后**的行, DELETE 返回**删除前**的行;
 *   - 未命中任何行时返回空结果集而不是错误;
 *   - `*` 展开成表的全部列; `rowid` 可引用;
 *   - 聚合函数被拒 (`RETURNING count(*)` 报 misuse of aggregate);
 *   - 后面不能再接 WHERE / ORDER BY / LIMIT。
 *
 * 行在**写入点**采集而不是事后重查: INSERT 有三条写入出口 (普通、OR REPLACE、upsert
 * DO UPDATE），其中 upsert 修改的是冲突行，其 rowid 与待插入值不同，因此必须在写入点保存
 * 返回行，不能在语句结束后按插入值回查。
 */

/**
 * DML 执行结果: 受影响行数 + RETURNING 采集到的行。
 *
 * rowid 与值一起存: `RETURNING rowid` 在无 INTEGER PRIMARY KEY 的表上取不到值数组里的
 * 任何一列, 只能靠这个字段。
 */
class DmlOutcome {
    var changes: Int64 = 0
    let returned = ArrayList<(Int64, Array<SqliteValue>)>()

    init() {}
}

/**
 * RETURNING 的行采集器。
 *
 * `wanted` 为假时 record 是空操作 —— 让各写入点无条件调用它, 不必在每处再判一次是否写了
 * RETURNING。判定漏一处就会让那条路径的行静默缺失。
 */
class ReturningCollector {
    let wanted: Bool
    let rows = ArrayList<(Int64, Array<SqliteValue>)>()

    init(wanted: Bool) {
        this.wanted = wanted
    }

    func record(rowid: Int64, values: Array<SqliteValue>): Unit {
        if (!wanted) {
            return
        }
        // 存快照: 调用方的数组会被后续行复用/改写, 存引用会让所有返回行变成最后一行。
        let snapshot = Array<SqliteValue>(values.size, repeat: SqliteValue.SNull)
        for (i in 0..values.size) {
            snapshot[i] = values[i]
        }
        rows.add((rowid, snapshot))
    }
}

/**
 * 把采集到的行按 RETURNING 的结果列求值成 ResultSet。
 *
 * 每行一个独立的 EvalContext: 表达式可以引用任意列, 而各行的值不同。共用一个上下文再
 * 改 values 也行, 但那样子查询的缓存与外层引用更容易串味。
 */
func buildReturningResultSet(db: SqliteDatabase, table: TableInfo, returning: ArrayList<ResultColumn>,
    collected: ArrayList<(Int64, Array<SqliteValue>)>, params: Array<SqliteValue>): ResultSet {
    let names = Array<String>(table.columns.size, repeat: "")
    for (i in 0..table.columns.size) {
        names[i] = table.columns[i].name
    }
    let expanded = expandReturningColumns(returning, table, names)
    rejectAggregatesInReturning(expanded)
    // RETURNING 在没有命中行时也必须像 SELECT 一样在执行前拒绝 WITHOUT ROWID 的伪列。
    // 否则 `UPDATE ... WHERE 0 RETURNING rowid` 会静默返回一个空结果集。
    if (table.withoutRowid) {
        let validation = EvalContext(db, params)
        validation.addSource(RowSource(table.name, names, Some(table)))
        for (column in expanded) {
            validateWithoutRowidRowidExpr(validation, column.expr)
        }
    }
    let rows = ArrayList<Array<SqliteValue>>()
    for ((rowid, values) in collected) {
        let ctx = EvalContext(db, params)
        let src = RowSource(table.name, names, Some(table))
        src.values = values
        src.rowid = rowid
        ctx.addSource(src)
        let out = Array<SqliteValue>(expanded.size, repeat: SqliteValue.SNull)
        for (i in 0..expanded.size) {
            out[i] = evalExpr(ctx, expanded[i].expr)
        }
        rows.add(out)
    }
    ResultSet(resultColumnNames(expanded), rows)
}

/**
 * 展开 RETURNING 里的 `*` 与 `t.*`。
 *
 * 不复用 expandResultColumns: 那个要一个 SelectStmt 与建好的 ctx.sources, 而这里在
 * 求值之前就要定下列名 (空结果集也要有正确的列名, 否则调用方按列名取值会失败)。
 */
func expandReturningColumns(returning: ArrayList<ResultColumn>, table: TableInfo, names: Array<String>): ArrayList<ResultColumn> {
    let out = ArrayList<ResultColumn>()
    for (rc in returning) {
        if (!(rc.expr is StarExpr)) {
            out.add(rc)
            continue
        }
        let star = (rc.expr as StarExpr).getOrThrow()
        if (!star.table.isEmpty() && star.table.toAsciiLower() != table.name.toAsciiLower()) {
            throw SqliteRuntimeException("sql", "no such table: ${star.table}")
        }
        for (name in names) {
            out.add(ResultColumn(ColumnExpr("", name), name))
        }
    }
    if (out.isEmpty()) {
        throw SqliteRuntimeException("sql", "RETURNING must have at least one result column")
    }
    out
}

/**
 * 拒绝 RETURNING 里的聚合。
 *
 * 不拒的话 `RETURNING count(*)` 会走到 evalAggregateReference, 而 DML 路径上没有累加器,
 * 它抛的也是 misuse of aggregate —— 但只在有行返回时才抛, 空结果集上会静默通过。
 * 在这里显式判定, 时机与 SQLite 一致 (它在准备语句时就拒)。
 */
func rejectAggregatesInReturning(columns: ArrayList<ResultColumn>): Unit {
    for (rc in columns) {
        if (exprHasAggregate(rc.expr)) {
            throw SqliteRuntimeException("sql", "misuse of aggregate function in RETURNING")
        }
    }
}

/** 表达式里是否出现聚合调用。子查询内部不算 —— 那是独立作用域, 允许有自己的聚合。 */
func exprHasAggregate(e: Expr): Bool {
    if (e is FuncExpr) {
        let f = (e as FuncExpr).getOrThrow()
        if (isAggregateName(f.name, f.args.size)) {
            return true
        }
    }
    for (child in childExpressions(e)) {
        if (exprHasAggregate(child)) {
            return true
        }
    }
    false
}
