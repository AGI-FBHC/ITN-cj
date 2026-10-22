package itn_spire

import std.core.*
import std.collection.*

/*
 * SQL literal helpers for the MySQL text protocol.
 * Binary UUIDs are inlined as X'hex' so parameter binding is not required.
 *
 * Escaping walks UTF-8 bytes and copies non-special bytes through unchanged;
 * decoding one byte at a time via String.fromUtf8 throws on multi-byte runes.
 */
public func sqlQuote(value: String): String {
    let bytes = value.toArray()
    let out = ArrayList<Byte>()
    out.add(UInt8(39)) /* ' */
    var i: Int64 = 0
    while (i < bytes.size) {
        let b = bytes[i]
        let bi = Int64(b)
        if (bi == 92) { /* \ */
            out.add(UInt8(92))
            out.add(UInt8(92))
        } else if (bi == 39) { /* ' */
            out.add(UInt8(92))
            out.add(UInt8(39))
        } else if (bi == 34) { /* " */
            out.add(UInt8(92))
            out.add(UInt8(34))
        } else if (bi == 10) { /* \n */
            out.add(UInt8(92))
            out.add(UInt8(110))
        } else if (bi == 13) { /* \r */
            out.add(UInt8(92))
            out.add(UInt8(114))
        } else if (bi == 0) {
            out.add(UInt8(92))
            out.add(UInt8(48))
        } else if (bi == 26) {
            out.add(UInt8(92))
            out.add(UInt8(90))
        } else {
            out.add(b)
        }
        i += 1
    }
    out.add(UInt8(39))
    return String.fromUtf8(out.toArray())
}

public func sqlBinary(bytes: Array<Byte>): String {
    "X'" + bytesToHex(bytes) + "'"
}

public func sqlNull(): String {
    "NULL"
}

public func sqlOptString(value: ?String): String {
    match (value) {
        case Some(v) => sqlQuote(v)
        case None => sqlNull()
    }
}

public func sqlOptBinary(value: ?Array<Byte>): String {
    match (value) {
        case Some(v) => sqlBinary(v)
        case None => sqlNull()
    }
}

public func sqlInt(value: Int64): String {
    value.toString()
}

public func sqlOptInt(value: ?Int64): String {
    match (value) {
        case Some(v) => v.toString()
        case None => sqlNull()
    }
}

/* MySQL DATETIME(6) literal. */
public func sqlNowLiteral(): String {
    sqlQuote(mysqlDatetime(nowUtcParts()))
}

public struct TimeParts {
    public let year: Int64
    public let month: Int64
    public let day: Int64
    public let hour: Int64
    public let minute: Int64
    public let second: Int64
    public let micros: Int64

    public init(year: Int64, month: Int64, day: Int64, hour: Int64, minute: Int64,
                second: Int64, micros: Int64) {
        this.year = year
        this.month = month
        this.day = day
        this.hour = hour
        this.minute = minute
        this.second = second
        this.micros = micros
    }
}

/* "yyyy-MM-dd HH:mm:ss.SSSSSS" for DATETIME(6) columns. */
public func mysqlDatetime(p: TimeParts): String {
    pad4(p.year) + "-" + pad2(p.month) + "-" + pad2(p.day) + " " +
        pad2(p.hour) + ":" + pad2(p.minute) + ":" + pad2(p.second) + "." + pad6(p.micros)
}

/* "yyyy-MM-ddTHH:mm:ss.SSSSSS" matching Python datetime.isoformat(). */
public func isoDatetime(p: TimeParts): String {
    pad4(p.year) + "-" + pad2(p.month) + "-" + pad2(p.day) + "T" +
        pad2(p.hour) + ":" + pad2(p.minute) + ":" + pad2(p.second) + "." + pad6(p.micros)
}

public func pad2(v: Int64): String {
    if (v < 10) {
        return "0" + v.toString()
    }
    return v.toString()
}

public func pad4(v: Int64): String {
    var s = v.toString()
    while (s.size < 4) {
        s = "0" + s
    }
    return s
}

public func pad6(v: Int64): String {
    var s = v.toString()
    while (s.size < 6) {
        s = "0" + s
    }
    return s
}
