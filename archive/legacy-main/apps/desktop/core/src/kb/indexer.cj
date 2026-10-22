package itn_desktop_core.kb

import std.fs.*
import std.collection.*
import std.time.*
import stdx.encoding.json.*
import std.convert.*
import std.sync.*
import stdx.encoding.base64.*
import itn_desktop_core.llm.*
import itn_desktop_core.db.*
import itn_desktop_core.util.*

public func kbDir(dataDir: String, kbId: String): String {
    return dataDir + Path.Separator + "kb" + Path.Separator + kbId
}

public func vectorsPath(dataDir: String, kbId: String): String {
    return kbDir(dataDir, kbId) + Path.Separator + "vectors.txt"
}

/*
 * 索引落库。
 *
 * 切片进 chunks 表、向量进 embeddings 表的 BLOB 列。整库索引替换是一次事务：
 * 中途失败不会留下半个知识库。
 *
 * 切片主键由这里显式分配（max(id)+1 起），因此插入切片与向量可以在同一批里完成，
 * 不需要逐行回读自增 id。
 */
public func saveIndex(dataDir: String, kbId: String, idx: KbIndex): Unit {
    let db = DbHub.open(dataDir)
    db.batch(va2([
        DbOp("DELETE FROM embeddings WHERE kb_id = ?", va([tv(kbId)])),
        DbOp("DELETE FROM chunks WHERE kb_id = ?", va([tv(kbId)]))
    ]))
    var nextId = db.scalarInt("SELECT MAX(id) FROM chunks", ArrayList<DbValue>()) + 1
    let chunkRows = ArrayList<ArrayList<DbValue>>()
    let ops = ArrayList<DbOp>()
    var ord: Int64 = 0
    for (c in idx.chunks) {
        let rowId = nextId
        nextId += 1
        chunkRows.add(va([nv(rowId), tv(kbId), tv(c.id), tv(c.docPath), tv(c.docTitle), tv(c.headingPath),
            nv(ord), tv(c.text), tv(c.caption), tv(c.captionError), tv(imagesJson(c.images))]))
        if (c.vector.size > 0) {
            ops.add(DbOp("INSERT INTO embeddings (chunk_id, kb_id, dim, vec) VALUES (?, ?, ?, ?)",
                va([nv(rowId), tv(kbId), nv(Int64(c.vector.size)), bv(encodeVector(c.vector))])))
        }
        ord += 1
    }
    db.runMany("INSERT INTO chunks (id, kb_id, chunk_key, doc_path, doc_title, heading_path, ord, text, caption, caption_error, images) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", chunkRows)
    db.batch(ops)
    db.putKv("meta", "kb_root_" + kbId, idx.rootDir)
}

public func loadIndex(dataDir: String, kbId: String): KbIndex {
    let db = DbHub.open(dataDir)
    migrateKbFromJson(db, dataDir, kbId)
    let idx = KbIndex()
    idx.kbId = kbId
    idx.rootDir = db.getKv("meta", "kb_root_" + kbId, "")
    if (idx.rootDir.size == 0) {
        idx.rootDir = db.scalarText("SELECT root_dir FROM knowledge_bases WHERE id = ?", va([tv(kbId)]))
    }
    let slot = HashMap<String, Int64>()
    var i: Int64 = 0
    for (r in db.query("SELECT chunk_key, doc_path, doc_title, heading_path, text, caption, caption_error, images " +
        "FROM chunks WHERE kb_id = ? ORDER BY ord", va([tv(kbId)]))) {
        let c = KbChunk()
        c.id = r.text(0)
        c.docPath = r.text(1)
        c.docTitle = r.text(2)
        c.headingPath = r.text(3)
        c.ordinal = i
        c.text = r.text(4)
        c.caption = r.text(5)
        c.captionError = r.text(6)
        c.images = parseImages(r.text(7))
        slot[c.id] = i
        idx.chunks.add(c)
        i += 1
    }
    for (r in db.query("SELECT chunk_key, vec FROM chunks JOIN embeddings ON embeddings.chunk_id = chunks.id WHERE chunks.kb_id = ?",
        va([tv(kbId)]))) {
        match (slot.get(r.text(0))) {
            case Some(pos) =>
                idx.chunks[pos].vector = decodeVector(r.blob(1))
            case None => ()
        }
    }
    return idx
}

