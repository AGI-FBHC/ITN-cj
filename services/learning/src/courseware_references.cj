package zhixun_learning

import std.collection.*
import std.convert.*
import std.core.*
import stdx.encoding.json.*

/** The excerpt is copied from the exact chapter text used by cwEvidence. */
func cwChapterReference(docId: String, bundleId: String, title: String, sourcePath: String, content: String): String {
    if (docId.size == 0 || content.trimAscii().size == 0) { return "[]" }
    let source = JsonWriter()
    source.putInt("number", 1)
    source.putStr("kind", "chapter-original")
    source.putStr("label", "上传章节原文")
    source.putStr("docId", docId)
    source.putStr("bundleId", bundleId)
    source.putStr("title", title)
    source.putStr("sourcePath", sourcePath)
    source.putStr("excerpt", cwTextOf(content, 16000))
    source.putBool("excerptTruncated", content.size > 16000)
    "[" + source.toJson() + "]"
}

func cwChapterReferences(cfg: Config, docId: String): String {
    if (docId.size == 0) { return "[]" }
    let docs = queryIndependent(cfg, "SELECT id,bundle_id,title,content,COALESCE(source_path,'') source_path " +
        "FROM kb_bundle_docs WHERE id=" + sqlQuote(docId) + " LIMIT 1")
    if (docs.size == 0) { return "[]" }
    let doc = docs[0]
    cwChapterReference(doc.text("id"), doc.text("bundle_id"), doc.text("title"), doc.text("source_path"), doc.text("content"))
}

/** Replace a top-level value without reserializing unrelated JSON/code escapes. */
func cwReferenceSetField(raw: String, key: String, value: String): String {
    let text = raw.trimAscii()
    let bytes = text.toArray()
    if (bytes.size < 2 || bytes[0] != 123) { return raw }
    var i: Int64 = 1
    while (i < bytes.size - 1) {
        while (i < bytes.size && (bytes[i] == 32 || bytes[i] == 10 || bytes[i] == 13 || bytes[i] == 9 || bytes[i] == 44)) { i += 1 }
        if (i >= bytes.size || bytes[i] != 34) { break }
        let nameStart = i
        i += 1
        while (i < bytes.size && bytes[i] != 34) {
            if (bytes[i] == 92) { i += 1 }
            i += 1
        }
        if (i >= bytes.size) { return raw }
        let name = text[nameStart..i + 1]
        i += 1
        while (i < bytes.size && bytes[i] != 58) { i += 1 }
        i += 1
        let start = i
        var depth: Int64 = 0
        var quoted = false
        while (i < bytes.size) {
            let b = bytes[i]
            if (quoted) {
                if (b == 92) { i += 2; continue }
                if (b == 34) { quoted = false }
            } else if (b == 34) { quoted = true }
            else if (b == 91 || b == 123) { depth += 1 }
            else if (depth == 0 && (b == 44 || b == 125)) { break }
            else if (b == 93 || b == 125) { depth -= 1 }
            i += 1
        }
        if (name == jsonQuote(key)) { return text[0..start] + value + text[i..text.size] }
    }
    let middle = if (text[1..text.size - 1].trimAscii().size > 0) { "," } else { "" }
    text[0..text.size - 1] + middle + jsonQuote(key) + ":" + value + "}"
}

func cwReferenceBracketEnd(bytes: Array<Byte>, start: Int64, open: Byte, close: Byte): Int64 {
    var depth: Int64 = 0
    var i = start
    while (i < bytes.size) {
        if (bytes[i] == 92) { i += 2; continue }
        if (bytes[i] == open) { depth += 1 }
        if (bytes[i] == close) { depth -= 1; if (depth == 0) { return i + 1 } }
        i += 1
    }
    start
}

func cwReferenceIndexByte(b: Byte): Bool {
    (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) ||
        b == 95 || b == 36 || b == 93 || b == 41
}

