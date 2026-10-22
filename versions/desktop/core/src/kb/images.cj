package itn_desktop_core.kb

import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import stdx.encoding.base64.*
import itn_desktop_core.store.Store
import itn_desktop_core.util.*

func imageHex(b: UInt8): Int64 {
    if (b >= 48 && b <= 57) { return Int64(b - 48) }
    if (b >= 65 && b <= 70) { return Int64(b - 65 + 10) }
    if (b >= 97 && b <= 102) { return Int64(b - 97 + 10) }
    return -1
}

func imagePathDecode(path: String): String {
    let bytes = path.toArray()
    let out = ArrayList<UInt8>()
    var i = 0
    while (i < bytes.size) {
        if (bytes[i] == 37 && i + 2 < bytes.size) {
            let hi = imageHex(bytes[i + 1]); let lo = imageHex(bytes[i + 2])
            if (hi < 0 || lo < 0) { throw Exception("图片路径编码无效") }
            out.add(UInt8(hi * 16 + lo)); i += 3
        } else { out.add(bytes[i]); i += 1 }
    }
    return String.fromUtf8(out.toArray())
}

func imageRelative(path: String): String {
    let parts = ArrayList<String>()
    let decoded = imagePathDecode(path).replace("\\", "/")
    if (hasPrefix(decoded, "/")) { throw Exception("图片须使用资料库内的相对路径") }
    for (b in decoded.toArray()) { if (b < 32) { throw Exception("图片路径无效") } }
    for (part in decoded.split("/")) {
        if (part.size == 0 || part == ".") { continue }
        if (part == "..") {
            if (parts.size == 0) { throw Exception("图片路径超出知识库") }
            parts.remove(at: parts.size - 1)
        } else {
            if (part.contains(":")) { throw Exception("图片路径无效") }
            parts.add(part)
        }
    }
    return joinWith(parts, "/")
}

public func resolveKnowledgeImage(store: Store, kbId: String, docPath: String, source: String,
    includeData: Bool): JsonObject {
    let kb = store.load().findKb(kbId).getOrThrow()
    var known = false
    for (chunk in loadIndexCached(store.dataDir, kbId).chunks) { if (chunk.docPath == docPath) { known = true; break } }
    if (!known) { throw Exception("请从已准备的文档中读取图片") }
    var src = trimStr(source)
    if (hasPrefix(src, "//")) { src = "https:" + src }
    let remote = hasPrefix(src, "https://") || hasPrefix(src, "http://")
    let candidates = ArrayList<String>()
    if (remote) {
        // 仓库图片的 docs 路径能与导入目录对应时，优先使用离线配图。
        let raw = src.replace("https://github.com/", "https://raw.githubusercontent.com/").replace("/blob/", "/")
        if (hasPrefix(raw, "https://raw.githubusercontent.com/")) {
            let path = String.fromUtf8(raw.toArray()[34..]).split("?")[0].split("#")[0]
            let parts = path.split("/")
            let rootName = baseNameOf(kb.rootDir)
            var i = 3
            while (i < parts.size) {
                if (parts[i] == rootName && i + 1 < parts.size) {
                    let tail = ArrayList<String>()
                    var j = i + 1
                    while (j < parts.size) { tail.add(parts[j]); j += 1 }
                    candidates.add(imageRelative(joinWith(tail, "/")))
                    break
                }
                i += 1
            }
        }
    } else {
        let path = src.split("?")[0].split("#")[0]
        let doc = docPath.replace("\\", "/").split("/")
        let base = ArrayList<String>()
        var i = 0
        while (i + 1 < doc.size) { base.add(doc[i]); i += 1 }
        candidates.add(imageRelative(joinWith(base, "/") + (if (base.size > 0) { "/" } else { "" }) + path))
    }
    for (relative in candidates) {
        let ext = Path(relative).extensionName.toAsciiLower()
        if (!isAssetExt(ext)) { throw Exception("这不是支持的图片格式") }
        let full = kb.rootDir + Path.Separator + relative.replace("/", Path.Separator.toString())
        if (!exists(full)) { continue }
        let file = File(full, OpenMode.Read)
        let size = file.length
        file.close()
        if (size > 8 * 1024 * 1024) { throw Exception("图片超过 8 MB") }
        let mime = if (ext == "svg") { "image/svg+xml" } else if (ext == "jpg") { "image/jpeg" } else { "image/" + ext }
        let out = JsonObject()
        out.put("kind", JsonString("local"))
        out.put("source", JsonString(source))
        out.put("path", JsonString(full))
        out.put("bytes", JsonInt(size))
        out.put("mimeType", JsonString(mime))
        if (includeData) { out.put("dataUrl", JsonString("data:" + mime + ";base64," + toBase64String(File.readFrom(full)))) }
        return out
    }
    if (remote) {
        let out = JsonObject()
        out.put("kind", JsonString("remote"))
        out.put("source", JsonString(source))
        out.put("url", JsonString(src))
        return out
    }
    throw Exception("找不到这张资料配图")
}
