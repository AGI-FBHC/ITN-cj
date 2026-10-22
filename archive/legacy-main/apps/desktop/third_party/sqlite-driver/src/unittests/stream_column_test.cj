package sqlite_driver.unittests

import sqlite_driver.*
import std.database.sql.*
import std.io.*
import std.time.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 流式列 (InputStream / SqlBlob / SqlClob) 的双向契约。
 *
 * 实现是**缓冲式**的: 绑定时把流读满成字节数组, 读取时在已物化的字节上包一个 ByteBuffer。
 * 理由写在 sqlite_type_bridge.cj 头部 —— 增量 BLOB I/O 要求句柄跨语句持有页面, 而结果集
 * 在语句结束时就解开了读快照。所以这里判的是"契约完整可用", 不是"分块读取"。
 *
 * 用例全部走 std.database.sql 门面 (prepareStatement / query / next(Array<SqlDbType>)),
 * 因为流式接口只存在于这一层; 向下转型到 SqliteConn 就测不到桥接代码。
 */

/** 一条门面连接。每个用例各开一条内存库, 互不干扰。 */
private func openFacadeConn(): Connection {
    registerSqliteDriver()
    DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", []).connect()
}

/**
 * 把流读干。
 *
 * 缓冲区故意取 7 字节 (小于任何被测数据, 也不是 2 的幂): 一次 read 读不满就返回的实现
 * 会在这里露出来, 而 8192 那种"一次读完"的缓冲区会把同样的缺陷盖住。
 */
private func drain(s: InputStream): Array<Byte> {
    let out = ByteBuffer()
    let buf = Array<Byte>(7, repeat: 0)
    while (true) {
        let n = s.read(buf)
        if (n <= 0) {
            break
        }
        out.write(buf[0..n])
    }
    out.bytes()
}

private func bytesEqual(a: Array<Byte>, b: Array<Byte>): Bool {
    if (a.size != b.size) {
        return false
    }
    for (i in 0..a.size) {
        if (a[i] != b[i]) {
            return false
        }
    }
    true
}

/** 可辨认的字节序列: 值随下标变化, 于是错位或截断都会被 bytesEqual 抓到。 */
private func patternBytes(size: Int64): Array<Byte> {
    let out = Array<Byte>(size, repeat: 0)
    for (i in 0..size) {
        out[i] = UInt8((i * 7 + 3) % 251)
    }
    out
}

@Test
class StreamColumnTest {
    /**
     * InputStream 参数存成 BLOB, 再读回同样的字节。
     *
     * 数据取 24578 字节 = 8192*3 + 2, 刻意不是 readStreamFully 内部缓冲 (8192) 的整数倍:
     * 循环少读一轮或多读一轮都会改变长度, 而"恰好整数倍"的数据两种错都看不出来。
     */
    @TestCase
    func inputStreamParameterRoundTripsAsABlob(): Unit {
        let conn = openFacadeConn()
        let create = conn.prepareStatement("CREATE TABLE s(id INTEGER PRIMARY KEY, b BLOB)")
        let _ = create.update()
        create.close()
        let data = patternBytes(24578)
        let insert = conn.prepareStatement("INSERT INTO s(b) VALUES(?)")
        insert.set<InputStream>(0, ByteBuffer(data))
        @Expect(insert.update().rowCount, 1)
        insert.close()

        let query = conn.prepareStatement("SELECT typeof(b), length(b), b FROM s")
        let rs = query.query()
        @Assert(rs.next(), true)
        @Expect(rs.get<String>(0), "blob")
        @Expect(rs.get<Int64>(1), 24578)
        @Expect(bytesEqual(drain(rs.get<InputStream>(2)), data), true)
        rs.close()
        query.close()
        conn.close()
    }

