package sqlite_driver

import std.collection.*

/*
 * 外键约束的实施。
 *
 * 语义按 SQL 标准的 MATCH SIMPLE, 与 SQLite 一致:
 *   - 子行的外键列**任一为 NULL** 即整条约束免检。这不是宽松, 而是标准规定的语义 ——
 *     NULL 表示"未知", 未知的引用无法判定违约。
 *   - 父行必须由某个 UNIQUE 约束或主键唯一确定。引用一个非唯一列在 SQLite 里是运行期
 *     错误而不是建表期错误 (建表时父表可能还不存在), 本驱动同样推迟到校验时报。
 *
 * 两个方向各查一件事:
 *   - 子表方向 (INSERT / UPDATE 子行): 新值在父表里是否存在。
 *   - 父表方向 (DELETE / UPDATE 父行): 是否还有子行引用旧值, 有则按 ON DELETE /
 *     ON UPDATE 动作处置。
 *
 * 立即约束在语句内校验; 延迟约束 (DEFERRABLE INITIALLY DEFERRED) 攒到 COMMIT 前统一查 ——
 * 后者是唯一需要动事务收尾路径的地方, 见 SqliteDatabase.commit。
 */

/** CASCADE 的递归深度上限, 与 SQLite 的 SQLITE_MAX_TRIGGER_DEPTH 默认值一致。 */
const FK_MAX_CASCADE_DEPTH: Int64 = 1000

/**
 * 一条待校验的延迟约束。
 *
 * 只记"哪张子表的哪条外键、当时的键值是什么", 不记行本身: COMMIT 时行可能已经被后续
 * 语句改过或删掉, 要按那时的状态重查。
 */
class DeferredFkCheck {
    let childTable: String
    let fkIndex: Int64
    let keyValues: Array<SqliteValue>

    init(childTable: String, fkIndex: Int64, keyValues: Array<SqliteValue>) {
        this.childTable = childTable
        this.fkIndex = fkIndex
        this.keyValues = keyValues
    }
}

/**
 * 子表方向: 校验一行的所有外键都指向存在的父行。
 *
 * depth 是 CASCADE 递归的层数, 只用于报错信息里的定位。
 */
func checkChildRowForeignKeys(db: SqliteDatabase, table: TableInfo, values: Array<SqliteValue>): Unit {
    if (!db.foreignKeysEnabled || table.foreignKeys.size == 0) {
        return
    }
    for (i in 0..table.foreignKeys.size) {
        let fk = table.foreignKeys[i]
        let key = childKeyValues(fk, values)
        if (anyNull(key)) {
            // MATCH SIMPLE: 任一列 NULL 即免检。
            continue
        }
        if (fk.deferred) {
            db.deferredFkChecks.add(DeferredFkCheck(table.name, i, key))
            continue
        }
        requireParentRowExists(db, fk, key)
    }
}

/** 取子行里外键列的值。 */
func childKeyValues(fk: ForeignKeyInfo, values: Array<SqliteValue>): Array<SqliteValue> {
    let key = Array<SqliteValue>(fk.childColumns.size, repeat: SqliteValue.SNull)
    for (i in 0..fk.childColumns.size) {
        key[i] = values[fk.childColumns[i]]
    }
    key
}

func anyNull(values: Array<SqliteValue>): Bool {
    for (v in values) {
        if (match (v) {
            case SNull => true;
            case _ => false
        }) {
            return true
        }
    }
    false
}

/** 父行不存在就抛。约束类型标 "foreignkey", 让上层能按类型分辨。 */
func requireParentRowExists(db: SqliteDatabase, fk: ForeignKeyInfo, key: Array<SqliteValue>): Unit {
    if (!parentRowExists(db, fk, key)) {
        throw SqliteConstraintException("foreignkey", fk.childTable,
            "FOREIGN KEY constraint failed: ${fk.childTable}(${joinNames(fk.childColumnNames)}) references ${fk.parentTable}")
    }
}

