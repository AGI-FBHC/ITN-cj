package sqlite_driver

/*
 * B-tree 页内布局。
 *
 * 页头 (叶页 8 字节, 内节点 12 字节):
 *   0     页类型 2/5/10/13
 *   1..2  第一个空闲块偏移 (0 = 无)
 *   3..4  cell 个数
 *   5..6  cell 内容区起点 (0 表示 65536)
 *   7     碎片字节数 (小于 4 字节、无法进空闲链的零头)
 *   8..11 最右子页号 —— 只有内节点有
 * 紧接页头是 cell 指针数组, 每项 2 字节, **按键升序**排列。cell 本体从页尾向前生长。
 *
 * 第 1 页特殊: 它的前 100 字节是文件头, 所以页头从偏移 100 开始。所有偏移计算都要过
 * pageHeaderOffset() —— 漏一处就会把文件头当页头解析, 而症状是"页类型 = 83" 这种
 * 看不出根因的报错 (83 是 'S', 魔数 "SQLite" 的首字节)。
 */
const PT_INDEX_INTERIOR: Int64 = 2
const PT_TABLE_INTERIOR: Int64 = 5
const PT_INDEX_LEAF: Int64 = 10
const PT_TABLE_LEAF: Int64 = 13

/** 页头内各字段偏移 (相对页头起点)。 */
const PH_TYPE: Int64 = 0
const PH_FIRST_FREEBLOCK: Int64 = 1
const PH_CELL_COUNT: Int64 = 3
const PH_CONTENT_START: Int64 = 5
const PH_FRAGMENTED: Int64 = 7
const PH_RIGHT_CHILD: Int64 = 8

/** 空闲块自身的头: 2 字节下一块偏移 + 2 字节本块大小。小于 4 字节的洞进不了链。 */
const FREEBLOCK_HEADER: Int64 = 4
const MIN_CELL_SIZE: Int64 = 4

func pageHeaderOffset(pageNo: Int64): Int64 {
    if (pageNo == 1) {
        HEADER_SIZE
    } else {
        0
    }
}

func pageType(page: Page): Int64 {
    readU8(page.data, pageHeaderOffset(page.pageNo) + PH_TYPE)
}

func isLeafPage(page: Page): Bool {
    let t = pageType(page)
    t == PT_TABLE_LEAF || t == PT_INDEX_LEAF
}

func isTablePage(page: Page): Bool {
    let t = pageType(page)
    t == PT_TABLE_LEAF || t == PT_TABLE_INTERIOR
}

/** 页头长度: 内节点多 4 字节的最右子页指针。 */
func pageHeaderSize(page: Page): Int64 {
    if (isLeafPage(page)) {
        8
    } else {
        12
    }
}

func cellCount(page: Page): Int64 {
    readU16(page.data, pageHeaderOffset(page.pageNo) + PH_CELL_COUNT)
}

func setCellCount(page: Page, n: Int64): Unit {
    writeU16(page.data, pageHeaderOffset(page.pageNo) + PH_CELL_COUNT, n)
}

func cellPointerArrayOffset(page: Page): Int64 {
    pageHeaderOffset(page.pageNo) + pageHeaderSize(page)
}

/** 第 i 个 cell 的页内偏移。 */
func cellOffset(page: Page, i: Int64): Int64 {
    readU16(page.data, cellPointerArrayOffset(page) + i * 2)
}

func setCellOffset(page: Page, i: Int64, off: Int64): Unit {
    writeU16(page.data, cellPointerArrayOffset(page) + i * 2, off)
}

func contentStart(page: Page, pageSize: Int64): Int64 {
    let _ = pageSize
    let raw = readU16(page.data, pageHeaderOffset(page.pageNo) + PH_CONTENT_START)
    if (raw == 0) {
        MAX_PAGE_SIZE
    } else {
        raw
    }
}

func setContentStart(page: Page, off: Int64): Unit {
    let v = if (off == MAX_PAGE_SIZE) {
        0
    } else {
        off
    }
    writeU16(page.data, pageHeaderOffset(page.pageNo) + PH_CONTENT_START, v)
}

