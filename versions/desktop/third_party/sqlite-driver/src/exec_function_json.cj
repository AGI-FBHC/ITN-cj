package sqlite_driver

import std.collection.*
import std.convert.*
import stdx.encoding.json.*

/*
 * SQLite JSON1 的常用子集。解析、对象/数组遍历和 JSON 转义全部交给 stdx.encoding.json；
 * 本文件只负责 SQL 值与 JSON 值的类型映射，以及 SQLite 的路径语法。
 */

enum JsonPathPart {
    | JsonPathKey(String)
    | JsonPathIndex(Int64)
}

func evalJsonFunction(f: FuncExpr, args: Array<SqliteValue>, lower: String): SqliteValue {
    match (lower) {
        case "json" =>
            requireArgCount(f, args, 1, 1)
            let parsed = parseJsonSqlValue(args[0], true)
            match (parsed) {
                case None => SqliteValue.SNull
                case Some(v) => SqliteValue.SText(v.toString())
            }
        case "json_valid" =>
            requireArgCount(f, args, 1, 1)
            match (args[0]) {
                case SNull => SqliteValue.SNull
                case _ =>
                    match (parseJsonSqlValue(args[0], false)) {
                        case Some(_) => SqliteValue.SInt(1)
                        case None => SqliteValue.SInt(0)
                    }
            }
        case "json_extract" =>
            requireArgCount(f, args, 2, -1)
            evalJsonExtract(f, args)
        case "json_type" =>
            requireArgCount(f, args, 1, 2)
            evalJsonType(f, args)
        case _ => throw SqliteRuntimeException("sql", "no such function: ${f.name}")
    }
}

/** json_array/json_object 保留参数书写顺序；stdx JsonArray 也保留数组顺序。 */
func evalJsonConstructor(ctx: EvalContext, f: FuncExpr, lower: String): SqliteValue {
    if (lower == "json_array") {
        let array = JsonArray()
        for (e in f.args) {
            let v = evalExpr(ctx, e)
            array.add(sqlValueToJson(v, expressionCarriesJson(e, v)))
        }
        return SqliteValue.SText(array.toString())
    }
    if (f.args.size % 2 != 0) {
        throw SqliteRuntimeException("sql", "json_object() requires an even number of arguments")
    }
    let parts = ArrayList<String>()
    var i = 0
    while (i < f.args.size) {
        let key = evalExpr(ctx, f.args[i])
        let keyText = match (key) {
            case SText(s) => s
            case _ => throw SqliteRuntimeException("sql", "json_object() labels must be TEXT")
        }
        let value = evalExpr(ctx, f.args[i + 1])
        let keyJson = JsonString(keyText).toString()
        let valueJson = sqlValueToJson(value, expressionCarriesJson(f.args[i + 1], value)).toString()
        parts.add("${keyJson}:${valueJson}")
        i += 2
    }
    SqliteValue.SText("{${joinStrings(parts, ",")}}")
}

func evalJsonExtract(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    let root = match (parseJsonSqlValue(args[0], true)) {
        case None => return SqliteValue.SNull
        case Some(v) => v
    }
    let paths = ArrayList<Option<JsonValue>>()
    for (i in 1..args.size) {
        match (args[i]) {
            case SNull => return SqliteValue.SNull
            case _ =>
                let pathText = valueToText(args[i])
                let parts = parseJsonPath(pathText)
                paths.add(selectJsonPath(root, parts))
        }
    }
    if (paths.size > 1) {
        let array = JsonArray()
        for (item in paths) {
            match (item) {
                case Some(v) => array.add(v)
                case None => array.add(JsonNull())
            }
        }
        return SqliteValue.SText(array.toString())
    }
    match (paths[0]) {
        case None => SqliteValue.SNull
        case Some(v) => jsonValueToSqlite(v, false)
    }
}

func evalJsonType(f: FuncExpr, args: Array<SqliteValue>): SqliteValue {
    let root = match (parseJsonSqlValue(args[0], true)) {
        case None => return SqliteValue.SNull
        case Some(v) => v
    }
    var selected = root
    if (args.size == 2) {
        match (args[1]) {
            case SNull => return SqliteValue.SNull
            case _ =>
                let found = selectJsonPath(root, parseJsonPath(valueToText(args[1])))
                selected = match (found) {
                    case None => return SqliteValue.SNull
                    case Some(v) => v
                }
        }
    }
    SqliteValue.SText(jsonKindName(selected))
}

