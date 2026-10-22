package web.security

import std.unicode.*
import stdx.crypto.crypto.SecureRandom
import stdx.encoding.hex.toHexString

public class AuthUtilities {
    private init() {}
    public static func normalizeEmail(email: String): String {
        let bytes = email.toArray()
        var start = 0
        var end = bytes.size
        while (start < end && bytes[start] <= 32) { start += 1 }
        while (end > start && bytes[end - 1] <= 32) { end -= 1 }
        return String.fromUtf8(bytes.slice(start, end - start)).toLower(CasingOption.Other)
    }
    public static func uuid(): String {
        let bytes = SecureRandom().nextBytes(16)
        bytes[6] = (bytes[6] & 15u8) | 64u8
        bytes[8] = (bytes[8] & 63u8) | 128u8
        let hex = toHexString(bytes).toArray()
        return String.fromUtf8(hex.slice(0, 8)) + "-" + String.fromUtf8(hex.slice(8, 4)) +
            "-" + String.fromUtf8(hex.slice(12, 4)) + "-" + String.fromUtf8(hex.slice(16, 4)) +
            "-" + String.fromUtf8(hex.slice(20, 12))
    }
    public static func numericCode(): String {
        let random = SecureRandom()
        var result = ""
        while (result.toArray().size < 6) {
            let value = random.nextBytes(1)[0]
            if (value < 250) { result += String.fromUtf8([48u8 + value % 10]) }
        }
        return result
    }
    public static func text(value: String): String {
        return "CONVERT(X'" + toHexString(value.toArray()) + "' USING utf8mb4)"
    }
    public static func uuidSql(value: String): String {
        return "UUID_TO_BIN(" + text(value) + ", 0)"
    }
    public static func equal(left: String, right: String): Bool {
        let a = left.toArray()
        let b = right.toArray()
        if (a.size != b.size) { return false }
        var difference = 0u8
        for (i in 0..a.size) { difference = difference | (a[i] ^ b[i]) }
        return difference == 0
    }
}