func rightChild(page: Page): Int64 {
    readU32(page.data, pageHeaderOffset(page.pageNo) + PH_RIGHT_CHILD)
}

func setRightChild(page: Page, childNo: Int64): Unit {
    writeU32(page.data, pageHeaderOffset(page.pageNo) + PH_RIGHT_CHILD, childNo)
}

func fragmentedBytes(page: Page): Int64 {
    readU8(page.data, pageHeaderOffset(page.pageNo) + PH_FRAGMENTED)
}

func setFragmentedBytes(page: Page, n: Int64): Unit {
    page.data[pageHeaderOffset(page.pageNo) + PH_FRAGMENTED] = UInt8(n & 0xFF)
}

func firstFreeblock(page: Page): Int64 {
    readU16(page.data, pageHeaderOffset(page.pageNo) + PH_FIRST_FREEBLOCK)
}

func setFirstFreeblock(page: Page, off: Int64): Unit {
    writeU16(page.data, pageHeaderOffset(page.pageNo) + PH_FIRST_FREEBLOCK, off)
}

/** 把一页初始化成空的指定类型。 */
func initPage(page: Page, ptype: Int64, usableSize: Int64): Unit {
    let hdr = pageHeaderOffset(page.pageNo)
    for (i in hdr..page.data.size) {
        page.data[i] = 0
    }
    page.data[hdr + PH_TYPE] = UInt8(ptype)
    setFirstFreeblock(page, 0)
    setCellCount(page, 0)
    setContentStart(page, usableSize)
    setFragmentedBytes(page, 0)
    if (ptype == PT_TABLE_INTERIOR || ptype == PT_INDEX_INTERIOR) {
        setRightChild(page, 0)
    }
}

func validatePageType(page: Page): Unit {
    let t = pageType(page)
    if (t != PT_INDEX_INTERIOR && t != PT_TABLE_INTERIOR && t != PT_INDEX_LEAF && t != PT_TABLE_LEAF) {
        throw SqliteFormatException("page ${page.pageNo} has an unknown B-tree page type ${t}")
    }
}

/*
 * cell 的 payload 溢出阈值。
 *
 * 这套公式来自格式规范, 里面的 35 / 32 / 255 / 23 都是规范里的常数。不能"取个差不多的
 * 值" —— 阈值差一字节就会让本地存储量与 SQLite 不同, 于是它读我们的 cell 时会在
 * 错误的位置找溢出页号, 读出的行是乱码而不是报错。
 */

/** 表叶页 cell 的本地 payload 上限。 */
func tableLeafMaxLocal(usableSize: Int64): Int64 {
    usableSize - 35
}

/** 索引页 cell 的本地 payload 上限。 */
func indexMaxLocal(usableSize: Int64): Int64 {
    ((usableSize - 12) * 64 / 255) - 23
}

/** 溢出时的最小本地存储量, 表页与索引页共用。 */
func minLocal(usableSize: Int64): Int64 {
    ((usableSize - 12) * 32 / 255) - 23
}

/**
 * 算一个 payload 有多少字节存在页内。
 *
 * 规范的做法: 先按 minLocal 算一个候选 K, 若 K 不超过 maxLocal 就用 K, 否则用 minLocal。
 * 这个"要么 K 要么 minLocal"的分支是为了避免溢出页里只剩几字节。
 */
func localPayloadSize(payloadSize: Int64, usableSize: Int64, isTableLeaf: Bool): Int64 {
    let maxLocal = if (isTableLeaf) {
        tableLeafMaxLocal(usableSize)
    } else {
        indexMaxLocal(usableSize)
    }
    if (payloadSize <= maxLocal) {
        return payloadSize
    }
    let m = minLocal(usableSize)
    let k = m + ((payloadSize - m) % (usableSize - 4))
    if (k <= maxLocal) {
        k
    } else {
        m
    }
}

