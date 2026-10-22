package sqlite_driver

import std.collection.*

/*
 * INSERT / UPDATE / DELETE。
 *
 * 三条共同的纪律:
 *
 *   1. **先算完再写**。UPDATE/DELETE 先把目标 rowid 全部收进列表, 再逐个改。边扫边改
 *      会让 B-tree 游标失效, 更糟的是改了 rowid 的行可能落到游标前方而被二次处理
 *      (`UPDATE t SET id = id + 1` 会把一行推着走到底)。
 *
 *   2. **索引与表同事务更新**。每次写行都要同步维护该表所有索引; 漏一处会让索引查询
 *      漏行或读到已删的行, 而全表扫仍然正确 —— 于是缺陷只在"用到那个索引的查询"上出现。
 *
 *   3. **约束在写之前查**。NOT NULL / CHECK / UNIQUE 都在动 B-tree 前判定, 失败直接抛。
 *      写一半再抛要靠事务回滚兜底, 而隐式事务下单语句的部分写入会留在库里。
 */

/**
 * 一条 INSERT 的执行结果: 受影响行数 + RETURNING 采集到的行。
 *
 * 采集器无条件传下去 (wanted 为假时 record 是空操作), 于是各写入出口不必各自判断有没有
 * 写 RETURNING —— 判定漏一处就会让那条路径的返回行静默缺失。
 */
func executeInsert(db: SqliteDatabase, stmt: InsertStmt, params: Array<SqliteValue>): DmlOutcome {
    let table = requireWritableTable(db, stmt.tableName)
    let upsertExpressions = ArrayList<Expr>()
    for ((_, valueExpr) in stmt.upsertSets) {
        upsertExpressions.add(valueExpr)
    }
    if (let Some(w) <- stmt.upsertWhere) {
        upsertExpressions.add(w)
    }
    validateDmlWithoutRowidReferences(db, table, upsertExpressions, params)
    let rows = buildInsertRows(db, stmt, table, params)
    let collector = ReturningCollector(!stmt.returning.isEmpty())
    var affected = 0
    for (values in rows) {
        if (insertOneRow(db, table, values, stmt, params, collector)) {
            affected += 1
        }
    }
    db.lastChanges = affected
    db.totalChanges += affected
    let outcome = DmlOutcome()
    outcome.changes = affected
    for (r in collector.rows) {
        outcome.returned.add(r)
    }
    outcome
}

/** 取表并拒绝写内部表。sqlite_schema 由 DDL 维护, 直接改会让模式与 B-tree 不一致。 */
func requireWritableTable(db: SqliteDatabase, name: String): TableInfo {
    if (isSchemaTableName(name)) {
        throw SqliteRuntimeException("sql", "table ${name} may not be modified")
    }
    if (name.toAsciiLower().startsWith("sqlite_")) {
        throw SqliteRuntimeException("sql", "object name reserved for internal use: ${name}")
    }
    match (db.currentSchema().findTable(name)) {
        case Some(t) => t
        case None => throw SqliteRuntimeException("sql", "no such table: ${name}")
    }
}

/**
 * 把 INSERT 的各种形态归一成"待插入的整行值数组"。
 *
 * 三种形态: VALUES 列表、INSERT … SELECT、DEFAULT VALUES。未列出的列取默认值 (无默认则
 * NULL)。列名列表为空时按表的列顺序全量对齐。
 */
func buildInsertRows(db: SqliteDatabase, stmt: InsertStmt, table: TableInfo, params: Array<SqliteValue>): ArrayList<Array<SqliteValue>> {
    let out = ArrayList<Array<SqliteValue>>()
    let targetColumns = resolveInsertColumns(stmt, table)
    if (stmt.defaultValues) {
        out.add(buildRowFromDefaults(db, table, params))
        return out
    }
    if (let Some(sel) <- stmt.select) {
        let rs = executeSelect(db, sel, params)
        for (srcRow in rs.rows) {
            if (srcRow.size != targetColumns.size) {
                throw SqliteRuntimeException("sql",
                    "table ${table.name} has ${targetColumns.size} column(s) but ${srcRow.size} value(s) were supplied")
            }
            out.add(assembleRow(db, table, targetColumns, srcRow, params))
        }
        return out
    }
    let ctx = EvalContext(db, params)
    for (rowExprs in stmt.rows) {
        if (rowExprs.size != targetColumns.size) {
            throw SqliteRuntimeException("sql",
                "table ${table.name} has ${targetColumns.size} column(s) but ${rowExprs.size} value(s) were supplied")
        }
        let supplied = Array<SqliteValue>(rowExprs.size, repeat: SqliteValue.SNull)
        for (i in 0..rowExprs.size) {
            supplied[i] = evalExpr(ctx, rowExprs[i])
        }
        out.add(assembleRow(db, table, targetColumns, supplied, params))
    }
    out
}

/** INSERT 的目标列序号。没写列名时是表的全部列。 */
func resolveInsertColumns(stmt: InsertStmt, table: TableInfo): Array<Int64> {
    if (stmt.columns.isEmpty()) {
        let all = Array<Int64>(table.columns.size, repeat: 0)
        for (i in 0..table.columns.size) {
            all[i] = i
        }
        return all
    }
    let out = Array<Int64>(stmt.columns.size, repeat: 0)
    let seen = HashSet<Int64>()
    for (i in 0..stmt.columns.size) {
        let idx = table.columnIndexOf(stmt.columns[i])
        if (idx < 0) {
            throw SqliteRuntimeException("sql", "table ${table.name} has no column named ${stmt.columns[i]}")
        }
        if (seen.contains(idx)) {
            throw SqliteRuntimeException("sql", "column ${stmt.columns[i]} specified more than once")
        }
        seen.add(idx)
        out[i] = idx
    }
    out
}

/** 全默认值的一行 (DEFAULT VALUES)。 */
func buildRowFromDefaults(db: SqliteDatabase, table: TableInfo, params: Array<SqliteValue>): Array<SqliteValue> {
    let row = Array<SqliteValue>(table.columns.size, repeat: SqliteValue.SNull)
    let ctx = EvalContext(db, params)
    for (i in 0..table.columns.size) {
        row[i] = defaultValueFor(ctx, table.columns[i])
    }
    row
}

