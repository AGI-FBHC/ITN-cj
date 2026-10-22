package sqlite_driver

import std.collection.*

/*
 * ALTER TABLE … DROP COLUMN。
 *
 * 与 RENAME / ADD COLUMN 一样, 表结构的唯一权威来源是 sqlite_schema.sql 那段文本, 所以删列
 * 就是"改那段文本 + 重写每一行的 record"。三件事的顺序是定死的:
 *
 *   1. 先按 SQLite 的顺序做各项拒绝检查 (顺序见 dropColumnPreconditions 的注释);
 *   2. 再改写 DDL 文本并**校验改写后的模式仍然自洽** —— 任何依赖对象引用了被删列就整条拒绝,
 *      此时还没有落任何写;
 *   3. 最后才动数据: 重写表树里每一行的 payload。
 *
 * 校验必须先于数据写入。显式事务中的语句失败只回滚本语句的作用域；若先重写记录再校验模式，
 * 调用方仍可提交外层事务，造成记录列数与 DDL 不一致。
 *
 * 索引树不需要重建。索引项里存的是**列值**加 rowid, 删掉一个不相关的列不改变这些值; 变的
 * 只是列在表里的序号, 而那是下次 loadSchema 从新 DDL 重算出来的。SQLite 也是这么做的
 * (删列后 `CREATE INDEX` 的 sql 文本原样保留)。
 */
func execAlterTableDropColumn(db: SqliteDatabase, table: TableInfo, stmt: AlterTableStmt): Int64 {
    let colIndex = dropColumnPreconditions(db, table, stmt.oldColumn)
    let newSql = removeColumnFromCreate(table.sql, table.columns[colIndex].name)
    // 校验放在写之前: 失败时什么都没改, 天然满足 SQLite 的"整条回滚"。
    let newTable = validateSchemaAfterDropColumn(db, table, colIndex, newSql)
    rewriteRowsWithoutColumn(db, table, newTable, colIndex)
    let row = findSchemaRowFor(db, "table", table.name)
    updateSchemaRow(db, row.rowid, "table", table.name, table.name, table.rootPage, newSql)
    db.bumpSchemaCookie()
    0
}

/**
 * 各项拒绝检查, 返回被删列的序号。
 *
 * 检查顺序与可观察的错误优先级一致：
 *   no such column → cannot drop PRIMARY KEY column → cannot drop UNIQUE column
 *   → no other columns exist
 * (`no such table` 更早, 在 execAlterTable 里就报了。)
 *
 * 顺序有可观测后果: 一张只有一列且那列是主键的表, 报的是 PRIMARY KEY 而不是
 * "no other columns exist"; 一列既不存在又赶上表只有一列时, 报的是 no such column。
 * 报错文本使用用户书写的列名并加双引号，而不是模式中保存的列名拼写。
 */
private func dropColumnPreconditions(db: SqliteDatabase, table: TableInfo, requested: String): Int64 {
    let colIndex = table.columnIndexOf(requested)
    if (colIndex < 0) {
        throw SqliteRuntimeException("schema", "no such column: \"${requested}\"")
    }
    let column = table.columns[colIndex]
    // rowid 别名列与复合主键成员都算主键列。表级 PRIMARY KEY(a,b) 的成员走的也是这条,
    // 因为 tableInfoFromCreate 已经把它们并进了 inPrimaryKey。
    if (column.isRowidAlias || column.inPrimaryKey) {
        throw SqliteRuntimeException("schema", "cannot drop PRIMARY KEY column: \"${column.name}\"")
    }
    if (columnHasColumnLevelUnique(table, column.name)) {
        throw SqliteRuntimeException("schema", "cannot drop UNIQUE column: \"${column.name}\"")
    }
    if (table.columns.size <= 1) {
        throw SqliteRuntimeException("schema", "cannot drop column \"${column.name}\": no other columns exist")
    }
    let _ = db
    colIndex
}

