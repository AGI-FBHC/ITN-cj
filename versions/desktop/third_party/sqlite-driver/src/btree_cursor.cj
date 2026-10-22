package sqlite_driver

import std.collection.*

/*
 * B-tree 游标: 在一棵树上定位与顺序移动。
 *
 * 用显式的父页栈而不是递归: 树深受页大小与键长影响, 递归遍历在深树上会吃掉调用栈,
 * 而"退回父页继续下一个 cell"这个动作用栈表达也最直接。
 *
 * 栈帧带一个 descendPending 状态位, 不能只用下标。原因: 索引树的内节点 cell **是记录**,
 * 中序遍历必须走"子树 index → cell index → 子树 index+1 → cell index+1 → …"。
 * 只有下标时, "即将下降到 index 的子树"与"已访问过 index 处的 cell"这两个状态同形,
 * next() 会把同一个 cell 反复交出来, 且中间整棵子树被跳过 —— 而这在小表上完全看不出来
 * (小表只有一层, 内节点不存在)。表树的内节点 cell 只有 rowid 与子页指针、不是记录,
 * 所以 isTable 为真时跳过"访问 cell"这一步。
 */
class CursorFrame {
    let pageNo: Int64
    /** 内节点: 0..cellCount 的位置; 叶页: cell 下标。 */
    var index: Int64
    /** 内节点专用: 下一步该下降到 index 处的子树 (true), 还是访问 index 处的 cell (false)。 */
    var descendPending: Bool

    init(pageNo: Int64, index: Int64, descendPending: Bool) {
        this.pageNo = pageNo
        this.index = index
        this.descendPending = descendPending
    }
}

/** 一条表记录: rowid + 完整 payload 字节。 */
class TableEntry {
    let rowid: Int64
    let payload: Array<Byte>

    init(rowid: Int64, payload: Array<Byte>) {
        this.rowid = rowid
        this.payload = payload
    }
}

class BtreeCursor {
    private let pager: Pager
    let rootPage: Int64
    /** 表 B-tree (按 rowid 索引) 还是索引 B-tree (按 record 索引)。 */
    let isTable: Bool
    private let stack = ArrayList<CursorFrame>()
    private var valid: Bool = false

    init(pager: Pager, rootPage: Int64, isTable: Bool) {
        this.pager = pager
        this.rootPage = rootPage
        this.isTable = isTable
    }

    prop isValid: Bool {
        get() {
            valid
        }
    }

    private func topFrame(): CursorFrame {
        stack[stack.size - 1]
    }

    private func currentPage(): Page {
        pager.getPage(topFrame().pageNo)
    }

    /** 移到第一条记录。空树返回 false。 */
    func first(): Bool {
        stack.clear()
        valid = false
        stack.add(CursorFrame(rootPage, 0, true))
        settleForward()
    }

    /** 移到最后一条记录。 */
    func last(): Bool {
        stack.clear()
        valid = false
        let page = pager.getPage(rootPage)
        validatePageType(page)
        if (isLeafPage(page)) {
            stack.add(CursorFrame(rootPage, cellCount(page) - 1, false))
        } else {
            stack.add(CursorFrame(rootPage, cellCount(page), true))
        }
        settleBackward()
    }

    /** 前进一条。 */
    func next(): Bool {
        if (!valid) {
            return false
        }
        let frame = topFrame()
        let page = pager.getPage(frame.pageNo)
        if (isLeafPage(page)) {
            frame.index += 1
        } else {
            // 刚交出的是内节点 index 处的 cell, 下一步下降到 index+1 的子树。
            frame.index += 1
            frame.descendPending = true
        }
        settleForward()
    }

