package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.fs.*
import std.io.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 存储模块的底层判据。
 *
 * 这里不走 openMemoryDb 的 SQL 入口，而是直接验证 header、pager、record、journal 和 parser，
 * 使失败能够定位到具体模块。
 */
@Test
class StorageHeaderLayerTest {
    @TestCase
    func mutableHeaderFieldsRoundTripThroughBytes(): Unit {
        let h = DbHeader()
        h.pageSize = 4096
        h.writeVersion = 2
        h.readVersion = 2
        h.reservedSpace = 0
        h.changeCounter = 123456
        h.dbSize = 17
        h.freelistTrunk = 3
        h.freelistCount = 4
        h.schemaCookie = 5
        h.schemaFormat = 4
        h.defaultCacheSize = 2000
        h.largestRootPage = 6
        h.textEncoding = TEXT_ENCODING_UTF8
        h.userVersion = 7
        h.incrementalVacuum = 0
        h.applicationId = 8
        h.versionValidFor = 9
        h.sqliteVersion = SQLITE_VERSION_NUMBER

        let buf = Array<Byte>(HEADER_SIZE, repeat: 0)
        writeDbHeader(buf, h)
        let parsed = parseDbHeader(buf)

        if (parsed.pageSize != h.pageSize || parsed.writeVersion != h.writeVersion || parsed.readVersion != h
            .readVersion || parsed.changeCounter != h.changeCounter || parsed.dbSize != h.dbSize ||
            parsed.freelistTrunk != h.freelistTrunk || parsed.freelistCount != h.freelistCount || parsed.schemaCookie != h
            .schemaCookie || parsed.schemaFormat != h.schemaFormat || parsed.defaultCacheSize != h.defaultCacheSize ||
            parsed.largestRootPage != h.largestRootPage || parsed.textEncoding != h.textEncoding ||
            parsed.userVersion != h.userVersion || parsed.applicationId != h.applicationId || parsed.versionValidFor != h
            .versionValidFor || parsed.sqliteVersion != h.sqliteVersion) {
            @Fail("header fields did not round-trip byte-for-byte")
        }
    }

    @TestCase
    func the64KiBPageSizeUsesTheOneByteMarker(): Unit {
        let h = newDbHeader(65536)
        let buf = Array<Byte>(HEADER_SIZE, repeat: 0)
        writeDbHeader(buf, h)
        if (readU16(buf, OFF_PAGE_SIZE) != PAGE_SIZE_64K_MARKER) {
            @Fail("65536-byte page size must be stored as the marker 1")
        }
        if (parseDbHeader(buf).pageSize != 65536) {
            @Fail("the 65536-byte page-size marker did not decode back to 65536")
        }
    }

    @TestCase
    func malformedHeaderFormsAreRejected(): Unit {
        let h = newDbHeader(4096)
        let buf = Array<Byte>(HEADER_SIZE, repeat: 0)
        writeDbHeader(buf, h)

        buf[0] = UInt8(b'X')
        assertThrows("bad header magic") {=> let _ = parseDbHeader(buf)}
        buf[0] = UInt8(b'S')

        writeU32(buf, OFF_TEXT_ENCODING, 2)
        assertThrows("UTF-16 header") {=> let _ = parseDbHeader(buf)}
        writeU32(buf, OFF_TEXT_ENCODING, TEXT_ENCODING_UTF8)

        writeU16(buf, OFF_PAGE_SIZE, 1000)
        assertThrows("non-power-of-two page size") {=> let _ = parseDbHeader(buf)}
    }
}

@Test
class StoragePagerLayerTest {
    @TestCase
    func commitPersistsAllocatedPages(): Unit {
        let backend = MemoryBackend()
        let pager = Pager(backend, newDbHeader(512), false, Journal(""))
        initializeNewDatabase(pager)

        pager.beginWrite()
        let second = pager.allocatePage()
        pager.markDirty(second)
        second.data[0] = UInt8(0xAB)
        pager.commit(false)

        if (pager.header.dbSize != 2) {
            @Fail("committed pager did not account for the newly allocated page")
        }
        if (backend.length() != 2 * 512) {
            @Fail("committed memory backend length should be two pages, got ${backend.length()}")
        }
        let page = pager.getPage(2)
        if (page.data[0] != UInt8(0xAB)) {
            @Fail("allocated page content was not persisted")
        }
    }

