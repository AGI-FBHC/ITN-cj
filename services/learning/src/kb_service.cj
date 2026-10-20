package zhixun_learning

import std.collection.*
import std.core.*
import std.env.*
import std.sync.*

/** 知识库与模型配置。Key 只放在环境变量里，其他项可在管理端调整。 */
class KbSettings {
    let baseUrl: String
    let embeddingModel: String
    let chatModel: String
    let embeddingDim: Int64
    let batchSize: Int64
    let chunkSize: Int64
    let chunkOverlap: Int64
    let topK: Int64

    init(baseUrl: String, embeddingModel: String, chatModel: String, embeddingDim: Int64,
         batchSize: Int64, chunkSize: Int64, chunkOverlap: Int64, topK: Int64) {
        this.baseUrl = baseUrl
        this.embeddingModel = embeddingModel
        this.chatModel = chatModel
        this.embeddingDim = embeddingDim
        this.batchSize = batchSize
        this.chunkSize = chunkSize
        this.chunkOverlap = chunkOverlap
        this.topK = topK
    }
}

func modelApiKey(): String {
    let primary = envOr("ZHIXUN_MODEL_API_KEY", "")
    if (primary.size > 0) { return primary }
    envOr("OPENAI_API_KEY", "")
}

func loadKbSettings(cfg: Config): KbSettings {
    let rows = query(cfg,
        "SELECT base_url,embedding_model,chat_model,embedding_dim,batch_size,chunk_size,chunk_overlap,top_k " +
        "FROM kb_settings WHERE id=1")
    if (rows.size == 0) {
        return KbSettings("", "", "", 0, 16, 800, 120, 6)
    }
    let row = rows[0]
    let batch = row.int("batch_size")
    let size = row.int("chunk_size")
    KbSettings(
        row.text("base_url"),
        row.text("embedding_model"),
        row.text("chat_model"),
        row.int("embedding_dim"),
        if (batch <= 0) { 16 } else if (batch > 64) { 64 } else { batch },
        if (size < 200) { 800 } else if (size > 4000) { 4000 } else { size },
        if (row.int("chunk_overlap") < 0) { 0 } else { row.int("chunk_overlap") },
        if (row.int("top_k") < 1) { 6 } else if (row.int("top_k") > 20) { 20 } else { row.int("top_k") }
    )
}

func endpointOf(settings: KbSettings): ModelEndpoint {
    ModelEndpoint(settings.baseUrl, modelApiKey(), settings.embeddingModel, settings.chatModel)
}

/** 进程内索引缓存：任何写操作把版本号加一，下次检索重建。 */
class KbIndexEntry {
    let hit: KbHit
    let vector: Array<Byte>

    init(hit: KbHit, vector: Array<Byte>) {
        this.hit = hit
        this.vector = vector
    }
}

let kbCacheLock = Mutex()
var kbCacheEntries: Array<KbIndexEntry> = []
var kbCacheVersion: Int64 = -1
var kbWriteVersion: Int64 = 0

func kbBumpVersion(): Unit {
    kbCacheLock.lock()
    try {
        kbWriteVersion += 1
    } finally {
        kbCacheLock.unlock()
    }
}

func kbLoadIndex(cfg: Config): Array<KbIndexEntry> {
    kbCacheLock.lock()
    let wanted = kbWriteVersion
    kbCacheLock.unlock()
    kbCacheLock.lock()
    try {
        if (kbCacheVersion == wanted) { return kbCacheEntries }
    } finally {
        kbCacheLock.unlock()
    }
    let rows = query(cfg,
        "SELECT c.id,c.document_id,c.heading_path,c.text,d.title doc_title,e.vec_hex " +
        "FROM kb_chunks c JOIN kb_documents d ON d.id=c.document_id " +
        "LEFT JOIN kb_embeddings e ON e.chunk_id=c.id " +
        "WHERE d.status<>'failed' ORDER BY c.document_id,c.chunk_index")
    let entries = ArrayList<KbIndexEntry>()
    for (row in rows) {
        let hit = KbHit(row.text("id"), row.text("document_id"), row.text("doc_title"),
            row.text("heading_path"), row.text("text"), 0.0)
        let hex = row.text("vec_hex")
        let vector = if (hex.size > 0) { kbHexDecode(hex) } else { Array<Byte>(0, repeat: 0) }
        entries.add(KbIndexEntry(hit, vector))
    }
    let loaded = entries.toArray()
    kbCacheLock.lock()
    try {
        kbCacheEntries = loaded
        kbCacheVersion = wanted
    } finally {
        kbCacheLock.unlock()
    }
    loaded
}

