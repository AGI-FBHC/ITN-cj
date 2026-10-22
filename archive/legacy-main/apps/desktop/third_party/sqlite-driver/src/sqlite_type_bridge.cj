package sqlite_driver

import std.database.sql.*
import std.convert.*
import std.io.*
import std.math.numeric.*
import std.time.*

/*
 * std.database.sql 与 SqliteValue 之间的受控转换。
 *
 * 绑定方向只接受能无歧义表达的仓颉类型; 读取方向做反向转换, 无法无损或明确转换时抛
 * SqlException。SQLite 是动态类型, SText 请求数值时按 SQLite 惯例尝试解析, 解析失败报错。
 *
 * 流式列 (InputStream / SqlBlob / SqlClob) 在绑定时完整读取为字节数组，读取时在已物化的
 * 字节上创建 ByteBuffer。增量 BLOB 句柄要求在读写期间持有页面，而结果集会在语句结束时
 * 释放读快照，因此流的生命周期不能跨越语句边界。缓冲式转换保证接口可用，但单列大小受
 * 可用内存限制。
 */

/** 把输入流读满。InputStream 只保证 read, 不保证 Seekable, 所以不能用 std.io.readToEnd。 */
func readStreamFully(s: InputStream): Array<Byte> {
    let out = ByteBuffer()
    let buf = Array<Byte>(8192, repeat: 0)
    while (true) {
        let n = s.read(buf)
        if (n <= 0) {
            break
        }
        out.write(buf[0..n])
    }
    out.bytes()
}

/** CLOB 是字符数据: 按 UTF-8 解码成 TEXT, 而不是当二进制存成 BLOB。 */
func readClobFully(s: InputStream): String {
    try {
        String.fromUtf8(readStreamFully(s))
    } catch (e: Exception) {
        throw SqliteRuntimeException("bind", "CLOB stream is not valid UTF-8: ${e.message}")
    }
}

/** 仓颉值 → SqliteValue。 */
public func coerceToSqliteValue<T>(value: T): SqliteValue {
    match (value) {
        case v: Bool => SqliteValue.SInt(if (v) {
            1
        } else {
            0
        })
        case v: Int8 => SqliteValue.SInt(Int64(v))
        case v: Int16 => SqliteValue.SInt(Int64(v))
        case v: Int32 => SqliteValue.SInt(Int64(v))
        case v: Int64 => SqliteValue.SInt(v)
        case v: Float32 => SqliteValue.SReal(Float64(v))
        case v: Float64 => SqliteValue.SReal(v)
        case v: String => SqliteValue.SText(v)
        case v: Array<Byte> => SqliteValue.SBlob(v)
        case v: Decimal => SqliteValue.SText(v.toString())
        case v: DateTime => SqliteValue.SText(formatDateTimeForSqlite(v))
        // InputStream 放在具体类型之后: Array<Byte> 等已在上面命中, 到这里的只有真正的流。
        case v: InputStream => SqliteValue.SBlob(readStreamFully(v))
        case _ => throw SqliteRuntimeException("bind", "unsupported parameter type")
    }
}

/** SqliteValue → 仓颉值。
 *
 * 由 13 个具名公开桥接函数 (valueFromSqliteBool / ... / valueFromSqliteByteBuffer) 替代原泛型壳:
 * 每个具名函数返回具体类型, 调用形式本身携带目标类型信息, 不依赖运行期字符串分派。
 * 路径 D (is / as 运行期归属判定) 的实现在 src/sqlite_query_result.cj 的 get<T> / getOrNull<T> 内部,
 * 通过本文件的 SENTINEL_* 哨兵 + isT<T> / castTo<T> 包内私有辅助函数实现; 识别与转换分离。
 */

/* 路径 D 运行期类型归属判定的包级哨兵常量。
 * 13 个 SENTINEL_* 对应 13 类目标类型; SENTINEL_INPUTSTREAM 与 SENTINEL_BYTEBUFFER
 * 指向 _SENTINEL_BYTEBUFFER_FOR_STREAM 承载的共享 ByteBuffer 实例,
 * 由 ByteBuffer <: InputStream 子类型关系在 get<T> 末支单判定同时覆盖两者。 */
