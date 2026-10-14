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

    /** 参与检索的文本。标题路径也要进来：像「常用手法」这种词往往只在标题里，
        正文并不出现，漏掉标题会让检索直接找不到这一段。 */
    public func indexText(): String {
        var s = headingPath
        if (s.size > 0) {
            s = s + "\n"
        }
        s = s + text
        if (caption.size > 0) {
            s = s + "\n[图片描述] " + caption
        }
        return s
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
    /** 这次扫描"漏掉了什么"：不做这个，用户把 PDF 放进来只会看到"没有找到文件" */
    public var scan: ScanReport = ScanReport()

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

/**
 * 一次目录扫描的"漏掉了什么"报告。
 *
 * 动机很直接：老师的资料大量是 PDF/Word，而桌面版只读纯文本类文件。
 * 如果只是静默跳过，用户看到"没有找到文件"根本不知道问题出在哪。
 * 这里按扩展名统计跳过的文件数，随建设索引的结果一起回给界面。
 */
public class ScanReport {
    public var skipExts: ArrayList<String> = ArrayList<String>()
    public var skipCounts: ArrayList<Int64> = ArrayList<Int64>()
    /** 超过体积上限被跳过的个数 */
    public var tooBig: Int64 = 0

    public func note(ext: String): Unit {
        let key = if (ext.size == 0) { "（无扩展名）" } else { ext }
        var i = 0
        while (i < skipExts.size) {
            if (skipExts[i] == key) {
                skipCounts[i] = skipCounts[i] + 1
                return
            }
            i = i + 1
        }
        skipExts.add(key)
        skipCounts.add(1)
    }

    public func total(): Int64 {
        var n = tooBig
        for (c in skipCounts) { n = n + c }
        return n
    }

    /** 形如「pdf ×3、docx ×1」。 */
    public func summary(): String {
        let sb = StringBuilder()
        var i = 0
        while (i < skipExts.size) {
            if (i > 0) { sb.append("、") }
            sb.append(skipExts[i])
            sb.append(" ×")
            sb.append(skipCounts[i].toString())
            i = i + 1
        }
        if (tooBig > 0) {
            if (sb.toString().size > 0) { sb.append("、") }
            sb.append("超过体积上限 ×")
            sb.append(tooBig.toString())
        }
        return sb.toString()
    }

    public func toJson(): JsonArray {
        let arr = JsonArray()
        var i = 0
        while (i < skipExts.size) {
            let o = JsonObject()
            o.put("ext", JsonString(skipExts[i]))
            o.put("count", JsonInt(skipCounts[i]))
            arr.add(o)
            i = i + 1
        }
        return arr
    }
}

/**
 * 这些后缀不进"未纳入"清单。
 *
 * 两类：① 图片——它们本来就该以 `![](x.png)` 的形式被文档引用，不该算"读不了的资料"；
 * ② 系统与工具产物（可执行文件、数据库、锁文件等），报出来只会让提示变噪音。
 */
public func ignoreInSkipReport(ext: String): Bool {
    if (ext == "png" || ext == "jpg" || ext == "jpeg" || ext == "gif" || ext == "webp" || ext == "bmp" || ext == "svg" || ext == "ico") {
        return true
    }
    if (ext == "exe" || ext == "dll" || ext == "so" || ext == "bin" || ext == "db" || ext == "lock" || ext == "tmp" || ext == "cache" || ext == "ini" || ext == "lnk") {
        return true
    }
    return false
}

/** 单文件体积上限：超过就跳过（一本 500 页的书大约 1.5MB，4MB 足够大）。 */
const MAX_DOC_BYTES: Int64 = 4 * 1024 * 1024

/**
 * 认得的纯文本类扩展名。
 * 只收"不需要额外依赖就能读成文本"的格式；PDF/Word 这类不是不想支持，
 * 是纯仓颉里解析它们不现实，因此跳过它们并如实告诉用户。
 */
public func isTextDocExt(ext: String): Bool {
    if (ext == "md" || ext == "markdown" || ext == "txt" || ext == "text") {
        return true
    }
    if (ext == "csv" || ext == "tsv" || ext == "log" || ext == "json") {
        return true
    }
    if (ext == "html" || ext == "htm") {
        return true
    }
    return false
}

/** 目录级忽略：隐藏目录（.obsidian 之类）与 node_modules 里的东西不是用户资料。 */
func skipDirName(nm: String): Bool {
    if (nm.size == 0) {
        return false
    }
    if (nm == "node_modules" || nm == "target" || nm == "dist") {
        return true
    }
    return nm.toArray()[0] == 46
}

/**
 * HTML 转文本：去掉 script/style，把 h1~h6 变成 Markdown 标题（这样分章照旧），
 * 其余标签丢掉，常见实体还原。够用即可，不做完整解析器。
 */
/** ASCII 大写转小写（只处理标签名这种 ASCII 场景）。 */
func lowerAscii(b: UInt8): UInt8 {
    if (b >= 65 && b <= 90) {
        return b + 32
    }
    return b
}

/** 从 start 开始若正好是 </name>，返回 '>' 的下标；否则 -1。 */
func closingTagEnd(src: Array<UInt8>, start: Int64, name: String): Int64 {
    var j = start + 1
    if (j >= src.size || src[j] != 47) {
        return -1
    }
    j = j + 1
    let nb = name.toArray()
    if (j + nb.size > src.size) {
        return -1
    }
    var k: Int64 = 0
    while (k < nb.size) {
        if (lowerAscii(src[j + k]) != nb[k]) {
            return -1
        }
        k = k + 1
    }
    j = j + nb.size
    while (j < src.size && src[j] != 62) {
        j = j + 1
    }
    if (j >= src.size) {
        return -1
    }
    return j
}

/**
 * HTML 转文本：去掉 script/style 的内容，把 h1~h6 变成 Markdown 标题（这样分章照旧），
 * 其余标签丢掉，常见实体还原，块级标签补换行。够用即可，不做完整解析器。
 */
public func htmlToText(raw: String): String {
    let src = raw.toArray()
    // 输出按字节攒着、最后统一转字符串：逐字节 String.fromUtf8 遇到中文会立刻抛 Invalid utf8
    let out = ArrayList<UInt8>()
    var i = 0
    var inSkip = ""      // "script" / "style"
    while (i < src.size) {
        let c = src[i]
        // 正在跳过 script/style：里面的内容一律不要（不能只在遇到 '<' 时判断）
        if (inSkip.size > 0) {
            if (c == 60) {
                let stop = closingTagEnd(src, i, inSkip)
                if (stop > i) {
                    inSkip = ""
                    i = stop + 1
                    continue
                }
            }
            i = i + 1
            continue
        }
        if (c == 60) {   // '<'
            var j = i + 1
            var closing = false
            if (j < src.size && src[j] == 47) {
                closing = true
                j = j + 1
            }
            let nameStart = j
            // 标签名允许字母与数字：h1/h2 这类必须把数字也吃进来
            while (j < src.size) {
                let d = src[j]
                if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57)) {
                    j = j + 1
                } else {
                    break
                }
            }
            let name = String.fromUtf8(src[nameStart..j]).toAsciiLower()
            var k = j
            while (k < src.size && src[k] != 62) {   // '>'
                k = k + 1
            }
            if (!closing && (name == "script" || name == "style")) {
                inSkip = name
                i = k + 1
                continue
            }
            var level: Int64 = 0
            // 只有开始标签才输出标题标记：否则 </h2> 会在正文里留下一行空的 "## "
            if (!closing && name.size == 2 && name.toArray()[0] == 104) {   // 'h'
                let d = name.toArray()[1]
                if (d >= 49 && d <= 54) {                                    // '1'..'6'
                    level = Int64(d - 48)
                }
            }
            var blockTag = false
            if (name == "p" || name == "div" || name == "br" || name == "li") {
                blockTag = true
            }
            if (name == "tr" || name == "td" || name == "th" || name == "section" || name == "article") {
                blockTag = true
            }
            if (level > 0) {
                out.add(10)      // 换行 + "#"*level + 空格
                var h: Int64 = 0
                while (h < level) {
                    out.add(35)
                    h = h + 1
                }
                out.add(32)
            } else if (blockTag) {
                out.add(10)
            } else {
                out.add(32)
            }
            i = k + 1
            continue
        }
        out.add(c)
        i = i + 1
    }
    var text = String.fromUtf8(out.toArray())
    text = text.replace("&nbsp;", " ")
    text = text.replace("&amp;", "&")
    text = text.replace("&lt;", "<")
    text = text.replace("&gt;", ">")
    text = text.replace("&quot;", "\"")
    text = text.replace("&#39;", "'")
    var trimmed = text
    while (trimmed.split("\n\n\n").size > 1) {
        trimmed = trimmed.replace("\n\n\n", "\n\n")
    }
    return trimStr(trimmed)
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

