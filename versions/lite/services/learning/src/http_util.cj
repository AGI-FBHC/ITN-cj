package zhixun_learning

import std.collection.*
import std.core.*
import std.io.*
import soulsoft_web_http.*

public func readBodyText(request: HttpRequest): String {
    let stream = request.body
    let buffer = Array<Byte>(4096, repeat: 0)
    let parts = ArrayList<Byte>()
    try {
        while (true) {
            let n = stream.read(buffer)
            if (n <= 0) { break }
            var i: Int64 = 0
            while (i < n) {
                parts.add(buffer[i])
                i += 1
            }
        }
    } catch (_: Exception) {}
    String.fromUtf8(parts.toArray())
}

public func writeJson(response: HttpResponse, status: UInt16, body: String): Unit {
    response.statusCode = status
    response.contentType = "application/json; charset=utf-8"
    response.write(body)
}

/** 读取原始请求体（上传 zip 用）。 */
public func readBodyBytes(request: HttpRequest): Array<Byte> {
    let stream = request.body
    let buffer = Array<Byte>(8192, repeat: 0)
    let parts = ArrayList<Byte>()
    try {
        while (true) {
            let n = stream.read(buffer)
            if (n <= 0) { break }
            var i: Int64 = 0
            while (i < n) {
                parts.add(buffer[i])
                i += 1
            }
            if (parts.size > 80 * 1024 * 1024) { break }
        }
    } catch (_: Exception) {}
    parts.toArray()
}