package sqlite_driver

/*
 * 数据库文件头: 第 1 页开头的 100 字节。所有多字节字段大端。
 *
 * 偏移与取值约束遵循 SQLite 文件格式规范。文件头写错通常不会立刻报错，却会使数据库无法被
 * 正确打开，所以这里的校验一律从严：宁可在打开时抛异常，也不要继续生成非法文件。
 */

/** 头部长度, 也是第 1 页内 B-tree 区的起始偏移。 */
const HEADER_SIZE: Int64 = 100

/** 头部魔数, 含结尾的 NUL。 */
const HEADER_MAGIC: String = "SQLite format 3\0"

/** page_size 字段里 1 的特殊含义: 65536。 */
const PAGE_SIZE_64K_MARKER: Int64 = 1
const MIN_PAGE_SIZE: Int64 = 512
const MAX_PAGE_SIZE: Int64 = 65536

/** 默认页大小, 与当前 SQLite 默认一致。 */
const DEFAULT_PAGE_SIZE: Int64 = 4096

/** 文本编码: 本实现只支持 UTF-8。 */
const TEXT_ENCODING_UTF8: Int64 = 1

/**
 * schema_format = 4: 支持 DESC 索引与列的 NOT NULL 改动等。
 * 写 4 让新库具备完整能力; 读的时候 1..4 都接受。
 */
const SCHEMA_FORMAT_MAX: Int64 = 4

/** write/read version = 1: DELETE 等回滚日志; = 2: WAL。写进文件头, 是持久设置。 */
const JOURNAL_VERSION_LEGACY: Int64 = 1
const JOURNAL_VERSION_WAL: Int64 = 2

/** 写进头部 96..99 的 SQLITE_VERSION_NUMBER, 对应 3.46.1。 */
const SQLITE_VERSION_NUMBER: Int64 = 3046001

/** 本驱动对外报告的版本字符串, 与上面的数字保持一致。 */
const SQLITE_VERSION_STRING: String = "3.46.1"

/** 头部各字段偏移。集中列出便于与规范逐条对照。 */
const OFF_PAGE_SIZE: Int64 = 16
const OFF_WRITE_VERSION: Int64 = 18
const OFF_READ_VERSION: Int64 = 19
const OFF_RESERVED_SPACE: Int64 = 20
const OFF_MAX_PAYLOAD_FRAC: Int64 = 21
const OFF_MIN_PAYLOAD_FRAC: Int64 = 22
const OFF_LEAF_PAYLOAD_FRAC: Int64 = 23
const OFF_CHANGE_COUNTER: Int64 = 24
const OFF_DB_SIZE: Int64 = 28
const OFF_FREELIST_TRUNK: Int64 = 32
const OFF_FREELIST_COUNT: Int64 = 36
const OFF_SCHEMA_COOKIE: Int64 = 40
const OFF_SCHEMA_FORMAT: Int64 = 44
const OFF_DEFAULT_CACHE_SIZE: Int64 = 48
const OFF_LARGEST_ROOT_PAGE: Int64 = 52
const OFF_TEXT_ENCODING: Int64 = 56
const OFF_USER_VERSION: Int64 = 60
const OFF_INCREMENTAL_VACUUM: Int64 = 64
const OFF_APPLICATION_ID: Int64 = 68
const OFF_VERSION_VALID_FOR: Int64 = 92
const OFF_SQLITE_VERSION: Int64 = 96

/**
 * 数据库头的可变视图。
 *
 * 字段设成 var 而不是构造后不可变: change_counter / db_size / schema_cookie 每次
 * 写事务都要改, 做成不可变会迫使每次都重建整个头对象再回填。
 */
class DbHeader {
    var pageSize: Int64 = DEFAULT_PAGE_SIZE
    var writeVersion: Int64 = 1
    var readVersion: Int64 = 1
    var reservedSpace: Int64 = 0
    var changeCounter: Int64 = 0
    var dbSize: Int64 = 0
    var freelistTrunk: Int64 = 0
    var freelistCount: Int64 = 0
    var schemaCookie: Int64 = 0
    var schemaFormat: Int64 = SCHEMA_FORMAT_MAX
    var defaultCacheSize: Int64 = 0
    var largestRootPage: Int64 = 0
    var textEncoding: Int64 = TEXT_ENCODING_UTF8
    var userVersion: Int64 = 0
    var incrementalVacuum: Int64 = 0
    var applicationId: Int64 = 0
    var versionValidFor: Int64 = 0
    var sqliteVersion: Int64 = SQLITE_VERSION_NUMBER

