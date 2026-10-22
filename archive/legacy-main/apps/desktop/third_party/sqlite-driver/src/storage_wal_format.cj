package sqlite_driver

/*
 * WAL (`<db>-wal`) 的文件格式与校验和。
 *
 * 32 字节 WAL 头:
 *   0..3    魔数 0x377f0682 / 0x377f0683 —— 末位区分校验和按小端还是大端读 u32
 *   4..7    格式版本, 恒 3007000
 *   8..11   页大小
 *   12..15  checkpoint 序号
 *   16..19  salt-1  (每次 RESTART/TRUNCATE 递增, 用来判定帧属于哪一代 WAL)
 *   20..23  salt-2  (随机)
 *   24..31  头自身的校验和 (over 0..23, 种子 0)
 *
 * 之后是帧序列, 每帧 24 字节帧头 + 一页数据:
 *   0..3    页号
 *   4..7    提交帧写事务后的库页数; 非提交帧写 0
 *   8..15   salt-1 / salt-2, 必须与 WAL 头相同
 *   16..23  校验和
 *
 * 校验和**必须逐位一致**。算错的帧会被 SQLite 判为无效并当成 WAL 结尾，读取结果会停留在
 * 最近一次有效提交之前而不报告错误。
 */
const WAL_HEADER_BYTES: Int64 = 32
const WAL_FRAME_HEADER_BYTES: Int64 = 24

/** 小端校验和的魔数。大端那个是 0x377f0683, 读得懂但我们不写。 */
const WAL_MAGIC_LE: Int64 = 0x377f0682
const WAL_MAGIC_BE: Int64 = 0x377f0683

/** WAL 格式版本, 固定值。 */
const WAL_FORMAT_VERSION: Int64 = 3007000

/** 自动 checkpoint 的默认阈值 (帧数), 与 SQLite 一致。 */
const WAL_DEFAULT_AUTOCHECKPOINT: Int64 = 1000

/** 头字段偏移。 */
const WAL_OFF_MAGIC: Int64 = 0
const WAL_OFF_FORMAT: Int64 = 4
const WAL_OFF_PAGE_SIZE: Int64 = 8
const WAL_OFF_CHECKPOINT_SEQ: Int64 = 12
const WAL_OFF_SALT1: Int64 = 16
const WAL_OFF_SALT2: Int64 = 20
const WAL_OFF_CHECKSUM1: Int64 = 24
const WAL_OFF_CHECKSUM2: Int64 = 28

/** 帧头字段偏移。 */
const WAL_FRAME_OFF_PAGE_NO: Int64 = 0
const WAL_FRAME_OFF_TRUNCATE: Int64 = 4
const WAL_FRAME_OFF_SALT1: Int64 = 8
const WAL_FRAME_OFF_SALT2: Int64 = 12
const WAL_FRAME_OFF_CHECKSUM1: Int64 = 16
const WAL_FRAME_OFF_CHECKSUM2: Int64 = 20

/** 32 位校验和对。 */
struct WalChecksum {
    let s1: UInt32
    let s2: UInt32

    init(s1: UInt32, s2: UInt32) {
        this.s1 = s1
        this.s2 = s2
    }

    func equalsTo(other: WalChecksum): Bool {
        s1 == other.s1 && s2 == other.s2
    }
}

/**
 * SQLite 的 WAL 校验和: Fibonacci 权重, 每轮吃两个 u32。
 *
 * 字节数必须是 8 的倍数 (帧头前 8 字节与整页都满足)。bigEndian 由魔数末位决定 ——
 * 我们写小端那个魔数, 但读别人的库时要按对方的魔数来, 否则算出的校验和全不符,
 * 表现是"对方的 WAL 里一帧都读不到"。
 */
func walChecksumBytes(bigEndian: Bool, data: Array<Byte>, seed: WalChecksum): WalChecksum {
    if (data.size % 8 != 0) {
        throw SqliteFormatException("WAL checksum input must be a multiple of 8 bytes, got ${data.size}")
    }
    var s1 = seed.s1
    var s2 = seed.s2
    var i = 0
    while (i < data.size) {
        let x0 = readU32ByOrder(data, i, bigEndian)
        let x1 = readU32ByOrder(data, i + 4, bigEndian)
        s1 = wrappingAddU32(s1, wrappingAddU32(x0, s2))
        s2 = wrappingAddU32(s2, wrappingAddU32(x1, s1))
        i += 8
    }
    WalChecksum(s1, s2)
}

func readU32ByOrder(buf: Array<Byte>, offset: Int64, bigEndian: Bool): UInt32 {
    if (bigEndian) {
        return (UInt32(buf[offset]) << 24) | (UInt32(buf[offset + 1]) << 16) | (UInt32(buf[offset + 2]) << 8) | UInt32(buf[offset +
                3])
    }
    (UInt32(buf[offset + 3]) << 24) | (UInt32(buf[offset + 2]) << 16) | (UInt32(buf[offset + 1]) << 8) | UInt32(buf[offset])
}

/** WAL 头的解析结果。 */
class WalFileHeader {
    let bigEndianChecksum: Bool
    let pageSize: Int64
    let checkpointSeq: Int64
    let salt1: Int64
    let salt2: Int64
    /** 头自身的校验和, 同时是第一帧的校验和种子。 */
    let checksum: WalChecksum

