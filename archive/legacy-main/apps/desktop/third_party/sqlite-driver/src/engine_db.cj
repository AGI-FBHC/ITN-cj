package sqlite_driver

import std.collection.*
import std.fs.*

/*
 * SqliteDatabase: 引擎的中心对象。持有 Pager、模式缓存与事务状态。
 *
 * 它与 sqlite_conn.cj 的 SqliteConn 分开: 后者是对外 API (含参数绑定、结果集封装、
 * 异常包装），前者只负责引擎语义。分开后，引擎调用方不必构造对外的 DSN 与参数数组。
 */

/**
 * 一条语句的子事务作用域。
 *
 * SQLite 的每条语句都是一个隐含的子事务: 语句执行到一半失败时, 它自己已经做出的改动
 * 整体撤销, 而外层事务继续存在。这个对象记着撤销所需的两处位置。
 */
class StatementScope {
    /** 对应的 pager savepoint 名。 */
    let name: String
    /** 开启时已登记的延迟外键检查条数; 撤销时把这之后登记的截掉。 */
    let deferredFkMark: Int64

    init(name: String, deferredFkMark: Int64) {
        this.name = name
        this.deferredFkMark = deferredFkMark
    }
}

/**
 * 语句作用域名的前缀, 带一个控制字符。
 *
 * SQL 标识符里不会出现控制字符，因此内部作用域不会与用户创建的 `SAVEPOINT` 重名，
 * `RELEASE` 和 `ROLLBACK TO` 也不会命中错误的作用域。
 */
const STATEMENT_SCOPE_PREFIX: String = "\u{1}stmt:"

/** 提交时的落盘强度。 */
public enum SqliteSyncMode {
    /** 只 flush 到 OS page cache。进程崩溃不丢, 掉电可能丢。默认。 */
    | SyncNormal
    /** 额外调系统 sync(1)。同步整个系统, 很慢, 但掉电保护更强。 */
    | SyncFull
}

class SqliteDatabase {
    let path: String
    let pager: Pager
    let syncMode: SqliteSyncMode
    private let lock: Option<LockFile>
    var busyTimeoutMs: Int64
    private var schema: SchemaCache
    /** 显式事务 (BEGIN 开的) 还是隐式 (单语句自动包裹)。 */
    var inExplicitTx: Bool = false
    /** BEGIN DEFERRED 后尚未真正开写事务时为真。 */
    private var deferredTx: Bool = false
    var foreignKeysEnabled: Bool = false
    /**
     * 尚未校验的延迟外键约束 (DEFERRABLE INITIALLY DEFERRED)。
     *
     * 事务中间态允许违约, 所以这些检查攒到 COMMIT 前才跑。回滚时整批丢弃 —— 那些写入
     * 已经不存在了, 再校验会对着已回滚的键值报错。
     */
    let deferredFkChecks = ArrayList<DeferredFkCheck>()
    var lastInsertRowid: Int64 = 0
    var totalChanges: Int64 = 0
    var lastChanges: Int64 = 0
    /**
     * `PRAGMA recursive_triggers`; 默认关 (与 SQLite 一致)。
     *
     * 关闭时同一个触发器不重入。第一层触发正常执行，由触发器自身写入引起的再次触发会被阻止。
     */
    var recursiveTriggers: Bool = false
    /** 当前正在执行的触发器名 (小写), 用于递归关闭时的重入判定。 */
    let activeTriggers = HashSet<String>()
    /** 触发器嵌套深度, 上限 TRIGGER_MAX_DEPTH。 */
    var triggerDepth: Int64 = 0
    /**
     * 当前触发器的 OLD / NEW 行; 不在触发器里时为 None。
     *
     * 挂在这里而不是只挂在某个 EvalContext 上, 与语句级 CTE 同一个理由: body 里的语句走正常的
     * executeStatement 路径并各自新建上下文, 而 OLD / NEW 必须在那些上下文里也可见。
     */
    var triggerRow: Option<TriggerRowContext> = None

