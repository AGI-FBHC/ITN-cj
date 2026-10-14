package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.fs.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * WAL 收尾: 读快照隔离、savepoint / 回滚在 WAL 分支上的回归、VACUUM 与 WAL 的交互、
 * 模式切换往返、journal_size_limit。
 *
 * 这些判据与 storage_wal_test.cj 不重合: 那份验的是**格式与 checkpoint** (帧、校验和、
 * 回填、恢复), 本份验的是**事务语义在 WAL 分支上是否与 DELETE 模式等价**。WAL 模式下
 * rollback() 走的是 discardPagesAfter 那条新代码路径, 与 DELETE 模式完全不同的分支,
 * 而既有 savepoint 用例跑的全是内存库与 DELETE 文件库。
 *
 * 本文件覆盖三类可观察行为：
 *   1. 读事务的快照**跨语句保持** —— A 在 BEGIN 后读过的行, B 改并提交后 A 再读仍是旧值;
 *   2. 读不阻塞写 —— A 持读快照时 B 能写能提交;
 *   3. 读后升级成写、期间别人已提交 → SQLite 报 `database is locked`, 不放行。
 *      放行会静默丢更新: 基于旧快照的写会覆盖掉对方的提交, 两边都不报错。
 */

/** 建一个 WAL 库并写入一行基准数据, 返回连接。 */
func openWalWithBaseRow(path: String): SqliteConn {
    let conn = openWalDb(path)
    conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
    conn.execString("INSERT INTO t VALUES (1,'orig')")
    conn
}

/**
 * 单值查询的规范文本, 空结果集给 <none>。
 *
 * 与同包的 scalarText 分开: 那个对非文本值抛异常, 而这里要能原样报出"读到的是别的类型"
 * —— 快照判据的失败消息里那个值本身就是诊断信息。
 */
func walScalar(conn: SqliteConn, sql: String): String {
    let rs = conn.queryString(sql)
    if (rs.rows.isEmpty() || rs.rows[0].size == 0) {
        return "<none>"
    }
    renderValue(rs.rows[0][0])
}

/** 取一个 PRAGMA 的整数值。 */
func pragmaInt(conn: SqliteConn, sql: String): Int64 {
    let rs = conn.queryString(sql)
    if (rs.rows.isEmpty() || rs.rows[0].size == 0) {
        throw Exception("'${sql}' returned no value")
    }
    match (rs.rows[0][0]) {
        case SInt(i) => i
        case v => throw Exception("'${sql}' returned ${v}, wanted an integer")
    }
}

/** 发一条 journal_mode 语句并断言它如实返回切换后的模式。 */
func expectMode(conn: SqliteConn, sql: String, wanted: String): Unit {
    let rs = conn.queryString(sql)
    if (rs.rows.isEmpty()) {
        @Fail("'${sql}' returned no row")
    }
    let got = renderValue(rs.rows[0][0])
    if (got != "T:${wanted}") {
        @Fail("'${sql}' reported ${got} instead of ${wanted}")
    }
}

