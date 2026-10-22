package itn_spire

import std.core.*
import std.collection.*
import std.convert.*

/*
 * Deterministic knowledge-category matching, ported from
 * src/agents/app/storage/learning_resources.py
 *   knowledge_point_candidates / match_knowledge_category / _category_similarity
 * It is keyword + token overlap scoring (not an LLM call), so Spire owns it.
 */
public struct KnowledgeMatch {
    public let id: Int64
    public let name: String
    public let description: String
    public let path: String
    public let confidence: Float64

    public init(id: Int64, name: String, description: String, path: String, confidence: Float64) {
        this.id = id
        this.name = name
        this.description = description
        this.path = path
        this.confidence = confidence
    }
}

public class KnowledgeMatcher {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    public func candidates(topic: String, limit: Int64): Array<KnowledgeMatch> {
        let terms = extractTerms(topic)
        if (terms.isEmpty()) {
            return Array<KnowledgeMatch>(0, repeat: KnowledgeMatch(0, "", "", "", 0.0))
        }
        var clauses = ""
        var first = true
        /* knowledge_category columns are utf8mb4_unicode_ci; coerce literals the same
         * way so 4-byte runes do not raise "Illegal mix of collations". */
        for (term in terms) {
            if (!first) {
                clauses = clauses + " OR "
            }
            first = false
            let lit = "CONVERT(" + sqlQuote("%" + term + "%") + " USING utf8mb4) COLLATE utf8mb4_unicode_ci"
            clauses = clauses + "(CONVERT(kc.name USING utf8mb4) COLLATE utf8mb4_unicode_ci LIKE " + lit +
                " OR CONVERT(COALESCE(kc.full_path,'') USING utf8mb4) COLLATE utf8mb4_unicode_ci LIKE " + lit + ")"
        }
        let topicLit = "CONVERT(" + sqlQuote(topic.trimAscii()) + " USING utf8mb4) COLLATE utf8mb4_unicode_ci"
        let sql = "SELECT kc.id,kc.name,kc.description,COALESCE(NULLIF(kc.full_path,''), " +
            "CONCAT_WS(' / ',root.name,parent.name,kc.name)) AS full_path " +
            "FROM knowledge_category kc " +
            "LEFT JOIN knowledge_category parent ON parent.id=kc.parent_id " +
            "LEFT JOIN knowledge_category root ON root.id=parent.parent_id " +
            "WHERE kc.status=1 AND (" + clauses + ") " +
            "ORDER BY (CONVERT(kc.name USING utf8mb4) COLLATE utf8mb4_unicode_ci=" + topicLit + ") DESC," +
            "(kc.node_type='knowledge_point') DESC,kc.level DESC LIMIT " + limit.toString()
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<KnowledgeMatch>(0, repeat: KnowledgeMatch(0, "", "", "", 0.0))
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<KnowledgeMatch>()
                for (row in rs.rows) {
                    if (row.size < 4) {
                        continue
                    }
                    let id = Int64.tryParse(row[0].text()) ?? 0
                    let name = row[1].text()
                    let description = row[2].text()
                    let path = row[3].text()
                    out.add(KnowledgeMatch(id, name, description, path, 0.0))
                }
                return out.toArray()
        }
    }

    public func findMatch(text: String): ?KnowledgeMatch {
        let pool = candidates(text, 40)
        if (pool.isEmpty()) {
            return None
        }
        var best: ?KnowledgeMatch = None
        var bestScore = 0.0
        for (item in pool) {
            let score = similarity(text, item.name + " " + item.description + " " + item.path)
            if (score > bestScore) {
                bestScore = score
                best = Some(KnowledgeMatch(item.id, item.name, item.description, item.path,
                    round3(if (score > 1.0) { 1.0 } else { score })))
            }
        }
        if (bestScore < 0.05) {
            return None
        }
        return best
    }
}