    /**
     * 当前语句的 WITH 子句声明的 CTE, 键是小写名。
     *
     * 挂在这里而不是只挂在某一个 EvalContext 上: DML 的执行器各自新建上下文 (INSERT 的
     * 默认值求值、UPDATE 的 SET 求值、DELETE 的 WHERE 求值…共 8 处), 而语句级 WITH 对它们
     * 全都可见。经这一份共享还顺带保证"只物化一次" —— 同一个 CTE 在一条语句里被引用多次时,
     * 各自重跑会让带 random() 的 body 给出不同的行。
     *
     * 由 executeStatement 在语句开始处填、结束处清。
     */
    let statementCtes = HashMap<String, MaterializedCte>()
    /** 仅在预编译语句执行期间存在；触发器内层语句沿用同一控制器。 */
    var statementControl: Option<StatementControl> = None

    /**
     * `PRAGMA journal_size_limit` 的值; 负数表示不限。
     *
     * 这是连接级属性，不写入文件头，也不跨连接持久化。内存库和 DELETE 模式同样允许设置并
     * 回读该值，因此不能只把它保存在 WalFile 中。
     */
    var journalSizeLimit: Int64 = -1
    /** sqlite_sequence 的根页, 0 表示还没建。AUTOINCREMENT 用它记最大值。 */
    private var sequenceRoot: Int64 = 0
    /** 语句作用域名的序号, 见 openStatementScope。 */
    private var statementScopeSeq: Int64 = 0

    init(path: String, pager: Pager, syncMode: SqliteSyncMode, lock: Option<LockFile>, busyTimeoutMs: Int64) {
        this.path = path
        this.pager = pager
        this.syncMode = syncMode
        this.lock = lock
        this.busyTimeoutMs = busyTimeoutMs
        this.schema = SchemaCache()
    }

    /** 打开后的第一次模式加载。 */
    func loadSchemaNow(): Unit {
        schema = loadSchema(pager)
        sequenceRoot = findSequenceRoot()
    }

    /**
     * 取模式, 必要时重载。
     *
     * 判据是 schema_cookie: 另一个进程改过模式后 cookie 会变, 我们缓存的列信息就过期了。
     * 不检查的话, 对方 ALTER TABLE ADD COLUMN 之后我们仍按旧列数解 record, 多出的列
     * 被静默丢掉。
     */
    func currentSchema(): SchemaCache {
        if (schema.cookie != pager.header.schemaCookie) {
            schema = loadSchema(pager)
            sequenceRoot = findSequenceRoot()
        }
        schema
    }

    func invalidateSchema(): Unit {
        schema.cookie = -1
    }

    private func findSequenceRoot(): Int64 {
        for (row in readSchemaRows(pager)) {
            if (row.objType == "table" && row.name.toAsciiLower() == "sqlite_sequence") {
                return row.rootPage
            }
        }
        0
    }

    prop hasSequenceTable: Bool {
        get() {
            sequenceRoot != 0
        }
    }

    prop sequenceRootPage: Int64 {
        get() {
            sequenceRoot
        }
    }

    func setSequenceRootPage(no: Int64): Unit {
        sequenceRoot = no
    }

    /*
     * 事务。
     */

    /** 显式 BEGIN。DEFERRED 推迟到第一次写才真正开事务与取锁。 */
    func begin(mode: String): Unit {
        if (inExplicitTx) {
            throw SqliteRuntimeException("state", "cannot start a transaction within a transaction")
        }
        inExplicitTx = true
        // 读快照要跨语句保持到本事务结束 —— 这一步对 DEFERRED 同样必需, 那时还没有写事务。
        pager.beginReadTx()
        if (mode == "DEFERRED") {
            deferredTx = true
            return
        }
        deferredTx = false
        acquireWrite()
    }

    /**
     * 确保处于可写状态。隐式事务 (无 BEGIN 的单语句) 也走这里。
     *
     * 返回值表示"本次是否由我开启了隐式事务", 调用方据此决定语句结束后是否自动提交。
     */
    func ensureWritable(): Bool {
        if (pager.inTx) {
            return false
        }
        acquireWrite()
        if (inExplicitTx) {
            // 显式 DEFERRED 事务的首次写: 事务归 BEGIN 管, 不自动提交。
            deferredTx = false
            return false
        }
        true
    }

    private func acquireWrite(): Unit {
        if (let Some(l) <- lock) {
            l.acquire(busyTimeoutMs)
        }
        try {
            pager.beginWrite()
        } catch (e: Exception) {
            releaseLock()
            throw e
        }
    }

    private func releaseLock(): Unit {
        if (let Some(l) <- lock) {
            l.release()
        }
    }

