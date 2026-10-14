package sqlite_driver

import std.collection.*

/*
 * DDL 执行: 把 CREATE / DROP / ALTER 落到 sqlite_schema 与 B-tree 上。
 *
 * 每个 DDL 都要做三件事, 缺一不可:
 *   1. 建/删对象自己的 B-tree
 *   2. 增/删/改 sqlite_schema 里的那一行
 *   3. 递增 schema_cookie
 * 漏掉第 3 步不会立刻出错 —— 本连接的缓存是对的 —— 但别的连接不会重载模式,
 * 于是它按旧列数解 record, 新加的列被静默丢掉。
 */

/** 往 sqlite_schema 插一行, 返回它的 rowid。 */
func insertSchemaRow(db: SqliteDatabase, objType: String, name: String, tblName: String, rootPage: Int64, sql: String): Int64 {
    let pager = db.pager
    let rowid = btreeMaxRowid(pager, SCHEMA_ROOT_PAGE) + 1
    let values = Array<SqliteValue>(SCHEMA_COLUMN_COUNT, repeat: SqliteValue.SNull)
    values[0] = SqliteValue.SText(objType)
    values[1] = SqliteValue.SText(name)
    values[2] = SqliteValue.SText(tblName)
    values[3] = SqliteValue.SInt(rootPage)
    values[4] = if (sql.isEmpty()) {
        SqliteValue.SNull
    } else {
        SqliteValue.SText(sql)
    }
    btreeInsertRow(pager, SCHEMA_ROOT_PAGE, rowid, encodeRecord(values), false)
    rowid
}

/** 按 (type, name) 删 sqlite_schema 里的行, 返回删掉几行。 */
func deleteSchemaRows(db: SqliteDatabase, objType: String, name: String): Int64 {
    let lower = name.toAsciiLower()
    let victims = ArrayList<Int64>()
    for (row in readSchemaRows(db.pager)) {
        if (row.objType == objType && row.name.toAsciiLower() == lower) {
            victims.add(row.rowid)
        }
    }
    for (rowid in victims) {
        let _ = btreeDeleteRow(db.pager, SCHEMA_ROOT_PAGE, rowid)
    }
    victims.size
}

/** 删掉某张表名下的所有 index 行 (DROP TABLE 用)。 */
func deleteSchemaIndexRowsFor(db: SqliteDatabase, tableName: String): ArrayList<Int64> {
    let lower = tableName.toAsciiLower()
    let victims = ArrayList<Int64>()
    let roots = ArrayList<Int64>()
    for (row in readSchemaRows(db.pager)) {
        if (row.objType == "index" && row.tblName.toAsciiLower() == lower) {
            victims.add(row.rowid)
            roots.add(row.rootPage)
        }
    }
    for (rowid in victims) {
        let _ = btreeDeleteRow(db.pager, SCHEMA_ROOT_PAGE, rowid)
    }
    roots
}

/** 改一行的 sql 与 name 字段 (ALTER TABLE 用)。 */
func updateSchemaRow(db: SqliteDatabase, rowid: Int64, objType: String, name: String, tblName: String, rootPage: Int64,
    sql: String): Unit {
    let values = Array<SqliteValue>(SCHEMA_COLUMN_COUNT, repeat: SqliteValue.SNull)
    values[0] = SqliteValue.SText(objType)
    values[1] = SqliteValue.SText(name)
    values[2] = SqliteValue.SText(tblName)
    values[3] = SqliteValue.SInt(rootPage)
    values[4] = if (sql.isEmpty()) {
        SqliteValue.SNull
    } else {
        SqliteValue.SText(sql)
    }
    btreeInsertRow(db.pager, SCHEMA_ROOT_PAGE, rowid, encodeRecord(values), true)
}

