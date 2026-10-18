package sqlite_driver

import std.collection.*
import std.fs.*
import std.io.*
import std.sort.*
import std.random.*

/*
 * WAL 文件的读写与恢复。
 *
 * WAL-index (页号 → 最新帧号) 放进程内存。SQLite 把它放在 `-shm` 里让多进程共享, 而
 * `std.posix` 没有 mmap, 所以我们每个进程各自恢复一份 —— 跨进程的一致性靠 `-cjflock`
 * 串行写来保证 (与本驱动现有的 DELETE 模式同一个协议)。
 *
 * 读事务开始时钉住一个 mxFrame 作为快照, 事务内不看后来追加的帧。这是"读不阻塞写"的
 * 全部来源: 写者往文件尾追加, 读者按自己的上限截断视野, 两边不必互斥。
 */

/** checkpoint 的四种模式。 */
enum WalCheckpointMode {
    /** 能回填多少算多少, 不重置 WAL。 */
    | CheckpointPassive
    /** 回填全部。单进程下与 PASSIVE 同效 (没有别的读者要等)。 */
    | CheckpointFull
    /** 回填全部后重置 WAL 到零帧 (换 salt)。 */
    | CheckpointRestart
    /** RESTART 再把文件截成 0 字节。 */
    | CheckpointTruncate
}

func walCheckpointModeName(mode: WalCheckpointMode): String {
    match (mode) {
        case CheckpointPassive => "passive"
        case CheckpointFull => "full"
        case CheckpointRestart => "restart"
        case CheckpointTruncate => "truncate"
    }
}

/** 一次 checkpoint 的结果, 供 PRAGMA wal_checkpoint 返回。 */
struct WalCheckpointResult {
    /** 回填进主库的页数。 */
    let backfilled: Int64
    /** checkpoint 之前 WAL 里的帧数。 */
    let framesBefore: Int64
    /** checkpoint 之后 WAL 里的帧数。 */
    let framesAfter: Int64

    init(backfilled: Int64, framesBefore: Int64, framesAfter: Int64) {
        this.backfilled = backfilled
        this.framesBefore = framesBefore
        this.framesAfter = framesAfter
    }
}

class WalFile {
    let path: String
    let pageSize: Int64
    private var file: Option<File> = None
    private var meta: Option<WalFileHeader> = None
    /** 页号 → 最新有效帧号 (1 起)。只含"已提交"的帧。 */
    private let index = HashMap<Int64, Int64>()
    /** 已确认有效且已提交的帧数, 也是新读事务的默认快照上限。 */
    var frameCount: Int64 = 0
    /** 最后一个提交帧记的库页数; 0 表示 WAL 里还没有提交。 */
    var dbSizeAtLastCommit: Int64 = 0
    /** 追加下一帧时的校验和种子 —— 即第 frameCount 帧的校验和。 */
    private var runningChecksum: WalChecksum = WalChecksum(0, 0)
    /** 自动 checkpoint 阈值 (帧); 0 或负数表示关闭。 */
    var autoCheckpointFrames: Int64 = WAL_DEFAULT_AUTOCHECKPOINT
    /**
     * `PRAGMA journal_size_limit` 的字节上限; 负数表示不限。
     *
     * 只在 WAL **重置**时起作用 —— 重置后文件里已无有效帧, 截短它不丢任何东西, 而保留原
     * 长度是为了让后续的帧写进已分配的空间 (省掉文件系统的扩展)。所以"限制"限的是
     * 那份预留, 不是任何时刻的实际长度。
     */
    var journalSizeLimit: Int64 = -1
    /** 上次扫描时的文件长度, 用来判断别的进程有没有追加过。 */
    private var scannedLength: Int64 = 0

    init(path: String, pageSize: Int64) {
        this.path = path
        this.pageSize = pageSize
    }

    /** -wal 文件在磁盘上存在吗。不叫 exists —— 那会遮蔽 std.fs 的同名自由函数。 */
    prop hasFile: Bool {
        get() {
            !path.isEmpty() && exists(path)
        }
    }

    prop isOpen: Bool {
        get() {
            match (file) {
                case Some(_) => true;
                case None => false
            }
        }
    }