/** 把"给定列的值"铺到整行, 缺的列填默认值, 并按列亲和性转换。 */
func assembleRow(db: SqliteDatabase, table: TableInfo, targetColumns: Array<Int64>, supplied: Array<SqliteValue>,
    params: Array<SqliteValue>): Array<SqliteValue> {
    let row = Array<SqliteValue>(table.columns.size, repeat: SqliteValue.SNull)
    let filled = Array<Bool>(table.columns.size, repeat: false)
    for (i in 0..targetColumns.size) {
        row[targetColumns[i]] = supplied[i]
        filled[targetColumns[i]] = true
    }
    let ctx = EvalContext(db, params)
    for (i in 0..table.columns.size) {
        if (!filled[i]) {
            row[i] = defaultValueFor(ctx, table.columns[i])
        }
    }
    // 亲和性转换在约束检查之前: NOT NULL 与 CHECK 看到的应是最终存进去的值。
    for (i in 0..table.columns.size) {
        let col = table.columns[i]
        if (col.isRowidAlias) {
            // rowid 别名列不做亲和性转换 —— 它必须是整数, 由 resolveRowid 校验。
            continue
        }
        row[i] = applyAffinity(row[i], col.affinity)
    }
    row
}

func defaultValueFor(ctx: EvalContext, col: ColumnInfo): SqliteValue {
    match (col.defaultExpr) {
        case Some(e) => applyAffinity(evalExpr(ctx, e), col.affinity)
        case None => SqliteValue.SNull
    }
}

/**
 * 插入一行。返回是否真的插进去了 (OR IGNORE 遇冲突时返回 false)。
 *
 * 顺序: 定 rowid → 查约束 → 写表 → 写索引。rowid 必须先定, 因为 UNIQUE 索引键含 rowid。
 */
func insertOneRow(db: SqliteDatabase, table: TableInfo, values: Array<SqliteValue>, stmt: InsertStmt,
    params: Array<SqliteValue>, collector: ReturningCollector): Bool {
    let conflict = stmt.conflict
    // BEFORE INSERT 排在约束检查之前: 它可能就是为了让本来违约的行变得合法而写的
    // (`BEFORE INSERT … SET NEW.v = coalesce(NEW.v, 'default')` 那类)。RAISE(IGNORE) 时
    // 这一行整个跳过, 不算受影响。
    if (!fireInsertTriggers(db, table, values, TRIGGER_TIMING_BEFORE, params)) {
        return false
    }
    var rowid = 0
    if (!table.withoutRowid) {
        rowid = try {
            resolveRowid(db, table, values)
        } catch (e: SqliteConstraintException) {
            return handleInsertConflict(db, table, values, stmt, params, e, 0, collector)
        }
    }
    // rowid 别名列的值就是 rowid, 回填以便 CHECK 与索引看到真值。
    if (table.rowidAliasColumn >= 0) {
        values[table.rowidAliasColumn] = SqliteValue.SInt(rowid)
    }
    try {
        checkRowConstraints(db, table, values, params)
        if (table.withoutRowid) {
            checkPrimaryKeyCollision(db, table, values, None)
        } else {
            checkRowidCollision(db, table, rowid)
        }
        checkUniqueConstraints(db, table, values, None)
        checkChildRowForeignKeys(db, table, values)
    } catch (e: SqliteConstraintException) {
        return handleInsertConflict(db, table, values, stmt, params, e, rowid, collector)
    }
    let replaceRow = match (conflict) {
        case ConflictReplace => true
        case _ => false
    }
    if (replaceRow) {
        // OR REPLACE: 先删掉所有冲突行 (rowid 冲突与 UNIQUE 冲突都算), 再插。
        deleteConflictingRows(db, table, values, rowid)
    }
    writeRow(db, table, rowid, values, replaceRow)
    if (!table.withoutRowid) {
        db.lastInsertRowid = rowid
    }
    collector.record(rowid, values)
    // AFTER INSERT 在写入后执行，因此触发器 body 可以读取刚写入的行。
    let _ = fireInsertTriggers(db, table, values, TRIGGER_TIMING_AFTER, params)
    true
}

/**
 * 触发 INSERT 的触发器。返回 false 表示 RAISE(IGNORE) 要求跳过这一行。
 *
 * INSERT 只有 NEW 没有 OLD。rowid 传 0 —— BEFORE 时它还没分配, 而 AFTER 时 NEW.rowid 应当
 * 取别名列的值, 那已经在 values 里。
 */
func fireInsertTriggers(db: SqliteDatabase, table: TableInfo, values: Array<SqliteValue>, timing: String,
    params: Array<SqliteValue>): Bool {
    let row = TriggerRowContext(table, None, 0, Some(values), rowidOfValues(table, values))
    fireTriggers(db, table.name, timing, TRIGGER_EVENT_INSERT, HashSet<String>(), row, params)
}

/** 一行的 rowid: 有别名列取它的值, 否则 0。 */
func rowidOfValues(table: TableInfo, values: Array<SqliteValue>): Int64 {
    if (table.rowidAliasColumn < 0 || table.rowidAliasColumn >= values.size) {
        return 0
    }
    match (values[table.rowidAliasColumn]) {
        case SInt(i) => i
        case _ => 0
    }
}

/**
 * 冲突处置。
 *
 * ABORT (默认) 抛出; IGNORE 跳过本行; REPLACE 删冲突行后重试; UPDATE (upsert) 执行
 * DO UPDATE SET。
 */
func handleInsertConflict(db: SqliteDatabase, table: TableInfo, values: Array<SqliteValue>, stmt: InsertStmt,
    params: Array<SqliteValue>, e: SqliteConstraintException, rowid: Int64, collector: ReturningCollector): Bool {
    match (stmt.conflict) {
        case ConflictAbort => throw e
        case ConflictIgnore =>
            // NOT NULL 与 CHECK 在 OR IGNORE 下也被忽略 —— 与 SQLite 一致。
            false
        case ConflictReplace =>
            // 冲突可能出在 NOT NULL/CHECK 上, 那种 REPLACE 也救不了。
            if (e.constraint == "notnull" || e.constraint == "check" || e.constraint == "datatype") {
                throw e
            }
            let finalRowid = if (table.withoutRowid) {
                0
            } else if (rowid != 0) {
                rowid
            } else {
                resolveRowid(db, table, values)
            }
            if (table.rowidAliasColumn >= 0) {
                values[table.rowidAliasColumn] = SqliteValue.SInt(finalRowid)
            }
            deleteConflictingRows(db, table, values, finalRowid)
            checkRowConstraints(db, table, values, params)
            writeRow(db, table, finalRowid, values, true)
            if (!table.withoutRowid) {
                db.lastInsertRowid = finalRowid
            }
            collector.record(finalRowid, values)
            true
        case ConflictUpdate =>
            if (e.constraint == "notnull" || e.constraint == "check" || e.constraint == "datatype") {
                throw e
            }
            applyUpsertUpdate(db, table, values, stmt, params, collector)
    }
}

/**
 * ON CONFLICT … DO UPDATE。
 *
 * 找到冲突的那一行, 对它执行 SET。SET 表达式里的 `excluded.col` 指本次要插入的值 ——
 * 这是 upsert 的关键: 没有它就无法表达"用新值更新旧行"。
 */
