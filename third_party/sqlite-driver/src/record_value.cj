package sqlite_driver

import std.convert.*
import std.math.*

/*
 * SqliteValue: SQLite 的 5 种存储类。
 *
 * 没有 SBool。SQLite 使用整数 0/1 表示布尔值，只保留 5 个变体可以保证读取、绑定与相等
 * 比较采用同一种表示，避免布尔参数无法匹配已存整数。
 */
public enum SqliteValue {
    | SNull
    | SInt(Int64)
    | SReal(Float64)
    | SText(String)
    | SBlob(Array<Byte>)
}

/** 存储类的排序序号: NULL < INTEGER = REAL < TEXT < BLOB。 */
func storageClassRank(v: SqliteValue): Int64 {
    match (v) {
        case SNull => 0
        case SInt(_) => 1
        case SReal(_) => 1
        case SText(_) => 2
        case SBlob(_) => 3
    }
}

/** 类型亲和性。列声明的类型名按 SQLite 的规则归到这 5 类。 */
public enum SqliteAffinity {
    | AffInteger
    | AffReal
    | AffNumeric
    | AffText
    | AffBlob
}

/**
 * 按 SQLite 的规则从列声明类型推亲和性。
 *
 * 规则本身是"按子串出现顺序判定"的, 顺序不能改: 含 INT → INTEGER; 含 CHAR/CLOB/TEXT
 * → TEXT; 含 BLOB 或类型为空 → BLOB; 含 REAL/FLOA/DOUB → REAL; 其余 → NUMERIC。
 * 例如 "INTEGER" 同时含 INT, 先判 INT 才对; "VARCHAR" 含 CHAR 归 TEXT。
 */
func affinityOf(declaredType: String): SqliteAffinity {
    let t = declaredType.toAsciiUpper()
    if (t.isEmpty()) {
        return SqliteAffinity.AffBlob
    }
    if (t.contains("INT")) {
        return SqliteAffinity.AffInteger
    }
    if (t.contains("CHAR") || t.contains("CLOB") || t.contains("TEXT")) {
        return SqliteAffinity.AffText
    }
    if (t.contains("BLOB")) {
        return SqliteAffinity.AffBlob
    }
    if (t.contains("REAL") || t.contains("FLOA") || t.contains("DOUB")) {
        return SqliteAffinity.AffReal
    }
    SqliteAffinity.AffNumeric
}

/** 值是否是数值存储类。 */
func isNumericValue(v: SqliteValue): Bool {
    match (v) {
        case SInt(_) => true
        case SReal(_) => true
        case _ => false
    }
}

/**
 * 把文本尽力解析成数值; 解析不出则返回 None。
 *
 * "尽力"的界与 SQLite 一致: 允许前后空白与前缀符号, 但**不允许尾部有非数字残留**
 * (`'12abc'` 不是数值)。这一点直接决定 `'42'` 进 INTEGER 列会不会变整数。
 */
func textToNumber(s: String): Option<SqliteValue> {
    let t = s.trimAscii()
    if (t.isEmpty()) {
        return None
    }
    // 整数优先: 能表达成 Int64 就用 Int64, 否则退到 Float64 (与 SQLite 相同)。
    if (looksLikeInteger(t)) {
        try {
            return Some(SqliteValue.SInt(Int64.parse(t)))
        } catch (_: Exception) {
            // 溢出 Int64: 退到浮点。
            try {
                return Some(SqliteValue.SReal(Float64.parse(t)))
            } catch (_: Exception) {
                return None
            }
        }
    }
    if (looksLikeReal(t)) {
        try {
            return Some(SqliteValue.SReal(Float64.parse(t)))
        } catch (_: Exception) {
            return None
        }
    }
    None
}

func looksLikeInteger(t: String): Bool {
    let bs = t.toArray()
    var i = 0
    if (i < bs.size && (bs[i] == UInt8(b'+') || bs[i] == UInt8(b'-'))) {
        i++
    }
    if (i >= bs.size) {
        return false
    }
    while (i < bs.size) {
        if (bs[i] < UInt8(b'0') || bs[i] > UInt8(b'9')) {
            return false
        }
        i++
    }
    true
}

