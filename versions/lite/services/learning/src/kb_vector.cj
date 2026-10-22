package zhixun_learning

import std.collection.*
import std.core.*
import std.math.*

/** 检索命中的切片。score 在融合前后含义不同，由调用方决定如何展示。 */
class KbHit {
    let chunkId: String
    let documentId: String
    let docTitle: String
    let headingPath: String
    let text: String
    var score: Float64

    init(chunkId: String, documentId: String, docTitle: String, headingPath: String, text: String, score: Float64) {
        this.chunkId = chunkId
        this.documentId = documentId
        this.docTitle = docTitle
        this.headingPath = headingPath
        this.text = text
        this.score = score
    }
}

func kbHexDigit(c: String): Int64 {
    match ("0123456789abcdef".indexOf(c.toAsciiLower())) {
        case Some(position) => position
        case None => 0
    }
}

func kbHexDecode(hex: String): Array<Byte> {
    let count = hex.size / 2
    let out = Array<Byte>(count, repeat: 0)
    var i: Int64 = 0
    while (i < count) {
        let high = kbHexDigit(hex[i * 2..i * 2 + 1])
        let low = kbHexDigit(hex[i * 2 + 1..i * 2 + 2])
        out[i] = UInt8((high << 4) | low)
        i += 1
    }
    out
}

func kbNormalize(vec: Array<Float64>): Array<Float64> {
    var sum: Float64 = 0.0
    for (value in vec) { sum += value * value }
    if (sum <= 0.0) { return vec }
    let norm = sqrt(sum)
    let out = Array<Float64>(vec.size, repeat: 0.0)
    var i: Int64 = 0
    while (i < vec.size) {
        out[i] = vec[i] / norm
        i += 1
    }
    out
}

/** 单位向量压成 int8（0..255 表示 -1..1），1024 维只占 1KB。 */
func kbQuantizeUnit(vec: Array<Float64>): Array<Byte> {
    let out = Array<Byte>(vec.size, repeat: 128)
    var i: Int64 = 0
    while (i < vec.size) {
        var scaled = vec[i] * 127.0
        if (scaled > 127.0) { scaled = 127.0 }
        if (scaled < -127.0) { scaled = -127.0 }
        let rounded = Int64(scaled + (if (scaled >= 0.0) { 0.5 } else { -0.5 }))
        out[i] = UInt8(rounded + 128)
        i += 1
    }
    out
}

/** 查询向量与量化向量的余弦：查询已归一化，量化向量解压成 [-1,1]。 */
func kbQuantizedCosine(query: Array<Float64>, quantized: Array<Byte>): Float64 {
    if (query.size == 0 || query.size != quantized.size) { throw Exception("查询与索引向量维度不一致，请重新建立索引") }
    let n = query.size
    var dot = 0.0
    var qa = 0.0
    var ba = 0.0
    var i: Int64 = 0
    while (i < n) {
        let q = query[i]
        let b = Float64(Int64(quantized[i]) - 128) / 127.0
        dot += q * b
        qa += q * q
        ba += b * b
        i += 1
    }
    if (qa <= 0.0 || ba <= 0.0) { return 0.0 }
    dot / (sqrt(qa) * sqrt(ba))
}

func kbGramHash(bytes: Array<Byte>, start: Int64, end: Int64): Int64 {
    var h: Int64 = 0
    var i = start
    while (i < end) {
        h = ((h << 5) + h + Int64(bytes[i])) & 2147483647
        i += 1
    }
    h
}

func kbCharStarts(bytes: Array<Byte>): ArrayList<Int64> {
    let out = ArrayList<Int64>()
    var i: Int64 = 0
    while (i < bytes.size) {
        if (kbIsLeadByte(bytes[i])) { out.add(i) }
        i += 1
    }
    out
}

/** 字符二元组集合：中文里这比按词切更稳，也不依赖分词器。 */
func kbGramSet(text: String): HashSet<Int64> {
    let bytes = text.toArray()
    let starts = kbCharStarts(bytes)
    let set = HashSet<Int64>()
    var i: Int64 = 0
    while (i + 1 < starts.size) {
        let end = if (i + 2 < starts.size) { starts[i + 2] } else { bytes.size }
        set.add(kbGramHash(bytes, starts[i], end))
        i += 1
    }
    set
}

