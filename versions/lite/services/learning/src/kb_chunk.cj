package zhixun_learning

import std.collection.*
import std.core.*

/** Offsets refer to UTF-8 bytes in the exact canonical source body. */
class KbPiece {
    let headingPath: String
    let text: String
    let startOffset: Int64
    let endOffset: Int64
    let sourceStart: Int64
    let sourceEnd: Int64

    init(headingPath: String, text: String) {
        this.headingPath = headingPath
        this.text = text
        this.startOffset = 0
        this.endOffset = text.size
        this.sourceStart = 0
        this.sourceEnd = text.size
    }

    init(headingPath: String, text: String, startOffset: Int64, endOffset: Int64) {
        this.headingPath = headingPath
        this.text = text
        this.startOffset = startOffset
        this.endOffset = endOffset
        this.sourceStart = startOffset
        this.sourceEnd = endOffset
    }

    func indexText(): String {
        if (headingPath.size == 0) { return text }
        headingPath + "\n" + text
    }

    func charCount(): Int64 { kbCharsBetween(text.toArray(), 0, text.size) }
}

class KbBlock {
    let headingPath: String
    let start: Int64
    let end: Int64
    let indivisible: Bool
    let isHeading: Bool

    init(headingPath: String, start: Int64, end: Int64) {
        this.headingPath = headingPath
        this.start = start
        this.end = end
        this.indivisible = false
        this.isHeading = false
    }

    init(headingPath: String, start: Int64, end: Int64, indivisible: Bool) {
        this.headingPath = headingPath
        this.start = start
        this.end = end
        this.indivisible = indivisible
        this.isHeading = false
    }
    init(headingPath: String, start: Int64, end: Int64, indivisible: Bool, isHeading: Bool) {
        this.headingPath = headingPath; this.start = start; this.end = end
        this.indivisible = indivisible; this.isHeading = isHeading
    }

}

class KbSourceLine {
    let start: Int64
    let end: Int64
    let text: String

    init(start: Int64, end: Int64, text: String) {
        this.start = start
        this.end = end
        this.text = text
    }
}

func kbIsLeadByte(value: Byte): Bool { (Int64(value) & 192) != 128 }

func kbCharsBetween(bytes: Array<Byte>, start: Int64, end: Int64): Int64 {
    var count: Int64 = 0
    var i = start
    while (i < end && i < bytes.size) {
        if (kbIsLeadByte(bytes[i])) { count += 1 }
        i += 1
    }
    count
}

func kbSentenceEndAt(bytes: Array<Byte>, i: Int64): Bool {
    let value = Int64(bytes[i])
    if (value == 10 || value == 33 || value == 63 || value == 59) { return true }
    if (value == 46) {
        if (i > 0 && i + 1 < bytes.size && bytes[i - 1] >= 48 && bytes[i - 1] <= 57 &&
            bytes[i + 1] >= 48 && bytes[i + 1] <= 57) { return false }
        return true
    }
    if (i < 2) { return false }
    let first = Int64(bytes[i - 2])
    let second = Int64(bytes[i - 1])
    if (first == 0xE3 && second == 0x80 && value == 0x82) { return true }
    first == 0xEF && second == 0xBC && (value == 0x81 || value == 0x9F || value == 0x9B)
}

func kbSourceLines(bytes: Array<Byte>): ArrayList<KbSourceLine> {
    let lines = ArrayList<KbSourceLine>()
    var start: Int64 = 0
    var i: Int64 = 0
    while (i < bytes.size) {
        if (bytes[i] == 10) {
            var end = i
            if (end > start && bytes[end - 1] == 13) { end -= 1 }
            var displayStart = start
            if (start == 0 && end >= 3 && bytes[0] == 239 && bytes[1] == 187 && bytes[2] == 191) { displayStart = 3 }
            lines.add(KbSourceLine(start, i + 1, String.fromUtf8(bytes.slice(displayStart, end - displayStart))))
            start = i + 1
        }
        i += 1
    }
    if (start < bytes.size) {
        var displayStart = start
        if (start == 0 && bytes.size >= 3 && bytes[0] == 239 && bytes[1] == 187 && bytes[2] == 191) { displayStart = 3 }
        lines.add(KbSourceLine(start, bytes.size, String.fromUtf8(bytes.slice(displayStart, bytes.size - displayStart))))
    }
    lines
}

