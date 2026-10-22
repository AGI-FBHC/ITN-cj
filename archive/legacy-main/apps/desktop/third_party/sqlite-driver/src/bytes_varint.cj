package sqlite_driver

import std.binary.*

/*
 * SQLite 变长整数 (varint) 与定长大端整数的编解码。
 *
 * varint 格式: 大端, 最多 9 字节。前 8 字节每字节贡献低 7 位、高位为"还有后续"标志;
 * 第 9 字节例外 —— 它贡献全部 8 位, 所以 9 字节能表达完整的 64 位。
 * 值按 64 位无符号解释, 但 SQLite 用它同时存放负 rowid, 故本模块在 Int64 与 UInt64
 * 之间做的是**位重解释**而不是数值转换 (数值转换对负数会抛异常)。
 */

/** varint 与定长字段共用的最大字节数。 */
const VARINT_MAX_BYTES: Int64 = 9

/**
 * 把 Int64 的位模式重解释为 UInt64。
 *
 * 不能用 `UInt64(v)`: 那是数值转换, 负数直接抛 "result would be less than UInt64.Min"。
 * 走一趟大端缓冲即得到同一串位的无符号读法。
 */
func bitsToU64(v: Int64): UInt64 {
    let buf = Array<Byte>(8, repeat: 0)
    let _ = v.writeBigEndian(buf)
    UInt64.readBigEndian(buf)
}

/** bitsToU64 的逆向。 */
func bitsToI64(v: UInt64): Int64 {
    let buf = Array<Byte>(8, repeat: 0)
    let _ = v.writeBigEndian(buf)
    Int64.readBigEndian(buf)
}

/** 编码 value 所需的 varint 字节数 (1..9)。 */
func varintLen(value: Int64): Int64 {
    let u = bitsToU64(value)
    if (u <= 0x7F) {
        return 1
    }
    if (u <= 0x3FFF) {
        return 2
    }
    if (u <= 0x1FFFFF) {
        return 3
    }
    if (u <= 0x0FFFFFFF) {
        return 4
    }
    if (u <= 0x07FFFFFFFF) {
        return 5
    }
    if (u <= 0x03FFFFFFFFFF) {
        return 6
    }
    if (u <= 0x01FFFFFFFFFFFF) {
        return 7
    }
    if (u <= 0x00FFFFFFFFFFFFFF) {
        return 8
    }
    9
}

/**
 * 把 value 写成 varint, 存入 buf 的 offset 处, 返回写入字节数。
 *
 * 调用方须保证 buf 从 offset 起至少有 varintLen(value) 字节可写。
 */
func writeVarint(buf: Array<Byte>, offset: Int64, value: Int64): Int64 {
    let n = varintLen(value)
    let u = bitsToU64(value)
    if (n == 9) {
        // 第 9 字节贡献 8 位, 前 8 字节各贡献 7 位: 先取最低 8 位, 再逐 7 位向前。
        buf[offset + 8] = UInt8(u & 0xFF)
        var rest = u >> 8
        var i = 7
        while (i >= 0) {
            buf[offset + i] = UInt8((rest & 0x7F) | 0x80)
            rest >>= 7
            i--
        }
        return 9
    }
    var i = n - 1
    var rest = u
    while (i >= 0) {
        let low = UInt8(rest & 0x7F)
        buf[offset + i] = if (i == n - 1) {
            low
        } else {
            low | 0x80
        }
        rest >>= 7
        i--
    }
    n
}

/** 解出的 varint: 值与消耗的字节数。 */
struct Varint {
    let value: Int64
    let size: Int64

    init(value: Int64, size: Int64) {
        this.value = value
        this.size = size
    }
}

/**
 * 从 buf 的 offset 处读一个 varint。
 *
 * 容错非最短编码 (如 0x81 0x00 表示 128 却写成 2 字节的 0): SQLite 自己不产出这种
 * 编码, 但读别的实现写的库时按位累加即可, 不必拒绝。
 * 缺字节时抛异常 —— 那是真损坏, 静默返回 0 会让上层把损坏当成合法的空记录。
 */
