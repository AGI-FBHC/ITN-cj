package sqlite_driver

/*
 * 连接配置。
 *
 * 字段刻意少: SQLite 没有网络层, 真正影响行为的只有"文件在哪"、"落盘多严"、"等锁多久"、
 * "页多大"。连接池参数不属于单连接配置，由上层连接管理器处理。
 */
public class SqliteDSN {
    /** 数据库文件路径; ":memory:" 或空串表示内存库。 */
    public let path: String
    /** 提交时的落盘强度。 */
    public let syncMode: SqliteSyncMode
    /** 取写锁的等待上限, 毫秒。 */
    public let busyTimeoutMs: Int64
    /** 新建库的页大小; 打开既有库时忽略 (页大小写在文件头里, 不可改)。 */
    public let pageSize: Int64
    /** 是否启用外键约束；打开连接时同步到 PRAGMA foreign_keys 并参与引用检查。 */
    public let foreignKeys: Bool

    public init(path!: String = ":memory:", syncMode!: SqliteSyncMode = SqliteSyncMode.SyncNormal,
        busyTimeoutMs!: Int64 = 5000, pageSize!: Int64 = DEFAULT_PAGE_SIZE, foreignKeys!: Bool = false) {
        if (busyTimeoutMs < 0) {
            throw SqliteRuntimeException("dsn", "busyTimeoutMs must not be negative, got ${busyTimeoutMs}")
        }
        validatePageSizeChoice(pageSize)
        this.path = path
        this.syncMode = syncMode
        this.busyTimeoutMs = busyTimeoutMs
        this.pageSize = pageSize
        this.foreignKeys = foreignKeys
    }

    /** 是否指向内存库。 */
    public prop isMemory: Bool {
        get() {
            path == ":memory:" || path.isEmpty()
        }
    }
}

/**
 * 页大小必须是 512..65536 之间的 2 的幂。
 *
 * 在 DSN 构造时就查而不是等到建库: 非法页大小会让文件头写出一个 SQLite 读不了的
 * 库, 而那要到互操作时才发现。
 */
func validatePageSizeChoice(pageSize: Int64): Unit {
    if (pageSize < MIN_PAGE_SIZE || pageSize > MAX_PAGE_SIZE) {
        throw SqliteRuntimeException("dsn",
            "pageSize must be between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}, got ${pageSize}")
    }
    if ((pageSize & (pageSize - 1)) != 0) {
        throw SqliteRuntimeException("dsn", "pageSize must be a power of two, got ${pageSize}")
    }
}
