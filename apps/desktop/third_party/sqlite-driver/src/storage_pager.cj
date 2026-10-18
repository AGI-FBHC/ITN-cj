package sqlite_driver

import std.collection.*
import std.sort.*

/*
 * Pager: 把字节流切成定长页, 并负责页缓存、脏页跟踪、页分配与事务边界。
 *
 * 页号从 1 起, 第 n 页占 [(n-1)*pageSize, n*pageSize)。第 1 页前 100 字节是文件头,
 * 其后才是 sqlite_schema 的 B-tree 区 —— 这是 SQLite 格式里唯一"页内有两种内容"的
 * 地方, 本类用 header 对象持有权威值, 落盘前才写回第 1 页的前 100 字节。
 *
 * 回滚有两套机制, 各管一件事:
 *   - 内存撤销栈 (undoStack): 管本进程内的 ROLLBACK 与 ROLLBACK TO savepoint。
 *     内存库也靠它, 于是两种后端的回滚走同一条代码路径。
 *   - 磁盘日志 (Journal): 只管进程崩溃后的恢复。正常路径上它是只写的。
 * 用一套代替两套都不行: 只有日志则 savepoint 无法部分回滚 (日志是线性追加, 没有层次);
 * 只有撤销栈则进程一死内存就没了, 磁盘上留着半个事务。
 */

/** SQLite 保留的锁字节所在偏移。该偏移落在哪一页, 那一页就永不承载数据。 */
const PENDING_BYTE: Int64 = 0x40000000

/** 默认页缓存上限 (页数)。可由 `PRAGMA cache_size` 改写, 见 pragmaCacheSize。 */
const DEFAULT_CACHE_PAGES: Int64 = 2000

/**
 * cache_size 允许的最小页数。
 *
 * B-tree 分裂要同时按住父页、被分裂页、新页与相邻页; 低于这个数它们会互相淘汰, 症状不是
 * "慢"而是"读到自己刚写的页的旧版本"。SQLite 的下限同样是 10。
 */
const MIN_CACHE_PAGES: Int64 = 10

/**
 * 撤销镜像复用池保留的缓冲个数。
 *
 * 只需覆盖"一条语句同时在手的镜像数"这个量级 —— 再多留也用不上, 而每一个都占满一页。
 */
const UNDO_IMAGE_POOL_LIMIT: Int64 = 16

class Page {
    let pageNo: Int64
    let data: Array<Byte>
    var dirty: Bool = false

    init(pageNo: Int64, data: Array<Byte>) {
        this.pageNo = pageNo
        this.data = data
    }
}

/** savepoint 标记: 撤销栈的位置 + 当时的头部快照。 */
class SavepointMark {
    let name: String
    let undoLen: Int64
    let header: HeaderSnapshot
    /** 开启这个 savepoint 那一刻外层作用域已记过镜像的页; RELEASE 时归还给外层。 */
    let outerRecorded: HashSet<Int64>

    init(name: String, undoLen: Int64, header: HeaderSnapshot, outerRecorded: HashSet<Int64>) {
        this.name = name
        this.undoLen = undoLen
        this.header = header
        this.outerRecorded = outerRecorded
    }
}

class Pager {
    let backend: StorageBackend
    let header: DbHeader
    /** 是否磁盘库。内存库不写日志, 也不需要锁 —— 它没有第二个访问者。 */
    let persistent: Bool
    private let journal: Journal
    private let cache = HashMap<Int64, Page>()
    /** 缓存的插入顺序, 用于淘汰。只淘汰干净页。 */
    private let cacheOrder = ArrayList<Int64>()
    var cacheLimit: Int64 = DEFAULT_CACHE_PAGES
    var inTx: Bool = false
    /** 本事务是否改过内容 (决定 COMMIT 是否递增 change_counter)。 */
    var txDirty: Bool = false

    private let undoStack = ArrayList<UndoEntry>()
    private let savepoints = ArrayList<SavepointMark>()
    /**
     * 当前 savepoint 作用域内已记过镜像的页。
     *
     * 与 dirty 标志分开是必需的: 一页在 savepoint 1 里改过 (已脏), savepoint 2 开启后
     * 再改, ROLLBACK TO 2 必须退回 savepoint 1 时的内容 —— 所以要在新作用域里重新记一次。
     * 若复用 dirty 判断, 第二次改动不会记镜像, ROLLBACK TO 2 会把它留在改后的状态。
     */
    private var recordedInScope = HashSet<Int64>()
    /**
     * 不再被任何撤销记录持有的镜像缓冲, 留着给下一次记镜像用。
     *
     * 每条语句都是一个作用域, 而一个作用域里被改到的页都要各记一份镜像 —— 其中绝大多数在
     * 语句成功后就被 mergeUndoInto 判为冗余而丢弃。反复按页大小分配并清零会放大显式事务中
     * 逐条写入的开销，因此复用不再被撤销记录持有的缓冲。
     */
    private let imagePool = ArrayList<Array<Byte>>()
    private var txStartHeader: Option<HeaderSnapshot> = None
    /** 事务开始时的页数, 回滚时据此把文件截回去。 */
    private var txStartPageCount: Int64 = 0