/**
 * 该列是否带**列级** UNIQUE。
 *
 * 只认列级的: 表级 `UNIQUE(a,b)` 的成员在 SQLite 里报的是另一种错
 * (`error in table t after drop column: no such column: a`, 即改写后重解析失败),
 * 两者不能混。ColumnInfo 没有 unique 标志, 所以回到 DDL 文本重解析取 ColumnDef。
 */
private func columnHasColumnLevelUnique(table: TableInfo, columnName: String): Bool {
    let parsed = try {
        Parser(table.sql).parseStatement()
    } catch (_: SqliteSyntaxException) {
        return false
    }
    if (!(parsed is CreateTableStmt)) {
        return false
    }
    let create = (parsed as CreateTableStmt).getOrThrow()
    let lower = columnName.toAsciiLower()
    for (def in create.columns) {
        if (def.name.toAsciiLower() == lower) {
            return def.unique
        }
    }
    false
}

/**
 * 校验删列之后整份模式仍然自洽; 任何依赖对象引用了被删列就抛。
 *
 * 报错格式与 SQLite 一致: `error in <type> <name> after drop column: <原因>`。
 *
 * 校验范围只包含能够无歧义绑定的列引用。完整的名称解析会产生以下行为：
 *   - 视图里 `u.b` 限定到另一张表 → **放过**;
 *   - 触发器 body 里 `UPDATE t SET b=1` (触发器建在别的表上) → **也放过**;
 *   - 视图里未限定的 `b` 而两张源表都有 b → 报 `ambiguous column name` 而不是删列错。
 * 也就是说"凡是提到该列名就拒"会**过度拒绝**上面第 2 条。完整复刻那套解析规则等于把
 * 名字解析器搬一份进 DDL 路径, 与收益不相称。
 *
 * 所以这里只校验**能无歧义判定**的引用:
 *   - 同表的约束 (表级/列级 CHECK、表级 UNIQUE/PRIMARY KEY 的列清单、外键的子侧列):
 *     它们只可能解析到本表, 无歧义;
 *   - 索引的键列与部分索引的 WHERE: 同理只解析到本表;
 *   - 视图/触发器里**限定到本表**的引用 (`t.b`), 以及触发器的 `NEW.b`/`OLD.b`;
 *   - 视图/触发器 body 里**未限定**的引用, 且该 body 的数据源只有本表一个 —— 此时不存在
 *     解析到别处的可能。
 * 落在这个子集之外的形态 (多源视图里未限定的同名列) 本驱动放过, 于是视图会留成坏的, 在
 * **查询它的时候**报 no such column。这与本驱动既有的取向一致 (loadSchema 对解析不了的
 * 视图是跳过而不是让整个库打不开), 不会静默返回错结果。
 */
private func validateSchemaAfterDropColumn(db: SqliteDatabase, table: TableInfo, colIndex: Int64, newSql: String): TableInfo {
    let dropped = table.columns[colIndex].name
    // 1. 表自己: 重解析新 DDL。表级 FK 引用被删列会在 foreignKeyInfoFrom 里抛。
    let newTable = try {
        let parsed = Parser(newSql).parseStatement()
        if (!(parsed is CreateTableStmt)) {
            throw SqliteFormatException("rewritten DDL is not a CREATE TABLE statement: ${newSql}")
        }
        let create = (parsed as CreateTableStmt).getOrThrow()
        tableInfoFromCreate(create, table.rootPage, newSql)
    } catch (e: SqliteSyntaxException) {
        throw dropColumnDependencyError("table", table.name, e.message)
    } catch (e: SqliteRuntimeException) {
        throw dropColumnDependencyError("table", table.name, foreignKeyReasonFor(e.message, dropped))
    }
    // 2. 表级与列级约束里的列引用。tableInfoFromCreate 不校验表达式中的列名，因此需要在
    //    模式写入前单独检查。
    checkConstraintRefsAfterDrop(newTable, table.name, dropped, newSql)
    // 3. 索引: 键列走 indexInfoFromCreate (它对缺列会抛), 部分索引的 WHERE 单独查。
    for (index in table.indexes) {
        validateIndexAfterDropColumn(db, newTable, index, dropped)
    }
    // 4. 视图与触发器: 见本函数头部说明的收窄范围。
    let schema = db.currentSchema()
    for ((_, view) in schema.views) {
        if (let Some(reason) <- viewBreaksAfterDrop(view, table.name, dropped)) {
            throw dropColumnDependencyError("view", view.name, reason)
        }
    }
    for (trigger in schema.triggers) {
        if (let Some(reason) <- triggerBreaksAfterDrop(trigger, table.name, dropped)) {
            throw dropColumnDependencyError("trigger", trigger.name, reason)
        }
    }
    newTable
}

