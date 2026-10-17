package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import soulsoft_web_http.*

/*
 * Pydantic v2 lax-mode coercion for request bodies and query strings.
 *
 * Every message, error type and `input` echo below was verified against
 * FastAPI 0.115.6 / pydantic 2.10.4 with the same field declarations the
 * Python routes use. The wire shape is:
 *   {"detail":[{"type":T,"loc":[...],"msg":M,"input":V,"ctx":{...}}]}
 */

/* An alias-resolved body field: the key that was actually present. */
struct AliasedField {
    let key: String
    let value: JsonValue
    init(key: String, value: JsonValue) {
        this.key = key
        this.value = value
    }
}

/*
 * AliasChoices(a, b): first key present in the object wins.
 *
 * An explicit JSON null counts as "not provided" and stops the search: every
 * caller here declares `T | None = None`, and pydantic assigns None for
 * `{"pageIndex": null}` without running the field's constraints — measured
 * FastAPI answers 200, where treating null as an int gave int_type/422.
 * Stopping also mirrors AliasChoices, which commits to the first key it finds
 * and does not fall through to the second alias.
 */
func bodyFieldByAlias(obj: JsonObject, a: String, b: String): ?AliasedField {
    match (obj.get(a)) {
        case Some(v) => return aliasFieldOrNull(a, v)
        case None => ()
    }
    if (a != b) {
        match (obj.get(b)) {
            case Some(v) => return aliasFieldOrNull(b, v)
            case None => ()
        }
    }
    return None
}

private func aliasFieldOrNull(key: String, v: JsonValue): ?AliasedField {
    match (v.kind()) {
        case JsonKind.JsNull => return None
        case _ => return Some(AliasedField(key, v))
    }
    return None     /* unreachable — keeps the return type non-Unit */
}

enum PInt {
    Done(Int64) | Fail(String, String, String)   /* errType, msg, inputRawJson */
}

enum PFloat {
    Done(Float64) | Fail(String, String, String)
}

enum PBool {
    Done(Bool) | Fail(String, String, String)
}

/*
 * int | None, lax mode.
 *   JSON int              -> value
 *   JSON float integral   -> value; fractional -> int_from_float
 *   JSON bool             -> 1 / 0
 *   JSON string           -> Python int(str) ; failure -> int_parsing
 *   JSON array / object   -> int_type
 */
func coercePyInt(v: JsonValue): PInt {
    match (v.kind()) {
        case JsonKind.JsInt =>
            return PInt.Done(v.asInt().getValue())
        case JsonKind.JsFloat =>
            let f = v.asFloat().getValue()
            let t = truncateFloat(f)
            if (floatFromInt(t) == f) {
                return PInt.Done(t)
            }
            return PInt.Fail("int_from_float",
                             "Input should be a valid integer, got a number with a fractional part",
                             valueToRaw(v))
        case JsonKind.JsBool =>
            return PInt.Done(if (v.asBool().getValue()) { 1 } else { 0 })
        case JsonKind.JsString =>
            let raw = v.asString().getValue()
            match (pythonIntText(raw)) {
                case Some(n) => return PInt.Done(n)
                case None =>
                    return PInt.Fail("int_parsing",
                                     "Input should be a valid integer, unable to parse string as an integer",
                                     valueToRaw(v))
            }
        case _ =>
            return PInt.Fail("int_type", "Input should be a valid integer", valueToRaw(v))
    }
}

/*
 * float | None, lax mode.
 *   JSON number / integral float -> value
 *   JSON bool                    -> 1.0 / 0.0
 *   JSON string                  -> Python float(str) ; failure -> float_parsing
 *   JSON array / object          -> float_type
 */
func coercePyFloat(v: JsonValue): PFloat {
    match (v.kind()) {
        case JsonKind.JsInt =>
            return PFloat.Done(floatFromInt(v.asInt().getValue()))
        case JsonKind.JsFloat =>
            return PFloat.Done(v.asFloat().getValue())
        case JsonKind.JsBool =>
            return PFloat.Done(if (v.asBool().getValue()) { 1.0 } else { 0.0 })
        case JsonKind.JsString =>
            let raw = v.asString().getValue().trimAscii()
            match (Float64.tryParse(raw)) {
                case Some(f) => return PFloat.Done(f)
                case None =>
                    return PFloat.Fail("float_parsing",
                                       "Input should be a valid number, unable to parse string as a number",
                                       valueToRaw(v))
            }
        case _ =>
            return PFloat.Fail("float_type", "Input should be a valid number", valueToRaw(v))
    }
}