func kbLeadingSpaces(line: String): Int64 {
    let bytes = line.toArray()
    var i: Int64 = 0
    while (i < bytes.size && bytes[i] == 32) { i += 1 }
    i
}

func kbFenceOf(line: String): String {
    let indent = kbLeadingSpaces(line)
    let trimmed = line.trimAscii()
    let original = line.toArray()
    if (indent > 3 || trimmed.size < 3 || (line.size > indent && original[indent] == 9)) { return "" }
    let bytes = trimmed.toArray()
    let marker = bytes[0]
    if (marker != 96 && marker != 126) { return "" }
    var count: Int64 = 0
    while (count < bytes.size && bytes[count] == marker) { count += 1 }
    if (count < 3) { return "" }
    trimmed[0..count]
}

func kbClosesFence(line: String, fence: String): Bool {
    let trimmed = line.trimAscii()
    if (kbLeadingSpaces(line) > 3 || !trimmed.startsWith(fence)) { return false }
    let bytes = trimmed.toArray()
    let marker = fence.toArray()[0]
    var i: Int64 = 0
    while (i < bytes.size && bytes[i] == marker) { i += 1 }
    i >= fence.size && trimmed[i..trimmed.size].trimAscii().size == 0
}

func kbHeadingLevel(line: String): Int64 {
    let indent = kbLeadingSpaces(line)
    if (indent > 3) { return 0 }
    let raw = line[indent..line.size]
    let bytes = raw.toArray()
    var level: Int64 = 0
    while (level < bytes.size && level < 7 && bytes[level] == 35) { level += 1 }
    if (level == 0 || level > 6) { return 0 }
    if (level < bytes.size && bytes[level] != 32 && bytes[level] != 9) { return 0 }
    level
}

func kbSetextLevel(line: String): Int64 {
    let text = line.trimAscii()
    if (text.size < 3) { return 0 }
    let bytes = text.toArray()
    let first = bytes[0]
    if (first != 61 && first != 45) { return 0 }
    for (byte in bytes) { if (byte != bytes[0]) { return 0 } }
    if (first == 61) { 1 } else { 2 }
}

