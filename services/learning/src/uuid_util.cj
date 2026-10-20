package zhixun_learning

import std.core.*
import std.random.*

func uuidV4(): Array<Byte> {
    let random = Random()
    let bytes = Array<Byte>(16, repeat: 0)
    var i: Int64 = 0
    while (i < 16) {
        bytes[i] = byteOf(Int64(random.nextUInt8()))
        i += 1
    }
    bytes[6] = byteOf((Int64(bytes[6]) & 0x0f) | 0x40)
    bytes[8] = byteOf((Int64(bytes[8]) & 0x3f) | 0x80)
    bytes
}

func bytesToHex(bytes: Array<Byte>): String {
    let digits = "0123456789abcdef"
    var result = ""
    for (byte in bytes) {
        let value = Int64(byte)
        result = result + charAt(digits, (value >> 4) & 0x0f) + charAt(digits, value & 0x0f)
    }
    result
}

func uuidFormat(bytes: Array<Byte>): String {
    if (bytes.size != 16) { return "" }
    let hex = bytesToHex(bytes)
    hex[0..8] + "-" + hex[8..12] + "-" + hex[12..16] + "-" + hex[16..20] + "-" + hex[20..32]
}

func charAt(text: String, index: Int64): String {
    text[index..index + 1]
}

func byteOf(value: Int64): Byte {
    UInt8(value)
}
