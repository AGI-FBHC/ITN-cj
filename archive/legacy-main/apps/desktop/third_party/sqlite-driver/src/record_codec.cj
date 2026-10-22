package sqlite_driver

/*
 * record 格式 (SQLite 的 "record format"): 一行的多个值编成一串字节。
 *
 *   [头长度 varint][serial type varint]*  [值本体]*
 *
 * 头长度**含自身**。serial type 既表示类型也表示长度:
 *   0        NULL, 无本体
 *   1..6     大端有符号整数, 长度 1/2/3/4/6/8 字节
 *   7        IEEE754 双精度, 8 字节
 *   8 / 9    常量整数 0 / 1, 无本体 —— 布尔列几乎不占空间就靠这两个
 *   10 / 11  保留
 *   >=12 偶  BLOB, 长度 (N-12)/2
 *   >=13 奇  TEXT, 长度 (N-13)/2
 *
 * 8/9 这两个常量类型是"我们的编码与 SQLite 是否一致"最容易漏的地方: 漏了不会报错,
 * 只是我们写的库比它的大一点; 但**读**它写的库时, 不认 8/9 就会把 0/1 读成 NULL。
 */
const SERIAL_NULL: Int64 = 0
const SERIAL_FLOAT: Int64 = 7
const SERIAL_ZERO: Int64 = 8
const SERIAL_ONE: Int64 = 9
const SERIAL_BLOB_BASE: Int64 = 12
const SERIAL_TEXT_BASE: Int64 = 13

/** 整数 serial type 1..6 对应的字节数。 */
func intSerialSize(serial: Int64): Int64 {
    match (serial) {
        case 1 => 1
        case 2 => 2
        case 3 => 3
        case 4 => 4
        case 5 => 6
        case 6 => 8
        case _ => throw SqliteFormatException("serial type ${serial} is not an integer type")
    }
}

/** 选能容纳 v 的最小整数 serial type。 */
func serialTypeForInt(v: Int64): Int64 {
    if (v == 0) {
        return SERIAL_ZERO
    }
    if (v == 1) {
        return SERIAL_ONE
    }
    if (v >= -128 && v <= 127) {
        return 1
    }
    if (v >= -32768 && v <= 32767) {
        return 2
    }
    if (v >= -8388608 && v <= 8388607) {
        return 3
    }
    if (v >= -2147483648 && v <= 2147483647) {
        return 4
    }
    if (v >= -140737488355328 && v <= 140737488355327) {
        return 5
    }
    6
}

/** 某个值的 serial type。 */
func serialTypeOf(v: SqliteValue): Int64 {
    match (v) {
        case SNull => SERIAL_NULL
        case SInt(i) => serialTypeForInt(i)
        case SReal(_) => SERIAL_FLOAT
        case SText(s) => SERIAL_TEXT_BASE + s.toArray().size * 2
        case SBlob(bs) => SERIAL_BLOB_BASE + bs.size * 2
    }
}

/** serial type 对应的本体字节数。 */
func serialBodySize(serial: Int64): Int64 {
    if (serial == SERIAL_NULL || serial == SERIAL_ZERO || serial == SERIAL_ONE) {
        return 0
    }
    if (serial >= 1 && serial <= 6) {
        return intSerialSize(serial)
    }
    if (serial == SERIAL_FLOAT) {
        return 8
    }
    if (serial == 10 || serial == 11) {
        throw SqliteFormatException("serial type ${serial} is reserved for internal use")
    }
    if (serial % 2 == 0) {
        (serial - SERIAL_BLOB_BASE) / 2
    } else {
        (serial - SERIAL_TEXT_BASE) / 2
    }
}

/** 把一行值编成 record 字节串。 */
func encodeRecord(values: Array<SqliteValue>): Array<Byte> {
    let serials = Array<Int64>(values.size, repeat: 0)
    var bodySize = 0
    var serialBytes = 0
    for (i in 0..values.size) {
        let s = serialTypeOf(values[i])
        serials[i] = s
        serialBytes += varintLen(s)
        bodySize += serialBodySize(s)
    }
    // 头长度含自身, 而它自己的 varint 长度又取决于总长 —— 迭代到稳定 (最多两轮:
    // 只有跨过 127/16383 这类边界时长度才会变)。
    var headerLen = serialBytes + 1
    while (varintLen(headerLen) + serialBytes != headerLen) {
        headerLen = varintLen(headerLen) + serialBytes
    }
    let out = Array<Byte>(headerLen + bodySize, repeat: 0)
    var pos = writeVarint(out, 0, headerLen)
    for (i in 0..values.size) {
        pos += writeVarint(out, pos, serials[i])
    }
    for (i in 0..values.size) {
        pos += writeSerialBody(out, pos, values[i], serials[i])
    }
    out
}