/**
 * 父表里是否存在键值等于 key 的行。
 *
 * 走全表扫描而不是索引: 父键必须是唯一的 (主键或 UNIQUE), 而唯一约束在本驱动里由自动
 * 索引实现 —— 但索引的键序含 rowid 且列序可能与外键声明的顺序不同, 复用它要先做列序映射。
 * 先做对再做快: 正确性由这里保证, 需要时在 planTableAccess 那一层加索引路径。
 */
func parentRowExists(db: SqliteDatabase, fk: ForeignKeyInfo, key: Array<SqliteValue>): Bool {
    let parent = requireParentTable(db, fk)
    let parentCols = resolveParentColumns(db, fk, parent)
    let cursor = tableCursor(db.pager, parent)
    var ok = cursor.first()
    while (ok) {
        let row = decodeTableRow(parent, cursor)
        if (rowMatchesKey(parent, parentCols, row, key)) {
            return true
        }
        ok = cursor.next()
    }
    false
}

/** 父表必须存在。子表可以先建, 但写子行的那一刻父表必须已经在。 */
func requireParentTable(db: SqliteDatabase, fk: ForeignKeyInfo): TableInfo {
    match (db.currentSchema().findTable(fk.parentTable)) {
        case Some(t) => t
        case None => throw SqliteConstraintException("foreignkey", fk.childTable,
            "FOREIGN KEY constraint failed: ${fk.childTable} references missing table ${fk.parentTable}")
    }
}

/**
 * 父键列序号。声明里省略父列时用父表主键。
 *
 * 父表的主键是 INTEGER PRIMARY KEY (rowid 别名) 时返回它的列序号 —— 那一列的值就是
 * rowid, 按列比较与按 rowid 比较等价。
 */
func resolveParentColumns(db: SqliteDatabase, fk: ForeignKeyInfo, parent: TableInfo): Array<Int64> {
    let _ = db
    if (fk.parentColumns.size > 0) {
        let out = Array<Int64>(fk.parentColumns.size, repeat: -1)
        for (i in 0..fk.parentColumns.size) {
            let idx = parent.columnIndexOf(fk.parentColumns[i])
            if (idx < 0) {
                throw SqliteConstraintException("foreignkey", fk.childTable,
                    "FOREIGN KEY constraint failed: table ${parent.name} has no column ${fk.parentColumns[i]}")
            }
            out[i] = idx
        }
        return out
    }
    if (parent.rowidAliasColumn >= 0) {
        return [parent.rowidAliasColumn]
    }
    if (parent.withoutRowid) {
        return parent.requireRowKey().keyColumns
    }
    if (parent.primaryKeyColumns.size > 0) {
        return parent.primaryKeyColumns
    }
    throw SqliteConstraintException("foreignkey", fk.childTable,
        "FOREIGN KEY constraint failed: table ${parent.name} has no primary key to reference")
}

/** 一行的指定列是否逐个等于 key。比较用父列的 collation。 */
func rowMatchesKey(parent: TableInfo, parentCols: Array<Int64>, row: Array<SqliteValue>, key: Array<SqliteValue>): Bool {
    if (parentCols.size != key.size) {
        return false
    }
    for (i in 0..parentCols.size) {
        let coll = parent.columns[parentCols[i]].collation
        // 亲和性要先对齐: 子列声明 TEXT 而父列声明 INTEGER 时, '1' 与 1 应视为同一个键,
        // 与 SQLite 按父列亲和性比较的行为一致。
        let want = applyAffinity(key[i], parent.columns[parentCols[i]].affinity)
        if (compareValues(row[parentCols[i]], want, coll) != CMP_EQ) {
            return false
        }
    }
    true
}

func joinNames(names: Array<String>): String {
    let sb = StringBuilder()
    for (i in 0..names.size) {
        if (i > 0) {
            sb.append(", ")
        }
        sb.append(names[i])
    }
    sb.toString()
}