    /**
     * 把游标推到下一个真实记录上。
     *
     * 循环不变式: 栈顶帧描述"接下来要做的事"。叶页看下标是否还在范围内; 内节点按
     * descendPending 决定下降还是交出本页 cell。做不动就弹栈, 让父页继续。
     */
    private func settleForward(): Bool {
        while (stack.size > 0) {
            let frame = topFrame()
            let page = pager.getPage(frame.pageNo)
            validatePageType(page)
            let n = cellCount(page)
            if (isLeafPage(page)) {
                if (frame.index < n) {
                    valid = true
                    return true
                }
                popAndAdvanceParent()
                continue
            }
            if (frame.descendPending) {
                frame.descendPending = false
                let child = if (frame.index < n) {
                    parseCell(page, frame.index, pager.usableSize).leftChild
                } else {
                    rightChild(page)
                }
                if (child == 0) {
                    throw SqliteFormatException("interior page ${frame.pageNo} has a null child pointer")
                }
                pushChildForward(child)
                continue
            }
            // 子树走完, 回到本页: 索引树要交出 index 处的记录, 表树直接跳到下一子树。
            if (frame.index < n) {
                if (!isTable) {
                    valid = true
                    return true
                }
                frame.index += 1
                frame.descendPending = true
                continue
            }
            popAndAdvanceParent()
        }
        valid = false
        false
    }

    private func popAndAdvanceParent(): Unit {
        stack.remove(at: stack.size - 1)
        if (stack.size > 0) {
            let parent = topFrame()
            // 父页的 index 处子树刚走完: 索引树接下来交出 index 处的 cell (descendPending
            // 已是 false), 表树则要推进到下一子树 —— 由 settleForward 的分支处理。
            parent.descendPending = false
        }
    }

    private func pushChildForward(child: Int64): Unit {
        let page = pager.getPage(child)
        validatePageType(page)
        if (isLeafPage(page)) {
            stack.add(CursorFrame(child, 0, false))
        } else {
            stack.add(CursorFrame(child, 0, true))
        }
    }

    /** 后退一条, 供 ORDER BY DESC 与反向扫描使用。 */
    func prev(): Bool {
        if (!valid) {
            return false
        }
        let frame = topFrame()
        let page = pager.getPage(frame.pageNo)
        if (isLeafPage(page)) {
            frame.index -= 1
        } else {
            // 刚交出内节点 index 处的 cell, 下一步进入 index 处的子树 (它在 cell 左边)。
            frame.descendPending = true
        }
        settleBackward()
    }

    private func settleBackward(): Bool {
        while (stack.size > 0) {
            let frame = topFrame()
            let page = pager.getPage(frame.pageNo)
            validatePageType(page)
            let n = cellCount(page)
            if (isLeafPage(page)) {
                if (frame.index >= 0 && frame.index < n) {
                    valid = true
                    return true
                }
                popAndRetreatParent()
                continue
            }
            if (frame.descendPending) {
                frame.descendPending = false
                let child = if (frame.index < n) {
                    parseCell(page, frame.index, pager.usableSize).leftChild
                } else {
                    rightChild(page)
                }
                if (child == 0) {
                    throw SqliteFormatException("interior page ${frame.pageNo} has a null child pointer")
                }
                pushChildBackward(child)
                continue
            }
            // 子树 index 已走完 (反向): 索引树交出 index-1 处的 cell。
            if (frame.index - 1 >= 0) {
                frame.index -= 1
                if (!isTable) {
                    valid = true
                    return true
                }
                frame.descendPending = true
                continue
            }
            popAndRetreatParent()
        }
        valid = false
        false
    }

    private func popAndRetreatParent(): Unit {
        stack.remove(at: stack.size - 1)
        if (stack.size > 0) {
            topFrame().descendPending = false
        }
    }

    private func pushChildBackward(child: Int64): Unit {
        let page = pager.getPage(child)
        validatePageType(page)
        if (isLeafPage(page)) {
            stack.add(CursorFrame(child, cellCount(page) - 1, false))
        } else {
            stack.add(CursorFrame(child, cellCount(page), true))
        }
    }

    /** 当前 cell。 */
    func currentCell(): CellInfo {
        if (!valid) {
            throw SqliteRuntimeException("cursor", "cursor is not positioned on a row")
        }
        parseCell(currentPage(), topFrame().index, pager.usableSize)
    }

    /** 当前记录的 rowid (表树)。 */
    func currentRowid(): Int64 {
        currentCell().rowid
    }

    /** 当前记录的完整 payload。 */
    func currentPayload(): Array<Byte> {
        let page = currentPage()
        readFullPayload(pager, page, parseCell(page, topFrame().index, pager.usableSize))
    }