    init() {}

    /** 每页可用字节数: 页大小减去页尾保留区。 */
    prop usableSize: Int64 {
        get() {
            pageSize - reservedSpace
        }
    }
}

/**
 * 把 from 的字段拷进 to, 保留 to 的 pageSize。
 *
 * WAL 模式下别的进程提交后要重读头, 而 pageSize 是打开时就定下、建库后不可改的 ——
 * 它由 Pager 的所有偏移计算依赖着, 中途改掉会让已缓存的页错位。
 */
func copyHeaderFields(from: DbHeader, to: DbHeader): Unit {
    to.writeVersion = from.writeVersion
    to.readVersion = from.readVersion
    to.reservedSpace = from.reservedSpace
    to.changeCounter = from.changeCounter
    to.dbSize = from.dbSize
    to.freelistTrunk = from.freelistTrunk
    to.freelistCount = from.freelistCount
    to.schemaCookie = from.schemaCookie
    to.schemaFormat = from.schemaFormat
    to.defaultCacheSize = from.defaultCacheSize
    to.largestRootPage = from.largestRootPage
    to.textEncoding = from.textEncoding
    to.userVersion = from.userVersion
    to.incrementalVacuum = from.incrementalVacuum
    to.applicationId = from.applicationId
    to.versionValidFor = from.versionValidFor
    to.sqliteVersion = from.sqliteVersion
}

/** 新建库时的头: 1 页 (只有 sqlite_schema 的根页), 计数器从 1 起。 */
func newDbHeader(pageSize: Int64): DbHeader {
    validatePageSize(pageSize)
    let h = DbHeader()
    h.pageSize = pageSize
    h.dbSize = 1
    h.changeCounter = 1
    h.versionValidFor = 1
    h
}

func validatePageSize(pageSize: Int64): Unit {
    if (pageSize < MIN_PAGE_SIZE || pageSize > MAX_PAGE_SIZE) {
        throw SqliteFormatException("page size ${pageSize} outside 512..65536")
    }
    if ((pageSize & (pageSize - 1)) != 0) {
        throw SqliteFormatException("page size ${pageSize} is not a power of two")
    }
}

/**
 * 解析 100 字节头。
 *
 * 拒绝而不是"尽力猜": 魔数不符、页大小非法、UTF-16 编码、schema_format 超范围
 * 都直接抛。特别是 UTF-16 —— 静默按 UTF-8 读会把每个字符读成两个乱码字节, 且
 * 一路不报错, 到用户看见结果时已经无法追溯到编码判断上。
 */