/** CREATE TABLE。 */
func execCreateTable(db: SqliteDatabase, stmt: CreateTableStmt): Int64 {
    if (stmt.name.toAsciiLower().startsWith("sqlite_")) {
        throw SqliteRuntimeException("schema", "object name reserved for internal use: ${stmt.name}")
    }
    let schema = db.currentSchema()
    if (let Some(_) <- schema.findTable(stmt.name)) {
        if (stmt.ifNotExists) {
            return 0
        }
        throw SqliteRuntimeException("schema", "table ${stmt.name} already exists")
    }
    validateColumnDefinitions(stmt)
    // WITHOUT ROWID 表的 B-tree 是索引树: 行的身份是主键, 没有 rowid 可当键。
    let rootPage = btreeCreate(db.pager, !stmt.withoutRowid)
    let _ = insertSchemaRow(db, "table", stmt.name, stmt.name, rootPage, stmt.sourceSql)
    // UNIQUE 约束与主键各需一个自动索引。名字与 SQLite 一致, 于是它读我们的库时
    // 能把索引对上约束。
    let table = tableInfoFromCreate(stmt, rootPage, stmt.sourceSql)
    // 序号按书写顺序分配 (见 autoIndexSpecs)。名字写进 sqlite_schema, 编号错了 SQLite
    // 会把索引对错约束。
    let specs = autoIndexSpecs(table)
    for (i in 0..specs.size) {
        // WITHOUT ROWID 表的主键占用自动索引序号，但表树本身就是主键索引，无需创建索引树
        // 或写入独立的 schema 行。
        if (stmt.withoutRowid && specs[i].primaryKey) {
            continue
        }
        let indexRoot = btreeCreate(db.pager, false)
        let _ = insertSchemaRow(db, "index", "sqlite_autoindex_${stmt.name}_${i + 1}", stmt.name, indexRoot, "")
    }
    if (table.autoincrement) {
        ensureSequenceTable(db)
    }
    db.bumpSchemaCookie()
    0
}

/**
 * 列定义的合法性检查。
 *
 * 重名列在 SQLite 里是硬错误。不检查的话建表能成功, 但之后所有对该列名的引用都取到
 * 第一个同名列, 第二个列永远读不出来 —— 而且不报错。
 */
func validateColumnDefinitions(stmt: CreateTableStmt): Unit {
    let seen = HashSet<String>()
    for (col in stmt.columns) {
        let lower = col.name.toAsciiLower()
        if (seen.contains(lower)) {
            throw SqliteRuntimeException("schema", "duplicate column name: ${col.name}")
        }
        seen.add(lower)
    }
    var pkCount = 0
    for (col in stmt.columns) {
        if (col.primaryKey) {
            pkCount += 1
        }
    }
    for (tc in stmt.constraints) {
        if (tc.kind == "primarykey") {
            pkCount += 1
            for (name in tc.columns) {
                if (!seen.contains(name.toAsciiLower())) {
                    throw SqliteRuntimeException("schema",
                        "table ${stmt.name} has no column named ${name} for its PRIMARY KEY")
                }
            }
        }
        if (tc.kind == "unique") {
            for (name in tc.columns) {
                if (!seen.contains(name.toAsciiLower())) {
                    throw SqliteRuntimeException("schema",
                        "table ${stmt.name} has no column named ${name} for its UNIQUE constraint")
                }
            }
        }
    }
    if (pkCount > 1) {
        throw SqliteRuntimeException("schema", "table ${stmt.name} has more than one primary key")
    }
    for (col in stmt.columns) {
        if (col.autoincrement && col.typeName.toAsciiUpper() != "INTEGER") {
            throw SqliteRuntimeException("schema", "AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY column")
        }
    }
    if (stmt.withoutRowid) {
        // 两条都照 SQLite 的原话报。无主键这条尤其要拦在建表时: 那种表没有可用的键,
        // 建出来之后每一次插入都无处安放。
        for (col in stmt.columns) {
            if (col.autoincrement) {
                throw SqliteRuntimeException("schema", "AUTOINCREMENT not allowed on WITHOUT ROWID tables")
            }
        }
        if (pkCount == 0) {
            throw SqliteRuntimeException("schema", "PRIMARY KEY missing on table ${stmt.name}")
        }
    }
}