    func commit(): Unit {
        if (!inExplicitTx && !pager.inTx) {
            throw SqliteRuntimeException("state", "cannot commit - no transaction is active")
        }
        // 延迟外键在这里校验, 且必须在 pager.commit 之前: 违约要让整个 COMMIT 失败,
        // 页已经落盘再报错就只剩一个"提交成功但数据违约"的库。
        verifyDeferredForeignKeys(this)
        if (pager.inTx) {
            let full = match (syncMode) {
                case SyncFull => true
                case SyncNormal => false
            }
            pager.commit(full)
        }
        inExplicitTx = false
        deferredTx = false
        pager.endReadTx()
        releaseLock()
    }

    func rollback(): Unit {
        if (!inExplicitTx && !pager.inTx) {
            throw SqliteRuntimeException("state", "cannot rollback - no transaction is active")
        }
        if (pager.inTx) {
            pager.rollback()
        }
        inExplicitTx = false
        deferredTx = false
        deferredFkChecks.clear()
        invalidateSchema()
        pager.endReadTx()
        releaseLock()
    }

    /** 隐式事务的收尾: 成功则提交。 */
    func commitImplicit(): Unit {
        verifyDeferredForeignKeys(this)
        if (pager.inTx) {
            let full = match (syncMode) {
                case SyncFull => true
                case SyncNormal => false
            }
            pager.commit(full)
        }
        releaseLock()
    }

    /** 隐式事务出错时的收尾: 回滚, 但不把异常吞掉。 */
    func rollbackImplicit(): Unit {
        deferredFkChecks.clear()
        if (pager.inTx) {
            try {
                pager.rollback()
            } catch (_: Exception) {
                // 回滚本身失败时原异常更重要; 日志文件会留下, 下次打开自动恢复。
            }
        }
        invalidateSchema()
        releaseLock()
    }

    /**
     * 开一条语句的子事务作用域。
     *
     * 序号保证嵌套时每层的名字互不相同: 触发器体与 INSTEAD OF 视图写入会重入语句执行路径,
     * 于是作用域会一层套一层。
     */
    func openStatementScope(): StatementScope {
        statementScopeSeq += 1
        let scope = StatementScope("${STATEMENT_SCOPE_PREFIX}${statementScopeSeq}", deferredFkChecks.size)
        pager.openSavepoint(scope.name)
        scope
    }

    /** 语句成功: 丢掉作用域, 保留它做过的改动。 */
    func releaseStatementScope(scope: StatementScope): Unit {
        pager.releaseSavepoint(scope.name)
    }

    /**
     * 语句失败: 撤销它做过的一切, 外层事务保持活动。
     *
     * 三件事缺一不可 —— 页内容退回语句开始处; 这条语句登记的延迟外键检查一并丢掉 (登记它们
     * 的写入已经不存在, 留到 COMMIT 会对着撤销掉的键值报错); 撤销可能抹掉 DDL 改过的页,
     * 所以模式缓存也要失效。
     *
     * 撤销之后再释放: 作用域自身不能留在栈上, 否则每条失败的语句都会给用户的 savepoint 栈
     * 垫一层。
     */
    func rollbackStatementScope(scope: StatementScope): Unit {
        pager.rollbackToSavepoint(scope.name)
        pager.releaseSavepoint(scope.name)
        while (deferredFkChecks.size > scope.deferredFkMark) {
            deferredFkChecks.remove(at: deferredFkChecks.size - 1)
        }
        invalidateSchema()
    }

    func savepoint(name: String): Unit {
        // savepoint 需要一个活动事务。没有时开一个隐式的, 并把它记成显式 ——
        // 否则语句结束时会被自动提交, savepoint 随之失效。
        if (!pager.inTx) {
            acquireWrite()
            inExplicitTx = true
            pager.beginReadTx()
        }
        pager.openSavepoint(name)
    }

    func releaseSavepoint(name: String): Unit {
        pager.releaseSavepoint(name)
    }

    func rollbackToSavepoint(name: String): Unit {
        pager.rollbackToSavepoint(name)
        invalidateSchema()
    }

    prop inTransaction: Bool {
        get() {
            inExplicitTx || pager.inTx
        }
    }

    func close(): Unit {
        pager.close()
        releaseLock()
    }

    /*
     * 日志模式。
     */

    /** 当前模式名, 与 PRAGMA journal_mode 返回的一致。 */
    func currentJournalModeName(): String {
        if (!pager.persistent) {
            return "memory"
        }
        if (pager.walMode) {
            return "wal"
        }
        "delete"
    }