/** 关键词得分：命中二元组数 / sqrt(切片二元组总数)，避免长切片靠字数取胜。 */
func kbKeywordScore(queryGrams: HashSet<Int64>, text: String): Float64 {
    if (queryGrams.size == 0) { return 0.0 }
    let bytes = text.toArray()
    let starts = kbCharStarts(bytes)
    if (starts.size < 2) { return 0.0 }
    var matches: Int64 = 0
    var total: Int64 = 0
    var i: Int64 = 0
    while (i + 1 < starts.size) {
        let end = if (i + 2 < starts.size) { starts[i + 2] } else { bytes.size }
        if (queryGrams.contains(kbGramHash(bytes, starts[i], end))) { matches += 1 }
        total += 1
        i += 1
    }
    if (matches == 0 || total == 0) { return 0.0 }
    Float64(matches) / sqrt(Float64(total))
}

func kbTopHits(pool: ArrayList<KbHit>, topK: Int64): ArrayList<KbHit> {
    let out = ArrayList<KbHit>()
    let n = pool.size
    var taken: Int64 = 0
    while (taken < topK && taken < n) {
        var best: Int64 = -1
        var bestScore = -1.0e308
        var i: Int64 = 0
        while (i < n) {
            if (pool[i].score > bestScore) {
                bestScore = pool[i].score
                best = i
            }
            i += 1
        }
        if (best < 0) { break }
        let picked = pool[best]
        out.add(KbHit(picked.chunkId, picked.documentId, picked.docTitle, picked.headingPath, picked.text, bestScore))
        pool[best].score = -1.0e308
        taken += 1
    }
    out
}

/** 名次融合：只看排第几，不看分数量级，所以向量与关键词两路可以直接相加。 */
func kbRrfFuse(rankings: ArrayList<ArrayList<KbHit>>, topK: Int64): ArrayList<KbHit> {
    let scores = HashMap<String, Float64>()
    let hits = HashMap<String, KbHit>()
    for (ranking in rankings) {
        var i: Int64 = 0
        while (i < ranking.size) {
            let hit = ranking[i]
            scores[hit.chunkId] = (scores.get(hit.chunkId) ?? 0.0) + 1.0 / (60.0 + Float64(i + 1))
            hits[hit.chunkId] = hit
            i += 1
        }
    }
    let pool = ArrayList<KbHit>()
    for ((key, value) in scores) {
        match (hits.get(key)) {
            case Some(hit) => pool.add(KbHit(hit.chunkId, hit.documentId, hit.docTitle, hit.headingPath, hit.text, value))
            case None => ()
        }
    }
    kbTopHits(pool, topK)
}

/**
 * 去冗：同一份文档已经出过两片后明显降权，紧挨着的同文档续写再降一档。
 * 分数先按池内最高分归一，否则 RRF 的 0.0x 量级会被 0.35 的扣分直接压平。
 */
func kbDiversify(pool: ArrayList<KbHit>, topK: Int64, lambda: Float64): ArrayList<KbHit> {
    let rest = ArrayList<KbHit>(pool)
    let picked = ArrayList<KbHit>()
    let perDoc = HashMap<String, Int64>()
    var maxScore = 0.000001
    for (hit in rest) {
        if (hit.score > maxScore) { maxScore = hit.score }
    }
    while (picked.size < topK && rest.size > 0) {
        var best: Int64 = -1
        var bestScore = -1.0e308
        var i: Int64 = 0
        while (i < rest.size) {
            let hit = rest[i]
            let used = perDoc.get(hit.documentId) ?? 0
            var penalty = 0.0
            if (used >= 2) {
                penalty = 0.35
            } else if (used == 1) {
                penalty = 0.12
            }
            if (picked.size > 0 && picked[picked.size - 1].documentId == hit.documentId) {
                penalty += 0.18
            }
            let score = lambda * (hit.score / maxScore) - penalty
            if (score > bestScore) {
                bestScore = score
                best = i
            }
            i += 1
        }
        if (best < 0) { break }
        let chosen = rest[best]
        picked.add(chosen)
        perDoc[chosen.documentId] = (perDoc.get(chosen.documentId) ?? 0) + 1
        rest.remove(at: best)
    }
    picked
}
