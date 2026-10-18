package web.service

import std.convert.*
import std.regex.Regex
import std.unicode.*
import std.time.DateTime
import stdx.encoding.json.*
import web.exception.*
import web.security.AuthUtilities

public class ProfileJson {
    public static func invalid(message: String): BusinessException { return BusinessException(ErrorCode.VALIDATION_FAILED, 400, message) }
    public static func value(object: JsonObject, key: String): Option<JsonValue> {
        if (let Some(item) <- object.get(key)) { if (item.toString() != "null") { return Some(item) } }
        return None
    }
    public static func text(object: JsonObject, key: String, max: Int64): Option<String> {
        if (let Some(item) <- value(object, key)) {
            let result = try { item.asString().getValue() } catch (_: Exception) { throw invalid("${key} 必须为文本") }
            if (length(result) > max) { throw invalid("${key} 长度超过 ${max}") }
            return Some(result)
        }
        return None
    }
    public static func length(text: String): Int64 {
        var units = 0
        for (byte in text.toArray()) { if (byte < 128 || byte >= 192) { units += if (byte >= 240) { 2 } else { 1 } } }
        return units
    }
    public static func number(object: JsonObject, key: String, min: Int64, max: Int64): Option<Int64> {
        if (let Some(item) <- value(object, key)) {
            let parsed = try { Int64.parse(item.toString()) } catch (_: Exception) { throw invalid("${key} 必须为整数") }
            if (parsed < min || parsed > max) { throw invalid("${key} 超出范围") }
            return Some(parsed)
        }
        return None
    }
    public static func choice(object: JsonObject, key: String, choices: Array<String>, required: Bool): Option<String> {
        let parsed = text(object, key, 32)
        if (let Some(item) <- parsed) {
            let normalized = item.trim().toUpper(CasingOption.Other)
            for (allowed in choices) { if (normalized == allowed) { return Some(normalized) } }
            throw invalid("${key} 枚举值无效")
        }
        if (required) { throw invalid("缺少字段：${key}") }
        return None
    }
    public static func uuid(text: String): String {
        if (!Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$").matches(text)) {
            throw invalid("UUID 格式无效")
        }
        return text.toLower(CasingOption.Other)
    }
    public static func strings(object: JsonObject, key: String, max: Int64): Option<String> {
        if (let Some(item) <- value(object, key)) {
            let items = try { item.asArray().getItems() } catch (_: Exception) { throw invalid("${key} 必须为数组") }
            for (element in items) {
                if (element.toString() == "null") { continue }
                let text = try { element.asString().getValue() } catch (_: Exception) { throw invalid("${key} 数组项必须为文本") }
                if (length(text) > max) { throw invalid("${key} 数组项过长") }
            }
            return Some(item.toString())
        }
        return None
    }
    public static func objectJson(object: JsonObject, key: String, integers: Bool): Option<String> {
        if (let Some(item) <- value(object, key)) {
            let fields = try { item.asObject().getFields() } catch (_: Exception) { throw invalid("${key} 必须为对象") }
            if (integers) {
                for ((_, element) in fields) {
                    if (element.toString() == "null") { continue }
                    let parsed = try { Int64.parse(element.toString()) } catch (_: Exception) { throw invalid("${key} 的值必须为整数") }
                    if (parsed < -2147483648 || parsed > 2147483647) { throw invalid("${key} 整数超出范围") }
                }
            }
            return Some(item.toString())
        }
        return None
    }
    public static func textSql(value: Option<String>): String { return textSql(value, false) }
    public static func textSql(value: Option<String>, strip: Bool): String {
        if (let Some(item) <- value) {
            let result = if (strip) { item.trim() } else { item }
            if (strip && result.isEmpty()) { return "NULL" }
            return AuthUtilities.text(result)
        }
        return "NULL"
    }
    public static func numericSql(value: Option<Int64>): String { return match (value) { case Some(item) => "${item}"; case None => "NULL" } }
    public static func row(names: Array<String>, cells: Array<Option<String>>, raw: Array<Int64>): String {
        let result = JsonObject()
        for (i in 0..names.size) {
            if (let Some(item) <- cells[i]) {
                var isRaw = false
                for (index in raw) { if (index == i) { isRaw = true } }
                result.put(names[i], if (isRaw) { JsonValue.fromStr(item) } else { JsonString(item) })
            } else {
                result.put(names[i], JsonValue.fromStr("null"))
            }
        }
        return result.toString()
    }
    public static func safeJson(value: Option<String>, fallback: String, array: Bool): String {
        try {
            let parsed = JsonValue.fromStr(value.getOrDefault({ => fallback }))
            if (array) { parsed.asArray() } else { parsed.asObject() }
            return parsed.toString()
        } catch (_: Exception) { return fallback }
    }
    public static func wrap(message: String, data: Option<String>): String {
        let result = JsonObject()
        result.put("code", JsonValue.fromStr("0"))
        result.put("message", JsonString(message))
        if (let Some(value) <- data) { result.put("data", JsonValue.fromStr(value)) }
        result.put("timestamp", JsonString(DateTime.nowUTC().toString()))
        return result.toString()
    }
}
