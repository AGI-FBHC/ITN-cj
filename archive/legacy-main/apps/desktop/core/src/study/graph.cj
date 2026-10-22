package itn_desktop_core.study

import std.collection.*
import std.convert.*
import std.fs.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.kb.*
import itn_desktop_core.store.*
import itn_desktop_core.util.*

/**
 * 学习网络图：把"我现在学到哪了"画成一张能点、能转的图。
 *
 * 三件事刻意做成这样：
 * 1. **从真实状态推导**，不做需要手工维护的知识图谱：节点就是章节（大小 = 切片数，颜色 = 进度），
 *    笔记/错题/产物挂在章节上，学完一章、做错一题、生成一份讲义，图自己就变。
 * 2. **一个只读接口**：前端不拼 5 个接口，`/api/graph` 一次给全。
 * 3. **不画空图**：没有索引就直接说"还没有可画的章节"，让界面给"去建立索引"。
 *
 * 连边取两种证据：同一篇文档里出现的章节（结构关系）+ 章节正文的字符 2-gram 重合度（内容相近）。
 * 中文没有分词也能算：2-gram 重合度足够把"同一主题"的章节连起来。
 */
public class GraphNode {
    public var name: String = ""
    public var chunkCount: Int64 = 0
    public var sectionCount: Int64 = 0
    public var docCount: Int64 = 0
    public var readCount: Int64 = 0
    public var done: Bool = false
    public var notes: Int64 = 0
    public var wrong: Int64 = 0
    public var wrongDue: Int64 = 0
    public var mastered: Int64 = 0
    public var grams: HashSet<Int64> = HashSet<Int64>()
    public var docs: HashSet<String> = HashSet<String>()
    public var artifacts: ArrayList<JsonObject> = ArrayList<JsonObject>()
}

/**
 * 正文取"字节 3-gram"，用来算章节之间的内容相近度。
 *
 * 为什么按字节而不是按字符：UTF-8 里一个汉字 3 字节，任意切两字节都可能切在一个字中间
 * （`String.fromUtf8` 会直接抛 "Invalid utf8 byte sequence"）。这里把窗口直接哈希成 Int64
 * 当键，全程不做字符串解码——中文一样能算，也不会碰到边界问题。
 */