private func dropColumnDependencyError(objType: String, name: String, reason: String): SqliteRuntimeException {
    SqliteRuntimeException("schema", "error in ${objType} ${name} after drop column: ${reason}")
}

/**
 * 外键报错的原因文本。
 *
 * SQLite 对"外键定义引用了被删的列"报的是
 * `unknown column "b" in foreign key definition`, 与普通的 no such column 不同形。
 * foreignKeyInfoFrom 抛的是本驱动自己的措辞, 这里在确实是那一条时换成对齐的文本。
 */
private func foreignKeyReasonFor(original: String, dropped: String): String {
    if (original.contains("foreign key") || original.contains("REFERENCES")) {
        return "unknown column \"${dropped}\" in foreign key definition"
    }
    original
}

/** 表级 CHECK / UNIQUE / PRIMARY KEY 与列级 CHECK 里是否还引用着被删的列。 */
private func checkConstraintRefsAfterDrop(newTable: TableInfo, tableName: String, dropped: String, newSql: String): Unit {
    let parsed = try {
        Parser(newSql).parseStatement()
    } catch (_: SqliteSyntaxException) {
        return
    }
    if (!(parsed is CreateTableStmt)) {
        return
    }
    let create = (parsed as CreateTableStmt).getOrThrow()
    let lower = dropped.toAsciiLower()
    for (tc in create.constraints) {
        // 表级 UNIQUE / PRIMARY KEY 的列清单。
        for (c in tc.columns) {
            if (c.toAsciiLower() == lower) {
                throw dropColumnDependencyError("table", tableName, "no such column: ${dropped}")
            }
        }
        if (let Some(e) <- tc.checkExpr) {
            if (exprReferencesColumn(e, tableName, dropped, true)) {
                throw dropColumnDependencyError("table", tableName, "no such column: ${dropped}")
            }
        }
    }
    for (def in create.columns) {
        if (let Some(e) <- def.checkExpr) {
            if (exprReferencesColumn(e, tableName, dropped, true)) {
                throw dropColumnDependencyError("table", tableName, "no such column: ${dropped}")
            }
        }
        if (let Some(e) <- def.defaultExpr) {
            if (exprReferencesColumn(e, tableName, dropped, true)) {
                throw dropColumnDependencyError("table", tableName, "no such column: ${dropped}")
            }
        }
    }
    let _ = newTable
}

/** 索引的键列与部分索引 WHERE 是否还引用着被删的列。 */
private func validateIndexAfterDropColumn(db: SqliteDatabase, newTable: TableInfo, index: IndexInfo, dropped: String): Unit {
    // UNIQUE 约束生成的自动索引没有 sql 文本, 它跟着表的约束走, 不单独校验。
    let row = try {
        findSchemaRowFor(db, "index", index.name)
    } catch (_: SqliteRuntimeException) {
        return
    }
    if (row.sql.isEmpty()) {
        return
    }
    let parsed = try {
        Parser(row.sql).parseStatement()
    } catch (_: SqliteSyntaxException) {
        return
    }
    if (!(parsed is CreateIndexStmt)) {
        return
    }
    let create = (parsed as CreateIndexStmt).getOrThrow()
    try {
        let _ = indexInfoFromCreate(create, index.rootPage, newTable)
    } catch (_: SqliteRuntimeException) {
        throw dropColumnDependencyError("index", index.name, "no such column: ${dropped}")
    }
    if (let Some(w) <- create.whereExpr) {
        if (exprReferencesColumn(w, newTable.name, dropped, true)) {
            throw dropColumnDependencyError("index", index.name, "no such column: ${dropped}")
        }
    }
}

