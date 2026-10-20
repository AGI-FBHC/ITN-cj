package zhixun_learning

import std.core.*
import std.collection.*
import std.convert.*
import std.math.*
import std.math.numeric.*
import stdx.encoding.json.*

public func jsonParse(text: String): ?JsonValue {
    try {
        return Some(JsonValue.fromStr(text))
    } catch (_: Exception) {
        return None
    }
}

public func jsonGetString(obj: JsonObject, key: String): ?String {
    match (obj.get(key)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsString => return Some(v.asString().getValue())
                case JsonKind.JsInt => return Some(v.asInt().getValue().toString())
                case _ => return None
            }
        case None => return None
    }
}

public func jsonGetInt(obj: JsonObject, key: String): ?Int64 {
    match (obj.get(key)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsInt => return Some(v.asInt().getValue())
                case JsonKind.JsString => return Int64.tryParse(v.asString().getValue())
                case _ => return None
            }
        case None => return None
    }
}

public func jsonGetBool(obj: JsonObject, key: String): ?Bool {
    match (obj.get(key)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsBool => return Some(v.asBool().getValue())
                case _ => return None
            }
        case None => return None
    }
}

public func jsonGetArray(obj: JsonObject, key: String): ?JsonArray {
    match (obj.get(key)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsArray => return Some(v.asArray())
                case _ => return None
            }
        case None => return None
    }
}

public func jsonGetObject(obj: JsonObject, key: String): ?JsonObject {
    match (obj.get(key)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsObject => return Some(v.asObject())
                case _ => return None
            }
        case None => return None
    }
}

public func jsonGetFloat(obj: JsonObject, key: String): ?Float64 {
    match (obj.get(key)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsFloat => return Some(v.asFloat().getValue())
                case JsonKind.JsInt => return Some(Float64(v.asInt().getValue()))
                case JsonKind.JsString => return Float64.tryParse(v.asString().getValue())
                case _ => return None
            }
        case None => return None
    }
}

public func jsonHas(obj: JsonObject, key: String): Bool {
    obj.containsKey(key)
}

/* JsonKind has no ==; use these instead of kind() == ... */
public func isJsObject(v: JsonValue): Bool {
    match (v.kind()) {
        case JsonKind.JsObject => return true
        case _ => return false
    }
}

public func isJsString(v: JsonValue): Bool {
    match (v.kind()) {
        case JsonKind.JsString => return true
        case _ => return false
    }
}

public func isJsArray(v: JsonValue): Bool {
    match (v.kind()) {
        case JsonKind.JsArray => return true
        case _ => return false
    }
}

public func isJsBool(v: JsonValue): Bool {
    match (v.kind()) {
        case JsonKind.JsBool => return true
        case _ => return false
    }
}

public func jsonIsNull(obj: JsonObject, key: String): Bool {
    match (obj.get(key)) {
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsNull => return true
                case _ => return false
            }
        case None => return false
    }
}

/* Build a JSON string value without re-parsing the text as JSON. */
public func jstr(value: String): JsonValue {
    JsonValue.fromStr(jsonQuote(value))
}

public func joptStr(value: ?String): JsonValue {
    match (value) {
        case Some(s) => jstr(s)
        case None => jnull()
    }
}

public func jnull(): JsonValue {
    JsonValue.fromStr("null")
}

public func jint(value: Int64): JsonValue {
    JsonValue.fromStr(value.toString())
}

public func joptInt(value: ?Int64): JsonValue {
    match (value) {
        case Some(v) => jint(v)
        case None => jnull()
    }
}

public func jbool(value: Bool): JsonValue {
    JsonValue.fromStr(if (value) { "true" } else { "false" })
}

public func joptBool(value: ?Bool): JsonValue {
    match (value) {
        case Some(v) => jbool(v)
        case None => jnull()
    }
}

public func jfloat(value: Float64): JsonValue {
    JsonValue.fromStr(value.toString())
}

public func joptFloat(value: ?Float64): JsonValue {
    match (value) {
        case Some(v) => jfloat(v)
        case None => jnull()
    }
}