/** 一次性把 kb/<id>/index.json 与 vectors.txt 导进数据库，只导一次。 */
func migrateKbFromJson(db: Db, dataDir: String, kbId: String): Unit {
    let flag = "migrated_kb_" + kbId
    if (db.getKv("meta", flag, "") == "1") {
        return
    }
    let path = kbDir(dataDir, kbId) + Path.Separator + "index.json"
    let raw = readTextOr(path, "")
    if (raw.size > 0) {
        try {
            let old = KbIndex.fromJson(JsonValue.fromStr(raw))
            attachLegacyVectors(vectorsPath(dataDir, kbId), old)
            saveIndex(dataDir, kbId, old)
        } catch (e: Exception) {
            ()
        }
        archiveLegacy(path)
    }
    db.putKv("meta", flag, "1")
}

/** 老格式 vectors.txt：原地解析一行浮点，避免为每个数字生成中间字符串数组。 */
func attachLegacyVectors(path: String, idx: KbIndex): Unit {
    let raw = readTextOr(path, "")
    if (raw.size == 0) {
        return
    }
    let b = raw.toArray()
    var chunkIdx = 0
    var i = 0
    let n = idx.chunks.size
    while (chunkIdx < n) {
        var lineEnd = i
        while (lineEnd < b.size && b[lineEnd] != 10) {
            lineEnd = lineEnd + 1
        }
        let vec = idx.chunks[chunkIdx].vector
        var p = i
        while (p < lineEnd) {
            while (p < lineEnd && (b[p] == 32 || b[p] == 9)) {
                p = p + 1
            }
            if (p >= lineEnd) {
                break
            }
            let start = p
            while (p < lineEnd && b[p] != 32 && b[p] != 9) {
                p = p + 1
            }
            vec.add(Float64.parse(String.fromUtf8(b[start..p])))
        }
        chunkIdx = chunkIdx + 1
        if (lineEnd >= b.size) {
            break
        }
        i = lineEnd + 1
    }
}

func imagesJson(images: ArrayList<String>): String {
    let arr = JsonArray()
    for (i in images) {
        arr.add(JsonString(i))
    }
    return arr.toString()
}

func parseImages(text: String): ArrayList<String> {
    let out = ArrayList<String>()
    if (text.size == 0) {
        return out
    }
    try {
        match (arrOf(JsonValue.fromStr(text))) {
            case Some(a) =>
                var i = 0
                while (i < a.size()) {
                    out.add(strValue(a[i]))
                    i += 1
                }
            case None => ()
        }
    } catch (e: Exception) {
        ()
    }
    return out
}

/** 把数组转成 ArrayList，供 batch 使用。 */
func va2(ops: Array<DbOp>): ArrayList<DbOp> {
    let out = ArrayList<DbOp>()
    for (o in ops) {
        out.add(o)
    }
    return out
}

/** 扫描目录并按 Markdown 结构分块。不调用模型。 */

/* ---------- 整理后的目录（outline） ---------- */

/**
 * 一个"整理好的目录"。
 *
 * 为什么要有它：用户随手丢进来的资料常常是散乱的——文件名没规律、一篇长文没有标题层次、
 * 多个文档其实是同一门课的不同章节。靠规则很难猜对，交给 agent（lumin）读一遍、给出一份
 * 目录计划，索引就按这份计划组织：章节名、章节顺序、哪几篇归到同一章。
 *
 * 文件落在 <数据目录>/kb/<kbId>/outline.json，格式：
 *   {"source":"lumin","note":"...","chapters":[{"name":"第一章 概述","docs":["a.md","sub/b.md"]}]}
 */
public class OutlineChapter {
    public var name: String = ""
    public var docs: ArrayList<String> = ArrayList<String>()

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("name", JsonString(name))
        let arr = JsonArray()
        for (d in docs) {
            arr.add(JsonString(d))
        }
        o.put("docs", arr)
        return o
    }
}

public class Outline {
    public var source: String = ""
    public var note: String = ""
    public var chapters: ArrayList<OutlineChapter> = ArrayList<OutlineChapter>()

    public func docCount(): Int64 {
        var n: Int64 = 0
        for (c in chapters) {
            n = n + c.docs.size
        }
        return n
    }

