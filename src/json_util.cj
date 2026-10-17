package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
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
