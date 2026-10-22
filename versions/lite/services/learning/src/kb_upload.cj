package zhixun_learning

import std.collection.*
import std.core.*
import std.convert.*
import stdx.crypto.digest.*
import std.fs.*
import std.io.*
import soulsoft_web_http.*

class KbReceivedZip {
    let size: Int64
    let hash: String
    init(size: Int64, hash: String) { this.size = size; this.hash = hash }
}

/** Streaming upload: do not build a 160MB ArrayList<Byte> on the HTTP thread. */
func kbReceiveBundleUpload(request: HttpRequest, bundleId: String): KbReceivedZip {
    let limit: Int64 = 256 * 1024 * 1024
    let declared = Int64.tryParse(request.headers.get("Content-Length") ?? "") ?? -1
    if (declared > limit) { throw Exception("压缩包不要超过256MB") }
    let cfg = loadConfig()
    let path = kbBundleZipPath(cfg, bundleId)
    let output = File(Path(path), OpenMode.Write)
    let hash = SHA256()
    let buffer = Array<Byte>(65536, repeat: 0)
    var size: Int64 = 0
    var complete = false
    try {
        while (true) {
            let count = request.body.read(buffer)
            if (count <= 0) { break }
            size += count
            if (size > limit) { throw Exception("压缩包不要超过256MB") }
            let part = buffer.slice(0, count)
            output.write(part)
            hash.write(part)
        }
        if (declared >= 0 && declared != size) { throw Exception("上传没有完成，请重新上传") }
        if (size < 22) { throw Exception("压缩包为空或不是有效的ZIP") }
        complete = true
        KbReceivedZip(size, bytesToHex(hash.finish()))
    } finally {
        output.close()
        if (!complete) { try { remove(Path(path)) } catch (_: Exception) {} }
    }
}