/** 视图是否因为删列而坏掉; 坏了返回原因。判定范围见 validateSchemaAfterDropColumn 的说明。 */
private func viewBreaksAfterDrop(view: ViewInfo, tableName: String, dropped: String): Option<String> {
    let onlySource = selectHasOnlySource(view.body, tableName)
    for (ref in selectColumnRefs(view.body)) {
        if (columnRefHits(ref, tableName, dropped, onlySource)) {
            return Some("no such column: ${dropped}")
        }
    }
    None
}

/**
 * 触发器是否因为删列而坏掉。
 *
 * `NEW.`/`OLD.` 只在触发器建于本表时才指向本表的列 —— 建在别的表上的触发器里的 NEW 指的是
 * 那张表。报错文本保留限定词 (`no such column: NEW.b`), 与 SQLite 一致。
 *
 * body 中各语句的列引用由 selectColumnRefs 收集，但 UPDATE 的 SET 目标列名不算表达式引用。
 */
private func triggerBreaksAfterDrop(trigger: TriggerInfo, tableName: String, dropped: String): Option<String> {
    let onTable = trigger.tableName.toAsciiLower() == tableName.toAsciiLower()
    let lowerDropped = dropped.toAsciiLower()
    if (onTable) {
        // UPDATE OF <列> 里点名了被删列。
        for (c in trigger.updateColumns) {
            if (c.toAsciiLower() == lowerDropped) {
                return Some("no such column: ${dropped}")
            }
        }
        if (let Some(w) <- trigger.whenExpr) {
            for (ref in collectRefs(w)) {
                if (isNewOldQualified(ref) && ref.name.toAsciiLower() == lowerDropped) {
                    return Some("no such column: ${ref.table.toAsciiUpper()}.${dropped}")
                }
                if (columnRefHits(ref, tableName, dropped, true)) {
                    return Some("no such column: ${dropped}")
                }
            }
        }
    }
    for (stmt in trigger.body) {
        for (ref in triggerStatementColumnRefs(stmt)) {
            if (onTable && isNewOldQualified(ref) && ref.name.toAsciiLower() == lowerDropped) {
                return Some("no such column: ${ref.table.toAsciiUpper()}.${dropped}")
            }
            if (columnRefHits(ref, tableName, dropped, false)) {
                return Some("no such column: ${dropped}")
            }
        }
    }
    None
}

/** NEW / OLD 限定词。 */
private func isNewOldQualified(ref: ColumnExpr): Bool {
    match (ref.table.toAsciiUpper()) {
        case "NEW" | "OLD" => true
        case _ => false
    }
}

/**
 * 一个列引用是否命中被删的列。
 *
 * allowUnqualified 为真时未限定的引用也算命中 —— 只有在"引用只可能解析到本表"的场合才能
 * 传真 (同表约束, 或数据源只有本表的 body)。
 */
private func columnRefHits(ref: ColumnExpr, tableName: String, dropped: String, allowUnqualified: Bool): Bool {
    if (ref.name.toAsciiLower() != dropped.toAsciiLower()) {
        return false
    }
    if (ref.table.isEmpty()) {
        return allowUnqualified
    }
    ref.table.toAsciiLower() == tableName.toAsciiLower()
}

private func exprReferencesColumn(e: Expr, tableName: String, dropped: String, allowUnqualified: Bool): Bool {
    for (ref in collectRefs(e)) {
        if (columnRefHits(ref, tableName, dropped, allowUnqualified)) {
            return true
        }
    }
    false
}

private func collectRefs(e: Expr): ArrayList<ColumnExpr> {
    let out = ArrayList<ColumnExpr>()
    collectColumnRefsDeep(e, out)
    out
}