/** CREATE INDEX。建完要把已有行灌进去 —— 空索引会让后续查询漏行。 */
func execCreateIndex(db: SqliteDatabase, stmt: CreateIndexStmt): Int64 {
    let schema = db.currentSchema()
    if (let Some(_) <- schema.findIndex(stmt.name)) {
        if (stmt.ifNotExists) {
            return 0
        }
        throw SqliteRuntimeException("schema", "index ${stmt.name} already exists")
    }
    let table = match (schema.findTable(stmt.tableName)) {
        case Some(t) => t
        case None => throw SqliteRuntimeException("schema", "no such table: ${stmt.tableName}")
    }
    for (colName in stmt.columns) {
        if (table.columnIndexOf(colName) < 0) {
            throw SqliteRuntimeException("schema", "table ${stmt.tableName} has no column named ${colName}")
        }
    }
    let rootPage = btreeCreate(db.pager, false)
    let _ = insertSchemaRow(db, "index", stmt.name, stmt.tableName, rootPage, stmt.sourceSql)
    let info = indexInfoFromCreate(stmt, rootPage, table)
    populateIndex(db, table, info)
    db.bumpSchemaCookie()
    0
}

/**
 * 把表里已有的行灌进新索引。
 *
 * UNIQUE 索引在这里就要查重：已有重复值时 CREATE UNIQUE INDEX 必须失败，否则后续查询
 * 使用不完整索引时会漏行。
 */
func populateIndex(db: SqliteDatabase, table: TableInfo, index: IndexInfo): Unit {
    let pager = db.pager
    let cursor = tableCursor(pager, table)
    var ok = cursor.first()
    while (ok) {
        let locator = currentRowLocator(table, cursor)
        let row = decodeTableRow(table, cursor)
        if (let Some(cond) <- index.whereExpr) {
            if (!evalIndexPredicate(db, table, row, cond)) {
                ok = cursor.next()
                continue
            }
        }
        let key = buildIndexKey(index, table, row, locator.rowid)
        let (colls, descs) = indexKeyMeta(table, index)
        if (index.unique) {
            let probe = key[0..index.columnIndexes.size]
            let indexCursor = BtreeCursor(pager, index.rootPage, false)
            if (indexCursor.seekIndex(probe, colls, descs)) {
                throw SqliteConstraintException("unique", table.name,
                    "UNIQUE constraint failed: ${index.tableName}.${describeIndexColumns(index)}")
            }
        }
        btreeInsertIndexKey(pager, index.rootPage, key, colls, descs)
        ok = cursor.next()
    }
}

func describeIndexColumns(index: IndexInfo): String {
    let sb = StringBuilder()
    for (i in 0..index.columnNames.size) {
        if (i > 0) {
            sb.append(", ${index.tableName}.")
        }
        sb.append(index.columnNames[i])
    }
    sb.toString()
}

/**
 * rowid 表的索引键 = 索引列的值 + rowid。
 *
 * WITHOUT ROWID 表改为追加“未显式出现在索引里的主键列”。两者都同时保证非唯一索引能
 * 容纳重复值，并给回表路径留下完整的行身份。
 */
func buildIndexKey(index: IndexInfo, table: TableInfo, row: Array<SqliteValue>, rowid: Int64): Array<SqliteValue> {
    let key = Array<SqliteValue>(indexStoredColumnCount(table, index), repeat: SqliteValue.SNull)
    for (i in 0..index.columnIndexes.size) {
        key[i] = row[index.columnIndexes[i]]
    }
    if (table.withoutRowid) {
        let appended = appendedPrimaryKeyColumns(table, index)
        for (i in 0..appended.size) {
            key[index.columnIndexes.size + i] = row[appended[i]]
        }
    } else {
        key[index.columnIndexes.size] = SqliteValue.SInt(rowid)
    }
    key
}

