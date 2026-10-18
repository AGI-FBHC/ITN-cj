package itn_spire

import std.core.*
import std.convert.*
import stdx.encoding.json.*

/*
 * Python str semantics needed by the presentation teaching-moments port.
 *
 * Python indexes and slices strings by Unicode code point; its str.strip()
 * removes every character where str.isspace() is true. Cangjie's trimAscii only
 * handles ASCII, so these helpers re-implement the bits of Python that the
 * presentation response contract depends on.
 */

/*
 * Unicode code point of a Rune, decoded from its UTF-8 bytes.
 * Rune has no toUInt32(); String.toArray() yields UTF-8.
 */
func runeCode(r: Rune): Int64 {
    let b = r.toString().toArray()
    if (b.size == 1) {
        return Int64(b[0])
    }
    if (b.size == 2) {
        return ((Int64(b[0]) & 0x1f) * 64) + (Int64(b[1]) & 0x3f)
    }
    if (b.size == 3) {
        return ((Int64(b[0]) & 0x0f) * 4096) + ((Int64(b[1]) & 0x3f) * 64) + (Int64(b[2]) & 0x3f)
    }
    if (b.size == 4) {
        return ((Int64(b[0]) & 0x07) * 262144) + ((Int64(b[1]) & 0x3f) * 4096) +
               ((Int64(b[2]) & 0x3f) * 64) + (Int64(b[3]) & 0x3f)
    }
    return -1
}

/* Python str.isspace() — the Unicode whitespace set CPython uses for str. */
func isPySpace(r: Rune): Bool {
    let v = runeCode(r)
    if (v >= 0x09 && v <= 0x0d) {
        return true
    }
    if (v == 0x20) {
        return true
    }
    if (v == 0x85 || v == 0xa0) {
        return true
    }
    if (v == 0x1680) {
        return true
    }
    if (v >= 0x2000 && v <= 0x200a) {
        return true
    }
    if (v == 0x2028 || v == 0x2029) {
        return true
    }
    return v == 0x202f || v == 0x205f || v == 0x3000
}

/* Python str.strip() with no arguments. */
func pyStrip(text: String): String {
    let rs = text.toRuneArray()
    var a: Int64 = 0
    var b = rs.size
    while (a < b && isPySpace(rs[a])) {
        a += 1
    }
    while (b > a && isPySpace(rs[b - 1])) {
        b -= 1
    }
    var out = ""
    var i = a
    while (i < b) {
        out = out + rs[i].toString()
        i += 1
    }
    return out
}

/* Python str.rstrip() — drop trailing whitespace only. */
func pyRStrip(text: String): String {
    let rs = text.toRuneArray()
    var b = rs.size
    while (b > 0 && isPySpace(rs[b - 1])) {
        b -= 1
    }
    var out = ""
    var i = 0
    while (i < b) {
        out = out + rs[i].toString()
        i += 1
    }
    return out
}

/* Python str.lstrip() — drop leading whitespace only. */
func pyLStrip(text: String): String {
    let rs = text.toRuneArray()
    var a: Int64 = 0
    while (a < rs.size && isPySpace(rs[a])) {
        a += 1
    }
    var out = ""
    var i = a
    while (i < rs.size) {
        out = out + rs[i].toString()
        i += 1
    }
    return out
}

/* Re-join a rune slice as a String (avoids re-wrapping pySlice). */
func runesToString(rs: Array<Rune>, a: Int64, b: Int64): String {
    var out = ""
    var i = a
    while (i < b) {
        out = out + rs[i].toString()
        i += 1
    }
    return out
}

/* Python str[a:b] — both indices are code points; out-of-range clamps. */
func pySlice(text: String, start: Int64, end: Int64): String {
    let rs = text.toRuneArray()
    var a = start
    var b = end
    if (a < 0) {
        a = 0
    }
    if (b > rs.size) {
        b = rs.size
    }
    if (a > b) {
        return ""
    }
    var out = ""
    var i = a
    while (i < b) {
        out = out + rs[i].toString()
        i += 1
    }
    return out
}