func applyUpsertUpdate(db: SqliteDatabase, table: TableInfo, newValues: Array<SqliteValue>, stmt: InsertStmt,
    params: Array<SqliteValue>, collector: ReturningCollector): Bool {
    let conflict = findConflictingRow(db, table, newValues, resolveRowidForProbe(db, table, newValues))
    let existing = match (conflict) {
        case Some(r) => r
        case None => throw SqliteRuntimeException("sql",
            "ON CONFLICT DO UPDATE could not locate the conflicting row in ${table.name}")
    }
    let existingRowid = existing.rowid
    let cursor = tableCursor(db.pager, table)
    if (!seekTableRow(cursor, table, existing)) {
        throw SqliteRuntimeException("sql", "conflicting row disappeared from ${table.name}")
    }
    let oldValues = decodeTableRow(table, cursor)
    let updated = Array<SqliteValue>(oldValues.size, repeat: SqliteValue.SNull)
    for (i in 0..oldValues.size) {
        updated[i] = oldValues[i]
    }
    // 求值上下文里放两个源: 表自身 (旧值) 与 excluded (新值)。
    let ctx = EvalContext(db, params)
    let names = Array<String>(table.columns.size, repeat: "")
    for (i in 0..table.columns.size) {
        names[i] = table.columns[i].name
    }
    let tableSrc = RowSource(table.name, names, Some(table))
    tableSrc.values = oldValues
    tableSrc.rowid = existingRowid
    ctx.addSource(tableSrc)
    let excludedSrc = RowSource("excluded", names, Some(table))
    excludedSrc.values = newValues
    // 只认 `excluded.col`: 未限定的列名要解析到目标表的旧值 (SQLite 的规则)。
    excludedSrc.qualifiedOnly = true
    ctx.addSource(excludedSrc)
    if (let Some(w) <- stmt.upsertWhere) {
        match (valueToTristate(evalExpr(ctx, w))) {
            case Some(true) => ()
            case _ => return false
        }
    }
    for ((colName, valueExpr) in stmt.upsertSets) {
        let idx = table.columnIndexOf(colName)
        if (idx < 0) {
            throw SqliteRuntimeException("sql", "table ${table.name} has no column named ${colName}")
        }
        updated[idx] = applyAffinity(evalExpr(ctx, valueExpr), table.columns[idx].affinity)
    }
    var newRowid = existingRowid
    if (table.rowidAliasColumn >= 0) {
        newRowid = valueToInt(updated[table.rowidAliasColumn])
        updated[table.rowidAliasColumn] = SqliteValue.SInt(newRowid)
    }
    checkRowConstraints(db, table, updated, params)
    checkPrimaryKeyCollision(db, table, updated, Some(existing))
    checkUniqueConstraints(db, table, updated, Some(existing))
    replaceRowInPlace(db, table, existing, oldValues, newRowid, updated)
    // upsert 返回被更新的冲突行，其 rowid 和最终值可能都不同于待插入行。
    collector.record(newRowid, updated)
    true
}

/** upsert 探测用的 rowid: 别名列有值时用它, 否则用 0 (表示"待分配", 不参与冲突判定)。 */
func resolveRowidForProbe(db: SqliteDatabase, table: TableInfo, values: Array<SqliteValue>): Int64 {
    let _ = db
    if (table.rowidAliasColumn < 0) {
        return 0
    }
    match (values[table.rowidAliasColumn]) {
        case SInt(i) => i
        case SNull => 0
        case v => valueToInt(v)
    }
}

/**
 * 定这一行的 rowid。
 *
 * 三种来源: 别名列给了显式值; AUTOINCREMENT 从 sqlite_sequence 取下一个; 普通表取
 * max(rowid)+1。
 *
 * AUTOINCREMENT 与普通 rowid 的区别在于删行后: 普通表会**复用**被删的最大 rowid,
 * AUTOINCREMENT 不复用 (sqlite_sequence 只增)。混淆二者会让外部引用指向新插入的不同行。
 */
func resolveRowid(db: SqliteDatabase, table: TableInfo, values: Array<SqliteValue>): Int64 {
    if (table.rowidAliasColumn >= 0) {
        let v = values[table.rowidAliasColumn]
        match (v) {
            case SNull => ()
            case SInt(i) => return i
            case SReal(f) =>
                // 整数值的浮点可以当 rowid (5.0 → 5); 有小数部分则不行。
                let i = floatToInt(f)
                if (Float64(i) == f) {
                    return i
                }
                throw SqliteConstraintException("datatype", table.name,
                    "datatype mismatch: INTEGER PRIMARY KEY column ${table.columns[table.rowidAliasColumn].name} cannot hold ${formatReal(f)}")
            case _ =>
                // 文本/BLOB 存进 INTEGER PRIMARY KEY: SQLite 报 datatype mismatch。
                throw SqliteConstraintException("datatype", table.name,
                "datatype mismatch: INTEGER PRIMARY KEY column ${table.columns[table.rowidAliasColumn].name} requires an integer")
        }
    }
    if (table.autoincrement) {
        return nextAutoincrementRowid(db, table)
    }
    let maxRowid = btreeMaxRowid(db.pager, table.rootPage)
    if (maxRowid == Int64.Max) {
        // 空间已满。SQLite 会去找空隙, 这里直接报错 —— 找空隙需要全表扫, 且这种库已经异常。
        throw SqliteRuntimeException("insert",
            "cannot allocate a new rowid for ${table.name}: the largest rowid is already Int64.Max")
    }
    maxRowid + 1
}

/** AUTOINCREMENT 的下一个 rowid: max(sqlite_sequence 记录值, 表内最大值) + 1。 */
func nextAutoincrementRowid(db: SqliteDatabase, table: TableInfo): Int64 {
    ensureSequenceTable(db)
    let recorded = readSequence(db, table.name)
    let actual = btreeMaxRowid(db.pager, table.rootPage)
    // 取两者较大: 记录值可能落后 (旧版写的库), 表内值可能落后 (删过行)。
    var base = if (recorded > actual) {
        recorded
    } else {
        actual
    }
    if (base == Int64.Max) {
        throw SqliteConstraintException("primarykey", table.name,
            "AUTOINCREMENT sequence for ${table.name} is exhausted")
    }
    base += 1
    writeSequence(db, table.name, base)
    base
}

/*
 * 约束检查。
 */