func chapterGrams(text: String, cap: Int64): HashSet<Int64> {
    let out = HashSet<Int64>()
    let b = byteSafePrefix(text, 3000).toArray()
    let n = b.size
    var i = 0
    while (i + 2 < n) {
        let c0 = Int64(b[i])
        // 只从"像词"的字节起头：ASCII 字母数字，或 UTF-8 汉字的起始字节（>=0xE0）
        let wordish = (c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 >= 0xE0
        if (wordish) {
            let key = (c0 * 131 + Int64(b[i + 1])) * 131 + Int64(b[i + 2])
            out.add(key)
            if (out.size >= cap) {
                break
            }
        }
        i = i + 1
    }
    return out
}

func pairWeight(e: JsonObject): Float64 {
    match (e.get("weight")) {
        case Some(v) => return floatValue(v)
        case None => return 0.0
    }
}

func setOverlap(a: HashSet<Int64>, b: HashSet<Int64>): Float64 {
    if (a.size == 0 || b.size == 0) {
        return 0.0
    }
    var small = a
    var big = b
    if (a.size > b.size) {
        small = b
        big = a
    }
    var hit: Int64 = 0
    for (g in small) {
        if (big.contains(g)) {
            hit = hit + 1
        }
    }
    let denom = if (small.size > 0) { small.size } else { 1 }
    return Float64(hit) / Float64(denom)
}

/** 产物挂在章节上：产物名里含章节名（"讲义-提示词工程.md" ↔ "提示词工程"）就算它的。 */
func artifactChapter(name: String, chapters: ArrayList<String>): Int64 {
    var best = -1
    var bestLen: Int64 = 0
    var i = 0
    while (i < chapters.size) {
        let c = chapters[i]
        if (c.size >= 2 && name.indexOf(c) != None) {
            if (c.size > bestLen) {
                bestLen = c.size
                best = i
            }
        }
        i = i + 1
    }
    return best
}

func artifactKind(name: String): String {
    if (hasPrefix(name, "讲义")) {
        return "lecture"
    }
    if (hasPrefix(name, "练习")) {
        return "quiz"
    }
    return "other"
}

/** 图最多画这么多节点；超了只画主干并如实说"折叠了 N 个"。 */
let GRAPH_MAX_NODES: Int64 = 200

public func buildGraph(dataDir: String, kbId: String): JsonObject {
    let out = JsonObject()
    let index = loadIndexCached(dataDir, kbId)
    if (index.chunks.size == 0) {
        out.put("empty", JsonBool(true))
        out.put("reason", JsonString(if (kbId.size == 0) { "还没有选择知识库" } else { "这个知识库还没有索引" }))
        out.put("nodes", JsonArray())
        out.put("edges", JsonArray())
        out.put("folded", JsonInt(0))
        return out
    }
    let store = StudyStore(dataDir)
    let d = store.load()
    let db = DbHub.open(dataDir)
    let nowMs = DateTime.now().toUnixTimeStamp().toMilliseconds()

    // ---- 节点：按章节聚合 ----
    let order = ArrayList<String>()
    let map = HashMap<String, GraphNode>()
    for (c in index.chunks) {
        let name = chapterOf(c.headingPath, c.docTitle)
        if (!map.contains(name)) {
            let fresh = GraphNode()
            fresh.name = name
            map[name] = fresh
            order.add(name)
        }
        match (map.get(name)) {
            case Some(node) =>
                node.chunkCount = node.chunkCount + 1
                node.docs.add(c.docPath)
                let readKey = kbId + "|" + c.id
                if (d.progress.isRead(readKey)) {
                    node.readCount = node.readCount + 1
                }
            case None => ()
        }
    }
    // 小节数与 2-gram（每章只取前若干切片，避免大库把时间花在算图上）
    var gi = 0
    for (name in order) {
        match (map.get(name)) {
            case Some(node) =>
                let sections = HashSet<String>()
                let sb = StringBuilder()
                var taken: Int64 = 0
                for (c in index.chunks) {
                    if (chapterOf(c.headingPath, c.docTitle) != name) {
                        continue
                    }
                    if (c.headingPath.size > 0) {
                        sections.add(c.headingPath)
                    }
                    if (taken < 4) {
                        sb.append(c.text)
                        taken = taken + 1
                    }
                    if (gi > 4000) {
                        break
                    }
                }
                node.sectionCount = sections.size
                node.docCount = node.docs.size
                node.grams = chapterGrams(sb.toString(), 160)
            case None => ()
        }
        gi = gi + 1
    }

    // ---- 笔记 ----
    for (n in d.notes) {
        if (n.chapter.size == 0) {
            continue
        }
        match (map.get(n.chapter)) {
            case Some(node) => node.notes = node.notes + 1
            case None => ()
        }
    }

    // ---- 错题（含今天该复习的）----
    for (r in d.quizRecords) {
        if (r.correct) {
            continue
        }
        match (map.get(r.chapter)) {
            case Some(node) =>
                node.wrong = node.wrong + 1
                let ro = r.toJson()
                attachReviewState(db, ro, r.id, nowMs)
                if (boolOf(ro, "mastered")) {
                    node.mastered = node.mastered + 1
                } else if (boolOf(ro, "due")) {
                    node.wrongDue = node.wrongDue + 1
                }
            case None => ()
        }
    }

    // ---- 产物 ----
    let artDir = dataDir + Path.Separator + "artifacts"
    if (exists(artDir)) {
        try {
            Directory.walk(Path(artDir), { fi: FileInfo =>
                if (!fi.isDirectory() && hasSuffix(fi.name, ".md")) {
                    let idx = artifactChapter(fi.name, order)
                    if (idx >= 0) {
                        match (map.get(order[idx])) {
                            case Some(node) =>
                                let a = JsonObject()
                                a.put("name", JsonString(fi.name))
                                a.put("kind", JsonString(artifactKind(fi.name)))
                                node.artifacts.add(a)
                            case None => ()
                        }
                    }
                }
                false
            })
        } catch (e: Exception) {
            ()
        }
    }

    // ---- 折叠：超过上限只留切片数最多的那批 ----
    var keep = order
    var folded: Int64 = 0
    if (order.size > GRAPH_MAX_NODES) {
        let sorted = ArrayList<String>()
        for (x in order) {
            sorted.add(x)
        }
        // 简单的选择排序取前 N：章节数量级不大，够用且不引依赖
        var i = 0
        while (i < sorted.size) {
            var j = i + 1
            while (j < sorted.size) {
                let ci = match (map.get(sorted[i])) { case Some(x) => x.chunkCount; case None => 0 }
                let cj = match (map.get(sorted[j])) { case Some(x) => x.chunkCount; case None => 0 }
                if (cj > ci) {
                    let t = sorted[i]
                    sorted[i] = sorted[j]
                    sorted[j] = t
                }
                j = j + 1
            }
            i = i + 1
        }
        keep = ArrayList<String>()
        var k = 0
        while (k < GRAPH_MAX_NODES) {
            keep.add(sorted[k])
            k = k + 1
        }
        folded = order.size - GRAPH_MAX_NODES
    }

    let nodes = JsonArray()
    for (name in keep) {
        match (map.get(name)) {
            case Some(node) =>
                let o = JsonObject()
                o.put("id", JsonString(node.name))
                o.put("name", JsonString(node.name))
                o.put("chunkCount", JsonInt(node.chunkCount))
                o.put("sectionCount", JsonInt(node.sectionCount))
                o.put("docCount", JsonInt(node.docCount))
                o.put("readCount", JsonInt(node.readCount))
                o.put("done", JsonBool(node.chunkCount > 0 && node.readCount >= node.chunkCount))
                o.put("status", JsonString(if (node.chunkCount > 0 && node.readCount >= node.chunkCount) {
                    "done"
                } else if (node.readCount > 0) {
                    "reading"
                } else {
                    "todo"
                }))
                o.put("notes", JsonInt(node.notes))
                o.put("wrong", JsonInt(node.wrong))
                o.put("wrongDue", JsonInt(node.wrongDue))
                o.put("mastered", JsonInt(node.mastered))
                let arts = JsonArray()
                for (a in node.artifacts) {
                    arts.add(a)
                }
                o.put("artifacts", arts)
                // 这篇章节出自哪些文档：星云图按它把章节分成"子团"（文档 = 子团中心）
                let docArr = JsonArray()
                for (doc in node.docs) {
                    docArr.add(JsonString(doc))
                }
                o.put("docs", docArr)
                nodes.add(o)
            case None => ()
        }
    }

    // ---- 连边：同文档 + 内容相近，每点最多留 4 条最强的 ----
    let pairs = ArrayList<JsonObject>()
    var a = 0
    while (a < keep.size) {
        var b = a + 1
        while (b < keep.size) {
            let na = match (map.get(keep[a])) { case Some(x) => x; case None => GraphNode() }
            let nb = match (map.get(keep[b])) { case Some(x) => x; case None => GraphNode() }
            var w = setOverlap(na.grams, nb.grams)
            var sameDoc = false
            for (doc in na.docs) {
                if (nb.docs.contains(doc)) {
                    sameDoc = true
                }
            }
            if (sameDoc) {
                w = w + 0.35
            }
            if (w >= 0.12) {
                let e = JsonObject()
                e.put("from", JsonString(na.name))
                e.put("to", JsonString(nb.name))
                e.put("weight", JsonFloat(w))
                e.put("sameDoc", JsonBool(sameDoc))
                pairs.add(e)
            }
            b = b + 1
        }
        a = a + 1
    }
    let edges = JsonArray()
    let kept = HashMap<String, Int64>()
    var pi = 0
    // 先按权重从大到小，再按"每点最多 4 条"过滤
    while (pi < pairs.size) {
        var best = -1
        var bestW = 0.0
        var i = pi
        while (i < pairs.size) {
            let w = pairWeight(pairs[i])
            if (w > bestW) {
                bestW = w
                best = i
            }
            i = i + 1
        }
        if (best < 0) {
            break
        }
        let e = pairs[best]
        let from = strOf(e, "from")
        let to = strOf(e, "to")
        let cf = match (kept.get(from)) { case Some(x) => x; case None => 0 }
        let ct = match (kept.get(to)) { case Some(x) => x; case None => 0 }
        if (cf < 4 && ct < 4) {
            edges.add(e)
            kept[from] = cf + 1
            kept[to] = ct + 1
        }
        pairs[best] = pairs[pi]
        pairs[pi] = e
        pi = pi + 1
    }

    let stats = JsonObject()
    stats.put("chapters", JsonInt(order.size))
    stats.put("notes", JsonInt(d.notes.size))
    stats.put("readChunks", JsonInt(d.progress.readChunks.size))
    stats.put("doneChapters", JsonInt(d.progress.completedChapters.size))

    out.put("empty", JsonBool(false))
    out.put("kbId", JsonString(kbId))
    out.put("nodes", nodes)
    out.put("edges", edges)
    out.put("folded", JsonInt(folded))
    out.put("stats", stats)
    return out
}


/* ============================================================
   星云图（首页"所有知识库一屏看完"）
   ------------------------------------------------------------
   与 /api/graph 的分工：graph 是"一个库里的章节网络"；nebula 是"所有库 + 每库一团"，
   聚合直接复用 buildGraph，不重写一遍。
   内核只给**数据**（每个库的章节、库内连边、hue、最近动静）与**上限**；
   球壳位置这类布局留给前端算——那里才知道画布多大、要不要按 reduced-motion 收着点。
   颜色按库 id 哈希：同一个库永远同一团颜色，加库/删库不会让整张图换色或重排。
   ============================================================ */

const NEBULA_DRAW_CLUSTERS: Int64 = 8
const NEBULA_MAX_POINTS: Int64 = 1200

/** 8 色调色板（色相彼此拉开 ≥40°）。色相与主题无关，主题只换背景与叠加方式。 */
let NEBULA_HUES: Array<Int64> = [152, 196, 240, 284, 328, 8, 40, 96]

/** 稳定哈希（同一个库 id 永远同一个值）。 */
func hashOf(text: String): Int64 {
    let b = text.toArray()
    var h: Int64 = 7
    var i = 0
    while (i < b.size) {
        h = ((h << 5) + h + Int64(b[i])) & 2147483647
        i = i + 1
    }
    return h
}

public func hueOf(kbId: String): Int64 {
    return NEBULA_HUES[hashOf(kbId) % NEBULA_HUES.size]
}

/** 这个库最近一次动静：进度 / 笔记 / 答题三张表里最新的时间戳（都没有就用索引时间）。 */
func lastActiveAt(db: Db, kbId: String, fallback: String): String {
    var best = fallback
    let sqls = [
        "SELECT MAX(at) FROM progress WHERE kb_id = ?",
        "SELECT MAX(created_at) FROM notes WHERE kb_id = ?",
        "SELECT MAX(created_at) FROM quiz_records WHERE kb_id = ?"
    ]
    for (sql in sqls) {
        try {
            let t = db.scalarText(sql, va([tv(kbId)]))
            if (t.size > 0 && t > best) {
                best = t
            }
        } catch (e: Exception) {
            ()
        }
    }
    return best
}

func sumInt(nodes: JsonArray, key: String): Int64 {
    var n: Int64 = 0
    var i = 0
    while (i < nodes.size()) {
        n = n + intOf(match (objOf(nodes[i])) { case Some(o) => o; case None => JsonObject() }, key)
        i = i + 1
    }
    return n
}

func countArtifacts(nodes: JsonArray): Int64 {
    var n: Int64 = 0
    var i = 0
    while (i < nodes.size()) {
        match (objOf(nodes[i])) {
            case Some(o) =>
                match (o.get("artifacts")) {
                    case Some(v) =>
                        match (v) {
                            case arr: JsonArray => n = n + arr.size()
                            case _ => ()
                        }
                    case None => ()
                }
            case None => ()
        }
        i = i + 1
    }
    return n
}

/** 章节 → 星云图里那个点（带 docKey，前端据此把章节分成子团）。 */
func nebulaChapter(node: JsonObject): JsonObject {
    let o = JsonObject()
    o.put("name", JsonString(strOf(node, "name")))
    o.put("chunkCount", JsonInt(intOf(node, "chunkCount")))
    o.put("readCount", JsonInt(intOf(node, "readCount")))
    o.put("done", JsonBool(boolOf(node, "done")))
    o.put("status", JsonString(strOf(node, "status")))
    o.put("notes", JsonInt(intOf(node, "notes")))
    o.put("wrong", JsonInt(intOf(node, "wrong")))
    o.put("wrongDue", JsonInt(intOf(node, "wrongDue")))
    let names = JsonArray()
    var artCount: Int64 = 0
    match (node.get("artifacts")) {
        case Some(v) =>
            match (v) {
                case arr: JsonArray =>
                    var i = 0
                    while (i < arr.size()) {
                        match (objOf(arr[i])) {
                            case Some(ao) =>
                                names.add(JsonString(strOf(ao, "name")))
                                artCount = artCount + 1
                            case None => ()
                        }
                        i = i + 1
                    }
                case _ => ()
            }
        case None => ()
    }
    o.put("artifactNames", names)
    o.put("artifactCount", JsonInt(artCount))
    var docKey = ""
    match (node.get("docs")) {
        case Some(v) =>
            match (v) {
                case arr: JsonArray =>
                    if (arr.size() > 0) {
                        docKey = strValue(arr[0])
                    }
                case _ => ()
            }
        case None => ()
    }
    o.put("docKey", JsonString(docKey))
    return o
}

/**
 * 星云图数据。
 *
 * 一道闸门：库数超过上限时只画最近活跃的那几个（其余折成计数）；点数超过全局上限时，
 * 每个库按比例留前若干章（其余记进这个库的 folded）。
 */
public func buildNebula(dataDir: String): JsonObject {
    let out = JsonObject()
    let db = DbHub.open(dataDir)
    let cfg = Store(dataDir).load()

    let ids = ArrayList<String>()
    let names = ArrayList<String>()
    let acts = ArrayList<String>()
    for (kb in cfg.knowledgeBases) {
        ids.add(kb.id)
        names.add(if (kb.name.size > 0) { kb.name } else { kb.id })
        acts.add(lastActiveAt(db, kb.id, kb.builtAt))
    }
    // 按最近动静排序（选择排序：库的数量级很小）
    var i = 0
    while (i < ids.size) {
        var j = i + 1
        while (j < ids.size) {
            if (acts[j] > acts[i]) {
                let t = ids[i]
                ids[i] = ids[j]
                ids[j] = t
                let nm = names[i]
                names[i] = names[j]
                names[j] = nm
                let at = acts[i]
                acts[i] = acts[j]
                acts[j] = at
            }
            j = j + 1
        }
        i = i + 1
    }

    let clusterList = ArrayList<JsonObject>()
    let clusterNodes = ArrayList<JsonArray>()
    let unformed = JsonArray()
    var foldedClusters: Int64 = 0
    var drawn: Int64 = 0
    var readChunks: Int64 = 0
    var wrongDue: Int64 = 0
    var artifactCount: Int64 = 0
    var chaptersAll: Int64 = 0

    var k = 0
    while (k < ids.size) {
        let g = buildGraph(dataDir, ids[k])
        if (boolOf(g, "empty")) {
            // 没索引的库：不画星云，画"未成形模糊团 + 建立索引"
            let u = JsonObject()
            u.put("id", JsonString(ids[k]))
            u.put("name", JsonString(names[k]))
            u.put("hue", JsonInt(hueOf(ids[k])))
            u.put("reason", JsonString(strOf(g, "reason")))
            u.put("lastActiveAt", JsonString(acts[k]))
            unformed.add(u)
            k = k + 1
            continue
        }
        if (drawn >= NEBULA_DRAW_CLUSTERS) {
            foldedClusters = foldedClusters + 1
            k = k + 1
            continue
        }
        drawn = drawn + 1
        let nodes = match (g.get("nodes")) { case Some(v) => match (v) { case a: JsonArray => a; case _ => JsonArray() }; case None => JsonArray() }
        let folded = intOf(g, "folded")
        let c = JsonObject()
        c.put("id", JsonString(ids[k]))
        c.put("name", JsonString(names[k]))
        c.put("hue", JsonInt(hueOf(ids[k])))
        c.put("lastActiveAt", JsonString(acts[k]))
        c.put("chapterCount", JsonInt(nodes.size() + folded))
        c.put("folded", JsonInt(folded))
        c.put("readChunks", JsonInt(sumInt(nodes, "readCount")))
        c.put("wrongCount", JsonInt(sumInt(nodes, "wrong")))
        c.put("wrongDue", JsonInt(sumInt(nodes, "wrongDue")))
        c.put("artifactCount", JsonInt(countArtifacts(nodes)))
        let chapterArr = JsonArray()
        var n = 0
        while (n < nodes.size()) {
            match (objOf(nodes[n])) {
                case Some(o) => chapterArr.add(nebulaChapter(o))
                case None => ()
            }
            n = n + 1
        }
        match (g.get("edges")) {
            case Some(v) => c.put("edges", v)
            case None => c.put("edges", JsonArray())
        }
        clusterList.add(c)
        clusterNodes.add(chapterArr)
        readChunks = readChunks + sumInt(nodes, "readCount")
        wrongDue = wrongDue + sumInt(nodes, "wrongDue")
        artifactCount = artifactCount + countArtifacts(nodes)
        chaptersAll = chaptersAll + nodes.size() + folded
        k = k + 1
    }

    // 全局点数上限：按比例留前若干章（每个库至少留 1 章，不然那团星云就没了）
    var totalPoints: Int64 = 0
    var ci = 0
    while (ci < clusterNodes.size) {
        totalPoints = totalPoints + clusterNodes[ci].size()
        ci = ci + 1
    }
    ci = 0
    while (ci < clusterNodes.size) {
        let arr = clusterNodes[ci]
        if (totalPoints > NEBULA_MAX_POINTS && arr.size() > 1) {
            var keep = (NEBULA_MAX_POINTS * Int64(arr.size())) / totalPoints
            if (keep < 1) {
                keep = 1
            }
            if (keep < Int64(arr.size())) {
                let trimmed = JsonArray()
                var t = 0
                while (t < keep) {
                    trimmed.add(arr[t])
                    t = t + 1
                }
                let dropped = Int64(arr.size()) - keep
                clusterNodes[ci] = trimmed
                totalPoints = totalPoints - dropped
                let c = clusterList[ci]
                c.put("folded", JsonInt(intOf(c, "folded") + dropped))
                c.put("chapterCount", JsonInt(intOf(c, "chapterCount") - dropped))
            }
        }
        ci = ci + 1
    }

    let clusters = JsonArray()
    ci = 0
    while (ci < clusterList.size) {
        let c = clusterList[ci]
        c.put("chapters", clusterNodes[ci])
        clusters.add(c)
        ci = ci + 1
    }

    let core = JsonObject()
    core.put("clusters", JsonInt(drawn))
    core.put("chapters", JsonInt(chaptersAll))
    core.put("readChunks", JsonInt(readChunks))
    core.put("wrongDue", JsonInt(wrongDue))
    core.put("artifactCount", JsonInt(artifactCount))
    core.put("unformed", JsonInt(unformed.size()))

    let stats = JsonObject()
    stats.put("clusters", JsonInt(drawn))
    stats.put("drawnClusters", JsonInt(drawn))
    stats.put("unformedClusters", JsonInt(unformed.size()))
    stats.put("foldedClusters", JsonInt(foldedClusters))
    stats.put("points", JsonInt(totalPoints))
    stats.put("pointCap", JsonInt(NEBULA_MAX_POINTS))

    out.put("clusters", clusters)
    out.put("unformed", unformed)
    out.put("core", core)
    out.put("foldedClusters", JsonInt(foldedClusters))
    out.put("stats", stats)
    return out
}