    /** 空流是零长 BLOB, 不是 SQL NULL —— 这两者在 SQLite 里是不同的值。 */
    @TestCase
    func anEmptyStreamIsAZeroLengthBlobNotNull(): Unit {
        let conn = openFacadeConn()
        let create = conn.prepareStatement("CREATE TABLE s(b BLOB)")
        let _ = create.update()
        create.close()
        let insert = conn.prepareStatement("INSERT INTO s(b) VALUES(?)")
        insert.set<InputStream>(0, ByteBuffer())
        let _ = insert.update()
        insert.close()

        let query = conn.prepareStatement("SELECT typeof(b), length(b), b IS NULL, b FROM s")
        let rs = query.query()
        @Assert(rs.next(), true)
        @Expect(rs.get<String>(0), "blob")
        @Expect(rs.get<Int64>(1), 0)
        @Expect(rs.get<Int64>(2), 0)
        @Expect(drain(rs.get<InputStream>(3)).size, 0)
        rs.close()
        query.close()
        conn.close()
    }

    /**
     * TEXT 列也能读成流, 字节是 UTF-8。
     *
     * 用非 ASCII 字符串: 字符数 5 而字节数 6, 于是"按字符算长度"的实现会露出来。
     * 这条对应 streamBytesFromSqlite 比 bytesFromSqlite 宽的那一段注释 ——
     * 读大列的调用方拿到的可能是长 TEXT (CLOB 契约就是这种)。
     */
    @TestCase
    func aTextColumnCanBeReadAsAUtf8Stream(): Unit {
        let conn = openFacadeConn()
        let create = conn.prepareStatement("CREATE TABLE s(t TEXT)")
        let _ = create.update()
        create.close()
        let text = "héllo"
        let insert = conn.prepareStatement("INSERT INTO s(t) VALUES(?)")
        insert.set<String>(0, text)
        let _ = insert.update()
        insert.close()

        let query = conn.prepareStatement("SELECT typeof(t), length(t), t FROM s")
        let rs = query.query()
        @Assert(rs.next(), true)
        @Expect(rs.get<String>(0), "text")
        // SQLite 的 length() 对 TEXT 数字符, 不数字节。
        @Expect(rs.get<Int64>(1), 5)
        let streamed = drain(rs.get<InputStream>(2))
        @Expect(streamed.size, 6)
        @Expect(String.fromUtf8(streamed), text)
        rs.close()
        query.close()
        conn.close()
    }

    /** 数值列请求流要拒绝: 对 INTEGER 列要一个字节流没有合理解释。 */
    @TestCase
    func aNumericColumnCannotBeReadAsAStream(): Unit {
        let conn = openFacadeConn()
        let query = conn.prepareStatement("SELECT 42, 1.5")
        let rs = query.query()
        @Assert(rs.next(), true)
        assertThrows("INTEGER as a stream") {
            => let _ = rs.get<InputStream>(0)
        }
        assertThrows("REAL as a stream") {
            => let _ = rs.get<InputStream>(1)
        }
        rs.close()
        query.close()
        conn.close()
    }

    /**
     * SQL NULL 读成流要报错, 但 getOrNull 给出 None。
     *
     * 这两条必须一起断言: 只测 getOrNull 的话, 一个"NULL 悄悄变成零长流"的实现也会绿。
     */
    @TestCase
    func sqlNullIsAnErrorForGetButNoneForGetOrNull(): Unit {
        let conn = openFacadeConn()
        let query = conn.prepareStatement("SELECT NULL")
        let rs = query.query()
        @Assert(rs.next(), true)
        assertThrows("SQL NULL as a stream") {
            => let _ = rs.get<InputStream>(0)
        }
        @Expect(rs.getOrNull<InputStream>(0).isNone(), true)
        rs.close()
        query.close()
        conn.close()
    }

    /** deprecated SqlBlob: 绑定与回写两个方向都要通。 */
    @TestCase
    func sqlBlobParameterAndSlotRoundTrip(): Unit {
        let conn = openFacadeConn()
        let create = conn.prepareStatement("CREATE TABLE s(b BLOB)")
        let _ = create.update()
        create.close()
        let data = patternBytes(300)
        let insert = conn.prepareStatement("INSERT INTO s(b) VALUES(?)")
        let _ = insert.update([SqlBlob(ByteBuffer(data))])
        insert.close()

        let query = conn.prepareStatement("SELECT b FROM s")
        let rs = query.query()
        let slots: Array<SqlDbType> = [SqlBlob(ByteBuffer())]
        @Assert(rs.next(slots), true)
        match (slots[0]) {
            case blob: SqlBlob => @Expect(bytesEqual(drain(blob.value), data), true)
            case _ => @Fail("expected a SqlBlob slot")
        }
        rs.close()
        query.close()
        conn.close()
    }

