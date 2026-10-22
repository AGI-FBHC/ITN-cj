package sqlite_driver

/*
 * SQLite 的比较与排序规则。
 *
 * 两条规则决定一切:
 *   1. 跨存储类的顺序固定为 NULL < INTEGER/REAL < TEXT < BLOB。同类内部才比值。
 *      整数与浮点属同一类, 混比时按数值 (且要防精度丢失, 见 compareIntReal)。
 *   2. TEXT 之间的顺序由 collation 决定: BINARY (逐字节)、NOCASE (ASCII 忽略大小写)、
 *      RTRIM (忽略尾部空格)。索引里存的是按建索引时的 collation 排好的顺序,
 *      查询若用另一种 collation, 索引就用不上 —— 所以 collation 必须随列一起记。
 */

/** 排序用的三值结果。 */
const CMP_LT: Int64 = -1
const CMP_EQ: Int64 = 0
const CMP_GT: Int64 = 1

public enum SqliteCollation {
    | CollBinary
    | CollNocase
    | CollRtrim
}

func collationByName(name: String): SqliteCollation {
    match (name.toAsciiUpper()) {
        case "BINARY" => SqliteCollation.CollBinary
        case "NOCASE" => SqliteCollation.CollNocase
        case "RTRIM" => SqliteCollation.CollRtrim
        case _ => throw SqliteRuntimeException("collation", "no such collation sequence: ${name}")
    }
}

func collationName(c: SqliteCollation): String {
    match (c) {
        case CollBinary => "BINARY"
        case CollNocase => "NOCASE"
        case CollRtrim => "RTRIM"
    }
}

/**
 * 比较两个值。NULL 参与排序时最小 (ORDER BY 用), 但相等判定另走 nullAwareEquals ——
 * SQL 里 `NULL = NULL` 是 NULL 而不是真, 两者不能混用同一个函数。
 */
func compareValues(a: SqliteValue, b: SqliteValue, coll: SqliteCollation): Int64 {
    let ra = storageClassRank(a)
    let rb = storageClassRank(b)
    if (ra != rb) {
        return if (ra < rb) {
            CMP_LT
        } else {
            CMP_GT
        }
    }
    match ((a, b)) {
        case (SNull, SNull) => CMP_EQ
        case (SInt(x), SInt(y)) => compareInt(x, y)
        case (SReal(x), SReal(y)) => compareFloat(x, y)
        case (SInt(x), SReal(y)) => compareIntReal(x, y)
        case (SReal(x), SInt(y)) => -compareIntReal(y, x)
        case (SText(x), SText(y)) => compareText(x, y, coll)
        case (SBlob(x), SBlob(y)) => compareBytes(x, y)
        case _ => CMP_EQ
    }
}

func compareInt(x: Int64, y: Int64): Int64 {
    if (x < y) {
        CMP_LT
    } else if (x > y) {
        CMP_GT
    } else {
        CMP_EQ
    }
}

func compareFloat(x: Float64, y: Float64): Int64 {
    if (x < y) {
        CMP_LT
    } else if (x > y) {
        CMP_GT
    } else {
        CMP_EQ
    }
}

/**
 * 整数与浮点比较。
 *
 * 不能简单地 `Float64(x) < y`: Int64 超过 2^53 时转 Float64 会丢精度, 于是
 * 9007199254740993 与 9007199254740992.0 会被判成相等。先按浮点粗比, 只在浮点相等
 * 且整数超出精确范围时才退回精确路径。
 */
func compareIntReal(x: Int64, y: Float64): Int64 {
    if (y.isNaN()) {
        // NaN 在 SQLite 里存为 NULL, 走到这里只能是计算中间态; 判整数更大以保证全序。
        return CMP_GT
    }
    if (y == Float64.Inf) {
        return CMP_LT
    }
    if (y == -Float64.Inf) {
        return CMP_GT
    }
    let fx = Float64(x)
    if (fx < y) {
        return CMP_LT
    }
    if (fx > y) {
        return CMP_GT
    }
    // 浮点看起来相等: 若 y 有小数部分, 按小数部分定序; 否则确实相等。
    let yi = floatToInt(y)
    if (Float64(yi) != y) {
        return if (y > Float64(yi)) {
            CMP_LT
        } else {
            CMP_GT
        }
    }
    compareInt(x, yi)
}