/*
 * 父表方向。
 *
 * 分两步走: 先在父行还是旧值时**收集**要处置的子行 (顺便把立即拒绝的动作抛出去), 等父行
 * 写完再**施加**动作。两步不能并成一步, 两个方向各有一个理由:
 *
 *   - ON UPDATE CASCADE: 子行的新键就是父行的新键。父行还没写时施加, 子行自己的外键自检
 *     去父表里找那个新键会找不到, 于是一条合法的级联更新被判违约。
 *   - ON DELETE SET DEFAULT: 默认值恰好指向正在被删的那一行时, 父行还在的状态下自检会
 *     通过, 留下一个引用已删行的子行。
 *
 * 而收集必须在父行改动之前: 子行是按**旧**键值找的。
 */

/** 一条已确定要施加、但还等着父行先落地的引用动作。 */
class PendingFkAction {
    let fk: ForeignKeyInfo
    let action: String
    let child: TableInfo
    let rows: ArrayList<TargetRow>
    /** ON UPDATE CASCADE 要写进子行的新父键; 删除方向用不上。 */
    let newKey: Array<SqliteValue>
    let isDelete: Bool

    init(fk: ForeignKeyInfo, action: String, child: TableInfo, rows: ArrayList<TargetRow>, newKey: Array<SqliteValue>,
        isDelete: Bool) {
        this.fk = fk
        this.action = action
        this.child = child
        this.rows = rows
        this.newKey = newKey
        this.isDelete = isDelete
    }
}

/**
 * 删一个父行前的收集: 按每条引用它的外键的 ON DELETE 动作决定子行怎么处置。
 *
 * RESTRICT 与非延迟的 NO ACTION 在这里就抛 —— 它们要在父行还在的状态下判。
 */
func collectParentDeleteActions(db: SqliteDatabase, parent: TableInfo, parentRow: Array<SqliteValue>): ArrayList<PendingFkAction> {
    let pending = ArrayList<PendingFkAction>()
    if (!db.foreignKeysEnabled) {
        return pending
    }
    for (fk in db.currentSchema().foreignKeysReferencing(parent.name)) {
        let parentCols = resolveParentColumns(db, fk, parent)
        let key = pickColumns(parentRow, parentCols)
        if (anyNull(key)) {
            // 父键含 NULL 的行不可能被任何子行引用 (MATCH SIMPLE 下子行免检)。
            continue
        }
        match (db.currentSchema().findTable(fk.childTable)) {
            case None => ()
            case Some(child) =>
                let rows = childRowsReferencing(db, fk, child, key)
                if (rows.isEmpty()) {
                    continue
                }
                rejectOrDefer(db, fk, fk.onDelete, child, rows)
                if (isDeferredOrRejecting(fk.onDelete)) {
                    continue
                }
                pending.add(PendingFkAction(fk, fk.onDelete, child, rows, key, true))
        }
    }
    pending
}

/**
 * 改一个父行的键值前的收集: 按 ON UPDATE 动作决定子行怎么处置。
 *
 * 键没变的更新不触发任何动作 —— 否则一条无关列的 UPDATE 会把子行级联改掉。
 */
func collectParentUpdateActions(db: SqliteDatabase, parent: TableInfo, oldRow: Array<SqliteValue>,
    newRow: Array<SqliteValue>): ArrayList<PendingFkAction> {
    let pending = ArrayList<PendingFkAction>()
    if (!db.foreignKeysEnabled) {
        return pending
    }
    for (fk in db.currentSchema().foreignKeysReferencing(parent.name)) {
        let parentCols = resolveParentColumns(db, fk, parent)
        let oldKey = pickColumns(oldRow, parentCols)
        let newKey = pickColumns(newRow, parentCols)
        if (keysEqual(parent, parentCols, oldKey, newKey)) {
            continue
        }
        match (db.currentSchema().findTable(fk.childTable)) {
            case None => ()
            case Some(child) =>
                let rows = childRowsReferencing(db, fk, child, oldKey)
                if (rows.isEmpty()) {
                    continue
                }
                rejectOrDefer(db, fk, fk.onUpdate, child, rows)
                if (isDeferredOrRejecting(fk.onUpdate)) {
                    continue
                }
                pending.add(PendingFkAction(fk, fk.onUpdate, child, rows, newKey, false))
        }
    }
    pending
}

