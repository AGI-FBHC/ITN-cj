package sqlite_driver

import std.collection.*

/*
 * B-tree 写路径: 插入、删除、页分裂与内节点维护。
 *
 * 分裂策略是"二分裂 + 向上传播": 一页放不下时拆成两页, 往父页插一个分界 cell;
 * 父页也满就继续往上, 一直到根。根满时把根**整体下移**到一个新页, 让根变成只有一个
 * 子页的内节点, 再对那个子页做普通分裂。
 *
 * 根整体下移这一步是必需的, 不能"就地把根拆成两页再造新根": 根页号写在 sqlite_schema
 * 的 rootpage 列里, 换根页号就要同步改 schema, 而 schema 自己的根页恒为 1 —— 于是
 * 表的根页号必须稳定。下移法让根页号永不改变。
 *
 * 另一处不能省的细节: 第 1 页的页头在偏移 100 处 (前面是文件头), 于是它的可用空间比
 * 其他页少 100 字节。下移法顺带回避了"把第 1 页当普通页分裂"这个不对称。
 *
 * 不实现 SQLite 那套多兄弟再平衡: 它把 3 个相邻兄弟的 cell 全部收集后重排。二分裂的
 * 空间利用率略低, 但 integrity_check 不检查页填充率 —— 它检查的是 cell 有序、父页分界
 * 键落在子页键区间内、页归属唯一、freelist 自洽。二分裂完全满足这些。
 */

/** 路径上的一层: 页号 + 在该页 cell 指针数组里的位置。 */
class PathStep {
    let pageNo: Int64
    let index: Int64

    init(pageNo: Int64, index: Int64) {
        this.pageNo = pageNo
        this.index = index
    }
}

/** 一页里拆出来的 cell 原始字节, 分裂时重排用。 */
class RawCell {
    let bytes: Array<Byte>
    /** 表树的 rowid; 索引树为 0。 */
    let rowid: Int64
    /** 内节点 cell 的左子页; 叶页为 0。 */
    let leftChild: Int64

    init(bytes: Array<Byte>, rowid: Int64, leftChild: Int64) {
        this.bytes = bytes
        this.rowid = rowid
        this.leftChild = leftChild
    }
}

/** 取出一页所有 cell 的原始字节 (按键序)。 */
func extractCells(page: Page, usableSize: Int64): ArrayList<RawCell> {
    let out = ArrayList<RawCell>()
    let n = cellCount(page)
    for (i in 0..n) {
        let info = parseCell(page, i, usableSize)
        let bytes = Array<Byte>(info.size, repeat: 0)
        page.data.copyTo(bytes, info.offset, 0, info.size)
        out.add(RawCell(bytes, info.rowid, info.leftChild))
    }
    out
}

/** 把一组 cell 依次写进一张空页。返回 false 表示放不下 (调用方需重新划分)。 */
func fillPage(page: Page, cells: ArrayList<RawCell>, from: Int64, to: Int64, pageSize: Int64, usableSize: Int64): Bool {
    for (i in from..to) {
        if (!insertCellBytes(page, cellCount(page), cells[i].bytes, pageSize, usableSize)) {
            return false
        }
    }
    true
}

/** 找一个把 cells 大致按字节数均分的下标 (左半的 cell 个数)。 */
func findSplitPoint(cells: ArrayList<RawCell>): Int64 {
    var total = 0
    for (c in cells) {
        total += c.bytes.size + 2
    }
    var acc = 0
    var i = 0
    while (i < cells.size - 1) {
        acc += cells[i].bytes.size + 2
        if (acc * 2 >= total) {
            return i + 1
        }
        i += 1
    }
    if (cells.size > 1) {
        cells.size - 1
    } else {
        1
    }
}

/**
 * 在 pathIdx 层的页上插入一个 cell, 必要时分裂并向上传播。
 *
 * path 是从根到目标页的路径 (seek 时记下的)。cellIdx 是插入位置。
 */