/** NOT NULL 与 CHECK。UNIQUE 另走 checkUniqueConstraints (它要查索引)。 */
func checkRowConstraints(db: SqliteDatabase, table: TableInfo, values: Array<SqliteValue>, params: Array<SqliteValue>): Unit {
    for (i in 0..table.columns.size) {
        let col = table.columns[i]
        if (!col.notNull) {
            continue
        }
        match (values[i]) {
            case SNull => throw SqliteConstraintException("notnull", table.name,
                "NOT NULL constraint failed: ${table.name}.${col.name}")
            case _ => ()
        }
    }
    // rowid 别名列隐含 NOT NULL (它是主键), 但值已由 resolveRowid 填好, 无需再查。
    let hasChecks = !table.checks.isEmpty() || anyColumnCheck(table)
    if (!hasChecks) {
        return
    }
    let ctx = EvalContext(db, params)
    let names = Array<String>(table.columns.size, repeat: "")
    for (i in 0..table.columns.size) {
        names[i] = table.columns[i].name
    }
    let src = RowSource(table.name, names, Some(table))
    src.values = values
    ctx.addSource(src)
    for (i in 0..table.columns.size) {
        if (let Some(chk) <- table.columns[i].checkExpr) {
            // CHECK 为 NULL 时视为通过 —— 这是 SQL 标准, 也是 SQLite 的行为。
            match (valueToTristate(evalExpr(ctx, chk))) {
                case Some(false) => throw SqliteConstraintException("check", table.name,
                    "CHECK constraint failed on ${table.name}.${table.columns[i].name}")
                case _ => ()
            }
        }
    }
    for (chk in table.checks) {
        match (valueToTristate(evalExpr(ctx, chk))) {
            case Some(false) => throw SqliteConstraintException("check", table.name,
                "CHECK constraint failed: ${table.name}")
            case _ => ()
        }
    }
}

func anyColumnCheck(table: TableInfo): Bool {
    for (c in table.columns) {
        if (let Some(_) <- c.checkExpr) {
            return true
        }
    }
    false
}

/**
 * UNIQUE 检查。
 *
 * 走索引而不是全表扫: UNIQUE 约束必定有对应的索引 (自动索引或显式的), 查索引是 O(log n)。
 *
 * excludeRowid 是"本次更新的目标行", 它自己的旧键不算冲突 —— 不排除的话
 * `UPDATE t SET x = x` 会撞上自己。
 */
/**
 * rowid 已被占用的检查。
 *
 * 必须在这一层查, 不能等 btree 写入时才发现: `btreeInsertRow` 抛的同一个约束异常在
 * insertOneRow 的 try 之外, 于是 OR IGNORE / OR REPLACE 的冲突处置根本接不到它 ——
 * `INSERT OR IGNORE` 撞 INTEGER PRIMARY KEY 时会抛异常而不是跳过该行。
 *
 * checkUniqueConstraints 覆盖不到这里: 它只遍历索引, 而 rowid 别名列 (INTEGER PRIMARY
 * KEY) 不建索引 —— 它就是 B-tree 的键本身。
 *
 * 报错文本与 SQLite 对齐 (UNIQUE constraint failed: t.id), 让按消息分辨的调用方一致。
 */
func checkRowidCollision(db: SqliteDatabase, table: TableInfo, rowid: Int64): Unit {
    if (table.rowidAliasColumn < 0) {
        // 无别名列时 rowid 由引擎分配, 取的是 max+1, 不会撞。
        return
    }
    let probe = BtreeCursor(db.pager, table.rootPage, true)
    if (probe.seekRowid(rowid)) {
        throw SqliteConstraintException("primarykey", table.name,
            "UNIQUE constraint failed: ${table.name}.${table.columns[table.rowidAliasColumn].name}")
    }
}

/** WITHOUT ROWID 表的主键由表树自身保证唯一。 */
func checkPrimaryKeyCollision(db: SqliteDatabase, table: TableInfo, values: Array<SqliteValue>,
    exclude: Option<RowLocator>): Unit {
    if (!table.withoutRowid) {
        return
    }
    let locator = locatorForValues(table, 0, values)
    let probe = tableCursor(db.pager, table)
    if (!seekTableRow(probe, table, locator)) {
        return
    }
    if (let Some(own) <- exclude) {
        if (sameLocator(table, locator, own)) {
            return
        }
    }
    let spec = table.requireRowKey()
    let names = StringBuilder()
    for (i in 0..spec.keyColumns.size) {
        if (i > 0) {
            names.append(", ${table.name}.")
        }
        names.append(table.columns[spec.keyColumns[i]].name)
    }
    throw SqliteConstraintException("primarykey", table.name,
        "UNIQUE constraint failed: ${table.name}.${names.toString()}")
}

func checkUniqueConstraints(db: SqliteDatabase, table: TableInfo, values: Array<SqliteValue>,
    exclude: Option<RowLocator>): Unit {
    for (index in table.indexes) {
        if (!index.unique) {
            continue
        }
        if (let Some(cond) <- index.whereExpr) {
            // 部分索引: 不满足条件的行不进索引, 也不受唯一约束。
            if (!evalIndexPredicate(db, table, values, cond)) {
                continue
            }
        }
        // 键含 NULL 时不参与唯一判定 —— SQL 里 NULL 不等于 NULL, 多行 NULL 合法。
        var hasNull = false
        let key = ArrayList<SqliteValue>()
        for (ci in index.columnIndexes) {
            match (values[ci]) {
                case SNull => hasNull = true
                case _ => ()
            }
            key.add(values[ci])
        }
        if (hasNull) {
            continue
        }
        match (findIndexKeyOwner(db, table, index, key.toArray())) {
            case Some(owner) =>
                let isOwnRow = match (exclude) {
                    case Some(own) => sameLocator(table, owner, own)
                    case None => false
                }
                if (!isOwnRow) {
                    throw SqliteConstraintException("unique", table.name,
                        "UNIQUE constraint failed: ${describeIndexColumns(index)}")
                }
            case None => ()
        }
    }
}

/**
 * 查索引里是否已有这个键, 返回持有它的表行身份。
 *
 * 索引键的存储形态是 (列值…, rowid), 所以按列值前缀定位后, 命中的第一条的末列就是 rowid。
 */
func findIndexKeyOwner(db: SqliteDatabase, table: TableInfo, index: IndexInfo, key: Array<SqliteValue>): Option<RowLocator> {
    let keyColumnCount = indexStoredColumnCount(table, index)
    let (colls, descs) = indexKeyMeta(table, index)
    let cursor = BtreeCursor(db.pager, index.rootPage, false)
    let _ = cursor.seekIndex(key, colls, descs)
    if (!cursor.isValid) {
        return None
    }
    let found = decodeRecord(cursor.currentPayload(), keyColumnCount)
    for (i in 0..key.size) {
        if (i >= found.size) {
            return None
        }
        if (compareValues(found[i], key[i], colls[i]) != CMP_EQ) {
            return None
        }
    }
    Some(locatorFromIndexKey(table, index, found))
}

