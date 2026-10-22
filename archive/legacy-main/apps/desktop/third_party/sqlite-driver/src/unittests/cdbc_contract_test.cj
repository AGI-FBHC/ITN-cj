package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.database.sql.*
import std.math.numeric.*
import std.time.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * std.database.sql 门面的契约测试。全部只依赖标准接口与 DriverManager, 不向下转型到
 * SqliteConn; 目的是证明纯驱动已经是一等公民, 而不是一个外表相似的私有连接类。
 */
@Test
class CdbcContractTest {
    @TestCase
    func driverRegistersWithPreferredPoolingDisabled(): Unit {
        registerSqliteDriver()
        let driver = DriverManager.getDriver("sqlite").getOrThrow()
        @Assert(driver.name, "sqlite")
        @Assert(driver.preferredPooling, false)
    }

    @TestCase
    func standardSqlCanCreateQueryAndRollback(): Unit {
        registerSqliteDriver()
        let ds = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", [])
        try {
            let conn = ds.connect()
            try {
                @Assert(conn.state, ConnectionState.Connected)
                let create = conn.prepareStatement("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, r REAL)")
                let _ = create.update()
                create.close()

                let insert = conn.prepareStatement("INSERT INTO t(v, r) VALUES (?, ?)")
                insert.set(0, "hello")
                insert.set(1, 3.25)
                let ur = insert.update()
                @Assert(ur.rowCount, 1)
                @Assert(ur.lastInsertId, 1)
                insert.close()

                let query = conn.prepareStatement("SELECT id, v, r, NULL AS n FROM t")
                let rs = query.query()
                @Assert(rs.columnInfos.size, 4)
                @Assert(rs.columnInfos[0].name, "id")
                @Assert(rs.columnInfos[0].typeName, "INTEGER")
                @Assert(rs.next(), true)
                @Assert(rs.get<Int64>(0), 1)
                @Assert(rs.get<String>(1), "hello")
                @Assert(rs.get<Float64>(2), 3.25)
                @Assert(rs.getOrNull<Int64>(3).isNone(), true)
                @Assert(rs.next(), false)
                rs.close()
                query.close()

                let tx = conn.createTransaction()
                tx.begin()
                let del = conn.prepareStatement("DELETE FROM t")
                let _ = del.update()
                del.close()
                tx.rollback()

                let count = conn.prepareStatement("SELECT count(*) AS c FROM t")
                let countRs = count.query()
                @Assert(countRs.next(), true)
                @Assert(countRs.get<Int64>(0), 1)
                countRs.close()
                count.close()
            } finally {
                conn.close()
            }
            @Assert(conn.state, ConnectionState.Closed)
        } finally {
            ds.close()
        }
    }

    @TestCase
    func parameterIndicesAreZeroBasedAndBounded(): Unit {
        registerSqliteDriver()
        let conn = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", []).connect()
        try {
            let stmt = conn.prepareStatement("SELECT ? AS v")
            assertThrows("negative parameter index") {=> stmt.set(-1, 1)}
            assertThrows("parameter index equal to count") {=> stmt.set(1, 1)}
            stmt.set(0, 42)
            let rs = stmt.query()
            @Assert(rs.next(), true)
            @Assert(rs.get<Int64>(0), 42)
            rs.close()
            stmt.close()
        } finally {
            conn.close()
        }
    }

    @TestCase
    func emptyStringAndZeroAreNotSqlNull(): Unit {
        registerSqliteDriver()
        let conn = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", []).connect()
        try {
            let create = conn.prepareStatement("CREATE TABLE t (id INTEGER, v TEXT)")
            let _ = create.update()
            create.close()
            let insert = conn.prepareStatement("INSERT INTO t(id, v) VALUES (?, ?)")
            insert.set(0, 0)
            insert.set(1, "")
            let _ = insert.update()
            insert.close()
            let query = conn.prepareStatement("SELECT id, v FROM t")
            let rs = query.query()
            @Assert(rs.next(), true)
            @Assert(rs.getOrNull<Int64>(0).isSome(), true)
            @Assert(rs.getOrNull<String>(1).isSome(), true)
            rs.close()
            query.close()
        } finally {
            conn.close()
        }
    }

    @TestCase
    func documentedValueTypesRoundTripThroughStandardApi(): Unit {
        registerSqliteDriver()
        let conn = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", []).connect()
        try {
            let create = conn.prepareStatement(
                "CREATE TABLE t (b INTEGER, i INTEGER, r REAL, s TEXT, blob BLOB, d TEXT, dt TEXT)")
            let _ = create.update()
            create.close()

            let insert = conn.prepareStatement("INSERT INTO t(b, i, r, s, blob, d, dt) VALUES (?, ?, ?, ?, ?, ?, ?)")
            insert.set(0, true)
            insert.set(1, 42)
            insert.set(2, 3.25)
            insert.set(3, "hello")
            insert.set(4, [1u8, 2u8, 254u8])
            insert.set(5, Decimal.parse("123.45"))
            insert.set(6, DateTime.parse("2026-08-14 12:34:56", "yyyy-MM-dd HH:mm:ss"))
            let _ = insert.update()
            insert.close()

            let query = conn.prepareStatement("SELECT b, i, r, s, blob, d, dt FROM t")
            let rs = query.query()
            @Assert(rs.next(), true)
            @Assert(rs.get<Bool>(0), true)
            @Assert(rs.get<Int64>(1), 42)
            @Assert(rs.get<Float64>(2), 3.25)
            @Assert(rs.get<String>(3), "hello")
            @Assert(rs.get<Array<Byte>>(4), [1u8, 2u8, 254u8])
            @Assert(rs.get<Decimal>(5), Decimal.parse("123.45"))
            @Assert(rs.get<DateTime>(6), DateTime.parse("2026-08-14 12:34:56", "yyyy-MM-dd HH:mm:ss"))
            rs.close()
            query.close()
        } finally {
            conn.close()
        }
    }