let SENTINEL_BOOL: Any = false
let SENTINEL_I8: Any = Int8(0)
let SENTINEL_I16: Any = Int16(0)
let SENTINEL_I32: Any = Int32(0)
let SENTINEL_I64: Any = Int64(0)
let SENTINEL_F32: Any = Float32(0.0)
let SENTINEL_F64: Any = Float64(0.0)
let SENTINEL_STRING: Any = ""
let SENTINEL_BYTES: Any = Array<Byte>()
let SENTINEL_DECIMAL: Any = Decimal.parse("0")
let SENTINEL_DATETIME: Any = DateTime.parse("1970-01-01 00:00:00", "yyyy-MM-dd HH:mm:ss")
let _SENTINEL_BYTEBUFFER_FOR_STREAM: Any = ByteBuffer()
let SENTINEL_INPUTSTREAM: Any = _SENTINEL_BYTEBUFFER_FOR_STREAM
let SENTINEL_BYTEBUFFER: Any = _SENTINEL_BYTEBUFFER_FOR_STREAM

/* 路径 D 运行期类型归属判定的包内私有辅助函数 (仅供 get<T> / getOrNull<T> 内部使用)。 */
func isT<T>(probe: Any): Bool {
    return (probe as T).isSome()
}

func castTo<T>(v: Any): ?T {
    return v as T
}

/** SqliteValue → Bool。 */
public func valueFromSqliteBool(v: SqliteValue): Bool {
    boolFromSqlite(v)
}

/** SqliteValue → Int8。 */
public func valueFromSqliteInt8(v: SqliteValue): Int8 {
    int8FromSqlite(v)
}

/** SqliteValue → Int16。 */
public func valueFromSqliteInt16(v: SqliteValue): Int16 {
    int16FromSqlite(v)
}

/** SqliteValue → Int32。 */
public func valueFromSqliteInt32(v: SqliteValue): Int32 {
    int32FromSqlite(v)
}

/** SqliteValue → Int64。 */
public func valueFromSqliteInt64(v: SqliteValue): Int64 {
    int64FromSqlite(v)
}

/** SqliteValue → Float32。 */
public func valueFromSqliteFloat32(v: SqliteValue): Float32 {
    float32FromSqlite(v)
}

/** SqliteValue → Float64。 */
public func valueFromSqliteFloat64(v: SqliteValue): Float64 {
    float64FromSqlite(v)
}

/** SqliteValue → String。 */
public func valueFromSqliteString(v: SqliteValue): String {
    stringFromSqlite(v)
}

/** SqliteValue → Array<Byte>。 */
public func valueFromSqliteBytes(v: SqliteValue): Array<Byte> {
    bytesFromSqlite(v)
}

/** SqliteValue → Decimal。 */
public func valueFromSqliteDecimal(v: SqliteValue): Decimal {
    decimalFromSqlite(v)
}

/** SqliteValue → DateTime。 */
public func valueFromSqliteDateTime(v: SqliteValue): DateTime {
    dateTimeFromSqlite(v)
}

/** SqliteValue → InputStream。流式读取: 在已物化的字节上包一层 ByteBuffer, TEXT 按 UTF-8 编码后给出,
 * 于是 `valueFromSqliteInputStream(v)` 对 TEXT 列与 BLOB 列都成立。 */
public func valueFromSqliteInputStream(v: SqliteValue): InputStream {
    ByteBuffer(streamBytesFromSqlite(v))
}

/** SqliteValue → ByteBuffer。流式读取同上。 */
public func valueFromSqliteByteBuffer(v: SqliteValue): ByteBuffer {
    ByteBuffer(streamBytesFromSqlite(v))
}

/* 13 个具名可空公开桥接函数 (形态 b):
 * SQL NULL → None, 其余按具名非可空函数转换后 Some(...) 包装。 */

/** SQL NULL → None; 其他值按 valueFromSqliteBool 转换。 */
public func valueFromSqliteOrNullBool(v: SqliteValue): ?Bool {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(valueFromSqliteBool(v))
    }
}

/** SQL NULL → None; 其他值按 valueFromSqliteInt8 转换。 */
public func valueFromSqliteOrNullInt8(v: SqliteValue): ?Int8 {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(valueFromSqliteInt8(v))
    }
}

/** SQL NULL → None; 其他值按 valueFromSqliteInt16 转换。 */
public func valueFromSqliteOrNullInt16(v: SqliteValue): ?Int16 {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(valueFromSqliteInt16(v))
    }
}