func kbTexCloser(line: String): String {
    let text = line.trimAscii()
    if (text.startsWith("$$")) {
        if (text.size > 2 && text.endsWith("$$")) { return "" }
        return "$$"
    }
    if (text.startsWith("\\[")) {
        if (text.endsWith("\\]")) { return "" }
        return "\\]"
    }
    for (name in ["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "displaymath"]) {
        if (text.startsWith("\\begin{" + name + "}")) { return "\\end{" + name + "}" }
    }
    ""
}

func kbIsImageLine(line: String): Bool {
    line.contains("![") || line.toAsciiLower().contains("<img") || line.toAsciiLower().contains("<figure")
}

func kbIsCaptionLine(line: String): Bool {
    var text = line.trimAscii().toAsciiLower()
    while (text.startsWith("*") || text.startsWith("_")) { text = text[1..text.size] }
    text.startsWith("图") || text.startsWith("表") || text.startsWith("figure ") ||
        text.startsWith("fig.") || text.startsWith("table ") || text.startsWith("<figcaption") ||
        text.startsWith("<p ") || text.startsWith("<p>") || text.startsWith("</figure>") || text.startsWith("</div>")
}

/** Keep each list item and its continuation together, while long lists may span slices. */
func kbIsListLine(line: String): Bool {
    let text = line.trimAscii().toArray()
    if (text.size < 2) { return false }
    if ((text[0] == 45 || text[0] == 43 || text[0] == 42) && (text[1] == 32 || text[1] == 9)) { return true }
    var i: Int64 = 0
    while (i < text.size && text[i] >= 48 && text[i] <= 57) { i += 1 }
    i > 0 && i + 1 < text.size && (text[i] == 46 || text[i] == 41) && (text[i + 1] == 32 || text[i + 1] == 9)
}

/** Semantic spans cover every byte, including blank lines and a leading BOM. */
func kbBlocks(title: String, bytes: Array<Byte>): ArrayList<KbBlock> {
    let lines = kbSourceLines(bytes)
    let blocks = ArrayList<KbBlock>()
    let stack = ArrayList<String>()
    let levels = ArrayList<Int64>()
    var currentPath = title
    var i: Int64 = 0
    while (i < lines.size) {
        let line = lines[i]
        let trimmed = line.text.trimAscii()
        var finish = i + 1
        var indivisible = false
        let fence = kbFenceOf(line.text)
        let texCloser = kbTexCloser(line.text)
        var level = kbHeadingLevel(line.text)
        var heading = ""
        if (level > 0) { heading = trimmed[level..trimmed.size].trimAscii() }
        if (level == 0 && trimmed.size > 0 && i + 1 < lines.size &&
            !kbIsImageLine(line.text) && fence.size == 0 && texCloser.size == 0) {
            level = kbSetextLevel(lines[i + 1].text)
            if (level > 0) { heading = trimmed; finish = i + 2 }
        }
        if (fence.size > 0) {
            indivisible = true
            while (finish < lines.size) {
                let closes = kbClosesFence(lines[finish].text, fence)
                finish += 1
                if (closes) { break }
            }
        } else if (texCloser.size > 0) {
            indivisible = true
            if (trimmed == texCloser || !trimmed.contains(texCloser)) {
                while (finish < lines.size) {
                    let closes = lines[finish].text.trimAscii().contains(texCloser)
                    finish += 1
                    if (closes) { break }
                }
            }
        } else if (trimmed.startsWith("$$") || trimmed.startsWith("\\[")) {
            indivisible = true
        } else if (level > 0) {
            while (levels.size > 0 && levels[levels.size - 1] >= level) {
                levels.remove(at: levels.size - 1)
                stack.remove(at: stack.size - 1)
            }
            levels.add(level)
            stack.add(heading)
            var joined = if (stack.size > 0 && stack[0] == title) { "" } else { title }
            for (item in stack) {
                if (joined.size > 0) { joined += " > " }
                joined += item
            }
            currentPath = joined
            indivisible = true
        } else if (kbIsImageLine(line.text)) {
            indivisible = true
            if (trimmed.toAsciiLower().startsWith("<figure") && !trimmed.toAsciiLower().contains("</figure>")) {
                while (finish < lines.size) {
                    let closes = lines[finish].text.toAsciiLower().contains("</figure>")
                    finish += 1
                    if (closes) { break }
                }
            } else {
                var probe = finish
                while (probe < lines.size && lines[probe].text.trimAscii().size == 0) { probe += 1 }
                if (probe < lines.size && kbIsCaptionLine(lines[probe].text)) {
                    finish = probe + 1
                    while (finish < lines.size && kbIsCaptionLine(lines[finish].text)) { finish += 1 }
                }
            }
        } else if (trimmed.contains("|")) {
            indivisible = true
            while (finish < lines.size && lines[finish].text.trimAscii().contains("|")) { finish += 1 }
            var probe = finish
            while (probe < lines.size && lines[probe].text.trimAscii().size == 0) { probe += 1 }
            if (probe < lines.size && kbIsCaptionLine(lines[probe].text)) { finish = probe + 1 }
        } else if (kbIsListLine(line.text)) {
            indivisible = true
            let indent = kbLeadingSpaces(line.text)
            while (finish < lines.size) {
                let next = lines[finish]
                if (next.text.trimAscii().size == 0 || kbLeadingSpaces(next.text) <= indent ||
                    kbIsListLine(next.text) || kbHeadingLevel(next.text) > 0 || kbFenceOf(next.text).size > 0 ||
                    kbTexCloser(next.text).size > 0 || kbIsImageLine(next.text) || next.text.contains("|")) { break }
                finish += 1
            }
        }
        blocks.add(KbBlock(currentPath, line.start, lines[finish - 1].end, indivisible, level > 0))
        i = finish
    }
    blocks
}

func kbCutSpan(bytes: Array<Byte>, headingPath: String, first: Int64, limit: Int64,
    target: Int64, overlap: Int64, atoms: ArrayList<KbBlock>, out: ArrayList<KbPiece>): Unit {
    var start = first
    var previousEnd = first
    var firstAtom: Int64 = 0
    while (start < limit) {
        while (firstAtom < atoms.size && atoms[firstAtom].end <= start) { firstAtom += 1 }
        var cut = limit
        var i = start
        var count: Int64 = 0
        var boundary: Int64 = -1
        while (i < limit) {
            if (kbIsLeadByte(bytes[i])) {
                if (count >= target) { cut = i; break }
                count += 1
            }
            if (kbSentenceEndAt(bytes, i) && count * 2 >= target) { boundary = i + 1 }
            i += 1
        }
        if (cut < limit) {
            if (boundary > start && boundary <= cut) { cut = boundary }
            var a = firstAtom
            while (a < atoms.size) {
                let atom = atoms[a]
                if (atom.start >= cut) { break }
                if (atom.indivisible && atom.start < cut && cut < atom.end) {
                    cut = if (atom.start > start) { atom.start } else { atom.end }
                    break
                }
                a += 1
            }
        }
        if (cut <= start) { throw Exception("切片无法前进") }
        // A window before a large protected block can consist only of the overlap.
        // Restart at the already-covered edge instead of emitting a duplicate range.
        if (cut <= previousEnd) { start = previousEnd; continue }
        previousEnd = cut
        out.add(KbPiece(headingPath, String.fromUtf8(bytes.slice(start, cut - start)), start, cut))
        if (cut >= limit) { return }
        var back = cut
        var moved: Int64 = 0
        while (back > start && moved < overlap) {
            back -= 1
            if (kbIsLeadByte(bytes[back])) { moved += 1 }
        }
        var a = firstAtom
        while (a < atoms.size) {
            let atom = atoms[a]
            if (atom.start >= back) { break }
            if (atom.indivisible && atom.start < back && back < atom.end) { back = atom.end; break }
            a += 1
        }
        if (back <= start || back >= cut) { back = cut }
        start = back
    }
}

/** Validate source identity and full byte coverage before database writes. */
func kbValidatePieces(body: String, pieces: Array<KbPiece>): Unit {
    let bytes = body.toArray()
    if (bytes.size == 0) {
        if (pieces.size != 0) { throw Exception("空原文不应生成切片") }
        return
    }
    if (pieces.size == 0) { throw Exception("非空原文没有切片") }
    var covered: Int64 = 0
    var lastStart: Int64 = -1
    for (piece in pieces) {
        let start = piece.startOffset
        let end = piece.endOffset
        if (start < 0 || end <= start || end > bytes.size || start > covered || start < lastStart || end <= covered) {
            throw Exception("切片范围无效、乱序或原文覆盖存在缺口")
        }
        if ((start < bytes.size && !kbIsLeadByte(bytes[start])) || (end < bytes.size && !kbIsLeadByte(bytes[end]))) {
            throw Exception("切片边界切断 UTF-8 字符")
        }
        if (piece.text != String.fromUtf8(bytes.slice(start, end - start))) { throw Exception("切片文字与原文范围不一致") }
        lastStart = start
        covered = end
    }
    if (covered != bytes.size) { throw Exception("切片未覆盖原文结尾") }
}

/** A heading chain belongs to its following paragraph/list, never to a standalone index slice. */
func kbAttachHeadingBodies(bytes: Array<Byte>, blocks: ArrayList<KbBlock>): ArrayList<KbBlock> {
    let out = ArrayList<KbBlock>()
    var i: Int64 = 0
    while (i < blocks.size) {
        if (!blocks[i].isHeading) { out.add(blocks[i]); i += 1; continue }
        let start = blocks[i].start
        var finish = i + 1
        var path = blocks[i].headingPath
        while (finish < blocks.size) {
            let block = blocks[finish]
            let blank = String.fromUtf8(bytes.slice(block.start, block.end - block.start)).trimAscii().size == 0
            if (!block.isHeading && !blank) { break }
            if (block.isHeading) { path = block.headingPath }
            finish += 1
        }
        if (finish < blocks.size) {
            let first = blocks[finish]
            path = first.headingPath
            finish += 1
            if (!first.indivisible) {
                while (finish < blocks.size && !blocks[finish].isHeading && !blocks[finish].indivisible) {
                    let block = blocks[finish]
                    if (String.fromUtf8(bytes.slice(block.start, block.end - block.start)).trimAscii().size == 0) { break }
                    finish += 1
                }
            }
        }
        out.add(KbBlock(path, start, blocks[finish - 1].end, true, false))
        i = finish
    }
    out
}

func kbSharedHeading(left: String, right: String, fallback: String): String {
    let a = left.split(" > ")
    let b = right.split(" > ")
    var i: Int64 = 0
    let out = StringBuilder()
    while (i < a.size && i < b.size && a[i] == b[i]) {
        if (i > 0) { out.append(" > ") }
        out.append(a[i]); i += 1
    }
    if (i == 0) { fallback } else { out.toString() }
}

/** An empty separator or heading chain is context, not an independent retrieval unit. */
func kbHasChunkBody(text: String): Bool {
    for (line in kbSourceLines(text.toArray())) {
        let value = line.text.trimAscii()
        if (value.size == 0 || kbHeadingLevel(line.text) > 0 || kbSetextLevel(line.text) > 0) { continue }
        if (value == "***" || value == "---" || value == "___") { continue }
        return true
    }
    false
}

/** Quality repair is part of every import, before summaries and embeddings are requested. */
func kbCoalesceSmallPieces(title: String, bytes: Array<Byte>, pieces: ArrayList<KbPiece>, target: Int64): Array<KbPiece> {
    let minimum = target / 4
    let maximum = target + target / 2
    var i: Int64 = 0
    while (i < pieces.size && pieces.size > 1) {
        let piece = pieces[i]
        let contextOnly = !kbHasChunkBody(piece.text)
        if (!contextOnly && piece.charCount() >= minimum) { i += 1; continue }
        let leftSize = if (i > 0) { kbCharsBetween(bytes, pieces[i - 1].startOffset, piece.endOffset) } else { bytes.size + maximum }
        let rightSize = if (i + 1 < pieces.size) { kbCharsBetween(bytes, piece.startOffset, pieces[i + 1].endOffset) } else { bytes.size + maximum }
        let canLeft = i > 0 && (contextOnly || leftSize <= maximum)
        let canRight = i + 1 < pieces.size && (contextOnly || rightSize <= maximum)
        if (!canLeft && !canRight) { i += 1; continue }
        let left = if (canLeft && (!canRight || leftSize <= rightSize)) { i - 1 } else { i }
        let first = pieces[left]
        let last = pieces[left + 1]
        pieces[left] = KbPiece(kbSharedHeading(first.headingPath, last.headingPath, title),
            String.fromUtf8(bytes.slice(first.startOffset, last.endOffset - first.startOffset)), first.startOffset, last.endOffset)
        pieces.remove(at: left + 1)
        i = left
    }
    pieces.toArray()
}

/** Pack complete content blocks toward the target instead of forcing a split at every heading. */
func kbChunksFor(title: String, body: String, target: Int64, overlap: Int64): Array<KbPiece> {
    let bytes = body.toArray()
    let out = ArrayList<KbPiece>()
    if (bytes.size == 0) { return out.toArray() }
    let safeTarget = if (target < 200) { 200 } else { target }
    let safeOverlap = if (overlap < 0) { 0 } else if (overlap >= safeTarget / 2) { safeTarget / 4 } else { overlap }
    let blocks = kbAttachHeadingBodies(bytes, kbBlocks(title, bytes))
    let raw = ArrayList<KbPiece>()
    kbCutSpan(bytes, title, 0, bytes.size, safeTarget, safeOverlap, blocks, raw)
    var firstBlock: Int64 = 0
    for (piece in raw) {
        while (firstBlock < blocks.size && blocks[firstBlock].end <= piece.startOffset) { firstBlock += 1 }
        var path = ""
        var i = firstBlock
        while (i < blocks.size && blocks[i].start < piece.endOffset) {
            let block = blocks[i]
            if (String.fromUtf8(bytes.slice(block.start, block.end - block.start)).trimAscii().size > 0) {
                path = if (path.size == 0) { block.headingPath } else { kbSharedHeading(path, block.headingPath, title) }
            }
            i += 1
        }
        out.add(KbPiece(if (path.size > 0) { path } else { title }, piece.text, piece.startOffset, piece.endOffset))
    }
    let pieces = kbCoalesceSmallPieces(title, bytes, out, safeTarget)
    kbValidatePieces(body, pieces)
    if (pieces.size > 1 && kbHasChunkBody(body)) {
        for (piece in pieces) {
            if (!kbHasChunkBody(piece.text)) { throw Exception("切片缺少正文，应与相邻内容自动合并") }
        }
    }
    pieces
}