func insertCellWithSplit(pager: Pager, path: ArrayList<PathStep>, pathIdx: Int64, cellIdx: Int64, cell: Array<Byte>): Unit {
    let page = pager.getPage(path[pathIdx].pageNo)
    pager.markDirty(page)
    if (insertCellBytes(page, cellIdx, cell, pager.pageSize, pager.usableSize)) {
        return
    }
    splitAndInsert(pager, path, pathIdx, cellIdx, cell)
}

/**
 * 分裂 pathIdx 层的页, 并把 cell 插进正确的一半。
 *
 * 分界 cell 的处理按树类型分两种:
 *   - 表树叶页: 分界键是左半最大 rowid 的**副本** (键仍留在叶页里)。表树的内节点
 *     cell 不含数据, 复制键不会重复存储行。
 *   - 索引树: 分界 cell 是左半最后一条记录本身, **上移**到父页 (从子页移走)。索引树的
 *     内节点 cell 是真记录, 复制会让同一个键在树里出现两次, integrity_check 会报
 *     "index entry count mismatch"。
 *   - 内节点分裂: 左半最后一个 cell 上移, 它的左子页成为左半页的最右子页。
 */
func splitAndInsert(pager: Pager, path: ArrayList<PathStep>, pathIdx: Int64, cellIdx: Int64, cell: Array<Byte>): Unit {
    let pageNo = path[pathIdx].pageNo
    let page = pager.getPage(pageNo)
    let ptype = pageType(page)
    let leaf = isLeafPage(page)
    let table = isTablePage(page)

    // 根页分裂: 先把根整体搬到新页, 根变成单子内节点, 然后对新页重做插入。
    if (pathIdx == 0) {
        moveRootDown(pager, page)
        let childNo = rightChild(page)
        let newPath = ArrayList<PathStep>()
        newPath.add(PathStep(pageNo, 0))
        newPath.add(PathStep(childNo, cellIdx))
        insertCellWithSplit(pager, newPath, 1, cellIdx, cell)
        return
    }

    let cells = extractCells(page, pager.usableSize)
    // 把新 cell 放进正确位置后一起重排。
    let newRowid = if (table && !leaf) {
        readVarint(cell, 4).value
    } else if (table) {
        readVarint(cell, readVarint(cell, 0).size).value
    } else {
        0
    }
    let newLeftChild = if (!leaf) {
        readU32(cell, 0)
    } else {
        0
    }
    cells.add(RawCell(cell, newRowid, newLeftChild), at: cellIdx)

    let splitAt = findSplitPoint(cells)
    let sibling = pager.allocatePage()
    pager.markDirty(page)
    pager.markDirty(sibling)

    // 分界 cell 与两半的范围。
    var leftEnd = splitAt
    var rightStart = splitAt
    let dividerCell: Array<Byte>
    var leftRightChild = 0

    if (leaf && table) {
        // 表叶页: 复制左半最大 rowid 当分界键。
        let maxRowid = cells[splitAt - 1].rowid
        dividerCell = buildTableInteriorCell(pageNo, maxRowid)
    } else if (leaf) {
        // 索引叶页: 左半最后一条记录上移。
        let promoted = cells[splitAt - 1]
        dividerCell = buildInteriorFromIndexLeafCell(promoted.bytes, pageNo)
        leftEnd = splitAt - 1
    } else if (table) {
        // 表内节点: 左半最后一个 cell 上移, 其左子页成为左半的最右子页。
        let promoted = cells[splitAt - 1]
        leftRightChild = promoted.leftChild
        dividerCell = buildTableInteriorCell(pageNo, promoted.rowid)
        leftEnd = splitAt - 1
    } else {
        // 索引内节点: 同上, 但分界 cell 要换成指向左半页。
        let promoted = cells[splitAt - 1]
        leftRightChild = promoted.leftChild
        dividerCell = rewriteInteriorCellChild(promoted.bytes, pageNo)
        leftEnd = splitAt - 1
    }

    // 右半页继承原页的最右子页 (内节点) 或直接是叶页。
    let originalRightChild = if (leaf) {
        0
    } else {
        rightChild(page)
    }

    // 重建两页。原页留左半, sibling 收右半 —— 保持原页号不变, 免得改父页里已有的指针。
    // 两页都按整个 usableSize 初始化。第 1 页的前 100 字节是文件头, 但那一段的扣除已经
    // 由 cellPointerArrayOffset (经 pageHeaderOffset) 完成 —— 内容区仍从 usableSize 向下
    // 生长, 只是可放的字节更少。这里再扣一次 100 会让第 1 页的内容区起点算错。
    initPage(page, ptype, pager.usableSize)
    initPage(sibling, ptype, pager.usableSize)
    if (!fillPage(page, cells, 0, leftEnd, pager.pageSize, pager.usableSize)) {
        throw SqliteFormatException("left half of the split does not fit on page ${pageNo}")
    }
    if (!fillPage(sibling, cells, rightStart, cells.size, pager.pageSize, pager.usableSize)) {
        throw SqliteFormatException("right half of the split does not fit on page ${sibling.pageNo}")
    }
    if (!leaf) {
        setRightChild(page, leftRightChild)
        setRightChild(sibling, originalRightChild)
    }

    // 分界 cell 进父页: 它指向左半 (原页号), 父页里原本指向本页的那个位置改指 sibling。
    linkSiblingIntoParent(pager, path, pathIdx, dividerCell, sibling.pageNo)
}