/** 找与这一行冲突的既有行 (表主键冲突优先, 其次 UNIQUE 索引)。 */
func findConflictingRow(db: SqliteDatabase, table: TableInfo, values: Array<SqliteValue>, rowid: Int64): Option<RowLocator> {
    if (table.withoutRowid) {
        let locator = locatorForValues(table, 0, values)
        let cursor = tableCursor(db.pager, table)
        if (seekTableRow(cursor, table, locator)) {
            return Some(locator)
        }
    } else if (rowid != 0) {
        let cursor = tableCursor(db.pager, table)
        if (cursor.seekRowid(rowid)) {
            return Some(rowidLocator(rowid))
        }
    }
    for (index in table.indexes) {
        if (!index.unique) {
            continue
        }
        if (let Some(cond) <- index.whereExpr) {
            // 部分唯一索引只约束谓词为真的行; 其余行没有冲突对象。
            if (!evalIndexPredicate(db, table, values, cond)) {
                continue
            }
        }
        var hasNull = false
        let key = ArrayList<SqliteValue>()
        for (ci in index.columnIndexes) {
            match (values[ci]) {
                case SNull => hasNull = true
                case _ => ()
            }
            key.add(values[ci])
        }
        if (hasNull) {
            continue
        }
        if (let Some(owner) <- findIndexKeyOwner(db, table, index, key.toArray())) {
            return Some(owner)
        }
    }
    None
}

/** OR REPLACE: 删掉所有与本行冲突的既有行。 */
func deleteConflictingRows(db: SqliteDatabase, table: TableInfo, values: Array<SqliteValue>, rowid: Int64): Unit {
    let victims = ArrayList<RowLocator>()
    let primary = locatorForValues(table, rowid, values)
    let cursor = tableCursor(db.pager, table)
    if (seekTableRow(cursor, table, primary)) {
        victims.add(primary)
    }
    for (index in table.indexes) {
        if (!index.unique) {
            continue
        }
        if (let Some(cond) <- index.whereExpr) {
            if (!evalIndexPredicate(db, table, values, cond)) {
                continue
            }
        }
        var hasNull = false
        let key = ArrayList<SqliteValue>()
        for (ci in index.columnIndexes) {
            match (values[ci]) {
                case SNull => hasNull = true
                case _ => ()
            }
            key.add(values[ci])
        }
        if (hasNull) {
            continue
        }
        if (let Some(owner) <- findIndexKeyOwner(db, table, index, key.toArray())) {
            if (!containsLocator(table, victims, owner)) {
                victims.add(owner)
            }
        }
    }
    for (v in victims) {
        let _ = deleteRow(db, table, v)
    }
}

func containsLocator(table: TableInfo, locators: ArrayList<RowLocator>, wanted: RowLocator): Bool {
    for (locator in locators) {
        if (sameLocator(table, locator, wanted)) {
            return true
        }
    }
    false
}

/*
 * 底层写入: 表与索引一起动。
 */

/** 写一行 (表 + 全部索引)。 */
func writeRow(db: SqliteDatabase, table: TableInfo, rowid: Int64, values: Array<SqliteValue>, replaceExisting: Bool): Unit {
    if (table.withoutRowid) {
        let spec = table.requireRowKey()
        btreeInsertIndexPayload(db.pager, table.rootPage, rowKeyOf(spec, values), encodeWithoutRowidRow(spec, values),
            spec.keyCollations, spec.keyDescs, replaceExisting)
    } else {
        let payload = encodeRowValues(table, values)
        btreeInsertRow(db.pager, table.rootPage, rowid, payload, replaceExisting)
    }
    for (index in table.indexes) {
        insertIndexEntry(db, table, index, values, rowid)
    }
}

func insertIndexEntry(db: SqliteDatabase, table: TableInfo, index: IndexInfo, values: Array<SqliteValue>, rowid: Int64): Unit {
    if (let Some(cond) <- index.whereExpr) {
        if (!evalIndexPredicate(db, table, values, cond)) {
            return
        }
    }
    let key = buildIndexKey(index, table, values, rowid)
    let (colls, descs) = indexKeyMeta(table, index)
    btreeInsertIndexKey(db.pager, index.rootPage, key, colls, descs)
}

func deleteIndexEntry(db: SqliteDatabase, table: TableInfo, index: IndexInfo, values: Array<SqliteValue>, rowid: Int64): Unit {
    if (let Some(cond) <- index.whereExpr) {
        if (!evalIndexPredicate(db, table, values, cond)) {
            return
        }
    }
    let key = buildIndexKey(index, table, values, rowid)
    let (colls, descs) = indexKeyMeta(table, index)
    let _ = btreeDeleteIndexKey(db.pager, index.rootPage, key, colls, descs)
}

/**
 * 删一行 (表 + 全部索引)。返回是否删到。
 *
 * 不在这里处置外键: 它同时被 CASCADE 的递归路径调用, 在里面再触发一次父表方向的处置会
 * 让级联走两遍。父表方向由 executeDelete 与 cascadeDeleteChildRow 各自在删之前调一次。
 */
func deleteRowByRowid(db: SqliteDatabase, table: TableInfo, rowid: Int64): Bool {
    deleteRow(db, table, rowidLocator(rowid))
}

func deleteRow(db: SqliteDatabase, table: TableInfo, locator: RowLocator): Bool {
    let cursor = tableCursor(db.pager, table)
    if (!seekTableRow(cursor, table, locator)) {
        return false
    }
    let values = decodeTableRow(table, cursor)
    for (index in table.indexes) {
        deleteIndexEntry(db, table, index, values, locator.rowid)
    }
    if (table.withoutRowid) {
        let spec = table.requireRowKey()
        btreeDeleteIndexKey(db.pager, table.rootPage, locator.key, spec.keyCollations, spec.keyDescs)
    } else {
        btreeDeleteRow(db.pager, table.rootPage, locator.rowid)
    }
}

/**
 * 原地替换一行。
 *
 * rowid 变了要先删旧行再插新行 —— 不能只覆盖 payload, 因为 rowid 是 B-tree 的键。
 * 索引项无论 rowid 是否变都要删旧插新: 索引键含 rowid, 也含列值, 两者任一变了键就变了。
 */