    /**
     * SqlClob 存成 TEXT 而不是 BLOB, 字节流按 UTF-8 往返。
     *
     * typeof 那一条是关键: CLOB 是字符数据, 存成 BLOB 会让 `WHERE t = 'x'` 与所有
     * TEXT 函数在这一列上失效, 而"读回来的字节一样"这一条**照样绿**。
     */
    @TestCase
    func sqlClobIsStoredAsTextAndRoundTripsAsUtf8(): Unit {
        let conn = openFacadeConn()
        let create = conn.prepareStatement("CREATE TABLE s(t TEXT)")
        let _ = create.update()
        create.close()
        let text = "汉字 abc"
        let insert = conn.prepareStatement("INSERT INTO s(t) VALUES(?)")
        let _ = insert.update([SqlClob(ByteBuffer(text.toArray()))])
        insert.close()

        let query = conn.prepareStatement("SELECT typeof(t), t = ?, t FROM s")
        query.set<String>(0, text)
        let rs = query.query()
        let slots: Array<SqlDbType> = [SqlVarchar(""), SqlBigInt(0), SqlClob(ByteBuffer())]
        @Assert(rs.next(slots), true)
        match (slots[0]) {
            case v: SqlVarchar => @Expect(v.value, "text")
            case _ => @Fail("expected a SqlVarchar slot")
        }
        match (slots[1]) {
            case v: SqlBigInt => @Expect(v.value, 1)
            case _ => @Fail("expected a SqlBigInt slot")
        }
        match (slots[2]) {
            case clob: SqlClob => @Expect(String.fromUtf8(drain(clob.value)), text)
            case _ => @Fail("expected a SqlClob slot")
        }
        rs.close()
        query.close()
        conn.close()
    }

    /** 非法 UTF-8 的 CLOB 参数要报错, 而不是存进一段坏字节。 */
    @TestCase
    func aClobParameterThatIsNotUtf8IsRejected(): Unit {
        let conn = openFacadeConn()
        let create = conn.prepareStatement("CREATE TABLE s(t TEXT)")
        let _ = create.update()
        create.close()
        // 0xFF 0xFE 在 UTF-8 里不是合法起始字节。
        let bad = Array<Byte>(2, repeat: 0)
        bad[0] = 255
        bad[1] = 254
        let insert = conn.prepareStatement("INSERT INTO s(t) VALUES(?)")
        assertThrows("CLOB with invalid UTF-8") {
            => let _ = insert.update([SqlClob(ByteBuffer(bad))])
        }
        insert.close()
        // 报错后表必须是空的 —— 部分写入比报错更糟。
        let query = conn.prepareStatement("SELECT count(*) FROM s")
        let rs = query.query()
        @Assert(rs.next(), true)
        @Expect(rs.get<Int64>(0), 0)
        rs.close()
        query.close()
        conn.close()
    }