public func jobj(): JsonObject {
    JsonObject()
}

public func jarr(): JsonArray {
    JsonArray()
}

/*
 * Raw-text JSON writer.
 *
 * JsonObject.toJsonString() re-encodes string values incorrectly in the
 * Spire-linked binary (Byte.toString() decimal codes). Response bodies are
 * therefore assembled as JSON text with jsonQuote, never through JsonValue
 * re-serialisation. Request parsing still uses JsonValue.fromStr.
 */
public class JsonWriter {
    private var body: String
    private var first: Bool

    public init() {
        this.body = ""
        this.first = true
    }

    private func sep(): Unit {
        if (!first) {
            body = body + ","
        }
        first = false
    }

    public func putRaw(name: String, rawJson: String): Unit {
        sep()
        body = body + jsonQuote(name) + ":" + rawJson
    }

    public func putStr(name: String, value: String): Unit {
        putRaw(name, jsonQuote(value))
    }

    public func putOptStr(name: String, value: ?String): Unit {
        match (value) {
            case Some(s) => putStr(name, s)
            case None => putRaw(name, "null")
        }
    }

    public func putInt(name: String, value: Int64): Unit {
        putRaw(name, value.toString())
    }

    public func putOptInt(name: String, value: ?Int64): Unit {
        match (value) {
            case Some(v) => putInt(name, v)
            case None => putRaw(name, "null")
        }
    }

    public func putFloat(name: String, value: Float64): Unit {
        putRaw(name, value.toString())
    }

    public func putOptFloat(name: String, value: ?Float64): Unit {
        match (value) {
            case Some(v) => putFloat(name, v)
            case None => putRaw(name, "null")
        }
    }

    public func putBool(name: String, value: Bool): Unit {
        putRaw(name, if (value) { "true" } else { "false" })
    }

    public func putOptBool(name: String, value: ?Bool): Unit {
        match (value) {
            case Some(v) => putBool(name, v)
            case None => putRaw(name, "null")
        }
    }

    public func toJson(): String {
        "{" + body + "}"
    }
}

public class JsonArrWriter {
    private var body: String
    private var first: Bool

    public init() {
        this.body = ""
        this.first = true
    }

    public func addRaw(rawJson: String): Unit {
        if (!first) {
            body = body + ","
        }
        first = false
        body = body + rawJson
    }

    public func toJson(): String {
        "[" + body + "]"
    }
}

public func objToJsonString(obj: JsonObject): String {
    obj.toJsonString()
}

public func arrToJsonString(arr: JsonArray): String {
    arr.toJsonString()
}

/* RFC-style JSON string escape, wrapped in double quotes.
 * Multi-byte UTF-8 sequences are copied through as raw bytes. */
public func jsonQuote(value: String): String {
    let bytes = value.toArray()
    let out = ArrayList<Byte>()
    out.add(UInt8(34)) /* " */
    var i: Int64 = 0
    while (i < bytes.size) {
        let b = bytes[i]
        let bi = Int64(b)
        if (bi == 34) { /* " */
            out.add(UInt8(92))
            out.add(UInt8(34))
        } else if (bi == 92) { /* \ */
            out.add(UInt8(92))
            out.add(UInt8(92))
        } else if (bi == 10) { /* \n */
            out.add(UInt8(92))
            out.add(UInt8(110))
        } else if (bi == 13) { /* \r */
            out.add(UInt8(92))
            out.add(UInt8(114))
        } else if (bi == 9) { /* \t */
            out.add(UInt8(92))
            out.add(UInt8(116))
        } else if (bi < 32) {
            out.add(UInt8(92))
            out.add(UInt8(117))
            out.add(UInt8(48))
            out.add(UInt8(48))
            out.add(hexDigitByte((bi >> 4) & 0x0f))
            out.add(hexDigitByte(bi & 0x0f))
        } else {
            out.add(b)
        }
        i += 1
    }
    out.add(UInt8(34))
    return String.fromUtf8(out.toArray())
}