func replaceRowInPlace(db: SqliteDatabase, table: TableInfo, oldLocator: RowLocator, oldValues: Array<SqliteValue>,
    newRowid: Int64, newValues: Array<SqliteValue>): Unit {
    for (index in table.indexes) {
        deleteIndexEntry(db, table, index, oldValues, oldLocator.rowid)
    }
    if (table.withoutRowid) {
        let spec = table.requireRowKey()
        let _ = btreeDeleteIndexKey(db.pager, table.rootPage, oldLocator.key, spec.keyCollations, spec.keyDescs)
        btreeInsertIndexPayload(db.pager, table.rootPage, rowKeyOf(spec, newValues),
            encodeWithoutRowidRow(spec, newValues), spec.keyCollations, spec.keyDescs, false)
    } else {
        if (newRowid != oldLocator.rowid) {
            let _ = btreeDeleteRow(db.pager, table.rootPage, oldLocator.rowid)
        }
        let payload = encodeRowValues(table, newValues)
        btreeInsertRow(db.pager, table.rootPage, newRowid, payload, true)
    }
    for (index in table.indexes) {
        insertIndexEntry(db, table, index, newValues, newRowid)
    }
}

/*
 * UPDATE。
 */
func executeUpdate(db: SqliteDatabase, stmt: UpdateStmt, params: Array<SqliteValue>): DmlOutcome {
    let table = requireWritableTable(db, stmt.tableName)
    // SET 的目标列先解析: 列名写错要在扫表之前报, 而不是扫到第一行才报。
    let assignments = ArrayList<(Int64, Expr)>()
    for ((colName, valueExpr) in stmt.sets) {
        let idx = table.columnIndexOf(colName)
        if (idx < 0) {
            throw SqliteRuntimeException("sql", "table ${table.name} has no column named ${colName}")
        }
        assignments.add((idx, valueExpr))
    }
    let expressions = ArrayList<Expr>()
    if (let Some(w) <- stmt.whereExpr) {
        expressions.add(w)
    }
    for ((_, valueExpr) in stmt.sets) {
        expressions.add(valueExpr)
    }
    for (term in stmt.orderBy) {
        expressions.add(term.expr)
    }
    validateDmlWithoutRowidReferences(db, table, expressions, params)
    let matched = collectMatchingRows(db, table, stmt.whereExpr, params)
    let targets = limitDmlTargets(db, table, matched, stmt.orderBy, stmt.limit, stmt.offset, params)
    let collector = ReturningCollector(!stmt.returning.isEmpty())
    var affected = 0
    for (target in targets) {
        if (updateOneRow(db, table, target, assignments, stmt.conflict, params, collector)) {
            affected += 1
        }
    }
    db.lastChanges = affected
    db.totalChanges += affected
    let outcome = DmlOutcome()
    outcome.changes = affected
    for (r in collector.rows) {
        outcome.returned.add(r)
    }
    outcome
}

/** 一个待改/待删的行: 稳定行身份 + 旧值。 */
class TargetRow {
    let locator: RowLocator
    let values: Array<SqliteValue>

    prop rowid: Int64 {
        get() {
            locator.rowid
        }
    }

    init(locator: RowLocator, values: Array<SqliteValue>) {
        this.locator = locator
        this.values = values
    }
}

/**
 * 收集满足 WHERE 的行。
 *
 * 全部物化后再改 —— 见文件头第 1 条纪律。这里也接了索引: 单表 UPDATE/DELETE 的 WHERE
 * 通过一条只含该表的 SELECT 走同一套访问路径选择。
 */
func collectMatchingRows(db: SqliteDatabase, table: TableInfo, whereExpr: Option<Expr>, params: Array<SqliteValue>): ArrayList<TargetRow> {
    let out = ArrayList<TargetRow>()
    let ctx = EvalContext(db, params)
    let names = Array<String>(table.columns.size, repeat: "")
    for (i in 0..table.columns.size) {
        names[i] = table.columns[i].name
    }
    let src = RowSource(table.name, names, Some(table))
    ctx.addSource(src)
    // 造一条等价的单表 SELECT, 让 planTableAccess 能看到 WHERE 并挑索引。
    let probe = SelectStmt()
    probe.columns.add(ResultColumn(StarExpr(""), ""))
    probe.from.add(JoinClause(TableRef(table.name, "", None), JoinKind.JoinInner, None, ArrayList<String>()))
    probe.whereExpr = whereExpr
    ctx.currentStatement = Some(probe)
    let clause = probe.from[0]
    forEachSourceRow(ctx, clause, src, 0) {
        =>
            let holds = match (whereExpr) {
                case None => true
                case Some(w) => match (valueToTristate(evalExpr(ctx, w))) {
                    case Some(true) => true
                    case _ => false
                }
            }
            if (holds) {
                let snapshot = Array<SqliteValue>(src.values.size, repeat: SqliteValue.SNull)
                for (i in 0..src.values.size) {
                    snapshot[i] = src.values[i]
                }
                out.add(TargetRow(locatorForValues(table, src.rowid, snapshot), snapshot))
            }
            true
    }
    out
}

/**
 * 按 ORDER BY 排序并按 LIMIT/OFFSET 裁剪待改/待删的行。
 *
 * 语义等价于 `… WHERE rowid IN (SELECT rowid … ORDER BY … LIMIT n OFFSET m)`, 这也是
 * SQLite 文档给出的等价形式。**必须先排再裁**: 反过来是"先取任意 n 行再排",
 * 与 SELECT 里 LIMIT 与 ORDER BY 的先后陷阱是同一个。
 *
 * 无 ORDER BY 时按 rowid 升序裁剪 (见 sortTargetsByRowid, **不能**直接用收集顺序)。
 * SQLite 在这种形态下不保证挑中哪些行, 这里选定为 rowid 序而不是留成不确定 ——
 * 不确定的行为没法测, 也没法让调用方复现问题。
 *
 * 注意 LIMIT 表达式在**扫表之后**求值。它不能引用被改的列 (语法上也没有列可引用),
 * 所以求值时机不影响结果, 但求值必须发生在 collectMatchingRows 之后, 因为参数绑定
 * 是同一批 params。
 */
func limitDmlTargets(db: SqliteDatabase, table: TableInfo, targets: ArrayList<TargetRow>, orderBy: ArrayList<OrderTerm>,
    limitExpr: Option<Expr>, offsetExpr: Option<Expr>, params: Array<SqliteValue>): ArrayList<TargetRow> {
    let limitAst = match (limitExpr) {
        case Some(e) => e
        case None => return targets
    }
    let ordered = if (orderBy.isEmpty()) {
        sortTargetsByTableKey(table, targets)
    } else {
        sortDmlTargets(db, table, targets, orderBy, params)
    }
    let ctx = EvalContext(db, params)
    var limit = match (evalExpr(ctx, limitAst)) {
        case SNull => -1
        case v => valueToInt(coerceNumeric(v))
    }
    // 负 LIMIT 在 SQLite 里表示"不限"; 与 SELECT 的 applyLimitOffset 保持一致。
    if (limit < 0) {
        limit = ordered.size
    }
    var offset = 0
    if (let Some(oe) <- offsetExpr) {
        offset = match (evalExpr(ctx, oe)) {
            case SNull => 0
            case v => valueToInt(coerceNumeric(v))
        }
        if (offset < 0) {
            offset = 0
        }
    }
    let kept = ArrayList<TargetRow>()
    var i = offset
    while (i < ordered.size && kept.size < limit) {
        kept.add(ordered[i])
        i += 1
    }
    kept
}