    /** 一帧在文件里的字节偏移。帧号从 1 起。 */
    private func frameOffset(frameNo: Int64): Int64 {
        WAL_HEADER_BYTES + (frameNo - 1) * (WAL_FRAME_HEADER_BYTES + pageSize)
    }

    private func requireFile(): File {
        match (file) {
            case Some(f) => f
            case None => throw SqliteRuntimeException("wal", "WAL file ${path} is not open")
        }
    }

    private func requireMeta(): WalFileHeader {
        match (meta) {
            case Some(m) => m
            case None => throw SqliteRuntimeException("wal", "WAL file ${path} has no header yet")
        }
    }

    /**
     * 打开 WAL: 文件已存在则恢复它, 不存在则建一个空的 (只有头)。
     *
     * 页大小不符时报错而不是重建: 那说明这个 -wal 属于另一个页大小的库, 重建会丢掉对方
     * 尚未回填的提交。
     */
    func openOrCreate(): Unit {
        if (path.isEmpty()) {
            return
        }
        if (exists(path) && fileByteLength(path) >= WAL_HEADER_BYTES) {
            file = Some(File(path, OpenMode.ReadWrite))
            recover()
            return
        }
        let f = File(path, OpenMode.ReadWrite)
        file = Some(f)
        writeFreshHeader(f, 0)
    }

    /** 写一份新的 WAL 头 (0 帧)。salt-1 递增让旧帧不再被认作本代。 */
    private func writeFreshHeader(f: File, checkpointSeq: Int64): Unit {
        let salt1 = nextSalt1()
        let salt2 = Int64(Random().nextUInt32())
        let buf = serializeWalHeader(pageSize, checkpointSeq, salt1, salt2)
        let _ = f.seek(SeekPosition.Begin(0))
        f.write(buf)
        f.flush()
        let parsed = parseWalHeader(buf)
        meta = Some(parsed)
        index.clear()
        frameCount = 0
        dbSizeAtLastCommit = 0
        runningChecksum = parsed.checksum
        scannedLength = WAL_HEADER_BYTES
    }

    private func nextSalt1(): Int64 {
        match (meta) {
            case Some(m) => (m.salt1 + 1) & 0xFFFFFFFF
            case None => Int64(Random().nextUInt32())
        }
    }

    /**
     * 从头扫帧重建索引。
     *
     * 停在第一个"salt 不符或校验和不符"的帧, 并且只把**最后一个提交帧**之前的帧算进索引 ——
     * 提交帧之后的那些属于一个没写完的事务, 必须丢弃。这与 SQLite 在无 `-shm` 时的恢复
     * 路径一致。
     */
    func recover(): Unit {
        let f = requireFile()
        let headBuf = Array<Byte>(WAL_HEADER_BYTES, repeat: 0)
        let _ = f.seek(SeekPosition.Begin(0))
        readFully(f, headBuf)
        let m = parseWalHeader(headBuf)
        if (m.pageSize != pageSize) {
            throw SqliteFormatException("WAL page size ${m.pageSize} does not match database page size ${pageSize}")
        }
        meta = Some(m)
        index.clear()
        frameCount = 0
        dbSizeAtLastCommit = 0
        runningChecksum = m.checksum
        let total = f.length
        let frameBytes = WAL_FRAME_HEADER_BYTES + pageSize
        // 先整趟扫出"到哪一帧为止是有效且已提交的", 再据此填索引 —— 边扫边填会把
        // 未提交事务的页也记进去。
        let pageOfFrame = ArrayList<Int64>()
        var commitFrame = 0
        var commitDbSize = 0
        var commitChecksum = m.checksum
        var running = m.checksum
        var frameNo = 0
        let head = Array<Byte>(WAL_FRAME_HEADER_BYTES, repeat: 0)
        let body = Array<Byte>(pageSize, repeat: 0)
        while (frameOffset(frameNo + 1) + frameBytes <= total) {
            frameNo += 1
            let _ = f.seek(SeekPosition.Begin(frameOffset(frameNo)))
            readFully(f, head)
            readFully(f, body)
            if (readU32(head, WAL_FRAME_OFF_SALT1) != m.salt1 || readU32(head, WAL_FRAME_OFF_SALT2) != m.salt2) {
                // 上一代 WAL 的残帧: 到此为止。
                frameNo -= 1
                break
            }
            let stored = WalChecksum(UInt32(readU32(head, WAL_FRAME_OFF_CHECKSUM1)),
                UInt32(readU32(head, WAL_FRAME_OFF_CHECKSUM2)))
            let computed = walFrameChecksum(m.bigEndianChecksum, head, body, running)
            if (!computed.equalsTo(stored)) {
                frameNo -= 1
                break
            }
            running = computed
            pageOfFrame.add(readU32(head, WAL_FRAME_OFF_PAGE_NO))
            let truncate = readU32(head, WAL_FRAME_OFF_TRUNCATE)
            if (truncate != 0) {
                commitFrame = frameNo
                commitDbSize = truncate
                commitChecksum = computed
            }
        }
        for (i in 0..commitFrame) {
            index[pageOfFrame[i]] = i + 1
        }
        frameCount = commitFrame
        dbSizeAtLastCommit = commitDbSize
        runningChecksum = commitChecksum
        scannedLength = total
    }