    /** SqlNullableBlob / SqlNullableClob: None 存 NULL, NULL 读回 None。 */
    @TestCase
    func nullableStreamSlotsMapSqlNullToNone(): Unit {
        let conn = openFacadeConn()
        let create = conn.prepareStatement("CREATE TABLE s(id INTEGER PRIMARY KEY, b BLOB, t TEXT)")
        let _ = create.update()
        create.close()
        let insert = conn.prepareStatement("INSERT INTO s(b, t) VALUES(?, ?)")
        let _ = insert.update([SqlNullableBlob(None), SqlNullableClob(None)])
        insert.close()

        let check = conn.prepareStatement("SELECT b IS NULL, t IS NULL FROM s")
        let crs = check.query()
        @Assert(crs.next(), true)
        @Expect(crs.get<Int64>(0), 1)
        @Expect(crs.get<Int64>(1), 1)
        crs.close()
        check.close()

        let query = conn.prepareStatement("SELECT b, t FROM s")
        let rs = query.query()
        let slots: Array<SqlDbType> = [SqlNullableBlob(None), SqlNullableClob(None)]
        @Assert(rs.next(slots), true)
        match (slots[0]) {
            case v: SqlNullableBlob => @Expect(v.value.isNone(), true)
            case _ => @Fail("expected a SqlNullableBlob slot")
        }
        match (slots[1]) {
            case v: SqlNullableClob => @Expect(v.value.isNone(), true)
            case _ => @Fail("expected a SqlNullableClob slot")
        }
        rs.close()
        query.close()
        conn.close()
    }

    /** 非 NULL 值填进 nullable 流槽位时要给出 Some, 且内容正确。 */
    @TestCase
    func nullableStreamSlotsCarryTheValueWhenItIsNotNull(): Unit {
        let conn = openFacadeConn()
        let create = conn.prepareStatement("CREATE TABLE s(b BLOB, t TEXT)")
        let _ = create.update()
        create.close()
        let data = patternBytes(64)
        let insert = conn.prepareStatement("INSERT INTO s(b, t) VALUES(?, ?)")
        let _ = insert.update([SqlNullableBlob(ByteBuffer(data)), SqlNullableClob(ByteBuffer("xyz".toArray()))])
        insert.close()

        let query = conn.prepareStatement("SELECT b, t FROM s")
        let rs = query.query()
        let slots: Array<SqlDbType> = [SqlNullableBlob(None), SqlNullableClob(None)]
        @Assert(rs.next(slots), true)
        match (slots[0]) {
            case v: SqlNullableBlob => @Expect(bytesEqual(drain(v.value.getOrThrow()), data), true)
            case _ => @Fail("expected a SqlNullableBlob slot")
        }
        match (slots[1]) {
            case v: SqlNullableClob => @Expect(String.fromUtf8(drain(v.value.getOrThrow())), "xyz")
            case _ => @Fail("expected a SqlNullableClob slot")
        }
        rs.close()
        query.close()
        conn.close()
    }

    /**
     * SqlInterval 两个方向都仍然拒绝, 且理由要说清是 SQLite 没有 interval 类型。
     *
     * 这一条与上面几条是一组: 流式列做通了之后, 唯一还被拒的 SqlDbType 就剩 interval,
     * 拒绝的理由必须是"存储层没有这个类型"而不是"驱动没做"。
     */
    @TestCase
    func intervalParametersAndSlotsAreStillRejectedWithAStorageReason(): Unit {
        let conn = openFacadeConn()
        let create = conn.prepareStatement("CREATE TABLE s(v TEXT)")
        let _ = create.update()
        create.close()
        let insert = conn.prepareStatement("INSERT INTO s(v) VALUES(?)")
        let intervalParams: Array<SqlDbType> = [SqlInterval(Duration.second), SqlNullableInterval(Duration.second)]
        for (param in intervalParams) {
            try {
                let _ = insert.update([param])
                @Fail("interval parameters must be rejected")
            } catch (e: SqliteRuntimeException) {
                @Expect(e.message.contains("interval"), true)
            }
        }
        insert.close()

        let seed = conn.prepareStatement("INSERT INTO s(v) VALUES('x')")
        let _ = seed.update()
        seed.close()
        let query = conn.prepareStatement("SELECT v FROM s")
        let intervalSlots: Array<SqlDbType> = [SqlInterval(Duration.Zero), SqlNullableInterval(None)]
        for (slot in intervalSlots) {
            let rs = query.query()
            try {
                let _ = rs.next([slot])
                @Fail("interval slots must be rejected")
            } catch (e: SqliteRuntimeException) {
                @Expect(e.message.contains("interval"), true)
            }
            rs.close()
        }
        query.close()
        conn.close()
    }
}