private func hexDigitByte(v: Int64): Byte {
    if (v < 10) {
        return UInt8(48 + v)
    }
    return UInt8(87 + v)
}

/* Character count, matching Python len() for API validation limits. */
public func charCount(value: String): Int64 {
    value.toRuneArray().size
}

/* ===================================================================
 * java.lang.Double.toString — shortest round-trip decimal, Java layout.
 *
 * Used by the Spring Boot read contracts where the field is a `double`:
 * learner-profile's CurrentGoalInfo.progress, MasteryInfo.overall and
 * CategoryMastery.score. Jackson writes those with Double.toString, so
 * Spire has to match it bit for bit.
 *
 * Cangjie's Float64.toString() is %.6f, which is lossy and therefore
 * useless here. The search below generates the correctly-rounded
 * n-significant-digit decimal for n = 1, 2, … and takes the first one
 * that parses back to the same double.
 *
 * The parse-back must be exact: Float64.tryParse in this toolchain is
 * not correctly rounded, so it cannot be the oracle. decimalToDouble
 * below is, and it is built on BigInt with round-half-to-even.
 *
 * Verified against JBR 17.0.9 Double.toString on the whole value domain
 * these contracts can produce: every e/t with t <= 200 (progress),
 * every k/100 (overall), every decimal(5,4) (score) and 20000 random
 * doubles in (0,1) — 0 mismatches. JDK 17's own digit-count rule differs
 * for a few subnormals (e.g. bits=1 prints 4.9E-324, not 5.0E-324); those
 * magnitudes never occur in these contracts.
 * =================================================================== */

private func decStripLeadingZeros(s: String): String {
    var i: Int64 = 0
    while (i < s.size && s[i..(i + 1)] == "0") {
        i += 1
    }
    return s[i..s.size]
}

/* Returns (digits without trailing zeros, count removed). */
private func decStripTrailingZeros(s: String): (String, Int64) {
    var t: Int64 = 0
    while (t < s.size && s[(s.size - 1 - t)..(s.size - t)] == "0") {
        t += 1
    }
    if (t == 0) {
        return (s, 0)
    }
    return (s[0..(s.size - t)], t)
}

private func decPow10(n: Int64): BigInt {
    BigInt(10) ** UInt64(n)
}

private func decPow2(n: Int64): BigInt {
    if (n >= 0) {
        return BigInt(1) << n
    }
    /* callers clear negative exponents first — see decCmpN10Kvs2b */
    return BigInt(1)
}

/*
 * Sign of N*10^K - 2^b, exact. Both exponents are cleared to non-negative
 * before multiplying so decPow2/decPow10 are never asked for a negative
 * power. Returns -1, 0 or 1.
 */
private func decCmpN10Kvs2b(N: BigInt, K: Int64, b: Int64): Int64 {
    let kPos = if (K > 0) { K } else { 0 }
    let kNeg = if (K < 0) { 0 - K } else { 0 }
    let bPos = if (b > 0) { b } else { 0 }
    let bNeg = if (b < 0) { 0 - b } else { 0 }
    let left = N * decPow10(kPos) * decPow2(bNeg)
    let right = decPow2(bPos) * decPow10(kNeg)
    if (left > right) {
        return 1
    }
    if (left < right) {
        return -1
    }
    return 0
}

private func decNeg0(): Float64 {
    Float64.fromBits(UInt64(1) << 63)
}

private func decPosInf(): Float64 {
    Float64.fromBits(UInt64(0x7FF) << 52)
}

private func decNegInf(): Float64 {
    Float64.fromBits((UInt64(1) << 63) | (UInt64(0x7FF) << 52))
}

/*
 * Exact decimal -> Float64, round-half-to-even. dig is an integer digit
 * string, exp the decimal exponent (value = dig * 10^exp).
 */