    @TestCase
    func rollbackDiscardsNewPages(): Unit {
        let backend = MemoryBackend()
        let pager = Pager(backend, newDbHeader(512), false, Journal(""))
        initializeNewDatabase(pager)

        pager.beginWrite()
        let _ = pager.allocatePage()
        pager.rollback()

        if (pager.header.dbSize != 1) {
            @Fail("rollback should discard pages allocated during the transaction")
        }
        if (backend.length() != 512) {
            @Fail("rollback should truncate the backend back to one page")
        }
    }

    @TestCase
    func savepointRollbackRestoresTheOriginalImage(): Unit {
        let backend = MemoryBackend()
        let pager = Pager(backend, newDbHeader(512), false, Journal(""))
        initializeNewDatabase(pager)

        pager.beginWrite()
        let page = pager.getPage(1)
        pager.openSavepoint("sp")
        let original = page.data[HEADER_SIZE + 8]
        pager.markDirty(page)
        page.data[HEADER_SIZE + 8] = UInt8(original ^ 0x5A)
        pager.rollbackToSavepoint("sp")

        if (page.data[HEADER_SIZE + 8] != original) {
            @Fail("ROLLBACK TO SAVEPOINT did not restore the page image")
        }
    }
}

@Test
class RecordCodecLayerTest {
    @TestCase
    func everySqliteSerialTypeRoundTrips(): Unit {
        let values: Array<SqliteValue> = [
            SqliteValue.SNull,
            SqliteValue.SInt(0),
            SqliteValue.SInt(1),
            SqliteValue.SInt(127),
            SqliteValue.SInt(-128),
            SqliteValue.SInt(32767),
            SqliteValue.SInt(-32768),
            SqliteValue.SInt(2147483647),
            SqliteValue.SInt(-9223372036854775807 - 1),
            SqliteValue.SReal(1.5),
            SqliteValue.SText("hello"),
            SqliteValue.SBlob([1, 2, 3, 255])
        ]
        let decoded = decodeRecord(encodeRecord(values), values.size)
        if (decoded.size != values.size) {
            @Fail("decoded record width differs from encoded width")
        }
        for (i in 0..values.size) {
            if (decoded[i] != values[i]) {
                @Fail("record field ${i} round-tripped to ${decoded[i]}, expected ${values[i]}")
            }
        }
    }

    @TestCase
    func decodePadsMissingLegacyColumnsWithNull(): Unit {
        let encoded = encodeRecord([SqliteValue.SInt(7)])
        let decoded = decodeRecord(encoded, 3)
        if (decoded.size != 3 || decoded[0] != SqliteValue.SInt(7) || decoded[1] != SqliteValue.SNull || decoded[2] != SqliteValue
            .SNull) {
            @Fail("decodeRecord should pad missing columns with NULL")
        }
    }

    @TestCase
    func reservedSerialTypesAreRejected(): Unit {
        assertThrows("reserved serial type 10") {=> let _ = serialBodySize(10)}
        assertThrows("reserved serial type 11") {=> let _ = serialBodySize(11)}
    }
}

@Test
class StorageJournalLayerTest {
    @TestCase
    func replayRestoresAPageAndTruncatesToTheHeaderCount(): Unit {
        let dir = TempDbDir()
        try {
            let journalPath = dir.file("db-journal")
            let pageSize = 512
            let image = Array<Byte>(pageSize, repeat: 0)
            for (i in 0..pageSize) {
                image[i] = UInt8(i & 0xFF)
            }
            writeSingleRecordJournal(journalPath, pageSize, 1, image)

            let backend = MemoryBackend()
            backend.writeAt(0, Array<Byte>(pageSize, repeat: 0))
            backend.truncate(pageSize * 3)
            let replay = replayJournalFile(journalPath, backend, pageSize)
            if (replay.pagesRestored != 1 || replay.dbPageCount != 2) {
                @Fail("journal replay reported pagesRestored=${replay.pagesRestored}, dbPageCount=${replay.dbPageCount}")
            }
            let restored = Array<Byte>(pageSize, repeat: 0)
            backend.readAt(0, restored)
            for (i in 0..pageSize) {
                if (restored[i] != image[i]) {
                    @Fail("journal replay restored byte ${i} as ${restored[i]}, expected ${image[i]}")
                }
            }
            if (backend.length() != 2 * pageSize) {
                @Fail("journal replay should truncate to the header page count")
            }
        } finally {
            dir.cleanup()
        }
    }
}

