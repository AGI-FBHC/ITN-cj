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

/**
 * 点开头的文件（`.nojekyll`、`.DS_Store`、`.gitignore`…）是工具/系统产物，不是用户资料。
 * 之前 `.nojekyll` 会被算进"未纳入 N 个文件"里，用户看到只会莫名其妙。
 */
public func ignoreEntryName(name: String): Bool {
    if (name.size == 0) {
        return false
    }
    return name.toArray()[0] == 46
}

/* ---------- 路径助手（标准库这版没有 stat，也没有现成的"取父目录"） ---------- */

/** 去掉末尾分隔符后取最后一段。 */
public func baseNameOf(p: String): String {
    let b = p.toArray()
    var n = b.size
    while (n > 0 && (b[n - 1] == 92 || b[n - 1] == 47)) {
        n = n - 1
    }
    var i = n
    while (i > 0 && b[i - 1] != 92 && b[i - 1] != 47) {
        i = i - 1
    }
    return String.fromUtf8(b[i..n])
}

/** 父目录。`D:\a.md` → `D:\`；`D:\x\y\a.md` → `D:\x\y`。 */
public func parentDirOf(p: String): String {
    let b = p.toArray()
    var n = b.size
    while (n > 0 && (b[n - 1] == 92 || b[n - 1] == 47)) {
        n = n - 1
    }
    var i = n
    while (i > 0 && b[i - 1] != 92 && b[i - 1] != 47) {
        i = i - 1
    }
    if (i == 0) {
        return p
    }
    let cut = i - 1
    if (cut == 2 && n > 2 && b[1] == 58) {
        return String.fromUtf8(b[0..3])
    }
    if (cut == 0) {
        return String.fromUtf8(b[0..1])
    }
    return String.fromUtf8(b[0..cut])
}

/**
 * 是不是目录。
 *
 * 用"能不能列出内容"判断：列得出 → 目录；列不出但读得出 → 文件。
 * 之所以不直接问系统：这版标准库既没有 stat，也拿不到 FileInfo（只能从 walk 的回调里得到）。
 */
public func looksLikeDirectory(p: String): Bool {
    let box = ArrayList<Bool>()
    try {
        Directory.walk(Path(p), { fi: FileInfo =>
            box.add(fi.isDirectory())
            false
        })
        if (box.size > 0) {
            return true
        }
    } catch (e: Exception) {
        return false
    }
    try {
        let head = File.readFrom(p)
        if (head.size >= 0) {
            return false
        }
        return false
    } catch (e: Exception) {
        // 列不出、也读不出：按（空）目录处理，让扫描如实报"没有可读文件"
        return true
    }
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
            } else if (!ignoreInSkipReport(ext) && !ignoreEntryName(nm)) {
                report.note(ext)
            }
        }
        true
    })
}

/** 把单独一个文件当成一篇资料（导入单文件时走这条）。 */
func scanOneDoc(full: String, rel: String, out: ArrayList<ScannedDoc>, report: ScanReport): Unit {
    let nm = baseNameOf(full)
    if (ignoreEntryName(nm)) {
        return
    }
    let ext = String.fromUtf8(Path(rel).extensionName.toArray()).toAsciiLower()
    if (!isTextDocExt(ext)) {
        if (!ignoreInSkipReport(ext)) {
            report.note(ext)
        }
        return
    }
    out.add(ScannedDoc(rel, nm, full))
}

/** 扫描根目录：既可以是文件夹，也可以是单独一个文件（导入的两种形态）。 */
public func scanDocsReport(root: String, report: ScanReport): ArrayList<ScannedDoc> {
    let out = ArrayList<ScannedDoc>()
    if (looksLikeDirectory(root)) {
        walkDocs(root, "", out, report)
    } else {
        scanOneDoc(root, baseNameOf(root), out, report)
    }
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

/* ---------- 导入资料 ---------- */

/** 一次导入的结果（给界面用）。 */
public class ImportInfo {
    public var ok: Bool = true
    public var kind: String = ""
    public var rootDir: String = ""
    public var source: String = ""
    /** 复制了几个文件（单文件导入时连同引用的图片一起复制） */
    public var copied: Int64 = 0
    /** 这次导入后能读到的资料篇数 */
    public var docs: Int64 = 0
    public var note: String = ""

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("ok", JsonBool(ok))
        o.put("kind", JsonString(kind))
        o.put("rootDir", JsonString(rootDir))
        o.put("source", JsonString(source))
        o.put("copied", JsonInt(copied))
        o.put("docs", JsonInt(docs))
        o.put("note", JsonString(note))
        return o
    }
}