func cwReferenceProse(text: String, valid: HashSet<Int64>, definitions: HashSet<String>): String {
    let bytes = text.toArray()
    let out = StringBuilder()
    let used = ArrayList<Int64>()
    var i: Int64 = 0
    var start: Int64 = 0
    while (i < bytes.size) {
        if (bytes[i] == 92) { i += 2; continue }
        if (bytes[i] == 96) {
            var run: Int64 = 1
            while (i + run < bytes.size && bytes[i + run] == 96) { run += 1 }
            let marker = text[i..i + run]
            var end = text.indexOf(marker, i + run)
            while (end != None) {
                let at = end.getOrThrow()
                if (bytes[at - 1] != 96 && (at + run == bytes.size || bytes[at + run] != 96)) { break }
                end = text.indexOf(marker, at + run)
            }
            i = match (end) { case Some(at) => at + run; case None => bytes.size }
            continue
        }
        if (bytes[i] == 91) {
            let end = cwReferenceBracketEnd(bytes, i, 91, 93)
            if (end > i) {
                var next = end
                while (next < bytes.size && (bytes[next] == 32 || bytes[next] == 9)) { next += 1 }
                let label = text[i + 1..end - 1]
                var digits = label.size > 0
                for (b in label.toArray()) { if (b < 48 || b > 57) { digits = false } }
                if (next < bytes.size && (bytes[next] == 40 || bytes[next] == 91)) {
                    let close: Byte = if (bytes[next] == 40) { 41 } else { 93 }
                    let stop = cwReferenceBracketEnd(bytes, next, bytes[next], close)
                    var adjacent = false
                    if (digits && bytes[next] == 91 && stop > next) {
                        let nextLabel = text[next + 1..stop - 1]
                        var numeric = nextLabel.size > 0
                        for (b in nextLabel.toArray()) { if (b < 48 || b > 57) { numeric = false } }
                        adjacent = numeric && !definitions.contains(nextLabel)
                    }
                    if (stop > next && !adjacent) { i = stop; continue }
                }
                var previous = i
                while (previous > 0 && (bytes[previous - 1] == 32 || bytes[previous - 1] == 9)) { previous -= 1 }
                let indexed = (i > start && cwReferenceIndexByte(bytes[i - 1])) ||
                    (previous > 0 && (bytes[previous - 1] == 61 || bytes[previous - 1] == 40 || bytes[previous - 1] == 91 ||
                        bytes[previous - 1] == 123 || bytes[previous - 1] == 44 || bytes[previous - 1] == 58))
                if (digits && !indexed && !definitions.contains(label) && !(next < bytes.size && bytes[next] == 58)) {
                    let number = Int64.tryParse(label) ?? 0
                    out.append(text[start..i])
                    if (valid.contains(number) && !used.contains(number)) { used.add(number) }
                    start = end
                }
                i = end; continue
            }
        }
        i += 1
    }
    out.append(text[start..text.size])
    let cleaned = out.toString()
    if (used.size == 0) { return cleaned }
    var end = cleaned.size
    let cleanBytes = cleaned.toArray()
    while (end > 0 && (cleanBytes[end - 1] == 32 || cleanBytes[end - 1] == 9 || cleanBytes[end - 1] == 13 || cleanBytes[end - 1] == 10)) { end -= 1 }
    let result = StringBuilder(); result.append(cleaned[0..end])
    for (number in used) { result.append(" [" + number.toString() + "]") }
    var trailing = text.size
    while (trailing > 0 && (bytes[trailing - 1] == 32 || bytes[trailing - 1] == 9 || bytes[trailing - 1] == 13 || bytes[trailing - 1] == 10)) { trailing -= 1 }
    result.append(text[trailing..text.size])
    result.toString()
}

/** One marker per source/paragraph. Code and Markdown destinations are opaque. */
func cwNormalizeCoursewareCitations(markdown: String, references: String): String {
    let valid = HashSet<Int64>()
    for (source in cwObjectList(cwJsonObjectFrom("{\"items\":" + references + "}").getOrThrow(), "items")) {
        if (cwField(source, "excerpt").trimAscii().size > 0) { valid.add(jsonGetInt(source, "number") ?? 0) }
    }
    let lines = kbSourceLines(markdown.toArray())
    let definitions = HashSet<String>()
    for (line in lines) {
        let value = line.text.trimAscii()
        if (value.startsWith("[")) {
            match (value.indexOf("]:")) { case Some(at) => definitions.add(value[1..at]); case None => () }
        }
    }
    let out = StringBuilder()
    var paragraph = ""
    var fence = ""
    for (line in lines) {
        let raw = markdown[line.start..line.end]
        let opening = kbFenceOf(line.text)
        if (fence.size > 0) {
            out.append(raw)
            if (kbClosesFence(line.text, fence)) { fence = "" }
        } else if (opening.size > 0) {
            out.append(cwReferenceProse(paragraph, valid, definitions)); paragraph = ""
            fence = opening; out.append(raw)
        } else if (line.text.trimAscii().size == 0 || kbLeadingSpaces(line.text) >= 4 || line.text.startsWith("\t")) {
            out.append(cwReferenceProse(paragraph, valid, definitions)); paragraph = ""; out.append(raw)
        } else if (kbHeadingLevel(line.text) > 0 || line.text.trimAscii().startsWith("- ") ||
            line.text.trimAscii().startsWith("* ") || line.text.trimAscii().startsWith("> ") || line.text.trimAscii().startsWith("|")) {
            out.append(cwReferenceProse(paragraph, valid, definitions)); paragraph = ""
            out.append(cwReferenceProse(raw, valid, definitions))
        } else { paragraph += raw }
    }
    out.append(cwReferenceProse(paragraph, valid, definitions))
    out.toString()
}

func cwAttachReferences(content: String, references: String): String {
    let raw = cwStripFences(content).trimAscii()
    let parsed = cwJsonObjectFrom(raw)
    if (parsed.isNone()) { return content }
    let sections = JsonArrWriter()
    for (item in cwRawObjectItems(lrArray(raw, "sections"))) {
        let section = cwJsonObjectFrom(item).getOrThrow()
        var normalized = item
        for (key in ["heading", "body", "text"]) {
            if (jsonHas(section, key)) {
                let valid = if (key == "heading") { "[]" } else { references }
                normalized = cwReferenceSetField(normalized, key, jsonQuote(cwNormalizeCoursewareCitations(cwField(section, key), valid)))
            }
        }
        sections.addRaw(normalized)
    }
    var out = raw
    if (jsonHas(parsed.getOrThrow(), "sections")) { out = cwReferenceSetField(out, "sections", sections.toJson()) }
    out = cwReferenceSetField(out, "references", references)
    cwReferenceSetField(out, "sources", references)
}
