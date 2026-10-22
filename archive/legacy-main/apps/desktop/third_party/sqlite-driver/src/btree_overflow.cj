package sqlite_driver

import std.collection.*

/*
 * 溢出页链: 放不进 cell 的 payload 尾部。
 *
 * 每个溢出页前 4 字节是下一页页号 (0 = 末页), 其后 usableSize-4 字节是数据。
 * 最后一页的尾部可能有空余, 空余处的内容**未定义** —— 读的时候必须按 payload 总长
 * 截断, 而不是读满一页。按整页读会在行尾拼上垃圾字节, 且 UTF-8 解码往往仍然成功,
 * 于是表现为"字符串末尾多了看不见的东西"。
 */

/** 每个溢出页能放的数据字节数。 */
func overflowPayloadPerPage(usableSize: Int64): Int64 {
    usableSize - 4
}

/**
 * 读完整 payload: 先取 cell 内的本地部分, 再顺着溢出链补齐。
 *
 * guard 计数防环: 损坏的库可能让溢出链自指, 没有上限的话这里会无限循环, 表现为进程挂死。
 */
func readFullPayload(pager: Pager, page: Page, cell: CellInfo): Array<Byte> {
    let out = Array<Byte>(cell.payloadSize, repeat: 0)
    page.data.copyTo(out, cell.localOffset, 0, cell.localSize)
    if (cell.overflowPage == 0) {
        return out
    }
    let perPage = overflowPayloadPerPage(pager.usableSize)
    var written = cell.localSize
    var next = cell.overflowPage
    var guard = 0
    while (next != 0 && written < cell.payloadSize) {
        guard += 1
        if (guard > pager.pageCount + 1) {
            throw SqliteFormatException("overflow page chain starting at ${cell.overflowPage} is circular")
        }
        let ovfl = pager.getPage(next)
        let remaining = cell.payloadSize - written
        let take = if (remaining < perPage) {
            remaining
        } else {
            perPage
        }
        ovfl.data.copyTo(out, 4, written, take)
        written += take
        next = readU32(ovfl.data, 0)
    }
    if (written < cell.payloadSize) {
        throw SqliteFormatException("overflow chain ended early: got ${written} of ${cell.payloadSize} payload bytes")
    }
    out
}

/**
 * 把 payload 的溢出部分写成溢出页链, 返回首页页号。
 *
 * 一次性分配所有页再回填 next 指针: 边分配边写会在中途失败时留下无人引用的页,
 * 而那些页既不在 freelist 也不在任何 B-tree 里, integrity_check 会报"页丢失"。
 */
func writeOverflowChain(pager: Pager, payload: Array<Byte>, localSize: Int64): Int64 {
    let overflowBytes = payload.size - localSize
    if (overflowBytes <= 0) {
        return 0
    }
    let perPage = overflowPayloadPerPage(pager.usableSize)
    let pageCount = (overflowBytes + perPage - 1) / perPage
    let pages = ArrayList<Page>()
    for (_ in 0..pageCount) {
        pages.add(pager.allocatePage())
    }
    var srcPos = localSize
    for (i in 0..pageCount) {
        let p = pages[i]
        pager.markDirty(p)
        let next = if (i + 1 < pageCount) {
            pages[i + 1].pageNo
        } else {
            0
        }
        writeU32(p.data, 0, next)
        let remaining = payload.size - srcPos
        let take = if (remaining < perPage) {
            remaining
        } else {
            perPage
        }
        payload.copyTo(p.data, srcPos, 4, take)
        srcPos += take
    }
    pages[0].pageNo
}

/** 释放一条溢出链上的所有页。 */
func freeOverflowChain(pager: Pager, firstPage: Int64): Unit {
    var next = firstPage
    var guard = 0
    while (next != 0) {
        guard += 1
        if (guard > pager.pageCount + 1) {
            throw SqliteFormatException("overflow page chain starting at ${firstPage} is circular")
        }
        let p = pager.getPage(next)
        let following = readU32(p.data, 0)
        pager.freePage(next)
        next = following
    }
}

/** 收集一条溢出链的页号, 供 integrity_check 统计页归属。 */
func overflowChainPages(pager: Pager, firstPage: Int64, into: ArrayList<Int64>): Unit {
    var next = firstPage
    var guard = 0
    while (next != 0) {
        guard += 1
        if (guard > pager.pageCount + 1) {
            throw SqliteFormatException("overflow page chain starting at ${firstPage} is circular")
        }
        into.add(next)
        let p = pager.getPage(next)
        next = readU32(p.data, 0)
    }
}

/*
 * cell 字节的构造。四种页类型的 cell 头不同, 但"本地 payload + 可选溢出页号"的尾部
 * 结构一致, 所以统一在这里编。
 */

/** 编一个表叶页 cell。payload 为完整 record 字节。 */
func buildTableLeafCell(pager: Pager, rowid: Int64, payload: Array<Byte>): Array<Byte> {
    let local = localPayloadSize(payload.size, pager.usableSize, true)
    let overflowFirst = writeOverflowChain(pager, payload, local)
    let headSize = varintLen(payload.size) + varintLen(rowid)
    let total = headSize + local + (if (overflowFirst != 0) {
        4
    } else {
        0
    })
    let cell = Array<Byte>(total, repeat: 0)
    var pos = writeVarint(cell, 0, payload.size)
    pos += writeVarint(cell, pos, rowid)
    payload.copyTo(cell, 0, pos, local)
    if (overflowFirst != 0) {
        writeU32(cell, pos + local, overflowFirst)
    }
    cell
}

/** 编一个索引页 cell (叶或内节点, 内节点的左子页由调用方另填)。 */
func buildIndexCell(pager: Pager, payload: Array<Byte>, leftChild: Int64, interior: Bool): Array<Byte> {
    let local = localPayloadSize(payload.size, pager.usableSize, false)
    let overflowFirst = writeOverflowChain(pager, payload, local)
    let prefix = if (interior) {
        4
    } else {
        0
    }
    let headSize = prefix + varintLen(payload.size)
    let total = headSize + local + (if (overflowFirst != 0) {
        4
    } else {
        0
    })
    let cell = Array<Byte>(total, repeat: 0)
    if (interior) {
        writeU32(cell, 0, leftChild)
    }
    var pos = prefix + writeVarint(cell, prefix, payload.size)
    payload.copyTo(cell, 0, pos, local)
    if (overflowFirst != 0) {
        writeU32(cell, pos + local, overflowFirst)
    }
    cell
}

/** 编一个表内节点 cell: 4 字节左子页 + rowid varint。 */
func buildTableInteriorCell(leftChild: Int64, rowid: Int64): Array<Byte> {
    let cell = Array<Byte>(4 + varintLen(rowid), repeat: 0)
    writeU32(cell, 0, leftChild)
    let _ = writeVarint(cell, 4, rowid)
    cell
}
