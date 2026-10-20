package zhixun_learning

import std.collection.*
import std.core.*
import std.fs.*
import soulsoft_web_http.*

/** Final assets live outside kb_work: cleaning the upload must not break Markdown images. */
func kbAssetRoot(): String { envOr("ZHIXUN_ASSET_ROOT", "data/kb_assets") }
func kbAssetBundleDir(bundleId: String): String { kbAssetRoot() + "/" + bundleId }
func kbAssetFile(bundleId: String, assetId: String): String { kbAssetBundleDir(bundleId) + "/" + assetId }

func kbImageSpace(byte: Byte): Bool { byte == 32 || byte == 9 || byte == 10 || byte == 13 }

/** URI decoding here deliberately preserves +, which is a valid filename character. */
func kbImageDecode(raw: String): String {
    let bytes = raw.toArray()
    let out = ArrayList<Byte>()
    var i: Int64 = 0
    while (i < bytes.size) {
        if (bytes[i] == 37 && i + 2 < bytes.size) {
            let h = kbImageHex(bytes[i + 1])
            let l = kbImageHex(bytes[i + 2])
            if (h >= 0 && l >= 0) {
                out.add(UInt8(h * 16 + l))
                i += 3
                continue
            }
        }
        if (bytes[i] == 92 && i + 1 < bytes.size &&
            (bytes[i + 1] == 32 || bytes[i + 1] == 40 || bytes[i + 1] == 41 ||
             bytes[i + 1] == 91 || bytes[i + 1] == 93 || bytes[i + 1] == 35)) {
            i += 1
        }
        out.add(bytes[i])
        i += 1
    }
    String.fromUtf8(out.toArray()).replace("&amp;", "&").replace("&#32;", " ").replace("&quot;", "\"")
}

func kbImageHex(byte: Byte): Int64 {
    if (byte >= 48 && byte <= 57) { return Int64(byte) - 48 }
    if (byte >= 65 && byte <= 70) { return Int64(byte) - 55 }
    if (byte >= 97 && byte <= 102) { return Int64(byte) - 87 }
    -1
}

/** Resolve ../ against the source document, while forbidding escape from the extracted root. */
func kbImageSourcePath(source: String, target: String): String {
    let raw = kbImageDecode(target).replace("\\", "/")
    if (raw.startsWith("/") || raw.contains(":")) { throw Exception("图片路径必须在资料包内") }
    let parts = ArrayList<String>()
    match (source.replace("\\", "/").lastIndexOf("/")) {
        case Some(position) =>
            for (part in source.replace("\\", "/")[0..position].split("/")) {
                if (part.size > 0 && part != ".") { parts.add(part) }
            }
        case None => ()
    }
    for (part in raw.split("/")) {
        if (part.size == 0 || part == ".") { continue }
        if (part == "..") {
            if (parts.size == 0) { throw Exception("图片路径越出资料包目录") }
            parts.remove(at: parts.size - 1)
        } else {
            for (byte in part.toArray()) {
                if (byte < 32 || byte == 127) { throw Exception("图片路径含控制字符") }
            }
            parts.add(part)
        }
    }
    let out = StringBuilder()
    var first = true
    for (part in parts) {
        if (!first) { out.append("/") }
        out.append(part)
        first = false
    }
    if (parts.size == 0) { throw Exception("图片路径为空") }
    out.toString()
}

func kbImageMime(path: String, data: Array<Byte>): String {
    if (data.size >= 8 && data[0] == 137 && data[1] == 80 && data[2] == 78 && data[3] == 71 &&
        data[4] == 13 && data[5] == 10 && data[6] == 26 && data[7] == 10) { return "image/png" }
    if (data.size >= 3 && data[0] == 255 && data[1] == 216 && data[2] == 255) { return "image/jpeg" }
    if (data.size >= 6 && data[0] == 71 && data[1] == 73 && data[2] == 70 && data[3] == 56) { return "image/gif" }
    if (data.size >= 12 && data[0] == 82 && data[1] == 73 && data[2] == 70 && data[3] == 70 &&
        data[8] == 87 && data[9] == 69 && data[10] == 66 && data[11] == 80) { return "image/webp" }
    if (data.size >= 2 && data[0] == 66 && data[1] == 77) { return "image/bmp" }
    if (data.size >= 4 && ((data[0] == 73 && data[1] == 73 && data[2] == 42 && data[3] == 0) ||
        (data[0] == 77 && data[1] == 77 && data[2] == 0 && data[3] == 42))) { return "image/tiff" }
    if (data.size >= 4 && data[0] == 0 && data[1] == 0 && data[2] == 1 && data[3] == 0) { return "image/x-icon" }
    if (data.size >= 12 && data[4] == 102 && data[5] == 116 && data[6] == 121 && data[7] == 112 &&
        data[8] == 97 && data[9] == 118 && data[10] == 105 && (data[11] == 102 || data[11] == 115)) { return "image/avif" }
    if (path.toAsciiLower().endsWith(".svg")) {
        let svg = String.fromUtf8(data).trimAscii().toAsciiLower()
        if (svg.contains("<svg") && svg.contains("</svg>")) { return "image/svg+xml" }
    }
    throw Exception("文件不是支持的图片格式")
}

