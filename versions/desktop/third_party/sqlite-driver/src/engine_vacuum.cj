package sqlite_driver

import std.collection.*

/*
 * VACUUM: 把整库重建一遍, 丢掉所有空洞。
 *
 * 为什么是重建而不是就地整理: 删除只把页还进 freelist, 文件不缩; 而在 B-tree 写路径上做
 * 兄弟合并与页搬迁要动已经验证正确的分裂逻辑, 代价与风险都远高于重建。重建还顺带把每棵树
 * 的页排布收紧, 顺序扫描因此变快 —— 这正是 SQLite 的 VACUUM 做的事。
 *
 * 实现上重建到一个**内存**库再整体写回, 而不是"写新文件 + 原子替换":
 *   - Pager 持着已打开的文件句柄, rename 之后句柄仍指向旧 inode, 后续读写会落到被替换掉
 *     的那个文件上。要换文件就得关掉重开, 而连接是对外对象, 中途换掉它的后端会让并发的
 *     读游标读到半个库。
 *   - 走写回则整个 VACUUM 是一个普通写事务, 崩溃安全由既有的日志机制保证, 不需要新的
 *     原子性论证: 中途崩溃则日志回放, 库退回 VACUUM 之前的形态。
 *
 * 代价是峰值占用: 重建期间新库在内存里, 旧库仍在磁盘上。对本驱动的定位 (嵌入式、单连接)
 * 可以接受, 且与 SQLite 需要 2 倍磁盘空间的量级一致。
 */

/**
 * 执行 VACUUM。
 *
 * 不能在事务里跑 —— 它要重写每一页, 与"事务内可回滚到语句边界"的语义冲突, SQLite 同样
 * 拒绝。返回 0 行受影响。
 */
func execVacuum(db: SqliteDatabase): Int64 {
    if (db.inTransaction) {
        throw SqliteRuntimeException("state", "cannot VACUUM from within a transaction")
    }
    if (db.pager.header.textEncoding != TEXT_ENCODING_UTF8) {
        // 重建时记录由本驱动重新编码, 而本驱动只写 UTF-8。硬报出来, 别把 UTF-16 的库
        // 静默重写成 UTF-8 —— 那会让头里的编码声明与实际内容不符, SQLite 读到乱码。
        throw SqliteRuntimeException("unsupported",
            "VACUUM only supports UTF-8 databases; this one declares text encoding ${db.pager.header.textEncoding}")
    }
    let rebuilt = rebuildIntoMemory(db)
    writeBackRebuilt(db, rebuilt)
    0
}

/**
 * 把 db 的全部内容重放进一个新的内存库, 返回它的 Pager。
 *
 * 顺序有讲究: 先建表并灌数据, 再建显式索引 —— CREATE INDEX 自己会扫表填索引, 于是显式
 * 索引不用单独填。表上的自动索引 (UNIQUE / 复合主键) 由 CREATE TABLE 一并建出, 但它们
 * 在灌数据时是空的 (数据是按 B-tree 层直插的, 绕过了约束检查), 所以要显式补填。
 *
 * 按 B-tree 层直插而不是走 INSERT: rowid 必须逐个保持原值, 且不该重跑一遍约束与外键 ——
 * 库里已有的数据本来就是合法的, 重跑只会因为"父行还没轮到被复制"而假报违约。
 */
private func rebuildIntoMemory(db: SqliteDatabase): SqliteDatabase {
    let fresh = openMemoryDatabase(db.pager.pageSize, SqliteSyncMode.SyncNormal)
    let schema = db.currentSchema()
    let rows = readSchemaRows(db.pager)
    // 表先全部建好并灌满。
    for (row in rows) {
        if (row.objType != "table" || row.sql.isEmpty()) {
            continue
        }
        if (row.name.toAsciiLower() == "sqlite_sequence") {
            // 它由 AUTOINCREMENT 的表自动建出, 不能显式 CREATE; 内容在后面单独搬。
            continue
        }
        let _ = executeSql(fresh, row.sql, Array<SqliteValue>())
        match (schema.findTable(row.name)) {
            case None => ()
            case Some(src) => copyTableRows(db, fresh, src)
        }
    }
    // 自动索引: CREATE TABLE 建了空树, 数据是直插进去的, 这里补填。
    for (row in rows) {
        if (row.objType != "table" || row.sql.isEmpty()) {
            continue
        }
        if (row.name.toAsciiLower() == "sqlite_sequence") {
            continue
        }
        populateAutoIndexes(fresh, row.name)
    }
    // 显式索引: CREATE INDEX 自己扫表填, 不用再补。
    for (row in rows) {
        if (row.objType != "index" || row.sql.isEmpty()) {
            continue
        }
        let _ = executeSql(fresh, row.sql, Array<SqliteValue>())
    }
    copySequenceRows(db, fresh)
    fresh
}

