package sqlite_driver

import std.collection.*

/*
 * 空页摘除: 删除让某一页的 cell 数归零后, 把它从树上摘掉并归还 freelist。
 *
 * 这不是空间优化, 而是格式正确性要求。SQLite 对非根页要求 cell 数大于 0, 一个 0 cell
 * 的非根页会让它对**整库**报 "database disk image is malformed"。这里必须同时保证：
 * 取一个由 SQLite 写出的库, 只把中间一个叶页的 cell 数改成 0 (内容区起点与空闲块两种
 * 形态都试过), 它立刻拒读整个库, 连 count(*) 都不给。
 *
 * 而结构自检查不出这一项: 空页在"cell 有序、分界键区间、页归属唯一、freelist 自洽、
 * 索引与表双向一致"这五项上全自洽。所以缺陷会一路静默到互操作那一步才暴露, 判据必须
 * 单独加一项 (见 pragmaIntegrityCheck 的空页检查)。
 *
 * 摘除分三种形态, 由页在树里的位置决定:
 *   - 空叶页: 父页里指向它的那一项去掉, 页进 freelist。父页可能因此也空, 向上递归。
 *   - 0 cell 的内节点 (仍持有最右子页): 不能直接摘 —— 子树还挂在它下面。把父页里指向
 *     本页的指针改指本页的最右子页, 再摘掉本页。
 *   - 根页: 页号写在 sqlite_schema.rootpage 里不能换。0 cell 的叶根合法 (空表就是这个
 *     形态), 保留; 0 cell 的内节点根把唯一子页的内容搬上来再释放子页, 即分裂时
 *     moveRootDown 的逆操作。
 *
 * 索引树多一道手续: 父页里的分界 cell 是**真记录**, 不是键的副本 (表树的内节点 cell 只
 * 含 rowid, 摘掉不丢数据)。摘掉它等于从索引里删掉一个键, 所以要先把记录取出来, 整趟摘除
 * 结束后再插回。顺序不能反 —— 先插回再摘会让插入落到即将被摘掉的页上。
 */

/**
 * B-tree 深度上限, 用作递归下降的防环保护。
 *
 * SQLite 的游标深度上限是 20 层; 以最小页大小 512 计, 20 层能寻址的行数已远超单文件
 * 上限, 所以正常的树到不了这里, 触发它一定意味着页指针成环。
 */
const MAX_BTREE_DEPTH: Int64 = 20

/**
 * 沿路径自下向上摘除已空的页。
 *
 * path 是删除时记下的从根到目标页的路径。isTable 决定分界 cell 的处置;
 * colls / descs 只有索引树用得上 (插回记录时要比较键)。
 */
func pruneEmptyPages(pager: Pager, rootPage: Int64, path: ArrayList<PathStep>, isTable: Bool,
    colls: Array<SqliteCollation>, descs: Array<Bool>): Unit {
    if (path.isEmpty()) {
        return
    }
    pruneEmptyPagesFrom(pager, rootPage, path[path.size - 1].pageNo, isTable, colls, descs)
}

/**
 * 从指定页开始向上摘除。
 *
 * 每一轮重新确认"父页是谁、本页挂在父页的哪个位置", 不复用删除时记下的下标: 索引树的
 * 内节点删除会先插一条替代记录, 那次插入可能分裂并改动祖先, 让记录下来的路径失效。
 * 重新定位的代价只在真的有页变空时才付。
 */
