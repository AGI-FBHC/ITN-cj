package sqlite_driver

import std.collection.*

/*
 * CREATE TABLE ... AS SELECT。
 *
 * 语义按 SQLite:
 *   - 列名取结果集的列名, 列的声明类型取源列的声明类型 (结果列是裸列引用时), 表达式列
 *     则无类型 —— 无类型列的亲和性是 BLOB, 即存进去的值不做任何转换。
 *   - **不继承**任何约束: 主键、NOT NULL、UNIQUE、DEFAULT、外键都不带过来。所以新表没有
 *     INTEGER PRIMARY KEY, rowid 由 1 起顺序发号。
 *   - 空结果集也建表, 只是没有行。
 *
 * 写进 sqlite_schema.sql 的是**展开后的 CREATE TABLE**, 不是原始的 AS SELECT 语句。
 * 必须如此: 模式重建靠重新解析这段 SQL, 若存原文则重开库时要重跑一遍 SELECT —— 那时源表
 * 可能已经变了或已被删, 列定义会跟着变, 库的形态就不稳定了。SQLite 存的同样是展开后的。
 */
func execCreateTableAsSelect(db: SqliteDatabase, stmt: CreateTableStmt, select: SelectStmt, params: Array<SqliteValue>): Int64 {
    if (stmt.name.toAsciiLower().startsWith("sqlite_")) {
        throw SqliteRuntimeException("schema", "object name reserved for internal use: ${stmt.name}")
    }
    if (let Some(_) <- db.currentSchema().findTable(stmt.name)) {
        if (stmt.ifNotExists) {
            return 0
        }
        throw SqliteRuntimeException("schema", "table ${stmt.name} already exists")
    }
    // 查询先跑完再建表: 建完表才发现 SELECT 报错会留下一张空表, 而调用方看到的是失败。
    let rs = executeSelect(db, select, params)
    let expanded = buildTableFromResultShape(db, stmt, select, rs)
    let _ = execCreateTable(db, expanded)
    let table = match (db.currentSchema().findTable(stmt.name)) {
        case Some(t) => t
        case None => throw SqliteRuntimeException("state", "table ${stmt.name} vanished right after being created")
    }
    var rowid = 0
    for (row in rs.rows) {
        rowid += 1
        // 结果集的宽度就是新表的列数, 但空结果集时列数由列名数组给出, 逐行补齐更稳。
        let values = Array<SqliteValue>(table.columns.size, repeat: SqliteValue.SNull)
        for (i in 0..table.columns.size) {
            if (i < row.size) {
                values[i] = row[i]
            }
        }
        writeRow(db, table, rowid, values, false)
    }
    db.lastChanges = rs.rows.size
    db.totalChanges += rs.rows.size
    0
}

/**
 * 由结果集形状造一份等价的列定义。
 *
 * 列名重复时 SQLite 会报错 (`duplicate column name`), 这里让 execCreateTable 的既有检查去
 * 报 —— 判据只有一处, 不会两处说法不一致。
 */
private func buildTableFromResultShape(db: SqliteDatabase, stmt: CreateTableStmt, select: SelectStmt, rs: ResultSet): CreateTableStmt {
    let out = CreateTableStmt()
    out.name = stmt.name
    out.ifNotExists = stmt.ifNotExists
    for (i in 0..rs.columnNames.size) {
        let col = ColumnDef()
        col.name = rs.columnNames[i]
        col.typeName = declaredTypeOfResultColumn(db, select, i)
        out.columns.add(col)
    }
    if (out.columns.isEmpty()) {
        throw SqliteRuntimeException("schema", "CREATE TABLE ${stmt.name} AS SELECT produced no columns")
    }
    out.sourceSql = renderCreateTableSql(out)
    out
}

/**
 * 第 i 个结果列的声明类型。
 *
 * 只有裸列引用才继承源列的类型; 表达式列无类型。`SELECT *` 展开后的列在 AST 里仍是 star
 * 形态, 拿不到逐列的来源, 所以这里对 star 返回空类型 —— 与 SQLite 不同 (它会继承),
 * 是本驱动的一处已知简化, 记在 README 的限制清单里。
 */
func declaredTypeOfResultColumn(db: SqliteDatabase, select: SelectStmt, i: Int64): String {
    if (i >= select.columns.size) {
        return ""
    }
    let rc = select.columns[i]
    if (!(rc.expr is ColumnExpr)) {
        return ""
    }
    let ce = (rc.expr as ColumnExpr).getOrThrow()
    let schema = db.currentSchema()
    // 限定了表名就只查那张表; 没限定则按 FROM 里的表依次找第一个有这一列的。
    if (!ce.table.isEmpty()) {
        return declaredTypeIn(schema, ce.table, ce.name)
    }
    for (clause in select.from) {
        let t = declaredTypeIn(schema, clause.source.name, ce.name)
        if (!t.isEmpty()) {
            return t
        }
    }
    ""
}

private func declaredTypeIn(schema: SchemaCache, tableName: String, columnName: String): String {
    match (schema.findTable(tableName)) {
        case None => ""
        case Some(t) =>
            let idx = t.columnIndexOf(columnName)
            if (idx < 0) {
                ""
            } else {
                t.columns[idx].declaredType
            }
    }
}

/**
 * 把列定义渲染回一条 CREATE TABLE 语句, 存进 sqlite_schema.sql。
 *
 * 列名一律加双引号: 结果列名可能是 `count(*)` 这种含括号与星号的形态, 不引起来重新解析
 * 时会失败, 于是重开库直接报模式损坏。内嵌的双引号按 SQL 规则翻倍。
 */
private func renderCreateTableSql(stmt: CreateTableStmt): String {
    let sb = StringBuilder()
    sb.append("CREATE TABLE ")
    sb.append(quoteIdentifier(stmt.name))
    sb.append(" (")
    for (i in 0..stmt.columns.size) {
        if (i > 0) {
            sb.append(", ")
        }
        sb.append(quoteIdentifier(stmt.columns[i].name))
        if (!stmt.columns[i].typeName.isEmpty()) {
            sb.append(" ")
            sb.append(stmt.columns[i].typeName)
        }
    }
    sb.append(")")
    sb.toString()
}

func quoteIdentifier(name: String): String {
    let sb = StringBuilder()
    sb.append("\"")
    for (r in name.toRuneArray()) {
        if (r == r'"') {
            sb.append("\"\"")
        } else {
            sb.append(r)
        }
    }
    sb.append("\"")
    sb.toString()
}