public func isAssetExt(ext: String): Bool {
    if (ext == "png" || ext == "jpg" || ext == "jpeg" || ext == "gif" || ext == "webp" || ext == "bmp" || ext == "svg") {
        return true
    }
    return false
}

/** 标识：英文短名，从文件名/显示名里挤出来。挤不出来返回空串，交给调用方兜底。 */
public func slugOf(name: String): String {
    let sb = StringBuilder()
    var lastDash = false
    var n: Int64 = 0
    for (b in name.toArray()) {
        let c = lowerAscii(b)
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
            sb.append(String.fromUtf8([c]))
            lastDash = false
            n = n + 1
        } else if (!lastDash && n > 0 && n < 24) {
            sb.append("-")
            lastDash = true
        }
    }
    var out = sb.toString()
    while (out.size > 0 && out.toArray()[out.size - 1] == 45) {
        out = String.fromUtf8(out.toArray()[0..out.size - 1])
    }
    return out
}

func copyFileBytes(from: String, to: String): Bool {
    try {
        let bytes = File.readFrom(from)
        File.writeTo(to, bytes)
        return true
    } catch (e: Exception) {
        return false
    }
}

/** 把 md 里引用的相对路径图片也照位置复制过去（否则复制完图就断了）。 */
func copyReferencedAssets(content: String, srcDir: String, destDir: String): Int64 {
    let refs = ArrayList<String>()
    for (line in splitLines(content)) {
        extractImages(line, refs)
    }
    var copied: Int64 = 0
    for (r in refs) {
        if (r.size == 0 || r.size > 200) {
            continue
        }
        if (hasPrefix(r, "http://") || hasPrefix(r, "https://") || hasPrefix(r, "data:")) {
            continue
        }
        var rel = r.replace("\\", "/")
        if (hasPrefix(rel, "/")) {
            continue
        }
        if (hasPrefix(rel, "./")) {
            rel = rel.replace("./", "")
        }
        if (rel.contains("..")) {
            continue
        }
        let ext = String.fromUtf8(Path(rel).extensionName.toArray()).toAsciiLower()
        if (!isAssetExt(ext)) {
            continue
        }
        let to = destDir + Path.Separator + rel.replace("/", Path.Separator.toString())
        let folder = parentDirOf(to)
        if (folder.size > 0 && folder != destDir) {
            ensureDir(folder)
        }
        if (copyFileBytes(srcDir + Path.Separator + rel.replace("/", Path.Separator.toString()), to)) {
            copied = copied + 1
        }
    }
    return copied
}

/**
 * 导入一种资料。
 *
 * 两种形态都从这一个入口走：
 *   - 文件夹：**原地登记**（不复制，几十 GB 的资料不应该被拷一遍）；
 *   - 单独一个文件：复制进受管资料目录 `<数据目录>/kb/<id>/source/`（连它引用的图片一起），
 *     这样原文件被移走/改名之后知识库还在。
 */
public func importMaterial(dataDir: String, kbId: String, path: String, kind: String): ImportInfo {
    let info = ImportInfo()
    info.source = path
    var isDir = kind == "dir"
    if (kind != "file" && kind != "dir") {
        isDir = looksLikeDirectory(path)
    }
    if (isDir) {
        if (!looksLikeDirectory(path)) {
            info.ok = false
            info.note = "读不到这个文件夹，检查一下路径对不对"
            return info
        }
        info.kind = "dir"
        info.rootDir = path
        info.docs = scanDocsReport(path, ScanReport()).size
        return info
    }
    let nm = baseNameOf(path)
    if (nm.size == 0) {
        info.ok = false
        info.note = "读不到这个文件，检查一下路径对不对"
        return info
    }
    let ext = String.fromUtf8(Path(nm).extensionName.toArray()).toAsciiLower()
    if (!isTextDocExt(ext)) {
        let shown = if (ext.size == 0) { "（无扩展名）" } else { ext }
        info.ok = false
        info.note = "这个格式现在读不了" + shown + "。内核只读 Markdown / 文本 / CSV / HTML / 日志 / JSON；" +
            "PDF、Word、PPT 请先转成 Markdown 或文本，或者把整个文件夹导入（能读的会被读，读不了的会列出来）。"
        return info
    }
    let destDir = kbDir(dataDir, kbId) + Path.Separator + "source"
    ensureDir(destDir)
    if (!copyFileBytes(path, destDir + Path.Separator + nm)) {
        info.ok = false
        info.note = "复制失败：" + path
        return info
    }
    info.copied = 1
    var content = ""
    try {
        content = String.fromUtf8(File.readFrom(destDir + Path.Separator + nm))
    } catch (e: Exception) {
        content = ""
    }
    if (content.size > 0) {
        let extra = copyReferencedAssets(content, parentDirOf(path), destDir)
        info.copied = info.copied + extra
        if (extra > 0) {
            info.note = "已把这篇资料和它引用的 " + extra.toString() + " 个图片一起复制进来"
        }
    }
    info.kind = "file"
    info.rootDir = destDir
    info.docs = scanDocsReport(destDir, ScanReport()).size
    return info
}