func parseDbHeader(buf: Array<Byte>): DbHeader {
    if (buf.size < HEADER_SIZE) {
        throw SqliteFormatException("file shorter than the 100-byte header")
    }
    let magic = HEADER_MAGIC.toArray()
    for (i in 0..magic.size) {
        if (buf[i] != magic[i]) {
            throw SqliteFormatException("not a SQLite database (bad magic at byte ${i})")
        }
    }
    let h = DbHeader()
    let rawPageSize = readU16(buf, OFF_PAGE_SIZE)
    h.pageSize = if (rawPageSize == PAGE_SIZE_64K_MARKER) {
        MAX_PAGE_SIZE
    } else {
        rawPageSize
    }
    validatePageSize(h.pageSize)

    h.writeVersion = readU8(buf, OFF_WRITE_VERSION)
    h.readVersion = readU8(buf, OFF_READ_VERSION)
    if (h.readVersion > 2) {
        throw SqliteFormatException("read format version ${h.readVersion} is newer than this driver supports")
    }
    if (h.writeVersion > 2) {
        throw SqliteFormatException("write format version ${h.writeVersion} is newer than this driver supports")
    }
    h.reservedSpace = readU8(buf, OFF_RESERVED_SPACE)
    if (h.reservedSpace >= h.pageSize - 32) {
        throw SqliteFormatException("reserved space ${h.reservedSpace} leaves too little usable page")
    }
    // 三个 payload fraction 在格式规范里是固定值; 不同的值意味着别的实现改过布局算法,
    // 我们的 cell 溢出阈值就不再与之吻合。
    if (readU8(buf, OFF_MAX_PAYLOAD_FRAC) != 64 || readU8(buf, OFF_MIN_PAYLOAD_FRAC) != 32 ||
        readU8(buf, OFF_LEAF_PAYLOAD_FRAC) != 32) {
        throw SqliteFormatException("non-standard payload fractions in header")
    }
    h.changeCounter = readU32(buf, OFF_CHANGE_COUNTER)
    h.dbSize = readU32(buf, OFF_DB_SIZE)
    h.freelistTrunk = readU32(buf, OFF_FREELIST_TRUNK)
    h.freelistCount = readU32(buf, OFF_FREELIST_COUNT)
    h.schemaCookie = readU32(buf, OFF_SCHEMA_COOKIE)
    h.schemaFormat = readU32(buf, OFF_SCHEMA_FORMAT)
    if (h.schemaFormat < 1 || h.schemaFormat > SCHEMA_FORMAT_MAX) {
        throw SqliteFormatException("unsupported schema format ${h.schemaFormat}")
    }
    h.defaultCacheSize = readU32(buf, OFF_DEFAULT_CACHE_SIZE)
    h.largestRootPage = readU32(buf, OFF_LARGEST_ROOT_PAGE)
    h.textEncoding = readU32(buf, OFF_TEXT_ENCODING)
    if (h.textEncoding != TEXT_ENCODING_UTF8) {
        throw SqliteFormatException(
            "text encoding ${h.textEncoding} (UTF-16) is not supported; only UTF-8 databases can be opened")
    }
    h.userVersion = readU32(buf, OFF_USER_VERSION)
    h.incrementalVacuum = readU32(buf, OFF_INCREMENTAL_VACUUM)
    h.applicationId = readU32(buf, OFF_APPLICATION_ID)
    h.versionValidFor = readU32(buf, OFF_VERSION_VALID_FOR)
    h.sqliteVersion = readU32(buf, OFF_SQLITE_VERSION)
    h
}

/** 把头写进 buf 的前 100 字节。72..91 的保留区留零。 */
func writeDbHeader(buf: Array<Byte>, h: DbHeader): Unit {
    let magic = HEADER_MAGIC.toArray()
    magic.copyTo(buf, 0, 0, magic.size)
    let encodedPageSize = if (h.pageSize == MAX_PAGE_SIZE) {
        PAGE_SIZE_64K_MARKER
    } else {
        h.pageSize
    }
    writeU16(buf, OFF_PAGE_SIZE, encodedPageSize)
    buf[OFF_WRITE_VERSION] = UInt8(h.writeVersion)
    buf[OFF_READ_VERSION] = UInt8(h.readVersion)
    buf[OFF_RESERVED_SPACE] = UInt8(h.reservedSpace)
    buf[OFF_MAX_PAYLOAD_FRAC] = 64
    buf[OFF_MIN_PAYLOAD_FRAC] = 32
    buf[OFF_LEAF_PAYLOAD_FRAC] = 32
    writeU32(buf, OFF_CHANGE_COUNTER, h.changeCounter)
    writeU32(buf, OFF_DB_SIZE, h.dbSize)
    writeU32(buf, OFF_FREELIST_TRUNK, h.freelistTrunk)
    writeU32(buf, OFF_FREELIST_COUNT, h.freelistCount)
    writeU32(buf, OFF_SCHEMA_COOKIE, h.schemaCookie)
    writeU32(buf, OFF_SCHEMA_FORMAT, h.schemaFormat)
    writeU32(buf, OFF_DEFAULT_CACHE_SIZE, h.defaultCacheSize)
    writeU32(buf, OFF_LARGEST_ROOT_PAGE, h.largestRootPage)
    writeU32(buf, OFF_TEXT_ENCODING, h.textEncoding)
    writeU32(buf, OFF_USER_VERSION, h.userVersion)
    writeU32(buf, OFF_INCREMENTAL_VACUUM, h.incrementalVacuum)
    writeU32(buf, OFF_APPLICATION_ID, h.applicationId)
    for (i in 72..92) {
        buf[i] = 0
    }
    writeU32(buf, OFF_VERSION_VALID_FOR, h.versionValidFor)
    writeU32(buf, OFF_SQLITE_VERSION, h.sqliteVersion)
}