/** SQL NULL → None; 其他值按 valueFromSqliteInt32 转换。 */
public func valueFromSqliteOrNullInt32(v: SqliteValue): ?Int32 {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(valueFromSqliteInt32(v))
    }
}

/** SQL NULL → None; 其他值按 valueFromSqliteInt64 转换。 */
public func valueFromSqliteOrNullInt64(v: SqliteValue): ?Int64 {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(valueFromSqliteInt64(v))
    }
}

/** SQL NULL → None; 其他值按 valueFromSqliteFloat32 转换。 */
public func valueFromSqliteOrNullFloat32(v: SqliteValue): ?Float32 {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(valueFromSqliteFloat32(v))
    }
}

/** SQL NULL → None; 其他值按 valueFromSqliteFloat64 转换。 */
public func valueFromSqliteOrNullFloat64(v: SqliteValue): ?Float64 {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(valueFromSqliteFloat64(v))
    }
}

/** SQL NULL → None; 其他值按 valueFromSqliteString 转换。 */
public func valueFromSqliteOrNullString(v: SqliteValue): ?String {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(valueFromSqliteString(v))
    }
}

/** SQL NULL → None; 其他值按 valueFromSqliteBytes 转换。 */
public func valueFromSqliteOrNullBytes(v: SqliteValue): ?Array<Byte> {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(valueFromSqliteBytes(v))
    }
}

/** SQL NULL → None; 其他值按 valueFromSqliteDecimal 转换。 */
public func valueFromSqliteOrNullDecimal(v: SqliteValue): ?Decimal {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(valueFromSqliteDecimal(v))
    }
}

/** SQL NULL → None; 其他值按 valueFromSqliteDateTime 转换。 */
public func valueFromSqliteOrNullDateTime(v: SqliteValue): ?DateTime {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(valueFromSqliteDateTime(v))
    }
}

/** SQL NULL → None; 其他值按 valueFromSqliteInputStream 转换。 */
public func valueFromSqliteOrNullInputStream(v: SqliteValue): ?InputStream {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(valueFromSqliteInputStream(v))
    }
}

/** SQL NULL → None; 其他值按 valueFromSqliteByteBuffer 转换。 */
public func valueFromSqliteOrNullByteBuffer(v: SqliteValue): ?ByteBuffer {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(valueFromSqliteByteBuffer(v))
    }
}

func boolFromSqlite(v: SqliteValue): Bool {
    match (v) {
        case SqliteValue.SNull => throw SqliteRuntimeException("result", "SQL NULL cannot be read as Bool")
        case SqliteValue.SInt(i) => i != 0
        case SqliteValue.SReal(f) => f != 0.0
        case SqliteValue.SText(s) => match (s.trimAscii().toAsciiLower()) {
            case "1" | "true" | "yes" | "on" => true
            case "0" | "false" | "no" | "off" => false
            case _ => throw SqliteRuntimeException("result", "cannot parse '${s}' as Bool")
        }
        case SqliteValue.SBlob(_) => throw SqliteRuntimeException("result", "BLOB cannot be read as Bool")
    }
}

func int64FromSqlite(v: SqliteValue): Int64 {
    match (v) {
        case SqliteValue.SNull => throw SqliteRuntimeException("result", "SQL NULL cannot be read as Int64")
        case SqliteValue.SInt(i) => i
        case SqliteValue.SReal(f) => Int64(f)
        case SqliteValue.SText(s) => try {
            Int64.parse(s.trimAscii())
        } catch (_: Exception) {
            throw SqliteRuntimeException("result", "cannot parse '${s}' as Int64")
        }
        case SqliteValue.SBlob(_) => throw SqliteRuntimeException("result", "BLOB cannot be read as Int64")
    }
}

func int8FromSqlite(v: SqliteValue): Int8 {
    let i = int64FromSqlite(v)
    if (i < Int64(Int8.Min) || i > Int64(Int8.Max)) {
        throw SqliteRuntimeException("result", "integer ${i} is out of Int8 range")
    }
    Int8(i)
}

func int16FromSqlite(v: SqliteValue): Int16 {
    let i = int64FromSqlite(v)
    if (i < Int64(Int16.Min) || i > Int64(Int16.Max)) {
        throw SqliteRuntimeException("result", "integer ${i} is out of Int16 range")
    }
    Int16(i)
}