/** DROP TABLE: 释放表树与所有索引树, 删掉相关 schema 行。 */
func execDropTable(db: SqliteDatabase, stmt: DropStmt): Int64 {
    let schema = db.currentSchema()
    let table = match (schema.findTable(stmt.name)) {
        case Some(t) => t
        case None =>
            if (stmt.ifExists) {
                return 0
            }
            throw SqliteRuntimeException("schema", "no such table: ${stmt.name}")
    }
    let indexRoots = deleteSchemaIndexRowsFor(db, table.name)
    let _ = deleteSchemaRows(db, "table", table.name)
    // 删除表时同时删除其触发器，避免模式中遗留指向不存在表的 TriggerInfo。
    dropTriggersOn(db, table.name)
    for (root in indexRoots) {
        btreeDestroy(db.pager, root)
    }
    btreeDestroy(db.pager, table.rootPage)
    if (db.hasSequenceTable) {
        removeSequenceEntry(db, table.name)
    }
    db.bumpSchemaCookie()
    0
}

/** DROP INDEX。自动索引不能单独删 —— 它属于 UNIQUE 约束。 */
func execDropIndex(db: SqliteDatabase, stmt: DropStmt): Int64 {
    let schema = db.currentSchema()
    let index = match (schema.findIndex(stmt.name)) {
        case Some(ix) => ix
        case None =>
            if (stmt.ifExists) {
                return 0
            }
            throw SqliteRuntimeException("schema", "no such index: ${stmt.name}")
    }
    if (index.autoIndex) {
        throw SqliteRuntimeException("schema",
            "index ${stmt.name} is an automatic index created by a UNIQUE constraint and cannot be dropped")
    }
    let _ = deleteSchemaRows(db, "index", index.name)
    btreeDestroy(db.pager, index.rootPage)
    db.bumpSchemaCookie()
    0
}

/**
 * ALTER TABLE。
 *
 * 四种形态都靠"改写存下来的 DDL 文本"实现, 与 SQLite 一致 —— 因为列信息只存在 sql 列里。
 * ADD COLUMN 不改动任何已有行: 旧行的 record 字段数比新列数少, 解码时按新列的常量 DEFAULT
 * 补齐 (record_codec.cj 的 decodeRecordWithDefaults)。DROP COLUMN 反过来必须重写每一行
 * (多出来的字段不会被自动忽略), 落在 schema_drop_column.cj。
 */
func execAlterTable(db: SqliteDatabase, stmt: AlterTableStmt): Int64 {
    let schema = db.currentSchema()
    let table = match (schema.findTable(stmt.tableName)) {
        case Some(t) => t
        case None => throw SqliteRuntimeException("schema", "no such table: ${stmt.tableName}")
    }
    let row = findSchemaRowFor(db, "table", table.name)
    if (stmt.action == "rename") {
        if (let Some(_) <- schema.findTable(stmt.newName)) {
            throw SqliteRuntimeException("schema", "there is already another table named ${stmt.newName}")
        }
        let newSql = replaceTableNameInCreate(table.sql, table.name, stmt.newName)
        updateSchemaRow(db, row.rowid, "table", stmt.newName, stmt.newName, table.rootPage, newSql)
        retargetIndexRows(db, table.name, stmt.newName)
        if (db.hasSequenceTable) {
            renameSequenceEntry(db, table.name, stmt.newName)
        }
        db.bumpSchemaCookie()
        return 0
    }
    if (stmt.action == "renamecolumn") {
        let oldIdx = table.columnIndexOf(stmt.oldColumn)
        if (oldIdx < 0) {
            throw SqliteRuntimeException("schema", "no such column: ${stmt.oldColumn}")
        }
        let newName = match (stmt.newColumn) {
            case Some(d) => d.name
            case None => throw SqliteRuntimeException("schema", "missing new column name")
        }
        if (table.columnIndexOf(newName) >= 0) {
            throw SqliteRuntimeException("schema", "duplicate column name: ${newName}")
        }
        let newSql = rewriteCreateWithRenamedColumn(table, stmt.oldColumn, newName)
        updateSchemaRow(db, row.rowid, "table", table.name, table.name, table.rootPage, newSql)
        // 索引的 DDL 里也写着列名, 一并改。
        renameColumnInIndexes(db, table, stmt.oldColumn, newName)
        db.bumpSchemaCookie()
        return 0
    }
    if (stmt.action == "addcolumn") {
        let def = match (stmt.newColumn) {
            case Some(d) => d
            case None => throw SqliteRuntimeException("schema", "missing column definition")
        }
        if (table.columnIndexOf(def.name) >= 0) {
            throw SqliteRuntimeException("schema", "duplicate column name: ${def.name}")
        }
        // 已有行不被回填, 新列的值要在读它们的时候由默认值算出来 —— 那条路径上没有求值
        // 上下文, 所以默认值必须是常量。SQLite 同样拒绝非常量的 ADD COLUMN 默认值, 且这条
        // 检查排在 NOT NULL 之前 (`NOT NULL DEFAULT (random())` 报的是非常量)。
        if (let Some(e) <- def.defaultExpr) {
            match (constantExprValue(e)) {
                case None => throw SqliteRuntimeException("schema",
                    "cannot add a column with a non-constant default value")
                case Some(_) => ()
            }
        }
        // NOT NULL 且无默认值的新列会让所有已有行违反约束 —— SQLite 直接拒绝。
        if (def.notNull) {
            match (def.defaultExpr) {
                case None => throw SqliteRuntimeException("schema", "cannot add a NOT NULL column with no default value")
                case Some(e) => match (constantExprValue(e)) {
                    case Some(SNull) => throw SqliteRuntimeException("schema",
                        "cannot add a NOT NULL column with a NULL default value")
                    case _ => ()
                }
            }
        }
        if (def.primaryKey) {
            throw SqliteRuntimeException("schema", "cannot add a PRIMARY KEY column")
        }
        if (def.unique) {
            throw SqliteRuntimeException("schema", "cannot add a UNIQUE column")
        }
        let newSql = appendColumnToCreate(table.sql, def)
        updateSchemaRow(db, row.rowid, "table", table.name, table.name, table.rootPage, newSql)
        db.bumpSchemaCookie()
        return 0
    }
    if (stmt.action == "dropcolumn") {
        return execAlterTableDropColumn(db, table, stmt)
    }
    throw SqliteRuntimeException("schema", "unsupported ALTER TABLE action: ${stmt.action}")
}

