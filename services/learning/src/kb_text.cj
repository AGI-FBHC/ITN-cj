package zhixun_learning

import std.collection.*
import std.core.*
import std.fs.*

/** Decode common Unicode source encodings without replacement characters or dropped text. */
func kbDecodeSourceText(bytes: Array<Byte>): String {
    if (bytes.size < 2 || !((bytes[0] == 255 && bytes[1] == 254) || (bytes[0] == 254 && bytes[1] == 255))) {
        return String.fromUtf8(bytes)
    }
    let little = bytes[0] == 255
    if ((bytes.size - 2) % 2 != 0) { throw Exception("UTF-16原文包含不完整字符") }
    let out = ArrayList<Byte>()
    var i: Int64 = 2
    while (i < bytes.size) {
        var code = if (little) { Int64(bytes[i]) + Int64(bytes[i + 1]) * 256 } else { Int64(bytes[i]) * 256 + Int64(bytes[i + 1]) }
        i += 2
        if (code >= 0xd800 && code <= 0xdbff) {
            if (i + 1 >= bytes.size) { throw Exception("UTF-16原文包含不完整代理对") }
            let low = if (little) { Int64(bytes[i]) + Int64(bytes[i + 1]) * 256 } else { Int64(bytes[i]) * 256 + Int64(bytes[i + 1]) }
            if (low < 0xdc00 || low > 0xdfff) { throw Exception("UTF-16原文代理对无效") }
            code = 0x10000 + (code - 0xd800) * 1024 + low - 0xdc00
            i += 2
        } else if (code >= 0xdc00 && code <= 0xdfff) { throw Exception("UTF-16原文包含孤立代理字符") }
        if (code < 0x80) { out.add(UInt8(code)) }
        else if (code < 0x800) {
            out.add(UInt8(0xc0 | (code >> 6))); out.add(UInt8(0x80 | (code & 63)))
        } else if (code < 0x10000) {
            out.add(UInt8(0xe0 | (code >> 12))); out.add(UInt8(0x80 | ((code >> 6) & 63))); out.add(UInt8(0x80 | (code & 63)))
        } else {
            out.add(UInt8(0xf0 | (code >> 18))); out.add(UInt8(0x80 | ((code >> 12) & 63)))
            out.add(UInt8(0x80 | ((code >> 6) & 63))); out.add(UInt8(0x80 | (code & 63)))
        }
    }
    String.fromUtf8(out.toArray())
}

func kbNormalizeWorkspaceSource(path: String): String {
    let bytes = File.readFrom(Path(path))
    let text = kbDecodeSourceText(bytes)
    if (bytes.size >= 2 && ((bytes[0] == 255 && bytes[1] == 254) || (bytes[0] == 254 && bytes[1] == 255))) {
        // This path is always inside the disposable workspace; the user's source archive is untouched.
        File.writeTo(Path(path), text.toArray())
    }
    text
}
