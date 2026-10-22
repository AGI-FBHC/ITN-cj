package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.fs.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 跨进程失效机制的两条窄窗口缺陷。
 *
 * 两条都不是"读到略旧的数据", 而是让别的进程**永久或静默**读错, 且两条都测不出于单进程的
 * 常规读写路径 —— 必须直接按住 Pager / WalFile 的落盘顺序与代号判定。
 *
 * 判据一 (页 1 顺序): change counter 在页 1, 别的进程靠它判要不要丢干净页缓存。页 1 若先写,
 *   对方会在数据页仍是旧内容时看到新 counter, 把旧页当"刚同步过的最新内容"存下并更新基线,
 *   此后永不失效。用记录型后端断言写入顺序, 而不是去赛跑那个微秒级窗口 —— 后者不稳定,
 *   绿了也证明不了顺序。
 *
 * 判据二 (WAL 代号): 帧定长, N 帧长度恒为 32+N*(24+pageSize)。对方 RESTART 后又追加回同样
 *   帧数时长度逐字相同, 只看长度就不会重扫, 于是索引里的帧号指向上一代的槽位, 而读路径不校验
 *   salt —— 静默读到错页。用两个 WalFile 指向同一文件模拟两个进程各自一份索引。
 */

/**
 * 记录每次 writeAt 落在哪一页的后端。
 *
 * 只记页号而不记内容: 判据要的是顺序, 存整页会让失败信息淹没在字节里。
 */
class RecordingBackend <: StorageBackend {
    private let inner = MemoryBackend()
    private let pageSize: Int64
    let writtenPages = ArrayList<Int64>()
    /** flush 发生时已写页数, 用来确认屏障真的插在页 1 之前。 */
    let flushMarks = ArrayList<Int64>()

    init(pageSize: Int64) {
        this.pageSize = pageSize
    }

    public func readAt(offset: Int64, buf: Array<Byte>): Unit {
        inner.readAt(offset, buf)
    }

    public func writeAt(offset: Int64, buf: Array<Byte>): Unit {
        writtenPages.add(offset / pageSize + 1)
        inner.writeAt(offset, buf)
    }

    public func length(): Int64 {
        inner.length()
    }

    public func truncate(n: Int64): Unit {
        inner.truncate(n)
    }

    public func flush(): Unit {
        flushMarks.add(writtenPages.size)
        inner.flush()
    }

    public func close(): Unit {
        inner.close()
    }
}

/** 本判据用的页大小。取最小值让页号算术一目了然。 */
const STALE_PAGE_SIZE: Int64 = 512

@Test
class HeaderPageWriteOrderTest {
    /**
     * 提交时页 1 必须最后写。
     *
     * 有分辨力的形态是"事务同时改了页 1 与别的页" —— 只改一页时无所谓顺序, 那一轮即使
     * 缺陷在也绿。所以这里先分配两页再一起提交。
     */
    @TestCase
    func commitWritesTheHeaderPageAfterEveryDataPage(): Unit {
        let backend = RecordingBackend(STALE_PAGE_SIZE)
        let pager = Pager(backend, newDbHeader(STALE_PAGE_SIZE), true, Journal(""))
        initializeNewDatabase(pager)

        pager.beginWrite()
        let a = pager.allocatePage()
        pager.markDirty(a)
        a.data[0] = UInt8(0xA1)
        let b = pager.allocatePage()
        pager.markDirty(b)
        b.data[0] = UInt8(0xB2)
        backend.writtenPages.clear()
        backend.flushMarks.clear()
        pager.commit(false)

        let order = backend.writtenPages
        if (order.size < 3) {
            @Fail("提交只写了 ${order.size} 页, 判据要求同一事务里页 1 与两张数据页一起落盘")
        }
        // 页 1 只应出现一次, 且在最后。
        var headerAt = -1
        for (i in 0..order.size) {
            if (order[i] == 1) {
                if (headerAt >= 0) {
                    @Fail("页 1 被写了两次 (位置 ${headerAt} 与 ${i}), 屏障两侧各写一次会让顺序失去意义")
                }
                headerAt = i
            }
        }
        if (headerAt != order.size - 1) {
            @Fail("页 1 写在第 ${headerAt} 位而不是最后一位; 写入顺序为 ${renderOrder(order)}" +
                " —— 别的进程会在数据页仍旧时看到新 change counter")
        }
        // 屏障: 必须有一次 flush 恰好发生在"页 1 之前、数据页之后"。
        var barrier = false
        for (mark in backend.flushMarks) {
            if (mark == order.size - 1) {
                barrier = true
            }
        }
        if (!barrier) {
            @Fail("页 1 之前没有 flush 屏障 (flush 位置 ${renderOrder(backend.flushMarks)}, 共写 " +
                "${order.size} 页) —— 缓冲可能让 counter 的字节先于数据页到达 OS")
        }
    }