class KbImageTarget {
    let start: Int64
    let end: Int64
    init(start: Int64, end: Int64) { this.start = start; this.end = end }
}

func kbImageLabel(text: String): String {
    var label = text.trimAscii().toAsciiLower().replace("\r", " ").replace("\n", " ").replace("\t", " ")
    while (label.contains("  ")) { label = label.replace("  ", " ") }
    label
}

func kbImageBracketEnd(bytes: Array<Byte>, start: Int64): Int64 {
    var depth: Int64 = 1
    var i = start + 1
    while (i < bytes.size) {
        if (bytes[i] == 92) { i += 2; continue }
        if (bytes[i] == 91) { depth += 1 }
        if (bytes[i] == 93) {
            depth -= 1
            if (depth == 0) { return i }
        }
        i += 1
    }
    -1
}

/** Strip an optional Markdown title without splitting normal filenames containing spaces. */
func kbImageDestination(bytes: Array<Byte>, start: Int64, end: Int64): ?KbImageTarget {
    var first = start
    var last = end
    while (first < last && kbImageSpace(bytes[first])) { first += 1 }
    while (last > first && kbImageSpace(bytes[last - 1])) { last -= 1 }
    if (first >= last) { return None }
    if (bytes[first] == 60) {
        var i = first + 1
        while (i < last && bytes[i] != 62) { i += 1 }
        if (i < last) { return Some(KbImageTarget(first + 1, i)) }
    }
    var i = first
    while (i + 1 < last) {
        if (bytes[i] == 92) { i += 2; continue }
        if (kbImageSpace(bytes[i])) {
            var next = i + 1
            while (next < last && kbImageSpace(bytes[next])) { next += 1 }
            if (next < last && ((bytes[next] == 34 && bytes[last - 1] == 34) ||
                (bytes[next] == 39 && bytes[last - 1] == 39) ||
                (bytes[next] == 40 && bytes[last - 1] == 41))) {
                return Some(KbImageTarget(first, i))
            }
        }
        i += 1
    }
    Some(KbImageTarget(first, last))
}

