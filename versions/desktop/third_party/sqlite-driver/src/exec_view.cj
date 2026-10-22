package sqlite_driver

import std.collection.*

/*
 * 视图的求值。
 *
 * 引用视图时执行其 SELECT，不缓存物化结果，因此同一语句中的后续读取可以看到先前写入的数据。
 * 同一语句多次引用视图时会分别执行视图查询。
 *
 * 视图 body 的求值上下文是**新的顶层上下文**, 而不是引用点的子上下文: body 里能看到的只有
 * 库里的表, 看不到引用点所在查询的数据源。用引用点的上下文会让
 * `SELECT * FROM t, v` 里的 v 意外能引用 t 的列 —— 那是关联子查询的语义, 视图不是。
 */

/**
 * 视图的结果列名。
 *
 * 写了别名清单就用它, 否则推 body 的结果列名。别名个数与结果列数不符时报错 —— 不报的话
 * 多出的列静默变成 NULL, 少写的列永远引用不到。
 */
func viewColumnNames(ctx: EvalContext, view: ViewInfo): Array<String> {
    let fromBody = subqueryColumnNames(ctx, view.body)
    if (view.columnNames.size == 0) {
        return fromBody
    }
    if (view.columnNames.size != fromBody.size) {
        throw SqliteRuntimeException("sql",
            "view ${view.name} has ${fromBody.size} values for ${view.columnNames.size} columns")
    }
    view.columnNames
}

/**
 * 跑一遍视图的 body, 返回它的行。
 *
 * 上下文用 db 新建而不是从 ctx 派生, 理由见文件头。参数数组要带过去: 视图 body 里不能有
 * 参数占位符 (存进 sqlite_schema 的文本里没有绑定值可言), 但传一份空数组会让 body 里
 * 恰好引用到的函数拿不到 params —— 传原样的更稳。
 */
func runViewBody(ctx: EvalContext, view: ViewInfo): ArrayList<Array<SqliteValue>> {
    let fresh = EvalContext(ctx.db, ctx.params)
    let rs = runSelectInto(fresh, view.body)
    let names = viewColumnNames(ctx, view)
    if (rs.columnNames.size == names.size) {
        return rs.rows
    }
    // 列数在建视图之后变了 (body 里是 `SELECT *` 而底表加过列)。按声明的列数裁剪或补 NULL,
    // 与 RowSource 的宽度对齐 —— 不对齐会在取列时越界。
    let out = ArrayList<Array<SqliteValue>>()
    for (row in rs.rows) {
        let fixed = Array<SqliteValue>(names.size, repeat: SqliteValue.SNull)
        for (i in 0..names.size) {
            if (i < row.size) {
                fixed[i] = row[i]
            }
        }
        out.add(fixed)
    }
    out
}

/**
 * 视图不可直接写, 除非有对应的 INSTEAD OF 触发器。
 *
 * 三条 DML 的入口都要调。报错措辞与 SQLite 一致 ("cannot modify X because it is a view"),
 * 于是上层按文本匹配的代码不必区分实现。
 */
func rejectViewWriteWithoutInsteadOf(db: SqliteDatabase, name: String, event: String): Unit {
    let schema = db.currentSchema()
    match (schema.findView(name)) {
        case None => ()
        case Some(_) =>
            let triggers = schema.triggersFor(name, TRIGGER_TIMING_INSTEAD_OF, event, HashSet<String>())
            if (triggers.isEmpty()) {
                throw SqliteRuntimeException("sql", "cannot modify ${name} because it is a view")
            }
    }
}
