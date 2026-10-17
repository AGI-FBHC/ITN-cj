package itn_desktop_core.tools

import std.fs.*
import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.*
import itn_desktop_core.llm.*
import itn_desktop_core.kb.*
import itn_desktop_core.util.*

public class ToolResult {
    public var name: String = ""
    public var ok: Bool = true
    public var summary: String = ""
    public var data: JsonValue = JsonNull()
}

/** 去掉路径分隔符与冒号，产物名只能落在 artifacts 目录内。 */
public func sanitizeName(name: String): String {
    let b = name.toArray()
    let out = ArrayList<UInt8>()
    var i = 0
    while (i < b.size) {
        let c = b[i]
        if (c == 47 || c == 92 || c == 58 || c == 42 || c == 63 || c == 34 || c == 60 || c == 62 || c == 124) {
            out.add(95)
        } else {
            out.add(c)
        }
        i = i + 1
    }
    let s = trimStr(String.fromUtf8(out.toArray()))
    if (s.size == 0) {
        return "artifact.md"
    }
    return s
}

public func hitJson(chunk: KbChunk, score: Float64): JsonObject {
    let o = JsonObject()
    o.put("score", JsonFloat(score))
    o.put("id", JsonString(chunk.id))
    o.put("docPath", JsonString(chunk.docPath))
    o.put("docTitle", JsonString(chunk.docTitle))
    o.put("headingPath", JsonString(chunk.headingPath))
    o.put("ordinal", JsonInt(chunk.ordinal))
    o.put("text", JsonString(chunk.text))
    o.put("caption", JsonString(chunk.caption))
    let imgs = JsonArray()
    for (i in chunk.images) {
        imgs.add(JsonString(i))
    }
    o.put("images", imgs)
    return o
}

public class ToolRegistry {
    public let store: Store
    public var shouldAbort: () -> Bool = { => false }

    public init(store: Store) {
        this.store = store
    }