/*
 * bool | None, lax mode.
 *   JSON bool                     -> value
 *   JSON int 0 / 1                -> False / True ; anything else -> bool_parsing
 *   JSON string true/false/t/f/y/n/yes/no/on/off/1/0 (case-insensitive)
 *   JSON array / object           -> bool_type
 */
func coercePyBool(v: JsonValue): PBool {
    match (v.kind()) {
        case JsonKind.JsBool =>
            return PBool.Done(v.asBool().getValue())
        case JsonKind.JsInt =>
            let n = v.asInt().getValue()
            if (n == 0) {
                return PBool.Done(false)
            }
            if (n == 1) {
                return PBool.Done(true)
            }
            return PBool.Fail("bool_parsing",
                              "Input should be a valid boolean, unable to interpret input",
                              valueToRaw(v))
        case JsonKind.JsString =>
            match (parsePyBoolText(v.asString().getValue())) {
                case Some(b) => return PBool.Done(b)
                case None =>
                    return PBool.Fail("bool_parsing",
                                      "Input should be a valid boolean, unable to interpret input",
                                      valueToRaw(v))
            }
        case _ =>
            return PBool.Fail("bool_type", "Input should be a valid boolean", valueToRaw(v))
    }
}

/* Python bool-string literals; everything else is a bool_parsing error. */
func parsePyBoolText(raw: String): ?Bool {
    let t = raw.toAsciiLower()
    if (t == "true" || t == "t" || t == "y" || t == "yes" || t == "on" || t == "1") {
        return Some(true)
    }
    if (t == "false" || t == "f" || t == "n" || t == "no" || t == "off" || t == "0") {
        return Some(false)
    }
    return None
}

/*
 * Python int(str): optional ASCII whitespace, optional sign, then decimal
 * digits. No underscores, no 0x, no decimal point.
 */
func pythonIntText(raw: String): ?Int64 {
    let t = raw.trimAscii()
    if (t.isEmpty()) {
        return None
    }
    let rs = t.toRuneArray()
    var i: Int64 = 0
    var negative = false
    if (runeCode(rs[i]) == 0x2b) {          /* '+' */
        i += 1
    } else {
        if (runeCode(rs[i]) == 0x2d) {      /* '-' */
            negative = true
            i += 1
        }
    }
    if (i >= rs.size) {
        return None
    }
    var digits = ""
    while (i < rs.size) {
        let v = runeCode(rs[i])
        if (v < 0x30 || v > 0x39) {
            return None
        }
        digits = digits + rs[i].toString()
        i += 1
    }
    if (digits.isEmpty()) {
        return None
    }
    match (Int64.tryParse(digits)) {
        case None => return None
        case Some(n) => return Some(if (negative) { 0 - n } else { n })
    }
}

/*
 * Read a request body into a JsonObject, emitting the body-level 422 that
 * FastAPI + the agents-service handler produce. Measured:
 *   zero bytes              -> missing,               loc ["body"], input null
 *   malformed JSON          -> json_invalid,          loc ["body", <pos>]
 *   the literal "null"      -> missing,               loc ["body"], input null
 *   any non-object          -> model_attributes_type, loc ["body"], input <value>
 * `body.size == 0` is zero BYTES: routing.py branches on `if body_bytes`, so
 * "  " still reaches request.json() and dies as json_invalid, while "" alone
 * yields body=None -> pydantic `missing`.
 */
public func readPyBodyObject(ctx: HttpContext): ?JsonObject {
    let body = readBodyText(ctx.request)
    if (body.size == 0) {
        writeValidation422(ctx.response, ["body"], "missing", "Field required", "null", None)
        return None
    }
    match (pyJsonDecodeError(body)) {
        case Some(e) =>
            writeJsonInvalid422(ctx.response, e)
            return None
        case None => ()
    }
    match (jsonParse(body)) {
        case None =>
            writeValidation422(ctx.response, ["body"], "model_attributes_type",
                               "Input should be a valid dictionary or object to extract fields from",
                               "{}", None)
            return None
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsNull =>
                    writeValidation422(ctx.response, ["body"], "missing",
                                       "Field required", "null", None)
                    return None
                case JsonKind.JsObject => return Some(v.asObject())
                case _ =>
                    writeValidation422(ctx.response, ["body"], "model_attributes_type",
                                       "Input should be a valid dictionary or object to extract fields from",
                                       valueToRaw(v), None)
                    return None
            }
    }
}