func int32FromSqlite(v: SqliteValue): Int32 {
    let i = int64FromSqlite(v)
    if (i < Int64(Int32.Min) || i > Int64(Int32.Max)) {
        throw SqliteRuntimeException("result", "integer ${i} is out of Int32 range")
    }
    Int32(i)
}

func float64FromSqlite(v: SqliteValue): Float64 {
    match (v) {
        case SqliteValue.SNull => throw SqliteRuntimeException("result", "SQL NULL cannot be read as Float64")
        case SqliteValue.SInt(i) => Float64(i)
        case SqliteValue.SReal(f) => f
        case SqliteValue.SText(s) => try {
            Float64.parse(s.trimAscii())
        } catch (_: Exception) {
            throw SqliteRuntimeException("result", "cannot parse '${s}' as Float64")
        }
        case SqliteValue.SBlob(_) => throw SqliteRuntimeException("result", "BLOB cannot be read as Float64")
    }
}

func float32FromSqlite(v: SqliteValue): Float32 {
    Float32(float64FromSqlite(v))
}

func stringFromSqlite(v: SqliteValue): String {
    match (v) {
        case SqliteValue.SNull => throw SqliteRuntimeException("result", "SQL NULL cannot be read as String")
        case SqliteValue.SInt(i) => "${i}"
        case SqliteValue.SReal(f) => "${f}"
        case SqliteValue.SText(s) => s
        case SqliteValue.SBlob(_) => throw SqliteRuntimeException("result", "BLOB cannot be read as String")
    }
}

func bytesFromSqlite(v: SqliteValue): Array<Byte> {
    match (v) {
        case SqliteValue.SNull => throw SqliteRuntimeException("result", "SQL NULL cannot be read as Array<Byte>")
        case SqliteValue.SBlob(b) => b
        case _ => throw SqliteRuntimeException("result", "value is not a BLOB")
    }
}

/**
 * 供流式读取用的字节。
 *
 * 比 bytesFromSqlite 宽: 那一条只收 BLOB, 因为请求 `Array<Byte>` 的调用方是在读二进制列,
 * 把 TEXT 悄悄转成字节会掩盖列类型搞错。而请求流的调用方通常是在读"大列", 大列既可能是
 * BLOB 也可能是长 TEXT (CLOB 契约就是后者), 所以这里按 UTF-8 编码 TEXT。
 * 数值仍然拒绝 —— 对数值列要流没有合理解释。
 */
func streamBytesFromSqlite(v: SqliteValue): Array<Byte> {
    match (v) {
        case SqliteValue.SNull => throw SqliteRuntimeException("result", "SQL NULL cannot be read as a stream")
        case SqliteValue.SBlob(b) => b
        case SqliteValue.SText(s) => s.toArray()
        case _ => throw SqliteRuntimeException("result", "value is neither a BLOB nor TEXT")
    }
}

func decimalFromSqlite(v: SqliteValue): Decimal {
    match (v) {
        case SqliteValue.SNull => throw SqliteRuntimeException("result", "SQL NULL cannot be read as Decimal")
        case SqliteValue.SInt(i) => Decimal.parse("${i}")
        case SqliteValue.SReal(f) => Decimal.parse("${f}")
        case SqliteValue.SText(s) => try {
            Decimal.parse(s.trimAscii())
        } catch (_: Exception) {
            throw SqliteRuntimeException("result", "cannot parse '${s}' as Decimal")
        }
        case SqliteValue.SBlob(_) => throw SqliteRuntimeException("result", "BLOB cannot be read as Decimal")
    }
}

func dateTimeFromSqlite(v: SqliteValue): DateTime {
    match (v) {
        case SqliteValue.SNull => throw SqliteRuntimeException("result", "SQL NULL cannot be read as DateTime")
        case SqliteValue.SText(s) => try {
            DateTime.parse(s.trimAscii(), "yyyy-MM-dd HH:mm:ss")
        } catch (_: Exception) {
            throw SqliteRuntimeException("result", "cannot parse '${s}' as DateTime")
        }
        case _ => throw SqliteRuntimeException("result", "value is not a SQLite datetime text")
    }
}

/*
 * SqlDbType 兼容桥接，与泛型参数绑定和读取使用相同的类型转换规则。
 */
