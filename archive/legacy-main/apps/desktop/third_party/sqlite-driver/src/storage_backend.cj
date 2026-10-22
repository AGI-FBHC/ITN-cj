package sqlite_driver

import std.fs.*
import std.io.*
import std.process.*

/*
 * 字节级存储后端。
 *
 * 抽出这层是为了让 Pager 对 `:memory:` 与磁盘库走同一条代码路径。内存库若另写一套
 * 页管理，B-tree 的分裂与合并会出现两份独立实现，难以保持行为一致。
 */
interface StorageBackend {
    /** 从 offset 起读满 buf; 不足则抛。 */
    func readAt(offset: Int64, buf: Array<Byte>): Unit

    /** 把 buf 全部写到 offset 处, 越界则扩展。 */
    func writeAt(offset: Int64, buf: Array<Byte>): Unit

    /** 当前字节长度。 */
    func length(): Int64

    /** 截断或扩展到 n 字节。 */
    func truncate(n: Int64): Unit

    /** 把用户态缓冲交给 OS。注意: 纯仓颉没有 fsync, 这不保证掉电持久。 */
    func flush(): Unit

    func close(): Unit
}

/** 磁盘文件后端。 */
class FileBackend <: StorageBackend {
    private let file: File

    init(file: File) {
        this.file = file
    }

    public func readAt(offset: Int64, buf: Array<Byte>): Unit {
        let _ = file.seek(SeekPosition.Begin(offset))
        var done = 0
        while (done < buf.size) {
            let n = file.read(buf[done..buf.size])
            if (n <= 0) {
                throw SqliteFormatException(
                    "unexpected end of file: wanted ${buf.size} bytes at offset ${offset}, got ${done}")
            }
            done += n
        }
    }

    public func writeAt(offset: Int64, buf: Array<Byte>): Unit {
        let _ = file.seek(SeekPosition.Begin(offset))
        file.write(buf)
    }

    public func length(): Int64 {
        file.length
    }

    public func truncate(n: Int64): Unit {
        file.setLength(n)
    }

    public func flush(): Unit {
        file.flush()
    }

    public func close(): Unit {
        file.close()
    }
}

/**
 * 内存后端: 一段可增长的字节数组。
 *
 * 容量按倍增扩张而不是每次按需 resize: 建库过程是大量小写入, 每次精确扩容会退化成
 * O(n²) 拷贝。used 与 data.size 分开记, data.size 是容量。
 */
class MemoryBackend <: StorageBackend {
    private var data: Array<Byte>
    private var used: Int64 = 0

    init() {
        this.data = Array<Byte>(DEFAULT_PAGE_SIZE, repeat: 0)
    }

    private func ensure(n: Int64): Unit {
        if (n <= data.size) {
            return
        }
        var cap = data.size
        while (cap < n) {
            cap *= 2
        }
        let bigger = Array<Byte>(cap, repeat: 0)
        data.copyTo(bigger, 0, 0, used)
        data = bigger
    }

    public func readAt(offset: Int64, buf: Array<Byte>): Unit {
        if (offset + buf.size > used) {
            throw SqliteFormatException(
                "unexpected end of in-memory database: wanted ${buf.size} bytes at offset ${offset}, have ${used}")
        }
        data.copyTo(buf, offset, 0, buf.size)
    }

    public func writeAt(offset: Int64, buf: Array<Byte>): Unit {
        ensure(offset + buf.size)
        // 稀疏写: offset 越过 used 时中间留零, 与文件后端的空洞语义一致。
        buf.copyTo(data, 0, offset, buf.size)
        if (offset + buf.size > used) {
            used = offset + buf.size
        }
    }

    public func length(): Int64 {
        used
    }

    public func truncate(n: Int64): Unit {
        ensure(n)
        if (n < used) {
            for (i in n..used) {
                data[i] = 0
            }
        }
        used = n
    }

    public func flush(): Unit {}

    public func close(): Unit {
        data = Array<Byte>(0, repeat: 0)
        used = 0
    }
}

/**
 * 尽力把数据推到稳定存储。
 *
 * 纯仓颉没有 fsync, 只能调系统 sync(1) —— 它同步**整个系统**的脏页, 很慢,
 * 所以只在 DSN 显式要求 Sync.Full 时用。返回值表示是否真的执行成功;
 * 拿不到 /bin/sync 时返回 false, 由调用方决定是否降级 (而不是在这里静默当成功)。
 */
func systemSync(): Bool {
    try {
        let p = launch("/bin/sync", Array<String>())
        p.wait() == 0
    } catch (_: Exception) {
        false
    }
}
