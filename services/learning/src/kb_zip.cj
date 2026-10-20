package zhixun_learning

import std.collection.*
import std.core.*
import std.io.*
import stdx.compress.zlib.*

/** zip 目录项。只支持 store(0) 与 deflate(8)，不支持 zip64 与加密。 */
class ZipEntry {
    let name: String
    let method: Int64
    let compressedSize: Int64
    let uncompressedSize: Int64
    let dataOffset: Int64

    init(name: String, method: Int64, compressedSize: Int64, uncompressedSize: Int64, dataOffset: Int64) {
        this.name = name
        this.method = method
        this.compressedSize = compressedSize
        this.uncompressedSize = uncompressedSize
        this.dataOffset = dataOffset
    }
}

func kbU16(bytes: Array<Byte>, offset: Int64): Int64 {
    if (offset + 1 >= bytes.size) { return -1 }
    Int64(bytes[offset]) + Int64(bytes[offset + 1]) * 256
}

func kbU32(bytes: Array<Byte>, offset: Int64): Int64 {
    if (offset + 3 >= bytes.size) { return -1 }
    Int64(bytes[offset]) + Int64(bytes[offset + 1]) * 256 + Int64(bytes[offset + 2]) * 65536 +
        Int64(bytes[offset + 3]) * 16777216
}

func kbUtf8(bytes: Array<Byte>, start: Int64, count: Int64): String {
    if (start < 0 || count <= 0 || start + count > bytes.size) { return "" }
    try {
        String.fromUtf8(bytes.slice(start, count))
    } catch (_: Exception) {
        // 非 UTF-8 文件名（例如 Windows 上用 GBK 打包）直接跳过，不让整包失败
        ""
    }
}

/** 列出 zip 内的文件项，跳过目录与系统垃圾文件。 */
func kbZipList(bytes: Array<Byte>): ArrayList<ZipEntry> {
    let out = ArrayList<ZipEntry>()
    if (bytes.size < 22) { throw Exception("压缩包太小，不是有效的 zip") }
    var eocd: Int64 = -1
    var i = bytes.size - 22
    let floor = if (bytes.size > 66560) { bytes.size - 66560 } else { 0 }
    while (i >= floor) {
        if (kbU32(bytes, i) == 0x06054b50) {
            eocd = i
            break
        }
        i -= 1
    }
    if (eocd < 0) { throw Exception("没有找到 zip 目录，可能是 zip64、rar 或损坏的文件") }
    let total = kbU16(bytes, eocd + 10)
    let dirOffset = kbU32(bytes, eocd + 16)
    if (total < 0 || dirOffset < 0) { throw Exception("zip 目录信息不完整") }

    var cursor = dirOffset
    var count: Int64 = 0
    while (count < total) {
        if (kbU32(bytes, cursor) != 0x02014b50) { break }
        let method = kbU16(bytes, cursor + 10)
        let compressed = kbU32(bytes, cursor + 20)
        let uncompressed = kbU32(bytes, cursor + 24)
        let nameLen = kbU16(bytes, cursor + 28)
        let extraLen = kbU16(bytes, cursor + 30)
        let commentLen = kbU16(bytes, cursor + 32)
        let localOffset = kbU32(bytes, cursor + 42)
        let name = kbUtf8(bytes, cursor + 46, nameLen)
        cursor = cursor + 46 + nameLen + extraLen + commentLen
        count += 1
        if (name.size == 0 || name.endsWith("/")) { continue }
        if (localOffset < 0 || compressed < 0) { continue }
        // 计算本地头之后真正的数据起点
        let localNameLen = kbU16(bytes, localOffset + 26)
        let localExtraLen = kbU16(bytes, localOffset + 28)
        if (localNameLen < 0 || localExtraLen < 0) { continue }
        let dataOffset = localOffset + 30 + localNameLen + localExtraLen
        out.add(ZipEntry(name, if (method < 0) { 0 } else { method }, compressed, uncompressed, dataOffset))
    }
    out
}

func kbInflateRaw(packed: Array<Byte>): Array<Byte> {
    let input = ByteBuffer()
    input.write(packed)
    let decoder = DecompressInputStream(input)
    let out = ArrayList<Byte>()
    let chunk = Array<Byte>(8192, repeat: 0)
    while (true) {
        let n = decoder.read(chunk)
        if (n <= 0) { break }
        var i: Int64 = 0
        while (i < n) {
            out.add(chunk[i])
            i += 1
        }
        if (out.size > 64 * 1024 * 1024) { throw Exception("单个文件解压后超过 64MB，已停止") }
    }
    out.toArray()
}

func kbZipExtract(bytes: Array<Byte>, entry: ZipEntry): Array<Byte> {
    let start = entry.dataOffset
    let size = entry.compressedSize
    if (start < 0 || size < 0 || start + size > bytes.size) {
        throw Exception("压缩包内条目越界：" + entry.name)
    }
    let payload = bytes.slice(start, size)
    if (entry.method == 0) { return payload }
    if (entry.method != 8) {
        throw Exception("不支持的压缩方式（" + entry.method.toString() + "）：" + entry.name)
    }
    kbInflateRaw(payload)
}

/** 解压到目标目录；拒绝绝对路径、.. 与超量文件。 */
func kbZipExtractAll(bytes: Array<Byte>, targetDir: String, maxFiles: Int64): Int64 {
    let entries = kbZipList(bytes)
    if (entries.size > maxFiles) { throw Exception("压缩包文件数超过 " + maxFiles.toString() + "，请拆分上传，未截断处理") }
    var written: Int64 = 0
    var totalBytes: Int64 = 0
    for (entry in entries) {
        let name = entry.name
        let lower = name.toAsciiLower()
        if (lower.startsWith("__macosx/") || lower.contains("/.ds_store") || lower == ".ds_store") { continue }
        let relative = kbPathNormalize(name)
        if (entry.uncompressedSize > 64 * 1024 * 1024) { throw Exception("单个文件解压后超过64MB：" + name) }
        let full = targetDir + "/" + relative
        let data = kbZipExtract(bytes, entry)
        totalBytes += data.size
        if (totalBytes > 256 * 1024 * 1024) { throw Exception("压缩包展开后超过256MB，请拆分上传") }
        kbWriteFileDeep(full, data)
        written += 1
    }
    written
}
