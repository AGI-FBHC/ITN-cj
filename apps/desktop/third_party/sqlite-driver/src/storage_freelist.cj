package sqlite_driver

import std.collection.*

/*
 * freelist: 被释放的页组成的单链表, 供后续分配复用。
 *
 * 结构 (照 SQLite 格式规范):
 *   头部 32..35  第一个 trunk 页号 (0 = 空)
 *   头部 36..39  freelist 总页数 (trunk 页与 leaf 页都计入)
 *   trunk 页 0..3   下一个 trunk 页号 (0 = 末尾)
 *   trunk 页 4..7   本页记录的 leaf 页号个数 L
 *   trunk 页 8..     L 个 4 字节 leaf 页号
 *
 * 写成顶层自由函数而不是 Pager 的方法: Pager 已经很大, 而 freelist 只用到它的
 * getPage / getNewPage / markDirty / header 几个入口, 分出来后两边都短。
 * (类体内的方法调不到 extend 块里的成员, 所以拆分只能走自由函数这条路。)
 */
const FREELIST_TRUNK_HEADER: Int64 = 8

/** 一个 trunk 页最多能记多少个 leaf 页号。 */
func freelistMaxLeaves(usableSize: Int64): Int64 {
    (usableSize - FREELIST_TRUNK_HEADER) / 4
}

/**
 * 从 freelist 摘一页。空则返回 None。
 *
 * 摘取顺序: 先从第一个 trunk 页的**最后一个** leaf 摘 (与 SQLite 一致, 只改计数不搬数据);
 * trunk 页的 leaf 用尽时, trunk 页自己被当作分配结果, 链表头前移。
 */
func freelistTake(pager: Pager): Option<Int64> {
    let h = pager.header
    if (h.freelistTrunk == 0) {
        return None
    }
    let trunkNo = h.freelistTrunk
    let trunk = pager.getPage(trunkNo)
    let leafCount = readU32(trunk.data, 4)
    if (leafCount > 0) {
        let idx = FREELIST_TRUNK_HEADER + (leafCount - 1) * 4
        if (idx + 4 > pager.usableSize) {
            throw SqliteFormatException(
                "freelist trunk page ${trunkNo} claims ${leafCount} leaves, which overflows the page")
        }
        let leafNo = readU32(trunk.data, idx)
        pager.markDirty(trunk)
        writeU32(trunk.data, 4, leafCount - 1)
        h.freelistCount -= 1
        if (leafNo < 1 || leafNo > h.dbSize) {
            throw SqliteFormatException("freelist leaf ${leafNo} is out of range")
        }
        return Some(leafNo)
    }
    // trunk 页空了: 它自己成为分配结果。
    let nextTrunk = readU32(trunk.data, 0)
    h.freelistTrunk = nextTrunk
    h.freelistCount -= 1
    Some(trunkNo)
}

/**
 * 把一页归还 freelist。
 *
 * 优先塞进现有第一个 trunk 页的 leaf 数组 (只改一个计数和一个槽位, 便宜);
 * 塞不下时让被释放的页成为新的 trunk 页, 链到旧头前面。
 */
func freelistAdd(pager: Pager, pageNo: Int64): Unit {
    let h = pager.header
    if (pageNo < 2 || pageNo > h.dbSize) {
        throw SqliteFormatException("cannot free page ${pageNo}: out of range (page 1 is never freed)")
    }
    if (pageNo == pager.lockBytePage) {
        throw SqliteFormatException("cannot free the lock-byte page")
    }
    if (h.freelistTrunk != 0) {
        let trunk = pager.getPage(h.freelistTrunk)
        let leafCount = readU32(trunk.data, 4)
        if (leafCount < freelistMaxLeaves(pager.usableSize)) {
            pager.markDirty(trunk)
            writeU32(trunk.data, FREELIST_TRUNK_HEADER + leafCount * 4, pageNo)
            writeU32(trunk.data, 4, leafCount + 1)
            h.freelistCount += 1
            return
        }
    }
    let newTrunk = pager.getNewPage(pageNo)
    writeU32(newTrunk.data, 0, h.freelistTrunk)
    writeU32(newTrunk.data, 4, 0)
    h.freelistTrunk = pageNo
    h.freelistCount += 1
}

/** 遍历 freelist 收集所有页号, 供 integrity_check 与测试核对。 */
func freelistPages(pager: Pager): Array<Int64> {
    let out = ArrayList<Int64>()
    var trunkNo = pager.header.freelistTrunk
    var guard = 0
    while (trunkNo != 0) {
        guard += 1
        if (guard > pager.header.dbSize + 1) {
            throw SqliteFormatException("freelist trunk chain is circular")
        }
        out.add(trunkNo)
        let trunk = pager.getPage(trunkNo)
        let leafCount = readU32(trunk.data, 4)
        if (leafCount > freelistMaxLeaves(pager.usableSize)) {
            throw SqliteFormatException("freelist trunk page ${trunkNo} has an impossible leaf count ${leafCount}")
        }
        for (i in 0..leafCount) {
            out.add(readU32(trunk.data, FREELIST_TRUNK_HEADER + i * 4))
        }
        trunkNo = readU32(trunk.data, 0)
    }
    out.toArray()
}