    /**
     * 别的进程可能改过 -wal: 长度变了或代号换了就重扫。
     *
     * 单看长度不够。帧是定长的, N 帧的长度恒为 32 + N*(24+pageSize), 于是"对方做过一次
     * RESTART 又恰好追加回同样的帧数"这一种交错会让长度**逐字相同**。那时索引里的帧号指向
     * 的是上一代 WAL 的槽位, 而槽位上现在放着新一代的别的页 —— 读路径 (frameFor →
     * readFrameBody) 只查索引直接 seek, 不校验 salt 也不校验校验和 (那只在 recover 里做),
     * 所以后果是静默读到错页内容, 不报错。
     *
     * salt1/salt2/checkpointSeq 三个字段唯一确定"哪一代 WAL", 比一次只多读 32 字节。
     *
     * 重扫整份而不是增量接着扫: 换代之后旧索引整份失效。帧数是千的量级, 重扫的代价远小于
     * 一次错读。
     */
    func refreshIfGrown(): Unit {
        if (!isOpen) {
            return
        }
        let f = requireFile()
        if (f.length != scannedLength || !sameGenerationOnDisk(f)) {
            recover()
        }
    }

    /**
     * 磁盘上的 WAL 头是否还是本进程索引所属的那一代。
     *
     * 两种"比不了"的情形一律返回 true, 交给长度那一支判定, 以免把正常路径变成每次重扫:
     * meta 为 None (TRUNCATE 之后还没补头) 时本来就没有代号可比; 文件短于一个头时同理。
     *
     * 头解析失败返回 false —— 宁可重扫一次让 recover 抛出真正的错误, 也不能带着一份
     * 来历不明的索引继续读。
     */
    private func sameGenerationOnDisk(f: File): Bool {
        let m = match (meta) {
            case Some(x) => x
            case None => return true
        }
        if (f.length < WAL_HEADER_BYTES) {
            return true
        }
        try {
            let buf = Array<Byte>(WAL_HEADER_BYTES, repeat: 0)
            let _ = f.seek(SeekPosition.Begin(0))
            readFully(f, buf)
            let onDisk = parseWalHeader(buf)
            onDisk.salt1 == m.salt1 && onDisk.salt2 == m.salt2 && onDisk.checkpointSeq == m.checkpointSeq
        } catch (_: Exception) {
            false
        }
    }

    /**
     * 某页在快照内的最新帧号; 0 表示 WAL 里没有 (该读主库文件)。
     *
     * maxFrame 是读事务钉住的上限: 大于它的帧属于本事务开始之后的提交, 看不见。
     */
    func frameFor(pageNo: Int64, maxFrame: Int64): Int64 {
        match (index.get(pageNo)) {
            case Some(fr) =>
                if (fr <= maxFrame) {
                    fr
                } else {
                    scanBackFor(pageNo, maxFrame)
                }
            case None => 0
        }
    }

    /**
     * 快照上限之下该页的最新帧。
     *
     * 只在"索引里的帧比快照新"时才走: 那一页在本事务开始后又被改过, 我们要的是更早的
     * 那一版。倒着扫比给每个快照各留一份索引省得多, 而这条路径本身很少走到 (要求
     * 同一页在读事务存续期间被写过)。
     */
    private func scanBackFor(pageNo: Int64, maxFrame: Int64): Int64 {
        if (maxFrame < 1 || !isOpen) {
            return 0
        }
        let f = requireFile()
        let head = Array<Byte>(WAL_FRAME_HEADER_BYTES, repeat: 0)
        var fr = maxFrame
        while (fr >= 1) {
            let _ = f.seek(SeekPosition.Begin(frameOffset(fr)))
            readFully(f, head)
            if (readU32(head, WAL_FRAME_OFF_PAGE_NO) == pageNo) {
                return fr
            }
            fr -= 1
        }
        0
    }