func compareText(x: String, y: String, coll: SqliteCollation): Int64 {
    match (coll) {
        case CollBinary => compareBytes(x.toArray(), y.toArray())
        case CollNocase => compareBytes(x.toAsciiLower().toArray(), y.toAsciiLower().toArray())
        case CollRtrim => compareBytes(rtrimSpaces(x.toArray()), rtrimSpaces(y.toArray()))
    }
}

func rtrimSpaces(bs: Array<Byte>): Array<Byte> {
    var end = bs.size
    while (end > 0 && bs[end - 1] == UInt8(b' ')) {
        end -= 1
    }
    bs[0..end]
}

/** 逐字节无符号比较, 前缀较短者在前 (memcmp 语义)。 */
func compareBytes(x: Array<Byte>, y: Array<Byte>): Int64 {
    let n = if (x.size < y.size) {
        x.size
    } else {
        y.size
    }
    for (i in 0..n) {
        if (x[i] != y[i]) {
            return if (x[i] < y[i]) {
                CMP_LT
            } else {
                CMP_GT
            }
        }
    }
    if (x.size < y.size) {
        CMP_LT
    } else if (x.size > y.size) {
        CMP_GT
    } else {
        CMP_EQ
    }
}

/**
 * SQL 的相等判定: 任一侧为 NULL 则结果未知 (None)。
 *
 * 与 compareValues 分开是三值逻辑的要求。若共用排序比较，NULL 会得到"相等"或"不相等"
 * 的确定答案，WHERE 就可能错误选中 NULL 行。
 */
func nullAwareEquals(a: SqliteValue, b: SqliteValue, coll: SqliteCollation): Option<Bool> {
    match ((a, b)) {
        case (SNull, _) => None
        case (_, SNull) => None
        case _ => Some(compareValues(a, b, coll) == CMP_EQ)
    }
}

/**
 * 比较用的类型统一: 一侧数值、另一侧文本时, SQLite 按**列亲和性**决定谁转向谁。
 *
 * 没有列上下文 (如两个字面量比) 时不转换, 于是 `'1' = 1` 为假 —— 这与 SQLite 一致,
 * 是它一个常被误解但确定的行为。
 */
func applyComparisonAffinity(v: SqliteValue, aff: Option<SqliteAffinity>): SqliteValue {
    match (aff) {
        case None => v
        case Some(a) => match (a) {
            case AffText => match (v) {
                case SInt(_) => SqliteValue.SText(valueToText(v))
                case SReal(_) => SqliteValue.SText(valueToText(v))
                case _ => v
            }
            case AffBlob => v
            case _ => match (v) {
                // 数值亲和性: 文本转数值, 转不动则保留 (于是仍按存储类排序, 文本 > 数值)。
                case SText(s) => match (textToNumber(s)) {
                    case Some(num) => num
                    case None => v
                }
                case _ => v
            }
        }
    }
}

/** 索引键 (多列) 比较: 逐列比, 每列可有独立的 collation 与升降序。 */
func compareIndexKeys(a: Array<SqliteValue>, b: Array<SqliteValue>, colls: Array<SqliteCollation>, descs: Array<Bool>): Int64 {
    let n = if (a.size < b.size) {
        a.size
    } else {
        b.size
    }
    for (i in 0..n) {
        let coll = if (i < colls.size) {
            colls[i]
        } else {
            SqliteCollation.CollBinary
        }
        var c = compareValues(a[i], b[i], coll)
        if (i < descs.size && descs[i]) {
            c = -c
        }
        if (c != CMP_EQ) {
            return c
        }
    }
    // 前缀相同: 短的在前。索引查找用前缀键时靠这条命中区间起点。
    if (a.size < b.size) {
        CMP_LT
    } else if (a.size > b.size) {
        CMP_GT
    } else {
        CMP_EQ
    }
}