func sqlDbTypeToSqliteValue(p: SqlDbType): SqliteValue {
    match (p) {
        case v: SqlBigInt => SqliteValue.SInt(v.value)
        case v: SqlByte => SqliteValue.SInt(Int64(v.value))
        case v: SqlSmallInt => SqliteValue.SInt(Int64(v.value))
        case v: SqlInteger => SqliteValue.SInt(Int64(v.value))
        case v: SqlReal => SqliteValue.SReal(Float64(v.value))
        case v: SqlDouble => SqliteValue.SReal(v.value)
        case v: SqlBool => SqliteValue.SInt(if (v.value) {
            1
        } else {
            0
        })
        case v: SqlChar => SqliteValue.SText(v.value)
        case v: SqlVarchar => SqliteValue.SText(v.value)
        case v: SqlBinary => SqliteValue.SBlob(v.value)
        case v: SqlVarBinary => SqliteValue.SBlob(v.value)
        case v: SqlDecimal => SqliteValue.SText(v.value.toString())
        case v: SqlDate => SqliteValue.SText(formatDateTimeForSqlite(v.value))
        case v: SqlTime => SqliteValue.SText(formatDateTimeForSqlite(v.value))
        case v: SqlTimestamp => SqliteValue.SText(formatDateTimeForSqlite(v.value))
        case v: SqlTimeTz => SqliteValue.SText(formatDateTimeForSqlite(v.value))
        case v: SqlBlob => SqliteValue.SBlob(readStreamFully(v.value))
        case v: SqlClob => SqliteValue.SText(readClobFully(v.value))
        // Duration 没有对应的 SQLite 存储类型。存成整数纳秒或 ISO 文本都是本驱动自创的
        // 约定, 换个驱动读不出来, 所以宁可拒绝而不是猜一种编码。
        case _: SqlInterval => throw SqliteRuntimeException("bind",
            "std.database.sql Duration parameters are not supported by sqlite-driver: SQLite has no interval type")
        case v: SqlNullableBigInt => nullableParam(v.value, {x: Int64 => SqliteValue.SInt(x)})
        case v: SqlNullableByte => nullableParam(v.value, {x: Int8 => SqliteValue.SInt(Int64(x))})
        case v: SqlNullableSmallInt => nullableParam(v.value, {x: Int16 => SqliteValue.SInt(Int64(x))})
        case v: SqlNullableInteger => nullableParam(v.value, {x: Int32 => SqliteValue.SInt(Int64(x))})
        case v: SqlNullableReal => nullableParam(v.value, {x: Float32 => SqliteValue.SReal(Float64(x))})
        case v: SqlNullableDouble => nullableParam(v.value, {x: Float64 => SqliteValue.SReal(x)})
        case v: SqlNullableBool => nullableParam(v.value, {
            x: Bool => SqliteValue.SInt(if (x) {
                1
            } else {
                0
            })
        })
        case v: SqlNullableChar => nullableParam(v.value, {x: String => SqliteValue.SText(x)})
        case v: SqlNullableVarchar => nullableParam(v.value, {x: String => SqliteValue.SText(x)})
        case v: SqlNullableBinary => nullableParam(v.value, {x: Array<Byte> => SqliteValue.SBlob(x)})
        case v: SqlNullableVarBinary => nullableParam(v.value, {x: Array<Byte> => SqliteValue.SBlob(x)})
        case v: SqlNullableDecimal => nullableParam(v.value, {x: Decimal => SqliteValue.SText(x.toString())})
        case v: SqlNullableDate => nullableParam(v.value, {x: DateTime => SqliteValue.SText(formatDateTimeForSqlite(x))})
        case v: SqlNullableTime => nullableParam(v.value, {x: DateTime => SqliteValue.SText(formatDateTimeForSqlite(x))})
        case v: SqlNullableTimestamp => nullableParam(v.value,
            {x: DateTime => SqliteValue.SText(formatDateTimeForSqlite(x))})
        case v: SqlNullableTimeTz => nullableParam(v.value,
            {x: DateTime => SqliteValue.SText(formatDateTimeForSqlite(x))})
        case v: SqlNullableBlob => nullableParam(v.value, {x: InputStream => SqliteValue.SBlob(readStreamFully(x))})
        case v: SqlNullableClob => nullableParam(v.value, {x: InputStream => SqliteValue.SText(readClobFully(x))})
        case _: SqlNullableInterval => throw SqliteRuntimeException("bind",
            "std.database.sql Duration parameters are not supported by sqlite-driver: SQLite has no interval type")
        case _ => throw SqliteRuntimeException("bind", "unknown std.database.sql parameter type")
    }
}

