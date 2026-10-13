package itn_desktop_core.kb

import std.fs.*
import std.collection.*
import std.time.*
import stdx.encoding.json.*
import std.convert.*
import std.sync.*
import stdx.encoding.base64.*
import itn_desktop_core.llm.*
import itn_desktop_core.util.*

public func kbDir(dataDir: String, kbId: String): String {
    return dataDir + Path.Separator + "kb" + Path.Separator + kbId
}

public func vectorsPath(dataDir: String, kbId: String): String {
    return kbDir(dataDir, kbId) + Path.Separator + "vectors.txt"
}

public func saveIndex(dataDir: String, kbId: String, idx: KbIndex): Unit {
    let dir = kbDir(dataDir, kbId)
    ensureDir(dir)
    // 向量走紧凑文本，一行一个切片；元数据仍走 JSON。
    // 分批追加写入：一次性拼出几十 MB 字符串会把堆顶穿。
    let vpath = Path(dir + Path.Separator + "vectors.txt")
    writeText(dir + Path.Separator + "vectors.txt", "")
    var sb = StringBuilder()
    var inBatch = 0
    for (c in idx.chunks) {
        var i = 0
        while (i < c.vector.size) {
            if (i > 0) {
                sb.append(" ")
            }
            sb.append(c.vector[i].toString())
            i = i + 1
        }
        sb.append("\n")
        inBatch = inBatch + 1
        if (inBatch >= 200) {
            File.appendTo(vpath, sb.toString().toArray())
            sb = StringBuilder()
            inBatch = 0
        }
    }
    if (inBatch > 0) {
        File.appendTo(vpath, sb.toString().toArray())
    }
    writeText(dir + Path.Separator + "index.json", idx.toJson().toString())
}

/** 原地解析一行浮点，避免为每个数字生成中间字符串数组。 */
func attachVectors(path: String, idx: KbIndex): Unit {
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

public func loadIndex(dataDir: String, kbId: String): KbIndex {
    let path = kbDir(dataDir, kbId) + Path.Separator + "index.json"
    let raw = readTextOr(path, "")
    if (raw.size == 0) {
        return KbIndex()
    }
    var idx = KbIndex()
    try {
        idx = KbIndex.fromJson(JsonValue.fromStr(raw))
    } catch (e: Exception) {
        return KbIndex()
    }
    attachVectors(vectorsPath(dataDir, kbId), idx)
    return idx
}

/** 扫描目录并按 Markdown 结构分块。不调用模型。 */
public func chunkAll(rootDir: String, maxChars: Int64): KbIndex {
    let idx = KbIndex()
    idx.rootDir = rootDir
    let docs = scanDocs(rootDir)
    for (d in docs) {
        let content = String.fromUtf8(File.readFrom(d.fullPath))
        for (c in chunkDocument(d, content, maxChars)) {
            idx.chunks.add(c)
        }
    }
    return idx
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
            c.caption = ""
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
