package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 事务触达页数超过页缓存上限时的正确性。
 *
 * 被守住的缺陷: 新分配的页在入缓存那一刻还是干净的, 而淘汰只挑干净页 —— 长写事务里
 * 其余页全脏, 于是它成为唯一候选被当场摘走, 标脏打在一个已不在缓存里的孤儿对象上。
 * flushDirtyPages 遍历缓存找不到它, 而 header.dbSize 已经加过。
 *
 * 两种后端的失败形态不同, 所以两边都要测:
 *   - 内存库: 读该页抛 "unexpected end of in-memory database", 响得很。
 *   - 文件库: flushDirtyPages 结尾的 truncate 把文件补零, **COMMIT 报成功**, 库里留下
 *     一张被父页正常引用的全零页。这一形态由 SQLite 判定 —— 见 interopReadBack。
 *
 * 用 `PRAGMA cache_size` 把上限压到最小而不是灌够 2000 页的数据: 触发条件是
 * "cache.size > cacheLimit", 压低上限走的是同一条代码路径, 而灌满默认上限需要约
 * 4 万行。默认上限那一档另有 exceedsDefaultCacheLimit 兜底。
 */

/** 压到最小上限后, 多少行足以反复触发淘汰。 */
const SPILL_ROWS: Int64 = 1200

/** 每行负载字节数; 取值让一页装不下几行, 于是页数增长快。 */
const SPILL_PAYLOAD_BYTES: Int64 = 600

func spillPayload(tag: Int64): String {
    let sb = StringBuilder()
    sb.append("row-${tag}-")
    while (sb.toString().size < SPILL_PAYLOAD_BYTES) {
        sb.append("0123456789abcdef")
    }
    sb.toString()
}

/** 建表并在**单个事务**内插满 SPILL_ROWS 行。 */
func fillBeyondCache(conn: SqliteConn): Unit {
    let _ = conn.execString("PRAGMA cache_size = 10")
    let _ = conn.execString("CREATE TABLE spill (id INTEGER PRIMARY KEY, payload TEXT)")
    let _ = conn.execString("BEGIN")
    for (i in 0..SPILL_ROWS) {
        let _ = conn.exec("INSERT INTO spill(payload) VALUES (?)", [SqliteValue.SText(spillPayload(i))])
    }
    let _ = conn.execString("COMMIT")
}

/** 逐行读回并比对内容, 顺带确认行数。 */
func assertContentIntact(conn: SqliteConn): Unit {
    let rs = conn.queryString("SELECT id, payload FROM spill ORDER BY id")
    @Assert(rs.rowCount, SPILL_ROWS)
    for (i in 0..SPILL_ROWS) {
        match (rs.rows[i][0]) {
            case SInt(v) => @Assert(v, i + 1)
            case other => @Fail("row ${i} has a non-integer id: ${renderValue(other)}")
        }
        match (rs.rows[i][1]) {
            case SText(v) => @Assert(v, spillPayload(i))
            case other => @Fail("row ${i} has a non-text payload: ${renderValue(other)}")
        }
    }
}

/** PRAGMA integrity_check 的全部输出拼成一行。 */
func integrityOf(conn: SqliteConn): String {
    let rs = conn.queryString("PRAGMA integrity_check")
    if (rs.rowCount == 0) {
        return "<empty>"
    }
    let sb = StringBuilder()
    for (i in 0..rs.rowCount) {
        if (i > 0) {
            sb.append("; ")
        }
        match (rs.rows[i][0]) {
            case SText(v) => sb.append(v)
            case other => sb.append(renderValue(other))
        }
    }
    sb.toString()
}

// 单值整数查询直接用 engine_ddl_dml_test.cj 里已有的 scalarInt, 不另造一份。

@Test
class PagerCacheSpillTest {
    /*
     * 内存库: 事务内新分配的页必须仍然可读。
     *
     * 未修时 INSERT 中途就抛 "unexpected end of in-memory database", 连 COMMIT 都到不了。
     */
    @TestCase
    func memoryBackendSurvivesCacheOverflow(): Unit {
        let conn = newMemConn()
        try {
            fillBeyondCache(conn)
            @Assert(integrityOf(conn), "ok")
            assertContentIntact(conn)
        } finally {
            conn.close()
        }
    }