    /**
     * 切到 WAL。
     *
     * 头里的 write/read version 改成 2 并**直接写进主库文件** —— 此刻 WAL 还没挂上, 走
     * 普通提交路径会把这次改动写进一个还不存在的 WAL。顺序反了会让库处在"头说 WAL、
     * 没有 -wal 文件"的状态, SQLite 打开它会自己建一个空 WAL 并认为库是空的。
     */
    func switchToWalMode(): Unit {
        if (pager.walMode) {
            return
        }
        requireNoTransactionForModeSwitch("wal")
        pager.header.writeVersion = JOURNAL_VERSION_WAL
        pager.header.readVersion = JOURNAL_VERSION_WAL
        pager.syncHeaderToDisk()
        attachWal(pager, path)
        // 连接上已设的 journal_size_limit 要带给新挂的 WAL —— 先 PRAGMA 再切模式的顺序
        // 很常见, 不带过去会让那次设置静默失效。
        if (let Some(w) <- pager.wal) {
            w.journalSizeLimit = journalSizeLimit
        }
    }

    /**
     * 切回回滚日志模式。
     *
     * 必须先把 WAL 回填干净: 残留的帧在切换后无人再读 (头里的 version 变回 1 之后, 连
     * 我们自己都不会去看 -wal), 那些提交就静默消失了。
     */
    func switchToRollbackJournalMode(): Unit {
        if (!pager.walMode) {
            return
        }
        requireNoTransactionForModeSwitch("delete")
        let _ = pager.checkpoint(WalCheckpointMode.CheckpointTruncate)
        pager.detachWal()
        pager.header.writeVersion = JOURNAL_VERSION_LEGACY
        pager.header.readVersion = JOURNAL_VERSION_LEGACY
        pager.syncHeaderToDisk()
    }

    private func requireNoTransactionForModeSwitch(target: String): Unit {
        if (inExplicitTx || pager.inTx) {
            throw SqliteRuntimeException("state", "cannot switch journal_mode to ${target} inside a transaction")
        }
    }

    func checkpoint(mode: WalCheckpointMode): WalCheckpointResult {
        if (!pager.walMode) {
            // 非 WAL 模式下 checkpoint 无事可做。返回全零而不是报错 —— 与 SQLite 一致,
            // 上层的定期 checkpoint 任务不该因为模式而失败。
            return WalCheckpointResult(0, 0, 0)
        }
        if (inExplicitTx) {
            throw SqliteRuntimeException("state", "cannot checkpoint inside a transaction")
        }
        pager.checkpoint(mode)
    }

    func setWalAutocheckpoint(frames: Int64): Unit {
        if (let Some(w) <- pager.wal) {
            w.autoCheckpointFrames = frames
        }
    }

    func walAutocheckpoint(): Int64 {
        match (pager.wal) {
            case Some(w) => w.autoCheckpointFrames
            case None => 0
        }
    }

    /** 设 journal_size_limit, 并同步给已挂上的 WAL。 */
    func setJournalSizeLimit(bytes: Int64): Unit {
        journalSizeLimit = bytes
        if (let Some(w) <- pager.wal) {
            w.journalSizeLimit = bytes
        }
    }

    /** 模式变更后递增 schema_cookie, 让别的连接知道要重载。 */
    func bumpSchemaCookie(): Unit {
        let page = pager.getPage(1)
        pager.markDirty(page)
        pager.header.schemaCookie += 1
        invalidateSchema()
    }
}

/**
 * 打开一个数据库。
 *
 * 磁盘库的打开顺序有讲究: 先取锁, 再看热日志, 最后读头。反过来 (先读头) 会在另一个
 * 进程正在恢复日志时读到中间状态。
 */
func openDatabase(path: String, pageSize: Int64, syncMode: SqliteSyncMode, busyTimeoutMs: Int64): SqliteDatabase {
    if (path == ":memory:" || path.isEmpty()) {
        return openMemoryDatabase(pageSize, syncMode)
    }
    let lock = LockFile(path)
    // 打开期的排他: 热日志恢复必须独占, 否则两个进程同时回放同一份日志。
    lock.acquire(busyTimeoutMs)
    var db: Option<SqliteDatabase> = None
    try {
        db = Some(openFileDatabase(path, pageSize, syncMode, lock, busyTimeoutMs))
    } finally {
        lock.release()
    }
    db.getOrThrow()
}