    /** 读一帧的页内容。 */
    func readFrameBody(frameNo: Int64, buf: Array<Byte>): Unit {
        let f = requireFile()
        let _ = f.seek(SeekPosition.Begin(frameOffset(frameNo) + WAL_FRAME_HEADER_BYTES))
        readFully(f, buf)
    }

    /**
     * 快照内 WAL 是否持有该页。
     *
     * 供 integrity_check 判断"主库文件里没有的页是不是在 WAL 里" —— WAL 模式下主库文件在
     * checkpoint 之前是旧的, 按它的长度判页数会把每个 WAL 库都判成损坏。
     */
    func holdsPage(pageNo: Int64, maxFrame: Int64): Bool {
        frameFor(pageNo, maxFrame) > 0
    }

    /** 一帧的页号。 */
    func framePageNo(frameNo: Int64): Int64 {
        let f = requireFile()
        let head = Array<Byte>(WAL_FRAME_HEADER_BYTES, repeat: 0)
        let _ = f.seek(SeekPosition.Begin(frameOffset(frameNo)))
        readFully(f, head)
        readU32(head, WAL_FRAME_OFF_PAGE_NO)
    }

    /**
     * 追加一批帧, 最后一帧标成提交。
     *
     * 提交帧的 truncate 字段写事务结束后的库页数 —— SQLite 靠它知道库有多大, 写 0
     * 会让对方把这一帧当成非提交帧, 于是整个事务被当作未完成而丢弃 (静默丢数据)。
     *
     * 写文件的顺序是"先全部帧、再 flush": 中途崩溃时最后一帧不完整, 校验和链会在那里断开,
     * 恢复路径正好把这批帧全部丢掉。
     */
    func appendCommit(pages: ArrayList<Page>, dbSizeAfter: Int64): Unit {
        if (pages.isEmpty()) {
            return
        }
        let f = requireFile()
        let m = requireMeta()
        var seed = runningChecksum
        var frameNo = frameCount
        let _ = f.seek(SeekPosition.Begin(frameOffset(frameCount + 1)))
        for (i in 0..pages.size) {
            let page = pages[i]
            let isLast = i == pages.size - 1
            let truncate = if (isLast) {
                dbSizeAfter
            } else {
                0
            }
            let head = serializeWalFrameHeader(page.pageNo, truncate, m.salt1, m.salt2, page.data, seed)
            f.write(head)
            f.write(page.data)
            seed = WalChecksum(UInt32(readU32(head, WAL_FRAME_OFF_CHECKSUM1)),
                UInt32(readU32(head, WAL_FRAME_OFF_CHECKSUM2)))
            frameNo += 1
            index[page.pageNo] = frameNo
        }
        f.flush()
        frameCount = frameNo
        dbSizeAtLastCommit = dbSizeAfter
        runningChecksum = seed
        scannedLength = f.length
    }

    /**
     * 把 WAL 帧回填进主库文件。
     *
     * 每页只写它的**最新**一帧 (索引里就是最新的), 于是回填的页数等于被改过的不同页数,
     * 而不是帧数。回填后主库要按最后一次提交的页数截断 —— 事务里删过页时主库会比目标大,
     * 不截断会让文件尾留着已经不属于任何树的页, SQLite 的 integrity_check 会报出来。
     */
    func checkpointInto(backend: StorageBackend, mode: WalCheckpointMode): WalCheckpointResult {
        let before = frameCount
        if (before == 0) {
            // 无帧可回填。RESTART / TRUNCATE 仍要重置文件, 否则模式切换后 -wal 会留着旧头。
            let after = resetForMode(mode, 0)
            return WalCheckpointResult(0, 0, after)
        }
        let buf = Array<Byte>(pageSize, repeat: 0)
        // 按页号升序回填: 顺序写对磁盘友好, 也让崩溃后的主库形态可预测。
        let pageNos = ArrayList<Int64>()
        for ((no, _) in index) {
            pageNos.add(no)
        }
        sort(pageNos)
        var written = 0
        for (no in pageNos) {
            let fr = index[no]
            if (fr > before) {
                continue
            }
            readFrameBody(fr, buf)
            backend.writeAt((no - 1) * pageSize, buf)
            written += 1
        }
        if (dbSizeAtLastCommit > 0) {
            backend.truncate(dbSizeAtLastCommit * pageSize)
        }
        backend.flush()
        let after = resetForMode(mode, before)
        WalCheckpointResult(written, before, after)
    }

