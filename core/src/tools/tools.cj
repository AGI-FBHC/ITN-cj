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

    public init(store: Store) {
        this.store = store
    }

    /** 工具：检索知识库，返回带出处的切片。
        配了向量模型就按向量相似度检索；没配（或调用失败）则退回字符二元组重叠度，
        保证知识库不被某个服务类型卡住。 */
    public func kbSearch(kbId: String, query: String, topK: Int64): ToolResult {
        let r = ToolResult()
        r.name = "kb_search"
        if (kbId.size == 0) {
            r.ok = false
            r.summary = "未指定知识库"
            return r
        }
        let s = store.load()
        let idx = loadIndexCached(store.dataDir, kbId)
        if (idx.chunks.size == 0) {
            r.ok = false
            r.summary = "知识库还没有索引"
            return r
        }
        var hits = ArrayList<SearchHit>()
        var mode = "关键词"
        if (s.embedModelId.size > 0) {
            match (s.findModel(s.embedModelId)) {
                case Some(cfg) =>
                    try {
                        let qv = LlmClient(cfg).embed([query])
                        hits = search(idx, qv[0], topK)
                        mode = "向量"
                    } catch (e: Exception) {
                        hits = keywordSearch(idx, query, topK)
                        mode = "关键词（向量调用失败：" + e.message + "）"
                    }
                case None =>
                    hits = keywordSearch(idx, query, topK)
            }
        } else {
            hits = keywordSearch(idx, query, topK)
        }
        let arr = JsonArray()
        for (h in hits) {
            arr.add(hitJson(h.chunk, h.score))
        }
        r.data = arr
        r.summary = "命中 " + hits.size.toString() + " 个切片（" + mode + "）"
        return r
    }
    /** 工具：把产物写到本地文件。 */
    public func saveArtifact(name: String, content: String): ToolResult {
        let r = ToolResult()
        r.name = "artifact_save"
        let dir = store.dataDir + Path.Separator + "artifacts"
        ensureDir(dir)
        let p = dir + Path.Separator + sanitizeName(name)
        writeText(p, content)
        r.data = JsonString(p)
        r.summary = "已写出产物"
        return r
    }
}