/**
 * 把分界 cell 插进父页, 并让父页里原先指向本页的指针改指 sibling。
 *
 * 父页里"指向本页"的位置有两种形态: 某个 cell 的左子页, 或最右子页指针。两种都要改,
 * 漏一种会让 sibling 成为无人引用的页 (integrity_check 报页丢失), 或让原页被引用两次。
 */
func linkSiblingIntoParent(pager: Pager, path: ArrayList<PathStep>, pathIdx: Int64, dividerCell: Array<Byte>,
    siblingNo: Int64): Unit {
    let parentIdx = pathIdx - 1
    let parent = pager.getPage(path[parentIdx].pageNo)
    pager.markDirty(parent)
    let childPos = path[parentIdx].index
    let n = cellCount(parent)
    if (childPos < n) {
        // 本页是 childPos 处 cell 的左子页: 该 cell 改指 sibling, 分界 cell 插在它前面。
        let info = parseCell(parent, childPos, pager.usableSize)
        writeU32(parent.data, info.offset, siblingNo)
    } else {
        // 本页是最右子页: sibling 成为新的最右子页, 分界 cell 追加到末尾。
        setRightChild(parent, siblingNo)
    }
    insertCellWithSplit(pager, path, parentIdx, childPos, dividerCell)
}

/**
 * 把根页内容整体搬到一个新页, 根变成只有最右子页的内节点。
 *
 * 搬完后根页号不变, 于是 sqlite_schema 里的 rootpage 不用改。
 */
func moveRootDown(pager: Pager, root: Page): Unit {
    let ptype = pageType(root)
    let child = pager.allocatePage()
    pager.markDirty(root)
    pager.markDirty(child)
    // 复制 cell 到新页。根页的页头可能在偏移 100 (第 1 页), 新页恒在 0, 所以逐 cell 重建
    // 而不是整页 memcpy。
    let cells = extractCells(root, pager.usableSize)
    initPage(child, ptype, pager.usableSize)
    if (!isLeafPage(root)) {
        setRightChild(child, rightChild(root))
    }
    if (!fillPage(child, cells, 0, cells.size, pager.pageSize, pager.usableSize)) {
        throw SqliteFormatException("root page contents do not fit on the new child page ${child.pageNo}")
    }
    let interiorType = if (isTablePage(root)) {
        PT_TABLE_INTERIOR
    } else {
        PT_INDEX_INTERIOR
    }
    initPage(root, interiorType, pager.usableSize)
    setRightChild(root, child.pageNo)
}