    /** WAL 模式时非 None。为 None 时走 DELETE 回滚日志那条路。 */
    var wal: Option<WalFile> = None
    /**
     * 读事务钉住的帧号上限; -1 表示"看最新"。
     *
     * 事务内不看后来追加的帧 —— 这是"读不阻塞写"的全部来源, 也是 WAL 相对 DELETE 日志的
     * 收益所在。
     */
    private var snapshotMaxFrame: Int64 = -1
    /** 上次同步缓存时 WAL 里的帧数, 用来发现别的进程的提交。 */
    private var lastSeenFrameCount: Int64 = -1
    /**
     * 上次同步缓存时文件头里的 change counter; -1 表示尚未取过。
     *
     * 这是 DELETE 日志模式下发现"别的进程提交过"的唯一途径。WAL 模式靠帧数
     * (lastSeenFrameCount), 但非 WAL 模式没有 -wal 文件可数, 而主库文件的头字节 24-27
     * 正是 SQLite 为此保留的计数器: 每次提交自增一次。
     *
     * 不看它的后果不是"读到略旧的数据", 而是**永久**读不到: 页一旦进了缓存, getPage 直接命中
     * 返回, 后续任何一次读都不会再碰文件。于是两个进程共享一个租约表时, 后写的那个进程的行
     * 对先开连接的进程永不可见 —— 两个进程都会认为租约是自己的。
     */
    private var lastSeenChangeCounter: Int64 = -1
    /**
     * 显式读事务进行中: 快照一旦钉住就保持到事务结束。
     *
     * 不能用 inTx 代替 —— 那是**写**事务标志, 而 `BEGIN DEFERRED` 后到第一次写之前它是 false。
     * 只看 inTx 会让每条语句结束时解开快照，下一条语句重新钉到最新帧，导致同一个读事务
     * 两次读取同一行时看到不同版本，破坏 WAL 的快照隔离。
     */
    var readTxActive: Bool = false

    init(backend: StorageBackend, header: DbHeader, persistent: Bool, journal: Journal) {
        this.backend = backend
        this.header = header
        this.persistent = persistent
        this.journal = journal
    }

    prop walMode: Bool {
        get() {
            match (wal) {
                case Some(_) => true
                case None => false
            }
        }
    }

    /** 当前可见的帧号上限。 */
    private func effectiveMaxFrame(w: WalFile): Int64 {
        if (snapshotMaxFrame >= 0) {
            snapshotMaxFrame
        } else {
            w.frameCount
        }
    }

    prop pageSize: Int64 {
        get() {
            header.pageSize
        }
    }

    prop usableSize: Int64 {
        get() {
            header.usableSize
        }
    }

    prop pageCount: Int64 {
        get() {
            header.dbSize
        }
    }

    /** 锁字节所在页号。该页不放数据, 分配时跳过。 */
    prop lockBytePage: Int64 {
        get() {
            PENDING_BYTE / pageSize + 1
        }
    }

    prop savepointDepth: Int64 {
        get() {
            savepoints.size
        }
    }

    /** 取一页。缓存命中直接返回, 否则从后端读入。 */
    func getPage(pageNo: Int64): Page {
        if (pageNo < 1) {
            throw SqliteFormatException("page number ${pageNo} is not valid (pages start at 1)")
        }
        if (let Some(p) <- cache.get(pageNo)) {
            return p
        }
        if (pageNo > header.dbSize) {
            throw SqliteFormatException("page ${pageNo} is beyond the database size of ${header.dbSize} pages")
        }
        let buf = Array<Byte>(pageSize, repeat: 0)
        // WAL 优先: 该页若在快照内被改过, 主库文件里还是旧内容 (checkpoint 之前不动主库)。
        // 这一支插在缓存未命中与 backend.readAt 之间, 于是所有调用方都不必改。
        if (let Some(w) <- wal) {
            let frame = w.frameFor(pageNo, effectiveMaxFrame(w))
            if (frame > 0) {
                w.readFrameBody(frame, buf)
                let fromWal = Page(pageNo, buf)
                insertIntoCache(fromWal)
                return fromWal
            }
        }
        backend.readAt((pageNo - 1) * pageSize, buf)
        let page = Page(pageNo, buf)
        insertIntoCache(page)
        page
    }

