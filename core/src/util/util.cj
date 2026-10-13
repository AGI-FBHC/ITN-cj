package itn_desktop_core.util

import std.fs.*
import std.env.*
import std.collection.*
import std.io.*

public func ensureDir(dir: String): Unit {
    if (!exists(dir)) {
        Directory.create(dir, recursive: true)
    }
}

public func readTextOr(path: String, fallback: String): String {
    if (!exists(path)) {
        return fallback
    }
    return String.fromUtf8(File.readFrom(path))
}

public func writeText(path: String, text: String): Unit {
    File.writeTo(path, text.toArray())
}

func hasPrefix(s: String, prefix: String): Bool {
    let sb = s.toArray()
    let pb = prefix.toArray()
    if (pb.size > sb.size) {
        return false
    }
    var i = 0
    while (i < pb.size) {
        if (sb[i] != pb[i]) {
            return false
        }
        i = i + 1
    }
    return true
}

// 同时支持 "--flag value" 与 "--flag=value" 两种写法
public func argValue(args: Array<String>, flag: String): ?String {
    let pref = flag + "="
    var i = 0
    while (i < args.size) {
        if (args[i] == flag && i + 1 < args.size) {
            return Some(args[i + 1])
        }
        if (hasPrefix(args[i], pref)) {
            let ab = args[i].toArray()
            let skip = pref.toArray().size
            return Some(String.fromUtf8(ab[skip..ab.size]))
        }
        i = i + 1
    }
    return None
}

public func readAllString(input: InputStream): String {
    let sb = StringBuilder()
    let buf = Array<UInt8>(8192, repeat: 0)
    while (true) {
        let n = input.read(buf)
        if (n <= 0) {
            break
        }
        sb.append(String.fromUtf8(buf[0..n]))
    }
    return sb.toString()
}

public func defaultDataDir(): String {
    match (getVariable("LOCALAPPDATA")) {
        case Some(v) => v + "\\ITN-Desktop"
        case None => "."
    }
}