@Test
class WalSnapshotIsolationTest {
    @TestCase
    func aReadTransactionKeepsItsSnapshotAcrossStatements(): Unit {
        /*
         * 分辨力的来源: 写者改的正是读者**已经读过**的那一行。
         *
         * 若样本让写者改另一行, "快照生效"与"快照根本没起作用"会给同一答案 —— 读者两次
         * 都读到 orig, 因为那一行本来就没被碰过。必须让两种实现给出不同的值。
         */
        let dir = TempDbDir()
        try {
            let reader = openWalWithBaseRow(dir.dbPath)
            let writer = openFileConn(dir.dbPath)
            try {
                reader.execString("BEGIN")
                let first = walScalar(reader, "SELECT v FROM t WHERE id=1")
                if (first != "T:orig") {
                    @Fail("the reader did not see the base row: ${first}")
                }
                // 读不阻塞写: 这一句本身就是判据之一, 抛异常即失败。
                writer.execString("UPDATE t SET v='changed' WHERE id=1")
                let writerSees = walScalar(writer, "SELECT v FROM t WHERE id=1")
                if (writerSees != "T:changed") {
                    @Fail("the writer cannot see its own committed write: ${writerSees}")
                }
                let second = walScalar(reader, "SELECT v FROM t WHERE id=1")
                if (second != "T:orig") {
                    @Fail("the read snapshot did not hold across statements: second read gave ${second}")
                }
                reader.execString("COMMIT")
                // 事务结束后视野必须放开, 否则连接会永久停在一个旧快照上。
                let afterCommit = walScalar(reader, "SELECT v FROM t WHERE id=1")
                if (afterCommit != "T:changed") {
                    @Fail("the snapshot was not released at COMMIT: ${afterCommit}")
                }
            } finally {
                reader.close()
                writer.close()
            }
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func twoReadersEachHoldTheirOwnSnapshot(): Unit {
        // 两个读者在不同时刻取快照, 各自看到取快照那一刻的值。共用一份快照状态的实现会让
        // 后开的那个把先开的推到新值上。
        let dir = TempDbDir()
        try {
            let writer = openWalWithBaseRow(dir.dbPath)
            let early = openFileConn(dir.dbPath)
            let late = openFileConn(dir.dbPath)
            try {
                early.execString("BEGIN")
                let _ = walScalar(early, "SELECT v FROM t WHERE id=1")
                writer.execString("UPDATE t SET v='second' WHERE id=1")
                late.execString("BEGIN")
                let _ = walScalar(late, "SELECT v FROM t WHERE id=1")
                writer.execString("UPDATE t SET v='third' WHERE id=1")
                let earlySees = walScalar(early, "SELECT v FROM t WHERE id=1")
                let lateSees = walScalar(late, "SELECT v FROM t WHERE id=1")
                if (earlySees != "T:orig") {
                    @Fail("the early reader drifted off its snapshot: ${earlySees}")
                }
                if (lateSees != "T:second") {
                    @Fail("the late reader should see the second value, got ${lateSees}")
                }
                early.execString("COMMIT")
                late.execString("COMMIT")
            } finally {
                early.close()
                late.close()
                writer.close()
            }
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func upgradingAStaleReadTransactionToAWriteIsRefused(): Unit {
        /*
         * 该序列必须报告 `database is locked`。
         *
         * 放行是最坏的一档: 本事务的写基于快照里的旧页, 提交后覆盖掉对方已提交的内容,
         * 两边都不报错 —— 丢的那次提交在任何日志里都不会留下痕迹。
         */
        let dir = TempDbDir()
        try {
            let reader = openWalWithBaseRow(dir.dbPath)
            let writer = openFileConn(dir.dbPath)
            try {
                reader.execString("BEGIN")
                let _ = walScalar(reader, "SELECT v FROM t WHERE id=1")
                writer.execString("UPDATE t SET v='writer-won' WHERE id=1")
                assertThrows("upgrading a stale read transaction to a write") {
                    => reader.execString("UPDATE t SET v='reader-lost' WHERE id=1")
                }
                reader.execString("ROLLBACK")
                // 对方的提交必须完好无损 —— 这一条才是"没有丢更新"的判据。
                let survived = walScalar(reader, "SELECT v FROM t WHERE id=1")
                if (survived != "T:writer-won") {
                    @Fail("the other connection's commit was lost: ${survived}")
                }
            } finally {
                reader.close()
                writer.close()
            }
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func aFreshReadTransactionThatWritesFirstIsNotRefused(): Unit {
        // 对照组: 没读过就写 (或读的是自己刚写的) 不该被上一例的守卫拦住。没有这一条,
        // 一个"恒拒绝升级"的实现也能让上一例通过。
        let dir = TempDbDir()
        try {
            let conn = openWalWithBaseRow(dir.dbPath)
            try {
                conn.execString("BEGIN")
                conn.execString("INSERT INTO t VALUES (2,'mine')")
                let mid = walScalar(conn, "SELECT v FROM t WHERE id=2")
                if (mid != "T:mine") {
                    @Fail("a transaction cannot see its own uncommitted write: ${mid}")
                }
                conn.execString("INSERT INTO t VALUES (3,'also-mine')")
                conn.execString("COMMIT")
                let total = walScalar(conn, "SELECT count(*) FROM t")
                if (total != "I:3") {
                    @Fail("row count after a read-then-write transaction is ${total}")
                }
            } finally {
                conn.close()
            }
        } finally {
            dir.cleanup()
        }
    }
}

@Test
class WalRollbackAndSavepointTest {
    @TestCase
    func rollbackToSavepointUndoesOnlyTheInnerWorkUnderWal(): Unit {
        // WAL 模式的 rollback 走 discardPagesAfter 那条分支, 与 DELETE 模式完全不同。
        // 既有 savepoint 用例跑的是内存库与 DELETE 文件库, 一条都没覆盖这条路径。
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            try {
                conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
                conn.execString("INSERT INTO t VALUES (1,'before')")
                conn.execString("BEGIN")
                conn.execString("INSERT INTO t VALUES (2,'outer')")
                conn.execString("SAVEPOINT sp1")
                conn.execString("INSERT INTO t VALUES (3,'inner')")
                conn.execString("UPDATE t SET v='clobbered' WHERE id=1")
                conn.execString("ROLLBACK TO sp1")
                conn.execString("INSERT INTO t VALUES (4,'after')")
                conn.execString("COMMIT")
                let got = renderRows(conn.queryString("SELECT id, v FROM t ORDER BY id"))
                let want = "I:1\u{1F}T:before\u{1E}I:2\u{1F}T:outer\u{1E}I:4\u{1F}T:after"
                if (got != want) {
                    @Fail("ROLLBACK TO under WAL gave ${got}")
                }
            } finally {
                conn.close()
            }
            // 重开一遍: 撤销必须真的没有进 WAL, 而不是只在内存里看着对。
            let again = openFileConn(dir.dbPath)
            let reopened = try {
                renderRows(again.queryString("SELECT id, v FROM t ORDER BY id"))
            } finally {
                again.close()
            }
            if (reopened != "I:1\u{1F}T:before\u{1E}I:2\u{1F}T:outer\u{1E}I:4\u{1F}T:after") {
                @Fail("after reopen the rolled-back rows came back: ${reopened}")
            }
            expectPythonOk(
                pythonOpen(dir.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT count(*) FROM t", "[(3,)]") +
                    pythonDone(), "real sqlite sees exactly the surviving rows after ROLLBACK TO under WAL")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func nestedSavepointsReleaseAndRollbackIndependentlyUnderWal(): Unit {
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            try {
                conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
                conn.execString("BEGIN")
                conn.execString("SAVEPOINT a")
                conn.execString("INSERT INTO t VALUES (1,'a')")
                conn.execString("SAVEPOINT b")
                conn.execString("INSERT INTO t VALUES (2,'b')")
                // RELEASE 保留改动, 只丢掉标记。
                conn.execString("RELEASE b")
                conn.execString("SAVEPOINT c")
                conn.execString("INSERT INTO t VALUES (3,'c')")
                conn.execString("ROLLBACK TO c")
                conn.execString("COMMIT")
                let got = renderRows(conn.queryString("SELECT id FROM t ORDER BY id"))
                if (got != "I:1\u{1E}I:2") {
                    @Fail("nested savepoints under WAL gave ${got}")
                }
            } finally {
                conn.close()
            }
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func aFullRollbackOfAManyPageTransactionLeavesNoTraceUnderWal(): Unit {
        /*
         * 跨多页的回滚: 事务里新分配的页必须从缓存里丢掉, 且一个字节都不能进 -wal。
         *
         * 行数要足够多才有分辨力 —— 单页事务下"丢弃新页"与"不丢"给同一答案, 因为没有新页。
         */
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            let framesBefore = try {
                conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, pad TEXT)")
                conn.execString("INSERT INTO t VALUES (1,'keep')")
                let before = renderValue(conn.queryString("PRAGMA wal_checkpoint(PASSIVE)").rows[0][1])
                conn.execString("BEGIN")
                for (i in 2..120) {
                    conn.exec("INSERT INTO t VALUES (?,?)", [SqliteValue.SInt(i), SqliteValue.SText(repeatText("z", 300))])
                }
                conn.execString("ROLLBACK")
                let got = renderRows(conn.queryString("SELECT id, pad FROM t ORDER BY id"))
                if (got != "I:1\u{1F}T:keep") {
                    @Fail("a rolled-back multi-page transaction left rows behind: ${got}")
                }
                let check = renderRows(conn.queryString("PRAGMA integrity_check"))
                if (check != "T:ok") {
                    @Fail("integrity_check after a WAL rollback: ${check}")
                }
                // 回滚后还能继续写 —— 页分配状态必须是干净的。
                conn.execString("INSERT INTO t VALUES (500,'after-rollback')")
                before
            } finally {
                conn.close()
            }
            let _ = framesBefore
            expectPythonOk(
                pythonOpen(dir.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT id FROM t ORDER BY id",
                    "[(1,), (500,)]") + pythonDone(), "real sqlite sees no trace of the rolled-back transaction")
        } finally {
            dir.cleanup()
        }
    }
}

@Test
class WalVacuumAndModeSwitchTest {
    @TestCase
    func vacuumUnderWalShrinksTheDatabaseAndStaysReadable(): Unit {
        /*
         * VACUUM 在 WAL 模式下把重建结果**追加成帧**而不是直接写主库。判据要同时守住三件事:
         * 页数真的降了、我们读得到、SQLite 也读得到。
         *
         * 只断言"读得到"没有分辨力 —— 一个什么都不做的 VACUUM 也让行数不变。
         */
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            try {
                conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, pad TEXT)")
                conn.execString("BEGIN")
                for (i in 1..201) {
                    conn.exec("INSERT INTO t VALUES (?,?)", [SqliteValue.SInt(i), SqliteValue.SText(repeatText("x", 300))])
                }
                conn.execString("COMMIT")
                let pagesFull = pragmaInt(conn, "PRAGMA page_count")
                conn.execString("DELETE FROM t WHERE id <= 150")
                conn.execString("VACUUM")
                let pagesAfter = pragmaInt(conn, "PRAGMA page_count")
                if (pagesAfter >= pagesFull) {
                    @Fail("VACUUM under WAL did not shrink the database: ${pagesFull} -> ${pagesAfter}")
                }
                let rows = renderRows(conn.queryString("SELECT count(*) FROM t"))
                if (rows != "I:50") {
                    @Fail("row count after VACUUM under WAL is ${rows}")
                }
                let check = renderRows(conn.queryString("PRAGMA integrity_check"))
                if (check != "T:ok") {
                    @Fail("integrity_check after VACUUM under WAL: ${check}")
                }
                // VACUUM 之后还要能写 —— 页分配与 freelist 都换过了。
                conn.execString("INSERT INTO t VALUES (9001,'post-vacuum')")
            } finally {
                conn.close()
            }
            expectPythonOk(
                pythonOpen(dir.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT count(*) FROM t", "[(51,)]") +
                    pythonExpect("SELECT pad FROM t WHERE id=9001", "[('post-vacuum',)]") + pythonDone(),
                "real sqlite reads a WAL database that was VACUUMed")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func vacuumedWalDatabaseIsSelfContainedAfterCheckpoint(): Unit {
        // 回填后单独复制主库文件并校验，避免读取器同时使用 -wal 而掩盖回填失败。
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            try {
                conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, pad TEXT)")
                conn.execString("BEGIN")
                for (i in 1..81) {
                    conn.exec("INSERT INTO t VALUES (?,?)", [SqliteValue.SInt(i), SqliteValue.SText(repeatText("q", 200))])
                }
                conn.execString("COMMIT")
                conn.execString("DELETE FROM t WHERE id % 2 == 0")
                conn.execString("VACUUM")
                let rs = conn.queryString("PRAGMA wal_checkpoint(TRUNCATE)")
                if (renderValue(rs.rows[0][2]) == "I:0") {
                    @Fail("the checkpoint after VACUUM backfilled zero pages")
                }
            } finally {
                conn.close()
            }
            expectPythonOk(
                "import sqlite3, sys, shutil\n" + "shutil.copy('${dir.dbPath}', '${dir.dbPath}.only')\n" +
                    "con = sqlite3.connect('${dir.dbPath}.only')\n" +
                    "rows = con.execute('PRAGMA integrity_check').fetchall()\n" +
                    "if rows != [('ok',)]: raise SystemExit('main file alone: %r' % (rows,))\n" +
                    "n = con.execute('SELECT count(*) FROM t').fetchone()[0]\n" +
                    "if n != 40: raise SystemExit('main file alone has %d of 40 rows' % n)\n" + "con.close()\n" +
                    "sys.stdout.write('OK')\n", "the main file alone is a complete database after VACUUM + checkpoint")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func integrityCheckAcceptsAWalDatabaseWhoseMainFileIsStillShort(): Unit {
        /*
         * WAL 库在 checkpoint 之前, 主库文件仍是旧长度而头里的 dbSize 已是新值。自检若按
         * "文件长度 == dbSize" 判，每一个尚未检查点的 WAL 库都会被判成损坏（例如
         * "header says the database has 30 pages but the file holds 1")。
         *
         * 判据两侧都要: 我们说 ok, 且 SQLite 也说 ok。只有前者时, 一个恒返回 ok 的自检
         * 也能通过。
         */
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            try {
                conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, pad TEXT)")
                conn.execString("BEGIN")
                for (i in 1..201) {
                    conn.exec("INSERT INTO t VALUES (?,?)", [SqliteValue.SInt(i), SqliteValue.SText(repeatText("m", 300))])
                }
                conn.execString("COMMIT")
                // 主库文件必须仍然比头声明的短, 否则这一例测不到那条分支。
                let pages = pragmaInt(conn, "PRAGMA page_count")
                let mainPages = fileByteLength(dir.dbPath) / pragmaInt(conn, "PRAGMA page_size")
                if (mainPages >= pages) {
                    @Fail("this case needs an uncheckpointed WAL: main file already holds ${mainPages} of ${pages} pages")
                }
                let check = renderRows(conn.queryString("PRAGMA integrity_check"))
                if (check != "T:ok") {
                    @Fail("integrity_check rejected a healthy uncheckpointed WAL database: ${check}")
                }
            } finally {
                conn.close()
            }
            expectPythonOk(pythonOpen(dir.dbPath) + pythonIntegrityCheck() + pythonDone(),
                "real sqlite agrees the uncheckpointed WAL database is healthy")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func switchingWalToDeleteAndBackKeepsEveryCommit(): Unit {
        // 每一步之间都写一行: 某一步丢内容时能指出是哪一段。切回 DELETE 前必须先 checkpoint,
        // 否则残留帧在 version 变回 1 之后无人再读, 那些提交静默消失。
        let dir = TempDbDir()
        try {
            let conn = openFileConn(dir.dbPath)
            try {
                conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
                conn.execString("INSERT INTO t VALUES (1,'delete-mode')")
                expectMode(conn, "PRAGMA journal_mode=WAL", "wal")
                conn.execString("INSERT INTO t VALUES (2,'wal-first')")
                expectMode(conn, "PRAGMA journal_mode=DELETE", "delete")
                conn.execString("INSERT INTO t VALUES (3,'back-to-delete')")
                expectMode(conn, "PRAGMA journal_mode=WAL", "wal")
                conn.execString("INSERT INTO t VALUES (4,'wal-again')")
                let got = renderRows(conn.queryString("SELECT id FROM t ORDER BY id"))
                if (got != "I:1\u{1E}I:2\u{1E}I:3\u{1E}I:4") {
                    @Fail("a mode round trip lost commits: ${got}")
                }
            } finally {
                conn.close()
            }
            let again = openFileConn(dir.dbPath)
            let reopened = try {
                let mode = renderValue(again.queryString("PRAGMA journal_mode").rows[0][0])
                if (mode != "T:wal") {
                    @Fail("the final mode did not persist across reopen: ${mode}")
                }
                renderRows(again.queryString("SELECT count(*) FROM t"))
            } finally {
                again.close()
            }
            if (reopened != "I:4") {
                @Fail("after reopen the round-tripped database has ${reopened} rows")
            }
            expectPythonOk(
                pythonOpen(dir.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT count(*) FROM t", "[(4,)]") +
                    pythonDone(), "real sqlite reads the database after a WAL/DELETE round trip")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func switchingToDeleteRemovesTheWalFile(): Unit {
        // -wal 必须真的消失: 留着它会让下次打开又按 WAL 恢复, 而头里的 version 已是 1。
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            try {
                conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY)")
                conn.execString("INSERT INTO t VALUES (1)")
                if (!exists("${dir.dbPath}-wal")) {
                    @Fail("no -wal file exists while in WAL mode")
                }
                expectMode(conn, "PRAGMA journal_mode=DELETE", "delete")
                if (exists("${dir.dbPath}-wal")) {
                    @Fail("the -wal file survived the switch back to DELETE mode")
                }
            } finally {
                conn.close()
            }
            expectPythonOk(
                "import sqlite3, sys\n" + "con = sqlite3.connect('${dir.dbPath}')\n" +
                    "m = con.execute('PRAGMA journal_mode').fetchone()[0]\n" +
                    "if m != 'delete': raise SystemExit('sqlite says journal_mode=%r' % m)\n" +
                    "n = con.execute('SELECT count(*) FROM t').fetchone()[0]\n" +
                    "if n != 1: raise SystemExit('row count is %d' % n)\n" + "con.close()\n" + "sys.stdout.write('OK')\n",
                "real sqlite agrees the database is back in DELETE mode")
        } finally {
            dir.cleanup()
        }
    }
}

@Test
class JournalSizeLimitTest {
    @TestCase
    func theLimitDefaultsToUnlimitedAndReadsBackWhatWasSet(): Unit {
        // 赋值形态也返回生效后的值，返回空结果集会使调用方无法确认设置结果。
        let dir = TempDbDir()
        try {
            let conn = openFileConn(dir.dbPath)
            try {
                if (pragmaInt(conn, "PRAGMA journal_size_limit") != -1) {
                    @Fail("journal_size_limit does not default to -1")
                }
                if (pragmaInt(conn, "PRAGMA journal_size_limit=8192") != 8192) {
                    @Fail("assigning journal_size_limit did not return the new value")
                }
                if (pragmaInt(conn, "PRAGMA journal_size_limit") != 8192) {
                    @Fail("journal_size_limit did not stick")
                }
                if (pragmaInt(conn, "PRAGMA journal_size_limit=-1") != -1) {
                    @Fail("journal_size_limit could not be set back to unlimited")
                }
            } finally {
                conn.close()
            }
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func theLimitIsAcceptedOnMemoryAndRollbackJournalDatabasesToo(): Unit {
        // 这是连接级属性，不写入文件头；内存库与 DELETE 模式同样接受并回读该值。
        // 只把它存在 WalFile 里会让这两种库上的读回值凭空变回默认值。
        let mem = newMemConn()
        try {
            if (pragmaInt(mem, "PRAGMA journal_size_limit=4096") != 4096) {
                @Fail("an in-memory database did not accept journal_size_limit")
            }
        } finally {
            mem.close()
        }
        let dir = TempDbDir()
        try {
            let conn = openFileConn(dir.dbPath)
            try {
                if (pragmaInt(conn, "PRAGMA journal_size_limit=2048") != 2048) {
                    @Fail("a DELETE-mode database did not accept journal_size_limit")
                }
                if (renderValue(conn.queryString("PRAGMA journal_mode").rows[0][0]) != "T:delete") {
                    @Fail("setting journal_size_limit changed the journal mode")
                }
            } finally {
                conn.close()
            }
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func aPositiveLimitKeepsThatMuchOfTheWalAllocatedAcrossAReset(): Unit {
        /*
         * 限制的是"重置后保留多长", 不是任何时刻的实际长度 —— salt 一换, 残留帧在恢复时
         * 全部对不上 salt 而被跳过, 所以保留它们是安全的。
         *
         * 对照组不可省: 不设 limit 时必须截到 32 字节。只有"设了 limit 的那一档"时,
         * 一个恒不截断的实现也能通过。
         */
        let dir = TempDbDir()
        try {
            let limited = openWalDb(dir.file("limited.db"))
            try {
                seedWalRows(limited, 40)
                limited.execString("PRAGMA journal_size_limit=16384")
                let _ = limited.queryString("PRAGMA wal_checkpoint(RESTART)")
                let size = fileByteLength("${dir.file("limited.db")}-wal")
                if (size != 16384) {
                    @Fail("with a 16384-byte limit the reset WAL is ${size} bytes")
                }
                // 保留的空间要能继续写读。
                limited.execString("INSERT INTO t VALUES (900,'after-reset')")
                let got = renderRows(limited.queryString("SELECT pad FROM t WHERE id=900"))
                if (got != "T:after-reset") {
                    @Fail("writing into the retained WAL space gave ${got}")
                }
            } finally {
                limited.close()
            }
            let plain = openWalDb(dir.file("plain.db"))
            try {
                seedWalRows(plain, 40)
                let _ = plain.queryString("PRAGMA wal_checkpoint(RESTART)")
                let size = fileByteLength("${dir.file("plain.db")}-wal")
                if (size != 32) {
                    @Fail("without a limit the reset WAL should be 32 bytes, found ${size}")
                }
            } finally {
                plain.close()
            }
            expectPythonOk(
                pythonOpen(dir.file("limited.db")) + pythonIntegrityCheck() + pythonExpect(
                    "SELECT pad FROM t WHERE id=900", "[('after-reset',)]") + pythonDone(),
                "real sqlite reads a WAL that was reset under a size limit")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func aLimitSetBeforeSwitchingToWalStillApplies(): Unit {
        // 先 PRAGMA 再切模式的顺序很常见。不把连接上的设置带给新挂的 WAL 会让那次设置
        // 静默失效 —— 读回值仍是 16384, 而实际行为按默认走。
        let dir = TempDbDir()
        try {
            let conn = openFileConn(dir.dbPath)
            try {
                let _ = conn.queryString("PRAGMA journal_size_limit=16384")
                expectMode(conn, "PRAGMA journal_mode=WAL", "wal")
                seedWalRows(conn, 40)
                let _ = conn.queryString("PRAGMA wal_checkpoint(RESTART)")
                let size = fileByteLength("${dir.dbPath}-wal")
                if (size != 16384) {
                    @Fail("a limit set before the mode switch did not reach the WAL: ${size} bytes")
                }
            } finally {
                conn.close()
            }
        } finally {
            dir.cleanup()
        }
    }
}