/** Collect only image destinations. Leave prose, alt text, titles, code and ordinary links intact. */
func kbImageTargets(text: String): ArrayList<KbImageTarget> {
    let bytes = text.toArray()
    let ignored = Array<Bool>(bytes.size, repeat: false)
    var fence: Byte = 0
    var fenceLength: Int64 = 0
    var line: Int64 = 0
    while (line < bytes.size) {
        var end = line
        while (end < bytes.size && bytes[end] != 10) { end += 1 }
        var first = line
        while (first < end && bytes[first] == 32 && first - line < 4) { first += 1 }
        var run: Int64 = 0
        if (first < end && (bytes[first] == 96 || bytes[first] == 126)) {
            while (first + run < end && bytes[first + run] == bytes[first]) { run += 1 }
        }
        let wasFenced = fence != 0
        if (run >= 3) {
            if (fence == 0) { fence = bytes[first]; fenceLength = run }
            else if (bytes[first] == fence && run >= fenceLength) { fence = 0 }
        }
        if (wasFenced || fence != 0) {
            var mark = line
            while (mark < end) { ignored[mark] = true; mark += 1 }
        }
        line = end + 1
    }
    // Inline code can contain image examples and must stay byte-for-byte unchanged.
    var c: Int64 = 0
    while (c < bytes.size) {
        if (!ignored[c] && bytes[c] == 96 && (c == 0 || bytes[c - 1] != 92)) {
            var run: Int64 = 1
            while (c + run < bytes.size && bytes[c + run] == 96) { run += 1 }
            var close = c + run
            var found = false
            while (close < bytes.size && !found) {
                if (bytes[close] == 96) {
                    var count: Int64 = 1
                    while (close + count < bytes.size && bytes[close + count] == 96) { count += 1 }
                    if (count == run) { found = true } else { close += count }
                } else { close += 1 }
            }
            if (found) {
                var mark = c
                while (mark < close + run) { ignored[mark] = true; mark += 1 }
                c = close + run
                continue
            }
        }
        c += 1
    }
    let targets = ArrayList<KbImageTarget>()
    let references = HashSet<String>()
    var i: Int64 = 0
    while (i < bytes.size) {
        if (ignored[i] || bytes[i] == 92) { i += if (bytes[i] == 92) { 2 } else { 1 }; continue }
        if (bytes[i] == 33 && i + 1 < bytes.size && bytes[i + 1] == 91) {
            let altEnd = kbImageBracketEnd(bytes, i + 1)
            if (altEnd < 0) { i += 1; continue }
            var next = altEnd + 1
            if (next < bytes.size && bytes[next] == 40) {
                var end = next + 1
                var depth: Int64 = 1
                var angle = false
                while (end < bytes.size) {
                    if (bytes[end] == 92) { end += 2; continue }
                    if (bytes[end] == 60) { angle = true }
                    if (bytes[end] == 62) { angle = false }
                    if (!angle && bytes[end] == 40) { depth += 1 }
                    if (!angle && bytes[end] == 41) { depth -= 1; if (depth == 0) { break } }
                    end += 1
                }
                if (end < bytes.size) {
                    match (kbImageDestination(bytes, next + 1, end)) {
                        case Some(target) => targets.add(target)
                        case None => ()
                    }
                    i = end + 1
                    continue
                }
            } else {
                while (next < bytes.size && kbImageSpace(bytes[next])) { next += 1 }
                var label = text[i + 2..altEnd]
                if (next < bytes.size && bytes[next] == 91) {
                    let refEnd = kbImageBracketEnd(bytes, next)
                    if (refEnd >= 0 && refEnd > next + 1) { label = text[next + 1..refEnd] }
                }
                references.add(kbImageLabel(label))
            }
            i = altEnd + 1
            continue
        }
        // HTML <img src="...">, including single-quoted and unquoted values.
        if (bytes[i] == 60 && i + 4 < bytes.size && (bytes[i + 1] == 105 || bytes[i + 1] == 73) &&
            (bytes[i + 2] == 109 || bytes[i + 2] == 77) && (bytes[i + 3] == 103 || bytes[i + 3] == 71) &&
            (kbImageSpace(bytes[i + 4]) || bytes[i + 4] == 62)) {
            var p = i + 4
            while (p < bytes.size && bytes[p] != 62) {
                while (p < bytes.size && kbImageSpace(bytes[p])) { p += 1 }
                let nameStart = p
                while (p < bytes.size && bytes[p] != 61 && bytes[p] != 62 && !kbImageSpace(bytes[p])) { p += 1 }
                let name = text[nameStart..p].toAsciiLower()
                while (p < bytes.size && kbImageSpace(bytes[p])) { p += 1 }
                if (p >= bytes.size || bytes[p] == 62) { break }
                if (bytes[p] != 61) { p += 1; continue }
                p += 1
                while (p < bytes.size && kbImageSpace(bytes[p])) { p += 1 }
                if (p >= bytes.size) { break }
                let quoteByte: Byte = if (bytes[p] == 34 || bytes[p] == 39) { bytes[p] } else { 0 }
                if (quoteByte != 0) { p += 1 }
                let valueStart = p
                while (p < bytes.size && (if (quoteByte != 0) { bytes[p] != quoteByte } else { !kbImageSpace(bytes[p]) && bytes[p] != 62 })) { p += 1 }
                if (name == "src" && p > valueStart) { targets.add(KbImageTarget(valueStart, p)) }
                if (quoteByte != 0 && p < bytes.size) { p += 1 }
            }
            i = p + 1
            continue
        }
        i += 1
    }
    // Reference definitions are rewritten only if an image actually uses the label.
    line = 0
    while (line < bytes.size) {
        var end = line
        while (end < bytes.size && bytes[end] != 10) { end += 1 }
        var first = line
        while (first < end && bytes[first] == 32 && first - line < 4) { first += 1 }
        if (first < end && !ignored[first] && bytes[first] == 91) {
            let close = kbImageBracketEnd(bytes, first)
            if (close > first && close + 1 < end && bytes[close + 1] == 58 &&
                references.contains(kbImageLabel(text[first + 1..close]))) {
                match (kbImageDestination(bytes, close + 2, end)) {
                    case Some(target) => targets.add(target)
                    case None => ()
                }
            }
        }
        line = end + 1
    }
    // Insertion sort keeps the formatter independent of compiler comparator extensions.
    var n: Int64 = 1
    while (n < targets.size) {
        var j = n
        while (j > 0 && targets[j].start < targets[j - 1].start) {
            let swap = targets[j - 1]
            targets[j - 1] = targets[j]
            targets[j] = swap
            j -= 1
        }
        n += 1
    }
    targets
}

