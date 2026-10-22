package sqlite_driver_cross_process

import std.database.sql.*
import std.sync.*
import std.convert.*
import std.fs.*
import std.io.*
import std.time.*

import sqlite_driver.*

/*
 * 跨进程可见性探针（DELETE 回滚日志模式）。
 *
 * 这个载体的存在理由是一条只在**两个进程**里成立的缺陷：连接一旦把某页读进缓存，getPage 就
 * 直接命中返回，后续任何一次读都不再碰文件。于是别的进程在我们打开连接之后提交的行，对我们
 * 永不可见 —— 不是"晚一点可见"，是永久读不到。
 *
 * 单进程测不出来：同一个 Pager 写完自己就把页改在缓存里了。两个**线程**也测不出来：它们共享
 * 同一个连接对象和同一份缓存。必须是两个进程各开一个连接。
 *
 * 启动顺序是判据的一部分。"B 后开连接"那一种顺序即使有缺陷也是绿的 —— B 打开时锁行已经在
 * 文件里，它第一次读就读到了。有分辨力的是反过来：**B 先开连接并读一次**（把旧页钉进缓存），
 * A 之后才写。所以 observe 子命令必须先读一次再等。
 *
 * 子命令：
 *   init   <db>            建表并写入基线行
 *   write  <db> <value>    以另一个进程的身份提交一行
 *   observe <db> <expect> <timeoutMs>
 *                          先读一次（钉住缓存），再轮询直到读到 expect 或超时
 *
 * observe 的退出码：0 = 读到了；3 = 超时没读到（缺陷成立）；4 = 前提不成立（连基线都读不到）。
 */
main(args: Array<String>): Int64 {
    if (args.size < 2) {
        eprintln("usage: sqlite_driver_cross_process <init|write|observe> <database-path> [...]")
        return 2
    }
    let command = args[0]
    let path = args[1]
    try {
        match (command) {
            case "init" => runInit(path)
            case "write" =>
                if (args.size != 3) {
                    eprintln("usage: ... write <database-path> <value>")
                    return 2
                }
                runWrite(path, args[2])
            case "observe" =>
                if (args.size != 4 && args.size != 5) {
                    eprintln("usage: ... observe <database-path> <expect> <timeoutMs> [ready-marker-path]")
                    return 2
                }
                let marker: Option<String> = if (args.size == 5) {
                    Some(args[4])
                } else {
                    None
                }
                runObserve(path, args[2], parseMillis(args[3]), marker)
            case _ =>
                eprintln("unknown command '${command}'")
                2
        }
    } catch (e: Exception) {
        eprintln("ERROR ${e.message}")
        1
    }
}

func runInit(path: String): Int64 {
    let conn = openSqlite(SqliteDSN(path: path))
    try {
        conn.execString("DROP TABLE IF EXISTS shared_lease")
        conn.execString("CREATE TABLE shared_lease (id INTEGER PRIMARY KEY, owner TEXT NOT NULL)")
        conn.execString("INSERT INTO shared_lease VALUES (1, 'baseline')")
        println("INIT_OK")
        0
    } finally {
        conn.close()
    }
}

func runWrite(path: String, value: String): Int64 {
    let conn = openSqlite(SqliteDSN(path: path))
    try {
        conn.execString("UPDATE shared_lease SET owner = '${value}' WHERE id = 1")
        // 写完立刻自己读一遍：这一行排除"UPDATE 根本没生效"这种同形失败。observe 读不到时，
        // 少了这一行就无法区分"缓存没失效"与"写入方自己就没写成功"。
        let readBack = ownerOf(conn)
        println("WRITE_OK ${value} readback=${readBack}")
        if (readBack == value) {
            0
        } else {
            eprintln("WRITE_NOT_APPLIED 期望 ${value}, 自身读回 ${readBack}")
            4
        }
    } finally {
        conn.close()
    }
}

/**
 * 就绪信号必须落成文件，不能靠 stdout。
 *
 * println 的输出是带缓冲的：调用方 grep 日志要等到进程退出才看得到 OBSERVE_READY，而那时
 * 判据早就跑完了。文件创建是一次显式系统调用，没有这个歧义。
 */
func signalReady(marker: Option<String>): Unit {
    if (let Some(p) <- marker) {
        let f = File(p, OpenMode.Write)
        try {
            f.write("ready".toArray())
            f.flush()
        } finally {
            f.close()
        }
    }
}

func runObserve(path: String, expect: String, timeoutMs: Int64, marker: Option<String>): Int64 {
    let conn = openSqlite(SqliteDSN(path: path))
    try {
        // 关键的第一次读：把当前页钉进本连接的缓存。缺陷成立时，这一次读之后本连接就再也
        // 看不到文件的变化了。
        let initial = ownerOf(conn)
        println("OBSERVE_INITIAL ${initial}")
        if (initial.isEmpty()) {
            eprintln("OBSERVE_NO_BASELINE 连基线行都读不到, 判据前提不成立")
            return 4
        }
        if (initial == expect) {
            eprintln("OBSERVE_ALREADY_EXPECTED 基线已经是期望值, 该轮没有分辨力")
            return 4
        }

        println("OBSERVE_READY")
        // 缓存已钉住，现在才允许写入方动手。
        signalReady(marker)
        let deadline = MonoTime.now() + Duration.millisecond * timeoutMs
        var polls = 0
        while (MonoTime.now() < deadline) {
            sleep(Duration.millisecond * 50)
            polls++
            let current = ownerOf(conn)
            if (current == expect) {
                println("OBSERVE_SAW ${current} polls=${polls}")
                return 0
            }
        }
        let last = ownerOf(conn)
        println("OBSERVE_TIMEOUT last=${last} polls=${polls}")
        eprintln("OBSERVE_STALE 本连接在 ${timeoutMs}ms 内始终读到 ${last}, 另一进程的提交不可见")
        3
    } finally {
        conn.close()
    }
}

/** 读当前 owner；表为空时返回空串，由调用方判成"前提不成立"而不是当成一个取值。 */
func ownerOf(conn: SqliteConn): String {
    let rows = conn.queryString("SELECT owner FROM shared_lease WHERE id = 1").rows
    if (rows.isEmpty()) {
        return ""
    }
    match (rows[0][0]) {
        case SText(value) => value
        case value => throw Exception("expected text owner, got ${value}")
    }
}

func parseMillis(text: String): Int64 {
    match (Int64.tryParse(text)) {
        case Some(v) where v > 0 => v
        case _ => throw IllegalArgumentException("timeoutMs must be a positive integer, got '${text}'")
    }
}