/** 索引叶页 cell → 索引内节点 cell: 前面加 4 字节左子页。 */
func buildInteriorFromIndexLeafCell(leafCell: Array<Byte>, leftChild: Int64): Array<Byte> {
    let out = Array<Byte>(leafCell.size + 4, repeat: 0)
    writeU32(out, 0, leftChild)
    leafCell.copyTo(out, 0, 4, leafCell.size)
    out
}

/** 改写索引内节点 cell 的左子页字段。 */
func rewriteInteriorCellChild(cell: Array<Byte>, leftChild: Int64): Array<Byte> {
    let out = Array<Byte>(cell.size, repeat: 0)
    cell.copyTo(out, 0, 0, cell.size)
    writeU32(out, 0, leftChild)
    out
}

/** 索引内节点 cell → 索引叶页 cell: 去掉前 4 字节。 */
func stripInteriorCellChild(cell: Array<Byte>): Array<Byte> {
    cell[4..cell.size]
}

/*
 * 表树的插入与删除。
 */

/** 定位并记下路径, 供插入时向上传播分裂。 */
func seekTableForWrite(pager: Pager, rootPage: Int64, rowid: Int64): (ArrayList<PathStep>, Bool, Int64) {
    let path = ArrayList<PathStep>()
    var pageNo = rootPage
    while (true) {
        let page = pager.getPage(pageNo)
        validatePageType(page)
        let n = cellCount(page)
        if (isLeafPage(page)) {
            var lo = 0
            var hi = n - 1
            var pos = n
            var found = false
            while (lo <= hi) {
                let mid = (lo + hi) / 2
                let midKey = parseCell(page, mid, pager.usableSize).rowid
                if (midKey == rowid) {
                    pos = mid
                    found = true
                    break
                }
                if (midKey < rowid) {
                    lo = mid + 1
                } else {
                    pos = mid
                    hi = mid - 1
                }
            }
            path.add(PathStep(pageNo, pos))
            return (path, found, pos)
        }
        var lo = 0
        var hi = n - 1
        var target = n
        while (lo <= hi) {
            let mid = (lo + hi) / 2
            let midKey = parseCell(page, mid, pager.usableSize).rowid
            if (midKey >= rowid) {
                target = mid
                hi = mid - 1
            } else {
                lo = mid + 1
            }
        }
        path.add(PathStep(pageNo, target))
        let child = if (target < n) {
            parseCell(page, target, pager.usableSize).leftChild
        } else {
            rightChild(page)
        }
        if (child == 0) {
            throw SqliteFormatException("interior page ${pageNo} has a null child pointer")
        }
        pageNo = child
    }
    (path, false, 0)
}

/**
 * 表树插入或替换一行。
 *
 * replaceExisting 为真时同 rowid 的旧行被覆盖 (INSERT OR REPLACE / UPDATE 用);
 * 为假时同 rowid 已存在则抛 —— 静默覆盖会让 INSERT 悄悄丢掉已有行。
 */
func btreeInsertRow(pager: Pager, rootPage: Int64, rowid: Int64, payload: Array<Byte>, replaceExisting: Bool): Unit {
    let (path, found, pos) = seekTableForWrite(pager, rootPage, rowid)
    let leafNo = path[path.size - 1].pageNo
    let leaf = pager.getPage(leafNo)
    if (found) {
        if (!replaceExisting) {
            throw SqliteConstraintException("primarykey", "", "a row with rowid ${rowid} already exists")
        }
        pager.markDirty(leaf)
        let old = parseCell(leaf, pos, pager.usableSize)
        if (old.overflowPage != 0) {
            freeOverflowChain(pager, old.overflowPage)
        }
        removeCellAt(leaf, pos, pager.pageSize, pager.usableSize)
    }
    let cell = buildTableLeafCell(pager, rowid, payload)
    insertCellWithSplit(pager, path, path.size - 1, pos, cell)
}