func readVarint(buf: Array<Byte>, offset: Int64): Varint {
    var acc: UInt64 = 0
    var i = 0
    while (i < 8) {
        let pos = offset + i
        if (pos >= buf.size) {
            throw SqliteFormatException("varint truncated at offset ${offset}")
        }
        let b = buf[pos]
        acc = (acc << 7) | UInt64(b & 0x7F)
        if ((b & 0x80) == 0) {
            return Varint(bitsToI64(acc), i + 1)
        }
        i++
    }
    // 已吃掉 8 个带续标志的字节, 第 9 字节贡献全部 8 位。
    let pos = offset + 8
    if (pos >= buf.size) {
        throw SqliteFormatException("varint truncated at offset ${offset}")
    }
    acc = (acc << 8) | UInt64(buf[pos])
    Varint(bitsToI64(acc), 9)
}

/** 读 1 字节无符号。 */
func readU8(buf: Array<Byte>, offset: Int64): Int64 {
    Int64(buf[offset])
}

/** 读 2 字节大端无符号。 */
func readU16(buf: Array<Byte>, offset: Int64): Int64 {
    (Int64(buf[offset]) << 8) | Int64(buf[offset + 1])
}

/** 写 2 字节大端无符号。value 须在 0..65535。 */
func writeU16(buf: Array<Byte>, offset: Int64, value: Int64): Unit {
    buf[offset] = UInt8((value >> 8) & 0xFF)
    buf[offset + 1] = UInt8(value & 0xFF)
}

/** 读 3 字节大端无符号。 */
func readU24(buf: Array<Byte>, offset: Int64): Int64 {
    (Int64(buf[offset]) << 16) | (Int64(buf[offset + 1]) << 8) | Int64(buf[offset + 2])
}

/** 读 4 字节大端无符号 (结果落在 0..2^32-1, 故用 Int64 承载)。 */
func readU32(buf: Array<Byte>, offset: Int64): Int64 {
    (Int64(buf[offset]) << 24) | (Int64(buf[offset + 1]) << 16) | (Int64(buf[offset + 2]) << 8) | Int64(buf[offset + 3])
}

/** 写 4 字节大端无符号。value 须在 0..2^32-1。 */
func writeU32(buf: Array<Byte>, offset: Int64, value: Int64): Unit {
    buf[offset] = UInt8((value >> 24) & 0xFF)
    buf[offset + 1] = UInt8((value >> 16) & 0xFF)
    buf[offset + 2] = UInt8((value >> 8) & 0xFF)
    buf[offset + 3] = UInt8(value & 0xFF)
}

/** 读 n 字节大端**有符号**整数 (n 为 1/2/3/4/6/8), 用于 record 的整数 serial type。 */
func readSignedBE(buf: Array<Byte>, offset: Int64, n: Int64): Int64 {
    var acc: UInt64 = 0
    for (i in 0..n) {
        acc = (acc << 8) | UInt64(buf[offset + i])
    }
    // 符号扩展: 把最高位复制到剩余高位。
    let bits = n * 8
    if (bits < 64) {
        let signBit: UInt64 = 1 << UInt64(bits - 1)
        if ((acc & signBit) != 0) {
            let mask: UInt64 = UInt64.Max << UInt64(bits)
            acc |= mask
        }
    }
    bitsToI64(acc)
}

/** 写 n 字节大端有符号整数, 与 readSignedBE 对偶。 */
func writeSignedBE(buf: Array<Byte>, offset: Int64, value: Int64, n: Int64): Unit {
    let u = bitsToU64(value)
    var i = n - 1
    var shift: UInt64 = 0
    while (i >= 0) {
        buf[offset + i] = UInt8((u >> shift) & 0xFF)
        shift += 8
        i--
    }
}
