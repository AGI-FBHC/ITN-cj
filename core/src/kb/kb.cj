package itn_desktop_core.kb

import std.fs.*
import std.collection.*
import std.math.*
import stdx.encoding.json.*
import itn_desktop_core.store.*
import itn_desktop_core.util.*

func lineStartsWith(line: String, prefix: String): Bool {
    let lb = line.toArray()
    let pb = prefix.toArray()
    if (pb.size > lb.size) { return false }
    var i = 0
    while (i < pb.size) {
        if (lb[i] != pb[i]) { return false }
        i = i + 1
    }
    return true
}

func headingLevel(line: String): Int64 {
    let b = line.toArray()
    var n = 0
    while (n < b.size && n < 6 && b[n] == 35) { n = n + 1 }
    if (n == 0) { return 0 }
    if (n < b.size && b[n] == 32) { return n }
    return 0
}

func headingText(line: String, level: Int64): String {
    let b = line.toArray()
    return trimStr(String.fromUtf8(b[(level + 1)..b.size]))
}

func extractImages(line: String, out: ArrayList<String>): Unit {
    let b = line.toArray()
    var i = 0
    while (i + 1 < b.size) {
        if (b[i] == 33 && b[i + 1] == 91) {
            var j = i + 2
            var closeBracket = -1
            while (j < b.size) {
                if (b[j] == 93 && j + 1 < b.size && b[j + 1] == 40) {
                    closeBracket = j
                    break
                }
                j = j + 1
            }
            if (closeBracket > 0) {
                var k = closeBracket + 2
                var endParen = -1
                while (k < b.size) {
                    if (b[k] == 41) { endParen = k; break }
                    k = k + 1
                }
                if (endParen > 0) {
                    let target = trimStr(String.fromUtf8(b[(closeBracket + 2)..endParen]))
                    if (target.size > 0) { out.add(target) }
                    i = endParen
                }
            }
        }
        i = i + 1
    }
}

public class KbChunk {
    public var id: String = ""
    public var docPath: String = ""
    public var docTitle: String = ""
    public var headingPath: String = ""
    public var ordinal: Int64 = 0
    public var text: String = ""
    public var images: ArrayList<String> = ArrayList<String>()
    public var caption: String = ""
    public var captionError: String = ""
    public var vector: ArrayList<Float64> = ArrayList<Float64>()

    public init() {}

    public func indexText(): String {
        if (caption.size > 0) {
            return text + "\n[图片描述] " + caption
        }
        return text
    }

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("id", JsonString(id))
        o.put("docPath", JsonString(docPath))
        o.put("docTitle", JsonString(docTitle))
        o.put("headingPath", JsonString(headingPath))
        o.put("ordinal", JsonInt(ordinal))
        o.put("text", JsonString(text))
        o.put("caption", JsonString(caption))
        o.put("captionError", JsonString(captionError))
        let imgs = JsonArray()
        for (i in images) { imgs.add(JsonString(i)) }
        o.put("images", imgs)
        // 向量不写进 JSON：千万级浮点做成 JSON 对象会直接把内存打爆，
        // 改由 indexer 以紧凑文本单独存放。
        return o
    }

    public static func fromJson(v: JsonValue): KbChunk {
        let c = KbChunk()
        match (objOf(v)) {
            case Some(o) =>
                c.id = strOf(o, "id")
                c.docPath = strOf(o, "docPath")
                c.docTitle = strOf(o, "docTitle")
                c.headingPath = strOf(o, "headingPath")
                c.ordinal = intOf(o, "ordinal")
                c.text = strOf(o, "text")
                c.caption = strOf(o, "caption")
                c.captionError = strOf(o, "captionError")
                c.images = strArrayOf(o, "images")
                match (o.get("vector")) {
                    case Some(vv) =>
                        match (vv) {
                            case va: JsonArray =>
                                var i = 0
                                while (i < va.size()) {
                                    c.vector.add(floatValue(va[i]))
                                    i = i + 1
                                }
                            case _ => ()
                        }
                    case None => ()
                }
            case None => ()
        }
        return c
    }
}

public class KbIndex {
    public var kbId: String = ""
    public var rootDir: String = ""
    public var builtAt: String = ""
    public var chunks: ArrayList<KbChunk> = ArrayList<KbChunk>()

    public init() {}

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("kbId", JsonString(kbId))
        o.put("rootDir", JsonString(rootDir))
        o.put("builtAt", JsonString(builtAt))
        let arr = JsonArray()
        for (c in chunks) { arr.add(c.toJson()) }
        o.put("chunks", arr)
        return o
    }

    public static func fromJson(v: JsonValue): KbIndex {
        let idx = KbIndex()
        match (objOf(v)) {
            case Some(o) =>
                idx.kbId = strOf(o, "kbId")
                idx.rootDir = strOf(o, "rootDir")
                idx.builtAt = strOf(o, "builtAt")
                match (o.get("chunks")) {
                    case Some(cv) =>
                        match (cv) {
                            case ca: JsonArray =>
                                var i = 0
                                while (i < ca.size()) {
                                    idx.chunks.add(KbChunk.fromJson(ca[i]))
                                    i = i + 1
                                }
                            case _ => ()
                        }
                    case None => ()
                }
            case None => ()
        }
        return idx
    }

    public func docCount(): Int64 {
        let seen = HashSet<String>()
        for (c in chunks) { seen.add(c.docPath) }
        return seen.size
    }

    public func imageCount(): Int64 {
        var n: Int64 = 0
        for (c in chunks) { n = n + c.images.size }
        return n
    }
}