func looksLikeReal(t: String): Bool {
    let bs = t.toArray()
    var i = 0
    if (i < bs.size && (bs[i] == UInt8(b'+') || bs[i] == UInt8(b'-'))) {
        i++
    }
    var digits = 0
    while (i < bs.size && bs[i] >= UInt8(b'0') && bs[i] <= UInt8(b'9')) {
        i++
        digits++
    }
    if (i < bs.size && bs[i] == UInt8(b'.')) {
        i++
        while (i < bs.size && bs[i] >= UInt8(b'0') && bs[i] <= UInt8(b'9')) {
            i++
            digits++
        }
    }
    if (digits == 0) {
        return false
    }
    if (i < bs.size && (bs[i] == UInt8(b'e') || bs[i] == UInt8(b'E'))) {
        i++
        if (i < bs.size && (bs[i] == UInt8(b'+') || bs[i] == UInt8(b'-'))) {
            i++
        }
        var expDigits = 0
        while (i < bs.size && bs[i] >= UInt8(b'0') && bs[i] <= UInt8(b'9')) {
            i++
            expDigits++
        }
        if (expDigits == 0) {
            return false
        }
    }
    i == bs.size
}

/**
 * 应用列亲和性: 存入某列前的值转换。
 *
 * 若不应用亲和性，`'42'` 存进 INTEGER 列后仍是文本，后续 `WHERE n = 42` 会按存储类排序
 * 判定 TEXT > INTEGER，导致条件恒不相等且不报错。
 */
func applyAffinity(v: SqliteValue, aff: SqliteAffinity): SqliteValue {
    match (v) {
        case SNull => v
        case _ => match (aff) {
            case AffBlob => v
            case AffText => match (v) {
                case SInt(i) => SqliteValue.SText("${i}")
                case SReal(f) => SqliteValue.SText(formatReal(f))
                case _ => v
            }
            case AffInteger => toIntegerAffinity(v)
            case AffReal => toRealAffinity(v)
            case AffNumeric => toNumericAffinity(v)
        }
    }
}

/** INTEGER 亲和性: 能无损变成整数就变, 否则保留原值。 */
func toIntegerAffinity(v: SqliteValue): SqliteValue {
    match (v) {
        case SText(s) => match (textToNumber(s)) {
            case Some(num) => toIntegerAffinity(num)
            case None => v
        }
        case SReal(f) =>
            // 只有能精确回到同一浮点值时才转 —— 3.5 存进 INTEGER 列仍是 3.5。
            if (f >= -9.2233720368547758e18 && f <= 9.2233720368547758e18) {
                let i = Int64(f)
                if (Float64(i) == f) {
                    SqliteValue.SInt(i)
                } else {
                    v
                }
            } else {
                v
            }
        case _ => v
    }
}

/** REAL 亲和性: 一律变成浮点 (整数也转)。 */
func toRealAffinity(v: SqliteValue): SqliteValue {
    match (v) {
        case SText(s) => match (textToNumber(s)) {
            case Some(num) => toRealAffinity(num)
            case None => v
        }
        case SInt(i) => SqliteValue.SReal(Float64(i))
        case _ => v
    }
}

/** NUMERIC 亲和性: 能变数值就变, 整数优先, 但不把整数强转成浮点。 */
func toNumericAffinity(v: SqliteValue): SqliteValue {
    match (v) {
        case SText(s) => match (textToNumber(s)) {
            case Some(num) => num
            case None => v
        }
        case SReal(f) =>
            if (f >= -9.2233720368547758e18 && f <= 9.2233720368547758e18) {
                let i = Int64(f)
                if (Float64(i) == f) {
                    SqliteValue.SInt(i)
                } else {
                    v
                }
            } else {
                v
            }
        case _ => v
    }
}

/**
 * 浮点的最短往返文本形式。
 *
 * 不能用 `"${f}"`: 仓颉的 Float64 转字符串恒定 6 位小数, 于是 1e300 会打成 309 位
 * 数字、0.1 打成 0.100000。SQLite 打印的是"能解析回同一个值的最短形式"。
 * 做法: 从 15 位有效数字起递增到 17, 取第一个解析回原值的; 再补上 SQLite 的两条
 * 排版习惯 —— 整数值带 `.0`, 科学计数法的尾数也带小数点。
 */
