package sqlite_driver

import std.collection.*

/*
 * WITHOUT ROWID 表的键规格与磁盘列序。
 *
 * 这种表**没有 rowid**: 它的 B-tree 是一棵索引树 (叶页 0x0A), cell 的 payload 就是整行的
 * record, 而行的身份由主键决定。磁盘上的列序也不是表的声明序 ——
 *
 *   主键列 (按 PRIMARY KEY 的书写顺序) + 其余列 (按表的声明顺序)
 *
 * 例: `CREATE TABLE t(a INT, b TEXT PRIMARY KEY, c TEXT) WITHOUT ROWID` 存的是 [b,a,c];
 * `PRIMARY KEY(b,a)` 存的是 [b,a,c]。这是拿 SQLite 写的库逐字节解出来的, 不是推断 ——
 * 列序写错的后果是本驱动与 SQLite 互相读到错位的值, 而两边都不报错。
 *
 * 一条容易忽略的性质: 键的**同一性只由主键前缀决定**。表树是索引树, 但两行主键相同、
 * 其余列不同时必须判为冲突，不能当成两个不同的键。decodeRecord(buf, n) 只解前 n 列，
 * compareIndexKeys 比 min(a,b) 长度再"短者在前", 所以传主键长度的键恰好就是"只比前缀",
 * 底层原语不需要改。
 */

/** 一张 WITHOUT ROWID 表的键与磁盘列序。 */
class RowKeySpec {
    /** 主键列的表内序号, 按 PRIMARY KEY 的书写顺序。 */
    let keyColumns: Array<Int64>
    let keyCollations: Array<SqliteCollation>
    let keyDescs: Array<Bool>
    /** 磁盘列序 -> 表内列序号。 */
    let storageOrder: Array<Int64>
    /** 表内列序号 -> 磁盘列序。storageOrder 的逆映射。 */
    let storageSlot: Array<Int64>
    /** 各列的常量 DEFAULT, 按磁盘列序; 解码时用来补齐 record 里缺失的字段。 */
    let storageDefaults: Array<SqliteValue>

    init(keyColumns: Array<Int64>, keyCollations: Array<SqliteCollation>, keyDescs: Array<Bool>,
        storageOrder: Array<Int64>, storageSlot: Array<Int64>, storageDefaults: Array<SqliteValue>) {
        this.keyColumns = keyColumns
        this.keyCollations = keyCollations
        this.keyDescs = keyDescs
        this.storageOrder = storageOrder
        this.storageSlot = storageSlot
        this.storageDefaults = storageDefaults
    }

    prop keyArity: Int64 {
        get() {
            keyColumns.size
        }
    }

    /** 某列是不是主键的一部分。 */
    func isKeyColumn(columnIndex: Int64): Bool {
        for (c in keyColumns) {
            if (c == columnIndex) {
                return true
            }
        }
        false
    }
}

/**
 * 由 CREATE TABLE 的 AST 算出键规格。
 *
 * 无主键时抛 —— SQLite 也拒 (`PRIMARY KEY missing on table t`), 而且这种表根本没有
 * 可用的键, 建出来也没法定位行。
 */
func buildRowKeySpec(stmt: CreateTableStmt, columns: Array<ColumnInfo>): RowKeySpec {
    let keyColumns = ArrayList<Int64>()
    let keyDescs = ArrayList<Bool>()
    var found = false
    for (tc in stmt.constraints) {
        if (tc.kind != "primarykey") {
            continue
        }
        found = true
        // 表级约束的书写顺序就是键的列序, 不能按表列序重排。
        for (i in 0..tc.columns.size) {
            let idx = columnIndexByName(columns, tc.columns[i])
            if (idx < 0) {
                throw SqliteRuntimeException("schema",
                    "table ${stmt.name} has no column named ${tc.columns[i]} for its PRIMARY KEY")
            }
            keyColumns.add(idx)
            keyDescs.add(if (i < tc.descs.size) {
                tc.descs[i]
            } else {
                false
            })
        }
    }
    if (!found) {
        for (i in 0..stmt.columns.size) {
            if (stmt.columns[i].primaryKey) {
                found = true
                keyColumns.add(i)
                keyDescs.add(stmt.columns[i].primaryKeyDesc)
            }
        }
    }
    if (!found || keyColumns.isEmpty()) {
        throw SqliteRuntimeException("schema", "PRIMARY KEY missing on table ${stmt.name}")
    }
    let colls = Array<SqliteCollation>(keyColumns.size, repeat: SqliteCollation.CollBinary)
    for (i in 0..keyColumns.size) {
        colls[i] = primaryKeyCollation(stmt, i, keyColumns[i], columns)
    }
    let (order, slot) = storageMapping(keyColumns.toArray(), columns.size)
    let defaults = Array<SqliteValue>(order.size, repeat: SqliteValue.SNull)
    for (i in 0..order.size) {
        defaults[i] = columns[order[i]].constantDefault
    }
    RowKeySpec(keyColumns.toArray(), colls, keyDescs.toArray(), order, slot, defaults)
}