/* Emit a pydantic constraint or parse failure with its `ctx`. */
func writePyConstraint422(response: HttpResponse, loc: Array<String>, errType: String,
                          msg: String, inputRawJson: String, ctxRawJson: String): Unit {
    writeFastApi422(response, loc, errType, msg, inputRawJson, Some(ctxRawJson))
}

func writePyType422(response: HttpResponse, loc: Array<String>, errType: String,
                    msg: String, inputRawJson: String): Unit {
    writeFastApi422(response, loc, errType, msg, inputRawJson, None)
}

/* ------------------------------------------------------------------ *
 * Multi-error accumulation.
 *
 * Pydantic reports EVERY failing field in one 422 — measured:
 *   {"title": "", "content": ""}     -> two string_too_short items
 *   {} on AddToWrongBookRequest      -> four `missing` items
 *   {"streak": -1, "last_pick": -2}  -> two greater_than_equal items
 * so a parser collects items in field-declaration order and writes once.
 * ------------------------------------------------------------------ */

/*
 * Holds pydantic error items until the parse finishes. Uses the same
 * string-accumulator shape as JsonArrWriter — no growable collection needed.
 */
public class PyBag {
    private var body: String
    private var first: Bool
    private var count: Int64

    public init() {
        this.body = ""
        this.first = true
        this.count = 0
    }

    public func add(item: String): Unit {
        if (!first) {
            body = body + ","
        }
        first = false
        body = body + item
        count += 1
    }

    public func ok(): Bool {
        count == 0
    }

    /* Write the agents-service 422 envelope. Call only when !ok(). */
    public func write(response: HttpResponse): Unit {
        let obj = JsonWriter()
        obj.putStr("code", "VALIDATION_FAILED")
        obj.putRaw("details", "[" + body + "]")
        writeJson(response, 422, obj.toJson())
    }
}

/*
 * Discard a validator's return value. The error (if any) is already in the
 * bag; callers that re-read the body on the success path do not need the
 * parsed value. Cangjie requires a statement expression to be Unit.
 */
public func pyDrop<T>(v: T): Unit {
    ()
}

/*
 * A body field located by AliasChoices. `key` is the key as it appears in
 * the input — that is what pydantic puts in `loc` for a value error.
 * Measured: {"categoryId": "zz"} errors at ["body","categoryId"], never at
 * ["body","category_id"].
 */
public struct PyField {
    public let key: String
    public let value: JsonValue
    public let raw: String

    public init(key: String, value: JsonValue) {
        this.key = key
        this.value = value
        this.raw = valueToRaw(value)
    }
}

/*
 * Lookup for a NON-optional field (`str`, `int`, `bool`, `Literal[...]`).
 * An explicit JSON null is a PRESENT value and fails type validation:
 * measured {"title": null} on `title: str` is string_type with input null.
 */
public func pyField(obj: JsonObject, snake: String, camel: String): ?PyField {
    match (obj.get(snake)) {
        case Some(v) => return Some(PyField(snake, v))
        case None => ()
    }
    if (snake != camel) {
        match (obj.get(camel)) {
            case Some(v) => return Some(PyField(camel, v))
            case None => ()
        }
    }
    return None
}

/*
 * Lookup for a `T | None` field. Explicit null means "not provided":
 * measured 200 for {"title": null} on Optional[str], {"categoryId": null}
 * on Optional[UUID], {"streak": null} on Optional[int]. Stops at the first
 * key present, matching AliasChoices.
 */
public func pyFieldOpt(obj: JsonObject, snake: String, camel: String): ?PyField {
    match (pyField(obj, snake, camel)) {
        case None => return None
        case Some(f) =>
            match (f.value.kind()) {
                case JsonKind.JsNull => return None
                case _ => return Some(f)
            }
    }
}