    public func chapterOfDoc(rel: String): String {
        for (c in chapters) {
            for (d in c.docs) {
                if (d == rel) {
                    return c.name
                }
            }
        }
        return ""
    }

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("source", JsonString(source))
        o.put("note", JsonString(note))
        let arr = JsonArray()
        for (c in chapters) {
            arr.add(c.toJson())
        }
        o.put("chapters", arr)
        return o
    }

    public static func fromJson(v: JsonValue): Outline {
        let ol = Outline()
        match (objOf(v)) {
            case Some(o) =>
                ol.source = strOf(o, "source")
                ol.note = strOf(o, "note")
                match (o.get("chapters")) {
                    case Some(cv) =>
                        match (cv) {
                            case ca: JsonArray =>
                                var i = 0
                                while (i < ca.size()) {
                                    let ch = OutlineChapter()
                                    match (objOf(ca[i])) {
                                        case Some(co) =>
                                            ch.name = strOf(co, "name")
                                            ch.docs = strArrayOf(co, "docs")
                                        case None => ()
                                    }
                                    if (ch.name.size > 0) {
                                        ol.chapters.add(ch)
                                    }
                                    i = i + 1
                                }
                            case _ => ()
                        }
                    case None => ()
                }
            case None => ()
        }
        return ol
    }

    public func save(path: String): Unit {
        writeText(path, toJson().toString())
    }

    public static func load(path: String): ?Outline {
        let raw = readTextOr(path, "")
        if (raw.size == 0) {
            return None
        }
        try {
            let ol = Outline.fromJson(JsonValue.fromStr(raw))
            if (ol.chapters.size == 0) {
                return None
            }
            return Some(ol)
        } catch (e: Exception) {
            return None
        }
    }
}

public func chunkAll(rootDir: String, maxChars: Int64): KbIndex {
    return chunkAllWith(rootDir, maxChars, None)
}

/**
 * 建索引。给了整理好的目录（outline）就按它组织：章名与章顺序都以目录为准，
 * 目录里没提到的文档接在后面（不丢资料）。
 *
 * rootDir 既可以是文件夹，也可以是单独一个文件——导入的两种形态走同一条路。
 */
public func chunkAllWith(rootDir: String, maxChars: Int64, outline: ?Outline): KbIndex {
    let idx = KbIndex()
    idx.rootDir = rootDir
    // 带上"漏掉了什么"的报告：用户把 PDF/Word 放进目录时，界面要能说清楚为什么没被读到
    let docs = scanDocsReport(rootDir, idx.scan)
    let order = orderDocs(docs, outline)
    for (d in order) {
        var raw: Array<UInt8> = []
        try {
            raw = File.readFrom(d.fullPath)
        } catch (e: Exception) {
            idx.scan.tooBig = idx.scan.tooBig + 1
            continue
        }
        if (raw.size > MAX_DOC_BYTES) {
            idx.scan.tooBig = idx.scan.tooBig + 1
            continue
        }
        var content = String.fromUtf8(raw.toArray())
        let ext = String.fromUtf8(Path(d.fullPath).extensionName.toArray()).toAsciiLower()
        if (ext == "html" || ext == "htm") {
            content = htmlToText(content)
        }
        let chName = chapterNameOfDoc(outline, d.relPath)
        for (c in chunkDocument(d, content, maxChars)) {
            if (chName.size > 0) {
                c.headingPath = if (c.headingPath.size > 0) { chName + " > " + c.headingPath } else { chName }
            }
            idx.chunks.add(c)
        }
    }
    return idx
}

/** 有目录就按目录排序（章内按目录给的顺序），没提到的接在后面。 */
func orderDocs(docs: ArrayList<ScannedDoc>, outline: ?Outline): ArrayList<ScannedDoc> {
    let out = ArrayList<ScannedDoc>()
    let used = ArrayList<String>()
    let ol = match (outline) {
        case Some(o) => o
        case None => Outline()
    }
    for (c in ol.chapters) {
        for (rel in c.docs) {
            for (d in docs) {
                if (d.relPath == rel && !used.contains(rel)) {
                    out.add(d)
                    used.add(rel)
                }
            }
        }
    }
    for (d in docs) {
        if (!used.contains(d.relPath)) {
            out.add(d)
        }
    }
    return out
}

func chapterNameOfDoc(outline: ?Outline, rel: String): String {
    match (outline) {
        case Some(o) => return o.chapterOfDoc(rel)
        case None => return ""
    }
}

/** 对尚未向量化的切片补齐向量。返回本次处理的切片数。 */
public func embedChunks(idx: KbIndex, client: LlmClient, batchSize: Int64): Int64 {
    let pending = ArrayList<Int64>()
    var i = 0
    while (i < idx.chunks.size) {
        if (idx.chunks[i].vector.size == 0) {
            pending.add(i)
        }
        i = i + 1
    }
    var done: Int64 = 0
    var p = 0
    while (p < pending.size) {
        let inputs = ArrayList<String>()
        var j = p
        while (j < pending.size && j < p + batchSize) {
            inputs.add(idx.chunks[pending[j]].indexText())
            j = j + 1
        }
        let vecs = client.embed(inputs.toArray())
        var k = 0
        while (k < vecs.size) {
            let target = idx.chunks[pending[p + k]]
            target.vector = ArrayList<Float64>()
            var m = 0
            while (m < vecs[k].size) {
                target.vector.add(vecs[k][m])
                m = m + 1
            }
            k = k + 1
        }
        done = done + vecs.size
        p = p + batchSize
    }
    return done
}

