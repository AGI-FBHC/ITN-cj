package sqlite_driver

import std.collection.*
import std.fs.*
import std.io.*
import std.random.*

/*
 * DELETE 模式回滚日志 (`<db>-journal`)。
 *
 * 日志格式照 SQLite 规范实现, 不是自定义格式 —— 这有个实际好处: 我们崩溃后留下的
 * 热日志，SQLite 打开该库时能自行恢复；本驱动也能恢复同格式日志。若用私有格式，日志可能
 * 被当成损坏或被忽略，从而在崩溃恢复后读到不完整事务。
 *
 * 头部 (28 字节, 后补零到 sector 大小):
 *   0..7    魔数 d9d505f920a163d7
 *   8..11   记录数; 写 0xFFFFFFFF 表示"按文件长度算" (热日志的合法取值)
 *   12..15  校验和初始值 (随机)
 *   16..19  事务开始时数据库的页数 —— 回放后据此截断
 *   20..23  sector 大小
 *   24..27  页大小
 * 之后每条记录: 4 字节页号 + pageSize 字节原始内容 + 4 字节校验和。
 */
const JOURNAL_SECTOR_SIZE: Int64 = 512
const JOURNAL_HEADER_BYTES: Int64 = 28
/** 记录数写这个值表示未知, 由文件长度推算。SQLite 只在热日志上接受它, 正合我们的用法。 */
const JOURNAL_NREC_UNKNOWN: Int64 = 0xFFFFFFFF
let JOURNAL_MAGIC: Array<Byte> = [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]

/**
 * SQLite 的页校验和: 从 pageSize-200 起每隔 200 字节取一个字节累加, 32 位回绕。
 *
 * 只抽样不全量 —— 这是 SQLite 的既有选择, 我们必须逐字复刻, 否则它校验我们的日志
 * 会失败并判定为损坏 (而它的失败表现是"拒绝恢复", 不是报错)。
 */
func journalChecksum(seed: Int64, data: Array<Byte>): Int64 {
    var sum = UInt32(seed & 0xFFFFFFFF)
    var i = data.size - 200
    while (i > 0) {
        sum = wrappingAddU32(sum, UInt32(data[i]))
        i -= 200
    }
    Int64(sum)
}

@OverflowWrapping
func wrappingAddU32(a: UInt32, b: UInt32): UInt32 {
    a + b
}

/** 一条撤销记录: 某页在本作用域内被首次改动之前的内容。 */
class UndoEntry {
    let pageNo: Int64
    let image: Array<Byte>

    init(pageNo: Int64, image: Array<Byte>) {
        this.pageNo = pageNo
        this.image = image
    }
}

/** 头部关键字段的快照, 用于 savepoint 部分回滚。 */
struct HeaderSnapshot {
    let dbSize: Int64
    let freelistTrunk: Int64
    let freelistCount: Int64
    let schemaCookie: Int64
    let userVersion: Int64
    let largestRootPage: Int64
    let changeCounter: Int64

    init(h: DbHeader) {
        this.dbSize = h.dbSize
        this.freelistTrunk = h.freelistTrunk
        this.freelistCount = h.freelistCount
        this.schemaCookie = h.schemaCookie
        this.userVersion = h.userVersion
        this.largestRootPage = h.largestRootPage
        this.changeCounter = h.changeCounter
    }

    func restoreInto(h: DbHeader): Unit {
        h.dbSize = dbSize
        h.freelistTrunk = freelistTrunk
        h.freelistCount = freelistCount
        h.schemaCookie = schemaCookie
        h.userVersion = userVersion
        h.largestRootPage = largestRootPage
        h.changeCounter = changeCounter
    }
}

class Journal {
    /** 日志文件路径; 内存库为空串, 此时所有文件操作都跳过。 */
    let path: String
    private var file: Option<File> = None
    private var checksumInit: Int64 = 0
    /** 本事务已写进日志文件的页, 避免同一页记两遍镜像。 */
    private let journaled = HashSet<Int64>()

    init(path: String) {
        this.path = path
    }

    prop isEnabled: Bool {
        get() {
            !path.isEmpty()
        }
    }

    /** 开日志: 建文件并写头。已存在同名文件说明上次没清理干净, 覆盖它。 */
    func open(dbPageCount: Int64, pageSize: Int64): Unit {
        if (!isEnabled) {
            return
        }
        journaled.clear()
        checksumInit = Int64(Random().nextUInt32() & 0x7FFFFFFF)
        let f = File(path, OpenMode.Write)
        let head = Array<Byte>(JOURNAL_SECTOR_SIZE, repeat: 0)
        JOURNAL_MAGIC.copyTo(head, 0, 0, 8)
        writeU32(head, 8, JOURNAL_NREC_UNKNOWN)
        writeU32(head, 12, checksumInit)
        writeU32(head, 16, dbPageCount)
        writeU32(head, 20, JOURNAL_SECTOR_SIZE)
        writeU32(head, 24, pageSize)
        f.write(head)
        f.flush()
        file = Some(f)
    }