func findSchemaRowFor(db: SqliteDatabase, objType: String, name: String): SchemaRow {
    let lower = name.toAsciiLower()
    for (row in readSchemaRows(db.pager)) {
        if (row.objType == objType && row.name.toAsciiLower() == lower) {
            return row
        }
    }
    throw SqliteRuntimeException("schema", "no ${objType} named ${name} in sqlite_schema")
}

/** 把索引行的 tbl_name 指向新表名, 并同步改它们 DDL 里的表名。 */
func retargetIndexRows(db: SqliteDatabase, oldName: String, newName: String): Unit {
    let lower = oldName.toAsciiLower()
    let rows = ArrayList<SchemaRow>()
    for (row in readSchemaRows(db.pager)) {
        if (row.objType == "index" && row.tblName.toAsciiLower() == lower) {
            rows.add(row)
        }
    }
    for (row in rows) {
        var name = row.name
        var sql = row.sql
        if (row.sql.isEmpty()) {
            // 自动索引: 名字里含表名, 要跟着改。
            name = renameAutoIndex(row.name, oldName, newName)
        } else {
            sql = replaceIndexTableName(row.sql, oldName, newName)
        }
        updateSchemaRow(db, row.rowid, "index", name, newName, row.rootPage, sql)
    }
}

func renameAutoIndex(indexName: String, oldTable: String, newTable: String): String {
    let prefix = "sqlite_autoindex_${oldTable}_"
    if (indexName.startsWith(prefix)) {
        let seq = indexName[prefix.size..indexName.size]
        return "sqlite_autoindex_${newTable}_${seq}"
    }
    indexName
}

func renameColumnInIndexes(db: SqliteDatabase, table: TableInfo, oldCol: String, newCol: String): Unit {
    let lower = table.name.toAsciiLower()
    let rows = ArrayList<SchemaRow>()
    for (row in readSchemaRows(db.pager)) {
        if (row.objType == "index" && row.tblName.toAsciiLower() == lower && !row.sql.isEmpty()) {
            rows.add(row)
        }
    }
    for (row in rows) {
        let newSql = replaceIdentifierInSql(row.sql, oldCol, newCol)
        updateSchemaRow(db, row.rowid, "index", row.name, row.tblName, row.rootPage, newSql)
    }
}