/** 解出来的 cell 结构。overflowPage 为 0 表示没有溢出。 */
class CellInfo {
    /** cell 在页内的起始偏移。 */
    let offset: Int64
    /** cell 总字节数 (含头、本地 payload、溢出页号)。 */
    let size: Int64
    /** payload 总长 (含溢出部分)。表内节点无 payload, 为 0。 */
    let payloadSize: Int64
    /** 本地 payload 起始偏移与长度。 */
    let localOffset: Int64
    let localSize: Int64
    /** 表页的 rowid; 索引页为 0。 */
    let rowid: Int64
    /** 内节点的左子页号; 叶页为 0。 */
    let leftChild: Int64
    let overflowPage: Int64

    init(offset: Int64, size: Int64, payloadSize: Int64, localOffset: Int64, localSize: Int64, rowid: Int64,
        leftChild: Int64, overflowPage: Int64) {
        this.offset = offset
        this.size = size
        this.payloadSize = payloadSize
        this.localOffset = localOffset
        this.localSize = localSize
        this.rowid = rowid
        this.leftChild = leftChild
        this.overflowPage = overflowPage
    }
}

/** 解析第 i 个 cell。 */
func parseCell(page: Page, i: Int64, usableSize: Int64): CellInfo {
    let start = cellOffset(page, i)
    parseCellAt(page, start, usableSize)
}

/*
 * 用 if/else 而不是 match: 仓颉的 match 里裸标识符是**绑定模式**, 写
 * `case PT_TABLE_INTERIOR =>` 会把 t 绑给一个新名字并匹配一切, 后续分支永不可达,
 * 且编译器不报错。常量分派必须走 if/else 或 `case _ where t == C`。
 */
/**
 * cell 必须整块落在页内。
 *
 * 页里出现"越界的 cell"只有一个来源 —— 页内容已损坏(写坏的 cell 指针、被覆盖的 cell 头、
 * 别的实现留下的垃圾)。这时要报"哪一页、哪个偏移、多少字节", 而不是放任 readU32 抛出
 * 数组越界: 后者只留下一句 `The length of the array is 4096, but the index is 4922.`,
 * 既看不到页号也定位不到 cell, 排查成本极高。
 */
func requireCellFits(page: Page, start: Int64, end: Int64, usableSize: Int64): Unit {
    if (start < 0 || end > usableSize) {
        throw SqliteFormatException(
            "page ${page.pageNo}: cell at ${start} ends at ${end}, beyond the usable page end ${usableSize}")
    }
}

func parseCellAt(page: Page, start: Int64, usableSize: Int64): CellInfo {
    let t = pageType(page)
    let buf = page.data
    if (t == PT_TABLE_INTERIOR) {
        // 4 字节左子页 + rowid varint, 无 payload。
        let child = readU32(buf, start)
        let key = readVarint(buf, start + 4)
        requireCellFits(page, start, start + 4 + key.size, usableSize)
        return CellInfo(start, 4 + key.size, 0, 0, 0, key.value, child, 0)
    }
    if (t == PT_TABLE_LEAF) {
        let plen = readVarint(buf, start)
        let key = readVarint(buf, start + plen.size)
        let headSize = plen.size + key.size
        let local = localPayloadSize(plen.value, usableSize, true)
        let hasOverflow = local < plen.value
        requireCellFits(page, start, start + headSize + local + (if (hasOverflow) { 4 } else { 0 }), usableSize)
        let ovfl = if (hasOverflow) {
            readU32(buf, start + headSize + local)
        } else {
            0
        }
        let size = headSize + local + (if (hasOverflow) {
            4
        } else {
            0
        })
        return CellInfo(start, size, plen.value, start + headSize, local, key.value, 0, ovfl)
    }
    if (t == PT_INDEX_LEAF) {
        let plen = readVarint(buf, start)
        let local = localPayloadSize(plen.value, usableSize, false)
        let hasOverflow = local < plen.value
        requireCellFits(page, start, start + plen.size + local + (if (hasOverflow) { 4 } else { 0 }), usableSize)
        let ovfl = if (hasOverflow) {
            readU32(buf, start + plen.size + local)
        } else {
            0
        }
        let size = plen.size + local + (if (hasOverflow) {
            4
        } else {
            0
        })
        return CellInfo(start, size, plen.value, start + plen.size, local, 0, 0, ovfl)
    }
    if (t == PT_INDEX_INTERIOR) {
        let child = readU32(buf, start)
        let plen = readVarint(buf, start + 4)
        let local = localPayloadSize(plen.value, usableSize, false)
        let hasOverflow = local < plen.value
        requireCellFits(page, start, start + 4 + plen.size + local + (if (hasOverflow) { 4 } else { 0 }), usableSize)
        let ovfl = if (hasOverflow) {
            readU32(buf, start + 4 + plen.size + local)
        } else {
            0
        }
        let size = 4 + plen.size + local + (if (hasOverflow) {
            4
        } else {
            0
        })
        return CellInfo(start, size, plen.value, start + 4 + plen.size, local, 0, child, ovfl)
    }
    throw SqliteFormatException("page ${page.pageNo} has an unknown B-tree page type ${t}")
}