class KbSearchResult {
    let hits: ArrayList<KbHit>
    let mode: String
    let degraded: Bool
    let note: String

    init(hits: ArrayList<KbHit>, mode: String, degraded: Bool, note: String) {
        this.hits = hits
        this.mode = mode
        this.degraded = degraded
        this.note = note
    }
}

/**
 * 混合检索：向量（可用时）与字符二元组关键词各取宽候选，按名次融合再去冗。
 * 没有向量模型时不报错，直接退化成关键词检索。
 */
func kbSearch(cfg: Config, settings: KbSettings, queryText: String, topK: Int64): KbSearchResult {
    let entries = kbLoadIndex(cfg)
    let query = queryText.trimAscii()
    if (query.size == 0 || entries.size == 0) {
        return KbSearchResult(ArrayList<KbHit>(), "无内容", false, "")
    }
    let wide = if (topK < 8) { 24 } else { topK * 3 }
    let rankings = ArrayList<ArrayList<KbHit>>()
    let parts = ArrayList<String>()
    var degraded = false
    var note = ""
    let endpoint = endpointOf(settings)
    if (endpoint.hasEmbedding()) {
        try {
            let vectors = embedTexts(endpoint, [query])
            let queryVector = kbNormalize(vectors[0])
            let scored = ArrayList<KbHit>()
            for (entry in entries) {
                if (entry.vector.size == 0) { continue }
                let score = kbQuantizedCosine(queryVector, entry.vector)
                scored.add(KbHit(entry.hit.chunkId, entry.hit.documentId, entry.hit.docTitle,
                    entry.hit.headingPath, entry.hit.text, score))
            }
            if (scored.size > 0) {
                rankings.add(kbTopHits(scored, wide))
                parts.add("向量")
            } else {
                degraded = true
                note = "文档还没有向量，先按关键词检索"
            }
        } catch (error: Exception) {
            degraded = true
            note = "向量检索不可用：" + error.message
        }
    } else {
        degraded = true
        note = "未配置向量模型，当前只做关键词检索"
    }
    let grams = kbGramSet(query)
    let keywordPool = ArrayList<KbHit>()
    for (entry in entries) {
        let score = kbKeywordScore(grams, entry.hit.headingPath + "\n" + entry.hit.text)
        if (score > 0.0) {
            keywordPool.add(KbHit(entry.hit.chunkId, entry.hit.documentId, entry.hit.docTitle,
                entry.hit.headingPath, entry.hit.text, score))
        }
    }
    rankings.add(kbTopHits(keywordPool, wide))
    parts.add("关键词")
    let fused = kbRrfFuse(rankings, wide)
    let finalHits = kbDiversify(fused, topK, 0.75)
    let modeParts = ArrayList<String>()
    for (part in parts) { modeParts.add(part) }
    var mode = ""
    var i: Int64 = 0
    while (i < modeParts.size) {
        if (i > 0) { mode += "+" }
        mode += modeParts[i]
        i += 1
    }
    KbSearchResult(finalHits, mode + " 融合", degraded, note)
}

