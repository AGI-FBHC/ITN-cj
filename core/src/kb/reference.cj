package itn_desktop_core.kb

import std.collection.*
import std.fs.*
import std.env.*
import std.posix.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.store.Store
import itn_desktop_core.util.*

func referenceMissing(reason: String): JsonObject {
    let out = JsonObject()
    out.put("status", JsonString("missing"))
    out.put("reason", JsonString(reason))
    return out
}

/** Normalize relative index paths without interpreting URL escapes as filesystem syntax. */
func referenceRelative(path: String): ?String {
    let value = path.replace("\\", "/")
    if (value.size == 0 || hasPrefix(value, "/")) { return None }
    let parts = ArrayList<String>()
    for (part in value.split("/")) {
        if (part.size == 0 || part == ".") { continue }
        if (part == "..") {
            if (parts.size == 0) { return None }
            parts.remove(at: parts.size - 1)
            continue
        }
        // Windows strips trailing spaces/dots and treats colon as an alternate stream.
        if (hasSuffix(part, ".") || hasSuffix(part, " ")) { return None }
        for (b in part.toArray()) {
            if (b < 32 || b == 127 || b == 58 || b == 42 || b == 63 || b == 34 || b == 60 || b == 62 || b == 124) {
                return None
            }
        }
        let device = part.split(".")[0].toAsciiLower()
        if (device == "con" || device == "prn" || device == "aux" || device == "nul") { return None }
        for (n in ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
            if (device == "com" + n || device == "lpt" + n) { return None }
        }
        parts.add(part)
    }
    if (parts.size == 0) { return None }
    return Some(joinWith(parts, "/"))
}

func referencePathKey(path: String): String {
    let value = path.replace("\\", "/")
    return if (Path.Separator.toString() == "\\") { value.toAsciiLower() } else { value }
}

func referenceWithin(root: String, path: String): Bool {
    let key = referencePathKey(root)
    let child = referencePathKey(path)
    let prefix = if (hasSuffix(key, "/")) { key } else { key + "/" }
    return child == key || hasPrefix(child, prefix)
}

/** Resolve existing ancestors too: a linked directory must not escape the registered root. */
func referenceAbsolute(root: String, relative: String): ?String {
    if (trimStr(root).size == 0) { return None }
    try {
        let rootPath = Path(root)
        let absolute = if (rootPath.isAbsolute()) { rootPath } else { Path(getcwd().toString() + Path.Separator + root) }
        let normalized = absolute.normalize().toString()
        let base = if (exists(normalized)) { canonicalize(normalized).toString() } else { normalized }
        var full = base
        for (part in relative.split("/")) {
            full = full + Path.Separator + part
            if (exists(full)) { full = canonicalize(full).toString() }
            if (!referenceWithin(base, full)) { return None }
        }
        return Some(full)
    } catch (_: Exception) {
        return None
    }
}

func referenceId(kbId: String, docPath: String, chunkId: String): String {
    // Length prefixes make ids stable even when a filename contains a delimiter.
    return kbId.size.toString() + ":" + kbId + docPath.size.toString() + ":" + docPath +
        chunkId.size.toString() + ":" + chunkId
}