/** 空闲块偏移必须落在页内, 否则链已经损坏。 */
func requireFreeblockFits(page: Page, off: Int64, usableSize: Int64): Unit {
    if (off < FREEBLOCK_HEADER || off + FREEBLOCK_HEADER > usableSize) {
        throw SqliteFormatException(
            "page ${page.pageNo}: freeblock offset ${off} is outside the usable page 0..${usableSize}")
    }
}

/** SQLite 要求相邻空闲块之间至少留 4 字节；1–3 字节零头须并入块并扣除碎片计数。 */
func coalesceFreeblocks(page: Page, usableSize: Int64): Unit {
    var cur = firstFreeblock(page)
    var visited = 0
    while (cur != 0) {
        visited += 1
        if (visited > usableSize / FREEBLOCK_HEADER + 1) {
            throw SqliteFormatException("page ${page.pageNo} has a circular freeblock chain")
        }
        requireFreeblockFits(page, cur, usableSize)
        let size = readU16(page.data, cur + 2)
        if (size < FREEBLOCK_HEADER || cur + size > usableSize) {
            throw SqliteFormatException("page ${page.pageNo}: invalid freeblock at ${cur}, size ${size}")
        }
        let next = readU16(page.data, cur)
        if (next == 0) { return }
        requireFreeblockFits(page, next, usableSize)
        if (next < cur + size) {
            throw SqliteFormatException("page ${page.pageNo}: overlapping or unordered freeblocks at ${cur} and ${next}")
        }
        let gap = next - cur - size
        if (gap >= FREEBLOCK_HEADER) { cur = next; continue }
        let nextSize = readU16(page.data, next + 2)
        if (nextSize < FREEBLOCK_HEADER || next + nextSize > usableSize || gap > fragmentedBytes(page)) {
            throw SqliteFormatException("page ${page.pageNo}: invalid fragments between freeblocks at ${cur} and ${next}")
        }
        writeU16(page.data, cur, readU16(page.data, next))
        writeU16(page.data, cur + 2, size + gap + nextSize)
        setFragmentedBytes(page, fragmentedBytes(page) - gap)
    }
}

/** 页内剩余可用字节: 未分配的间隙 + 空闲链 + 碎片。 */
func totalFreeBytes(page: Page, pageSize: Int64, usableSize: Int64): Int64 {
    let gap = contentStart(page, pageSize) - (cellPointerArrayOffset(page) + cellCount(page) * 2)
    var free = if (gap > 0) {
        gap
    } else {
        0
    }
    var fb = firstFreeblock(page)
    var guard = 0
    while (fb != 0) {
        guard += 1
        if (guard > usableSize / FREEBLOCK_HEADER + 1) {
            throw SqliteFormatException("page ${page.pageNo} has a circular freeblock chain")
        }
        requireFreeblockFits(page, fb, usableSize)
        free += readU16(page.data, fb + 2)
        fb = readU16(page.data, fb)
    }
    free + fragmentedBytes(page)
}

