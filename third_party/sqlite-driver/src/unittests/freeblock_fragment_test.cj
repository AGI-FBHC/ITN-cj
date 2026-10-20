package sqlite_driver.unittests

import sqlite_driver.*
import std.unittest.*
import std.unittest.testmacro.*

func fragmentPage(fragmented: Int64): Page {
    let page = Page(2, Array<Byte>(4096, repeat: 0))
    initPage(page, PT_TABLE_LEAF, 4096)
    setContentStart(page, 100)
    setFragmentedBytes(page, fragmented)
    return page
}

@Test
class FreeblockFragmentTest {
    @TestCase
    func joinsSuccessorAcrossTwoFragmentBytes(): Unit {
        let page = fragmentPage(2)
        setFirstFreeblock(page, 126)
        writeU16(page.data, 126, 0)
        writeU16(page.data, 128, 20)
        releaseCellSpace(page, 100, 24, 4096)
        @Expect(firstFreeblock(page), 100)
        @Expect(readU16(page.data, 100), 0)
        @Expect(readU16(page.data, 102), 46)
        @Expect(fragmentedBytes(page), 0)
    }

    @TestCase
    func joinsPredecessorAcrossTwoFragmentBytes(): Unit {
        let page = fragmentPage(2)
        setFirstFreeblock(page, 100)
        writeU16(page.data, 100, 0)
        writeU16(page.data, 102, 20)
        releaseCellSpace(page, 122, 24, 4096)
        @Expect(firstFreeblock(page), 100)
        @Expect(readU16(page.data, 100), 0)
        @Expect(readU16(page.data, 102), 46)
        @Expect(fragmentedBytes(page), 0)
    }

    @TestCase
    func joinsBothSidesAndConsumesOnlyTheirFragments(): Unit {
        let page = fragmentPage(7)
        setFirstFreeblock(page, 100)
        writeU16(page.data, 100, 150)
        writeU16(page.data, 102, 20)
        writeU16(page.data, 150, 0)
        writeU16(page.data, 152, 30)
        releaseCellSpace(page, 122, 25, 4096)
        @Expect(firstFreeblock(page), 100)
        @Expect(readU16(page.data, 100), 0)
        @Expect(readU16(page.data, 102), 80)
        @Expect(fragmentedBytes(page), 2)
    }

    @TestCase
    func leavesFourByteLiveRegionBetweenBlocks(): Unit {
        let page = fragmentPage(0)
        setFirstFreeblock(page, 100)
        writeU16(page.data, 100, 0)
        writeU16(page.data, 102, 20)
        for (i in 120..124) { page.data[i] = 0x4A }
        releaseCellSpace(page, 124, 20, 4096)
        @Expect(readU16(page.data, 100), 124)
        @Expect(readU16(page.data, 102), 20)
        @Expect(fragmentedBytes(page), 0)
        for (i in 120..124) { @Expect(page.data[i], 0x4A) }
    }

    @TestCase
    func normalizesAnExistingFragmentGapBeforeReuse(): Unit {
        let page = fragmentPage(2)
        setFirstFreeblock(page, 100)
        writeU16(page.data, 100, 122)
        writeU16(page.data, 102, 20)
        writeU16(page.data, 122, 0)
        writeU16(page.data, 124, 20)
        let free = totalFreeBytes(page, 4096, 4096)
        @Expect(allocateCellSpace(page, 8, 4096, 4096), 134)
        @Expect(readU16(page.data, 100), 0)
        @Expect(fragmentedBytes(page), 0)
        @Expect(totalFreeBytes(page, 4096, 4096), free - 8)
    }
}