    /**
     * 钉住读快照。
     *
     * 先重扫 -wal: 别的进程可能追加过帧。发现帧数变了就把干净页全部丢出缓存并重读头 ——
     * 不丢的话缓存里留着 checkpoint 之前的旧页, 而它在主库文件里看起来仍然"有效"。
     *
     * 已钉住时直接返回: 事务内的第二条语句不能把视野推到新帧上去。
     */
    func pinReadSnapshot(): Unit {
        if (snapshotMaxFrame >= 0 && (inTx || readTxActive)) {
            return
        }
        if (let Some(w) <- wal) {
            w.refreshIfGrown()
            if (w.frameCount != lastSeenFrameCount) {
                dropCleanPages()
                lastSeenFrameCount = w.frameCount
                snapshotMaxFrame = w.frameCount
                reloadHeaderFromStorage()
            }
            snapshotMaxFrame = w.frameCount
            return
        }
        syncWithForeignCommits()
    }

    /**
     * DELETE 日志模式下同步别的进程的提交。
     *
     * 只在两次读之间做, 事务内不做: 已经读过的事务必须保持它那一刻的视野, 中途换页会让
     * 同一个事务里两次读到不同版本。这与 WAL 那一支"已钉住就直接返回"是同一条约束。
     *
     * 内存库直接跳过 —— 它没有第二个访问者, 每次读都去解析一遍头纯属浪费。
     */
    private func syncWithForeignCommits(): Unit {
        if (!persistent || inTx || readTxActive) {
            return
        }
        let current = readChangeCounterFromStorage()
        if (current < 0) {
            return
        }
        if (lastSeenChangeCounter < 0) {
            // 第一次读: 只记下基线。此刻缓存里的内容与文件是一致的, 没有可失效的东西。
            lastSeenChangeCounter = current
            return
        }
        if (current != lastSeenChangeCounter) {
            // 别的进程提交过。干净页全部作废, 脏页留着 —— 那是本连接尚未提交的内容, 丢掉它
            // 等于静默回滚。头也要重读: dbSize 变小时旧的 dbSize 会让越界检查失效。
            dropCleanPages()
            reloadHeaderFromStorage()
            lastSeenChangeCounter = current
        }
    }

    /**
     * 只读文件头的 change counter, 不解析整个头。
     *
     * 每条语句都会走这里, 所以读的是 HEADER_SIZE 个字节而不是一整页 —— 4KB 页大小下这是
     * 100 字节对 4096 字节的差别。返回 -1 表示读不到(文件还没有头), 由调用方按"无变化"处理。
     */
    private func readChangeCounterFromStorage(): Int64 {
        if (backend.length() < HEADER_SIZE) {
            return -1
        }
        let buf = Array<Byte>(HEADER_SIZE, repeat: 0)
        backend.readAt(0, buf)
        readU32(buf, OFF_CHANGE_COUNTER)
    }

    /** 语句结束: 事务外才解开快照, 事务内要保持到 endReadTx。 */
    func unpinReadSnapshot(): Unit {
        if (!inTx && !readTxActive) {
            snapshotMaxFrame = -1
        }
    }

    /**
     * 显式事务开始: 之后钉住的快照要一直保持。
     *
     * 这里不立即钉 —— SQLite 的 `BEGIN DEFERRED` 也是到第一次读才取快照, 于是
     * `BEGIN; <很久之后> SELECT` 读到的是 SELECT 那一刻的库, 不是 BEGIN 那一刻的。
     */
    func beginReadTx(): Unit {
        readTxActive = true
    }

    /** 显式事务结束: 解开快照, 下一条语句重新钉到最新。 */
    func endReadTx(): Unit {
        readTxActive = false
        if (!inTx) {
            snapshotMaxFrame = -1
        }
    }

    /**
     * 读事务里已经读过, 而别人在这之后提交了 —— 此时不能升级成写事务。
     *
     * 放行会静默丢更新：本事务的写基于快照里的旧页，提交后会覆盖其他连接已经提交的内容。
     * 此时必须报告 `database is locked`，由调用方重试整个事务。
     *
     * 只在"快照已钉住且落后于当前帧"时拒绝: 没读过 (BEGIN IMMEDIATE 直接写) 的事务不受影响,
     * 它的快照就是最新的。
     */
    private func rejectWriteOnStaleSnapshot(): Unit {
        if (!readTxActive || snapshotMaxFrame < 0) {
            return
        }
        if (let Some(w) <- wal) {
            w.refreshIfGrown()
            if (w.frameCount > snapshotMaxFrame) {
                throw SqliteBusyException(
                    "database is locked: another connection committed ${w.frameCount - snapshotMaxFrame} " +
                        "frame(s) after this transaction took its read snapshot; retry the transaction")
            }
        }
    }

