// Copyright (c) 2006 Damien Miller <djm@mindrot.org>
//
// Permission to use, copy, modify, and distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

// Cangjie port of Spring Security BCrypt (Damien Miller/jBCrypt).

package web.security

import stdx.crypto.crypto.SecureRandom



public class BCryptPasswordEncoder {
    public init() {}

    public func encode(rawPassword: String): String {
        let salt = SecureRandom().nextBytes(16)
        let raw = rawPassword.toArray()
        let password = Array<UInt8>(raw.size + 1, { i => if (i < raw.size) { raw[i] } else { 0u8 } })
        let hashed = BCryptEngine().hash(password, salt, 10, true)
        return "$2a$10$" + BCryptEngine.encode(salt, 16) + BCryptEngine.encode(hashed, 23)
    }

    // Accept the revisions used by Spring BCryptPasswordEncoder.
    public func matches(rawPassword: String, encodedPassword: String): Bool {
        let bytes = encodedPassword.toArray()
        if (bytes.size != 60 || bytes[0] != 36 || bytes[1] != 50 ||
            bytes[3] != 36 || bytes[6] != 36) { return false }
        if (bytes[2] != 97 && bytes[2] != 98 && bytes[2] != 121) { return false }
        if (bytes[4] < 48 || bytes[4] > 57 || bytes[5] < 48 || bytes[5] > 57) { return false }
        let cost = Int64(bytes[4] - 48) * 10 + Int64(bytes[5] - 48)
        if (cost < 4 || cost > 31) { return false }
        try {
            let salt = BCryptEngine.decodeSalt(bytes.slice(7, 22))
            let raw = rawPassword.toArray()
            let password = Array<UInt8>(raw.size + 1, { i => if (i < raw.size) { raw[i] } else { 0u8 } })
            let engine = BCryptEngine()
            let hashed = engine.hash(password, salt, cost, bytes[2] == 97)
            let prefix = String.fromUtf8(bytes.slice(0, 7))
            let calculated = (prefix + BCryptEngine.encode(salt, 16) +
                BCryptEngine.encode(hashed, 23)).toArray()
            var difference = 0u8
            for (i in 0..60) { difference = difference | (bytes[i] ^ calculated[i]) }
            return difference == 0
        } catch (_: IllegalArgumentException) {
            return false
        }
    }
}

class BCryptEngine {
    private let p: Array<UInt32> = BCryptConstants.pOrig.clone()
    private let s: Array<UInt32> = BCryptConstants.sOrig.clone()
    private static let alphabet = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".toArray()

    @OverflowWrapping
    private func f(word: UInt32): UInt32 {
        var n = s[Int64((word >> 24) & 255)]
        n += s[Int64(256 | ((word >> 16) & 255))]
        n = n ^ s[Int64(512 | ((word >> 8) & 255))]
        n += s[Int64(768 | (word & 255))]
        return n
    }

    private func encipher(lr: Array<UInt32>, offset: Int64): Unit {
        var left = lr[offset] ^ p[0]
        var right = lr[offset + 1]
        var i = 1
        while (i <= 16) {
            right = right ^ f(left) ^ p[i]
            left = left ^ f(right) ^ p[i + 1]
            i += 2
        }
        lr[offset] = right ^ p[17]
        lr[offset + 1] = left
    }

    @OverflowWrapping
    private static func words(data: Array<UInt8>, offset: Array<Int64>, sign: Array<UInt32>): Array<UInt32> {
        var correct = 0u32
        var buggy = 0u32
        for (i in 0..4) {
            let value = UInt32(data[offset[0]])
            correct = (correct << 8) | value
            let signedValue = if (value >= 128) { value | 0xffffff00u32 } else { value }
            buggy = (buggy << 8) | signedValue
            if (i > 0) { sign[0] = sign[0] | (buggy & 128) }
            offset[0] = (offset[0] + 1) % data.size
        }
        return [correct, buggy]
    }

    private static func word(data: Array<UInt8>, offset: Array<Int64>): UInt32 {
        return words(data, offset, [0u32])[0]
    }