/** 按 B-tree 层把一张表的行原样搬过去, rowid 与 payload 都不变。 */
private func copyTableRows(src: SqliteDatabase, dst: SqliteDatabase, table: TableInfo): Unit {
    match (dst.currentSchema().findTable(table.name)) {
        case None => throw SqliteRuntimeException("state", "VACUUM rebuilt schema is missing table ${table.name}")
        case Some(target) =>
            dst.pager.beginWrite()
            if (table.withoutRowid) {
                let sourceCursor = tableCursor(src.pager, table)
                let spec = target.requireRowKey()
                var ok = sourceCursor.first()
                while (ok) {
                    let payload = sourceCursor.currentPayload()
                    let key = decodeRecord(payload, spec.keyArity)
                    btreeInsertIndexPayload(dst.pager, target.rootPage, key, payload, spec.keyCollations,
                        spec.keyDescs, false)
                    ok = sourceCursor.next()
                }
            } else {
                for (e in collectTableEntries(src.pager, table.rootPage)) {
                    btreeInsertRow(dst.pager, target.rootPage, e.rowid, e.payload, false)
                }
            }
            dst.pager.commit(false)
    }
}

/**
 * 补填一张表的自动索引。
 *
 * 自动索引的名字形如 sqlite_autoindex_<表>_<n>, 由 CREATE TABLE 建出。显式索引在这里跳过,
 * 否则 CREATE INDEX 之后会被填第二遍, 每个键出现两次。
 */
private func populateAutoIndexes(dst: SqliteDatabase, tableName: String): Unit {
    match (dst.currentSchema().findTable(tableName)) {
        case None => ()
        case Some(table) =>
            if (table.indexes.isEmpty()) {
                return
            }
            dst.pager.beginWrite()
            for (index in table.indexes) {
                if (!index.name.toAsciiLower().startsWith("sqlite_autoindex_")) {
                    continue
                }
                populateIndex(dst, table, index)
            }
            dst.pager.commit(false)
    }
}

/**
 * 搬 sqlite_sequence 的内容。
 *
 * 它记着每张 AUTOINCREMENT 表用过的最大 rowid。不搬则重建后的库会从头发号, 与已删除的
 * 历史行重号 —— AUTOINCREMENT 承诺的正是"不重用", 所以这一步不是优化而是正确性。
 */
private func copySequenceRows(src: SqliteDatabase, dst: SqliteDatabase): Unit {
    if (!src.hasSequenceTable || !dst.hasSequenceTable) {
        return
    }
    dst.pager.beginWrite()
    for (e in collectTableEntries(src.pager, src.sequenceRootPage)) {
        btreeInsertRow(dst.pager, dst.sequenceRootPage, e.rowid, e.payload, true)
    }
    dst.pager.commit(false)
}

/**
 * 把重建好的库整体写回原后端。
 *
 * 页 1 只搬 B-tree 区 (偏移 100 之后), 前 100 字节的文件头留用原库的 —— user_version /
 * application_id / 文本编码是库的身份, VACUUM 不该改。dbSize / freelist / schemaCookie
 * 则必须换成新库的值: 前两个是新的页排布, 第三个要变以让别的连接重载模式 (每棵树的
 * rootpage 都换了)。
 */
private func writeBackRebuilt(db: SqliteDatabase, rebuilt: SqliteDatabase): Unit {
    let dst = db.pager
    let src = rebuilt.pager
    let newSize = src.header.dbSize
    dst.beginWrite()
    var no = 1
    while (no <= newSize) {
        let from = src.getPage(no)
        // 目标库比新库短时, 尾部的页在文件里还不存在, 只能用 getNewPage。
        let to = if (no <= dst.header.dbSize) {
            let p = dst.getPage(no)
            dst.markDirty(p)
            p
        } else {
            dst.getNewPage(no)
        }
        if (no == 1) {
            // 前 100 字节是文件头, 由 flushDirtyPages 按 dst.header 重写, 这里别覆盖。
            from.data.copyTo(to.data, HEADER_SIZE, HEADER_SIZE, dst.pageSize - HEADER_SIZE)
        } else {
            from.data.copyTo(to.data, 0, 0, dst.pageSize)
        }
        no += 1
    }
    dst.header.dbSize = newSize
    dst.header.freelistTrunk = src.header.freelistTrunk
    dst.header.freelistCount = src.header.freelistCount
    dst.header.largestRootPage = src.header.largestRootPage
    dst.header.schemaCookie += 1
    dst.txDirty = true
    dst.commit(false)
    // 文件收缩只能在提交之后: 提交前截断会把还没落盘的页扔掉。中途崩溃则文件留长一截,
    // 但头里的 dbSize 已是新值, 尾部那些页不被任何树引用, 下次 VACUUM 会清掉。
    dst.truncateToDbSize()
    db.invalidateSchema()
    rebuilt.close()
}