/*
 * str with min_length / max_length. Pass minLen <= 0 when the field declares
 * only max_length (measured: LearningResourceCreateRequest.title accepts "").
 * Pass maxLen <= 0 when there is no max.
 */
public func pyStr(bag: PyBag, f: PyField, minLen: Int64, maxLen: Int64): ?String {
    match (f.value.kind()) {
        case JsonKind.JsNull =>
            bag.add(pyStringType(["body", f.key], "null"))
            return None
        case JsonKind.JsString =>
            let s = f.value.asString().getValue()
            let n = charCount(s)
            if (minLen > 0 && n < minLen) {
                bag.add(pyStringTooShort(["body", f.key], f.raw, minLen))
                return None
            }
            if (maxLen > 0 && n > maxLen) {
                bag.add(pyStringTooLong(["body", f.key], f.raw, maxLen))
                return None
            }
            return Some(s)
        case _ =>
            bag.add(pyStringType(["body", f.key], f.raw))
            return None
    }
}

/*
 * str with Field(pattern=...). `pattern` is the raw regex, echoed in both
 * msg and ctx (measured: "^#[0-9a-fA-F]{6}$").
 */
public func pyStrPattern(bag: PyBag, f: PyField, pattern: String): ?String {
    match (f.value.kind()) {
        case JsonKind.JsNull =>
            bag.add(pyStringType(["body", f.key], "null"))
            return None
        case JsonKind.JsString =>
            let s = f.value.asString().getValue()
            if (regexMatches(pattern, s)) {
                return Some(s)
            }
            bag.add(pyPatternMismatch(["body", f.key], f.raw, pattern))
            return None
        case _ =>
            bag.add(pyStringType(["body", f.key], f.raw))
            return None
    }
}

/*
 * int | None with ge/le. Null on a NON-optional int is int_type with input
 * null (measured: question_count: int = Field(default=15) rejects
 * {"questionCount": null}). Lax coercion matches coercePyInt: bool -> 1/0,
 * integral float -> value, fractional -> int_from_float.
 */
public func pyInt(bag: PyBag, f: PyField, ge: ?Int64, le: ?Int64): ?Int64 {
    match (f.value.kind()) {
        case JsonKind.JsNull =>
            bag.add(pyIntType(["body", f.key], "null"))
            return None
        case _ => ()
    }
    match (coercePyInt(f.value)) {
        case PInt.Fail(t, m, input) =>
            bag.add(pyErrItem(["body", f.key], t, m, input, None))
            return None
        case PInt.Done(n) =>
            var bad = false
            match (ge) {
                case Some(g) =>
                    if (n < g) {
                        bag.add(pyGe(["body", f.key], f.raw, g))
                        bad = true
                    }
                case None => ()
            }
            match (le) {
                case Some(l) =>
                    if (n > l) {
                        bag.add(pyLe(["body", f.key], f.raw, l))
                        bad = true
                    }
                case None => ()
            }
            if (bad) {
                return None
            }
            return Some(n)
    }
}

/* bool | None. Null on a non-optional bool is bool_type with input null. */
public func pyBoolField(bag: PyBag, f: PyField): ?Bool {
    match (f.value.kind()) {
        case JsonKind.JsNull =>
            bag.add(pyBoolType(["body", f.key], "null"))
            return None
        case _ => ()
    }
    match (coercePyBool(f.value)) {
        case PBool.Fail(t, m, input) =>
            bag.add(pyErrItem(["body", f.key], t, m, input, None))
            return None
        case PBool.Done(b) => return Some(b)
    }
}

/*
 * UUID. Non-string input is uuid_type (measured: {"categoryId": 5}).
 * An unparseable string is uuid_parsing with the uuid-crate diagnostic.
 * Call through pyFieldOpt for a `UUID | None` field so null is "absent".
 */
public func pyUuidField(bag: PyBag, f: PyField): ?Array<Byte> {
    match (f.value.kind()) {
        case JsonKind.JsNull =>
            bag.add(pyUuidType(["body", f.key], "null"))
            return None
        case JsonKind.JsString =>
            let text = f.value.asString().getValue()
            match (uuidParse(text)) {
                case Some(bytes) => return Some(bytes)
                case None =>
                    match (uuidParseError(text)) {
                        case Some(err) => bag.add(pyUuidParsing(["body", f.key], f.raw, err))
                        case None => bag.add(pyUuidParsing(["body", f.key], f.raw, "Invalid UUID"))
                    }
                    return None
            }
        case _ =>
            bag.add(pyUuidType(["body", f.key], f.raw))
            return None
    }
}