/**
 * 无 ORDER BY 的 LIMIT 按 rowid 升序裁剪。
 *
 * `collectMatchingRows` 的产出顺序由访问路径决定：索引扫描采用索引序，全表扫描采用 rowid 序。
 * 无 ORDER BY 时必须先恢复表键顺序再裁剪，避免索引是否存在改变被修改或删除的行。
 *
 * 键直接取 `target.rowid`, 不走表达式求值。走 `ORDER BY rowid` 看起来更直白, 但
 * `rowid` 作为隐式列只在**没有同名真实列**时生效 —— 表里真有一列叫 rowid 时就会排错列。
 * 传给 sortedIndexes 的 OrderTerm 只用到 desc/nullsFirst, 其 expr 是占位符。
 */
func sortTargetsByTableKey(table: TableInfo, targets: ArrayList<TargetRow>): ArrayList<TargetRow> {
    if (targets.size < 2) {
        return targets
    }
    let keys = ArrayList<Array<SqliteValue>>()
    for (target in targets) {
        keys.add(if (table.withoutRowid) {
            target.locator.key
        } else {
            [SqliteValue.SInt(target.rowid)]
        })
    }
    let terms = ArrayList<OrderTerm>()
    let colls: Array<SqliteCollation>
    if (table.withoutRowid) {
        let spec = table.requireRowKey()
        for (i in 0..spec.keyArity) {
            terms.add(OrderTerm(ColumnExpr("", table.columns[spec.keyColumns[i]].name), spec.keyDescs[i], true, ""))
        }
        colls = spec.keyCollations
    } else {
        terms.add(OrderTerm(ColumnExpr("", "rowid"), false, true, ""))
        colls = [SqliteCollation.CollBinary]
    }
    let out = ArrayList<TargetRow>()
    for (idx in sortedIndexes(keys, terms, colls)) {
        out.add(targets[idx])
    }
    out
}

/** 按 ORDER BY 项排序待改/待删的行。复用 SELECT 的稳定归并排序与比较规则。 */
func sortDmlTargets(db: SqliteDatabase, table: TableInfo, targets: ArrayList<TargetRow>, orderBy: ArrayList<OrderTerm>,
    params: Array<SqliteValue>): ArrayList<TargetRow> {
    let ctx = EvalContext(db, params)
    let names = Array<String>(table.columns.size, repeat: "")
    for (i in 0..table.columns.size) {
        names[i] = table.columns[i].name
    }
    let src = RowSource(table.name, names, Some(table))
    ctx.addSource(src)
    let colls = Array<SqliteCollation>(orderBy.size, repeat: SqliteCollation.CollBinary)
    for (i in 0..orderBy.size) {
        colls[i] = orderTermCollation(ctx, orderBy[i], -1, ResultSet(Array<String>(), ArrayList<Array<SqliteValue>>()))
    }
    let keys = ArrayList<Array<SqliteValue>>()
    for (target in targets) {
        // 排序键在**旧值**上求值: ORDER BY 决定的是"哪些行被选中", 而选中发生在改写之前。
        for (i in 0..src.values.size) {
            src.values[i] = target.values[i]
        }
        src.rowid = target.rowid
        let key = Array<SqliteValue>(orderBy.size, repeat: SqliteValue.SNull)
        for (i in 0..orderBy.size) {
            key[i] = evalExpr(ctx, orderBy[i].expr)
        }
        keys.add(key)
    }
    let out = ArrayList<TargetRow>()
    for (idx in sortedIndexes(keys, orderBy, colls)) {
        out.add(targets[idx])
    }
    out
}

/**
 * 把 SET 施加到一行上, 返回新值。
 *
 * SET 右侧看到的是**旧值**: `SET a = b, b = a` 应交换而不是让两列都变成 b 的旧值。
 *
 * BEFORE UPDATE 触发器可能修改目标行。触发后需要重新读取该行并再次应用 SET，才能保留
 * 触发器对未被 SET 覆盖字段的修改。
 */
func applyAssignments(db: SqliteDatabase, table: TableInfo, rowid: Int64, oldValues: Array<SqliteValue>,
    assignments: ArrayList<(Int64, Expr)>, params: Array<SqliteValue>): Array<SqliteValue> {
    let newValues = Array<SqliteValue>(oldValues.size, repeat: SqliteValue.SNull)
    for (i in 0..oldValues.size) {
        newValues[i] = oldValues[i]
    }
    let ctx = EvalContext(db, params)
    let names = Array<String>(table.columns.size, repeat: "")
    for (i in 0..table.columns.size) {
        names[i] = table.columns[i].name
    }
    let src = RowSource(table.name, names, Some(table))
    src.values = oldValues
    src.rowid = rowid
    ctx.addSource(src)
    for ((idx, valueExpr) in assignments) {
        let col = table.columns[idx]
        let raw = evalExpr(ctx, valueExpr)
        newValues[idx] = if (col.isRowidAlias) {
            raw
        } else {
            applyAffinity(raw, col.affinity)
        }
    }
    newValues
}

/** SET 涉及的列名 (小写), 供 `UPDATE OF` 过滤。 */
func assignedColumnNames(table: TableInfo, assignments: ArrayList<(Int64, Expr)>): HashSet<String> {
    let out = HashSet<String>()
    for ((idx, _) in assignments) {
        out.add(table.columns[idx].name.toAsciiLower())
    }
    out
}

