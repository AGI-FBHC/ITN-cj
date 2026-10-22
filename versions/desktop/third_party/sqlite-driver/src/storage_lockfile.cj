package sqlite_driver

import std.convert.*
import std.env.*
import std.fs.*
import std.time.*

/*
 * 跨进程写互斥的锁文件协议。
 *
 * 纯仓颉没有跨进程文件锁原语, 只能借 `File.create` 在目标已存在时抛异常这一点当排他原语:
 * 建文件成功 = 拿到锁, 抛异常 = 别人持锁。
 *
 * 这条协议的能力边界必须说清 (README 也写了): 它只能协调**同样使用本驱动**的进程。
 * SQLite 使用文件字节区间上的建议性锁, 与本驱动的锁文件互不可见 —— 于是对方仍能读
 * 我们写出的库, 但两者同时写没有互斥。把它说成通用互斥会让人在混合部署里丢数据。
 *
 * 锁文件内容是 "<pid> <unix 毫秒>", 用于判定陈旧锁: 持锁进程已死时, 锁必须能被接管,
 * 否则一次崩溃就让库永久不可写。
 */

/** 锁文件后缀。避开 SQLite 自己用的 -journal / -wal / -shm, 以免对方误判。 */
const LOCK_SUFFIX: String = "-cjflock"

/** 每轮重试的间隔。 */
let LOCK_RETRY_INTERVAL: Duration = Duration.millisecond * 10

func lockPathFor(dbPath: String): String {
    "${dbPath}${LOCK_SUFFIX}"
}

class LockFile {
    let path: String
    private var held: Bool = false

    init(dbPath: String) {
        this.path = lockPathFor(dbPath)
    }

    prop isHeld: Bool {
        get() {
            held
        }
    }

    /**
     * 取锁, 最多等 timeoutMs 毫秒。
     *
     * 可重入: 已持锁时直接返回 —— 同一连接内嵌套的写操作 (如 DDL 触发的索引重建)
     * 不该把自己挡在外面。
     */
    func acquire(timeoutMs: Int64): Unit {
        if (held) {
            return
        }
        let deadline = DateTime.now() + Duration.millisecond * timeoutMs
        var firstTry = true
        while (true) {
            if (tryCreate()) {
                held = true
                return
            }
            // 第一次失败就检查陈旧锁: 持锁进程若已死, 等下去毫无意义。
            if (firstTry) {
                firstTry = false
                if (removeIfStale()) {
                    continue
                }
            }
            if (DateTime.now() >= deadline) {
                throw SqliteBusyException(
                    "database is locked by another process holding ${path} (waited ${timeoutMs} ms)")
            }
            sleep(LOCK_RETRY_INTERVAL)
        }
    }

    private func tryCreate(): Bool {
        try {
            let f = File.create(path)
            f.write("${getProcessId()} ${DateTime.now().toUnixTimeStamp().toMilliseconds()}".toArray())
            f.flush()
            f.close()
            true
        } catch (_: Exception) {
            false
        }
    }

    /** 锁文件的持有者进程已不存在时删掉它, 返回是否删过。 */
    private func removeIfStale(): Bool {
        let holder = readHolderPid()
        match (holder) {
            case Some(pid) where !processAlive(pid) => try {
                remove(path)
                true
            } catch (_: Exception) {
                false
            }
            case _ => false
        }
    }

    private func readHolderPid(): Option<Int64> {
        try {
            let f = File(path, OpenMode.Read)
            let n = f.length
            if (n <= 0 || n > 128) {
                f.close()
                return None
            }
            let buf = Array<Byte>(n, repeat: 0)
            var done = 0
            while (done < n) {
                let got = f.read(buf[done..n])
                if (got <= 0) {
                    break
                }
                done += got
            }
            f.close()
            let text = String.fromUtf8(buf[0..done])
            let parts = text.split(" ")
            if (parts.size < 1) {
                return None
            }
            Some(Int64.parse(parts[0]))
        } catch (_: Exception) {
            None
        }
    }

    func release(): Unit {
        if (!held) {
            return
        }
        held = false
        if (exists(path)) {
            try {
                remove(path)
            } catch (_: Exception) {
                // 删不掉 (如权限变了) 只能留下陈旧锁; 下一个取锁者会按 pid 判定它已死并接管。
            }
        }
    }
}

/**
 * 判断进程是否还活着。
 *
 * 走 /proc/<pid> 而不是 kill(0): 纯仓颉拿不到 signal 系统调用。/proc 不存在的平台上
 * 一律返回 true —— 宁可多等 busy_timeout, 也不能误判活进程已死而抢走它的锁。
 */
func processAlive(pid: Int64): Bool {
    if (!exists("/proc")) {
        return true
    }
    exists("/proc/${pid}")
}
