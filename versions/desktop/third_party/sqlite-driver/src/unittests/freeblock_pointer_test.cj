package sqlite_driver.unittests

import sqlite_driver.*
import std.unittest.*
import std.unittest.testmacro.*

@Test
class FreeblockPointerTest {
    @TestCase
    func freeblockReuseReservesTheGrowingPointerArray(): Unit {
        let data = Array<Byte>(4096, repeat: 0)
        let page = Page(2, data)
        initPage(page, PT_TABLE_LEAF, 4096)
        // 合法页：2 个指针结束于 12，首个 cell 从 13 开始，间隙仅 1 字节；
        // 中间仍有 200 字节空闲块。旧实现会直接用它，再把第三个指针写到 12..14，覆盖 cell。
        let small = Array<Byte>(20, repeat: 0x41)
        let large = Array<Byte>(3858, repeat: 0x42)
        var at: Int64 = 13
        at += writeVarint(data, at, small.size)
        at += writeVarint(data, at, 1)
        small.copyTo(data, 0, at, small.size)
        at = 235
        at += writeVarint(data, at, large.size)
        at += writeVarint(data, at, 2)
        large.copyTo(data, 0, at, large.size)
        setCellCount(page, 2)
        setCellOffset(page, 0, 13)
        setCellOffset(page, 1, 235)
        setContentStart(page, 13)
        setFirstFreeblock(page, 35)
        writeU16(data, 35, 0)
        writeU16(data, 37, 200)
        let cell = Array<Byte>(22, repeat: 0x43)
        writeVarint(cell, 0, 20)
        writeVarint(cell, 1, 3)
        @Expect(insertCellBytes(page, 2, cell, 4096, 4096), true)
        @Expect(contentStart(page, 4096) >= cellPointerArrayOffset(page) + cellCount(page) * 2, true)
        let first = parseCell(page, 0, 4096)
        let second = parseCell(page, 1, 4096)
        @Expect(first.payloadSize, 20)
        @Expect(first.rowid, 1)
        @Expect(second.payloadSize, 3858)
        @Expect(second.rowid, 2)
        for (i in 0..small.size) { @Expect(data[first.localOffset+i], small[i]) }
        for (i in 0..large.size) { @Expect(data[second.localOffset+i], large[i]) }
    }
}