/**
 * 碎片整理: 把所有 cell 重新贴到页尾, 清空空闲链与碎片计数。
 *
 * 必须按"内容区从高地址向低地址重排"来做, 且用一份临时拷贝 —— 原地搬会在 cell 区间
 * 重叠时互相覆盖。
 *
 * **解析也一律走快照**: 重排是从页尾往上贴, 放第 i 个 cell 时写入的位置就可能压住
 * 后面那些 cell 的旧位置。若这时还从 page.data 解析, 那些 cell 会按"被覆盖后的字节"
 * 解出长度, 进而算出离谱的本地长度、再去页内读溢出页号 —— 索引越过页尾, 报出来的却是
 * 一句毫无线索的数组越界。用户实测到的那条
 * `The length of the array is 4096, but the index is 4922.`
 * 就出自这里 (readU32 ← parseCellAt ← defragmentPage)。tmp 整轮只读不写, 从它解析安全。
 */
func defragmentPage(page: Page, pageSize: Int64, usableSize: Int64): Unit {
    let _ = pageSize
    let n = cellCount(page)
    let tmp = Array<Byte>(page.data.size, repeat: 0)
    page.data.copyTo(tmp, 0, 0, page.data.size)
    let snapshot = Page(page.pageNo, tmp)
    var cursor = usableSize
    for (i in 0..n) {
        let info = parseCellAt(snapshot, readU16(tmp, cellPointerArrayOffset(page) + i * 2), usableSize)
        if (info.size <= 0 || info.size > usableSize) {
            throw SqliteFormatException(
                "page ${page.pageNo}: cell ${i} at ${info.offset} claims ${info.size} bytes, which cannot fit a page")
        }
        cursor -= info.size
        tmp.copyTo(page.data, info.offset, cursor, info.size)
        setCellOffset(page, i, cursor)
    }
    setContentStart(page, cursor)
    setFirstFreeblock(page, 0)
    setFragmentedBytes(page, 0)
}

/**
 * 在页内分配 size 字节的 cell 空间, 返回偏移; 放不下返回 -1。
 *
 * 调用方已经算进了新增的 2 字节指针槽 —— 这里只负责内容区。
 * 先试空闲链 (首次适配), 不行再用间隙, 还不行就整理后重试。
 */
func allocateCellSpace(page: Page, size: Int64, pageSize: Int64, usableSize: Int64): Int64 {
    // 写入旧版本产生的页时，先规范化已有链；不改变任何存活 cell 的字节与偏移。
    coalesceFreeblocks(page, usableSize)
    let ptrEnd = cellPointerArrayOffset(page) + cellCount(page) * 2 + 2
    // 空闲链里有内容空间不等于页头还有 2 字节指针槽。若间隙只剩 0/1 字节，
    // 先整理再分配，否则 insertCellBytes 会用新指针覆盖首个 cell 或 freeblock 头。
    if (contentStart(page, pageSize) < ptrEnd) {
        if (totalFreeBytes(page, pageSize, usableSize) < size + 2) { return -1 }
        defragmentPage(page, pageSize, usableSize)
        if (contentStart(page, pageSize) < ptrEnd) { return -1 }
    }
    if (let Some(off) <- takeFromFreeblocks(page, size, usableSize)) {
        return off
    }
    var cstart = contentStart(page, pageSize)
    if (cstart - ptrEnd >= size) {
        cstart -= size
        setContentStart(page, cstart)
        return cstart
    }
    // 间隙不够但总空闲够: 整理后再试。
    if (totalFreeBytes(page, pageSize, usableSize) >= size + 2) {
        defragmentPage(page, pageSize, usableSize)
        var after = contentStart(page, pageSize)
        let ptrEnd2 = cellPointerArrayOffset(page) + cellCount(page) * 2 + 2
        if (after - ptrEnd2 >= size) {
            after -= size
            setContentStart(page, after)
            return after
        }
    }
    -1
}