func kbInsertDocumentsChunks(cfg: Config, documentId: String, pieces: Array<KbPiece>): Array<String> {
    let ids = ArrayList<String>()
    for (piece in pieces) { ids.add(uuidFormat(uuidV4())) }
    var start: Int64 = 0
    while (start < pieces.size) {
        let statements = ArrayList<String>()
        var rows = ""
        var i = start
        var count: Int64 = 0
        while (i < pieces.size && count < 20) {
            let piece = pieces[i]
            if (rows.size > 0) { rows += "," }
            rows += "(" + sqlQuote(ids[i]) + "," + sqlQuote(documentId) + "," + i.toString() + "," +
                sqlQuote(piece.headingPath) + "," + sqlQuote(piece.text) + "," + piece.charCount().toString() + ")"
            i += 1
            count += 1
        }
        statements.add("INSERT INTO kb_chunks(id,document_id,chunk_index,heading_path,text,char_count) VALUES " + rows)
        transaction(cfg, statements.toArray())
        start = i
    }
    ids.toArray()
}

func kbSaveEmbeddings(cfg: Config, chunkIds: Array<String>, vectors: Array<Array<Float64>>, model: String): Int64 {
    var saved: Int64 = 0
    var start: Int64 = 0
    while (start < chunkIds.size && start < vectors.size) {
        var rows = ""
        var i = start
        var count: Int64 = 0
        var dim: Int64 = 0
        while (i < chunkIds.size && i < vectors.size && count < 20) {
            let unit = kbNormalize(vectors[i])
            let quantized = kbQuantizeUnit(unit)
            dim = quantized.size
            if (rows.size > 0) { rows += "," }
            rows += "(" + sqlQuote(chunkIds[i]) + "," + sqlQuote(model) + "," + dim.toString() + "," +
                sqlQuote(bytesToHex(quantized)) + ")"
            i += 1
            count += 1
        }
        if (rows.size > 0) {
            transaction(cfg, ["INSERT INTO kb_embeddings(chunk_id,model,dim,vec_hex) VALUES " + rows +
                " ON DUPLICATE KEY UPDATE model=VALUES(model),dim=VALUES(dim),vec_hex=VALUES(vec_hex)"])
            saved += count
        }
        start = i
    }
    saved
}

class KbIngestResult {
    let chunkCount: Int64
    let embeddedCount: Int64
    let note: String

    init(chunkCount: Int64, embeddedCount: Int64, note: String) {
        this.chunkCount = chunkCount
        this.embeddedCount = embeddedCount
        this.note = note
    }
}

/** 切块写库；配了向量模型就顺手把向量补上，失败不影响关键词检索。 */
func kbIngest(cfg: Config, documentId: String, title: String, content: String, settings: KbSettings): KbIngestResult {
    let pieces = kbChunksFor(title, content, settings.chunkSize, settings.chunkOverlap)
    execute(cfg, "UPDATE kb_documents SET status='indexing',error_message='' WHERE id=" + sqlQuote(documentId))
    execute(cfg, "DELETE FROM kb_chunks WHERE document_id=" + sqlQuote(documentId))
    let chunkIds = kbInsertDocumentsChunks(cfg, documentId, pieces)
    let endpoint = endpointOf(settings)
    var embedded: Int64 = 0
    var note = ""
    if (endpoint.hasEmbedding()) {
        var start: Int64 = 0
        while (start < pieces.size) {
            let inputs = ArrayList<String>()
            var i = start
            while (i < pieces.size && i < start + settings.batchSize) {
                inputs.add(pieces[i].indexText())
                i += 1
            }
            if (inputs.size == 0) { break }
            try {
                let vectors = embedTexts(endpoint, inputs.toArray())
                embedded += kbSaveEmbeddings(cfg, chunkIds[start..i], vectors, settings.embeddingModel)
            } catch (error: Exception) {
                note = "向量化失败，已保留关键词检索：" + error.message
                break
            }
            start = i
        }
    } else {
        note = "未配置向量模型，本次只建立关键词索引"
    }
    execute(cfg,
        "UPDATE kb_documents SET chunk_count=" + pieces.size.toString() + ",embedded_count=" + embedded.toString() +
        ",embedding_model=" + sqlQuote(if (embedded > 0) { settings.embeddingModel } else { "" }) +
        ",status='ready',indexed_at=NOW(6),error_message=" + sqlQuote(note) + " WHERE id=" + sqlQuote(documentId))
    kbBumpVersion()
    KbIngestResult(pieces.size, embedded, note)
}