/* ---------- 自适应分章：材料自己怎么编号，就怎么分章 ---------- */

/** 取开头的一个 UTF-8 字符。 */
public func firstCharOf(s: String): String {
    let b = s.toArray()
    if (b.size == 0) {
        return ""
    }
    var n: Int64 = 1
    if (b[0] >= 224) { n = 3 } else if (b[0] >= 192) { n = 2 }
    if (n > b.size) { n = b.size }
    return String.fromUtf8(b[0..n])
}

/** 取末尾的一个 UTF-8 字符。 */
public func lastCharOf(s: String): String {
    let b = s.toArray()
    if (b.size == 0) {
        return ""
    }
    var i = b.size - 1
    while (i > 0 && (b[i] & 192) == 128) {
        i = i - 1
    }
    return String.fromUtf8(b[i..b.size])
}

/** 从第 i 个字节开始读一个字符。 */
func charAtByte(b: Array<UInt8>, i: Int64): String {
    if (i >= b.size) {
        return ""
    }
    var n: Int64 = 1
    if (b[i] >= 224) { n = 3 } else if (b[i] >= 192) { n = 2 }
    if (i + n > b.size) { n = b.size - i }
    return String.fromUtf8(b[i..(i + n)])
}

func isCnNumeral(ch: String): Bool {
    for (x in ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "百", "零", "两"]) {
        if (ch == x) {
            return true
        }
    }
    return false
}

func endsLikeSentence(ch: String): Bool {
    if (ch == "。" || ch == "，" || ch == "；" || ch == "：" || ch == "！" || ch == "？" || ch == "、") {
        return true
    }
    return false
}

/**
 * 这一行像不像"章节标题"？返回 1/2/3（级别），0 表示不像。
 *
 * 只认很硬的信号，宁可漏认也不要把正文句子当成标题：
 *   - 「第一章 / 第 2 节 / 第三部分 / 第5单元」——数字或中文数字 + 章节单位，不看下文；
 *   - 「一、」「二、」这种中文序号——要求后面确实跟着一段正文（nextLen 够长）；
 *   - 「1.2」「3、」这种数字序号——同上，且行本身要短。
 */
func pseudoHeadingLevelOf(line: String, nextLen: Int64): Int64 {
    let t = trimStr(line)
    if (t.size == 0 || t.size > 60) {
        return 0
    }
    if (endsLikeSentence(lastCharOf(t))) {
        return 0
    }
    let b = t.toArray()
    if (b[0] == 35) {
        return 0
    }
    if (hasPrefix(t, "第")) {
        var i: Int64 = 3
        var digits: Int64 = 0
        while (i < b.size && digits < 4) {
            let ch = charAtByte(b, i)
            if (ch.size == 0) {
                break
            }
            let isDigit = b[i] >= 48 && b[i] <= 57
            if (!isDigit && !isCnNumeral(ch)) {
                break
            }
            i = i + ch.size
            digits = digits + 1
        }
        if (digits > 0 && i < b.size) {
            let unit = charAtByte(b, i)
            if (unit == "章" || unit == "篇" || unit == "部" || unit == "单") {
                return 1
            }
            if (unit == "节" || unit == "讲" || unit == "课" || unit == "目") {
                return 2
            }
        }
        return 0
    }
    let f = firstCharOf(t)
    let fl = f.toArray().size
    if (isCnNumeral(f) && fl < b.size) {
        let sep = charAtByte(b, fl)
        if ((sep == "、" || sep == "." || sep == "．" || sep == ")" || sep == "）") && t.size <= 40 && nextLen >= 16) {
            return 1
        }
        return 0
    }
    if (b[0] >= 48 && b[0] <= 57) {
        var i: Int64 = 0
        var nums: Int64 = 0
        var dots: Int64 = 0
        while (i < b.size) {
            if (b[i] >= 48 && b[i] <= 57) {
                nums = nums + 1
            } else if (b[i] == 46) {
                dots = dots + 1
            } else {
                break
            }
            if (nums > 6) {
                return 0
            }
            i = i + 1
        }
        var ok = false
        if (i < b.size) {
            let sep = charAtByte(b, i)
            if (sep == "、" || sep == ")" || sep == "）") {
                ok = true
            } else if (sep == "." || sep == "．" || sep == " " || sep == "　" || sep == "-") {
                ok = true
            }
        } else if (dots > 0) {
            ok = true
        }
        if (ok && nums > 0 && t.size <= 40 && nextLen >= 16) {
            if (dots > 1) {
                return 3
            }
            return 2
        }
    }
    return 0
}