/** 表树删除一行。返回是否真的删掉了。 */
func btreeDeleteRow(pager: Pager, rootPage: Int64, rowid: Int64): Bool {
    let (path, found, pos) = seekTableForWrite(pager, rootPage, rowid)
    if (!found) {
        return false
    }
    let leaf = pager.getPage(path[path.size - 1].pageNo)
    pager.markDirty(leaf)
    let info = parseCell(leaf, pos, pager.usableSize)
    if (info.overflowPage != 0) {
        freeOverflowChain(pager, info.overflowPage)
    }
    removeCellAt(leaf, pos, pager.pageSize, pager.usableSize)
    // 页被删空则必须摘掉: SQLite 把 0 cell 的非根页判为整库损坏, 留在原处会产出它
    // 拒读的文件。空的**叶根**是合法形态 (新建的空表就是它), pruneEmptyPages 会放过。
    pruneEmptyPages(pager, rootPage, path, true, Array<SqliteCollation>(), Array<Bool>())
    true
}

/** 表树里当前最大的 rowid; 空树返回 0。供 AUTOINCREMENT 与新 rowid 分配用。 */
func btreeMaxRowid(pager: Pager, rootPage: Int64): Int64 {
    let cursor = BtreeCursor(pager, rootPage, true)
    if (!cursor.last()) {
        return 0
    }
    cursor.currentRowid()
}

/*
 * 索引树的插入与删除。索引没有 rowid, 键就是记录本身 (末列惯例上是 rowid)。
 */
func seekIndexForWrite(pager: Pager, rootPage: Int64, key: Array<SqliteValue>, colls: Array<SqliteCollation>,
    descs: Array<Bool>): (ArrayList<PathStep>, Bool) {
    let path = ArrayList<PathStep>()
    var pageNo = rootPage
    while (true) {
        let page = pager.getPage(pageNo)
        validatePageType(page)
        let n = cellCount(page)
        var lo = 0
        var hi = n - 1
        var target = n
        var exact = false
        while (lo <= hi) {
            let mid = (lo + hi) / 2
            let cell = parseCell(page, mid, pager.usableSize)
            let midKey = decodeRecord(readFullPayload(pager, page, cell), key.size)
            let c = compareIndexKeys(midKey, key, colls, descs)
            if (c >= 0) {
                target = mid
                if (c == 0) {
                    exact = true
                }
                hi = mid - 1
            } else {
                lo = mid + 1
            }
        }
        path.add(PathStep(pageNo, target))
        if (isLeafPage(page)) {
            return (path, exact)
        }
        if (exact) {
            // 键就在这个内节点上 —— 索引树的内节点 cell 是真记录。
            return (path, true)
        }
        let child = if (target < n) {
            parseCell(page, target, pager.usableSize).leftChild
        } else {
            rightChild(page)
        }
        if (child == 0) {
            throw SqliteFormatException("interior page ${pageNo} has a null child pointer")
        }
        pageNo = child
    }
    (path, false)
}

/** 索引树插入一条键记录。 */
func btreeInsertIndexKey(pager: Pager, rootPage: Int64, key: Array<SqliteValue>, colls: Array<SqliteCollation>,
    descs: Array<Bool>): Unit {
    let (path, _) = seekIndexForWrite(pager, rootPage, key, colls, descs)
    let payload = encodeRecord(key)
    let last = path[path.size - 1]
    let page = pager.getPage(last.pageNo)
    if (!isLeafPage(page)) {
        // 定位停在内节点上 (键与某个分界记录相等)。插到它的左子树最右端才保持有序。
        let deepPath = descendRightmost(pager, path, last.index)
        let leafStep = deepPath[deepPath.size - 1]
        let leafPage = pager.getPage(leafStep.pageNo)
        let cell = buildIndexCell(pager, payload, 0, false)
        insertCellWithSplit(pager, deepPath, deepPath.size - 1, cellCount(leafPage), cell)
        return
    }
    let cell = buildIndexCell(pager, payload, 0, false)
    insertCellWithSplit(pager, path, path.size - 1, last.index, cell)
}