private func nullableParam<T>(v: ?T, body: (T) -> SqliteValue): SqliteValue {
    match (v) {
        case None => SqliteValue.SNull
        case Some(x) => body(x)
    }
}

func writeSqlDbType(v: SqliteValue, slot: SqlDbType): Unit {
    match (slot) {
        case s: SqlBigInt => s.value = valueFromSqliteInt64(v)
        case s: SqlByte => s.value = valueFromSqliteInt8(v)
        case s: SqlSmallInt => s.value = valueFromSqliteInt16(v)
        case s: SqlInteger => s.value = valueFromSqliteInt32(v)
        case s: SqlReal => s.value = valueFromSqliteFloat32(v)
        case s: SqlDouble => s.value = valueFromSqliteFloat64(v)
        case s: SqlBool => s.value = valueFromSqliteBool(v)
        case s: SqlChar => s.value = valueFromSqliteString(v)
        case s: SqlVarchar => s.value = valueFromSqliteString(v)
        case s: SqlBinary => s.value = valueFromSqliteBytes(v)
        case s: SqlVarBinary => s.value = valueFromSqliteBytes(v)
        case s: SqlDecimal => s.value = valueFromSqliteDecimal(v)
        case s: SqlDate => s.value = valueFromSqliteDateTime(v)
        case s: SqlTime => s.value = valueFromSqliteDateTime(v)
        case s: SqlTimestamp => s.value = valueFromSqliteDateTime(v)
        case s: SqlTimeTz => s.value = valueFromSqliteDateTime(v)
        case s: SqlBlob => s.value = ByteBuffer(streamBytesFromSqlite(v))
        case s: SqlClob => s.value = ByteBuffer(stringFromSqlite(v).toArray())
        case _: SqlInterval => throw SqliteRuntimeException("result",
            "std.database.sql Duration results are not supported by sqlite-driver: SQLite has no interval type")
        case s: SqlNullableBigInt => s.value = valueFromSqliteOrNullInt64(v)
        case s: SqlNullableByte => s.value = valueFromSqliteOrNullInt8(v)
        case s: SqlNullableSmallInt => s.value = valueFromSqliteOrNullInt16(v)
        case s: SqlNullableInteger => s.value = valueFromSqliteOrNullInt32(v)
        case s: SqlNullableReal => s.value = valueFromSqliteOrNullFloat32(v)
        case s: SqlNullableDouble => s.value = valueFromSqliteOrNullFloat64(v)
        case s: SqlNullableBool => s.value = valueFromSqliteOrNullBool(v)
        case s: SqlNullableChar => s.value = valueFromSqliteOrNullString(v)
        case s: SqlNullableVarchar => s.value = valueFromSqliteOrNullString(v)
        case s: SqlNullableBinary => s.value = valueFromSqliteOrNullBytes(v)
        case s: SqlNullableVarBinary => s.value = valueFromSqliteOrNullBytes(v)
        case s: SqlNullableDecimal => s.value = valueFromSqliteOrNullDecimal(v)
        case s: SqlNullableDate => s.value = valueFromSqliteOrNullDateTime(v)
        case s: SqlNullableTime => s.value = valueFromSqliteOrNullDateTime(v)
        case s: SqlNullableTimestamp => s.value = valueFromSqliteOrNullDateTime(v)
        case s: SqlNullableTimeTz => s.value = valueFromSqliteOrNullDateTime(v)
        case s: SqlNullableBlob => s.value = nullableStream(v) {x => ByteBuffer(streamBytesFromSqlite(x))}
        case s: SqlNullableClob => s.value = nullableStream(v) {x => ByteBuffer(stringFromSqlite(x).toArray())}
        case _: SqlNullableInterval => throw SqliteRuntimeException("result",
            "std.database.sql Duration results are not supported by sqlite-driver: SQLite has no interval type")
        case _ => throw SqliteRuntimeException("result", "unknown std.database.sql result type")
    }
}

/** SQL NULL → None, 其余包成流。返回类型写成 ?InputStream 以匹配 SqlNullable*.value 的契约。 */
private func nullableStream(v: SqliteValue, body: (SqliteValue) -> ByteBuffer): ?InputStream {
    match (v) {
        case SqliteValue.SNull => None
        case _ => Some(body(v))
    }
}