    /** 丢掉全部干净页。脏页不能丢 —— 它们是本事务尚未提交的内容。 */
    private func dropCleanPages(): Unit {
        let keep = ArrayList<Int64>()
        for (no in cacheOrder) {
            match (cache.get(no)) {
                case Some(p) where p.dirty => keep.add(no)
                case Some(_) => cache.remove(no)
                case None => ()
            }
        }
        cacheOrder.clear()
        for (no in keep) {
            cacheOrder.add(no)
        }
    }

    /**
     * 重新读头。
     *
     * 别的进程提交后 dbSize / freelist / schemaCookie 都可能变, 而它们只存在于页 1 里。
     * 不重读会让我们按旧的 dbSize 判"页号越界", 于是对方新分配的页读不出来。
     */
    private func reloadHeaderFromStorage(): Unit {
        let buf = Array<Byte>(pageSize, repeat: 0)
        var got = false
        if (let Some(w) <- wal) {
            let frame = w.frameFor(1, effectiveMaxFrame(w))
            if (frame > 0) {
                w.readFrameBody(frame, buf)
                got = true
            }
        }
        if (!got) {
            if (backend.length() < pageSize) {
                return
            }
            backend.readAt(0, buf)
        }
        let fresh = parseDbHeader(buf[0..HEADER_SIZE])
        copyHeaderFields(fresh, header)
    }

    /**
     * 取一页并清零, 用于刚分配出来的新页。
     *
     * 与 getPage 分开是必要的: 新页在文件里还不存在, getPage 会读到文件末尾之外而抛。
     */
    func getNewPage(pageNo: Int64): Page {
        if (let Some(p) <- cache.get(pageNo)) {
            markDirty(p)
            for (i in 0..p.data.size) {
                p.data[i] = 0
            }
            return p
        }
        let page = Page(pageNo, Array<Byte>(pageSize, repeat: 0))
        // 先标脏再进缓存, 顺序不能反: insertIntoCache 会触发淘汰, 而淘汰只挑干净页。
        // 反过来则这张刚分配的页在入缓存那一刻还是干净的, 长写事务里其余页全脏,
        // 于是它成为唯一的淘汰候选被当场摘走, markDirty 打在一个已不在缓存里的孤儿上。
        // 后果: flushDirtyPages 遍历缓存永远找不到它, 而 header.dbSize 已经加过 ——
        // 内存库读该页抛"unexpected end", 文件库被结尾的 truncate 补零后
        // **COMMIT 报成功却留下一张被父页正常引用的全零页**, 即 SQLite 判 malformed 的形态。
        markDirty(page)
        insertIntoCache(page)
        page
    }

    private func insertIntoCache(page: Page): Unit {
        cache[page.pageNo] = page
        cacheOrder.add(page.pageNo)
        evictIfNeeded(page.pageNo)
    }

    /**
     * 缓存超限时淘汰干净页。
     *
     * protect 是本次刚插入的页号, 永不淘汰它 —— 调用方拿着这个 Page 对象正要往里写,
     * 把它摘出缓存会让后续的 flush 看不到这次写入。上面的 markDirty 顺序已经让新页
     * 一进来就是脏的, 所以这条在正常路径上是冗余的; 留着是为了让将来再次引入同类
     * 顺序错误时, 后果从"静默产出损坏的库"降级为"缓存暂时超限"。
     */
    private func evictIfNeeded(protect: Int64): Unit {
        if (cache.size <= cacheLimit) {
            return
        }
        var i = 0
        while (i < cacheOrder.size && cache.size > cacheLimit) {
            let no = cacheOrder[i]
            if (no == protect) {
                i++
                continue
            }
            match (cache.get(no)) {
                case Some(p) where !p.dirty =>
                    cache.remove(no)
                    cacheOrder.remove(at: i)
                case Some(_) => i++
                case None => cacheOrder.remove(at: i)
            }
        }
    }

    /**
     * 标记页为脏, 必要时先留下原始镜像。
     *
     * 顺序至关重要: 必须在内容被改之前记镜像。所有写页的路径都要先调这里, 漏一处就会
     * 让该页在回滚后停在改后的状态，而且不会立即报错。重新打开数据库后才能发现数据未恢复。
     */
    func markDirty(page: Page): Unit {
        if (inTx && !recordedInScope.contains(page.pageNo)) {
            let image = takeImage(page.data)
            undoStack.add(UndoEntry(page.pageNo, image))
            recordedInScope.add(page.pageNo)
            // WAL 模式没有回滚日志: 主库文件在 checkpoint 之前根本不动, 崩溃后"未提交的
            // 帧"靠校验和链自然被丢弃, 不需要另存一份原始镜像。
            if (persistent && !walMode) {
                journal.recordPage(page.pageNo, page.data, txStartPageCount)
            }
        }
        page.dirty = true
        txDirty = true
    }