/** 主键列的比较规则: 表级 PRIMARY KEY 的 COLLATE 覆盖列声明上的默认规则。 */
func primaryKeyCollation(stmt: CreateTableStmt, keyPosition: Int64, columnIndex: Int64, columns: Array<ColumnInfo>): SqliteCollation {
    for (tc in stmt.constraints) {
        if (tc.kind == "primarykey" && keyPosition < tc.collations.size) {
            return collationByName(tc.collations[keyPosition])
        }
    }
    columns[columnIndex].collation
}

/** 磁盘列序: 主键列在前 (按键序), 其余列按表声明序跟在后面。 */
func storageMapping(keyColumns: Array<Int64>, columnCount: Int64): (Array<Int64>, Array<Int64>) {
    let order = Array<Int64>(columnCount, repeat: 0)
    let slot = Array<Int64>(columnCount, repeat: -1)
    var at = 0
    for (c in keyColumns) {
        if (slot[c] >= 0) {
            // `PRIMARY KEY(a,a)` 这种重复列: 只算第一次, 否则磁盘列数会比表列数多。
            continue
        }
        order[at] = c
        slot[c] = at
        at += 1
    }
    for (i in 0..columnCount) {
        if (slot[i] < 0) {
            order[at] = i
            slot[i] = at
            at += 1
        }
    }
    (order, slot)
}

func columnIndexByName(columns: Array<ColumnInfo>, name: String): Int64 {
    let lower = name.toAsciiLower()
    for (c in columns) {
        if (c.name.toAsciiLower() == lower) {
            return c.index
        }
    }
    -1
}

/*
 * 行与键的编解码。
 */

/** 按磁盘列序编一整行。 */
func encodeWithoutRowidRow(spec: RowKeySpec, values: Array<SqliteValue>): Array<Byte> {
    let ordered = Array<SqliteValue>(values.size, repeat: SqliteValue.SNull)
    for (i in 0..values.size) {
        ordered[i] = values[spec.storageOrder[i]]
    }
    encodeRecord(ordered)
}

/** 把磁盘序的 record 还原成表声明序的一行; record 里缺的字段取列默认值。 */
func decodeWithoutRowidRow(spec: RowKeySpec, payload: Array<Byte>): Array<SqliteValue> {
    let ordered = decodeRecordWithDefaults(payload, spec.storageDefaults)
    let columnCount = spec.storageSlot.size
    let values = Array<SqliteValue>(columnCount, repeat: SqliteValue.SNull)
    for (i in 0..columnCount) {
        values[i] = ordered[spec.storageSlot[i]]
    }
    values
}

/** 一行的主键值, 按键序。 */
func rowKeyOf(spec: RowKeySpec, values: Array<SqliteValue>): Array<SqliteValue> {
    let key = Array<SqliteValue>(spec.keyColumns.size, repeat: SqliteValue.SNull)
    for (i in 0..spec.keyColumns.size) {
        key[i] = values[spec.keyColumns[i]]
    }
    key
}

/**
 * 一行在表树里的稳定身份。
 *
 * rowid 表只用 rowid；WITHOUT ROWID 表只用 key。把两种身份收进一个类型，避免 DML、
 * 外键级联和索引回表各自再维护一套“rowid 为 0 时另有含义”的约定。
 */
class RowLocator {
    let rowid: Int64
    let key: Array<SqliteValue>

    init(rowid: Int64, key: Array<SqliteValue>) {
        this.rowid = rowid
        this.key = key
    }
}

func rowidLocator(rowid: Int64): RowLocator {
    RowLocator(rowid, Array<SqliteValue>())
}

func keyLocator(key: Array<SqliteValue>): RowLocator {
    RowLocator(0, key)
}

func locatorForValues(table: TableInfo, rowid: Int64, values: Array<SqliteValue>): RowLocator {
    if (table.withoutRowid) {
        return keyLocator(rowKeyOf(table.requireRowKey(), values))
    }
    rowidLocator(rowid)
}