    init(bigEndianChecksum: Bool, pageSize: Int64, checkpointSeq: Int64, salt1: Int64, salt2: Int64,
        checksum: WalChecksum) {
        this.bigEndianChecksum = bigEndianChecksum
        this.pageSize = pageSize
        this.checkpointSeq = checkpointSeq
        this.salt1 = salt1
        this.salt2 = salt2
        this.checksum = checksum
    }
}

/**
 * 解析 32 字节 WAL 头。
 *
 * 头自身的校验和不符时抛: 那说明这个 -wal 不是完整写出来的, 里面一帧都不可信。SQLite
 * 在这种情况下重建 WAL, 我们报错让调用方决定 —— 静默重建会丢掉别人尚未回填的提交。
 */
func parseWalHeader(buf: Array<Byte>): WalFileHeader {
    if (buf.size < WAL_HEADER_BYTES) {
        throw SqliteFormatException("WAL file is shorter than its 32-byte header")
    }
    let magic = readU32(buf, WAL_OFF_MAGIC)
    if (magic != WAL_MAGIC_LE && magic != WAL_MAGIC_BE) {
        throw SqliteFormatException("not a WAL file (magic 0x${magic})")
    }
    let bigEndian = magic == WAL_MAGIC_BE
    let format = readU32(buf, WAL_OFF_FORMAT)
    if (format != WAL_FORMAT_VERSION) {
        throw SqliteFormatException("unsupported WAL format version ${format}")
    }
    let pageSize = readU32(buf, WAL_OFF_PAGE_SIZE)
    validatePageSize(pageSize)
    let stored = WalChecksum(UInt32(readU32(buf, WAL_OFF_CHECKSUM1)), UInt32(readU32(buf, WAL_OFF_CHECKSUM2)))
    let computed = walChecksumBytes(bigEndian, buf[0..WAL_OFF_CHECKSUM1], WalChecksum(0, 0))
    if (!computed.equalsTo(stored)) {
        throw SqliteFormatException("WAL header checksum does not match its contents")
    }
    WalFileHeader(bigEndian, pageSize, readU32(buf, WAL_OFF_CHECKPOINT_SEQ), readU32(buf, WAL_OFF_SALT1),
        readU32(buf, WAL_OFF_SALT2), stored)
}

/** 序列化 32 字节 WAL 头, 校验和现算。只写小端魔数。 */
func serializeWalHeader(pageSize: Int64, checkpointSeq: Int64, salt1: Int64, salt2: Int64): Array<Byte> {
    let buf = Array<Byte>(WAL_HEADER_BYTES, repeat: 0)
    writeU32(buf, WAL_OFF_MAGIC, WAL_MAGIC_LE)
    writeU32(buf, WAL_OFF_FORMAT, WAL_FORMAT_VERSION)
    writeU32(buf, WAL_OFF_PAGE_SIZE, pageSize)
    writeU32(buf, WAL_OFF_CHECKPOINT_SEQ, checkpointSeq)
    writeU32(buf, WAL_OFF_SALT1, salt1)
    writeU32(buf, WAL_OFF_SALT2, salt2)
    let ck = walChecksumBytes(false, buf[0..WAL_OFF_CHECKSUM1], WalChecksum(0, 0))
    writeU32(buf, WAL_OFF_CHECKSUM1, Int64(ck.s1))
    writeU32(buf, WAL_OFF_CHECKSUM2, Int64(ck.s2))
    buf
}

/**
 * 帧头的字节形态。
 *
 * 校验和覆盖"帧头前 8 字节 + 整页内容", 种子是**上一帧**的校验和 (首帧用 WAL 头的)。
 * 这条链式关系意味着中间插一帧就会让后面全部失效 —— 正是 WAL 用来判定结尾的机制。
 */
func serializeWalFrameHeader(pageNo: Int64, truncate: Int64, salt1: Int64, salt2: Int64, body: Array<Byte>,
    seed: WalChecksum): Array<Byte> {
    let head = Array<Byte>(WAL_FRAME_HEADER_BYTES, repeat: 0)
    writeU32(head, WAL_FRAME_OFF_PAGE_NO, pageNo)
    writeU32(head, WAL_FRAME_OFF_TRUNCATE, truncate)
    writeU32(head, WAL_FRAME_OFF_SALT1, salt1)
    writeU32(head, WAL_FRAME_OFF_SALT2, salt2)
    let ck = walFrameChecksum(false, head, body, seed)
    writeU32(head, WAL_FRAME_OFF_CHECKSUM1, Int64(ck.s1))
    writeU32(head, WAL_FRAME_OFF_CHECKSUM2, Int64(ck.s2))
    head
}

/** 一帧的校验和: 先吃帧头前 8 字节, 再吃整页。 */
func walFrameChecksum(bigEndian: Bool, frameHeader: Array<Byte>, body: Array<Byte>, seed: WalChecksum): WalChecksum {
    let afterHeader = walChecksumBytes(bigEndian, frameHeader[0..8], seed)
    walChecksumBytes(bigEndian, body, afterHeader)
}