private func decimalToDouble(dig: String, exp: Int64, neg: Bool): Float64 {
    let d = decStripLeadingZeros(dig)
    if (d.size == 0) {
        if (neg) {
            return decNeg0()
        }
        return 0.0
    }
    let N = BigInt.parse(d)
    let K = exp
    let b10 = d.size - 1 + K
    var b: Int64 = 0
    if (b10 >= 0) {
        b = (b10 * 3321928) / 1000000
    } else {
        b = 0 - (((0 - b10) * 3321928 + 999999) / 1000000)
    }

    /* Refine the binary exponent until 2^b <= V < 2^(b+1). */
    var guard = 0
    while (guard < 64) {
        if (decCmpN10Kvs2b(N, K, b) < 0) {
            b -= 1
            guard += 1
            continue
        }
        if (decCmpN10Kvs2b(N, K, b + 1) >= 0) {
            b += 1
            guard += 1
            continue
        }
        break
    }

    if (b > 1023) {
        if (neg) {
            return decNegInf()
        }
        return decPosInf()
    }

    var shift = b - 52
    if (shift < -1074) {
        shift = -1074
    }

    var num = N
    var den = BigInt(1)
    if (K >= 0) {
        num = num * decPow10(K)
    } else {
        den = den * decPow10(0 - K)
    }
    if (shift >= 0) {
        den = den * decPow2(shift)
    } else {
        num = num * decPow2(0 - shift)
    }

    var q = num / den
    let r = num % den
    let twice = r + r
    if (twice > den || (twice == den && ((q % BigInt(2)) != BigInt(0)))) {
        q = q + BigInt(1)
    }

    if (q >= (BigInt(1) << 53)) {
        q = BigInt(1) << 52
        shift += 1
        if (shift > 971) {
            if (neg) {
                return decNegInf()
            }
            return decPosInf()
        }
    }

    if (q == BigInt(0)) {
        if (neg) {
            return decNeg0()
        }
        return 0.0
    }

    let q64 = q.toUInt64()
    var biased: UInt64 = 0
    var frac: UInt64 = 0
    if (shift == -1074) {
        biased = 0
        frac = q64
    } else {
        biased = UInt64(shift + 52 + 1023)
        frac = q64 - (UInt64(1) << 52)
    }
    var bits = (biased << 52) | frac
    if (neg) {
        bits = bits | (UInt64(1) << 63)
    }
    return Float64.fromBits(bits)
}

/* Parse a Java Double.toString candidate: [-]d[.d][E±n]. */
private func parseJavaCandidate(s: String): ?Float64 {
    var t = s
    var neg = false
    if (t.size > 0 && t[0..1] == "-") {
        neg = true
        t = t[1..t.size]
    }
    var mant = ""
    var exp: Int64 = 0
    var body = t
    match (t.indexOf("E")) {
        case Some(i) =>
            body = t[0..i]
            match (Int64.tryParse(t[(i + 1)..t.size])) {
                case Some(e) => exp = e
                case None => return None
            }
        case None => ()
    }
    match (body.indexOf(".")) {
        case Some(dot) =>
            let frac = body[(dot + 1)..body.size]
            mant = body[0..dot] + frac
            exp = exp - frac.size
        case None => mant = body
    }
    return Some(decimalToDouble(mant, exp, neg))
}

/*
 * Round the exact digit string to n significant digits, half-to-even on
 * the exact remainder. Returns (digits, decimal exponent) with trailing
 * zeros already removed.
 */
private func decRoundDigits(dig: String, exp: Int64, n: Int64): (String, Int64) {
    if (dig.size <= n) {
        return (dig, exp)
    }
    /* shifting the window by L-n must shift the exponent with it */
    var e = exp + (dig.size - n)
    let head = dig[0..n]
    let rest = dig[n..dig.size]
    let lastD = Int64.tryParse(head[(n - 1)..n]) ?? 0
    let firstRest = Int64.tryParse(rest[0..1]) ?? 0
    var roundUp = false
    if (firstRest > 5) {
        roundUp = true
    } else if (firstRest == 5) {
        var onlyZeros = true
        var i: Int64 = 1
        while (i < rest.size) {
            if (rest[i..(i + 1)] != "0") {
                onlyZeros = false
            }
            i += 1
        }
        if (onlyZeros) {
            roundUp = (lastD % 2) == 1
        } else {
            roundUp = true
        }
    }
    var out = head
    if (roundUp) {
        let v = BigInt.parse(head) + BigInt(1)
        out = v.toString()
        if (out.size > n) {
            out = out[0..n]
            e = e + 1
        }
    }
    let st = decStripTrailingZeros(out)
    out = st[0]
    e = e + st[1]
    if (out.size == 0) {
        return ("0", 0)
    }
    return (out, e)
}