/* Python str.find(sub) — code-point index of the first occurrence, else -1. */
func pyFind(haystack: String, needle: String): Int64 {
    if (needle.isEmpty()) {
        return 0
    }
    let h = haystack.toRuneArray()
    let n = needle.toRuneArray()
    if (n.size > h.size) {
        return -1
    }
    var i: Int64 = 0
    while (i + n.size <= h.size) {
        var ok = true
        var j: Int64 = 0
        while (j < n.size) {
            if (h[i + j] != n[j]) {
                ok = false
                break
            }
            j += 1
        }
        if (ok) {
            return i
        }
        i += 1
    }
    return -1
}

/*
 * Python re.sub(r"^\s*#{1,6}\s*", "", text).strip().
 *
 * When there is no run of 1-6 '#' after optional leading whitespace the regex
 * does not match at all, so the text is left unchanged and only the trailing
 * .strip() applies — that is why the no-match branch returns pyStrip(text).
 */
func pyStripHeadingMarks(text: String): String {
    let rs = text.toRuneArray()
    var i: Int64 = 0
    while (i < rs.size && isPySpace(rs[i])) {
        i += 1
    }
    var hashes: Int64 = 0
    while (i < rs.size && hashes < 6 && runeCode(rs[i]) == 0x23) {
        i += 1
        hashes += 1
    }
    if (hashes == 0) {
        return pyStrip(text)
    }
    while (i < rs.size && isPySpace(rs[i])) {
        i += 1
    }
    return pyStrip(pySlice(text, i, rs.size))
}

/*
 * Python round(x, ndigits) — half-to-even at the given decimal place.
 * Cangjie Float64.round() is half-away-from-zero, which disagrees at exact
 * halves. The pre-snap absorbs binary-float noise in products such as
 * len(note) * 0.72 so the halfway rule sees the decimal value Python sees.
 */
func pythonRoundFloat(v: Float64, digits: Int64): Float64 {
    var scale: Float64 = 1.0
    var k: Int64 = 0
    while (k < digits) {
        scale = scale * 10.0
        k += 1
    }
    let snapped = roundFloatTo12(v * scale)
    let n = truncateFloat(snapped)
    let fracRaw = snapped - floatFromInt(n)
    var frac = fracRaw
    if (frac < 0.0) {
        frac = 0.0 - frac
    }
    var rounded: Float64 = floatFromInt(n)
    if (frac > 0.5) {
        rounded = floatFromInt(n) + 1.0
    } else if (frac < 0.5) {
        rounded = floatFromInt(n)
    } else if (n % 2 != 0) {
        rounded = floatFromInt(n) + 1.0
    }
    return rounded / scale
}

private func roundFloatTo12(v: Float64): Float64 {
    let shifted = v * 1e12
    let n = truncateFloat(shifted)
    let frac = shifted - floatFromInt(n)
    var adj = floatFromInt(n)
    if (frac > 0.5) {
        adj = floatFromInt(n) + 1.0
    } else if (frac < -0.5) {
        adj = floatFromInt(n) - 1.0
    }
    return adj / 1e12
}

/* Python bool(value) on a parsed JSON value. */
func jsonValTruthy(v: JsonValue): Bool {
    match (v.kind()) {
        case JsonKind.JsNull => return false
        case JsonKind.JsBool => return v.asBool().getValue()
        case JsonKind.JsInt => return v.asInt().getValue() != 0
        case JsonKind.JsFloat => return v.asFloat().getValue() != 0.0
        case JsonKind.JsString => return !v.asString().getValue().isEmpty()
        case JsonKind.JsArray => return v.asArray().size() > 0
        case JsonKind.JsObject =>
            for ((_, _) in v.asObject().getFields()) {
                return true
            }
            return false
    }
}