/** Read only registered index rows. In particular, do not trigger loadIndex's legacy import. */
public func resolveKnowledgeReference(store: Store, args: JsonObject): JsonObject {
    for (key in ["kbId", "docPath", "chunkId", "headingPath"]) {
        match (args.get(key)) {
            case Some(v) => match (v) { case value: JsonString => (); case _ => return referenceMissing("invalid_input") }
            case None => ()
        }
    }
    let kbId = strOf(args, "kbId")
    let docPath = strOf(args, "docPath")
    let chunkId = strOf(args, "chunkId")
    let headingPath = strOf(args, "headingPath")
    if (trimStr(docPath).size == 0 && trimStr(chunkId).size == 0) { return referenceMissing("invalid_input") }
    var relative = ""
    if (docPath.size > 0) {
        match (referenceRelative(docPath)) {
            case Some(path) => relative = path
            case None => return referenceMissing("unsafe_path")
        }
    }
    let db = DbHub.open(store.dataDir)
    if (kbId.size > 0 && db.scalarInt("SELECT COUNT(*) FROM knowledge_bases WHERE id = ?", va([tv(kbId)])) == 0) {
        return referenceMissing("unknown_kb")
    }
    var sql = "SELECT b.id, b.name, b.root_dir, c.chunk_key, c.doc_path, c.doc_title, c.heading_path, c.ord, c.text " +
        "FROM chunks c JOIN knowledge_bases b ON b.id = c.kb_id WHERE 1 = 1"
    let params = ArrayList<DbValue>()
    if (kbId.size > 0) { sql += " AND b.id = ?"; params.add(tv(kbId)) }
    if (relative.size > 0) {
        sql += " AND REPLACE(c.doc_path, ?, ?) = ?"
        params.add(tv("\\")); params.add(tv("/")); params.add(tv(relative))
    }
    if (chunkId.size > 0) { sql += " AND c.chunk_key = ?"; params.add(tv(chunkId)) }
    if (headingPath.size > 0) { sql += " AND c.heading_path = ?"; params.add(tv(headingPath)) }
    sql += " ORDER BY b.id, c.doc_path, c.ord, c.id"
    let candidates = ArrayList<JsonObject>()
    let seen = HashSet<String>()
    var foundText = ""
    var rejectedPath = false
    for (row in db.query(sql, params)) {
        let docKey = row.text(0).size.toString() + ":" + row.text(0) + row.text(4)
        if (seen.contains(docKey)) { continue }
        let safeRelative = referenceRelative(row.text(4))
        if (safeRelative.isNone()) { rejectedPath = true; continue }
        let absolute = referenceAbsolute(row.text(2), safeRelative.getOrThrow())
        if (absolute.isNone()) { rejectedPath = true; continue }
        let chunks = db.query("SELECT chunk_key FROM chunks WHERE kb_id = ? AND doc_path = ? ORDER BY ord, id",
            va([tv(row.text(0)), tv(row.text(4))]))
        var offset: Int64 = 0
        for (chunk in chunks) { if (chunk.text(0) == row.text(3)) { break }; offset += 1 }
        let candidate = JsonObject()
        candidate.put("referenceId", JsonString(referenceId(row.text(0), row.text(4), row.text(3))))
        candidate.put("kbId", JsonString(row.text(0)))
        candidate.put("kbName", JsonString(row.text(1)))
        candidate.put("docPath", JsonString(row.text(4)))
        candidate.put("docTitle", JsonString(row.text(5)))
        candidate.put("headingPath", JsonString(row.text(6)))
        candidate.put("chunkId", JsonString(row.text(3)))
        candidate.put("ordinal", JsonInt(row.int(7)))
        candidate.put("offset", JsonInt(offset))
        candidate.put("pageOffset", JsonInt((offset / 12) * 12))
        candidate.put("pageSize", JsonInt(12))
        candidate.put("totalChunks", JsonInt(chunks.size))
        candidate.put("absolutePath", JsonString(absolute.getOrThrow()))
        candidate.put("sourceExists", JsonBool(exists(absolute.getOrThrow())))
        seen.add(docKey)
        candidates.add(candidate)
        if (candidates.size == 1) { foundText = row.text(8) }
    }
    if (candidates.size == 0) {
        // Old citations often stored only a shortened heading. A known document can
        // still be opened, while an explicit stale chunk id must never be replaced.
        if (!rejectedPath && headingPath.size > 0 && chunkId.size == 0 && relative.size > 0) {
            let fallback = JsonObject()
            fallback.put("kbId", JsonString(kbId)); fallback.put("docPath", JsonString(relative))
            return resolveKnowledgeReference(store, fallback)
        }
        return referenceMissing(if (rejectedPath) { "unsafe_path" } else { "not_indexed" })
    }
    if (candidates.size == 1) {
        let out = candidates[0]
        out.put("status", JsonString("found"))
        out.put("text", JsonString(foundText))
        return out
    }
    let out = JsonObject()
    out.put("status", JsonString("ambiguous"))
    let choices = JsonArray()
    for (candidate in candidates) { choices.add(candidate) }
    out.put("candidates", choices)
    return out
}