    /** 一份 source 的副本, 优先用池里的缓冲。页大小对不上的缓冲直接弃用。 */
    private func takeImage(source: Array<Byte>): Array<Byte> {
        if (imagePool.size > 0) {
            let reused = imagePool[imagePool.size - 1]
            imagePool.remove(at: imagePool.size - 1)
            if (reused.size == source.size) {
                source.copyTo(reused, 0, 0, source.size)
                return reused
            }
        }
        let fresh = Array<Byte>(source.size, repeat: 0)
        source.copyTo(fresh, 0, 0, source.size)
        fresh
    }

    /**
     * 归还一块镜像缓冲。
     *
     * 只有在对应的撤销记录已被丢弃时才可以调 —— 缓冲随后会被覆写, 而记录若还留在栈上,
     * 回滚就会把别的页的内容写进这一页。
     */
    private func recycleImage(image: Array<Byte>): Unit {
        if (imagePool.size < UNDO_IMAGE_POOL_LIMIT) {
            imagePool.add(image)
        }
    }

    /** 开写事务。 */
    func beginWrite(): Unit {
        if (inTx) {
            throw SqliteRuntimeException("state", "pager already in a write transaction")
        }
        rejectWriteOnStaleSnapshot()
        // 写者要看到别人已提交的全部内容 —— 先重扫 -wal 再钉快照, 否则会基于旧页写新帧。
        pinReadSnapshot()
        txStartPageCount = header.dbSize
        txStartHeader = Some(HeaderSnapshot(header))
        txDirty = false
        undoStack.clear()
        savepoints.clear()
        recordedInScope = HashSet<Int64>()
        if (persistent && !walMode) {
            journal.open(header.dbSize, pageSize)
        }
        inTx = true
    }

    /**
     * 提交: 脏页刷到后端, 再删日志。
     *
     * 删日志必须在页数据落盘**之后** —— 反过来则中途崩溃时既没日志可恢复, 数据页又只
     * 写了一半, 库直接损坏。
     */
    func commit(syncFull: Bool): Unit {
        if (!inTx) {
            throw SqliteRuntimeException("state", "no write transaction to commit")
        }
        if (txDirty) {
            header.changeCounter += 1
            header.versionValidFor = header.changeCounter
            // 头必须显式落盘, 不能等页 1 恰好因别的原因变脏。dbSize / freelist / schemaCookie
            // 由各写路径改在 header 对象上, 而只有写出页 1 才会把它们带到磁盘上。
            forceHeaderPageFlush()
        }
        if (let Some(w) <- wal) {
            commitToWal(w, syncFull)
            return
        }
        flushDirtyPages()
        backend.flush()
        if (syncFull) {
            let _ = systemSync()
        }
        if (persistent) {
            journal.deleteJournal()
        }
        // 本连接自己的提交也要记进基线, 否则下一条语句会把自己刚写的 counter 当成"别人改过",
        // 白丢一次整个干净页缓存。功能上无害而性能上每写一次就清一次缓存。
        lastSeenChangeCounter = header.changeCounter
        endTx()
    }

    /**
     * WAL 模式的提交: 脏页作为帧追加到 -wal, 主库文件一个字节都不动。
     *
     * 最后一帧标提交并填库页数。中途崩溃时最后一帧不完整, 校验和链在那里断开, 恢复路径
     * 正好把这一整批帧丢掉 —— 于是"提交要么整批可见, 要么整批不可见"。
     */
    private func commitToWal(w: WalFile, syncFull: Bool): Unit {
        w.ensureHeader()
        let nos = ArrayList<Int64>()
        for ((no, p) in cache) {
            if (p.dirty && no <= header.dbSize) {
                nos.add(no)
            }
        }
        sort(nos)
        let pages = ArrayList<Page>()
        for (no in nos) {
            let page = cache[no]
            if (no == 1) {
                writeDbHeader(page.data, header)
            }
            pages.add(page)
        }
        w.appendCommit(pages, header.dbSize)
        for (page in pages) {
            page.dirty = false
        }
        if (syncFull) {
            let _ = systemSync()
        }
        lastSeenFrameCount = w.frameCount
        endTx()
        // 自动 checkpoint 排在事务收尾之后: 它要写主库文件, 而那必须在提交完成之后发生。
        if (w.shouldAutoCheckpoint()) {
            let _ = checkpoint(WalCheckpointMode.CheckpointPassive)
        }
    }