    /*
     * 文件库: COMMIT 之后重新打开, 内容与自检都要正常。
     *
     * 重开是必需的 —— 不重开则读到的是缓存里的页, 磁盘上那张零页碰不到。
     */
    @TestCase
    func fileBackendSurvivesCacheOverflow(): Unit {
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            try {
                fillBeyondCache(conn)
                @Assert(integrityOf(conn), "ok")
            } finally {
                conn.close()
            }
            let reopened = openFileConn(tmp.dbPath)
            try {
                @Assert(integrityOf(reopened), "ok")
                assertContentIntact(reopened)
            } finally {
                reopened.close()
            }
        } finally {
            tmp.cleanup()
        }
    }

    /*
     * SQLite 读回。本驱动的自检有盲区 (页号越界与空页两项是补上去的, 不保证没有第三处),
     * 而补零页在父页看来是一个正常的子页引用, 所以这一条以 SQLite 为判据。
     */
    @TestCase
    func interopReadBackAfterCacheOverflow(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            try {
                fillBeyondCache(conn)
            } finally {
                conn.close()
            }
            var expectedBytes = 0
            for (i in 0..SPILL_ROWS) {
                expectedBytes += spillPayload(i).size
            }
            let script = pythonOpen(tmp.dbPath) + pythonIntegrityCheck() +
                pythonExpect("SELECT count(*) FROM spill", "[(${SPILL_ROWS},)]") +
                pythonExpect("SELECT sum(length(payload)) FROM spill", "[(${expectedBytes},)]") + pythonDone()
            expectPythonOk(script, "sqlite cannot read a database written across a cache overflow")
        } finally {
            tmp.cleanup()
        }
    }

    /*
     * 默认上限那一档。
     *
     * 上面三例把 cache_size 压到 10, 走的是同一条淘汰路径; 这一例不改 cache_size,
     * 用足以越过默认 2000 页的数据量兜底, 防止"只在小上限下成立"的实现混过去。
     * 512 字节页让页数涨得快, 于是行数还能保持在能接受的量级。
     */
    @TestCase
    func exceedsDefaultCacheLimit(): Unit {
        let tmp = TempDbDir()
        let rows = 2600
        let conn = openSqlite(SqliteDSN(path: tmp.file("wide.db"), pageSize: 512))
        try {
            let _ = conn.execString("CREATE TABLE wide (id INTEGER PRIMARY KEY, payload TEXT)")
            let sb = StringBuilder()
            while (sb.toString().size < 400) {
                sb.append("0123456789abcdef")
            }
            let payload = sb.toString()
            let _ = conn.execString("BEGIN")
            for (_ in 0..rows) {
                let _ = conn.exec("INSERT INTO wide(payload) VALUES (?)", [SqliteValue.SText(payload)])
            }
            let _ = conn.execString("COMMIT")
            // 判据的前提: 真的越过了默认上限 (DEFAULT_CACHE_PAGES = 2000, 包私有故写字面值)。
            // 没越过则本例什么也没验证, 所以这一条断言不能省。
            @Assert(scalarInt(conn, "PRAGMA page_count") > 2000, true)
            @Assert(integrityOf(conn), "ok")
            @Assert(scalarInt(conn, "SELECT count(*) FROM wide"), rows)
        } finally {
            conn.close()
            tmp.cleanup()
        }
    }

    /*
     * cache_size 本身: 双语义与下限。
     */
    @TestCase
    func cacheSizePragmaRoundTrip(): Unit {
        let conn = newMemConn()
        try {
            // 正数是页数; 读回一律是负数 (KiB) 形式。4096 字节页上 500 页即 2000 KiB。
            let _ = conn.execString("PRAGMA cache_size = 500")
            @Assert(scalarInt(conn, "PRAGMA cache_size"), -2000)
            // 负数是 KiB: -800 KiB 在 4096 字节页上是 200 页, 读回仍是 -800。
            let _ = conn.execString("PRAGMA cache_size = -800")
            @Assert(scalarInt(conn, "PRAGMA cache_size"), -800)
            // 下限 10 页 = 40 KiB, 低于它一律钉在 10。
            let _ = conn.execString("PRAGMA cache_size = 1")
            @Assert(scalarInt(conn, "PRAGMA cache_size"), -40)
        } finally {
            conn.close()
        }
    }
}