func updateOneRow(db: SqliteDatabase, table: TableInfo, target: TargetRow, assignments: ArrayList<(Int64, Expr)>,
    conflict: ConflictAction, params: Array<SqliteValue>, collector: ReturningCollector): Bool {
    // 目标行可能已被本语句的前一次操作删掉 (OR REPLACE 时会发生)。
    let cursor = tableCursor(db.pager, table)
    if (!seekTableRow(cursor, table, target.locator)) {
        return false
    }
    var oldValues = decodeTableRow(table, cursor)
    var newValues = applyAssignments(db, table, target.rowid, oldValues, assignments, params)
    let updatedNames = assignedColumnNames(table, assignments)
    if (db.currentSchema().hasTriggersOn(table.name)) {
        let beforeRow = TriggerRowContext(table, Some(oldValues), target.rowid, Some(newValues), target.rowid)
        if (!fireTriggers(db, table.name, TRIGGER_TIMING_BEFORE, TRIGGER_EVENT_UPDATE, updatedNames, beforeRow, params)) {
            return false
        }
        // BEFORE 触发器可能修改或删除目标行，因此需要重新定位并基于最新值计算更新结果。
        let recheck = tableCursor(db.pager, table)
        if (!seekTableRow(recheck, table, target.locator)) {
            return false
        }
        oldValues = decodeTableRow(table, recheck)
        newValues = applyAssignments(db, table, target.rowid, oldValues, assignments, params)
    }
    var newRowid = target.rowid
    if (table.rowidAliasColumn >= 0) {
        let v = newValues[table.rowidAliasColumn]
        newRowid = match (v) {
            case SNull => throw SqliteConstraintException("notnull", table.name,
                "NOT NULL constraint failed: ${table.name}.${table.columns[table.rowidAliasColumn].name}")
            case SInt(i) => i
            case SReal(f) =>
                let i = floatToInt(f)
                if (Float64(i) != f) {
                    throw SqliteConstraintException("datatype", table.name,
                        "datatype mismatch: INTEGER PRIMARY KEY cannot hold ${formatReal(f)}")
                }
                i
            case _ => throw SqliteConstraintException("datatype", table.name,
                "datatype mismatch: INTEGER PRIMARY KEY requires an integer")
        }
        newValues[table.rowidAliasColumn] = SqliteValue.SInt(newRowid)
    }
    try {
        checkRowConstraints(db, table, newValues, params)
        checkPrimaryKeyCollision(db, table, newValues, Some(target.locator))
        checkUniqueConstraints(db, table, newValues, Some(target.locator))
        if (!table.withoutRowid && newRowid != target.rowid) {
            let probe = tableCursor(db.pager, table)
            if (probe.seekRowid(newRowid)) {
                throw SqliteConstraintException("primarykey", table.name,
                    "UNIQUE constraint failed: ${table.name}.${table.columns[table.rowidAliasColumn].name}")
            }
        }
        checkChildRowForeignKeys(db, table, newValues)
    } catch (e: SqliteConstraintException) {
        match (conflict) {
            case ConflictIgnore => return false
            case ConflictReplace =>
                if (e.constraint == "notnull" || e.constraint == "check" || e.constraint == "datatype") {
                    throw e
                }
                // 冲突行不能是自己 —— 那不是真冲突。
                let victims = ArrayList<RowLocator>()
                if (let Some(owner) <- findConflictingRow(db, table, newValues, newRowid)) {
                    if (!sameLocator(table, owner, target.locator)) {
                        victims.add(owner)
                    }
                }
                for (v in victims) {
                    let _ = deleteRow(db, table, v)
                }
                checkRowConstraints(db, table, newValues, params)
            case _ => throw e
        }
    }
    // 本表可能同时是别人的父表: 改了被引用的键就要按 ON UPDATE 处置子行。
    // 收集在写之前 (子行按旧键找), 施加在写之后 (CASCADE 写进子行的新键要在父表里查得到)。
    let pendingFk = collectParentUpdateActions(db, table, oldValues, newValues)
    replaceRowInPlace(db, table, target.locator, oldValues, newRowid, newValues)
    applyPendingFkActions(db, pendingFk, 0)
    // UPDATE 返回写入**后**的值 (DELETE 返回删除前的), 故记 newValues 而不是 oldValues。
    collector.record(newRowid, newValues)
    let afterRow = TriggerRowContext(table, Some(oldValues), target.rowid, Some(newValues), newRowid)
    let _ = fireTriggers(db, table.name, TRIGGER_TIMING_AFTER, TRIGGER_EVENT_UPDATE, updatedNames, afterRow, params)
    true
}

/*
 * DELETE。
 */
func executeDelete(db: SqliteDatabase, stmt: DeleteStmt, params: Array<SqliteValue>): DmlOutcome {
    let table = requireWritableTable(db, stmt.tableName)
    let expressions = ArrayList<Expr>()
    if (let Some(w) <- stmt.whereExpr) {
        expressions.add(w)
    }
    for (term in stmt.orderBy) {
        expressions.add(term.expr)
    }
    validateDmlWithoutRowidReferences(db, table, expressions, params)
    let matched = collectMatchingRows(db, table, stmt.whereExpr, params)
    let targets = limitDmlTargets(db, table, matched, stmt.orderBy, stmt.limit, stmt.offset, params)
    let collector = ReturningCollector(!stmt.returning.isEmpty())
    var affected = 0
    let hasTriggers = db.currentSchema().hasTriggersOn(table.name)
    for (target in targets) {
        let beforeRow = TriggerRowContext(table, Some(target.values), target.rowid, None, 0)
        if (hasTriggers) {
            if (!fireTriggers(db, table.name, TRIGGER_TIMING_BEFORE, TRIGGER_EVENT_DELETE, HashSet<String>(), beforeRow,
                params)) {
                continue
            }
        }
        // 收集在删之前 (RESTRICT 要在父行还在时判, 子行按旧键找), 施加在删之后 ——
        // ON DELETE SET DEFAULT 的默认值恰好指向本行时, 只有这个顺序才判得出违约。
        let pendingFk = collectParentDeleteActions(db, table, target.values)
        if (deleteRow(db, table, target.locator)) {
            affected += 1
            // DELETE 返回删除**前**的行 —— 删完再取就什么都没有了。
            collector.record(target.rowid, target.values)
            let _ = fireTriggers(db, table.name, TRIGGER_TIMING_AFTER, TRIGGER_EVENT_DELETE, HashSet<String>(),
                beforeRow, params)
        }
        applyPendingFkActions(db, pendingFk, 0)
    }
    db.lastChanges = affected
    db.totalChanges += affected
    let outcome = DmlOutcome()
    outcome.changes = affected
    for (r in collector.rows) {
        outcome.returned.add(r)
    }
    outcome
}

/**
 * DML 的表达式也要在扫表前检查 WITHOUT ROWID 的伪列。
 *
 * SELECT 有完整的 prepare-like 校验; UPDATE/DELETE 若只在实际行上求值, 空表和无命中
 * 的语句会错误地放过 `rowid`。这里建立同一张单表上下文, 复用 SELECT 的递归检查。
 */
func validateDmlWithoutRowidReferences(db: SqliteDatabase, table: TableInfo, expressions: ArrayList<Expr>,
    params: Array<SqliteValue>): Unit {
    if (!table.withoutRowid || expressions.isEmpty()) {
        return
    }
    let ctx = EvalContext(db, params)
    let names = Array<String>(table.columns.size, repeat: "")
    for (i in 0..table.columns.size) {
        names[i] = table.columns[i].name
    }
    ctx.addSource(RowSource(table.name, names, Some(table)))
    for (expr in expressions) {
        validateWithoutRowidRowidExpr(ctx, expr)
    }
}