class KbAssetFinalizer {
    let cfg: Config
    let bundleId: String
    let inputDir: String
    let log: KbAgentLog
    let saved = HashMap<String, String>()
    let warned = HashSet<String>()
    let warnings = ArrayList<String>()
    let deferMetadata: Bool
    let metadataRows = ArrayList<String>()

    init(cfg: Config, bundleId: String, inputDir: String, log: KbAgentLog) {
        this.cfg = cfg; this.bundleId = bundleId; this.inputDir = inputDir; this.log = log
        this.deferMetadata = false
    }

    init(cfg: Config, bundleId: String, inputDir: String, log: KbAgentLog, deferMetadata: Bool) {
        this.cfg = cfg; this.bundleId = bundleId; this.inputDir = inputDir; this.log = log
        this.deferMetadata = deferMetadata
    }

    func flushMetadata(): Unit {
        if (metadataRows.size == 0) { return }
        var rows = ""
        for (row in metadataRows) { if (rows.size > 0) { rows += "," }; rows += row }
        transaction(cfg, ["INSERT INTO kb_bundle_assets(id,bundle_id,source_path,mime_type,byte_size) VALUES " + rows])
        metadataRows.clear()
    }

    func warning(message: String): Unit {
        if (!warned.contains(message)) {
            warned.add(message)
            warnings.add(message)
            log.add("[图片警告] " + message)
        }
    }

    func imageUrl(sourcePath: String, target: String): String {
        let lower = target.trimAscii().toAsciiLower()
        if (lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("//") || lower.startsWith("data:image/")) { return target }
        if (lower.startsWith("/api/admin/kb/bundles/")) { return target }
        if (sourcePath.size == 0) { warning("找不到原文路径，无法定位图片：" + target); return target }
        try {
            var local = target
            match (local.indexOf("#")) { case Some(pos) => local = local[0..pos]; case None => () }
            match (local.indexOf("?")) { case Some(pos) => local = local[0..pos]; case None => () }
            let relative = kbImageSourcePath(sourcePath, local)
            match (saved.get(relative)) { case Some(url) => return url; case None => () }
            let full = inputDir + "/" + relative
            if (!exists(Path(full))) { throw Exception("包内文件不存在") }
            let data = File.readFrom(Path(full))
            if (data.size == 0 || data.size > 20 * 1024 * 1024) { throw Exception("图片为空或超过 20MB") }
            let mime = kbImageMime(relative, data)
            let assetId = uuidFormat(uuidV4())
            kbWriteFileDeep(kbAssetFile(bundleId, assetId), data)
            let metadata = "(" + sqlQuote(assetId) + "," + sqlQuote(bundleId) + "," + sqlQuote(relative) + "," + sqlQuote(mime) + "," + data.size.toString() + ")"
            try {
                if (deferMetadata) { metadataRows.add(metadata) }
                else { execute(cfg, "INSERT INTO kb_bundle_assets(id,bundle_id,source_path,mime_type,byte_size) VALUES " + metadata) }
            } catch (error: Exception) {
                try { remove(Path(kbAssetFile(bundleId, assetId))) } catch (_: Exception) {}
                throw error
            }
            let url = "/api/admin/kb/bundles/" + bundleId + "/assets/" + assetId
            saved[relative] = url
            return url
        } catch (error: Exception) {
            warning(sourcePath + " → " + target + "：" + error.message)
            target
        }
    }

    func document(sourcePath: String, content: String): String {
        let targets = kbImageTargets(content)
        let out = StringBuilder()
        var cursor: Int64 = 0
        for (target in targets) {
            if (target.start < cursor) { continue }
            out.append(content[cursor..target.start])
            out.append(imageUrl(sourcePath, content[target.start..target.end]))
            cursor = target.end
        }
        out.append(content[cursor..content.size])
        out.toString()
    }
}

/** Called only after adminUserId succeeds; lookup also prevents cross-bundle asset access. */
func kbWriteBundleAsset(response: HttpResponse, cfg: Config, bundleId: String, assetId: String): Unit {
    let rows = query(cfg, "SELECT mime_type,byte_size FROM kb_bundle_assets WHERE bundle_id=" +
        sqlQuote(bundleId) + " AND id=" + sqlQuote(assetId) + " LIMIT 1")
    if (rows.size == 0) { writeError(response, 404, "没有找到这张图片"); return }
    let path = kbAssetFile(bundleId, assetId)
    if (!exists(Path(path))) { writeError(response, 404, "图片文件已丢失，请重新导入资料包"); return }
    let data = File.readFrom(Path(path))
    response.statusCode = 200
    response.contentType = rows[0].text("mime_type")
    response.contentLength = data.size
    response.headers.add("X-Content-Type-Options", "nosniff")
    response.headers.add("Cache-Control", "private, max-age=3600")
    response.headers.add("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
    response.write(data)
}