public class ScannedDoc {
    public var relPath: String = ""
    public var title: String = ""
    public var fullPath: String = ""
    public init(rel: String, title: String, full: String) {
        this.relPath = rel
        this.title = title
        this.fullPath = full
    }
}

func walkDocs(dir: String, rel: String, out: ArrayList<ScannedDoc>): Unit {
    Directory.walk(Path(dir), { fi: FileInfo =>
        let nm = fi.name
        let childRel = if (rel.size == 0) { nm } else { rel + "/" + nm }
        let childFull = dir + Path.Separator + nm
        if (fi.isDirectory()) {
            walkDocs(childFull, childRel, out)
        } else {
            let ext = Path(nm).extensionName
            if (ext == "md" || ext == "txt") {
                out.add(ScannedDoc(childRel, nm, childFull))
            }
        }
        true
    })
}

public func scanDocs(root: String): ArrayList<ScannedDoc> {
    let out = ArrayList<ScannedDoc>()
    walkDocs(root, "", out)
    return out
}

/** 按 Markdown 标题层级分块；代码块内不切分；同时收集图片引用。 */
public func firstH1(content: String): String {
    for (line in splitLines(content)) {
        let trimmed = trimStr(line)
        if (headingLevel(trimmed) == 1) {
            return headingText(trimmed, 1)
        }
    }
    return ""
}

public func chunkDocument(doc: ScannedDoc, content: String, maxChars: Int64): ArrayList<KbChunk> {
    let chunks = ArrayList<KbChunk>()
    let lines = splitLines(content)
    var headingStack = Array<String>(6, repeat: "")
    var buffer = StringBuilder()
    var bufferImages = ArrayList<String>()
    var inCode = false
    var ordinal: Int64 = 0
    let h1 = firstH1(content)
    let title = if (h1.size > 0) { h1 } else { doc.title }

    func headingPathStr(): String {
        let parts = ArrayList<String>()
        var i = 0
        while (i < 6) {
            if (headingStack[i].size > 0) { parts.add(headingStack[i]) }
            i = i + 1
        }
        return joinWith(parts, " > ")
    }

    func flush(): Unit {
        let text = trimStr(buffer.toString())
        if (text.size == 0) { return }
        let c = KbChunk()
        c.id = doc.relPath + "#" + ordinal.toString()
        c.docPath = doc.relPath
        c.docTitle = title
        c.headingPath = headingPathStr()
        c.ordinal = ordinal
        c.text = text
        c.images = bufferImages
        chunks.add(c)
        ordinal = ordinal + 1
        buffer = StringBuilder()
        bufferImages = ArrayList<String>()
    }

    for (line in lines) {
        let trimmed = trimStr(line)
        if (lineStartsWith(trimmed, "```")) {
            inCode = !inCode
            buffer.append(line)
            buffer.append("\n")
            continue
        }
        if (!inCode) {
            let lvl = headingLevel(trimmed)
            if (lvl > 0) {
                flush()
                headingStack[lvl - 1] = headingText(trimmed, lvl)
                var k = lvl
                while (k < 6) {
                    headingStack[k] = ""
                    k = k + 1
                }
                continue
            }
        }
        extractImages(line, bufferImages)
        buffer.append(line)
        buffer.append("\n")
        if (buffer.toString().size > maxChars) {
            flush()
        }
    }
    flush()
    return chunks
}

public class SearchHit {
    public var chunk: KbChunk
    public var score: Float64
    public init(chunk: KbChunk, score: Float64) {
        this.chunk = chunk
        this.score = score
    }
}

public func cosine(a: ArrayList<Float64>, b: Array<Float64>): Float64 {
    var dot = 0.0
    var na = 0.0
    var nb = 0.0
    let n = if (a.size < b.size) { a.size } else { b.size }
    var i = 0
    while (i < n) {
        dot = dot + a[i] * b[i]
        na = na + a[i] * a[i]
        nb = nb + b[i] * b[i]
        i = i + 1
    }
    if (na <= 0.0 || nb <= 0.0) { return 0.0 }
    return dot / (sqrt(na) * sqrt(nb))
}

public func search(index: KbIndex, queryVector: Array<Float64>, topK: Int64): ArrayList<SearchHit> {
    let pool = ArrayList<SearchHit>()
    for (c in index.chunks) {
        if (c.vector.size == 0) { continue }
        pool.add(SearchHit(c, cosine(c.vector, queryVector)))
    }
    let n = pool.size
    let k = if (topK < n) { topK } else { n }
    let out = ArrayList<SearchHit>()
    var taken: Int64 = 0
    while (taken < k) {
        var best = -1
        var bestScore = -2.0
        var i = 0
        while (i < n) {
            if (pool[i].score > bestScore) {
                bestScore = pool[i].score
                best = i
            }
            i = i + 1
        }
        if (best < 0) { break }
        // 取用后把原项标记为已选，但返回值必须是副本，否则分数会被标记值覆盖
        out.add(SearchHit(pool[best].chunk, bestScore))
        pool[best].score = -2.0
        taken = taken + 1
    }
    return out
}