/** 从空闲链里摘一块 >= size 的; 摘不到返回 None。 */
func takeFromFreeblocks(page: Page, size: Int64, usableSize: Int64): Option<Int64> {
    var prev = 0
    var cur = firstFreeblock(page)
    var visited = 0
    while (cur != 0) {
        visited += 1
        if (visited > usableSize / FREEBLOCK_HEADER + 1) { throw SqliteFormatException("page ${page.pageNo} has a circular freeblock chain") }
        requireFreeblockFits(page, cur, usableSize)
        let blockSize = readU16(page.data, cur + 2)
        if (blockSize < FREEBLOCK_HEADER || cur + blockSize > usableSize) {
            throw SqliteFormatException("page ${page.pageNo}: invalid freeblock at ${cur}, size ${blockSize}")
        }
        if (blockSize >= size) {
            let next = readU16(page.data, cur)
            let leftover = blockSize - size
            if (leftover < FREEBLOCK_HEADER) {
                // 剩头太小, 进不了链: 整块拿走, 零头计入碎片。
                if (prev == 0) {
                    setFirstFreeblock(page, next)
                } else {
                    writeU16(page.data, prev, next)
                }
                setFragmentedBytes(page, fragmentedBytes(page) + leftover)
                return Some(cur)
            }
            // 从块尾切走 size 字节, 前半仍留在链上。
            writeU16(page.data, cur + 2, leftover)
            return Some(cur + leftover)
        }
        prev = cur
        cur = readU16(page.data, cur)
    }
    None
}

/**
 * 把 [off, off+size) 归还空闲链, 并与相邻空闲块合并。
 *
 * 合并不是优化而是正确性要求: 不合并时同一页反复增删会把空间切成一堆 4 字节以下的
 * 碎片, 最终 totalFreeBytes 显示有空间而 allocateCellSpace 拿不到 —— 表现为
 * "页明明是空的却报页满"。
 */
func releaseCellSpace(page: Page, off: Int64, size: Int64, usableSize: Int64): Unit {
    if (size < FREEBLOCK_HEADER) {
        setFragmentedBytes(page, fragmentedBytes(page) + size)
        return
    }
    var prev = 0
    var cur = firstFreeblock(page)
    // 空闲链按偏移升序维护, 找插入点。
    while (cur != 0 && cur < off) {
        prev = cur
        cur = readU16(page.data, cur)
    }
    writeU16(page.data, off, cur)
    writeU16(page.data, off + 2, size)
    if (prev == 0) {
        setFirstFreeblock(page, off)
    } else {
        writeU16(page.data, prev, off)
    }
    coalesceFreeblocks(page, usableSize)
}

/**
 * 把已编好的 cell 字节插到位置 idx (指针数组里的下标)。
 *
 * 返回 false 表示页内放不下 —— 由调用方决定分裂。这里不自己分裂: 分裂要动父页,
 * 而本文件只管单页布局, 混进来会让"页内布局"和"树形维护"两件事纠在一起。
 */
func insertCellBytes(page: Page, idx: Int64, cell: Array<Byte>, pageSize: Int64, usableSize: Int64): Bool {
    let off = allocateCellSpace(page, cell.size, pageSize, usableSize)
    if (off < 0) {
        return false
    }
    cell.copyTo(page.data, 0, off, cell.size)
    let n = cellCount(page)
    let base = cellPointerArrayOffset(page)
    // 指针数组往后挪一格, 腾出 idx。
    var i = n
    while (i > idx) {
        writeU16(page.data, base + i * 2, readU16(page.data, base + (i - 1) * 2))
        i -= 1
    }
    writeU16(page.data, base + idx * 2, off)
    setCellCount(page, n + 1)
    true
}

/** 删除位置 idx 的 cell: 指针数组前移, 内容空间归还空闲链。 */
func removeCellAt(page: Page, idx: Int64, pageSize: Int64, usableSize: Int64): Unit {
    let _ = pageSize
    let info = parseCell(page, idx, usableSize)
    let n = cellCount(page)
    let base = cellPointerArrayOffset(page)
    var i = idx
    while (i < n - 1) {
        writeU16(page.data, base + i * 2, readU16(page.data, base + (i + 1) * 2))
        i += 1
    }
    setCellCount(page, n - 1)
    releaseCellSpace(page, info.offset, info.size, usableSize)
}