func writeSerialBody(buf: Array<Byte>, offset: Int64, v: SqliteValue, serial: Int64): Int64 {
    match (v) {
        case SNull => 0
        case SInt(i) =>
            if (serial == SERIAL_ZERO || serial == SERIAL_ONE) {
                0
            } else {
                let n = intSerialSize(serial)
                writeSignedBE(buf, offset, i, n)
                n
            }
        case SReal(f) =>
            writeSignedBE(buf, offset, bitsToI64(reinterpretFloatBits(f)), 8)
            8
        case SText(s) =>
            let bs = s.toArray()
            bs.copyTo(buf, 0, offset, bs.size)
            bs.size
        case SBlob(bs) =>
            bs.copyTo(buf, 0, offset, bs.size)
            bs.size
    }
}

/** 取 Float64 的 IEEE754 位模式。 */
func reinterpretFloatBits(f: Float64): UInt64 {
    f.toBits()
}

/**
 * 解 record, 缺的字段按 NULL 补。
 *
 * columnCount 是期待的列数: record 里的字段可能**少于**它 —— ALTER TABLE ADD COLUMN
 * 之后的旧行就是这样。缺的字段补齐而不是报错, 这是 SQLite 的既定行为, 也是"加过列的表
 * 还能读旧数据"的前提。
 *
 * 表行的缺失字段读出的是列的 DEFAULT 而不是 NULL, 走 decodeRecordWithDefaults; 索引键、
 * sqlite_schema 这类没有默认值可言的 record 用本函数。
 */
func decodeRecord(buf: Array<Byte>, columnCount: Int64): Array<SqliteValue> {
    decodeRecordInto(buf, Array<SqliteValue>(columnCount, repeat: SqliteValue.SNull))
}

/**
 * 解 record, 缺的字段取 fallback 里对应位置的值。
 *
 * fallback 的长度就是期待的列数, 元素是各列的常量 DEFAULT。record 里**写着** NULL 的字段
 * 是真的 NULL, 不被 fallback 覆盖 —— 只有 record 根本没有的那些尾部字段才取默认值。
 */
func decodeRecordWithDefaults(buf: Array<Byte>, fallback: Array<SqliteValue>): Array<SqliteValue> {
    let out = Array<SqliteValue>(fallback.size, repeat: SqliteValue.SNull)
    for (i in 0..fallback.size) {
        out[i] = fallback[i]
    }
    decodeRecordInto(buf, out)
}

/** 逐字段解进 out; out 的长度即期待的列数, 未被 record 覆盖的位置保持原值。 */
private func decodeRecordInto(buf: Array<Byte>, out: Array<SqliteValue>): Array<SqliteValue> {
    let columnCount = out.size
    if (buf.size == 0) {
        return out
    }
    let head = readVarint(buf, 0)
    let headerLen = head.value
    if (headerLen < 1 || headerLen > buf.size) {
        throw SqliteFormatException("record header length ${headerLen} exceeds the record size ${buf.size}")
    }
    var typePos = head.size
    var bodyPos = headerLen
    var col = 0
    while (typePos < headerLen) {
        let st = readVarint(buf, typePos)
        typePos += st.size
        let size = serialBodySize(st.value)
        if (bodyPos + size > buf.size) {
            throw SqliteFormatException(
                "record body truncated: field ${col} needs ${size} bytes at ${bodyPos} of ${buf.size}")
        }
        if (col < columnCount) {
            out[col] = decodeSerial(buf, bodyPos, st.value)
        }
        bodyPos += size
        col += 1
    }
    out
}

/** 解 record 里的字段数, 不解值 —— 供 schema 解析核对列数。 */
func recordFieldCount(buf: Array<Byte>): Int64 {
    if (buf.size == 0) {
        return 0
    }
    let head = readVarint(buf, 0)
    var typePos = head.size
    var n = 0
    while (typePos < head.value) {
        let st = readVarint(buf, typePos)
        typePos += st.size
        n += 1
    }
    n
}

func decodeSerial(buf: Array<Byte>, offset: Int64, serial: Int64): SqliteValue {
    if (serial == SERIAL_NULL) {
        return SqliteValue.SNull
    }
    if (serial == SERIAL_ZERO) {
        return SqliteValue.SInt(0)
    }
    if (serial == SERIAL_ONE) {
        return SqliteValue.SInt(1)
    }
    if (serial >= 1 && serial <= 6) {
        return SqliteValue.SInt(readSignedBE(buf, offset, intSerialSize(serial)))
    }
    if (serial == SERIAL_FLOAT) {
        let bits = readSignedBE(buf, offset, 8)
        return SqliteValue.SReal(Float64.fromBits(bitsToU64(bits)))
    }
    if (serial == 10 || serial == 11) {
        throw SqliteFormatException("serial type ${serial} is reserved for internal use")
    }
    let size = serialBodySize(serial)
    let body = Array<Byte>(size, repeat: 0)
    buf.copyTo(body, offset, 0, size)
    if (serial % 2 == 0) {
        SqliteValue.SBlob(body)
    } else {
        // 非法 UTF-8 落回 BLOB 而不是抛: 别的实现可能写进过任意字节, 拒绝打开整个库
        // 比按字节保留更糟 —— 至少后者能把行读出来。
        try {
            SqliteValue.SText(String.fromUtf8(body))
        } catch (_: Exception) {
            SqliteValue.SBlob(body)
        }
    }
}