    /**
     * 回填 WAL 到主库。
     *
     * 只在没有活动写事务时可以做: 事务中间回填会把尚未提交的页写进主库。
     */
    func checkpoint(mode: WalCheckpointMode): WalCheckpointResult {
        let w = match (wal) {
            case Some(x) => x
            case None => return WalCheckpointResult(0, 0, 0)
        }
        if (inTx) {
            throw SqliteRuntimeException("state", "cannot checkpoint while a write transaction is active")
        }
        let result = w.checkpointInto(backend, mode)
        lastSeenFrameCount = w.frameCount
        snapshotMaxFrame = -1
        result
    }

    /** 回滚整个事务: 撤销栈全部回放, 文件截回起始页数。 */
    func rollback(): Unit {
        if (!inTx) {
            throw SqliteRuntimeException("state", "no write transaction to roll back")
        }
        unwindUndoTo(0)
        if (let Some(snap) <- txStartHeader) {
            snap.restoreInto(header)
        }
        if (walMode) {
            // 主库与 -wal 都没被这个事务碰过 (帧只在提交时追加), 所以无处可回滚 ——
            // 只要把撤销栈恢复后的页标回干净, 并丢掉本事务新分配的页。
            discardPagesAfter(txStartPageCount)
            endTx()
            return
        }
        if (persistent) {
            // 脏页已被撤销栈恢复成原始内容, 直接刷回去即可, 不必读日志文件。
            flushDirtyPages()
            backend.truncate(txStartPageCount * pageSize)
            backend.flush()
            journal.deleteJournal()
        } else {
            backend.truncate(txStartPageCount * pageSize)
        }
        endTx()
    }

    /**
     * 回滚后清理缓存: 页号大于 keepUpTo 的整页丢掉, 其余标回干净。
     *
     * 只 WAL 模式用。DELETE 模式靠"把恢复后的内容写回主库"收尾, 而 WAL 模式下主库从未被
     * 这个事务改过, 写回反而会把内容推进主库、绕过 WAL。
     */
    private func discardPagesAfter(keepUpTo: Int64): Unit {
        let survivors = ArrayList<Int64>()
        for (no in cacheOrder) {
            match (cache.get(no)) {
                case None => ()
                case Some(p) =>
                    if (no > keepUpTo) {
                        cache.remove(no)
                    } else {
                        p.dirty = false
                        survivors.add(no)
                    }
            }
        }
        cacheOrder.clear()
        for (no in survivors) {
            cacheOrder.add(no)
        }
    }

    private func endTx(): Unit {
        inTx = false
        undoStack.clear()
        savepoints.clear()
        recordedInScope = HashSet<Int64>()
        txStartHeader = None
        txDirty = false
        // 快照必须跟着写事务一起解开。留着它会让下一次取快照被"已钉住"那一支跳过, 于是
        // 视野停在本次提交**之前** —— 表现是刚写的行读不到, 或 rejectWriteOnStaleSnapshot
        // 把自己上一次的提交当成别人的而拦住下一个事务。
        if (!readTxActive) {
            snapshotMaxFrame = -1
        }
    }

    /** 开一个 savepoint。同名 savepoint 可叠加, ROLLBACK TO 命中最靠内的那个。 */
    func openSavepoint(name: String): Unit {
        savepoints.add(SavepointMark(name, undoStack.size, HeaderSnapshot(header), recordedInScope))
        // 新作用域: 已改过的页在这里第一次再被改时要重新记镜像。
        recordedInScope = HashSet<Int64>()
    }

    private func findSavepoint(name: String): Int64 {
        var i = savepoints.size - 1
        while (i >= 0) {
            if (savepoints[i].name == name) {
                return i
            }
            i--
        }
        -1
    }

    /**
     * RELEASE: 丢掉该 savepoint 及其内层, 但**保留**它们做过的改动。
     *
     * 被丢掉的那些作用域记下的镜像随之并回外层, 冗余的一份就地丢弃 —— 见 mergeUndoInto。
     */
    func releaseSavepoint(name: String): Unit {
        let idx = findSavepoint(name)
        if (idx < 0) {
            throw SqliteRuntimeException("savepoint", "no such savepoint: ${name}")
        }
        let outer = savepoints[idx].outerRecorded
        mergeUndoInto(savepoints[idx].undoLen, outer)
        while (savepoints.size > idx) {
            savepoints.remove(at: savepoints.size - 1)
        }
        recordedInScope = outer
    }