func evalJsonArrow(left: SqliteValue, right: SqliteValue, textMode: Bool): SqliteValue {
    if (left == SqliteValue.SNull || right == SqliteValue.SNull) {
        return SqliteValue.SNull
    }
    let root = match (parseJsonSqlValue(left, true)) {
        case None => return SqliteValue.SNull
        case Some(v) => v
    }
    let path = match (right) {
        case SInt(i) =>
            if (i < 0) {
                throw SqliteRuntimeException("sql", "bad JSON path: '${i}'")
            }
            "$[${i}]"
        case SText(s) =>
            if (s.startsWith("$")) {
                s
            } else {
                "$.${s}"
            }
        case _ => throw SqliteRuntimeException("sql", "JSON path must be TEXT or INTEGER")
    }
    let found = selectJsonPath(root, parseJsonPath(path))
    match (found) {
        case None => SqliteValue.SNull
        case Some(v) => jsonValueToSqlite(v, !textMode)
    }
}

func parseJsonSqlValue(v: SqliteValue, throwOnError: Bool): Option<JsonValue> {
    match (v) {
        case SNull => None
        case SInt(i) => parseJsonText("${i}", throwOnError)
        case SReal(f) => parseJsonText("${f}", throwOnError)
        case SText(s) => parseJsonText(s, throwOnError)
        case SBlob(bytes) =>
            try {
                parseJsonText(String.fromUtf8(bytes), throwOnError)
            } catch (e: Exception) {
                if (throwOnError) {
                    throw SqliteRuntimeException("sql", "malformed JSON")
                }
                None
            }
    }
}

func parseJsonText(text: String, throwOnError: Bool): Option<JsonValue> {
    try {
        if (!jsonDocumentShapeIsComplete(text)) {
            throw Exception("incomplete JSON document")
        }
        Some(JsonValue.fromStr(text))
    } catch (_: Exception) {
        if (throwOnError) {
            throw SqliteRuntimeException("sql", "malformed JSON")
        }
        None
    }
}

/** stdx 对部分未闭合容器会按空容器容错；先做文档边界校验，避免 json_valid 误报。 */
func jsonDocumentShapeIsComplete(text: String): Bool {
    let bytes = text.toArray()
    var stack = ArrayList<Byte>()
    var quoted = false
    var escaped = false
    var rootFinished = false
    for (b in bytes) {
        if (quoted) {
            if (escaped) {
                escaped = false
            } else if (b == b'\\') {
                escaped = true
            } else if (b == b'\"') {
                quoted = false
            }
            continue
        }
        if (b == b'\"') {
            if (rootFinished) { return false }
            quoted = true
            continue
        }
        if (b == b'{' || b == b'[') {
            if (rootFinished) { return false }
            stack.add(b)
            continue
        }
        if (b == b'}' || b == b']') {
            if (stack.isEmpty()) { return false }
            let open = stack[stack.size - 1]
            if ((b == b'}' && open != b'{') || (b == b']' && open != b'[')) { return false }
            stack.remove(at: stack.size - 1)
            if (stack.isEmpty()) { rootFinished = true }
            continue
        }
        if (rootFinished && b != b' ' && b != b'\t' && b != b'\r' && b != b'\n') {
            return false
        }
    }
    !quoted && !escaped && stack.isEmpty() && !bytes.isEmpty()
}

func sqlValueToJson(v: SqliteValue, rawJson: Bool): JsonValue {
    if (rawJson) {
        match (v) {
            case SText(s) =>
                try {
                    return JsonValue.fromStr(s)
                } catch (_: Exception) {
                    // 标量 json_extract 结果没有 JSON 子类型，按普通 JSON 字符串保留。
                    ()
                }
            case _ => ()
        }
    }
    match (v) {
        case SNull => JsonNull()
        case SInt(i) => JsonInt(i)
        case SReal(f) => JsonFloat(f)
        case SText(s) => JsonString(s)
        case SBlob(_) => throw SqliteRuntimeException("sql", "JSON cannot contain BLOB values")
    }
}

func expressionCarriesJson(e: Expr, value: SqliteValue): Bool {
    if (e is BinaryExpr) {
        let b = (e as BinaryExpr).getOrThrow()
        return b.op == "->"
    }
    if (e is FuncExpr) {
        let f = (e as FuncExpr).getOrThrow()
        match (f.name.toAsciiLower()) {
            case "json" | "json_array" | "json_object" => true
            case "json_extract" =>
                if (f.args.size > 2) {
                    true
                } else {
                    match (value) {
                        case SText(s) => s.startsWith("{") || s.startsWith("[")
                        case _ => false
                    }
                }
            case _ => false
        }
    } else {
        false
    }
}