/** RESTRICT / NO ACTION 是"不动子行"的两种动作，收集时立即处理，不进入待施加清单。 */
func isDeferredOrRejecting(action: String): Bool {
    action == FK_RESTRICT || action == FK_NO_ACTION
}

/**
 * 立即拒绝, 或把延迟的 NO ACTION 攒进待验清单。
 *
 * RESTRICT 与 NO ACTION 在本驱动的执行时机下都是"立刻抛", 但**不能合并**: 延迟约束下
 * NO ACTION 推到 COMMIT 才查, 而 RESTRICT 无论是否 DEFERRABLE 都立即生效 —— 这正是
 * SQL 标准里两者唯一的区别。合并会让 `DEFERRABLE INITIALLY DEFERRED` 的 NO ACTION 提前
 * 报错, 即"先删父行、同一事务内再删子行"这个合法序列被拒。
 */
func rejectOrDefer(db: SqliteDatabase, fk: ForeignKeyInfo, action: String, child: TableInfo, rows: ArrayList<TargetRow>): Unit {
    if (action == FK_RESTRICT) {
        throw SqliteConstraintException("foreignkey", child.name,
            "FOREIGN KEY constraint failed: ${rows.size} row(s) in ${child.name} still reference ${fk.parentTable}")
    }
    if (action != FK_NO_ACTION) {
        return
    }
    if (!fk.deferred) {
        throw SqliteConstraintException("foreignkey", child.name,
            "FOREIGN KEY constraint failed: ${rows.size} row(s) in ${child.name} still reference ${fk.parentTable}")
    }
    // 延迟: 攒起来等 COMMIT。到那时子行可能已被同一事务的后续语句修好。
    for (row in rows) {
        db.deferredFkChecks.add(DeferredFkCheck(child.name, foreignKeyIndexOf(child, fk), childKeyValues(fk, row.values)))
    }
}

func pickColumns(row: Array<SqliteValue>, cols: Array<Int64>): Array<SqliteValue> {
    let out = Array<SqliteValue>(cols.size, repeat: SqliteValue.SNull)
    for (i in 0..cols.size) {
        out[i] = row[cols[i]]
    }
    out
}

func keysEqual(parent: TableInfo, parentCols: Array<Int64>, a: Array<SqliteValue>, b: Array<SqliteValue>): Bool {
    for (i in 0..parentCols.size) {
        if (compareValues(a[i], b[i], parent.columns[parentCols[i]].collation) != CMP_EQ) {
            return false
        }
    }
    true
}

/** 施加已收集的全部动作。父行此刻已经落地。 */
func applyPendingFkActions(db: SqliteDatabase, pending: ArrayList<PendingFkAction>, depth: Int64): Unit {
    for (p in pending) {
        applyReferentialAction(db, p, depth)
    }
}

/**
 * 施加一条引用动作。到这里只剩真会改子行的三种: CASCADE / SET NULL / SET DEFAULT。
 *
 * SET NULL 与 SET DEFAULT 不能合并: 它们只在列无 DEFAULT 时才碰巧一致。
 *
 * isDelete 区分父行是被删还是被改键: 删时子行跟着删, 改键时 CASCADE 是把新键写进子行。
 *
 * 用 if/else 而不是 match: 仓颉的 match 里裸标识符是**绑定模式**, `case FK_CASCADE =>`
 * 会把 action 绑给一个新名字并匹配一切, 于是三种动作全部走成第一支, 且编译器不报错。
 * 同一陷阱在 parseCellAt (btree_node.cj) 上方也记着。
 */