/**
 * 按 key 定位，但把独立的 payload 存进索引树。
 *
 * WITHOUT ROWID 表用主键前缀定位，cell payload 却是完整行 record。普通索引的 key 与
 * payload 相同，原来的 btreeInsertIndexKey 无法表达这一形态。
 */
func btreeInsertIndexPayload(pager: Pager, rootPage: Int64, key: Array<SqliteValue>, payload: Array<Byte>,
    colls: Array<SqliteCollation>, descs: Array<Bool>, replaceExisting: Bool): Unit {
    let (path, found) = seekIndexForWrite(pager, rootPage, key, colls, descs)
    if (found) {
        if (!replaceExisting) {
            throw SqliteConstraintException("primarykey", "", "an index-tree key already exists")
        }
        let _ = btreeDeleteIndexKey(pager, rootPage, key, colls, descs)
        btreeInsertIndexPayload(pager, rootPage, key, payload, colls, descs, false)
        return
    }
    let last = path[path.size - 1]
    let page = pager.getPage(last.pageNo)
    if (!isLeafPage(page)) {
        let deepPath = descendRightmost(pager, path, last.index)
        let leafStep = deepPath[deepPath.size - 1]
        let leafPage = pager.getPage(leafStep.pageNo)
        let cell = buildIndexCell(pager, payload, 0, false)
        insertCellWithSplit(pager, deepPath, deepPath.size - 1, cellCount(leafPage), cell)
        return
    }
    let cell = buildIndexCell(pager, payload, 0, false)
    insertCellWithSplit(pager, path, path.size - 1, last.index, cell)
}

/** 从 path 末层的 index 处子树一路下降到最右叶页, 扩展 path。 */
func descendRightmost(pager: Pager, path: ArrayList<PathStep>, childIndex: Int64): ArrayList<PathStep> {
    let out = ArrayList<PathStep>()
    for (s in path) {
        out.add(s)
    }
    let top = out[out.size - 1]
    let page = pager.getPage(top.pageNo)
    var childNo = if (childIndex < cellCount(page)) {
        parseCell(page, childIndex, pager.usableSize).leftChild
    } else {
        rightChild(page)
    }
    while (true) {
        let p = pager.getPage(childNo)
        validatePageType(p)
        if (isLeafPage(p)) {
            out.add(PathStep(childNo, cellCount(p)))
            return out
        }
        out.add(PathStep(childNo, cellCount(p)))
        childNo = rightChild(p)
        if (childNo == 0) {
            throw SqliteFormatException("interior page has a null right child while descending")
        }
    }
    out
}

/**
 * 索引树删除一条键记录。返回是否删到。
 *
 * 键落在内节点上时不能直接删 cell —— 那会断开它两侧的子树。做法与 SQLite 一致:
 * 用左子树最右叶页的最后一条记录顶上来, 再删那条叶记录。
 */
