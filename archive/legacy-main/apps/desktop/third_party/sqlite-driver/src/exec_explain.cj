package sqlite_driver

import std.collection.*

/*
 * EXPLAIN QUERY PLAN。
 *
 * 本引擎没有字节码引擎，因此不伪造 opcode 级 EXPLAIN。这里输出稳定的四列摘要，并直接
 * 调实际执行器使用的 rowid/索引规划函数；这样计划显示不会与执行路径悄悄分叉。
 */

func executeExplainQueryPlan(db: SqliteDatabase, stmt: ExplainQueryPlanStmt,
    params: Array<SqliteValue>): StatementResult {
    let select = match (stmt.statement) {
        case s: SelectStmt => s
        case _ => throw SqliteRuntimeException("sql",
            "EXPLAIN QUERY PLAN currently describes SELECT statements")
    }
    let rows = ArrayList<Array<SqliteValue>>()
    explainSelectAccess(db, select, params, rows)
    StatementResult(Some(ResultSet(["id", "parent", "notused", "detail"], rows)), 0)
}

func explainSelectAccess(db: SqliteDatabase, stmt: SelectStmt, params: Array<SqliteValue>,
    rows: ArrayList<Array<SqliteValue>>): Unit {
    if (stmt.from.isEmpty()) {
        addExplainRow(rows, "SCAN CONSTANT ROW")
        return
    }

    let ctx = EvalContext(db, params)
    ctx.currentStatement = Some(stmt)
    // 只建列元数据，不求值子查询、CTE 或视图。EXPLAIN 本身必须没有用户数据副作用。
    for (clause in stmt.from) {
        let ref = clause.source
        if (ref.subquery.isSome()) {
            ctx.addSource(RowSource(ref.effectiveName, Array<String>(), None))
            continue
        }
        match (db.currentSchema().findTable(ref.name)) {
            case Some(table) =>
                let names = Array<String>(table.columns.size, repeat: "")
                for (i in 0..table.columns.size) {
                    names[i] = table.columns[i].name
                }
                ctx.addSource(RowSource(ref.effectiveName, names, Some(table)))
            case None => ctx.addSource(RowSource(ref.effectiveName, Array<String>(), None))
        }
    }

    for (level in 0..stmt.from.size) {
        let clause = stmt.from[level]
        let shownName = clause.source.effectiveName
        if (let Some(subquery) <- clause.source.subquery) {
            addExplainRow(rows, "SCAN SUBQUERY ${shownName}")
            explainSelectAccess(db, subquery, params, rows)
            continue
        }
        let table = match (ctx.sources[level].table) {
            case Some(t) => t
            case None =>
                addExplainRow(rows, "SCAN ${shownName}")
                continue
        }
        match (planRowidAccess(ctx, table, level)) {
            case Some(_) => addExplainRow(rows,
                "SEARCH ${shownName} USING INTEGER PRIMARY KEY")
            case None => match (planPrimaryKeyAccess(ctx, table, level)) {
                case Some(_) => addExplainRow(rows, "SEARCH ${shownName} USING PRIMARY KEY")
                case None => match (planTableAccess(ctx, table, level)) {
                    case Some(plan) => addExplainRow(rows,
                        "SEARCH ${shownName} USING INDEX ${plan.index.name}")
                    case None => addExplainRow(rows, "SCAN ${shownName}")
                }
            }
        }
    }
}

private func addExplainRow(rows: ArrayList<Array<SqliteValue>>, detail: String): Unit {
    let id = rows.size
    rows.add([SqliteValue.SInt(id), SqliteValue.SInt(0), SqliteValue.SInt(0), SqliteValue.SText(detail)])
}