func applyReferentialAction(db: SqliteDatabase, p: PendingFkAction, depth: Int64): Unit {
    if (depth >= FK_MAX_CASCADE_DEPTH) {
        throw SqliteConstraintException("foreignkey", p.child.name,
            "foreign key cascade exceeded the maximum depth of ${FK_MAX_CASCADE_DEPTH}; the schema probably has a reference cycle")
    }
    let fk = p.fk
    let child = p.child
    if (p.action == FK_CASCADE) {
        if (p.isDelete) {
            for (row in p.rows) {
                cascadeDeleteChildRow(db, child, row, depth)
            }
            return
        }
        for (row in p.rows) {
            let updated = copyRow(row.values)
            for (i in 0..fk.childColumns.size) {
                updated[fk.childColumns[i]] = applyAffinity(p.newKey[i], child.columns[fk.childColumns[i]].affinity)
            }
            cascadeUpdateChildRow(db, child, row, updated, depth)
        }
        return
    }
    if (p.action == FK_SET_NULL) {
        for (row in p.rows) {
            let updated = copyRow(row.values)
            for (i in 0..fk.childColumns.size) {
                updated[fk.childColumns[i]] = SqliteValue.SNull
            }
            cascadeUpdateChildRow(db, child, row, updated, depth)
        }
        return
    }
    if (p.action == FK_SET_DEFAULT) {
        for (row in p.rows) {
            let updated = copyRow(row.values)
            for (i in 0..fk.childColumns.size) {
                let col = child.columns[fk.childColumns[i]]
                updated[fk.childColumns[i]] = columnDefaultValue(db, col)
            }
            cascadeUpdateChildRow(db, child, row, updated, depth)
        }
        return
    }
    throw SqliteRuntimeException("sql", "unknown foreign key action ${p.action}")
}

/** 列的 DEFAULT 值; 没声明 DEFAULT 则为 NULL。 */
func columnDefaultValue(db: SqliteDatabase, col: ColumnInfo): SqliteValue {
    match (col.defaultExpr) {
        case None => SqliteValue.SNull
        case Some(e) =>
            let ctx = EvalContext(db, Array<SqliteValue>())
            applyAffinity(evalExpr(ctx, e), col.affinity)
    }
}

func copyRow(values: Array<SqliteValue>): Array<SqliteValue> {
    let out = Array<SqliteValue>(values.size, repeat: SqliteValue.SNull)
    for (i in 0..values.size) {
        out[i] = values[i]
    }
    out
}

/** 外键在子表清单里的序号, 供延迟校验按序号回查。 */
func foreignKeyIndexOf(child: TableInfo, fk: ForeignKeyInfo): Int64 {
    for (i in 0..child.foreignKeys.size) {
        if (refEq(child.foreignKeys[i], fk)) {
            return i
        }
    }
    0
}

func refEq(a: ForeignKeyInfo, b: ForeignKeyInfo): Bool {
    a.parentTable.toAsciiLower() == b.parentTable.toAsciiLower() && joinNames(a.childColumnNames) == joinNames(
        b.childColumnNames)
}

/** 引用给定父键值的所有子行。 */
func childRowsReferencing(db: SqliteDatabase, fk: ForeignKeyInfo, child: TableInfo, parentKey: Array<SqliteValue>): ArrayList<TargetRow> {
    let out = ArrayList<TargetRow>()
    let cursor = tableCursor(db.pager, child)
    var ok = cursor.first()
    while (ok) {
        let locator = currentRowLocator(child, cursor)
        let row = decodeTableRow(child, cursor)
        let key = childKeyValues(fk, row)
        if (!anyNull(key) && childKeyEquals(child, fk, key, parentKey)) {
            out.add(TargetRow(locator, row))
        }
        ok = cursor.next()
    }
    out
}