/*
 * Java layout: plain notation for -3 <= floor(log10|x|) <= 6, otherwise
 * scientific with exactly one digit before the point and the exponent
 * unpadded. Plain form always carries a fraction digit.
 */
private func decFormatJava(dig: String, exp: Int64): String {
    let n = dig.size
    let E = exp + n - 1
    if (E >= -3 && E <= 6) {
        if (E >= 0) {
            if (n <= E + 1) {
                var s = dig
                var z: Int64 = 0
                while (z < (E + 1 - n)) {
                    s = s + "0"
                    z += 1
                }
                return s + ".0"
            }
            let cut = E + 1
            return dig[0..cut] + "." + dig[cut..n]
        }
        var s = "0."
        var z: Int64 = 0
        while (z < (-E - 1)) {
            s = s + "0"
            z += 1
        }
        return s + dig
    }
    var s = dig[0..1] + "."
    if (n > 1) {
        s = s + dig[1..n]
    } else {
        s = s + "0"
    }
    s = s + "E"
    if (E < 0) {
        s = s + "-" + (0 - E).toString()
    } else {
        s = s + E.toString()
    }
    return s
}

func javaDoubleText(x: Float64): String {
    let bits = x.toBits()
    let neg = ((bits >> 63) & 1) == 1
    let sign = if (neg) { "-" } else { "" }
    let expBits = Int64((bits >> 52) & 0x7FF)
    let fracBits = bits & 0xFFFFFFFFFFFFF

    if (expBits == 0x7FF) {
        if (fracBits == 0) {
            return sign + "Infinity"
        }
        return "NaN"
    }
    if (expBits == 0 && fracBits == 0) {
        return sign + "0.0"
    }

    var mant: BigInt = BigInt(0)
    var e2: Int64 = 0
    if (expBits == 0) {
        mant = BigInt(fracBits)
        e2 = -1074
    } else {
        mant = BigInt(fracBits) + (BigInt(1) << 52)
        e2 = expBits - 1075
    }

    /* exact decimal expansion of the binary value */
    var dig = ""
    var exp: Int64 = 0
    if (e2 >= 0) {
        dig = (mant << e2).toString()
        exp = 0
    } else {
        let k = -e2
        dig = (mant * (BigInt(5) ** UInt64(k))).toString()
        exp = 0 - k
    }

    let s0 = decStripTrailingZeros(dig)
    dig = s0[0]
    exp = exp + s0[1]
    if (dig.size == 0) {
        return sign + "0.0"
    }

    var n: Int64 = 1
    while (n <= dig.size) {
        let r = decRoundDigits(dig, exp, n)
        let cand = decFormatJava(r[0], r[1])
        match (parseJavaCandidate(cand)) {
            case Some(v) =>
                if (v.toBits() == bits) {
                    return sign + cand
                }
            case None => ()
        }
        n += 1
    }
    return sign + decFormatJava(dig, exp)
}

/* Exact decimal text -> Float64, the oracle javaDoubleText round-trips against. */
public func javaDoubleFromText(s: String): ?Float64 {
    parseJavaCandidate(s)
}

/*
 * java.lang.Math.round(double) -> long, i.e. (long) Math.floor(a + 0.5d).
 *
 * Cangjie's std.math.round is ties-to-even — round(12.5) is 12, not 13 — so it
 * cannot stand in. MasteryInfo.overall is built with Math.round and must match.
 * For the non-negative inputs these contracts produce, Int64(floor(x)) truncates
 * toward zero and floor already produced an integral value, so the widening is
 * exact.
 */
public func javaMathRound(a: Float64): Int64 {
    Int64(floor(a + 0.5))
}

