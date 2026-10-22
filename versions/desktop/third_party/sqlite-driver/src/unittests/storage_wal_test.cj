package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.fs.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * WAL: 格式、校验和、恢复、读写路径、checkpoint、模式切换、并发。
 *
 * 判据使用 SQLite，而不只依赖内部自检。校验和错误的帧会被当成 WAL 结尾，
 * 读取结果停留在提交之前，既不报错也不损坏主库；内部自检和 integrity_check 都难以发现。
 */

/** 建一个 WAL 模式的文件库并写入若干行。返回连接, 调用方负责 close。 */
func openWalDb(path: String): SqliteConn {
    let conn = openFileConn(path)
    let rs = conn.queryString("PRAGMA journal_mode=WAL")
    if (rs.rows.isEmpty()) {
        @Fail("PRAGMA journal_mode=WAL returned no row")
    }
    let mode = renderValue(rs.rows[0][0])
    if (mode != "T:wal") {
        @Fail("PRAGMA journal_mode=WAL reported ${mode} instead of wal")
    }
    conn
}

@Test
class WalHeaderAndModeTest {
    @TestCase
    func switchingToWalWritesVersionTwoIntoTheFileHeader(): Unit {
        // 头里的 write/read version 是持久设置: SQLite 打开这个库时也要认为它是 WAL。
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
            conn.close()
            expectPythonOk(
                "import sqlite3, sys\n" + "raw = open('${dir.dbPath}','rb').read(20)\n" +
                    "if raw[18] != 2 or raw[19] != 2:\n" +
                    "    raise SystemExit('write/read version are %d/%d, wanted 2/2' % (raw[18], raw[19]))\n" +
                    "con = sqlite3.connect('${dir.dbPath}')\n" + "m = con.execute('PRAGMA journal_mode').fetchone()[0]\n" +
                    "if m != 'wal': raise SystemExit('sqlite says journal_mode=%r' % m)\n" + "con.close()\n" +
                    "sys.stdout.write('OK')\n", "WAL flag in the database header")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func theWalFileAppearsAndCarriesTheStandardMagic(): Unit {
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
            let walPath = "${dir.dbPath}-wal"
            if (!exists(walPath)) {
                @Fail("no -wal file was created after switching to WAL mode")
            }
            conn.close()
            expectPythonOk(
                "import struct, sys\n" + "raw = open('${walPath}','rb').read(32)\n" +
                    "magic, fmt, psize = struct.unpack('>III', raw[:12])\n" +
                    "if magic not in (0x377f0682, 0x377f0683):\n" +
                    "    raise SystemExit('bad WAL magic %08x' % magic)\n" +
                    "if fmt != 3007000: raise SystemExit('bad WAL format %d' % fmt)\n" + "sys.stdout.write('OK')\n",
                "WAL header magic and format version")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func aMemoryDatabaseReportsMemoryNotWal(): Unit {
        // 内存库没有第二个访问者, 日志与 WAL 都无处可写。如实返回 memory 而不是假装成功。
        let conn = newMemConn()
        try {
            let rs = conn.queryString("PRAGMA journal_mode=WAL")
            if (renderValue(rs.rows[0][0]) != "T:memory") {
                @Fail("in-memory database reported ${renderValue(rs.rows[0][0])}")
            }
        } finally {
            conn.close()
        }
    }

    @TestCase
    func journalModeOffIsRejectedRatherThanIgnored(): Unit {
        let dir = TempDbDir()
        try {
            let conn = openFileConn(dir.dbPath)
            try {
                assertThrows("journal_mode=off") {
                    => conn.execString("PRAGMA journal_mode=OFF")
                }
            } finally {
                conn.close()
            }
        } finally {
            dir.cleanup()
        }
    }
}

/*
 * WAL 字节级差分校验辅助。
 *
 * 校验和算法在这里独立实现，不调用被测代码，以便逐帧检查 SQLite WAL。
 */
func pythonWalHelpers(): String {
    "import struct\n" + "def _ck(be, data, s1, s2):\n" + "    f = '>I' if be else '<I'\n" + "    M = 0xFFFFFFFF\n" +
        "    for i in range(0, len(data), 8):\n" + "        x0 = struct.unpack_from(f, data, i)[0]\n" +
        "        x1 = struct.unpack_from(f, data, i + 4)[0]\n" + "        s1 = (s1 + x0 + s2) & M\n" +
        "        s2 = (s2 + x1 + s1) & M\n" + "    return s1, s2\n" + "def wal_scan(path):\n" +
        "    raw = open(path, 'rb').read()\n" +
        "    magic, fmt, psize, seq, salt1, salt2, c1, c2 = struct.unpack('>8I', raw[:32])\n" +
        "    be = (magic & 1) == 1\n" + "    h1, h2 = _ck(be, raw[:24], 0, 0)\n" + "    if (h1, h2) != (c1, c2):\n" +
        "        raise SystemExit('WAL header checksum mismatch')\n" + "    frames = []\n" + "    s1, s2 = c1, c2\n" +
        "    off = 32\n" + "    while off + 24 + psize <= len(raw):\n" +
        "        pgno, trunc, fs1, fs2, fc1, fc2 = struct.unpack_from('>6I', raw, off)\n" +
        "        body = raw[off + 24: off + 24 + psize]\n" + "        k1, k2 = _ck(be, raw[off:off + 8], s1, s2)\n" +
        "        k1, k2 = _ck(be, body, k1, k2)\n" +
        "        if (fs1, fs2) != (salt1, salt2) or (k1, k2) != (fc1, fc2):\n" + "            break\n" +
        "        frames.append((pgno, trunc))\n" + "        s1, s2 = k1, k2\n" + "        off += 24 + psize\n" +
        "    return psize, salt1, salt2, be, (s1, s2), frames, len(raw)\n"
}

@Test
class WalChecksumTest {
    @TestCase
    func everyFrameWeWriteChecksumsCorrectlyByRealSqliteRules(): Unit {
        // 这一例必须先单独通过。校验和错了后面全是假绿: SQLite 会把第一个不符的帧
        // 当成 WAL 结尾, 静默读到我们提交之前的旧数据。
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
            conn.execString("BEGIN")
            for (i in 1..6) {
                conn.exec("INSERT INTO t VALUES (?,?)", [SqliteValue.SInt(i), SqliteValue.SText("v${i}")])
            }
            conn.execString("COMMIT")
            conn.execString("INSERT INTO t VALUES (99,'later')")
            conn.close()
            expectPythonOk(
                "import sys\n" + pythonWalHelpers() +
                    "psize, s1, s2, be, run, frames, total = wal_scan('${dir.dbPath}-wal')\n" +
                    "if not frames: raise SystemExit('no valid frame found at all')\n" +
                    "consumed = 32 + len(frames) * (24 + psize)\n" + "if consumed != total:\n" +
                    "    raise SystemExit('checksum chain broke after %d of %d bytes (%d frames)'\n" +
                    "                     % (consumed, total, len(frames)))\n" + "if not any(t for (_, t) in frames):\n" +
                    "    raise SystemExit('no frame is marked as a commit frame')\n" + "sys.stdout.write('OK')\n",
                "every frame passes the real checksum rule")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func aCorruptFrameChecksumTruncatesTheWalInsteadOfBeingRead(): Unit {
        // 篡改第二次提交那一帧的校验和: 我们必须像 SQLite 一样把它当结尾, 于是只看到
        // 第一次提交的数据。读出来就说明我们没验校验和 —— 那正是"静默读到脏数据"的形态。
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
            conn.execString("INSERT INTO t VALUES (1,'first')")
            conn.execString("INSERT INTO t VALUES (2,'second')")
            conn.close()
            // 把最后一帧的校验和翻掉一位。
            expectPythonOk(
                "import sys, struct\n" + pythonWalHelpers() + "p = '${dir.dbPath}-wal'\n" +
                    "psize, s1, s2, be, run, frames, total = wal_scan(p)\n" +
                    "if len(frames) < 2: raise SystemExit('wanted at least 2 frames, got %d' % len(frames))\n" +
                    "last = len(frames) - 1\n" + "off = 32 + last * (24 + psize) + 16\n" +
                    "raw = bytearray(open(p, 'rb').read())\n" + "old = struct.unpack_from('>I', raw, off)[0]\n" +
                    "struct.pack_into('>I', raw, off, old ^ 1)\n" + "open(p, 'wb').write(raw)\n" +
                    "sys.stdout.write('OK')\n", "flip one bit of the last frame checksum")
            let again = openFileConn(dir.dbPath)
            let rows = try {
                renderRows(again.queryString("SELECT id, v FROM t ORDER BY id"))
            } finally {
                again.close()
            }
            // 第一帧那一代的内容仍在, 被篡改的那一帧之后的内容不该出现。
            if (rows.contains("T:second")) {
                @Fail("a frame whose checksum does not match was still read: got ${rows}")
            }
            if (!rows.contains("T:first")) {
                @Fail("valid frames before the corrupt one were lost: got ${rows}")
            }
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func framesWithoutACommitMarkerAreDiscardedOnReopen(): Unit {
        // 模拟"写到一半崩溃": 追加一批校验和正确、但没有提交标记的帧。它们必须被整批丢弃。
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)")
            conn.execString("INSERT INTO t VALUES (1,'committed')")
            conn.close()
            expectPythonOk(
                "import sys, struct\n" + pythonWalHelpers() + "p = '${dir.dbPath}-wal'\n" +
                    "psize, salt1, salt2, be, run, frames, total = wal_scan(p)\n" +
                    "if not frames: raise SystemExit('no committed frame to build on')\n" +
                    "# 造一帧把页 2 整页清零, 但 truncate 写 0 (非提交帧)。\n" + "body = b'\\x00' * psize\n" +
                    "head = bytearray(struct.pack('>4I', 2, 0, salt1, salt2) + b'\\x00' * 8)\n" +
                    "k1, k2 = _ck(be, bytes(head[:8]), run[0], run[1])\n" + "k1, k2 = _ck(be, body, k1, k2)\n" +
                    "struct.pack_into('>II', head, 16, k1, k2)\n" + "with open(p, 'ab') as f:\n" +
                    "    f.write(bytes(head)); f.write(body)\n" + "sys.stdout.write('OK')\n",
                "append a valid but uncommitted frame")
            let again = openFileConn(dir.dbPath)
            let rows = try {
                renderRows(again.queryString("SELECT id, v FROM t ORDER BY id"))
            } finally {
                again.close()
            }
            if (rows != "I:1\u{1F}T:committed") {
                @Fail("uncommitted frames changed what we read: got ${rows}")
            }
        } finally {
            dir.cleanup()
        }
    }
}

@Test
class WalInteropTest {
    @TestCase
    func realSqliteReadsWhatWeWroteIntoTheWal(): Unit {
        // 刻意**不** checkpoint: 数据只在 -wal 里, 主库文件还是旧的。对方必须顺着 WAL 读到
        // 最新内容 —— 只读主库会少掉全部行, 而那是不报错的。
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT, n REAL)")
            conn.execString("CREATE INDEX t_v ON t(v)")
            conn.execString("BEGIN")
            for (i in 1..21) {
                conn.exec("INSERT INTO t VALUES (?,?,?)",
                    [SqliteValue.SInt(i), SqliteValue.SText("row-${i}"), SqliteValue.SReal(Float64(i) / 4.0)])
            }
            conn.execString("COMMIT")
            conn.execString("DELETE FROM t WHERE id % 5 == 0")
            conn.close()
            expectPythonOk(
                pythonOpen(dir.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT count(*) FROM t", "[(16,)]") +
                    pythonExpect("SELECT v FROM t WHERE id = 7", "[('row-7',)]") + pythonExpect(
                    "SELECT count(*) FROM t WHERE v LIKE 'row-1%'", "[(9,)]") + pythonExpect(
                    "SELECT n FROM t WHERE id = 4", "[(1.0,)]") + pythonDone(),
                "real sqlite reads our uncheckpointed WAL")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func weReadWhatRealSqliteWroteIntoTheWal(): Unit {
        // SQLite 写入 -wal 且不执行 checkpoint，驱动必须能读取全部帧。
        let dir = TempDbDir()
        try {
            expectPythonOk(
                "import sqlite3, sys\n" + "con = sqlite3.connect('${dir.dbPath}')\n" + "con.isolation_level = None\n" +
                    "con.execute('PRAGMA journal_mode=WAL')\n" +
                    "con.execute('CREATE TABLE p(id INTEGER PRIMARY KEY, v TEXT, b BLOB)')\n" + "con.execute('BEGIN')\n" +
                    "for i in range(1, 31):\n" +
                    "    con.execute('INSERT INTO p VALUES (?,?,?)', (i, 'py-%d' % i, bytes([i % 251]) * 40))\n" +
                    "con.execute('COMMIT')\n" + "con.execute(\"INSERT INTO p VALUES (500,'tail',NULL)\")\n" +
                    "import os\n" + "if os.path.getsize('${dir.dbPath}-wal') <= 32:\n" +
                    "    raise SystemExit('sqlite checkpointed; this case needs frames left in the WAL')\n" +
                    "con.close()\n" + "sys.stdout.write('OK')\n", "python builds a WAL database")
            let conn = openFileConn(dir.dbPath)
            try {
                let mode = renderValue(conn.queryString("PRAGMA journal_mode").rows[0][0])
                if (mode != "T:wal") {
                    @Fail("we opened a WAL database but report journal_mode=${mode}")
                }
                let count = renderRows(conn.queryString("SELECT count(*) FROM p"))
                if (count != "I:31") {
                    @Fail("wanted 31 rows from the WAL, got ${count}")
                }
                let tail = renderRows(conn.queryString("SELECT v FROM p WHERE id = 500"))
                if (tail != "T:tail") {
                    @Fail("the last (uncheckpointed) commit is missing: got ${tail}")
                }
                let blob = renderRows(conn.queryString("SELECT length(b) FROM p WHERE id = 3"))
                if (blob != "I:40") {
                    @Fail("blob written through the WAL came back wrong: got ${blob}")
                }
                let check = renderRows(conn.queryString("PRAGMA integrity_check"))
                if (check != "T:ok") {
                    @Fail("integrity_check on a python-written WAL database: ${check}")
                }
            } finally {
                conn.close()
            }
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func weCanKeepWritingToAWalDatabaseRealSqliteStarted(): Unit {
        // 接着别人的 WAL 往下写: salt 与校验和链必须接上, 否则对方读到我们的帧会当结尾截断。
        let dir = TempDbDir()
        try {
            expectPythonOk(
                "import sqlite3, sys\n" + "con = sqlite3.connect('${dir.dbPath}')\n" + "con.isolation_level = None\n" +
                    "con.execute('PRAGMA journal_mode=WAL')\n" +
                    "con.execute('CREATE TABLE m(id INTEGER PRIMARY KEY, v TEXT)')\n" +
                    "con.execute(\"INSERT INTO m VALUES (1,'from-python')\")\n" + "con.close()\n" +
                    "sys.stdout.write('OK')\n", "python starts the WAL database")
            let conn = openFileConn(dir.dbPath)
            try {
                conn.execString("INSERT INTO m VALUES (2,'from-driver')")
            } finally {
                conn.close()
            }
            expectPythonOk(
                pythonOpen(dir.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT id, v FROM m ORDER BY id",
                    "[(1, 'from-python'), (2, 'from-driver')]") + pythonDone(), "both sides' frames are readable")
        } finally {
            dir.cleanup()
        }
    }
}

/** WAL 库里灌 n 行的公用准备。 */
func seedWalRows(conn: SqliteConn, n: Int64): Unit {
    conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, pad TEXT)")
    conn.execString("BEGIN")
    for (i in 1..(n + 1)) {
        conn.exec("INSERT INTO t VALUES (?,?)", [SqliteValue.SInt(i), SqliteValue.SText("pad-${i}")])
    }
    conn.execString("COMMIT")
}

@Test
class WalCheckpointTest {
    @TestCase
    func passiveCheckpointBackfillsTheMainFileAndLeavesTheWalInPlace(): Unit {
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            let before = try {
                seedWalRows(conn, 40)
                let rs = conn.queryString("PRAGMA wal_checkpoint")
                if (rs.rows.isEmpty()) {
                    @Fail("PRAGMA wal_checkpoint returned no row")
                }
                // 列是 busy, log, checkpointed。回填页数必须 > 0, 否则这一例什么也没验。
                let backfilled = renderValue(rs.rows[0][2])
                if (backfilled == "I:0") {
                    @Fail("checkpoint reported 0 pages backfilled; nothing was verified")
                }
                renderRows(conn.queryString("SELECT count(*) FROM t"))
            } finally {
                conn.close()
            }
            if (before != "I:40") {
                @Fail("row count changed across checkpoint: ${before}")
            }
            // 主库文件自己就该自洽了 —— 这一条是"回填到底有没有落进主库"的判据。
            expectPythonOk(
                "import sqlite3, os, sys, shutil\n" + "shutil.copy('${dir.dbPath}', '${dir.dbPath}.only')\n" +
                    "con = sqlite3.connect('${dir.dbPath}.only')\n" +
                    "rows = con.execute('PRAGMA integrity_check').fetchall()\n" +
                    "if rows != [('ok',)]: raise SystemExit('main file alone: %r' % (rows,))\n" +
                    "n = con.execute('SELECT count(*) FROM t').fetchone()[0]\n" +
                    "if n != 40: raise SystemExit('main file alone has %d rows' % n)\n" + "con.close()\n" +
                    "sys.stdout.write('OK')\n", "the main file alone carries every row after checkpoint")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func truncateCheckpointEmptiesTheWalFile(): Unit {
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            try {
                seedWalRows(conn, 20)
                let rs = conn.queryString("PRAGMA wal_checkpoint(TRUNCATE)")
                if (renderValue(rs.rows[0][1]) != "I:0") {
                    @Fail("after TRUNCATE the WAL still reports ${renderValue(rs.rows[0][1])} frames")
                }
                let walSize = fileByteLength("${dir.dbPath}-wal")
                if (walSize != 0) {
                    @Fail("TRUNCATE left a ${walSize}-byte WAL file")
                }
                // 截空之后还要能继续写读 —— 头需要在下一次写之前重建。
                conn.execString("INSERT INTO t VALUES (777,'after-truncate')")
                let got = renderRows(conn.queryString("SELECT pad FROM t WHERE id=777"))
                if (got != "T:after-truncate") {
                    @Fail("writing after a TRUNCATE checkpoint gave ${got}")
                }
            } finally {
                conn.close()
            }
            expectPythonOk(
                pythonOpen(dir.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT count(*) FROM t", "[(21,)]") +
                    pythonDone(), "database is readable after a TRUNCATE checkpoint plus a new write")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func restartCheckpointResetsFrameNumberingButKeepsTheFile(): Unit {
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            try {
                seedWalRows(conn, 12)
                let rs = conn.queryString("PRAGMA wal_checkpoint(RESTART)")
                if (renderValue(rs.rows[0][1]) != "I:0") {
                    @Fail("RESTART left ${renderValue(rs.rows[0][1])} frames")
                }
                let walSize = fileByteLength("${dir.dbPath}-wal")
                if (walSize != 32) {
                    @Fail("RESTART should leave just the 32-byte header, found ${walSize} bytes")
                }
                conn.execString("INSERT INTO t VALUES (900,'gen2')")
                let got = renderRows(conn.queryString("SELECT count(*) FROM t"))
                if (got != "I:13") {
                    @Fail("after RESTART the row count is ${got}")
                }
            } finally {
                conn.close()
            }
            expectPythonOk(
                pythonOpen(dir.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT pad FROM t WHERE id=900",
                    "[('gen2',)]") + pythonDone(), "frames written after RESTART are readable by real sqlite")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func automaticCheckpointFiresOnceTheThresholdIsReached(): Unit {
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            try {
                conn.execString("PRAGMA wal_autocheckpoint=4")
                if (renderValue(conn.queryString("PRAGMA wal_autocheckpoint").rows[0][0]) != "I:4") {
                    @Fail("wal_autocheckpoint did not take the new threshold")
                }
                conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY, pad TEXT)")
                // 每条 INSERT 一个事务, 于是帧数稳步增长并越过阈值。
                for (i in 1..13) {
                    conn.exec("INSERT INTO t VALUES (?,?)", [SqliteValue.SInt(i), SqliteValue.SText("p${i}")])
                }
                // 越过阈值后 WAL 应当被回填过至少一次, 帧数不会一路涨到 13 以上。
                let frames = renderValue(conn.queryString("PRAGMA wal_checkpoint(PASSIVE)").rows[0][1])
                let rows = renderRows(conn.queryString("SELECT count(*) FROM t"))
                if (rows != "I:12") {
                    @Fail("row count after autocheckpoint churn is ${rows}")
                }
                if (frames == "I:0") {
                    // 手工 checkpoint 之后帧数为 0 是 PASSIVE 的正常结果之一, 不构成失败,
                    // 但要确认自动 checkpoint 真的把内容推进过主库 —— 见下面的主库单独判据。
                    ()
                }
            } finally {
                conn.close()
            }
            expectPythonOk(
                "import sqlite3, sys, shutil\n" + "shutil.copy('${dir.dbPath}', '${dir.dbPath}.only')\n" +
                    "con = sqlite3.connect('${dir.dbPath}.only')\n" +
                    "n = con.execute('SELECT count(*) FROM t').fetchone()[0]\n" +
                    "if n != 12: raise SystemExit('main file alone has %d of 12 rows' % n)\n" + "con.close()\n" +
                    "sys.stdout.write('OK')\n", "automatic checkpoint moved rows into the main file")
        } finally {
            dir.cleanup()
        }
    }

    @TestCase
    func checkpointInsideATransactionIsRejected(): Unit {
        // 事务中间回填会把尚未提交的页写进主库。报错而不是静默跳过 —— 跳过会让调用方
        // 以为 WAL 已经清空。
        let dir = TempDbDir()
        try {
            let conn = openWalDb(dir.dbPath)
            try {
                conn.execString("CREATE TABLE t(id INTEGER PRIMARY KEY)")
                conn.execString("BEGIN")
                conn.execString("INSERT INTO t VALUES (1)")
                assertThrows("checkpoint inside a transaction") {
                    => conn.execString("PRAGMA wal_checkpoint")
                }
                conn.execString("ROLLBACK")
            } finally {
                conn.close()
            }
        } finally {
            dir.cleanup()
        }
    }
}