    @TestCase
    func deprecatedSqlDbTypeBridgeStillWorks(): Unit {
        registerSqliteDriver()
        let conn = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", []).connect()
        try {
            let stmt = conn.prepareStatement("SELECT ? AS v")
            let queryParams: Array<SqlDbType> = [SqlBigInt(42)]
            let rs = stmt.query(queryParams)
            let outValues: Array<SqlDbType> = [SqlBigInt(0)]
            @Assert(rs.next(outValues), true)
            match (outValues[0]) {
                case v: SqlBigInt => @Assert(v.value, 42)
                case _ => @Fail("legacy next(values) did not write SqlBigInt")
            }
            rs.close()
            stmt.close()
        } finally {
            conn.close()
        }
    }

    @TestCase
    func emptyResultStillDescribesColumns(): Unit {
        registerSqliteDriver()
        let conn = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", []).connect()
        try {
            let create = conn.prepareStatement("CREATE TABLE t (id INTEGER, v TEXT)")
            let _ = create.update()
            create.close()
            let query = conn.prepareStatement("SELECT id, v FROM t")
            let rs = query.query()
            @Assert(rs.columnInfos.size, 2)
            @Assert(rs.columnInfos[0].name, "id")
            @Assert(rs.columnInfos[1].name, "v")
            @Assert(rs.columnInfos[0].typeName, "NULL")
            @Assert(rs.columnInfos[1].typeName, "NULL")
            rs.close()
            query.close()
        } finally {
            conn.close()
        }
    }

    @TestCase
    func savepointsCanRollbackIndependently(): Unit {
        registerSqliteDriver()
        let conn = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", []).connect()
        try {
            let create = conn.prepareStatement("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
            let _ = create.update()
            create.close()
            let tx = conn.createTransaction()
            tx.begin()
            let first = conn.prepareStatement("INSERT INTO t(v) VALUES (?)")
            first.set(0, "outer")
            let _ = first.update()
            first.close()
            tx.save("sp")
            let second = conn.prepareStatement("INSERT INTO t(v) VALUES (?)")
            second.set(0, "inner")
            let _ = second.update()
            second.close()
            tx.rollback("sp")
            tx.commit()

            let query = conn.prepareStatement("SELECT count(*) AS c FROM t")
            let rs = query.query()
            @Assert(rs.next(), true)
            @Assert(rs.get<Int64>(0), 1)
            rs.close()
            query.close()
        } finally {
            conn.close()
        }
    }

    @TestCase
    func unknownDsnOptionsAreRejected(): Unit {
        assertThrows("unknown DSN option") {=> let _ = parseSqliteDsn(":memory:?page_sise=8192")}
    }

    @TestCase
    func driverOpenRejectsUnknownOptionsImmediately(): Unit {
        registerSqliteDriver()
        assertThrows("unknown driver option at open time") {
            => let _ = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", [("page_sise", "8192")])
        }
    }

    @TestCase
    func busyTimeoutOptionAppliesToMemoryConnections(): Unit {
        registerSqliteDriver()
        let ds = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", [("busy_timeout", "1234")])
        try {
            let conn = ds.connect()
            try {
                let statement = conn.prepareStatement("PRAGMA busy_timeout")
                try {
                    let result = statement.query()
                    try {
                        @Assert(result.next(), true)
                        @Assert(result.get<Int64>(0), 1234)
                    } finally {
                        result.close()
                    }
                } finally {
                    statement.close()
                }
            } finally {
                conn.close()
            }
        } finally {
            ds.close()
        }
    }

    @TestCase
    func connectionRejectsParallelTransactions(): Unit {
        registerSqliteDriver()
        let conn = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", []).connect()
        try {
            let first = conn.createTransaction()
            first.begin()
            assertThrows("second transaction on the same connection") {
                => let _ = conn.createTransaction()
            }
            first.rollback()
        } finally {
            conn.close()
        }
    }

    @TestCase
    func closedResourcesRejectUse(): Unit {
        registerSqliteDriver()
        let ds = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", [])
        let conn = ds.connect()
        let stmt = conn.prepareStatement("SELECT ? AS v")
        stmt.close()
        assertThrows("statement use after close") {=> stmt.set(0, 1)}
        conn.close()
        assertThrows("connection use after close") {=> let _ = conn.prepareStatement("SELECT 1")}
        ds.close()
        assertThrows("datasource use after close") {=> let _ = ds.connect()}
    }
}