func formatReal(f: Float64): String {
    if (f.isNaN()) {
        // SQLite 把 NaN 存成 NULL, 走到这里说明是计算中间态, 打印成空串与它一致。
        return ""
    }
    if (f == Float64.Inf) {
        return "Inf"
    }
    if (f == -Float64.Inf) {
        return "-Inf"
    }
    var text = f.format(".17g")
    for (p in 15..18) {
        let s = f.format(".${p}g")
        if (Float64.parse(s) == f) {
            text = s
            break
        }
    }
    ensureRealLooksReal(text)
}

/** 给整数形态的浮点文本补 `.0`, 使 2.0 打成 "2.0" 而不是 "2" (与 SQLite 一致)。 */
func ensureRealLooksReal(text: String): String {
    if (text.contains("Inf") || text.contains("NaN")) {
        return text
    }
    let ePos = text.indexOf("e") ?? text.indexOf("E") ?? -1
    if (ePos < 0) {
        if (text.contains(".")) {
            return text
        }
        return "${text}.0"
    }
    let mantissa = text[0..ePos]
    let exponent = text[ePos..text.size]
    if (mantissa.contains(".")) {
        return text
    }
    "${mantissa}.0${exponent}"
}

/** 值转成文本形式, 供 CAST / 拼接 / TEXT 亲和性使用。 */
func valueToText(v: SqliteValue): String {
    match (v) {
        case SNull => ""
        case SInt(i) => "${i}"
        case SReal(f) => formatReal(f)
        case SText(s) => s
        case SBlob(bs) =>
            // BLOB 转文本按字节序列解释; 非法 UTF-8 时退回十六进制而不是抛 ——
            // CAST(x'ff' AS TEXT) 在 SQLite 里也不报错。
            try {
            String.fromUtf8(bs)
        } catch (_: Exception) {
            bytesToHex(bs)
        }
    }
}

/** 值的真假判定 (WHERE 用): 0 与 0.0 与空/非数值文本为假。 */
func valueIsTrue(v: SqliteValue): Bool {
    match (v) {
        case SNull => false
        case SInt(i) => i != 0
        case SReal(f) => f != 0.0
        case SText(s) => match (textToNumber(s)) {
            case Some(SInt(i)) => i != 0
            case Some(SReal(f)) => f != 0.0
            case _ => false
        }
        case SBlob(bs) => bs.size > 0 && !allZero(bs)
    }
}

func allZero(bs: Array<Byte>): Bool {
    for (b in bs) {
        if (b != 0) {
            return false
        }
    }
    true
}

/** 取值的数值形态 (Float64), 非数值按 0 计 —— 与 SQLite 的算术规则一致。 */
func valueToFloat(v: SqliteValue): Float64 {
    match (v) {
        case SInt(i) => Float64(i)
        case SReal(f) => f
        case SText(s) => match (textToNumber(s)) {
            case Some(SInt(i)) => Float64(i)
            case Some(SReal(f)) => f
            case _ => 0.0
        }
        case SBlob(_) => 0.0
        case SNull => 0.0
    }
}

/** 取值的整数形态, 浮点向零截断。 */
func valueToInt(v: SqliteValue): Int64 {
    match (v) {
        case SInt(i) => i
        case SReal(f) => floatToInt(f)
        case SText(s) => match (textToNumber(s)) {
            case Some(SInt(i)) => i
            case Some(SReal(f)) => floatToInt(f)
            case _ => 0
        }
        case _ => 0
    }
}

/** 浮点转整数, 越界时钳到 Int64 边界 (仓颉的 Int64(f) 越界会抛)。 */
func floatToInt(f: Float64): Int64 {
    if (f.isNaN()) {
        return 0
    }
    if (f >= 9.2233720368547758e18) {
        return Int64.Max
    }
    if (f <= -9.2233720368547758e18) {
        return Int64.Min
    }
    Int64(trunc(f))
}

const HEX_DIGITS: String = "0123456789ABCDEF"

func bytesToHex(bs: Array<Byte>): String {
    let digits = HEX_DIGITS.toArray()
    let out = Array<Byte>(bs.size * 2, repeat: 0)
    for (i in 0..bs.size) {
        out[i * 2] = digits[Int64(bs[i] >> 4)]
        out[i * 2 + 1] = digits[Int64(bs[i] & 0x0F)]
    }
    String.fromUtf8(out)
}