    /**
     * 对照: 只有页 1 脏时, 它当然是最后一页 —— 这一轮即使缺陷在也绿。
     *
     * 它证明上一条的分辨力来自"多页同时脏"这个形态, 而不是断言本身恒真。
     */
    @TestCase
    func headerOnlyCommitIsNotDiscriminating(): Unit {
        let backend = RecordingBackend(STALE_PAGE_SIZE)
        let pager = Pager(backend, newDbHeader(STALE_PAGE_SIZE), true, Journal(""))
        initializeNewDatabase(pager)

        pager.beginWrite()
        let one = pager.getPage(1)
        pager.markDirty(one)
        one.data[HEADER_SIZE + 4] = UInt8(0x7F)
        backend.writtenPages.clear()
        pager.commit(false)

        var dataPages = 0
        for (no in backend.writtenPages) {
            if (no != 1) {
                dataPages += 1
            }
        }
        if (dataPages != 0) {
            @Fail("只改页 1 的事务却写了 ${dataPages} 张数据页, 该轮的前提不成立")
        }
    }
}

@Test
class WalGenerationDetectionTest {
    /**
     * RESTART 后追加回同样的帧数, 长度逐字相同 —— 另一进程仍须重扫。
     *
     * 两个 WalFile 指向同一路径, 模拟两个进程各自一份索引 (真进程里 index 也是私有的,
     * 所以这个替身在被测行为上是等价的)。
     */
    @TestCase
    func aRestartWithTheSameFrameCountStillInvalidatesTheIndex(): Unit {
        let dir = TempDbDir()
        try {
            let walPath = "${dir.dir}/gen.db-wal"
            let a = WalFile(walPath, STALE_PAGE_SIZE)
            a.openOrCreate()
            // A 提交一代: 页 2 与页 3。
            a.appendCommit(framesFor([2, 3]), 3)
            let lengthAfterFirst = fileByteLength(walPath)

            // B 扫到这一代, 索引里页 2 在帧 1。
            let b = WalFile(walPath, STALE_PAGE_SIZE)
            b.openOrCreate()
            if (b.frameCount != 2) {
                @Fail("B 应扫到 2 帧, 实得 ${b.frameCount} —— 判据前提不成立")
            }
            if (b.frameFor(2, b.frameCount) != 1) {
                @Fail("B 的索引里页 2 应在帧 1, 实得 ${b.frameFor(2, b.frameCount)}")
            }

            // A 换代: RESTART 清零, 再追加**同样帧数**的两张**不同**页。
            let _ = a.checkpointInto(MemoryBackend(), WalCheckpointMode.CheckpointRestart)
            a.appendCommit(framesFor([8, 9]), 9)
            let lengthAfterSecond = fileByteLength(walPath)
            if (lengthAfterSecond != lengthAfterFirst) {
                @Fail("两代长度应相同 (${lengthAfterFirst} vs ${lengthAfterSecond}) —— " +
                    "长度不同则走的是长度那一支, 该轮测不到代号判定")
            }

            // B 重新判定: 必须发现换代。
            b.refreshIfGrown()
            if (b.frameFor(9, b.frameCount) <= 0) {
                @Fail("B 看不到新一代的页 9 —— refreshIfGrown 没有重扫, 它仍在用上一代的索引")
            }
            if (b.frameFor(2, b.frameCount) > 0) {
                @Fail("B 仍认为页 2 在 WAL 里 (帧 ${b.frameFor(2, b.frameCount)}), " +
                    "而新一代根本没有页 2 —— 这个帧号指向的是别的页的内容")
            }
            b.close()
            a.close()
        } finally {
            dir.cleanup()
        }
    }

    /**
     * 对照: 同一代内追加帧时长度会变, 靠长度那一支就够。
     *
     * 它排除"代号判定让 refreshIfGrown 变成无条件重扫"这种把上一条空过的实现。
     */
    @TestCase
    func growthWithinOneGenerationIsStillDetected(): Unit {
        let dir = TempDbDir()
        try {
            let walPath = "${dir.dir}/grow.db-wal"
            let a = WalFile(walPath, STALE_PAGE_SIZE)
            a.openOrCreate()
            a.appendCommit(framesFor([2]), 2)

            let b = WalFile(walPath, STALE_PAGE_SIZE)
            b.openOrCreate()
            if (b.frameCount != 1) {
                @Fail("B 应扫到 1 帧, 实得 ${b.frameCount}")
            }

            a.appendCommit(framesFor([5]), 5)
            b.refreshIfGrown()
            if (b.frameCount != 2) {
                @Fail("同代追加后 B 应扫到 2 帧, 实得 ${b.frameCount}")
            }
            if (b.frameFor(5, b.frameCount) <= 0) {
                @Fail("同代追加的页 5 对 B 不可见")
            }
            b.close()
            a.close()
        } finally {
            dir.cleanup()
        }
    }
}

/** 给定页号造出一批可追加的页, 内容用页号填充以便区分。 */
func framesFor(pageNos: Array<Int64>): ArrayList<Page> {
    let pages = ArrayList<Page>()
    for (no in pageNos) {
        let data = Array<Byte>(STALE_PAGE_SIZE, repeat: UInt8(no))
        pages.add(Page(no, data))
    }
    pages
}

/** 把页号序列渲染成可读字符串, 供失败信息用。 */
func renderOrder(items: ArrayList<Int64>): String {
    let sb = StringBuilder()
    sb.append("[")
    for (i in 0..items.size) {
        if (i > 0) {
            sb.append(", ")
        }
        sb.append("${items[i]}")
    }
    sb.append("]")
    sb.toString()
}