public func stamp(): String {
    return DateTime.now().toString()
}

// ---------- 图片多模态描述 ----------

public func toOsPath(rel: String): String {
    let b = rel.toArray()
    let sep = Path.Separator.toArray()
    let out = ArrayList<UInt8>()
    var i = 0
    while (i < b.size) {
        if (b[i] == 47) {
            for (s in sep) { out.add(s) }
        } else {
            out.add(b[i])
        }
        i = i + 1
    }
    return String.fromUtf8(out.toArray())
}

func isSafeRel(rel: String): Bool {
    // 拒绝绝对路径与向上跳转，避免越出知识库目录
    if (rel.size == 0) { return false }
    let b = rel.toArray()
    if (b[0] == 47 || b[0] == 92) { return false }
    if (b.size > 1 && b[1] == 58) { return false }
    let parts = rel.split("..")
    var n = 0
    for (p in parts) { n = n + 1 }
    return n <= 1
}

func mimeOf(rel: String): String {
    let ext = Path(rel).extensionName
    if (ext == "png") { return "image/png" }
    if (ext == "jpg" || ext == "jpeg") { return "image/jpeg" }
    if (ext == "gif") { return "image/gif" }
    if (ext == "webp") { return "image/webp" }
    if (ext == "bmp") { return "image/bmp" }
    return "application/octet-stream"
}

/** 为带图片的切片生成描述。切片已有描述则跳过。返回本次生成数量。 */
public func captionChunks(rootDir: String, idx: KbIndex, client: LlmClient, visionModel: String): Int64 {
    var done: Int64 = 0
    for (c in idx.chunks) {
        if (c.images.size == 0 || c.caption.size > 0) {
            continue
        }
        c.captionError = ""
        let rel = c.images[0]
        if (!isSafeRel(rel)) {
            continue
        }
        let full = rootDir + Path.Separator + toOsPath(rel)
        if (!exists(full)) {
            continue
        }
        try {
            let bytes = File.readFrom(full)
            if (bytes.size == 0) { continue }
            let dataUrl = "data:" + mimeOf(rel) + ";base64," + toBase64String(bytes)
            let prompt = "请用简洁的中文描述这张图片的内容，重点是它在教学材料里要传达的信息。只输出描述本身，不要额外说明。"
            c.caption = client.chatVision(visionModel, prompt, dataUrl)
            done = done + 1
        } catch (e: Exception) {
            // 不静默吞掉：把失败原因写进描述字段，便于用户与排查者看到
            c.caption = ""
            c.captionError = e.message
        }
    }
    return done
}

// ---------- 索引缓存 ----------
// 真实规模下索引有数万个切片，每次检索都重新读盘并按浮点解析代价太高。
// 进程内按 (数据目录, 知识库) 缓存，重建索引时替换。

let indexCacheLock = Mutex()
let indexCacheMap = HashMap<String, KbIndex>()

func cacheKey(dataDir: String, kbId: String): String {
    return dataDir + "|" + kbId
}

public func loadIndexCached(dataDir: String, kbId: String): KbIndex {
    let key = cacheKey(dataDir, kbId)
    indexCacheLock.lock()
    try {
        match (indexCacheMap.get(key)) {
            case Some(v) => return v
            case None => ()
        }
    } finally {
        indexCacheLock.unlock()
    }
    let idx = loadIndex(dataDir, kbId)
    indexCacheLock.lock()
    try {
        indexCacheMap[key] = idx
    } finally {
        indexCacheLock.unlock()
    }
    return idx
}

public func putIndexCache(dataDir: String, kbId: String, idx: KbIndex): Unit {
    indexCacheLock.lock()
    try {
        indexCacheMap[cacheKey(dataDir, kbId)] = idx
    } finally {
        indexCacheLock.unlock()
    }
}

public func dropIndexCache(dataDir: String, kbId: String): Unit {
    indexCacheLock.lock()
    try {
        indexCacheMap.remove(cacheKey(dataDir, kbId))
    } finally {
        indexCacheLock.unlock()
    }
}