func btreeDeleteIndexKey(pager: Pager, rootPage: Int64, key: Array<SqliteValue>, colls: Array<SqliteCollation>,
    descs: Array<Bool>): Bool {
    let (path, found) = seekIndexForWrite(pager, rootPage, key, colls, descs)
    if (!found) {
        return false
    }
    let step = path[path.size - 1]
    let page = pager.getPage(step.pageNo)
    pager.markDirty(page)
    if (isLeafPage(page)) {
        let info = parseCell(page, step.index, pager.usableSize)
        if (info.overflowPage != 0) {
            freeOverflowChain(pager, info.overflowPage)
        }
        removeCellAt(page, step.index, pager.pageSize, pager.usableSize)
        pruneEmptyPages(pager, rootPage, path, false, colls, descs)
        return true
    }
    // 内节点: 取左子树最右叶页的最后一条记录当替代。
    let deepPath = descendRightmost(pager, path, step.index)
    let leafStep = deepPath[deepPath.size - 1]
    let leafPage = pager.getPage(leafStep.pageNo)
    pager.markDirty(leafPage)
    let leafN = cellCount(leafPage)
    if (leafN == 0) {
        // 左子树最右叶页是空的 —— 没有可提升的记录。此时直接删内节点 cell 会断树,
        // 故退回"标记删除不可行"并抛: 这种形态只可能来自已损坏的树。
        throw SqliteFormatException(
            "cannot delete interior index entry: leftmost subtree of page ${step.pageNo} has an empty rightmost leaf")
    }
    let replacementInfo = parseCell(leafPage, leafN - 1, pager.usableSize)
    let replacement = readFullPayload(pager, leafPage, replacementInfo)
    if (replacementInfo.overflowPage != 0) {
        freeOverflowChain(pager, replacementInfo.overflowPage)
    }
    removeCellAt(leafPage, leafN - 1, pager.pageSize, pager.usableSize)

    // 换掉内节点 cell: 先删旧的 (释放其溢出链), 再插新的 (保留原左子页)。
    let oldInfo = parseCell(page, step.index, pager.usableSize)
    let leftChildNo = oldInfo.leftChild
    if (oldInfo.overflowPage != 0) {
        freeOverflowChain(pager, oldInfo.overflowPage)
    }
    removeCellAt(page, step.index, pager.pageSize, pager.usableSize)
    let newCell = buildIndexCell(pager, replacement, leftChildNo, true)
    insertCellWithSplit(pager, path, path.size - 1, step.index, newCell)
    // 顶上来的那条记录是从叶页摘走的, 叶页可能因此变空。这里按页号重新定位而不是复用
    // deepPath: 上面那次插入可能分裂并改动祖先, 记下的路径已经不可信。
    pruneEmptyPagesFrom(pager, rootPage, leafStep.pageNo, false, colls, descs)
    true
}

/**
 * 建一棵空树, 返回根页号。
 *
 * tableTree 决定叶页类型：表树是 0x0D，索引树是 0x0A。类型错误会使文件格式无效。
 */
func btreeCreate(pager: Pager, tableTree: Bool): Int64 {
    let page = pager.allocatePage()
    pager.markDirty(page)
    let ptype = if (tableTree) {
        PT_TABLE_LEAF
    } else {
        PT_INDEX_LEAF
    }
    initPage(page, ptype, pager.usableSize)
    page.pageNo
}

/** 释放整棵树的所有页 (DROP TABLE / DROP INDEX)。 */
func btreeDestroy(pager: Pager, rootPage: Int64): Unit {
    let pages = ArrayList<Int64>()
    collectTreePages(pager, rootPage, pages)
    for (no in pages) {
        pager.freePage(no)
    }
}

/** 收集一棵树占用的所有页 (含溢出页), 供 DROP 与 integrity_check 使用。 */
func collectTreePages(pager: Pager, rootPage: Int64, into: ArrayList<Int64>): Unit {
    let stack = ArrayList<Int64>()
    stack.add(rootPage)
    var guard = 0
    while (stack.size > 0) {
        guard += 1
        if (guard > pager.pageCount * 2 + 16) {
            throw SqliteFormatException("B-tree rooted at page ${rootPage} appears to contain a cycle")
        }
        let no = stack[stack.size - 1]
        stack.remove(at: stack.size - 1)
        into.add(no)
        let page = pager.getPage(no)
        validatePageType(page)
        let n = cellCount(page)
        for (i in 0..n) {
            let info = parseCell(page, i, pager.usableSize)
            if (info.overflowPage != 0) {
                overflowChainPages(pager, info.overflowPage, into)
            }
            if (!isLeafPage(page) && info.leftChild != 0) {
                stack.add(info.leftChild)
            }
        }
        if (!isLeafPage(page)) {
            let rc = rightChild(page)
            if (rc != 0) {
                stack.add(rc)
            }
        }
    }
}