func pruneEmptyPagesFrom(pager: Pager, rootPage: Int64, startPage: Int64, isTable: Bool, colls: Array<SqliteCollation>,
    descs: Array<Bool>): Unit {
    // 摘下来的索引分界记录攒着, 整趟结束后插回: 插入会分裂并改动父页, 与正在进行的
    // 摘除纠在一起会让刚定位到的父页失效。
    let pending = ArrayList<Array<Byte>>()
    var pageNo = startPage
    var guard = 0
    while (true) {
        guard += 1
        if (guard > pager.pageCount + 16) {
            throw SqliteFormatException("pruning empty pages under root ${rootPage} does not terminate")
        }
        let page = pager.getPage(pageNo)
        if (cellCount(page) > 0) {
            break
        }
        if (pageNo == rootPage) {
            collapseRootIfNeeded(pager, page)
            break
        }
        let ancestors = findPathToPage(pager, rootPage, pageNo)
        if (ancestors.size < 2) {
            // 页已不在树上 (上一轮就摘掉了), 或树形已变。两种情况都无事可做。
            break
        }
        let parentNo = ancestors[ancestors.size - 2]
        if (isLeafPage(page)) {
            detachEmptyLeaf(pager, parentNo, pageNo, isTable, pending)
        } else {
            spliceOutInteriorPage(pager, parentNo, page)
        }
        pageNo = parentNo
    }
    for (payload in pending) {
        let key = decodeRecord(payload, recordFieldCount(payload))
        btreeInsertIndexKey(pager, rootPage, key, colls, descs)
    }
}

/**
 * 摘掉一个空叶页: 父页里指向它的那一项去掉, 页归还 freelist。
 *
 * 父页里"指向本页"有两种位置, 处置不同:
 *   - 某个 cell 的左子页: 删那个 cell。剩下的分界键仍把两侧子树分得开 —— 被删的那段键
 *     区间是空的, 后续落进它的插入会走到相邻子树, 仍然有序。
 *   - 最右子页指针: 父页最后一个 cell 的左子页顶上来当最右子页, 再删那个 cell。
 */
func detachEmptyLeaf(pager: Pager, parentNo: Int64, pageNo: Int64, isTable: Bool, pending: ArrayList<Array<Byte>>): Unit {
    let parent = pager.getPage(parentNo)
    pager.markDirty(parent)
    let parentCells = cellCount(parent)
    let pos = childCellIndex(pager, parent, pageNo)
    var cellToRemove: Int64
    if (pos >= 0) {
        cellToRemove = pos
    } else {
        if (parentCells == 0) {
            // 父页只剩一个最右子页指针。指针置空, 下一轮把父页自己当空内节点处理。
            setRightChild(parent, 0)
            pager.freePage(pageNo)
            return
        }
        let last = parseCell(parent, parentCells - 1, pager.usableSize)
        setRightChild(parent, last.leftChild)
        cellToRemove = parentCells - 1
    }
    if (!isTable) {
        // 索引树: 分界 cell 是真记录, 取出来待插回, 别把键丢了。
        let info = parseCell(parent, cellToRemove, pager.usableSize)
        pending.add(readFullPayload(pager, parent, info))
        if (info.overflowPage != 0) {
            freeOverflowChain(pager, info.overflowPage)
        }
    }
    removeCellAt(parent, cellToRemove, pager.pageSize, pager.usableSize)
    pager.freePage(pageNo)
}

/**
 * 把一个 0 cell 的内节点从链里旁路掉: 父页里指向它的指针改指它的最右子页。
 *
 * 不能像空叶页那样摘 —— 最右子页下面还挂着整棵子树。旁路后本页无人引用, 进 freelist;
 * 子树的键区间没变, 父页里的分界键仍然成立。
 */
func spliceOutInteriorPage(pager: Pager, parentNo: Int64, page: Page): Unit {
    let onlyChild = rightChild(page)
    if (onlyChild == 0) {
        throw SqliteFormatException(
            "interior page ${page.pageNo} has no cells and no rightmost child; the tree is corrupt")
    }
    let parent = pager.getPage(parentNo)
    pager.markDirty(parent)
    let pos = childCellIndex(pager, parent, page.pageNo)
    if (pos >= 0) {
        // 左子页字段恒在 cell 起点的前 4 字节 —— 表树与索引树的内节点 cell 都是。
        writeU32(parent.data, parseCell(parent, pos, pager.usableSize).offset, onlyChild)
    } else {
        setRightChild(parent, onlyChild)
    }
    pager.freePage(page.pageNo)
}

