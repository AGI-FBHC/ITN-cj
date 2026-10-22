package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 页内碎片整理必须**从快照解析** cell，不能边重排边从 page.data 里读。
 *
 * defragmentPage 把 cell 一个个往页尾重排：先放 cell0（目标位置 [usable-size0, usable)），
 * 再放 cell1……。如果解析 cell1 时读的是**已经被 cell0 覆盖过的** page.data，就会把
 * cell0 的字节当成 cell1 的"payload 长度 varint"来解。垃圾长度一旦落进溢出分支，
 * 下一步就会去页内读溢出页号，索引直接越过页尾 4096 ——
 * 用户实测报的 `The length of the array is 4096, but the index is 4922.` 就是这一条。
 *
 * 本用例把页搭成"两个 cell 从低地址的空闲块里抠出来、第三个 cell 紧贴页尾"，并让
 * 覆盖到 cell1 头部的字节恰好编码出 5408 这个长度：
 *   local = 489 + (5408-489) % 4092 = 1316
 *   readU32 的偏移 = 3600 + 6 + 1316 = 4922
 * 于是修复前它会以完全相同的报错文本抛出来，修复后两个 cell 的 payload 必须原样保留。
 */
@Test
class DefragmentOverlapTest {
    @TestCase
    func defragmentKeepsCellsItIsRewritingOver(): Unit {
        let pageSize: Int64 = 4096
        let usable: Int64 = pageSize
        let data = Array<Byte>(pageSize, repeat: 0)
        let page = Page(2, data)
        initPage(page, PT_TABLE_LEAF, usable)

        // cell0: payload 1497 字节，放在页首方向的低偏移处（模拟从空闲块抠出来的空间）
        let pay0 = Array<Byte>(1497, repeat: 0x41)
        // 这几个字节会在重排时落到 cell1 的头部，被当成 5 字节 varint + rowid 读
        pay0[1001] = 0x80
        pay0[1002] = 0x80
        pay0[1003] = 0x80
        pay0[1004] = 0xAA
        pay0[1005] = 0x20
        pay0[1006] = 0x07
        let off0: Int64 = 1000
        var pos = off0
        pos += writeVarint(data, pos, pay0.size)
        pos += writeVarint(data, pos, 1)
        pay0.copyTo(data, 0, pos, pay0.size)
        let size0 = pos + pay0.size - off0

        // cell1: 小 payload，紧贴页尾
        let pay1 = Array<Byte>(397, repeat: 0x42)
        let off1: Int64 = 3600
        pos = off1
        pos += writeVarint(data, pos, pay1.size)
        pos += writeVarint(data, pos, 7)
        pay1.copyTo(data, 0, pos, pay1.size)
        let size1 = pos + pay1.size - off1

        setCellCount(page, 2)
        setCellOffset(page, 0, off0)
        setCellOffset(page, 1, off1)
        setContentStart(page, off0)
        setFirstFreeblock(page, 0)
        setFragmentedBytes(page, 0)

        defragmentPage(page, pageSize, usable)

        let a = parseCell(page, 0, usable)
        let b = parseCell(page, 1, usable)
        @Expect(a.payloadSize, pay0.size)
        @Expect(b.payloadSize, pay1.size)
        @Expect(a.localSize, pay0.size)
        @Expect(b.localSize, pay1.size)
        var i: Int64 = 0
        while (i < pay0.size) {
            if (data[a.localOffset + i] != pay0[i]) {
                @Fail("cell0 payload byte ${i} changed: defragment read a cell out of the page it was rewriting")
            }
            i += 1
        }
        i = 0
        while (i < pay1.size) {
            if (data[b.localOffset + i] != pay1[i]) {
                @Fail("cell1 payload byte ${i} changed: defragment read a cell out of the page it was rewriting")
            }
            i += 1
        }
        // 紧凑重排后内容区应当正好是 4096 - size0 - size1，页里不留看不见的空洞：
        // 空闲链与碎片计数都清空，剩余空闲只等于指针数组与内容区之间的那段间隙
        @Expect(contentStart(page, pageSize), usable - size0 - size1)
        @Expect(firstFreeblock(page), 0)
        @Expect(fragmentedBytes(page), 0)
        @Expect(totalFreeBytes(page, pageSize, usable),
            contentStart(page, pageSize) - (cellPointerArrayOffset(page) + 4))
    }
}
