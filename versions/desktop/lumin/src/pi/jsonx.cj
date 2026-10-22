package lumin.pi

import std.collection.*
import stdx.encoding.json.*

/** 独立库不依赖宿主的 util，这几个 JSON 取值助手就地实现；合并进 ITN-Desktop 时可直接换成 util 里那份。 */
public func strOf(o: JsonObject, key: String): String {
    match (o.get(key)) {
        case Some(v) =>
            match (v) {
                case s: JsonString => s.getValue()
                case _ => ""
            }
        case None => ""
    }
}

public func intOf(o: JsonObject, key: String): Int64 {
    match (o.get(key)) {
        case Some(v) =>
            match (v) {
                case j: JsonInt => j.getValue()
                case _ => 0
            }
        case None => 0
    }
}

/** 取布尔值；缺失或类型不对时返回 dflt。 */
public func boolOf(o: JsonObject, key: String, dflt: Bool): Bool {
    match (o.get(key)) {
        case Some(v) =>
            match (v) {
                case b: JsonBool => return b.getValue()
                case _ => return dflt
            }
        case None => return dflt
    }
}

public func objOf(v: JsonValue): ?JsonObject {
    match (v) {
        case o: JsonObject => Some(o)
        case _ => None
    }
}

public func arrOf(v: JsonValue): ?JsonArray {
    match (v) {
        case a: JsonArray => Some(a)
        case _ => None
    }
}

/** 按字节截断但不切断多字节字符。 */
public func byteSafePrefix(s: String, maxBytes: Int64): String {
    let b = s.toArray()
    if (b.size <= maxBytes) {
        return s
    }
    var end = maxBytes
    while (end > 0 && (b[end] & 192) == 128) {
        end = end - 1
    }
    if (end <= 0) {
        return ""
    }
    return String.fromUtf8(b[0..end])
}