    /** 工具：检索知识库，返回带出处的切片。
        配了向量模型就按向量相似度检索；没配（或调用失败）则退回字符二元组重叠度，
        保证知识库不被某个服务类型卡住。 */
    public func kbSearch(kbId: String, query: String, topK: Int64): ToolResult {
        let r = ToolResult()
        r.name = "kb_search"
        // kbId 为空 = 通用模式：把本机登记的所有知识库都搜一遍，结果合并排序。
        // 出处的标题会带上库名（《库名》标题），引用里才看得出这句出自哪一份资料。
        if (kbId.size == 0) {
            return kbSearchAll(query, topK)
        }
        let s = store.load()
        let idx = loadIndexCached(store.dataDir, kbId)
        if (idx.chunks.size == 0) {
            r.ok = false
            r.summary = "知识库还没有索引"
            return r
        }
        // 混合检索：向量（配了向量模型就带上）+ 关键词两路融合，再做去冗。
        // 只在一处决定"怎么检索"，界面那条 /api/kb/search 与这里走的是同一个函数。
        var qv: Option<Array<Float64>> = None
        var note = ""
        if (s.embedModelId.size > 0) {
            match (s.findModel(s.embedModelId)) {
                case Some(cfg) =>
                    try {
                        let modelClient = LlmClient(cfg)
                        modelClient.shouldAbort = shouldAbort
                        let vecs = modelClient.embed([query])
                        if (vecs.size > 0) {
                            qv = Some(vecs[0])
                        }
                    } catch (e: Exception) {
                        if (shouldAbort()) { throw Exception("已取消") }
                        note = "（向量调用失败，只用了关键词：" + e.message + "）"
                    }
                case None => ()
            }
        }
        let (hits, mode0) = hybridSearch(idx, query, qv, topK)
        let mode = mode0 + note
        let arr = JsonArray()
        for (h in hits) {
            arr.add(hitJson(h.chunk, h.score))
        }
        r.data = arr
        r.summary = "命中 " + hits.size.toString() + " 个切片（" + mode + "）"
        return r
    }
    /**
     * 通用模式：本机所有知识库里一起搜。
     *
     * 每个库各取 topK 个候选，再用同一把尺子（分数）合并取前 topK 个 ——
     * 不同库的分数来自同一套算法（向量余弦或关键词重叠度），可以直接比。
     */
    public func kbSearchAll(query: String, topK: Int64): ToolResult {
        let r = ToolResult()
        r.name = "kb_search"
        let s = store.load()
        let merged = ArrayList<JsonObject>()
        var mode = "关键词"
        var searched: Int64 = 0
        var skipped: Int64 = 0
        for (kb in s.knowledgeBases) {
            let idx = loadIndexCached(store.dataDir, kb.id)
            if (idx.chunks.size == 0) {
                skipped = skipped + 1
                continue
            }
            searched = searched + 1
            var qv: Option<Array<Float64>> = None
            if (s.embedModelId.size > 0) {
                match (s.findModel(s.embedModelId)) {
                    case Some(cfg) =>
                        try {
                            let modelClient = LlmClient(cfg)
                            modelClient.shouldAbort = shouldAbort
                            let vecs = modelClient.embed([query])
                            if (vecs.size > 0) {
                                qv = Some(vecs[0])
                            }
                        } catch (e: Exception) {
                            if (shouldAbort()) { throw Exception("已取消") }
                        }
                    case None => ()
                }
            }
            let (hits, mode1) = hybridSearch(idx, query, qv, topK)
            mode = mode1
            let kbName = if (kb.name.size > 0) { kb.name } else { kb.id }
            for (h in hits) {
                let o = hitJson(h.chunk, h.score)
                o.put("kbId", JsonString(kb.id))
                o.put("kbName", JsonString(kbName))
                o.put("docTitle", JsonString("《" + kbName + "》" + h.chunk.docTitle))
                merged.add(o)
            }
        }
        if (searched == 0) {
            r.ok = false
            r.summary = "本机还没有建过索引的知识库"
            return r
        }
        // 按分数从大到小取前 topK（选择排序，量级很小）
        let n = merged.size
        let k = if (topK < n) { topK } else { n }
        let arr = JsonArray()
        var taken: Int64 = 0
        while (taken < k) {
            var best = -1
            var bestScore = -1.0e308
            var i = 0
            while (i < n) {
                let sc = floatValue(match (merged[i].get("score")) { case Some(v) => v; case None => JsonNull() })
                if (sc > bestScore) {
                    bestScore = sc
                    best = i
                }
                i = i + 1
            }
            if (best < 0) {
                break
            }
            arr.add(merged[best])
            merged[best] = JsonObject()
            taken = taken + 1
        }
        r.data = arr
        var extra = ""
        if (skipped > 0) {
            extra = "，" + skipped.toString() + " 个库还没有索引"
        }
        r.summary = "在 " + searched.toString() + " 个知识库里命中 " + taken.toString() + " 个切片（" + mode + "）" + extra
        return r
    }

    /** 工具：把模型候选产物写到 drafts。 */
    public func saveArtifact(name: String, content: String): ToolResult { return saveArtifactTo("drafts", name, content) }

    /** 界面确认后的成果写到 artifacts；模型候选仍走 drafts。 */
    public func saveArtifactTo(folder: String, name: String, content: String): ToolResult {
        let r = ToolResult()
        r.name = "artifact_save"
        let dir = store.dataDir + Path.Separator + folder
        ensureDir(dir)
        let safe = sanitizeName(name)
        // 重名不覆盖：不同知识库/不同时间生成同一个主题（例如都叫「讲义-第一章.md」）时，
        // 直接写会静默把上一份冲掉——用户看不到任何提示就丢了东西。这里改成自动加序号。
        var finalName = safe
        var n = 2
        while (exists(dir + Path.Separator + finalName)) {
            let base = if (safe.size > 3 && hasSuffix(safe, ".md")) { String.fromUtf8(safe.toArray()[0..(safe.size - 3)]) } else { safe }
            finalName = base + "-" + n.toString() + ".md"
            n = n + 1
        }
        let p = dir + Path.Separator + finalName
        writeText(p, content)
        r.data = JsonString(p)
        r.summary = "已写出产物 " + finalName
        return r
    }
}