/*
 * sqlite_sequence: AUTOINCREMENT 的持久计数器。
 *
 * 它存在的意义正是修一个具体缺陷: 没有它, rowid 会被重用 —— 删掉 id 1、2 后重开库,
 * 新行会拿到 id=2 (因为"当前最大 rowid + 1" 是从剩余行算的)。AUTOINCREMENT 的语义是
 * "永不重用", 必须把历史最大值单独记下来。
 */
const SEQUENCE_TABLE_NAME: String = "sqlite_sequence"
const SEQUENCE_COLUMN_COUNT: Int64 = 2

func ensureSequenceTable(db: SqliteDatabase): Unit {
    if (db.hasSequenceTable) {
        return
    }
    let root = btreeCreate(db.pager, true)
    let _ = insertSchemaRow(db, "table", SEQUENCE_TABLE_NAME, SEQUENCE_TABLE_NAME, root,
        "CREATE TABLE sqlite_sequence(name,seq)")
    db.setSequenceRootPage(root)
}

/** 读某张表的 AUTOINCREMENT 计数; 没有记录返回 0。 */
func readSequence(db: SqliteDatabase, tableName: String): Int64 {
    if (!db.hasSequenceTable) {
        return 0
    }
    for (e in collectTableEntries(db.pager, db.sequenceRootPage)) {
        let vals = decodeRecord(e.payload, SEQUENCE_COLUMN_COUNT)
        if (valueToText(vals[0]) == tableName) {
            return valueToInt(vals[1])
        }
    }
    0
}

/** 写某张表的 AUTOINCREMENT 计数 (只增不减)。 */
func writeSequence(db: SqliteDatabase, tableName: String, seq: Int64): Unit {
    ensureSequenceTable(db)
    var targetRowid = -1
    var maxRowid = 0
    for (e in collectTableEntries(db.pager, db.sequenceRootPage)) {
        let vals = decodeRecord(e.payload, SEQUENCE_COLUMN_COUNT)
        if (valueToText(vals[0]) == tableName) {
            targetRowid = e.rowid
        }
        if (e.rowid > maxRowid) {
            maxRowid = e.rowid
        }
    }
    let values = Array<SqliteValue>(SEQUENCE_COLUMN_COUNT, repeat: SqliteValue.SNull)
    values[0] = SqliteValue.SText(tableName)
    values[1] = SqliteValue.SInt(seq)
    let rowid = if (targetRowid >= 0) {
        targetRowid
    } else {
        maxRowid + 1
    }
    btreeInsertRow(db.pager, db.sequenceRootPage, rowid, encodeRecord(values), true)
}

func removeSequenceEntry(db: SqliteDatabase, tableName: String): Unit {
    if (!db.hasSequenceTable) {
        return
    }
    for (e in collectTableEntries(db.pager, db.sequenceRootPage)) {
        let vals = decodeRecord(e.payload, SEQUENCE_COLUMN_COUNT)
        if (valueToText(vals[0]) == tableName) {
            let _ = btreeDeleteRow(db.pager, db.sequenceRootPage, e.rowid)
            return
        }
    }
}

func renameSequenceEntry(db: SqliteDatabase, oldName: String, newName: String): Unit {
    if (!db.hasSequenceTable) {
        return
    }
    for (e in collectTableEntries(db.pager, db.sequenceRootPage)) {
        let vals = decodeRecord(e.payload, SEQUENCE_COLUMN_COUNT)
        if (valueToText(vals[0]) == oldName) {
            let values = Array<SqliteValue>(SEQUENCE_COLUMN_COUNT, repeat: SqliteValue.SNull)
            values[0] = SqliteValue.SText(newName)
            values[1] = vals[1]
            btreeInsertRow(db.pager, db.sequenceRootPage, e.rowid, encodeRecord(values), true)
            return
        }
    }
}
