package zhixun_learning

import std.collection.*
import std.core.*

/** 一个待入库的切片：标题路径 + 正文。 */
class KbPiece {
    let headingPath: String
    let text: String

    init(headingPath: String, text: String) {
        this.headingPath = headingPath
        this.text = text
    }

    func indexText(): String {
        if (headingPath.size == 0) { return text }
        headingPath + "\n" + text
    }

    func charCount(): Int64 {
        var count: Int64 = 0
        for (value in text.toArray()) {
            if ((Int64(value) & 192) != 128) { count += 1 }
        }
        count
    }
}

class KbBlock {
    let headingPath: String
    let start: Int64
    let end: Int64

    init(headingPath: String, start: Int64, end: Int64) {
        this.headingPath = headingPath
        this.start = start
        this.end = end
    }
}

func kbIsLeadByte(value: Byte): Bool {
    (Int64(value) & 192) != 128
}

func kbCharsBetween(bytes: Array<Byte>, start: Int64, end: Int64): Int64 {
    var count: Int64 = 0
    var i = start
    while (i < end && i < bytes.size) {
        if (kbIsLeadByte(bytes[i])) { count += 1 }
        i += 1
    }
    count
}

/** 判断字节 i 是否是一个句子结束符的最后一个字节（。！？；!?; 与换行）。 */
func kbSentenceEndAt(bytes: Array<Byte>, i: Int64): Bool {
    let value = Int64(bytes[i])
    if (value == 10 || value == 33 || value == 63 || value == 59 || value == 46) { return true }
    if (i < 2) { return false }
    let first = Int64(bytes[i - 2])
    let second = Int64(bytes[i - 1])
    // 。= E3 80 82
    if (first == 0xE3 && second == 0x80 && value == 0x82) { return true }
    // ！= EF BC 81，？= EF BC 9F，；= EF BC 9B
    if (first == 0xEF && second == 0xBC && (value == 0x81 || value == 0x9F || value == 0x9B)) { return true }
    false
}

/**
 * 按 Markdown 标题把正文切成块，标题栈拼成标题路径（如「第二章 > 2.1 线性表」）。
 * 没有标题的纯文本整篇归到一个块，路径退化为文档标题。
 */
func kbBlocks(title: String, bytes: Array<Byte>): ArrayList<KbBlock> {
    let blocks = ArrayList<KbBlock>()
    let stack = ArrayList<String>()
    var currentPath = title
    var blockStart: Int64 = 0
    var lineStart: Int64 = 0
    let size = bytes.size
    var i: Int64 = 0
    while (i <= size) {
        let atEnd = i == size
        let isBreak = atEnd || Int64(bytes[i]) == 10
        if (isBreak) {
            var lineEnd = i
            if (lineEnd > lineStart && Int64(bytes[lineEnd - 1]) == 13) { lineEnd -= 1 }
            var level: Int64 = 0
            var k = lineStart
            while (k < lineEnd && Int64(bytes[k]) == 35 && level < 6) {
                level += 1
                k += 1
            }
            if (level > 0 && k < lineEnd && Int64(bytes[k]) == 32) {
                if (blockStart < lineStart) {
                    blocks.add(KbBlock(currentPath, blockStart, lineStart))
                }
                let headingText = String.fromUtf8(bytes.slice(k + 1, lineEnd - k - 1)).trimAscii()
                while (stack.size >= level) {
                    stack.remove(at: stack.size - 1)
                }
                stack.add(headingText)
                // 标题跟文档名重复时不重复拼一遍，否则每片都带着「X > X」。
                var path = if (stack.size > 0 && stack[0] != title) { title } else { "" }
                var s: Int64 = 0
                while (s < stack.size) {
                    if (path.size > 0) { path += " > " }
                    path += stack[s]
                    s += 1
                }
                currentPath = if (path.trimAscii().size == 0) { title } else { path }
                blockStart = lineStart
            }
            lineStart = i + 1
        }
        i += 1
    }
    if (blockStart < size) {
        blocks.add(KbBlock(currentPath, blockStart, size))
    }
    blocks
}

func kbCutBlock(bytes: Array<Byte>, block: KbBlock, target: Int64, overlap: Int64, out: ArrayList<KbPiece>): Unit {
    var start = block.start
    let limit = block.end
    if (start >= limit) { return }
    while (start < limit) {
        if (kbCharsBetween(bytes, start, limit) <= target) {
            let text = String.fromUtf8(bytes.slice(start, limit - start)).trimAscii()
            if (text.size > 0) { out.add(KbPiece(block.headingPath, text)) }
            return
        }
        var i = start
        var count: Int64 = 0
        var hardCut = limit
        var lastBoundary: Int64 = -1
        while (i < limit) {
            if (kbIsLeadByte(bytes[i])) {
                if (count >= target) {
                    hardCut = i
                    break
                }
                count += 1
            }
            if (kbSentenceEndAt(bytes, i)) { lastBoundary = i + 1 }
            i += 1
        }
        var cut = hardCut
        // 只在后半段找句末切点，避免第一句就把窗口切碎。
        if (lastBoundary > start && lastBoundary <= hardCut) {
            if (kbCharsBetween(bytes, start, lastBoundary) * 2 >= target) { cut = lastBoundary }
        }
        if (cut <= start) { cut = if (hardCut > start) { hardCut } else { limit } }
        let text = String.fromUtf8(bytes.slice(start, cut - start)).trimAscii()
        if (text.size > 0) { out.add(KbPiece(block.headingPath, text)) }
        if (cut >= limit) { return }
        var back = cut
        var moved: Int64 = 0
        while (back > start && moved < overlap) {
            back -= 1
            if (kbIsLeadByte(bytes[back])) { moved += 1 }
        }
        if (back <= start) { back = cut }
        if (back <= start) { return }
        start = back
    }
}

/** 切片入口：标题感知 + 句末优先 + 重叠。 */
func kbChunksFor(title: String, body: String, target: Int64, overlap: Int64): Array<KbPiece> {
    let bytes = body.toArray()
    let out = ArrayList<KbPiece>()
    if (bytes.size == 0) { return out.toArray() }
    let safeTarget = if (target < 200) { 200 } else { target }
    let safeOverlap = if (overlap < 0) { 0 } else if (overlap >= safeTarget / 2) { safeTarget / 4 } else { overlap }
    let blocks = kbBlocks(title, bytes)
    for (block in blocks) {
        kbCutBlock(bytes, block, safeTarget, safeOverlap, out)
    }
    out.toArray()
}