    /**
     * 回填完成后按模式处置 WAL 文件, 返回剩余帧数。
     *
     * PASSIVE / FULL 保留帧不动 —— 帧还在, 但内容已经与主库一致, 读路径读哪边都对。
     * 单进程下两者同效: FULL 的区别是"等所有读者离开", 而我们没有别的读者要等。
     */
    private func resetForMode(mode: WalCheckpointMode, framesBefore: Int64): Int64 {
        match (mode) {
            case CheckpointPassive => framesBefore
            case CheckpointFull => framesBefore
            case CheckpointRestart =>
                restart()
                0
            case CheckpointTruncate =>
                restart()
                let f = requireFile()
                f.setLength(0)
                f.flush()
                // 截成 0 字节后头也没了: 下次写之前必须重建, 否则追加的帧前面没有头。
                meta = None
                scannedLength = 0
                0
        }
    }

    /**
     * 重置成零帧的新一代 WAL: 换 salt, checkpoint 序号 +1。
     *
     * salt 一换, 文件里残留的旧帧在恢复时就全部对不上 salt 而被跳过, 所以**不截断也是安全的**。
     * 我们仍然默认截到 32 字节, 因为留着一份没人会读的兆级文件对嵌入式场景没有好处 ——
     * SQLite 留着它是为了让后续帧写进已分配的空间, 那点收益换不来这份磁盘占用。
     *
     * `journal_size_limit` 正是给需要那份预留的调用方的旋钮: 设了正值就保留到该长度为止。
     */
    private func restart(): Unit {
        let f = requireFile()
        let seq = match (meta) {
            case Some(m) => (m.checkpointSeq + 1) & 0xFFFFFFFF
            case None => 0
        }
        let existing = f.length
        writeFreshHeader(f, seq)
        f.setLength(retainedLengthAfterReset(existing))
        f.flush()
        scannedLength = f.length
    }

    /**
     * 重置后保留多长。
     *
     * 上限之外的部分截掉; 头本身 (32 字节) 永远保留 —— 截到比头还短会让下一次打开读不到头。
     */
    private func retainedLengthAfterReset(existing: Int64): Int64 {
        if (journalSizeLimit < 0) {
            return WAL_HEADER_BYTES
        }
        if (existing <= journalSizeLimit) {
            return if (existing < WAL_HEADER_BYTES) {
                WAL_HEADER_BYTES
            } else {
                existing
            }
        }
        if (journalSizeLimit < WAL_HEADER_BYTES) {
            WAL_HEADER_BYTES
        } else {
            journalSizeLimit
        }
    }

    /** TRUNCATE 之后再写之前要补一份头。 */
    func ensureHeader(): Unit {
        match (meta) {
            case Some(_) => ()
            case None => writeFreshHeader(requireFile(), 0)
        }
    }

    /** 自动 checkpoint 的判据: 帧数到阈值。 */
    func shouldAutoCheckpoint(): Bool {
        autoCheckpointFrames > 0 && frameCount >= autoCheckpointFrames
    }

    func close(): Unit {
        if (let Some(f) <- file) {
            try {
                f.flush()
                f.close()
            } catch (_: Exception) {
                // 关不上不影响磁盘上已 flush 的内容; -wal 留着, 下次打开会恢复。
            }
        }
        file = None
    }

    /** 删掉 -wal 文件。切回 DELETE 模式时用, 必须已 checkpoint 干净。 */
    func removeFile(): Unit {
        close()
        meta = None
        index.clear()
        frameCount = 0
        dbSizeAtLastCommit = 0
        scannedLength = 0
        if (!path.isEmpty() && exists(path)) {
            remove(path)
        }
    }
}

func walPathFor(dbPath: String): String {
    "${dbPath}-wal"
}