/**
 * CASCADE 删一个子行, 并继续向下级联。
 *
 * 深度加一后递归: 子行自己也可能是别人的父行。环由 FK_MAX_CASCADE_DEPTH 拦住 ——
 * 自引用表 (`parent_id REFERENCES self(id) ON DELETE CASCADE`) 是合法且常见的形态,
 * 所以不能靠"访问过就不再访问"来防, 只能靠深度。
 */
func cascadeDeleteChildRow(db: SqliteDatabase, child: TableInfo, row: TargetRow, depth: Int64): Unit {
    // 子行自己可能也是别人的父行, 同样按"收集 → 写 → 施加"的顺序处理。
    let pending = collectParentDeleteActions(db, child, row.values)
    let _ = deleteRow(db, child, row.locator)
    applyPendingFkActions(db, pending, depth + 1)
}

/** CASCADE / SET NULL / SET DEFAULT 改一个子行, 并继续向下级联。 */
func cascadeUpdateChildRow(db: SqliteDatabase, child: TableInfo, row: TargetRow, updated: Array<SqliteValue>,
    depth: Int64): Unit {
    let pending = collectParentUpdateActions(db, child, row.values, updated)
    var newRowid = row.rowid
    if (child.rowidAliasColumn >= 0) {
        newRowid = valueToInt(updated[child.rowidAliasColumn])
    }
    // 改完的子行自己也要满足它自己的外键 —— SET DEFAULT 尤其容易踩: 默认值指向一个不存在
    // 的父行时, 这条 UPDATE 必须失败而不是留下一个违约的行。
    checkChildRowForeignKeys(db, child, updated)
    checkPrimaryKeyCollision(db, child, updated, Some(row.locator))
    checkUniqueConstraints(db, child, updated, Some(row.locator))
    replaceRowInPlace(db, child, row.locator, row.values, newRowid, updated)
    applyPendingFkActions(db, pending, depth + 1)
}

/**
 * COMMIT 前把延迟约束全部查一遍。
 *
 * 按"当时记下的键值"重查而不是重查行: 行可能已被同一事务的后续语句改过或删掉, 那种情况下
 * 约束已经不再违反。这正是延迟约束的用途 —— 允许事务中间态违约。
 */
func verifyDeferredForeignKeys(db: SqliteDatabase): Unit {
    if (db.deferredFkChecks.isEmpty()) {
        return
    }
    let pending = ArrayList<DeferredFkCheck>()
    for (c in db.deferredFkChecks) {
        pending.add(c)
    }
    db.deferredFkChecks.clear()
    for (check in pending) {
        match (db.currentSchema().findTable(check.childTable)) {
            case None => ()
            case Some(child) =>
                if (check.fkIndex >= child.foreignKeys.size) {
                    continue
                }
                let fk = child.foreignKeys[check.fkIndex]
                // 键值当时非 NULL, 但那一行现在可能已经不存在或已改成别的键 —— 所以查的是
                // "还有没有子行仍持这个键", 有才要求父行存在。
                if (childRowsReferencing(db, fk, child, check.keyValues).isEmpty()) {
                    continue
                }
                requireParentRowExists(db, fk, check.keyValues)
        }
    }
}

/** 子键与父键是否相等。按子列的 collation 比 —— 子列才是这次要匹配的一侧。 */
func childKeyEquals(child: TableInfo, fk: ForeignKeyInfo, childKey: Array<SqliteValue>, parentKey: Array<SqliteValue>): Bool {
    if (childKey.size != parentKey.size) {
        return false
    }
    for (i in 0..childKey.size) {
        let coll = child.columns[fk.childColumns[i]].collation
        if (compareValues(childKey[i], parentKey[i], coll) != CMP_EQ) {
            return false
        }
    }
    true
}