    /**
     * 表树按 rowid 定位。
     *
     * 返回 true 表示精确命中; false 表示未命中, 此时游标停在**第一个大于 key 的记录**上
     * (或失效)。区分这两种结果是"点查"与"范围扫描起点"共用同一入口的前提。
     */
    func seekRowid(key: Int64): Bool {
        stack.clear()
        valid = false
        var pageNo = rootPage
        while (true) {
            let page = pager.getPage(pageNo)
            validatePageType(page)
            let n = cellCount(page)
            if (isLeafPage(page)) {
                var lo = 0
                var hi = n - 1
                var pos = n
                while (lo <= hi) {
                    let mid = (lo + hi) / 2
                    let midKey = parseCell(page, mid, pager.usableSize).rowid
                    if (midKey == key) {
                        stack.add(CursorFrame(pageNo, mid, false))
                        valid = true
                        return true
                    }
                    if (midKey < key) {
                        lo = mid + 1
                    } else {
                        pos = mid
                        hi = mid - 1
                    }
                }
                stack.add(CursorFrame(pageNo, pos, false))
                let _ = settleForward()
                return false
            }
            // 内节点: 找第一个 rowid >= key 的 cell, 走它的左子页; 都小于则走最右子页。
            var lo = 0
            var hi = n - 1
            var target = n
            while (lo <= hi) {
                let mid = (lo + hi) / 2
                let midKey = parseCell(page, mid, pager.usableSize).rowid
                if (midKey >= key) {
                    target = mid
                    hi = mid - 1
                } else {
                    lo = mid + 1
                }
            }
            stack.add(CursorFrame(pageNo, target, false))
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
        false
    }

    /**
     * 索引树定位到第一个 >= key 的记录, 返回是否精确命中。
     *
     * key 可以是前缀 (列数少于索引列数): "前缀相同则短者更小"的规则让游标停在该前缀的
     * 第一条记录上, 这正是 `WHERE a = ?` 用 (a, b) 复合索引的查法。
     */
    func seekIndex(key: Array<SqliteValue>, colls: Array<SqliteCollation>, descs: Array<Bool>): Bool {
        stack.clear()
        valid = false
        var pageNo = rootPage
        var exact = false
        while (true) {
            let page = pager.getPage(pageNo)
            validatePageType(page)
            let n = cellCount(page)
            var lo = 0
            var hi = n - 1
            var target = n
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
            if (isLeafPage(page)) {
                stack.add(CursorFrame(pageNo, target, false))
                let ok = settleForward()
                return exact && ok
            }
            // 内节点: target 处的 cell 键 >= key, 故答案在它的左子树里, 或就是它自己。
            stack.add(CursorFrame(pageNo, target, true))
            let child = if (target < n) {
                parseCell(page, target, pager.usableSize).leftChild
            } else {
                rightChild(page)
            }
            if (child == 0) {
                throw SqliteFormatException("interior page ${pageNo} has a null child pointer")
            }
            // 已决定下降, 清掉 descendPending 以免 settleForward 再降一次。
            stack[stack.size - 1].descendPending = false
            pageNo = child
        }
        false
    }

    /** 供写路径用: 当前定位点的页与下标, 插入就发生在这里。 */
    func positionPage(): Page {
        currentPage()
    }

    func positionIndex(): Int64 {
        topFrame().index
    }

    /** 自根到当前页的页号路径, 分裂时沿它向上维护。 */
    func pathPageNumbers(): Array<Int64> {
        let out = Array<Int64>(stack.size, repeat: 0)
        for (i in 0..stack.size) {
            out[i] = stack[i].pageNo
        }
        out
    }

    func invalidate(): Unit {
        valid = false
        stack.clear()
    }
}

/** 遍历一棵表树, 把所有记录收进列表。 */
func collectTableEntries(pager: Pager, rootPage: Int64): ArrayList<TableEntry> {
    let out = ArrayList<TableEntry>()
    let cursor = BtreeCursor(pager, rootPage, true)
    var ok = cursor.first()
    while (ok) {
        out.add(TableEntry(cursor.currentRowid(), cursor.currentPayload()))
        ok = cursor.next()
    }
    out
}

/** 遍历一棵索引树, 把所有键记录收进列表。 */
func collectIndexPayloads(pager: Pager, rootPage: Int64): ArrayList<Array<Byte>> {
    let out = ArrayList<Array<Byte>>()
    let cursor = BtreeCursor(pager, rootPage, false)
    var ok = cursor.first()
    while (ok) {
        out.add(cursor.currentPayload())
        ok = cursor.next()
    }
    out
}