func sameLocator(table: TableInfo, a: RowLocator, b: RowLocator): Bool {
    if (!table.withoutRowid) {
        return a.rowid == b.rowid
    }
    let spec = table.requireRowKey()
    compareIndexKeys(a.key, b.key, spec.keyCollations, spec.keyDescs) == CMP_EQ
}

/** 表树游标：rowid 表是 table B-tree，WITHOUT ROWID 表是 index B-tree。 */
func tableCursor(pager: Pager, table: TableInfo): BtreeCursor {
    BtreeCursor(pager, table.rootPage, !table.withoutRowid)
}

/** 把表游标定位到一行。 */
func seekTableRow(cursor: BtreeCursor, table: TableInfo, locator: RowLocator): Bool {
    if (!table.withoutRowid) {
        return cursor.seekRowid(locator.rowid)
    }
    let spec = table.requireRowKey()
    cursor.seekIndex(locator.key, spec.keyCollations, spec.keyDescs)
}

/** 解出表游标当前行，并恢复成表声明里的列序。 */
func decodeTableRow(table: TableInfo, cursor: BtreeCursor): Array<SqliteValue> {
    if (!table.withoutRowid) {
        return decodeRowValues(table, cursor.currentRowid(), cursor.currentPayload())
    }
    decodeWithoutRowidRow(table.requireRowKey(), cursor.currentPayload())
}

/** 表游标当前行的身份。 */
func currentRowLocator(table: TableInfo, cursor: BtreeCursor): RowLocator {
    if (!table.withoutRowid) {
        return rowidLocator(cursor.currentRowid())
    }
    let spec = table.requireRowKey()
    keyLocator(decodeRecord(cursor.currentPayload(), spec.keyArity))
}

/** 二级索引末尾需要追加的主键列；已显式出现在索引里的列不重复追加。 */
func appendedPrimaryKeyColumns(table: TableInfo, index: IndexInfo): ArrayList<Int64> {
    let out = ArrayList<Int64>()
    if (!table.withoutRowid) {
        return out
    }
    for (column in table.requireRowKey().keyColumns) {
        if (!index.columnIndexes.contains(column)) {
            out.add(column)
        }
    }
    out
}

func indexStoredColumnCount(table: TableInfo, index: IndexInfo): Int64 {
    if (table.withoutRowid) {
        index.columnIndexes.size + appendedPrimaryKeyColumns(table, index).size
    } else {
        index.columnIndexes.size + 1
    }
}

/** 二级索引完整键的比较规格，包含 rowid 或追加的主键列。 */
func indexKeyMeta(table: TableInfo, index: IndexInfo): (Array<SqliteCollation>, Array<Bool>) {
    let n = indexStoredColumnCount(table, index)
    let colls = Array<SqliteCollation>(n, repeat: SqliteCollation.CollBinary)
    let descs = Array<Bool>(n, repeat: false)
    for (i in 0..index.columnIndexes.size) {
        colls[i] = index.collations[i]
        descs[i] = index.descs[i]
    }
    if (table.withoutRowid) {
        let spec = table.requireRowKey()
        let appended = appendedPrimaryKeyColumns(table, index)
        for (i in 0..appended.size) {
            let column = appended[i]
            for (j in 0..spec.keyColumns.size) {
                if (spec.keyColumns[j] == column) {
                    colls[index.columnIndexes.size + i] = spec.keyCollations[j]
                    descs[index.columnIndexes.size + i] = spec.keyDescs[j]
                    break
                }
            }
        }
    }
    (colls, descs)
}

/** 从二级索引的完整键恢复它指向的表行身份。 */
func locatorFromIndexKey(table: TableInfo, index: IndexInfo, storedKey: Array<SqliteValue>): RowLocator {
    if (!table.withoutRowid) {
        return rowidLocator(valueToInt(storedKey[storedKey.size - 1]))
    }
    let spec = table.requireRowKey()
    let key = Array<SqliteValue>(spec.keyArity, repeat: SqliteValue.SNull)
    let appended = appendedPrimaryKeyColumns(table, index)
    for (i in 0..spec.keyColumns.size) {
        let wanted = spec.keyColumns[i]
        var source = -1
        for (j in 0..index.columnIndexes.size) {
            if (index.columnIndexes[j] == wanted) {
                source = j
                break
            }
        }
        if (source < 0) {
            for (j in 0..appended.size) {
                if (appended[j] == wanted) {
                    source = index.columnIndexes.size + j
                    break
                }
            }
        }
        if (source < 0 || source >= storedKey.size) {
            throw SqliteFormatException(
                "index '${index.name}' does not contain primary-key column ${table.columns[wanted].name}")
        }
        key[i] = storedKey[source]
    }
    keyLocator(key)
}