    private func key(data: Array<UInt8>): Unit {
        let offset = [0i64]
        let lr = [0u32, 0u32]
        for (i in 0..18) { p[i] = p[i] ^ word(data, offset) }
        var i = 0
        while (i < 18) {
            encipher(lr, 0)
            p[i] = lr[0]
            p[i + 1] = lr[1]
            i += 2
        }
        i = 0
        while (i < 1024) {
            encipher(lr, 0)
            s[i] = lr[0]
            s[i + 1] = lr[1]
            i += 2
        }
    }

    @OverflowWrapping
    private func enhancedKey(salt: Array<UInt8>, password: Array<UInt8>, safety: Bool): Unit {
        let passwordOffset = [0i64]
        let saltOffset = [0i64]
        let sign = [0u32]
        var difference = 0u32
        for (i in 0..18) {
            let w = words(password, passwordOffset, sign)
            difference = difference | (w[0] ^ w[1])
            p[i] = p[i] ^ w[0]
        }
        // Spring's $2a$ compatibility safeguard for sign-extension collisions.
        if (safety) {
            difference = difference | (difference >> 16)
            difference = (difference & 0xffff) + 0xffff
            p[0] = p[0] ^ ((sign[0] << 9) & (!difference) & 0x10000)
        }
        let lr = [0u32, 0u32]
        var i = 0
        while (i < 18) {
            lr[0] = lr[0] ^ word(salt, saltOffset)
            lr[1] = lr[1] ^ word(salt, saltOffset)
            encipher(lr, 0)
            p[i] = lr[0]
            p[i + 1] = lr[1]
            i += 2
        }
        i = 0
        while (i < 1024) {
            lr[0] = lr[0] ^ word(salt, saltOffset)
            lr[1] = lr[1] ^ word(salt, saltOffset)
            encipher(lr, 0)
            s[i] = lr[0]
            s[i + 1] = lr[1]
            i += 2
        }
    }

    func hash(password: Array<UInt8>, salt: Array<UInt8>, cost: Int64, safety: Bool): Array<UInt8> {
        enhancedKey(salt, password, safety)
        let rounds = 1i64 << cost
        for (_ in 0..rounds) {
            key(password)
            key(salt)
        }
        let ciphertext = BCryptConstants.ciphertext.clone()
        for (_ in 0..64) {
            for (j in 0..3) { encipher(ciphertext, j * 2) }
        }
        return Array<UInt8>(24, { i => UInt8((ciphertext[i / 4] >> ((3 - i % 4) * 8)) & 255) })
    }

    private static func decodeChar(value: UInt8): UInt32 {
        for (i in 0..64) {
            if (alphabet[i] == value) { return UInt32(i) }
        }
        throw IllegalArgumentException("Invalid BCrypt salt character")
    }

    static func decodeSalt(encoded: Array<UInt8>): Array<UInt8> {
        let salt = Array<UInt8>(16, repeat: 0u8)
        var bitBuffer = 0u32
        var bitCount = 0
        var output = 0
        for (value in encoded) {
            bitBuffer = (bitBuffer << 6) | decodeChar(value)
            bitCount += 6
            if (bitCount >= 8 && output < 16) {
                bitCount -= 8
                salt[output] = UInt8((bitBuffer >> bitCount) & 255)
                output += 1
            }
            bitBuffer = bitBuffer & ((1u32 << bitCount) - 1)
        }
        if (output != 16) { throw IllegalArgumentException("Invalid BCrypt salt length") }
        return salt
    }

    static func encode(data: Array<UInt8>, length: Int64): String {
        let outputSize = (length * 8 + 5) / 6
        let output = Array<UInt8>(outputSize, repeat: 0u8)
        var bitBuffer = 0u32
        var bitCount = 0
        var index = 0
        for (i in 0..length) {
            bitBuffer = (bitBuffer << 8) | UInt32(data[i])
            bitCount += 8
            while (bitCount >= 6) {
                bitCount -= 6
                output[index] = alphabet[Int64((bitBuffer >> bitCount) & 63)]
                index += 1
            }
            bitBuffer = bitBuffer & ((1u32 << bitCount) - 1)
        }
        if (bitCount > 0) { output[index] = alphabet[Int64((bitBuffer << (6 - bitCount)) & 63)] }
        return String.fromUtf8(output)
    }
}