    /**
     * 把 from 之后的撤销记录并进外层作用域的已记页集合, 并丢掉其中冗余的记录。
     *
     * 冗余的判据是"外层已经有这一页的镜像": 那一份在 from 之前, 记的是更早的内容, 外层
     * 以及更外层的回滚要的正是它, 内层这一份永远不会被用到。
     *
     * 没有这一步, 每开一个作用域就会给同一页再压一份镜像 —— 一条 SQL 语句一个作用域时,
     * 撤销栈会随事务里的语句条数线性膨胀, 长事务的内存与拷贝开销都跟着涨。
     *
     * 同一页在被丢掉的多个内层作用域里各记过一份时, 保留**最靠前**的那一份: 它记的内容
     * 最早, 是外层回滚要还原的目标。
     */
    private func mergeUndoInto(from: Int64, recorded: HashSet<Int64>): Unit {
        var keep = from
        var i = from
        while (i < undoStack.size) {
            let entry = undoStack[i]
            if (!recorded.contains(entry.pageNo)) {
                recorded.add(entry.pageNo)
                undoStack[keep] = entry
                keep += 1
            } else {
                recycleImage(entry.image)
            }
            i += 1
        }
        while (undoStack.size > keep) {
            undoStack.remove(at: undoStack.size - 1)
        }
    }

    /**
     * ROLLBACK TO: 撤销该 savepoint 之后的改动, 但**保留 savepoint 本身**。
     *
     * 保留 savepoint 是 SQL 标准语义，使同一 savepoint 可以多次执行 `ROLLBACK TO`。
     */
    func rollbackToSavepoint(name: String): Unit {
        let idx = findSavepoint(name)
        if (idx < 0) {
            throw SqliteRuntimeException("savepoint", "no such savepoint: ${name}")
        }
        let mark = savepoints[idx]
        unwindUndoTo(mark.undoLen)
        mark.header.restoreInto(header)
        // 内层 savepoint 随之失效, 但 idx 这个保留。
        while (savepoints.size > idx + 1) {
            savepoints.remove(at: savepoints.size - 1)
        }
        // 清空而不是接回外层那一份: idx 仍在栈上, 之后的改动要能再一次退回到这里, 所以
        // 每一页都得在这个作用域里重新记镜像。
        recordedInScope = HashSet<Int64>()
    }

    /** 从栈顶回放撤销记录直到长度降到 target。 */
    private func unwindUndoTo(target: Int64): Unit {
        while (undoStack.size > target) {
            let entry = undoStack[undoStack.size - 1]
            undoStack.remove(at: undoStack.size - 1)
            match (cache.get(entry.pageNo)) {
                case Some(p) =>
                    entry.image.copyTo(p.data, 0, 0, entry.image.size)
                    recycleImage(entry.image)
                    // 仍标脏: 磁盘上是改后的内容, 必须把恢复后的内容写回去。
                    p.dirty = true
                case None =>
                    // 只有干净页会被淘汰，而带撤销镜像的页一定是脏页。找不到该页表示缓存状态
                    // 已不一致，必须报告错误，不能静默跳过恢复。
                    throw SqliteRuntimeException("state",
                    "page ${entry.pageNo} vanished from the cache while it had an undo image")
            }
        }
    }

    /**
     * 让页 1 进脏页集合, 使权威头能随本次刷盘一起落地。
     *
     * 不走 markDirty: 那会压一条 undo 镜像并记进日志, 而本函数只在提交路径上调用 ——
     * 此刻已不会再回滚, 镜像纯属浪费, 且它会让 recordedInScope 多一个永不使用的条目。
     *
     * 只置 dirty 标志而不自己写盘: 头的写入统一由 flushDirtyPages 里 `no == 1` 那一支完成,
     * 于是"什么时候把 header 对象序列化进页 1"只有一处答案。
     */
    private func forceHeaderPageFlush(): Unit {
        if (header.dbSize < 1) {
            // 空库没有页 1 可写。initializeNewDatabase 会先把 dbSize 置成 1。
            return
        }
        getPage(1).dirty = true
    }