private func openFileDatabase(path: String, pageSize: Int64, syncMode: SqliteSyncMode, lock: LockFile,
    busyTimeoutMs: Int64): SqliteDatabase {
    let isNew = !exists(path) || fileByteLength(path) == 0
    if (isNew) {
        let file = File(path, OpenMode.ReadWrite)
        let backend = FileBackend(file)
        let header = newDbHeader(pageSize)
        let journal = Journal(journalPathFor(path))
        let pager = Pager(backend, header, true, journal)
        let db = SqliteDatabase(path, pager, syncMode, Some(lock), busyTimeoutMs)
        initializeNewDatabase(pager)
        db.loadSchemaNow()
        return db
    }
    let file = File(path, OpenMode.ReadWrite)
    let backend = FileBackend(file)
    // 先按头里的页大小读日志 —— 日志头也记着页大小, 两者不符说明日志不属于这个库。
    let headBuf = Array<Byte>(HEADER_SIZE, repeat: 0)
    backend.readAt(0, headBuf)
    var header = parseDbHeader(headBuf)
    let replay = recoverHotJournal(path, backend, header.pageSize)
    if (let Some(_) <- replay) {
        // 回放改过第 1 页, 头要重读。
        backend.readAt(0, headBuf)
        header = parseDbHeader(headBuf)
    }
    let actualPages = backend.length() / header.pageSize
    if (header.dbSize == 0 || header.dbSize > actualPages) {
        // 头里的页数不可信 (旧版 SQLite 或崩溃残留) 时按文件长度算, 与 SQLite 的做法一致。
        header.dbSize = actualPages
    }
    let journal = Journal(journalPathFor(path))
    let pager = Pager(backend, header, true, journal)
    if (header.writeVersion == JOURNAL_VERSION_WAL || header.readVersion == JOURNAL_VERSION_WAL) {
        attachWal(pager, path)
    }
    let db = SqliteDatabase(path, pager, syncMode, Some(lock), busyTimeoutMs)
    db.loadSchemaNow()
    db
}

/**
 * 挂上 WAL 并恢复它。
 *
 * 恢复后要把库页数改成"最后一个提交帧记的那个": 主库文件在 checkpoint 之前是旧的, 按
 * 文件长度算会漏掉 WAL 里新分配的页, 于是读它们时报"页号越界"。
 */
func attachWal(pager: Pager, dbPath: String): Unit {
    let w = WalFile(walPathFor(dbPath), pager.pageSize)
    w.openOrCreate()
    pager.wal = Some(w)
    if (w.dbSizeAtLastCommit > 0) {
        pager.header.dbSize = w.dbSizeAtLastCommit
    }
    // WAL 里可能有更新的头 (dbSize / schemaCookie 都在页 1)。钉一次快照会顺带重读它。
    pager.pinReadSnapshot()
    // 立刻解开: 打开时钉的快照留着会让这条连接的**第一个**读事务停在打开那一刻的视野 ——
    // 中间别的连接提交的内容一概看不到, 而 pinReadSnapshot 的"已钉住就跳过"那一支正好
    // 把它保留下来。打开与"开始读事务"是两件事。
    pager.unpinReadSnapshot()
}

func fileByteLength(path: String): Int64 {
    let f = File(path, OpenMode.Read)
    let n = f.length
    f.close()
    n
}

/** 建一个纯内存库。VACUUM 也用它当重建的暂存区。 */
func openMemoryDatabase(pageSize: Int64, syncMode: SqliteSyncMode): SqliteDatabase {
    let backend = MemoryBackend()
    let header = newDbHeader(pageSize)
    let pager = Pager(backend, header, false, Journal(""))
    let db = SqliteDatabase(":memory:", pager, syncMode, None, 0)
    initializeNewDatabase(pager)
    db.loadSchemaNow()
    db
}

/**
 * 新库的初始形态: 一页, 就是 sqlite_schema 的空表叶页。
 *
 * 第 1 页的页头在偏移 100 处 —— 前 100 字节是文件头。initPage 会按页号自动处理这个偏移。
 */
func initializeNewDatabase(pager: Pager): Unit {
    pager.beginWrite()
    let page = pager.getNewPage(1)
    initPage(page, PT_TABLE_LEAF, pager.usableSize)
    pager.header.dbSize = 1
    pager.markDirty(page)
    pager.commit(false)
}