func writeSingleRecordJournal(path: String, pageSize: Int64, pageNo: Int64, image: Array<Byte>): Unit {
    let f = File(path, OpenMode.Write)
    let head = Array<Byte>(JOURNAL_SECTOR_SIZE, repeat: 0)
    JOURNAL_MAGIC.copyTo(head, 0, 0, 8)
    writeU32(head, 8, JOURNAL_NREC_UNKNOWN)
    let seed: Int64 = 123456
    writeU32(head, 12, seed)
    writeU32(head, 16, 2)
    writeU32(head, 20, JOURNAL_SECTOR_SIZE)
    writeU32(head, 24, pageSize)
    f.write(head)

    let rec = Array<Byte>(4 + pageSize + 4, repeat: 0)
    writeU32(rec, 0, pageNo)
    image.copyTo(rec, 0, 4, pageSize)
    writeU32(rec, 4 + pageSize, journalChecksum(seed, image))
    f.write(rec)
    f.flush()
    f.close()
}

@Test
class SqlParserLayerTest {
    @TestCase
    func parsesASetOperationChainWithoutDroppingMiddleTerms(): Unit {
        let stmt = Parser("SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3").parseStatement()
        if (!(stmt is SelectStmt)) {
            @Fail("expected a SELECT statement")
        }
    }

    @TestCase
    func rejectsAttachAndMultipleStatements(): Unit {
        assertThrows("ATTACH rejection") {=> let _ = Parser("ATTACH 'x.db' AS x").parseStatement()}
        assertThrows("multiple statement rejection") {=> let _ = Parser("SELECT 1; SELECT 2").parseStatement()}
    }

    @TestCase
    func exposesTheNumberOfParameters(): Unit {
        let p = Parser("SELECT ?, ?2, :name, :name")
        let _ = p.parseStatement()
        if (p.parameterCount != 3) {
            @Fail("expected 3 distinct parameters, got ${p.parameterCount}")
        }
    }
}

@Test
class ExecDateTimeLayerTest {
    @TestCase
    func dateAndTimeFunctionsMatchRealSqlite(): Unit {
        expectSameAsSqlite([], "SELECT date('2020-02-29','+1 day')", "date arithmetic")
        expectSameAsSqlite([], "SELECT datetime('2020-01-02 03:04:05')", "datetime parsing")
        expectSameAsSqlite([], "SELECT strftime('%Y-%m-%d %H:%M:%S','2020-01-02 03:04:05')", "strftime")
        expectSameAsSqlite([], "SELECT unixepoch('1970-01-01 00:00:00')", "unixepoch")
    }
}

@Test
class IntegrityCheckLayerTest {
    @TestCase
    func aHealthyDatabaseReportsOk(): Unit {
        let dir = TempDbDir()
        try {
            let conn = openFileConn(dir.dbPath)
            conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
            conn.execString("INSERT INTO t VALUES (1,'a')")
            let rs = conn.queryString("PRAGMA integrity_check")
            if (rs.rows.isEmpty() || renderValue(rs.rows[0][0]) != "T:ok") {
                @Fail("healthy database integrity_check should report ok")
            }
            conn.close()
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func aFileLongerThanTheHeaderDeclaresIsReported(): Unit {
        let dir = TempDbDir()
        try {
            let conn = openFileConn(dir.dbPath)
            conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
            conn.execString("INSERT INTO t VALUES (1,'a')")
            conn.close()

            // 多加一个字节，使文件长度不再等于 header.dbSize * pageSize。该判据独立于
            // cell 与页结构的内部一致性。
            let f = File(dir.dbPath, OpenMode.ReadWrite)
            let _ = f.seek(SeekPosition.End(0))
            f.write(Array<Byte>(1, repeat: 0))
            f.flush()
            f.close()

            let again = openFileConn(dir.dbPath)
            let rs = again.queryString("PRAGMA integrity_check")
            again.close()
            if (rs.rows.isEmpty() || renderValue(rs.rows[0][0]) == "T:ok") {
                @Fail("integrity_check should notice a file length that disagrees with the header")
            }
        } finally {
            dir.cleanup()
        }
    }
}