    /**
     * 脏页刷到后端。页 1 排在**最后**, 且写它之前先 flush 一次。
     *
     * 这个顺序不是为了磁盘友好, 而是跨进程可见性: change counter 在页 1, 而别的进程正是靠
     * 它判"要不要丢弃干净页缓存" (见 syncWithForeignCommits)。页 1 若先写, 对方会在数据页
     * 还是旧内容时就看到新 counter, 于是把旧页当成"刚同步过的最新内容"缓存下来, 并把基线
     * 更新成新 counter —— 此后再也不触发失效, 症状与从未做跨进程失效时逐字一致 (永久读到
     * 旧数据), 只是窗口窄到微秒级。
     *
     * 文件的扩展也排在屏障之前: counter 可见的那一刻, 页内容与文件长度都得已经就位。
     *
     * 崩溃一致性不受影响, 反而更好 —— DELETE 模式的恢复靠日志, 而日志里也存着页 1 的原始
     * 镜像; counter 后落盘意味着"数据没下去就不宣告新版本", 与"日志在数据页之后才删"同理。
     *
     * 其余页仍按页号升序写: 顺序写对磁盘友好, 也让崩溃后的文件形态可预测。
     */
    private func flushDirtyPages(): Unit {
        let nos = ArrayList<Int64>()
        for ((no, p) in cache) {
            if (p.dirty) {
                nos.add(no)
            }
        }
        sort(nos)
        var headerDirty = false
        for (no in nos) {
            if (no > header.dbSize) {
                // 事务里分配又在回滚中被丢弃的页, 不写。
                continue
            }
            if (no == 1) {
                headerDirty = true
                continue
            }
            let page = cache[no]
            backend.writeAt((no - 1) * pageSize, page.data)
            page.dirty = false
        }
        let want = header.dbSize * pageSize
        if (backend.length() < want) {
            backend.truncate(want)
        }
        if (!headerDirty) {
            return
        }
        // 屏障: 数据页与文件长度先对别的进程可见, 页 1 的 counter 才能露出去。
        backend.flush()
        let first = cache[1]
        writeDbHeader(first.data, header)
        backend.writeAt(0, first.data)
        first.dirty = false
    }

    /**
     * 分配一页: 优先从 freelist 摘, 没有就在文件尾追加。
     *
     * 跳过锁字节页 —— 那一页在 SQLite 里被建议性文件锁占用, 放数据会让对方读到垃圾。
     */
    func allocatePage(): Page {
        if (let Some(no) <- freelistTake(this)) {
            return getNewPage(no)
        }
        var next = header.dbSize + 1
        if (next == lockBytePage) {
            header.dbSize = next
            let filler = getNewPage(next)
            markDirty(filler)
            next += 1
        }
        header.dbSize = next
        txDirty = true
        getNewPage(next)
    }

    /** 归还一页到 freelist。 */
    func freePage(pageNo: Int64): Unit {
        freelistAdd(this, pageNo)
        txDirty = true
    }

    /** 关闭: 有未提交事务时回滚, 避免把半个事务留在磁盘上。 */
    func close(): Unit {
        if (inTx) {
            try {
                rollback()
            } catch (_: Exception) {
                // 关闭路径上的回滚失败无处上报, 但日志文件会留在磁盘上, 下次打开时的
                // 热日志恢复会完成同一件事。
            }
        }
        // -wal 刻意不删也不 checkpoint: SQLite 关最后一个连接时会 checkpoint, 但那要求
        // 知道自己是最后一个 —— 我们没有 -shm 里的连接计数, 猜错会在别的进程读到一半时
        // 改写主库。留着 -wal 是安全的: 下次打开会恢复它。
        if (let Some(w) <- wal) {
            w.close()
        }
        backend.close()
    }

    /**
     * 该页的最新内容是否在 WAL 里 (而不是主库文件里)。
     *
     * integrity_check 要用它区分两件在磁盘上长得一样的事: 主库文件比头声明的短, 究竟是
     * "页还在 WAL 里没回填" (正常) 还是"页真的丢了" (损坏)。
     */
    func pageIsBackedByWal(pageNo: Int64): Bool {
        match (wal) {
            case Some(w) => w.holdsPage(pageNo, effectiveMaxFrame(w))
            case None => false
        }
    }

    /**
     * 把文件截到 dbSize 页。
     *
     * 只 VACUUM 用: 平时文件只增不减, flushDirtyPages 的截断也只补长不缩短。必须在提交
     * 之后调 —— 提交前截断会把尚未落盘的脏页扔掉。
     */
    func truncateToDbSize(): Unit {
        let want = header.dbSize * pageSize
        if (backend.length() > want) {
            backend.truncate(want)
            backend.flush()
        }
    }

    /** 把当前头写回第 1 页并刷盘。无事务的元数据更新与日志模式切换用它。 */
    func syncHeaderToDisk(): Unit {
        let page = getPage(1)
        writeDbHeader(page.data, header)
        backend.writeAt(0, page.data)
        backend.flush()
    }

    /**
     * 摘掉 WAL。切回回滚日志模式时用, 调用方必须已 checkpoint 干净。
     *
     * 顺带把快照上限清掉: 留着它会让摘掉之后的读仍按一个不存在的帧号去判定可见性。
     */
    func detachWal(): Unit {
        if (let Some(w) <- wal) {
            w.removeFile()
        }
        wal = None
        snapshotMaxFrame = -1
        lastSeenFrameCount = -1
    }
}