/*
 * Literal["a","b",...]. ctx.expected is pydantic's join: "'a', 'b' or 'c'".
 * Explicit null is literal_error with input null (measured: status: Literal
 * rejects {"status": null}, unlike an Optional field).
 */
public func pyLiteralField(bag: PyBag, f: PyField, allowed: Array<String>): ?String {
    let expected = pyLiteralExpected(allowed)
    match (f.value.kind()) {
        case JsonKind.JsString =>
            let s = f.value.asString().getValue()
            var found = false
            for (a in allowed) {
                if (a == s) {
                    found = true
                }
            }
            if (found) {
                return Some(s)
            }
            bag.add(pyLiteral(["body", f.key], f.raw, expected))
            return None
        case _ =>
            bag.add(pyLiteral(["body", f.key], f.raw, expected))
            return None
    }
}

/* "'a'" / "'a' or 'b'" / "'a', 'b' or 'c'" */
public func pyLiteralExpected(allowed: Array<String>): String {
    var s = ""
    var i: Int64 = 0
    while (i < allowed.size) {
        if (i > 0) {
            if (i == allowed.size - 1) {
                s = s + " or "
            } else {
                s = s + ", "
            }
        }
        s = s + "'" + allowed[i] + "'"
        i += 1
    }
    return s
}

/*
 * list[str] with max_length. Measured interaction: when the list is over the
 * limit, pydantic reports ONLY `too_long` and suppresses the per-item errors
 * ({"kbRefs": [1] + 21 strings} yields one too_long, not string_type at 0).
 * Item errors therefore fire only when the length is fine, and they carry a
 * NUMERIC loc index: ["body","kbRefs",0].
 */
public func pyStrList(bag: PyBag, f: PyField, maxLen: Int64): ?Array<String> {
    match (f.value.kind()) {
        case JsonKind.JsNull =>
            bag.add(pyListType(["body", f.key], "null"))
            return None
        case JsonKind.JsArray =>
            let arr = f.value.asArray()
            if (maxLen > 0 && arr.size() > maxLen) {
                bag.add(pyListTooLong(["body", f.key], f.raw, maxLen, arr.size()))
                return None
            }
            let out = ArrayList<String>()
            var i: Int64 = 0
            while (i < arr.size()) {
                match (arr.get(i)) {
                    case Some(item) =>
                        match (item.kind()) {
                            case JsonKind.JsString => out.add(item.asString().getValue())
                            case _ => bag.add(pyListStringType(f.key, i, valueToRaw(item)))
                        }
                    case None => ()
                }
                i += 1
            }
            return Some(out.toArray())
        case _ =>
            bag.add(pyListType(["body", f.key], f.raw))
            return None
    }
}

/*
 * Pattern check for the Field(pattern=...) declarations in models.py.
 * Only one exists in the migrated surface — NoteCategory.color
 * "^#[0-9a-fA-F]{6}$" — so the matcher is written for exactly that shape
 * rather than shipping a general regex engine. Measured msg/ctx echo the
 * pattern text verbatim; if a second pattern appears, extend this.
 */
public func regexMatches(pattern: String, text: String): Bool {
    if (pattern == "^#[0-9a-fA-F]{6}$") {
        return isHexColor(text)
    }
    /* Unknown pattern: fail closed so the 422 surfaces rather than silently
     * accepting a value the real service would reject. */
    return false
}

/* Exact "^#[0-9a-fA-F]{6}$": '#', six hex digits, end. */
private func isHexColor(text: String): Bool {
    let rs = text.toRuneArray()
    if (rs.size != 7) {
        return false
    }
    if (runeCode(rs[0]) != 0x23) {
        return false
    }
    var i: Int64 = 1
    while (i < 7) {
        let c = runeCode(rs[i])
        let digit = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
        if (!digit) {
            return false
        }
        i += 1
    }
    return true
}