public func extractTerms(topic: String): Array<String> {
    let out = ArrayList<String>()
    var current = ""
    var currentIsAscii = false
    var hasCurrent = false
    for (ch in topic.toAsciiLower().runes()) {
        let cOpt = ch.toString().toArray()
        var code: Int64 = 0
        if (cOpt.size > 0) {
            code = Int64(cOpt[0])
        }
        let isAsciiAlpha = (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
            code == 43 || code == 46 || code == 35 || code == 45
        /* CJK Unified Ideographs: U+4E00..U+9FFF */
        let isCjk = code >= 0x4e00 && code <= 0x9fff
        if (isAsciiAlpha) {
            if (hasCurrent && !currentIsAscii) {
                pushTerm(out, current)
                current = ""
            }
            current = current + ch.toString()
            currentIsAscii = true
            hasCurrent = true
        } else if (isCjk) {
            if (hasCurrent && currentIsAscii) {
                pushTerm(out, current)
                current = ""
            }
            current = current + ch.toString()
            currentIsAscii = false
            hasCurrent = true
        } else {
            if (hasCurrent) {
                pushTerm(out, current)
                current = ""
                hasCurrent = false
                currentIsAscii = false
            }
        }
    }
    if (hasCurrent) {
        pushTerm(out, current)
    }
    /* de-dup preserving order, max 8 */
    let seen = HashSet<String>()
    let result = ArrayList<String>()
    for (t in out.toArray()) {
        if (charCount(t) < 2) {
            continue
        }
        if (seen.contains(t)) {
            continue
        }
        seen.add(t)
        result.add(t)
        if (result.size >= 8) {
            break
        }
    }
    return result.toArray()
}

private func pushTerm(out: ArrayList<String>, term: String): Unit {
    if (charCount(term) >= 2) {
        out.add(term)
    }
}

public func similarity(left: String, right: String): Float64 {
    let lt = tokenSet(left)
    let rt = tokenSet(right)
    if (lt.isEmpty() || rt.isEmpty()) {
        return 0.0
    }
    var shared: Int64 = 0
    for (t in lt) {
        if (rt.contains(t)) {
            shared += 1
        }
    }
    var union: Int64 = 0
    let all = HashSet<String>()
    for (t in lt) {
        all.add(t)
    }
    for (t in rt) {
        all.add(t)
    }
    union = all.size
    let semantic = semanticSet()
    var semanticHits = 0
    for (t in lt) {
        if (rt.contains(t) && semantic.contains(t)) {
            semanticHits += 1
        }
    }
    let sharedF = int64ToFloat64(shared)
    let unionF = int64ToFloat64(union)
    let hitsF = int64ToFloat64(semanticHits)
    return sharedF / unionF + 0.18 * hitsF
}

private func int64ToFloat64(v: Int64): Float64 {
    /* Int64 -> Float64 via string parse to avoid Option-returning casts. */
    match (Float64.tryParse(v.toString())) {
        case Some(f) => return f
        case None => return 0.0
    }
}

private func tokenSet(value: String): HashSet<String> {
    let lowered = value.toAsciiLower()
    let english = HashSet<String>()
    var current = ""
    for (ch in lowered.runes()) {
        let cOpt = ch.toString().toArray()
        var code: Int64 = 0
        if (cOpt.size > 0) {
            code = Int64(cOpt[0])
        }
        let isAsciiAlpha = (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
            code == 43 || code == 46 || code == 35 || code == 45
        if (isAsciiAlpha) {
            current = current + ch.toString()
        } else {
            if (current.size > 0) {
                english.add(current)
                current = ""
            }
        }
    }
    if (current.size > 0) {
        english.add(current)
    }
    /* compact chinese/latin run without punctuation */
    var compact = ""
    for (ch in lowered.runes()) {
        let cOpt = ch.toString().toArray()
        var code: Int64 = 0
        if (cOpt.size > 0) {
            code = Int64(cOpt[0])
        }
        if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
            (code >= 0x4e00 && code <= 0x9fff)) {
            compact = compact + ch.toString()
        }
    }
    if (compact.size > 0) {
        english.add(compact)
    }
    /* alias folding for a few semantic families used by the Python scorer */
    let aliases = semanticAliases()
    let out = HashSet<String>()
    for (t in english) {
        out.add(t)
        for (entry in aliases) {
            if (entry.value.contains(t)) {
                out.add(entry.key)
            }
        }
    }
    return out
}

private struct AliasEntry {
    public let key: String
    public let value: Array<String>
    public init(key: String, value: Array<String>) {
        this.key = key
        this.value = value
    }
}

private func semanticAliases(): Array<AliasEntry> {
    let out = ArrayList<AliasEntry>()
    out.add(AliasEntry("functioncall", ["functioncall", "functioncalling", "函数调用", "工具函数"]))
    out.add(AliasEntry("toolcall", ["toolcall", "工具调用"]))
    out.add(AliasEntry("jsonschema", ["jsonschema", "参数定义", "参数模式"]))
    out.add(AliasEntry("parameter", ["parameter", "参数"]))
    out.add(AliasEntry("errorhandling", ["errorhandling", "错误处理", "异常处理"]))
    out.add(AliasEntry("workflow", ["workflow", "工作流"]))
    out.add(AliasEntry("mcp", ["mcp", "模型上下文协议"]))
    out.add(AliasEntry("protocol", ["protocol", "协议"]))
    return out.toArray()
}

private func semanticSet(): HashSet<String> {
    let s = HashSet<String>()
    s.add("functioncall")
    s.add("toolcall")
    s.add("jsonschema")
    s.add("parameter")
    s.add("errorhandling")
    s.add("workflow")
    s.add("mcp")
    s.add("protocol")
    return s
}

private func round3(v: Float64): Float64 {
    /* Round to 3 decimal places using integer arithmetic. */
    let scaled = (v * 1000.0) + 0.5
    let asStr = scaled.toString()
    let dot = asStr.indexOf(".")
    match (dot) {
        case Some(d) =>
            let intPart = asStr[0..d]
            match (Int64.tryParse(intPart)) {
                case Some(i) =>
                    match (i as Float64) {
                        case Some(f) => return f / 1000.0
                        case None => return v
                    }
                case None => return v
            }
        case None => return v
    }
}