/** 预扫描整篇：没有 Markdown 标题时，看看它自己的编号能不能当结构。返回 行号 → 级别。 */
func detectPseudoHeadings(lines: ArrayList<String>): HashMap<Int64, Int64> {
    let map = HashMap<Int64, Int64>()
    var inCode = false
    var i = 0
    while (i < lines.size) {
        let t = trimStr(lines[i])
        if (lineStartsWith(t, "```")) {
            inCode = !inCode
            i = i + 1
            continue
        }
        if (!inCode && t.size > 0 && t.size <= 60) {
            var nextLen: Int64 = 0
            var j = i + 1
            while (j < lines.size) {
                let nt = trimStr(lines[j])
                if (nt.size > 0) {
                    nextLen = nt.size
                    break
                }
                j = j + 1
            }
            let lvl = pseudoHeadingLevelOf(t, nextLen)
            if (lvl > 0) {
                map[i] = lvl
            }
        }
        i = i + 1
    }
    return map
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

    // 自适应：材料自己有 Markdown 标题就按它分；没有就用它自己的编号习惯（第一章 / 一、/ 1.2）；
    // 都没有且篇幅很长时，再按长度切成几块、拿每块的头一行当节名。
    var mdHeadings: Int64 = 0
    for (l in lines) {
        if (headingLevel(trimStr(l)) > 0) {
            mdHeadings = mdHeadings + 1
        }
    }
    let pseudo = if (mdHeadings == 0) { detectPseudoHeadings(lines) } else { HashMap<Int64, Int64>() }
    let synthetic = mdHeadings == 0 && pseudo.size == 0 && content.size > maxChars * 3
    var autoLeft: Int64 = 0
    var autoBlocks: Int64 = 0

    func headingPathStr(): String {
        let parts = ArrayList<String>()
        var i = 0
        while (i < 6) {
            if (headingStack[i].size > 0) { parts.add(headingStack[i]) }
            i = i + 1
        }
        return joinWith(parts, " > ")
    }

    func setHeading(lvl: Int64, name: String): Unit {
        if (lvl < 1 || lvl > 6) {
            return
        }
        headingStack[lvl - 1] = name
        var k = lvl
        while (k < 6) {
            headingStack[k] = ""
            k = k + 1
        }
    }

    /** 长文按长度切块时，给这一块起个名字：优先用它的第一行（像个标题才算）。 */
    func autoTitleOf(text: String, n: Int64): String {
        for (l in splitLines(text)) {
            let t = trimStr(l)
            if (t.size > 24) {
                return byteSafePrefix(t, 60)
            }
            if (t.size >= 2 && !t.contains(",")) {
                return t
            }
        }
        return doc.title + " · 第" + n.toString() + "部分"
    }

    func flush(): Unit {
        let text = trimStr(buffer.toString())
        if (text.size == 0) { return }
        if (synthetic) {
            if (autoLeft <= 0) {
                autoBlocks = autoBlocks + 1
                autoLeft = 3
                setHeading(1, autoTitleOf(text, autoBlocks))
            }
            autoLeft = autoLeft - 1
        }
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

    var lineIdx: Int64 = -1
    for (line in lines) {
        lineIdx = lineIdx + 1
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
                setHeading(lvl, headingText(trimmed, lvl))
                continue
            }
            if (pseudo.size > 0) {
                match (pseudo.get(lineIdx)) {
                    case Some(pl) =>
                        flush()
                        setHeading(pl, trimmed)
                        continue
                    case None => ()
                }
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


// ---------- 混合检索：两路候选 → 名次融合 → 去冗 ----------
/*
 * 为什么不是"向量 or 关键词"：
 *   向量擅长近义与意译，但对**专有名词、编号、代码符号**很钝（「1.2 节」「kb_search」「YAML」
 *   这类词在向量空间里几乎挨在一起）；关键词（字符二元组）反过来 —— 精确命中很强，换个说法就全丢。
 *   两边各取一批候选、按**名次**融合（RRF），比任何一侧单独用都稳。
 *
 * 为什么还要去冗：
 *   同一份资料里相邻的切片高度相似，Top-K 经常是同一段的续写 —— 模型看到的是"同一件事说三遍"，
 *   还挤掉了别的文档里的关键证据。这里对"同一份文档已经出过两片"的候选扣分，
 *   让证据尽量分散（MMR 的简化版：相似度用"同文档/同标题"代理，不再算两两余弦）。
 */

/** 名次融合（Reciprocal Rank Fusion）：只看"排第几"，不看分数量纲，所以两路可以直接合。 */
public func rrfFuse(rankings: ArrayList<ArrayList<SearchHit>>, topK: Int64): ArrayList<SearchHit> {
    let scores = HashMap<String, Float64>()
    let chunks = HashMap<String, KbChunk>()
    for (rank in rankings) {
        var i: Int64 = 0
        while (i < rank.size) {
            let h = rank[i]
            let key = h.chunk.id
            scores[key] = (scores.get(key) ?? 0.0) + 1.0 / (60.0 + Float64(i + 1))
            chunks[key] = h.chunk
            i += 1
        }
    }
    let pool = ArrayList<SearchHit>()
    for ((key, sc) in scores) {
        match (chunks.get(key)) {
            case Some(c) => pool.add(SearchHit(c, sc))
            case None => ()
        }
    }
    return topHits(pool, topK)
}

/**
 * 去冗：同一份文档最多"优待"两片，之后明显降权；紧挨着的同一篇续写再降一档。
 *
 * 分数先按池子里的最高分归一化到 [0,1] 再扣分 —— 否则 RRF 分数（约 0.0x 量级）会被
 * 0.3 级别的扣分直接压平，去冗变成"按扣分排序"。
 */
public func diversify(pool: ArrayList<SearchHit>, topK: Int64, lambda: Float64): ArrayList<SearchHit> {
    let rest = ArrayList<SearchHit>(pool)
    let picked = ArrayList<SearchHit>()
    let perDoc = HashMap<String, Int64>()
    var maxScore = 0.0000001
    for (h in rest) {
        if (h.score > maxScore) {
            maxScore = h.score
        }
    }
    while (picked.size < topK && rest.size > 0) {
        var best = -1
        var bestScore = -1.0e308
        var i: Int64 = 0
        while (i < rest.size) {
            let h = rest[i]
            let doc = h.chunk.docPath
            let used = perDoc.get(doc) ?? 0
            var penalty = 0.0
            if (used >= 2) {
                penalty = 0.35
            } else if (used == 1) {
                penalty = 0.12
            }
            if (picked.size > 0 && picked[picked.size - 1].chunk.docPath == doc) {
                penalty = penalty + 0.18
            }
            let score = lambda * (h.score / maxScore) - penalty
            if (score > bestScore) {
                bestScore = score
                best = i
            }
            i += 1
        }
        if (best < 0) {
            break
        }
        let chosen = rest[best]
        picked.add(SearchHit(chosen.chunk, chosen.score))
        perDoc[chosen.chunk.docPath] = (perDoc.get(chosen.chunk.docPath) ?? 0) + 1
        rest.remove(at: best)
    }
    return picked
}

/**
 * 混合检索的唯一入口：向量（有就带上）+ 关键词两路 → 融合 → 去冗。
 *
 * candidates 是"两路各取多少候选"，比 topK 宽一些才有多余的能去冗。
 * 返回的第二项是给人看的模式说明（界面与工具摘要里会写"向量+关键词 融合"）。
 */
public func hybridSearch(index: KbIndex, query: String, queryVector: Option<Array<Float64>>, topK: Int64): (ArrayList<SearchHit>, String) {
    let wide = if (topK < 8) { 24 } else { topK * 3 }
    let rankings = ArrayList<ArrayList<SearchHit>>()
    var parts = ArrayList<String>()
    match (queryVector) {
        case Some(qv) =>
            rankings.add(search(index, qv, wide))
            parts.add("向量")
        case None => ()
    }
    rankings.add(keywordSearch(index, query, wide))
    parts.add("关键词")
    let fused = rrfFuse(rankings, wide)
    let out = diversify(fused, topK, 0.75)
    return (out, joinWith(parts, "+") + " 融合")
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