func walkDocs(dir: String, rel: String, out: ArrayList<ScannedDoc>, report: ScanReport): Unit {
    Directory.walk(Path(dir), { fi: FileInfo =>
        let nm = fi.name
        let childRel = if (rel.size == 0) { nm } else { rel + "/" + nm }
        let childFull = dir + Path.Separator + nm
        if (fi.isDirectory()) {
            if (!skipDirName(nm)) {
                walkDocs(childFull, childRel, out, report)
            }
        } else {
            let ext = String.fromUtf8(Path(nm).extensionName.toArray()).toAsciiLower()
            if (isTextDocExt(ext)) {
                if (fi.size > MAX_DOC_BYTES) {
                    report.tooBig = report.tooBig + 1
                } else {
                    out.add(ScannedDoc(childRel, nm, childFull))
                }
            } else if (!ignoreInSkipReport(ext)) {
                report.note(ext)
            }
        }
        true
    })
}

public func scanDocsReport(root: String, report: ScanReport): ArrayList<ScannedDoc> {
    let out = ArrayList<ScannedDoc>()
    walkDocs(root, "", out, report)
    return out
}

public func scanDocs(root: String): ArrayList<ScannedDoc> {
    let out = ArrayList<ScannedDoc>()
    walkDocs(root, "", out, ScanReport())
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

// ---------- 关键词兜底检索 ----------
// 很多模型服务只提供对话、不提供向量接口。为了不让知识库卡在某个服务类型上，
// 没配向量模型时改用字符二元组重叠度排序，不依赖任何外部服务。

/** 二元组的哈希。每步都掩到 31 位：
    仓颉默认对整数溢出抛异常，所以不能直接用会溢出的整数哈希。 */
func gramHash(bytes: Array<UInt8>, start: Int64, end: Int64): Int64 {
    var h: Int64 = 0
    var i = start
    while (i < end) {
        h = ((h << 5) + h + Int64(bytes[i])) & 2147483647
        i = i + 1
    }
    return h
}
/** 返回每个 UTF-8 字符的起始字节下标，末尾追加哨兵。 */
func charStarts(bytes: Array<UInt8>): ArrayList<Int64> {
    let out = ArrayList<Int64>()
    var i = 0
    while (i < bytes.size) {
        if ((bytes[i] & 192) != 128) {
            out.add(i)
        }
        i = i + 1
    }
    out.add(bytes.size)
    return out
}

func gramHashes(bytes: Array<UInt8>, starts: ArrayList<Int64>): HashSet<Int64> {
    let set = HashSet<Int64>()
    var i = 0
    while (i + 2 < starts.size) {
        set.add(gramHash(bytes, starts[i], starts[i + 2]))
        i = i + 1
    }
    return set
}

public func keywordSearch(index: KbIndex, query: String, topK: Int64): ArrayList<SearchHit> {
    let qb = query.toArray()
    let qStarts = charStarts(qb)
    let qGrams = gramHashes(qb, qStarts)
    let hits = ArrayList<SearchHit>()
    if (qGrams.size == 0) {
        return hits
    }
    for (c in index.chunks) {
        let text = c.indexText()
        let cb = text.toArray()
        let cStarts = charStarts(cb)
        if (cStarts.size < 3) {
            continue
        }
        var matches: Int64 = 0
        var i = 0
        while (i + 2 < cStarts.size) {
            if (qGrams.contains(gramHash(cb, cStarts[i], cStarts[i + 2]))) {
                matches = matches + 1
            }
            i = i + 1
        }
        if (matches == 0) {
            continue
        }
        // 归一化长度，避免长切片仅因字数多而排前
        let total = Float64(cStarts.size - 2)
        hits.add(SearchHit(c, Float64(matches) / sqrt(total)))
    }
    return topHits(hits, topK)
}


/** 从候选里挑出得分最高的 topK 个。返回副本，避免内部标记值污染结果。 */
public func topHits(pool: ArrayList<SearchHit>, topK: Int64): ArrayList<SearchHit> {
    let n = pool.size
    let k = if (topK < n) { topK } else { n }
    let out = ArrayList<SearchHit>()
    var taken: Int64 = 0
    while (taken < k) {
        var best = -1
        var bestScore = -1.0e308
        var i = 0
        while (i < n) {
            if (pool[i].score > bestScore) {
                bestScore = pool[i].score
                best = i
            }
            i = i + 1
        }
        if (best < 0) {
            break
        }
        out.add(SearchHit(pool[best].chunk, bestScore))
        pool[best].score = -1.0e308
        taken = taken + 1
    }
    return out
}
