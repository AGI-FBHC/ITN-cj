package itn_desktop_core.resource

import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import itn_desktop_core.util.*

public func contextFromHits(hits: JsonArray): String {
    let sb = StringBuilder()
    var i = 0
    while (i < hits.size()) {
        let n = i + 1
        sb.append("[")
        sb.append(n.toString())
        sb.append("] ")
        match (objOf(hits[i])) {
            case Some(h) =>
                sb.append("《")
                sb.append(strOf(h, "docTitle"))
                sb.append("》")
                let hp = strOf(h, "headingPath")
                if (hp.size > 0) {
                    sb.append(" · ")
                    sb.append(hp)
                }
                sb.append("（")
                sb.append(strOf(h, "docPath"))
                sb.append("）\n")
                sb.append(strOf(h, "text"))
                let cap = strOf(h, "caption")
                if (cap.size > 0) {
                    sb.append("\n[图片描述] ")
                    sb.append(cap)
                }
            case None => ()
        }
        sb.append("\n\n")
        i = i + 1
    }
    return sb.toString()
}

/** 列出出处，供界面展示与产物附录使用。 */
public func citationsFromHits(hits: JsonArray): JsonArray {
    let arr = JsonArray()
    var i = 0
    while (i < hits.size()) {
        match (objOf(hits[i])) {
            case Some(h) =>
                let c = JsonObject()
                c.put("index", JsonInt(i + 1))
                c.put("docTitle", JsonString(strOf(h, "docTitle")))
                c.put("docPath", JsonString(strOf(h, "docPath")))
                c.put("headingPath", JsonString(strOf(h, "headingPath")))
                c.put("chunkId", JsonString(if (strOf(h, "id").size > 0) { strOf(h, "id") } else { strOf(h, "chunkId") }))
                c.put("kbId", JsonString(strOf(h, "kbId")))
                c.put("text", JsonString(strOf(h, "text")))
                arr.add(c)
            case None => ()
        }
        i = i + 1
    }
    return arr
}

/** 统计产物的引用覆盖情况：段落数、带引用的段落数、越界引用编号。 */
public func citationReport(markdown: String, sourceCount: Int64): JsonObject {
    var paragraphs: Int64 = 0
    var cited: Int64 = 0
    var outOfRange: Int64 = 0
    for (block in markdown.split("\n\n")) {
        let t = trimStr(block)
        if (t.size == 0 || t.toArray()[0] == 35) {
            continue
        }
        paragraphs = paragraphs + 1
        let marks = scanCitations(t)
        if (marks.size > 0) {
            cited = cited + 1
        }
        for (m in marks) {
            if (m > sourceCount) {
                outOfRange = outOfRange + 1
            }
        }
    }
    let o = JsonObject()
    o.put("paragraphs", JsonInt(paragraphs))
    o.put("citedParagraphs", JsonInt(cited))
    o.put("outOfRange", JsonInt(outOfRange))
    return o
}

public func scanCitations(text: String): ArrayList<Int64> {
    let out = ArrayList<Int64>()
    let b = text.toArray()
    var i = 0
    while (i < b.size) {
        if (b[i] == 91) {
            var j = i + 1
            var digits = ArrayList<UInt8>()
            while (j < b.size && b[j] >= 48 && b[j] <= 57) {
                digits.add(b[j])
                j = j + 1
            }
            if (digits.size > 0 && j < b.size && b[j] == 93) {
                out.add(Int64.parse(String.fromUtf8(digits.toArray())))
                i = j
            }
        }
        i = i + 1
    }
    return out
}