    /**
     * 记一页的原始镜像。
     *
     * 只记事务开始时就存在的页: 事务中新分配的页在回滚时会被截掉, 记它反而会在回放时
     * 把文件重新撑大到含垃圾页。
     */
    func recordPage(pageNo: Int64, data: Array<Byte>, txStartPageCount: Int64): Unit {
        if (!isEnabled || pageNo > txStartPageCount || journaled.contains(pageNo)) {
            return
        }
        if (let Some(f) <- file) {
            let rec = Array<Byte>(4 + data.size + 4, repeat: 0)
            writeU32(rec, 0, pageNo)
            data.copyTo(rec, 0, 4, data.size)
            writeU32(rec, 4 + data.size, journalChecksum(checksumInit, data))
            f.write(rec)
            journaled.add(pageNo)
        }
    }

    /** 提交后清理: 关文件并删掉它。文件消失即"无需恢复"。 */
    func deleteJournal(): Unit {
        if (!isEnabled) {
            return
        }
        if (let Some(f) <- file) {
            try {
                f.flush()
                f.close()
            } catch (_: Exception) {
                // 已经要删了, 关不上不影响结果。
            }
        }
        file = None
        journaled.clear()
        if (exists(path)) {
            try {
                remove(path)
            } catch (_: Exception) {
                throw SqliteRuntimeException("journal", "cannot remove journal file ${path}")
            }
        }
    }

    /** 回滚时把日志里的页镜像写回数据库文件。 */
    func rollbackInto(backend: StorageBackend, pageSize: Int64): Unit {
        if (!isEnabled) {
            return
        }
        if (let Some(f) <- file) {
            f.flush()
        }
        replayJournalFile(path, backend, pageSize)
    }

    /** 事务中止且日志文件已关闭时用: 只清理状态。 */
    func reset(): Unit {
        file = None
        journaled.clear()
    }
}

/** 回放结果, 供热日志恢复报告做了什么。 */
struct JournalReplay {
    let pagesRestored: Int64
    let dbPageCount: Int64

    init(pagesRestored: Int64, dbPageCount: Int64) {
        this.pagesRestored = pagesRestored
        this.dbPageCount = dbPageCount
    }
}

/**
 * 回放一个日志文件: 把其中的页镜像写回数据库, 并把数据库截回日志头记录的页数。
 *
 * 校验和不符时**停在该记录之前**而不是报错退出: 尾部记录可能只写了一半 (崩溃点),
 * 那部分本来就不该回放。前面已校验通过的记录都是完整的, 回放它们才是正确行为。
 */
func replayJournalFile(journalPath: String, backend: StorageBackend, expectPageSize: Int64): JournalReplay {
    let f = File(journalPath, OpenMode.Read)
    let size = f.length
    if (size < JOURNAL_SECTOR_SIZE) {
        // 头都没写完 —— 没有任何记录可回放。
        f.close()
        return JournalReplay(0, 0)
    }
    let head = Array<Byte>(JOURNAL_SECTOR_SIZE, repeat: 0)
    readFully(f, head)
    for (i in 0..8) {
        if (head[i] != JOURNAL_MAGIC[i]) {
            f.close()
            throw SqliteFormatException("journal file ${journalPath} has a bad magic number")
        }
    }
    let ckInit = readU32(head, 12)
    let dbPageCount = readU32(head, 16)
    let sectorSize = readU32(head, 20)
    let pageSize = readU32(head, 24)
    if (pageSize != expectPageSize) {
        f.close()
        throw SqliteFormatException("journal page size ${pageSize} does not match database page size ${expectPageSize}")
    }
    let recSize = 4 + pageSize + 4
    let available = size - sectorSize
    let nRec = if (available > 0) {
        available / recSize
    } else {
        0
    }
    var restored = 0
    let rec = Array<Byte>(recSize, repeat: 0)
    for (i in 0..nRec) {
        let _ = f.seek(SeekPosition.Begin(sectorSize + i * recSize))
        readFully(f, rec)
        let pageNo = readU32(rec, 0)
        let body = rec[4..4 + pageSize]
        let want = readU32(rec, 4 + pageSize)
        if (journalChecksum(ckInit, body) != want) {
            break
        }
        if (pageNo >= 1) {
            backend.writeAt((pageNo - 1) * pageSize, body)
            restored += 1
        }
    }
    f.close()
    if (dbPageCount > 0) {
        backend.truncate(dbPageCount * pageSize)
    }
    backend.flush()
    JournalReplay(restored, dbPageCount)
}

func readFully(f: File, buf: Array<Byte>): Unit {
    var done = 0
    while (done < buf.size) {
        let n = f.read(buf[done..buf.size])
        if (n <= 0) {
            throw SqliteFormatException("journal file truncated: wanted ${buf.size} bytes, got ${done}")
        }
        done += n
    }
}

/**
 * 启动期热日志恢复。
 *
 * "热"的判据: 日志文件存在且魔数完整。SQLite 还会看有没有别的进程持 RESERVED 锁,
 * 本驱动不使用同类文件锁, 所以只能靠锁文件协议 (storage_lockfile.cj) 在恢复前排他。
 */
func recoverHotJournal(dbPath: String, backend: StorageBackend, pageSize: Int64): Option<JournalReplay> {
    let jp = journalPathFor(dbPath)
    if (!exists(jp)) {
        return None
    }
    let replay = try {
        replayJournalFile(jp, backend, pageSize)
    } catch (e: SqliteFormatException) {
        // 魔数或页大小不符: 不是我们能恢复的日志。删掉它会丢别人的数据, 留着会每次
        // 打开都撞上同一堵墙 —— 报错更诚实。
        throw e
    }
    remove(jp)
    Some(replay)
}

func journalPathFor(dbPath: String): String {
    "${dbPath}-journal"
}