func jsonValueToSqlite(v: JsonValue, textMode: Bool): SqliteValue {
    if (textMode) {
        return SqliteValue.SText(v.toString())
    }
    match (v.kind()) {
        case JsNull => SqliteValue.SNull
        case JsBool => SqliteValue.SInt(if (v.asBool().getValue()) { 1 } else { 0 })
        case JsInt => SqliteValue.SInt(v.asInt().getValue())
        case JsFloat => SqliteValue.SReal(v.asFloat().getValue())
        case JsString => SqliteValue.SText(v.asString().getValue())
        case JsArray | JsObject => SqliteValue.SText(v.toString())
    }
}

func jsonKindName(value: JsonValue): String {
    match (value.kind()) {
        case JsNull => "null"
        case JsBool => if (value.asBool().getValue()) { "true" } else { "false" }
        case JsInt => "integer"
        case JsFloat => "real"
        case JsString => "text"
        case JsArray => "array"
        case JsObject => "object"
    }
}

func parseJsonPath(path: String): ArrayList<JsonPathPart> {
    let bytes = path.toArray()
    if (bytes.isEmpty() || bytes[0] != b'$') {
        throw SqliteRuntimeException("sql", "bad JSON path: '${path}'")
    }
    let out = ArrayList<JsonPathPart>()
    var p = 1
    while (p < bytes.size) {
        if (bytes[p] == b'.') {
            p += 1
            if (p >= bytes.size) {
                throw SqliteRuntimeException("sql", "bad JSON path: '${path}'")
            }
            if (bytes[p] == b'\"') {
                let (key, next) = quotedPathKey(bytes, p, path)
                out.add(JsonPathKey(key))
                p = next
            } else {
                let start = p
                while (p < bytes.size && bytes[p] != b'.' && bytes[p] != b'[') {
                    p += 1
                }
                if (p == start) {
                    throw SqliteRuntimeException("sql", "bad JSON path: '${path}'")
                }
                out.add(JsonPathKey(String.fromUtf8(bytes[start..p])))
            }
            continue
        }
        if (bytes[p] == b'[') {
            p += 1
            let start = p
            while (p < bytes.size && bytes[p] != b']') {
                p += 1
            }
            if (p >= bytes.size) {
                throw SqliteRuntimeException("sql", "bad JSON path: '${path}'")
            }
            let token = String.fromUtf8(bytes[start..p])
            p += 1
            if (token.startsWith("#-")) {
                let n = parsePathInteger(token[2..], path)
                out.add(JsonPathIndex(-n))
            } else if (token.startsWith("\"")) {
                let parsed = parseJsonText(token, true)
                let key = parsed.getOrThrow().asString().getValue()
                out.add(JsonPathKey(key))
            } else {
                out.add(JsonPathIndex(parsePathInteger(token, path)))
            }
            continue
        }
        throw SqliteRuntimeException("sql", "bad JSON path: '${path}'")
    }
    out
}

func quotedPathKey(bytes: Array<Byte>, start: Int64, path: String): (String, Int64) {
    var p = start + 1
    while (p < bytes.size) {
        if (bytes[p] == b'\"') {
            if (p + 1 < bytes.size && bytes[p + 1] == b'\"') {
                p += 2
                continue
            }
            let literal = String.fromUtf8(bytes[start..(p + 1)])
            let parsed = parseJsonText(literal, true).getOrThrow().asString().getValue()
            return (parsed, p + 1)
        }
        p += 1
    }
    throw SqliteRuntimeException("sql", "bad JSON path: '${path}'")
}

func parsePathInteger(text: String, path: String): Int64 {
    try {
        Int64.parse(text)
    } catch (_: Exception) {
        throw SqliteRuntimeException("sql", "bad JSON path: '${path}'")
    }
}

func selectJsonPath(root: JsonValue, parts: ArrayList<JsonPathPart>): Option<JsonValue> {
    var current = root
    for (part in parts) {
        match (part) {
            case JsonPathKey(key) =>
                if (!(current is JsonObject)) {
                    return None
                }
                match ((current as JsonObject).getOrThrow().get(key)) {
                    case Some(v) => current = v
                    case None => return None
                }
            case JsonPathIndex(index) =>
                if (!(current is JsonArray)) {
                    return None
                }
                let array = (current as JsonArray).getOrThrow()
                let actual = if (index < 0) { array.size() + index } else { index }
                if (actual < 0 || actual >= array.size()) {
                    return None
                }
                current = array.get(actual).getOrThrow()
        }
    }
    Some(current)
}

func joinStrings(values: ArrayList<String>, separator: String): String {
    let sb = StringBuilder()
    for (i in 0..values.size) {
        if (i > 0) {
            sb.append(separator)
        }
        sb.append(values[i])
    }
    sb.toString()
}
