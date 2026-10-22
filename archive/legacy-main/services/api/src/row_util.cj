package itn_spire

import std.core.*
import std.convert.*
import stdx.encoding.json.*

/* Shared MySQL row/JSON helpers used by notes and wrong-answer stores. */

func cellText(row: Array<MyCell>, idx: Int64): String {
    if (idx >= row.size || row[idx].isNull) {
        return ""
    }
    return row[idx].text()
}

func optCellText(row: Array<MyCell>, idx: Int64): ?String {
    if (idx >= row.size || row[idx].isNull) {
        return None
    }
    return Some(row[idx].text())
}

func uuidText(row: Array<MyCell>, idx: Int64): ?String {
    if (idx >= row.size || row[idx].isNull) {
        return None
    }
    if (row[idx].bytes.size == 16) {
        return Some(uuidFormat(row[idx].bytes))
    }
    let t = row[idx].text()
    if (t.isEmpty()) {
        return None
    }
    return Some(t)
}

func optCellInt(row: Array<MyCell>, idx: Int64): ?Int64 {
    if (idx >= row.size || row[idx].isNull) {
        return None
    }
    return Int64.tryParse(row[idx].text())
}

func optCellFloat(row: Array<MyCell>, idx: Int64): ?Float64 {
    if (idx >= row.size || row[idx].isNull) {
        return None
    }
    return Float64.tryParse(row[idx].text())
}

func optCellBool(row: Array<MyCell>, idx: Int64): ?Bool {
    if (idx >= row.size || row[idx].isNull) {
        return None
    }
    let t = row[idx].text()
    return Some(t == "1" || t == "true" || t == "TRUE")
}

func parseJsonArrayText(text: String): String {
    let trimmed = text.trimAscii()
    if (trimmed.isEmpty()) {
        return "[]"
    }
    if (trimmed.startsWith("[")) {
        return trimmed
    }
    return "[]"
}

func jsonStringArray(items: Array<String>): String {
    var out = "["
    var first = true
    for (s in items) {
        if (!first) {
            out = out + ","
        }
        first = false
        out = out + jsonQuote(s)
    }
    return out + "]"
}

func matchFloat(v: ?Float64): String {
    match (v) {
        case Some(x) => x.toString()
        case None => "NULL"
    }
}