/** 这条 SELECT 的数据源是否只有 tableName 一个 (没有别的表, 也没有子查询)。 */
private func selectHasOnlySource(stmt: SelectStmt, tableName: String): Bool {
    if (stmt.from.size != 1) {
        return false
    }
    let src = stmt.from[0].source
    if (let Some(_) <- src.subquery) {
        return false
    }
    if (!stmt.withCtes.isEmpty()) {
        return false
    }
    if (let Some(_) <- stmt.setRight) {
        return false
    }
    src.name.toAsciiLower() == tableName.toAsciiLower()
}

/**
 * 触发器 body 里一条语句的列引用。
 *
 * UPDATE 的 SET 目标列名刻意不收 (见 triggerBreaksAfterDrop 的注释); INSERT 的目标列名同理 ——
 * 它们属于**另一张表**的列, 与本表删列无关。
 */
private func triggerStatementColumnRefs(stmt: Stmt): ArrayList<ColumnExpr> {
    let out = ArrayList<ColumnExpr>()
    if (stmt is SelectStmt) {
        for (r in selectColumnRefs((stmt as SelectStmt).getOrThrow())) {
            out.add(r)
        }
        return out
    }
    if (stmt is InsertStmt) {
        let ins = (stmt as InsertStmt).getOrThrow()
        for (row in ins.rows) {
            for (e in row) {
                collectColumnRefsDeep(e, out)
            }
        }
        if (let Some(sel) <- ins.select) {
            for (r in selectColumnRefs(sel)) {
                out.add(r)
            }
        }
        return out
    }
    if (stmt is UpdateStmt) {
        let upd = (stmt as UpdateStmt).getOrThrow()
        for ((_, valueExpr) in upd.sets) {
            collectColumnRefsDeep(valueExpr, out)
        }
        if (let Some(w) <- upd.whereExpr) {
            collectColumnRefsDeep(w, out)
        }
        return out
    }
    if (stmt is DeleteStmt) {
        let del = (stmt as DeleteStmt).getOrThrow()
        if (let Some(w) <- del.whereExpr) {
            collectColumnRefsDeep(w, out)
        }
        return out
    }
    out
}

/**
 * 重写表树里每一行, 去掉被删列的值。
 *
 * 先全量收集再回写, 不在游标上边读边改 —— B-tree 写会分裂/合并页, 游标位置随之失效。
 * rowid 保持不变 (SQLite 也不重排), 所以索引项里的 rowid 仍然对得上。
 *
 * 用 newTable 编码而不是 table: 被删列在 rowid 别名列之前时, 别名列的序号要跟着前移一位,
 * 而 encodeRowValues 是按 rowidAliasColumn 把那一列写成 NULL 的。用旧序号会把错误的一列
 * 抹成 NULL, 表现为某列数据整列丢失。
 */
private func rewriteRowsWithoutColumn(db: SqliteDatabase, table: TableInfo, newTable: TableInfo, colIndex: Int64): Unit {
    let locators = ArrayList<RowLocator>()
    let payloads = ArrayList<Array<SqliteValue>>()
    let cursor = tableCursor(db.pager, table)
    var ok = cursor.first()
    while (ok) {
        locators.add(currentRowLocator(table, cursor))
        payloads.add(decodeTableRow(table, cursor))
        ok = cursor.next()
    }
    for (i in 0..locators.size) {
        let old = payloads[i]
        let kept = Array<SqliteValue>(old.size - 1, repeat: SqliteValue.SNull)
        var target = 0
        for (j in 0..old.size) {
            if (j == colIndex) {
                continue
            }
            kept[target] = old[j]
            target += 1
        }
        if (table.withoutRowid) {
            let oldSpec = table.requireRowKey()
            let newSpec = newTable.requireRowKey()
            let _ = btreeDeleteIndexKey(db.pager, table.rootPage, locators[i].key, oldSpec.keyCollations,
                oldSpec.keyDescs)
            btreeInsertIndexPayload(db.pager, table.rootPage, rowKeyOf(newSpec, kept),
                encodeWithoutRowidRow(newSpec, kept), newSpec.keyCollations, newSpec.keyDescs, false)
        } else {
            btreeInsertRow(db.pager, table.rootPage, locators[i].rowid, encodeRowValues(newTable, kept), true)
        }
    }
}