/**
 * 页在父页里的 cell 下标; 返回 -1 表示它是父页的最右子页。
 *
 * 找不到时报告错误，因为路径与页内容不一致表示树已损坏或内部状态失配，不能继续修改文件。
 */
func childCellIndex(pager: Pager, parent: Page, childNo: Int64): Int64 {
    let n = cellCount(parent)
    for (i in 0..n) {
        if (parseCell(parent, i, pager.usableSize).leftChild == childNo) {
            return i
        }
    }
    if (rightChild(parent) == childNo) {
        return -1
    }
    throw SqliteFormatException("page ${parent.pageNo} does not reference child page ${childNo}")
}

/**
 * 从根到目标页的页号序列 (含两端); 目标不在树上时返回空。
 *
 * 深度优先而不是按键定位: 变空的页已经没有键可用来导航。只在真的有页变空时才走这条路,
 * 所以全树遍历的代价可接受。
 */
func findPathToPage(pager: Pager, rootPage: Int64, targetPage: Int64): ArrayList<Int64> {
    let path = ArrayList<Int64>()
    if (descendTo(pager, rootPage, targetPage, path, 0)) {
        return path
    }
    ArrayList<Int64>()
}

func descendTo(pager: Pager, pageNo: Int64, targetPage: Int64, path: ArrayList<Int64>, depth: Int64): Bool {
    if (depth > MAX_BTREE_DEPTH) {
        throw SqliteFormatException("B-tree is deeper than ${MAX_BTREE_DEPTH} levels; it is probably cyclic")
    }
    path.add(pageNo)
    if (pageNo == targetPage) {
        return true
    }
    let page = pager.getPage(pageNo)
    if (!isLeafPage(page)) {
        let n = cellCount(page)
        for (i in 0..n) {
            let child = parseCell(page, i, pager.usableSize).leftChild
            if (child != 0 && descendTo(pager, child, targetPage, path, depth + 1)) {
                return true
            }
        }
        let rc = rightChild(page)
        if (rc != 0 && descendTo(pager, rc, targetPage, path, depth + 1)) {
            return true
        }
    }
    path.remove(at: path.size - 1)
    false
}

/**
 * 根页变空时的处置。
 *
 * 叶根 0 cell 是合法形态 (空表), 什么都不做。内节点根 0 cell 则把唯一子页的内容整体搬
 * 上来, 子页释放 —— moveRootDown 的逆操作。根页号保持不变, sqlite_schema.rootpage 不用改。
 *
 * 第 1 页的页头在偏移 100 处, 可用空间比别的页少 100 字节。搬不下时保持现状: 一个"单子
 * 内节点根"是合法形态, 而搬一半会毁掉整棵树。
 */
func collapseRootIfNeeded(pager: Pager, root: Page): Unit {
    if (isLeafPage(root)) {
        return
    }
    let childNo = rightChild(root)
    if (childNo == 0) {
        throw SqliteFormatException("root page ${root.pageNo} is an interior page with no cells and no rightmost child")
    }
    let child = pager.getPage(childNo)
    validatePageType(child)
    let ptype = pageType(child)
    let cells = extractCells(child, pager.usableSize)
    let childRight = if (isLeafPage(child)) {
        0
    } else {
        rightChild(child)
    }
    pager.markDirty(root)
    let backup = Array<Byte>(root.data.size, repeat: 0)
    root.data.copyTo(backup, 0, 0, root.data.size)
    initPage(root, ptype, pager.usableSize)
    if (!isLeafPage(root)) {
        setRightChild(root, childRight)
    }
    if (!fillPage(root, cells, 0, cells.size, pager.pageSize, pager.usableSize)) {
        backup.copyTo(root.data, 0, 0, backup.size)
        return
    }
    // 子页的内容已搬走; 它的孙页现在由根直接引用, 只释放子页自己。
    pager.freePage(childNo)
}
