package itn_desktop_core.harvest

import std.collection.*
import std.fs.*
import std.random.*
import std.sync.*
import std.time.*
import stdx.encoding.json.*
import stdx.encoding.base64.*
import stdx.net.http.*
import stdx.net.tls.*
import stdx.net.tls.common.*
import itn_desktop_core.util.*
import itn_desktop_core.store.*
import itn_desktop_core.kb.*
import itn_desktop_core.tools.*

// Sources are immutable snapshots. Only the UI ingest endpoint can promote them;
// model tools never receive a confirmation flag that could bypass the user.
let harvestLock = Mutex()

func rootOf(dataDir: String): String { return dataDir + Path.Separator + "staging" }
func validId(id: String): Bool {
    if (id.size == 0 || id.size > 80) { return false }
    for (c in id.toArray()) {
        if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 122) || c == 45)) { return false }
    }
    return true
}
func dirOf(dataDir: String, id: String): String {
    if (!validId(id)) { throw Exception("来源 id 无效") }
    return rootOf(dataDir) + Path.Separator + id
}
func manifestPath(dir: String): String { return dir + Path.Separator + ".source.json" }
func readSource(dataDir: String, id: String): JsonObject {
    let path = manifestPath(dirOf(dataDir, id))
    if (!exists(path)) { throw Exception("找不到这个来源") }
    return match (objOf(JsonValue.fromStr(readTextOr(path, "")))) {
        case Some(o) => o
        case None => throw Exception("来源记录损坏，未修改知识库")
    }
}
func arrayOf(o: JsonObject, key: String): JsonArray {
    return match (o.get(key)) {
        case Some(a: JsonArray) => a
        case _ => JsonArray()
    }
}
public func harvestSources(dataDir: String): JsonArray {
    let a = JsonArray()
    let root = rootOf(dataDir)
    if (!exists(root)) { return a }
    Directory.walk(Path(root), { f: FileInfo =>
        if (f.isDirectory() && validId(f.name)) {
            try { a.add(readSource(dataDir, f.name)) } catch (e: Exception) { () }
        }
        true
    })
    return a
}
func encode(s: String): String {
    let digits = "0123456789ABCDEF".toArray()
    let b = StringBuilder()
    for (c in s.toArray()) {
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 45 || c == 46 || c == 95) {
            b.append(String.fromUtf8([c]))
        } else {
            b.append("%" + String.fromUtf8([digits[Int64(c) / 16], digits[Int64(c) % 16]]))
        }
    }
    return b.toString()
}
public func harvestPathAllowed(path: String): Bool {
    if (path.size == 0 || hasPrefix(path, "/") || path.contains("\\") || path.contains(":")) { return false }
    for (p in path.split("/")) {
        if (p.size == 0 || hasPrefix(p, ".") || p == "node_modules" || p == "dist" || p == "target") { return false }
    }
    return isTextDocExt(Path(path).extensionName.toAsciiLower())
}
func githubJson(dataDir: String, suffix: String): JsonObject {
    if (!webHostAllowed(dataDir, "api.github.com")) { throw Exception(webHostDenyReason(dataDir, "api.github.com")) }
    var tls = TlsClientConfig()
    tls.serverName = Some("api.github.com")
    tls.supportedAlpnProtocols = ["http/1.1"]
    let client = ClientBuilder().tlsConfig(tls).readTimeout(Duration.second * 30).build()
    try {
        let req = HttpRequestBuilder().method("GET").url("https://api.github.com/repos/" + suffix)
            .header("User-Agent", "ITN-Desktop").header("Accept", "application/vnd.github+json").build()
        let resp = client.send(req)
        if (resp.status != 200) { throw Exception("GitHub 返回 " + resp.status.toString() + "，未并入任何资料") }
        let bytes = ArrayList<UInt8>()
        let buf = Array<UInt8>(8192, repeat: 0)
        while (true) {
            let n = resp.body.read(buf)
            if (n == 0) { break }
            if (bytes.size + n > 8 * 1024 * 1024) { throw Exception("GitHub 响应超过8MB，请选更小的仓库") }
            for (i in 0..n) { bytes.add(buf[i]) }
        }
        return match (objOf(JsonValue.fromStr(String.fromUtf8(bytes.toArray())))) {
            case Some(o) => o
            case None => throw Exception("GitHub 返回的不是可用 JSON")
        }
    } finally { client.close() }
}
func putFile(dir: String, path: String, bytes: Array<UInt8>, files: JsonArray): Unit {
    if (!harvestPathAllowed(path) || bytes.size > 4 * 1024 * 1024) { throw Exception("文件路径或大小超出收集范围") }
    // Require valid UTF-8; binary files must not silently become indexed text.
    let _text = String.fromUtf8(bytes)
    let dest = dir + Path.Separator + toOsPath(path)
    ensureDir(parentDirOf(dest))
    File.writeTo(dest, bytes)
    let f = JsonObject()
    f.put("path", JsonString(path))
    f.put("bytes", JsonInt(bytes.size))
    files.add(f)
}
public func harvestStage(dataDir: String, kind: String, urlIn: String, refIn: String): JsonObject {
    if (kind != "url" && kind != "repo") { throw Exception("来源类型只能是 url 或 repo") }
    let id = "source-" + Random().nextUInt64().toString()
    let dir = dirOf(dataDir, id)
    let o = JsonObject()
    o.put("id", JsonString(id))
    o.put("kind", JsonString(kind))
    o.put("url", JsonString(trimStr(urlIn)))
    o.put("ref", JsonString(""))
    o.put("commit", JsonString(""))
    o.put("fetchedAt", JsonString(stamp()))
    o.put("kbId", JsonString(""))
    o.put("status", JsonString("staged"))
    let files = JsonArray()
    var skipped: Int64 = 0
    ensureDir(dir)
    if (kind == "url") {
        let page = fetchPage(dataDir, trimStr(urlIn))
        o.put("title", JsonString(strOf(page, "title")))
        // fetchPage.text is prompt-truncated. Stage the full persisted page instead.
        let bytes = File.readFrom(strOf(page, "path"))
        putFile(dir, "page.md", bytes, files)
    } else {
        var spec = trimStr(urlIn)
        if (hasPrefix(spec, "https://github.com/")) { spec = spec[19..spec.size] }
        if (hasSuffix(spec, ".git")) { spec = spec[0..spec.size - 4] }
        let parts = spec.split("/")
        if (parts.size != 2 || !validId(parts[0].toAsciiLower().replace("_", "-")) ||
            !validId(parts[1].toAsciiLower().replace("_", "-").replace(".", "-"))) {
            throw Exception("仓库请写 owner/repo 或 https://github.com/owner/repo，分支单独填写")
        }
        let info = githubJson(dataDir, spec)
        let ref = if (refIn.size > 0) { refIn } else { strOf(info, "default_branch") }
        // Resolve a COMMIT, not a tree SHA, then pin all downloads to that commit.
        let revision = githubJson(dataDir, spec + "/commits/" + encode(ref))
        let commit = strOf(revision, "sha")
        if (commit.size != 40) { throw Exception("未取得完整 commit，不能登记为可追溯来源") }
        let tree = githubJson(dataDir, spec + "/git/trees/" + commit + "?recursive=1")
        if (boolOf(tree, "truncated")) { throw Exception("仓库文件树被截断，请选择更小的仓库或改用本地文件夹导入") }
        o.put("url", JsonString("https://github.com/" + spec))
        o.put("title", JsonString(spec))
        o.put("ref", JsonString(ref))
        o.put("commit", JsonString(commit))
        let entries = arrayOf(tree, "tree")
        var total: Int64 = 0
        for (i in 0..entries.size()) {
            let v = entries[i]
            match (objOf(v)) {
                case Some(f) =>
                    if (strOf(f, "type") != "blob") { continue }
                    let path = strOf(f, "path")
                    let size = intOf(f, "size")
                    if (!harvestPathAllowed(path) || size > 4 * 1024 * 1024 || files.size() >= 300 || total + size > 32 * 1024 * 1024) {
                        skipped = skipped + 1
                        continue
                    }
                    // Blob API avoids mutable branch races and contents API's 1 MB inline limit.
                    let blob = githubJson(dataDir, spec + "/git/blobs/" + strOf(f, "sha"))
                    let b64 = strOf(blob, "content").replace("\n", "").replace("\r", "")
                    match (fromBase64String(b64)) {
                        case Some(bytes) =>
                            putFile(dir, path, bytes, files)
                            total = total + Int64(bytes.size)
                        case None => throw Exception("GitHub 文件编码无效，暂存未完成")
                    }
                case None => ()
            }
        }
    }
    if (files.size() == 0) { throw Exception("没有取得可读文本，未并入任何资料") }
    o.put("files", files)
    o.put("skipped", JsonInt(skipped))
    o.put("requiresConfirmation", JsonBool(true))
    writeText(manifestPath(dir), o.toString())
    return o
}
public func harvestPreview(dataDir: String, id: String, path: String): JsonObject {
    let o = readSource(dataDir, id)
    let files = arrayOf(o, "files")
    for (i in 0..files.size()) {
        let v = files[i]
        match (objOf(v)) {
            case Some(f) =>
                if (strOf(f, "path") == path && harvestPathAllowed(path)) {
                    let r = JsonObject()
                    r.put("text", JsonString(byteSafePrefix(readTextOr(dirOf(dataDir, id) + Path.Separator + toOsPath(path), ""), 20000)))
                    return r
                }
            case None => ()
        }
    }
    throw Exception("来源里没有这个文件")
}
public func harvestIngest(store: Store, kbId: String, id: String): JsonObject {
    synchronized(harvestLock) {
        let o = readSource(store.dataDir, id)
        if (strOf(o, "status") != "staged") { throw Exception("这份来源已处理，请勿重复并入") }
        let kb = match (store.load().findKb(kbId)) {
            case Some(k) => k
            case None => throw Exception("请先选择要并入的知识库")
        }
        if (kb.rootDir.size == 0) { throw Exception("知识库没有资料目录") }
        let dest = kb.rootDir + Path.Separator + "sources" + Path.Separator + id
        if (exists(dest)) { throw Exception("目标已存在，未覆盖；请检查上次并入结果") }
        let files = arrayOf(o, "files")
        // Validate every file before writing to the registered knowledge-base directory.
        for (i in 0..files.size()) {
            let v = files[i]
            let f = match (objOf(v)) { case Some(x) => x; case None => throw Exception("文件清单无效") }
            let path = strOf(f, "path")
            if (!harvestPathAllowed(path) || !exists(dirOf(store.dataDir, id) + Path.Separator + toOsPath(path))) { throw Exception("暂存文件缺失或路径无效") }
        }
        ensureDir(dest)
        for (i in 0..files.size()) {
            let v = files[i]
            match (objOf(v)) {
                case Some(f) =>
                    let path = strOf(f, "path")
                    let to = dest + Path.Separator + toOsPath(path)
                    ensureDir(parentDirOf(to))
                    File.writeTo(to, File.readFrom(dirOf(store.dataDir, id) + Path.Separator + toOsPath(path)))
                case None => ()
            }
        }
        o.put("kbId", JsonString(kbId))
        o.put("status", JsonString("ingested"))
        o.put("requiresConfirmation", JsonBool(false))
        o.put("dest", JsonString(dest))
        writeText(manifestPath(dest), o.toString())
        writeText(manifestPath(dirOf(store.dataDir, id)), o.toString())
        return o
    }
}
public func harvestDiscard(dataDir: String, id: String): JsonObject {
    synchronized(harvestLock) {
        let o = readSource(dataDir, id)
        if (strOf(o, "status") != "staged") { throw Exception("已并入的来源不能从暂存区移除") }
        // Logical discard preserves the immutable snapshot for audit; it never deletes user files.
        o.put("status", JsonString("discarded"))
        writeText(manifestPath(dirOf(dataDir, id)), o.toString())
        return o
    }
}
public func harvestRefetch(dataDir: String, id: String): JsonObject {
    let o = readSource(dataDir, id)
    return harvestStage(dataDir, strOf(o, "kind"), strOf(o, "url"), strOf(o, "ref"))
}
