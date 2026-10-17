package itn_spire

import std.core.*
import std.random.*

/* Numeric widen/narrow via constructors — `as Int64`/`as Byte` always yield None. */
private func byteToInt(b: Byte): Int64 {
    Int64(b)
}

private func int64ToByte(v: Int64): Byte {
    UInt8(v)
}

/*
 * Parse a hyphenated or compact hex UUID into 16 raw bytes.
 *
 * The uuid crate (and therefore FastAPI's UUID path converter) also accepts a
 * lowercase "urn:uuid:" prefix and one matching brace pair — both come back 200
 * from the legacy service. Without the two strips below they were rejected with
 * a 422 while uuidParseError (which already handled them) reported no fault, so
 * the caller fell through to the generic "Invalid UUID" fallback. The strips
 * mirror uuidParseError exactly; adding them only turns previously-rejected
 * input into accepted input, never the reverse.
 *
 * Deliberately walks the UTF-8 bytes instead of String.replace:
 * Cangjie String.replace is replace-first only (replaceString is
 * replace-all), so stripping every '-' via replace left 34 chars
 * and made size != 32 reject every normal UUID.
 */
public func uuidParse(text: String): ?Array<Byte> {
    /*
     * Accept exactly the inputs FastAPI's UUID converter accepts: nothing
     * that uuidParseError() can describe. The old walk skipped every '-'
     * and never counted groups, so "-0000...", "....-0000-" and
     * "urn:uuid:"+36 hex (1 group) all yielded bytes while the 422 path
     * reported "group count expected 5, found N" — two halves of one
     * validator disagreeing about the same string. Gate on the strict side
     * so the accept path and the reject path can never drift apart again.
     */
    match (uuidParseError(text)) {
        case Some(_) => return None
        case None => ()
    }
    var s = text
    if (s.startsWith("urn:uuid:")) {
        s = s[9..s.size]
    } else {
        if (s.size >= 2 && s.startsWith("{") && s.endsWith("}")) {
            s = s[1..(s.size - 1)]
        }
    }
    let raw = s.toArray()
    let out = Array<Byte>(16, repeat: 0)
    var n: Int64 = 0
    var i: Int64 = 0
    while (i < raw.size) {
        if (byteToInt(raw[i]) == 45) {
            i += 1
            continue
        }
        if (i + 1 >= raw.size) {
            return None
        }
        let hi = hexVal(raw[i])
        let lo = hexVal(raw[i + 1])
        if (hi < 0 || lo < 0) {
            return None
        }
        if (n >= 16) {
            return None
        }
        out[n] = int64ToByte((hi << 4) | lo)
        n += 1
        i += 2
    }
    if (n != 16) {
        return None
    }
    return Some(out)
}

public func uuidFormat(bytes: Array<Byte>): String {
    if (bytes.size != 16) {
        return ""
    }
    var s = ""
    var i: Int64 = 0
    while (i < 16) {
        if (i == 4 || i == 6 || i == 8 || i == 10) {
            s = s + "-"
        }
        s = s + hex2(bytes[i])
        i += 1
    }
    return s
}

public func uuidV4(): Array<Byte> {
    let rnd = Random()
    let out = Array<Byte>(16, repeat: 0)
    var i: Int64 = 0
    while (i < 16) {
        let r = rnd.nextUInt8()
        out[i] = int64ToByte(byteToIntFromUInt8(r))
        i += 1
    }
    out[6] = int64ToByte((byteToInt(out[6]) & 0x0f) | 0x40)
    out[8] = int64ToByte((byteToInt(out[8]) & 0x3f) | 0x80)
    return out
}

private func byteToIntFromUInt8(v: UInt8): Int64 {
    Int64(v)
}

public func bytesToHex(bytes: Array<Byte>): String {
    var s = ""
    for (b in bytes) {
        s = s + hex2(b)
    }
    return s
}

/*
 * Python uuid.UUID.hex.upper() — what the presentation visibility clause binds
 * into "WHERE HEX(id)=%s". MySQL's HEX() returns uppercase, so the parameter
 * has to match case for the comparison to succeed.
 */
public func bytesToHexUpper(bytes: Array<Byte>): String {
    let digits = "0123456789ABCDEF"
    var s = ""
    for (b in bytes) {
        let v = byteToInt(b)
        s = s + byteToChar(digits[(v >> 4) & 0x0f])
        s = s + byteToChar(digits[v & 0x0f])
    }
    return s
}

public func hexToBytes(text: String): ?Array<Byte> {
    if (text.size % 2 != 0) {
        return None
    }
    let out = Array<Byte>(text.size / 2, repeat: 0)
    var i: Int64 = 0
    while (i < out.size) {
        let hi = hexVal(text[i * 2])
        let lo = hexVal(text[i * 2 + 1])
        if (hi < 0 || lo < 0) {
            return None
        }
        out[i] = int64ToByte((hi << 4) | lo)
        i += 1
    }
    return Some(out)
}

/* String indexing yields Byte; accept Byte so call sites stay simple. */
private func hexVal(ch: Byte): Int64 {
    let v = byteToInt(ch)
    if (v >= 48 && v <= 57) {
        return v - 48
    }
    if (v >= 97 && v <= 102) {
        return v - 87
    }
    if (v >= 65 && v <= 70) {
        return v - 55
    }
    return -1
}

private func hex2(b: Byte): String {
    let digits = "0123456789abcdef"
    let v = byteToInt(b)
    var out = ""
    out = out + byteToChar(digits[(v >> 4) & 0x0f])
    out = out + byteToChar(digits[v & 0x0f])
    return out
}

private func byteToChar(b: Byte): String {
    let arr = Array<Byte>(1, repeat: 0)
    arr[0] = b
    String.fromUtf8(arr)
}
